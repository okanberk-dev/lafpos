import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** Hazırlama süresi raporu: gönderilmesinden "Hazır"a, ürün ve saat bazında; iptal ve hazırlanmamış sayılmaz */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;

describe('hazırlama süresi', () => {
  it('hazır olan kalemler sayılır, bekleyen ve iptal edilen sayılmaz; yetki rapor.gor', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
      items: [
        { productId: product('Latte').id, size: 'M', qty: 1 },
        { productId: product('Türk Kahvesi').id, qty: 1 },
      ],
    });
    const latte = sent.items.find((i) => i.name === 'Latte')!;
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [latte.id], status: 'hazir' });
    const r = await h.ok<{ overall: { count: number }; products: { name: string; count: number; p90: number }[]; hours: unknown[]; slowest: unknown[] }>('mudur', 'GET', '/reports/prep');
    expect(r.overall.count).toBe(1);
    expect(r.products.map((p) => p.name)).toEqual(['Latte']);
    expect(r.hours).toHaveLength(1);
    expect(r.slowest).toHaveLength(1);
    expect((await h.call('garson', 'GET', '/reports/prep')).status).toBe(403);
  });

  it('hazırdan teslime: her teslim dokunuşu bir kez, son hazır olan kalemden; geri alınan teslim sayılmaz', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    type Prep = { handoff: { count: number; median: number; max: number } };
    const base = (await h.ok<Prep>('mudur', 'GET', '/reports/prep')).handoff.count;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
      items: [
        { productId: product('Latte').id, size: 'M', qty: 1 },
        { productId: product('Türk Kahvesi').id, qty: 1 },
      ],
    });
    const ids = sent.items.map((i) => i.id);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazir' });
    // Latte 3 dakika, Türk kahvesi 90 saniye önce hazır oldu: müşteri ikisini birlikte 90 saniye sonra aldı
    const now = Date.now();
    db.update(schema.orderItems).set({ readyAt: now - 180_000 }).where(eq(schema.orderItems.id, ids[0])).run();
    db.update(schema.orderItems).set({ readyAt: now - 90_000 }).where(eq(schema.orderItems.id, ids[1])).run();
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: ids, status: 'servis' });
    let r = await h.ok<Prep>('mudur', 'GET', '/reports/prep');
    expect(r.handoff.count).toBe(base + 1);
    expect(r.handoff.max).toBeGreaterThanOrEqual(90);
    expect(r.handoff.max).toBeLessThan(100);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazir' });
    r = await h.ok<Prep>('mudur', 'GET', '/reports/prep');
    expect(r.handoff.count).toBe(base);
  });
});
