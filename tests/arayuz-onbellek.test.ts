import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anaBetik, eskiSayfaKarari, yeniAnaBetik } from '@shared/ana-betik';
import { type Harness, startApp } from './harness';

/**
 * Güncellemeden sonra eski arayüz (27 Kasım 2026): otomatik güncellemeden sonra sahip kasayı (tarayıcı ya da kiosk) ilk
 * açtığında eski sürüm (eski yeşil kenar çubuğu) görünüyor, elle yenileyince düzeliyordu. İki neden:
 * 1. Sunucu kökü (`/`, kasa penceresinin adresi) ve derleme dosyalarını önbellek başlığı olmadan, yalnız Last-Modified ile
 *    veriyordu; tarayıcı böyle yanıtı sezgisel olarak (son değişikliğin yaşının onda biri kadar) sunucuya sormadan
 *    önbellekten açar. Artık arayüz sayfası hiç saklanmaz (`no-store`: geri gelişte ve oturum geri yüklemesinde de
 *    sunucudan), adı özet taşımayan dosyalar her açılışta sorulur (`no-cache`), /assets/ kalıcı önbellekte.
 * 2. Sayfa güncellemeden hemen önce eski sunucudan açılmış, giriş ekranındayken sunucu yenilenmişse ilk derleme sorusu
 *    yeni sunucuya gidiyor, eski sayfa yeni derlemeyi "bu sürüm" sanıyordu. Artık sayfa kendi ana betiğini sunucunun
 *    index.html'iyle karşılaştırır (src/lib/buildWatch.ts, karar burada sınanır).
 * Tarayıcıdaki davranış e2e/flows.mjs'te ("Güncellemeden sonra ilk açılış", "Eski sürümle açılan sayfa", "Giriş
 * ekranı güncellemeden sonra")
 */
const INDEX = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script></head><body><div id="root"></div></body></html>';
let h: Harness;
let dir: string;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let eskiWebDist: string;
let arayuzOnbellegi: (path: string) => string;

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
  // Sunucu modülleri sınama veritabanı kurulduktan sonra yüklenir
  const mod = await import('../server/app');
  arayuzOnbellegi = mod.arayuzOnbellegi;
  app = mod.createApp();
});
afterAll(async () => {
  const { env } = await import('../server/env');
  env.webDist = eskiWebDist;
  rmSync(dir, { recursive: true, force: true });
  h.cleanup();
});

describe('arayüz dosyalarının önbelleği', () => {
  it('arayüz sayfası (index.html) hiç saklanmaz: kök, /index.html ve arayüz yolları no-store; Last-Modified sezgisel önbelleğe yol açmaz', async () => {
    for (const path of ['/', '/index.html', '/masalar', '/adisyon/abc', '/musteri-ekrani?ekran=kasa']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(await res.text(), path).toContain('/assets/index-Ab12Cd34.js');
    }
  });

  it('kural yola göre: /assets/ kalıcı, uzantılı dosya her açılışta sorulur, sayfa (uzantısız ya da .html) saklanmaz', () => {
    expect(arayuzOnbellegi('/assets/index-Ab12Cd34.js')).toBe('public, max-age=31536000, immutable');
    expect(arayuzOnbellegi('/assets/inter-latin.woff2')).toBe('public, max-age=31536000, immutable');
    for (const p of ['/sw.js', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png']) expect(arayuzOnbellegi(p), p).toBe('no-cache');
    for (const p of ['/', '/index.html', '/masalar', '/yonetim/menu', '/demo/']) expect(arayuzOnbellegi(p), p).toBe('no-store');
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

describe('eski derlemeyle açılan sayfa (src/lib/buildWatch.ts)', () => {
  const BASE = 'http://localhost:4000/giris';
  const ESKI = ['/assets/index-Eski0000.js'];
  const YENI_HTML = INDEX;

  it('sayfanın ana betiği sunucunun index.html’indekinden farklıysa yeni betiğin yolu; aynıysa, geliştirmede ya da anlaşılmazsa null', () => {
    expect(yeniAnaBetik(ESKI, YENI_HTML, BASE)).toBe('/assets/index-Ab12Cd34.js');
    expect(yeniAnaBetik(['/assets/index-Ab12Cd34.js'], YENI_HTML, BASE)).toBeNull();
    // Göreli ve tam adresli betik de aynı yol sayılır
    expect(yeniAnaBetik(['/assets/index-Ab12Cd34.js'], INDEX.replace('src="/assets/', 'src="http://localhost:4000/assets/'), BASE)).toBeNull();
    // Geliştirme sunucusu: /@vite/client sayfada da var
    expect(yeniAnaBetik(['/@vite/client', '/src/main.tsx'], '<script type="module" src="/@vite/client"></script>', BASE)).toBeNull();
    // Sayfa modül betiği taşımıyorsa ya da sunucunun yanıtı sayfa değilse karar verilmez
    expect(yeniAnaBetik([], YENI_HTML, BASE)).toBeNull();
    expect(yeniAnaBetik(ESKI, '{"error":"Bulunamadı"}', BASE)).toBeNull();
  });

  it('kasa sabah açılır (eski sunucu), güncelleme giriş ekranındayken kurulur: sayfa bir kez yenilenir; yenilemeden sonra güncel', () => {
    // Açılışta sunucu da eski: güncel
    expect(eskiSayfaKarari(yeniAnaBetik(ESKI, INDEX.replace('Ab12Cd34', 'Eski0000'), BASE), null)).toBe('guncel');
    // Güncelleme kuruldu: dakikalık denetim ya da girişten sonraki ilk derleme sorusu eski sayfayı bulur
    const hedef = yeniAnaBetik(ESKI, YENI_HTML, BASE);
    expect(eskiSayfaKarari(hedef, null)).toBe('yenile');
    // Yenilenen sayfa yeni derlemeden: güncel, iz silinir
    expect(eskiSayfaKarari(yeniAnaBetik(['/assets/index-Ab12Cd34.js'], YENI_HTML, BASE), hedef)).toBe('guncel');
  });

  it('yenilemeden sonra da eski (ara önbellek): aynı hedefe ikinci kez yenilenmez; bir sonraki güncellemede yeniden yenilenir', () => {
    const hedef = yeniAnaBetik(ESKI, YENI_HTML, BASE);
    expect(eskiSayfaKarari(hedef, hedef)).toBe('dur');
    expect(eskiSayfaKarari(yeniAnaBetik(ESKI, INDEX.replace('Ab12Cd34', 'Sonraki1'), BASE), hedef)).toBe('yenile');
  });

  it('kasada açılışta ve girişten önce de denetlenir: uygulamanın kökü (App) bağlar, yalnız kasada (Uzaktan ve demo değil)', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const kok = app.slice(app.indexOf('export function App()'));
    // Erken dönüşlerden (müşteri ekranı, giriş ekranı) önce
    expect(kok.indexOf('useStalePageWatch(!REMOTE && !DEMO)')).toBeGreaterThan(0);
    expect(kok.indexOf('useStalePageWatch(')).toBeLessThan(kok.indexOf('return'));
  });
});
