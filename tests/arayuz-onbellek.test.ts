import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anaBetik } from '@shared/ana-betik';
import { type Harness, startApp } from './harness';

/**
 * Güncellemeden sonra eski arayüz (27 Kasım 2026): otomatik güncellemeden sonra sahip kasayı (tarayıcı ya da kiosk) ilk
 * açtığında eski sürüm (eski yeşil kenar çubuğu) görünüyor, elle yenileyince düzeliyordu. Neden: sunucu index.html'i
 * önbellek başlığı olmadan, yalnız Last-Modified ile veriyordu; tarayıcı böyle yanıtı sezgisel olarak (son değişikliğin
 * yaşının onda biri kadar) sunucuya sormadan önbellekten açar, eski index.html eski betiği yükler. Eski sayfa da sunucunun
 * yeni derlemesini "bu sürüm" sanıp yenilenmiyordu (src/lib/buildWatch.ts). Artık index.html ve adı özet taşımayan
 * dosyalar her açılışta sunucuya sorulur; /assets/ (adında içerik özeti) kalıcı önbellekte. Tarayıcıdaki davranış
 * e2e/flows.mjs'te ("Güncellemeden sonra ilk açılış")
 */
const INDEX = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script></head><body><div id="root"></div></body></html>';
let h: Harness;
let dir: string;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let eskiWebDist: string;

beforeAll(async () => {
  h = await startApp();
  dir = mkdtempSync(join(tmpdir(), 'asilpos-web-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-Ab12Cd34.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), '// sw');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
  writeFileSync(join(dir, 'icons', 'icon-192.png'), 'png');
  const { env } = await import('../server/env');
  eskiWebDist = env.webDist;
  env.webDist = dir;
  const { createApp } = await import('../server/app');
  app = createApp();
});
afterAll(async () => {
  const { env } = await import('../server/env');
  env.webDist = eskiWebDist;
  rmSync(dir, { recursive: true, force: true });
  h.cleanup();
});

describe('arayüz dosyalarının önbelleği', () => {
  it('index.html her açılışta sunucuya sorulur: kök, /index.html ve arayüz yolları no-cache', async () => {
    for (const path of ['/', '/index.html', '/masalar', '/adisyon/abc', '/musteri-ekrani?ekran=kasa']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text(), path).toContain('/assets/index-Ab12Cd34.js');
    }
  });

  it('adı içerik özeti taşıyan derleme dosyası kalıcı; olmayanın 404’ü önbelleğe girmez', async () => {
    const js = await app.request('/assets/index-Ab12Cd34.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const yok = await app.request('/assets/index-Eski0000.js');
    expect(yok.status).toBe(404);
    expect(yok.headers.get('cache-control')).toBe('no-store');
  });

  it('adı özet taşımayan dosyalar (servis çalışanı, manifest, simge) de her açılışta sorulur; API önbelleğe girmez', async () => {
    for (const path of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
    const health = await app.request('/api/health');
    expect(health.headers.get('cache-control')).toBe('no-store');
  });

  it('sayfa denetimi index.html’in ana betiğini okur (Vite derlemesi ve geliştirme sunucusu)', () => {
    expect(anaBetik(INDEX)).toBe('/assets/index-Ab12Cd34.js');
    expect(anaBetik('<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.tsx"></script>')).toBe('/@vite/client');
    // Satır içi modül (React önsözü) betik sayılmaz
    expect(anaBetik('<script type="module">import x from "/y"</script>')).toBeNull();
  });
});
