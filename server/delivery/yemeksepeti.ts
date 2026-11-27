import { tl } from '@shared/money';
import { PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload } from '@shared/platforms';
import { kafeFetch } from '../lib/kafe-anahtari';
import { networkError, type PlatformAdapter, PlatformHttpError, type PlatformNotify } from './adapter';

/**
 * Yemeksepeti (Delivery Hero POS middleware) bağdaştırıcısı. Platform siparişi kasaya değil herkese açık bir adrese
 * iter: AsilPOS Uzaktan (Vercel, api/uzaktan.ts `yemeksepeti/*`) siparişi JWT ile doğrulayıp Redis'teki gelen kutusuna
 * koyar ve `remoteOrderId` ile hemen yanıtlar; kasa gelen kutusunu imzalı olarak 20 saniyede bir çeker, işler ve
 * siler. Kabul, ret ve aşamalar kasadan middleware'e gider (`POST /v2/login` jetonuyla; sipariş gövdesindeki
 * `callbackUrls` varsa o adreslere). Belgeler: calisma/arastirma/paket-platformlari/yemeksepeti-dh/*.yaml
 * (calisma-notlari dalı): plugin.yaml (bize gelenler), mw.yaml ve shared.yaml (bizim gönderdiklerimiz).
 */

export interface YemeksepetiConfig {
  mwUrl: string;
  username: string;
  password: string;
  remoteId: string;
  cloudUrl: string;
  cloudSecret: string;
}

export const yemeksepetiConfigured = (c: YemeksepetiConfig) => !!(c.mwUrl && c.username && c.password && c.remoteId && c.cloudUrl && c.cloudSecret.length >= 32);

// ─── Delivery Hero sipariş gövdesi (plugin.yaml / pluginOrder.yaml; alanlar isteğe bağlı okunur) ────────────────

export interface DhDiscount {
  name?: string;
  amount?: string | number;
  sponsorships?: { sponsor?: string; amount?: string | number }[];
}

export interface DhTopping {
  id?: string;
  name?: string;
  price?: string | number;
  quantity?: number | string;
  remoteCode?: string | null;
  type?: string;
  children?: DhTopping[];
  discounts?: DhDiscount[];
}

export interface DhProduct {
  id?: string;
  categoryName?: string | null;
  name?: string;
  paidPrice?: string | number;
  quantity?: string | number;
  remoteCode?: string | null;
  selectedToppings?: DhTopping[];
  unitPrice?: string | number;
  comment?: string | null;
  discounts?: DhDiscount[];
}

export interface DhOrder {
  token: string;
  code?: string;
  shortCode?: string | null;
  comments?: { customerComment?: string | null };
  createdAt?: string;
  customer?: { firstName?: string | null; lastName?: string | null; mobilePhone?: string | null };
  delivery?: {
    address?: {
      building?: string;
      city?: string;
      company?: string;
      deliveryArea?: string;
      deliveryInstructions?: string | null;
      deliveryMainArea?: string;
      entrance?: string;
      flatNumber?: string;
      floor?: string;
      intercom?: string;
      number?: string;
      postcode?: string;
      street?: string;
    } | null;
    expectedDeliveryTime?: string | null;
    riderPickupTime?: string | null;
  } | null;
  discounts?: DhDiscount[];
  expeditionType?: string;
  expiryDate?: string;
  payment?: { status?: string; type?: string };
  test?: boolean;
  preOrder?: boolean;
  pickup?: { pickupTime?: string | null; pickupCode?: string } | null;
  price?: { deliveryFees?: { name?: string; value?: number | string }[]; grandTotal?: string | number; payRestaurant?: string | number; collectFromCustomer?: string | number; riderTip?: string | number | null };
  products?: DhProduct[];
  callbackUrls?: { orderAcceptedUrl?: string; orderRejectedUrl?: string; orderPickedUpUrl?: string; orderPreparedUrl?: string };
  localInfo?: { platform?: string; platformKey?: string };
}

/** Aktarıcının gelen kutusundaki kayıt: sipariş ya da durum bildirimi (ORDER_CANCELLED, ORDER_PICKED_UP …) */
export type InboxItem =
  | { id: string; kind: 'order'; remoteId: string; receivedAt: number; order: DhOrder }
  | { id: string; kind: 'status'; remoteId: string; receivedAt: number; remoteOrderId: string; status: string; message?: string };

const toKurus = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : 0;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  return 0;
};
const toQty = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const toMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
};

/** Kim götürür: pickup → gel-al; delivery ve riderPickupTime dolu → Yemeksepeti kuryesi; boş → kendi kuryemiz */
export function courierOf(o: DhOrder): PlatformCourier {
  if ((o.expeditionType ?? '').toLowerCase() === 'pickup') return 'gelal';
  return o.delivery?.riderPickupTime ? 'platform' : 'restoran';
}

/** Restoranın karşıladığı kısım (VENDOR sponsorluğu); sponsoru yazılmayan indirim restorana yazılmaz (belge) */
function vendorShare(list: DhDiscount[] | undefined): number {
  let sum = 0;
  for (const d of list ?? []) for (const s of d.sponsorships ?? []) if ((s.sponsor ?? '').toUpperCase() === 'VENDOR') sum += toKurus(s.amount);
  return sum;
}

function addressOf(o: DhOrder): string | null {
  const a = o.delivery?.address;
  if (!a) return null;
  const line = [a.street, a.number].map(text).filter(Boolean).join(' ');
  const detail = [a.building && `${a.building}`, a.entrance && `giriş ${a.entrance}`, a.floor && `kat ${a.floor}`, a.flatNumber && `daire ${a.flatNumber}`, a.intercom && `zil ${a.intercom}`].filter(Boolean).join(', ');
  const parts = [line, detail, a.deliveryArea, a.deliveryMainArea, a.city, a.deliveryInstructions].map(text).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function toppingNames(list: DhTopping[] | undefined, out: string[], depth = 0): number {
  let extra = 0;
  for (const t of list ?? []) {
    const name = text(t.name);
    if (name) out.push(toQty(t.quantity) > 1 ? `${toQty(t.quantity)}× ${name}` : name);
    extra += toKurus(t.price) * toQty(t.quantity);
    if (depth < 5) extra += toppingNames(t.children, out, depth + 1);
  }
  return extra;
}

/** Teslimat ücreti mi: Delivery Hero adı İngilizce ("delivery fee"); Türkçe ad gelirse de tanınır */
const isDeliveryFee = (name: string | null) => !name || /deliver|teslimat|getirme|kurye/.test(name.toLocaleLowerCase('tr-TR'));

/** Ücret adı: bilinen Delivery Hero adları Türkçe, ötekiler olduğu gibi */
function feeLabel(name: string | null): string {
  const n = (name ?? '').toLocaleLowerCase('tr-TR');
  if (isDeliveryFee(name)) return 'Teslimat ücreti';
  if (/packag|container|ambalaj|paket/.test(n)) return 'Ambalaj ücreti';
  if (/service|hizmet/.test(n)) return 'Hizmet ücreti';
  if (/small|küçük/.test(n)) return 'Küçük sipariş ücreti';
  return name!;
}
/** Alan var mı (0,00 da geçerli bir değerdir) */
const present = (v: unknown) => v != null && !(typeof v === 'string' && !v.trim());

/**
 * Delivery Hero siparişi → AsilPOS'un tek biçimi. Birim fiyat ürün + seçenekler; ürünün `paidPrice`'ı (adet toplamı)
 * varsa birim ona göre düzeltilir. Ücretler (`deliveryFees`: teslimat, ambalaj…) adlarıyla ayrı satır olur
 * (`kind: 'fee'`); yalnız Yemeksepeti kuryesinin teslimat ücreti platformundur ve satır olmaz. İndirimlerin restoran
 * payı VENDOR sponsorluğu. Müşterinin bize ödediği: kapıda tahsilatta `collectFromCustomer`, yoksa `grandTotal`
 * (platform kuryesinde teslimat ücreti düşülür); kalanı platformun kampanyasıdır. Yemeksepeti kuryesi kapıda nakit
 * alıyorsa kasaya `payRestaurant` bırakır: o tutar kasada alınır. Kabul süresi platformun `expiryDate`'i; geri çağrı
 * adresi olmayan sipariş (dolaylı akış) tablette zaten kabul edilmiştir.
 */
export function fromDhOrder(o: DhOrder, remoteId: string, now = Date.now()): PlatformOrderPayload {
  const courier = courierOf(o);
  const paid = (o.payment?.status ?? '').toLowerCase() === 'paid';
  const lines: PlatformOrderPayload['lines'] = [];
  for (const p of o.products ?? []) {
    const qty = toQty(p.quantity);
    const modifiers: string[] = [];
    const extra = toppingNames(p.selectedToppings, modifiers);
    let unit = toKurus(p.unitPrice) + extra;
    const total = toKurus(p.paidPrice);
    if (total > 0 && Math.abs(total - unit * qty) > qty) unit = Math.round(total / qty);
    lines.push({ externalId: text(p.remoteCode) ?? text(p.id), name: text(p.name) ?? 'Ürün', qty, unitPrice: unit, modifiers, note: text(p.comment) });
  }
  let platformFees = 0;
  for (const f of o.price?.deliveryFees ?? []) {
    const value = toKurus(f.value);
    if (value <= 0) continue;
    const name = text(f.name);
    if (courier === 'platform' && isDeliveryFee(name)) {
      platformFees += value;
      continue;
    }
    const label = feeLabel(name);
    lines.push({ externalId: `ys-ucret:${label.toLocaleLowerCase('tr-TR')}`, name: label, qty: 1, unitPrice: value, modifiers: [], note: null, kind: 'fee' });
  }
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const productDiscounts = (o.products ?? []).reduce((a, p) => a + vendorShare(p.discounts) + (p.selectedToppings ?? []).reduce((b, t) => b + vendorShare(t.discounts), 0), 0);
  // Ürün düzeyindeki indirimler üst düzey listede de yer alır (belge): büyük olan alınır, iki kez sayılmaz
  const restaurantDiscount = Math.min(subtotal, Math.max(vendorShare(o.discounts), productDiscounts));
  const ourPart = subtotal - restaurantDiscount;
  // Müşterinin bize düşen ödemesi: kendi kuryemizin kapıda alacağı (collectFromCustomer, yalnız teslimatta ve sıfırdan
  // büyükse), yoksa grandTotal (Yemeksepeti kuryesinin teslimat ücreti düşülür)
  let ours = ourPart;
  /** grandTotal'ın kalemleri aşan kısmı (bilinen fark, kuryenin bahşişi, düşülmüş): adisyona girmez, doğrulanır */
  let excess = 0;
  const collect = toKurus(o.price?.collectFromCustomer);
  if (!paid && courier === 'restoran' && collect > 0) ours = collect;
  else if (present(o.price?.grandTotal)) {
    ours = Math.max(0, toKurus(o.price!.grandTotal) - platformFees);
    excess = ours - toKurus(o.price?.riderTip) - ourPart;
  }
  // Ödenmemiş siparişte kasada alınacak tutar sıfır görünüyorsa (eksik ya da 0,00 alan) tamamı platform payı sayılmaz;
  // tutar platformdan doğrulanmalı (otomatik kabul edilmez)
  let amountReview: string | null = null;
  if (!paid && ours <= 0) {
    ours = ourPart;
    amountReview = `Yemeksepeti'nde alınacak tutar sıfır göründü; ${tl(ourPart)} sayıldı, Yemeksepeti'nden doğrulayın`;
  } else if (excess > 0) {
    // Toplam kalemleri aşıyor (bahşiş tek başına aşmaz): fark adisyona ve platform alacağına girmez, doğrulanır
    amountReview = `Yemeksepeti'nde ${paid ? 'ödenen' : 'alınacak'} ${tl(ourPart + excess)}, kalemler ${tl(ourPart)}: farkı Yemeksepeti'nden doğrulayın`;
  } else if (paid && !present(o.price?.grandTotal)) {
    // Ödenmiş siparişin toplamı gelmedi: kalemlerle çapraz denetlenemez (Getir ve Trendyol Go'da da aynı kural)
    amountReview = "Yemeksepeti toplamı gelmedi: tutarı Yemeksepeti'nden doğrulayın";
  }
  let platformCollects = paid || courier === 'platform';
  let paymentLabel = paid ? `Online${text(o.payment?.type) ? ` ${o.payment!.type}` : ''}` : `Kapıda ${text(o.payment?.type) ?? 'ödeme'}`;
  // Yemeksepeti kuryesi kapıda alıyor ve kasaya nakit bırakıyor: o tutar kasada alınır, kalanı platformun payı
  const payRestaurant = toKurus(o.price?.payRestaurant);
  if (courier === 'platform' && !paid && payRestaurant > 0) {
    ours = payRestaurant;
    platformCollects = false;
    paymentLabel = `${paymentLabel} · kurye kasaya ${tl(payRestaurant)} bırakır`;
  }
  const customerTotal = Math.min(ours, ourPart);
  const platformDiscount = ourPart - customerTotal;
  const callbackUrls = o.callbackUrls ?? {};
  const preAccepted = !callbackUrls.orderAcceptedUrl;
  const name = [text(o.customer?.firstName), text(o.customer?.lastName)].filter(Boolean).join(' ') || null;
  const codeBase = text(o.shortCode) ?? text(o.code) ?? o.token.slice(-4);
  const noteParts = [o.test ? 'TEST SİPARİŞİ' : null, preAccepted ? 'Yemeksepeti tabletinde kabul edildi' : null, text(o.comments?.customerComment), o.pickup?.pickupCode ? `Teslim kodu ${o.pickup.pickupCode}` : null].filter(Boolean);
  // İleri tarihli siparişin saati, kabulde platforma bildirilen saatle aynı kuraldan: gel-alda müşterinin alma saati,
  // Yemeksepeti kuryesinde kuryenin alma saati, kendi kuryemizde teslim saati (yoksa ötekiler)
  const times = { pickupTime: toMs(o.pickup?.pickupTime), expectedDeliveryTime: toMs(o.delivery?.expectedDeliveryTime), riderPickupTime: toMs(o.delivery?.riderPickupTime) };
  const ownTime = courier === 'gelal' ? times.pickupTime : courier === 'platform' ? times.riderPickupTime : times.expectedDeliveryTime;
  const scheduled = o.preOrder ? (ownTime ?? times.expectedDeliveryTime ?? times.pickupTime ?? times.riderPickupTime) : null;
  return {
    platform: 'yemeksepeti',
    simulated: false,
    externalId: o.token,
    code: o.test ? `TEST ${codeBase}` : codeBase,
    placedAt: toMs(o.createdAt) ?? now,
    scheduledFor: scheduled,
    courier,
    platformCollects,
    paymentLabel,
    customer: { name, phone: courier === 'restoran' ? text(o.customer?.mobilePhone) : null, address: courier === 'restoran' ? addressOf(o) : null },
    note: noteParts.length ? noteParts.join(' · ') : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal,
    expiresAt: preAccepted ? null : toMs(o.expiryDate),
    preAccepted,
    test: !!o.test,
    ...(amountReview ? { amountReview } : {}),
    // Ön sipariş ama saati yok: otomatik kabul edilmez
    ...(o.preOrder && scheduled == null ? { scheduledUnknown: true } : {}),
    platformData: {
      remoteId,
      token: o.token,
      callbackUrls,
      expeditionType: o.expeditionType ?? '',
      test: !!o.test,
      times,
    },
  };
}

/** Kasadaki ret nedenleri → Delivery Hero neden kodları (shared.yaml `order_rejected`) */
export const DH_REJECT_REASONS: Record<string, string> = {
  'Ürün tükendi': 'ITEM_UNAVAILABLE',
  'Çok yoğunuz': 'TOO_BUSY',
  'Kapanmak üzereyiz': 'CLOSED',
  'Adres hizmet alanı dışında': 'OUTSIDE_DELIVERY_AREA',
};
export const DH_REJECT_OTHER = 'TOO_BUSY';

// ─── Middleware istemcisi ───────────────────────────────────────────────────

export class YemeksepetiHttpError extends PlatformHttpError {}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? 8000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal }).catch((e) => {
      throw networkError(e, timeoutMs);
    });
    const raw = await res.text().catch((e) => {
      throw networkError(e, timeoutMs);
    });
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = raw;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function explain(status: number, json: unknown): string {
  const msg = json && typeof json === 'object' ? ((json as { message?: string }).message ?? (json as { code?: string }).code) : typeof json === 'string' ? json.slice(0, 120) : null;
  const why = status === 401 || status === 403 ? 'kimlik reddedildi' : status === 409 ? 'sipariş bu durumda değil' : status === 404 ? 'sipariş bulunamadı' : `HTTP ${status}`;
  return msg ? `${why}: ${msg}` : why;
}

/** Jeton: `POST /v2/login` (client_credentials); süresi dolmadan yenilenir, 401'de bir kez yeniden alınır */
export class YemeksepetiClient {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly c: YemeksepetiConfig) {}

  private async login(): Promise<string> {
    const body = new URLSearchParams({ username: this.c.username, password: this.c.password, grant_type: 'client_credentials' });
    const { status, json } = await request(`${this.c.mwUrl}/v2/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const out = json as { access_token?: string; expires_in?: number } | null;
    if (status !== 200 || !out?.access_token) throw new YemeksepetiHttpError(status, `giriş olmadı (${explain(status, json)})`);
    this.token = { value: out.access_token, expiresAt: Date.now() + Math.max(60, (out.expires_in ?? 1800) - 60) * 1000 };
    return this.token.value;
  }

  private async bearer(fresh = false): Promise<string> {
    if (!fresh && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    return this.login();
  }

  /** Middleware'e JSON gönderir; 401'de jetonu yenileyip bir kez daha dener */
  async post(url: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.bearer(attempt > 0);
      const { status, json } = await request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      if (status >= 200 && status < 300) return json;
      if (status === 401 && attempt === 0) continue;
      throw new YemeksepetiHttpError(status, explain(status, json));
    }
    throw new YemeksepetiHttpError(401, 'kimlik reddedildi');
  }

}

// ─── Aktarıcı (AsilPOS Uzaktan) ───────────────────────────────────────────────

/**
 * Aktarıcının adresi; restoranın kimliği imzalı sorguda (`?restoran=`): aktarıcı yalnız bu restoranın gelen kutusunu
 * verir ve siler (api/uzaktan.ts `pullLists`). Eski aktarıcı sorguyu yok sayar (ortak kutu, bugünkü davranış)
 */
function relayUrl(c: YemeksepetiConfig, path: string): URL {
  const url = new URL(`${c.cloudUrl}/api/yemeksepeti/${path}`);
  if (c.remoteId) url.searchParams.set('restoran', c.remoteId);
  return url;
}

/** Gelen kutusunu çeker (imzalı; en çok 50 kayıt) */
export async function fetchInbox(c: YemeksepetiConfig): Promise<InboxItem[]> {
  const { status, json } = await kafeFetch(c.cloudSecret, 'GET', relayUrl(c, 'inbox')).catch((e) => {
    throw networkError(e, 8000);
  });
  if (status !== 200) throw new YemeksepetiHttpError(status, `aktarıcı gelen kutusu alınamadı (${explain(status, json)})`);
  const body = json as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) throw new YemeksepetiHttpError(502, 'aktarıcı gelen kutusu beklenen biçimde gelmedi');
  return body.items.filter((i): i is InboxItem => !!i && typeof (i as InboxItem).id === 'string' && ((i as InboxItem).kind === 'order' || (i as InboxItem).kind === 'status'));
}

/** İşlenen kayıtları siler; silinemezse bir sonraki çekimde yine gelir (tekilleştirme kasada) */
export async function ackInbox(c: YemeksepetiConfig, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { status } = await kafeFetch(c.cloudSecret, 'POST', relayUrl(c, 'inbox/ack'), { ids });
  if (status !== 200) throw new YemeksepetiHttpError(status, 'aktarıcı gelen kutusu temizlenemedi');
}

type Times = { pickupTime?: number | null; expectedDeliveryTime?: number | null; riderPickupTime?: number | null };
type Data = {
  token?: string;
  callbackUrls?: { orderAcceptedUrl?: string; orderRejectedUrl?: string; orderPickedUpUrl?: string; orderPreparedUrl?: string };
  expeditionType?: string;
  test?: boolean;
  times?: Times;
};
const dataOf = (o: PlatformOrderPayload): Data => (o.platformData ?? {}) as Data;

/**
 * Kabulde bildirilen saat: platformun saatine uyulur (gel-alda müşterinin alma saati, kendi kuryemizde teslim saati,
 * Yemeksepeti kuryesinde kuryenin alma saati; belge: farklı saat müşteriye bildirilir); o saat hazırlıktan erkense ya
 * da yoksa şimdi + hazırlık (kendi kuryemizde +20 dk yol). En az 3 dakika sonrası.
 */
export function acceptanceTime(courier: PlatformCourier, prepMinutes: number, times: Times = {}, now = Date.now()): string {
  const ready = now + Math.max(3, prepMinutes + (courier === 'restoran' ? 20 : 0)) * 60_000;
  const wanted = courier === 'gelal' ? times.pickupTime : courier === 'restoran' ? times.expectedDeliveryTime : times.riderPickupTime;
  return new Date(wanted && wanted > ready ? wanted : ready).toISOString();
}

/**
 * Geri çağrı adresi yalnız middleware ile aynı alan adındaysa (ve aynı şemayla) kullanılır: gelen kutusundaki adres
 * restoranın jetonunu başka bir sunucuya taşımasın
 */
export function trustedCallback(url: string | undefined, mwUrl: string): string | null {
  if (!url) return null;
  let u: URL;
  let mw: URL;
  try {
    u = new URL(url);
    mw = new URL(mwUrl);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol !== mw.protocol || (u.protocol !== 'https:' && u.hostname !== mw.hostname)) return null;
  if (u.hostname === mw.hostname) return u.toString();
  // IP adresinde yalnız tam eşleşme; alan adında kayıtlı kök (".com.tr" gibi iki etiketli uzantıda son üç etiket)
  if (/^[\d.]+$/.test(mw.hostname) || mw.hostname.includes(':')) return null;
  const labels = mw.hostname.split('.');
  const twoLevel = labels.length >= 3 && SECOND_LEVEL.has(labels.at(-2)!);
  const base = labels.slice(twoLevel ? -3 : -2).join('.');
  return labels.length >= (twoLevel ? 3 : 2) && u.hostname.endsWith(`.${base}`) ? u.toString() : null;
}
/** "com.tr", "co.uk" gibi iki etiketli uzantıların ikinci etiketi: kök bir etiket daha içeri alınır */
const SECOND_LEVEL = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'gen', 'biz', 'info', 'web', 'av', 'bel', 'pol', 'k12', 'tv', 'name', 'tel', 'ac', 'or', 'ne', 'go']);

const untrusted = (what: string) => new YemeksepetiHttpError(400, `${what} adresi middleware alan adında değil; güvenilmedi`);

export function yemeksepetiAdapter(c: YemeksepetiConfig, client = new YemeksepetiClient(c)): PlatformAdapter {
  const cb = (d: Data, key: keyof NonNullable<Data['callbackUrls']>, what: string): string | null => {
    const raw = d.callbackUrls?.[key];
    if (!raw) return null;
    const ok = trustedCallback(raw, c.mwUrl);
    if (!ok) throw untrusted(what);
    return ok;
  };
  return {
    platform: 'yemeksepeti',
    label: PLATFORM_LABEL.yemeksepeti,
    configured: () => yemeksepetiConfigured(c),
    async poll(_since, now) {
      const items = await fetchInbox(c);
      const orders: PlatformOrderPayload[] = [];
      const cancelled: string[] = [];
      const invalid: { externalId: string; error: string }[] = [];
      // Kayıt kimliği → siparişin belirteci (kasada kalacaklar için)
      const tokenOf = new Map<string, string>();
      /** Başka restoranın kayıtları (ortak gelen kutusunda): hiç silinmez, o restoranın kasası alır */
      const foreign = new Set<string>();
      for (const item of items) {
        const token = item.kind === 'order' ? (item.order && typeof item.order.token === 'string' ? item.order.token : item.id) : item.remoteOrderId;
        tokenOf.set(item.id, token);
        // Başka restoranın kimliği: atlanır ve kutuda bırakılır ama bildirilir (yanlış ayarda siparişler sessizce kaybolmasın)
        if (item.remoteId && c.remoteId && item.remoteId !== c.remoteId) {
          foreign.add(item.id);
          invalid.push({ externalId: token, error: `başka restoranın kimliği (${item.remoteId}); bu kasanın YEMEKSEPETI_REMOTE_ID'si ${c.remoteId}, kayıt gelen kutusunda o restorana bırakıldı` });
          continue;
        }
        if (item.kind === 'order') {
          // Bozuk sipariş ötekileri durdurmaz: atlanır, kimliğiyle bildirilir
          try {
            if (!item.order || typeof item.order.token !== 'string') throw new Error('sipariş belirteci yok');
            orders.push(fromDhOrder(item.order, item.remoteId, now));
          } catch (e) {
            invalid.push({ externalId: token, error: e instanceof Error ? e.message : String(e) });
          }
        } else if (item.status === 'ORDER_CANCELLED') cancelled.push(item.remoteOrderId);
      }
      // Kasada işlenenler silinir; başka restoranınki, kayda alınmayan (Kapalı), kaydı düşen ve iptali ertelenen kutuda kalır
      const commit = (keep: ReadonlySet<string>) => ackInbox(c, items.filter((i) => !foreign.has(i.id) && !keep.has(tokenOf.get(i.id) ?? '')).map((i) => i.id));
      return { orders, cancelled, invalid, commit };
    },
    async accept(order, prepMinutes) {
      const d = dataOf(order);
      const url = cb(d, 'orderAcceptedUrl', 'Kabul');
      // Geri çağrı adresi yok: dolaylı akış, sipariş tablette kabul edildi; platforma gönderilecek bir şey yok
      if (!url) return;
      await client.post(url, { status: 'order_accepted', acceptanceTime: acceptanceTime(order.courier, prepMinutes, d.times), remoteOrderId: d.token ?? order.externalId });
    },
    async reject(order, reason, opts) {
      const d = dataOf(order);
      const url = cb(d, 'orderRejectedUrl', 'Ret');
      if (!url) throw new YemeksepetiHttpError(409, 'sipariş Yemeksepeti tabletinde kabul edildi; ret ve iptal tabletten yapılır');
      // Kabulden sonra kasadan iptal: neden kodları kurye ve teslim olaylarına özgü (belge), kasanın iptali karşılamaz
      if (opts?.afterAccept) throw new YemeksepetiHttpError(409, 'kabul edilmiş siparişin iptali kasadan gönderilmez; Yemeksepeti uygulamasından iptal edin');
      let code = d.test ? 'TEST_ORDER' : (DH_REJECT_REASONS[reason] ?? DH_REJECT_OTHER);
      // Adres dışı yalnız kendi kuryemizde geçerli (belge: Vendor Delivery)
      if (code === 'OUTSIDE_DELIVERY_AREA' && order.courier !== 'restoran') code = DH_REJECT_OTHER;
      await client.post(url, { status: 'order_rejected', reason: code, message: reason });
    },
    async notify(order, status: PlatformNotify, courier) {
      const d = dataOf(order);
      if (courier === 'platform') {
        // Yemeksepeti kuryesi: yalnız "hazır" (preparation-completed), o da adres verildiyse; alma ve teslimi platform yazar
        if (status !== 'hazir') return false;
        const url = cb(d, 'orderPreparedUrl', 'Hazır');
        if (!url) return false;
        await client.post(url, {});
        return true;
      }
      // Kendi kuryemiz ve gel-al: "alındı" bir kez, yolda adımında (teslime doğrudan geçilse de aşama turu yoldan
      // geçer); adres yoksa gönderilmez (belge: "If the URL is not present, you should skip it")
      if (status !== 'yolda') return false;
      const url = cb(d, 'orderPickedUpUrl', 'Alındı');
      if (!url) return false;
      await client.post(url, { status: 'order_picked_up' });
      return true;
    },
  };
}
