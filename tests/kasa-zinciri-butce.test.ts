import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import { type Harness, startApp } from './harness';
import { ACILIS_KASA } from '@shared/eski-adlar';

/**
 * Kasa zincirinin istek bütçesi (docs/03-ENTEGRASYON.md §5): lafmaliyet bağlantısı tanımlı değilken (LAFMALIYET_URL
 * yok) devir ve gider kategorileri için hiçbir istek gitmez; öneri yerel sayımdan gelir, kategori listesi boştur ve
 * harcama kategorisiz kaydedilir.
 */
let h: Harness;
const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeAll(async () => {
  h = await startApp({ LAFMALIYET_URL: '', LAFMALIYET_SYNC_SECRET: '' });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false });
  updateSettings({ okcProvider: 'kapali' });
});
afterAll(() => {
  fetchSpy.mockRestore();
  h.cleanup();
});

describe('bağlantı yokken kasa zinciri', () => {
  it('devir ve kategori istenmez; öneri yerel sayımdan, kategori listesi boş', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq, isNull } = await import('drizzle-orm');
    const lm = await import('../server/sync/lafmaliyet');
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const day = db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get()!;
    expect(await h.ok('kasa', 'GET', '/cash/expense-categories')).toMatchObject({ items: [], configured: false });
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 1000, description: 'Buz' });
    db.update(schema.businessDays).set({ date: addDays(businessDate(Date.now()), -1) }).where(eq(schema.businessDays.id, day.id)).run();
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 50000 });
    expect((await h.ok<{ opening: unknown }>('mudur', 'GET', '/cash/day')).opening).toMatchObject({ suggested: 50000, source: ACILIS_KASA });
    expect(await lm.devirIfStale()).toBe(false);
    expect(await lm.categoriesIfStale()).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
