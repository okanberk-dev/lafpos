/**
 * Raporların kasada ve LafPOS Uzaktan'da aynı kodla hesaplanan parçaları (server/services/reports.ts ve api/uzaktan.ts
 * ikisi de bunu kullanır): uzaktaki rakam kasadakiyle birebir aynı olsun diye. Saf işlevler; veritabanı yok.
 */

// ─── Hazırlama süresi ───────────────────────────────────────────────────────

/** Hazırlanan kalem: [ad, boy, gönderilme anı, saniye, adisyon no] */
export type PrepDone = [string, string, number, number, number];

/** Sıralı dizide yüzdelik (en yakın sıra) */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function secStats(secs: number[]) {
  const s = [...secs].sort((a, b) => a - b);
  return { count: s.length, avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0, median: percentile(s, 50), p90: percentile(s, 90), max: s.at(-1) ?? 0 };
}

/** Hazırlama raporunun gövdesi: kalemler ve teslim süreleri (sn); `hourOf` İstanbul saati (0-23) */
export function prepFrom(done: PrepDone[], handoffs: number[], hourOf: (ms: number) => number) {
  const byProduct = new Map<string, { name: string; size: string; secs: number[] }>();
  for (const [name, size, , sec] of done) {
    const key = `${name}|${size}`;
    const row = byProduct.get(key) ?? { name, size, secs: [] };
    row.secs.push(sec);
    byProduct.set(key, row);
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, secs: [] as number[] }));
  for (const [, , sentAt, sec] of done) hours[hourOf(sentAt)]!.secs.push(sec);
  return {
    overall: secStats(done.map((d) => d[3])),
    handoff: secStats(handoffs),
    products: [...byProduct.values()].map((r) => ({ name: r.name, size: r.size, ...secStats(r.secs) })).sort((a, b) => b.p90 - a.p90 || b.count - a.count),
    hours: hours.filter((h) => h.secs.length).map((h) => ({ hour: h.hour, ...secStats(h.secs) })),
    slowest: [...done]
      .sort((a, b) => b[3] - a[3])
      .slice(0, 10)
      .map(([name, size, sentAt, sec, orderNo]) => ({ orderNo, name, size, sentAt, sec })),
  };
}

// ─── Kalem listeleri, adisyonlar, iadeler ───────────────────────────────────

export interface ItemListRow {
  id: string;
  at: number;
  orderId: string;
  orderNo: number;
  place: string;
  name: string;
  size: string;
  qty: number;
  value: number;
  reason: string | null;
  compKind: string | null;
  person: { kind: string; name: string } | null;
  by: string | null;
  approvedBy: string | null;
  afterSend: boolean;
  afterBill: boolean;
}

export interface OdenmezPersonRow {
  kind: string | null;
  id: string | null;
  name: string;
  qty: number;
  amount: number;
}

/** Günlük listeleri dönem için birleştirir: en yeni üstte (kasadaki sıralama) */
export function mergeRows<T extends { at: number }>(lists: T[][]): T[] {
  return lists.flat().sort((a, b) => b.at - a.at);
}

/** Günlük ödenmez kişi dökümlerini dönem için toplar (kasadaki `odenmezByPerson` sırası) */
export function mergeOdenmez(lists: OdenmezPersonRow[][]): OdenmezPersonRow[] {
  const rows = new Map<string, OdenmezPersonRow>();
  for (const r of lists.flat()) {
    const key = `${r.kind ?? 'yok'}:${r.id ?? (r.kind ? 'gizli' : '')}`;
    const row = rows.get(key) ?? { ...r, qty: 0, amount: 0 };
    row.qty += r.qty;
    row.amount += r.amount;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'tr'));
}

export interface CheckRow {
  id: string;
  no: number;
  status: string;
  type: string;
  place: string | null;
  openedAt: number;
  closedAt: number | null;
  waiter: string | null;
  itemCount: number;
  qty: number;
  total: number;
  methods: string[];
}

/** Adisyon listesi: kapanış (yoksa açılış) anına göre en yeni üstte; `limit` ekran, null CSV */
export function mergeChecks(lists: CheckRow[][], limit: number | null = 300, cross: CrossPay[] = []) {
  // Adisyonun başka günde alınan ödemesi de dönemin içindeyse ödeme türlerine girer (kasada dönem tek seferde okunur)
  const extra = new Map<string, string[]>();
  for (const p of cross) extra.set(p[5], [...(extra.get(p[5]) ?? []), p[6]]);
  const all = lists
    .flat()
    .map((c) => (extra.has(c.id) ? { ...c, methods: [...new Set([...c.methods, ...extra.get(c.id)!])] } : c))
    .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  return { count: all.length, rows: limit == null ? all : all.slice(0, limit) };
}

// ─── Paket platformları ─────────────────────────────────────────────────────

export interface PlatformDayRow {
  platform: string;
  label: string;
  orders: number;
  revenue: number;
  discounts: number;
  platformDiscount: number;
  collectedByPlatform: number;
  collectedAtCounter: number;
  open: { orders: number; amount: number };
  missed: { orders: number; amount: number; rejected: number; expired: number; cancelled: number; unrecorded: number };
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Günlük platform satırlarını dönem için toplar; pay dönemin cirosundan, ortalama sepet toplamdan. `order`:
 * platformların sabit sırası (eşitlikte)
 */
export function mergePlatforms(lists: PlatformDayRow[][], netSales: number, pending: number, order: readonly string[]) {
  const rows = new Map<string, PlatformDayRow>();
  for (const r of lists.flat()) {
    const row =
      rows.get(r.platform) ??
      ({ ...r, orders: 0, revenue: 0, discounts: 0, platformDiscount: 0, collectedByPlatform: 0, collectedAtCounter: 0, open: { orders: 0, amount: 0 }, missed: { orders: 0, amount: 0, rejected: 0, expired: 0, cancelled: 0, unrecorded: 0 } } as PlatformDayRow);
    row.orders += r.orders;
    row.revenue += r.revenue;
    row.discounts += r.discounts;
    row.platformDiscount += r.platformDiscount;
    row.collectedByPlatform += r.collectedByPlatform;
    row.collectedAtCounter += r.collectedAtCounter;
    row.open.orders += r.open.orders;
    row.open.amount += r.open.amount;
    for (const k of ['orders', 'amount', 'rejected', 'expired', 'cancelled', 'unrecorded'] as const) row.missed[k] += r.missed[k];
    rows.set(r.platform, row);
  }
  const revenue = [...rows.values()].reduce((a, r) => a + r.revenue, 0);
  const platforms = order
    .filter((p) => rows.has(p))
    .map((p) => {
      const r = rows.get(p)!;
      return { ...r, avgBasket: r.orders ? Math.round(r.revenue / r.orders) : 0, share: pct(r.revenue, netSales) };
    })
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  const orders = platforms.reduce((a, r) => a + r.orders, 0);
  return {
    netSales,
    revenue,
    orders,
    avgBasket: orders ? Math.round(revenue / orders) : 0,
    share: pct(revenue, netSales),
    open: { orders: platforms.reduce((a, r) => a + r.open.orders, 0), amount: platforms.reduce((a, r) => a + r.open.amount, 0) },
    missed: { orders: platforms.reduce((a, r) => a + r.missed.orders, 0), amount: platforms.reduce((a, r) => a + r.missed.amount, 0) },
    pending,
    platforms,
  };
}

// ─── Gün aşırı ödeme ───────────────────────────────────────────────────────

/**
 * Bir günün, o günün kapanmış adisyonlarına ait olmayan satış ödemesi: [adisyonun iş günü, adisyon kapanmış satış mı
 * (0/1), tutar, platform ya da "", platformun kendi ödeme türüyle mi (0/1), adisyon kimliği, ödeme türünün adı]. Dönem raporunda adisyonun günü döneme
 * düşüyorsa ödeme "kapanmış adisyonların ödemesi" sayılır (kasada dönem tek seferde okunur)
 */
export type CrossPay = [string, 0 | 1, number, string, 0 | 1, string, string];

/** Dönemin gün aşırı ödemelerinden kapanmış adisyonlara düşenler: mutabakat ve platform tahsilatı için */
export function crossPayIn(pays: CrossPay[], from: string, to: string) {
  let closed = 0;
  const byPlatform = new Map<string, { platform: number; counter: number }>();
  for (const [date, sale, amount, platform, own] of pays) {
    if (!sale || date < from || date > to) continue;
    closed += amount;
    if (platform) {
      const r = byPlatform.get(platform) ?? { platform: 0, counter: 0 };
      if (own) r.platform += amount;
      else r.counter += amount;
      byPlatform.set(platform, r);
    }
  }
  return { closed, byPlatform };
}
