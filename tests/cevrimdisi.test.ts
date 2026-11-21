import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Tablet kasaya ulaşamayınca (sunucu yeniden başlıyor, Wi-Fi koptu) gönderim tablette bekler ve aynı kimlikle yeniden
 * gelir (src/lib/cart.ts SendBatch). İlk deneme yazılıp yanıtı kaybolduysa ikinci deneme kalemleri yeniden yazmaz.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

describe('çevrimdışı gönderim', () => {
  it('aynı gönderim kimliği bir kez yazılır; yeni kimlik yeniden yazar; geçersiz kimlik reddedilir', async () => {
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'tezgah' });
    const body = (id: string) => ({ items: [{ productId: latte.id, qty: 2 }], clientBatchId: id });
    const first = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, body('tablet-0001-abcdef'));
    expect(first.items.reduce((a, i) => a + i.qty, 0)).toBe(2);
    // Yanıt kayboldu, tablet aynı kimlikle yeniden gönderir: ikinci kez yazılmaz, güncel adisyon döner
    const again = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, body('tablet-0001-abcdef'));
    expect(again.items.reduce((a, i) => a + i.qty, 0)).toBe(2);
    const next = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, body('tablet-0002-abcdef'));
    expect(next.items.reduce((a, i) => a + i.qty, 0)).toBe(4);
    // Kimliksiz gönderim eskisi gibi
    const plain = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, qty: 1 }] });
    expect(plain.items.reduce((a, i) => a + i.qty, 0)).toBe(5);
    expect((await h.call('garson', 'POST', `/orders/${o.id}/items`, body('kısa'))).status).toBe(422);
  });

  it('ulaşılamadı sayılan durumlar: yanıt yok, sunucu yeniden başlıyor', async () => {
    const { unreachable } = await import('../src/lib/cart');
    for (const status of [0, 502, 503, 504]) expect(unreachable({ status })).toBe(true);
    for (const status of [400, 401, 403, 409, 422, 500]) expect(unreachable({ status })).toBe(false);
  });
});
