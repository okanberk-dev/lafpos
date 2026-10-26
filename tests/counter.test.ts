import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Tezgâhta tek ekran: "Tezgâh satışı" ya da satış sonrası "Yeni satış" kasiyerin boş tezgâh adisyonunu yeniden
 * kullanır; kalemsiz ve ödemesiz adisyon gün sonunu tutmaz, kendiliğinden kapanır.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;

describe('tezgâh satışı', () => {
  it("yalnız bu cihazın boş tezgâh adisyonu yeniden kullanılır; aynı PIN'le iki kasa ayrı adisyon alır", async () => {
    const a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect((await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: a.id })).id).toBe(a.id);
    // İkinci kasa aynı PIN'le girer ama kendi kimliğini vermez: ayrı adisyon (iki müşteri tek hesapta birleşmez)
    await h.login('kasa2', '1111');
    expect((await h.ok<OrderDTO>('kasa2', 'POST', '/orders', { type: 'tezgah' })).id).not.toBe(a.id);
    // Başka kişi bu adisyonun kimliğini verse de alamaz
    expect((await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'tezgah', reuse: a.id })).id).not.toBe(a.id);

    const sold = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const next = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: a.id });
    expect(next.id).not.toBe(a.id);
    await h.ok('kasa', 'POST', `/orders/${a.id}/payments`, { methodId: method('Nakit').id, amount: sold.total });
    expect((await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: next.id })).id).toBe(next.id);

    // Boş adisyona indirim verilmez (sonraki satışa sessizce geçerdi)
    const disc = await h.call<{ code: string }>('kasa', 'POST', `/orders/${next.id}/discount`, { type: 'percent', value: 50, reason: 'Kampanya', approverPin: '2468' });
    expect(disc.json.code).toBe('empty_order');
  });

  it('sayacı çalışan oda adisyonu boş sayılmaz: gün sonunu tutar', async () => {
    const room = h.boot.tables.find((t) => t.kind === 'oda')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    await h.ok('kasa', 'POST', `/orders/${o.id}/room/start`, {});
    const { isEmptyOrder } = await import('../server/services/orders');
    const { db } = await import('../server/db/client');
    expect(isEmptyOrder(db, o.id)).toBe(false);
    const blocked = await h.call<{ code: string }>('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(blocked.json.code).toBe('open_orders');
    const stopped = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/room/stop`, {});
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, amount: stopped.total });
  });

  it('elle fiyat: yetkisi olmayan kasiyerde yetkili PIN ister, fiyat kaleme yazılır ve denetime düşer', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    const line = { productId: product('Türk kahvesi').id, qty: 1, priceOverride: 5000 };
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items`, { items: [line] });
    expect(denied.json.code).toBe('approval_required');
    const done = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [line], approverPin: '2468' });
    expect(done.items[0]!.unitPrice).toBe(5000);
    const audit = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.some((a) => a.action === 'item.price_override')).toBe(true);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: done.total });
  });

  it('gün sonunda kalemsiz ve ödemesiz adisyonlar kapanır, dolu adisyon yine engeller', async () => {
    const full = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    const withItem = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${full.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const blocked = await h.call<{ code: string; error: string }>('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(blocked.json.code).toBe('open_orders');
    expect(blocked.json.error).toContain(`#${full.no}`);
    // Boş adisyonlar engel listesinde yok
    expect(blocked.json.error).not.toMatch(/#\d+, #/);

    await h.ok('kasa', 'POST', `/orders/${full.id}/payments`, { methodId: method('Nakit').id, amount: withItem.total });
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    const audit = await h.ok<{ message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.some((a) => a.message.includes('boş adisyon gün sonunda kapatıldı'))).toBe(true);
  });
});
