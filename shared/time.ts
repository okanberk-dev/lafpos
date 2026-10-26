/** Saat dilimi her zaman İstanbul (lafmaliyet ve laffogato ile aynı kural). */
export const TZ = 'Europe/Istanbul';
/** İş günü bu saatte döner: 03:00'te kapanan gece önceki günün cirosudur. */
export const DAY_ROLLOVER_HOUR = 5;

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

/** İş gününün başladığı an (o tarihin 05:00'i, İstanbul = UTC+3, yaz saati yok) */
export function businessDayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, DAY_ROLLOVER_HOUR - 3, 0, 0);
}

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

export const fmtTime = (ms: number) => timeFmt.format(new Date(ms));
export const fmtDateTime = (ms: number) => dateTimeFmt.format(new Date(ms));
/** "2026-10-26" -> "26 Ekim 2026 Pazartesi" */
export const fmtDateLong = (date: string) => dateLongFmt.format(new Date(`${date}T12:00:00Z`));

/** Geçen süre: "4 dk", "1 sa 12 dk" */
export function fmtElapsed(fromMs: number, toMs = Date.now()): string {
  const min = Math.max(0, Math.floor((toMs - fromMs) / 60000));
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}

/** "HH:MM" metnini dakikaya çevirir */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}
