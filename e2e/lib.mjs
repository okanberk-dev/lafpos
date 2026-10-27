/**
 * Uçtan uca testlerin ortak parçaları: sunucuyu geçici veriyle başlatma, API ile oturum ve örnek veri,
 * tarayıcı (sistemdeki Chrome, playwright-core) ve sayfa denetimleri.
 *
 * Yöntem anthropics/skills `webapp-testing` skill'inden uyarlandı (bkz. .claude/skills/webapp-testing):
 * sunucunun yaşam döngüsünü betik yönetir, sayfa yüklenince önce gözlenir, sonra eylem yapılır.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PINS = { patron: '1897', mudur: '2468', kasa: '1111', garson: '2222', bar: '3333' };

/** Telefon dokunmatik ve ince imleçsiz; tablet dokunmatik; bilgisayar fare */
export const VIEWPORTS = {
  telefon: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  bilgisayar: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  /** Koyu tema (sistem ayarı): yalnız patronun ekranları taranır */
  koyu: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' },
};

async function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Derlenmiş arayüzü sunan üretim sunucusunu boş bir veri klasörüyle başlatır (ilk açılışta örnek kurulum yüklenir). */
export async function startServer() {
  if (!existsSync(join(ROOT, 'dist/web/index.html'))) throw new Error('Önce arayüzü derleyin: npm run build');
  const dataDir = mkdtempSync(join(tmpdir(), 'lafpos-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', LAFPOS_DATA_DIR: dataDir, LAFPOS_PORT: String(port), LAFPOS_HOST: '127.0.0.1', LAFPOS_NO_JOBS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`Sunucu açılamadı:\n${log}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* henüz dinlemiyor */
    }
    if (Date.now() > deadline) throw new Error(`Sunucu 30 sn içinde hazır olmadı:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    base,
    log: () => log,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function apiClient(base) {
  const tokens = {};
  async function call(who, method, path, body) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text && (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : text;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return json;
  }
  return {
    tokens,
    call,
    async loginAll() {
      for (const [who, pin] of Object.entries(PINS)) tokens[who] = (await call('', 'POST', '/auth/login', { pin })).token;
    },
  };
}

/** Ekranlar boş görünmesin: gün açık, bir masada hazır kalem, bir masada hesap istenmiş, bir tezgâh siparişi */
export async function seedFloor(api) {
  const boot = await api.call('kasa', 'GET', '/bootstrap');
  await api.call('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
  // Kurulum self serviste açılır; kasa taraması ve akışlar masalı sürümü (masaya servis) dener, demo self servisi
  await api.call('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
  const product = (name) => boot.products.find((p) => p.name === name);
  const tables = boot.tables.filter((t) => t.kind === 'masa');
  const s1 = await api.call('garson', 'POST', '/orders', { type: 'masa', tableId: tables[0].id, guests: 2 });
  // Kalem eklemek siparişi bara/mutfağa gönderir
  const filled = await api.call('garson', 'POST', `/orders/${s1.id}/items`, {
    items: [
      { productId: product('Latte').id, size: 'M', qty: 2 },
      { productId: product('Türk Kahvesi').id, qty: 1 },
    ],
  });
  await api.call('bar', 'POST', '/kitchen/status', { itemIds: [filled.items[0].id], status: 'hazir' });
  const s2 = await api.call('garson', 'POST', '/orders', { type: 'masa', tableId: tables[1].id, guests: 1 });
  await api.call('garson', 'POST', `/orders/${s2.id}/items`, { items: [{ productId: product('Espresso').id, qty: 1 }] });
  await api.call('kasa', 'POST', `/orders/${s2.id}/bill`, {});
  const tz = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
  await api.call('kasa', 'POST', `/orders/${tz.id}/items`, { items: [{ productId: product('Latte').id, size: 'L', qty: 1 }] });
  return { boot, s1, s2, tz, tables };
}

export async function launchBrowser() {
  const executablePath = process.env.LAFPOS_E2E_CHROME || undefined;
  return chromium.launch({ headless: process.env.LAFPOS_E2E_HEADED !== '1', ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
}

/** Rolün oturum jetonunu sayfa açılmadan yerleştirir; konsol ve ağ hatalarını toplar */
export async function openContext(browser, viewport, token) {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce' });
  if (token) await context.addInitScript((t) => localStorage.setItem('lafpos.token', t), token);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`konsol: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`sayfa hatası: ${e.message.slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`istek ${r.status()}: ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return { context, page, problems };
}

/** Yükleme göstergeleri kaybolana dek bekler (SSE bağlantısı açık kaldığı için ağ sessizliği beklenmez) */
export async function settle(page) {
  await page.waitForLoadState('load');
  await page
    .waitForFunction(() => {
      const main = document.querySelector('main') ?? document.querySelector('#root > *');
      if (!main) return false;
      const text = document.body.innerText;
      return !/LafPOS (açılıyor|hazırlanıyor)/.test(text) && !document.querySelector('main .animate-spin');
    }, null, { timeout: 8000 })
    .catch(() => null);
  await page.waitForTimeout(250);
}

/**
 * Yatay taşma: ekran dışına uzanan ve yatay kaydırılabilir bir kabın içinde olmayan görünür öğeler.
 * Tablo ve şerit gibi bilerek kayan kaplar sayılmaz; kırpılan içerik sayılır.
 */
export async function overflowReport(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : '';
      return `${el.tagName.toLowerCase()}${id}${cls} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    };
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (el.closest('[aria-hidden="true"], .sr-only, [data-overflow-ok]')) continue;
      if (inScroller(el)) continue;
      // Taşan öğenin içindekileri ayrıca sayma: en dıştaki yeter
      if (bad.some((b) => b.el.contains(el))) continue;
      bad.push({ el, text: describe(el), right: Math.round(r.right), left: Math.round(r.left) });
    }
    return { page: document.documentElement.scrollWidth - vw, items: bad.slice(0, 8).map(({ text, right, left }) => ({ text, right, left })) };
  });
}

/** Ekrandaki etkileşimli öğelerden 44 px'ten küçük olanlar (AGENTS.md kural 8) */
export async function smallTargets(page, min = 44) {
  return page.evaluate((min) => {
    const sel = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="tab"], summary';
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"], [inert], [data-tap-ok]')) continue;
      let target = el;
      if (el.matches('input[type="checkbox"], input[type="radio"], input[type="color"]')) target = el.closest('label') ?? el;
      if (seen.has(target)) continue;
      seen.add(target);
      const r = target.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const st = getComputedStyle(target);
      if (st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      // Cümlenin içindeki bağlantı WCAG 2.5.8'in "satır içi" istisnası: metinle birlikte akar
      if (target.tagName === 'A' && st.display === 'inline') continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (Math.min(r.width, r.height) + 0.5 < min) {
        const label = (target.getAttribute('aria-label') || target.textContent || target.getAttribute('placeholder') || target.tagName).trim().replace(/\s+/g, ' ');
        out.push(`${label.slice(0, 32)} (${Math.round(r.width)}×${Math.round(r.height)})`);
      }
    }
    return out;
  }, min);
}
