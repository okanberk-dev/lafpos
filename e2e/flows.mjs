/**
 * Uçtan uca akışlar: gerçek tarayıcıda (telefon, tablet, bilgisayar boyutunda), gerçek sunucuya karşı.
 * Her akış kendi bağlamını açar, sonucu API'den doğrular ve tarayıcıda konsol ya da ağ hatası bırakmaz.
 */
import { mkdirSync } from 'node:fs';
import { openContext, ROOT, settle } from './lib.mjs';

mkdirSync(`${ROOT}/e2e/out`, { recursive: true });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Tarayıcı bağlamını açar, akışı çalıştırır, konsol ve ağ hatası varsa akışı düşürür */
async function withPage(ctx, viewport, role, fn) {
  const { context, page, problems } = await openContext(ctx.browser, viewport, role ? ctx.api.tokens[role] : null);
  try {
    await fn(page).catch(async (e) => {
      // Düşen akışın son hâli: e2e/out/hata-<boyut>-<rol>.png
      await page.screenshot({ path: `${ROOT}/e2e/out/hata-${viewport}-${role ?? 'giris'}.png` }).catch(() => null);
      throw e;
    });
    const real = problems.filter((p) => !/istek 4\d\d: GET \/api\/auth\/me/.test(p));
    assert(real.length === 0, real.join(' | '));
  } finally {
    await context.close();
  }
}

const go = async (ctx, page, path) => {
  await page.goto(ctx.server.base + path, { waitUntil: 'domcontentloaded' });
  await settle(page);
};

export async function runFlows(ctx) {
  const { api, seed } = ctx;
  const simple = seed.boot.products.find((p) => p.active && !p.hidden && p.priceL == null && p.optionGroupIds.length === 0 && !p.isService);

  const flows = [
    [
      'Telefonda giriş: tuş takımıyla PIN',
      () =>
        withPage(ctx, 'telefon', null, async (page) => {
          await go(ctx, page, '/giris');
          for (const d of '2222') await page.getByRole('button', { name: d, exact: true }).click();
          await page.getByRole('button', { name: 'Giriş', exact: true }).click();
          await page.waitForURL(/\/masalar$/, { timeout: 8000 });
          await page.getByRole('navigation').getByText('Masalar').first().waitFor();
        }),
    ],
    [
      'Telefonda garson: boş masayı açar, ürün ekler, bara gönderir',
      () =>
        withPage(ctx, 'telefon', 'garson', async (page) => {
          assert(simple, 'seçeneksiz tek boy ürün bulunamadı');
          await go(ctx, page, '/masalar');
          const table = seed.tables[2];
          await page.getByRole('button', { name: new RegExp(`^${table.name}\\b`) }).first().click();
          await page.waitForURL(/\/adisyon\//, { timeout: 8000 });
          const orderId = new URL(page.url()).pathname.split('/').pop();
          await page.getByPlaceholder('Ürün ara').fill(simple.name);
          await page.getByRole('button', { name: new RegExp(`^${simple.shortName || simple.name}`) }).first().click();
          await page.getByRole('button', { name: /^Gönder \(1\)/ }).click();
          await page.getByRole('button', { name: /^Gönder \(/ }).waitFor({ state: 'detached', timeout: 8000 });
          const order = await api.call('garson', 'GET', `/orders/${orderId}`);
          assert(order.items.length === 1 && order.items[0].productId === simple.id, `adisyonda beklenen kalem yok: ${JSON.stringify(order.items.map((i) => i.name))}`);
        }),
    ],
    [
      'Tablette kasiyer: hesabı nakit alır, adisyon kapanır',
      () =>
        withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, `/adisyon/${seed.s1.id}`);
          await page.getByRole('button', { name: /^Ödeme · / }).click();
          await page.getByRole('button', { name: 'Nakit', exact: true }).click();
          await page.getByRole('button', { name: 'Tam', exact: true }).click();
          await page.getByRole('button', { name: /Nakit al$/ }).click();
          await page.getByText('Adisyon kapandı').waitFor({ timeout: 8000 });
          const order = await api.call('kasa', 'GET', `/orders/${seed.s1.id}`);
          assert(order.status === 'kapali', `adisyon kapanmadı: ${order.status}`);
        }),
    ],
    [
      'Telefonda patron: Yönetim › Ürünler › kısa adı değiştirir',
      () =>
        withPage(ctx, 'telefon', 'patron', async (page) => {
          await go(ctx, page, '/yonetim');
          await page.getByRole('link', { name: /^Ürünler/ }).click();
          await page.waitForURL(/\/yonetim\/menu$/);
          await page.getByLabel('Ürün ara').fill('Latte');
          await page.getByRole('button', { name: /^Latte\b/ }).first().click();
          const drawer = page.getByRole('dialog', { name: /Latte ayrıntısı/ });
          await drawer.waitFor();
          await drawer.getByLabel('Kısa ad').fill('LATTE E2E');
          await drawer.getByRole('button', { name: 'Kaydet', exact: true }).click();
          await drawer.waitFor({ state: 'detached', timeout: 8000 });
          const boot = await api.call('patron', 'GET', '/bootstrap');
          assert(boot.products.find((p) => p.name === 'Latte')?.shortName === 'LATTE E2E', 'kısa ad kaydedilmedi');
        }),
    ],
    [
      'Bilgisayarda patron: Personel çekmecesinde indirim sınırını değiştirir',
      () =>
        withPage(ctx, 'bilgisayar', 'patron', async (page) => {
          await go(ctx, page, '/yonetim/personel');
          await page.getByRole('button', { name: /^Garson\b/ }).first().click();
          const drawer = page.getByRole('dialog', { name: /Garson ayrıntısı/ });
          await drawer.waitFor();
          await drawer.getByLabel(/İndirim sınırı/).fill('15');
          await drawer.getByRole('button', { name: 'Kaydet', exact: true }).click();
          await drawer.waitFor({ state: 'detached', timeout: 8000 });
          const users = await api.call('patron', 'GET', '/admin/users');
          assert(users.find((u) => u.name === 'Garson')?.maxDiscountPct === 15, 'indirim sınırı kaydedilmedi');
        }),
    ],
    [
      'Tablette kasiyer: yönetim kapalı, kasa kör sayım, ürünü tükendi işaretler',
      () =>
        withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, '/masalar');
          const rail = await page.locator('aside').first().innerText();
          assert(!/Yönetim|Rapor|Patron/.test(rail), `kasiyer menüsünde olmaması gereken: ${rail.replace(/\s+/g, ' ')}`);
          await go(ctx, page, '/yonetim/menu');
          assert(!new URL(page.url()).pathname.startsWith('/yonetim'), 'kasiyer yönetime girebildi');
          await go(ctx, page, '/kasa');
          await page.getByText('Kör kasa', { exact: true }).waitFor();
          assert((await page.getByText('Beklenen nakit', { exact: true }).count()) === 0, 'kör kasada beklenen nakit görünüyor');
          await go(ctx, page, `/adisyon/${seed.s2.id}`);
          await page.getByRole('button', { name: 'İşlemler' }).click();
          await page.getByRole('button', { name: /Tükenen ürünler/ }).click();
          const dialog = page.getByRole('dialog', { name: /Tükenen ürünler/ });
          await dialog.getByPlaceholder('Ürün ara').fill('Americano');
          await dialog.getByRole('button', { name: 'Tükendi', exact: true }).first().click();
          await dialog.getByRole('button', { name: 'Satışa aç', exact: true }).first().waitFor({ timeout: 8000 });
          const boot = await api.call('kasa', 'GET', '/bootstrap');
          assert(boot.products.find((p) => p.name === 'Americano')?.active === false, 'Americano tükenmedi');
          await dialog.getByRole('button', { name: 'Satışa aç', exact: true }).first().click();
          await dialog.getByRole('button', { name: 'Tükendi', exact: true }).first().waitFor({ timeout: 8000 });
        }),
    ],
    [
      'Bilgisayarda komut paleti: Ctrl K ile personel sayfasına gider',
      () =>
        withPage(ctx, 'bilgisayar', 'patron', async (page) => {
          await go(ctx, page, '/masalar');
          await page.keyboard.press('Control+k');
          const input = page.getByPlaceholder('Ekran, ürün ya da personel ara');
          await input.waitFor();
          await input.fill('personel');
          await page.keyboard.press('Enter');
          await page.waitForURL(/\/yonetim\/personel$/, { timeout: 8000 });
        }),
    ],
    [
      'Bilgisayarda yönetim: daraltılan menü ve sıkı görünüm yeniden açılışta kalır',
      () =>
        withPage(ctx, 'bilgisayar', 'patron', async (page) => {
          await go(ctx, page, '/yonetim/menu');
          await page.getByRole('button', { name: 'Menüyü daralt' }).click();
          await page.getByRole('button', { name: 'Sıkı görünüm' }).click();
          await page.reload({ waitUntil: 'domcontentloaded' });
          await settle(page);
          await page.getByRole('button', { name: 'Menüyü genişlet' }).waitFor();
          const density = await page.evaluate(() => document.documentElement.dataset.density);
          assert(density === 'compact', `sıkı görünüm kalmadı: ${density}`);
        }),
    ],
  ];

  const results = [];
  for (const [name, fn] of flows) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return results;
}
