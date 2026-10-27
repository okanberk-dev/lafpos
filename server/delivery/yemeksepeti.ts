import { PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload } from '@shared/platforms';
import { signedFetch } from '../lib/signature';
import type { PlatformAdapter, PlatformNotify } from './adapter';

/**
 * Yemeksepeti (Delivery Hero POS middleware) bağdaştırıcısı. Platform siparişi kasaya değil herkese açık bir adrese
 * iter: LafPOS Uzaktan (Vercel, api/uzaktan.ts `yemeksepeti/*`) siparişi JWT ile doğrulayıp Redis'teki gelen kutusuna
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

/**
 * Delivery Hero siparişi → LafPOS'un tek biçimi. Birim fiyat ürün + seçenekler; ürünün `paidPrice`'ı (adet toplamı)
 * varsa birim ona göre düzeltilir. İndirimlerin restoran payı VENDOR sponsorluğu; müşterinin ödediği `grandTotal`
 * (kendi kuryemizde teslimat ücreti bizim satırımızdır, platform kuryesinde ve gel-alda ücret platformundur ve
 * toplamdan düşülür). Kabul süresi platformun `expiryDate`'i.
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
  const fees = (o.price?.deliveryFees ?? []).reduce((a, f) => a + toKurus(f.value), 0);
  if (courier === 'restoran' && fees > 0) lines.push({ externalId: null, name: 'Teslimat ücreti', qty: 1, unitPrice: fees, modifiers: [], note: null });
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const productDiscounts = (o.products ?? []).reduce((a, p) => a + vendorShare(p.discounts) + (p.selectedToppings ?? []).reduce((b, t) => b + vendorShare(t.discounts), 0), 0);
  // Ürün düzeyindeki indirimler üst düzey listede de yer alır (belge): büyük olan alınır, iki kez sayılmaz
  const restaurantDiscount = Math.min(subtotal, Math.max(vendorShare(o.discounts), productDiscounts));
  const grand = toKurus(o.price?.grandTotal);
  const ours = Math.max(0, grand - (courier === 'restoran' ? 0 : fees));
  let platformDiscount = 0;
  let customerTotal = subtotal - restaurantDiscount;
  if (grand > 0 && ours <= subtotal - restaurantDiscount) {
    platformDiscount = subtotal - restaurantDiscount - ours;
    customerTotal = ours;
  }
  const name = [text(o.customer?.firstName), text(o.customer?.lastName)].filter(Boolean).join(' ') || null;
  const codeBase = text(o.shortCode) ?? text(o.code) ?? o.token.slice(-4);
  const noteParts = [o.test ? 'TEST SİPARİŞİ' : null, text(o.comments?.customerComment), o.pickup?.pickupCode ? `Teslim kodu ${o.pickup.pickupCode}` : null].filter(Boolean);
  const scheduled = o.preOrder ? (toMs(o.delivery?.expectedDeliveryTime) ?? toMs(o.pickup?.pickupTime)) : null;
  return {
    platform: 'yemeksepeti',
    simulated: false,
    externalId: o.token,
    code: o.test ? `TEST ${codeBase}` : codeBase,
    placedAt: toMs(o.createdAt) ?? now,
    scheduledFor: scheduled,
    courier,
    // Online ödendiyse ya da Yemeksepeti kuryesi kapıda alıyorsa (payRestaurant) tahsilat platformun; kendi kuryemiz kapıda alırsa kasada
    platformCollects: paid || courier === 'platform',
    paymentLabel: paid ? `Online${text(o.payment?.type) ? ` ${o.payment!.type}` : ''}` : `Kapıda ${text(o.payment?.type) ?? 'ödeme'}`,
    customer: { name, phone: courier === 'restoran' ? text(o.customer?.mobilePhone) : null, address: courier === 'restoran' ? addressOf(o) : null },
    note: noteParts.length ? noteParts.join(' · ') : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal,
    expiresAt: toMs(o.expiryDate),
    platformData: { remoteId, token: o.token, callbackUrls: o.callbackUrls ?? {}, expeditionType: o.expeditionType ?? '', test: !!o.test },
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

export class YemeksepetiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
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

  statusUrl(token: string): string {
    return `${this.c.mwUrl}/v2/order/status/${encodeURIComponent(token)}`;
  }
  preparedUrl(token: string): string {
    return `${this.c.mwUrl}/v2/orders/${encodeURIComponent(token)}/preparation-completed`;
  }
}

// ─── Aktarıcı (LafPOS Uzaktan) ───────────────────────────────────────────────

/** Gelen kutusunu çeker (imzalı; en çok 50 kayıt) */
export async function fetchInbox(c: YemeksepetiConfig): Promise<InboxItem[]> {
  const { status, json } = await signedFetch(c.cloudSecret, 'GET', new URL(`${c.cloudUrl}/api/yemeksepeti/inbox`));
  if (status !== 200) throw new YemeksepetiHttpError(status, `aktarıcı gelen kutusu alınamadı (${explain(status, json)})`);
  const body = json as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) throw new YemeksepetiHttpError(502, 'aktarıcı gelen kutusu beklenen biçimde gelmedi');
  return body.items.filter((i): i is InboxItem => !!i && typeof (i as InboxItem).id === 'string' && ((i as InboxItem).kind === 'order' || (i as InboxItem).kind === 'status'));
}

/** İşlenen kayıtları siler; silinemezse bir sonraki çekimde yine gelir (tekilleştirme kasada) */
export async function ackInbox(c: YemeksepetiConfig, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { status } = await signedFetch(c.cloudSecret, 'POST', new URL(`${c.cloudUrl}/api/yemeksepeti/inbox/ack`), { ids });
  if (status !== 200) throw new YemeksepetiHttpError(status, 'aktarıcı gelen kutusu temizlenemedi');
}

type Data = { token?: string; callbackUrls?: { orderAcceptedUrl?: string; orderRejectedUrl?: string; orderPickedUpUrl?: string; orderPreparedUrl?: string }; expeditionType?: string };
const dataOf = (o: PlatformOrderPayload): Data => (o.platformData ?? {}) as Data;

/** Kabulde bildirilen süre: hazırlık + (kendi kuryemizde yol); en az 2 dakika sonra olmalı */
export function acceptanceTime(courier: PlatformCourier, prepMinutes: number, now = Date.now()): string {
  const minutes = Math.max(3, prepMinutes + (courier === 'restoran' ? 20 : 0));
  return new Date(now + minutes * 60_000).toISOString();
}

export function yemeksepetiAdapter(c: YemeksepetiConfig, client = new YemeksepetiClient(c)): PlatformAdapter {
  return {
    platform: 'yemeksepeti',
    label: PLATFORM_LABEL.yemeksepeti,
    configured: () => yemeksepetiConfigured(c),
    async poll(_since, now) {
      const items = await fetchInbox(c);
      const orders: PlatformOrderPayload[] = [];
      const cancelled: string[] = [];
      const done: string[] = [];
      for (const item of items) {
        done.push(item.id);
        if (item.remoteId && c.remoteId && item.remoteId !== c.remoteId) continue;
        if (item.kind === 'order') {
          if (item.order && typeof item.order.token === 'string') orders.push(fromDhOrder(item.order, item.remoteId, now));
        } else if (item.status === 'ORDER_CANCELLED') cancelled.push(item.remoteOrderId);
      }
      // Kayıtlar yerelde işlendikten sonra silinir; silme başarısızsa yeniden gelir, sipariş tekilleştirilir
      await ackInbox(c, done).catch(() => undefined);
      return { orders, cancelled };
    },
    async accept(order, prepMinutes) {
      const d = dataOf(order);
      const token = d.token ?? order.externalId;
      await client.post(d.callbackUrls?.orderAcceptedUrl || client.statusUrl(token), { status: 'order_accepted', acceptanceTime: acceptanceTime(order.courier, prepMinutes), remoteOrderId: token });
    },
    async reject(order, reason) {
      const d = dataOf(order);
      const token = d.token ?? order.externalId;
      await client.post(d.callbackUrls?.orderRejectedUrl || client.statusUrl(token), { status: 'order_rejected', reason: DH_REJECT_REASONS[reason] ?? DH_REJECT_OTHER, message: reason });
    },
    async notify(order, status: PlatformNotify, courier) {
      const d = dataOf(order);
      const token = d.token ?? order.externalId;
      if (courier === 'platform') {
        // Yemeksepeti kuryesi: yalnız "hazır" (preparation-completed), o da adres verildiyse; alma ve teslimi platform yazar
        if (status !== 'hazir' || !d.callbackUrls?.orderPreparedUrl) return false;
        await client.post(d.callbackUrls.orderPreparedUrl, {});
        return true;
      }
      // Kendi kuryemiz ve gel-al: "alındı" (yolda ya da teslim) bir kez; hazır platforma gitmez
      if (status === 'hazir') return false;
      await client.post(d.callbackUrls?.orderPickedUpUrl || client.statusUrl(token), { status: 'order_picked_up' });
      return true;
    },
  };
}
