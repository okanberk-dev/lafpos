/**
 * Merkez lisansı (docs/KALANLAR.md Merkez kararları): kasa da Merkez paneli de aynı kuralla hesaplar.
 *
 * - Onaysız kurulum (Merkez'de "Onay bekliyor") kurulduğu andan 14 gün deneme süresinde çalışır.
 * - Aktif lisans bitiş gününün sonuna (İstanbul) kadar; bitişsiz aktif süresizdir.
 * - Pasif ya da süresi dolmuş lisansta önce uyarı çıkar; 7 gün sonra yeni satış kapanır. Kayıtlar, raporlar ve açık
 *   adisyonun tahsilatı açık kalır.
 * - Kasa son geçerli kaydı saklar: internet ya da Merkez yokken bu kayıtla ve kendi saatiyle hesaplar, durmaz.
 */
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export type LicenseStatus = 'bekliyor' | 'aktif' | 'pasif';

/** Merkez'in kurulum için tuttuğu lisans kaydı */
export interface LicenseRecord {
  durum: LicenseStatus;
  /** Aktif lisansın son günü (YYYY-MM-DD, İstanbul); yoksa süresiz */
  bitis?: string | null;
  /** Pasife alındığı an (ms); uyarı süresi buradan sayılır */
  pasifAt?: number | null;
}

export type LicenseState = 'deneme' | 'aktif' | 'uyari' | 'kapali';

export interface LicenseView {
  state: LicenseState;
  /** Durumun değişeceği an (deneme ya da aktifin bitişi, uyarının satışı kapatacağı an); süresizde null */
  until: number | null;
  /** Kısa, sade açıklama (kasada şerit, Merkez'de satır) */
  message: string;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD gününün İstanbul'da son anı (Türkiye 2016'dan beri sabit UTC+3) */
export function endOfDayIstanbul(date: string): number {
  return Date.parse(`${date}T23:59:59.999+03:00`);
}

const dayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = (ms: number) => dayFmt.format(new Date(ms));
const daysLeft = (from: number, to: number) => Math.max(1, Math.ceil((to - from) / DAY_MS));

export function licenseState(rec: LicenseRecord | null | undefined, opts: { installedAt: number; now: number }): LicenseView {
  const { installedAt, now } = opts;
  let expiredAt: number;
  let reason: string;
  const durum = rec?.durum ?? 'bekliyor';
  if (durum === 'aktif') {
    const end = rec?.bitis && DATE_RE.test(rec.bitis) ? endOfDayIstanbul(rec.bitis) : null;
    if (end == null) return { state: 'aktif', until: null, message: 'Lisans etkin' };
    if (now <= end) return { state: 'aktif', until: end, message: `Lisans ${fmtDay(end)} tarihine kadar etkin` };
    expiredAt = end;
    reason = 'Lisansın süresi doldu';
  } else if (durum === 'pasif') {
    expiredAt = rec?.pasifAt ?? now;
    reason = 'Lisans pasif';
  } else {
    const trialEnd = installedAt + TRIAL_DAYS * DAY_MS;
    if (now < trialEnd) return { state: 'deneme', until: trialEnd, message: `Deneme süresi: ${daysLeft(now, trialEnd)} gün kaldı` };
    expiredAt = trialEnd;
    reason = 'Deneme süresi bitti';
  }
  const closeAt = expiredAt + GRACE_DAYS * DAY_MS;
  if (now < closeAt) return { state: 'uyari', until: closeAt, message: `${reason}: ${daysLeft(now, closeAt)} gün sonra yeni satış kapanacak` };
  return { state: 'kapali', until: null, message: `${reason}: yeni satış kapalı. Kayıtlar ve raporlar açık` };
}

/** Yeni satış (adisyon açma, kalem ekleme) açık mı */
export const salesAllowed = (v: LicenseView) => v.state !== 'kapali';

/** Kasanın bildirdiği güncelleme durumunun Merkez'deki adı */
export const UPDATE_LABELS: Record<string, string> = {
  guncel: 'Kuruldu',
  indiriliyor: 'İndiriliyor',
  bekliyor: 'Gün kapanınca kurulacak',
  kuruluyor: 'Kuruluyor',
  'geri-dondu': 'Sorun çıktı, eski sürüme döndü',
  hata: 'Sorun çıktı',
  kapali: 'Güncelleme kapalı',
};

/** Merkez'e son 10 dakikada (kasa nabzı 5 dk'da bir) haber veren kurulum çevrimiçi sayılır */
export const ONLINE_MS = 10 * 60_000;
