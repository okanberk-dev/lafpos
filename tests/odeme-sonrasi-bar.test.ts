import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsUntilPaid } from '@shared/service-mode';
import type { FloorStateDTO, KitchenTicket, OrderDTO, PickupBoardDTO } from '@shared/types';
import { cartGroupOf, groupCartItems } from '../src/pages/order/cartGroups';
import { type Harness, PINS, startApp } from './harness';

/**
 * Ödeme alınınca bara (4 Kasım 2026, operatör: "ödemesi alınınca bar tarafına gitsin"): tezgâh satışında "Öde" ile
 * eklenen kalem ödeme bekler (`held`), bar ekranı, çağrı ekranı ve sipariş sayacı onu görmez. Adisyon kapanınca (ödeme,
 * yazarkasa, ciro dışı ya da ₺0) kendiliğinden bara gider: gönderim anı ve fiş numarası o an. Müşteri vazgeçerse bar
 * boşuna hazırlamaz; satış onaysız iptal edilir, fire sayılmaz. "Ödemeden gönder" bekleyeni hemen yollar (denetimde iz).
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const latte = () => h.boot.products.find((p) => p.name === 'Latte')!;
const cash = () => h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
const kitchenItemIds = async () => (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).flatMap((t) => t.items.map((i) => i.id));
const counterSale = async (qty = 2) => {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty }], hold: true });
};
const audits = () => h.ok<{ action: string; orderId: string | null; message: string; severity: string }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=200');

describe('tezgâh satışında "Öde": ödeme alınınca bara', () => {
  it('bekleyen kalem bar ekranında, çağrı ekranında ve sipariş sayacında yok; ödeme alınınca yeni fişle bara düşer', async () => {
    const o = await counterSale();
    const item = o.items[0];
    expect(item.held).toBe(true);
    expect(await kitchenItemIds()).not.toContain(item.id);
    const floor = await h.ok<FloorStateDTO>('kasa', 'GET', '/floor');
    expect(floor.others.find((x) => x.id === o.id)?.pendingKitchen).toBe(0);
    const board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.some((e) => e.id === o.id)).toBe(false);

    const before = Date.now();
    const paid = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.total });
    expect(paid.closed).toBe(true);
    const after = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    const released = after.items[0];
    expect(released.held).toBe(false);
    expect(released.sentAt).toBeGreaterThanOrEqual(before);
    expect(released.batch).toBeGreaterThan(item.batch);
    const ticket = (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).find((t) => t.orderId === o.id)!;
    expect(ticket.items.map((i) => i.id)).toEqual([item.id]);
    // Fişte "Ödendi": barista ödemesi alınmış siparişi bilir
    expect(ticket.paid).toBe(true);
    expect((await h.ok<PickupBoardDTO>('', 'GET', '/public/board')).preparing.some((e) => e.id === o.id)).toBe(true);
  });

  it('kısmi ödemede bekler; kalan da ödenince gider', async () => {
    const o = await counterSale(2);
    const first = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.total - 1000 });
    expect(first.closed).toBe(false);
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: 1000 });
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });

  it('yazarkasada ödenince (cihaz ödemeyi kendisi bildirir) adisyon kapanır ve kalemler bara gider', async () => {
    const o = await counterSale(1);
    const sent = await h.ok<{ receipt: { id: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    const done = await h.ok<{ status: string }>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: o.total }] });
    expect(done.status).toBe('tamamlandi');
    expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });

  it('ciro dışı kapanış (personel yemeği) da bara gönderir', async () => {
    const o = await counterSale(1);
    const garson = (await h.ok<{ id: string; name: string }[]>('patron', 'GET', '/admin/users')).find((u) => u.name === 'Garson')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: garson.id }, approverPin: PINS.mudur });
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });

  it('müşteri vazgeçerse satış onaysız iptal edilir; bara hiç gitmez, fire sayılmaz', async () => {
    const o = await counterSale(2);
    // Başka kasiyer (müdür değil, iptal yetkisi yok) ve süre geçmiş olsa da: bekleyen kalem bara gitmedi
    const cancelled = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Müşteri vazgeçti' });
    expect(cancelled.status).toBe('iptal');
    const row = (await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).items[0];
    expect(row.voided).toBe(true);
    expect(row.voidAfterSend).toBe(false);
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    const log = (await audits()).find((a) => a.action === 'order.cancel' && a.orderId === o.id)!;
    expect(log.severity).toBe('info');
  });

  it('bekleyen kalem tek tek de onaysız silinir; bar uyarılmaz, fire sayılmaz', async () => {
    const o = await counterSale(2);
    // Garson ekledi gibi değil: başka kullanıcı (müdür) da onaysız siler, çünkü kalem bara gitmedi
    const voided = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { qty: 1, reason: 'Yanlış ürün' });
    const gone = voided.items.find((i) => i.voided)!;
    expect(gone.voidAfterSend).toBe(false);
    expect(voided.items.find((i) => !i.voided)?.held).toBe(true);
  });

  it('"Ödemeden gönder" bekleyenleri hemen yollar ve denetime yazar; bekleyen yoksa 409', async () => {
    const o = await counterSale(1);
    const r = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/release`, {});
    expect(r.items[0].held).toBe(false);
    expect(await kitchenItemIds()).toContain(o.items[0].id);
    const log = (await audits()).find((a) => a.action === 'order.release' && a.orderId === o.id)!;
    expect(log.message).toMatch(/siparişi ödeme alınmadan bara gönderdi \(1 kalem\)/);
    const again = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/release`, {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('nothing_held');
    // Bar ekranı rolü sipariş alamaz: gönderemez
    await h.login('bar', '3333');
    const o2 = await counterSale(1);
    expect((await h.call('bar', 'POST', `/orders/${o2.id}/release`, {})).status).toBe(403);
  });

  it('masa adisyonuna taşınan bekleyen kalem bara gider (masada ödeme sonda alınır)', async () => {
    const o = await counterSale(2);
    const table = h.boot.tables.find((t) => t.kind === 'masa')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: o.items[0].id, qty: 1 }], tableId: table.id });
    const ids = await kitchenItemIds();
    const src = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    // Kaynakta kalan bekler; taşınan masada bara gitti
    expect(src.items.find((i) => !i.voided)?.held).toBe(true);
    expect(ids).not.toContain(src.items[0].id);
    const floor = await h.ok<FloorStateDTO>('kasa', 'GET', '/floor');
    const moved = floor.tables[table.id]?.[0];
    expect(moved?.pendingKitchen).toBe(1);
  });

  it('yalnız tezgâh satışında: masa siparişinde "hold" reddedilir', async () => {
    const table = h.boot.tables.filter((t) => t.kind === 'masa')[3];
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 1 });
    const r = await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }], hold: true });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('hold_not_counter');
    expect(holdsUntilPaid({ type: 'tezgah', source: 'pos' })).toBe(true);
    expect(holdsUntilPaid({ type: 'masa', source: 'pos' })).toBe(false);
    expect(holdsUntilPaid({ type: 'tezgah', source: 'laffogato' })).toBe(false);
  });

  it('"Bara gönder" (hold yok) tezgâhta da hemen gider', async () => {
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }] });
    expect(o.items[0].held).toBe(false);
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });
});

describe('ekran (kaynak)', () => {
  const page = readFileSync(new URL('../src/pages/order/OrderPage.tsx', import.meta.url), 'utf8');
  const cart = readFileSync(new URL('../src/pages/order/CartPanel.tsx', import.meta.url), 'utf8');

  it('"Öde" tezgâh satışında bekletir, "Bara gönder" hemen gönderir', () => {
    expect(page).toContain('const holdOnPay = holdsUntilPaid(order);');
    expect(page.match(/if \(await send\(holdOnPay\)\) setDialog\('odeme'\);/g)?.length).toBe(2);
    expect(page).toMatch(/const sendOnly = \(\) =>\s*void once\(async \(\) => \{\s*if \(promptNumarator\('send'\)\) return;\s*await send\(\);/);
    expect(page).toContain('...(hold ? { hold: true } : {}),');
  });

  it('sepette "Ödeme bekliyor" grubu en üstte; "Ödemeden gönder" sipariş yetkisiyle', () => {
    const items = [{ voided: false, stationId: 'bar', status: 'yeni' as const, held: false }, { voided: false, stationId: 'bar', status: 'yeni' as const, held: true }];
    expect(cartGroupOf(items[1])).toBe('odeme');
    expect(groupCartItems(items).map((g) => g.label)).toEqual(['Ödeme bekliyor', 'Barda']);
    expect(cart).toContain("g.key === 'odeme' && order.status === 'acik' && !REMOTE && can('siparis.al')");
    expect(cart).toContain('post<OrderDTO>(`/orders/${order.id}/release`, {})');
    expect(cart).toContain("{payFirst ? 'Ödeme alınınca sipariş bara gider'");
  });
});
