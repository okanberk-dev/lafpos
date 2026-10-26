import { asc, eq, inArray } from 'drizzle-orm';
import { calcOrder } from '@shared/order-calc';
import type { OrderDTO, OrderItemDTO, PaymentDTO } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';

type OrderRow = typeof schema.orders.$inferSelect;
type ItemRow = typeof schema.orderItems.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

export function itemToDTO(i: ItemRow): OrderItemDTO {
  return {
    id: i.id,
    productId: i.productId,
    name: i.name,
    size: i.size,
    options: i.options,
    optionsText: i.optionsText,
    qty: i.qty,
    unitPrice: i.unitPrice,
    basePrice: i.basePrice,
    kdvRate: i.kdvRate,
    discount: i.discount,
    discountReason: i.discountReason,
    happyHour: i.happyHour,
    complimentary: i.complimentary,
    compReason: i.compReason,
    voided: i.voided,
    voidReason: i.voidReason,
    voidAfterSend: i.voidAfterSend,
    note: i.note,
    stationId: i.stationId,
    status: i.status,
    batch: i.batch,
    sentAt: i.sentAt,
    readyAt: i.readyAt,
    paidQty: i.paidQty,
    isService: i.isService,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
  };
}

export function paymentToDTO(p: PaymentRow, userNames: Map<string, string>): PaymentDTO {
  return {
    id: p.id,
    methodId: p.methodId,
    methodName: p.methodName,
    zField: p.zField,
    amount: p.amount,
    tip: p.tip,
    given: p.given,
    change: p.change,
    items: p.items,
    customerId: p.customerId,
    note: p.note,
    userId: p.userId,
    userName: p.userId ? (userNames.get(p.userId) ?? null) : null,
    createdAt: p.createdAt,
    refundedAt: p.refundedAt,
    refundReason: p.refundReason,
  };
}

export function userNameMap(t: Tx | DB): Map<string, string> {
  return new Map(t.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
}

export function orderItems(t: Tx | DB, orderId: string): ItemRow[] {
  return t.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).orderBy(asc(schema.orderItems.createdAt), asc(schema.orderItems.id)).all();
}

export function orderPayments(t: Tx | DB, orderId: string): PaymentRow[] {
  return t.select().from(schema.payments).where(eq(schema.payments.orderId, orderId)).orderBy(asc(schema.payments.createdAt)).all();
}

export function calcFor(order: Pick<OrderRow, 'discountType' | 'discountValue' | 'serviceRate'>, items: ItemRow[]) {
  return calcOrder({
    lines: items.map((i) => ({
      id: i.id,
      qty: i.qty,
      unitPrice: i.unitPrice,
      kdvRate: i.kdvRate,
      discount: i.discount,
      complimentary: i.complimentary,
      voided: i.voided,
    })),
    discount: order.discountType && order.discountValue != null ? { type: order.discountType, value: order.discountValue } : null,
    serviceRate: order.serviceRate,
  });
}

export function orderToDTO(t: Tx | DB, order: OrderRow): OrderDTO {
  const items = orderItems(t, order.id);
  const pays = orderPayments(t, order.id);
  const names = userNameMap(t);
  const table = order.tableId ? t.select({ name: schema.tables.name }).from(schema.tables).where(eq(schema.tables.id, order.tableId)).get() : null;
  const customer = order.customerId ? t.select().from(schema.customers).where(eq(schema.customers.id, order.customerId)).get() : null;
  const room = t.select().from(schema.roomSessions).where(eq(schema.roomSessions.orderId, order.id)).all();
  const activeRoom = room.find((r) => r.endedAt == null) ?? null;
  return {
    id: order.id,
    dayId: order.dayId,
    no: order.no,
    type: order.type,
    status: order.status,
    tableId: order.tableId,
    tableName: table?.name ?? null,
    customer: customer
      ? { id: customer.id, name: customer.name, phone: customer.phone, balance: customer.balance, stamps: customer.stamps, creditLimit: customer.creditLimit }
      : null,
    waiterId: order.waiterId,
    waiterName: order.waiterId ? (names.get(order.waiterId) ?? null) : null,
    guests: order.guests,
    note: order.note,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    discountType: order.discountType,
    discountValue: order.discountValue,
    discountReason: order.discountReason,
    serviceRate: order.serviceRate,
    total: order.total,
    paid: order.paid,
    totals: order.totals ?? calcFor(order, items),
    billPrintedAt: order.billPrintedAt,
    billPrints: order.billPrints,
    source: order.source,
    extId: order.extId,
    extNo: order.extNo,
    extStage: order.extStage,
    extFulfillment: order.extFulfillment,
    extLabel: order.extLabel,
    extPaid: order.extPaid,
    extTotal: order.extTotal,
    scheduledFor: order.scheduledFor,
    deliveryName: order.deliveryName,
    deliveryPhone: order.deliveryPhone,
    deliveryAddress: order.deliveryAddress,
    deliveryStatus: order.deliveryStatus,
    courierId: order.courierId,
    cancelReason: order.cancelReason,
    items: items.map(itemToDTO),
    payments: pays.map((p) => paymentToDTO(p, names)),
    room: activeRoom ? { id: activeRoom.id, startedAt: activeRoom.startedAt, endedAt: activeRoom.endedAt, hourlyRate: activeRoom.hourlyRate } : null,
    version: order.version,
    updatedAt: order.updatedAt,
  };
}

export function ordersToDTOs(t: Tx | DB, ids: string[]): OrderDTO[] {
  if (!ids.length) return [];
  const rows = t.select().from(schema.orders).where(inArray(schema.orders.id, ids)).all();
  return rows.map((r) => orderToDTO(t, r));
}
