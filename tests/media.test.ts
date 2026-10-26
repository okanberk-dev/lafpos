import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('bilinmeyen ya da görselsiz ürün 404; uç oturum istemez ve önbelleğe kapalı değildir', async () => {
    const { createApp } = await import('../server/app');
    const app = createApp();
    expect((await app.request('/media/products/olmayan')).status).toBe(404);
    const local = h.boot.products.find((p) => !p.image)!;
    expect((await app.request(`/media/products/${local.id}`)).status).toBe(404);
  });
});
