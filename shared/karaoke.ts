import { tl } from './money';

/**
 * Sitedeki karaoke rezervasyonunu kasa nasıl okur. Kurallar sitenindir (laffogato `docs/LAFPOS.md` › "Karaoke
 * satırını kasa nasıl okur"; `holdsSlot`, `karaokeMoneyOf`); burada kasanın iki sorusuna çevrilir: oda bu saatte
 * tutulu mu, blok önceden ödenmiş mi. Saf: sunucu (ücretlendirme) ve ekran (oda kutusu, masa planı) aynı kuralı okur.
 * docs/03-ENTEGRASYON.md §2.4
 */

export type SiteKaraokeStatus = 'requested' | 'confirmed' | 'cancelled';
export type SiteKaraokePayment = 'none' | 'pending' | 'paid' | 'refunding' | 'refunded' | 'expired';

/** Sitenin `GET /api/panel/karaoke` satırı (`toPanelReservation` beyaz listesi): yalnız ad, saat, kişi, durumlar, not, tutar */
export interface SiteKaraokeBooking {
  /** "krk-00042"; kapıda "KRK-00042" diye sorulur */
  id: string;
  /** İstanbul takvim günü, YYYY-MM-DD */
  date: string;
  startHour: number;
  hours: number;
  /** Bloğun başladığı ve bittiği an, ISO-8601 */
  startsAt: string;
  endsAt: string;
  guests: number;
  status: SiteKaraokeStatus;
  paymentStatus: SiteKaraokePayment;
  firstName: string;
  note: string;
  totalMinor: number;
  /** web, uygulama; boş: köşkün personelinin açtığı satır (ör. telafi saati) */
  channel: 'web' | 'app' | '';
}

export const SITE_KARAOKE_STATUSES: readonly SiteKaraokeStatus[] = ['requested', 'confirmed', 'cancelled'];
export const SITE_KARAOKE_PAYMENTS: readonly SiteKaraokePayment[] = ['none', 'pending', 'paid', 'refunding', 'refunded', 'expired'];

/** Oda tutulu: yalnız `requested` ya da `confirmed`. İptal satırı ödeme durumu ne olursa olsun odayı bırakmıştır */
export const holdsRoom = (b: Pick<SiteKaraokeBooking, 'status'>) => b.status === 'requested' || b.status === 'confirmed';

/**
 * Bloğun kasadaki karşılığı:
 * - `paid`: sitede ödendi (online karaoke cirosu); kasa yalnız bloğu aşan süreyi kendi saat ücretiyle alır.
 * - `till`: köşkte ödenecek (`none`); blok satırın tutarını (`totalMinor`, üye indirimi içinde) öder, aşan süre saat
 *   ücretiyle. Tutarı 0 olan satır (köşkün ücretsiz telafi saati) bloğu ücretsizdir.
 * - `null`: blok yok sayılır, bütün süre saat ücretiyle: iptal, ödemesi süren (`pending`), iadesi süren ya da yapılmış,
 *   süresi dolmuş. Bilinmeyen durum güvenli tarafa okunur (sitenin kuralı: bilinmeyen ödeme `none`).
 */
export type BlockTerms = 'paid' | 'till' | null;

export function blockTerms(b: Pick<SiteKaraokeBooking, 'status' | 'paymentStatus'> | null | undefined): BlockTerms {
  if (!b || !holdsRoom(b)) return null;
  if (b.paymentStatus === 'paid') return 'paid';
  if (b.paymentStatus === 'none') return 'till';
  return null;
}

/**
 * "Sayacı başlat"ta seçilebilir: oda tutulu ve ödemesi sitede alınmış, köşkte alınacak ya da sürüyor. Ödemesi süren
 * rezervasyon bağlanabilir: sayaç durunca güncel durumu okunur (ödendiyse blok düşer, değilse bütün süre ücretlenir)
 */
export const linkableBooking = (b: Pick<SiteKaraokeBooking, 'status' | 'paymentStatus'>) =>
  holdsRoom(b) && (b.paymentStatus === 'paid' || b.paymentStatus === 'none' || b.paymentStatus === 'pending');

/** Köşkün ücretsiz telafi saati: tutarı 0, notu "Telafi: KRK-…" (site personelinin açtığı satır) */
export const isMakeGood = (b: Pick<SiteKaraokeBooking, 'paymentStatus' | 'totalMinor' | 'note'>) =>
  b.paymentStatus === 'none' && b.totalMinor === 0 && /^telafi:\s*krk-/i.test(b.note.trim());

/** "krk-00042" → "KRK-00042": kapıda sorulan kod */
export const bookingCode = (id: string) => id.toUpperCase();

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/** "20:00-22:00" (24:00 gece yarısıdır) */
export const bookingHours = (b: Pick<SiteKaraokeBooking, 'startHour' | 'hours'>) => `${hh(b.startHour)}-${b.startHour + b.hours === 24 ? '24:00' : hh(b.startHour + b.hours)}`;

/** Ödeme durumunun kasadaki adı ve tonu (rozet) */
export function bookingPayment(b: SiteKaraokeBooking): { text: string; tone: 'green' | 'warn' | 'neutral' | 'red' } {
  if (b.status === 'cancelled') return { text: 'İptal', tone: 'neutral' };
  switch (b.paymentStatus) {
    case 'paid':
      return { text: 'Sitede ödendi', tone: 'green' };
    case 'none':
      return isMakeGood(b) ? { text: 'Ücretsiz telafi saati', tone: 'green' } : { text: `Köşkte ödenecek · ${tl(b.totalMinor)}`, tone: 'warn' };
    case 'pending':
      return { text: 'Ödemesi sürüyor', tone: 'warn' };
    case 'refunding':
      return { text: 'İadesi sürüyor', tone: 'neutral' };
    case 'refunded':
      return { text: 'İade edildi', tone: 'neutral' };
    default:
      return { text: 'Ödeme süresi doldu', tone: 'red' };
  }
}

/** Sayaç başlatılırken önerilecek pencere: başlangıçtan bu kadar önce (erken gelen grup) */
export const SUGGEST_BEFORE_MS = 60 * 60_000;

/**
 * "Sayacı başlat"ta o saate düşen rezervasyonlar: bağlanabilir, başlangıcına en çok bir saat kalmış ve bitmemiş;
 * başlangıcı şimdiye en yakın olan önce
 */
export function bookingsAtHand<T extends SiteKaraokeBooking>(bookings: T[], nowMs: number): T[] {
  return bookings
    .filter((b) => linkableBooking(b) && Date.parse(b.startsAt) - SUGGEST_BEFORE_MS <= nowMs && nowMs < Date.parse(b.endsAt))
    .sort((a, b) => Math.abs(Date.parse(a.startsAt) - nowMs) - Math.abs(Date.parse(b.startsAt) - nowMs));
}

/** Sayaca bağlanan rezervasyonun kasada saklanan kısmı (`room_sessions.booking`): ad ve not saklanmaz */
export type RoomBookingSnapshot = Pick<SiteKaraokeBooking, 'id' | 'date' | 'startHour' | 'hours' | 'status' | 'paymentStatus' | 'totalMinor'>;

export const snapshotOf = (b: SiteKaraokeBooking): RoomBookingSnapshot => ({
  id: b.id,
  date: b.date,
  startHour: b.startHour,
  hours: b.hours,
  status: b.status,
  paymentStatus: b.paymentStatus,
  totalMinor: b.totalMinor,
});
