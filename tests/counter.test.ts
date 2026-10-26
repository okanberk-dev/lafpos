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
  it('boş tezgâh adisyonu yeniden kullanılır; kalem eklenince sonraki satış yeni adisyon', async () => {
    const a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(b.id).toBe(a.id);

    // Başka kişinin boş adisyonu kullanılmaz
    const other = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'tezgah' });
    expect(other.id).not.toBe(a.id);

    const sold = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const next = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(next.id).not.toBe(a.id);
    await h.ok('kasa', 'POST', `/orders/${a.id}/payments`, { methodId: method('Nakit').id, amount: sold.total });
    // Satış kapandı; "Yeni satış" yine aynı boş adisyonu açar
    expect((await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' })).id).toBe(next.id);
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
