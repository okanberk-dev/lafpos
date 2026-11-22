/**
 * Patron panelinin "Bugün" kıyasları (dün, geçen hafta aynı gün, geçen ay aynı gün; hafta ve ay başından bugüne; gün
 * sonu tahmini; birikimli ciro eğrisi; en çok satanların geçen haftaya göre değişimi). Saf işlevler: kasa
 * (`server/services/reports.ts` `patronLive`) girdiyi kurar, ekran (kafede ve LafPOS Uzaktan'da) şu anki saatle
 * hesaplar. Girdi saatten bağımsızdır (kapanış dakikaları ve tam gün toplamları): özet yalnız satışla değişir, Uzaktan'ın
 * sürüm ve ETag kuralı bozulmaz, kıyas her yoklamada Redis'ten okunmaz.
 *
 * Ölçüt Raporlar › Ciro'nunkiyle aynı (`summaryReport`, `comparison`): ciro kapanmış POS adisyonlarının toplamı (online
 * ödenmiş sipariş, ikram ve ödenmez dışı; KDV ve servis dahil), adisyon tutarı olan kapanmış adisyon, gün İstanbul iş
 * günü (05:00). Gün sürerken kıyas günü de "aynı saate kadar" (gün başından aynı dakikaya kadar kapanan; Uzaktan
 * Raporlar'daki gibi dakika duyarlılığıyla), gün kapanınca tam gün. İş günü olmayan tarih "veri yok"tur, ₺0 değil.
 */
import { addDays, businessDayStartMs } from './time';

/** Kapanış dakikası (gün başından, 05:00), ciro, tutarı olan adisyon: yalnız dolu dakikalar (`closingMinutes`) */
export type Close = [number, number, number];

export interface StatsDay {
  /** O tarihin iş günü hâlâ açık mı */
  open: boolean;
  closes: Close[];
}

/** Kasanın patron özetine koyduğu girdi (`PatronData.stats`); eski sunucu göndermez */
export interface PatronStats {
  v: 1;
  /** Bugün masada oturan kişi (masa adisyonlarının kişi sayısı, Raporlar'daki gibi) */
  guests: number;
  /** Bugün, dün, 7/14/21/28 gün önce ve geçen ayın aynı günü; iş günü olmayan tarih yok */
  days: Record<string, StatsDay>;
  /** Hafta ve ay kıyası için geçmiş tam günler: [tarih, ciro, adisyon], iş günü olanlar, dünden geriye */
  daily: [string, number, number][];
  /** Geçen haftanın aynı günü, bugünün en çok satanları (`top` sırası) için: [sıra, dakika, adet, ciro] */
  topPrev: [number, number, number, number][];
}

export interface Sales {
  netSales: number;
  receipts: number;
}

export type StatsMode = 'live' | 'closed' | 'none';

export interface Compare {
  key: 'dun' | 'hafta' | 'ay';
  label: string;
  /** Kıyas günü; geçen ayda o gün yoksa (31 Ekim → Eylül'de 31 yok) null */
  date: string | null;
  /** Aynı saate kadar (gün sürerken) ya da tam gün; iş günü yoksa null ("veri yok") */
  value: Sales | null;
  /** O günün gün sonu toplamı (gün sürerken küçük satır) */
  full: Sales | null;
  /** Değişim yüzdesi (tek ondalık); kıyas sıfırsa ya da veri yoksa null */
  change: number | null;
  diff: number | null;
}

export interface Period {
  key: 'hafta' | 'ay';
  label: string;
  cur: Sales & { from: string; to: string; days: number };
  prev: Sales & { from: string; to: string; days: number };
  change: number | null;
  /** Geçen ayda bugünün günü yoksa önceki ayın tamamı */
  wholePrev: boolean;
}

export const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

const sumCloses = (closes: Close[], untilMin: number | null): Sales => {
  let netSales = 0;
  let receipts = 0;
  for (const [m, rev, n] of closes) {
    if (untilMin != null && m > untilMin) continue;
    netSales += rev;
    receipts += n;
  }
  return { netSales, receipts };
};

/** Takvimde geçen ayın aynı günü; geçen ayda o gün yoksa (31 → 30 günlük ay, 29-31 Mart → Şubat) null */
export function sameDayLastMonth(date: string): string | null {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const prevDays = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  if (d > prevDays) return null;
  return new Date(Date.UTC(y, m - 2, d)).toISOString().slice(0, 10);
}

/** Haftanın Pazartesi'si (iş günü tarihine göre) */
export function weekStart(date: string): string {
  const wd = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}

export const monthStart = (date: string) => `${date.slice(0, 8)}01`;

/** Önceki ayın ilk günü ve gün sayısı */
function prevMonth(date: string) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10),
    days: new Date(Date.UTC(y, m - 1, 0)).getUTCDate(),
  };
}

/** Kasanın göndereceği tarihler (girdiyi kuran ve test eden aynı listeyi kullanır) */
export function statsDates(today: string) {
  const lastMonth = sameDayLastMonth(today);
  const curves = [today, addDays(today, -1), addDays(today, -7), addDays(today, -14), addDays(today, -21), addDays(today, -28), ...(lastMonth ? [lastMonth] : [])];
  // Tam günler: geçen haftanın Pazartesi'sinden ya da önceki ayın 1'inden (hangisi önceyse) düne kadar
  const ws = addDays(weekStart(today), -7);
  const pm = prevMonth(today).start;
  return {
    curves: [...new Set(curves)],
    dailyFrom: ws < pm ? ws : pm,
    dailyTo: addDays(today, -1),
    lastMonth,
  };
}

/** Gün sürerken kesim dakikası: gün başından geçen tam dakika (kıyas günü de bu dakikaya kadar) */
export function cutoffMinute(date: string, nowMs: number) {
  return Math.floor((nowMs - businessDayStartMs(date)) / 60_000);
}

export interface TodayInput {
  date: string;
  dayOpen: boolean;
  netSales: number;
  orders: number;
}

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
/** "22 Ekim Çarşamba" (yıl yok; kıyas satırında kısa) */
export const dayLabel = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${DAY_NAMES[d.getUTCDay()]}`;
};
export const monthName = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1]!;

/**
 * Bütün kıyaslar. `mode`: gün açık ve bugünün günü ("live", aynı saate kadar), bugünün günü kapandı ("closed", tam
 * gün), bugün iş günü yok ("none": gün açılmadı; kıyas günlerinin tam günü yazılır, yüzde yok)
 */
export function todayStats(t: TodayInput, s: PatronStats, nowMs: number) {
  const todayDay = s.days[t.date];
  const mode: StatsMode = t.dayOpen && todayDay ? 'live' : todayDay ? 'closed' : 'none';
  const cut = mode === 'live' ? cutoffMinute(t.date, nowMs) : null;
  const today: Sales = { netSales: t.netSales, receipts: t.orders };

  const at = (date: string | null) => {
    const day = date ? s.days[date] : undefined;
    return day ? { value: sumCloses(day.closes, cut), full: sumCloses(day.closes, null) } : { value: null, full: null };
  };
  const cmp = (key: Compare['key'], label: string, date: string | null): Compare => {
    const { value, full } = at(date);
    const live = mode !== 'none' && value;
    return {
      key,
      label,
      date,
      value,
      full,
      change: live ? change(today.netSales, value.netSales) : null,
      diff: live ? today.netSales - value.netSales : null,
    };
  };
  const lastMonth = sameDayLastMonth(t.date);
  const compares = [cmp('dun', 'Dün', addDays(t.date, -1)), cmp('hafta', 'Geçen hafta aynı gün', addDays(t.date, -7)), cmp('ay', 'Geçen ay aynı gün', lastMonth)];

  // Hafta ve ay başından bugüne: geçmiş tam günler + bugün; önceki dönemin aynı günü kıyas günüyle aynı kesimle
  const daily = new Map(s.daily.map(([d, rev, n]) => [d, { netSales: rev, receipts: n }]));
  const sumDays = (from: string, to: string) => {
    let netSales = 0;
    let receipts = 0;
    let days = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = daily.get(d);
      if (!r) continue;
      netSales += r.netSales;
      receipts += r.receipts;
      days += 1;
    }
    return { netSales, receipts, days };
  };
  const withToday = mode !== 'none';
  const period = (key: Period['key'], from: string, prevFrom: string, prevSame: string | null, prevTo: string): Period | null => {
    const yesterday = addDays(t.date, -1);
    const cur = sumDays(from, yesterday);
    if (withToday) {
      cur.netSales += today.netSales;
      cur.receipts += today.receipts;
      cur.days += 1;
    }
    // Bugünsüz dönem (gün açılmadı) bugünün kıyas gününü de saymaz: aynı gün sayısı
    const prevEnd = withToday ? prevTo : prevSame ? addDays(prevSame, -1) : prevTo;
    const before = prevSame ? sumDays(prevFrom, addDays(prevSame, -1)) : sumDays(prevFrom, prevEnd);
    if (prevSame && withToday) {
      const same = at(prevSame).value;
      if (same) {
        before.netSales += same.netSales;
        before.receipts += same.receipts;
        before.days += 1;
      }
    }
    if (!cur.days) return null;
    const curTo = withToday ? t.date : yesterday;
    return {
      key,
      label: key === 'hafta' ? 'Hafta başından' : 'Ay başından',
      cur: { ...cur, from, to: curTo },
      prev: {
        ...before,
        from: prevFrom,
        to: prevSame && withToday ? prevSame : prevEnd,
      },
      change: before.days ? change(cur.netSales, before.netSales) : null,
      wholePrev: !prevSame,
    };
  };
  const ws = weekStart(t.date);
  const pm = prevMonth(t.date);
  const periods = [period('hafta', ws, addDays(ws, -7), addDays(t.date, -7), addDays(t.date, -7)), period('ay', monthStart(t.date), pm.start, lastMonth, addDays(pm.start, pm.days - 1))].filter(
    (p): p is Period => p != null,
  );

  return {
    mode,
    cutoffMin: cut,
    today,
    guests: s.guests,
    compares,
    periods,
    forecast: forecast(t, s, cut),
    curve: curves(t.date, s, cut),
  };
}

/**
 * Gün sonu tahmini (yalnız gün sürerken): son 4 aynı haftagününün (7, 14, 21, 28 gün önce) bu saate kadarki payı
 * (Σ aynı saate kadar / Σ gün sonu); bugünün cirosu bu paya bölünür. En az 2 satışlı gün ve %10 pay gerekir
 * (sabahın ilk satışı tahmini uçurmasın); değilse null
 */
export function forecast(t: TodayInput, s: PatronStats, cut: number | null): { value: number; days: number; share: number } | null {
  if (cut == null || t.netSales <= 0) return null;
  let part = 0;
  let whole = 0;
  let days = 0;
  for (const back of [7, 14, 21, 28]) {
    const day = s.days[addDays(t.date, -back)];
    if (!day) continue;
    const full = sumCloses(day.closes, null).netSales;
    if (full <= 0) continue;
    part += sumCloses(day.closes, cut).netSales;
    whole += full;
    days += 1;
  }
  if (days < 2 || whole <= 0 || part / whole < 0.1) return null;
  return {
    value: Math.max(t.netSales, Math.round((t.netSales * whole) / part)),
    days,
    share: Math.round((part / whole) * 1000) / 10,
  };
}

/**
 * Birikimli ciro (saat başlarında): bugün (gün sürerken şu ana kadar) ve geçen haftanın aynı günü (bütün gün). Nokta
 * i, gün başından (05:00) i saat sonraki toplam; son nokta bugünün kesimi
 */
export function curves(date: string, s: PatronStats, cut: number | null) {
  const cum = (closes: Close[], hours: number) => Array.from({ length: hours + 1 }, (_, h) => closes.reduce((a, [m, rev]) => (m < h * 60 ? a + rev : a), 0));
  const today = s.days[date];
  const prev = s.days[addDays(date, -7)];
  const lastMin = (closes: Close[]) => closes.reduce((a, [m]) => Math.max(a, m), 0);
  const end = Math.max(24, Math.ceil(((cut ?? 0) + 1) / 60), ...[today, prev].filter(Boolean).map((d) => Math.ceil((lastMin(d!.closes) + 1) / 60)));
  // Gün sürerken bugünün eğrisi geçmiş saat başlarında biter; şu anki toplam `todayNow`
  const todayLen = cut != null ? Math.min(end, Math.floor(cut / 60)) : end;
  return {
    hours: end,
    today: today ? cum(today.closes, end).slice(0, todayLen + 1) : null,
    /** Bugün gün sürerken son nokta tam saat değil: şu anki toplam */
    todayNow: today && cut != null ? sumCloses(today.closes, cut).netSales : null,
    lastWeek: prev ? cum(prev.closes, end) : null,
  };
}

/** En çok satanlar (ilk 5) ve geçen haftanın aynı günü (gün sürerken aynı saate kadar) */
export function topCompare<T extends { qty: number; revenue: number }>(top: T[], s: PatronStats, cut: number | null, hasLastWeek: boolean) {
  return top.slice(0, 5).map((p, i) => {
    let qty = 0;
    let revenue = 0;
    for (const [idx, m, q, rev] of s.topPrev) {
      if (idx !== i || (cut != null && m > cut)) continue;
      qty += q;
      revenue += rev;
    }
    return {
      ...p,
      prev: hasLastWeek ? { qty, revenue } : null,
      change: hasLastWeek ? change(p.revenue, revenue) : null,
    };
  });
}
