/** Saat dilimi her zaman İstanbul (lafmaliyet ve laffogato ile aynı kural). */
export const TZ = 'Europe/Istanbul';
/** İş günü bu saatte döner: 03:00'te kapanan gece önceki günün cirosudur. */
export const DAY_ROLLOVER_HOUR = 5;

/** Mesai: bir mesai en çok 24 saat (yazmada; açık mesai raporda da en çok bu kadar sayılır) */
export const MAX_SHIFT_MS = 24 * 3600_000;
/** Mesai: önceki iş gününden açık kalan mesai en az bu kadar sürüyorsa çıkışı unutulmuştur (bkz. `shiftForgotten`) */
export const FORGOTTEN_MIN_MS = 8 * 3600_000;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

export interface IstanbulParts {
  date: string;
  hour: number;
  minute: number;
  /** 1 = Pazartesi … 7 = Pazar */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function istanbulParts(ms: number): IstanbulParts {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday] ?? 1,
  };
}

/** "YYYY-MM-DD" tarihine gün ekler (takvim hesabı, saat diliminden bağımsız) */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Verilen anın iş günü: 05:00'ten önceyse önceki takvim günü */
export function businessDate(ms: number): string {
  const p = istanbulParts(ms);
  return p.hour < DAY_ROLLOVER_HOUR ? addDays(p.date, -1) : p.date;
}

const dayMonthFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long' });

/**
 * Açık gün bugünün iş gününden eskiyse (gün sonu alınmadan 05:00 geçti) kasanın uyarısı, değilse null. Sunucu yeni
 * satışı bu metinle reddeder (409 `stale_day`), Kasa ekranı aynı metni bant olarak gösterir.
 */
export function staleDayMessage(day: { date: string; zNo: number }, nowMs = Date.now()): string | null {
  const today = businessDate(nowMs);
  if (day.date >= today) return null;
  const when = dayMonthFmt.format(new Date(`${day.date}T12:00:00Z`));
  return day.date === addDays(today, -1) ? `Dünün günü açık (${when}, Z ${day.zNo}). Önce gün sonunu alın` : `${when} günü hâlâ açık (Z ${day.zNo}). Önce gün sonunu alın`;
}

/**
 * Mesai: açık mesainin çıkışı unutulmuş mu. Ölçü süre değil iş günü: mesai önceki iş gününde (05:00 kuralı) başladı
 * ve 8 saatten uzun sürüyor. 20:00 girişi ertesi sabah 09:00'da unutulmuştur (13 saat); aynı günün 08:00–22:30'u
 * ve 22:00–06:00 gece vardiyası değildir. Unutulan mesai şimdiye kapatılmaz (kilit ekranı da kullanıcı menüsü de;
 * çıkış saatini bir yetkili girer), raporda ve CSV'de süresi sayılmaz.
 */
export function shiftForgotten(clockIn: number, now: number): boolean {
  return businessDate(clockIn) < businessDate(now) && now - clockIn > FORGOTTEN_MIN_MS;
}

/** İş gününün başladığı an (o tarihin 05:00'i, İstanbul = UTC+3, yaz saati yok) */
export function businessDayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, DAY_ROLLOVER_HOUR - 3, 0, 0);
}

/**
 * Raporların ve patron panelinin "bugün"ü: açık iş günü varsa onun tarihi (gün 05:00'te kapanmadıysa satış hâlâ
 * ona yazılır), yoksa şu anın iş günü. Sunucu ve istemci aynı kuralı kullanır.
 */
export function currentBusinessDate(openDayDate: string | null | undefined, now = Date.now()): string {
  return openDayDate ?? businessDate(now);
}

/** "YYYY-MM-DD" gerçek bir takvim günü mü (2026-02-30, 2026-13-01 değil; yıl 1000'den küçük değil) */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Saatin iş günündeki sırası: 05 → 0, 23 → 18, gece yarısından sonrası en sonda (04 → 23) */
export const businessHourIndex = (hour: number) => (hour - DAY_ROLLOVER_HOUR + 24) % 24;

/** İş gününün saatleri sırayla: 05, 06, …, 23, 00, …, 04 (saatlik grafik ve döküm bu sırayla) */
export const BUSINESS_HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => (i + DAY_ROLLOVER_HOUR) % 24);

const timeFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateLongFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const dateShortFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'short', weekday: 'short' });

export const fmtTime = (ms: number) => timeFmt.format(new Date(ms));
export const fmtDateTime = (ms: number) => dateTimeFmt.format(new Date(ms));
/** "2026-10-26" -> "26 Ekim 2026 Pazartesi" */
export const fmtDateLong = (date: string) => dateLongFmt.format(new Date(`${date}T12:00:00Z`));
/** "2026-10-26" -> "26 Eki Pzt" (tarih adımlayıcı gibi dar yerler) */
export const fmtDateShort = (date: string) => dateShortFmt.format(new Date(`${date}T12:00:00Z`));

/** Geçen süre: "4 dk", "1 sa 12 dk" */
export function fmtElapsed(fromMs: number, toMs = Date.now()): string {
  const min = Math.max(0, Math.floor((toMs - fromMs) / 60000));
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}

/**
 * Meta satırı için geçen süre ("az önce", "12 dk", "1 sa 5 dk"): bir dakikadan kısa süre "0 dk" yazılmaz.
 * Bar sayaçları ve gecikme rozeti fmtElapsed'de kalır (orada 0 dk da bilgidir)
 */
export function fmtAgo(fromMs: number, toMs = Date.now()): string {
  return toMs - fromMs < 60_000 ? 'az önce' : fmtElapsed(fromMs, toMs);
}

/** "HH:MM" metnini dakikaya çevirir */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}
