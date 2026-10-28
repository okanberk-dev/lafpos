import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { PLATFORM_LABEL, type PlatformId } from '@shared/platforms';
import { numaratorLabel } from '@shared/service-mode';
import { businessDate } from '@shared/time';
import type { FloorOrderSummary, FloorStateDTO, KitchenTicket, PickupBoardDTO, PickupEntryDTO } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { holdsRoom } from '@shared/karaoke';
import { siteKaraokeView } from '../sync/laffogato-karaoke';
import { userNameMap } from './dto';
import { getOpenDay } from './orders';

const TYPE_LABEL: Record<string, string> = { tezgah: 'Tezgâh', gelal: 'Gel-al', paket: 'Paket', online: 'Online', masa: 'Masa' };

export function orderLabel(
  o: { type: string; no: number; deliveryName: string | null; extLabel: string | null; source: string; numarator?: string | null; platform?: PlatformId | null; platformCode?: string | null },
  tableName?: string | null,
): string {
  if (tableName) return tableName;
  if (o.source === 'laffogato') return o.extLabel ?? 'Online';
  // Yarı self servis: kasada girilen masa no / numaratör ("Masa 12"); personel siparişi oraya götürür
  if (o.numarator) return numaratorLabel(o.numarator);
  // Paket platformu: kurye ve bar platformla kısa kodu söyler ("Yemeksepeti A7KX")
  if (o.platform) return `${PLATFORM_LABEL[o.platform]} ${o.platformCode ?? ''}`.trim();
  if (o.deliveryName) return `${TYPE_LABEL[o.type] ?? o.type} · ${o.deliveryName}`;
  return `${TYPE_LABEL[o.type] ?? o.type} #${o.no}`;
}

export function floorState(t: Tx | DB): FloorStateDTO {
  const open = t.select().from(schema.orders).where(eq(schema.orders.status, 'acik')).orderBy(asc(schema.orders.openedAt)).all();
  const ids = open.map((o) => o.id);
  const items = ids.length ? t.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, ids)).all() : [];
  const rooms = ids.length
    ? t
        .select()
        .from(schema.roomSessions)
        .where(and(inArray(schema.roomSessions.orderId, ids), isNull(schema.roomSessions.endedAt)))
        .all()
    : [];
  const names = userNameMap(t);
  const tableNames = new Map(t.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((x) => [x.id, x.name]));

  const result: FloorStateDTO = { tables: {}, reservations: [], others: [] };
  for (const o of open) {
    const mine = items.filter((i) => i.orderId === o.id && !i.voided);
    const summary: FloorOrderSummary = {
      id: o.id,
      no: o.no,
      total: o.extPaid ? (o.extTotal ?? 0) : o.total,
      paid: o.extPaid ? (o.extTotal ?? 0) : o.paid,
      guests: o.guests,
      openedAt: o.openedAt,
      waiterId: o.waiterId,
      waiterName: o.waiterId ? (names.get(o.waiterId) ?? null) : null,
      billPrintedAt: o.billPrintedAt,
      itemCount: mine.reduce((a, i) => a + i.qty, 0),
      pendingKitchen: mine.filter((i) => i.stationId && (i.status === 'yeni' || i.status === 'hazirlaniyor')).length,
      readyToServe: mine.filter((i) => i.status === 'hazir').length,
      source: o.source,
      roomStartedAt: rooms.find((r) => r.orderId === o.id)?.startedAt ?? null,
    };
    if (o.tableId) (result.tables[o.tableId] ??= []).push(summary);
    else result.others.push({ ...summary, type: o.type, label: orderLabel(o, o.tableId ? tableNames.get(o.tableId) : null) });
  }

  const today = businessDate(Date.now());
  result.reservations = t
    .select()
    .from(schema.reservations)
    .where(and(eq(schema.reservations.date, today), inArray(schema.reservations.status, ['bekliyor', 'geldi'])))
    .orderBy(asc(schema.reservations.time))
    .all()
    .map((r) => ({ id: r.id, tableId: r.tableId, time: r.time, name: r.name, guests: r.guests, status: r.status }));
  // Sitedeki karaoke rezervasyonları: odayı tutanlar (iptal ve süresi dolan değil); bağlantı yoksa boş
  result.siteKaraoke = siteKaraokeView().bookings.filter(holdsRoom);
  return result;
}

/** Hazır olan sipariş çağrı ekranında bu kadar kalır (teslim edilince hemen düşer) */
export const PICKUP_READY_MS = 10 * 60_000;
/** Bar ekranının Hazır sekmesi: teslim edilmemiş hazır siparişler bu kadar görünür */
export const KITCHEN_READY_MS = 30 * 60_000;

/**
 * Çağrı ekranı: tezgâh ve gel-al siparişleri ile sitenin gel-al siparişleri. Bar "Hazır"a basınca sipariş
 * "Hazırlanıyor"dan "Hazır"a geçer; masaya ya da kuryeye giden siparişler burada görünmez. Masa no / numaratör
 * girilmiş tezgâh siparişi (yarı self servis) numara yerine masasıyla görünür: müşteri kalkmaz, personel getirir.
 * Paket platformunun gel-al siparişi LafPOS numarasıyla değil platformun kısa koduyla görünür (müşteri uygulamada
 * onu görür). "Teslim edildi" (kalemler serviste ya da gel-al teslim aşamasında) siparişi hemen düşürür.
 */
export function pickupBoard(t: Tx | DB, now = Date.now()): PickupBoardDTO {
  const day = getOpenDay(t);
  const since = day ? Math.min(day.openedAt, now - 12 * 3600_000) : now - 24 * 3600_000;
  const orders = t
    .select()
    .from(schema.orders)
    .where(and(gt(schema.orders.openedAt, since), inArray(schema.orders.status, ['acik', 'kapali'])))
    .all()
    .filter((o) => (o.source === 'pos' && (o.type === 'tezgah' || o.type === 'gelal')) || (o.source === 'laffogato' && o.extFulfillment === 'pickup'));
  const items = orders.length
    ? t.select().from(schema.orderItems).where(and(inArray(schema.orderItems.orderId, orders.map((o) => o.id)), eq(schema.orderItems.voided, false))).all()
    : [];
  const board: PickupBoardDTO = { preparing: [], ready: [] };
  for (const o of orders) {
    const mine = items.filter((i) => i.orderId === o.id && i.stationId);
    if (!mine.length) continue;
    if (o.deliveryStatus === 'teslim') continue;
    const entry: PickupEntryDTO = {
      id: o.id,
      no: o.source === 'laffogato' ? (o.extNo ?? o.no) : o.no,
      name: o.deliveryName?.trim().split(/\s+/)[0] || null,
      online: o.source === 'laffogato',
      table: o.numarator ?? null,
      ...(o.platform && o.platformCode ? { platform: o.platform, code: o.platformCode } : {}),
    };
    if (mine.some((i) => i.status === 'yeni' || i.status === 'hazirlaniyor')) {
      board.preparing.push(entry);
      continue;
    }
    if (mine.every((i) => i.status === 'servis')) continue;
    const readyAt = Math.max(...mine.map((i) => i.readyAt ?? 0), o.source === 'laffogato' ? o.updatedAt : 0);
    if (now - readyAt < PICKUP_READY_MS) board.ready.push({ ...entry, readyAt });
  }
  board.ready.sort((a, b) => b.readyAt - a.readyAt);
  return board;
}

/**
 * Bar/mutfak ekranı. Varsayılan: istasyona düşen ve henüz hazır olmayan kalemler, fiş (adisyon + gönderim) başına
 * gruplu. `ready` (Hazır sekmesi): son 30 dakikada hazır olup teslim edilmemiş kalemler, sipariş başına tek fiş
 * (müşteri siparişi bütün alır); site ve paket platformu siparişleri gelmez, onların teslimi kendi akışlarında.
 * `history` (Geçmiş): son 90 dakikada hazır olanlar ve teslim edilenler.
 */
export function kitchenTickets(t: Tx | DB, opts: { stationId?: string | null; history?: boolean; ready?: boolean } = {}): KitchenTicket[] {
  const now = Date.now();
  const day = getOpenDay(t);
  const since = day ? Math.min(day.openedAt, now - 12 * 3600_000) : now - 24 * 3600_000;

  const base = and(gt(schema.orderItems.sentAt, since), opts.stationId ? eq(schema.orderItems.stationId, opts.stationId) : undefined);
  const where = opts.history
    ? and(base, eq(schema.orderItems.voided, false), inArray(schema.orderItems.status, ['hazir', 'servis']), gt(schema.orderItems.readyAt, now - 90 * 60_000))
    : opts.ready
      ? and(base, eq(schema.orderItems.voided, false), eq(schema.orderItems.status, 'hazir'), gt(schema.orderItems.readyAt, now - KITCHEN_READY_MS))
      : and(
          base,
          or(
            and(eq(schema.orderItems.voided, false), inArray(schema.orderItems.status, ['yeni', 'hazirlaniyor'])),
            // Hazırlanırken iptal edilen kalem 10 dakika boyunca üstü çizili görünür
            and(eq(schema.orderItems.voided, true), eq(schema.orderItems.voidAfterSend, true), gt(schema.orderItems.voidedAt, now - 10 * 60_000)),
          ),
        );

  const rows = t
    .select({ item: schema.orderItems, order: schema.orders })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .where(and(where, inArray(schema.orders.status, ['acik', 'kapali'])))
    .orderBy(asc(schema.orderItems.sentAt))
    .all()
    .filter((r) => r.item.stationId && (!opts.ready || (r.order.source === 'pos' && !r.order.platform && r.order.deliveryStatus !== 'teslim')));

  const names = userNameMap(t);
  const tableNames = new Map(t.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((x) => [x.id, x.name]));
  const tickets = new Map<string, KitchenTicket>();
  for (const { item, order } of rows) {
    const key = opts.ready ? `${order.id}:hazir` : `${order.id}:${item.batch}`;
    let ticket = tickets.get(key);
    if (!ticket) {
      ticket = {
        key,
        orderId: order.id,
        orderNo: order.source === 'laffogato' ? (order.extNo ?? order.no) : order.no,
        batch: item.batch,
        label: orderLabel(order, order.tableId ? tableNames.get(order.tableId) : null),
        type: order.type,
        source: order.source,
        waiterName: order.waiterId ? (names.get(order.waiterId) ?? null) : null,
        note: order.note,
        sentAt: item.sentAt,
        scheduledFor: order.scheduledFor,
        numarator: order.numarator ?? null,
        items: [],
      };
      tickets.set(key, ticket);
    }
    ticket.items.push({
      id: item.id,
      name: item.name,
      size: item.size,
      optionsText: item.optionsText,
      qty: item.qty,
      note: item.note,
      status: item.status,
      voided: item.voided,
      stationId: item.stationId,
      sentAt: item.sentAt,
      startedAt: item.startedAt,
      readyAt: item.readyAt,
    });
  }
  // Yalnız iptal satırı kalan fişte bile iptal bildirimi gösterilsin; ama hiç kalemi kalmayan fiş yok
  const list = [...tickets.values()].filter((tk) => tk.items.length);
  // Hazır: en uzun bekleyen önce (alınmayan sipariş üstte kalır)
  const readyOf = (tk: KitchenTicket) => Math.max(...tk.items.map((i) => i.readyAt ?? 0));
  if (opts.ready) return list.sort((a, b) => readyOf(a) - readyOf(b));
  return opts.history ? list.sort((a, b) => b.sentAt - a.sentAt) : list;
}
