import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/** Ürün kartı görseli: yalnız sitenin kendi görselleri, bilinmeyen ya da görselsiz ürün 404 */
let h: Harness;
beforeAll(async () => {
  h = await startApp({ LAFFOGATO_URL: 'https://laffogato.net' });
});
afterAll(() => h.cleanup());

describe('ürün görseli', () => {
  it('kaynak yalnız sitenin https adresi: başka kökene istek atılmaz', async () => {
    const { thumbSource } = await import('../server/services/media');
    expect(thumbSource('https://laffogato.net/menu/latte.webp')?.pathname).toBe('/menu/latte.webp');
    expect(thumbSource('http://laffogato.net/menu/latte.webp')).toBeNull();
    expect(thumbSource('https://laffogato.net.kotu.com/x.webp')).toBeNull();
    expect(thumbSource('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(thumbSource('file:///etc/passwd')).toBeNull();
    expect(thumbSource(null)).toBeNull();
    expect(thumbSource('bozuk adres')).toBeNull();
  });

  it('küçük kopya sürümlü adresle istenir: site fotoğrafı değişince yenisi gelir, aynısı yeniden indirilmez', async () => {
    const { thumbFor } = await import('../server/services/media');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } }));
    try {
      expect(await thumbFor('https://laffogato.net/gorsel/menu/mnu-0007?v=aaa')).not.toBeNull();
      expect(String(spy.mock.calls[0]![0])).toBe('https://laffogato.net/_next/image?url=%2Fgorsel%2Fmenu%2Fmnu-0007%3Fv%3Daaa&w=256&q=75');
      await thumbFor('https://laffogato.net/gorsel/menu/mnu-0007?v=aaa');
      expect(spy).toHaveBeenCalledTimes(1);
      await thumbFor('https://laffogato.net/gorsel/menu/mnu-0007?v=bbb');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(String(spy.mock.calls[1]![0])).toContain('url=%2Fgorsel%2Fmenu%2Fmnu-0007%3Fv%3Dbbb');
    } finally {
      spy.mockRestore();
    }
  });

  it('bilinmeyen ya da görselsiz ürün 404; uç oturum istemez ve önbelleğe kapalı değildir', async () => {
    const { createApp } = await import('../server/app');
    const app = createApp();
    expect((await app.request('/media/products/olmayan')).status).toBe(404);
    const local = h.boot.products.find((p) => !p.image)!;
    expect((await app.request(`/media/products/${local.id}`)).status).toBe(404);
  });
});
