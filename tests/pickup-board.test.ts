import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LiveEvent, readyAlertFor } from '@shared/events';
import type { PlatformOrderPayload } from '@shared/platforms';
import type { FloorStateDTO, KitchenTicket, OrderDTO, PickupBoardDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** Çağrı ekranı: tezgâh ve gel-al siparişleri "Hazırlanıyor"dan "Hazır"a geçer; masa siparişi görünmez */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;

describe('çağrı ekranı', () => {
  it('hazırlanıyor → hazır → teslim; masa siparişi yok; hazır 10 dakika sonra düşer', async () => {
    const counter = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${counter.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    const pickup = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Ayşe Yılmaz' });
    await h.ok('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const table = h.boot.tables.find((t) => t.kind !== 'oda')!;
    const dine = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id });
    await h.ok('garson', 'POST', `/orders/${dine.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });

    let board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.map((e) => e.no).sort()).toEqual([counter.no, pickup.no].sort());
    // Yalnız ad: soyadı çağrı ekranına çıkmaz
    expect(board.preparing.find((e) => e.id === pickup.id)?.name).toBe('Ayşe');
    expect(board.preparing.some((e) => e.id === dine.id)).toBe(false);

    const ids = sent.items.map((i) => i.id);
    // "Hazır" siparişi alan kişiye uyarı olarak gider
    const { bus } = await import('../server/lib/events');
    const seen: { kind: string; message?: string; forUserId?: string }[] = [];
    const listen = (e: { kind: string; message?: string; forUserId?: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazir' });
    bus.off('event', listen);
    const alert = seen.find((e) => e.kind === 'items.ready');
    expect(alert?.message).toBe(`Tezgâh #${counter.no} · 1 ürün hazır`);
    expect(alert?.forUserId).toBe(counter.waiterId);
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.map((e) => e.id)).toEqual([counter.id]);
    expect(board.preparing.map((e) => e.id)).toEqual([pickup.id]);

    const { pickupBoard, PICKUP_READY_MS } = await import('../server/services/floor');
    const { db } = await import('../server/db/client');
    expect(pickupBoard(db, Date.now() + PICKUP_READY_MS + 1000).ready).toEqual([]);

    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'servis' });
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready).toEqual([]);
    // Eski oturumlu uç yok; çağrı ekranı oturumsuz okur
    expect((await h.call('bar', 'GET', '/kitchen/board')).status).toBe(404);
  });

  it('paket platformunun gel-al siparişi platformun koduyla; Siparişler\'de teslim edilince düşer, bar ekranının Hazır sekmesine gelmez', async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
    const service = await import('../server/delivery/service');
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    const lines = [{ externalId: 'ys-latte', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: [], note: null }];
    const payload: PlatformOrderPayload = {
      platform: 'yemeksepeti',
      simulated: true,
      externalId: `ys-${Math.random()}`,
      code: 'K9TX',
      placedAt: Date.now(),
      scheduledFor: null,
      courier: 'gelal',
      platformCollects: true,
      paymentLabel: 'Online kart',
      customer: { name: 'Deniz Öztürk', phone: null, address: null },
      note: null,
      lines,
      subtotal: 19000,
      restaurantDiscount: 0,
      platformDiscount: 0,
      customerTotal: 19000,
    };
    const fx = new Effects();
    const { row } = tx((t) => service.ingestPlatformOrder(t, fx, payload));
    fx.flush();
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const order = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect(order.type).toBe('gelal');

    let board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    // Müşteri LafPOS numarasını bilmez, platformun kodunu bilir
    expect(board.preparing.find((e) => e.id === orderId)).toMatchObject({ code: 'K9TX', platform: 'yemeksepeti', name: 'Deniz' });
    // Hazır uyarısı platform bilgisini taşır: paket yetkili her cihazda çalar (kabul eden kafede olmayabilir)
    const { bus } = await import('../server/lib/events');
    const seen: LiveEvent[] = [];
    const listen = (e: LiveEvent) => seen.push(e);
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: order.items.map((i) => i.id), status: 'hazir' });
    bus.off('event', listen);
    const alert = seen.find((e) => e.kind === 'items.ready');
    expect(alert).toMatchObject({ platform: 'yemeksepeti', message: 'Yemeksepeti K9TX · 1 ürün hazır', forUserId: order.waiterId });
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.find((e) => e.id === orderId)?.code).toBe('K9TX');
    // Platform siparişinin teslimi kendi akışında (Siparişler): bar ekranının Hazır sekmesinde düğmesi yok
    const ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    expect(ready.some((tk) => tk.orderId === orderId)).toBe(false);

    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect([...board.preparing, ...board.ready].some((e) => e.id === orderId)).toBe(false);
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'kapali' });
  });

  it('bar ekranının Hazır sekmesi: teslim edilmeyen hazır siparişler; Teslim edildi düşürür, Geri al geri getirir', async () => {
    const { bus } = await import('../server/lib/events');
    const { db, schema } = await import('../server/db/client');
    const { eq, inArray } = await import('drizzle-orm');
    const counter = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const c = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${counter.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 2 }] });
    const pickup = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Can Demir' });
    const p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const table = h.boot.tables.filter((t) => t.kind !== 'oda')[1];
    const dine = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id });
    const d = await h.ok<OrderDTO>('garson', 'POST', `/orders/${dine.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const ids = (o: OrderDTO) => o.items.map((i) => i.id);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [...ids(c), ...ids(p), ...ids(d)], status: 'hazir' });

    // Sipariş başına tek fiş, en uzun bekleyen önce; garson da görür (siparis.al)
    let ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    for (const o of [counter, pickup, dine]) expect(ready.find((tk) => tk.orderId === o.id)?.key).toBe(`${o.id}:hazir`);
    expect((await h.ok<KitchenTicket[]>('garson', 'GET', '/kitchen?ready=1')).length).toBe(ready.length);
    // Aktif fişlerde yok (hazır), geçmişte var
    expect((await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen')).some((tk) => tk.orderId === counter.id)).toBe(false);
    let floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.tables[table.id]?.[0]?.readyToServe).toBe(1);
    // Kasanın gel-al siparişinin aşaması bardan izler: hepsi hazır olunca "Hazır"
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('hazir');

    const readyAt = (o: OrderDTO) => db.select().from(schema.orderItems).where(inArray(schema.orderItems.id, ids(o))).all();
    const before = readyAt(p).map((i) => i.readyAt);
    const seen: { kind: string; topic: string; orderId?: string }[] = [];
    const listen = (e: { kind: string; topic: string; orderId?: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [...ids(c), ...ids(p), ...ids(d)], status: 'servis' });
    bus.off('event', listen);
    expect(readAll(readyAt(p))).toEqual([{ status: 'servis', served: true }]);
    ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    expect(ready.filter((tk) => [counter.id, pickup.id, dine.id].includes(tk.orderId))).toEqual([]);
    let board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect([...board.ready, ...board.preparing].some((e) => e.id === counter.id || e.id === pickup.id)).toBe(false);
    // Masa karosundaki "N hazır" teslimle düşer
    floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.tables[table.id]?.[0]?.readyToServe).toBe(0);
    // Kasanın gel-al siparişi de teslim aşamasına geçer (Siparişler'de ikinci düğme kalmaz); denetim kaydında
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('teslim');
    expect(seen.some((e) => e.topic === 'delivery' && e.orderId === pickup.id)).toBe(true);
    let audit = await h.ok<{ action: string; orderId: string | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.some((a) => a.action === 'delivery.done' && a.orderId === pickup.id)).toBe(true);

    // Geri al: hazır anı korunur, hazır uyarısı yinelenmez, gel-al "Hazır"a döner
    seen.length = 0;
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [...ids(c), ...ids(p)], status: 'hazir' });
    bus.off('event', listen);
    expect(seen.some((e) => e.kind === 'items.ready')).toBe(false);
    expect(readyAt(p).map((i) => i.readyAt)).toEqual(before);
    expect(readAll(readyAt(p))).toEqual([{ status: 'hazir', served: false }]);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('hazir');
    audit = await h.ok<{ action: string; orderId: string | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.some((a) => a.action === 'delivery.undo' && a.orderId === pickup.id)).toBe(true);
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.map((e) => e.id)).toEqual(expect.arrayContaining([counter.id, pickup.id]));
    ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    expect(ready.map((tk) => tk.orderId)).toEqual(expect.arrayContaining([counter.id, pickup.id]));

    // Hazır sekmesi son 30 dakikayı gösterir
    const old = Date.now() - 31 * 60_000;
    db.update(schema.orderItems).set({ readyAt: old }).where(eq(schema.orderItems.orderId, counter.id)).run();
    ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    expect(ready.some((tk) => tk.orderId === counter.id)).toBe(false);
  });
});

describe('hazır uyarısı kimde çalar (readyAlertFor)', () => {
  const ready = (over: Partial<LiveEvent> = {}): LiveEvent => ({ seq: 1, at: 0, topic: 'orders', kind: 'items.ready', message: 'Bahçe 4 · 2 ürün hazır', forUserId: 'garson', byUserId: 'bar', ...over });
  const kasiyer = { id: 'kasa', permissions: ['siparis.al', 'odeme.al', 'paket.yonet'] };
  const garson = { id: 'garson', permissions: ['siparis.al'] };
  const patron = { id: 'patron', permissions: ['siparis.al', 'paket.yonet', 'rapor.maliyet'] };

  it('elle alınan sipariş: yalnız siparişi alan; "Hazır"a basan kendi ekranında görmez', () => {
    expect(readyAlertFor(ready(), garson)).toBe(true);
    expect(readyAlertFor(ready(), kasiyer)).toBe(false);
    expect(readyAlertFor(ready({ byUserId: 'garson' }), garson)).toBe(false);
    expect(readyAlertFor(ready({ kind: 'ticket.status' }), garson)).toBe(false);
  });

  it('platform siparişi: kabul eden (otomatik kabulde kafede olmayan patron) ve paket yetkili her cihaz; garson değil', () => {
    const e = ready({ platform: 'getir', forUserId: 'patron', message: 'Getir Yemek 4821 · 1 ürün hazır' });
    expect(readyAlertFor(e, kasiyer)).toBe(true);
    expect(readyAlertFor(e, patron)).toBe(true);
    expect(readyAlertFor(e, garson)).toBe(false);
    // Kabul edeni olmayan (eski kayıt) platform siparişi de kasaya düşer
    expect(readyAlertFor({ ...e, forUserId: undefined }, kasiyer)).toBe(true);
    expect(readyAlertFor({ ...e, byUserId: 'kasa' }, kasiyer)).toBe(false);
  });
});

describe('teslimden sonra eklenen kalem', () => {
  const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
  const board = () => h.ok<PickupBoardDTO>('', 'GET', '/public/board');
  const where = async (id: string) => {
    const b = await board();
    return b.ready.some((e) => e.id === id) ? 'hazir' : b.preparing.some((e) => e.id === id) ? 'hazirlaniyor' : null;
  };
  const audits = () => h.ok<{ action: string; orderId: string | null }[]>('patron', 'GET', '/admin/audit?limit=100');

  it('teslim edilmiş gel-al\'a bar kalemi: çağrı ekranında Hazırlanıyor, hazır olunca Hazır sekmesinde ve Teslim edildi düğmesinde; aşama kalemlerden', async () => {
    const { readyToHand } = await import('../src/lib/readyToHand');
    const pickup = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Ece Kaya' });
    const first = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const firstIds = first.items.map((i) => i.id);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: firstIds, status: 'hazir' });
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: firstIds, status: 'servis' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('teslim');
    expect(await where(pickup.id)).toBeNull();

    // Müşteri bir şey daha ister: aynı adisyona bar kalemi. Teslim geri alınır (denetimde), sipariş yeniden hazırlanıyor
    const more = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    expect(more.deliveryStatus).toBe('hazirlaniyor');
    expect((await audits()).filter((a) => a.action === 'delivery.undo' && a.orderId === pickup.id)).toHaveLength(1);
    expect(await where(pickup.id)).toBe('hazirlaniyor');
    expect(readyToHand(more)).toEqual([]);

    const newIds = more.items.filter((i) => !firstIds.includes(i.id)).map((i) => i.id);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: newIds, status: 'hazir' });
    let o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`);
    expect(o.deliveryStatus).toBe('hazir');
    expect(await where(pickup.id)).toBe('hazir');
    // Kasada Teslim edildi düğmesi yalnız yeni kalem için; bar ekranının Hazır sekmesinde de yalnız o
    expect(readyToHand(o)).toEqual(newIds);
    const ready = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?ready=1');
    expect(ready.find((tk) => tk.orderId === pickup.id)?.items.map((i) => i.id)).toEqual(newIds);

    // Bar Geçmiş'ten Geri al (hazır → hazırlanıyor): aşama da Hazırlanıyor'a döner, Siparişler'de "Hazır" rozeti kalmaz
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: newIds, status: 'hazirlaniyor' });
    o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`);
    expect(o.deliveryStatus).toBe('hazirlaniyor');
    expect(readyToHand(o)).toEqual([]);
    expect(await where(pickup.id)).toBe('hazirlaniyor');

    // Yeniden hazır ve teslim: sipariş yine teslim edildi, çağrı ekranından düşer
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: newIds, status: 'hazir' });
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: newIds, status: 'servis' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('teslim');
    expect(await where(pickup.id)).toBeNull();
  });

  it('kapanmış ve teslim edilmiş gel-al yeniden açılıp kalem eklenince yine çağrı ekranında; bekleyen kalem iptal edilince kalanlardan', async () => {
    const pickup = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Mert Can' });
    const first = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const firstIds = first.items.map((i) => i.id);
    await h.ok('kasa', 'POST', `/orders/${pickup.id}/payments`, { methodId: method('Nakit').id, amount: first.total });
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: firstIds, status: 'hazir' });
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: firstIds, status: 'servis' });
    let o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`);
    expect([o.status, o.deliveryStatus]).toEqual(['kapali', 'teslim']);

    await h.ok('patron', 'POST', `/orders/${pickup.id}/reopen`, { reason: 'Müşteri ekledi' });
    const more = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${pickup.id}/items`, {
      items: [
        { productId: product('Latte').id, size: 'M', qty: 1 },
        { productId: product('Türk Kahvesi').id, qty: 1 },
      ],
    });
    expect(more.deliveryStatus).toBe('hazirlaniyor');
    expect(await where(pickup.id)).toBe('hazirlaniyor');
    const [latte, turk] = more.items.filter((i) => !firstIds.includes(i.id));
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [latte!.id], status: 'hazir' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`)).deliveryStatus).toBe('hazirlaniyor');
    // Bekleyen son kalem iptal edilince kalanların hepsi hazır: "Hazır"
    await h.ok('kasa', 'POST', `/orders/${pickup.id}/items/${turk!.id}/void`, { reason: 'Vazgeçti' });
    o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup.id}`);
    expect(o.deliveryStatus).toBe('hazir');
    expect(await where(pickup.id)).toBe('hazir');
  });
});

/** Kalemlerin durumu ve teslim zamanının yazılıp yazılmadığı (tekilleştirilmiş) */
function readAll(rows: { status: string; servedAt: number | null }[]) {
  const seen = new Map<string, { status: string; served: boolean }>();
  for (const r of rows) seen.set(`${r.status}|${r.servedAt != null}`, { status: r.status, served: r.servedAt != null });
  return [...seen.values()];
}
