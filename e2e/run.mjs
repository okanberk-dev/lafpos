/**
 * LafPOS uçtan uca denetimi. Önce `npm run build`, sonra `npm run e2e`.
 *
 * 1. Tarama: her rol, izinli her ekranı telefon (390 px, dokunmatik), tablet (768 px, dokunmatik) ve
 *    bilgisayar (1280 px) boyutunda, patronun ekranlarını ayrıca koyu temada açar. Konsol ve sayfa hatası, 4xx/5xx istek, yatay taşma ve dokunmatik
 *    ekranda 44 px'ten küçük hedef arar; her ekranın görüntüsünü e2e/out/ altına kaydeder.
 * 2. Akışlar: e2e/flows.mjs (telefonda sipariş, ödeme, yönetimde düzenleme).
 *
 * Seçenekler: --only=tarama|akis  --viewports=telefon,tablet  --roles=patron  --routes=/yonetim/menu
 *             --targets=warn (küçük hedefleri yalnız raporla)
 * Sorun varsa çıkış kodu 1'dir.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFlows } from './flows.mjs';
import { apiClient, launchBrowser, openContext, overflowReport, ROOT, seedFloor, settle, smallTargets, startServer, VIEWPORTS } from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

const ROUTES = {
  giris: ['/giris'],
  patron: [
    '/patron',
    '/masalar',
    '/siparisler',
    '/mutfak',
    '/kasa',
    '/cihaz',
    '/musteriler',
    '/rezervasyon',
    '/raporlar',
    '/yonetim',
    '/yonetim/genel',
    '/yonetim/menu',
    '/yonetim/secenekler',
    '/yonetim/masa-plani',
    '/yonetim/personel',
    '/yonetim/odeme',
    '/yonetim/yazarkasa',
    '/yonetim/entegrasyon',
    '/yonetim/ayarlar',
    '/yonetim/denetim',
  ],
  garson: ['/masalar', '/siparisler', '/mutfak', '@s1'],
  kasa: ['/kasa', '/masalar', '@s2', '@tz', '/cihaz'],
  bar: ['/mutfak'],
};

const slug = (route) => route.replace(/^\/|^@/, '').replace(/[/?=&]+/g, '-') || 'kok';

async function sweep(server, api, seed, browser) {
  const outDir = join(ROOT, 'e2e/out');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const viewports = list(args.viewports) ?? Object.keys(VIEWPORTS);
  const roles = list(args.roles) ?? Object.keys(ROUTES);
  const only = list(args.routes);
  const strictTargets = args.targets !== 'warn';
  const failures = [];
  const warnings = [];
  let pages = 0;

  for (const viewport of viewports) {
    for (const role of roles) {
      if (viewport === 'koyu' && role !== 'patron') continue;
      const token = role === 'giris' ? null : api.tokens[role];
      const { context, page, problems } = await openContext(browser, viewport, token);
      for (const route of ROUTES[role]) {
        if (only && !only.includes(route)) continue;
        const target = route === '@s1' ? `/adisyon/${seed.s1.id}` : route === '@s2' ? `/adisyon/${seed.s2.id}` : route === '@tz' ? `/adisyon/${seed.tz.id}` : route;
        problems.length = 0;
        await page.goto(server.base + target, { waitUntil: 'domcontentloaded' });
        await settle(page);
        const where = `${viewport} · ${role} · ${route}`;
        const landed = new URL(page.url()).pathname;
        if (!landed.startsWith(target.split('?')[0])) problems.push(`yönlendirildi: ${landed}`);
        const overflow = await overflowReport(page);
        if (overflow.page > 1) problems.push(`sayfa ${overflow.page} px yatay taşıyor`);
        for (const o of overflow.items) problems.push(`taşan öğe: ${o.text} (sol ${o.left}, sağ ${o.right})`);
        if (VIEWPORTS[viewport].hasTouch) {
          const small = await smallTargets(page);
          if (small.length) (strictTargets ? problems : warnings).push(...small.map((s) => `${where}: küçük hedef ${s}`).slice(0, strictTargets ? 0 : 50));
          if (small.length && strictTargets) problems.push(`44 px altı ${small.length} hedef: ${small.slice(0, 6).join(', ')}`);
        }
        await page.screenshot({ path: join(outDir, `${viewport}-${role}-${slug(route)}.png`) });
        pages++;
        for (const p of problems) failures.push(`${where}: ${p}`);
      }
      await context.close();
    }
  }
  return { failures, warnings, pages };
}

const server = await startServer();
let exitCode = 0;
try {
  const api = apiClient(server.base);
  await api.loginAll();
  const seed = await seedFloor(api);
  const browser = await launchBrowser();
  try {
    if (args.only !== 'akis') {
      const { failures, warnings, pages } = await sweep(server, api, seed, browser);
      for (const w of warnings) console.log(`  uyarı  ${w}`);
      for (const f of failures) console.log(`  HATA   ${f}`);
      console.log(`Tarama: ${pages} ekran, ${failures.length} sorun${warnings.length ? `, ${warnings.length} uyarı` : ''}`);
      if (failures.length) exitCode = 1;
    }
    if (args.only !== 'tarama') {
      const results = await runFlows({ server, api, seed, browser });
      for (const r of results) console.log(`  ${r.ok ? 'tamam' : 'HATA '}  ${r.name}${r.ok ? '' : `: ${r.error}`}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`Akışlar: ${results.length - failed}/${results.length} geçti`);
      if (failed) exitCode = 1;
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(e);
  console.error(server.log().slice(-2000));
  exitCode = 1;
} finally {
  await server.stop();
}
process.exit(exitCode);
