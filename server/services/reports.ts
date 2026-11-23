import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray } from 'drizzle-orm';
import { odenmezByPerson } from '@shared/comp';
import { type CrossPay, type PrepDone, prepFrom } from '@shared/remote-calc';
import { type HistoryDay, historyProductsShown, historyProductsView, historyReport, historySpan, mergeHistoryStats } from '@shared/gecmis';
import { type PatronStats, statsDates } from '@shared/today-stats';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { netOfKdv, percentOf, tl } from '@shared/money';
import { calcOrder, offDeviceTotals, type OrderTotals } from '@shared/order-calc';
import { PLATFORM_LABEL, PLATFORMS, type PlatformId } from '@shared/platforms';
import { addDays, businessDate, businessDayStartMs, currentBusinessDate, DAY_ROLLOVER_HOUR, fmtDateShort, istanbulParts } from '@shared/time';
import type { CompKind } from '@shared/types';
import { db, schema } from '../db/client';
import { auditForViewer } from '../delivery/commission';
import { PRE_ACCEPTED_TTL_MS, platformSettings } from '../delivery/service';
import { trainingMode } from '../lib/settings';
import { addonCostOf, addonSiteIds, costMap, costsAt } from '../sync/lafmaliyet';
import { deviceReceipts, onlineCounted } from './days';
import { historyFor, type HistoryIn } from './gecmis';
import { historyStore } from '../sync/modpos';
import { getOpenDay, REFUND_REWRITE, REFUND_VOID } from './orders';

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
function load(range: Range, read: { items?: boolean; payments?: boolean } = {}, skip: string[] = []): Dataset {
  // `skip`: geçmiş ciro gününün (ModPOS) yerine geçtiği deneme günlerinin tarihleri (./gecmis.ts `historyFor`)
  const inRange = and(gte(schema.businessDays.date, range.from), lte(schema.businessDays.date, range.to), ...(skip.length ? [notInArray(schema.businessDays.date, skip)] : []));
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

/**
 * Raporlar › Ciro. `history`: kasanın Raporlar ekranı (server/routes/reports.ts) LafPOS öncesi geçmiş günlerini de görür
 * (ModPOS; ./gecmis.ts `historyFor`): günler kaynağın adıyla, ciro dökümüne indirimi, ciro dışı ve KDV'siyle girer. Gün
 * raporu (Uzaktan'a giden, server/sync/cloud-reports.ts) ve patron paneli geçmişsiz çağırır: LafPOS'un kendi günü
 */
export function summaryReport(range: Range, nowMs = Date.now(), opts: { history?: boolean } = {}) {
  const today = reportToday(nowMs);
  const hist = opts.history ? historyFor(range, today) : null;
  const ds = load(range, {}, hist?.replaced);
  const dates = dayOf(ds);
  const closed = ds.orders.filter(isSale);
  const closedIds = idsOf(closed);
  const sum = (f: (o: OrderRow) => number) => closed.reduce((a, o) => a + f(o), 0);
  const netSales = sum((o) => totalsOf(o).total);
  const receipts = closed.filter((o) => o.total > 0).length;
  const byDay = new Map<string, { date: string; netSales: number; receipts: number; kaynak?: string; zText?: string | null }>();
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
  // Online sipariş sitede ödenmiş gelir, X/Z gibi her aşamada (hazırlanan da) sayılır; ciroya girmez. Sitede iptal ya da
  // iade edildiği ya da kasada ödendiği bilinen girmez (Z'nin kuralı)
  const online = ds.orders.filter(onlineCounted);
  const cmp = comparison(range, nowMs, today);
  const prevHist = opts.history ? historyFor(cmp.range, today) : null;
  const prev = load(cmp.range, ORDERS_ONLY, prevHist?.replaced);
  const prevClosed = prev.orders.filter((o) => isSale(o) && (cmp.cutoffMs == null || (o.closedAt ?? o.openedAt) <= cmp.cutoffMs));
  const prevHistSales = (prevHist?.days ?? []).map((d) => historySales(d, cmp.cutoffMs));
  const prevNet = prevClosed.reduce((a, o) => a + totalsOf(o).total, 0) + prevHistSales.reduce((a, x) => a + x.netSales, 0);
  const prevReceipts = prevClosed.filter((o) => o.total > 0).length + prevHistSales.reduce((a, x) => a + x.receipts, 0);
  // Satılan ürün: ürün raporunun adedi (ikram satılmadı, ayrı sayılır)
  const itemsSold = ds.items.filter((i) => !i.voided && !i.complimentary && closedIds.has(i.orderId)).reduce((a, i) => a + i.qty, 0);
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
  // Geçmiş ciro günleri (ModPOS): gün toplamlarıyla ödeme türlerine, KDV'ye ve günlük satırlara (kaynağın adıyla) girer
  const H = { rev: 0, receipts: 0, list: 0, comp: 0, disc: 0, gross: 0, odenmez: 0 };
  for (const r of (hist?.days ?? []).map((d) => historyReport(d, hist!.kaynak))) {
    H.rev += r.s.rev;
    H.receipts += r.s.receipts;
    H.list += r.s.list;
    H.comp += r.s.comp;
    H.disc += r.s.disc;
    H.gross += r.s.gross;
    H.odenmez += r.s.odenmez;
    byDay.set(r.date, { date: r.date, netSales: r.s.rev, receipts: r.s.receipts, kaynak: r.kaynak, zText: r.zText ?? null });
    for (const [name, zField, amount, count] of r.pay) {
      const row = payMap.get(name) ?? { name, zField, amount: 0, count: 0 };
      row.amount += amount;
      row.count += count;
      payMap.set(name, row);
    }
    for (const [rate, gross, base, k] of r.kdv) {
      const row = kdvByRate.get(rate) ?? { rate, gross: 0, base: 0, kdv: 0 };
      row.gross += gross;
      row.base += base;
      row.kdv += k;
      kdvByRate.set(rate, row);
    }
  }
  const histNet = netSales + H.rev;
  const histReceipts = receipts + H.receipts;
  const block = historyBlock(range, hist);
  const kdvTotal = [...kdvByRate.values()].reduce((a, k) => a + k.kdv, 0);
  const totalPaid = [...payMap.values()].reduce((a, p) => a + p.amount, 0);
  // Kapanmış adisyonların ödemeleri ciroya eşit olmalı (bahşiş hariç); açık adisyonlardan alınan ödeme ayrı
  const paidClosed = salesPays.filter((p) => closedIds.has(p.orderId!)).reduce((a, p) => a + p.amount, 0);
  const paidOpen = salesPays.filter((p) => !closedIds.has(p.orderId!)).reduce((a, p) => a + p.amount, 0);
  const tableOrders = closed.filter((o) => o.type === 'masa');
  const tableGuests = tableOrders.reduce((a, o) => a + o.guests, 0);
  const tableSales = tableOrders.reduce((a, o) => a + totalsOf(o).total, 0);
  // Yazarkasadan geçmeyen kart ve nakit: X ve Z'nin kuralı (shared/order-calc.ts), dönemin günlerinin ödemeleriyle
  const offDevice = offDeviceTotals(ds.payments, deviceReceipts(db, ds.days.map((d) => d.id)));
  return {
    range,
    asOf: nowMs,
    waterfall: {
      list: sum((o) => totalsOf(o).gross + totalsOf(o).complimentary) + H.list,
      complimentary: sum((o) => totalsOf(o).complimentary) + H.comp,
      discounts: sum((o) => totalsOf(o).lineDiscounts + totalsOf(o).orderDiscount) + H.disc,
      service: sum((o) => totalsOf(o).service),
      revenue: histNet,
      kdv: kdvTotal,
      netExKdv: histNet - kdvTotal,
    },
    kdv: [...kdvByRate.values()].sort((a, b) => a.rate - b.rate),
    // Geçmiş gününün ödemeleri cirosuna eşittir (gün toplamı)
    reconciliation: { paidClosed: paidClosed + H.rev, difference: paidClosed - netSales, paidOpen },
    /** Masa adisyonlarının cirosu (kişi başının payı; LafPOS Uzaktan günleri toplarken oranı yeniden kurar) */
    tableSales,
    perGuest: tableGuests ? Math.round(tableSales / tableGuests) : null,
    days: ds.days.length + (hist?.days.length ?? 0),
    netSales: histNet,
    gross: sum((o) => totalsOf(o).gross) + H.gross,
    discounts: sum((o) => totalsOf(o).lineDiscounts + totalsOf(o).orderDiscount) + H.disc,
    complimentary: sum((o) => totalsOf(o).complimentary) + H.comp,
    odenmez: compKindOf(ds, closedIds, 'odenmez') + H.odenmez,
    zayi: compKindOf(ds, closedIds, 'zayi'),
    voided: voidedItems(ds).reduce((a, i) => a + i.qty * i.unitPrice, 0),
    receipts: histReceipts,
    avgCheck: histReceipts ? Math.round(histNet / histReceipts) : 0,
    guests: closed.filter((o) => o.type === 'masa').reduce((a, o) => a + o.guests, 0),
    // Geçmişin ürün listesi dönemin hepsini kapsıyorsa onun adedi de (Ürünler'de ayrı blok)
    itemsSold: itemsSold + (block?.covered ? block.qty : 0),
    tips: salesPays.reduce((a, p) => a + p.tip, 0),
    /** Yazarkasadan geçmeyen kart ve nakit (bahşiş hariç); rapor gören kasa rakamlarını da görür (`seesCashNumbers`) */
    offDevice,
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    payments: [...payMap.values()].sort((a, b) => b.amount - a.amount).map((p) => ({ ...p, share: pct(p.amount, totalPaid) })),
    types: [...types.values()].sort((a, b) => b.amount - a.amount),
    online: { orders: online.length, amount: online.reduce((a, o) => a + (o.extTotal ?? 0), 0) },
    previous: { range: cmp.range, label: cmp.label, netSales: prevNet, receipts: prevReceipts, change: change(histNet, prevNet) },
    // Dönemde geçmiş ciro günü varsa sayfanın notu (kaynak, gün sayısı, ilk ve son gün)
    ...(hist?.days.length ? { history: historySpan(hist.days.map((d) => ({ date: d.date, kaynak: hist.kaynak, indirimBilinmiyor: d.indirimBilinmiyor })))! } : {}),
  };
}

/**
 * Geçmiş gününün kıyas dönemindeki satışı ("aynı saate kadar"): kesim yoksa ya da gün kesimden önce bittiyse (ve kesimden
 * sonra kapanışı yoksa) bütün gün; kesimi içeren gün kapanış dakikalarıyla (dakikası olmayan gün, ModPOS, orada
 * sayılmaz). api/uzaktan.ts `salesUntil` ile aynı kural
 */
function historySales(d: HistoryDay, cutoffMs: number | null): { netSales: number; receipts: number } {
  const start = businessDayStartMs(d.date);
  if (cutoffMs == null || (businessDayStartMs(addDays(d.date, 1)) <= cutoffMs && d.closes.every(([m]) => start + m * 60_000 <= cutoffMs))) return { netSales: d.ciro, receipts: d.adisyon };
  const until = d.closes.filter(([m]) => start + m * 60_000 <= cutoffMs);
  return { netSales: until.reduce((a, c) => a + c[1], 0), receipts: until.reduce((a, c) => a + c[2], 0) };
}

/**
 * Geçmişin dönem ürün listesi (indirim öncesi, ürün ürün; LafPOS ürünlerine karışmaz): dönem bloğun bütün günlerini
 * kapsıyor ve o günlerin hepsi raporda geçmiş günü olarak duruyorsa satırlarıyla (`covered`), yalnız bir kısmını
 * kapsıyorsa not; kesişmiyorsa yok
 */
function historyBlock(range: Range, hist: HistoryIn | null) {
  if (!hist?.urunler) return null;
  const shown = historyProductsShown(hist.urunler, range, hist.inRange, hist.days.map((d) => ({ date: d.date, kaynak: hist.kaynak })));
  if (!shown) return null;
  return shown === 'tam' ? { ...historyProductsView(hist.urunler, hist.kaynak), covered: true as const } : { kaynak: hist.kaynak, from: hist.urunler.from, to: hist.urunler.to, covered: false as const };
}

// ─── Ürün ve kategori ───────────────────────────────────────────────────────

export function productReport(range: Range, withCost: boolean, opts: { history?: boolean; skip?: string[] } = {}) {
  const hist = opts.history ? historyFor(range, reportToday()) : null;
  const ds = load(range, {}, hist?.replaced ?? opts.skip);
  const closedIds = idsOf(ds.orders.filter(isSale));
  const voided = new Set(voidedItems(ds));
  const totals = new Map(ds.orders.map((o) => [o.id, totalsOf(o)]));
  const products = new Map(db.select().from(schema.products).all().map((p) => [p.id, p]));
  const categories = new Map(db.select().from(schema.categories).all().map((c) => [c.id, c]));
  const costs = withCost ? costMap() : {};
  // Eklerin (şurup, ekstra shot, alternatif süt) kimlikleri gün sonunun kuralıyla: ciroları ana ürünün satırında, reçete
  // maliyetleri de oraya eklenir (lafmaliyet ekleri ayrı ürün sayar, kendi maliyetiyle)
  const addonIds = withCost ? addonSiteIds() : null;
  const rows = new Map<
    string,
    { key: string; name: string; size: string; categoryId: string | null; category: string; qty: number; revenue: number; revenueNet: number; cost: number | null; costPartial?: boolean; complimentary: number; voided: number }
  >();
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
        // Yalnız maliyet yetkisine: bir ekin maliyeti bilinmiyor (o ek 0 sayıldı)
        ...(withCost ? { costPartial: false } : {}),
        complimentary: 0,
        voided: 0,
      };
    if (i.voided) row.voided += i.qty;
    else if (i.complimentary) row.complimentary += i.qty;
    else {
      row.qty += i.qty;
      const net = totals.get(i.orderId)?.lineNet[i.id] ?? 0;
      row.revenue += net;
      row.revenueNet += netOfKdv(net, i.kdvRate);
      if (withCost && row.cost != null) {
        const unit = p?.extId ? costs[`${p.extId}:${i.size === 'L' ? 'L' : 'M'}`] : undefined;
        if (unit == null) row.cost = null;
        else {
          // Eklerin maliyeti: bilinmeyen ek 0 sayılır, satır "maliyet eksik" işaretlenir (ana ürünün maliyeti bilinir)
          const addons = addonCostOf(i, costs, addonIds!);
          row.cost += unit * i.qty + addons.cost;
          if (addons.partial) row.costPartial = true;
        }
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
    // Geçmişin (ModPOS) dönem ürün listesi ayrı blokta: indirim öncesi, ürün cirosuna eklenmez
    ...((block) => (block ? { history: block } : {}))(historyBlock(range, hist)),
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
export function hourlyReport(range: Range, opts: { rawWeek?: boolean; history?: boolean; skip?: string[] } = {}) {
  const hist = opts.history ? historyFor(range, reportToday()) : null;
  const ds = load(range, ORDERS_ONLY, hist?.replaced ?? opts.skip);
  // Geçmiş günleri (ModPOS) yalnız kapanış dakikası biliniyorsa saatlere girer (lafmaliyet'ten gelen gün yalnız toplamıyla)
  const histDays = (hist?.days ?? []).filter((d) => d.closes.length);
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
  const histHours = histDays.flatMap((d) => historyReport(d).hours.map(([off, rev, n]) => ({ off: single ? off : off % 24, rev, n })));
  const length = [...offsets, ...histHours.map((x) => x.off)].reduce((a, x) => Math.max(a, x + 1), 24);
  const hours = Array.from({ length }, (_, offset) => ({ hour: (offset + DAY_ROLLOVER_HOUR) % 24, offset, nextDay: offset >= 24, revenue: 0, orders: 0 }));
  for (const [k, o] of closed.entries()) {
    const row = hours[offsets[k]!]!;
    row.revenue += totalsOf(o).total;
    if (o.total > 0) row.orders += 1;
  }
  for (const x of histHours) {
    hours[x.off]!.revenue += x.rev;
    hours[x.off]!.orders += x.n;
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
  for (const d of histDays) {
    const w = week[weekdayOf(d.date) - 1];
    w.days += 1;
    for (const [hour, v] of historyReport(d).clock) w.hours[hour] += v;
  }
  // `rawWeek`: ortalamaya bölünmeden toplam (LafPOS Uzaktan günlük özetleri toplayıp kendisi böler)
  if (!opts.rawWeek) for (const w of week) if (w.days > 1) w.hours = w.hours.map((v) => Math.round(v / w.days));
  const parts = PARTS.map((p) => {
    const hs = hours.filter((h) => (h.hour >= p.from && h.hour < p.to) || (p.to > 24 && h.hour < p.to - 24));
    const revenue = hs.reduce((a, h) => a + h.revenue, 0);
    return { key: p.key, label: p.label, revenue, orders: hs.reduce((a, h) => a + h.orders, 0), share: pct(revenue, total) };
  });
  return {
    range,
    total,
    days: ds.days.length + histDays.length,
    hours,
    parts,
    // Eşit cirolu saatlerde en yoğun ilki, en sakin sonuncusu: aktif saatlerin hepsi eşitse ikisi aynı saati göstermez
    // (aynı saat yalnız tek aktif saatte)
    busiest: active.length ? active.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null,
    quietest: active.length ? active.reduce((a, b) => (b.revenue <= a.revenue ? b : a)) : null,
    peaks: [...active].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    week,
  };
}

/**
 * Bir iş gününün kapanmış satışları, kapandıkları dakikaya göre (gün başından, 05:00, geçen dakika): `[dakika, ciro,
 * tutarı olan adisyon]`, yalnız dolu dakikalar. LafPOS Uzaktan (server/sync/cloud-reports.ts) bugünü içeren dönemin
 * kıyasını ("aynı saate kadar", `comparison` `cutoffMs`) günlük özetten bununla kurar; ölçüt Ciro'nunkiyle aynı
 */
export function closingMinutes(date: string): [number, number, number][] {
  const ds = load({ from: date, to: date }, ORDERS_ONLY);
  const start = businessDayStartMs(date);
  const byMinute = new Map<number, [number, number, number]>();
  for (const o of ds.orders.filter(isSale)) {
    const m = Math.floor(((o.closedAt ?? o.openedAt) - start) / 60_000);
    const row = byMinute.get(m) ?? [m, 0, 0];
    row[1] += totalsOf(o).total;
    if (o.total > 0) row[2] += 1;
    byMinute.set(m, row);
  }
  return [...byMinute.values()].sort((a, b) => a[0] - b[0]);
}

// ─── Hazırlama süresi (bara gönderilmesinden "Hazır"a) ───────────────────────

/**
 * Bar ve mutfakta hazırlama süresi: kalemin gönderildiği andan "Hazır"a basıldığı ana (saniye). Ürün, saat ve
 * en yavaş fişler; yoğun saatte kaç barista gerektiğini gösterir. Açık adisyonlar da sayılır (hazırlanmışsa).
 * `handoff`: hazırdan teslime (bar ekranında ya da kasada "Teslim edildi"); her teslim dokunuşu bir kez sayılır,
 * süresi o dokunuşta teslim edilen kalemlerin en son hazır olanından.
 */
export function prepReport(range: Range, skip: string[] = []) {
  const { done, handoffs } = prepRaw(range, skip);
  return { range, ...prepFrom(done, handoffs, hourMemo()) };
}

/**
 * Hazırlama raporunun ham verisi: hazırlanan kalemler ve teslim süreleri. LafPOS Uzaktan'a günlük gider; dönem
 * istatistiği iki yerde de `prepFrom` (shared/remote-calc.ts) ile kurulur
 */
export function prepRaw(range: Range, skip: string[] = []): { done: PrepDone[]; handoffs: number[] } {
  const ds = load(range, {}, skip);
  const orderNo = new Map(ds.orders.map((o) => [o.id, o.no]));
  const done = ds.items
    .filter((i) => !i.voided && i.stationId && i.readyAt && i.readyAt >= i.sentAt)
    .map((i): PrepDone => [i.name, i.size, i.sentAt, Math.round((i.readyAt! - i.sentAt) / 1000), orderNo.get(i.orderId) ?? 0]);
  // Teslim: aynı adisyonda aynı anda teslim edilen kalemler tek teslimdir. Hiç "Hazır" görmeden teslime geçen kalem
  // (hazır anı teslim anına eşit) sayılmaz
  const handoffs = new Map<string, number>();
  for (const i of ds.items) {
    if (i.voided || !i.stationId || i.status !== 'servis' || !i.readyAt || !i.servedAt || i.servedAt <= i.readyAt) continue;
    const key = `${i.orderId}|${i.servedAt}`;
    handoffs.set(key, Math.min(handoffs.get(key) ?? Infinity, Math.round((i.servedAt - i.readyAt) / 1000)));
  }
  return { done, handoffs: [...handoffs.values()] };
}

/**
 * Dönemin, dönemde kapanmış bir adisyona ait olmayan satış ödemeleri (gün aşırı: adisyon başka günde açılmış): adisyonun
 * günü, kapanmış satış mı, tutar, platform. LafPOS Uzaktan günleri toplarken bunlardan dönemin içine düşenleri
 * "kapanmış adisyonların ödemesi" sayar (`crossPayIn`); kasada dönem tek seferde okunduğu için aynı sonuç
 */
export function crossDayPayments(range: Range): CrossPay[] {
  const ds = load(range, { items: false });
  const closedIds = idsOf(ds.orders.filter(isSale));
  const pays = ds.payments.filter((p) => p.orderId && !p.refundedAt && !closedIds.has(p.orderId));
  if (!pays.length) return [];
  const orderIds = [...new Set(pays.map((p) => p.orderId!))];
  const orders = new Map(db.select().from(schema.orders).where(inArray(schema.orders.id, orderIds)).all().map((o) => [o.id, o]));
  const dayIds = [...new Set([...orders.values()].map((o) => o.dayId))];
  const dates = new Map(dayIds.length ? db.select({ id: schema.businessDays.id, date: schema.businessDays.date }).from(schema.businessDays).where(inArray(schema.businessDays.id, dayIds)).all().map((d) => [d.id, d.date]) : []);
  const channelOf = new Map(db.select({ id: schema.paymentMethods.id, channel: schema.paymentMethods.channel }).from(schema.paymentMethods).all().map((m) => [m.id, m.channel]));
  return pays.map((p): CrossPay => {
    const o = orders.get(p.orderId!);
    const platform = o?.source === 'pos' && o.platform ? o.platform : '';
    return [o ? (dates.get(o.dayId) ?? '') : '', o && isSale(o) ? 1 : 0, p.amount, platform, platform && channelOf.get(p.methodId) === platform ? 1 : 0, p.orderId!, p.methodName];
  });
}

// ─── Personel (maliyet yetkisi: personel tutarları) ─────────────────────────

export function staffReport(range: Range, skip: string[] = []) {
  const ds = load(range, {}, skip);
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const rows = new Map<
    string,
    { userId: string; name: string; orders: number; revenue: number; voids: number; voidValue: number; comps: number; compValue: number; discounts: number; odenmez: number; odenmezValue: number }
  >();
  const row = (id: string | null, fallbackName?: string | null) => {
    const key = id ?? 'yok';
    if (!rows.has(key)) {
      rows.set(key, { userId: key, name: id ? (users.get(id) ?? fallbackName ?? 'Bilinmiyor') : 'Atanmamış', orders: 0, revenue: 0, voids: 0, voidValue: 0, comps: 0, compValue: 0, discounts: 0, odenmez: 0, odenmezValue: 0 });
    }
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
      // Çalışanın adına yazılan ödenmez (personel yemeği, patron hesabı): kalemi kim yazdıysa değil, kimin adınaysa
      if (i.compKind === 'odenmez' && i.compPersonKind === 'user' && i.compPersonId) {
        const p = row(i.compPersonId, i.compPersonName);
        p.odenmez += i.qty;
        p.odenmezValue += i.qty * i.unitPrice;
      }
    }
  }
  return { range, staff: [...rows.values()].sort((a, b) => b.revenue - a.revenue) };
}

/** Kapanmış adisyonlardaki ciro dışı kalemlerin bir türünün (ödenmez, zayi) değeri; Z'deki `odenmez` ve `zayi` ile aynı kural */
function compKindOf(ds: { items: ItemRow[] }, closedIds: Set<string>, kind: CompKind): number {
  return ds.items.filter((i) => !i.voided && i.complimentary && i.compKind === kind && closedIds.has(i.orderId)).reduce((a, i) => a + i.qty * i.unitPrice, 0);
}

// ─── Kalem listeleri: iptal, ikram, indirim, iade, happy hour ───────────────

/**
 * Kalem hesap yazdırıldıktan sonra mı iptal edildi: iptal anında yazılan bayrak (`voidAfterBill`). Adisyonun
 * `billPrintedAt`'i iptalden sonra yazdırılan hesapla da dolar, tek başına yetmez. Bayraktan önce iptal edilmiş kalemde
 * adisyonun son yazdırılması iptalden önceyse hesap kesin iptalden önce görülmüştür; sonraysa bilinmez, sayılmaz
 */
const voidedAfterBill = (i: ItemRow, o: OrderRow) =>
  i.voidAfterBill || (!i.voidReason?.startsWith(REFUND_VOID) && o.billPrintedAt != null && i.voidedAt != null && i.voidedAt > o.billPrintedAt);

/** Bütün POS adisyonlarından (açık ve kalemleri taşınmış olanlar dahil): iptal listesi X/Z'nin iptal tutarını verir */
export function itemListReport(range: Range, kind: 'iptal' | 'ikram' | 'indirim' | 'happy', showStaff: (userId: string) => boolean = () => true, skip: string[] = []) {
  const ds = load(range, {}, skip);
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
        // Ödenmezin kimin adına yazıldığı (personel adı yalnız görebilene; ötekine "Personel")
        person:
          kind === 'ikram' && i.compKind === 'odenmez' && i.compPersonKind && i.compPersonId
            ? { kind: i.compPersonKind, name: i.compPersonKind === 'user' && !showStaff(i.compPersonId) ? 'Personel' : (i.compPersonName ?? 'Bilinmiyor') }
            : null,
        by: users.get((kind === 'iptal' ? i.voidBy : kind === 'ikram' ? i.compBy : i.createdBy) ?? '') ?? null,
        approvedBy: kind === 'iptal' && i.voidApprovedBy ? (users.get(i.voidApprovedBy) ?? null) : null,
        afterSend: i.voidAfterSend,
        afterBill: kind === 'iptal' && voidedAfterBill(i, o),
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
        person: null,
        by: o.discountBy ? (users.get(o.discountBy) ?? null) : null,
        approvedBy: null,
        afterSend: false,
        afterBill: false,
      });
    }
    rows.sort((a, b) => b.at - a.at);
  }
  // Kişi bazında ödenmez: listedeki ödenmez satırlarıyla aynı kapsam (yalnız ikram listesinde)
  const odenmezPeople =
    kind === 'ikram' ? odenmezByPerson(ds.items.filter((i) => orders.get(i.orderId)?.source === 'pos' && i.complimentary && !i.voided && i.compKind === 'odenmez'), showStaff) : [];
  return { range, total: rows.reduce((a, r) => a + r.value, 0), count: rows.length, rows, odenmezPeople };
}

export function refundReport(range: Range, skip: string[] = []) {
  const ds = load(range, {}, skip);
  const orders = new Map(ds.orders.map((o) => [o.id, o]));
  const users = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  // Kalem iadesinde ödeme iptal edilip kalan aynı türle yeniden yazılır (orders.refundItems): iade tutarı net gösterilir.
  // Yeniden yazılan ödeme sonradan kendisi de iptal edilmiş olabilir (ikinci iade, ardından siparişin iptali): o da
  // öncekinin netini düşer, kendi satırında kendi neti görünür (yalnız canlı olanlar sayılınca ilk iade brüt çıkıyordu)
  const rewritten = new Map<string, number>();
  for (const p of ds.payments) if (p.note?.startsWith(REFUND_REWRITE)) rewritten.set(p.note.slice(REFUND_REWRITE.length), p.amount);
  const rows = ds.payments
    .filter((p) => p.refundedAt && p.amount - (rewritten.get(p.id) ?? 0) > 0)
    .map((p) => ({
      id: p.id,
      at: p.refundedAt!,
      orderNo: p.orderId ? (orders.get(p.orderId)?.no ?? null) : null,
      method: p.methodName,
      amount: p.amount - (rewritten.get(p.id) ?? 0),
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
export function checksReport(range: Range, limit: number | null = 300, showWaiter: (waiterId: string | null) => boolean = () => true, skip: string[] = []) {
  const ds = load(range, {}, skip);
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

// ─── Paket platformları ─────────────────────────────────────────────────────

/**
 * Platform siparişinin ciroya girmeme nedeni: platform kaydının durumu (kabul edilip iptal edilen de `iptal`).
 * `unrecorded`: platformda kabul edilmiş (tablette, platformun panelinden ya da kasadan kabulü gidip adisyonu
 * açılamamış) sipariş 3 saat içinde kasaya alınmadı; kaybedilmiş olmayabilir, kasada kaydı yok
 */
type MissedKind = 'rejected' | 'expired' | 'cancelled' | 'unrecorded';

/**
 * Paket platformlarının satışı (Yemeksepeti, Getir Yemek, Trendyol Go, Migros Yemek). Ciro Raporlar › Ciro'nun
 * kuralıyla (kapanmış POS adisyonu, adisyonun açıldığı iş günü, KDV dahil), siparişin kaynağına göre
 * (`orders.platform`): tahsilatı kim yaptıysa yapsın (kapıda nakit alınan da) platformun satışıdır. Platformun
 * karşıladığı kampanya ciroyu düşürmez, bilgi olarak kabul edilen siparişten okunur. Kaçan sipariş (reddedilen,
 * süresi dolan, iptal edilen) ciroya girmez: tutarı müşterinin ödeyeceğidir; kabul edilmemişse geldiği anın iş gününe
 * (05:00 kuralı), kabul edilip iptal edildiyse adisyonun gününe yazılır. Platformun test siparişi sayılmaz.
 * Tahmini komisyon bugünkü oranla (Yönetim › Paket platformları; sipariş anında dondurulmaz, oran değişirse geçmişin
 * tahmini de değişir) ve yalnız maliyet yetkisine (`withCost`): komisyon bir maliyettir.
 */
export function platformReport(range: Range, withCost: boolean, nowMs = Date.now(), skip: string[] = []) {
  const ds = load(range, { items: false }, skip);
  const netSales = ds.orders.filter(isSale).reduce((a, o) => a + totalsOf(o).total, 0);
  const own = ds.orders.filter((o) => o.source === 'pos' && o.platform != null);
  // Kabul edilen siparişlerin platform kaydı: platformun kampanyası ve iptalde müşterinin tutarı
  const dayIds = ds.days.map((d) => d.id);
  const ownIds = db.select({ id: schema.orders.id }).from(schema.orders).where(and(inArray(schema.orders.dayId, dayIds), isNotNull(schema.orders.platform)));
  const acceptedRows = own.length
    ? db.select({ orderId: schema.platformOrders.orderId, payload: schema.platformOrders.payload }).from(schema.platformOrders).where(inArray(schema.platformOrders.orderId, ownIds)).all()
    : [];
  const payloadOf = new Map(acceptedRows.map((r) => [r.orderId!, r.payload]));
  // Kabul edilmeden kapanan kayıtlar: geldiği an dönemin iş günlerinde (05:00'ten 05:00'e)
  const loose = db
    .select()
    .from(schema.platformOrders)
    .where(and(isNull(schema.platformOrders.orderId), gte(schema.platformOrders.receivedAt, businessDayStartMs(range.from)), lt(schema.platformOrders.receivedAt, businessDayStartMs(addDays(range.to, 1)))))
    .all()
    .filter((r) => !r.payload.test);
  const channelOf = new Map(db.select({ id: schema.paymentMethods.id, channel: schema.paymentMethods.channel }).from(schema.paymentMethods).all().map((m) => [m.id, m.channel]));
  const settings = platformSettings();

  const rows = new Map<PlatformId, ReturnType<typeof emptyPlatformRow>>();
  const row = (p: PlatformId) => {
    if (!rows.has(p)) rows.set(p, emptyPlatformRow(p));
    return rows.get(p)!;
  };
  const miss = (p: PlatformId, kind: MissedKind, amount: number) => {
    const r = row(p);
    r.missed[kind] += 1;
    r.missed.orders += 1;
    r.missed.amount += amount;
  };
  const platformOf = new Map<string, PlatformId>();
  for (const o of own) {
    const p = o.platform!;
    platformOf.set(o.id, p);
    if (o.status === 'acik') {
      row(p).open.orders += 1;
      row(p).open.amount += totalsOf(o).total;
    } else if (o.status === 'iptal') miss(p, 'cancelled', payloadOf.get(o.id)?.customerTotal ?? 0);
    else if (isSale(o)) {
      const r = row(p);
      const t = totalsOf(o);
      // Adisyon sayısı Ciro'nun ölçütüyle: tutarı olan adisyon
      if (o.total > 0) r.orders += 1;
      r.revenue += t.total;
      r.discounts += t.lineDiscounts + t.orderDiscount;
      r.platformDiscount += payloadOf.get(o.id)?.platformDiscount ?? 0;
    }
  }
  // Tahsilat: platformun ödeme türü (kanal = platform) platformda, öteki türler (nakit, kart, yemek kartı) kasada
  const saleIds = idsOf(own.filter(isSale));
  for (const pay of ds.payments) {
    if (!pay.orderId || pay.refundedAt || !saleIds.has(pay.orderId)) continue;
    const p = platformOf.get(pay.orderId)!;
    if (channelOf.get(pay.methodId) === p) row(p).collectedByPlatform += pay.amount;
    else row(p).collectedAtCounter += pay.amount;
  }
  let pending = 0;
  for (const r of loose) {
    // Onay bekleyenin süresi geçtiyse platformda iptal olmuştur (zamanlayıcı henüz işaretlemediyse de; Yönetim'deki liste gibi)
    const expired = r.status === 'bekliyor' && r.notifiedStatus !== 'picked' && r.expiresAt != null && r.expiresAt <= nowMs;
    // Platformda kabul edilmiş (panelden ya da kasadan kabulü gidip adisyonu açılamamış) ama kasaya alınmamış kaydın
    // süresi dolmaz: tabletteki gibi 3 saat sonra "kasaya alınmadı" sayılır, karar bekleyen değildir
    const unrecorded = r.status === 'bekliyor' && r.notifiedStatus === 'picked' && (r.payload.scheduledFor ?? r.payload.placedAt) + PRE_ACCEPTED_TTL_MS <= nowMs;
    if (r.status === 'ret') miss(r.platform, 'rejected', r.payload.customerTotal);
    else if (r.status === 'suresi_doldu' || expired) miss(r.platform, r.payload.preAccepted ? 'unrecorded' : 'expired', r.payload.customerTotal);
    else if (unrecorded) miss(r.platform, 'unrecorded', r.payload.customerTotal);
    else if (r.status === 'iptal') miss(r.platform, 'cancelled', r.payload.customerTotal);
    else if (r.status === 'bekliyor' && r.notifiedStatus !== 'picked') pending += 1;
  }

  const revenue = [...rows.values()].reduce((a, r) => a + r.revenue, 0);
  const platforms = PLATFORMS.filter((p) => rows.has(p))
    .map((p) => {
      const r = rows.get(p)!;
      const rate = settings[p].commissionPct;
      return {
        ...r,
        avgBasket: r.orders ? Math.round(r.revenue / r.orders) : 0,
        share: pct(r.revenue, netSales),
        ...(withCost ? { commissionPct: rate, commission: percentOf(r.revenue, rate) } : {}),
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  const orders = platforms.reduce((a, r) => a + r.orders, 0);
  return {
    range,
    /** Dönemin bütün cirosu (Raporlar › Ciro'nun `netSales`'i); platformların payı bunun içindedir */
    netSales,
    revenue,
    orders,
    avgBasket: orders ? Math.round(revenue / orders) : 0,
    share: pct(revenue, netSales),
    open: { orders: platforms.reduce((a, r) => a + r.open.orders, 0), amount: platforms.reduce((a, r) => a + r.open.amount, 0) },
    missed: { orders: platforms.reduce((a, r) => a + r.missed.orders, 0), amount: platforms.reduce((a, r) => a + r.missed.amount, 0) },
    /**
     * Onay bekleyen (karar verilmemiş) siparişler: hiçbir rakama girmez. Platformda kabul edilip adisyonu henüz
     * açılmamış kayıt karar beklemez, sayılmaz (3 saat sonra "kasaya alınmadı")
     */
    pending,
    ...(withCost ? { commission: platforms.reduce((a, r) => a + (r.commission ?? 0), 0) } : {}),
    platforms,
  };
}

function emptyPlatformRow(platform: PlatformId) {
  return {
    platform,
    label: PLATFORM_LABEL[platform],
    /** Tutarı olan kapanmış adisyon */
    orders: 0,
    /** Ciro, KDV dahil */
    revenue: 0,
    /** Restoranın karşıladığı indirim (platformun kampanyasındaki restoran payı ve kasada yapılan indirim) */
    discounts: 0,
    /** Platformun karşıladığı kampanya: ciroyu düşürmez, bilgi */
    platformDiscount: 0,
    collectedByPlatform: 0,
    collectedAtCounter: 0,
    /** Henüz kapanmamış adisyonlar: ciroya girmedi */
    open: { orders: 0, amount: 0 },
    /** Reddedilen, süresi dolan, iptal edilen, platformda kabul edilip kasaya alınmayan; tutar müşterinin ödeyeceği */
    missed: { orders: 0, amount: 0, rejected: 0, expired: 0, cancelled: 0, unrecorded: 0 },
  };
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

/**
 * "Bugün" kıyaslarının girdisi (`shared/today-stats.ts`): kıyas günlerinin kapanış dakikaları, hafta ve ay kıyası için
 * geçmiş tam günler ve en çok satanların geçen haftaki kapanışları. Saatten bağımsız: özet yalnız satışla değişir,
 * "aynı saate kadar" kesimini ekran yapar. Ölçüt `summaryReport`'unki (kapanmış POS adisyonu, `totals.total`)
 */
function patronStats(today: string, top: { key: string }[], guests: number): PatronStats {
  const { curves, dailyFrom, dailyTo } = statsDates(today);
  // Gerçek kullanımda deneme günleri (eğitimde ya da işaretten önce kapanmış) kıyasa girmez: "Dün", "Geçen hafta" ve
  // "Ay başından" gerçek satışla kıyaslanır. Kurulum modunda bütün günler denemedir, kıyas aralarında yapılır
  const live = !trainingMode();
  const trial = (d: { trainingDay: boolean | null; closedAt: number | null }) => live && d.closedAt != null && d.trainingDay !== false;
  const days: PatronStats['days'] = {};
  for (const date of curves) {
    const rows = db.select({ closedAt: schema.businessDays.closedAt, trainingDay: schema.businessDays.trainingDay }).from(schema.businessDays).where(eq(schema.businessDays.date, date)).all().filter((r) => !trial(r));
    if (rows.length) days[date] = { open: rows.some((r) => r.closedAt == null), closes: closingMinutes(date) };
  }
  const ds = load({ from: dailyFrom, to: dailyTo }, ORDERS_ONLY);
  const dates = dayOf(ds);
  const byDate = new Map<string, [string, number, number]>();
  const skip = new Set(ds.days.filter(trial).map((d) => d.id));
  for (const d of ds.days) if (!skip.has(d.id)) byDate.set(d.date, [d.date, 0, 0]);
  for (const o of ds.orders) {
    if (!isSale(o) || skip.has(o.dayId)) continue;
    const row = byDate.get(dates.get(o.dayId)!);
    if (!row) continue;
    row[1] += totalsOf(o).total;
    if (o.total > 0) row[2] += 1;
  }
  const stats: PatronStats = { v: 1, guests, days, daily: [...byDate.values()], topPrev: productCloses(addDays(today, -7), top.slice(0, 5).map((t) => t.key)) };
  // LafPOS öncesi günler (Merkez'den, shared/gecmis.ts): kıyas günü LafPOS'ta yoksa ya da cirosu küçükse geçmiş geçer
  // Elle yüklenen (Merkez) ve lafmaliyet'ten gelen (ModPOS) birleşik kayıt: aynı tarihte lafmaliyet'inki
  return mergeHistoryStats(stats, today, historyStore()?.gunler ?? null);
}

/**
 * Bir iş gününde verilen ürünlerin (ürün raporunun anahtarı) kapanış dakikasına göre satışı: [sıra, dakika, adet,
 * ciro]; ürün raporunun ölçütü (kapanmış adisyon, iptal ve ikram dışı kalem, indirimli kalem tutarı)
 */
function productCloses(date: string, keys: string[]): [number, number, number, number][] {
  if (!keys.length) return [];
  const ds = load({ from: date, to: date }, { payments: false });
  const start = businessDayStartMs(date);
  const closed = new Map(ds.orders.filter(isSale).map((o) => [o.id, o]));
  const index = new Map(keys.map((k, i) => [k, i]));
  const rows = new Map<string, [number, number, number, number]>();
  for (const i of ds.items) {
    const o = closed.get(i.orderId);
    if (!o || i.voided || i.complimentary) continue;
    const idx = index.get(`${i.productId ?? i.name}|${i.size}`);
    if (idx == null) continue;
    const m = Math.floor(((o.closedAt ?? o.openedAt) - start) / 60_000);
    const row = rows.get(`${idx}:${m}`) ?? [idx, m, 0, 0];
    row[2] += i.qty;
    row[3] += totalsOf(o).lineNet[i.id] ?? 0;
    rows.set(`${idx}:${m}`, row);
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Patron paneli. `withCost`: maliyet ve kâr (`rapor.maliyet`). `cashNumbers`: kasa rakamlarını gören (kör kasa kuralı,
 * `seesCashNumbers`; uzaktaki özet için patron rolünün `kasa.rakam`ı): yazarkasadan geçmeyen tutar yalnız ona gider
 */
export function patronLive(withCost: boolean, cashNumbers = false) {
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
    // Eski platform ayarı uyarısının iletisinde komisyon oranı yazıyordu: maliyeti görmeyene (ve bulut özetine) silinir
    .map((a) => auditForViewer({ id: a.id, at: a.at, severity: a.severity, action: a.action, message: a.message, amount: a.amount, orderId: a.orderId }, withCost));

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
    ...(cashNumbers ? { offDevice: summary.offDevice } : {}),
    discounts: summary.discounts,
    complimentary: summary.complimentary,
    odenmez: summary.odenmez,
    zayi: summary.zayi,
    voided: summary.voided,
    online: summary.online,
    top: products,
    stats: patronStats(today, products, summary.guests),
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
 * kalemleri (`openGross`) de girer: açık masası çok olan öğleden sonra yalancı alarm vermez. Açıklamalar ekranın
 * geri kalanı gibi Türkçe biçimde: "%4,5", "₺120,00 eksik", "(2 Kas Pzt)".
 */
function anomalies(today: string, s: ReturnType<typeof summaryReport>, openGross: number) {
  const out: { level: 'uyari' | 'alarm'; title: string; detail: string }[] = [];
  const rung = s.gross + openGross + s.voided;
  const rateNow = rung > 0 ? s.voided / rung : 0;
  const past = [7, 14, 21, 28].map((d) => summaryReport({ from: addDays(today, -d), to: addDays(today, -d) }));
  const pastRates = past.filter((p) => p.gross > 0).map((p) => p.voided / (p.gross + p.voided));
  const avg = pastRates.length ? pastRates.reduce((a, b) => a + b, 0) / pastRates.length : 0;
  // Oran yüzde olarak tek ondalıkla, virgüllü ("%4,5"; tam sayıda ondalık yok: "%12")
  const pct1 = (r: number) => (r * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 });
  if (s.voided > 0 && rateNow > Math.max(0.03, avg * 2)) {
    out.push({ level: rateNow > 0.08 ? 'alarm' : 'uyari', title: 'İptal oranı yüksek', detail: `Bugün %${pct1(rateNow)}; son 4 haftanın aynı günü ortalaması %${pct1(avg)}` });
  }
  const lastClosed = db.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).all().find((d) => d.closedAt);
  if (lastClosed?.cashDiff != null && lastClosed.cashDiff !== 0) {
    // Fark sayılan eksi beklenen: eksi kasada eksik, artı fazla para
    const diff = lastClosed.cashDiff;
    out.push({ level: Math.abs(diff) >= 10000 ? 'alarm' : 'uyari', title: 'Kasa farkı', detail: `Z ${lastClosed.zNo} (${fmtDateShort(lastClosed.date)}) gün sonunda ${tl(Math.abs(diff))} ${diff < 0 ? 'eksik' : 'fazla'}` });
  }
  if (lastClosed && lastClosed.closedAt && lastClosed.countedCash == null) {
    out.push({ level: 'uyari', title: 'Kasa föyü girilmedi', detail: `Z ${lastClosed.zNo} (${fmtDateShort(lastClosed.date)}) sayılmadan kapandı` });
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
