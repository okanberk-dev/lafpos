/**
 * LafPOS Uzaktan (Vercel'deki salt okunur görünüm): VITE_LAFPOS_UZAKTAN=1 ile ayrı derlenir, api/uzaktan.ts'in kendi
 * işleyicisiyle (kafe bağlı değil: örnek gün, parolasız) Vercel'in yönlendirmeleriyle aynı statik sunucudan açılır.
 * Tarama (telefon, tablet, bilgisayar, koyu): ROUTES; giriş yokken İndir giriş ekranına döner, girişten sonra
 * menüde ve açılıyor; kafeden veri gelmemişken de (kabuksuz) açılıyor.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { overflowReport, ROOT, settle, smallTargets, VIEWPORTS } from './lib.mjs';

const OUT = join(ROOT, 'dist/uzaktan-e2e');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

/** Uzaktan taranan ekranlar (tests/web-kurucu.test.ts İndir'in burada olduğunu denetler) */
export const REMOTE_ROUTES = ['/patron', '/raporlar', '/indir'];

/** Güncelleme kanalının örneği: İndir sayfası sürümü buradan yazar */
const MANIFEST = { v: 1, build: 1795100000, version: '0.2.0', date: '2026-11-20T10:00:00.000Z', app: { file: 'lafpos-app-1795100000.zip', sha256: 'a'.repeat(64), size: 1 } };

async function startRemote() {
  execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_LAFPOS_UZAKTAN: '1' },
  });
  // Kafe bağlı değil: Redis ve anahtar yok, işleyici örnek günü açar
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_DEMO']) delete process.env[k];
  const handler = await tsImport(join(ROOT, 'api/uzaktan.ts'), import.meta.url);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const method = req.method ?? 'GET';
        const r = await handler[method](new Request(`https://lafpos.vercel.app${req.url}`, { method, headers: { authorization: req.headers.authorization ?? '', 'content-type': req.headers['content-type'] ?? 'application/json' }, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) }));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      if (url.pathname === '/guncelleme/surum.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(MANIFEST));
        return;
      }
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(OUT, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        if (path.startsWith('/assets/') || path.startsWith('/guncelleme/')) {
          res.writeHead(404).end();
          return;
        }
        file = join(OUT, 'index.html');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((ok) => server.close(ok)) };
}

async function open(browser, viewport) {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce' });
  await context.route(/^https:\/\/laffogato\.net\//, (r) => r.fulfill({ status: 404 }));
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`konsol: ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => problems.push(`sayfa hatası: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && u.host !== 'laffogato.net' && !(r.status() === 503 && u.pathname === '/api/bootstrap')) problems.push(`istek ${r.status()}: ${u.pathname}`);
  });
  return { context, page, problems };
}

async function check(page, viewport, problems) {
  const overflow = await overflowReport(page);
  if (overflow.page > 1) problems.push(`sayfa ${overflow.page} px yatay taşıyor`);
  for (const o of overflow.items) problems.push(`taşan öğe: ${o.text} (sol ${o.left}, sağ ${o.right})`);
  if (VIEWPORTS[viewport].hasTouch) {
    const small = await smallTargets(page);
    if (small.length) problems.push(`44 px altı ${small.length} hedef: ${small.slice(0, 6).join(', ')}`);
  }
}

/** Örnek günde parolasız giriş kendiliğinden olur; giriş ekranından çıkana dek bekler */
async function signIn(page, base) {
  await page.goto(`${base}/giris`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.pathname !== '/giris', { timeout: 15_000 });
  await settle(page);
}

export async function runRemote(browser) {
  const server = await startRemote();
  mkdirSync(join(ROOT, 'e2e/out'), { recursive: true });
  const failures = [];
  let pages = 0;
  try {
    for (const viewport of Object.keys(VIEWPORTS)) {
      const { context, page, problems } = await open(browser, viewport);
      const where = (r) => `uzaktan · ${viewport} · ${r}`;
      try {
        // Oturum yokken İndir açılmaz: parolalı kurulumda giriş ekranında kalınır, indirme bağlantısı yok
        const locked = (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ secret: true, password: true, redis: true, snapshotAt: null, demo: false, open: false }) });
        await context.route('**/api/uzaktan/kurulum', locked);
        await page.goto(`${server.base}/indir`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'Üye girişi' }).waitFor({ timeout: 15_000 });
        if (new URL(page.url()).pathname !== '/giris') failures.push(`${where('/indir')}: oturumsuz giriş ekranına dönmedi (${new URL(page.url()).pathname})`);
        if ((await page.locator('a[href$="LafPOS-Kur.cmd"], a[href="/indir"]').count()) > 0) failures.push(`${where('/indir')}: oturumsuz indirme bağlantısı göründü`);
        await check(page, viewport, problems);
        await page.screenshot({ path: join(ROOT, 'e2e/out', `uzaktan-${viewport}-giris.png`) });
        pages++;
        for (const p of problems) failures.push(`${where('/giris')}: ${p}`);
        await context.unroute('**/api/uzaktan/kurulum', locked);
        await signIn(page, server.base);
        for (const route of REMOTE_ROUTES) {
          problems.length = 0;
          await page.evaluate((to) => {
            history.pushState(null, '', to);
            dispatchEvent(new PopStateEvent('popstate'));
          }, route);
          await settle(page);
          if (new URL(page.url()).pathname !== route) problems.push(`yönlendirildi: ${new URL(page.url()).pathname}`);
          if (route === '/indir') {
            const link = page.locator('a[href="/guncelleme/LafPOS-Kur.cmd"]');
            if ((await link.count()) !== 1) problems.push('İndir bağlantısı yok');
            if ((await page.getByText('Son sürüm 0.2.0').count()) === 0) problems.push('sürüm satırı yok');
            // Menüde İndir (telefonda alt sekmede ya da Daha'da)
            if ((await page.locator('a[href="/indir"]').count()) === 0) problems.push('menüde İndir yok');
          }
          await check(page, viewport, problems);
          await page.screenshot({ path: join(ROOT, 'e2e/out', `uzaktan-${viewport}-${route.slice(1)}.png`) });
          pages++;
          for (const p of problems) failures.push(`${where(route)}: ${p}`);
        }
        // Kafeden veri gelmemiş: kabuk açılamaz, İndir kabuksuz açılır
        problems.length = 0;
        await context.route('**/api/bootstrap', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Kafeden henüz veri gelmedi', code: 'no_snapshot' }) }));
        await page.goto(`${server.base}/indir`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if ((await page.locator('a[href="/guncelleme/LafPOS-Kur.cmd"]').count()) !== 1) problems.push('veri yokken İndir bağlantısı yok');
        await check(page, viewport, problems);
        await page.screenshot({ path: join(ROOT, 'e2e/out', `uzaktan-${viewport}-indir-veri-yok.png`) });
        pages++;
        for (const p of problems) failures.push(`${where('/indir › veri-yok')}: ${p}`);
      } catch (e) {
        failures.push(`${where('akış')}: ${String(e?.message ?? e).split('\n')[0]}`);
        await page.screenshot({ path: join(ROOT, 'e2e/out', `hata-uzaktan-${viewport}.png`) }).catch(() => null);
      } finally {
        await context.close();
      }
    }
  } finally {
    await server.stop();
    rmSync(OUT, { recursive: true, force: true });
  }
  return { failures, pages };
}
