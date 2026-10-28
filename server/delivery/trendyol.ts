import { tl } from '@shared/money';
import { PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload } from '@shared/platforms';
import { networkError, type PlatformAdapter, PlatformHttpError, type PlatformNotify } from './adapter';

/**
 * Trendyol Go Yemek (Uber Eats Türkiye siparişleri de buradan gelir) bağdaştırıcısı: yalnız yoklama (platform
 * kasayı aramaz), kasadan doğrudan. Kaynak: developers.tgoapps.com (Yetkilendirme; Yemek › Sipariş entegrasyonu ›
 * Sipariş paketlerini çekme, Paket modelleri, Paket durumu güncelleme; Uber Eats geçişi değişiklikleri); özet
 * calisma/arastirma/paket-platformlari/README.md (calisma-notlari dalı).
 *
 * - Kimlik: Basic (API anahtarı:gizli anahtar), `User-Agent: "<satıcı no> - <entegratör>"`, `x-agentname`,
 *   `x-executor-user`. Uç başına 10 saniyede 50 istek: 20 saniyelik yoklama bunun çok altında.
 * - Sipariş: `GET /integrator/order/meal/suppliers/{id}/packages` (durum ve değişiklik zamanı süzgeci, sayfa 50).
 * - Akış: `PUT …/packages/{paketId}/picked` (kabul, hazırlık süresi) → `/invoiced` (hazır) → kendi kuryemizde
 *   `/manual-shipped` ve `/manual-delivered`; ret ve iptal `/unsupplied` (neden kodu).
 *
 * Alan adları ve yollar bu dosyanın başındaki sabitlerde toplandı: canlıya geçmeden önce Trendyol'un test ortamında
 * (IP izni) bir tur atılır, uyuşmayan ad yalnız burada değişir. Para TL ondalık gelir, kuruşa çevrilir.
 */

export const TRENDYOL_DEFAULT_URL = 'https://api.tgoapps.com';

/** Uç yolları (satıcı no ile) */
export const TRENDYOL_PATHS = {
  packages: (supplierId: string) => `/integrator/order/meal/suppliers/${encodeURIComponent(supplierId)}/packages`,
  picked: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/picked`,
  invoiced: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/invoiced`,
  shipped: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/manual-shipped`,
  delivered: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/manual-delivered`,
  unsupplied: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/unsupplied`,
};

/** Paket durumları (packageStatus): yeni sipariş `Created`; platformun iptali `Cancelled`; bizim iptalimiz `UnSupplied` */
export const TRENDYOL_STATUS = { created: 'Created', cancelled: 'Cancelled', unsupplied: 'UnSupplied' } as const;

/**
 * Ret / iptal neden kodları (`unsupplied`, 621-627). Kasadaki ret nedenleri (shared/platforms.ts REJECT_REASONS) bu
 * kodlara eşlenir; belgedeki sıra: 621 ürün yok, 622 yoğunluk, 623 kapalı / kapanıyor, 624 adres, 625 müşteri
 * istedi, 626 ödeme sorunu, 627 diğer. Test ortamında doğrulanır.
 */
export const TRENDYOL_REASON_CODES: Record<string, number> = {
  'Ürün tükendi': 621,
  'Çok yoğunuz': 622,
  'Kapanmak üzereyiz': 623,
  'Adres hizmet alanı dışında': 624,
};
export const TRENDYOL_REASON_OTHER = 627;

export interface TrendyolConfig {
  supplierId: string;
  apiKey: string;
  apiSecret: string;
  /** Canlı `https://api.tgoapps.com`; test ortamı Trendyol'un verdiği adres */
  apiUrl: string;
  /** User-Agent ve x-agentname'deki entegratör adı */
  agentName: string;
}

export const trendyolConfigured = (c: TrendyolConfig) => !!(c.supplierId && c.apiKey && c.apiSecret);

// ─── Paket modeli (belgedeki alanlar; hepsi isteğe bağlı okunur) ───────────────

export interface TrendyolPromotion {
  name?: string;
  description?: string;
  /** TL; `amount` nesne (value + sellerCoverageRatio) ya da sayı gelebilir */
  amount?: { value?: number; sellerCoverageRatio?: number } | number;
  sellerCoverageRatio?: number;
}

export interface TrendyolLine {
  id?: number | string;
  lineId?: number | string;
  productId?: number | string;
  name?: string;
  /** Birim fiyat (TL) */
  price?: number;
  unitPrice?: number;
  quantity?: number;
  /** Bazı sürümlerde adet yerine satırın birimleri (`items`) gelir */
  items?: unknown[];
  modifierProducts?: { name?: string; price?: number; modifierProducts?: { name?: string; price?: number }[] }[];
  extraIngredients?: { name?: string; price?: number }[];
  removedIngredients?: { name?: string }[];
  promotions?: TrendyolPromotion[];
  note?: string;
}

export interface TrendyolPackage {
  id: number | string;
  orderNumber?: string;
  /** Kuryenin ve personelin söylediği kısa kod (3; Uber geçişiyle 5 karakter) */
  orderCode?: string;
  packageStatus?: string;
  /** `GO`: Trendyol Go kuryesi; `STORE`: restoran teslim eder ya da müşteri gelip alır */
  deliveryType?: string;
  storePickupSelected?: boolean;
  packageCreationDate?: number | string;
  packageModificationDate?: number | string;
  preparationTime?: number;
  callCenterPhone?: string;
  customerNote?: string;
  /** Uber geçişi: kuryeye söylenen teslim kodu */
  pinCode?: string;
  customer?: { firstName?: string; lastName?: string };
  address?: {
    fullName?: string;
    address1?: string;
    address2?: string;
    addressDescription?: string;
    apartmentNumber?: string;
    doorNumber?: string;
    floor?: string;
    neighborhood?: string;
    district?: string;
    city?: string;
    phone?: string;
  };
  lines?: TrendyolLine[];
  /** `paymentType`: PAY_WITH_CREDIT_CARD (online), PAY_WITH_CASH, PAY_WITH_MULTINET… (kapıda) */
  payment?: { paymentType?: string; cardType?: string } | string;
  /** Müşterinin ödediği (TL) */
  totalPrice?: number;
  promotions?: TrendyolPromotion[];
}

export interface TrendyolPage {
  content?: TrendyolPackage[];
  page?: number;
  size?: number;
  totalPages?: number;
  totalElements?: number;
}

const toKurus = (tl: unknown): number => (typeof tl === 'number' && Number.isFinite(tl) ? Math.round(tl * 100) : typeof tl === 'string' && tl.trim() ? Math.round(Number(tl.replace(',', '.')) * 100) || 0 : 0);
const toMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Kampanyanın tutarı (kuruş) ve restoranın payı (0-1) */
function promotionParts(p: TrendyolPromotion): { value: number; sellerRatio: number } {
  const value = typeof p.amount === 'number' ? toKurus(p.amount) : toKurus(p.amount?.value);
  const raw = typeof p.amount === 'object' && p.amount ? p.amount.sellerCoverageRatio : p.sellerCoverageRatio;
  // Oran 0-1 ya da 0-100 gelebilir
  const ratio = typeof raw === 'number' && Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : 0;
  return { value, sellerRatio: Math.min(1, Math.max(0, ratio)) };
}

/**
 * Tanınan online ödeme türleri (Trendyol uygulamasında kartla ya da cüzdanla ödenmiş). Burada olmayan ve kapıda
 * sayılmayan tür online sayılır ama doğrulanır (`verify`): kendi kuryemizin siparişinde kapıda ödemeyse kasa açık verir
 */
export const TRENDYOL_ONLINE_PAYMENTS: ReadonlySet<string> = new Set(['PAY_WITH_CREDIT_CARD', 'PAY_WITH_DEBIT_CARD', 'PAY_WITH_CARD', 'PAY_WITH_WALLET', 'PAY_ONLINE', 'ONLINE', 'CREDIT_CARD', 'DEBIT_CARD']);

/** Ödeme türü metninden: online mı, kapıda ne; tanınmayan tür `verify` (ham adıyla `raw`) */
export function paymentOf(pkg: TrendyolPackage): { online: boolean; label: string; verify?: boolean; raw?: string } {
  const given = (typeof pkg.payment === 'string' ? pkg.payment : (pkg.payment?.paymentType ?? '')).trim();
  const raw = given.toUpperCase();
  const cardType = typeof pkg.payment === 'object' && pkg.payment ? text(pkg.payment.cardType) : null;
  if (!raw) return { online: true, label: 'Online' };
  if (raw.includes('CASH') || raw.includes('NAKIT')) return { online: false, label: 'Kapıda nakit' };
  const cards: [string, string][] = [
    ['MULTINET', 'Multinet'],
    ['PLUXEE', 'Pluxee'],
    ['SODEXO', 'Pluxee'],
    ['EDENRED', 'Edenred'],
    ['TICKET', 'Edenred'],
    ['SETCARD', 'Setcard'],
    ['METROPOL', 'Metropol'],
    ['TOKENFLEX', 'Tokenflex'],
  ];
  for (const [key, label] of cards) if (raw.includes(key)) return { online: false, label: `Kapıda ${label}` };
  if (raw.includes('DOOR') || raw.includes('KAPIDA')) return { online: false, label: `Kapıda ${cardType ?? 'kart'}` };
  const label = `Online ${cardType ?? 'kart'}`.trim();
  return TRENDYOL_ONLINE_PAYMENTS.has(raw) ? { online: true, label } : { online: true, label, verify: true, raw: given };
}

/** Kim götürür: GO → platform kuryesi; STORE → gel-al ya da kendi kuryemiz */
export function courierOf(pkg: TrendyolPackage): PlatformCourier {
  if ((pkg.deliveryType ?? '').toUpperCase() === 'GO') return 'platform';
  return pkg.storePickupSelected ? 'gelal' : 'restoran';
}

function addressOf(pkg: TrendyolPackage): string | null {
  const a = pkg.address;
  if (!a) return null;
  const detail = [a.apartmentNumber && `Apt ${a.apartmentNumber}`, a.floor && `Kat ${a.floor}`, a.doorNumber && `Daire ${a.doorNumber}`].filter(Boolean).join(' ');
  const parts = [a.address1, a.address2, detail, a.addressDescription, a.neighborhood, a.district, a.city].map(text).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Trendyol paketi → LafPOS'un tek biçimi. Satırın birim fiyatı ürün + seçenek + ekstra; kampanyalar restoranın payı
 * oranında adisyon indirimi, kalanı platformun. Paketin `totalPrice`'ı (müşterinin ödediği) varsa esas odur:
 * kampanya alanı farklı anlaşılmışsa fark platform indirimine yazılır, böylece müşteri toplamı = kalemler − bizden −
 * platformdan eşitliği bozulmaz (kasa platformun ödeyeceği tutarı kalemler − bizden diye hesaplar).
 */
export function fromTrendyolPackage(pkg: TrendyolPackage, now = Date.now()): PlatformOrderPayload {
  const courier = courierOf(pkg);
  const pay = paymentOf(pkg);
  const lines: PlatformOrderPayload['lines'] = [];
  let restaurantDiscount = 0;
  let platformDiscount = 0;
  const addPromotions = (list: TrendyolPromotion[] | undefined, times = 1) => {
    for (const p of list ?? []) {
      const { value, sellerRatio } = promotionParts(p);
      const total = value * times;
      const ours = Math.round(total * sellerRatio);
      restaurantDiscount += ours;
      platformDiscount += total - ours;
    }
  };
  for (const l of pkg.lines ?? []) {
    const qty = Math.max(1, Math.round(typeof l.quantity === 'number' ? l.quantity : Array.isArray(l.items) && l.items.length ? l.items.length : 1));
    const base = toKurus(l.unitPrice ?? l.price);
    const modifiers: string[] = [];
    let extra = 0;
    for (const m of l.modifierProducts ?? []) {
      if (text(m.name)) modifiers.push(m.name!.trim());
      extra += toKurus(m.price);
      for (const mm of m.modifierProducts ?? []) {
        if (text(mm.name)) modifiers.push(mm.name!.trim());
        extra += toKurus(mm.price);
      }
    }
    for (const e of l.extraIngredients ?? []) {
      if (text(e.name)) modifiers.push(`+${e.name!.trim()}`);
      extra += toKurus(e.price);
    }
    for (const r of l.removedIngredients ?? []) if (text(r.name)) modifiers.push(`−${r.name!.trim()}`);
    lines.push({ externalId: l.productId != null ? String(l.productId) : null, name: text(l.name) ?? 'Ürün', qty, unitPrice: base + extra, modifiers, note: text(l.note) });
    addPromotions(l.promotions, qty);
  }
  addPromotions(pkg.promotions);
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  restaurantDiscount = Math.min(restaurantDiscount, subtotal);
  platformDiscount = Math.min(platformDiscount, subtotal - restaurantDiscount);
  const paidTotal = pkg.totalPrice != null ? toKurus(pkg.totalPrice) : null;
  let customerTotal = subtotal - restaurantDiscount - platformDiscount;
  // Ödenen tutar yoksa ya da kalemleri (restoran kampanyası düşülmüş) aşıyorsa tutar Trendyol'dan doğrulanmalı:
  // kampanya alanlarından hesaplanan kalır, otomatik kabul edilmez
  let amountReview: string | null = paidTotal == null ? 'Trendyol ödenen tutarı vermedi' : null;
  if (paidTotal != null && paidTotal >= 0 && paidTotal <= subtotal - restaurantDiscount) {
    // Müşterinin ödediği esastır: kampanya alanlarının anlaşılmayan kısmı platformun karşıladığı farktır
    platformDiscount = subtotal - restaurantDiscount - paidTotal;
    customerTotal = paidTotal;
  } else if (paidTotal != null) {
    amountReview = `Trendyol'da ödenen ${tl(paidTotal)}, kalemler ${tl(subtotal - restaurantDiscount)}: farkı Trendyol'dan doğrulayın`;
  }
  // Kendi kuryemizin siparişinde ödeme türü yoksa ya da tanınmıyorsa online sayılır (tahmin; elle kabulde de öyle):
  // tahsilat Trendyol'dan doğrulanmalı, otomatik kabul edilmez
  const noPayment = !(typeof pkg.payment === 'string' ? pkg.payment : pkg.payment?.paymentType);
  if (noPayment && courier !== 'platform') amountReview ??= 'Ödeme türü gelmedi: tahsilatı Trendyol\'dan doğrulayın';
  if (pay.verify && courier !== 'platform') amountReview ??= `Ödeme türü tanınmadı (${pay.raw}): tahsilatı Trendyol'dan doğrulayın`;
  const name = [text(pkg.customer?.firstName), text(pkg.customer?.lastName)].filter(Boolean).join(' ') || text(pkg.address?.fullName);
  const phone = text(pkg.address?.phone) ?? text(pkg.callCenterPhone);
  const noteParts = [text(pkg.customerNote), pkg.pinCode ? `Teslim PIN ${pkg.pinCode}` : null].filter(Boolean);
  return {
    platform: 'trendyol',
    simulated: false,
    externalId: String(pkg.id),
    code: text(pkg.orderCode) ?? (text(pkg.orderNumber)?.slice(-4) ?? String(pkg.id).slice(-4)),
    placedAt: toMs(pkg.packageCreationDate) ?? now,
    scheduledFor: null,
    courier,
    // Online ödendiyse ya da kapıda ödemeyi Trendyol Go kuryesi alıyorsa tahsilat platformun; kendi kuryemiz kapıda alırsa kasada
    platformCollects: pay.online || courier === 'platform',
    paymentLabel: pay.label,
    customer: { name, phone: courier === 'restoran' ? phone : null, address: courier === 'restoran' ? addressOf(pkg) : null },
    note: noteParts.length ? noteParts.join(' · ') : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal,
    ...(amountReview ? { amountReview } : {}),
  };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

export class TrendyolHttpError extends PlatformHttpError {}

function headersFor(c: TrendyolConfig): Record<string, string> {
  return {
    authorization: `Basic ${btoa(`${c.apiKey}:${c.apiSecret}`)}`,
    'user-agent': `${c.supplierId} - ${c.agentName}`,
    'x-agentname': c.agentName,
    'x-executor-user': c.agentName,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

export async function trendyolRequest(c: TrendyolConfig, method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, timeoutMs = 8000): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.apiUrl.replace(/\/+$/, '')}${path}`, { method, headers: headersFor(c), body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal }).catch((e) => {
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
  const msg = json && typeof json === 'object' ? ((json as { message?: string; error?: string }).message ?? (json as { error?: string }).error) : typeof json === 'string' ? json.slice(0, 120) : null;
  const why = status === 401 || status === 403 ? 'anahtar reddedildi' : status === 429 ? 'istek sınırı aşıldı' : status === 404 ? 'paket bulunamadı' : `HTTP ${status}`;
  return msg ? `${why}: ${msg}` : why;
}

async function put(c: TrendyolConfig, path: string, body: unknown): Promise<void> {
  const { status, json } = await trendyolRequest(c, 'PUT', path, body);
  if (status < 200 || status >= 300) throw new TrendyolHttpError(status, explain(status, json));
}

/**
 * Bir durumun paketleri, verilen değişiklik penceresinde (ms), sayfa sayfa. Yanıt beklenen biçimde değilse
 * (içerik dizisi yok) hata: boş liste sanılıp bekleyen sipariş gözden kaçmasın.
 */
export async function fetchPackages(c: TrendyolConfig, status: string, startMs: number, endMs: number, maxPages = 10): Promise<TrendyolPackage[]> {
  const out: TrendyolPackage[] = [];
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ packageStatus: status, packageModificationStartDate: String(startMs), packageModificationEndDate: String(endMs), page: String(page), size: '50' });
    const { status: code, json } = await trendyolRequest(c, 'GET', `${TRENDYOL_PATHS.packages(c.supplierId)}?${q}`);
    if (code !== 200) throw new TrendyolHttpError(code, explain(code, json));
    const body = json as TrendyolPage | TrendyolPackage[] | null;
    const content = Array.isArray(body) ? body : body?.content;
    if (!Array.isArray(content)) throw new TrendyolHttpError(502, 'paket listesi beklenen biçimde gelmedi');
    out.push(...content.filter((p) => p && p.id != null));
    const totalPages = Array.isArray(body) ? 1 : (body?.totalPages ?? 1);
    if (page + 1 >= totalPages || content.length === 0) break;
  }
  return out;
}

/** Yoklama penceresi: son başarılı yoklamadan 10 dk önceye kadar (kaçan değişiklik yakalanır); ilk kez 2 saat */
export const POLL_OVERLAP_MS = 10 * 60_000;
export const FIRST_POLL_WINDOW_MS = 2 * 3600_000;

/** Bağdaştırıcı (server/delivery/adapter.ts arayüzü); yapılandırma dışarıdan gelir (env, test) */
export function trendyolAdapter(c: TrendyolConfig): PlatformAdapter {
  return {
    platform: 'trendyol',
    label: PLATFORM_LABEL.trendyol,
    configured: () => trendyolConfigured(c),
    async poll(sinceMs, now) {
      const start = Math.max(0, sinceMs - POLL_OVERLAP_MS);
      const created = await fetchPackages(c, TRENDYOL_STATUS.created, start, now);
      const cancelled = await fetchPackages(c, TRENDYOL_STATUS.cancelled, start, now);
      // Bozuk paket ötekileri durdurmaz: atlanır, kimliğiyle bildirilir
      const orders: PlatformOrderPayload[] = [];
      const invalid: { externalId: string; error: string }[] = [];
      for (const p of created) {
        try {
          orders.push(fromTrendyolPackage(p, now));
        } catch (e) {
          invalid.push({ externalId: String(p.id), error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { orders, cancelled: cancelled.map((p) => String(p.id)), invalid };
    },
    accept: (order, prepMinutes) => put(c, TRENDYOL_PATHS.picked(c.supplierId, order.externalId), { preparationTime: prepMinutes }),
    reject: (order, reason) => put(c, TRENDYOL_PATHS.unsupplied(c.supplierId, order.externalId), { reasonCode: TRENDYOL_REASON_CODES[reason] ?? TRENDYOL_REASON_OTHER }),
    async notify(order, status: PlatformNotify, courier) {
      const id = order.externalId;
      if (status === 'hazir') {
        await put(c, TRENDYOL_PATHS.invoiced(c.supplierId, id), {});
        return true;
      }
      // Platform kuryesi alınca ve teslim edince platform kendi yazar; kendi kuryemiz ve gel-al bizden
      if (courier === 'platform') return false;
      if (status === 'yolda') {
        await put(c, TRENDYOL_PATHS.shipped(c.supplierId, id), {});
        return true;
      }
      await put(c, TRENDYOL_PATHS.delivered(c.supplierId, id), {});
      return true;
    },
  };
}
