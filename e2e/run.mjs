/**
 * LafPOS uçtan uca denetimi. Önce `npm run build`, sonra `npm run e2e`.
 *
 * 1. Tarama: her rol, izinli her ekranı telefon (390 px, dokunmatik), tablet (768 px, dokunmatik) ve
 *    bilgisayar (1280 px) boyutunda, patronun ekranlarını ayrıca koyu temada açar. Konsol ve sayfa hatası, 4xx/5xx istek, yatay taşma ve dokunmatik
 *    ekranda 44 px'ten küçük hedef arar; her ekranın görüntüsünü e2e/out/ altına kaydeder.
 * 2. Akışlar: e2e/flows.mjs (telefonda sipariş, ödeme, yönetimde düzenleme).
 * 3. Tarayıcı demosu: e2e/demo.mjs (dist/web/demo; tarama, PIN'siz akışlar, iki sekme).
 *
 * Seçenekler: --only=tarama|akis|demo  --viewports=telefon,tablet  --roles=patron  --routes=/yonetim/menu,/raporlar#urunler
 *             --targets=warn (küçük hedefleri yalnız raporla)
 * Sorun varsa çıkış kodu 1'dir.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDemo } from './demo.mjs';
import { runFlows } from './flows.mjs';
import { apiClient, launchBrowser, openContext, overflowReport, ROOT, seedFloor, settle, smallTargets, startServer, VIEWPORTS } from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/**
 * Varsayılan görünümde olmayan durum (seçili masa, açık pencere, ikinci sekme): adres açılır, `act` sayfayı o duruma
 * getirir, sonra aynı denetimler koşar (taşma, 44 px, konsol). Görüntü `…-<adres>-<ad>.png`; `--routes=` adresle
 * (adresin bütün durumları) ya da `adres#ad` ile seçer. Rapor sekmesi adreste değil cihazda saklanır
 * (`reports.key`): sekmeye basılır, aynı bağlamda sonraki ekranlar etkilenmesin diye durum adresinden sonra gelir
 */
const state = (path, name, act) => ({ path, name, act });

const ROUTES = {
  giris: ['/giris', state('/giris', 'mesai', (page) => page.getByRole('button', { name: 'Mesai', exact: true }).click({ timeout: 5000 }))],
  patron: [
    '/patron',
    '/masalar',
    // İki boylu üründe zorunlu seçim: Türk kahvesinin Büyük düğmesi seçenek penceresini açar (şeker seçilmedi, Ekle kapalı)
    state('@tz', 'zorunlu-secenek', async (page) => {
      await page.getByPlaceholder('Ürün ara').fill('Türk Kahvesi', { timeout: 5000 });
      await page.getByRole('button', { name: /^Büyük / }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Türk Kahvesi' }).waitFor({ timeout: 5000 });
    }),
    '/siparisler',
    '/mutfak',
    // Tükenen ürünler › Seçenekler (yulaf sütü bitti); telefon ve tablette araçlar "Diğer" penceresinde
    state('/mutfak', 'tukenen-secenekler', async (page) => {
      const more = page.getByRole('button', { name: 'Diğer', exact: true });
      if (await more.isVisible()) await more.click({ timeout: 5000 });
      await page.getByRole('button', { name: 'Tükendi', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Tükenen ürünler' }).getByRole('tab', { name: /Seçenekler/ }).click({ timeout: 5000 });
    }),
    state('/mutfak', 'hazir', (page) => page.getByRole('tab', { name: /^Hazır/ }).click({ timeout: 5000 })),
    '/cagri',
    '/musteri-ekrani',
    state('/musteri-ekrani', 'uzun-masa', async (page) => {
      // Teşekkür ekranı uzun masa no ile (yarı self, harfli masa no): çağrı kutusu telefonda taşmasın
      await page.evaluate(async () => {
        const res = await fetch('/api/display/e2e-uzun', {
          method: 'PUT',
          headers: { authorization: `Bearer ${localStorage.getItem('lafpos.token')}`, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'thanks', total: 12345, call: 'Masa WWWWWW' }),
        });
        if (!res.ok) throw new Error(`PUT /display → ${res.status}`);
      });
      await page.goto(new URL('/musteri-ekrani?ekran=e2e-uzun', page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.getByText('Masa WWWWWW', { exact: true }).waitFor({ timeout: 5000 });
    }),
    '/kasa',
    '/cihaz',
    '/musteriler',
    '/rezervasyon',
    '/raporlar',
    state('/raporlar', 'urunler', (page) => page.getByRole('tab', { name: 'Ürünler', exact: true }).click({ timeout: 5000 })),
    state('/raporlar', 'platformlar', async (page) => {
      // Rapor boş görünmesin: sunucu başına bir kez deneme modunda bir Getir siparişi teslim edilir, biri reddedilir
      await page.evaluate(async () => {
        const call = async (method, path, body) => {
          const res = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('lafpos.token')}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
          if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
          return res.json();
        };
        if ((await call('GET', '/reports/platforms')).platforms.length) return;
        await call('PUT', '/platforms/getir', { mode: 'deneme', commissionPct: 25 });
        const sold = await call('POST', '/platforms/getir/test-order', { courier: 'platform' });
        const { orderId } = await call('POST', `/platforms/orders/${sold.id}/accept`, {});
        await call('POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
        const missed = await call('POST', '/platforms/getir/test-order', { courier: 'platform' });
        await call('POST', `/platforms/orders/${missed.id}/reject`, { reason: 'Çok yoğunuz' });
        await call('PUT', '/platforms/getir', { mode: 'kapali' });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.getByRole('tab', { name: 'Paket platformları', exact: true }).click({ timeout: 5000 });
    }),
    '/yonetim',
    '/yonetim/genel',
    '/yonetim/menu',
    state('/yonetim/menu', 'yeni-urun', async (page) => {
      await page.getByRole('button', { name: 'Yerel ürün', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Yeni yerel ürün' }).waitFor({ timeout: 5000 });
    }),
    state('/yonetim/menu', 'yeni-grup', async (page) => {
      await page.getByRole('button', { name: 'Yerel ürün', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Yeni yerel ürün' }).getByRole('button', { name: 'Yeni grup', exact: true }).click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Yeni seçenek grubu' }).waitFor({ timeout: 5000 });
    }),
    '/yonetim/secenekler',
    state('/yonetim/secenekler', 'yeni-grup', async (page) => {
      await page.getByRole('button', { name: 'Grup ekle', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Yeni seçenek grubu' }).waitFor({ timeout: 5000 });
    }),
    '/yonetim/masa-plani',
    '/yonetim/musteri-ekrani',
    state('/yonetim/musteri-ekrani', 'siparis', (page) => page.getByRole('radio', { name: 'Sipariş', exact: true }).click({ timeout: 5000 })),
    state('/yonetim/masa-plani', 'secili-masa', (page) => page.locator('[data-table-id]').first().click({ timeout: 5000 })),
    '/yonetim/personel',
    '/yonetim/mesai',
    '/yonetim/roller',
    '/yonetim/odeme',
    '/yonetim/yazarkasa',
    '/yonetim/entegrasyon',
    '/yonetim/platformlar',
    '/yonetim/ag',
    '/yonetim/ayarlar',
    '/yonetim/denetim',
  ],
  garson: ['/masalar', '/siparisler', '/mutfak', '@s1'],
  kasa: ['/kasa', state('/kasa', 'vardiya', (page) => page.getByRole('button', { name: 'Vardiya devri', exact: true }).click({ timeout: 5000 })), '/masalar', '/satis', '@s2', '@tz', '/cihaz'],
  bar: ['/mutfak', state('/mutfak', 'hazir', (page) => page.getByRole('tab', { name: /^Hazır/ }).click({ timeout: 5000 }))],
};

/** Kendiliğinden başka adrese geçen ekranlar: "/satis" boş tezgâh satışını açıp adisyona geçer */
const LANDS = { '/satis': '/adisyon/' };

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
      for (const entry of ROUTES[role]) {
        const route = typeof entry === 'string' ? entry : entry.path;
        const extra = typeof entry === 'string' ? null : entry;
        if (only && !only.includes(route) && !(extra && only.includes(`${route}#${extra.name}`))) continue;
        const target = route === '@s1' ? `/adisyon/${seed.s1.id}` : route === '@s2' ? `/adisyon/${seed.s2.id}` : route === '@tz' ? `/adisyon/${seed.tz.id}` : route;
        problems.length = 0;
        await page.goto(server.base + target, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if (extra) {
          try {
            await extra.act(page);
            await settle(page);
          } catch (e) {
            problems.push(`durum kurulamadı (${extra.name}): ${String(e?.message ?? e).split('\n')[0]}`);
          }
        }
        const where = `${viewport} · ${role} · ${route}${extra ? ` › ${extra.name}` : ''}`;
        const landed = new URL(page.url()).pathname;
        if (!landed.startsWith(LANDS[route] ?? target.split('?')[0])) problems.push(`yönlendirildi: ${landed}`);
        const overflow = await overflowReport(page);
        if (overflow.page > 1) problems.push(`sayfa ${overflow.page} px yatay taşıyor`);
        for (const o of overflow.items) problems.push(`taşan öğe: ${o.text} (sol ${o.left}, sağ ${o.right})`);
        if (VIEWPORTS[viewport].hasTouch) {
          const small = await smallTargets(page);
          if (small.length) (strictTargets ? problems : warnings).push(...small.map((s) => `${where}: küçük hedef ${s}`).slice(0, strictTargets ? 0 : 50));
          if (small.length && strictTargets) problems.push(`44 px altı ${small.length} hedef: ${small.slice(0, 6).join(', ')}`);
        }
        await page.screenshot({ path: join(outDir, `${viewport}-${role}-${slug(route)}${extra ? `-${extra.name}` : ''}.png`) });
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
    if (!args.only || args.only === 'tarama') {
      const { failures, warnings, pages } = await sweep(server, api, seed, browser);
      for (const w of warnings) console.log(`  uyarı  ${w}`);
      for (const f of failures) console.log(`  HATA   ${f}`);
      console.log(`Tarama: ${pages} ekran, ${failures.length} sorun${warnings.length ? `, ${warnings.length} uyarı` : ''}`);
      if (failures.length) exitCode = 1;
    }
    if (!args.only || args.only === 'akis') {
      const results = await runFlows({ server, api, seed, browser });
      for (const r of results) console.log(`  ${r.ok ? 'tamam' : 'HATA '}  ${r.name}${r.ok ? '' : `: ${r.error}`}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`Akışlar: ${results.length - failed}/${results.length} geçti`);
      if (failed) exitCode = 1;
    }
    if (!args.only || args.only === 'demo') {
      const results = await runDemo(browser);
      for (const r of results) console.log(`  ${r.ok ? 'tamam' : 'HATA '}  ${r.name}${r.ok ? '' : `: ${r.error}`}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`Demo: ${results.length - failed}/${results.length} geçti`);
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
