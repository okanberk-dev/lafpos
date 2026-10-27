import { and, eq, isNull } from 'drizzle-orm';
import { tl } from '@shared/money';
import { schema, type Tx } from '../db/client';
import { type Actor, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings } from '../lib/settings';
import { activeRoom, assertNoPendingDevice, assertPosOrder, loadOrder, recalc } from './orders';

/**
 * Karaoke odası gibi süreli alanlar: sayaç başlar, durunca süre faturalama adımına yukarı yuvarlanır
 * (en az "minimum dakika"), saatlik ücretle adisyona HİZMET satırı (KDV %20) olarak eklenir.
 */
export function billableMinutes(elapsedMs: number, stepMin: number, minimumMin: number): number {
  const minutes = Math.max(0, Math.ceil(elapsedMs / 60_000));
  const stepped = Math.ceil(minutes / Math.max(1, stepMin)) * Math.max(1, stepMin);
  return Math.max(minimumMin, stepped);
}

export function roomCharge(hourlyRate: number, minutes: number): number {
  return Math.round((hourlyRate * minutes) / 60);
}

export function startRoom(t: Tx, actor: Actor, fx: Effects, orderId: string) {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik') throw conflict('Adisyon kapalı');
  // Sitede ödenmiş siparişe oda ücreti yazılmaz: tahsil edilemez (kural 7)
  assertPosOrder(o);
  if (!o.tableId) throw bad('Oda sayacı yalnız oda/masa adisyonunda çalışır');
  const table = t.select().from(schema.tables).where(eq(schema.tables.id, o.tableId)).get();
  if (!table || table.kind !== 'oda' || !table.hourlyRate) throw bad('Bu masa saatlik oda değil');
  // Sepet cihazda beklerken sayaç başlamaz: cihaz ödemesi adisyonu kapatır, oda ücreti kapanmış adisyona yazılamazdı
  assertNoPendingDevice(t, orderId);
  if (activeRoom(t, orderId)) throw conflict('Oda sayacı zaten çalışıyor', 'room_running');
  // Bir odada aynı anda tek sayaç: odanın başka hesabında ("Yeni hesap", aynı odada ayrı hesaba taşıma) sayaç
  // çalışırken ikincisi başlarsa oda iki kez faturalanır (inceleme, 27 Eki 2026). Kapanmış adisyonda kalmış eski sayaç
  // odayı tutmaz: ücret yazılamaz, durdurulamaz
  const holder = t
    .select({ no: schema.orders.no })
    .from(schema.roomSessions)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.roomSessions.orderId))
    .where(and(eq(schema.roomSessions.tableId, table.id), isNull(schema.roomSessions.endedAt), eq(schema.orders.status, 'acik')))
    .get();
  if (holder) throw conflict(`${table.name} sayacı #${holder.no} adisyonda çalışıyor; oda ücreti o hesaba yazılır`, 'room_running');
  t.insert(schema.roomSessions).values({ id: ulid(), orderId, tableId: table.id, hourlyRate: table.hourlyRate, startedAt: Date.now(), startedBy: actor.user.id }).run();
  fx.audit(t, { userId: actor.user.id, action: 'room.start', orderId, message: `${table.name} sayacı başladı (saatlik ${tl(table.hourlyRate)})` });
  fx.emit({ topic: 'orders', kind: 'room.started', orderId, tableId: table.id, byUserId: actor.user.id });
  fx.emit({ topic: 'tables', kind: 'room.started', tableId: table.id, byUserId: actor.user.id });
}

export function stopRoom(t: Tx, actor: Actor, fx: Effects, orderId: string) {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik') throw conflict('Adisyon kapalı; oda ücretini yazmak için önce adisyonu yeniden açın', 'order_closed');
  assertPosOrder(o);
  const session = activeRoom(t, orderId);
  if (!session) throw notFound('Çalışan oda sayacı');
  // Oda ücreti ürünü: POS'ta gizli hizmet ürünü ("Karaoke odası"); kişi başı karaoke gibi görünür hizmetler değil
  const services = t.select().from(schema.products).where(and(eq(schema.products.isService, true), eq(schema.products.active, true))).all();
  const product = services.find((p) => p.posName === 'KARAOKE ODASI') ?? services.find((p) => p.hidden) ?? services[0];
  if (!product) throw conflict('Saatlik oda ürünü tanımlı değil (Yönetim › Menü, gizli "hizmet" ürünü)');
  const s = getSettings();
  const now = Date.now();
  const minutes = billableMinutes(now - session.startedAt, s.roomBillingStepMinutes, s.roomMinimumMinutes);
  const charge = roomCharge(session.hourlyRate, minutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const itemId = ulid(now);
  t.insert(schema.orderItems)
    .values({
      id: itemId,
      orderId,
      productId: product.id,
      name: product.shortName?.trim() || product.name,
      size: 'TEK',
      options: [],
      optionsText: `${h ? `${h} sa ` : ''}${m ? `${m} dk` : ''}`.trim(),
      qty: 1,
      unitPrice: charge,
      basePrice: charge,
      kdvRate: product.kdvRate,
      status: 'servis',
      batch: 0,
      sentAt: now,
      servedAt: now,
      isService: true,
      posName: product.posName ?? product.name.toLocaleUpperCase('tr-TR'),
      createdBy: actor.user.id,
      createdAt: now,
    })
    .run();
  t.update(schema.roomSessions).set({ endedAt: now, itemId }).where(eq(schema.roomSessions.id, session.id)).run();
  recalc(t, orderId);
  fx.audit(t, { userId: actor.user.id, action: 'room.stop', orderId, amount: charge, message: `Oda sayacı durdu: ${minutes} dk, ${tl(charge)} adisyona eklendi (#${o.no})` });
  fx.emit({ topic: 'orders', kind: 'room.stopped', orderId, tableId: session.tableId, byUserId: actor.user.id });
  fx.emit({ topic: 'tables', kind: 'room.stopped', tableId: session.tableId, byUserId: actor.user.id });
}
