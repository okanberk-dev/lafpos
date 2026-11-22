import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Menü yoklamasının takvimi (L3 madde 6 ve 8, S8): gün açıkken 15 dk'da bir, açık iş günü yokken (gece) hiç, gün
 * açılınca bir kez (online siparişler de hemen); LafPOS'un siteye kendi Tükendi yazımından birkaç saniye sonra bir kez (site o an uyanık).
 * Site isteği sahte `fetch`'e gider, ağ yok; zamanlayıcı gerçek (`startJobs`), saat sahte.
 */
let h: Harness;
// Sorgu (`?branch=`, imzalı isteğin şubesi) yol eşlemesine katılmaz
const urlOf = (input: unknown) => (input instanceof Request ? input.url : String(input)).split('?')[0]!;
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = urlOf(input);
  if (url.endsWith('/api/mobile/v1/menu')) return new Response(null, { status: 304, headers: { etag: '"m1"' } });
  if (url.endsWith('/api/pos/orders/version')) return Response.json({ version: 'v1' });
  if (url.endsWith('/api/panel/orders')) return Response.json({ version: 1, complete: true, orders: [] });
  if (url.endsWith('/api/panel/menu')) return Response.json({ item: {} });
  return new Response(null, { status: 404 });
});
const calls = (path: string) => fetchSpy.mock.calls.filter(([input]) => urlOf(input).endsWith(path)).length;
/** Sahte saat ilerlemeden bekleyen işler (sahte fetch, SQLite) bitsin */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeAll(async () => {
  h = await startApp({ LAFFOGATO_URL: 'https://site.test', LAFFOGATO_SYNC_SECRET: 'z'.repeat(48) });
});
afterAll(() => {
  fetchSpy.mockRestore();
  h.cleanup();
});

describe('menü yoklaması', () => {
  it('gece yok, gün açılınca bir kez, sonra 15 dakikada bir; kendi Tükendi yazımından sonra bir kez', async () => {
    const jobs = await import('../server/jobs');
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    process.env.LAFPOS_NO_JOBS = '0';
    try {
      jobs.startJobs();
      // Hiç iş günü yok (ilk kurulum): bir saat boyunca siteye hiç istek gitmez; menü sorulmaz, sipariş yazılacak gün
      // olmadığı için sipariş sürüm sinyali de (gece seyrekliği site-orders.test.ts'te, açık gün yokken 3 dk'da bir)
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(calls('/api/mobile/v1/menu')).toBe(0);
      expect(calls('/api/pos/orders/version')).toBe(0);
      expect(calls('/api/panel/orders')).toBe(0);

      // Gün açılınca bir kez (menü ve online siparişler hemen); aralığın sırası 75. dakikada
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      await settle();
      expect(calls('/api/mobile/v1/menu')).toBe(1);
      expect(calls('/api/pos/orders/version')).toBe(1);
      expect(calls('/api/panel/orders')).toBe(1);
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(calls('/api/mobile/v1/menu')).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(calls('/api/mobile/v1/menu')).toBe(2);

      // LafPOS siteye Tükendi yazar: birkaç saniye sonra bir eşitleme, sıradaki yoklamayı beklemeden
      const boot = await h.ok<BootstrapDTO>('mudur', 'GET', '/bootstrap');
      const latte = boot.products.find((p) => p.name === 'Latte' && p.extSource === 'laffogato')!;
      expect((await h.ok<{ site: string }>('mudur', 'POST', `/sync/products/${latte.id}/availability`, { active: false })).site).toBe('guncellendi');
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(calls('/api/mobile/v1/menu')).toBe(3);
    } finally {
      jobs.stopJobs();
      process.env.LAFPOS_NO_JOBS = '1';
      vi.useRealTimers();
    }
  });
});
