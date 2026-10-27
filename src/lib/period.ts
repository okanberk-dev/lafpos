import { addDays, BUSINESS_HOURS, businessHourIndex, istanbulParts } from '@shared/time';

export type PeriodKey = 'bugun' | 'dun' | 'hafta' | 'gecenhafta' | 'ay' | 'gecenay' | 'ozel';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  bugun: 'Bugün',
  dun: 'Dün',
  hafta: 'Bu hafta',
  gecenhafta: 'Geçen hafta',
  ay: 'Bu ay',
  gecenay: 'Geçen ay',
  ozel: 'Tarih seç',
};

/**
 * İş günü tarihleriyle dönem aralığı (hafta pazartesi başlar). `today` raporların bugünüdür:
 * `currentBusinessDate(boot.day?.date)`; gün 05:00'te kapanmadıysa satış hâlâ açık güne yazılır, takvim günü değil.
 */
export function periodRange(key: Exclude<PeriodKey, 'ozel'>, today: string): { from: string; to: string } {
  const weekday = istanbulParts(Date.parse(`${today}T12:00:00Z`)).weekday;
  const monday = addDays(today, -(weekday - 1));
  const [y, m] = today.split('-').map(Number);
  const firstOfMonth = `${y}-${String(m).padStart(2, '0')}-01`;
  switch (key) {
    case 'bugun':
      return { from: today, to: today };
    case 'dun':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'hafta':
      return { from: monday, to: today };
    case 'gecenhafta':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'ay':
      return { from: firstOfMonth, to: today };
    case 'gecenay': {
      const lastPrev = addDays(firstOfMonth, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

const shortFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'short' });
export const fmtShortDate = (date: string) => shortFmt.format(new Date(`${date}T12:00:00Z`));

export function rangeLabel(r: { from: string; to: string }) {
  return r.from === r.to ? fmtShortDate(r.from) : `${fmtShortDate(r.from)} – ${fmtShortDate(r.to)}`;
}

/** Patron panelinin saat dizileri (server/services/reports.ts patronLive) */
export interface HourlySeries {
  /** Bugün, saat numarasıyla (0-23) */
  hourly: number[];
  hourlyLastWeek?: number[];
  /** Gün 05:00'i geçip 24 saati aştıysa ertesi günün saatleri: [0] ertesi gün 05:00, [1] 06:00… */
  hourlyNextDay?: number[];
  hourlyLastWeekNextDay?: number[];
}

export interface HourBar {
  key: string;
  /** Eksen: saat ("06") */
  label: string;
  /** İpucu ve tablo: "06:00", ertesi günse "06:00 · ertesi gün" */
  title: string;
  nextDay: boolean;
  value: number;
  compare: number;
}

/** "06:00" ya da "06:00 · ertesi gün" (gün 05:00'te kapanmadı, satış hâlâ açık güne yazıldı) */
export const hourTitle = (hour: number, nextDay = false) => `${String(hour).padStart(2, '0')}:00${nextDay ? ' · ertesi gün' : ''}`;

/**
 * Bugünün saat saat grafiği (patron paneli, genel bakış): çubuklar iş günü sırasıyla, 05:00'ten ertesi 05:00'e;
 * gece yarısından sonraki satış günün sonunda durur. Gün 24 saati aştıysa (masa açık kaldı, gün kapanmadı) ertesi
 * sabahın satışı aynı saatin sabahki çubuğuna karışmaz, gecenin ardından kendi çubuğunda çizilir. Boş sabah saatleri
 * `from`a kadar, boş gece saatleri 23:00'ten sonra gösterilmez.
 */
export function hourBars(s: HourlySeries, from = 7): HourBar[] {
  const bar = (key: string, hour: number, nextDay: boolean, value: number | undefined, compare: number | undefined): HourBar => ({
    key,
    label: String(hour).padStart(2, '0'),
    title: hourTitle(hour, nextDay),
    nextDay,
    value: value ?? 0,
    compare: compare ?? 0,
  });
  const next = Math.max(s.hourlyNextDay?.length ?? 0, s.hourlyLastWeekNextDay?.length ?? 0);
  const bars = [
    ...BUSINESS_HOURS.map((hour) => bar(`g${hour}`, hour, false, s.hourly[hour], s.hourlyLastWeek?.[hour])),
    ...Array.from({ length: next }, (_, i) => bar(`e${i}`, BUSINESS_HOURS[i % 24]!, true, s.hourlyNextDay?.[i], s.hourlyLastWeekNextDay?.[i])),
  ];
  const active = bars.flatMap((b, i) => (b.value || b.compare ? [i] : []));
  const start = Math.min(businessHourIndex(from), active[0] ?? 24);
  const end = Math.max(businessHourIndex(23), active.at(-1) ?? 0);
  return bars.slice(start, end + 1);
}

/** Saat satırlarını iş günü sırasına dizer (05:00 ilk, gece yarısından sonrası son) */
export const byBusinessHour = <T extends { hour: number }>(rows: T[]): T[] => [...rows].sort((a, b) => businessHourIndex(a.hour) - businessHourIndex(b.hour));
