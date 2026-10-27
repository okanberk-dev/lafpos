import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Sahibin 26 Ekim kararı (L3 madde 8): LafPOS bağlantısı varsayılan kapalı. `LAFFOGATO_URL` .env'de açıkça
 * yazılmadıkça siteye hiçbir istek gitmez: menü yoklaması, görsel, sipariş sürüm sinyali, Tükendi yazımı. Anahtar
 * tek başına bağlantıyı açmaz; elle "Siteyle eşitle" ve "Yenile" "Site bağlantısı kurulmadı" der.
 */
let h: Harness;
let boot: BootstrapDTO;
const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeAll(async () => {
  delete process.env.LAFFOGATO_URL;
  h = await startApp({ LAFFOGATO_SYNC_SECRET: 'k'.repeat(48) });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
});
afterAll(() => {
  fetchSpy.mockRestore();
  h.cleanup();
});

describe('LAFFOGATO_URL yokken site bağlantısı kapalı', () => {
  it('durum ve açılış verisi "kurulmadı" der; anahtar tek başına bağlantı sayılmaz', async () => {
    const status = await h.ok<{ menu: { linked: boolean }; online: { configured: boolean } }>('patron', 'GET', '/sync/status');
    expect(status.menu.linked).toBe(false);
    expect(status.online.configured).toBe(false);
    expect(boot.integrations.laffogatoUrl).toBe('');
    expect(boot.integrations.laffogatoPanel).toBe(false);
  });

  it('elle eşitleme ve sipariş yenileme aynı mesajla 409', async () => {
    for (const path of ['/sync/menu/preview', '/sync/menu/apply', '/sync/online/refresh']) {
      const r = await h.call<{ error: string; code: string }>('patron', 'POST', path);
      expect(r.status, path).toBe(409);
      expect(r.json.code, path).toBe('not_configured');
      expect(r.json.error, path).toMatch(/^Site bağlantısı kurulmadı/);
    }
    const status = await h.ok<{ menu: { state: { lastError?: string } | null } }>('patron', 'GET', '/sync/status');
    // "Kurulmadı" bir hata değildir: durum kaydına hata yazılmaz, Genel bakış kırmızı göstermez
    expect(status.menu.state?.lastError ?? null).toBeNull();
  });

  it('Tükendi yalnız LafPOS\'ta değişir, ürün görseli indirilmez', async () => {
    const latte = boot.products.find((p) => p.name === 'Latte' && p.extSource === 'laffogato')!;
    expect((await h.ok<{ site: string }>('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: false })).site).toBe('baglanti_yok');
    expect((await h.ok<{ site: string }>('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: true })).site).toBe('baglanti_yok');
    const withImage = boot.products.find((p) => p.image)!;
    const { createApp } = await import('../server/app');
    expect((await createApp().request(`/media/products/${withImage.id}`)).status).toBe(404);
    const { warmProductThumbs } = await import('../server/services/media');
    expect(await warmProductThumbs()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('zamanlayıcı iki saat boyunca hiç fetch çağırmaz (gün açık, otomatik eşitleme açık)', async () => {
    fetchSpy.mockClear();
    const jobs = await import('../server/jobs');
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    process.env.LAFPOS_NO_JOBS = '0';
    try {
      jobs.startJobs();
      await vi.advanceTimersByTimeAsync(2 * 3600_000);
    } finally {
      jobs.stopJobs();
      process.env.LAFPOS_NO_JOBS = '1';
      vi.useRealTimers();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
