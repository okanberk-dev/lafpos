import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { calcOrder, type OrderTotals } from '@shared/order-calc';
import { addDays, businessDate, businessDayStartMs, currentBusinessDate, DAY_ROLLOVER_HOUR, istanbulParts } from '@shared/time';
import type { CompKind } from '@shared/types';
import { db, schema } from '../db/client';
import { costMap, costsAt } from '../sync/lafmaliyet';
import { getOpenDay } from './orders';

/**
 * Raporlar: iş günü tarihleriyle ([from, to], 05:00 kuralı) çalışır. Ciro yalnız LafPOS'ta tahsil edilen
 * (source = 'pos') kapanmış adisyonlardandır; online (sitede ödenen) siparişler ayrı gösterilir. İptal, X/Z gibi
 * bütün POS adisyonlarından sayılır: açık, iptal edilmiş ya da kalemleri başka masaya taşınmış (birlesti) olsa da.
 */

type OrderRow = typeof schema.orders.$inferSelect;
type ItemRow = typeof schema.orderItems.$inferSelect;

export interface Range {
  from: string;
  to: string;
}

interface Dataset {
  days: (typeof schema.businessDays.$inferSelect)[];
  /** Dönemin bütün adisyonları, her durumda: her rapor kendi kümesini açıkça seçer */
  orders: OrderRow[];
  items: ItemRow[];
  payments: (typeof schema.payments.$inferSelect)[];
}

/** Bir raporun alabileceği en uzun dönem (gün, iki uç dahil): dönem belleğe okunur, kasa işlemleri beklemesin */
export const MAX_RANGE_DAYS = 400;

/** Dönemin gün sayısı, iki uç dahil */
export const dayCount = (r: Range) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86400_000) + 1;

/** Raporların "bugün"ü: açık iş günü (05:00'i geçse de), yoksa şu anın iş günü; patron paneliyle aynı */
export const reportToday = (now = Date.now()) => currentBusinessDate(getOpenDay(db)?.date, now);

const EMPTY_TOTALS: OrderTotals = calcOrder({ lines: [] });
const totalsOf = (o: OrderRow) => o.totals ?? EMPTY_TOTALS;
/** Ciro kümesi: LafPOS'ta tahsil edilip kapanmış adisyon */
const isSale = (o: OrderRow) => o.status === 'kapali' && o.source === 'pos';
const idsOf = (orders: OrderRow[]) => new Set(orders.map((o) => o.id));

/**
 * Dönemin iş günleri ve o günlerin bütün adisyonları, kalemleri, ödemeleri. Kimlik listesi bağlanmaz: SQLite bir
 * sorguda en çok 32.766 değişken alır, uzun dönemde adisyon sayısı bunu aşar; günler ve adisyonlar alt sorguyla
 * seçilir. Kalem ve ödeme gerekmeyen rapor (saatlik, kıyas dönemi) `{ items: false, payments: false }` ile yalnız
 * adisyonları okur: uzun dönemde okumanın çoğu kalemlerdir ve okuma sürerken kasa bekler.
 */
function load(range: Range, read: { items?: boolean; payments?: boolean } = {}): Dataset {
  const inRange = and(gte(schema.businessDays.date, range.from), lte(schema.businessDays.date, range.to));
  const days = db.select().from(schema.businessDays).where(inRange).orderBy(asc(schema.businessDays.date)).all();
  if (!days.length) return { days, orders: [], items: [], payments: [] };
  const dayIds = db.select({ id: schema.businessDays.id }).from(schema.businessDays).where(inRange);
  const orderIds = db.select({ id: schema.orders.id }).from(schema.orders).where(inArray(schema.orders.dayId, dayIds));
  const orders = db.select().from(schema.orders).where(inArray(schema.orders.dayId, dayIds)).all();
  const items = read.items === false ? [] : db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds)).all();
  const payments = read.payments === false ? [] : db.select().from(schema.payments).where(inArray(schema.payments.dayId, dayIds)).all();
  return { days, orders, items, payments };
}

/** Yalnız adisyonlar (ciro, adisyon sayısı, saat): kalem ve ödeme okunmaz */
const ORDERS_ONLY = { items: false, payments: false } as const;

/** İptal edilen kalemler: X/Z gibi bütün POS adisyonlarından (açık, iptal edilmiş, kalemleri taşınmış) */
function voidedItems(ds: Dataset): ItemRow[] {
  const pos = idsOf(ds.orders.filter((o) => o.source === 'pos'));
  return ds.items.filter((i) => i.voided && pos.has(i.orderId));
}

function groupBy<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const arr = out.get(k);
    if (arr) arr.push(x);
    else out.set(k, [x]);
  }
  return out;
}

const dayOf = (ds: Dataset) => new Map(ds.days.map((d) => [d.id, d.date]));
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/**
 * Kıyas dönemi: aynı uzunlukta ve aynı haftanın günlerine hizalı. Ayın 1'inden başlayan dönem önceki ayın aynı
 * günleriyle (1-26 Ekim → 1-26 Eylül), diğerleri bütün haftalar kadar geriyle (Çarşamba Çarşambayla) kıyaslanır.
 * Bugünü (açık iş günü, `reportToday`) içeren dönemde önceki dönem de aynı saate kadar sayılır (yarım gün bütün
 * günle kıyaslanmaz).
 */
export function comparison(r: Range, nowMs = Date.now(), today = businessDate(nowMs)): { range: Range; label: string; cutoffMs: number | null } {
  const len = dayCount(r);
  const [fy, fm, fd] = r.from.split('-').map(Number);
  let range: Range;
  let label: string;
  let shiftMs: number;
  if (fd === 1 && len <= 31 && r.to.slice(0, 7) === r.from.slice(0, 7)) {
    const prevMonthStart = new Date(Date.UTC(fy!, fm! - 2, 1)).toISOString().slice(0, 10);
    const prevMonthDays = new Date(Date.UTC(fy!, fm! - 1, 0)).getUTCDate();
    range = { from: prevMonthStart, to: addDays(prevMonthStart, Math.min(len, prevMonthDays) - 1) };
    label = 'önceki ayın aynı günleri';
    shiftMs = Date.parse(`${r.from}T00:00:00Z`) - Date.parse(`${prevMonthStart}T00:00:00Z`);
  } else {
    const back = Math.ceil(len / 7) * 7;
    range = { from: addDays(r.from, -back), to: addDays(r.to, -back) };
    label = back === 7 ? 'geçen haftanın aynı günleri' : `${back / 7} hafta önceki aynı günler`;
    shiftMs = back * 86400_000;
  }
  const partial = r.to === today;
  if (partial) label += ', aynı saate kadar';
  return { range, label, cutoffMs: partial ? nowMs - shiftMs : null };
}

// ─── Ciro ───────────────────────────────────────────────────────────────────

export function summaryReport(range: Range, nowMs = Date.now()) {
  const ds = load(range);
  const dates = dayOf(ds);
  const closed = ds.orders.filter(isSale);
  const closedIds = idsOf(closed);
  const sum = (f: (o: OrderRow) => number) => closed.reduce((a, o) => a + f(o), 0);
  const netSales = sum((o) => totalsOf(o).total);
  const receipts = closed.filter((o) => o.total > 0).length;
  const byDay = new Map<string, { date: string; netSales: number; receipts: number }>();
  for (const d of ds.days) byDay.set(d.date, { date: d.date, netSales: 0, receipts: 0 });
  for (const o of closed) {
    const row = byDay.get(dates.get(o.dayId)!)!;
    row.netSales += totalsOf(o).total;
    if (o.total > 0) row.receipts += 1;
  }
  const salesPays = ds.payments.filter((p) => p.orderId && !p.refundedAt);
  const payMap = new Map<string, { name: string; zField: string; amount: number; count: number }>();
  for (const p of salesPays) {
    const row = payMap.get(p.methodName) ?? { name: p.methodName, zField: p.zField, amount: 0, count: 0 };
    row.amount += p.amount;
    row.count += 1;
    payMap.set(p.methodName, row);
  }
  // Türe göre: adisyon sayısı "Adisyon" kutusuyla aynı ölçütle (tutarı olan adisyon; tamamı ikram edilen sayılmaz)
  const types = new Map<string, { type: string; orders: number; amount: number }>();
  for (const o of closed) {
    if (o.total <= 0) continue;
    const row = types.get(o.type) ?? { type: o.type, orders: 0, amount: 0 };
    row.orders += 1;
    row.amount += totalsOf(o).total;
    types.set(o.type, row);
  }
  // Online sipariş sitede ödenmiş gelir, X/Z gibi her aşamada (hazırlanan da) sayılır; ciroya girmez
  const online = ds.orders.filter((o) => o.source === 'laffogato');
  const cmp = comparison(range, nowMs, reportToday(nowMs));
  const prev = load(cmp.range, ORDERS_ONLY);
  const prevClosed = prev.orders.filter((o) => isSale(o) && (cmp.cutoffMs == null || (o.closedAt ?? o.openedAt) <= cmp.cutoffMs));
  const prevNet = prevClosed.reduce((a, o) => a + totalsOf(o).total, 0);
  const prevReceipts = prevClosed.filter((o) => o.total > 0).length;
  // Satılan ürün: ürün raporunun adedi (ikram satılmadı, ayrı sayılır)
  const itemsSold = ds.items.filter((i) => !i.voided && !i.complimentary && closedIds.has(i.orderId)).reduce((a, i) => a + i.qty, 0);
  const totalPaid = [...payMap.values()].reduce((a, p) => a + p.amount, 0);
  // Ciro dökümü: liste değeri − ikram − indirim (+ servis) = ciro (KDV dahil); − KDV = net satış (KDV hariç)
  const kdvByRate = new Map<number, { rate: number; gross: number; base: number; kdv: number }>();
  for (const o of closed) {
    for (const k of totalsOf(o).kdv) {
      const row = kdvByRate.get(k.rate) ?? { rate: k.rate, gross: 0, base: 0, kdv: 0 };
      row.gross += k.gross;
      row.base += k.base;
      row.kdv += k.kdv;
      kdvByRate.set(k.rate, row);
    }
  }
  const kdvTotal = [...kdvByRate.values()].reduce((a, k) => a + k.kdv, 0);
  // Kapanmış adisyonların ödemeleri ciroya eşit olmalı (bahşiş hariç); açık adisyonlardan alınan ödeme ayrı
  const paidClosed = salesPays.filter((p) => closedIds.has(p.orderId!)).reduce((a, p) => a + p.amount, 0);
  const paidOpen = salesPays.filter((p) => !closedIds.has(p.orderId!)).reduce((a, p) => a + p.amount, 0);
  const tableOrders = closed.filter((o) => o.type === 'masa');
  const tableGuests = tableOrders.reduce((a, o) => a + o.guests, 0);
  const tableSales = tableOrders.reduce((a, o) => a + totalsOf(o).total, 0);
  return {
    range,
    asOf: nowMs,
    waterfall: {
      list: sum((o) => totalsOf(o).gross + totalsOf(o).complimentary),
      complimentary: sum((o) => totalsOf(o).complimentary),
      discounts: sum((o) => totalsOf(o).lineDiscounts + totalsOf(o).orderDiscount),
      service: sum((o) => totalsOf(o).service),
      revenue: netSales,
      kdv: kdvTotal,
      netExKdv: netSales - kdvTotal,
    },
    kdv: [...kdvByRate.values()].sort((a, b) => a.rate - b.rate),
    reconciliation: { paidClosed, difference: paidClosed - netSales, paidOpen },
    perGuest: tableGuests ? Math.round(tableSales / tableGuests) : null,
    days: ds.days.length,
    netSales,
    gross: sum((o) => totalsOf(o).gross),
    discounts: sum((o) => totalsOf(o).lineDiscounts + totalsOf(o).orderDiscount),
    complimentary: sum((o) => totalsOf(o).complimentary),
    odenmez: compKindOf(ds, closedIds, 'odenmez'),
    zayi: compKindOf(ds, closedIds, 'zayi'),
    voided: voidedItems(ds).reduce((a, i) => a + i.qty * i.unitPrice, 0),
    receipts,
    avgCheck: receipts ? Math.round(netSales / receipts) : 0,
    guests: closed.filter((o) => o.type === 'masa').reduce((a, o) => a + o.guests, 0),
    itemsSold,
    tips: salesPays.reduce((a, p) => a + p.tip, 0),
    byDay: [...byDay.values()],
    payments: [...payMap.values()].sort((a, b) => b.amount - a.amount).map((p) => ({ ...p, share: pct(p.amount, totalPaid) })),
    types: [...types.values()].sort((a, b) => b.amount - a.amount),
    online: { orders: online.length, amount: online.reduce((a, o) => a + (o.extTotal ?? 0), 0) },
    previous: { range: cmp.range, label: cmp.label, netSales: prevNet, receipts: prevReceipts, change: change(netSales, prevNet) },
  };
}

// ─── Ürün ve kategori ───────────────────────────────────────────────────────

export function productReport(range: Range, withCost: boolean) {
  const ds = load(range);
  const closedIds = idsOf(ds.orders.filter(isSale));
  const voided = new Set(voidedItems(ds));
  const totals = new Map(ds.orders.map((o) => [o.id, totalsOf(o)]));
  const products = new Map(db.select().from(schema.products).all().map((p) => [p.id, p]));
  const categories = new Map(db.select().from(schema.categories).all().map((c) => [c.id, c]));
  const costs = withCost ? costMap() : {};
  const rows = new Map<string, { key: string; name: string; size: string; categoryId: string | null; category: string; qty: number; revenue: number; revenueNet: number; cost: number | null; complimentary: number; voided: number }>();
  for (const i of ds.items) {
    // Satış ve ikram kapanmış adisyondan, iptal adedi bütün POS adisyonlarından (X/Z gibi)
    if (i.voided ? !voided.has(i) : !closedIds.has(i.orderId)) continue;
    const key = `${i.productId ?? i.name}|${i.size}`;
    const p = i.productId ? products.get(i.productId) : undefined;
    const row =
      rows.get(key) ??
      {
        key,
        name: i.name,
        size: i.size,
        categoryId: p?.categoryId ?? null,
        category: p ? (categories.get(p.categoryId)?.name ?? '') : '',
        qty: 0,
        revenue: 0,
        revenueNet: 0,
        cost: withCost ? 0 : null,
        complimentary: 0,
        voided: 0,
      };
    if (i.voided) row.voided += i.qty;
    else if (i.complimentary) row.complimentary += i.qty;
    else {
      row.qty += i.qty;
      const net = totals.get(i.orderId)?.lineNet[i.id] ?? 0;
      row.revenue += net;
      row.revenueNet += Math.round((net * 100) / (100 + i.kdvRate));
      if (withCost && row.cost != null) {
        const unit = p?.extId ? costs[`${p.extId}:${i.size === 'L' ? 'L' : 'M'}`] : undefined;
        if (unit == null) row.cost = null;
        else row.cost += unit * i.qty;
      }
    }
    rows.set(key, row);
  }
  const list = [...rows.values()].filter((r) => r.qty > 0 || r.complimentary > 0 || r.voided > 0);
  const total = list.reduce((a, r) => a + r.revenue, 0);
  const products_ = list
    .sort((a, b) => b.revenue - a.revenue)
    .map((r) => ({
      ...r,
      share: pct(r.revenue, total),
      avgPrice: r.qty ? Math.round(r.revenue / r.qty) : 0,
      // Brüt kâr KDV hariç: kalemlerin kendi KDV'siyle ayrıştırılmış ciro − reçete maliyeti
      margin: withCost && r.cost != null ? r.revenueNet - r.cost : null,
    }));
  const cats = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const r of list) {
    const k = r.category || 'Diğer';
    const c = cats.get(k) ?? { name: k, qty: 0, revenue: 0 };
    c.qty += r.qty;
    c.revenue += r.revenue;
    cats.set(k, c);
  }
  // Servis ücreti bir ürüne ait değil: ürün cirosu + servis = toplam ciro (özet ve Z ile mutabakat)
  const service = [...closedIds].reduce((a, id) => a + (totals.get(id)?.service ?? 0), 0);
  return {
    range,
    total,
    service,
    // Maliyetlerin son çekimi: yalnız maliyet yetkisine (eskiyse "Maliyetler N gün önce alındı"); personel varlığını da görmez
    ...(withCost ? { costsAt: costsAt() } : {}),
    products: products_,
    categories: [...cats.values()].sort((a, b) => b.revenue - a.revenue).map((c) => ({ ...c, share: pct(c.revenue, total) })),
  };
}

// ─── Saatlik ────────────────────────────────────────────────────────────────

const PARTS = [
  { key: 'sabah', label: 'Sabah', from: 6, to: 12 },
  { key: 'ogle', label: 'Öğle', from: 12, to: 17 },
  { key: 'aksam', label: 'Akşam', from: 17, to: 22 },
  { key: 'gece', label: 'Gece', from: 22, to: 30 },
];

/**
 * Anın İstanbul saati (0-23), çağrı başına önbellekli: saat dilimi farkı tam saat olduğundan aynı UTC saatindeki anlar
 * aynı saati verir; uzun dönemde on binlerce adisyon için Intl saat başına bir kez çağrılır.
 */
function hourMemo() {
  const seen = new Map<number, number>();
  return (ms: number) => {
    const key = Math.floor(ms / 3_600_000);
    let hour = seen.get(key);
    if (hour === undefined) seen.set(key, (hour = istanbulParts(ms).hour));
    return hour;
  };
}

/**
 * Saatlik ciro, adisyonun açıldığı saate göre; `hours` iş günü sırasıyla (05:00 ilk, gece yarısından sonrası son).
 * Satır, iş gününün başından (05:00) geçen saattir (`offset`). Tek günde gün 24 saati aşarsa (05:00'te kapanmadı,
 * masa açık kaldı) ertesi günün saatleri kendi satırlarıyla sonda gelir (`nextDay`): 27 Ekim 06:30 satışı 26 Ekim
 * sabahının 06'sına karışmaz, gecenin ardından çizilir. Çok günlük dönemde satır günün saatidir (dağılım), 24 satır.
 * Adisyon sayısı Adisyon kutusuyla aynı ölçütle: tutarı olan adisyon (tamamı ikram edilen ₺0 adisyon sayılmaz).
 */
export function hourlyReport(range: Range) {
  const ds = load(range, ORDERS_ONLY);
  const closed = ds.orders.filter(isSale);
  const hourOf = hourMemo();
  const dates = dayOf(ds);
  const dayStart = new Map(ds.days.map((d) => [d.id, businessDayStartMs(d.date)]));
  const single = range.from === range.to;
  const offsetOf = (o: OrderRow) => {
    const raw = Math.max(0, Math.floor((o.openedAt - (dayStart.get(o.dayId) ?? o.openedAt)) / 3_600_000));
    return single ? raw : raw % 24;
  };
  const offsets = closed.map(offsetOf);
  const length = offsets.reduce((a, x) => Math.max(a, x + 1), 24);
  const hours = Array.from({ length }, (_, offset) => ({ hour: (offset + DAY_ROLLOVER_HOUR) % 24, offset, nextDay: offset >= 24, revenue: 0, orders: 0 }));
  for (const [k, o] of closed.entries()) {
    const row = hours[offsets[k]!]!;
    row.revenue += totalsOf(o).total;
    if (o.total > 0) row.orders += 1;
  }
  const total = hours.reduce((a, h) => a + h.revenue, 0);
  const active = hours.filter((h) => h.orders > 0);
  // Haftanın günü × saat: iş gününün (gece yarısından sonraki satış o güne yazılır) haftanın günü, adisyonun açıldığı
  // saat; hücre o günün ortalama cirosu (dönemde 2 salı varsa salı hücreleri 2'ye bölünür)
  const weekdayOf = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  };
  const week = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, days: 0, hours: Array.from({ length: 24 }, () => 0) }));
  for (const d of ds.days) week[weekdayOf(d.date) - 1].days += 1;
  for (const o of closed) {
    const date = dates.get(o.dayId);
    if (date) week[weekdayOf(date) - 1].hours[hourOf(o.openedAt)] += totalsOf(o).total;
  }
  for (const w of week) if (w.days > 1) w.hours = w.hours.map((v) => Math.round(v / w.days));
  const parts = PARTS.map((p) => {
    const hs = hours.filter((h) => (h.hour >= p.from && h.hour < p.to) || (p.to > 24 && h.hour < p.to - 24));
    const revenue = hs.reduce((a, h) => a + h.revenue, 0);
    return { key: p.key, label: p.label, revenue, orders: hs.reduce((a, h) => a + h.orders, 0), share: pct(revenue, total) };
  });
  return {
    range,
    total,
    days: ds.days.length,
    hours,
    parts,
    busiest: active.length ? active.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null,
    quietest: active.length ? active.reduce((a, b) => (b.revenue < a.revenue ? b : a)) : null,
    peaks: [...active].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    week,
  };
}

// ─── Hazırlama süresi (bara gönderilmesinden "Hazır"a) ───────────────────────

/** Sıralı dizide yüzdelik (en yakın sıra) */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Bar ve mutfakta hazırlama süresi: kalemin gönderildiği andan "Hazır"a basıldığı ana (saniye). Ürün, saat ve
 * en yavaş fişler; yoğun saatte kaç barista gerektiğini gösterir. Açık adisyonlar da sayılır (hazırlanmışsa).
 */
export function prepReport(range: Range) {
  const ds = load(range);
  const orderNo = new Map(ds.orders.map((o) => [o.id, o.no]));
  const done = ds.items
    .filter((i) => !i.voided && i.stationId && i.readyAt && i.readyAt >= i.sentAt)
    .map((i) => ({ id: i.id, orderId: i.orderId, name: i.name, size: i.size, sentAt: i.sentAt, sec: Math.round((i.readyAt! - i.sentAt) / 1000) }));
  const stats = (secs: number[]) => {
    const s = [...secs].sort((a, b) => a - b);
    return { count: s.length, avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0, median: percentile(s, 50), p90: percentile(s, 90), max: s.at(-1) ?? 0 };
  };
  const byProduct = new Map<string, { name: string; size: string; secs: number[] }>();
  for (const d of done) {
    const key = `${d.name}|${d.size}`;
    const row = byProduct.get(key) ?? { name: d.name, size: d.size, secs: [] };
    row.secs.push(d.sec);
    byProduct.set(key, row);
  }
  const hourOf = hourMemo();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, secs: [] as number[] }));
  for (const d of done) hours[hourOf(d.sentAt)].secs.push(d.sec);
  return {
    range,
    overall: stats(done.map((d) => d.sec)),
    products: [...byProduct.values()].map((r) => ({ name: r.name, size: r.size, ...stats(r.secs) })).sort((a, b) => b.p90 - a.p90 || b.count - a.count),
    hours: hours.filter((h) => h.secs.length).map((h) => ({ hour: h.hour, ...stats(h.secs) })),
    slowest: [...done].sort((a, b) => b.sec - a.sec).slice(0, 10).map((d) => ({ orderNo: orderNo.get(d.orderId) ?? 0, name: d.name, size: d.size, sentAt: d.sentAt, sec: d.sec })),
  };
}

// ─── Personel (maliyet yetkisi: personel tutarları) ─────────────────────────

export function staffReport(range: Range) {
  const ds = load(range);
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const rows = new Map<string, { userId: string; name: string; orders: number; revenue: number; voids: number; voidValue: number; comps: number; compValue: number; discounts: number }>();
  const row = (id: string | null) => {
    const key = id ?? 'yok';
    if (!rows.has(key)) rows.set(key, { userId: key, name: id ? (users.get(id) ?? 'Bilinmiyor') : 'Atanmamış', orders: 0, revenue: 0, voids: 0, voidValue: 0, comps: 0, compValue: 0, discounts: 0 });
    return rows.get(key)!;
  };
  const closed = ds.orders.filter(isSale);
  for (const o of closed) {
    const r = row(o.waiterId);
    // Adisyon kutusuyla aynı ölçüt: tamamı ikram edilen ₺0 adisyon sayılmaz (ortalamayı düşürmez); indirimi ve
    // ikramı yine garsona yazılır
    if (o.total > 0) r.orders += 1;
    r.revenue += totalsOf(o).total;
    r.discounts += totalsOf(o).lineDiscounts + totalsOf(o).orderDiscount;
  }
  // İptal bütün POS adisyonlarından (X/Z ve iptal listesiyle aynı); ikram, ciro gibi kapanmış adisyondan (açıkken
  // geri alınabilir)
  for (const i of voidedItems(ds)) {
    const r = row(i.voidBy);
    r.voids += i.qty;
    r.voidValue += i.qty * i.unitPrice;
  }
  const closedIds = idsOf(closed);
  for (const i of ds.items) {
    if (!i.voided && i.complimentary && closedIds.has(i.orderId)) {
      const r = row(i.compBy);
      r.comps += i.qty;
      r.compValue += i.qty * i.unitPrice;
    }
  }
  return { range, staff: [...rows.values()].sort((a, b) => b.revenue - a.revenue) };
}

/** Kapanmış adisyonlardaki ciro dışı kalemlerin bir türünün (ödenmez, zayi) değeri; Z'deki `odenmez` ve `zayi` ile aynı kural */
function compKindOf(ds: { items: ItemRow[] }, closedIds: Set<string>, kind: CompKind): number {
  return ds.items.filter((i) => !i.voided && i.complimentary && i.compKind === kind && closedIds.has(i.orderId)).reduce((a, i) => a + i.qty * i.unitPrice, 0);
}

// ─── Kalem listeleri: iptal, ikram, indirim, iade, happy hour ───────────────

/** Bütün POS adisyonlarından (açık ve kalemleri taşınmış olanlar dahil): iptal listesi X/Z'nin iptal tutarını verir */
export function itemListReport(range: Range, kind: 'iptal' | 'ikram' | 'indirim' | 'happy') {
  const ds = load(range);
  const orders = new Map(ds.orders.map((o) => [o.id, o]));
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const tables = new Map(db.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((t) => [t.id, t.name]));
  const pick = (i: ItemRow) =>
    kind === 'iptal' ? i.voided : kind === 'ikram' ? i.complimentary && !i.voided : kind === 'indirim' ? i.discount > 0 && !i.voided : i.happyHour && !i.voided;
  const rows = ds.items
    .filter((i) => orders.get(i.orderId)?.source === 'pos' && pick(i))
    .map((i) => {
      const o = orders.get(i.orderId)!;
      const listUnit = i.basePrice + i.options.reduce((a, op) => a + op.price * op.qty, 0);
      const value = kind === 'indirim' ? i.discount : kind === 'happy' ? Math.max(0, listUnit - i.unitPrice) * i.qty : i.qty * i.unitPrice;
      return {
        id: i.id,
        at: kind === 'iptal' ? (i.voidedAt ?? i.createdAt) : i.createdAt,
        orderId: o.id,
        orderNo: o.no,
        place: o.tableId ? (tables.get(o.tableId) ?? '') : ORDER_TYPE_LABEL[o.type],
        name: i.name,
        size: i.size,
        qty: i.qty,
        value,
        reason: kind === 'iptal' ? i.voidReason : kind === 'ikram' ? i.compReason : kind === 'indirim' ? i.discountReason : 'Happy hour',
        compKind: kind === 'ikram' ? (i.compKind ?? 'ikram') : null,
        by: users.get((kind === 'iptal' ? i.voidBy : kind === 'ikram' ? i.compBy : i.createdBy) ?? '') ?? null,
        approvedBy: kind === 'iptal' && i.voidApprovedBy ? (users.get(i.voidApprovedBy) ?? null) : null,
        afterSend: i.voidAfterSend,
        billPrinted: !!o.billPrintedAt,
      };
    })
    .sort((a, b) => b.at - a.at);
  // Adisyon düzeyindeki indirimler de indirim raporuna girer
  if (kind === 'indirim') {
    for (const o of ds.orders) {
      const t = totalsOf(o);
      if (o.source !== 'pos' || !t.orderDiscount) continue;
      rows.push({
        id: `${o.id}-adisyon`,
        at: o.closedAt ?? o.updatedAt,
        orderId: o.id,
        orderNo: o.no,
        place: o.tableId ? (tables.get(o.tableId) ?? '') : ORDER_TYPE_LABEL[o.type],
        name: 'Adisyon indirimi',
        size: 'TEK',
        qty: 1,
        value: t.orderDiscount,
        reason: o.discountReason,
        compKind: null,
        by: o.discountBy ? (users.get(o.discountBy) ?? null) : null,
        approvedBy: null,
        afterSend: false,
        billPrinted: !!o.billPrintedAt,
      });
    }
    rows.sort((a, b) => b.at - a.at);
  }
  return { range, total: rows.reduce((a, r) => a + r.value, 0), count: rows.length, rows };
}

export function refundReport(range: Range) {
  const ds = load(range);
  const orders = new Map(ds.orders.map((o) => [o.id, o]));
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const rows = ds.payments
    .filter((p) => p.refundedAt)
    .map((p) => ({
      id: p.id,
      at: p.refundedAt!,
      orderNo: p.orderId ? (orders.get(p.orderId)?.no ?? null) : null,
      method: p.methodName,
      amount: p.amount,
      reason: p.refundReason,
      by: p.refundedBy ? (users.get(p.refundedBy) ?? null) : null,
    }))
    .sort((a, b) => b.at - a.at);
  return { range, total: rows.reduce((a, r) => a + r.amount, 0), count: rows.length, rows };
}

/**
 * Adisyon listesi (ModPOS "Adisyon" raporu): kapanan ve iptal edilen adisyonlar, ödeme türleriyle. `count` dönemin
 * gerçek adisyon sayısı; `rows` en yeni `limit` adisyon (ekran), `limit` null ise hepsi (CSV). `showWaiter` garsonun
 * kime gösterileceğini söyler: garsona göre toplanan liste personel tutarıdır (`seesStaffOf`).
 */
export function checksReport(range: Range, limit: number | null = 300, showWaiter: (waiterId: string | null) => boolean = () => true) {
  const ds = load(range);
  const tables = new Map(db.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((t) => [t.id, t.name]));
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const checks = ds.orders
    .filter((o) => o.source === 'pos' && (o.status === 'kapali' || o.status === 'iptal'))
    .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  // Kalem ve ödeme adisyona göre bir kez gruplanır (satır başına bütün listeyi taramak uzun dönemde karesel)
  const itemsBy = groupBy(
    ds.items.filter((i) => !i.voided),
    (i) => i.orderId,
  );
  const paysBy = groupBy(
    ds.payments.filter((p) => p.orderId && !p.refundedAt),
    (p) => p.orderId!,
  );
  const rows = (limit == null ? checks : checks.slice(0, limit)).map((o) => {
    const its = itemsBy.get(o.id) ?? [];
    const pays = paysBy.get(o.id) ?? [];
    return {
      id: o.id,
      no: o.no,
      status: o.status,
      type: o.type,
      place: o.tableId ? (tables.get(o.tableId) ?? '') : null,
      openedAt: o.openedAt,
      closedAt: o.closedAt,
      waiter: o.waiterId && showWaiter(o.waiterId) ? (users.get(o.waiterId) ?? null) : null,
      itemCount: its.length,
      qty: its.reduce((a, i) => a + i.qty, 0),
      total: o.total,
      methods: [...new Set(pays.map((p) => p.methodName))],
    };
  });
  return { range, count: checks.length, rows };
}

// ─── Patron paneli: canlı ───────────────────────────────────────────────────

/**
 * Bir iş gününde, gün başından itibaren `elapsedMs` içinde kapanan POS adisyonlarının cirosu ve adisyon sayısı
 * (raporlarla aynı ölçüt: tutarı olan adisyon; tamamı ikram edilen sayılmaz)
 */
function salesUntil(date: string, elapsedMs: number) {
  const start = businessDayStartMs(date);
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.date, date)).all();
  if (!day.length) return { netSales: 0, orders: 0 };
  const orders = db
    .select()
    .from(schema.orders)
    .where(and(inArray(schema.orders.dayId, day.map((d) => d.id)), eq(schema.orders.status, 'kapali'), eq(schema.orders.source, 'pos')))
    .all()
    .filter((o) => (o.closedAt ?? 0) <= start + elapsedMs);
  return { netSales: orders.reduce((a, o) => a + totalsOf(o).total, 0), orders: orders.filter((o) => o.total > 0).length };
}

export function patronLive(withCost: boolean) {
  const now = Date.now();
  const openDay = getOpenDay(db);
  const today = currentBusinessDate(openDay?.date, now);
  const elapsed = now - businessDayStartMs(today);
  const ds = load({ from: today, to: today });
  const pos = ds.orders.filter((o) => o.source === 'pos');
  const closed = pos.filter((o) => o.status === 'kapali');
  const open = pos.filter((o) => o.status === 'acik');
  const netSales = closed.reduce((a, o) => a + totalsOf(o).total, 0);
  const openTotal = open.reduce((a, o) => a + o.total - o.paid, 0);
  const lastWeek = salesUntil(addDays(today, -7), elapsed);
  const fourWeeks = salesUntil(addDays(today, -28), elapsed);
  const yesterday = summaryReport({ from: addDays(today, -1), to: addDays(today, -1) }, now);

  // Saat dizisi saat numarasıyla (0-23); gün 05:00'i geçip 24 saati aştıysa ertesi günün saatleri `…NextDay`de
  // ([0] ertesi gün 05:00). Grafik iş günü sırasıyla çizer (src/lib/period.ts hourBars): gecenin ardından ertesi gün.
  // Eski istemci yalnız 24 saati okur, ertesi günü göstermez ama saatleri kaymaz (LafPOS Uzaktan sürüm farkı)
  const byHour = (date: string) => {
    const rows = hourlyReport({ from: date, to: date }).hours;
    const day = Array.from({ length: 24 }, () => 0);
    for (const r of rows) if (!r.nextDay) day[r.hour] = r.revenue;
    return { day, next: rows.filter((r) => r.nextDay).map((r) => r.revenue) };
  };
  const todayHours = byHour(today);
  const lastWeekHours = byHour(addDays(today, -7));
  const products = productReport({ from: today, to: today }, withCost).products.slice(0, 6);
  const summary = summaryReport({ from: today, to: today }, now);

  const tables = new Map(db.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((t) => [t.id, t.name]));
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const openChecks = open
    .map((o) => ({ id: o.id, no: o.no, place: o.tableId ? (tables.get(o.tableId) ?? '') : ORDER_TYPE_LABEL[o.type], total: o.total, paid: o.paid, openedAt: o.openedAt, waiter: o.waiterId ? (users.get(o.waiterId) ?? null) : null, billPrinted: !!o.billPrintedAt }))
    .sort((a, b) => a.openedAt - b.openedAt);

  const since = businessDayStartMs(today);
  const alerts = db
    .select()
    .from(schema.auditLog)
    .where(and(gte(schema.auditLog.at, since), inArray(schema.auditLog.severity, ['uyari', 'alarm'])))
    .orderBy(desc(schema.auditLog.at))
    .limit(40)
    .all()
    .map((a) => ({ id: a.id, at: a.at, severity: a.severity, action: a.action, message: a.message, amount: a.amount, orderId: a.orderId }));

  return {
    now,
    date: today,
    dayOpen: !!openDay,
    netSales,
    // Raporlarla aynı ölçüt: tutarı olan kapanmış adisyon (tamamı ikram edilen ortalamayı düşürmez)
    orders: closed.filter((o) => o.total > 0).length,
    avgCheck: closed.some((o) => o.total > 0) ? Math.round(netSales / closed.filter((o) => o.total > 0).length) : 0,
    open: { count: open.length, total: openTotal },
    compare: {
      lastWeek: { ...lastWeek, change: change(netSales, lastWeek.netSales) },
      fourWeeks: { ...fourWeeks, change: change(netSales, fourWeeks.netSales) },
    },
    yesterday: { netSales: yesterday.netSales, receipts: yesterday.receipts },
    hourly: todayHours.day,
    hourlyLastWeek: lastWeekHours.day,
    hourlyNextDay: todayHours.next,
    hourlyLastWeekNextDay: lastWeekHours.next,
    payments: summary.payments,
    discounts: summary.discounts,
    complimentary: summary.complimentary,
    odenmez: summary.odenmez,
    zayi: summary.zayi,
    voided: summary.voided,
    online: summary.online,
    top: products,
    ...(withCost ? { costsAt: costsAt() } : {}),
    openChecks,
    alerts,
    anomalies: anomalies(today, summary, open.reduce((a, o) => a + totalsOf(o).gross, 0)),
  };
}

/**
 * Basit anomali kuralları (robotPOS'un "aiR anomali" karşılığı): bugünün iptal oranı son 4 haftanın aynı gününe
 * göre belirgin yüksekse, son gün sonunda kasa farkı varsa, hesap yazdırıldıktan sonra iptal ya da kapanmış
 * adisyon yeniden açıldıysa uyarır. İptal açık adisyonlardan da sayıldığından oranın paydasına açık adisyonların
 * kalemleri (`openGross`) de girer: açık masası çok olan öğleden sonra yalancı alarm vermez.
 */
function anomalies(today: string, s: ReturnType<typeof summaryReport>, openGross: number) {
  const out: { level: 'uyari' | 'alarm'; title: string; detail: string }[] = [];
  const rung = s.gross + openGross + s.voided;
  const rateNow = rung > 0 ? s.voided / rung : 0;
  const past = [7, 14, 21, 28].map((d) => summaryReport({ from: addDays(today, -d), to: addDays(today, -d) }));
  const pastRates = past.filter((p) => p.gross > 0).map((p) => p.voided / (p.gross + p.voided));
  const avg = pastRates.length ? pastRates.reduce((a, b) => a + b, 0) / pastRates.length : 0;
  if (s.voided > 0 && rateNow > Math.max(0.03, avg * 2)) {
    out.push({ level: rateNow > 0.08 ? 'alarm' : 'uyari', title: 'İptal oranı yüksek', detail: `Bugün %${(rateNow * 100).toFixed(1)}; son 4 haftanın aynı günü ortalaması %${(avg * 100).toFixed(1)}` });
  }
  const lastClosed = db.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).all().find((d) => d.closedAt);
  if (lastClosed?.cashDiff != null && lastClosed.cashDiff !== 0) {
    out.push({ level: Math.abs(lastClosed.cashDiff) >= 10000 ? 'alarm' : 'uyari', title: 'Kasa farkı', detail: `Z ${lastClosed.zNo} (${lastClosed.date}) gün sonunda ${(lastClosed.cashDiff / 100).toLocaleString('tr-TR')} ₺ fark` });
  }
  if (lastClosed && lastClosed.closedAt && lastClosed.countedCash == null) {
    out.push({ level: 'uyari', title: 'Kasa föyü girilmedi', detail: `Z ${lastClosed.zNo} (${lastClosed.date}) sayılmadan kapandı` });
  }
  const since = businessDayStartMs(today);
  const reopen = db.select().from(schema.auditLog).where(and(gte(schema.auditLog.at, since), eq(schema.auditLog.action, 'order.reopen'))).all();
  if (reopen.length) out.push({ level: 'alarm', title: 'Kapanmış adisyon açıldı', detail: `Bugün ${reopen.length} kez` });
  const afterBill = db
    .select()
    .from(schema.auditLog)
    .where(and(gte(schema.auditLog.at, since), eq(schema.auditLog.action, 'item.void'), eq(schema.auditLog.severity, 'alarm')))
    .all();
  if (afterBill.length) out.push({ level: 'alarm', title: 'Hesap yazdırıldıktan sonra iptal', detail: `Bugün ${afterBill.length} kalem` });
  return out;
}
