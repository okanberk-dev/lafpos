import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { db, schema, tx } from '../db/client';
import { type AppEnv, actorFrom, blindOrder, needDirect } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, isoDateTime, kurus, query } from '../lib/http';
import { afterDelivery } from '../delivery/service';
import { bootstrap } from '../services/bootstrap';
import { orderToDTO } from '../services/dto';
import { floorState, kitchenTickets } from '../services/floor';
import * as orders from '../services/orders';
import { startRoom, stopRoom } from '../services/rooms';

export const posRoutes = new Hono<AppEnv>();

const approver = { approverPin: z.string().max(6).optional().nullable() };
const reason = z.string().max(200).default('');

/** Yazma işlemi: tek veritabanı işlemi, sonra canlı olaylar. */
function write<T>(fn: (t: Parameters<Parameters<typeof tx>[0]>[0], fx: Effects) => T): T {
  const fx = new Effects();
  const result = tx((t) => fn(t, fx));
  fx.flush();
  return result;
}

posRoutes.get('/bootstrap', (c) => c.json(bootstrap(db, c.get('user'))));
posRoutes.get('/floor', (c) => c.json(floorState(db)));

/** Adisyon yanıtı: kör kasada kapanmış adisyonun ödeme dökümü süzülür (blindOrder) */
const dto = (c: Context<AppEnv>, id: string) => blindOrder(c.get('user'), orders.getOrderDTO(db, id));

posRoutes.get('/orders', (c) => {
  const q = query(
    c,
    z.object({
      status: z.enum(['acik', 'kapali', 'iptal', 'tum']).default('acik'),
      dayId: z.string().optional(),
      type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  );
  const conds = [];
  if (q.status !== 'tum') conds.push(eq(schema.orders.status, q.status));
  if (q.dayId) conds.push(eq(schema.orders.dayId, q.dayId));
  if (q.type) conds.push(inArray(schema.orders.type, q.type.split(',') as ('masa' | 'tezgah' | 'gelal' | 'paket' | 'online')[]));
  if (q.status !== 'acik' && !q.dayId) {
    const day = orders.getOpenDay(db);
    if (day) conds.push(eq(schema.orders.dayId, day.id));
  }
  const rows = db
    .select()
    .from(schema.orders)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.orders.openedAt))
    .limit(q.limit)
    .all();
  const user = c.get('user');
  return c.json(rows.map((r) => blindOrder(user, orderToDTO(db, r))));
});

posRoutes.get('/orders/:id', (c) => c.json(dto(c, c.req.param('id'))));

posRoutes.post('/orders', async (c) => {
  const input = await body(
    c,
    z.object({
      type: z.enum(['masa', 'tezgah', 'gelal', 'paket']),
      tableId: z.string().nullish(),
      guests: z.number().int().min(1).max(99).optional(),
      customerId: z.string().nullish(),
      note: z.string().max(300).nullish(),
      newCheck: z.boolean().optional(),
      reuse: z.string().max(40).nullish(),
      deliveryName: z.string().max(80).nullish(),
      deliveryPhone: z.string().max(30).nullish(),
      deliveryAddress: z.string().max(400).nullish(),
      scheduledFor: isoDateTime.nullish(),
    }),
  );
  const actor = actorFrom(c);
  const order = write((t, fx) => orders.createOrder(t, actor, fx, input));
  return c.json(dto(c, order.id));
});

posRoutes.patch('/orders/:id', async (c) => {
  const input = await body(
    c,
    z.object({
      guests: z.number().int().min(1).max(99).optional(),
      note: z.string().max(300).nullish(),
      waiterId: z.string().optional(),
      customerId: z.string().nullish(),
      ...approver,
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.updateOrder(t, actor, fx, c.req.param('id'), input));
  return c.json(dto(c, c.req.param('id')));
});

/** Yarı self servis: masa no / numaratör ("12"); null siler. Kapanmış (ödenmiş) tezgâh satışında da düzeltilir */
posRoutes.put('/orders/:id/numarator', async (c) => {
  const input = await body(c, z.object({ numarator: z.string().max(20).nullable() }));
  const actor = actorFrom(c);
  write((t, fx) => orders.setNumarator(t, actor, fx, c.req.param('id'), input.numarator));
  return c.json(dto(c, c.req.param('id')));
});

const optionPick = z.object({ itemId: z.string(), qty: z.number().int().min(0).max(9).optional() });

posRoutes.post('/orders/:id/items', async (c) => {
  const input = await body(
    c,
    z.object({
      items: z
        .array(
          z.object({
            productId: z.string(),
            size: z.enum(['M', 'L', 'TEK']).optional(),
            qty: z.number().int().min(1).max(99),
            options: z.array(optionPick).max(20).optional(),
            note: z.string().max(200).nullish(),
            priceOverride: kurus.nullish(),
          }),
        )
        .min(1)
        .max(60),
      ...approver,
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.addItems(t, actor, fx, c.req.param('id'), input.items));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/items/:itemId/void', async (c) => {
  const input = await body(c, z.object({ qty: z.number().int().min(1).optional(), reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.voidItem(t, actor, fx, c.req.param('id'), { itemId: c.req.param('itemId'), qty: input.qty, reason: input.reason }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/items/:itemId/comp', async (c) => {
  const input = await body(c, z.object({ qty: z.number().int().min(1).optional(), reason, undo: z.boolean().optional(), ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.compItem(t, actor, fx, c.req.param('id'), { itemId: c.req.param('itemId'), qty: input.qty, reason: input.reason, undo: input.undo }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/comp', async (c) => {
  const input = await body(c, z.object({ kind: z.enum(['ikram', 'odenmez']), reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.compOrder(t, actor, fx, c.req.param('id'), { kind: input.kind, reason: input.reason }));
  return c.json(dto(c, c.req.param('id')));
});

const discountShape = { type: z.enum(['percent', 'amount']), value: z.number().min(0).max(1_000_000_000), reason, ...approver };

posRoutes.post('/orders/:id/items/:itemId/discount', async (c) => {
  const input = await body(c, z.object(discountShape));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.setItemDiscount(t, actor, fx, c.req.param('id'), { itemId: c.req.param('itemId'), type: input.type, value: input.value, reason: input.reason }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/discount', async (c) => {
  const input = await body(c, z.object({ ...discountShape, remove: z.boolean().optional() }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.setOrderDiscount(t, actor, fx, c.req.param('id'), input.remove ? null : { type: input.type, value: input.value, reason: input.reason }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/move', async (c) => {
  const input = await body(c, z.object({ tableId: z.string(), ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.moveOrder(t, actor, fx, c.req.param('id'), input.tableId));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/merge', async (c) => {
  const input = await body(c, z.object({ sourceOrderId: z.string(), ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.mergeOrders(t, actor, fx, c.req.param('id'), input.sourceOrderId));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/transfer', async (c) => {
  const input = await body(
    c,
    z.object({
      items: z.array(z.object({ itemId: z.string(), qty: z.number().int().min(1) })).min(1),
      tableId: z.string().nullish(),
      targetOrderId: z.string().nullish(),
      ...approver,
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  const res = write((t, fx) => orders.transferItems(t, actor, fx, c.req.param('id'), input));
  return c.json({ source: dto(c, res.source.id), target: dto(c, res.target.id) });
});

posRoutes.post('/orders/:id/bill', (c) => {
  const actor = actorFrom(c);
  write((t, fx) => orders.printBill(t, actor, fx, c.req.param('id')));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/payments', async (c) => {
  const input = await body(
    c,
    z.object({
      methodId: z.string(),
      amount: kurus,
      tip: kurus.optional(),
      given: kurus.nullish(),
      items: z.array(z.object({ itemId: z.string(), qty: z.number().int().min(1) })).nullish(),
      customerId: z.string().nullish(),
      note: z.string().max(200).nullish(),
      share: z.boolean().optional(),
      shareNo: z.number().int().min(1).max(30).optional(),
      // Ödeme denemesinin kimliği (istemci üretir): yeniden gelen istek ikinci kez yazılmaz
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
      ...approver,
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  const res = write((t, fx) => orders.addPayment(t, actor, fx, c.req.param('id'), input));
  // Kaydedilen tutar ve pay da döner: kör kasada kapanan adisyonun ödeme dökümü gizlidir, ekran bunu gösterir
  return c.json({ order: dto(c, res.order.id), closed: res.closed, change: res.change, amount: res.amount, share: res.share });
});

/** Hesap paylaşımı: kişi sayısı (2-30) ya da kaldırmak için null */
posRoutes.put('/orders/:id/split', async (c) => {
  const input = await body(c, z.object({ people: z.number().int().nullable() }));
  const actor = actorFrom(c);
  write((t, fx) => orders.setSplit(t, actor, fx, c.req.param('id'), input.people));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/payments/:paymentId/refund', async (c) => {
  const input = await body(c, z.object({ reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.refundPayment(t, actor, fx, c.req.param('id'), { paymentId: c.req.param('paymentId'), reason: input.reason }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/close', (c) => {
  const actor = actorFrom(c);
  write((t, fx) => orders.closeOrder(t, actor, fx, c.req.param('id')));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/reopen', async (c) => {
  const input = await body(c, z.object({ reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.reopenOrder(t, actor, fx, c.req.param('id'), input.reason));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/cancel', async (c) => {
  const input = await body(c, z.object({ reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => orders.cancelOrder(t, actor, fx, c.req.param('id'), input.reason));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/delivery', async (c) => {
  const input = await body(c, z.object({ deliveryStatus: z.enum(['hazirlaniyor', 'hazir', 'yolda', 'teslim']).optional(), courierId: z.string().nullish() }));
  const actor = actorFrom(c);
  write((t, fx) => {
    const before = t.select({ s: schema.orders.deliveryStatus }).from(schema.orders).where(eq(schema.orders.id, c.req.param('id'))).get()?.s ?? null;
    orders.setDelivery(t, actor, fx, c.req.param('id'), input);
    // Platform siparişi: tahsilatı platform yapıyorsa kuryeye verilince / teslimde kapanır
    afterDelivery(t, actor.user, fx, c.req.param('id'), before);
  });
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/room/start', (c) => {
  const actor = actorFrom(c);
  write((t, fx) => startRoom(t, actor, fx, c.req.param('id')));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/room/stop', (c) => {
  const actor = actorFrom(c);
  write((t, fx) => stopRoom(t, actor, fx, c.req.param('id')));
  return c.json(dto(c, c.req.param('id')));
});

// ─── Bar / mutfak ekranı ─────────────────────────────────────────────────────

posRoutes.get('/kitchen', (c) => {
  const q = query(c, z.object({ station: z.string().optional(), history: z.enum(['0', '1']).optional() }));
  const actor = actorFrom(c);
  if (!actor.user.permissions.has('mutfak.ekran') && !actor.user.permissions.has('siparis.al')) needDirect(actor, 'mutfak.ekran');
  return c.json(kitchenTickets(db, { stationId: q.station || null, history: q.history === '1' }));
});


posRoutes.post('/kitchen/status', async (c) => {
  const input = await body(
    c,
    // "yeni"ye dönüş yok: başlamış kalemin başlama zamanı silinip onaysız iptal açılırdı (orders.setItemsStatus)
    z.object({ itemIds: z.array(z.string()).min(1).max(100), status: z.enum(['hazirlaniyor', 'hazir', 'servis']).optional() }),
  );
  const actor = actorFrom(c);
  write((t, fx) => orders.setItemsStatus(t, actor, fx, input));
  return c.json({ ok: true });
});

export { write };
