import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { percentOf, tl } from '@shared/money';
import { amountForItems, lineGross } from '@shared/order-calc';
import type { OrderDTO, Size } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { type Actor, can, need, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings } from '../lib/settings';
import { calcFor, orderItems, orderPayments, orderToDTO } from './dto';
import {
  defaultsOf,
  happyHourPercent,
  loadSaleProduct,
  normalizeSize,
  optionsText,
  optionsUnitTotal,
  requiredOf,
  posNameFor,
  resolveOptions,
  sizePrice,
  stationFor,
} from './menu';

type OrderRow = typeof schema.orders.$inferSelect;
type ItemRow = typeof schema.orderItems.$inferSelect;

/** Yanlış giriş penceresi: kalemi ekleyen kişi, hazırlanmaya başlanmadıysa bu süre içinde onaysız iptal eder */
export const VOID_GRACE_MS = 2 * 60_000;

// ─── Ortak yardımcılar ───────────────────────────────────────────────────────

export function getOpenDay(t: Tx | DB) {
  return t.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).orderBy(desc(schema.businessDays.openedAt)).get();
}

export function requireOpenDay(t: Tx | DB) {
  const day = getOpenDay(t);
  if (!day) throw new HttpError(409, 'Gün açılmamış. Kasa ekranından günü açın', 'day_closed');
  return day;
}

export function loadOrder(t: Tx | DB, id: string): OrderRow {
  const o = t.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
  if (!o) throw notFound('Adisyon');
  return o;
}

function loadItem(t: Tx | DB, orderId: string, itemId: string): ItemRow {
  const it = t.select().from(schema.orderItems).where(and(eq(schema.orderItems.id, itemId), eq(schema.orderItems.orderId, orderId))).get();
  if (!it) throw notFound('Kalem');
  return it;
}

function assertOpen(o: OrderRow) {
  if (o.status !== 'acik') throw conflict('Bu adisyon kapalı', 'order_closed');
}

function assertPosOrder(o: OrderRow) {
  if (o.extPaid) throw conflict('Bu sipariş sitede ödendi; tutarı LafPOS\'ta değiştirilemez', 'online_order');
}

/**
 * Sepeti yazarkasada bekleyen adisyonun tutarı ve ödemeleri değişmez: cihazın sonucu geldiğinde ödenen kalemler
 * kayar, aynı kalem iki kez ödenir (inceleme, 26 Eki 2026). Kalem eklemek serbest; cihazdaki sepet aynı kalır.
 */
function assertNoPendingDevice(t: Tx | DB, orderId: string) {
  const pending = t
    .select({ id: schema.fiscalReceipts.id })
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, orderId), inArray(schema.fiscalReceipts.status, ['gonderildi', 'kilitli'])))
    .get();
  if (pending) throw conflict('Bu adisyonun sepeti yazarkasada bekliyor; önce cihazda ödeyin ya da sepeti iptal edin', 'okc_pending');
}

export function assertNoActiveRoom(t: Tx | DB, orderId: string) {
  const active = t
    .select()
    .from(schema.roomSessions)
    .where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt)))
    .get();
  if (active) throw conflict('Önce oda sayacını durdurun', 'room_running');
}

function orderEvents(fx: Effects, o: Pick<OrderRow, 'id' | 'tableId'>, userId: string, kind: string) {
  fx.emit({ topic: 'orders', kind, orderId: o.id, tableId: o.tableId ?? undefined, byUserId: userId });
  fx.emit({ topic: 'tables', kind, orderId: o.id, tableId: o.tableId ?? undefined, byUserId: userId });
}

/** Toplamları yeniden hesaplar ve saklar. Her para değişikliğinden sonra çağrılır. */
export function recalc(t: Tx | DB, orderId: string): OrderRow {
  const o = loadOrder(t, orderId);
  const items = orderItems(t, orderId);
  const totals = calcFor(o, items);
  const paid = orderPayments(t, orderId).reduce((a, p) => a + (p.refundedAt ? 0 : p.amount), 0);
  // İptal, ikram, indirim ya da taşıma ödenmiş tutarın altına indiremez: önce fazla ödeme iptal edilir
  if (paid > totals.total) throw conflict(`Ödenen ${tl(paid)} yeni toplamı (${tl(totals.total)}) aşıyor; önce fazla ödemeyi iptal edin`, 'overpaid');
  t.update(schema.orders)
    .set({ total: totals.total, paid, totals, updatedAt: Date.now(), version: sql`${schema.orders.version} + 1` })
    .where(eq(schema.orders.id, orderId))
    .run();
  return loadOrder(t, orderId);
}

function nextOrderNo(t: Tx | DB, dayId: string): number {
  const row = t
    .update(schema.businessDays)
    .set({ lastOrderNo: sql`${schema.businessDays.lastOrderNo} + 1` })
    .where(eq(schema.businessDays.id, dayId))
    .returning({ no: schema.businessDays.lastOrderNo })
    .get();
  return row.no;
}

function nextBatch(t: Tx | DB, orderId: string): number {
  const row = t
    .select({ b: sql<number>`coalesce(max(${schema.orderItems.batch}), 0)` })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .get();
  return (row?.b ?? 0) + 1;
}

/** Kalemin bir kısmını ayırır: orijinalde `qty - part` kalır, ayrılan parça yeni satır olur (aynı fiş, aynı fiyat). */
function splitItem(t: Tx | DB, it: ItemRow, part: number, patch: Partial<ItemRow>): ItemRow {
  if (part >= it.qty) {
    t.update(schema.orderItems).set(patch).where(eq(schema.orderItems.id, it.id)).run();
    return { ...it, ...patch };
  }
  // Kalem indirimi adetle orantılı bölünür
  const partDiscount = Math.round((it.discount * part) / it.qty);
  t.update(schema.orderItems)
    .set({ qty: it.qty - part, discount: it.discount - partDiscount })
    .where(eq(schema.orderItems.id, it.id))
    .run();
  const copy: ItemRow = { ...it, id: ulid(), qty: part, discount: partDiscount, paidQty: 0, ...patch };
  t.insert(schema.orderItems).values(copy).run();
  return copy;
}

// ─── Adisyon açma ve kalem ekleme ────────────────────────────────────────────

export interface CreateOrderInput {
  type: 'masa' | 'tezgah' | 'gelal' | 'paket';
  tableId?: string | null;
  guests?: number;
  customerId?: string | null;
  note?: string | null;
  /** Masada açık adisyon varken ikinci (ayrı) adisyon aç */
  newCheck?: boolean;
  deliveryName?: string | null;
  deliveryPhone?: string | null;
  deliveryAddress?: string | null;
  scheduledFor?: string | null;
}

export function createOrder(t: Tx, actor: Actor, fx: Effects, input: CreateOrderInput): OrderRow {
  needDirect(actor, 'siparis.al');
  const day = requireOpenDay(t);
  if (input.type === 'masa') {
    if (!input.tableId) throw bad('Masa seçilmeli');
    const table = t.select().from(schema.tables).where(eq(schema.tables.id, input.tableId)).get();
    if (!table || !table.active) throw notFound('Masa');
    if (!input.newCheck) {
      const existing = t
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.tableId, input.tableId), eq(schema.orders.status, 'acik')))
        .orderBy(schema.orders.openedAt)
        .get();
      if (existing) return existing;
    }
  }
  if (input.type === 'paket') needDirect(actor, 'paket.yonet');
  const now = Date.now();
  const settings = getSettings();
  const row: typeof schema.orders.$inferInsert = {
    id: ulid(now),
    dayId: day.id,
    no: nextOrderNo(t, day.id),
    type: input.type,
    status: 'acik',
    tableId: input.type === 'masa' ? input.tableId! : null,
    customerId: input.customerId ?? null,
    waiterId: actor.user.id,
    guests: Math.max(1, Math.min(99, input.guests ?? 1)),
    note: input.note?.trim() || null,
    openedAt: now,
    openedBy: actor.user.id,
    serviceRate: input.type === 'masa' ? settings.serviceRate : 0,
    total: 0,
    paid: 0,
    deliveryName: input.deliveryName?.trim() || null,
    deliveryPhone: input.deliveryPhone?.trim() || null,
    deliveryAddress: input.deliveryAddress?.trim() || null,
    deliveryStatus: input.type === 'paket' || input.type === 'gelal' ? 'hazirlaniyor' : null,
    scheduledFor: input.scheduledFor ?? null,
    updatedAt: now,
  };
  t.insert(schema.orders).values(row).run();
  const created = recalc(t, row.id!);
  orderEvents(fx, created, actor.user.id, 'order.opened');
  return created;
}

export interface AddItemLine {
  productId: string;
  size?: Size;
  qty: number;
  options?: { itemId: string; qty?: number }[];
  note?: string | null;
  /** Elle fiyat (birim, kuruş); siparis.fiyat yetkisi ister */
  priceOverride?: number | null;
}

export function addItems(t: Tx, actor: Actor, fx: Effects, orderId: string, lines: AddItemLine[]): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  if (!lines.length) throw bad('Eklenecek ürün yok');
  const now = Date.now();
  const batch = nextBatch(t, orderId);
  const stations = new Set<string>();
  const soldOut: string[] = [];

  for (const line of lines) {
    const qty = Math.trunc(line.qty);
    if (qty < 1 || qty > 99) throw bad('Adet 1 ile 99 arasında olmalı');
    const sp = loadSaleProduct(t, line.productId);
    const p = sp.product;
    if (!p.active) throw conflict(`${p.name} tükendi`, 'sold_out');
    const size = normalizeSize(p, line.size);
    const base = sizePrice(p, size);
    const opts = resolveOptions(sp, line.options ?? []);
    let unit = base + optionsUnitTotal(opts);
    let happy = false;

    if (line.priceOverride != null) {
      const approverId = need(actor, 'siparis.fiyat', 'Fiyat değiştirmek yetkili onayı gerektirir');
      const override = Math.trunc(line.priceOverride);
      if (override < 0) throw bad('Fiyat negatif olamaz');
      if (override !== unit) {
        fx.audit(t, {
          userId: actor.user.id,
          approverId,
          action: 'item.price_override',
          severity: override < unit ? 'uyari' : 'info',
          orderId,
          amount: override - unit,
          message: `${actor.user.name} ${p.name} fiyatını ${tl(unit)} yerine ${tl(override)} girdi (#${o.no})`,
        });
      }
      unit = override;
    } else {
      const pct = happyHourPercent(t, p, now);
      if (pct > 0) {
        unit -= percentOf(unit, pct);
        happy = true;
      }
    }

    if (p.portionsLeft != null) {
      if (p.portionsLeft < qty) throw conflict(`${p.name}: son ${p.portionsLeft} porsiyon kaldı`, 'portions');
      const left = p.portionsLeft - qty;
      t.update(schema.products)
        .set({ portionsLeft: left, active: left > 0, updatedAt: now })
        .where(eq(schema.products.id, p.id))
        .run();
      if (left === 0) soldOut.push(p.id);
    }

    const stationId = stationFor(p, sp.category);
    if (stationId) stations.add(stationId);
    t.insert(schema.orderItems)
      .values({
        id: ulid(now),
        orderId,
        productId: p.id,
        name: p.shortName?.trim() || p.name,
        size,
        options: opts,
        optionsText: optionsText(opts, defaultsOf(sp), requiredOf(sp)),
        qty,
        unitPrice: unit,
        basePrice: base,
        kdvRate: p.kdvRate,
        happyHour: happy,
        note: line.note?.trim().slice(0, 200) || null,
        stationId,
        status: stationId ? 'yeni' : 'servis',
        batch,
        sentAt: now,
        servedAt: stationId ? null : now,
        isService: p.isService,
        extProductId: p.extSource === 'laffogato' ? p.extId : null,
        posName: posNameFor(p, size),
        createdBy: actor.user.id,
        createdAt: now,
      })
      .run();
  }

  const updated = recalc(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.items_added');
  for (const s of stations) fx.emit({ topic: 'kitchen', kind: 'ticket.new', orderId, stationId: s, byUserId: actor.user.id });
  if (soldOut.length) {
    fx.emit({ topic: 'menu', kind: 'product.sold_out', byUserId: actor.user.id });
    for (const id of soldOut) fx.emit({ topic: 'sync', kind: 'availability.push', message: id });
  }
  return updated;
}

// ─── Kalem işlemleri: iptal, ikram, indirim ──────────────────────────────────

export function voidItem(t: Tx, actor: Actor, fx: Effects, orderId: string, input: { itemId: string; qty?: number; reason: string }): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  const it = loadItem(t, orderId, input.itemId);
  if (it.voided) throw conflict('Kalem zaten iptal edilmiş');
  const reason = input.reason.trim();
  if (!reason) throw bad('İptal nedeni yazılmalı', 'reason_required');
  const unpaid = it.qty - it.paidQty;
  const qty = Math.max(1, Math.min(input.qty ?? unpaid, it.qty));
  if (qty > unpaid) throw conflict('Ödenmiş kalem iptal edilemez; önce ödemeyi iptal edin', 'item_paid');

  const now = Date.now();
  const fresh = it.status === 'yeni' && !it.startedAt && it.createdBy === actor.user.id && now - it.sentAt < VOID_GRACE_MS;
  const approverId = fresh ? null : need(actor, 'siparis.iptal', 'Gönderilmiş kalemi iptal etmek yetkili onayı gerektirir');
  const afterSend = !fresh && it.status !== 'yeni';
  const value = qty * it.unitPrice;

  splitItem(t, it, qty, {
    voided: true,
    voidReason: reason,
    voidBy: actor.user.id,
    voidApprovedBy: approverId,
    voidedAt: now,
    voidAfterSend: afterSend,
  });
  const updated = recalc(t, orderId);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'item.void',
    severity: fresh ? 'info' : o.billPrintedAt ? 'alarm' : 'uyari',
    orderId,
    entity: 'order_item',
    entityId: it.id,
    amount: value,
    message: `${actor.user.name} #${o.no} adisyonda ${qty}× ${it.name} iptal etti (${tl(value)}, ${reason})${o.billPrintedAt ? ', hesap yazdırıldıktan sonra' : ''}`,
    data: { afterSend, fresh },
  });
  orderEvents(fx, updated, actor.user.id, 'item.voided');
  if (it.stationId) fx.emit({ topic: 'kitchen', kind: 'ticket.void', orderId, stationId: it.stationId, byUserId: actor.user.id });
  return updated;
}

export function compItem(t: Tx, actor: Actor, fx: Effects, orderId: string, input: { itemId: string; qty?: number; reason: string; undo?: boolean }): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  const it = loadItem(t, orderId, input.itemId);
  if (it.voided) throw conflict('İptal edilmiş kalem ikram edilemez');
  const approverId = need(actor, 'siparis.ikram', 'İkram yetkili onayı gerektirir');

  if (input.undo) {
    if (!it.complimentary) throw conflict('Kalem ikram değil');
    t.update(schema.orderItems).set({ complimentary: false, compReason: null, compBy: null }).where(eq(schema.orderItems.id, it.id)).run();
    const updated = recalc(t, orderId);
    fx.audit(t, { userId: actor.user.id, approverId, action: 'item.uncomp', orderId, entityId: it.id, message: `${actor.user.name} #${o.no} adisyonda ${it.name} ikramını geri aldı` });
    orderEvents(fx, updated, actor.user.id, 'item.uncomped');
    return updated;
  }

  if (it.complimentary) throw conflict('Kalem zaten ikram');
  const reason = input.reason.trim();
  if (!reason) throw bad('İkram nedeni yazılmalı', 'reason_required');
  const unpaid = it.qty - it.paidQty;
  const qty = Math.max(1, Math.min(input.qty ?? unpaid, it.qty));
  if (qty > unpaid) throw conflict('Ödenmiş kalem ikram edilemez', 'item_paid');
  const value = qty * it.unitPrice;
  splitItem(t, it, qty, { complimentary: true, compReason: reason, compBy: actor.user.id, discount: 0 });
  const updated = recalc(t, orderId);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'item.comp',
    severity: 'uyari',
    orderId,
    entity: 'order_item',
    entityId: it.id,
    amount: value,
    message: `${actor.user.name} #${o.no} adisyonda ${qty}× ${it.name} ikram etti (${tl(value)}, ${reason})`,
  });
  orderEvents(fx, updated, actor.user.id, 'item.comped');
  return updated;
}

function discountApproval(actor: Actor, pct: number): string | null {
  const approverId = need(actor, 'siparis.indirim', 'İndirim yetkili onayı gerektirir');
  if (!approverId && pct > actor.user.maxDiscountPct) {
    // Kullanıcının indirim yetkisi var ama sınırı aşıyor: üst sınırı yeten bir yetkili onaylamalı
    if (!actor.approver) {
      throw new HttpError(403, `İndirim sınırınız %${actor.user.maxDiscountPct}; daha fazlası yetkili onayı ister`, 'approval_required', { permission: 'siparis.indirim' });
    }
    if (!can(actor.approver, 'siparis.indirim') || pct > actor.approver.maxDiscountPct) {
      throw new HttpError(403, `${actor.approver.name} bu indirimi onaylayamaz`, 'approval_forbidden');
    }
    return actor.approver.id;
  }
  if (approverId && actor.approver && pct > actor.approver.maxDiscountPct) {
    throw new HttpError(403, `${actor.approver.name} en çok %${actor.approver.maxDiscountPct} indirim onaylayabilir`, 'approval_forbidden');
  }
  return approverId;
}

export function setItemDiscount(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: { itemId: string; type: 'percent' | 'amount'; value: number; reason: string },
): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  const it = loadItem(t, orderId, input.itemId);
  if (it.voided || it.complimentary) throw conflict('İptal ya da ikram kalemine indirim yapılamaz');
  if (it.paidQty > 0) throw conflict('Ödemesi alınmış kaleme indirim yapılamaz', 'item_paid');
  const gross = lineGross(it);
  const amount = input.type === 'percent' ? percentOf(gross, Math.min(100, Math.max(0, input.value))) : Math.min(gross, Math.max(0, Math.trunc(input.value)));
  const pct = gross > 0 ? (amount * 100) / gross : 0;
  const reason = input.reason.trim();
  if (amount > 0 && !reason) throw bad('İndirim nedeni seçilmeli', 'reason_required');
  const approverId = amount > 0 ? discountApproval(actor, pct) : null;
  t.update(schema.orderItems)
    .set({ discount: amount, discountReason: amount > 0 ? reason : null })
    .where(eq(schema.orderItems.id, it.id))
    .run();
  const updated = recalc(t, orderId);
  if (amount > 0) {
    fx.audit(t, {
      userId: actor.user.id,
      approverId,
      action: 'item.discount',
      severity: pct >= getSettings().alertDiscountPct ? 'uyari' : 'info',
      orderId,
      entityId: it.id,
      amount,
      message: `${actor.user.name} #${o.no} adisyonda ${it.name} için ${tl(amount)} indirim yaptı (%${Math.round(pct)}, ${reason})`,
    });
  }
  orderEvents(fx, updated, actor.user.id, 'item.discount');
  return updated;
}

export function setOrderDiscount(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: { type: 'percent' | 'amount'; value: number; reason: string } | null,
): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  if (!input || input.value <= 0) {
    t.update(schema.orders).set({ discountType: null, discountValue: null, discountReason: null, discountBy: null }).where(eq(schema.orders.id, orderId)).run();
    const updated = recalc(t, orderId);
    if (updated.paid > updated.total) throw conflict('Alınan ödeme yeni tutarı aşıyor');
    orderEvents(fx, updated, actor.user.id, 'order.discount');
    return updated;
  }
  const reason = input.reason.trim();
  if (!reason) throw bad('İndirim nedeni seçilmeli', 'reason_required');
  const value = input.type === 'percent' ? Math.min(100, Math.max(0, Math.round(input.value))) : Math.max(0, Math.trunc(input.value));
  const before = calcFor({ ...o, discountType: null, discountValue: null }, orderItems(t, orderId));
  const subtotal = before.gross - before.lineDiscounts;
  const amount = input.type === 'percent' ? percentOf(subtotal, value) : Math.min(subtotal, value);
  const pct = subtotal > 0 ? (amount * 100) / subtotal : 0;
  const approverId = discountApproval(actor, pct);
  t.update(schema.orders)
    .set({ discountType: input.type, discountValue: value, discountReason: reason, discountBy: approverId ?? actor.user.id })
    .where(eq(schema.orders.id, orderId))
    .run();
  const updated = recalc(t, orderId);
  if (updated.paid > updated.total) throw conflict('Alınan ödeme indirimli tutarı aşıyor; önce ödemeyi iptal edin');
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.discount',
    severity: pct >= getSettings().alertDiscountPct ? 'uyari' : 'info',
    orderId,
    amount,
    message: `${actor.user.name} #${o.no} adisyona ${tl(amount)} indirim yaptı (%${Math.round(pct)}, ${reason})`,
  });
  orderEvents(fx, updated, actor.user.id, 'order.discount');
  return updated;
}

// ─── Masa işlemleri ──────────────────────────────────────────────────────────

export function updateOrder(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: { guests?: number; note?: string | null; waiterId?: string; customerId?: string | null },
): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  const patch: Partial<OrderRow> = { updatedAt: Date.now() };
  if (input.guests != null) patch.guests = Math.max(1, Math.min(99, Math.trunc(input.guests)));
  if (input.note !== undefined) patch.note = input.note?.trim() || null;
  if (input.customerId !== undefined) {
    if (input.customerId) {
      const c = t.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).get();
      if (!c) throw notFound('Müşteri');
    }
    patch.customerId = input.customerId;
  }
  if (input.waiterId && input.waiterId !== o.waiterId) {
    need(actor, 'masa.islem');
    const w = t.select().from(schema.users).where(eq(schema.users.id, input.waiterId)).get();
    if (!w || !w.active) throw notFound('Personel');
    patch.waiterId = w.id;
    fx.audit(t, { userId: actor.user.id, action: 'order.waiter', orderId, message: `#${o.no} adisyonun garsonu ${w.name} oldu` });
  }
  t.update(schema.orders).set(patch).where(eq(schema.orders.id, orderId)).run();
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.updated');
  return updated;
}

export function moveOrder(t: Tx, actor: Actor, fx: Effects, orderId: string, tableId: string): OrderRow {
  const approverId = need(actor, 'masa.islem');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  const table = t.select().from(schema.tables).where(eq(schema.tables.id, tableId)).get();
  if (!table || !table.active) throw notFound('Masa');
  if (o.tableId === tableId) return o;
  const busy = t.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tableId, tableId), eq(schema.orders.status, 'acik'))).get();
  if (busy) throw conflict(`${table.name} dolu. Birleştirmek için "Birleştir"i kullanın`, 'table_busy');
  const fromTable = o.tableId;
  t.update(schema.orders)
    .set({ tableId, type: 'masa', updatedAt: Date.now() })
    .where(eq(schema.orders.id, orderId))
    .run();
  t.update(schema.roomSessions).set({ tableId }).where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt))).run();
  fx.audit(t, { userId: actor.user.id, approverId, action: 'order.move', orderId, message: `#${o.no} adisyon ${table.name} masasına taşındı` });
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.moved');
  if (fromTable) fx.emit({ topic: 'tables', kind: 'order.moved', tableId: fromTable, byUserId: actor.user.id });
  return updated;
}

export function mergeOrders(t: Tx, actor: Actor, fx: Effects, targetId: string, sourceId: string): OrderRow {
  const approverId = need(actor, 'masa.islem');
  if (targetId === sourceId) throw bad('Aynı adisyon birleştirilemez');
  const target = loadOrder(t, targetId);
  const source = loadOrder(t, sourceId);
  assertOpen(target);
  assertOpen(source);
  assertPosOrder(target);
  assertPosOrder(source);
  assertNoPendingDevice(t, targetId);
  assertNoPendingDevice(t, sourceId);
  t.update(schema.orderItems).set({ orderId: targetId }).where(eq(schema.orderItems.orderId, sourceId)).run();
  t.update(schema.payments).set({ orderId: targetId }).where(eq(schema.payments.orderId, sourceId)).run();
  t.update(schema.roomSessions).set({ orderId: targetId }).where(eq(schema.roomSessions.orderId, sourceId)).run();
  t.update(schema.orders)
    .set({ status: 'birlesti', mergedInto: targetId, closedAt: Date.now(), closedBy: actor.user.id, updatedAt: Date.now() })
    .where(eq(schema.orders.id, sourceId))
    .run();
  t.update(schema.orders)
    .set({ guests: target.guests + source.guests, customerId: target.customerId ?? source.customerId })
    .where(eq(schema.orders.id, targetId))
    .run();
  recalc(t, sourceId);
  const updated = recalc(t, targetId);
  fx.audit(t, { userId: actor.user.id, approverId, action: 'order.merge', orderId: targetId, message: `#${source.no} adisyon #${target.no} ile birleştirildi` });
  orderEvents(fx, updated, actor.user.id, 'order.merged');
  orderEvents(fx, source, actor.user.id, 'order.merged');
  return updated;
}

/** Seçilen kalemleri (adetleriyle) başka masaya ya da adisyona taşır: hesap bölme. */
export function transferItems(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: { items: { itemId: string; qty: number }[]; tableId?: string | null; targetOrderId?: string | null },
): { source: OrderRow; target: OrderRow } {
  const approverId = need(actor, 'masa.islem');
  const source = loadOrder(t, orderId);
  assertOpen(source);
  assertPosOrder(source);
  assertNoPendingDevice(t, orderId);
  if (!input.items.length) throw bad('Taşınacak kalem seçilmedi');

  let target: OrderRow;
  if (input.targetOrderId) {
    target = loadOrder(t, input.targetOrderId);
    assertOpen(target);
    assertPosOrder(target);
  } else {
    const tableId = input.tableId ?? source.tableId;
    const existing =
      input.tableId && input.tableId !== source.tableId
        ? // Sitede ödenmiş QR siparişine kalem taşınmaz (tahsil edilemez, ciroya girmez): yalnız kasa adisyonu
          t
            .select()
            .from(schema.orders)
            .where(and(eq(schema.orders.tableId, input.tableId), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos'), eq(schema.orders.extPaid, false)))
            .get()
        : undefined;
    target =
      existing ??
      createOrder(t, actor, fx, {
        type: tableId ? 'masa' : source.type === 'masa' ? 'tezgah' : (source.type as 'tezgah' | 'gelal' | 'paket'),
        tableId,
        guests: 1,
        newCheck: true,
      });
  }
  if (target.id === source.id) throw bad('Kaynak ve hedef aynı');

  for (const sel of input.items) {
    const it = loadItem(t, orderId, sel.itemId);
    if (it.voided) continue;
    const unpaid = it.qty - it.paidQty;
    const qty = Math.min(Math.trunc(sel.qty), unpaid);
    if (qty <= 0) throw conflict(`${it.name} ödenmiş; taşınamaz`, 'item_paid');
    if (qty >= it.qty) t.update(schema.orderItems).set({ orderId: target.id }).where(eq(schema.orderItems.id, it.id)).run();
    else splitItem(t, it, qty, { orderId: target.id });
  }

  const src = recalc(t, orderId);
  const dst = recalc(t, target.id);
  const remaining = orderItems(t, orderId).filter((i) => !i.voided);
  const hasPayments = orderPayments(t, orderId).some((p) => !p.refundedAt);
  if (!remaining.length && !hasPayments) {
    t.update(schema.orders)
      .set({ status: 'birlesti', mergedInto: target.id, closedAt: Date.now(), closedBy: actor.user.id })
      .where(eq(schema.orders.id, orderId))
      .run();
  }
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.transfer',
    orderId,
    message: `#${source.no} adisyondan ${input.items.length} kalem #${dst.no} adisyona taşındı`,
  });
  orderEvents(fx, src, actor.user.id, 'order.items_moved');
  orderEvents(fx, dst, actor.user.id, 'order.items_moved');
  return { source: loadOrder(t, orderId), target: dst };
}

export function printBill(t: Tx, actor: Actor, fx: Effects, orderId: string): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  const now = Date.now();
  t.update(schema.orders)
    .set({ billPrintedAt: now, billPrints: o.billPrints + 1, updatedAt: now })
    .where(eq(schema.orders.id, orderId))
    .run();
  fx.audit(t, {
    userId: actor.user.id,
    action: 'order.bill',
    orderId,
    amount: o.total,
    message: `#${o.no} hesap ${o.billPrints > 0 ? `${o.billPrints + 1}. kez ` : ''}yazdırıldı (${tl(o.total)})`,
  });
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.bill');
  return updated;
}

// ─── Ödeme ───────────────────────────────────────────────────────────────────

export interface PaymentInput {
  methodId: string;
  amount: number;
  tip?: number;
  given?: number | null;
  items?: { itemId: string; qty: number }[] | null;
  customerId?: string | null;
  note?: string | null;
}

/** Aynı kalem birden çok kez seçildiyse adetleri birleştirir (kalem bazlı ödeme ve cihaz sepeti) */
export function mergeSelection(list: { itemId: string; qty: number }[]): { itemId: string; qty: number }[] {
  const merged = new Map<string, number>();
  for (const s of list) merged.set(s.itemId, (merged.get(s.itemId) ?? 0) + Math.trunc(s.qty));
  return [...merged].filter(([, qty]) => qty > 0).map(([itemId, qty]) => ({ itemId, qty }));
}

/** Adisyonun damga sayılan adedi (ayarlardaki damga kategorileri, iptal ve ikram hariç) */
function stampQtyOf(t: Tx, orderId: string): number {
  const settings = getSettings();
  if (!settings.stampCategoryKeys.length) return 0;
  const items = orderItems(t, orderId).filter((i) => !i.voided && !i.complimentary);
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
  if (!productIds.length) return 0;
  const cats = t
    .select({ id: schema.products.id, key: schema.categories.extKey })
    .from(schema.products)
    .innerJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(inArray(schema.products.id, productIds))
    .all();
  const stampProducts = new Set(cats.filter((c) => c.key && settings.stampCategoryKeys.includes(c.key)).map((c) => c.id));
  return items.filter((i) => i.productId && stampProducts.has(i.productId)).reduce((a, i) => a + i.qty, 0);
}

/** Kapanışta müşteriye yazılan ziyaret, harcama ve damgayı geri alır (yeniden açma, ödeme ya da fiş iptali) */
function uncreditCustomer(t: Tx, o: OrderRow) {
  if (!o.customerId || o.status !== 'kapali') return;
  const stampQty = stampQtyOf(t, o.id);
  t.update(schema.customers)
    .set({
      visits: sql`max(0, ${schema.customers.visits} - 1)`,
      totalSpent: sql`max(0, ${schema.customers.totalSpent} - ${o.total})`,
      stamps: sql`max(0, ${schema.customers.stamps} - ${stampQty})`,
    })
    .where(eq(schema.customers.id, o.customerId))
    .run();
}

export function closeOrderRow(t: Tx, o: OrderRow, userId: string) {
  const now = Date.now();
  t.update(schema.orders).set({ status: 'kapali', closedAt: now, closedBy: userId, updatedAt: now }).where(eq(schema.orders.id, o.id)).run();
  // Masada bekleyen (istasyonsuz) kalemler servis edilmiş sayılır
  if (o.customerId) {
    const stampQty = stampQtyOf(t, o.id);
    t.update(schema.customers)
      .set({
        visits: sql`${schema.customers.visits} + 1`,
        totalSpent: sql`${schema.customers.totalSpent} + ${o.total}`,
        stamps: sql`${schema.customers.stamps} + ${stampQty}`,
        lastVisitAt: now,
      })
      .where(eq(schema.customers.id, o.customerId))
      .run();
  }
}

export function addPayment(t: Tx, actor: Actor, fx: Effects, orderId: string, input: PaymentInput): { order: OrderRow; closed: boolean; change: number } {
  needDirect(actor, 'odeme.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoActiveRoom(t, orderId);
  assertNoPendingDevice(t, orderId);
  const day = requireOpenDay(t);
  const method = t.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, input.methodId)).get();
  if (!method || !method.active) throw bad('Ödeme türü geçersiz');

  const items = orderItems(t, orderId);
  const totals = calcFor(o, items);
  const paidSoFar = orderPayments(t, orderId).reduce((a, p) => a + (p.refundedAt ? 0 : p.amount), 0);
  const remaining = totals.total - paidSoFar;
  if (remaining <= 0) throw conflict('Bu adisyonun ödenecek tutarı kalmadı', 'nothing_due');

  let amount = Math.trunc(input.amount);
  let selection: { itemId: string; qty: number }[] | null = null;
  // Aynı kalem iki kez gönderilirse adetler birleşir: iki kez ücret alınmaz
  const wanted = mergeSelection(input.items ?? []);
  if (wanted.length) {
    const lines = items.map((i) => ({ id: i.id, qty: i.qty, paidQty: i.paidQty }));
    const sel = wanted.map((s) => ({ lineId: s.itemId, qty: s.qty }));
    const expected = amountForItems(totals, lines, sel);
    if (expected <= 0) throw bad('Seçilen kalemler ödenmiş ya da ücretsiz');
    amount = Math.min(expected, remaining);
    selection = [];
    for (const s of wanted) {
      const it = items.find((i) => i.id === s.itemId);
      if (!it) throw notFound('Kalem');
      const qty = Math.min(s.qty, it.qty - it.paidQty);
      if (qty <= 0) continue;
      t.update(schema.orderItems).set({ paidQty: it.paidQty + qty }).where(eq(schema.orderItems.id, it.id)).run();
      selection.push({ itemId: it.id, qty });
    }
  }
  if (amount <= 0) throw bad('Tutar sıfırdan büyük olmalı');
  if (amount > remaining) throw bad(`En fazla ${tl(remaining)} alınabilir`, 'overpay');
  const tip = Math.max(0, Math.trunc(input.tip ?? 0));

  let given: number | null = null;
  let change = 0;
  if (method.kind === 'nakit' && input.given != null) {
    given = Math.trunc(input.given);
    if (given < amount + tip) throw bad('Verilen para tutardan az');
    change = given - amount - tip;
  }

  let customerId: string | null = null;
  const paymentId = ulid();
  if (method.kind === 'cari') {
    need(actor, 'cari.yonet');
    customerId = input.customerId ?? o.customerId;
    if (!customerId) throw bad('Açık hesap için müşteri seçin', 'customer_required');
    const cust = t.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get();
    if (!cust) throw notFound('Müşteri');
    if (cust.creditLimit != null && cust.balance + amount > cust.creditLimit) {
      throw conflict(`${cust.name} açık hesap sınırını aşıyor (sınır ${tl(cust.creditLimit)}, bakiye ${tl(cust.balance)})`, 'credit_limit');
    }
    t.update(schema.customers).set({ balance: cust.balance + amount }).where(eq(schema.customers.id, customerId)).run();
    t.insert(schema.customerLedger)
      .values({ id: ulid(), customerId, kind: 'borc', amount, orderId, paymentId, methodId: method.id, dayId: day.id, note: `#${o.no} adisyon`, userId: actor.user.id, createdAt: Date.now() })
      .run();
    if (!o.customerId) t.update(schema.orders).set({ customerId }).where(eq(schema.orders.id, orderId)).run();
  }

  t.insert(schema.payments)
    .values({
      id: paymentId,
      orderId,
      dayId: day.id,
      methodId: method.id,
      methodName: method.name,
      zField: method.zField,
      amount,
      tip,
      given,
      change: given != null ? change : null,
      items: selection,
      customerId,
      note: input.note?.trim() || null,
      userId: actor.user.id,
      createdAt: Date.now(),
    })
    .run();

  let updated = recalc(t, orderId);
  let closed = false;
  if (updated.total - updated.paid <= 0) {
    closeOrderRow(t, updated, actor.user.id);
    updated = loadOrder(t, orderId);
    closed = true;
  }
  orderEvents(fx, updated, actor.user.id, closed ? 'order.closed' : 'payment.added');
  fx.emit({ topic: 'cash', kind: 'payment.added', orderId, byUserId: actor.user.id });
  if (customerId) fx.emit({ topic: 'customers', kind: 'ledger', byUserId: actor.user.id });
  return { order: updated, closed, change };
}

/** Ödenecek tutarı sıfır olan (tamamı ikram/iptal) adisyonu kapatır. */
export function closeOrder(t: Tx, actor: Actor, fx: Effects, orderId: string): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = recalc(t, orderId);
  assertOpen(o);
  assertNoActiveRoom(t, orderId);
  if (o.total - o.paid > 0) throw conflict(`Ödenecek ${tl(o.total - o.paid)} var`, 'due');
  closeOrderRow(t, o, actor.user.id);
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.closed');
  return updated;
}

export function refundPayment(t: Tx, actor: Actor, fx: Effects, orderId: string, input: { paymentId: string; reason: string }): OrderRow {
  const approverId = need(actor, 'odeme.iade', 'Ödeme iptali yetkili onayı gerektirir');
  const o = loadOrder(t, orderId);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  const p = t.select().from(schema.payments).where(and(eq(schema.payments.id, input.paymentId), eq(schema.payments.orderId, orderId))).get();
  if (!p) throw notFound('Ödeme');
  if (p.refundedAt) throw conflict('Ödeme zaten iptal edilmiş');
  const day = requireOpenDay(t);
  if (p.dayId !== day.id) throw conflict('Kapanmış bir güne ait ödeme iptal edilemez', 'day_closed');
  const reason = input.reason.trim();
  if (!reason) throw bad('İptal nedeni yazılmalı', 'reason_required');
  const now = Date.now();
  t.update(schema.payments).set({ refundedAt: now, refundedBy: actor.user.id, refundReason: reason }).where(eq(schema.payments.id, p.id)).run();
  for (const s of p.items ?? []) {
    const it = t.select().from(schema.orderItems).where(eq(schema.orderItems.id, s.itemId)).get();
    if (it) t.update(schema.orderItems).set({ paidQty: Math.max(0, it.paidQty - s.qty) }).where(eq(schema.orderItems.id, it.id)).run();
  }
  if (p.customerId) {
    const ledger = t
      .select()
      .from(schema.customerLedger)
      .where(and(eq(schema.customerLedger.paymentId, p.id), eq(schema.customerLedger.kind, 'borc')))
      .get();
    if (ledger) {
      t.update(schema.customers).set({ balance: sql`${schema.customers.balance} - ${p.amount}` }).where(eq(schema.customers.id, p.customerId)).run();
      t.insert(schema.customerLedger)
        .values({ id: ulid(), customerId: p.customerId, kind: 'duzeltme', amount: -p.amount, orderId, paymentId: p.id, dayId: day.id, note: `Ödeme iptali: ${reason}`, userId: actor.user.id, createdAt: now })
        .run();
    }
  }
  const wasClosed = o.status === 'kapali';
  if (wasClosed) {
    uncreditCustomer(t, o);
    t.update(schema.orders).set({ status: 'acik', closedAt: null, closedBy: null }).where(eq(schema.orders.id, orderId)).run();
  }
  const updated = recalc(t, orderId);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'payment.refund',
    severity: wasClosed ? 'alarm' : 'uyari',
    orderId,
    entityId: p.id,
    amount: p.amount,
    message: `${actor.user.name} #${o.no} adisyonda ${tl(p.amount)} ${p.methodName} ödemesini iptal etti (${reason})${wasClosed ? '; adisyon yeniden açıldı' : ''}`,
  });
  orderEvents(fx, updated, actor.user.id, 'payment.refunded');
  fx.emit({ topic: 'cash', kind: 'payment.refunded', orderId, byUserId: actor.user.id });
  return updated;
}

export function reopenOrder(t: Tx, actor: Actor, fx: Effects, orderId: string, reason: string): OrderRow {
  const approverId = need(actor, 'odeme.iade', 'Kapanmış adisyonu açmak yetkili onayı gerektirir');
  const o = loadOrder(t, orderId);
  if (o.status !== 'kapali') throw conflict('Yalnız kapanmış adisyon yeniden açılır');
  assertPosOrder(o);
  const day = requireOpenDay(t);
  if (o.dayId !== day.id) throw conflict('Önceki günün adisyonu açılamaz', 'day_closed');
  if (!reason.trim()) throw bad('Neden yazılmalı', 'reason_required');
  // Kapanışta verilen ziyaret, harcama ve damga geri alınır: aç-kapa ile damga biriktirilmesin
  uncreditCustomer(t, o);
  t.update(schema.orders).set({ status: 'acik', closedAt: null, closedBy: null, updatedAt: Date.now() }).where(eq(schema.orders.id, orderId)).run();
  const updated = recalc(t, orderId);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.reopen',
    severity: 'alarm',
    orderId,
    amount: o.total,
    message: `${actor.user.name} kapanmış #${o.no} adisyonu yeniden açtı (${tl(o.total)}, ${reason.trim()})`,
  });
  orderEvents(fx, updated, actor.user.id, 'order.reopened');
  return updated;
}

export function cancelOrder(t: Tx, actor: Actor, fx: Effects, orderId: string, reason: string): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  if (orderPayments(t, orderId).some((p) => !p.refundedAt)) throw conflict('Önce alınan ödemeleri iptal edin', 'has_payments');
  const live = orderItems(t, orderId).filter((i) => !i.voided);
  const now = Date.now();
  const allFresh = live.every((i) => i.status === 'yeni' && !i.startedAt && i.createdBy === actor.user.id && now - i.sentAt < VOID_GRACE_MS);
  const approverId = live.length && !allFresh ? need(actor, 'siparis.iptal', 'Adisyon iptali yetkili onayı gerektirir') : null;
  if (live.length && !reason.trim()) throw bad('İptal nedeni yazılmalı', 'reason_required');
  for (const it of live) {
    t.update(schema.orderItems)
      .set({ voided: true, voidReason: reason.trim() || 'Adisyon iptali', voidBy: actor.user.id, voidApprovedBy: approverId, voidedAt: now, voidAfterSend: !allFresh && it.status !== 'yeni' })
      .where(eq(schema.orderItems.id, it.id))
      .run();
  }
  t.update(schema.orders)
    .set({ status: 'iptal', cancelReason: reason.trim() || null, closedAt: now, closedBy: actor.user.id })
    .where(eq(schema.orders.id, orderId))
    .run();
  const updated = recalc(t, orderId);
  const value = live.reduce((a, i) => a + lineGross(i), 0);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.cancel',
    severity: !live.length || allFresh ? 'info' : o.billPrintedAt ? 'alarm' : 'uyari',
    orderId,
    amount: value,
    message: live.length ? `${actor.user.name} #${o.no} adisyonu iptal etti (${tl(value)}, ${reason.trim()})` : `#${o.no} boş adisyon kapatıldı`,
  });
  orderEvents(fx, updated, actor.user.id, 'order.cancelled');
  for (const s of new Set(live.map((i) => i.stationId).filter(Boolean))) fx.emit({ topic: 'kitchen', kind: 'ticket.void', orderId, stationId: s!, byUserId: actor.user.id });
  return updated;
}

// ─── Bar / mutfak durumları ──────────────────────────────────────────────────

const NEXT: Record<string, 'hazirlaniyor' | 'hazir' | 'servis'> = { yeni: 'hazirlaniyor', hazirlaniyor: 'hazir', hazir: 'servis' };

export function setItemsStatus(
  t: Tx,
  actor: Actor,
  fx: Effects,
  input: { itemIds: string[]; status?: 'hazirlaniyor' | 'hazir' | 'servis' | 'yeni' },
): void {
  if (!can(actor.user, 'mutfak.ekran') && !can(actor.user, 'siparis.al')) needDirect(actor, 'mutfak.ekran');
  if (!input.itemIds.length) return;
  const items = t.select().from(schema.orderItems).where(inArray(schema.orderItems.id, input.itemIds)).all();
  const now = Date.now();
  const orders = new Set<string>();
  const stations = new Set<string>();
  for (const it of items) {
    if (it.voided) continue;
    const status = input.status ?? NEXT[it.status];
    if (!status || status === it.status) continue;
    const patch: Partial<ItemRow> = { status };
    if (status === 'yeni') Object.assign(patch, { startedAt: null, readyAt: null, servedAt: null });
    if (status === 'hazirlaniyor') patch.startedAt = it.startedAt ?? now;
    if (status === 'hazir') Object.assign(patch, { startedAt: it.startedAt ?? now, readyAt: now });
    if (status === 'servis') Object.assign(patch, { startedAt: it.startedAt ?? now, readyAt: it.readyAt ?? now, servedAt: now });
    t.update(schema.orderItems).set(patch).where(eq(schema.orderItems.id, it.id)).run();
    orders.add(it.orderId);
    if (it.stationId) stations.add(it.stationId);
  }
  for (const id of orders) {
    const o = loadOrder(t, id);
    orderEvents(fx, o, actor.user.id, 'item.status');
  }
  for (const s of stations) fx.emit({ topic: 'kitchen', kind: 'ticket.status', stationId: s, byUserId: actor.user.id });
}

export function getOrderDTO(t: Tx | DB, orderId: string): OrderDTO {
  return orderToDTO(t, loadOrder(t, orderId));
}

/**
 * Dışarıdan gelen (yazarkasa POS'ta alınmış) ödemeleri adisyona işler: kalemlerin ödenen adetleri işaretlenir,
 * ödemeler eklenir, tutar tamamlandıysa adisyon kapanır. Ödeme cihazda zaten alındığı için yetki sorulmaz;
 * işlemi başlatan kişinin adına kaydedilir.
 */
export function addExternalPayments(
  t: Tx,
  userId: string,
  fx: Effects,
  orderId: string,
  input: { payments: { methodId: string; amount: number; note?: string | null }[]; items: { itemId: string; qty: number }[] },
): { order: OrderRow; closed: boolean; paymentIds: string[] } {
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik') throw conflict('Adisyon artık açık değil', 'order_closed');
  const day = requireOpenDay(t);
  const items = orderItems(t, orderId);
  const totals = calcFor(o, items);
  const paidSoFar = orderPayments(t, orderId).reduce((a, p) => a + (p.refundedAt ? 0 : p.amount), 0);
  const remaining = totals.total - paidSoFar;
  const sum = input.payments.reduce((a, p) => a + p.amount, 0);
  if (sum > remaining) throw conflict(`Cihazdaki ödeme (${tl(sum)}) kalan tutarı (${tl(remaining)}) aşıyor`, 'overpay');

  const marked: { itemId: string; qty: number }[] = [];
  for (const sel of input.items) {
    const it = items.find((i) => i.id === sel.itemId);
    if (!it) continue;
    const qty = Math.min(sel.qty, it.qty - it.paidQty);
    if (qty <= 0) continue;
    t.update(schema.orderItems).set({ paidQty: it.paidQty + qty }).where(eq(schema.orderItems.id, it.id)).run();
    marked.push({ itemId: it.id, qty });
  }

  const ids: string[] = [];
  const now = Date.now();
  input.payments.forEach((p, idx) => {
    const method = t.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, p.methodId)).get();
    if (!method) throw notFound('Ödeme türü');
    const id = ulid(now);
    let customerId: string | null = null;
    if (method.kind === 'cari' && !o.customerId) {
      // Cihazda açık hesap seçildi ama adisyonda müşteri yok: alacak kaybolmasın, yönetici müşteriyi bağlasın
      fx.audit(t, {
        userId,
        action: 'okc.cari_no_customer',
        severity: 'alarm',
        orderId,
        amount: p.amount,
        message: `#${o.no} adisyon yazarkasada açık hesaba ${tl(p.amount)} kapandı ama adisyonda müşteri yok; müşteriyi bağlayıp cariye işleyin`,
      });
    }
    if (method.kind === 'cari' && o.customerId) {
      customerId = o.customerId;
      const cust = t.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get();
      if (cust?.creditLimit != null && cust.balance + p.amount > cust.creditLimit) {
        fx.audit(t, { userId, action: 'okc.credit_limit', severity: 'alarm', orderId, amount: p.amount, message: `${cust.name} yazarkasada açık hesap sınırını aştı (sınır ${tl(cust.creditLimit)}, bakiye ${tl(cust.balance)})` });
      }
      t.update(schema.customers).set({ balance: sql`${schema.customers.balance} + ${p.amount}` }).where(eq(schema.customers.id, customerId)).run();
      t.insert(schema.customerLedger)
        .values({ id: ulid(now), customerId, kind: 'borc', amount: p.amount, orderId, paymentId: id, methodId: method.id, dayId: day.id, note: `#${o.no} adisyon (yazarkasa)`, userId, createdAt: now })
        .run();
    }
    t.insert(schema.payments)
      .values({
        id,
        orderId,
        dayId: day.id,
        methodId: method.id,
        methodName: method.name,
        zField: method.zField,
        amount: p.amount,
        // Kalem işaretleri ilk ödemede durur: ödeme iptal edilirse adetler geri açılır
        items: idx === 0 && marked.length ? marked : null,
        customerId,
        note: p.note ?? null,
        userId,
        createdAt: now,
      })
      .run();
    ids.push(id);
  });

  let updated = recalc(t, orderId);
  let closed = false;
  if (updated.total - updated.paid <= 0) {
    closeOrderRow(t, updated, userId);
    updated = loadOrder(t, orderId);
    closed = true;
  }
  orderEvents(fx, updated, userId, closed ? 'order.closed' : 'payment.added');
  fx.emit({ topic: 'cash', kind: 'payment.added', orderId, byUserId: userId });
  return { order: updated, closed, paymentIds: ids };
}

/** Yazarkasada fiş iptal edilince LafPOS ödemeleri de iptal edilir ve adisyon yeniden açılır. */
export function refundExternalPayments(t: Tx, userId: string | null, fx: Effects, orderId: string, paymentIds: string[], reason: string) {
  const o = loadOrder(t, orderId);
  const now = Date.now();
  const openDay = getOpenDay(t);
  for (const pid of paymentIds) {
    const p = t.select().from(schema.payments).where(eq(schema.payments.id, pid)).get();
    if (!p || p.refundedAt) continue;
    t.update(schema.payments).set({ refundedAt: now, refundedBy: userId, refundReason: reason }).where(eq(schema.payments.id, pid)).run();
    for (const s of p.items ?? []) {
      const it = t.select().from(schema.orderItems).where(eq(schema.orderItems.id, s.itemId)).get();
      if (it) t.update(schema.orderItems).set({ paidQty: Math.max(0, it.paidQty - s.qty) }).where(eq(schema.orderItems.id, it.id)).run();
    }
    if (p.customerId) {
      t.update(schema.customers).set({ balance: sql`${schema.customers.balance} - ${p.amount}` }).where(eq(schema.customers.id, p.customerId)).run();
      // Normal ödeme iptaliyle aynı: bakiye ile cari ekstresi ayrışmasın
      t.insert(schema.customerLedger)
        .values({ id: ulid(now), customerId: p.customerId, kind: 'duzeltme', amount: -p.amount, orderId, paymentId: p.id, dayId: openDay?.id ?? p.dayId, note: `Yazarkasa fiş iptali: ${reason}`, userId, createdAt: now })
        .run();
    }
  }
  if (o.status === 'kapali') {
    uncreditCustomer(t, o);
    t.update(schema.orders).set({ status: 'acik', closedAt: null, closedBy: null }).where(eq(schema.orders.id, orderId)).run();
  }
  const updated = recalc(t, orderId);
  orderEvents(fx, updated, userId ?? 'sistem', 'payment.refunded');
  fx.emit({ topic: 'cash', kind: 'payment.refunded', orderId });
  return updated;
}

/** Paket / gel-al durum akışı ve kurye ataması */
export function setDelivery(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: { deliveryStatus?: 'hazirlaniyor' | 'hazir' | 'yolda' | 'teslim'; courierId?: string | null },
): OrderRow {
  if (!can(actor.user, 'paket.yonet') && !can(actor.user, 'siparis.al')) needDirect(actor, 'paket.yonet');
  const o = loadOrder(t, orderId);
  if (o.type !== 'paket' && o.type !== 'gelal') throw bad('Yalnız paket ve gel-al siparişlerinde');
  const patch: Partial<OrderRow> = { updatedAt: Date.now() };
  if (input.deliveryStatus) patch.deliveryStatus = input.deliveryStatus;
  if (input.courierId !== undefined) {
    if (input.courierId) {
      const u = t.select().from(schema.users).where(eq(schema.users.id, input.courierId)).get();
      if (!u || !u.active) throw notFound('Kurye');
    }
    patch.courierId = input.courierId;
  }
  t.update(schema.orders).set(patch).where(eq(schema.orders.id, orderId)).run();
  if (input.deliveryStatus === 'teslim') {
    fx.audit(t, { userId: actor.user.id, action: 'delivery.done', orderId, message: `#${o.no} ${o.type === 'paket' ? 'paket teslim edildi' : 'gel-al teslim edildi'}` });
  }
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.delivery');
  fx.emit({ topic: 'delivery', kind: 'delivery.status', orderId, byUserId: actor.user.id });
  return updated;
}
