import { and, count, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { CLOSED_PAGE_DEFAULT, CLOSED_PAGE_MAX, type ClosedOrderDetailDTO, type ClosedOrderRow, type ClosedOrdersDTO, KITCHEN_HISTORY_MAX } from '@shared/history';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { matchesTerms, searchTerms } from '@shared/search';
import { currentBusinessDate } from '@shared/time';
import type { KitchenTicket } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { type AuthUser, blindOrder, can, requirePermission, seesCashNumbers } from '../lib/auth';
import { notFound } from '../lib/http';
import { orderToDTO, userNameMap } from './dto';
import { kitchenItemOf, kitchenTicketOf, orderLabel } from './floor';
import { getOpenDay } from './orders';

const { orders, orderItems } = schema;

// ─── Bar geçmişi ─────────────────────────────────────────────────────────────

/**
 * Bar ekranının Geçmiş görünümü: açık günün hazırlanmış ve teslim edilmiş fişleri (adisyon + gönderim), en son hazır
 * olan üstte, en çok 100 fiş. Gün sonu alınınca boşalır (açık gün yoksa boş): dünün fişi bugüne karışmaz. Arama günün
 * bütün fişlerinde yapılır (sipariş no, masa ya da tür, müşteri adı, ürün adı), yine en çok 100 sonuç.
 *
 * Kasanın siparişinde hazır anı kaleme yazılır. Sitenin siparişi kendi akışında ilerler (hazır anı yazılmaz, hazırlama
 * raporuna girmez): fişi son hareketinin anıyla sıralanır, hazır saati boş gelir. Siteden kalkan (iptal, süresi geçen)
 * sipariş hazırlanmış sayılmaz.
 */
export function kitchenHistory(t: Tx | DB, opts: { stationId?: string | null; q?: string | null; limit?: number } = {}): KitchenTicket[] {
  const day = getOpenDay(t);
  if (!day) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? KITCHEN_HISTORY_MAX), KITCHEN_HISTORY_MAX);
  const done = and(
    eq(orders.dayId, day.id),
    inArray(orders.status, ['acik', 'kapali']),
    eq(orderItems.held, false),
    eq(orderItems.voided, false),
    inArray(orderItems.status, ['hazir', 'servis']),
    opts.stationId ? eq(orderItems.stationId, opts.stationId) : isNotNull(orderItems.stationId),
    or(isNotNull(orderItems.readyAt), isNotNull(orderItems.servedAt), and(eq(orders.source, 'laffogato'), sql`coalesce(${orders.extStage}, '') <> 'gone'`)),
  );
  /** Kalemin "bitti" anı: hazır, yoksa teslim, o da yoksa (site akışı) adisyonun son hareketi */
  const doneAt = sql<number>`coalesce(${orderItems.readyAt}, ${orderItems.servedAt}, ${orders.updatedAt})`;
  const tableNames = new Map(t.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((x) => [x.id, x.name]));
  const terms = searchTerms(opts.q);

  let keys: { orderId: string; batch: number }[];
  if (!terms.length) {
    const latest = sql<number>`max(${doneAt})`;
    keys = t
      .select({ orderId: orderItems.orderId, batch: orderItems.batch, at: latest })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(done)
      .groupBy(orderItems.orderId, orderItems.batch)
      .orderBy(desc(latest))
      .limit(limit)
      .all();
  } else {
    // Arama günün bütün fişlerinde: yalnız aranan alanlar okunur, Türkçe harfe duyarsız süzgeç bellekte (`foldTr`)
    const slim = t
      .select({
        orderId: orderItems.orderId,
        batch: orderItems.batch,
        name: orderItems.name,
        at: doneAt,
        no: orders.no,
        extNo: orders.extNo,
        type: orders.type,
        source: orders.source,
        tableId: orders.tableId,
        numarator: orders.numarator,
        deliveryName: orders.deliveryName,
        extLabel: orders.extLabel,
        platform: orders.platform,
        platformCode: orders.platformCode,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(done)
      .all();
    const found = new Map<string, { orderId: string; batch: number; at: number; text: string }>();
    for (const r of slim) {
      const key = `${r.orderId}:${r.batch}`;
      const hit = found.get(key);
      if (hit) {
        hit.at = Math.max(hit.at, r.at);
        hit.text += ` ${r.name}`;
        continue;
      }
      const no = r.source === 'laffogato' ? (r.extNo ?? r.no) : r.no;
      const label = orderLabel(r, r.tableId ? tableNames.get(r.tableId) : null);
      found.set(key, { orderId: r.orderId, batch: r.batch, at: r.at, text: `${no} ${label} ${ORDER_TYPE_LABEL[r.type] ?? ''} ${r.source === 'laffogato' ? 'online' : ''} ${r.deliveryName ?? ''} ${r.name}` });
    }
    keys = [...found.values()]
      .filter((f) => matchesTerms(f.text, terms))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }
  if (!keys.length) return [];

  const wanted = new Set(keys.map((k) => `${k.orderId}:${k.batch}`));
  const rows = t
    .select({ item: orderItems, order: orders })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(done, inArray(orderItems.orderId, [...new Set(keys.map((k) => k.orderId))])))
    .orderBy(orderItems.sentAt, orderItems.id)
    .all()
    .filter((r) => wanted.has(`${r.order.id}:${r.item.batch}`));

  const names = userNameMap(t);
  const tickets = new Map<string, { ticket: KitchenTicket; at: number; readyBy: Set<string>; servedBy: Set<string> }>();
  for (const { item, order } of rows) {
    const key = `${order.id}:${item.batch}`;
    let entry = tickets.get(key);
    if (!entry) {
      entry = { ticket: kitchenTicketOf(order, item, key, names, tableNames), at: 0, readyBy: new Set(), servedBy: new Set() };
      tickets.set(key, entry);
    }
    entry.ticket.items.push({ ...kitchenItemOf(item), servedAt: item.servedAt });
    entry.at = Math.max(entry.at, item.readyAt ?? item.servedAt ?? order.updatedAt);
    if (item.readyBy && names.has(item.readyBy)) entry.readyBy.add(names.get(item.readyBy)!);
    if (item.status === 'servis' && item.servedBy && names.has(item.servedBy)) entry.servedBy.add(names.get(item.servedBy)!);
  }
  return [...tickets.values()]
    .sort((a, b) => b.at - a.at)
    .map(({ ticket, readyBy, servedBy }) => {
      const readyAts = ticket.items.map((i) => i.readyAt).filter((x): x is number => x != null);
      const allServed = ticket.items.every((i) => i.status === 'servis');
      const servedAts = ticket.items.map((i) => i.servedAt).filter((x): x is number => x != null);
      return {
        ...ticket,
        history: {
          readyAt: readyAts.length ? Math.max(...readyAts) : null,
          servedAt: allServed && servedAts.length ? Math.max(...servedAts) : null,
          readyBy: readyBy.size ? [...readyBy].join(', ') : null,
          servedBy: servedBy.size ? [...servedBy].join(', ') : null,
        },
      };
    });
}

// ─── Kapanan adisyonlar ──────────────────────────────────────────────────────

/** Siparişler ekranını açabilen (sipariş alan, ödeme alan, paketi yöneten) ya da raporu gören kapananları listeler */
export function requireClosedOrders(user: AuthUser) {
  if (!can(user, 'siparis.al') && !can(user, 'odeme.al') && !can(user, 'paket.yonet') && !can(user, 'rapor.gor')) requirePermission(user, 'siparis.al');
}

/**
 * Listelenecek iş günleri. Bugün: açık gün, yoksa şu anın iş günü tarihini taşıyan (bugün kapanmış) günler. Başka bir
 * tarih rapor yetkisi ister (`rapor.gor`): personel yalnız bugünü görür, dünün kapananlarına bakıp ciro çıkaramaz.
 */
function closedDays(t: Tx | DB, user: AuthUser, date?: string | null): { ids: string[]; date: string; today: string } {
  const open = getOpenDay(t);
  const today = currentBusinessDate(open?.date);
  const wanted = date ?? today;
  if (wanted !== today) requirePermission(user, 'rapor.gor');
  const ids = t.select({ id: schema.businessDays.id }).from(schema.businessDays).where(eq(schema.businessDays.date, wanted)).all().map((d) => d.id);
  if (wanted === today && open && !ids.includes(open.id)) ids.push(open.id);
  return { ids, date: wanted, today };
}

/** Sıralama anı: kapanış; kapanış anı yazılmamış eski kayıtta son hareket */
const closedAtOf = sql<number>`coalesce(${orders.closedAt}, ${orders.updatedAt})`;

const closedCols = {
  id: orders.id,
  no: orders.no,
  type: orders.type,
  source: orders.source,
  tableName: schema.tables.name,
  numarator: orders.numarator,
  extLabel: orders.extLabel,
  extNo: orders.extNo,
  deliveryName: orders.deliveryName,
  platform: orders.platform,
  platformCode: orders.platformCode,
  customerName: schema.customers.name,
  customerPhone: schema.customers.phone,
  openedAt: orders.openedAt,
  closedAt: orders.closedAt,
  total: orders.total,
  extPaid: orders.extPaid,
  extTotal: orders.extTotal,
  at: closedAtOf,
};

/** İmleç: sıralama anı ve kimlik ("1793780576004_01M5X0..."); aynı milisaniyede kapanan iki adisyon da kaybolmaz */
function parseCursor(before?: string | null): { at: number; id: string } | null {
  const m = /^(\d{1,16})_([A-Za-z0-9]{1,40})$/.exec(before ?? '');
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}

/**
 * Kapanan adisyonlar, en son kapanan üstte, sayfa sayfa (en çok 100 satır). Arama: adisyon no, masa ya da tür, müşteri
 * (kayıtlı müşteri, telefon, gel-al adı) ve ürün adı; günün kapananlarında, Türkçe harfe duyarsız. Kör kasada ödeme
 * türleri gelmez (`seesCashNumbers`); maliyet ve kâr bu uçta hiç yok.
 */
export function closedOrders(t: Tx | DB, user: AuthUser, opts: { date?: string | null; q?: string | null; limit?: number; before?: string | null } = {}): ClosedOrdersDTO {
  requireClosedOrders(user);
  const days = closedDays(t, user, opts.date);
  const limit = Math.min(Math.max(1, opts.limit ?? CLOSED_PAGE_DEFAULT), CLOSED_PAGE_MAX);
  const empty: ClosedOrdersDTO = { date: days.date, today: days.today, count: 0, rows: [], next: null };
  if (!days.ids.length) return empty;
  const inDay = and(inArray(orders.dayId, days.ids), eq(orders.status, 'kapali'));
  const cursor = parseCursor(opts.before);
  const terms = searchTerms(opts.q);
  const from = () => t.select(closedCols).from(orders).leftJoin(schema.tables, eq(schema.tables.id, orders.tableId)).leftJoin(schema.customers, eq(schema.customers.id, orders.customerId));

  let page: ReturnType<ReturnType<typeof from>['all']>;
  let total: number;
  if (!terms.length) {
    total = t.select({ n: count() }).from(orders).where(inDay).get()?.n ?? 0;
    page = from()
      .where(and(inDay, cursor ? or(lt(closedAtOf, cursor.at), and(eq(closedAtOf, cursor.at), lt(orders.id, cursor.id))) : undefined))
      .orderBy(desc(closedAtOf), desc(orders.id))
      .limit(limit + 1)
      .all();
  } else {
    // Arama günün bütün kapananlarında: ürün adları tek sorguyla, süzgeç bellekte (`foldTr`)
    const all = from().where(inDay).orderBy(desc(closedAtOf), desc(orders.id)).all();
    const itemNames = new Map<string, string>();
    for (const r of t
      .select({ orderId: orderItems.orderId, name: orderItems.name })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(inDay, eq(orderItems.voided, false)))
      .all()) {
      itemNames.set(r.orderId, `${itemNames.get(r.orderId) ?? ''} ${r.name}`);
    }
    const hits = all.filter((r) =>
      matchesTerms(
        `${r.source === 'laffogato' ? (r.extNo ?? r.no) : r.no} ${r.no} ${orderLabel(r, r.tableName)} ${ORDER_TYPE_LABEL[r.type] ?? ''} ${r.source === 'laffogato' ? 'online' : ''} ${r.deliveryName ?? ''} ${r.customerName ?? ''} ${r.customerPhone ?? ''} ${itemNames.get(r.id) ?? ''}`,
        terms,
      ),
    );
    total = hits.length;
    page = (cursor ? hits.filter((r) => r.at < cursor.at || (r.at === cursor.at && r.id < cursor.id)) : hits).slice(0, limit + 1);
  }
  const more = page.length > limit;
  const shown = more ? page.slice(0, limit) : page;
  if (!shown.length) return { ...empty, count: total };

  const ids = shown.map((r) => r.id);
  const items = t
    .select({ orderId: orderItems.orderId, name: orderItems.name, qty: orderItems.qty, voided: orderItems.voided, complimentary: orderItems.complimentary })
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids))
    .orderBy(orderItems.createdAt, orderItems.id)
    .all();
  // Kör kasa: ödeme türleri kasa rakamlarını görmeyene gitmez (nakit satışları toplayıp beklenen nakdi bulamasın)
  const pays = seesCashNumbers(user)
    ? t.select({ orderId: schema.payments.orderId, methodName: schema.payments.methodName, refundedAt: schema.payments.refundedAt }).from(schema.payments).where(inArray(schema.payments.orderId, ids)).orderBy(schema.payments.createdAt).all()
    : [];
  const receipts = t
    .select({ orderId: schema.fiscalReceipts.orderId, receiptNo: schema.fiscalReceipts.receiptNo })
    .from(schema.fiscalReceipts)
    .where(and(inArray(schema.fiscalReceipts.orderId, ids), eq(schema.fiscalReceipts.status, 'tamamlandi'), isNotNull(schema.fiscalReceipts.receiptNo)))
    .orderBy(schema.fiscalReceipts.createdAt)
    .all();

  const rows = shown.map((r): ClosedOrderRow => {
    const mine = items.filter((i) => i.orderId === r.id);
    const live = mine.filter((i) => !i.voided);
    // Aynı ürünün satırları özetle tek parça ("2 Latte"), ilk üç ürün
    const byName = new Map<string, number>();
    for (const i of live) byName.set(i.name, (byName.get(i.name) ?? 0) + i.qty);
    const parts = [...byName].map(([name, qty]) => `${qty} ${name}`);
    return {
      id: r.id,
      no: r.no,
      type: r.type,
      source: r.source,
      tableName: r.tableName,
      numarator: r.numarator,
      extLabel: r.extLabel,
      extNo: r.extNo,
      deliveryName: r.deliveryName,
      platform: r.platform,
      platformCode: r.platformCode,
      customerName: r.customerName,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      total: r.extPaid ? (r.extTotal ?? 0) : r.total,
      extPaid: r.extPaid,
      itemCount: live.reduce((a, i) => a + i.qty, 0),
      summary: parts.slice(0, 3).join(', '),
      more: Math.max(0, parts.length - 3),
      voided: mine.filter((i) => i.voided).reduce((a, i) => a + i.qty, 0),
      comped: live.filter((i) => i.complimentary).reduce((a, i) => a + i.qty, 0),
      methods: [...new Set(pays.filter((p) => p.orderId === r.id && !p.refundedAt).map((p) => p.methodName))],
      receiptNo: receipts.filter((x) => x.orderId === r.id).at(-1)?.receiptNo ?? null,
    };
  });
  const last = shown.at(-1)!;
  return { date: days.date, today: days.today, count: total, rows, next: more ? `${last.at}_${last.id}` : null };
}

/**
 * Kapanan adisyonun ayrıntısı: kalemler (iptal ve ciro dışı olanlarla), ödemeler ve yazarkasa fişi. Adisyon kişiye göre
 * süzülür (`blindOrder`: kör kasada ödeme dökümü yok, başkasının adisyonunda garson ve ödemeyi alan gizli). Bugünün
 * dışındaki günün adisyonu rapor yetkisi ister.
 */
export function closedOrderDetail(t: Tx | DB, user: AuthUser, id: string): ClosedOrderDetailDTO {
  requireClosedOrders(user);
  const o = t.select().from(orders).where(eq(orders.id, id)).get();
  if (!o) throw notFound('Adisyon');
  const today = closedDays(t, user);
  if (!today.ids.includes(o.dayId)) requirePermission(user, 'rapor.gor');
  const sees = seesCashNumbers(user);
  const day = t.select({ date: schema.businessDays.date }).from(schema.businessDays).where(eq(schema.businessDays.id, o.dayId)).get();
  const receipts = t
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, id), inArray(schema.fiscalReceipts.status, ['tamamlandi', 'fis_iptal']), isNotNull(schema.fiscalReceipts.receiptNo)))
    .orderBy(schema.fiscalReceipts.createdAt)
    .all();
  return {
    order: blindOrder(user, orderToDTO(t, o)),
    paymentsHidden: o.status !== 'acik' && !sees,
    receipts: receipts.map((r) => ({ id: r.id, zNo: r.zNo, receiptNo: r.receiptNo, at: r.completedAt ?? r.updatedAt, cancelled: r.status === 'fis_iptal', amount: sees ? r.amount : null })),
    date: day?.date ?? today.today,
  };
}
