import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClosedOrderDetailDTO, ClosedOrdersDTO } from '@shared/history';
import { foldTr, matchesTerms, searchTerms } from '@shared/search';
import type { KitchenTicket, OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Geçmiş siparişler (22 Kasım 2026, sahip: "geçmiş siparişleri de baristalar vs biz ekrandan görebilelim, karışıklık
 * olmasın diye"): bar ekranında bugünün Geçmiş'i (hazırlayan, teslim eden, Geri al), Siparişler › Kapanan'da arama ve
 * adisyon dökümü; önceki gün yalnız rapor yetkisiyle, kör kasada ödeme dökümü yok.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;

async function auditOf(action: string) {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).all();
}

describe('arama anahtarı', () => {
  it('Türkçe harfe ve büyük-küçüğe duyarsız; bütün sözcükler aranır; # atılır', () => {
    expect(foldTr('ÇAY Süt Işık')).toBe('cay sut isik');
    expect(searchTerms(' #12  Latte ')).toEqual(['12', 'latte']);
    expect(matchesTerms('12 Masa 4 Latte', searchTerms('latte 12'))).toBe(true);
    expect(matchesTerms('12 Masa 4 Latte', searchTerms('mocha'))).toBe(false);
    expect(matchesTerms('her şey', [])).toBe(true);
  });
});

describe('bar geçmişi', () => {
  it('hazırlanan ve teslim edilen fişler en yeni üstte; hazırlayan ve teslim eden; aramayla bulunur', async () => {
    const a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sa = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1, note: 'Yulaf sütü' }] });
    const b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sb = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 2 }] });
    // Bekleyen fiş geçmişte yok
    expect(await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1')).toEqual([]);

    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: sa.items.map((i) => i.id), status: 'hazir' });
    await new Promise((r) => setTimeout(r, 5));
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: sb.items.map((i) => i.id), status: 'hazir' });
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: sb.items.map((i) => i.id), status: 'servis' });

    const list = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1');
    expect(list.map((t) => t.orderId)).toEqual([b.id, a.id]);
    const [tb, ta] = list;
    expect(ta!.history).toMatchObject({ readyBy: 'Bar ekranı', servedAt: null, servedBy: null });
    expect(ta!.history!.readyAt).toBeGreaterThanOrEqual(ta!.sentAt);
    expect(ta!.items[0]).toMatchObject({ name: 'Latte', note: 'Yulaf sütü', status: 'hazir' });
    expect(tb!.history!.servedBy).toBeTruthy();
    expect(tb!.history!.servedAt).toBeGreaterThan(0);

    expect((await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1&q=turk')).map((t) => t.orderId)).toEqual([b.id]);
    expect((await h.ok<KitchenTicket[]>('bar', 'GET', `/kitchen?history=1&q=%23${a.no}`)).map((t) => t.orderId)).toEqual([a.id]);
    expect(await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1&q=yokboyle')).toEqual([]);
    // Üst sınır
    expect((await h.call('bar', 'GET', '/kitchen?history=1&limit=500')).status).toBe(422);
  });

  it('"Hazır"ı geri almak bar yetkisi ister; denetim kaydına yazılır, fiş bekleyenlere döner', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    const ids = sent.items.map((i) => i.id);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazir' });

    // Garson (sipariş alır, bar yetkisi yok) barın "Hazır"ını geri alamaz
    expect((await h.call('garson', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazirlaniyor' })).status).toBe(403);
    const before = (await auditOf('kitchen.undo')).length;

    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazirlaniyor' });
    const logs = await auditOf('kitchen.undo');
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.orderId).toBe(o.id);
    expect(logs.at(-1)!.message).toContain('“Hazır”ı geri aldı');

    const active = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen');
    expect(active.some((t) => t.orderId === o.id)).toBe(true);
    const past = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1');
    expect(past.some((t) => t.orderId === o.id)).toBe(false);
    const back = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(back.items[0]).toMatchObject({ status: 'hazirlaniyor' });
  });
});

describe('kapanan adisyonlar', () => {
  let closedId = '';
  it('bugünün kapananları aranır; kör kasada ödeme türü ve dökümü yok, raporcu görür', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Zeynep Kaya' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: sent.total });
    closedId = o.id;

    const mine = await h.ok<ClosedOrdersDTO>('kasa', 'GET', '/history/orders?q=zeynep');
    expect(mine.rows.map((r) => r.id)).toEqual([o.id]);
    expect(mine.rows[0]).toMatchObject({ summary: '1 Türk Kahvesi', methods: [], total: sent.total });
    expect((await h.ok<ClosedOrdersDTO>('kasa', 'GET', '/history/orders?q=kahvesi')).rows.some((r) => r.id === o.id)).toBe(true);
    expect((await h.ok<ClosedOrdersDTO>('kasa', 'GET', '/history/orders?q=yokboyle')).rows).toEqual([]);

    const blind = await h.ok<ClosedOrderDetailDTO>('kasa', 'GET', `/history/orders/${o.id}`);
    expect(blind.paymentsHidden).toBe(true);
    expect(blind.order.payments).toEqual([]);
    expect(blind.order.items.map((i) => i.name)).toEqual(['Türk Kahvesi']);

    const boss = await h.ok<ClosedOrderDetailDTO>('mudur', 'GET', `/history/orders/${o.id}`);
    expect(boss.paymentsHidden).toBe(false);
    expect(boss.order.payments.map((p) => p.methodName)).toEqual(['Nakit']);
    expect((await h.ok<ClosedOrdersDTO>('mudur', 'GET', '/history/orders?q=zeynep')).rows[0]!.methods).toEqual(['Nakit']);
    // Maliyet ve kâr bu uçlarda hiç yok
    expect(JSON.stringify(boss)).not.toMatch(/"cost|"profit|"maliyet/i);
  });

  it('sayfalı ve üst sınırlı: imleçle sonraki sayfa, 100 üstü reddedilir', async () => {
    for (let n = 0; n < 2; n++) {
      const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
      const s = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
      await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: s.total });
    }
    const p1 = await h.ok<ClosedOrdersDTO>('kasa', 'GET', '/history/orders?limit=2');
    expect(p1.rows.length).toBe(2);
    expect(p1.count).toBeGreaterThanOrEqual(3);
    expect(p1.next).toBeTruthy();
    const p2 = await h.ok<ClosedOrdersDTO>('kasa', 'GET', `/history/orders?limit=2&before=${p1.next}`);
    expect(p2.rows.some((r) => p1.rows.some((x) => x.id === r.id))).toBe(false);
    expect((await h.call('kasa', 'GET', '/history/orders?limit=101')).status).toBe(422);
  });

  it('önceki gün yalnız rapor yetkisiyle; personel bugünü görür', async () => {
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await h.call('kasa', 'GET', `/history/orders?date=${yesterday}`)).status).toBe(403);
    expect((await h.call('garson', 'GET', `/history/orders?date=${yesterday}`)).status).toBe(403);
    const old = await h.ok<ClosedOrdersDTO>('mudur', 'GET', `/history/orders?date=${yesterday}`);
    expect(old).toMatchObject({ date: yesterday, rows: [] });
    // Garson bugünün kapananını görür
    expect((await h.ok<ClosedOrdersDTO>('garson', 'GET', '/history/orders')).rows.some((r) => r.id === closedId)).toBe(true);
    // Kurye ya da yetkisiz kimse yok; bar (yalnız mutfak) kapananları görmez
    expect((await h.call('bar', 'GET', '/history/orders')).status).toBe(403);

    // Dünün (kapanmış) gününe ait adisyon personele kapalı, raporcuya açık
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const oldDay = 'eski-gun-gecmis';
    db.insert(schema.businessDays).values({ id: oldDay, date: yesterday, zNo: 900, openedAt: Date.now() - 2 * 86_400_000, closedAt: Date.now() - 86_400_000 }).run();
    db.update(schema.orders).set({ dayId: oldDay }).where(eq(schema.orders.id, closedId)).run();
    expect((await h.call('kasa', 'GET', `/history/orders/${closedId}`)).status).toBe(403);
    expect((await h.ok<ClosedOrderDetailDTO>('mudur', 'GET', `/history/orders/${closedId}`)).date).toBe(yesterday);
    expect((await h.ok<ClosedOrdersDTO>('mudur', 'GET', `/history/orders?date=${yesterday}`)).rows.some((r) => r.id === closedId)).toBe(true);
    // Bar geçmişi yalnız açık günün: başka güne ait fiş bugünün geçmişinde yok
    const before = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1');
    expect(before.length).toBeGreaterThan(0);
    db.update(schema.orders).set({ dayId: oldDay }).where(eq(schema.orders.id, before[0]!.orderId)).run();
    expect((await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen?history=1')).some((t) => t.orderId === before[0]!.orderId)).toBe(false);
  });
});

describe('arayüz', () => {
  const kitchen = readFileSync(new URL('../src/pages/KitchenPage.tsx', import.meta.url), 'utf8');
  const closed = readFileSync(new URL('../src/pages/orders/ClosedOrders.tsx', import.meta.url), 'utf8');
  it('bar geçmişinde künye, arama ve yetkiye bağlı Geri al; kapananda arama, gün seçici ve yeniden yazdır', () => {
    for (const s of ['label="Bugünkü fişlerde ara"', '>Sipariş</dt>', '>Hazır</dt>', '>Teslim</dt>', 'canBar', 'Teslim bekliyor']) expect(kitchen, s).toContain(s);
    for (const s of ['label="Kapanan adisyonlarda ara"', "can('rapor.gor')", 'Hesabı yeniden yazdır', 'BillReceipt', 'paymentsHidden', 'Daha eski adisyonlar']) expect(closed, s).toContain(s);
  });
});
