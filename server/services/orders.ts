import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { normalizeNumarator, numaratorLabel } from '@shared/service-mode';
import { allocate, percentOf, tl } from '@shared/money';
import { discountGrowth, happyHourUnit, itemPayLines, itemsBreakdown, lineGross, type OrderTotals, type PaidItem, splitState } from '@shared/order-calc';
import { staleDayMessage } from '@shared/time';
import { COMP_LABEL, compPermission } from '@shared/comp';
import type { CompKind, OrderDTO, Size } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { type Actor, approverFor, can, need, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings } from '../lib/settings';
import { localStampsOn } from '../sync/laffogato-link';
import { enqueueSiteAvailability, enqueueSiteSoldOut } from '../sync/site-outbox';
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

/**
 * Yeni satış (adisyon açma, kalem ekleme, oda sayacı) yalnız bugünün iş gününe: dünden açık kalan güne yazılan satış
 * lafmaliyet'e dünün tarihiyle gider. Ödeme, iptal ve gün sonu engellenmez; gün kapanınca yeni gün açılır.
 */
export function requireCurrentDay(t: Tx | DB) {
  const day = requireOpenDay(t);
  const stale = staleDayMessage(day);
  if (stale) throw new HttpError(409, stale, 'stale_day');
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

export function assertPosOrder(o: OrderRow) {
  if (o.extPaid) throw conflict('Bu sipariş sitede ödendi; tutarı LafPOS\'ta değiştirilemez', 'online_order');
}

/**
 * Paket platformu siparişinin içeriği platformda belirlenir: ürün eklenmez, başka adisyonla birleşmez, kalem taşınmaz
 * (platformun ödediği tutar değişmesin; server/delivery/service.ts `afterDelivery`)
 */
function assertNotPlatform(o: OrderRow) {
  if (o.platform) throw conflict('Platform siparişinin içeriği platformda belirlenir; ürün eklenmez, birleştirilmez, taşınmaz', 'platform_order');
}

/** Masadaki açık kasa adisyonu koşulu: sitede ödenmiş online (QR) sipariş masada görünür ama masayı tutmaz */
function openCheckOn(tableId: string) {
  return and(eq(schema.orders.tableId, tableId), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos'), eq(schema.orders.extPaid, false));
}

/**
 * Sepeti yazarkasada bekleyen adisyonun tutarı ve ödemeleri değişmez: cihazın sonucu geldiğinde ödenen kalemler
 * kayar, aynı kalem iki kez ödenir (inceleme, 26 Eki 2026). Kalem eklemek serbest; cihazdaki sepet aynı kalır.
 */
export function assertNoPendingDevice(t: Tx | DB, orderId: string) {
  const pending = t
    .select({ id: schema.fiscalReceipts.id })
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, orderId), inArray(schema.fiscalReceipts.status, ['gonderildi', 'kilitli'])))
    .get();
  if (pending) throw conflict('Bu adisyonun sepeti yazarkasada bekliyor; önce cihazda ödeyin ya da sepeti iptal edin', 'okc_pending');
}

/**
 * Cihazda fişi kesilmiş ama LafPOS'a tam işlenememiş (hata, sonucu "ödendi": eksik ödendi ya da işlenemedi)
 * sepetlerdeki kalemler, kalem başına adet. Bu adetler LafPOS'ta ödenmiş sayılmaz ama mali fişe girdi: cihaza
 * yeniden gönderilmez, başka adisyona taşınmaz (aynı kalem ikinci fişe girerdi; inceleme, 27 Eki 2026).
 */
export function fiscalHeldQty(t: Tx | DB, orderId: string): Map<string, number> {
  const held = new Map<string, number>();
  const rows = t
    .select({ items: schema.fiscalReceipts.items, result: schema.fiscalReceipts.result })
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, orderId), eq(schema.fiscalReceipts.status, 'hata')))
    .all();
  for (const r of rows) {
    if ((r.result as { status?: string } | null)?.status !== 'paid') continue;
    for (const l of r.items) held.set(l.itemId, (held.get(l.itemId) ?? 0) + l.qty);
  }
  return held;
}

/** Kalemin cihaza gidebilecek ya da taşınabilecek adedi: ödenmemiş ve belgeli hata fişinde olmayan */
export function freeQty(it: Pick<ItemRow, 'id' | 'qty' | 'paidQty'>, held: Map<string, number>): number {
  return Math.max(0, it.qty - it.paidQty - (held.get(it.id) ?? 0));
}

/**
 * Parasal izi olmayan adisyon: kalem ve ödeme satırı yok, oda sayacı çalışmıyor, yazarkasada sepeti yok.
 * Gün sonu ve otomatik gün sonu bunları kendiliğinden kapatır; tek ölçüt burada (inceleme, 26 Eki 2026 gece).
 */
export function isEmptyOrder(t: Tx | DB, orderId: string): boolean {
  if (orderItems(t, orderId).length || orderPayments(t, orderId).length) return false;
  const room = t.select({ id: schema.roomSessions.id }).from(schema.roomSessions).where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt))).get();
  if (room) return false;
  const basket = t.select({ id: schema.fiscalReceipts.id }).from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.orderId, orderId)).get();
  return !basket;
}

/** Adisyonun çalışan oda sayacı (karaoke): faturalanacak ücrettir, durunca adisyona yazılır */
export function activeRoom(t: Tx | DB, orderId: string) {
  return t
    .select()
    .from(schema.roomSessions)
    .where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt)))
    .get();
}

export function assertNoActiveRoom(t: Tx | DB, orderId: string) {
  if (activeRoom(t, orderId)) throw conflict('Önce oda sayacını durdurun', 'room_running');
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
  /** Tezgâh: bu cihazın son boş tezgâh adisyonu (sessionStorage); boşsa yeniden kullanılır */
  reuse?: string | null;
  deliveryName?: string | null;
  deliveryPhone?: string | null;
  deliveryAddress?: string | null;
  scheduledFor?: string | null;
}

/**
 * `staleOk`: yalnız hesap bölme (kalem taşıma) için. Taşınan kalemler o günün satışıdır, yeni satış değil: dünden açık
 * kalan günde de hesap bölünebilsin, yoksa adisyon kapanmaz ve gün sonu alınamaz. İstemciden gelmez (rota gövdesi değil).
 */
export function createOrder(t: Tx, actor: Actor, fx: Effects, input: CreateOrderInput, opts: { staleOk?: boolean } = {}): OrderRow {
  needDirect(actor, 'siparis.al');
  const day = opts.staleOk ? requireOpenDay(t) : requireCurrentDay(t);
  if (input.type === 'masa') {
    if (!input.tableId) throw bad('Masa seçilmeli');
    const table = t.select().from(schema.tables).where(eq(schema.tables.id, input.tableId)).get();
    if (!table || !table.active) throw notFound('Masa');
    if (!input.newCheck) {
      // Masanın kasa adisyonu: sitede ödenmiş QR siparişi masada dursa da garsonun adisyonu değildir
      // (kalem eklenemez, tahsil edilmez); yalnız o varsa yeni adisyon açılır
      const existing = t.select().from(schema.orders).where(openCheckOn(input.tableId)).orderBy(schema.orders.openedAt).get();
      if (existing) return existing;
    }
  }
  if (input.type === 'tezgah' && input.reuse) {
    // Yalnız bu cihazın kendi boş tezgâh adisyonu yeniden kullanılır (istemci kimliğini verir): aynı PIN'le açık
    // iki kasa aynı adisyonu almasın. İndirimli, bölünmüş, müşterili ya da notlu adisyon yeni satış değildir
    const prev = t.select().from(schema.orders).where(eq(schema.orders.id, input.reuse)).get();
    if (
      prev &&
      prev.status === 'acik' &&
      prev.type === 'tezgah' &&
      prev.source === 'pos' &&
      prev.dayId === day.id &&
      prev.openedBy === actor.user.id &&
      !prev.customerId &&
      !prev.note &&
      !prev.numarator &&
      prev.discountType == null &&
      prev.splitPeople == null &&
      isEmptyOrder(t, prev.id)
    ) {
      return prev;
    }
  }
  if (input.type === 'paket') needDirect(actor, 'paket.yonet');
  if (input.customerId) {
    const c = t.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, input.customerId)).get();
    if (!c) throw notFound('Müşteri');
  }
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

/**
 * `platformPrice`: paket platformundan gelen satırlar (server/delivery). Fiyat platformun: `priceOverride` yetki
 * onayı ve fiyat değişikliği kaydı istemez, happy hour uygulanmaz.
 */
export function addItems(t: Tx, actor: Actor, fx: Effects, orderId: string, lines: AddItemLine[], { platformPrice = false }: { platformPrice?: boolean } = {}): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  if (!platformPrice) assertNotPlatform(o);
  requireCurrentDay(t);
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
    // Platform satırının seçenekleri notta yazar (platformun seçimi); zorunlu seçenek kasada sorulmaz
    const opts = resolveOptions(sp, line.options ?? [], { lenient: platformPrice });
    let unit = base + optionsUnitTotal(opts);
    let happy = false;

    if (line.priceOverride != null && platformPrice) {
      const override = Math.trunc(line.priceOverride);
      if (override < 0) throw bad('Fiyat negatif olamaz');
      unit = override;
    } else if (line.priceOverride != null) {
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
        unit = happyHourUnit(unit, pct);
        happy = true;
      }
    }

    if (p.portionsLeft != null) {
      if (p.portionsLeft < qty) throw conflict(`${p.name}: son ${p.portionsLeft} porsiyon kaldı`, 'portions');
      const left = p.portionsLeft - qty;
      t.update(schema.products)
        .set({ portionsLeft: left, active: left > 0, ...(left > 0 ? {} : { soldOutBy: 'lafpos' as const }), updatedAt: now })
        .where(eq(schema.products.id, p.id))
        .run();
      if (left === 0) {
        soldOut.push(p.id);
        // Siteye bağlı ürün sitede ve uygulamada da tükensin: yazım kalemle aynı işlemde giden kutusuna girer
        enqueueSiteSoldOut(t, p);
      }
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

/** Bar ya da mutfak kaleme dokunmadı: hiçbir şey hazırlanmadı */
const notStarted = (it: ItemRow) => it.status === 'yeni' && !it.startedAt;

/**
 * Hazırlanmaya başlanmamış kalemin iptalinde porsiyon geri döner: ürün hâlâ satılabilir (hazırlanmış kalem fire
 * sayılır, dönmez). Porsiyonu sıfırdan dönen ürün yeniden satışa açılır ve site de güncellenir: yazım iptalle aynı
 * işlemde giden kutusuna girer (bekleyen Tükendi'nin yerini alır), olay dinleyicisi hemen gönderir.
 */
function releasePortions(t: Tx, fx: Effects, userId: string, lines: { productId: string | null; qty: number }[]) {
  const now = Date.now();
  const reopened = new Set<string>();
  for (const l of lines) {
    if (!l.productId) continue;
    const p = t
      .select({ portionsLeft: schema.products.portionsLeft, extSource: schema.products.extSource, extId: schema.products.extId })
      .from(schema.products)
      .where(eq(schema.products.id, l.productId))
      .get();
    if (p?.portionsLeft == null) continue;
    t.update(schema.products)
      .set({ portionsLeft: p.portionsLeft + l.qty, ...(p.portionsLeft === 0 ? { active: true, soldOutBy: null } : {}), updatedAt: now })
      .where(eq(schema.products.id, l.productId))
      .run();
    if (p.portionsLeft === 0) {
      reopened.add(l.productId);
      enqueueSiteAvailability(t, p, true);
    }
  }
  if (reopened.size) {
    fx.emit({ topic: 'menu', kind: 'product.available', byUserId: userId });
    for (const id of reopened) fx.emit({ topic: 'sync', kind: 'availability.push', message: id });
  }
}

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
  const before = calcFor(o, orderItems(t, orderId));

  splitItem(t, it, qty, {
    voided: true,
    voidReason: reason,
    voidBy: actor.user.id,
    voidApprovedBy: approverId,
    voidedAt: now,
    voidAfterSend: afterSend,
  });
  if (notStarted(it)) releasePortions(t, fx, actor.user.id, [{ productId: it.productId, qty }]);
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
  approveDiscountShrink(t, actor, fx, orderId, before, `#${o.no} adisyonda ${qty}× ${it.name} iptal etti`);
  orderEvents(fx, updated, actor.user.id, 'item.voided');
  if (it.stationId) fx.emit({ topic: 'kitchen', kind: 'ticket.void', orderId, stationId: it.stationId, byUserId: actor.user.id });
  return updated;
}

/**
 * Kalemi ciro dışı yazar: müşteriye ikram (`siparis.ikram`) ya da zayi (döküldü, yanlış hazırlandı; `siparis.odenmez`).
 * Geri alma yazanın yetkisini ister: ödenmez ya da zayi kaydını yalnız ikram yetkisi olan geri alamaz.
 */
/**
 * Tahsilatı platformun yaptığı paket siparişi (platform ödemesi kuryeye verilince yazılır, server/delivery/service.ts
 * afterDelivery) ciro dışı kapanmaz: sıfırla kapanan adisyona platform ödemesi hiç yazılmaz, uyuşmazlık alarmı da
 * düşmezdi. İptal platformdan gelir; kendi kuryemizin kapıda aldığı siparişte ikram ve zayi serbesttir.
 */
function assertNotPlatformCollected(t: Tx, o: OrderRow) {
  if (!o.platform) return;
  const row = t.select({ payload: schema.platformOrders.payload }).from(schema.platformOrders).where(eq(schema.platformOrders.orderId, o.id)).get();
  if (row?.payload.platformCollects) throw conflict('Tahsilatı platformun yaptığı sipariş ciro dışı kapanmaz; iptal platformdan gelir', 'platform_order');
}

export function compItem(t: Tx, actor: Actor, fx: Effects, orderId: string, input: { itemId: string; qty?: number; reason: string; undo?: boolean; kind?: 'ikram' | 'zayi' }): OrderRow {
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  if (!input.undo) assertNotPlatformCollected(t, o);
  const it = loadItem(t, orderId, input.itemId);
  if (it.voided) throw conflict('İptal edilmiş kalem ikram ya da zayi yazılamaz');

  if (input.undo) {
    if (!it.complimentary) throw conflict('Kalem ikram ya da zayi değil');
    const was: CompKind = it.compKind ?? 'ikram';
    const approverId = need(actor, compPermission(was), `${COMP_LABEL[was]} kaydını geri almak yetkili onayı gerektirir`);
    t.update(schema.orderItems).set({ complimentary: false, compReason: null, compBy: null, compKind: null }).where(eq(schema.orderItems.id, it.id)).run();
    const updated = recalc(t, orderId);
    const what = was === 'ikram' ? 'ikramını' : `${COMP_LABEL[was].toLocaleLowerCase('tr-TR')} kaydını`;
    fx.audit(t, { userId: actor.user.id, approverId, action: 'item.uncomp', orderId, entityId: it.id, message: `${actor.user.name} #${o.no} adisyonda ${it.name} ${what} geri aldı`, data: { kind: was } });
    orderEvents(fx, updated, actor.user.id, 'item.uncomped');
    return updated;
  }

  const kind: CompKind = input.kind ?? 'ikram';
  const zayi = kind === 'zayi';
  const approverId = need(actor, compPermission(kind), zayi ? 'Zayi yazmak yetkili onayı gerektirir' : 'İkram yetkili onayı gerektirir');
  if (it.complimentary) throw conflict('Kalem zaten ikram ya da zayi');
  const reason = input.reason.trim();
  if (!reason) throw bad(zayi ? 'Zayi nedeni yazılmalı' : 'İkram nedeni yazılmalı', 'reason_required');
  const unpaid = it.qty - it.paidQty;
  const qty = Math.max(1, Math.min(input.qty ?? unpaid, it.qty));
  if (qty > unpaid) throw conflict(zayi ? 'Ödenmiş kalem zayi yazılamaz' : 'Ödenmiş kalem ikram edilemez', 'item_paid');
  const value = qty * it.unitPrice;
  const before = calcFor(o, orderItems(t, orderId));
  splitItem(t, it, qty, { complimentary: true, compReason: reason, compBy: actor.user.id, compKind: kind, discount: 0 });
  const updated = recalc(t, orderId);
  const did = zayi ? 'zayi yazdı' : 'ikram etti';
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: zayi ? 'item.zayi' : 'item.comp',
    severity: 'uyari',
    orderId,
    entity: 'order_item',
    entityId: it.id,
    amount: value,
    message: `${actor.user.name} #${o.no} adisyonda ${qty}× ${it.name} ${did} (${tl(value)}, ${reason})`,
    data: { kind },
  });
  approveDiscountShrink(t, actor, fx, orderId, before, `#${o.no} adisyonda ${qty}× ${it.name} ${did}`);
  orderEvents(fx, updated, actor.user.id, 'item.comped');
  return updated;
}

/**
 * Adisyonun tamamı ciro dışı kapanır: müşteriye ikram, ödenmez (personel yemeği, patron hesabı) ya da zayi (döküldü,
 * yanlış hazırlandı). Ödenmemiş bütün kalemler ikram işaretlenir (türüyle), adisyon sıfır tutarla kapanır. Yalnız hiç
 * ödeme alınmamış adisyonda: tutarla alınan ödeme kaleme bağlı değildir, kalanı kalem kalem ikram edilir. Ödenmez ve
 * zayi ayrı yetki ister (`siparis.odenmez`).
 */
export function compOrder(t: Tx, actor: Actor, fx: Effects, orderId: string, input: { kind: CompKind; reason: string }): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  assertNotPlatformCollected(t, o);
  // Çalışan oda sayacı kalem görünmeyen ücrettir: önce durdurulup satıra yazılır, sonra ikram edilir
  assertNoActiveRoom(t, orderId);
  // Cihazda kesilmiş ama LafPOS'a işlenmemiş fiş: kalemler cihazda ödenmiş olabilir, ödenmez yazılmaz
  if (fiscalHeldQty(t, orderId).size) throw conflict('Adisyonda yazarkasada kesilmiş ama işlenmemiş bir fiş var. Kalanı kasadan alın ya da fişi cihazdan iptal edin', 'okc_unresolved');
  const label = COMP_LABEL[input.kind];
  const approverId = need(actor, compPermission(input.kind), input.kind === 'ikram' ? 'İkram yetkili onayı gerektirir' : `${label} kapatmak yetkili onayı gerektirir`);
  if (orderPayments(t, orderId).some((p) => !p.refundedAt)) throw conflict('Ödeme alınmış adisyonun kalanı kalem kalem ikram ya da zayi yazılır', 'has_payments');
  const reason = input.reason.trim();
  if (!reason) throw bad(`${label} nedeni yazılmalı`, 'reason_required');
  const live = orderItems(t, orderId).filter((i) => !i.voided && !i.complimentary);
  if (!live.length) throw conflict('Ücretli kalem yok', 'nothing_to_comp');
  for (const it of live) {
    t.update(schema.orderItems).set({ complimentary: true, compReason: reason, compBy: actor.user.id, compKind: input.kind, discount: 0 }).where(eq(schema.orderItems.id, it.id)).run();
  }
  // Kalmayan ücretin indirimi de kalmaz: sıfır tutarlı adisyonda açık indirim raporda iz bırakmasın
  t.update(schema.orders).set({ discountType: null, discountValue: null, discountReason: null }).where(eq(schema.orders.id, orderId)).run();
  const value = live.reduce((a, i) => a + i.qty * i.unitPrice, 0);
  const updated = recalc(t, orderId);
  if (updated.total !== 0) throw conflict(`Ödenecek ${tl(updated.total)} kaldı`, 'due');
  closeOrderRow(t, updated, actor.user.id);
  const did = input.kind === 'ikram' ? 'tamamını ikram etti' : `${label.toLocaleLowerCase('tr-TR')} kapattı`;
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: input.kind === 'ikram' ? 'order.comp' : `order.${input.kind}`,
    // Hesap yazdırıldıktan sonra sıfırlamak, parayı alıp adisyonu ücretsiz kapatma örüntüsüdür (iptaldeki gibi)
    severity: o.billPrintedAt ? 'alarm' : 'uyari',
    orderId,
    amount: value,
    message: `${actor.user.name} #${o.no} adisyonu ${did} (${tl(value)}, ${reason})${o.billPrintedAt ? ', hesap yazdırıldıktan sonra' : ''}`,
    data: { kind: input.kind, items: live.length },
  });
  const closed = loadOrder(t, orderId);
  orderEvents(fx, closed, actor.user.id, 'order.closed');
  fx.emit({ topic: 'cash', kind: 'order.comped', orderId, byUserId: actor.user.id });
  return closed;
}

/**
 * Adisyondaki bütün indirimlerin (kalem + adisyon) brüt tutara oranı. İndirim sınırı tek tek indirime değil bu
 * toplam etkiye uygulanır: %10 sınırlı kişi kaleme %10, adisyona %10 verip %19 indirim yapamaz (denetim, 26 Eki 2026).
 */
function totalDiscountPct(totals: Pick<OrderTotals, 'gross' | 'lineDiscounts' | 'orderDiscount'>): number {
  return totals.gross > 0 ? ((totals.lineDiscounts + totals.orderDiscount) * 100) / totals.gross : 0;
}

/** Adisyonların bugünkü kalemleriyle hesaplanan adisyon indirimi toplamı */
function orderDiscountOf(t: Tx | DB, ...orderIds: string[]): number {
  return orderIds.reduce((a, id) => a + calcFor(loadOrder(t, id), orderItems(t, id)).orderDiscount, 0);
}

/**
 * Birleştirme ve kalem taşıma, hedefin adisyon indirimini gelen kalemlere de uygular. İndirim toplamı büyüdüyse bu
 * yeni bir indirimdir: indirim yetkisi ya da yetkili onayı ister ve denetime yazılır. Yoksa yalnız `masa.islem`'i
 * olan garson başka masanın hesabını indirimli adisyona alıp indirimsiz kalemleri indirimli kapatırdı.
 */
function approveDiscountGrowth(t: Tx, actor: Actor, fx: Effects, target: OrderRow, growth: number, what: string) {
  // Aynı oranlı iki indirimli adisyon birleşince yüzdenin yuvarlaması toplamı 1-2 kuruş oynatabilir: indirim büyümesi değil
  if (growth <= 2) return;
  const pct = totalDiscountPct(calcFor(target, orderItems(t, target.id)));
  const approverId = discountApproval(actor, pct, 'İndirimli adisyona gelen kalemler de indirimli olur; yetkili onayı gerektirir');
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.discount',
    severity: pct >= getSettings().alertDiscountPct ? 'uyari' : 'info',
    orderId: target.id,
    amount: growth,
    message: `${actor.user.name} ${what}; #${target.no} adisyonun indirimi gelen kalemlere de uygulandı (${tl(growth)}, adisyonda toplam %${Math.round(pct)})`,
  });
}

/**
 * Adisyonu küçülten işlem (kalem iptali, ikram, başka adisyona taşıma) saklı indirimi kalan kalemlerde büyütür: tutar
 * indirimi aynı kalır, kalem indirimi kalanın daha büyük payı olur. Sınır yalnız indirim anında denetlendiği için %10
 * sınırlı kasiyer 10 lattelik adisyona %10 tutar indirimi verip 9 latteyi "yanlış giriş" diye iptal edince 1 latte
 * bedava kapanıyordu (gözden geçirme, 27 Eki 2026). Önceki orandan fazlası yeni indirimdir: kalan kalemlerdeki toplam
 * oran işlemi yapanın sınırında olmalı ya da yetkili onaylamalı, denetime yazılır. Yüzde adisyon indirimi oranını
 * korur, onay istemez. Adisyon iptali bütün kalemleri iptal eder; geride indirim kalmaz.
 */
function approveDiscountShrink(t: Tx, actor: Actor, fx: Effects, orderId: string, before: OrderTotals, what: string) {
  const o = loadOrder(t, orderId);
  const after = calcFor(o, orderItems(t, orderId));
  const growth = discountGrowth(before, after);
  // Yüzde indirimlerin yuvarlaması 1-2 kuruş oynatabilir: indirim büyümesi değil
  if (growth <= 2) return;
  const was = Math.round(totalDiscountPct(before) * 10) / 10;
  const pct = totalDiscountPct(after);
  const shown = Math.round(pct * 10) / 10;
  const approverId = discountApproval(actor, pct, `Kalan kalemlerde indirim %${shown} olur; yetkili onayı gerektirir`);
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'order.discount',
    severity: pct >= getSettings().alertDiscountPct ? 'uyari' : 'info',
    orderId,
    amount: growth,
    message: `${actor.user.name} ${what}; #${o.no} adisyonda kalan kalemlerin indirimi %${was} iken %${shown} oldu (${tl(growth)} fazla indirim)`,
    data: { beforePct: was, pct: shown },
  });
}

function discountApproval(actor: Actor, pct: number, reason = 'İndirim yetkili onayı gerektirir'): string | null {
  const approverId = need(actor, 'siparis.indirim', reason);
  if (!approverId && pct > actor.user.maxDiscountPct) {
    // Kullanıcının indirim yetkisi var ama sınırı aşıyor: üst sınırı yeten bir yetkili onaylamalı
    if (!actor.approver) {
      throw new HttpError(403, `İndirim sınırınız %${actor.user.maxDiscountPct}; daha fazlası yetkili onayı ister`, 'approval_required', { permission: 'siparis.indirim' });
    }
    // Yetkisi olmayanın PIN'i hatalı PIN'le aynı yanıtı alır (adı söylenmez); yetkisi olanın sınırı söylenir
    const id = approverFor(actor, 'siparis.indirim');
    if (pct > actor.approver.maxDiscountPct) {
      throw new HttpError(403, `${actor.approver.name} en çok %${actor.approver.maxDiscountPct} indirim onaylayabilir`, 'approval_forbidden');
    }
    return id;
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
  // İndirimi kaldırmak da adisyonu değiştirir: sipariş yetkisi ister (bar ekranı onaylı indirimi geri alamasın)
  needDirect(actor, 'siparis.al');
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
  // Sınır adisyondaki toplam indirime de uygulanır: kalem indirimi adisyon indiriminin üstüne biner
  const total = totalDiscountPct(calcFor(o, orderItems(t, orderId).map((i) => (i.id === it.id ? { ...i, discount: amount } : i))));
  const limitPct = Math.max(pct, total);
  const reason = input.reason.trim();
  if (amount > 0 && !reason) throw bad('İndirim nedeni seçilmeli', 'reason_required');
  const approverId = amount > 0 ? discountApproval(actor, limitPct) : null;
  t.update(schema.orderItems)
    .set({ discount: amount, discountReason: amount > 0 ? reason : null })
    .where(eq(schema.orderItems.id, it.id))
    .run();
  const updated = recalc(t, orderId);
  // Kaldırılan indirim de denetime yazılır: onaylı indirimi kimin geri aldığı görünür
  if (amount === 0 && it.discount > 0) {
    fx.audit(t, {
      userId: actor.user.id,
      action: 'item.discount_removed',
      orderId,
      entityId: it.id,
      amount: it.discount,
      message: `${actor.user.name} #${o.no} adisyonda ${it.name} kalemindeki ${tl(it.discount)} indirimi kaldırdı`,
    });
  }
  if (amount > 0) {
    fx.audit(t, {
      userId: actor.user.id,
      approverId,
      action: 'item.discount',
      severity: limitPct >= getSettings().alertDiscountPct ? 'uyari' : 'info',
      orderId,
      entityId: it.id,
      amount,
      message: `${actor.user.name} #${o.no} adisyonda ${it.name} için ${tl(amount)} indirim yaptı (%${Math.round(pct)}${Math.round(total) > Math.round(pct) ? `, adisyonda toplam %${Math.round(total)}` : ''}, ${reason})`,
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
  // İndirimi kaldırmak da adisyonu değiştirir: sipariş yetkisi ister (bar ekranı onaylı indirimi geri alamasın)
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  if (!input || input.value <= 0) {
    const removed = o.discountType ? calcFor(o, orderItems(t, orderId)).orderDiscount : 0;
    t.update(schema.orders).set({ discountType: null, discountValue: null, discountReason: null, discountBy: null }).where(eq(schema.orders.id, orderId)).run();
    const updated = recalc(t, orderId);
    if (updated.paid > updated.total) throw conflict('Alınan ödeme yeni tutarı aşıyor');
    // Kaldırılan indirim de denetime yazılır: onaylı indirimi kimin geri aldığı görünür
    if (o.discountType) {
      fx.audit(t, {
        userId: actor.user.id,
        action: 'order.discount_removed',
        orderId,
        amount: removed,
        message: `${actor.user.name} #${o.no} adisyondaki ${tl(removed)} indirimi kaldırdı`,
      });
    }
    orderEvents(fx, updated, actor.user.id, 'order.discount');
    return updated;
  }
  const reason = input.reason.trim();
  if (!reason) throw bad('İndirim nedeni seçilmeli', 'reason_required');
  const value = input.type === 'percent' ? Math.min(100, Math.max(0, Math.round(input.value))) : Math.max(0, Math.trunc(input.value));
  const items = orderItems(t, orderId);
  const before = calcFor({ ...o, discountType: null, discountValue: null }, items);
  const subtotal = before.gross - before.lineDiscounts;
  // Boş adisyona indirim verilmez: yetki ve uyarı eşiği tutara göre ölçülür, sonra eklenen kalemlere sessizce uygulanırdı
  if (subtotal <= 0) throw bad('Önce ürün ekleyin; indirim boş adisyona verilmez', 'empty_order');
  const amount = input.type === 'percent' ? percentOf(subtotal, value) : Math.min(subtotal, value);
  const pct = subtotal > 0 ? (amount * 100) / subtotal : 0;
  // Sınır kalem indirimleriyle birlikte toplam etkiye uygulanır (toplam oran, kalem indirimi varken adisyonunkinden büyük)
  const total = totalDiscountPct(calcFor({ ...o, discountType: input.type, discountValue: value }, items));
  const approverId = discountApproval(actor, Math.max(pct, total));
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
    severity: Math.max(pct, total) >= getSettings().alertDiscountPct ? 'uyari' : 'info',
    orderId,
    amount,
    message: `${actor.user.name} #${o.no} adisyona ${tl(amount)} indirim yaptı (%${Math.round(pct)}${Math.round(total) > Math.round(pct) ? `, adisyonda toplam %${Math.round(total)}` : ''}, ${reason})`,
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

/**
 * Yarı self servis: tezgâh ya da gel-al siparişine masa no / numaratör ("12") yazar ya da siler. Parasal değildir:
 * ödeme alındıktan sonra da düzeltilebilir (tezgâh satışı ödemeyle kapanır, sipariş barda hazırlanırken). Bar
 * ekranı, çağrı ekranı ve masa listesi yenilensin diye kitchen ve orders konularına olay düşer.
 */
export function setNumarator(t: Tx, actor: Actor, fx: Effects, orderId: string, raw: string | null): OrderRow {
  if (!can(actor.user, 'siparis.al')) needDirect(actor, 'odeme.al');
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik' && o.status !== 'kapali') throw conflict('İptal edilmiş ya da birleşmiş adisyona masa no yazılmaz', 'order_closed');
  if (o.source !== 'pos') throw conflict('Online siparişin masası sitede seçilir', 'online_order');
  if (o.type !== 'tezgah' && o.type !== 'gelal') throw bad('Masa no / numaratör yalnız tezgâh ve gel-al siparişinde girilir; masadaki adisyonu Masa taşı ile değiştirin');
  const value = normalizeNumarator(raw);
  if (value === undefined) throw bad('Masa no en çok 6 harf ya da rakam olabilir', 'numarator_invalid');
  if (value === o.numarator) return o;
  if (o.status === 'kapali') {
    // Gün sonu alınmış günün adisyonu Z'ye yazılmıştır: masa no da o günün kaydıdır, değişmez
    const day = t.select({ closedAt: schema.businessDays.closedAt }).from(schema.businessDays).where(eq(schema.businessDays.id, o.dayId)).get();
    if (day?.closedAt) throw conflict('Gün sonu alınmış günün adisyonunda masa no değişmez', 'day_closed');
  }
  t.update(schema.orders).set({ numarator: value, updatedAt: Date.now() }).where(eq(schema.orders.id, orderId)).run();
  // Ödenmiş adisyonda değişiklik sonradan yapılan düzeltmedir: denetime yazılır (açık satışta sipariş almanın parçası)
  if (o.status === 'kapali') {
    const label = (n: string | null) => (n ? numaratorLabel(n) : 'masa no yok');
    fx.audit(t, { userId: actor.user.id, action: 'order.numarator', orderId, message: `#${o.no} ödenmiş adisyon: ${label(o.numarator)} → ${label(value)}` });
  }
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.numarator');
  fx.emit({ topic: 'kitchen', kind: 'ticket.updated', orderId, byUserId: actor.user.id });
  return updated;
}

export function moveOrder(t: Tx, actor: Actor, fx: Effects, orderId: string, tableId: string): OrderRow {
  const approverId = need(actor, 'masa.islem');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  // Sitede ödenmiş siparişin masası sitenin (senkron geri yazar); "masa" adisyonuna dönüp odaya da taşınmaz
  assertPosOrder(o);
  const table = t.select().from(schema.tables).where(eq(schema.tables.id, tableId)).get();
  if (!table || !table.active) throw notFound('Masa');
  if (o.tableId === tableId) return o;
  // Masada yalnız sitede ödenmiş online sipariş varsa masa dolu sayılmaz (onunla birleştirilemez de)
  const busy = t.select({ id: schema.orders.id }).from(schema.orders).where(openCheckOn(tableId)).get();
  if (busy) throw conflict(`${table.name} dolu. Birleştirmek için "Birleştir"i kullanın`, 'table_busy');
  const fromTable = o.tableId;
  // Masaya oturan siparişin yeri artık masadır: masa no / numaratör kalırsa bar fişi ve çağrı ekranı eski masayı gösterirdi
  t.update(schema.orders)
    .set({ tableId, type: 'masa', numarator: null, updatedAt: Date.now() })
    .where(eq(schema.orders.id, orderId))
    .run();
  t.update(schema.roomSessions).set({ tableId }).where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt))).run();
  fx.audit(t, { userId: actor.user.id, approverId, action: 'order.move', orderId, message: `#${o.no} adisyon ${table.name} masasına taşındı` });
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.moved');
  if (fromTable) fx.emit({ topic: 'tables', kind: 'order.moved', tableId: fromTable, byUserId: actor.user.id });
  if (o.numarator) fx.emit({ topic: 'kitchen', kind: 'ticket.updated', orderId, byUserId: actor.user.id });
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
  assertNotPlatform(target);
  assertNotPlatform(source);
  assertNoPendingDevice(t, targetId);
  assertNoPendingDevice(t, sourceId);
  const discountBefore = orderDiscountOf(t, targetId, sourceId);
  t.update(schema.orderItems).set({ orderId: targetId }).where(eq(schema.orderItems.orderId, sourceId)).run();
  t.update(schema.payments).set({ orderId: targetId }).where(eq(schema.payments.orderId, sourceId)).run();
  t.update(schema.roomSessions).set({ orderId: targetId }).where(eq(schema.roomSessions.orderId, sourceId)).run();
  // Yazarkasa fişleri de ödemeleriyle birlikte gider: fiş iptali hedef adisyondan düşer, sonraki sepet o fişleri bilir
  t.update(schema.fiscalReceipts).set({ orderId: targetId }).where(eq(schema.fiscalReceipts.orderId, sourceId)).run();
  t.update(schema.orders)
    .set({ status: 'birlesti', mergedInto: targetId, closedAt: Date.now(), closedBy: actor.user.id, updatedAt: Date.now() })
    .where(eq(schema.orders.id, sourceId))
    .run();
  // Paylaşım birleşmede kalkar: iki hesabın pay numaraları karışır (ödenmiş payların etiketi kalır)
  t.update(schema.orders)
    .set({ guests: target.guests + source.guests, customerId: target.customerId ?? source.customerId, splitPeople: null })
    .where(eq(schema.orders.id, targetId))
    .run();
  recalc(t, sourceId);
  const updated = recalc(t, targetId);
  approveDiscountGrowth(t, actor, fx, updated, orderDiscountOf(t, targetId) - discountBefore, `#${source.no} adisyonu #${target.no} ile birleştirdi`);
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
  assertNotPlatform(source);
  assertNoPendingDevice(t, orderId);
  if (!input.items.length) throw bad('Taşınacak kalem seçilmedi');

  let target: OrderRow;
  if (input.targetOrderId) {
    target = loadOrder(t, input.targetOrderId);
    assertOpen(target);
    assertPosOrder(target);
    assertNotPlatform(target);
  } else {
    const tableId = input.tableId ?? source.tableId;
    const existing =
      input.tableId && input.tableId !== source.tableId
        ? // Sitede ödenmiş QR siparişine kalem taşınmaz (tahsil edilemez, ciroya girmez): yalnız kasa adisyonu
          t.select().from(schema.orders).where(openCheckOn(input.tableId)).get()
        : undefined;
    target =
      existing ??
      createOrder(
        t,
        actor,
        fx,
        {
          type: tableId ? 'masa' : source.type === 'masa' ? 'tezgah' : (source.type as 'tezgah' | 'gelal' | 'paket'),
          tableId,
          guests: 1,
          newCheck: true,
        },
        { staleOk: true },
      );
    // Masasız ayrı hesap (yarı self) aynı masaya gider: masa no yeni hesaba da yazılır
    if (!existing && !tableId && source.numarator) {
      t.update(schema.orders).set({ numarator: source.numarator }).where(eq(schema.orders.id, target.id)).run();
      target = loadOrder(t, target.id);
    }
  }
  if (target.id === source.id) throw bad('Kaynak ve hedef aynı');
  const discountBefore = orderDiscountOf(t, orderId, target.id);
  const sourceBefore = calcFor(source, orderItems(t, orderId));

  const held = fiscalHeldQty(t, orderId);
  for (const sel of input.items) {
    const it = loadItem(t, orderId, sel.itemId);
    if (it.voided) continue;
    const unpaid = it.qty - it.paidQty;
    // Cihazda fişi kesilmiş ama LafPOS'a işlenmemiş adet taşınmaz: öbür adisyondan ikinci kez fişe girerdi
    if (held.has(it.id) && Math.trunc(sel.qty) > freeQty(it, held)) {
      throw conflict(`${it.name} cihazda kesilmiş ama LafPOS'a tam işlenmemiş bir fişte; taşınamaz. Kalanı kasadan alın ya da fişi cihazdan iptal edin`, 'okc_unresolved');
    }
    const qty = Math.min(Math.trunc(sel.qty), unpaid);
    if (qty <= 0) throw conflict(`${it.name} ödenmiş; taşınamaz`, 'item_paid');
    if (qty >= it.qty) t.update(schema.orderItems).set({ orderId: target.id }).where(eq(schema.orderItems.id, it.id)).run();
    else splitItem(t, it, qty, { orderId: target.id });
  }

  const src = recalc(t, orderId);
  const dst = recalc(t, target.id);
  approveDiscountGrowth(t, actor, fx, dst, orderDiscountOf(t, orderId, target.id) - discountBefore, `#${source.no} adisyondan #${dst.no} adisyona kalem taşıdı`);
  // Kaynakta kalan kalemler: tutar indirimi kaynakta kalır, taşınan kalemlerin payı da kalanlara biner
  approveDiscountShrink(t, actor, fx, orderId, sourceBefore, `#${source.no} adisyondan #${dst.no} adisyona kalem taşıdı`);
  const remaining = orderItems(t, orderId).filter((i) => !i.voided);
  const hasPayments = orderPayments(t, orderId).some((p) => !p.refundedAt);
  const emptied = !remaining.length && !hasPayments;
  // Oda sayacı çalışan kaynak kapanmaz: sayaç odanın hesabında kalır, durunca ücreti yazılır (kapanmış adisyona
  // yazılamazdı, oda ücreti kaybolurdu). Bütün kalemler aynı odadaki başka hesaba geçtiyse sayaç da onlarla gider:
  // kalemleri tutan hesapta görünür, orada ikinci sayaç başlatılmaz, boşalan kaynak kapanır (inceleme, 27 Eki 2026)
  const room = activeRoom(t, orderId);
  let roomMoved = false;
  if (emptied && room && dst.tableId === room.tableId && !activeRoom(t, target.id)) {
    t.update(schema.roomSessions).set({ orderId: target.id }).where(eq(schema.roomSessions.id, room.id)).run();
    roomMoved = true;
  }
  if (emptied && (!room || roomMoved)) {
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
    message: `#${source.no} adisyondan ${input.items.length} kalem #${dst.no} adisyona taşındı${roomMoved ? ', oda sayacı da' : ''}`,
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
  /** Paylaşımlı hesapta sıradaki payı al: tutarı sunucu hesaplar (splitState) */
  share?: boolean;
  /** Pay ödemesinde kasiyerin ekranda gördüğü pay numarası; tutar da `amount` olarak gelir, ikisi tutmalı */
  shareNo?: number;
  /** Ödeme denemesinin istemcideki kimliği: aynı kimlikle gelen istek yeniden yazılmaz, ilk sonuç döner */
  requestId?: string | null;
}

/**
 * Aynı deneme kimliğiyle gelen istek kaydedilen ödemeyle aynı mı: tür, tutar, bahşiş, pay numarası ve kalemler.
 * Kaydedilen tutar istemcinin gönderdiğiyle aynıdır (pay ve kalem ödemesinde tutmayan tutar 409 alır).
 */
function sameRequest(prev: typeof schema.payments.$inferSelect, input: PaymentInput): boolean {
  if (prev.methodId !== input.methodId || prev.amount !== Math.trunc(input.amount)) return false;
  if (prev.tip !== Math.max(0, Math.trunc(input.tip ?? 0))) return false;
  if (!!input.share !== (prev.shareNo != null)) return false;
  if (input.share && input.shareNo != null && input.shareNo !== prev.shareNo) return false;
  const key = (list: { itemId: string; qty: number }[]) =>
    list
      .map((s) => `${s.itemId}:${s.qty}`)
      .sort()
      .join(',');
  return key(mergeSelection(input.items ?? [])) === key(prev.items ?? []);
}

/** Ödenmiş paylar (iptal edilmemiş, payı olan ödemeler) */
function sharePayments(t: Tx | DB, orderId: string) {
  return orderPayments(t, orderId).filter((p) => !p.refundedAt && p.shareNo != null);
}

/** Hesap kişilere bölünmüş ve ödenmemiş pay kalmış mı (kalan tutar paylara dağılır) */
export function splitActive(t: Tx | DB, o: OrderRow, remaining: number): boolean {
  return !!o.splitPeople && splitState(o.splitPeople, sharePayments(t, o.id).length, remaining).shares.length > 0;
}

/**
 * Hesabı kişilere eşit böler (paylaşımlı hesap) ya da bölmeyi kaldırır. Kalan tutar ödenmemiş paylara eşit
 * dağılır; ödenmiş pay sayısından aza indirilemez.
 */
export function setSplit(t: Tx, actor: Actor, fx: Effects, orderId: string, people: number | null): OrderRow {
  needDirect(actor, 'odeme.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  if (people != null) {
    const n = Math.trunc(people);
    if (n < 2 || n > 30) throw bad('Kişi sayısı 2 ile 30 arasında olmalı', 'split_people');
    const paid = sharePayments(t, orderId).length;
    if (n <= paid) throw bad(`${paid} pay ödendi; kişi sayısı en az ${paid + 1} olmalı`, 'split_people');
    people = n;
  }
  t.update(schema.orders).set({ splitPeople: people, updatedAt: Date.now(), version: sql`${schema.orders.version} + 1` }).where(eq(schema.orders.id, orderId)).run();
  fx.audit(t, {
    userId: actor.user.id,
    action: 'order.split',
    orderId,
    message: people ? `#${o.no} hesap ${people} kişiye bölündü` : `#${o.no} hesap paylaşımı kaldırıldı`,
  });
  const updated = loadOrder(t, orderId);
  orderEvents(fx, updated, actor.user.id, 'order.split');
  return updated;
}

/** Aynı kalem birden çok kez seçildiyse adetleri birleştirir (kalem bazlı ödeme ve cihaz sepeti) */
export function mergeSelection(list: { itemId: string; qty: number }[]): { itemId: string; qty: number }[] {
  const merged = new Map<string, number>();
  for (const s of list) merged.set(s.itemId, (merged.get(s.itemId) ?? 0) + Math.trunc(s.qty));
  return [...merged].filter(([, qty]) => qty > 0).map(([itemId, qty]) => ({ itemId, qty }));
}

/** Adisyonun damga sayılan adedi (ayarlardaki damga kategorileri, iptal ve ikram hariç); damga kartı kapalıyken 0 */
function stampQtyOf(t: Tx, orderId: string): number {
  const settings = getSettings();
  if (!localStampsOn()) return 0;
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

export function addPayment(
  t: Tx,
  actor: Actor,
  fx: Effects,
  orderId: string,
  input: PaymentInput,
): { order: OrderRow; closed: boolean; change: number; amount: number; share: { no: number; of: number } | null } {
  needDirect(actor, 'odeme.al');
  // Yanıtı kaybolan istek yeniden geldiyse (kasiyer "Öde"ye tekrar bastı) ödeme ikinci kez yazılmaz: ilk sonuç döner.
  // Yoksa yarım ödeme iki kez yazılıp adisyon yarısı alınmış hâlde kapanıyordu (denetim, 26 Eki 2026)
  if (input.requestId) {
    const prev = t
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.orderId, orderId), eq(schema.payments.requestId, input.requestId)))
      .get();
    if (prev) {
      // İlk sonuç yalnız aynı istek için döner. Ekran yenilenip başka pay, tutar ya da kalem aynı kimlikle geldiyse ya
      // da o ödeme iptal edildiyse "alındı" denmez: kart terminalinde çekilen para LafPOS'a hiç yazılmıyordu
      // (gözden geçirme, 27 Eki 2026). 409'da istemci yeni kimlik üretir, ekran yenilenir
      if (prev.refundedAt) throw conflict('Bu deneme iptal edilen ödemeye ait; ekran yenilendi, ödemeyi yeniden alın', 'request_refunded');
      if (!sameRequest(prev, input)) throw conflict('Ödeme ekranı değişti; ekran yenilendi, ödemeyi yeniden alın', 'request_reused');
      const order = loadOrder(t, orderId);
      const share = prev.shareNo != null ? { no: prev.shareNo, of: prev.shareOf ?? prev.shareNo } : null;
      return { order, closed: order.status === 'kapali', change: prev.change ?? 0, amount: prev.amount, share };
    }
  }
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
  let selection: PaidItem[] | null = null;
  // Aynı kalem iki kez gönderilirse adetler birleşir: iki kez ücret alınmaz
  const wanted = mergeSelection(input.items ?? []);
  let share: { no: number; of: number } | null = null;
  // Bölünmüş hesapta pay dışı ödeme payları düşürmez: masa paylarını ödeyip kalkar, kalan kimseye kalmaz
  if (!input.share && splitActive(t, o, remaining)) {
    throw conflict('Hesap kişilere bölünmüş: payları "Paylaş"tan alın ya da paylaşımı kaldırın', 'split_active');
  }
  if (input.share) {
    if (!o.splitPeople) throw bad('Hesap paylaşılmadı; önce kişi sayısını seçin', 'split_off');
    if (wanted.length) throw bad('Pay ödemesinde kalem seçilmez', 'split_items');
    const paid = sharePayments(t, orderId);
    const state = splitState(o.splitPeople, paid.length, remaining);
    if (!state.shares.length) throw conflict('Bütün paylar ödendi; kalan tutarı "Tutar" ile alın', 'split_done');
    // Pay tutarını sunucu belirler; numara ilk boş pay (iptal edilen payın numarası yeniden kullanılır)
    const used = new Set(paid.map((p) => p.shareNo));
    let no = 1;
    while (used.has(no)) no++;
    // Kasiyerin ekranda gördüğü pay sunucununkiyle aynı olmalı: başka cihazda kalem eklendiyse, kişi sayısı
    // değiştiyse ya da yanıtı kaybolan istek yeniden geldiyse kart terminaline yanlış tutar girilmesin
    if (Math.trunc(input.amount) !== state.shares[0] || (input.shareNo != null && input.shareNo !== no)) {
      throw conflict(`Paylar değişti: sıradaki pay ${no}/${o.splitPeople}, ${tl(state.shares[0])}. Ekran yenilendi, yeniden alın`, 'split_changed');
    }
    amount = state.shares[0];
    share = { no, of: o.splitPeople };
  }
  if (wanted.length) {
    for (const s of wanted) {
      const it = items.find((i) => i.id === s.itemId);
      if (!it) throw notFound('Kalem');
      // İptal, ikram ya da tamamen indirimli kalem ödemeye seçilmez: ücretsizken ödenmiş işaretlenirse ikramı geri
      // alınınca borçlu olur ama ne kalemle ödenir ne iptal edilir (denetim, 26 Eki 2026)
      if (it.voided || it.complimentary || (totals.lineNet[it.id] ?? 0) <= 0) {
        throw conflict(`${it.name} ücretsiz; ödemeye seçilmez. Ekran yenilendi, yeniden seçin`, 'item_free');
      }
    }
    // Satır satır tutar ödemeye yazılır: ödeme iptal edilip adet yeniden ödenince kalemin kalanı kuruşu kuruşuna alınır
    const lines = itemPayLines(items, orderPayments(t, orderId));
    const breakdown = itemsBreakdown(
      totals,
      lines,
      wanted.map((s) => ({ lineId: s.itemId, qty: s.qty })),
    );
    const expected = breakdown.reduce((a, l) => a + l.amount, 0);
    if (expected <= 0) throw bad('Seçilen kalemler ödenmiş ya da ücretsiz');
    amount = Math.min(expected, remaining);
    // Kasiyerin ekranda gördüğü ve kart terminaline girdiği tutar sunucununkiyle aynı olmalı (pay ödemesindeki gibi):
    // başka cihazda indirim kalktıysa ya da kalem eklenip indirim yeniden dağıldıysa başka tutar sessizce yazılmasın
    if (Math.trunc(input.amount) !== amount) {
      throw conflict(`Seçilen kalemlerin tutarı değişti: ${tl(amount)}. Ekran yenilendi, yeniden alın`, 'items_changed');
    }
    // Kalan tutar seçilenden azsa (araya tutar ödemesi girdi) satır tutarları alınana oranla iner
    const lineAmounts = amount < expected ? allocate(amount, breakdown.map((l) => l.amount)) : breakdown.map((l) => l.amount);
    selection = breakdown.map((l, i) => ({ itemId: l.lineId, qty: l.qty, amount: lineAmounts[i] ?? 0 }));
    for (const l of breakdown) {
      const it = items.find((i) => i.id === l.lineId)!;
      t.update(schema.orderItems).set({ paidQty: it.paidQty + l.qty }).where(eq(schema.orderItems.id, it.id)).run();
    }
  }
  if (amount <= 0) throw bad('Tutar sıfırdan büyük olmalı');
  if (amount > remaining) throw bad(`En fazla ${tl(remaining)} alınabilir`, 'overpay');
  const tip = Math.max(0, Math.trunc(input.tip ?? 0));
  // İşletme bahşiş almaz (Ayarlar'da kapalı): eski istemci gönderse de yazılmaz
  if (tip > 0 && !getSettings().tipsEnabled) throw bad('Bahşiş alınmıyor; bahşişi kaldırın', 'tip_disabled');
  // Açık hesapta para alınmaz: bahşiş Z'de alınmış görünür ama ne çekmecededir ne müşterinin borcunda (denetim, 26 Eki 2026)
  if (tip > 0 && method.kind === 'cari') throw bad('Açık hesaba bahşiş yazılmaz; bahşişi kaldırın', 'tip_on_account');

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
      shareNo: share?.no ?? null,
      shareOf: share?.of ?? null,
      userId: actor.user.id,
      createdAt: Date.now(),
      requestId: input.requestId ?? null,
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
  return { order: updated, closed, change, amount, share };
}

/** Ödenecek tutarı sıfır olan (tamamı ikram/iptal) adisyonu kapatır. */
export function closeOrder(t: Tx, actor: Actor, fx: Effects, orderId: string): OrderRow {
  needDirect(actor, 'siparis.al');
  const o = recalc(t, orderId);
  assertOpen(o);
  // Sitede ödenmiş siparişin aşaması sitenin, kapanışı senkronun
  assertPosOrder(o);
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
  // Boş adisyon da olsa iptal sipariş yetkisi ister (bar ekranı, kurye başkasının masasını kapatmasın)
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  assertOpen(o);
  assertPosOrder(o);
  assertNoPendingDevice(t, orderId);
  // Çalışan oda sayacı kalem görünmeyen ücrettir: "boş adisyon" diye onaysız silinmesin, önce durdurulup yazılır
  assertNoActiveRoom(t, orderId);
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
  releasePortions(t, fx, actor.user.id, live.filter(notStarted));
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

/**
 * Bar ve mutfak durumları. Başlamış kalem bekleyene ("yeni") dönmez ve başlama zamanı silinmez: onaysız iptal
 * "hiç başlanmamış" kaleme (yanlış giriş penceresi) özgüdür. Garson kalemi "yeni"ye çekip bardan çıkmış içeceği
 * onaysız, zayi sayılmadan iptal ediyordu (denetim, 26 Eki 2026). Bardaki "Geri al" en çok "hazırlanıyor"a döner.
 *
 * "Teslim edildi" kalemi "servis"e taşır (teslim zamanı yazılır, çağrı ekranından ve bar ekranının Hazır sekmesinden
 * düşer); onun "Geri al"ı "servis"ten "hazir"a döndürür: hazır olduğu an korunur, hazır uyarısı yinelenmez. Kasanın
 * kendi gel-al siparişinin aşaması bardan izler (`syncPickupDelivery`; Siparişler'de aynı sipariş için ikinci bir
 * düğme kalmasın).
 */
export function setItemsStatus(
  t: Tx,
  actor: Actor,
  fx: Effects,
  input: { itemIds: string[]; status?: 'hazirlaniyor' | 'hazir' | 'servis' },
): void {
  if (!can(actor.user, 'mutfak.ekran') && !can(actor.user, 'siparis.al')) needDirect(actor, 'mutfak.ekran');
  if (!input.itemIds.length) return;
  const items = t.select().from(schema.orderItems).where(inArray(schema.orderItems.id, input.itemIds)).all();
  const now = Date.now();
  const orders = new Set<string>();
  const stations = new Set<string>();
  /** Adisyon başına bu dokunuşta "Hazır" olan adet: siparişi alana uyarı */
  const readyCount = new Map<string, number>();
  /** Teslimi geri alınan kalemin adisyonu */
  const unserved = new Set<string>();
  for (const it of items) {
    if (it.voided) continue;
    const status = input.status ?? NEXT[it.status];
    if (!status || status === it.status) continue;
    // Teslimin geri alınışı: kalem yeniden hazırlanmadı, yalnız teslim zamanı silinir
    const undo = it.status === 'servis' && status === 'hazir' && it.readyAt != null;
    if (status === 'hazir' && !undo) readyCount.set(it.orderId, (readyCount.get(it.orderId) ?? 0) + it.qty);
    if (it.status === 'servis') unserved.add(it.orderId);
    const patch: Partial<ItemRow> = { status };
    // Teslimden geri dönen kalemin teslim zamanı kalmaz (hazırdan teslime süresi yalnız gerçek teslimi sayar)
    if (status === 'hazirlaniyor') Object.assign(patch, { startedAt: it.startedAt ?? now, servedAt: null });
    if (status === 'hazir') Object.assign(patch, undo ? { servedAt: null } : { startedAt: it.startedAt ?? now, readyAt: now, servedAt: null });
    if (status === 'servis') Object.assign(patch, { startedAt: it.startedAt ?? now, readyAt: it.readyAt ?? now, servedAt: now });
    t.update(schema.orderItems).set(patch).where(eq(schema.orderItems.id, it.id)).run();
    orders.add(it.orderId);
    if (it.stationId) stations.add(it.stationId);
  }
  for (const id of orders) {
    const o = syncPickupDelivery(t, actor, fx, loadOrder(t, id), unserved.has(id));
    orderEvents(fx, o, actor.user.id, 'item.status');
    const ready = readyCount.get(id);
    if (ready && o.waiterId) {
      const table = o.tableId ? t.select({ name: schema.tables.name }).from(schema.tables).where(eq(schema.tables.id, o.tableId)).get() : null;
      const place =
        table?.name ?? (o.source === 'laffogato' ? (o.extLabel ?? 'Online') : o.numarator ? numaratorLabel(o.numarator) : `${ORDER_TYPE_LABEL[o.type]} #${o.no}`);
      fx.emit({ topic: 'orders', kind: 'items.ready', orderId: id, tableId: o.tableId ?? undefined, message: `${place} · ${ready} ürün hazır`, forUserId: o.waiterId, byUserId: actor.user.id });
    }
  }
  for (const s of stations) fx.emit({ topic: 'kitchen', kind: 'ticket.status', stationId: s, byUserId: actor.user.id });
}

/**
 * Kasanın gel-al siparişi (site ve paket platformu değil): aşaması bardan izler. Bara giden kalemlerin hepsi hazır
 * olunca "Hazır", hepsi teslim edilince "Teslim edildi"; teslim geri alınınca (kalem servisten döndü) kalemlerin
 * durumuna döner. Platform siparişinin aşaması platforma ve ödemesine bağlı, burada değişmez.
 */
function syncPickupDelivery(t: Tx, actor: Actor, fx: Effects, o: OrderRow, unserved: boolean): OrderRow {
  if (o.source !== 'pos' || o.platform || o.type !== 'gelal' || o.status === 'iptal') return o;
  const kitchen = orderItems(t, o.id).filter((i) => !i.voided && i.stationId);
  if (!kitchen.length) return o;
  const served = kitchen.every((i) => i.status === 'servis');
  const ready = kitchen.every((i) => i.status === 'hazir' || i.status === 'servis');
  const reverted = unserved && o.deliveryStatus === 'teslim';
  let next: OrderRow['deliveryStatus'] = null;
  if (served) next = o.deliveryStatus === 'teslim' ? null : 'teslim';
  else if (ready) next = o.deliveryStatus === 'hazirlaniyor' || reverted ? 'hazir' : null;
  else if (reverted) next = 'hazirlaniyor';
  if (!next || next === o.deliveryStatus) return o;
  t.update(schema.orders).set({ deliveryStatus: next, updatedAt: Date.now() }).where(eq(schema.orders.id, o.id)).run();
  // Hazır aşaması denetime yazılmaz (Siparişler'deki aşama düğmesi gibi); teslim ve geri alınışı yazılır
  if (next === 'teslim' || reverted) {
    fx.audit(t, {
      userId: actor.user.id,
      action: next === 'teslim' ? 'delivery.done' : 'delivery.undo',
      orderId: o.id,
      message: next === 'teslim' ? `#${o.no} gel-al teslim edildi` : `#${o.no} gel-al teslimi geri alındı`,
    });
  }
  fx.emit({ topic: 'delivery', kind: 'delivery.status', orderId: o.id, byUserId: actor.user.id });
  return loadOrder(t, o.id);
}

export function getOrderDTO(t: Tx | DB, orderId: string): OrderDTO {
  return orderToDTO(t, loadOrder(t, orderId));
}

/**
 * Dışarıdan gelen (yazarkasa POS'ta alınmış) ödemeleri adisyona işler: kalemlerin ödenen adetleri işaretlenir,
 * ödemeler eklenir, tutar tamamlandıysa (oda sayacı çalışmıyorsa) adisyon kapanır. Ödeme cihazda zaten alındığı için
 * yetki sorulmaz; işlemi başlatan kişinin adına kaydedilir.
 */
export function addExternalPayments(
  t: Tx,
  userId: string,
  fx: Effects,
  orderId: string,
  input: { payments: { methodId: string; amount: number; note?: string | null }[]; items: PaidItem[] },
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

  const marked: PaidItem[] = [];
  for (const sel of input.items) {
    const it = items.find((i) => i.id === sel.itemId);
    if (!it) continue;
    const qty = Math.min(sel.qty, it.qty - it.paidQty);
    if (qty <= 0) continue;
    t.update(schema.orderItems).set({ paidQty: it.paidQty + qty }).where(eq(schema.orderItems.id, it.id)).run();
    marked.push({ itemId: it.id, qty, amount: qty === sel.qty ? sel.amount : undefined });
  }
  // Sepetin satır tutarları kalem işaretine yazılır (addPayment gibi): ödeme iptal edilip adet yeniden ödenince
  // satırın kalanı kuruşu kuruşuna alınır. Cihaz sepetten az aldıysa tutarlar alınana oranla iner; biri
  // bilinmiyorsa (eski sepet) hiçbiri yazılmaz, adet payları sırayla sayılır
  const lineAmounts = marked.map((m) => m.amount);
  if (lineAmounts.every((a): a is number => a != null)) {
    const expected = lineAmounts.reduce((a, b) => a + b, 0);
    const scaled = sum < expected ? allocate(sum, lineAmounts) : lineAmounts;
    marked.forEach((m, i) => (m.amount = scaled[i] ?? 0));
  } else {
    for (const m of marked) delete m.amount;
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
    if (activeRoom(t, orderId)) {
      // Oda sayacı çalışırken adisyon kapanmaz: kapanmış adisyona oda ücreti yazılamaz, ücret kaybolurdu (eski veri
      // ya da gönderimi hata görünen sepet; sepet beklerken sayaç başlamaz)
      fx.audit(t, {
        userId,
        action: 'okc.room_running',
        severity: 'uyari',
        orderId,
        message: `#${o.no} adisyon yazarkasada ödendi ama oda sayacı çalışıyor; adisyon açık kaldı. Sayacı durdurup oda ücretini alın`,
      });
    } else {
      closeOrderRow(t, updated, userId);
      updated = loadOrder(t, orderId);
      closed = true;
    }
  }
  orderEvents(fx, updated, userId, closed ? 'order.closed' : 'payment.added');
  fx.emit({ topic: 'cash', kind: 'payment.added', orderId, byUserId: userId });
  return { order: updated, closed, paymentIds: ids };
}

/**
 * Yazarkasada fiş iptal edilince o fişin LafPOS ödemeleri de iptal edilir. Ödeme bulunduğu adisyondan düşer
 * (birleştirmeyle başka adisyona geçmiş olabilir). Kapanmış adisyon yalnız bu iptalle gerçekten ödenecek tutar
 * doğduysa yeniden açılır: ödemesi LafPOS'ta zaten iptal edilip yeniden alınmış adisyon kapalı kalır (inceleme,
 * 27 Eki 2026).
 */
export function refundExternalPayments(
  t: Tx,
  userId: string | null,
  fx: Effects,
  paymentIds: string[],
  reason: string,
): { refunded: number; orders: { order: OrderRow; reopened: boolean }[] } {
  const now = Date.now();
  const openDay = getOpenDay(t);
  const touched = new Map<string, OrderRow>();
  let refunded = 0;
  for (const pid of paymentIds) {
    const p = t.select().from(schema.payments).where(eq(schema.payments.id, pid)).get();
    if (!p || p.refundedAt || !p.orderId) continue;
    if (!touched.has(p.orderId)) touched.set(p.orderId, loadOrder(t, p.orderId));
    refunded += p.amount;
    t.update(schema.payments).set({ refundedAt: now, refundedBy: userId, refundReason: reason }).where(eq(schema.payments.id, pid)).run();
    for (const s of p.items ?? []) {
      const it = t.select().from(schema.orderItems).where(eq(schema.orderItems.id, s.itemId)).get();
      if (it) t.update(schema.orderItems).set({ paidQty: Math.max(0, it.paidQty - s.qty) }).where(eq(schema.orderItems.id, it.id)).run();
    }
    if (p.customerId) {
      t.update(schema.customers).set({ balance: sql`${schema.customers.balance} - ${p.amount}` }).where(eq(schema.customers.id, p.customerId)).run();
      // Normal ödeme iptaliyle aynı: bakiye ile cari ekstresi ayrışmasın
      t.insert(schema.customerLedger)
        .values({ id: ulid(now), customerId: p.customerId, kind: 'duzeltme', amount: -p.amount, orderId: p.orderId, paymentId: p.id, dayId: openDay?.id ?? p.dayId, note: `Yazarkasa fiş iptali: ${reason}`, userId, createdAt: now })
        .run();
    }
  }
  const orders: { order: OrderRow; reopened: boolean }[] = [];
  for (const o of touched.values()) {
    let updated = recalc(t, o.id);
    const reopened = o.status === 'kapali' && updated.paid < updated.total;
    if (reopened) {
      uncreditCustomer(t, o);
      t.update(schema.orders).set({ status: 'acik', closedAt: null, closedBy: null }).where(eq(schema.orders.id, o.id)).run();
      updated = loadOrder(t, o.id);
    }
    orderEvents(fx, updated, userId ?? 'sistem', 'payment.refunded');
    fx.emit({ topic: 'cash', kind: 'payment.refunded', orderId: o.id });
    orders.push({ order: updated, reopened });
  }
  return { refunded, orders };
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
