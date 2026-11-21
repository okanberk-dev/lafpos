import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** Karşılama sihirbazı (server/services/kurulum.ts): adımların durumu veritabanından; gizlenir; yetki */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

type Steps = { steps: { key: string; done: boolean; to: string }[]; hidden: boolean };
const state = async () => Object.fromEntries((await h.ok<Steps>('patron', 'GET', '/admin/kurulum')).steps.map((s) => [s.key, s.done]));

describe('karşılama sihirbazı', () => {
  it('yeni kurulum: deneme satışı ve gerçek kullanım yapılmadı; sıra ve bağlantılar', async () => {
    const r = await h.ok<Steps>('patron', 'GET', '/admin/kurulum');
    expect(r.steps.map((s) => s.key)).toEqual(['menu', 'masa', 'personel', 'fis', 'pavo', 'deneme', 'gercek']);
    expect(r.steps.every((s) => s.to.startsWith('/'))).toBe(true);
    const s = await state();
    expect(s.deneme).toBe(false);
    expect(s.masa).toBe(true);
    expect((await h.call('garson', 'GET', '/admin/kurulum')).status).toBe(403);
  });

  it('satış yapılınca ve hesap yazdırılınca ilgili adımlar tamamlanır', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/bill`);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: h.boot.paymentMethods.find((m) => m.name === 'Nakit')!.id, amount: o.total });
    const s = await state();
    expect(s.deneme).toBe(true);
    expect(s.fis).toBe(true);
  });

  it('gizlenince kart kaybolur, yeniden açılır', async () => {
    expect((await h.ok<Steps>('patron', 'PUT', '/admin/kurulum', { hidden: true })).hidden).toBe(true);
    expect((await h.ok<Steps>('patron', 'PUT', '/admin/kurulum', { hidden: false })).hidden).toBe(false);
  });
});
