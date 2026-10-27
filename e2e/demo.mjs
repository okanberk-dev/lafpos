/**
 * Tarayıcı demosu (dist/web/demo, lafpos.vercel.app/demo): LafPOS sunucusu sayfanın içinde çalışır. Derlenmiş
 * dosyalar Vercel'in yönlendirmeleriyle aynı statik sunucudan açılır. PIN ekranı yok; tarama (telefon, tablet,
 * bilgisayar, koyu), akışlar ve iki sekme. Site görselleri ağa çıkmaz, boş görselle yanıtlanır.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { overflowReport, ROOT, settle, smallTargets, VIEWPORTS } from './lib.mjs';

const WEB = join(ROOT, 'dist/web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
/** 1×1 saydam PNG: laffogato.net görselleri yerine */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Demo her denetimde yeniden derlenir (kasa derlemesi `npm run build` onu silmiş olabilir, eski kalmış da olabilir).
 * vercel.json'daki gibi sunulur: dosya varsa o; /demo altında olmayan derleme dosyası 404 (yeni sürümde eski sekme
 * yenilensin), diğerleri demo sayfası; gerisi kasa sayfası.
 */
export async function startStatic() {
  if (!existsSync(join(WEB, 'index.html'))) throw new Error('Önce arayüzü derleyin: npm run build');
  execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'demo', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(WEB, path);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (path.startsWith('/demo/assets/')) {
        res.writeHead(404).end();
        return;
      }
      file = join(WEB, path.startsWith('/demo') ? 'demo/index.html' : 'index.html');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((ok) => server.close(ok)) };
}

async function openDemo(browser, viewport, role = 'patron') {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce' });
  await context.route(/^https:\/\/laffogato\.net\//, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  await context.addInitScript((r) => localStorage.setItem('lafpos.demo.rol', r), role);
  const problems = [];
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && problems.push(`konsol: ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => problems.push(`sayfa hatası: ${e.message.slice(0, 200)}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`istek ${r.status()}: ${new URL(r.url()).pathname}`));
  };
  const page = await context.newPage();
  watch(page);
  return { context, page, problems, watch };
}

/** Demo açılana dek bekler: ilk açılışta sql.js yüklenir, kurulum ve örnek gün işlenir */
async function ready(page) {
  await page.getByText('LafPOS demosu hazırlanıyor').waitFor({ state: 'detached', timeout: 20_000 });
  await settle(page);
}

/** Demo self serviste açılır: satış ekranı (menü), bar, çağrı ve müşteri ekranı; masa planı şeritten açılan sürümde */
const SWEEP = {
  patron: ['/satis', '/masalar', '/patron', '/kasa', '/raporlar', '/siparisler', '/mutfak', '/cagri', '/yonetim', '/musteri-ekrani', '/giris'],
  garson: ['/satis'],
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function sweep(base, browser) {
  const failures = [];
  let pages = 0;
  for (const viewport of Object.keys(VIEWPORTS)) {
    for (const [role, routes] of Object.entries(SWEEP)) {
      if (viewport === 'koyu' && role !== 'patron') continue;
      const { context, page, problems } = await openDemo(browser, viewport, role);
      await page.goto(`${base}/demo/`, { waitUntil: 'domcontentloaded' });
      await ready(page);
      for (const route of routes) {
        problems.length = 0;
        // Yönlendirici içinden: tam sayfa yüklemesi demoyu her ekranda yeniden açardı
        await page.evaluate((to) => {
          history.pushState(null, '', to);
          dispatchEvent(new PopStateEvent('popstate'));
        }, `/demo${route}`);
        await settle(page);
        const where = `demo · ${viewport} · ${role} · ${route}`;
        if (route === '/giris') {
          // Çıkıştan sonra PIN değil rol seçimi
          if ((await page.getByText('Kimle devam edelim?').count()) === 0 && (await page.getByText("PIN kodunuzu girin").count()) > 0) problems.push('PIN ekranı göründü');
        }
        const overflow = await overflowReport(page);
        if (overflow.page > 1) problems.push(`sayfa ${overflow.page} px yatay taşıyor`);
        for (const o of overflow.items) problems.push(`taşan öğe: ${o.text} (sol ${o.left}, sağ ${o.right})`);
        if (VIEWPORTS[viewport].hasTouch) {
          const small = await smallTargets(page);
          if (small.length) problems.push(`44 px altı ${small.length} hedef: ${small.slice(0, 6).join(', ')}`);
        }
        await page.screenshot({ path: join(ROOT, 'e2e/out', `demo-${viewport}-${role}-${route.slice(1) || 'kok'}.png`) });
        pages++;
        for (const p of problems) failures.push(`${where}: ${p}`);
      }
      await context.close();
    }
  }
  return { failures, pages };
}

async function flow(browser, base, fn) {
  const { context, page, problems, watch } = await openDemo(browser, 'bilgisayar');
  try {
    await page.goto(`${base}/demo/`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await fn(page, context, watch);
    assert(problems.length === 0, problems.join(' | '));
  } catch (e) {
    await page.screenshot({ path: join(ROOT, 'e2e/out/hata-demo.png') }).catch(() => null);
    throw e;
  } finally {
    await context.close();
  }
}

/** Sayfanın içindeki sunucuya istek (demo oturumuyla) */
const api = (page, method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(`/api${p}`, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('lafpos.demo.token')}` }, body: b === undefined ? undefined : JSON.stringify(b) });
      return res.json();
    },
    [method, path, body],
  );

export async function runDemo(browser) {
  const server = await startStatic();
  const results = [];
  try {
    const { failures, pages } = await sweep(server.base, browser);
    for (const f of failures) console.log(`  HATA   ${f}`);
    console.log(`Demo taraması: ${pages} ekran, ${failures.length} sorun`);
    if (failures.length) results.push({ name: 'Demo taraması', ok: false, error: `${failures.length} sorun` });

    const flows = [
      [
        'Demo PIN sormadan self servis satış ekranında açılır: menü var, masa planı yok',
        async (page) => {
          assert(/^\/demo\/adisyon\//.test(new URL(page.url()).pathname), `açılış adresi: ${page.url()}`);
          assert((await page.getByText('PIN kodunuzu girin').count()) === 0, 'PIN ekranı göründü');
          await page.getByPlaceholder('Ürün ara').waitFor();
          assert((await page.getByRole('link', { name: 'Masalar', exact: true }).count()) === 0, 'self serviste Masalar menüde');
          const boot = await api(page, 'GET', '/bootstrap');
          assert(boot.day?.zNo === 1 && boot.settings.serviceMode === 'self', `gün ya da mod: ${boot.day?.zNo} ${boot.settings.serviceMode}`);
        },
      ],
      [
        'Demo: tezgâhta ürün ekler, önce öder; numara çağrı ekranında; yenileyince veri kalır',
        async (page) => {
          const boot = await api(page, 'GET', '/bootstrap');
          const simple = boot.products.find((p) => p.active && !p.hidden && p.priceL == null && p.optionGroupIds.length === 0 && !p.isService);
          const orderId = new URL(page.url()).pathname.split('/').pop();
          await page.getByPlaceholder('Ürün ara').fill(simple.name);
          await page.getByRole('button', { name: new RegExp(`^${simple.shortName || simple.name}`) }).first().click();
          await page.getByRole('button', { name: /^Öde · / }).click();
          await page.getByRole('button', { name: 'Nakit', exact: true }).click();
          await page.getByRole('button', { name: 'Tam', exact: true }).click();
          await page.getByRole('button', { name: /Nakit al$/ }).click();
          await page.getByRole('heading', { name: 'Adisyon kapandı' }).waitFor({ timeout: 8000 });
          // Bekleme yok: yazan istek yanıtını kayıt bittikten sonra alır
          await page.reload({ waitUntil: 'domcontentloaded' });
          await ready(page);
          const order = await api(page, 'GET', `/orders/${orderId}`);
          assert(order.status === 'kapali' && order.items[0]?.productId === simple.id, `yenileyince adisyon: ${order.status}`);
          const board = await api(page, 'GET', '/public/board');
          assert([...board.preparing, ...board.ready].some((e) => e.id === orderId), 'numara çağrı ekranında yok');
        },
      ],
      [
        'Demo: garsona geçer; indirim PIN yerine "Müdür onaylasın" ile',
        async (page) => {
          await page.getByLabel('Demo rolü').selectOption('garson');
          await page.waitForFunction(() => document.body.innerText.includes('GA'));
          const boot = await api(page, 'GET', '/bootstrap');
          const latte = boot.products.find((p) => p.name === 'Latte');
          const o = await api(page, 'POST', '/orders', { type: 'tezgah' });
          await api(page, 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }] });
          await page.evaluate((to) => {
            history.pushState(null, '', to);
            dispatchEvent(new PopStateEvent('popstate'));
          }, `/demo/adisyon/${o.id}`);
          await settle(page);
          await page.getByRole('button', { name: 'İşlemler' }).click();
          await page.getByRole('button', { name: /^Adisyon indirimi/ }).click();
          await page.getByRole('button', { name: '1', exact: true }).click();
          await page.getByRole('button', { name: '0', exact: true }).click();
          await page.getByRole('button', { name: 'Öğrenci', exact: true }).click();
          await page.getByRole('button', { name: 'Uygula', exact: true }).click();
          const approve = page.getByRole('button', { name: 'Müdür onaylasın' });
          await approve.waitFor({ timeout: 8000 });
          assert((await page.getByLabel('PIN').count()) === 0, 'onay penceresinde PIN alanı var');
          await approve.click();
          await page.getByText('İndirim uygulandı').waitFor({ timeout: 8000 });
          const after = await api(page, 'GET', `/orders/${o.id}`);
          assert(after.totals.orderDiscount > 0, 'indirim uygulanmadı');
        },
      ],
      [
        'Demo: ikinci sekme sunucuyu paylaşır; yazılan diğerinde canlı görünür',
        async (page, context, watch) => {
          await page.evaluate(() => {
            history.pushState(null, '', '/demo/siparisler');
            dispatchEvent(new PopStateEvent('popstate'));
          });
          await settle(page);
          const other = await context.newPage();
          watch(other);
          await other.goto(`${server.base}/demo/siparisler`, { waitUntil: 'domcontentloaded' });
          await ready(other);
          const boot = await api(other, 'GET', '/bootstrap');
          const latte = boot.products.find((p) => p.name === 'Latte');
          const o = await api(other, 'POST', '/orders', { type: 'tezgah' });
          await api(other, 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
          await page.waitForFunction((no) => document.body.innerText.includes(`#${no}`), o.no, { timeout: 8000 });
          const locks = await page.evaluate(() => navigator.locks.query());
          assert(locks.held.length === 1 && locks.pending.length === 1, `kilit: ${JSON.stringify(locks)}`);
        },
      ],
      [
        'Demo: şeritten masaya servise geçer ve geri döner; platform siparişi gelir, şeritten kabul edilir',
        async (page) => {
          await page.getByLabel('Servis modu').selectOption('masa');
          await page.waitForURL(/\/demo\/masalar$/, { timeout: 8000 });
          await page.getByRole('link', { name: 'Masalar', exact: true }).first().waitFor();
          await page.getByRole('button', { name: 'Platform siparişi gönder' }).click();
          await page.getByRole('button', { name: /onay bekliyor/ }).click();
          const dialog = page.getByRole('dialog', { name: 'Onay bekleyen platform siparişleri' });
          await dialog.getByRole('button', { name: /^Kabul et · \d+ dk$/ }).first().click();
          await page.getByText(/kabul edildi/).first().waitFor({ timeout: 8000 });
          const accepted = (await api(page, 'GET', '/platforms')).orders.filter((o) => o.status === 'kabul');
          assert(accepted.length >= 2, `kabul edilen platform siparişi: ${accepted.length}`);
          await page.getByLabel('Servis modu').selectOption('self');
          await page.waitForURL(/\/demo\/adisyon\//, { timeout: 8000 });
        },
      ],
      [
        'Demo: sıfırla ilk güne döner',
        async (page) => {
          const extra = await api(page, 'POST', '/orders', { type: 'tezgah' });
          assert(extra.id, 'adisyon açılmadı');
          await page.getByRole('button', { name: 'Demoyu sıfırla' }).click();
          await page.getByRole('dialog', { name: 'Demoyu sıfırla' }).getByRole('button', { name: 'Sıfırla', exact: true }).click();
          await page.waitForEvent('load');
          await ready(page);
          const gone = await api(page, 'GET', `/orders/${extra.id}`);
          assert(gone.code === 'not_found', `sıfırlamadan sonra adisyon duruyor: ${JSON.stringify(gone).slice(0, 80)}`);
          const boot = await api(page, 'GET', '/bootstrap');
          assert(boot.day?.zNo === 1 && boot.settings.serviceMode === 'self', 'ilk gün değil');
        },
      ],
    ];
    for (const [name, fn] of flows) {
      try {
        await flow(browser, server.base, fn);
        results.push({ name, ok: true });
      } catch (e) {
        results.push({ name, ok: false, error: e.message.split('\n')[0] });
      }
    }
  } finally {
    await server.stop();
  }
  return results;
}
