import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { istanbulParts } from '@shared/time';
import type { FloorStateDTO, OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Denetim bulguları (adisyon yaşam döngüsü, karaoke odası, iptal, taşıma, gün sonu), her biri bir testle. Çalışan oda
 * sayacı faturalanacak ücrettir: kalem taşıma, iptal, cihaz ödemesi ya da gün sonu onu kaybettirmez; sayaç cihazda
 * bekleyen sepette ve sitede ödenmiş siparişte başlamaz. Masayı açmak sitede ödenmiş QR siparişini döndürmez; adisyon
 * iptali sipariş yetkisi ister; hazırlanmadan iptal edilen kalemin porsiyonu geri döner; boş adisyonlar otomatik gün
 * sonunu tutmaz.
 *
 * Bulgular: kalem taşıma state-03, money-11; iptal state-03, money-10; cihaz sepeti state-04, fiscal-26; sitede
 * ödenmiş sipariş input-67; masa açma sync-44; iptal yetkisi auth-57; porsiyon state-08. Gün sonu (state-02,
 * money-10'un gün sonu yarısı) ve otomatik gün sonu (state-06) 0e41785'te düzeldi (`isEmptyOrder`); testleri
 * gerilemeye karşı burada.
 *
 * İnceleme bulguları (27 Eki 2026): bir odada tek sayaç (aynı odada ayrı hesaba taşıma ya da "Yeni hesap" odayı iki kez
 * faturalamaz); indirimi kaldırmak sipariş yetkisi ister ve denetime yazılır (auth-57'nin eşi); başlamış kalem "yeni"ye
 * çekilip porsiyonu geri alınamaz (state-05/auth-55 ile aynı düzeltme, odeme-indirim dalıyla birebir).
 */
let h: Harness;
const MUDUR = PINS.mudur;

beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => {
  vi.useRealTimers();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const server = () => import('../server/db/client');

/** Planda tek karaoke odası var: her test kendi odasını ve masasını açar, birbirinin adisyonuna düşmez */
let tableNo = 0;
async function newTable(kind: 'masa' | 'oda', siteTableCode: string | null = null): Promise<string> {
  const { db, schema } = await server();
  const like = h.boot.tables.find((t) => t.kind === kind)!;
  const id = `test-${kind}-${++tableNo}`;
  db.insert(schema.tables)
    .values({ id, sectionId: like.sectionId, name: `${kind === 'oda' ? 'Oda' : 'Masa'} T${tableNo}`, kind, hourlyRate: kind === 'oda' ? 100000 : null, siteTableCode })
    .run();
  return id;
}

async function runningSessions(orderId: string) {
  const { db, schema } = await server();
  return db
    .select()
    .from(schema.roomSessions)
    .where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt)))
    .all();
}

async function roomOrder(items: { name: string; qty: number }[] = []) {
  const room = await newTable('oda');
  let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: room });
  if (items.length) o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty })) });
  return { room, order: o };
}

/** Kalanı ödenir; adisyon kapanmalı */
async function settle(orderId: string) {
  const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
  const res = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: method('Nakit').id, amount: o.total - o.paid });
  expect(res.closed).toBe(true);
}

let onlineNo = 0;
/** Sitenin masa QR, gel-al siparişleri (sitede ödenmiş); her çağrı listedeki siparişleri açık tutar */
async function siteOrders(list: { fulfillment: 'table' | 'pickup'; label: string }[]): Promise<string[]> {
  const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
  const { db, schema } = await server();
  const orders = list.map((o) => ({
    id: `ord-test-${++onlineNo}`,
    orderNo: 9000 + onlineNo,
    stage: 'new' as const,
    fulfillment: o.fulfillment,
    label: o.label,
    firstName: 'Ece',
    scheduledFor: '',
    note: '',
    paidAt: new Date().toISOString(),
    lines: [{ menuItemId: 'mnu-0007', name: 'Latte', size: 'M' as const, detail: '', note: '', qty: 1 }],
    totalMinor: 19500,
  }));
  upsertOnlineOrders(orders);
  return orders.map((o) => db.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.extId, o.id))).get()!.id);
}

async function auditFor(orderId: string) {
  const rows = await h.ok<{ action: string; severity: string; orderId: string | null; amount: number | null; approverName: string | null; message: string }[]>(
    'patron',
    'GET',
    '/admin/audit?limit=1000',
  );
  return rows.filter((a) => a.orderId === orderId);
}

describe('karaoke odası: çalışan sayaç faturalanacak ücrettir', () => {
  it('kalemlerin hepsi başka masaya taşınınca sayacı çalışan oda adisyonu kapanmaz; oda ücreti kaynağa yazılır', async () => {
    const { room, order: o } = await roomOrder([{ name: 'Türk kahvesi', qty: 2 }]);
    const other = await newTable('masa');
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`);
    // Garson masa.islem yetkisiyle, onaysız: bütün kalemler başka masaya
    const moved = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: o.items[0].id, qty: 2 }], tableId: other });
    expect(moved.source.status).toBe('acik');
    expect(moved.source.room?.endedAt).toBeNull();
    expect(moved.target).toMatchObject({ status: 'acik', tableId: other, room: null, total: 28000 });
    // Oda planda sayacıyla görünür; hedef yalnız kendi kalemlerini öder
    const floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.tables[room]?.map((f) => f.roomStartedAt)).toEqual([moved.source.room!.startedAt]);
    await settle(moved.target.id);
    // Sayaç durunca en az bir saat kaynağa yazılır ve alınır
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(stopped.total).toBe(100000);
    await settle(o.id);
    expect(await runningSessions(o.id)).toHaveLength(0);
  });

  it('aynı odada ayrı hesaba taşımada sayaç kalemlerle gider; başka odadaki adisyona taşımada kaynakta kalır', async () => {
    // "Aynı masada ayrı hesap", bütün kalemler: hedef de odada açılır, boşalan kaynak kapanır, sayaç hedefe geçer.
    // Kaynakta kalsaydı odanın kalemli hesabında "Oda sayacı kapalı · Başlat" görünür, ikinci sayaç başlatılırdı
    const { room, order: a } = await roomOrder([{ name: 'Türk kahvesi', qty: 1 }]);
    const started = (await h.ok<OrderDTO>('garson', 'POST', `/orders/${a.id}/room/start`)).room!;
    const split = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${a.id}/transfer`, { items: [{ itemId: a.items[0].id, qty: 1 }], tableId: room });
    expect(split.source).toMatchObject({ status: 'birlesti', room: null });
    expect(split.target).toMatchObject({ status: 'acik', tableId: room, total: 14000 });
    expect(split.target.room).toMatchObject({ id: started.id, startedAt: started.startedAt, endedAt: null });
    const floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.tables[room]?.map((f) => [f.id, f.roomStartedAt])).toEqual([[split.target.id, started.startedAt]]);

    // Kalemlerin bir kısmı aynı odada ayrı hesaba: sayaç kalemi kalan kaynağın
    const { room: room2, order: d } = await roomOrder([{ name: 'Türk kahvesi', qty: 2 }]);
    await h.ok('garson', 'POST', `/orders/${d.id}/room/start`);
    const part = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${d.id}/transfer`, { items: [{ itemId: d.items[0].id, qty: 1 }], tableId: room2 });
    expect(part.source).toMatchObject({ status: 'acik', total: 14000 });
    expect(part.source.room).not.toBeNull();
    expect(part.target).toMatchObject({ tableId: room2, room: null, total: 14000 });

    // Başka odadaki var olan adisyona (targetOrderId) taşıma: sayaç kendi odasının, kaynakta kalır
    const { order: b } = await roomOrder([{ name: 'Türk kahvesi', qty: 1 }]);
    await h.ok('garson', 'POST', `/orders/${b.id}/room/start`);
    const into = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${b.id}/transfer`, { items: [{ itemId: b.items[0].id, qty: 1 }], targetOrderId: split.target.id });
    expect(into.source.status).toBe('acik');
    expect(into.source.room).not.toBeNull();
    expect(into.target.total).toBe(28000);
    expect(into.target.room?.id).toBe(started.id);

    // Sayacı çalışmayan adisyon boşalınca eskisi gibi kapanır (birleşti)
    const { order: c } = await roomOrder([{ name: 'Türk kahvesi', qty: 1 }]);
    const plain = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${c.id}/transfer`, { items: [{ itemId: c.items[0].id, qty: 1 }], targetOrderId: split.target.id });
    expect(plain.source.status).toBe('birlesti');

    // Her oda bir kez faturalanır: sayaç durunca en az bir saat
    for (const id of [split.target.id, b.id, d.id]) {
      const before = await h.ok<OrderDTO>('garson', 'GET', `/orders/${id}`);
      const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${id}/room/stop`);
      expect(stopped.total - before.total).toBe(100000);
      await settle(id);
    }
    await settle(part.target.id);
  });

  it('bir odada aynı anda tek sayaç çalışır: odanın ikinci hesabında sayaç başlamaz, oda iki kez faturalanmaz', async () => {
    // Odada "Yeni hesap" (newCheck) ile ikinci adisyon: sayaç ilk hesapta çalışıyor
    const { room, order: a } = await roomOrder([{ name: 'Türk kahvesi', qty: 1 }]);
    await h.ok('garson', 'POST', `/orders/${a.id}/room/start`);
    const second = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: room, newCheck: true });
    expect(second.id).not.toBe(a.id);
    const start = await h.call<{ code: string; error: string }>('garson', 'POST', `/orders/${second.id}/room/start`);
    expect(start.status).toBe(409);
    expect(start.json.code).toBe('room_running');
    expect(start.json.error).toContain(`#${a.no}`);
    const { db, schema } = await server();
    const onRoom = () =>
      db
        .select()
        .from(schema.roomSessions)
        .where(and(eq(schema.roomSessions.tableId, room), isNull(schema.roomSessions.endedAt)))
        .all();
    expect(onRoom()).toHaveLength(1);
    // Aynı adisyonda ikinci başlatma da aynı kodla döner
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${a.id}/room/start`)).json.code).toBe('room_running');

    // Kalemler ayrı hesaba taşınıp kaynakta kalan bir kalem varken de hedefte ikinci sayaç başlamaz (inceleme bulgusu)
    await h.ok<OrderDTO>('garson', 'POST', `/orders/${a.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const split = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${a.id}/transfer`, { items: [{ itemId: a.items[0].id, qty: 1 }], tableId: room });
    expect(split.source.room).not.toBeNull();
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${split.target.id}/room/start`)).json.code).toBe('room_running');
    expect(onRoom()).toHaveLength(1);

    // Sayaç durunca oda bir kez yazılır; oda yeniden kullanılınca öteki hesapta başlar
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${a.id}/room/stop`);
    expect(stopped.items.filter((i) => i.isService).map((i) => i.unitPrice)).toEqual([100000]);
    await settle(a.id);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${second.id}/room/start`)).room).not.toBeNull();
    expect(onRoom()).toHaveLength(1);
    await h.ok('garson', 'POST', `/orders/${second.id}/room/stop`);
    await settle(second.id);
    await settle(split.target.id);
  });

  it('sayacı çalışan oda adisyonu iptal edilmez; durdurulan oda ücreti ancak yetkili onayıyla ve denetime yazılarak iptal edilir', async () => {
    const { order: o } = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`);
    // Kalemsiz görünen adisyon: eskiden onaysız, nedensiz "boş adisyon" diye iptal ediliyor, sayaç sonsuza dek kalıyordu
    for (const who of ['garson', 'mudur']) {
      const r = await h.call<{ code: string }>(who, 'POST', `/orders/${o.id}/cancel`, { reason: '' });
      expect(r.status, who).toBe(409);
      expect(r.json.code, who).toBe('room_running');
    }
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    expect(await runningSessions(o.id)).toHaveLength(1);

    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(stopped.total).toBe(100000);
    // Oda ücreti gönderilmiş kalem sayılır: iptali yetkili onayı ve neden ister
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/cancel`, { reason: 'Yanlış odada başlatıldı' })).json.code).toBe('approval_required');
    const cancelled = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/cancel`, { reason: 'Yanlış odada başlatıldı', approverPin: MUDUR });
    expect(cancelled.status).toBe('iptal');
    expect((await auditFor(o.id)).find((a) => a.action === 'order.cancel')).toMatchObject({ severity: 'uyari', amount: 100000, approverName: 'Müdür' });
  });

  it('gün sonu sayacı çalışan kalemsiz oda adisyonunu boş sayıp iptal etmez', async () => {
    const { order: o } = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`);
    const r = await h.call<{ code: string; error: string }>('mudur', 'POST', '/cash/day/close', { countedCash: null });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('open_orders');
    expect(r.json.error).toContain(`#${o.no}`);
    const after = await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`);
    expect(after.status).toBe('acik');
    expect(after.room?.endedAt).toBeNull();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/stop`);
    await settle(o.id);
  });

  it('sepeti yazarkasada bekleyen adisyonda oda sayacı başlamaz; cihaz ödemesi adisyonu sayaçsız kapatır', async () => {
    const { order: o } = await roomOrder([{ name: 'Türk kahvesi', qty: 2 }]);
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    const start = await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/room/start`);
    expect(start.status).toBe(409);
    expect(start.json.code).toBe('okc_pending');
    expect(await runningSessions(o.id)).toHaveLength(0);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    expect(await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).toMatchObject({ status: 'kapali', paid: 28000, room: null });
  });

  it('sayaç çalışırken yazarkasada gelen ödeme adisyonu kapatmaz: uyarı düşer, oda ücreti sonra yazılıp alınır', async () => {
    const { order: o } = await roomOrder([{ name: 'Türk kahvesi', qty: 1 }]);
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    // Eski veride (ya da gönderimi hata görünen sepette) sayaç sepet beklerken başlamış olabilir
    const { db, schema } = await server();
    const row = db.select().from(schema.orders).where(eq(schema.orders.id, o.id)).get()!;
    db.insert(schema.roomSessions).values({ id: `oturum-${o.id}`, orderId: o.id, tableId: row.tableId!, hourlyRate: 100000, startedAt: Date.now() - 30 * 60_000 }).run();
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    const after = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(after).toMatchObject({ status: 'acik', total: 14000, paid: 14000 });
    expect(after.room?.endedAt).toBeNull();
    expect((await auditFor(o.id)).find((a) => a.action === 'okc.room_running')).toMatchObject({ severity: 'uyari' });
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(stopped.total - stopped.paid).toBe(100000);
    await settle(o.id);
  });

  it('sitede ödenmiş siparişte oda sayacı çalışmaz; sipariş odaya taşınmaz, kasadan kapatılmaz (kural 7)', async () => {
    const room = await newTable('oda', 'Karaoke QR');
    const [atRoom, pickup] = await siteOrders([
      { fulfillment: 'table', label: 'Karaoke QR' },
      { fulfillment: 'pickup', label: 'Gel-al' },
    ]);
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${atRoom}`)).tableId).toBe(room);
    const start = await h.call<{ code: string }>('garson', 'POST', `/orders/${atRoom}/room/start`);
    expect(start.status).toBe(409);
    expect(start.json.code).toBe('online_order');
    expect(await runningSessions(atRoom)).toHaveLength(0);

    // Eski veride çalışan sayaç: durdurmak sitede ödenmiş siparişe kasa tutarı yazmaz
    const { db, schema } = await server();
    db.insert(schema.roomSessions).values({ id: `oturum-${atRoom}`, orderId: atRoom, tableId: room, hourlyRate: 100000, startedAt: Date.now() - 60 * 60_000 }).run();
    const stop = await h.call<{ code: string }>('garson', 'POST', `/orders/${atRoom}/room/stop`);
    expect(stop.status).toBe(409);
    expect(stop.json.code).toBe('online_order');
    const still = await h.ok<OrderDTO>('garson', 'GET', `/orders/${atRoom}`);
    expect(still.total).toBe(0);
    expect(still.items.map((i) => i.name)).toEqual(['Latte']);
    db.delete(schema.roomSessions).where(eq(schema.roomSessions.id, `oturum-${atRoom}`)).run();

    // Masa taşı: gel-al siparişi odaya taşınıp "masa" adisyonuna dönmez
    const other = await newTable('oda');
    const move = await h.call<{ code: string }>('garson', 'POST', `/orders/${pickup}/move`, { tableId: other });
    expect(move.status).toBe(409);
    expect(move.json.code).toBe('online_order');
    expect(await h.ok<OrderDTO>('garson', 'GET', `/orders/${pickup}`)).toMatchObject({ type: 'online', tableId: null });
    // Kasadan kapatma: siparişin aşaması sitenin, kapanışı senkronun
    const close = await h.call<{ code: string }>('kasa', 'POST', `/orders/${pickup}/close`);
    expect(close.status).toBe(409);
    expect(close.json.code).toBe('online_order');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${pickup}`)).status).toBe('acik');
  });
});

describe('masa açma ve adisyon iptali', () => {
  it('sitede ödenmiş QR siparişi olan masayı açmak kasa adisyonu açar; kişi sayısı ve not kaybolmaz', async () => {
    const table = await newTable('masa', 'QR 7');
    const [qr] = await siteOrders([{ fulfillment: 'table', label: 'QR 7' }]);
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${qr}`)).tableId).toBe(table);
    // Rezervasyonda "geldi" ve masa planı: POST /orders {type: 'masa', tableId}
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table, guests: 3, note: 'Rezervasyon: Ali' });
    expect(o.id).not.toBe(qr);
    expect(o).toMatchObject({ source: 'pos', extPaid: false, guests: 3, note: 'Rezervasyon: Ali' });
    await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    // Masada kasa adisyonu varken masayı açmak onu döndürür (QR siparişi daha önce açılmış olsa da)
    expect((await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table })).id).toBe(o.id);
    await settle(o.id);
  });

  it('adisyon iptali sipariş yetkisi ister: bar ekranı başkasının boş adisyonunu iptal edemez', async () => {
    const table = await newTable('masa');
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table, guests: 3 });
    const r = await h.call<{ code: string; permission: string }>('bar', 'POST', `/orders/${o.id}/cancel`, { reason: '' });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'forbidden', permission: 'siparis.al' });
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    // Siparişi alan kişi boş adisyonu onaysız kapatır
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/cancel`, { reason: '' })).status).toBe('iptal');
  });
});

describe('indirim kaldırma', () => {
  it('adisyon indirimini kaldırmak sipariş yetkisi ister ve denetime yazılır', async () => {
    const table = await newTable('masa');
    let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 2 }] });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 50, reason: 'Sürekli müşteri', approverPin: MUDUR });
    expect(o.total).toBe(14000);
    // Bar ekranı (sipariş yetkisi yok) başkasının adisyonundaki onaylı indirimi kaldıramaz: ne remove ne sıfır değer
    for (const body of [{ type: 'percent', value: 0, reason: '', remove: true }, { type: 'amount', value: 0, reason: '' }]) {
      const r = await h.call<{ code: string; permission: string }>('bar', 'POST', `/orders/${o.id}/discount`, body);
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ code: 'forbidden', permission: 'siparis.al' });
    }
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`)).total).toBe(14000);
    expect((await auditFor(o.id)).map((a) => a.action)).toEqual(['order.discount']);

    // Siparişi alan kişi kaldırır: hesap eski tutarına döner, kaldırılan indirim denetimde görünür
    const removed = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 0, reason: '', remove: true });
    expect(removed).toMatchObject({ total: 28000, discountType: null });
    expect((await auditFor(o.id)).find((a) => a.action === 'order.discount_removed')).toMatchObject({ amount: 14000, approverName: null });
    // İndirimsiz adisyonda "kaldır" denetime bir şey yazmaz
    await h.ok('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 0, reason: '', remove: true });
    expect((await auditFor(o.id)).filter((a) => a.action === 'order.discount_removed')).toHaveLength(1);
    await settle(o.id);
  });

  it('kalem indirimini kaldırmak sipariş yetkisi ister ve denetime yazılır', async () => {
    const table = await newTable('masa');
    let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const itemId = o.items[0].id;
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items/${itemId}/discount`, { type: 'percent', value: 50, reason: 'Sürekli müşteri', approverPin: MUDUR });
    expect(o.total).toBe(7000);
    const r = await h.call<{ code: string; permission: string }>('bar', 'POST', `/orders/${o.id}/items/${itemId}/discount`, { type: 'amount', value: 0, reason: '' });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'forbidden', permission: 'siparis.al' });
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`)).total).toBe(7000);

    const removed = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items/${itemId}/discount`, { type: 'amount', value: 0, reason: '' });
    expect(removed.total).toBe(14000);
    const rows = await auditFor(o.id);
    expect(rows.map((a) => a.action).sort()).toEqual(['item.discount', 'item.discount_removed']);
    expect(rows.find((a) => a.action === 'item.discount_removed')).toMatchObject({ amount: 7000 });
    await settle(o.id);
  });
});

describe('porsiyon sayacı', () => {
  async function productRow(id: string) {
    const { db, schema } = await server();
    const p = db.select().from(schema.products).where(eq(schema.products.id, id)).get()!;
    return { active: p.active, portionsLeft: p.portionsLeft };
  }

  it('hazırlanmadan iptal edilen kalemin porsiyonu geri döner, ürün yeniden satışa açılır (site de); hazırlanmış kalemde dönmez', async () => {
    const cake = product('San Sebastian');
    expect(cake.extSource).toBe('laffogato');
    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 1 });
    const { bus } = await import('../server/lib/events');
    const seen: LiveEvent[] = [];
    const listen = (e: LiveEvent) => seen.push(e);

    // Son porsiyon yanlışlıkla girildi: aynı kasiyer hemen iptal eder (hiçbir şey hazırlanmadı)
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: cake.id, qty: 1 }] });
    expect(o.items[0].status).toBe('yeni');
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    bus.on('event', listen);
    try {
      await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { reason: 'Yanlış ürün' });
    } finally {
      bus.off('event', listen);
    }
    expect(await productRow(cake.id)).toEqual({ active: true, portionsLeft: 1 });
    expect(seen.some((e) => e.topic === 'menu' && e.kind === 'product.available')).toBe(true);
    expect(seen.some((e) => e.topic === 'sync' && e.kind === 'availability.push' && e.message === cake.id)).toBe(true);

    // Porsiyonla tükenen ürün sitede de yeniden satışa açılır: site ürünün güncel durumunu alır
    const bodies: unknown[] = [];
    const site = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/panel/menu') bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const { env } = await import('../server/env');
    const saved = { laffogatoUrl: env.laffogatoUrl, laffogatoPanelSecret: env.laffogatoPanelSecret };
    Object.assign(env, { laffogatoUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}`, laffogatoPanelSecret: 's'.repeat(40) });
    try {
      const { pushSoldOut } = await import('../server/sync/laffogato-orders');
      await pushSoldOut([cake.id]);
    } finally {
      Object.assign(env, saved);
      site.close();
    }
    expect(bodies).toEqual([{ id: cake.extId, isActive: true, actor: 'LafPOS porsiyon' }]);

    // Geri dönen porsiyon satılır; bar hazırlamaya başladıktan sonraki iptal fire sayılır, porsiyon dönmez
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: cake.id, qty: 1 }] });
    const sold = o.items.find((i) => !i.voided)!;
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [sold.id], status: 'hazirlaniyor' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${sold.id}/void`, { reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    await h.ok('kasa', 'POST', `/orders/${o.id}/close`);
  });

  it('yanlış giriş penceresi geçmiş ama hazırlanmamış kalemin onaylı iptalinde ve adisyon iptalinde de porsiyon döner', async () => {
    const cake = product('San Sebastian');
    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 5 });
    const { db, schema } = await server();

    // İki dakikadan eski, bar başlamamış kalem: iptal yetkili onayı ister, porsiyon yine döner
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: cake.id, qty: 2 }] });
    db.update(schema.orderItems).set({ sentAt: Date.now() - 10 * 60_000 }).where(eq(schema.orderItems.id, o.items[0].id)).run();
    expect(await productRow(cake.id)).toEqual({ active: true, portionsLeft: 3 });
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { qty: 1, reason: 'Müşteri vazgeçti' })).json.code).toBe('approval_required');
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { qty: 1, reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    expect(await productRow(cake.id)).toEqual({ active: true, portionsLeft: 4 });

    // Adisyon iptali: hazırlanmamış kalanı da geri döner
    await h.ok('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Müşteri gitti', approverPin: MUDUR });
    expect(await productRow(cake.id)).toEqual({ active: true, portionsLeft: 5 });

    // Taze adisyon iptali (onaysız): son porsiyonlar geri gelir, ürün yeniden satışta
    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 2 });
    let f = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    f = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${f.id}/items`, { items: [{ productId: cake.id, qty: 2 }] });
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    expect((await h.ok<OrderDTO>('kasa', 'POST', `/orders/${f.id}/cancel`, { reason: 'Yanlış adisyon' })).status).toBe('iptal');
    expect(await productRow(cake.id)).toEqual({ active: true, portionsLeft: 2 });

    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: null });
  });

  it('hazırlanmış ya da servis edilmiş kalem "yeni"ye çekilemez: iptalinde porsiyon dönmez, ürün Tükendi kalır', async () => {
    const cake = product('San Sebastian');
    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 2 });
    const { bus } = await import('../server/lib/events');
    const seen: LiveEvent[] = [];
    const listen = (e: LiveEvent) => seen.push(e);
    const table = await newTable('masa');
    let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, {
      items: [
        { productId: cake.id, qty: 1 },
        { productId: cake.id, qty: 1, note: 'Ayrı tabak' },
      ],
    });
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    const [ready, served] = o.items;
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [ready.id, served.id], status: 'hazir' });
    await h.ok('garson', 'POST', '/kitchen/status', { itemIds: [served.id], status: 'servis' });

    // Garson (yalnız siparis.al) ya da bar kalemi bekleyene çekip "hiç başlanmamış" gösteremez: başlama zamanı kalır
    for (const who of ['garson', 'bar']) {
      const r = await h.call(who, 'POST', '/kitchen/status', { itemIds: [ready.id, served.id], status: 'yeni' });
      expect(r.status, who).toBe(422);
    }
    const after = await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`);
    expect(after.items.map((i) => i.status)).toEqual(['hazir', 'servis']);

    // İptal yetkili onayı ister (hazırlanmış kalem); onaylı iptalde porsiyon dönmez, ürün POS'ta ve sitede Tükendi kalır
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/items/${served.id}/void`, { reason: 'Vazgeçti' })).json.code).toBe('approval_required');
    bus.on('event', listen);
    try {
      for (const it of [ready, served]) await h.ok('garson', 'POST', `/orders/${o.id}/items/${it.id}/void`, { reason: 'Vazgeçti', approverPin: MUDUR });
    } finally {
      bus.off('event', listen);
    }
    expect(await productRow(cake.id)).toEqual({ active: false, portionsLeft: 0 });
    expect(seen.filter((e) => (e.topic === 'menu' && e.kind === 'product.available') || (e.topic === 'sync' && e.kind === 'availability.push'))).toEqual([]);

    await h.ok('garson', 'POST', `/orders/${o.id}/cancel`, { reason: '' });
    await h.ok('patron', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: null });
  });
});

describe('otomatik gün sonu', () => {
  // Günü kapattığı için en sonda
  it('satış sonrası açılan boş tezgâh ve boş masa adisyonu otomatik gün sonunu tutmaz; sayacı çalışan oda tutar', async () => {
    const { db, schema } = await server();
    const at = Math.ceil((Date.now() + 1) / 3600_000) * 3600_000 + 30_000;
    await h.ok('patron', 'PUT', '/admin/settings', { autoDayEnd: true, autoDayEndHour: istanbulParts(at).hour, menuAutoSync: false, onlineOrdersSync: false });

    // Gecenin son tezgâh satışı, ardından kasa ekranının açtığı boş "Yeni satış" ve dokunulup boş bırakılan masa
    let sale = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    sale = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${sale.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    await settle(sale.id);
    const next = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: sale.id });
    const tapped = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: await newTable('masa') });
    // Kalemsiz ama sayacı çalışan oda boş değildir
    const { order: room } = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${room.id}/room/start`);

    const day = db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get()!;
    const busy = db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos')))
      .all()
      .filter((o) => ![next.id, tapped.id, room.id].includes(o.id) && db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id)).all().length);
    expect(busy.map((o) => o.no), 'önceki testlerden açık kalan dolu adisyon').toEqual([]);
    db.update(schema.businessDays).set({ openedAt: at - 4 * 3600_000 }).where(eq(schema.businessDays.id, day.id)).run();

    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(at);
    delete process.env.LAFPOS_NO_JOBS;
    const { startJobs, stopJobs } = await import('../server/jobs');
    startJobs();
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      const skip = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'day.auto_skip')).all();
      expect(skip.map((a) => a.message)).toEqual(['Otomatik gün sonu alınamadı: 1 açık adisyon var']);
      expect(db.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!.closedAt).toBeNull();
      expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${room.id}`)).status).toBe('acik');

      await h.ok('garson', 'POST', `/orders/${room.id}/room/stop`);
      await settle(room.id);
      await vi.advanceTimersByTimeAsync(60_000);
      const closed = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!;
      expect(closed.closedAt).not.toBeNull();
      expect(closed.note).toBe('Otomatik gün sonu');
      for (const id of [next.id, tapped.id]) {
        expect(await h.ok<OrderDTO>('patron', 'GET', `/orders/${id}`)).toMatchObject({ status: 'iptal', cancelReason: 'Boş adisyon (gün sonu)' });
      }
    } finally {
      stopJobs();
      process.env.LAFPOS_NO_JOBS = '1';
      vi.useRealTimers();
    }
  });
});
