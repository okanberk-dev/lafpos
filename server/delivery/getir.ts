import { ACCEPT_SECONDS, PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload, REJECT_REASONS } from '@shared/platforms';
import { signedFetch } from '../lib/signature';
import { networkError, type PlatformAdapter, PlatformHttpError, type PlatformNotify } from './adapter';

/**
 * Getir Yemek bağdaştırıcısı (GetirFood API 1.5.8; belgeler calisma/arastirma/paket-platformlari/getir/* ve README,
 * calisma-notlari dalı). Getir siparişi bizim verdiğimiz iki adrese iter (yeni sipariş, iptal; başlıkta bizim
 * ürettiğimiz `x-api-key`): LafPOS Uzaktan (Vercel, api/uzaktan.ts `getir/*`) kaydı Redis'teki gelen kutusuna koyar,
 * kasa gelen kutusunu imzalı olarak 20 saniyede bir çeker, işler ve siler. Yedek: kasa doğrudan Getir'in onaysız
 * (`/food-orders/periodic/unapproved`) ve iptal (`/periodic/cancelled`) listelerini de okur (en sık dakikada bir;
 * aktarıcı düşmüşse hemen); iki yoldan gelen aynı sipariş tekilleşir.
 *
 * - Kimlik: `POST /auth/login` {appSecretKey, restaurantSecretKey} → {token, restaurantId}; jeton 1 saat, her
 *   istekte `token` başlığı; 401'de bir kez yeniden giriş.
 * - Akış: `/verify` (ileri tarihli onaysız, durum 325: `/verify-scheduled`) → `/prepare` → Getir kuryesinde
 *   (deliveryType 1) `/handover`, kendi kuryemizde (2) `/deliver`; ret ve iptal `/cancel` {cancelReasonId, cancelNote},
 *   neden `/cancel-options`'tan. Getir aşama çağrıları arasında en az 1 dakika ister (belge "Order Flow").
 * - Para TL ondalık gelir, kuruşa çevrilir; saatler GMT (belge "System Time").
 *
 * Belgede olmayan ya da emin olunmayan alanlar yanlarındaki yorumla işaretlendi; canlıya geçmeden Getir'in test
 * ortamında bir tur atılır, uyuşmayan ad yalnız bu dosyanın başındaki sabitlerde değişir.
 */

export const GETIR_DEFAULT_URL = 'https://food-external-api-gateway.getirapi.com';
/** Test ortamı (belge "URLs") */
export const GETIR_TEST_URL = 'https://food-external-api-gateway.development.getirapi.com';

const enc = encodeURIComponent;
export const GETIR_PATHS = {
  login: '/auth/login',
  unapproved: '/food-orders/periodic/unapproved',
  cancelled: '/food-orders/periodic/cancelled',
  verify: (id: string) => `/food-orders/${enc(id)}/verify`,
  verifyScheduled: (id: string) => `/food-orders/${enc(id)}/verify-scheduled`,
  prepare: (id: string) => `/food-orders/${enc(id)}/prepare`,
  handover: (id: string) => `/food-orders/${enc(id)}/handover`,
  deliver: (id: string) => `/food-orders/${enc(id)}/deliver`,
  cancel: (id: string) => `/food-orders/${enc(id)}/cancel`,
  cancelOptions: (id: string) => `/food-orders/${enc(id)}/cancel-options`,
};

/** Sipariş durumları (belge "Order Flow"): 325 ileri tarihli onaysız, 400 onaysız (anlık ya da ön onaylı ileri tarihli), 350 onaylı, 500 hazırlanıyor */
export const GETIR_STATUS = { scheduledUnapproved: 325, unapproved: 400, verified: 350, preparing: 500 } as const;

/** Kim götürür (`deliveryType`): 1 Getir kuryesi, 2 restoranın kuryesi (belge "Order Flow"); gel-al belgede yok */
export const GETIR_DELIVERY = { getir: 1, restaurant: 2 } as const;

/**
 * Ödeme türleri (belge "Payment Methods"). Online olanlar (kasada tahsil edilmez): 1 MasterPass (belge: online),
 * 2 BKM Express, 15 MobilExpress, 16 GetirMoney (cüzdan), 19 Sodexo Online. Belge hangilerinin online olduğunu tek tek
 * yazmaz ("online ödeme türleri /payment-methods'ta listelenmez"): 3 Kredi / Banka Kartı kapıda POS cihazı sayıldı
 * (online kart MasterPass'tır); test ortamında doğrulanır.
 */
export const GETIR_ONLINE_METHODS: ReadonlySet<number> = new Set([1, 2, 15, 16, 19]);
export const GETIR_PAYMENT_LABEL: Record<number, string> = {
  1: 'MasterPass',
  2: 'BKM Express',
  3: 'Kredi / Banka Kartı',
  4: 'Nakit',
  5: 'Multinet',
  6: 'Sodexo',
  8: 'Ticket',
  10: 'Setcard',
  11: 'Metropol',
  12: 'Paye',
  15: 'MobilExpress',
  16: 'GetirMoney',
  17: 'Sodexo Pass Mobil',
  18: 'CIO',
  19: 'Sodexo Online',
  21: 'TokenFlex',
};

/** Getir hizmet hata kodları (belge "Service Error Messages"); yanıt gövdesinde `code` beklenir */
export const GETIR_ERROR_TEXT: Record<number, string> = {
  1: 'sipariş bulunamadı',
  2: 'sipariş zaten onaylanmış',
  3: 'sipariş bu durumda değil',
  4: 'sipariş o an kilitli',
  11: 'sipariş iptal edilemez',
  12: 'bu aşamada restoran iptal edemez',
  13: 'sipariş zaten iptal edilmiş',
  28: 'sipariş başka restoranın',
  38: 'restoran Getir\'de kapalı',
  59: 'iptal nedeni gerekli',
  74: 'hazırlandı için süre sınırı aşıldı',
  79: 'ileri tarihli sipariş henüz etkinleşmedi',
};

/** Aşama çağrıları arasında Getir'in istediği bekleme (belge: en az 1 dakika) */
export const STEP_GAP_MS = 60_000;
/** Yedek yoklamanın (onaysız ve iptal listesi) en sık aralığı: belge "/unapproved sürekli sorgulanmamalı" */
export const BACKUP_EVERY_MS = 60_000;

export interface GetirConfig {
  appSecretKey: string;
  restaurantSecretKey: string;
  /** Canlı GETIR_DEFAULT_URL; test ortamı GETIR_TEST_URL */
  apiUrl: string;
  cloudUrl: string;
  cloudSecret: string;
  /** Testte kısaltılır */
  stepGapMs?: number;
  backupEveryMs?: number;
}

export const getirConfigured = (c: GetirConfig) => !!(c.appSecretKey && c.restaurantSecretKey && c.cloudUrl && c.cloudSecret.length >= 32);

// ─── Getir sipariş gövdesi (belge "Integration Structure" ve swagger "Get Food Order Response Schema"; isteğe bağlı okunur)

export interface GetirName {
  tr?: string;
  en?: string;
}

export interface GetirProduct {
  /** Satır kimliği */
  id?: string;
  /** Restoranın ürün kimliği (Ürün eşleme buna bağlanır); zincirde chainProduct */
  product?: string;
  chainProduct?: string;
  count?: number;
  name?: GetirName | string;
  /** Birim fiyat (TL), seçenekler hariç */
  price?: number;
  optionPrice?: number;
  priceWithOption?: number;
  totalPrice?: number;
  totalOptionPrice?: number;
  /** Adet × (ürün + seçenek) */
  totalPriceWithOption?: number;
  /** Yapısı belgede boş nesne; seçenek adları displayInfo'dan okunur */
  optionCategories?: unknown[];
  displayInfo?: { title?: GetirName; options?: { tr?: string[]; en?: string[] } };
  note?: string;
  discountedPriceWithOption?: number;
  totalDiscountedPriceWithOption?: number;
}

export interface GetirOrder {
  id: string;
  status?: number;
  isScheduled?: boolean;
  /** Kuryenin ve müşterinin söylediği onay kodu */
  confirmationId?: string;
  client?: {
    id?: string;
    name?: string;
    contactPhoneNumber?: string;
    /** Maskeli: "+90 (850) 000-00000 / 000000" */
    clientPhoneNumber?: string;
    clientUnmaskedPhoneNumber?: string;
    deliveryAddress?: { id?: string; address?: string; aptNo?: string; floor?: string; doorNo?: string; city?: string; district?: string; description?: string };
    location?: { lat?: number; lon?: number };
  };
  courier?: { id?: string; status?: number; name?: string };
  products?: GetirProduct[];
  clientNote?: string;
  doNotKnock?: boolean;
  dropOffAtDoor?: boolean;
  /** TL; indirimden önce ve sonra. İndirimi kimin karşıladığı belgede yok */
  totalPrice?: number;
  totalDiscountedPrice?: number;
  checkoutDate?: string;
  scheduledDate?: string;
  verifyDate?: string;
  deliveryType?: number;
  isEcoFriendly?: boolean;
  paymentMethod?: number;
  paymentMethodText?: GetirName;
  restaurant?: { id?: string; name?: string };
  isQueued?: boolean;
  cancelDate?: string;
  cancelNote?: string;
  cancelReason?: { id?: string; messages?: GetirName; cancelSource?: number };
}

/** Aktarıcının gelen kutusundaki kayıt: sipariş (newOrder) ya da iptal (cancelOrder) */
export type InboxItem =
  | { id: string; kind: 'order'; receivedAt: number; order: GetirOrder }
  | { id: string; kind: 'cancel'; receivedAt: number; orderId: string; reason?: string; note?: string };

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
const present = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Getir saatleri GMT (belge "System Time"): saat dilimi yazılmamış ISO metin UTC sayılır (yerel sanılırsa 3 saat kayar) */
export const toMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
};
const nameOf = (n: GetirName | string | undefined): string | null => (typeof n === 'string' ? text(n) : (text(n?.tr) ?? text(n?.en)));

/** Kim götürür: deliveryType 1 Getir kuryesi, 2 kendi kuryemiz; bilinmeyen değer kendi kuryemiz sayılır (adres ve telefon kasaya gelsin) */
export function courierOf(o: GetirOrder): PlatformCourier {
  return o.deliveryType === GETIR_DELIVERY.getir ? 'platform' : 'restoran';
}

/** Ödeme: online mı, kasada görünen adı (Getir'in Türkçe metni varsa o) */
export function paymentOf(o: GetirOrder): { online: boolean; label: string } {
  const method = typeof o.paymentMethod === 'number' ? o.paymentMethod : null;
  const online = method != null && GETIR_ONLINE_METHODS.has(method);
  const name = nameOf(o.paymentMethodText) ?? (method != null ? GETIR_PAYMENT_LABEL[method] : null) ?? (method != null ? `ödeme türü ${method}` : 'ödeme');
  const prefix = online ? 'Online' : 'Kapıda';
  return { online, label: /^(online|kapıda)\b/i.test(name) ? name : `${prefix} ${name}` };
}

function addressOf(o: GetirOrder): string | null {
  const a = o.client?.deliveryAddress;
  if (!a) return null;
  const detail = [a.aptNo && `${a.aptNo}`, a.floor && `kat ${a.floor}`, a.doorNo && `daire ${a.doorNo}`].filter(Boolean).join(', ');
  const parts = [a.address, detail, a.district, a.city, a.description].map(text).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Getir siparişi → LafPOS'un tek biçimi. Satırın birim fiyatı ürün + seçenekler (`priceWithOption`); adet toplamı
 * (`totalPriceWithOption`) tutmuyorsa birim ona göre düzeltilir. Getir ücret satırı (teslimat, ambalaj) göndermez:
 * Getir kuryesinin ücretini Getir müşteriden kendisi alır. İndirim (`totalPrice` − `totalDiscountedPrice`, satırda
 * `totalDiscountedPriceWithOption`) kimin karşıladığını belge yazmaz: restoran kampanyası sayılır (adisyon
 * müşterinin ödediğini gösterir; Getir'in karşıladığı kampanya varsa farkı hesap kesiminde görünür). Müşterinin
 * ödediği `totalDiscountedPrice`. Kabul süresi sipariş saatinden 5 dk (belge "Time Limit for Order Confirmation").
 */
export function fromGetirOrder(o: GetirOrder, now = Date.now()): PlatformOrderPayload {
  if (typeof o.id !== 'string' || !o.id) throw new Error('sipariş kimliği yok');
  const courier = courierOf(o);
  const pay = paymentOf(o);
  const lines: PlatformOrderPayload['lines'] = [];
  let lineDiscount = 0;
  for (const p of o.products ?? []) {
    const qty = toQty(p.count);
    let unit = present(p.priceWithOption) ? toKurus(p.priceWithOption) : toKurus(p.price) + toKurus(p.optionPrice);
    const total = toKurus(p.totalPriceWithOption);
    if (total > 0 && Math.abs(total - unit * qty) > qty) unit = Math.round(total / qty);
    const lineTotal = unit * qty;
    if (present(p.totalDiscountedPriceWithOption)) lineDiscount += Math.max(0, lineTotal - toKurus(p.totalDiscountedPriceWithOption));
    else if (present(p.discountedPriceWithOption)) lineDiscount += Math.max(0, lineTotal - toKurus(p.discountedPriceWithOption) * qty);
    const modifiers = (p.displayInfo?.options?.tr ?? p.displayInfo?.options?.en ?? []).map(text).filter((m): m is string => !!m);
    lines.push({ externalId: text(p.product) ?? text(p.chainProduct) ?? text(p.id), name: nameOf(p.name) ?? nameOf(p.displayInfo?.title) ?? 'Ürün', qty, unitPrice: unit, modifiers, note: text(p.note) });
  }
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const orderDiscount = present(o.totalPrice) && present(o.totalDiscountedPrice) ? Math.max(0, toKurus(o.totalPrice) - toKurus(o.totalDiscountedPrice)) : 0;
  // Satır indirimleri sipariş toplamında da yer alır: büyük olan alınır, iki kez sayılmaz
  const restaurantDiscount = Math.min(subtotal, Math.max(orderDiscount, lineDiscount));
  let customerTotal = subtotal - restaurantDiscount;
  let platformDiscount = 0;
  const paid = present(o.totalDiscountedPrice) ? toKurus(o.totalDiscountedPrice) : present(o.totalPrice) ? toKurus(o.totalPrice) : null;
  if (paid != null && paid >= 0 && paid <= customerTotal) {
    // Müşterinin ödediği esastır: kalemlerden fazlası (anlaşılamayan fark) platformun karşıladığı sayılır ki
    // müşteri toplamı = kalemler − bizden − platformdan eşitliği bozulmasın
    platformDiscount = customerTotal - paid;
    customerTotal = paid;
  }
  const placed = toMs(o.checkoutDate);
  const scheduledFor = o.isScheduled ? toMs(o.scheduledDate) : null;
  const noteParts = [text(o.clientNote), courier === 'restoran' && o.doNotKnock ? 'Kapıyı çalmayın' : null, courier === 'restoran' && o.dropOffAtDoor ? 'Kapıya bırakın' : null].filter(Boolean);
  const phone = text(o.client?.contactPhoneNumber) ?? text(o.client?.clientPhoneNumber) ?? text(o.client?.clientUnmaskedPhoneNumber);
  return {
    platform: 'getir',
    simulated: false,
    externalId: o.id,
    code: text(o.confirmationId) ?? o.id.slice(-4),
    placedAt: placed ?? now,
    scheduledFor,
    courier,
    // Online ödendiyse ya da kapıda ödemeyi Getir kuryesi alıyorsa tahsilat platformun; kendi kuryemiz kapıda alırsa kasada
    platformCollects: pay.online || courier === 'platform',
    paymentLabel: pay.label,
    customer: { name: text(o.client?.name), phone: courier === 'restoran' ? phone : null, address: courier === 'restoran' ? addressOf(o) : null },
    note: noteParts.length ? noteParts.join(' · ') : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal,
    // Getir 5 dk içinde yanıt ister (sipariş saatinden; geç çekilen sipariş taze süre almaz); saat yoksa kasa ACCEPT_SECONDS uygular
    expiresAt: placed != null ? placed + ACCEPT_SECONDS.getir! * 1000 : undefined,
    // Getir siparişinde test bayrağı yok (test ortamının siparişleri gerçek akışla denenir)
    test: false,
    platformData: { status: o.status ?? null, isScheduled: !!o.isScheduled, deliveryType: o.deliveryType ?? null, restaurantId: text(o.restaurant?.id), paymentMethod: o.paymentMethod ?? null },
  };
}

type Data = { status?: number | null; isScheduled?: boolean; restaurantId?: string | null };
const dataOf = (o: PlatformOrderPayload): Data => (o.platformData ?? {}) as Data;

/**
 * Kasadaki ret nedenleri → Getir'in iptal seçeneği (`/cancel-options` {id, message}); seçenek metinleri belgede yok,
 * anahtar kelimeyle eşlenir, bulunamazsa "diğer" ya da ilk seçenek. Test ortamında doğrulanır.
 */
export const GETIR_REASON_PATTERNS: Record<(typeof REJECT_REASONS)[number], RegExp> = {
  'Ürün tükendi': /ürün|stok|tüken|malzeme|kalmad/,
  'Çok yoğunuz': /yoğun|kapasite|busy/,
  'Kapanmak üzereyiz': /kapan|kapalı|closed|mesai/,
  'Adres hizmet alanı dışında': /adres|bölge|mesafe|hizmet alanı|uzak|teslimat alanı/,
  Diğer: /diğer|other/,
};

export function pickCancelOption(options: { id?: unknown; message?: unknown }[], reason: string): { id: string; message: string } | null {
  const valid = options.filter((x): x is { id: string; message?: string } => !!x && typeof x.id === 'string' && !!x.id).map((x) => ({ id: x.id, message: text(x.message) ?? '' }));
  if (!valid.length) return null;
  const find = (re: RegExp) => valid.find((x) => re.test(x.message.toLocaleLowerCase('tr-TR')));
  const pattern = (GETIR_REASON_PATTERNS as Record<string, RegExp | undefined>)[reason];
  return (pattern && find(pattern)) ?? find(GETIR_REASON_PATTERNS.Diğer) ?? valid[0]!;
}

// ─── Getir istemcisi ─────────────────────────────────────────────────────────

/** Getir'in yanıtı; `code` Getir hizmet hata kodu (belge "Service Error Messages") */
export class GetirHttpError extends PlatformHttpError {
  constructor(
    status: number,
    message: string,
    readonly code: number | null = null,
  ) {
    super(status, message);
  }
  /** 4 (sipariş o an kilitli) geçicidir; ötekiler HTTP koduna göre */
  override get permanent(): boolean {
    if (this.code === 4) return false;
    return super.permanent;
  }
}

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

/** Hata gövdesindeki Getir kodu (`code`), varsa */
function codeOf(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const c = (json as { code?: unknown }).code;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

function explain(status: number, json: unknown): string {
  const code = codeOf(json);
  const msg = json && typeof json === 'object' ? ((json as { message?: string }).message ?? (json as { error?: string }).error) : typeof json === 'string' ? json.slice(0, 120) : null;
  const known = code != null ? GETIR_ERROR_TEXT[code] : undefined;
  const why = known ?? (status === 401 || status === 403 ? 'kimlik reddedildi' : status === 429 ? 'istek sınırı aşıldı' : status === 404 ? 'sipariş bulunamadı' : `HTTP ${status}`);
  return msg && !known ? `${why}: ${msg}` : code != null ? `${why} (Getir ${code})` : why;
}

/** Jeton: `POST /auth/login`; 1 saat geçerli (belge "Authentication"), 55 dakikada yenilenir, 401'de bir kez yeniden alınır */
export class GetirClient {
  private token: { value: string; expiresAt: number } | null = null;
  /** Girişte Getir'in verdiği restoran kimliği: başka restoranın siparişi ayıklanır */
  restaurantId: string | null = null;
  constructor(private readonly c: GetirConfig) {}

  private url(path: string) {
    return `${this.c.apiUrl.replace(/\/+$/, '')}${path}`;
  }

  private async login(): Promise<string> {
    // Swagger gövdeyi JSON şemayla verir (appSecretKey, restaurantSecretKey); açıklamadaki "HTTP Basic Auth" sözü test ortamında doğrulanır
    const { status, json } = await request(this.url(GETIR_PATHS.login), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ appSecretKey: this.c.appSecretKey, restaurantSecretKey: this.c.restaurantSecretKey }) });
    const out = json as { token?: string; restaurantId?: string } | null;
    if (status !== 200 || !out?.token) throw new GetirHttpError(status, `giriş olmadı (${explain(status, json)})`, codeOf(json));
    this.token = { value: out.token, expiresAt: Date.now() + 55 * 60_000 };
    if (typeof out.restaurantId === 'string' && out.restaurantId) this.restaurantId = out.restaurantId;
    return this.token.value;
  }

  private async bearer(fresh = false): Promise<string> {
    if (!fresh && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    return this.login();
  }

  /** Jetonlu istek; 2xx'te gövde, yoksa GetirHttpError. 401 ve 403'te jeton yenilenip bir kez daha denenir */
  async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.bearer(attempt > 0);
      const headers: Record<string, string> = { token, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const { status, json } = await request(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (status >= 200 && status < 300) return json;
      if ((status === 401 || status === 403) && attempt === 0) continue;
      throw new GetirHttpError(status, explain(status, json), codeOf(json));
    }
    throw new GetirHttpError(401, 'kimlik reddedildi');
  }

  post(path: string, body: unknown = {}) {
    return this.call('POST', path, body);
  }

  /** Sipariş listesi (onaysız, iptal): dizi; `{data: [...]}` sarmalı da kabul edilir. Beklenmeyen biçim hata: boş sanılıp sipariş kaçmasın */
  async orders(path: string): Promise<GetirOrder[]> {
    const json = await this.post(path, {});
    const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : null;
    if (!list) throw new GetirHttpError(502, 'sipariş listesi beklenen biçimde gelmedi');
    return list.filter((o): o is GetirOrder => !!o && typeof (o as GetirOrder).id === 'string');
  }
}

// ─── Aktarıcı (LafPOS Uzaktan) ───────────────────────────────────────────────

/** Gelen kutusunu çeker (imzalı; önce iptaller, en çok 50 kayıt) */
export async function fetchInbox(c: GetirConfig): Promise<InboxItem[]> {
  const { status, json } = await signedFetch(c.cloudSecret, 'GET', new URL(`${c.cloudUrl}/api/getir/inbox`)).catch((e) => {
    throw networkError(e, 8000);
  });
  if (status !== 200) throw new GetirHttpError(status, `aktarıcı gelen kutusu alınamadı (${explain(status, json)})`);
  const body = json as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) throw new GetirHttpError(502, 'aktarıcı gelen kutusu beklenen biçimde gelmedi');
  return body.items.filter((i): i is InboxItem => !!i && typeof (i as InboxItem).id === 'string' && ((i as InboxItem).kind === 'order' || (i as InboxItem).kind === 'cancel'));
}

/** İşlenen kayıtları siler; silinemezse bir sonraki çekimde yine gelir (tekilleştirme kasada) */
export async function ackInbox(c: GetirConfig, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { status } = await signedFetch(c.cloudSecret, 'POST', new URL(`${c.cloudUrl}/api/getir/inbox/ack`), { ids });
  if (status !== 200) throw new GetirHttpError(status, 'aktarıcı gelen kutusu temizlenemedi');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function getirAdapter(c: GetirConfig, client = new GetirClient(c)): PlatformAdapter {
  const gap = c.stepGapMs ?? STEP_GAP_MS;
  const backupEvery = c.backupEveryMs ?? BACKUP_EVERY_MS;
  let lastBackupAt = 0;
  /** Sipariş → son akış çağrısı (verify, prepare, handover, deliver): Getir aralarında en az 1 dk ister */
  const lastCall = new Map<string, number>();

  /** Akış çağrısı; süre dolmamışsa 425 (kalıcı değil, sessizce sonraki turda): yeniden başlatmadan önceki çağrı bilinmez, beklenmez */
  async function step(orderId: string, path: string) {
    const wait = (lastCall.get(orderId) ?? 0) + gap - Date.now();
    if (wait > 0) throw new GetirHttpError(425, `Getir aşamalar arasında ${Math.ceil(gap / 60_000)} dk ister; ${Math.ceil(wait / 1000)} sn sonra yeniden denenecek`);
    await client.post(path, {});
    lastCall.set(orderId, Date.now());
  }

  /** Başka restoranın siparişi (girişte öğrenilen kimlikle): atlanır ama bildirilir */
  const foreign = (o: GetirOrder) => !!(client.restaurantId && o.restaurant?.id && o.restaurant.id !== client.restaurantId);

  return {
    platform: 'getir',
    label: PLATFORM_LABEL.getir,
    configured: () => getirConfigured(c),
    // Getir kuryesine verilince de bildirilir (yolda → handover)
    handover: true,
    async poll(_since, now) {
      const orders = new Map<string, PlatformOrderPayload>();
      const cancelled = new Set<string>();
      const invalid: { externalId: string; error: string }[] = [];
      const seen = new Set<string>();
      const take = (o: GetirOrder) => {
        const id = typeof o.id === 'string' ? o.id : '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        if (foreign(o)) {
          invalid.push({ externalId: id, error: `başka restoranın siparişi (${o.restaurant!.id}); bu restoran ${client.restaurantId}` });
          return;
        }
        // Bozuk sipariş ötekileri durdurmaz: atlanır, kimliğiyle bildirilir
        try {
          orders.set(id, fromGetirOrder(o, now));
        } catch (e) {
          invalid.push({ externalId: id, error: message(e) });
        }
      };
      // 1) Aktarıcının gelen kutusu
      let items: InboxItem[] = [];
      let relayError: string | null = null;
      try {
        items = await fetchInbox(c);
      } catch (e) {
        relayError = message(e);
      }
      // Kayıt kimliği → sipariş kimliği (kasada kalacaklar için)
      const orderIdOf = new Map<string, string>();
      for (const item of items) {
        if (item.kind === 'cancel') {
          orderIdOf.set(item.id, item.orderId);
          cancelled.add(item.orderId);
          continue;
        }
        const id = item.order && typeof item.order.id === 'string' ? item.order.id : item.id;
        orderIdOf.set(item.id, id);
        if (!item.order || typeof item.order.id !== 'string') {
          invalid.push({ externalId: id, error: 'sipariş kimliği yok' });
          continue;
        }
        take(item.order);
      }
      // 2) Yedek: doğrudan Getir'in onaysız ve iptal listeleri (aktarıcı düştüyse hemen, yoksa en sık dakikada bir)
      let warning: string | undefined;
      if (relayError != null || now - lastBackupAt >= backupEvery) {
        try {
          const unapproved = await client.orders(GETIR_PATHS.unapproved);
          const gone = await client.orders(GETIR_PATHS.cancelled);
          lastBackupAt = now;
          for (const o of unapproved) take(o);
          for (const o of gone) if (!foreign(o)) cancelled.add(o.id);
        } catch (e) {
          if (relayError != null) throw new GetirHttpError(0, `aktarıcı: ${relayError}; Getir: ${message(e)}`);
          warning = `yedek yoklama yapılamadı (${message(e)}); siparişler aktarıcıdan alınıyor`;
        }
      }
      if (relayError != null) warning = `aktarıcı gelen kutusu alınamadı (${relayError}); siparişler doğrudan Getir'den alınıyor`;
      // Kasada işlenenler silinir; kayda alınmayan (Kapalı), kaydı düşen ve iptali ertelenen kutuda kalır
      const commit = (keep: ReadonlySet<string>) => ackInbox(c, items.filter((i) => !keep.has(orderIdOf.get(i.id) ?? '')).map((i) => i.id));
      return { orders: [...orders.values()], cancelled: [...cancelled], invalid, commit, warning };
    },
    async accept(order) {
      // Hazırlık süresi Getir'e sipariş başına gitmez (verify gövdesiz; restoranın ortalama süresi ayrı ve sınırlı uçta)
      const d = dataOf(order);
      const path = d.status === GETIR_STATUS.scheduledUnapproved ? GETIR_PATHS.verifyScheduled(order.externalId) : GETIR_PATHS.verify(order.externalId);
      try {
        const res = await client.post(path, {});
        if (res && typeof res === 'object' && (res as { result?: unknown }).result === false) throw new GetirHttpError(409, 'Getir kabulü uygulamadı (result: false)');
      } catch (e) {
        // Getir panelinden zaten onaylanmış: kasada yalnız adisyon açılır
        if (e instanceof GetirHttpError && e.code === 2) return;
        throw e;
      }
      lastCall.set(order.externalId, Date.now());
    },
    async reject(order, reason) {
      // Kabulden sonra kasada iptal de aynı yoldan: Getir'in o aşamada verdiği seçenekler; vermiyorsa (kurye yolda) kalıcı ret
      const options = await client.call('GET', GETIR_PATHS.cancelOptions(order.externalId));
      if (!Array.isArray(options)) throw new GetirHttpError(502, 'iptal seçenekleri beklenen biçimde gelmedi');
      const pick = pickCancelOption(options as { id?: unknown; message?: unknown }[], reason);
      if (!pick) throw new GetirHttpError(409, 'Getir bu sipariş için iptal seçeneği vermiyor: bu aşamada restoran iptal edemez');
      try {
        await client.post(GETIR_PATHS.cancel(order.externalId), { cancelReasonId: pick.id, cancelNote: reason });
      } catch (e) {
        if (e instanceof GetirHttpError && e.code === 13) return;
        throw e;
      }
    },
    async notify(order, status: PlatformNotify, courier) {
      const id = order.externalId;
      if (status === 'hazir') {
        await step(id, GETIR_PATHS.prepare(id));
        return true;
      }
      if (courier === 'platform') {
        // Getir kuryesi: kuryeye verilince handover; teslimi Getir yazar
        if (status !== 'yolda') return false;
        await step(id, GETIR_PATHS.handover(id));
        return true;
      }
      // Kendi kuryemiz: "yolda"nın Getir'de karşılığı yok, teslimde deliver
      if (status !== 'teslim') return false;
      await step(id, GETIR_PATHS.deliver(id));
      return true;
    },
  };
}
