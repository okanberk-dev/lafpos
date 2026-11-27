import { tl } from '@shared/money';
import { PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload } from '@shared/platforms';
import { networkError, type PlatformAdapter, PlatformHttpError, type PlatformNotify } from './adapter';

/**
 * Trendyol Go Yemek (Uber Eats Türkiye siparişleri de buradan gelir) bağdaştırıcısı: yalnız yoklama (platform
 * kasayı aramaz), kasadan doğrudan. Kaynak: developers.tgoapps.com (Canlı-Test Ortam Bilgileri, Authorization; Yemek ›
 * Sipariş Entegrasyonu › Sipariş Paketlerini Çekme, Paket Modelleri, Siparişi Kabul Etme, Sipariş Hazırlığının Bitmesi,
 * Siparişin Yola Çıkması, Siparişin Teslim Edilmesi, Sipariş İptali; Uber Eats geçişi), 22 Kasım 2026'da okundu (#74).
 *
 * - Adres: canlı `https://api.tgoapis.com` (IP izni gerekmez), test `https://stageapi.tgoapis.com` (IP izni ister).
 * - Kimlik: Basic (API anahtarı:gizli anahtar), `User-Agent: "<satıcı no> - SelfIntegration"` (yazılım bizim),
 *   `x-agentname`, `x-executor-user` (işlemi yapanın e-postası). Uç başına 10 saniyede 50 istek: 20 saniyelik yoklama
 *   bunun çok altında.
 * - Sipariş: `GET /integrator/order/meal/suppliers/{id}/packages` (`packageStatuses` virgüllü, değişiklik zamanı
 *   süzgeci, sayfa 50); tek paket `GET …/packages/{paketId}`.
 * - Akış: `PUT …/packages/picked` `{ packageId, preparationTime }` (kabul) → `PUT …/packages/invoiced`
 *   `{ packageId, actualDate }` (hazır) → kendi kuryemizde `PUT …/packages/{paketId}/manual-shipped` ve
 *   `/manual-delivered` `{ actualDate }`; ret ve iptal `PUT …/packages/unsupplied` `{ packageId, itemIdList, reasonId }`
 *   (tam iptalde paketin bütün `packageItemId`'leri).
 * - Paket modelleri: model 1 kendi kuryemiz (`deliveryType: STORE`), model 2 Trendyol Go kuryesi (`GO`); `appName`
 *   `Galaxy` ise sipariş GetirYemek by Uber Eats'ten gelmiştir (Getir siparişleri de bu API'den akar).
 *
 * Alan adları ve yollar bu dosyanın başındaki sabitlerde toplandı: canlıya geçmeden önce test ortamında (IP izniyle) ya
 * da panelden test siparişiyle bir tur atılır. Para TL ondalık gelir, kuruşa çevrilir.
 */

export const TRENDYOL_DEFAULT_URL = 'https://api.tgoapis.com';
export const TRENDYOL_STAGE_URL = 'https://stageapi.tgoapis.com';

/** Uç yolları (satıcı no ile); kabul, hazır ve ret yolunda paket kimliği yok, gövdededir */
export const TRENDYOL_PATHS = {
  packages: (supplierId: string) => `/integrator/order/meal/suppliers/${encodeURIComponent(supplierId)}/packages`,
  one: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}`,
  picked: (supplierId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/picked`,
  invoiced: (supplierId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/invoiced`,
  shipped: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/manual-shipped`,
  delivered: (supplierId: string, packageId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/${encodeURIComponent(packageId)}/manual-delivered`,
  unsupplied: (supplierId: string) => `${TRENDYOL_PATHS.packages(supplierId)}/unsupplied`,
};

/** Paket durumları (packageStatus): yeni sipariş `Created`; platformun iptali `Cancelled`; bizim iptalimiz `UnSupplied` */
export const TRENDYOL_STATUS = { created: 'Created', cancelled: 'Cancelled', unsupplied: 'UnSupplied' } as const;

/**
 * Restoran kaynaklı iptal nedenleri (`unsupplied` `reasonId`, belge: Paket Modelleri): 621 tedarik problemi, 622 mağaza
 * kapalı, 623 mağaza siparişi hazırlayamıyor, 624 yüksek yoğunluk / kurye yok (yalnız model 1), 626 alan dışı (yalnız
 * model 1), 627 sipariş karışıklığı. Kasadaki ret nedenleri (shared/platforms.ts REJECT_REASONS) böyle eşlenir;
 * "diğer" kodu yok, 623 gider.
 */
export const TRENDYOL_REASON_CODES: Record<string, number> = {
  'Ürün tükendi': 621,
  'Çok yoğunuz': 623,
  'Kapanmak üzereyiz': 622,
  'Adres hizmet alanı dışında': 626,
};
export const TRENDYOL_REASON_OTHER = 623;
/** Yalnız model 1'de (kendi kuryemiz) geçerli kodların kendi kuryemizdeki karşılığı */
const OWN_COURIER_REASON: Record<string, number> = { 'Çok yoğunuz': 624 };
const OWN_COURIER_ONLY = new Set([624, 626]);

/** Kasadaki ret nedeni → belgedeki `reasonId`; 624 ve 626 yalnız kendi kuryemizin siparişinde, ötekinde 623 */
export function trendyolReasonId(reason: string, courier: PlatformCourier): number {
  const own = courier === 'restoran';
  const id = (own ? OWN_COURIER_REASON[reason] : undefined) ?? TRENDYOL_REASON_CODES[reason] ?? TRENDYOL_REASON_OTHER;
  return !own && OWN_COURIER_ONLY.has(id) ? TRENDYOL_REASON_OTHER : id;
}

export interface TrendyolConfig {
  supplierId: string;
  apiKey: string;
  apiSecret: string;
  /** Canlı `https://api.tgoapis.com`; test ortamı `https://stageapi.tgoapis.com` */
  apiUrl: string;
  /** x-agentname ve User-Agent'taki entegratör adı (yazılım bizim: `SelfIntegration`) */
  agentName: string;
  /** x-executor-user: işlemi yapanın e-postası; boşsa entegratör adı gider */
  executorEmail?: string;
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

/** Satırın bir birimi: iptal (`unsupplied` `itemIdList`) bu kimlikle; kampanyalar birimde */
export interface TrendyolLineItem {
  packageItemId?: string | number;
  lineItemId?: string | number;
  isCancelled?: boolean;
  coupon?: TrendyolPromotion | null;
  promotions?: TrendyolPromotion[] | null;
}

export interface TrendyolLine {
  id?: number | string;
  lineId?: number | string;
  productId?: number | string;
  name?: string;
  /** Birim fiyat (TL), seçenekler dahil (belgedeki örneklerde totalPrice = Σ price × birim) */
  price?: number;
  unitSellingPrice?: number;
  unitPrice?: number;
  quantity?: number;
  /** Satırın birimleri: adet iptal edilmemiş birim sayısıdır */
  items?: TrendyolLineItem[];
  modifierProducts?: { name?: string; price?: number; modifierProducts?: { name?: string; price?: number }[] }[];
  extraIngredients?: { name?: string; price?: number }[];
  removedIngredients?: { name?: string }[];
  promotions?: TrendyolPromotion[] | null;
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
  /**
   * `paymentType`: `PAY_WITH_CARD` online (yemek kartıysa `mealCard` dolu); `PAY_WITH_ON_DELIVERY` kapıda, türü
   * `onDelivery`'de (CASH, CARD, SODEXO_CARD…)
   */
  payment?: { paymentType?: string; cardType?: string; mealCard?: unknown; onDelivery?: unknown } | string;
  /** Müşterinin ödediği (TL) */
  totalPrice?: number;
  coupon?: TrendyolPromotion | null;
  promotions?: TrendyolPromotion[] | null;
  /** Panelden oluşturulan test siparişi */
  testPackage?: boolean;
  /** `Trendyol`, `TrendyolGo` ya da `Galaxy` (GetirYemek by Uber Eats) */
  userInformation?: { appName?: string } | null;
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
 * sayılmayan tür online sayılır ama doğrulanır (`verify`): kendi kuryemizin siparişinde kapıda ödemeyse kasa açık verir.
 * Belgedeki kapıda ödeme `PAY_WITH_ON_DELIVERY`'dir (aşağıda ayrıca)
 */
export const TRENDYOL_ONLINE_PAYMENTS: ReadonlySet<string> = new Set(['PAY_WITH_CREDIT_CARD', 'PAY_WITH_DEBIT_CARD', 'PAY_WITH_CARD', 'PAY_WITH_WALLET', 'PAY_ONLINE', 'ONLINE', 'CREDIT_CARD', 'DEBIT_CARD']);

/**
 * Ödeme türü metninden: online mı, kapıda ne; tanınmayan tür `verify` (ham adıyla `raw`). Tür gelmediyse (boş ya da
 * yalnız boşluk) `missing`: online sayılır, kendi kuryemizin siparişinde tahsilat doğrulanır
 */
export function paymentOf(pkg: TrendyolPackage): { online: boolean; label: string; verify?: boolean; raw?: string; missing?: boolean } {
  const given = (typeof pkg.payment === 'string' ? pkg.payment : (pkg.payment?.paymentType ?? '')).trim();
  const raw = given.toUpperCase();
  const cardType = typeof pkg.payment === 'object' && pkg.payment ? text(pkg.payment.cardType) : null;
  if (!raw) return { online: true, label: 'Online', missing: true };
  // Belge: kapıda ödeme PAY_WITH_ON_DELIVERY, türü onDelivery'de (dize; nesne gelirse dize alanlarından biri)
  if (raw.includes('ON_DELIVERY')) {
    const od = typeof pkg.payment === 'object' && pkg.payment ? pkg.payment.onDelivery : null;
    const sub = (typeof od === 'string' ? od : od && typeof od === 'object' ? Object.values(od).find((v): v is string => typeof v === 'string' && !!v.trim()) : '') ?? '';
    return { online: false, label: onDeliveryLabel(sub.trim().toUpperCase()) };
  }
  if (raw.includes('CASH') || raw.includes('NAKIT')) return { online: false, label: 'Kapıda nakit' };
  const voucher = voucherName(raw);
  if (voucher) return { online: false, label: `Kapıda ${voucher}` };
  if (raw.includes('DOOR') || raw.includes('KAPIDA')) return { online: false, label: `Kapıda ${cardType ?? 'kart'}` };
  const meal = typeof pkg.payment === 'object' && pkg.payment ? pkg.payment.mealCard : null;
  if (meal != null && meal !== false && meal !== '' && TRENDYOL_ONLINE_PAYMENTS.has(raw)) return { online: true, label: 'Online yemek kartı' };
  const label = `Online ${cardType ?? 'kart'}`.trim();
  return TRENDYOL_ONLINE_PAYMENTS.has(raw) ? { online: true, label } : { online: true, label, verify: true, raw: given };
}

const VOUCHERS: [string, string][] = [
  ['MULTINET', 'Multinet'],
  ['PLUXEE', 'Pluxee'],
  ['SODEXO', 'Pluxee'],
  ['EDENRED', 'Edenred'],
  ['TICKET', 'Edenred'],
  ['SETCARD', 'Setcard'],
  ['METROPOL', 'Metropol'],
  ['TOKENFLEX', 'Tokenflex'],
  ['PAYEKART', 'Paye'],
  ['IWALLET', 'iWallet'],
];
const voucherName = (raw: string) => VOUCHERS.find(([key]) => raw.includes(key))?.[1] ?? null;

/** `onDelivery` türü → kasadaki ad: CASH nakit, CARD kart, yemek kartları adıyla (`_CODE` ise "kod") */
function onDeliveryLabel(sub: string): string {
  if (!sub) return 'Kapıda ödeme';
  if (sub === 'CASH' || sub.includes('NAKIT')) return 'Kapıda nakit';
  const voucher = voucherName(sub);
  if (voucher) return `Kapıda ${voucher}${sub.endsWith('_CODE') ? ' kod' : ''}`;
  if (sub === 'CARD' || sub.includes('CARD')) return 'Kapıda kart';
  return 'Kapıda ödeme';
}

/** Kim götürür: GO → platform kuryesi; STORE → gel-al ya da kendi kuryemiz */
export function courierOf(pkg: TrendyolPackage): PlatformCourier {
  if ((pkg.deliveryType ?? '').toUpperCase() === 'GO') return 'platform';
  return pkg.storePickupSelected ? 'gelal' : 'restoran';
}

/** Belge: model 1'de apartman, kat ve kapı "TGO Yemek" dolgusu gelir (gerçek adres address1'de), model 2'de hepsi */
const FILLER = /TGO\s*Yemek/i;
const real = (v: unknown): string | null => {
  const t = text(v);
  return t && !FILLER.test(t) ? t : null;
};

function addressOf(pkg: TrendyolPackage): string | null {
  const a = pkg.address;
  if (!a) return null;
  const apt = real(a.apartmentNumber);
  const floor = real(a.floor);
  const door = real(a.doorNumber);
  const detail = [apt && `Apt ${apt}`, floor && `Kat ${floor}`, door && `Daire ${door}`].filter(Boolean).join(' ');
  const parts = [a.address1, a.address2, detail, a.addressDescription, a.neighborhood, a.district, a.city].map(real).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Trendyol paketi → AsilPOS'un tek biçimi. Satırın birim fiyatı `price` (belgede seçenekler dahil: örneklerde
 * totalPrice = Σ price × birim; `modifierProducts[].price` yalnız bilgi, eklenmez); adet iptal edilmemiş birim sayısı.
 * Kampanyalar satırda, birimde (`items[].promotions`, `coupon`) ve pakette (`promotions`, `coupon`); restoranın payı
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
  const addPromotions = (list: (TrendyolPromotion | null | undefined)[] | null | undefined, times = 1) => {
    for (const p of list ?? []) {
      if (!p || typeof p !== 'object') continue;
      const { value, sellerRatio } = promotionParts(p);
      const total = value * times;
      const ours = Math.round(total * sellerRatio);
      restaurantDiscount += ours;
      platformDiscount += total - ours;
    }
  };
  for (const l of pkg.lines ?? []) {
    const units = Array.isArray(l.items) ? l.items.filter((i) => i && typeof i === 'object') : [];
    const active = units.filter((i) => i.isCancelled !== true);
    // Birimlerin hepsi iptal edilmişse satır yok
    if (units.length && !active.length) continue;
    const qty = Math.max(1, Math.round(units.length ? active.length : typeof l.quantity === 'number' ? l.quantity : 1));
    // Liste fiyatı (seçenekler dahil); indirimler kampanya alanlarından düşülür
    const unitPrice = toKurus(l.price ?? l.unitSellingPrice ?? l.unitPrice);
    const modifiers: string[] = [];
    for (const m of l.modifierProducts ?? []) {
      if (text(m.name)) modifiers.push(m.name!.trim());
      for (const mm of m.modifierProducts ?? []) if (text(mm.name)) modifiers.push(mm.name!.trim());
    }
    for (const e of l.extraIngredients ?? []) if (text(e.name)) modifiers.push(`+${e.name!.trim()}`);
    for (const r of l.removedIngredients ?? []) if (text(r.name)) modifiers.push(`−${r.name!.trim()}`);
    lines.push({ externalId: l.productId != null ? String(l.productId) : null, name: text(l.name) ?? 'Ürün', qty, unitPrice, modifiers, note: text(l.note) });
    addPromotions(l.promotions, qty);
    for (const i of active) addPromotions([...(i.promotions ?? []), i.coupon]);
  }
  addPromotions([...(pkg.promotions ?? []), pkg.coupon]);
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
  // Kendi kuryemizin siparişinde ödeme türü yoksa (yalnız boşluk da: `paymentOf`'un kırptığı değer) ya da tanınmıyorsa
  // online sayılır (tahmin; elle kabulde de öyle): tahsilat Trendyol'dan doğrulanmalı, otomatik kabul edilmez
  if (pay.missing && courier !== 'platform') amountReview ??= 'Ödeme türü gelmedi: tahsilatı Trendyol\'dan doğrulayın';
  if (pay.verify && courier !== 'platform') amountReview ??= `Ödeme türü tanınmadı (${pay.raw}): tahsilatı Trendyol'dan doğrulayın`;
  // Panelden oluşturulan test siparişi gerçek satış değildir: otomatik kabul edilmez, notta işaretli
  if (pkg.testPackage === true) amountReview = 'Trendyol test siparişi: otomatik kabul edilmez';
  const name = [text(pkg.customer?.firstName), text(pkg.customer?.lastName)].filter(Boolean).join(' ') || text(pkg.address?.fullName);
  const phone = text(pkg.address?.phone) ?? text(pkg.callCenterPhone);
  const getir = text(pkg.userInformation?.appName)?.toLowerCase() === 'galaxy';
  const noteParts = [pkg.testPackage === true ? 'Test siparişi' : null, getir ? 'Getir (Uber) siparişi' : null, text(pkg.customerNote), pkg.pinCode ? `Teslim PIN ${pkg.pinCode}` : null].filter(Boolean);
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
    'x-executor-user': c.executorEmail || c.agentName,
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
    const q = new URLSearchParams({ packageStatuses: status, packageModificationStartDate: String(startMs), packageModificationEndDate: String(endMs), page: String(page), size: '50' });
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

/**
 * Tam iptal için paketin iptal edilmemiş birimlerinin `packageItemId`'leri (belge: Sipariş İptali), tek paket ucundan.
 * Yanıt paket ya da sayfa (`{ content: [paket] }`) olabilir. Okunamazsa ret düşer: kimliksiz iptal gönderilmez.
 */
export async function packageItemIds(c: TrendyolConfig, packageId: string): Promise<string[]> {
  const { status, json } = await trendyolRequest(c, 'GET', TRENDYOL_PATHS.one(c.supplierId, packageId));
  if (status !== 200) throw new TrendyolHttpError(status, explain(status, json));
  const body = json as (TrendyolPackage & TrendyolPage) | null;
  const pkg = Array.isArray(body?.content) ? (body.content.find((p) => p && String(p.id) === packageId) ?? body.content[0]) : body;
  const ids: string[] = [];
  for (const l of Array.isArray(pkg?.lines) ? pkg.lines : []) {
    for (const i of Array.isArray(l?.items) ? l.items : []) if (i && i.isCancelled !== true && i.packageItemId != null && String(i.packageItemId)) ids.push(String(i.packageItemId));
  }
  if (!ids.length) throw new TrendyolHttpError(502, 'paket kalemleri okunamadı');
  return ids;
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
    accept: (order, prepMinutes) => put(c, TRENDYOL_PATHS.picked(c.supplierId), { packageId: order.externalId, preparationTime: prepMinutes }),
    async reject(order, reason) {
      const itemIdList = await packageItemIds(c, order.externalId);
      await put(c, TRENDYOL_PATHS.unsupplied(c.supplierId), { packageId: order.externalId, itemIdList, reasonId: trendyolReasonId(reason, order.courier) });
    },
    async notify(order, status: PlatformNotify, courier) {
      const id = order.externalId;
      if (status === 'hazir') {
        await put(c, TRENDYOL_PATHS.invoiced(c.supplierId), { packageId: id, actualDate: Date.now() });
        return true;
      }
      // Platform kuryesi alınca ve teslim edince platform kendi yazar; kendi kuryemiz ve gel-al bizden
      if (courier === 'platform') return false;
      if (status === 'yolda') {
        await put(c, TRENDYOL_PATHS.shipped(c.supplierId, id), { actualDate: Date.now() });
        return true;
      }
      await put(c, TRENDYOL_PATHS.delivered(c.supplierId, id), { actualDate: Date.now() });
      return true;
    },
  };
}
