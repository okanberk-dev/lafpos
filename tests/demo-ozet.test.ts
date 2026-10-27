import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * LafPOS Uzaktan demo özeti (api/demo-ozet.json): kafe bağlanana kadar lafpos.vercel.app'te parolasız gösterilen
 * örnek gün. Üretmek için: LAFPOS_DEMO_OZET=1 npx vitest run tests/demo-ozet.test.ts. Normal koşuda yalnız
 * dosyanın kişisel veri, PIN ve maliyet taşımadığı denetlenir.
 */
const GEN = process.env.LAFPOS_DEMO_OZET === '1';
let h: Harness;

beforeAll(async () => {
  if (GEN) h = await startApp();
});
afterAll(() => h?.cleanup());

describe('demo özeti', () => {
  it.runIf(GEN)('örnek gün kurulur ve özet yazılır', async () => {
    const { db, schema } = await import('../server/db/client');
    const { buildSnapshot } = await import('../server/sync/cloud');
    const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
    const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
    const tables = h.boot.tables.filter((t) => t.kind === 'masa');
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 150000 });

    const sale = async (items: [string, number, ('M' | 'L')?][], table: number | null, guests = 2) => {
      const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', table == null ? { type: 'tezgah' } : { type: 'masa', tableId: tables[table]!.id, guests });
      return h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: items.map(([n, qty, size]) => ({ productId: product(n).id, qty, ...(size ? { size } : {}) })) });
    };
    // Gün içinde kapanmış adisyonlar: saatlere yayılır
    const closed: [string, number, ('M' | 'L')?][][] = [
      [['Latte', 2, 'M'], ['Türk Kahvesi', 1]],
      [['Americano', 1, 'L'], ['Espresso', 2, 'M']],
      [['Mocha', 2, 'L']],
      [['Flat White', 1, 'M'], ['Cortado', 1]],
      [['Türk Kahvesi', 3]],
      [['Latte', 1, 'L'], ['Americano', 2, 'M']],
      [['Espresso', 1, 'M'], ['Mocha', 1, 'M']],
      [['Flat White', 2, 'M']],
      [['Latte', 3, 'M'], ['Cortado', 2]],
      [['Türk Kahvesi', 2], ['Americano', 1, 'M']],
    ];
    const now = Date.now();
    for (const [i, items] of closed.entries()) {
      const o = await sale(items, i % 3 === 0 ? null : i % tables.length, 1 + (i % 4));
      await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(i % 3 === 1 ? 'Nakit' : 'Kredi kartı').id, amount: o.total });
      const closedAt = now - (closed.length - i) * 50 * 60_000;
      db.update(schema.orders).set({ openedAt: closedAt - 25 * 60_000, closedAt }).where(eq(schema.orders.id, o.id)).run();
    }
    // Açık masalar ve bar kuyruğu
    await sale([['Latte', 2, 'M'], ['Türk Kahvesi', 1]], 3, 3);
    await sale([['Mocha', 1, 'L'], ['Espresso', 1, 'M']], 4, 2);
    const b = await sale([['Flat White', 2, 'M'], ['Cortado', 1]], 5, 2);
    await h.ok('kasa', 'POST', `/orders/${b.id}/bill`, {});
    await sale([['Americano', 1, 'L']], null);

    const snap = buildSnapshot();
    writeFileSync(new URL('../api/demo-ozet.json', import.meta.url), JSON.stringify(snap));
    expect(snap.patron).toBeTruthy();
  });

  it('demo özeti kişisel veri, PIN ve maliyet taşımaz', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../api/demo-ozet.json', import.meta.url), 'utf8');
    expect(raw).not.toMatch(/"pin"|pinHash|"cost":\d|"margin":\d|"phone":"/);
    expect(JSON.parse(raw)).toHaveProperty('bootstrap');
  });
});
