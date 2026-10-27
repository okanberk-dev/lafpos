/**
 * Servis modu (Yönetim › Ayarlar): işletmenin siparişi nasıl aldığı ve sunduğu. Sistemin akışı buna göre değişir;
 * ödeme kuralları değişmez, kalemler bara her modda aynı gider.
 *
 * - `masa` (varsayılan): garson masayı açar, sipariş masada alınır, hesap sonda ödenir (bugünkü akış).
 * - `yari_self`: sipariş ve ödeme kasada; kasiyer masa no ya da numaratör girer, personel masaya götürür.
 * - `self`: sipariş ve ödeme kasada; müşteri numarasını çağrı ekranında görünce tezgâhtan alır.
 */
export const SERVICE_MODES = ['masa', 'yari_self', 'self'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const DEFAULT_SERVICE_MODE: ServiceMode = 'masa';

export const SERVICE_MODE_LABEL: Record<ServiceMode, string> = {
  masa: 'Masaya servis',
  yari_self: 'Yarı self servis',
  self: 'Self servis',
};

/** Ayarlar sayfasında her modun altındaki tek satır */
export const SERVICE_MODE_HINT: Record<ServiceMode, string> = {
  masa: 'Garson masayı açar, sipariş masada alınır, hesap sonda ödenir',
  yari_self: 'Sipariş ve ödeme kasada, masa no ya da numaratörle personel masaya götürür',
  self: 'Sipariş ve ödeme kasada, müşteri numarası çağrılınca tezgâhtan alır',
};

/** Ayarlarda yoksa ya da tanınmıyorsa (eski kurulum, uzaktan özet) bugünkü akış */
export function serviceModeOf(settings?: { serviceMode?: unknown } | null): ServiceMode {
  const m = settings?.serviceMode;
  return typeof m === 'string' && (SERVICE_MODES as readonly string[]).includes(m) ? (m as ServiceMode) : DEFAULT_SERVICE_MODE;
}

/** Yeni satış tezgâhta başlar, önce ödeme alınır (self ve yarı self) */
export function isCounterFirst(mode: ServiceMode): boolean {
  return mode !== 'masa';
}

/** Tezgâh satışında ödemeden (ya da gönderimden) önce masa no / numaratör sorulur */
export function asksNumarator(mode: ServiceMode): boolean {
  return mode === 'yari_self';
}

export const NUMARATOR_MAX = 6;

/**
 * Masa no / numaratör: 1-6 harf ya da rakam ("12", "B4"). Boş değer temizler (null), geçersiz değer undefined.
 * Türkçe büyük harfe çevrilir; boşluk ve tire atılır.
 */
export function normalizeNumarator(raw: unknown): string | null | undefined {
  if (raw == null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const v = String(raw).replace(/[\s-]+/g, '').toLocaleUpperCase('tr-TR');
  if (!v) return null;
  if (v.length > NUMARATOR_MAX || !/^[0-9A-ZÇĞİÖŞÜ]+$/.test(v)) return undefined;
  return v;
}

/** Yazılırken masa no alanı: izinsiz karakter düşer, Türkçe büyük harf, en çok 6 ("b-4" → "B4") */
export function numaratorInput(raw: string): string {
  return raw
    .toLocaleUpperCase('tr-TR')
    .replace(/[^0-9A-ZÇĞİÖŞÜ]/g, '')
    .slice(0, NUMARATOR_MAX);
}

export function numaratorLabel(n: string): string {
  return `Masa ${n}`;
}

/**
 * Siparişin çağrı kimliği: masa no / numaratör girildiyse "Masa 12" (personel götürür), self modlarda tezgâh ve
 * gel-al siparişinde numara ("No 34", müşteri alır). Masaya servis modunda numarasız siparişte yok.
 */
export type CallId = { kind: 'masa'; value: string } | { kind: 'numara'; value: string };

export function callFor(o: { type: string; source: string; no: number; numarator: string | null }, mode: ServiceMode): CallId | null {
  if (o.numarator) return { kind: 'masa', value: o.numarator };
  if (mode === 'masa' || o.source !== 'pos' || (o.type !== 'tezgah' && o.type !== 'gelal')) return null;
  return { kind: 'numara', value: String(o.no) };
}

export function callText(c: CallId): string {
  return c.kind === 'masa' ? numaratorLabel(c.value) : `No ${c.value}`;
}

/**
 * Bar ekranındaki fişin başlığı: çağrı kimliği varsa büyük rozet, yanında tür (numara tekrar yazılmaz);
 * yoksa bugünkü etiket ve sipariş numarası.
 */
export function ticketHead(
  t: { label: string; orderNo: number; type: string; source: string; numarator: string | null },
  mode: ServiceMode,
): { call: string | null; label: string; showNo: boolean } {
  const call = callFor({ type: t.type, source: t.source, no: t.orderNo, numarator: t.numarator }, mode);
  if (!call) return { call: null, label: t.label, showNo: true };
  if (call.kind === 'masa') return { call: callText(call), label: '', showNo: true };
  return { call: callText(call), label: t.label.replace(new RegExp(` #${t.orderNo}$`), ''), showNo: false };
}
