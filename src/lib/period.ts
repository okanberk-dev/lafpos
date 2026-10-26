import { addDays, businessDate, istanbulParts } from '@shared/time';

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

/** İş günü tarihleriyle dönem aralığı (hafta pazartesi başlar) */
export function periodRange(key: Exclude<PeriodKey, 'ozel'>, now = Date.now()): { from: string; to: string } {
  const today = businessDate(now);
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
