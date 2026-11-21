/**
 * LafPOS Uzaktan (Vercel'deki salt okunur görünüm): VITE_LAFPOS_UZAKTAN=1 ile ayrı derlenir, api/uzaktan.ts'in kendi
 * işleyicisiyle (kafe bağlı değil: örnek gün, parolasız) Vercel'in yönlendirmeleriyle aynı statik sunucudan açılır.
 * Tarama (telefon, tablet, bilgisayar, koyu): ROUTES; giriş yokken İndir giriş ekranına döner, girişten sonra
 * menüde ve açılıyor; kafeden veri gelmemişken de (kabuksuz) açılıyor.
 * Üyelik (LAFPOS_UYE_EPOSTA, bellekte sahte Redis): ilk girişte parola belirlenir, yanlış parola girmez, doğrusu girer;
 * kafe bağlanmadan da İndir'e ulaşılır.
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
export const REMOTE_ROUTES = ['/patron', '/raporlar', '/merkez', '/indir'];

/** Üyelik akışının örnek üyesi (gerçek kimse değil) ve sahte Redis'in adresi */
const MEMBER = { email: 'uye@ornek.test', password: 'ornek-parola-2026', invite: 'ORNK-2026-DAVT' };
const REDIS_URL = 'https://redis.e2e';
const redisStore = new Map();

/** Upstash REST'in bellekteki karşılığı: işleyicinin kullandığı komutlar */
function fakeRedis() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== REDIS_URL) return realFetch(input, init);
    const [cmd, key, ...rest] = JSON.parse(String(init.body));
    let result = null;
    if (cmd === 'GET') result = redisStore.get(key) ?? null;
    else if (cmd === 'MGET') result = [key, ...rest].map((k) => redisStore.get(k) ?? null);
    else if (cmd === 'SET') {
      if (rest.includes('NX') && redisStore.has(key)) result = null;
      else (redisStore.set(key, rest[0]), (result = 'OK'));
    } else if (cmd === 'INCR') (redisStore.set(key, String(Number(redisStore.get(key) ?? 0) + 1)), (result = Number(redisStore.get(key))));
    else if (cmd === 'DEL') (redisStore.delete(key), (result = 1));
    else if (cmd === 'EXPIRE') result = redisStore.has(key) ? 1 : 0;
    // Dükkânların özet sürümü (hash; kafe bağlı değilken boş)
    else if (cmd === 'HGETALL') result = Object.entries(JSON.parse(redisStore.get(key) ?? '{}')).flat();
    else if (cmd === 'HGET') result = JSON.parse(redisStore.get(key) ?? '{}')[rest[0]] ?? null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  return () => (globalThis.fetch = realFetch);
}

/** Üyeliği açar ya da kapatır: işleyici ortamı her istekte okur */
function memberMode(on) {
  const vars = { LAFPOS_UYE_EPOSTA: MEMBER.email, LAFPOS_UYE_DAVET: MEMBER.invite, LAFPOS_CLOUD_SECRET: 'e'.repeat(40), KV_REST_API_URL: REDIS_URL, KV_REST_API_TOKEN: 't' };
  for (const [k, v] of Object.entries(vars)) on ? (process.env[k] = v) : delete process.env[k];
}

/** Güncelleme kanalının örneği: İndir sayfası sürümü buradan yazar */
const MANIFEST = { v: 1, build: 1795100000, version: '0.2.0', date: '2026-11-20T10:00:00.000Z', app: { file: 'lafpos-app-1795100000.zip', sha256: 'a'.repeat(64), size: 1 } };

async function startRemote() {
  execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_LAFPOS_UZAKTAN: '1' },
  });
  // Kafe bağlı değil: Redis ve anahtar yok, işleyici örnek günü açar
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA']) delete process.env[k];
  const restoreFetch = fakeRedis();
  const handler = await tsImport(join(ROOT, 'api/uzaktan.ts'), import.meta.url);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const method = req.method ?? 'GET';
        // Vercel gibi: koşullu istek (If-None-Match) ve seçili dükkân da işleve gider
        const pass = Object.fromEntries(['if-none-match', 'x-laf-dukkan'].filter((h) => req.headers[h]).map((h) => [h, String(req.headers[h])]));
        const r = await handler[method](new Request(`https://lafpos.vercel.app${req.url}`, { method, headers: { authorization: req.headers.authorization ?? '', 'content-type': req.headers['content-type'] ?? 'application/json', ...pass }, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) }));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(r.status === 304 ? undefined : Buffer.from(await r.arrayBuffer()));
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
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      restoreFetch();
      memberMode(false);
      return new Promise((ok) => server.close(ok));
    },
  };
}

async function open(browser, viewport) {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce' });
  await context.route(/^https:\/\/laffogato\.net\//, (r) => r.fulfill({ status: 404 }));
  const page = await context.newPage();
  const problems = [];
  // Yanıt kodları aşağıda ayrıca sayılır (beklenenler ayıklanarak); tarayıcının aynı yanıt için yazdığı satır sayılmaz
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && problems.push(`konsol: ${m.text().slice(0, 200)}`));
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

const installerLink = (page) => page.locator('a[href="/guncelleme/LafPOS-Kur.cmd"]').waitFor({ timeout: 20_000 });

/**
 * Örnek günde parolasız giriş kendiliğinden olur; giriş ekranından çıkana dek bekler. ?uzaktan=1: kafe bağlı değilken
 * site demoya (/demo/) döner, bu işaret örnek özetle uzaktan görünümde tutar (src/main.tsx)
 */
async function signIn(page, base) {
  await page.goto(`${base}/giris?uzaktan=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.pathname !== '/giris', { timeout: 15_000 });
  await settle(page);
}

/**
 * Üyelik: ilk girişte "Üyeliği oluştur" (davet kodu, parola iki kez); kafe bağlanmadığı için girişten sonra doğrudan
 * İndir ("Kafe henüz bağlanmadı"); ikinci girişte davet sorulmaz, yanlış parola girmez, doğrusu girer. Sayfa sayısını döner
 */
async function memberFlow(browser, base, viewport, failures) {
  const where = (r) => `uzaktan · ${viewport} · üyelik › ${r}`;
  const shot = (page, name) => page.screenshot({ path: join(ROOT, 'e2e/out', `uzaktan-${viewport}-uyelik-${name}.png`) });
  redisStore.clear();
  memberMode(true);
  let pages = 0;
  const first = await open(browser, viewport);
  try {
    const { page, problems } = first;
    await page.goto(`${base}/giris`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Üyeliği oluştur' }).waitFor({ timeout: 15_000 });
    // Kafe bağlı değilken de demoya dönülmez (üye programı buradan indirir); demo bağlantı olarak durur
    if ((await page.locator('a[href="/demo/"]').count()) !== 1) problems.push('giriş ekranında demo bağlantısı yok');
    await check(page, viewport, problems);
    await shot(page, 'olustur');
    pages++;
    // İki parola aynı değilse üyelik açılmaz
    await page.locator('#eposta').fill(MEMBER.email);
    await page.locator('#davet').fill(MEMBER.invite.toLowerCase());
    await page.locator('#parola').fill(MEMBER.password);
    await page.locator('#parola2').fill(`${MEMBER.password}x`);
    await page.getByRole('button', { name: 'Üyeliği oluştur' }).click();
    await page.getByText('İki parola aynı değil').waitFor({ timeout: 5_000 });
    if (redisStore.has(`lafpos:uye:${MEMBER.email}`)) problems.push('parolalar farklıyken üyelik açıldı');
    await page.locator('#parola2').fill(MEMBER.password);
    await page.getByRole('button', { name: 'Üyeliği oluştur' }).click();
    // Kafe bağlı değil: giriş çalışır, canlı görünüm yerine doğrudan İndir açılır
    await page.getByText('Kafe henüz bağlanmadı').waitFor({ timeout: 15_000 });
    if (/ornek-parola/.test(redisStore.get(`lafpos:uye:${MEMBER.email}`) ?? 'ornek-parola')) problems.push('parola Redis\'e açık yazıldı ya da üyelik kaydı yok');
    await installerLink(page).catch(() => problems.push('üye girişinden sonra İndir bağlantısı yok'));
    if ((await page.getByRole('button', { name: 'Çıkış' }).count()) !== 1) problems.push('üye oturumunda Çıkış yok');
    await settle(page);
    await check(page, viewport, problems);
    await shot(page, 'indir');
    pages++;
    for (const p of problems) failures.push(`${where('ilk giriş')}: ${p}`);
  } catch (e) {
    failures.push(`${where('ilk giriş')}: ${String(e?.message ?? e).split('\n')[0]}`);
    await shot(first.page, 'hata-ilk').catch(() => null);
  } finally {
    await first.context.close();
  }
  const second = await open(browser, viewport);
  try {
    const { page, problems } = second;
    // Yanlış parolanın 401'i beklenir
    const expected = (p) => p === 'istek 401: /api/uzaktan/giris';
    await page.goto(`${base}/patron`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Üye girişi' }).waitFor({ timeout: 15_000 });
    if ((await page.locator('#parola2, #davet').count()) > 0) problems.push('üyelik varken davet kodu ya da parola yeniden soruldu');
    await page.locator('#eposta').fill(MEMBER.email);
    await page.locator('#parola').fill('yanlis-parola-1');
    await page.getByRole('button', { name: 'Giriş' }).click();
    await page.getByText('E-posta ya da parola yanlış').waitFor({ timeout: 10_000 });
    await check(page, viewport, problems);
    await shot(page, 'giris');
    pages++;
    await page.locator('#parola').fill(MEMBER.password);
    await page.getByRole('button', { name: 'Giriş' }).click();
    await page.getByText('Kafe henüz bağlanmadı').waitFor({ timeout: 15_000 });
    for (const p of problems.filter((x) => !expected(x))) failures.push(`${where('giriş')}: ${p}`);
  } catch (e) {
    failures.push(`${where('giriş')}: ${String(e?.message ?? e).split('\n')[0]}`);
    await shot(second.page, 'hata-giris').catch(() => null);
  } finally {
    await second.context.close();
    memberMode(false);
  }
  return pages;
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
        await page.goto(`${server.base}/indir?uzaktan=1`, { waitUntil: 'domcontentloaded' });
        // Açılış birkaç kez yeniden dener, sonra kabuksuz İndir gelir
        await installerLink(page).catch(() => problems.push('veri yokken İndir bağlantısı yok'));
        await settle(page);
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
      pages += await memberFlow(browser, server.base, viewport, failures);
    }
  } finally {
    await server.stop();
    rmSync(OUT, { recursive: true, force: true });
  }
  return { failures, pages };
}
