import { and, desc, eq, inArray, like, lt } from 'drizzle-orm';
import { afterLoss, lossOf } from '../sync/bildirim';
import { assertCanSell } from '../sync/merkez';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { db, schema, type Tx, tx } from '../db/client';
import { type AppEnv, actorFrom, blindOrder, can, needDirect, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, isoDateTime, kurus, query } from '../lib/http';
import { CLOSED_PAGE_DEFAULT, CLOSED_PAGE_MAX, HISTORY_QUERY_MAX, KITCHEN_HISTORY_MAX } from '@shared/history';
import { isCalendarDate } from '@shared/time';
import { afterDelivery } from '../delivery/service';
import { bootstrap } from '../services/bootstrap';
import { orderToDTO } from '../services/dto';
import { floorState, kitchenTickets, ordersAwaitingHand } from '../services/floor';
import { closedOrderDetail, closedOrders, kitchenHistory } from '../services/history';
import { setOptionSoldOut } from '../services/menu';
import * as orders from '../services/orders';
import { linkRoom, startRoom, stopRoom } from '../services/rooms';
import { refreshSiteKaraoke, siteKaraokeOn } from '../sync/laffogato-karaoke';

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
posRoutes.get('/floor', (c) => {
  const f = floorState(db);
  // Sitedeki karaoke rezervasyonunun serbest metin notu yalnız oda kutusunu gören rollere (siparis.al ya da
  // rezervasyon.yonet; /sync/karaoke'nin kapısı): bar ekranı ve kurye gibi roller planı notsuz görür
  const u = c.get('user');
  if (f.siteKaraoke && !can(u, 'siparis.al') && !can(u, 'rezervasyon.yonet')) f.siteKaraoke = f.siteKaraoke.map((b) => ({ ...b, note: '' }));
  return c.json(f);
});

/** Adisyon yanıtı: kör kasada kapanmış adisyonun ödeme dökümü süzülür (blindOrder) */
const dto = (c: Context<AppEnv>, id: string) => blindOrder(c.get('user'), orders.getOrderDTO(db, id));

posRoutes.get('/orders', (c) => {
  const q = query(
    c,
    z.object({
      status: z.enum(['acik', 'kapali', 'iptal', 'tum']).default('acik'),
      dayId: z.string().optional(),
      type: z.string().optional(),
      /** Teslim bekleyen hazır kalemi olanlar: bar ekranının Hazır sekmesiyle aynı koşul (`awaitingHandWhere`) */
      ready: z.literal('1').optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  );
  const conds = [];
  if (q.ready) {
    // Siparişler › Açık'ın önce ödenmiş satışları: son 30 dakikada hazır olup teslim edilmemiş, açık günün; açık gün
    // yoksa boş (eskiden gün boyu ve gün sonundan sonra önceki günlerin "Ödendi" kartları birikiyordu)
    const ids = ordersAwaitingHand(db);
    if (!ids.length) return c.json([]);
    conds.push(inArray(schema.orders.id, ids));
  }
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
  // Lisans kapalıysa yeni adisyon açılmaz (Merkez); açık adisyonun tahsilatı sürer
  assertCanSell();
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

/**
 * Gönderim kimliği ilk kez mi geliyor: aynı işlemde kaydedilir (yazımla birlikte ya hep ya hiç). Bir günden eski
 * kimlikler silinir (tablet en çok birkaç dakika bekletir)
 */
function firstSend(t: Tx, orderId: string, batchId: string): boolean {
  const key = `gonderim:${batchId}`;
  if (t.select({ key: schema.syncState.key }).from(schema.syncState).where(eq(schema.syncState.key, key)).get()) return false;
  const now = Date.now();
  t.insert(schema.syncState).values({ key, value: { orderId, at: now }, updatedAt: now }).run();
  t.delete(schema.syncState).where(and(like(schema.syncState.key, 'gonderim:%'), lt(schema.syncState.updatedAt, now - 24 * 3600_000))).run();
  return true;
}

const optionPick = z.object({ itemId: z.string(), qty: z.number().int().min(0).max(9).optional() });

posRoutes.post('/orders/:id/items', async (c) => {
  assertCanSell();
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
      /** Tezgâh satışında "Öde": kalemler ödeme alınınca bara gider (holdsUntilPaid) */
      hold: z.boolean().optional(),
      /**
       * Tabletin gönderim kimliği: kasaya ulaşamayan gönderim aynı kimlikle yeniden gelir; ilk deneme yazılıp yanıtı
       * kaybolduysa ikinci kez yazılmaz (src/lib/cart.ts SendBatch)
       */
      clientBatchId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
      ...approver,
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => {
    if (input.clientBatchId && !firstSend(t, c.req.param('id'), input.clientBatchId)) return;
    orders.addItems(t, actor, fx, c.req.param('id'), input.items, { hold: input.hold ?? false });
  });
  return c.json(dto(c, c.req.param('id')));
});

/** Ödeme bekleyen kalemleri ödeme alınmadan bara gönderir ("Bara gönder") */
posRoutes.post('/orders/:id/release', (c) => {
  const actor = actorFrom(c);
  write((t, fx) => orders.sendHeld(t, actor, fx, c.req.param('id')));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/items/:itemId/void', async (c) => {
  const input = await body(c, z.object({ qty: z.number().int().min(1).optional(), reason, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  const before = lossOf('iptal', c.req.param('id')).value;
  write((t, fx) => orders.voidItem(t, actor, fx, c.req.param('id'), { itemId: c.req.param('itemId'), qty: input.qty, reason: input.reason }));
  // Büyük iptal patronun telefonuna (eşik Yönetim'de; Uzaktan kurulu değilse hiçbir şey)
  afterLoss('iptal', c.req.param('id'), before, actor.user.id);
  return c.json(dto(c, c.req.param('id')));
});

/** Gönderilmiş kaleme not (boş metin siler); bar fişi canlı güncellenir */
posRoutes.put('/orders/:id/items/:itemId/note', async (c) => {
  const input = await body(c, z.object({ note: z.string().max(200).nullable() }));
  const actor = actorFrom(c);
  write((t, fx) => orders.setItemNote(t, actor, fx, c.req.param('id'), c.req.param('itemId'), input.note));
  return c.json(dto(c, c.req.param('id')));
});

/** Ödenmezin kişisi: kayıtlı personel (`user`) ya da müşteri (`customer`); ödenmezde zorunlu, öteki türlerde reddedilir */
const compPerson = z.object({ kind: z.enum(['user', 'customer']), id: z.string().min(1).max(64) }).nullish();

posRoutes.post('/orders/:id/items/:itemId/comp', async (c) => {
  // kind: ikram (varsayılan), ödenmez ya da zayi; geri almada (undo) tür kalemin kendisinden
  const input = await body(
    c,
    z.object({ qty: z.number().int().min(1).optional(), reason, undo: z.boolean().optional(), kind: z.enum(['ikram', 'odenmez', 'zayi']).optional(), person: compPerson, ...approver }),
  );
  const actor = actorFrom(c, input.approverPin);
  const before = lossOf('ikram', c.req.param('id')).value;
  write((t, fx) =>
    orders.compItem(t, actor, fx, c.req.param('id'), { itemId: c.req.param('itemId'), qty: input.qty, reason: input.reason, undo: input.undo, kind: input.kind, person: input.person }),
  );
  if (!input.undo) afterLoss('ikram', c.req.param('id'), before, actor.user.id);
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/comp', async (c) => {
  const input = await body(c, z.object({ kind: z.enum(['ikram', 'odenmez', 'zayi']), reason, person: compPerson, ...approver }));
  const actor = actorFrom(c, input.approverPin);
  const before = lossOf('ikram', c.req.param('id')).value;
  write((t, fx) => orders.compOrder(t, actor, fx, c.req.param('id'), { kind: input.kind, reason: input.reason, person: input.person }));
  afterLoss('ikram', c.req.param('id'), before, actor.user.id);
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

/**
 * Hesap paylaşımı: kişi sayısı (2-30) ya da kaldırmak için null. `amounts` isteğe bağlı elle paylardır: ödenmemiş
 * payların tutarları sırayla, kuruş; sunucu doğrular (tam sayı, her biri > 0, toplam = kalan, adet = ödenmemiş pay)
 */
posRoutes.put('/orders/:id/split', async (c) => {
  const input = await body(c, z.object({ people: z.number().int().nullable(), amounts: z.array(z.number()).max(30).nullish() }));
  const actor = actorFrom(c);
  write((t, fx) => orders.setSplit(t, actor, fx, c.req.param('id'), input.people, input.amounts ?? null));
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

/** `bookingId`: sayacı sitedeki karaoke rezervasyonuna bağlar (oda kutusunun önerisi; docs/03-ENTEGRASYON.md §2.4) */
posRoutes.post('/orders/:id/room/start', async (c) => {
  const actor = actorFrom(c);
  const input = await body(c, z.object({ bookingId: z.string().min(1).max(64).nullish() }));
  write((t, fx) => startRoom(t, actor, fx, c.req.param('id'), { bookingId: input.bookingId ?? null }));
  return c.json(dto(c, c.req.param('id')));
});

posRoutes.post('/orders/:id/room/stop', async (c) => {
  const actor = actorFrom(c);
  // Ücret düğmeye basıldığı ana göre: aşağıdaki site okuması (en çok 8 sn) süreye eklenmesin
  const at = Date.now();
  // Rezervasyona bağlı sayaç: ücret rezervasyonun güncel durumuyla yazılsın (ödemesi bu arada tamamlanmış olabilir).
  // Liste geride kaldıysa bir çekim; site ulaşılamazsa eldeki listeyle (ya da bağlanırken saklananla) devam
  const running = orders.activeRoom(db, c.req.param('id'));
  if (running?.bookingId && siteKaraokeOn()) await refreshSiteKaraoke().catch(() => undefined);
  write((t, fx) => stopRoom(t, actor, fx, c.req.param('id'), { at }));
  return c.json(dto(c, c.req.param('id')));
});

/** Çalışan, rezervasyonsuz sayacı sitedeki bir karaoke rezervasyonuna bağlar (oda kutusu "Rezervasyona bağla"; §2.4) */
posRoutes.post('/orders/:id/room/link', async (c) => {
  const actor = actorFrom(c);
  const input = await body(c, z.object({ bookingId: z.string().min(1).max(64) }));
  write((t, fx) => linkRoom(t, actor, fx, c.req.param('id'), input.bookingId));
  return c.json(dto(c, c.req.param('id')));
});

// ─── Bar / mutfak ekranı ─────────────────────────────────────────────────────

/** Geçmiş aramasının metni (bar geçmişi, kapanan adisyonlar): kısa ve sınırlı */
const historyQuery = z.string().trim().max(HISTORY_QUERY_MAX).optional();

/**
 * `history=1` bar geçmişi: açık günün hazırlanan ve teslim edilen fişleri, en yeni üstte, en çok 100 (`limit`);
 * `q` günün bütün fişlerinde arar (no, masa, ürün). Geri alma `POST /kitchen/status` ile (yetki ve denetim orada)
 */
posRoutes.get('/kitchen', (c) => {
  const q = query(
    c,
    z.object({
      station: z.string().optional(),
      history: z.enum(['0', '1']).optional(),
      ready: z.enum(['0', '1']).optional(),
      q: historyQuery,
      limit: z.coerce.number().int().min(1).max(KITCHEN_HISTORY_MAX).default(KITCHEN_HISTORY_MAX),
    }),
  );
  const actor = actorFrom(c);
  if (!actor.user.permissions.has('mutfak.ekran') && !actor.user.permissions.has('siparis.al')) needDirect(actor, 'mutfak.ekran');
  if (q.history === '1') return c.json(kitchenHistory(db, { stationId: q.station || null, q: q.q, limit: q.limit }));
  return c.json(kitchenTickets(db, { stationId: q.station || null, ready: q.ready === '1' }));
});

// ─── Kapanan adisyonlar (Siparişler › Kapanan) ───────────────────────────────

/**
 * Kapanan adisyonlar: sayfalı (`limit` en çok 100, `before` imleci), aramalı (`q`: no, masa, müşteri, ürün). `date`
 * verilmezse bugün; başka gün rapor yetkisi ister (`rapor.gor`). Kör kasada ödeme türleri gelmez
 */
posRoutes.get('/history/orders', (c) => {
  const q = query(
    c,
    z.object({
      date: z.string().refine(isCalendarDate).optional(),
      q: historyQuery,
      limit: z.coerce.number().int().min(1).max(CLOSED_PAGE_MAX).default(CLOSED_PAGE_DEFAULT),
      before: z.string().regex(/^\d{1,16}_[A-Za-z0-9]{1,40}$/).optional(),
    }),
  );
  return c.json(closedOrders(db, c.get('user'), q));
});

/** Kapanan adisyonun ayrıntısı: kalemler, ödemeler (kör kasada gizli) ve yazarkasa fişi; önceki gün rapor yetkisi ister */
posRoutes.get('/history/orders/:id', (c) => c.json(closedOrderDetail(db, c.get('user'), c.req.param('id'))));


posRoutes.post('/kitchen/status', async (c) => {
  const input = await body(
    c,
    // "yeni"ye dönüş yok: başlamış kalemin başlama zamanı silinip onaysız iptal açılırdı (orders.setItemsStatus).
    // "servis" Teslim edildi; teslimden "hazir"a dönüş onun Geri al'ı
    z.object({ itemIds: z.array(z.string()).min(1).max(100), status: z.enum(['hazirlaniyor', 'hazir', 'servis']).optional() }),
  );
  const actor = actorFrom(c);
  write((t, fx) => orders.setItemsStatus(t, actor, fx, input));
  return c.json({ ok: true });
});

// ─── Seçenek tükendi ─────────────────────────────────────────────────────────

/**
 * Seçeneği kasada Tükendi yap / satışa aç (yulaf sütü bitti): ürünün Tükendi'siyle aynı yetki (`urun.tukendi` ya da
 * menü yetkisi). Yalnız LafPOS'ta; siteye gitmez
 */
posRoutes.post('/option-items/:id/sold-out', async (c) => {
  const user = c.get('user');
  if (!can(user, 'menu.yonet')) requirePermission(user, 'urun.tukendi');
  const input = await body(c, z.object({ soldOut: z.boolean() }));
  return c.json(write((t, fx) => setOptionSoldOut(t, fx, c.req.param('id'), input.soldOut, { id: user.id, name: user.name })));
});

export { write };
