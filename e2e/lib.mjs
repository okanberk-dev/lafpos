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
  /** Dokunmatik ekranlı kasa bilgisayarı (fare de bağlı: birincil giriş fare, ama dokunmatik): kasa ve garson ekranları, 44 px */
  'dokunmatik-pc': { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, hasTouch: true },
  /** Koyu tema (sistem ayarı): yalnız patronun ekranları taranır */
  koyu: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' },
  /** Koyu tema telefonda (patronun en sık baktığı yer): yalnız patronun ekranları */
  'koyu-telefon': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' },
};

export async function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/**
 * Derlenmiş arayüzü sunan üretim sunucusunu boş bir veri klasörüyle başlatır (ilk açılışta örnek kurulum yüklenir).
 * `jobs`: arka plan işleri açık (internet kesintisi denemesi); `env`: ek ayarlar (ör. sahte lafmaliyet adresi)
 */
export async function startServer({ jobs = false, env: extra = {} } = {}) {
  if (!existsSync(join(ROOT, 'dist/web/index.html'))) throw new Error('Önce arayüzü derleyin: npm run build');
  const dataDir = mkdtempSync(join(tmpdir(), 'lafpos-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    // Ayarlar dosyası veri klasöründe (Windows kurulumundaki ayarlar.env gibi): Yönetim › Bağlantı bilgileri yazabilsin
    env: { ...process.env, NODE_ENV: 'production', LAFPOS_DATA_DIR: dataDir, LAFPOS_PORT: String(port), LAFPOS_HOST: '127.0.0.1', LAFPOS_AYAR_DOSYASI: join(dataDir, 'ayarlar.env'), ...(jobs ? {} : { LAFPOS_NO_JOBS: '1' }), ...extra },
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
 * Yatay taşma: ekran dışına uzanan ve yatay kaydırılabilir bir kabın içinde olmayan görünür öğeler, ayrıca yana da
 * kayan sayfa kabı (dikey kaydırma kabı). Tablo ve şerit gibi bilerek kayan kaplar sayılmaz; kırpılan içerik sayılır.
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
    // Sol menü (ray): içindeki hiçbir öğe rayın kutusundan taşmaz (sahibin bildirdiği üst üste binme, 22 Kas 2026)
    const rail = document.querySelector('nav.lp-rail');
    if (rail && rail.offsetParent) {
      const rr = rail.getBoundingClientRect();
      for (const el of rail.querySelectorAll('a, button, [role="status"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Kayan ekran listesinin içindekiler dikeyde listeyle kırpılır; yatayda ve dipte (foot) taşma hata
        const inList = !!el.closest('.lp-rail-list');
        if (r.right > rr.right + 1 || r.left < rr.left - 1 || (!inList && (r.bottom > rr.bottom + 1 || r.top < rr.top - 1))) bad.push({ el, text: `rayda taşan ${describe(el)}`, right: Math.round(r.right), left: Math.round(r.left) });
      }
    }
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
    // Sayfanın kaydırma kabı yana kaymamalı. overflow-y: auto, overflow-x'i de auto yapar: telefondan geniş sayfa yana
    // kayan bir sayfa olur, içindekileri de yukarıdaki inScroller muaf tuttuğu için taşma görünmezdi (Patron 390 px
    // telefonda 462 px genişti). Bilerek yana kayan kap (overflow-x-auto: ray, tablo) sayılmaz; kaydırma sınıfı
    // varyantlı da olabilir (max-md:overflow-y-auto)
    for (const el of document.querySelectorAll('main [class*="overflow-y-auto"]:not([class*="overflow-x-auto"])')) {
      if (el.closest('[aria-hidden="true"], [data-overflow-ok]')) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (bad.some((b) => b.el.contains(el))) continue;
      bad.push({ el, text: `${describe(el)} yatay kayıyor (${el.scrollWidth - el.clientWidth} px)`, right: Math.round(r.right), left: Math.round(r.left) });
    }
    /*
     * Okunmayan yazı (22 Kas 2026: ray beyaz olunca Araçlar çekmecesi, giriş kartı ve sepet çubuğunda beyaz zeminde
     * beyaz yazı kaldı; hiçbir denetim görmedi). Ekranda görünen her yazının rengi, altındaki gerçek zeminle
     * karşılaştırılır (yarı saydam katmanlar üst üste bindirilir); 3:1'in altı hata. Kapalı (disabled) denetimler,
     * fotoğraf üstü yazılar ve başka bir katmanın (pencere perdesi) altında kalanlar sayılmaz.
     */
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const memo = new Map();
    const rgba = (css) => {
      if (memo.has(css)) return memo.get(css);
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#000';
      cx.fillStyle = css;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      const a = d[3] / 255;
      // Tuval renkleri alfa ile çarpılmış saklar: geri böl
      const out = a ? [d[0], d[1], d[2], a] : [0, 0, 0, 0];
      memo.set(css, out);
      return out;
    };
    const over = (top, under) => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (!a) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
    };
    const lum = (c) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const STOP = /rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8}\b/gi;
    /** Öğenin kendi zemin katmanı: düz renk, degradenin ortalama rengi; fotoğraf varsa null (bilinmez) */
    const layer = (st) => {
      let c = rgba(st.backgroundColor);
      const img = st.backgroundImage;
      if (img && img !== 'none') {
        if (img.includes('url(')) return null;
        const stops = (img.match(STOP) ?? []).map(rgba).filter((x) => x[3] > 0.5);
        if (stops.length) c = over([0, 1, 2].map((i) => stops.reduce((n, x) => n + x[i], 0) / stops.length).concat(1), c);
      }
      return c;
    };
    const faint = [];
    const seen = new Set();
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || !node.nodeValue.trim()) continue;
      if (el.closest('svg, .sr-only, [data-contrast-ok], :disabled, [aria-disabled="true"], option, script, style, noscript')) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      // Üstünde başka katman varsa (pencere perdesi, açık çekmece) bu yazı zaten görünmüyor
      const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2)));
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
      seen.add(el);
      const fill = st.webkitTextFillColor && st.webkitTextFillColor !== 'currentcolor' ? st.webkitTextFillColor : st.color;
      let fg = rgba(fill);
      let bg = [0, 0, 0, 0];
      let unknown = false;
      const stack = [];
      for (let p = el; p; p = p.parentElement) {
        const ps = p === el ? st : getComputedStyle(p);
        const l = layer(ps);
        if (!l) {
          unknown = true;
          break;
        }
        stack.push({ l, o: Number(ps.opacity) });
        if (l[3] >= 0.999 && Number(ps.opacity) >= 0.999) break;
      }
      if (unknown) continue;
      // Katmanları alttan üste bindir; saydamlık (opacity) hem zemini hem yazıyı soldurur
      let alpha = 1;
      for (let i = stack.length - 1; i >= 0; i--) {
        const { l, o } = stack[i];
        alpha *= o;
        bg = over([l[0], l[1], l[2], l[3] * alpha], bg);
      }
      if (bg[3] < 0.999) bg = over(bg, [255, 255, 255, 1]);
      fg = over([fg[0], fg[1], fg[2], fg[3] * alpha], bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio >= 3) continue;
      const hex = (c) => `#${[0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('')}`;
      faint.push({ kind: 'okunmayan yazı', text: `${describe(el)} ${ratio.toFixed(1)}:1 (yazı ${hex(fg)}, zemin ${hex(bg)})`, right: Math.round(r.right), left: Math.round(r.left) });
    }
    return {
      page: document.documentElement.scrollWidth - vw,
      items: [...bad.slice(0, 8).map(({ text, right, left }) => ({ text, right, left })), ...faint.slice(0, 8)],
    };
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
