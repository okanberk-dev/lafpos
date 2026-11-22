/**
 * Geçmiş ciro: dükkânın LafPOS'tan önceki kasa programında (ör. ModPOS) kalan günleri. Sahip Merkez'den bir kez yükler
 * (`POST merkez/gecmis`); bulutta dükkân başına tek anahtarda durur, kasaya gitmez. LafPOS Uzaktan'da patron panelinin
 * kıyasları (dün, geçen hafta bugün, geçen ay bugün; hafta ve ay toplamı) ve Raporlar o günleri de görür.
 *
 * Kural: bir tarih için hem geçmiş hem LafPOS'un gün raporu varsa cirosu büyük olan geçer (geçiş günlerinde LafPOS'ta
 * yalnız deneme satışı vardır; gerçek satış eski programdadır). İki kaynak toplanmaz: aynı satış iki kez sayılmasın.
 * Geçmiş gün yalnız ciro, adisyon, ödeme türü ve kapanış dakikasını taşır; ürün, personel ve KDV kırılımı yoktur.
 */
import { type StatsDayReport, reportStatsDates } from './remote-calc.js';
import type { RemoteDayReport } from './remote-reports.js';
import type { PatronStats } from './today-stats.js';

export const historyKey = (shop: string) => `lafpos:gecmis:${shop}`;
/** Kasada Merkez'den gelen geçmişin sync_state anahtarı (server/sync/merkez.ts yazar, reports.ts okur) */
export const GECMIS_KEY = 'merkez.gecmis';
/**
 * İşaret: dükkânın geçmişi var ve en son ne zaman yüklendi. Uzaktan'ın her istekte zaten okuduğu sürüm karmasında
 * (api/uzaktan.ts `VERSIONS_KEY`) ayrı alanda durur: geçmişi olmayan dükkânda tek ek Redis komutu çalışmaz, geçmişi
 * olanda kayıt işlev örneği başına bir kez okunur (işaret değişince yeniden)
 */
export const HISTORY_FLAG_HASH = 'lafpos:surum';
export const historyFlag = (shop: string) => `gecmis:${shop}`;

export interface HistoryDay {
  date: string;
  /** Günün cirosu (kuruş, KDV dahil) */
  ciro: number;
  adisyon: number;
  /** Kapanış dakikası (05:00'ten), ciro, adisyon; boşsa gün yalnız toplamıyla bilinir */
  closes: [number, number, number][];
  /** Ödeme türleri: [ad, Z alanı, tutar, adet] */
  pay: [string, string, number, number][];
}

export interface HistoryStore {
  v: 1;
  kaynak: string;
  at: number;
  gunler: HistoryDay[];
}

export const HISTORY_MAX_DAYS = 800;
const PAY_FIELDS: [key: 'kart' | 'nakit' | 'yemek', ad: string, alan: string][] = [
  ['kart', 'Kredi kartı', 'card'],
  ['nakit', 'Nakit', 'cash'],
  ['yemek', 'Yemek kartı', 'meal_card'],
];
const nat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e12;
const validDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Yüklenen günleri doğrular: `{ date, ciro, adisyon, closes?, kart?, nakit?, yemek? }`; kart, nakit, yemek
 * `[tutar, adet]`. Kapanışlar verildiyse toplamı günün cirosuna ve adisyonuna eşit olmalı (yarım yapıştırılmış veri
 * saklanmaz). Hata varsa sahibin okuyacağı cümle döner
 */
export function parseHistory(input: unknown): HistoryDay[] | string {
  if (!Array.isArray(input)) return 'Günler anlaşılamadı';
  if (input.length > HISTORY_MAX_DAYS) return `En çok ${HISTORY_MAX_DAYS} gün yüklenir`;
  const out = new Map<string, HistoryDay>();
  for (const raw of input) {
    const d = raw as Record<string, unknown>;
    if (!d || typeof d !== 'object' || !validDate(d.date)) return 'Tarih anlaşılamadı (YYYY-AA-GG)';
    if (!nat(d.ciro) || !nat(d.adisyon)) return `${d.date}: ciro ve adisyon tam sayı olmalı (ciro kuruş)`;
    const closes: HistoryDay['closes'] = [];
    if (d.closes != null) {
      if (!Array.isArray(d.closes) || d.closes.length > 2000) return `${d.date}: kapanışlar anlaşılamadı`;
      for (const c of d.closes as unknown[]) {
        if (!Array.isArray(c) || c.length !== 3 || !nat(c[0]) || c[0] >= 1440 || !nat(c[1]) || !nat(c[2])) return `${d.date}: kapanış satırı [dakika, kuruş, adisyon] olmalı`;
        closes.push([c[0], c[1], c[2]]);
      }
      closes.sort((a, b) => a[0] - b[0]);
      if (closes.length && (closes.reduce((a, c) => a + c[1], 0) !== d.ciro || closes.reduce((a, c) => a + c[2], 0) !== d.adisyon)) return `${d.date}: kapanışların toplamı günün cirosunu ve adisyonunu tutmuyor`;
    }
    const pay: HistoryDay['pay'] = [];
    for (const [key, ad, alan] of PAY_FIELDS) {
      const p = d[key];
      if (p == null) continue;
      if (!Array.isArray(p) || p.length !== 2 || !nat(p[0]) || !nat(p[1])) return `${d.date}: ${ad} [tutar, adet] olmalı`;
      if (p[0] > 0 || p[1] > 0) pay.push([ad, alan, p[0], p[1]]);
    }
    if (pay.length && pay.reduce((a, p) => a + p[2], 0) !== d.ciro) return `${d.date}: ödeme türlerinin toplamı günün cirosunu tutmuyor`;
    out.set(d.date, { date: d.date, ciro: d.ciro, adisyon: d.adisyon, closes, pay });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Saklanan kaydı okur; bozuksa ya da boşsa null */
export function readHistory(raw: string | null | undefined): HistoryDay[] | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<HistoryStore>;
    return s.v === 1 && Array.isArray(s.gunler) && s.gunler.length ? s.gunler : null;
  } catch {
    return null;
  }
}

/** Geçmiş günün Uzaktan Raporlar'daki karşılığı: kapanmış tek iş günü; bilinmeyen kırılımlar boş */
export function historyReport(d: HistoryDay): RemoteDayReport {
  const hours = new Map<number, [number, number, number]>();
  const clock = new Map<number, number>();
  for (const [min, rev, n] of d.closes) {
    const off = Math.floor(min / 60);
    const h = hours.get(off) ?? [off, 0, 0];
    h[1] += rev;
    h[2] += n;
    hours.set(off, h);
    const saat = (off + 5) % 24;
    clock.set(saat, (clock.get(saat) ?? 0) + rev);
  }
  return {
    v: 1,
    date: d.date,
    at: 0,
    n: 1,
    closed: true,
    z: [],
    s: { list: d.ciro, gross: d.ciro, comp: 0, disc: 0, svc: 0, rev: d.ciro, odenmez: 0, zayi: 0, voided: 0, receipts: d.adisyon, items: 0, tips: 0, guests: 0, tableSales: 0, paidClosed: d.ciro, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
    pay: d.pay,
    types: [],
    kdv: [],
    closes: d.closes,
    prod: [],
    hours: [...hours.values()].sort((a, b) => a[0] - b[0]),
    clock: [...clock.entries()].sort((a, b) => a[0] - b[0]),
    staff: [],
  };
}

/**
 * İstenen tarihlerde geçmişi gün raporlarına katar: LafPOS'un raporu yoksa ya da cirosu geçmişten küçükse geçmiş günü
 * geçer. `today` ve sonrası LafPOS'undur (bugünün canlı raporu ezilmez)
 */
export function fillHistory<T extends { date: string; s: { rev: number } }>(dates: string[], reps: T[], history: HistoryDay[] | null, today: string, make: (d: HistoryDay) => T): T[] {
  if (!history?.length) return reps;
  const want = new Set(dates);
  const byDate = new Map(reps.map((r) => [r.date, r]));
  for (const h of history) {
    if (!want.has(h.date) || h.date >= today) continue;
    const cur = byDate.get(h.date);
    if (!cur || cur.s.rev < h.ciro) byDate.set(h.date, make(h));
  }
  return [...byDate.values()];
}

/** Kıyasın okuduğu alanlar (api/uzaktan.ts `statsDays`) */
export function historyStatsDay(d: HistoryDay): StatsDayReport {
  return { date: d.date, n: 1, closed: true, s: { rev: d.ciro, receipts: d.adisyon }, closes: d.closes, hours: [] };
}

/**
 * Yeni kasanın kendi kurduğu kıyas girdisine (`PatronData.stats`) geçmişi katar: kıyas günlerinde (dün, 7/14/21/28 gün
 * önce, geçen ayın aynı günü) ve geçmiş tam günlerde, kasanın o gün için bildirdiği ciro geçmişten küçükse (ya da
 * gün hiç yoksa) geçmiş günü yazılır. Kapanış dakikası olmayan geçmiş günü yalnız gün sonu toplamıyla bilinir
 */
export function mergeHistoryStats(stats: PatronStats, today: string, history: HistoryDay[] | null): PatronStats {
  if (!history?.length) return stats;
  const { curves, dailyFrom, dailyTo } = reportStatsDates(today);
  const byDate = new Map(history.map((h) => [h.date, h]));
  const days = { ...stats.days };
  for (const date of curves) {
    const h = byDate.get(date);
    if (!h || date >= today) continue;
    const cur = days[date];
    if (cur && cur.closes.reduce((a, c) => a + c[1], 0) >= h.ciro) continue;
    days[date] = h.closes.length || h.ciro === 0 ? { open: false, closes: h.closes } : { open: false, closes: [[0, h.ciro, h.adisyon]], grain: 'gun' };
  }
  const daily = new Map(stats.daily.map((r) => [r[0], r]));
  for (const h of history) {
    if (h.date < dailyFrom || h.date > dailyTo || h.date >= today) continue;
    const cur = daily.get(h.date);
    if (!cur || cur[1] < h.ciro) daily.set(h.date, [h.date, h.ciro, h.adisyon]);
  }
  return { ...stats, days, daily: [...daily.values()].sort((a, b) => (a[0] < b[0] ? 1 : -1)) };
}
