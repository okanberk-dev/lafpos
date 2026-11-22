/**
 * Merkez lisansı (docs/KALANLAR.md Merkez kararları, docs/07-UZAKTAN-ERISIM.md §4 Merkez): kasa da Merkez paneli de
 * aynı kuralla hesaplar.
 *
 * - Onaysız kurulum (Merkez'de "Onay bekliyor") kurulduğu andan 14 gün deneme süresinde çalışır.
 * - Aktif lisans bitiş gününün sonuna (İstanbul) kadar; bitişsiz aktif süresizdir. Bitişe 14 gün kala yalnız uyarı
 *   (`soon`): satışa hiçbir etkisi yok.
 * - Pasif ya da süresi dolmuş lisansta önce uyarı çıkar; 7 gün sonra yeni satış kapanır. Kayıtlar, raporlar ve açık
 *   adisyonun tahsilatı her durumda açık kalır.
 * - Çevrimdışı kasada satış hiç kapanmaz (kesin kural): satışın kapanması için kasanın Merkez'den lisans kaydını son
 *   15 dakikada (`CONFIRM_MS`, üç nabız) almış olması gerekir. İnternet ya da Merkez yokken kasa son kayıtla ve kendi
 *   saatiyle hesaplar ama en çok uyarı gösterir: süresi dolmuş lisans çevrimdışı kasada satışı durdurmaz. Böylece
 *   sahibin Merkez'de uzattığı lisansı henüz alamamış kasa durmaz; bedeli, internetten kopan kasanın kapanmamasıdır.
 */
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
/** Aktif lisansın bitişine bu kadar gün kala kasada ve panelde "yakında bitiyor" uyarısı (yalnız uyarı) */
export const SOON_DAYS = 14;
/** Satışın kapanabilmesi için Merkez'in lisans kaydını en geç bu kadar önce onaylamış olması (üç nabız) */
export const CONFIRM_MS = 15 * 60_000;
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
  /** Aktif lisansın bitişine `SOON_DAYS` günden az kaldı (yalnız uyarı) */
  soon?: boolean;
  /** Kural satışı kapatırdı ama Merkez son 15 dakikada onaylamadı (kasa çevrimdışı): satış sürer, yalnız uyarı */
  offline?: boolean;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD gününün İstanbul'da son anı (Türkiye 2016'dan beri sabit UTC+3) */
export function endOfDayIstanbul(date: string): number {
  return Date.parse(`${date}T23:59:59.999+03:00`);
}

const dayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = (ms: number) => dayFmt.format(new Date(ms));
const daysLeft = (from: number, to: number) => Math.max(1, Math.ceil((to - from) / DAY_MS));

export interface LicenseOpts {
  installedAt: number;
  now: number;
  /**
   * Lisans kaydının Merkez'den en son alındığı an (kasada son başarılı nabız, panelde kasanın son görülmesi). Verilirse
   * (null dahil) kural satışı kapatacakken bu an `CONFIRM_MS`'den eskiyse sonuç uyarıda kalır: çevrimdışı kasa satışı
   * kesmez. Verilmezse yalın kural (testler)
   */
  confirmedAt?: number | null;
}

export function licenseState(rec: LicenseRecord | null | undefined, opts: LicenseOpts): LicenseView {
  const { installedAt, now } = opts;
  let expiredAt: number;
  let reason: string;
  const durum = rec?.durum ?? 'bekliyor';
  if (durum === 'aktif') {
    const end = rec?.bitis && DATE_RE.test(rec.bitis) ? endOfDayIstanbul(rec.bitis) : null;
    if (end == null) return { state: 'aktif', until: null, message: 'Lisans etkin' };
    if (now <= end) {
      if (end - now < SOON_DAYS * DAY_MS) return { state: 'aktif', until: end, soon: true, message: `Lisans ${fmtDay(end)} tarihinde bitiyor: ${daysLeft(now, end)} gün kaldı` };
      return { state: 'aktif', until: end, message: `Lisans ${fmtDay(end)} tarihine kadar etkin` };
    }
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
  // Çevrimdışı kasa satışı kesmez: kapanma yalnız Merkez'in yakın zamanda onayladığı kayıtla
  if (opts.confirmedAt !== undefined && (opts.confirmedAt == null || now - opts.confirmedAt > CONFIRM_MS)) {
    return { state: 'uyari', until: null, offline: true, message: `${reason}: kasa Merkez'e ulaşamıyor, satış sürüyor. İnternet gelince lisans denetlenir` };
  }
  return { state: 'kapali', until: null, message: `${reason}: yeni satış kapalı. Kayıtlar ve raporlar açık` };
}

/** Yeni satış (adisyon açma, kalem ekleme) açık mı */
export const salesAllowed = (v: LicenseView) => v.state !== 'kapali';

/**
 * Şube kodu (Merkez'de sahip verir: "MRN", "TZL-2"): büyük harf, rakam ve tire, en çok 12 karakter. Boş: kod yok (null);
 * kurala uymayan: undefined (panel 400 döner, kasa yok sayar)
 */
export const BRANCH_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
export function normalizeBranchCode(v: unknown): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  if (!s) return null;
  return BRANCH_CODE_RE.test(s) ? s : undefined;
}

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
