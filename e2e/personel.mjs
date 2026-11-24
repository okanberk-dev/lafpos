/**
 * Personel bağlantısı (docs/03-ENTEGRASYON.md §4.8; sahip kararı 2: "doğru hesabı bağladığından emin ol"), sahte
 * lafmaliyet ucuyla:
 *
 * 1. Yönetim › Personel › kişi › "lafmaliyet personeli": hiçbir aday önceden seçili gelmez, Bağla seçilene dek kapalı;
 *    aynı ada uyan iki kayıt varken onay penceresi iki tarafı gösterir ve "Eminim" işaretlenmeden bağlamaz.
 * 2. Gün sonu gövdesi `workedStaffRefs`'i taşır; lafmaliyet'in yanıtındaki personel satırı Entegrasyon'da görünür.
 * 3. Kasa › Geçmiş günler › "Bugün çalışanlar" düzeltilir, gün yeniden gider.
 *
 * Her durumda telefon ve tablet boyutunda taşma ve 44 px denetlenir; görüntüler e2e/out/personel-*.png.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { apiClient, freePort, openContext, overflowReport, ROOT, settle, smallTargets, startServer } from './lib.mjs';

/** Sahte lafmaliyet: personel listesi (kasanın şubesi) ve gün sonu; gelen gövdeleri saklar */
function fakeLadmin(port) {
  const posts = [];
  const items = [
    { ref: 's:12', name: 'Ayşe Yılmaz', active: true, account: 'ayse@laffogato.net' },
    // "Kasa" adına iki kayıt uyar: hangisi olduğu soyadından ve hesabından anlaşılır ("Eminim" istenir)
    { ref: 's:7', name: 'Kasa Kaya', active: true, account: null },
    { ref: 's:3', name: 'Kasa Ak', active: true, account: 'Kasa Ak' },
    { ref: 's:40', name: 'Eski Personel', active: false, account: null },
  ];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'GET' && url.pathname === '/api/panel/pos/personel') {
        return send(200, { version: 1, now: new Date().toISOString(), sube: url.searchParams.get('sube'), items });
      }
      if (req.method === 'POST' && url.pathname === '/api/pos/gun') {
        const day = JSON.parse(raw);
        posts.push(day);
        const refs = day.workedStaffRefs;
        return send(200, { ok: true, date: day.date, counted: true, switchDay: null, ...(refs ? { staff: { counted: refs, unknown: [], otherBranch: ['s:99'] } } : {}) });
      }
      return send(404, { error: 'not_found' });
    });
  });
  return { posts, listen: () => new Promise((ok) => server.listen(port, '127.0.0.1', ok)), close: () => new Promise((ok) => server.close(() => ok())) };
}

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${label}: ${Math.round(timeoutMs / 1000)} sn içinde olmadı`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Görünen durumun denetimi (taşma, dokunmatikte 44 px, konsol) ve görüntüsü */
async function check(page, problems, viewport, name) {
  const found = [...problems];
  const overflow = await overflowReport(page);
  if (overflow.page > 1) found.push(`sayfa ${overflow.page} px yatay taşıyor`);
  for (const o of overflow.items) found.push(`${o.kind ?? 'taşan öğe'}: ${o.text}`);
  const small = await smallTargets(page);
  if (small.length) found.push(`44 px altı ${small.length} hedef: ${small.slice(0, 6).join(', ')}`);
  await page.screenshot({ path: join(ROOT, `e2e/out/personel-${viewport}-${name}.png`) });
  if (found.length) throw new Error(`${viewport} › ${name}: ${found.join('; ')}`);
}

export async function runStaffLink(browser) {
  const results = [];
  const port = await freePort();
  const fake = fakeLadmin(port);
  await fake.listen();
  const server = await startServer({ env: { LAFMALIYET_URL: `http://127.0.0.1:${port}`, LAFMALIYET_SYNC_SECRET: 's'.repeat(40) } });
  const step = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e?.message ?? e).split('\n')[0] });
    }
  };
  try {
    const api = apiClient(server.base);
    await api.loginAll();
    // Kurulum modu kapalı (gün lafmaliyet'e gitsin), eğitim yazarkasası yok
    await api.call('patron', 'PUT', '/admin/settings', { demoMode: false });
    await api.call('patron', 'PUT', '/okc/settings', { provider: 'kapali' });
    const users = await api.call('patron', 'GET', '/admin/users');
    const kasa = users.find((u) => u.name === 'Kasa');

    for (const viewport of ['telefon', 'tablet']) {
      await step(`${viewport}: aday önceden seçili değil; aynı ada uyan iki kayıtta onay iki tarafı gösterir, "Eminim" olmadan bağlamaz`, async () => {
        // Bir önceki boyutta bağlandıysa baştan
        await api.call('patron', 'PATCH', `/admin/users/${kasa.id}`, { staffRef: null }).catch(() => null);
        const { context, page, problems } = await openContext(browser, viewport, api.tokens.patron);
        try {
          await page.goto(`${server.base}/yonetim/personel?kisi=${kasa.id}`, { waitUntil: 'domcontentloaded' });
          await settle(page);
          const group = page.getByRole('radiogroup', { name: 'Kasa için ladmin personeli' });
          await group.waitFor({ timeout: 8000 });
          if ((await group.getByRole('radio', { checked: true }).count()) !== 0) throw new Error('bir aday önceden seçili');
          const choose = page.getByRole('button', { name: 'Kişi seçin', exact: true });
          if (!(await choose.isDisabled())) throw new Error('seçim yokken Bağla açık');
          // Sıra: adı uyan kayıtlar önce
          const first = (await group.getByRole('radio').first().innerText()).split('\n')[0];
          if (!first.startsWith('Kasa')) throw new Error(`ilk aday adı uyan değil: ${first}`);
          await check(page, problems, viewport, 'secici');
          await group.getByRole('radio', { name: /Kasa Kaya/ }).click({ timeout: 5000 });
          await page.getByRole('button', { name: 'Bağla…', exact: true }).click({ timeout: 5000 });
          const dialog = page.getByRole('dialog', { name: 'Bu iki kayıt aynı kişi mi?' });
          await dialog.waitFor({ timeout: 5000 });
          await dialog.getByText('Kasa · Kasiyer / Barista', { exact: true }).waitFor({ timeout: 5000 });
          await dialog.getByText(/^Kasa Kaya · giriş hesabı yok · Marina$/).waitFor({ timeout: 5000 });
          const link = dialog.getByRole('button', { name: 'Bağla', exact: true });
          if (!(await link.isDisabled())) throw new Error('"Eminim" işaretlenmeden Bağla açık');
          await check(page, problems, viewport, 'onay');
          await dialog.getByRole('checkbox', { name: /Eminim/ }).check({ timeout: 5000 });
          await link.click({ timeout: 5000 });
          await page.getByRole('button', { name: 'Bağlantıyı kaldır', exact: true }).waitFor({ timeout: 8000 });
          const after = (await api.call('patron', 'GET', '/admin/users')).find((u) => u.id === kasa.id);
          if (after.staffRef !== 's:7') throw new Error(`bağlantı yazılmadı: ${after.staffRef}`);
          await check(page, problems, viewport, 'bagli');
        } finally {
          await context.close();
        }
      });
    }

    let dayId = '';
    await step('gün sonu gövdesi workedStaffRefs taşır; Entegrasyon lafmaliyet\'in personel yanıtını yazar', async () => {
      const boot = await api.call('kasa', 'GET', '/bootstrap');
      await api.call('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      const product = boot.products.find((p) => p.name === 'Espresso') ?? boot.products[0];
      let o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
      o = await api.call('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty: 1 }] });
      const nakit = boot.paymentMethods.find((m) => m.kind === 'nakit');
      await api.call('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: nakit.id, amount: o.total - o.paid });
      const closed = await api.call('mudur', 'POST', '/cash/day/close', { countedCash: null });
      dayId = closed.day.id;
      const body = await until(() => fake.posts.find((p) => p.date === closed.day.date), 15_000, 'gün lafmaliyet\'e gitmedi').catch(async (e) => {
        const st = (await api.call('patron', 'GET', '/sync/status')).lafmaliyet;
        throw new Error(`${e.message} (bekleyen ${st.pending}, kurulum modu ${st.training}, hata ${st.lastError}, gelen ${fake.posts.length})`);
      });
      if (JSON.stringify(body.workedStaffRefs) !== JSON.stringify(['s:7'])) throw new Error(`workedStaffRefs: ${JSON.stringify(body.workedStaffRefs)}`);
      const { context, page, problems } = await openContext(browser, 'telefon', api.tokens.patron);
      try {
        await page.goto(`${server.base}/yonetim/entegrasyon`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await page.getByText(/lafmaliyet 1 personelin gününü saydı; başka şubenin kaydı: s:99/).first().waitFor({ timeout: 8000 });
        await check(page, problems, 'telefon', 'entegrasyon');
      } finally {
        await context.close();
      }
    });

    await step('Kasa › Geçmiş günler › Bugün çalışanlar düzeltilir; bağsız kişi rozetle, gün yeniden gider', async () => {
      if (!dayId) throw new Error('kapanmış gün yok');
      const sent = fake.posts.length;
      const { context, page, problems } = await openContext(browser, 'telefon', api.tokens.patron);
      try {
        await page.goto(`${server.base}/kasa`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await page.getByRole('tab', { name: 'Geçmiş günler', exact: true }).first().click({ timeout: 5000 });
        await page.getByRole('button', { name: /^Z 1\b/ }).first().click({ timeout: 8000 });
        const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Bugün çalışanlar', exact: true }) }).last();
        await card.waitFor({ timeout: 8000 });
        await card.getByText('Kasa', { exact: true }).waitFor({ timeout: 5000 });
        await card.getByRole('button', { name: 'Düzelt', exact: true }).click({ timeout: 5000 });
        const dialog = page.getByRole('dialog', { name: 'Bugün çalışanları düzelt' });
        await dialog.waitFor({ timeout: 5000 });
        await check(page, problems, 'telefon', 'calisanlar-duzelt');
        await dialog.getByRole('button', { name: /^Garson/ }).click({ timeout: 5000 });
        await dialog.getByRole('button', { name: 'Kaydet', exact: true }).click({ timeout: 5000 });
        await card.getByText('Elle düzeltildi', { exact: true }).waitFor({ timeout: 8000 });
        await card.getByText('lafmaliyet’e bağlı değil', { exact: true }).first().waitFor({ timeout: 5000 });
        await check(page, problems, 'telefon', 'calisanlar');
      } finally {
        await context.close();
      }
      const detail = await api.call('patron', 'GET', `/cash/days/${dayId}`);
      if (!detail.worked.corrected || !detail.worked.ids.includes(users.find((u) => u.name === 'Garson').id)) throw new Error('düzeltme yazılmadı');
      await until(() => fake.posts.length > sent, 15_000, 'düzeltilen gün yeniden gitmedi');
    });
  } catch (e) {
    results.push({ name: 'kurulum', ok: false, error: String(e?.message ?? e).split('\n')[0] });
    console.error(server.log().slice(-2000));
  } finally {
    await server.stop();
    await fake.close();
  }
  return results;
}
