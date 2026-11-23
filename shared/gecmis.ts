/**
 * Geçmiş ciro: dükkânın LafPOS'tan önceki kasa programında (ör. ModPOS) kalan günleri. İki kaynaktan gelir:
 * - lafmaliyet (ladmin): kasa ModPOS dönemini imzalı uçtan günde bir çeker (`GET /api/panel/pos/modpos-gunler`,
 *   server/sync/modpos.ts; `sync_state` `lafmaliyet.modpos`). Asıl kaynak budur; aynı tarihte elle yüklenenin yerine geçer.
 * - Merkez: sahibin daha önce yüklediği kayıt (`POST merkez/gecmis`; bulutta dükkân başına tek anahtar, nabızla kasaya
 *   gelir: `sync_state` `merkez.gecmis`).
 * Kasa ikisini birleştirir (`mergeHistory`, server/sync/modpos.ts `historyStore`): patron panelinin kıyasları, kasadaki
 * Raporlar (Ciro, Saatlik, Ürünler; günler kaynağın adıyla "ModPOS") ve LafPOS Uzaktan o günleri görür. Uzaktan'a kasa o
 * günleri (dönemin ürün listesiyle) kendi dükkân kimliğiyle gün raporu olarak iter (server/sync/cloud-reports.ts):
 * geçmiş bulutta başka anahtarda dursa ya da hiç yüklenmemiş olsa da "Geçen hafta" ModPOS günlerini gösterir. İş günü, Z
 * zinciri ve lafmaliyet giden kutusu geçmişi hiç görmez (tests/modpos-kasa.test.ts).
 *
 * Kural (bulut, `fillHistory`): bir tarih için hem geçmiş hem LafPOS'un gün raporu varsa cirosu büyük olan geçer (geçiş
 * günlerinde LafPOS'ta yalnız deneme satışı vardır; gerçek satış eski programdadır). İki kaynak toplanmaz: aynı satış iki
 * kez sayılmasın.
 *
 * Geçmiş gün ciro, adisyon, ödeme türü, indirim, ciro dışı (ödenmez ve ikram), KDV, önceki programın Z numarası ve (varsa)
 * kapanış dakikasını taşır; ürün kırılımı dönem için tek blok (`urunler`, indirim öncesi), personel kırılımı yoktur.
 * Para kuruş.
 */
import { splitKdv } from './money.js';
import { type StatsDayReport, reportStatsDates } from './remote-calc.js';
import type { RemoteDayReport } from './remote-reports.js';
import type { PatronStats } from './today-stats.js';

export const historyKey = (shop: string) => `lafpos:gecmis:${shop}`;
/** Kasada Merkez'den gelen geçmişin sync_state anahtarı (server/sync/merkez.ts yazar, server/sync/modpos.ts birleştirir) */
export const GECMIS_KEY = 'merkez.gecmis';
/** Kasada lafmaliyet'ten (ladmin) gelen ModPOS döneminin sync_state anahtarı (server/sync/modpos.ts) */
export const MODPOS_KEY = 'lafmaliyet.modpos';
/**
 * İşaret: dükkânın geçmişi var ve en son ne zaman yüklendi. Uzaktan'ın her istekte zaten okuduğu sürüm karmasında
 * (api/uzaktan.ts `VERSIONS_KEY`) ayrı alanda durur: geçmişi olmayan dükkânda tek ek Redis komutu çalışmaz, geçmişi
 * olanda kayıt işlev örneği başına bir kez okunur (işaret değişince yeniden)
 */
export const HISTORY_FLAG_HASH = 'lafpos:surum';
export const historyFlag = (shop: string) => `gecmis:${shop}`;

export interface HistoryDay {
  date: string;
  /** Günün cirosu (kuruş, KDV dahil, indirimden sonra) */
  ciro: number;
  adisyon: number;
  /** Kapanış dakikası (05:00'ten), ciro, adisyon; boşsa gün yalnız toplamıyla bilinir */
  closes: [number, number, number][];
  /** Ödeme türleri: [ad, Z alanı, tutar, adet] */
  pay: [string, string, number, number][];
  /** İndirim (kuruş); sıfırsa alan yok */
  indirim?: number;
  /**
   * İndirim bilinmiyor: gün yalnız ModPOS föyünden geldi (lafmaliyet'te kasa raporu yok; föyde indirim yazmaz). Brüt =
   * ciro; raporlar indirimi sıfır gibi göstermez, "bilinmiyor" der
   */
  indirimBilinmiyor?: true;
  /** Ciro dışı: ödenmez ve ikram (kuruş, liste değeriyle); sıfırsa alan yok */
  odenmez?: number;
  /** KDV: [oran, KDV dahil, matrah, KDV]; yoksa ciro %10 sayılır (`historyKdv`) */
  kdv?: [number, number, number, number][];
  /** Önceki programın Z numarası ("Z-2026-002"); LafPOS'un Z zincirine girmez */
  z?: string;
}

/** Önceki programın dönem ürün listesi: tek blok, indirim öncesi (ödenmez hariç). Satır: [ad, boy, adet (ondalıklı olabilir), tutar kuruş] */
export interface HistoryProducts {
  from: string;
  to: string;
  rows: [string, string, number, number][];
}

/**
 * Uzaktan'a giden geçmiş gününün taşıdığı dönem ürün listesi işareti (`RemoteDayReport.urunler`): bloğun dönemi ve o
 * dönemin geçmiş günü sayısı (`n`) her geçmiş gününde, satırlar (`rows`) yalnız bloğun son geçmiş gününde (liste her gün
 * anahtarında kopyalanmasın: 400 gün × 500 satır). Bulut bloğu ancak `n` gün raporda geçmiş günü olarak duruyorsa ve
 * satırları taşıyan gün de dönemdeyse tam gösterir
 */
export type PushedHistoryProducts = Pick<HistoryProducts, 'from' | 'to'> & { n: number; rows?: HistoryProducts['rows'] };

export interface HistoryStore {
  v: 1;
  kaynak: string;
  at: number;
  gunler: HistoryDay[];
  urunler?: HistoryProducts;
}

export const HISTORY_MAX_DAYS = 800;
export const HISTORY_MAX_PRODUCTS = 500;
/** lafmaliyet'ten gelen günlerin kaynağı ve `historyReport`'un varsayılanı */
export const HISTORY_SOURCE = 'ModPOS';
/** Kaynağı yazılmamış elle yüklenmiş kayıt (`merkez/gecmis`'in varsayılanıyla aynı) */
export const HISTORY_SOURCE_UNKNOWN = 'Önceki kasa programı';
/** KDV satırı yüklenmeyen geçmiş günün oranı: kafe satışı %10 */
const HISTORY_KDV_RATE = 10;
const PAY_FIELDS: [key: 'kart' | 'nakit' | 'yemek', ad: string, alan: string][] = [
  ['kart', 'Kredi kartı', 'card'],
  ['nakit', 'Nakit', 'cash'],
  ['yemek', 'Yemek kartı', 'meal_card'],
];
const nat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e12;
const validDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Yüklenen günleri doğrular: `{ date, ciro, adisyon, closes?, kart?, nakit?, yemek?, indirim?, odenmez?, kdv?, z? }`;
 * kart, nakit, yemek `[tutar, adet]`, KDV `[[oran, dahil, matrah, kdv]]` (dahil toplamı ciroya, matrah + KDV dahile eşit).
 * Kapanışlar verildiyse toplamı günün cirosuna ve adisyonuna eşit olmalı (yarım yapıştırılmış veri saklanmaz). Hata
 * varsa sahibin okuyacağı cümle döner
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
    const day: HistoryDay = { date: d.date, ciro: d.ciro, adisyon: d.adisyon, closes, pay };
    for (const [key, ad] of [['indirim', 'indirim'], ['odenmez', 'ödenmez']] as const) {
      if (d[key] == null) continue;
      if (!nat(d[key])) return `${d.date}: ${ad} tam sayı olmalı (kuruş, sıfır ya da artı)`;
      if (d[key] > 0) day[key] = d[key];
    }
    if (d.kdv != null) {
      const kdv = parseKdv(d.kdv, d.ciro);
      if (typeof kdv === 'string') return `${d.date}: ${kdv}`;
      if (kdv.length) day.kdv = kdv;
    }
    if (d.z != null && d.z !== '') {
      if (typeof d.z !== 'string' || d.z.trim().length > 40) return `${d.date}: Z numarası en çok 40 karakterlik metin olmalı`;
      day.z = d.z.trim();
    }
    out.set(d.date, day);
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** KDV satırları: oran 0-100, dahil = matrah + KDV, dahil toplamı ciroya eşit */
function parseKdv(input: unknown, ciro: number): NonNullable<HistoryDay['kdv']> | string {
  if (!Array.isArray(input) || input.length > 10) return 'KDV satırları anlaşılamadı';
  const out: NonNullable<HistoryDay['kdv']> = [];
  for (const k of input as unknown[]) {
    if (!Array.isArray(k) || k.length !== 4 || !nat(k[0]) || k[0] > 100 || !nat(k[1]) || !nat(k[2]) || !nat(k[3])) return 'KDV satırı [oran, KDV dahil, matrah, KDV] olmalı (oran 0-100, tutar kuruş)';
    if (k[2] + k[3] !== k[1]) return `KDV satırında matrah ve KDV toplamı KDV dahil tutarı tutmuyor (%${k[0]})`;
    out.push([k[0], k[1], k[2], k[3]]);
  }
  if (out.length && out.reduce((a, k) => a + k[1], 0) !== ciro) return 'KDV dahil tutarların toplamı günün cirosunu tutmuyor';
  return out.sort((a, b) => a[0] - b[0]);
}

/** Saklanan kaydı okur (kaynak ve ürün listesiyle); bozuksa ya da gün yoksa null. Bozuk ürün bloğu yok sayılır */
export function readHistoryStore(raw: string | null | undefined): HistoryStore | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<HistoryStore>;
    if (s.v !== 1 || !Array.isArray(s.gunler) || !s.gunler.length) return null;
    const store: HistoryStore = { v: 1, kaynak: typeof s.kaynak === 'string' && s.kaynak ? s.kaynak : HISTORY_SOURCE_UNKNOWN, at: Number(s.at) || 0, gunler: s.gunler };
    const urunler = validProducts(s.urunler);
    if (urunler) store.urunler = urunler;
    return store;
  } catch {
    return null;
  }
}

/** Saklanan kaydın günleri; bozuksa ya da boşsa null */
export function readHistory(raw: string | null | undefined): HistoryDay[] | null {
  return readHistoryStore(raw)?.gunler ?? null;
}

/** Geçmiş günün KDV'si: yüklenmediyse ciro %10 (kafe satışı) ayrıştırılır */
export function historyKdv(d: Pick<HistoryDay, 'ciro' | 'kdv'>): [number, number, number, number][] {
  if (d.kdv?.length) return d.kdv;
  if (!d.ciro) return [];
  const { net, kdv } = splitKdv(d.ciro, HISTORY_KDV_RATE);
  return [[HISTORY_KDV_RATE, d.ciro, net, kdv]];
}

/**
 * Geçmiş günün Raporlar'daki karşılığı: kapanmış tek iş günü, kaynağın adı ve önceki programın Z numarasıyla. Ciro dökümü
 * LafPOS gününün kuralıyla: brüt = ciro + indirim, ciro dışı = ödenmez, liste = brüt + ciro dışı; KDV yüklenmediyse %10.
 * Bilinmeyen kırılımlar (ürün, personel, satış türü) boş; ürünler dönem bloğunda (`HistoryStore.urunler`)
 */
export function historyReport(d: HistoryDay, kaynak: string = HISTORY_SOURCE): RemoteDayReport {
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
  const indirim = d.indirim ?? 0;
  const odenmez = d.odenmez ?? 0;
  const gross = d.ciro + indirim;
  return {
    v: 1,
    date: d.date,
    at: 0,
    n: 1,
    closed: true,
    z: [],
    s: { list: gross + odenmez, gross, comp: odenmez, disc: indirim, svc: 0, rev: d.ciro, odenmez, zayi: 0, voided: 0, receipts: d.adisyon, items: 0, tips: 0, guests: 0, tableSales: 0, paidClosed: d.ciro, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
    pay: d.pay,
    types: [],
    kdv: historyKdv(d),
    closes: d.closes,
    prod: [],
    hours: [...hours.values()].sort((a, b) => a[0] - b[0]),
    clock: [...clock.entries()].sort((a, b) => a[0] - b[0]),
    staff: [],
    kaynak,
    ...(d.z ? { zText: d.z } : {}),
    ...(d.indirimBilinmiyor ? { indirimBilinmiyor: true as const } : {}),
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

/**
 * Dönem ürün listesi raporda nasıl görünür: dönem bloğun bütün günlerini kapsıyorsa tam blok (`tam`), yalnız bir kısmını
 * kapsıyorsa not (`kismi`: blok günlere bölünemez), hiç kesişmiyorsa yok. `history` ve `used` verilirse bloğun günlerinin
 * hepsi raporda geçmiş günü olarak durmalı (kaynak adı taşıyan gün); biri LafPOS günüyle değiştiyse blok o günü de
 * sayardı: not
 */
export function historyProductsShown(block: HistoryProducts | null | undefined, range: { from: string; to: string }, history?: Pick<HistoryDay, 'date'>[] | null, used?: { date: string; kaynak?: string }[]): 'tam' | 'kismi' | null {
  if (!block || range.to < block.from || range.from > block.to) return null;
  if (range.from > block.from || range.to < block.to) return 'kismi';
  if (!history || !used) return 'tam';
  const fromHistory = new Set(used.filter((d) => d.kaynak).map((d) => d.date));
  return history.every((h) => h.date < block.from || h.date > block.to || fromHistory.has(h.date)) ? 'tam' : 'kismi';
}

/** Dönem ürün bloğunun biçimi (saklanan ya da gelen kayıt): bozuksa null */
export function validProducts(u: unknown): HistoryProducts | null {
  const b = u as Partial<HistoryProducts> | null;
  if (!b || typeof b !== 'object' || !validDate(b.from) || !validDate(b.to) || b.from > b.to || !Array.isArray(b.rows) || b.rows.length > HISTORY_MAX_PRODUCTS) return null;
  // Adet ondalıklı olabilir (lafmaliyet'in listesi), tutar kuruş
  const ok = b.rows.every((r) => Array.isArray(r) && r.length === 4 && typeof r[0] === 'string' && typeof r[1] === 'string' && Number.isFinite(r[2]) && r[2] >= 0 && r[2] < 1e9 && nat(r[3]));
  return ok ? { from: b.from, to: b.to, rows: b.rows } : null;
}

/**
 * Gün raporundaki dönem bloğu işaretinin biçimi (kasanın ittiği; api/uzaktan.ts doğrular): dönem, 1-800 arası gün sayısı;
 * satırlar varsa bloğun biçiminde
 */
export function validPushedProducts(u: unknown): u is PushedHistoryProducts {
  if (!u || typeof u !== 'object') return false;
  const b = u as { from?: unknown; to?: unknown; n?: unknown; rows?: unknown };
  if (!Number.isInteger(b.n) || (b.n as number) < 1 || (b.n as number) > HISTORY_MAX_DAYS) return false;
  if (b.rows === undefined) return validDate(b.from) && validDate(b.to) && b.from <= b.to;
  return validProducts(u) !== null;
}

/** Raporlara giden dönem ürün listesi: başlık, toplamlar ve satırlar (en çok satan önce) */
export function historyProductsView(block: HistoryProducts, kaynak: string) {
  const rows = [...block.rows].sort((a, b) => b[3] - a[3]).map(([name, size, qty, amount]) => ({ name, size, qty, amount }));
  return { kaynak, from: block.from, to: block.to, qty: Math.round(rows.reduce((a, r) => a + r.qty, 0) * 1000) / 1000, amount: rows.reduce((a, r) => a + r.amount, 0), rows };
}

/**
 * Dönemin geçmişten gelen günleri (Raporlar'ın notu): kaynak, gün sayısı, ilk ve son gün; indirimi bilinmeyen (yalnız
 * föyden gelen) gün varsa sayısı. Yoksa null
 */
export function historySpan(days: { date: string; kaynak?: string; indirimBilinmiyor?: boolean }[]): { kaynak: string; days: number; from: string; to: string; indirimBilinmiyor?: number } | null {
  const hist = days.filter((d) => d.kaynak);
  const list = hist.map((d) => d.date).sort();
  if (!list.length) return null;
  const unknown = hist.filter((d) => d.indirimBilinmiyor).length;
  return { kaynak: hist[0]!.kaynak!, days: list.length, from: list[0]!, to: list[list.length - 1]!, ...(unknown ? { indirimBilinmiyor: unknown } : {}) };
}

/**
 * Kasanın iki geçmiş kaydını birleştirir: elle yüklenen (Merkez) ve lafmaliyet'ten gelen. Aynı tarihte lafmaliyet'in günü
 * geçer (ayrıntısı tam: indirim, ciro dışı, KDV, Z); ürün bloğu lafmaliyet'inki, yoksa elle yüklenenin. Kaynak adı
 * lafmaliyet günü varsa onunki. `at` iki kaydın anlarının büyüğü (değişince Uzaktan'a yeniden gider). İkisi de boşsa null
 */
export function mergeHistory(manual: Pick<HistoryStore, 'kaynak' | 'at' | 'gunler' | 'urunler'> | null | undefined, ladmin: Pick<HistoryStore, 'kaynak' | 'at' | 'gunler' | 'urunler'> | null | undefined): HistoryStore | null {
  const a = manual?.gunler?.length ? manual : null;
  const b = ladmin?.gunler?.length ? ladmin : null;
  if (!a && !b) return null;
  const byDate = new Map<string, HistoryDay>();
  for (const d of a?.gunler ?? []) byDate.set(d.date, d);
  for (const d of b?.gunler ?? []) byDate.set(d.date, d);
  const urunler = validProducts(b?.urunler) ?? validProducts(a?.urunler);
  return {
    v: 1,
    kaynak: b ? b.kaynak || HISTORY_SOURCE : a!.kaynak || HISTORY_SOURCE_UNKNOWN,
    at: Math.max(a?.at ?? 0, b?.at ?? 0),
    gunler: [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1)),
    ...(urunler ? { urunler } : {}),
  };
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

