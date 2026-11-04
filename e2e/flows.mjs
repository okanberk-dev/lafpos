/**
 * Uçtan uca akışlar: gerçek tarayıcıda (telefon, tablet, bilgisayar boyutunda), gerçek sunucuya karşı.
 * Her akış kendi bağlamını açar, sonucu API'den doğrular ve tarayıcıda konsol ya da ağ hatası bırakmaz.
 */
import { mkdirSync } from 'node:fs';
import { openContext, overflowReport, PINS, ROOT, settle, smallTargets } from './lib.mjs';

mkdirSync(`${ROOT}/e2e/out`, { recursive: true });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * Tarayıcı bağlamını açar, akışı çalıştırır, konsol ve ağ hatası varsa akışı düşürür. `allow`: akışın bilerek
 * ürettiği hatalar (yetkili onayı isteyen ilk istek 403 `approval_required` döner, PIN'le tekrarlanır).
 */
async function withPage(ctx, viewport, role, fn, allow = []) {
  const { context, page, problems } = await openContext(ctx.browser, viewport, role ? ctx.api.tokens[role] : null);
  try {
    await fn(page).catch(async (e) => {
      // Düşen akışın son hâli: e2e/out/hata-<boyut>-<rol>.png
      await page.screenshot({ path: `${ROOT}/e2e/out/hata-${viewport}-${role ?? 'giris'}.png` }).catch(() => null);
      throw e;
    });
    const real = problems.filter((p) => ![/istek 4\d\d: GET \/api\/auth\/me/, ...allow].some((re) => re.test(p)));
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
  /** Ürünün fişinin düştüğü istasyon (ürünün ya da kategorisinin); yoksa bara gitmez */
  const stationOf = (p) => p.stationId ?? seed.boot.categories.find((c) => c.id === p.categoryId)?.stationId ?? null;
  /** Bara gitmeyen, seçeneksiz tek boy ürün (etkinlik ücreti gibi) */
  const noBar = seed.boot.products.find((p) => p.active && !p.hidden && p.priceL == null && p.optionGroupIds.length === 0 && !stationOf(p));
  /**
   * Müşteri ekranının `after`'dan sonra yazılmış teşekkür durumu (ödeme penceresi kapanırken gönderir; istek
   * beklenmez, birkaç kez okunur)
   */
  const thanksOn = async (code, after = 0) => {
    for (let i = 0; i < 50; i++) {
      const s = await api.call('', 'GET', `/public/display/${code}`);
      if (s.kind === 'thanks' && s.at > after) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

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
      'Telefonda patron: yerel ürün çekmecesinde yeni seçenek grubu açar, ürünle tek kayıtta bağlar',
      () =>
        withPage(ctx, 'telefon', 'patron', async (page) => {
          await go(ctx, page, '/yonetim/menu');
          await page.getByRole('button', { name: 'Yerel ürün', exact: true }).click();
          const drawer = page.getByRole('dialog', { name: 'Yeni yerel ürün' });
          await drawer.waitFor();
          await drawer.getByRole('textbox', { name: /^Ad/ }).fill('E2E etkinlik');
          await drawer.getByRole('textbox', { name: /^Fiyat/ }).fill('150');
          await drawer.getByRole('button', { name: 'Yeni grup', exact: true }).click();
          const editor = page.getByRole('dialog', { name: 'Yeni seçenek grubu' });
          await editor.waitFor();
          // Çekmeceden açılan yeni grup hep açık: kapalı kaydedilse ürüne görünmeden bağlanır, çipi çıkmazdı
          assert((await editor.getByText('Grup açık', { exact: true }).count()) === 0, 'çekmecedeki yeni grup penceresinde "Grup açık" anahtarı var');
          await editor.getByRole('textbox', { name: /^Ad/ }).fill('E2E bilet');
          await editor.getByLabel('1. seçenek adı').fill('Ön sıra');
          await editor.getByLabel('1. seçenek ek fiyatı (₺)').fill('20');
          await editor.getByRole('button', { name: 'Kaydet', exact: true }).click();
          await editor.waitFor({ state: 'detached', timeout: 8000 });
          await drawer.getByRole('button', { name: /^E2E bilet/, pressed: true }).waitFor({ timeout: 8000 });
          await drawer.getByRole('button', { name: 'Kaydet', exact: true }).click();
          await drawer.waitFor({ state: 'detached', timeout: 8000 });
          const menu = await api.call('patron', 'GET', '/admin/menu');
          const group = menu.optionGroups.find((g) => g.name === 'E2E bilet');
          const product = menu.products.find((p) => p.name === 'E2E etkinlik');
          assert(group && product, 'grup ya da ürün oluşmadı');
          assert(JSON.stringify(product.optionGroupIds) === JSON.stringify([group.id]), `grup ürüne bağlanmadı: ${JSON.stringify(product.optionGroupIds)}`);
          assert(menu.optionItems.some((i) => i.groupId === group.id && i.price === 2000), 'seçeneğin ek fiyatı kaydedilmedi');
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
      'Telefonda kasiyer: yulaf sütü tükendi; açık pencerede (alt çubukta da) ve sepetteki satırda seçili Yulaf uyarır, seçenek penceresinde gri; normal süt bitince Latte süt sormadan eklenir, sepette seçili Normal işaretlenmez',
      () =>
        withPage(ctx, 'telefon', 'kasa', async (page) => {
          // Kısa adı önceki akışta değişti: güncel menüden
          const boot = await api.call('kasa', 'GET', '/bootstrap');
          const latte = boot.products.find((p) => p.name === 'Latte');
          const milk = boot.optionGroups.find((g) => g.name === 'Süt' && latte.optionGroupIds.includes(g.id));
          const item = (name) => milk.items.find((i) => i.name === name);
          const soldOut = async (name) => (await api.call('kasa', 'GET', '/bootstrap')).optionGroups.find((g) => g.id === milk.id).items.find((i) => i.name === name).soldOut;
          const label = latte.shortName?.trim() || latte.name;
          const modal = page.getByRole('dialog', { name: latte.name });
          // Grup başlığındaki ipucu (alt çubuktaki "Süt: ..." satırı ayrı); süt isteğe bağlı, bırakmak da olur
          const gone = modal.getByText('Yulaf tükendi, başka birini seçin ya da bırakın', { exact: true });
          const why = modal.locator('#secenek-eksik');
          const inView = (loc) => loc.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
          });
          const pressed = async (name) => (await modal.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-pressed')) === 'true';
          try {
            await go(ctx, page, `/adisyon/${seed.tz.id}`);
            // Sepette gönderilmemiş "Latte (Yulaf)": aşağıda yulaf bitince düzenlenecek
            await page.getByPlaceholder('Ürün ara').fill('Latte');
            await page.getByRole('button', { name: `${label} seçenekleri`, exact: true }).click();
            await modal.getByRole('button', { name: /^Yulaf/ }).click();
            await modal.getByRole('button', { name: /^Ekle/ }).click();
            await modal.waitFor({ state: 'detached' });
            // Pencere açıkken Yulaf seçili; bardan Yulaf tükendi (menü olayı açılış verisini yeniler): seçim, not ve adet
            // korunur, ipucu çıkar, Ekle kapanır
            await page.getByRole('button', { name: `${label} seçenekleri`, exact: true }).click();
            await modal.getByRole('button', { name: /^Yulaf/ }).click();
            await modal.getByLabel('Bara ve mutfağa not').fill('E2E notu');
            await modal.getByRole('button', { name: 'Artır', exact: true }).last().click();
            await api.call('kasa', 'POST', `/option-items/${item('Yulaf').id}/sold-out`, { soldOut: true });
            await gone.waitFor({ timeout: 8000 });
            // Pencere not alanına kaydırılmışken de Ekle'nin neden kapalı olduğu alt çubukta görünür (başlıktaki ipucu
            // telefonda ekranın dışında kalır)
            await modal.getByLabel('Bara ve mutfağa not').scrollIntoViewIfNeeded();
            await why.filter({ hasText: 'Süt: Yulaf tükendi, başka birini seçin ya da bırakın' }).waitFor({ timeout: 8000 });
            assert(await inView(why), 'alt çubuktaki neden ekranda değil');
            assert((await modal.getByRole('button', { name: /^Ekle/ }).getAttribute('aria-describedby')) === 'secenek-eksik', 'Ekle nedenine bağlı değil');
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-secenek-alt-cubuk.png` });
            assert(await pressed('Yulaf'), 'seçili Yulaf menü olayında bırakıldı');
            assert(!(await modal.getByRole('button', { name: /^Yulaf/ }).isDisabled()), 'seçiliyken tükenen Yulaf bırakılamıyor');
            assert(await modal.getByRole('button', { name: /^Ekle/ }).isDisabled(), 'tükenen Yulaf seçiliyken Ekle açık');
            assert((await modal.getByLabel('Bara ve mutfağa not').inputValue()) === 'E2E notu', 'not menü olayında silindi');
            const qty = (await modal.getByRole('button', { name: 'Azalt', exact: true }).last().locator('xpath=following-sibling::span[1]').textContent()).trim();
            assert(qty === '2', `adet menü olayında sıfırlandı: ${qty}`);
            await gone.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-secenek-secili-tukendi.png` });
            await modal.getByRole('button', { name: /^Laktozsuz/ }).click();
            assert((await gone.count()) === 0, 'başka süt seçildi ama ipucu duruyor');
            assert(((await why.textContent()) ?? '').trim() === '', 'başka süt seçildi ama alt çubukta neden duruyor');
            assert(!(await modal.getByRole('button', { name: /^Ekle/ }).isDisabled()), 'başka süt seçildi ama Ekle kapalı');
            await modal.getByRole('button', { name: /^Ekle/ }).click();
            await modal.waitFor({ state: 'detached' });
            // Sepetteki "Latte (Yulaf)" düzenlenir: Yulaf seçili kalır, ipucu var, Güncelle kapalı; seçili Yulaf'a dokununca
            // bırakılır, grup varsayılana (Normal) döner
            await page.getByRole('tab', { name: /^Adisyon/ }).click();
            await page.getByRole('button', { name: `${label} düzenle`, exact: true }).filter({ hasText: 'Yulaf' }).click();
            await gone.waitFor({ timeout: 8000 });
            assert(await pressed('Yulaf'), 'düzenlenen satırın tükenen Yulaf\'ı süzüldü');
            assert(await modal.getByRole('button', { name: /^Güncelle/ }).isDisabled(), 'tükenen Yulaf seçiliyken Güncelle açık');
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-secenek-duzenle-tukendi.png` });
            await modal.getByRole('button', { name: /^Yulaf/ }).click();
            assert((await gone.count()) === 0 && (await pressed('Normal')), 'seçili tükenen Yulaf bırakılınca varsayılan seçilmedi');
            assert(await modal.getByRole('button', { name: /^Yulaf/ }).isDisabled(), 'bırakılan tükenmiş Yulaf yeniden seçilebiliyor');
            await modal.getByRole('button', { name: /^Güncelle/ }).click();
            await modal.waitFor({ state: 'detached' });
            assert((await page.getByRole('button', { name: `${label} düzenle`, exact: true }).filter({ hasText: 'Yulaf' }).count()) === 0, 'sepette Yulaf kaldı');
            await page.getByRole('tab', { name: 'Menü', exact: true }).click();
            // Aşağıdaki adım Yulaf'ı Tükenen ürünler penceresinden işaretler
            await api.call('kasa', 'POST', `/option-items/${item('Yulaf').id}/sold-out`, { soldOut: false });

            await page.getByRole('button', { name: 'İşlemler' }).click();
            await page.getByRole('button', { name: /Tükenen ürünler/ }).click();
            const dialog = page.getByRole('dialog', { name: /Tükenen ürünler/ });
            await dialog.getByRole('tab', { name: /Seçenekler/ }).click();
            await dialog.getByPlaceholder(/Seçenek ara/).fill('Yulaf');
            await dialog.getByRole('button', { name: 'Tükendi', exact: true }).first().click();
            await dialog.getByRole('button', { name: 'Satışa aç', exact: true }).first().waitFor({ timeout: 8000 });
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-secenek-tukendi.png` });
            assert((await soldOut('Yulaf')) === true, 'Yulaf tükenmedi');
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached' });
            // Normal süt de bitti (başka kasa). Süt isteğe bağlı: satış durmaz, boy düğmesi Latte'yi pencere açmadan ekler
            // (sunucu o grup için süt yazmaz; su ve espresso da böyle satılır)
            await api.call('kasa', 'POST', `/option-items/${item('Normal').id}/sold-out`, { soldOut: true });
            await page.getByPlaceholder('Ürün ara').fill('Latte');
            const tile = page.getByRole('button', { name: `${label} seçenekleri`, exact: true }).locator('xpath=..');
            const linesOf = () => page.evaluate((id) => JSON.parse(localStorage.getItem('lafpos.cart') ?? '{}')?.state?.byOrder?.[id] ?? [], seed.tz.id);
            const before = (await linesOf()).length;
            await tile.getByRole('button', { name: new RegExp(`^${boot.settings.sizeLabels.M}`) }).click();
            await page.waitForFunction(([id, n]) => (JSON.parse(localStorage.getItem('lafpos.cart') ?? '{}')?.state?.byOrder?.[id] ?? []).length > n, [seed.tz.id, before], { timeout: 8000 });
            assert((await modal.count()) === 0, 'isteğe bağlı grubun varsayılanı tükendi diye hızlı ekleme pencere açtı');
            const added = (await linesOf()).at(-1);
            assert(added.productId === latte.id && added.options.length === 0, `hızlı eklenen satır beklenen gibi değil: ${JSON.stringify(added)}`);
            // Pencerede Süt grubunda yalnız bilgi notu, önseçim yok, Ekle açık
            await page.getByRole('button', { name: `${label} seçenekleri`, exact: true }).click();
            await modal.getByText('Normal tükendi', { exact: true }).waitFor({ timeout: 8000 });
            assert(!(await pressed('Normal')) && !(await pressed('Laktozsuz')), 'tükenen varsayılanın yerine süt önseçili');
            assert(await modal.getByRole('button', { name: /^Yulaf/ }).isDisabled(), 'tükenen Yulaf seçilebiliyor');
            assert(!(await modal.getByRole('button', { name: /^Ekle/ }).isDisabled()), 'isteğe bağlı grubun varsayılanı tükendi diye Ekle kapalı');
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-secenek-penceresi.png` });
            const overflow = await overflowReport(page);
            assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
            // Yalnız pencerenin hedefleri: telefonda arkasında kalan ürün kartları da sayılırdı
            const small = await modal.locator('button').evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) + 0.5 < 44; }).map((e) => e.textContent.trim()));
            assert(!small.length, `44 px altı: ${small.join(', ')}`);
            await modal.getByRole('button', { name: /^Laktozsuz/ }).click();
            await modal.getByRole('button', { name: /^Ekle/ }).click();
            await modal.waitFor({ state: 'detached' });
            // Sepette Yulaf bırakılınca varsayılana dönen, sonra tükenen Normal (düzenlenen satır) işaretlenmez: önseçili
            // varsayılan gibi gönderimde çıkar, Gönder 409 almaz (pencere yukarıda "Normal tükendi" dedi, menü güncel)
            await page.getByRole('tab', { name: /^Adisyon/ }).click();
            await page.getByRole('button', { name: `${label} düzenle`, exact: true }).first().waitFor({ timeout: 8000 });
            assert((await page.getByRole('button', { name: `${label} düzenle`, exact: true }).filter({ hasText: 'tükendi' }).count()) === 0, 'tükenen önseçili Normal yüzünden satır işaretli');
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-sepet-tukendi.png` });
          } finally {
            // Sonraki akışlar Latte'yi seçeneksiz ekler: düşse de sütler açılır
            for (const name of ['Yulaf', 'Normal']) await api.call('kasa', 'POST', `/option-items/${item(name).id}/sold-out`, { soldOut: false });
          }
        }),
    ],
    [
      'Tablette kasiyer: Su penceresi açıkken ve Su sepetteyken önseçili Normal süt tükenir; Ekle açık, satır işaretsiz, Gönder süt yazmadan geçer; açıkça seçilen Yulaf tükenince uyarır',
      async () => {
        const boot = await api.call('kasa', 'GET', '/bootstrap');
        const water = boot.products.find((p) => p.name === 'Su');
        const milk = boot.optionGroups.find((g) => g.name === 'Süt' && water.optionGroupIds.includes(g.id));
        assert(water && milk && !milk.required, 'Su ya da isteğe bağlı Süt grubu bulunamadı');
        const item = (name) => milk.items.find((i) => i.name === name);
        const mark = (name, soldOut) => api.call('kasa', 'POST', `/option-items/${item(name).id}/sold-out`, { soldOut });
        const label = water.shortName?.trim() || water.name;
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        try {
          await withPage(ctx, 'tablet', 'kasa', async (page) => {
            await go(ctx, page, `/adisyon/${o.id}`);
            const modal = page.getByRole('dialog', { name: water.name });
            const add = modal.getByRole('button', { name: /^Ekle/ });
            const why = modal.locator('#secenek-eksik');
            const chip = (name, pressed) => modal.getByRole('button', { name: new RegExp(`^${name}`), ...(pressed === undefined ? {} : { pressed }) });
            const open = async () => {
              await page.getByPlaceholder('Ürün ara').fill(water.name);
              await page.getByRole('button', { name: `${label} seçenekleri`, exact: true }).click();
              await modal.waitFor();
            };
            // Pencereyle eklenen Su: Normal süt önseçili, satıra yazılır
            await open();
            await chip('Normal', true).waitFor({ timeout: 8000 });
            await add.click();
            await modal.waitFor({ state: 'detached' });
            // Pencere yeniden açık, Normal önseçili; bardan Normal tükendi (menü olayı): seçim bırakılır, yalnız bilgi
            // notu, Ekle açık. Kasiyerden başka süt istenmez (yanlış ALTERNATIF SÜT satırı ya da +25 TL olurdu)
            await open();
            await chip('Normal', true).waitFor({ timeout: 8000 });
            await mark('Normal', true);
            await modal.getByText('Normal tükendi', { exact: true }).waitFor({ timeout: 8000 });
            await chip('Normal', false).waitFor({ timeout: 8000 });
            assert((await modal.getByText(/başka birini seçin/).count()) === 0, 'tükenen önseçili Normal için başka süt isteniyor');
            assert(((await why.textContent()) ?? '').trim() === '', `alt çubukta neden var: ${await why.textContent()}`);
            assert(!(await add.isDisabled()), 'önseçili Normal tükendi diye Ekle kapalı');
            assert((await chip('Laktozsuz').getAttribute('aria-pressed')) === 'false', 'tükenen Normal\'in yerine süt seçildi');
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-secenek-onsecili-tukendi.png` });
            await add.click();
            await modal.waitFor({ state: 'detached' });
            // Sepette ilk satırın seçeneğinde tükenen Normal var: işaretlenmez (Gönder onu çıkarır)
            const lines = page.getByRole('button', { name: `${label} düzenle`, exact: true });
            await lines.nth(1).waitFor({ timeout: 8000 });
            assert((await lines.count()) === 2, `sepette ${await lines.count()} Su satırı var`);
            assert((await lines.filter({ hasText: 'tükendi' }).count()) === 0, 'önseçili Normal tükenen Su satırı işaretli');
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-sepet-onsecili-tukendi.png` });
            // Açıkça seçilen Yulaf tükenince eskisi gibi: seçili kalır, uyarı, Ekle kapalı
            await open();
            await chip('Yulaf').click();
            await chip('Yulaf', true).waitFor();
            await mark('Yulaf', true);
            await modal.getByText('Yulaf tükendi, başka birini seçin ya da bırakın', { exact: true }).waitFor({ timeout: 8000 });
            await why.filter({ hasText: 'Süt: Yulaf tükendi, başka birini seçin ya da bırakın' }).waitFor({ timeout: 8000 });
            assert((await chip('Yulaf').getAttribute('aria-pressed')) === 'true', 'açıkça seçilen Yulaf tükenince bırakıldı');
            assert(await add.isDisabled(), 'tükenen Yulaf seçiliyken Ekle açık');
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-secenek-yulaf-tukendi.png` });
            await page.keyboard.press('Escape');
            await modal.waitFor({ state: 'detached' });
            // Gönder 409 almaz: iki Su bara gider (tezgâhta Öde'nin yanındaki Gönder)
            await page.getByRole('button', { name: 'Gönder', exact: true }).click();
            await page.getByRole('button', { name: 'Gönder', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
          });
          const done = await api.call('kasa', 'GET', `/orders/${o.id}`);
          const sold = done.items.filter((i) => i.productId === water.id && !i.voided);
          assert(sold.reduce((a, i) => a + i.qty, 0) === 2, `adisyonda ${sold.length} Su kalemi var`);
          assert(sold.every((i) => !i.options.some((x) => x.groupId === milk.id)), `Su'ya süt yazıldı: ${JSON.stringify(sold.map((i) => i.options.map((x) => x.name)))}`);
          assert(sold.every((i) => i.unitPrice === water.price), `Su fiyatı değişti: ${sold.map((i) => i.unitPrice)}`);
        } finally {
          for (const name of ['Normal', 'Yulaf']) await mark(name, false);
        }
      },
    ],
    [
      'Tablette kasiyer: seçenek penceresi açıkken bağlı grup kapanır, ücretli varsayılanlı grup açılır; seçim uzlaşır, Ekle ve Gönder geçer',
      async () => {
        const menu = await api.call('patron', 'GET', '/admin/menu');
        const category = menu.categories.find((c) => !c.extSource) ?? menu.categories[0];
        const lid = await api.call('patron', 'POST', '/admin/option-groups', { name: 'E2E kapak', kind: 'single', items: [{ name: 'Kapaklı', isDefault: true }, { name: 'Kapaksız' }] });
        // Ücretli varsayılanlı grup kapalı başlar: seçeneksiz satışa yazılmaz
        const cup = await api.call('patron', 'POST', '/admin/option-groups', { name: 'E2E bardak', kind: 'single', active: false, items: [{ name: 'Karton', price: 500, isDefault: true }, { name: 'Kupa' }] });
        const product = await api.call('patron', 'POST', '/admin/products', { categoryId: category.id, name: 'E2E soğuk kahve', price: 19000, kdvRate: 10, groupIds: [lid.id, cup.id] });
        const items = (await api.call('patron', 'GET', '/admin/menu')).optionItems;
        const setOpen = (id, name, active) =>
          api.call('patron', 'PUT', `/admin/option-groups/${id}`, { name, kind: 'single', active, items: items.filter((i) => i.groupId === id && i.active).map((i) => ({ id: i.id, name: i.name, price: i.price, isDefault: i.isDefault })) });
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        await withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, `/adisyon/${o.id}`);
          await page.getByPlaceholder('Ürün ara').fill('E2E soğuk');
          await page.getByRole('button', { name: 'E2E soğuk kahve seçenekleri', exact: true }).click();
          const modal = page.getByRole('dialog', { name: 'E2E soğuk kahve' });
          await modal.getByRole('button', { name: /^Kapaklı/, pressed: true }).waitFor({ timeout: 8000 });
          // Pencere açıkken bağlı grup kapandı (başka cihazda Yönetim › Seçenekler): seçimi atılır, yoksa Gönder 400 alırdı
          await setOpen(lid.id, 'E2E kapak', false);
          await modal.getByText('E2E kapak', { exact: true }).waitFor({ state: 'detached', timeout: 8000 });
          // Ücretli varsayılanlı grup açıldı: çipi seçili gelir, Ekle tutarı onu içerir (₺195 gösterilip ₺200 alınmaz)
          await setOpen(cup.id, 'E2E bardak', true);
          await modal.getByRole('button', { name: /^Karton/, pressed: true }).waitFor({ timeout: 8000 });
          const add = modal.getByRole('button', { name: /^Ekle/ });
          const text = (await add.textContent()) ?? '';
          assert(/195,00/.test(text), `Ekle tutarı Karton'u içermiyor: ${text}`);
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-secenek-grup-acildi.png` });
          await add.click();
          await modal.waitFor({ state: 'detached' });
          await page.getByRole('button', { name: 'Gönder', exact: true }).click();
          await page.getByRole('button', { name: 'Gönder', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
        });
        const done = await api.call('kasa', 'GET', `/orders/${o.id}`);
        const line = done.items.find((i) => i.productId === product.id);
        assert(line, 'kalem adisyona yazılmadı');
        assert(line.unitPrice === 19500 && JSON.stringify(line.options.map((x) => x.name)) === '["Karton"]', `kalem beklenen gibi değil: ${line.unitPrice} ${JSON.stringify(line.options.map((x) => x.name))}`);
        // Sonraki akışlar menüyü değişmemiş bilir: ürün kaldırılır (satıldığı için gizlenir), gruplar kapanır
        await api.call('patron', 'DELETE', `/admin/products/${product.id}`);
        await setOpen(cup.id, 'E2E bardak', false);
      },
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
    [
      'Tablette kasiyer: hesabı üç kişiye böler, payları nakit ve kartla ayrı ayrı alır',
      async () => {
        const product = (name) => seed.boot.products.find((p) => p.name === name);
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        await api.call('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 3 }, { productId: product('Türk Kahvesi').id, qty: 1 }] });
        await withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, `/adisyon/${o.id}`);
          await page.getByRole('button', { name: /^Ödeme · / }).click();
          await page.getByRole('button', { name: 'Paylaş', exact: true }).click();
          // Kitin adet seçicisi: düğmeler Azalt / Artır, adı grubun etiketinde ("Kişi")
          await page.getByRole('group', { name: 'Kişi', exact: true }).getByRole('button', { name: 'Artır', exact: true }).click();
          await page.getByRole('button', { name: 'Hesabı 3 kişiye böl' }).click();
          await page.getByText('Pay 1 · sıradaki').waitFor();
          const cash = async () => {
            await page.getByRole('button', { name: 'Nakit', exact: true }).click();
            await page.getByRole('button', { name: 'Tam', exact: true }).click();
            await page.getByRole('button', { name: /Nakit al$/ }).click();
          };
          await cash();
          await page.getByRole('button', { name: 'Sıradaki pay' }).click();
          await page.getByText('Pay 2 · sıradaki').waitFor();
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-paylas.png` });
          await page.getByRole('button', { name: 'Kredi kartı', exact: true }).click();
          await page.getByRole('button', { name: /Kredi kartı al$/ }).click();
          await page.getByText('Pay 3 · sıradaki').waitFor();
          await cash();
          await page.getByRole('heading', { name: 'Adisyon kapandı' }).waitFor();
        });
        const done = await api.call('mudur', 'GET', `/orders/${o.id}`);
        const shares = done.payments.filter((p) => !p.refundedAt).map((p) => `${p.shareNo}/${p.shareOf} ${p.methodName}`);
        assert(done.status === 'kapali', `adisyon kapanmadı: ${done.status}`);
        assert(shares.join(', ') === '1/3 Nakit, 2/3 Kredi kartı, 3/3 Nakit', `paylar beklenen gibi değil: ${shares.join(', ')}`);
      },
    ],
    [
      'Self servis: patron modu seçer, yönetimden kasaya dönüş yeni satışa; kasiyer açılışta yeni satışta, Öde ile alır, numara sonuçta büyük; müşteri ekranının teşekkürü numarayı söyler (bara gitmeyen satışta söylemez)',
      async () => {
        assert(simple && stationOf(simple), 'bara giden seçeneksiz tek boy ürün bulunamadı');
        assert(noBar, 'bara gitmeyen seçeneksiz ürün bulunamadı');
        // Bu cihaz müşteri ekranını yansıtır (Adisyon › İşlemler › Müşteri ekranı'nın yazdığı tercih)
        const display = 'e2e-self';
        try {
          await withPage(ctx, 'bilgisayar', 'patron', async (page) => {
            await go(ctx, page, '/yonetim/ayarlar');
            await page.getByRole('radio', { name: /^Self servis/ }).click();
            await page.getByRole('radio', { name: /^Self servis/, checked: true }).waitFor({ timeout: 8000 });
            // Yönetimden kasaya dönüş servis modunun açılış sayfasına: masa planına değil yeni satışa
            await page.getByRole('link', { name: 'Kasa ekranlarına dön' }).click();
            await page.waitForURL(/\/adisyon\//, { timeout: 8000 });
          });
          const boot = await api.call('kasa', 'GET', '/bootstrap');
          assert(boot.settings.serviceMode === 'self', `servis modu kaydedilmedi: ${boot.settings.serviceMode}`);
          let orderId = '';
          let plainId = '';
          let thanks = null;
          let plainThanks = null;
          await withPage(ctx, 'tablet', 'kasa', async (page) => {
            await page.addInitScript((code) => localStorage.setItem('lafpos.pref.display.code', JSON.stringify(code)), display);
            await go(ctx, page, '/');
            await page.waitForURL(/\/adisyon\//, { timeout: 8000 });
            orderId = new URL(page.url()).pathname.split('/').pop();
            const rail = await page.locator('aside').first().innerText();
            assert(/Satış/.test(rail), `self serviste menüde Satış yok: ${rail.replace(/\s+/g, ' ')}`);
            await page.getByPlaceholder('Ürün ara').fill(simple.name);
            await page.getByRole('button', { name: new RegExp(`^${simple.shortName || simple.name}`) }).first().click();
            await page.getByRole('button', { name: /^Öde · / }).click();
            await page.getByRole('button', { name: 'Nakit', exact: true }).click();
            await page.getByRole('button', { name: 'Tam', exact: true }).click();
            await page.getByRole('button', { name: /Nakit al$/ }).click();
            await page.getByRole('heading', { name: 'Adisyon kapandı' }).waitFor({ timeout: 8000 });
            await page.getByText('Sipariş numarası', { exact: true }).waitFor();
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-self-servis.png` });
            await page.getByRole('button', { name: 'Yeni satış', exact: true }).click();
            await page.waitForURL((u) => u.pathname.startsWith('/adisyon/') && !u.pathname.endsWith(orderId), { timeout: 8000 });
            plainId = new URL(page.url()).pathname.split('/').pop();
            // Ödeme penceresinin gerçek gönderimi (kapanırken): teşekkür çağrı numarasıyla
            thanks = await thanksOn(display);

            // Müşteri ekranı numarayı büyük söyler (çağrı numaralı teşekkür 15 sn kalır)
            await go(ctx, page, `/musteri-ekrani?ekran=${display}`);
            await page.getByText('Numaranız', { exact: true }).waitFor({ timeout: 8000 });
            if (thanks?.call) await page.getByText(thanks.call.replace(/^No /, ''), { exact: true }).waitFor();
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-musteri-ekrani-numara.png` });
            const overflow = await overflowReport(page);
            assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);

            // Bara gitmeyen satış: teşekkür numara söylemez (çağrı ekranında da görünmez)
            await go(ctx, page, `/adisyon/${plainId}`);
            await page.getByPlaceholder('Ürün ara').fill(noBar.name);
            await page.getByRole('button', { name: new RegExp(`^${noBar.shortName || noBar.name}`) }).first().click();
            await page.getByRole('button', { name: /^Öde · / }).click();
            await page.getByRole('button', { name: 'Nakit', exact: true }).click();
            await page.getByRole('button', { name: 'Tam', exact: true }).click();
            await page.getByRole('button', { name: /Nakit al$/ }).click();
            await page.getByRole('heading', { name: 'Adisyon kapandı' }).waitFor({ timeout: 8000 });
            await page.getByRole('button', { name: 'Yeni satış', exact: true }).click();
            await page.waitForURL((u) => u.pathname.startsWith('/adisyon/') && !u.pathname.endsWith(plainId), { timeout: 8000 });
            plainThanks = await thanksOn(display, thanks?.at ?? 0);
          });
          const order = await api.call('kasa', 'GET', `/orders/${orderId}`);
          assert(order.status === 'kapali' && order.type === 'tezgah', `tezgâh satışı kapanmadı: ${order.type} ${order.status}`);
          assert(thanks?.call === `No ${order.no}` && thanks.total === order.total, `müşteri ekranının teşekkürü numarasız: ${JSON.stringify(thanks)}`);
          const plain = await api.call('kasa', 'GET', `/orders/${plainId}`);
          assert(plain.status === 'kapali' && plain.items.every((i) => !i.stationId), `bara gitmeyen satış kapanmadı: ${plain.status}`);
          assert(plainThanks?.total === plain.total && plainThanks.call == null, `bara gitmeyen satışın teşekkürü yok ya da numara söyledi: ${JSON.stringify(plainThanks)}`);
          const board = await api.call('', 'GET', '/public/board');
          const entry = [...board.preparing, ...board.ready].find((e) => e.id === orderId);
          assert(entry && entry.no === order.no && !entry.table, `çağrı ekranında numara yok: ${JSON.stringify(entry)}`);

          // Önce ödenen satış hazır olunca Siparişler › Açık'ta teslim bekler: çağrı numarası, "Ödendi" ve Teslim edildi
          await api.call('bar', 'POST', '/kitchen/status', { itemIds: order.items.filter((i) => i.stationId).map((i) => i.id), status: 'hazir' });
          // Teslim yetkisi olmayan (kurye: yalnız paket) düğmesiz "Ödendi" kartı görmez
          const kurye = await api.call('patron', 'POST', '/admin/users', { name: 'Kurye E2E', role: 'kurye', pin: '5959' });
          api.tokens.kurye = (await api.call('', 'POST', '/auth/login', { pin: '5959' })).token;
          try {
            await withPage(ctx, 'telefon', 'kurye', async (page) => {
              await go(ctx, page, '/siparisler');
              await page.getByRole('tab', { name: /^Açık/ }).waitFor({ timeout: 8000 });
              assert((await page.getByText('Ödendi', { exact: true }).count()) === 0, 'kurye düğmesiz "Ödendi" kartı görüyor');
              assert((await page.getByText(`No ${order.no}`, { exact: true }).count()) === 0, 'kurye önce ödenen satışın kartını görüyor');
              await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kurye-siparisler.png` });
            });
          } finally {
            await api.call('patron', 'PATCH', `/admin/users/${kurye.id}`, { active: false });
          }
          await withPage(ctx, 'tablet', 'kasa', async (page) => {
            await go(ctx, page, '/siparisler');
            const label = page.getByText(`No ${order.no}`, { exact: true });
            const card = page.locator('div').filter({ has: label }).filter({ hasText: 'Ödendi' }).last();
            await card.waitFor({ timeout: 8000 });
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-siparisler-self-odendi.png` });
            const overflow = await overflowReport(page);
            assert(overflow.page <= 1 && !overflow.items.length, `Siparişler yatay taşıyor: ${JSON.stringify(overflow)}`);
            await card.getByRole('button', { name: 'Teslim edildi', exact: true }).click();
            await label.waitFor({ state: 'detached', timeout: 8000 });
          });
          const handed = await api.call('kasa', 'GET', `/orders/${orderId}`);
          assert(handed.items.filter((i) => i.stationId).every((i) => i.status === 'servis'), `Siparişler'den teslim edilmedi: ${handed.items.map((i) => i.status)}`);
        } finally {
          await api.call('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
          await api.call('kasa', 'PUT', `/display/${display}`, { kind: 'idle' });
        }
      },
    ],
    [
      'Yarı self servis: Öde harfli masa no sorar, kayıt sürerken ikinci Öde kalemi yinelemez, bar fişi ve çağrı ekranı masayı gösterir',
      async () => {
        assert(simple, 'seçeneksiz tek boy ürün bulunamadı');
        await api.call('patron', 'PUT', '/admin/settings', { serviceMode: 'yari_self' });
        try {
          let orderId = '';
          await withPage(ctx, 'tablet', 'kasa', async (page) => {
            await go(ctx, page, '/satis');
            await page.waitForURL(/\/adisyon\//, { timeout: 8000 });
            orderId = new URL(page.url()).pathname.split('/').pop();
            await page.getByPlaceholder('Ürün ara').fill(simple.name);
            await page.getByRole('button', { name: new RegExp(`^${simple.shortName || simple.name}`) }).first().click();
            await page.getByRole('button', { name: /^Öde · / }).click();
            const dialog = page.getByRole('dialog', { name: 'Masa no / numaratör' });
            await dialog.waitFor();
            // Masa adlarında harf var: klavyeyle "b", tuş takımıyla 12
            await dialog.getByLabel('Masa no').fill('b');
            await dialog.getByRole('button', { name: '1', exact: true }).click();
            await dialog.getByRole('button', { name: '2', exact: true }).click();
            const typed = await dialog.getByLabel('Masa no').inputValue();
            assert(typed === 'B12', `masa no alanı: ${typed}`);
            // Masa no kaydedilirken "Öde"ye yeniden basmak kalemleri bara ikinci kez göndermez
            await page.route('**/api/orders/*/numarator', async (route) => {
              await new Promise((r) => setTimeout(r, 1500));
              await route.continue();
            });
            await dialog.getByRole('button', { name: 'Devam', exact: true }).click();
            await page.getByRole('button', { name: /^Öde · / }).click({ force: true, noWaitAfter: true, timeout: 2000 }).catch(() => {});
            await page.getByRole('button', { name: 'Nakit', exact: true }).click();
            await page.getByRole('button', { name: 'Tam', exact: true }).click();
            await page.getByRole('button', { name: /Nakit al$/ }).click();
            await page.getByRole('heading', { name: 'Adisyon kapandı' }).waitFor({ timeout: 8000 });
            await page.getByText('Masaya götürülecek', { exact: true }).waitFor();
            await page.getByText('Masa B12', { exact: true }).first().waitFor();
            await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-yari-self.png` });
          });
          const order = await api.call('kasa', 'GET', `/orders/${orderId}`);
          assert(order.numarator === 'B12' && order.status === 'kapali', `masa no kaydedilmedi: ${order.numarator} ${order.status}`);
          const sentQty = order.items.filter((i) => !i.voided).reduce((a, i) => a + i.qty, 0);
          assert(sentQty === 1, `kalem bara ${sentQty} kez gitti`);
          const tickets = await api.call('bar', 'GET', '/kitchen');
          const ticket = tickets.find((t) => t.orderId === orderId);
          assert(ticket?.label === 'Masa B12' && ticket.numarator === 'B12', `bar fişinde masa yok: ${ticket?.label}`);
          const board = await api.call('', 'GET', '/public/board');
          const entry = [...board.preparing, ...board.ready].find((e) => e.id === orderId);
          assert(entry?.table === 'B12', `çağrı ekranında masa yok: ${JSON.stringify(entry)}`);
          await withPage(ctx, 'tablet', 'bar', async (page) => {
            await go(ctx, page, '/mutfak');
            await page.getByText('Masa B12', { exact: true }).first().waitFor({ timeout: 8000 });
          });
        } finally {
          await api.call('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
        }
      },
    ],
    [
      'Tablette kasiyer: personel yemeğini ödenmez kapatır, müdür onaylar',
      async () => {
        const table = seed.tables[5];
        const o = await api.call('kasa', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 1 });
        await api.call('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: simple.id, qty: 2 }] });
        await withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, `/adisyon/${o.id}`);
          await page.getByRole('button', { name: 'İşlemler', exact: true }).click();
          await page.getByRole('button', { name: /^Ödenmez kapat/ }).click();
          const reason = page.getByRole('dialog', { name: 'Ödenmez kapat' });
          await reason.getByRole('button', { name: 'Personel yemeği', exact: true }).click();
          await reason.getByRole('button', { name: 'Ödenmez kapat', exact: true }).click();
          const approval = page.getByRole('dialog', { name: 'Yetkili onayı' });
          for (const d of PINS.mudur) await approval.getByRole('button', { name: d, exact: true }).click();
          await approval.getByRole('button', { name: 'Onayla', exact: true }).click();
          await page.waitForURL((u) => !u.pathname.startsWith('/adisyon/'), { timeout: 8000 });
        }, [/istek 403: POST \/api\/orders\/[^/]+\/comp/, /konsol: Failed to load resource: .*403/]);
        const closed = await api.call('kasa', 'GET', `/orders/${o.id}`);
        assert(closed.status === 'kapali' && closed.total === 0, `adisyon kapanmadı: ${closed.status} ${closed.total}`);
        assert(closed.items.every((i) => i.compKind === 'odenmez' && i.compReason === 'Personel yemeği'), 'kalemler ödenmez değil');
      },
    ],
    [
      'Tablette müdür: ödeme ekranından dökülen siparişi zayi kapatır',
      async () => {
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        await api.call('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: simple.id, qty: 1 }] });
        await withPage(ctx, 'tablet', 'mudur', async (page) => {
          await go(ctx, page, `/adisyon/${o.id}`);
          await page.getByRole('button', { name: /^Ödeme · / }).click();
          await page.getByRole('button', { name: 'Zayi', exact: true }).click();
          const reason = page.getByRole('dialog', { name: 'Zayi kapat' });
          await reason.getByRole('button', { name: 'Döküldü', exact: true }).click();
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-mudur-zayi.png` });
          await reason.getByRole('button', { name: 'Zayi kapat', exact: true }).click();
          await reason.waitFor({ state: 'detached', timeout: 8000 });
        });
        const closed = await api.call('kasa', 'GET', `/orders/${o.id}`);
        assert(closed.status === 'kapali' && closed.total === 0, `adisyon kapanmadı: ${closed.status} ${closed.total}`);
        assert(closed.items.every((i) => i.compKind === 'zayi' && i.compReason === 'Döküldü'), 'kalemler zayi değil');
      },
    ],
    [
      'Telefonda kasiyer: Türk kahvesinin Büyük düğmesi şekeri sorar (önseçim yok, seçilene kadar Ekle kapalı); Latte boy düğmesiyle hemen eklenir, "Seçenekli her üründe" ayarında o da sorar',
      async () => {
        const boot = await api.call('kasa', 'GET', '/bootstrap');
        const { M, L } = boot.settings.sizeLabels;
        const latte = boot.products.find((p) => p.name === 'Latte');
        // Kısa adı önceki akışta değişti: kart güncel adla, boy düğmeleri kartın içinden
        const latteTile = (page) => page.getByRole('button', { name: `${latte.shortName?.trim() || latte.name} seçenekleri`, exact: true }).locator('xpath=..');
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        try {
          await withPage(ctx, 'telefon', 'kasa', async (page) => {
            await go(ctx, page, `/adisyon/${o.id}`);
            await page.getByPlaceholder('Ürün ara').fill('Türk Kahvesi');
            await page.getByRole('button', { name: new RegExp(`^${L} `) }).first().click();
            const modal = page.getByRole('dialog', { name: 'Türk Kahvesi' });
            await modal.waitFor({ timeout: 8000 });
            assert((await modal.getByRole('button', { name: new RegExp(`^${L}`) }).getAttribute('aria-pressed')) === 'true', 'dokunulan boy seçili gelmedi');
            for (const name of ['Sade', 'Az şekerli', 'Orta', 'Şekerli']) assert((await modal.getByRole('button', { name, exact: true }).getAttribute('aria-pressed')) === 'false', `şekerde önseçim: ${name}`);
            await modal.getByText('Zorunlu', { exact: true }).waitFor();
            await modal.getByText('Şeker seçin', { exact: true }).waitFor();
            assert(await modal.getByRole('button', { name: /^Ekle/ }).isDisabled(), 'şeker seçilmeden Ekle açık');
            await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-zorunlu-secenek.png` });
            const overflow = await overflowReport(page);
            assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
            // Yalnız pencerenin hedefleri: telefonda arkasında kalan ürün kartları da sayılırdı
            const small = await modal.locator('button').evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) + 0.5 < 44; }).map((e) => e.textContent.trim()));
            assert(!small.length, `44 px altı: ${small.join(', ')}`);
            await modal.getByRole('button', { name: 'Sade', exact: true }).click();
            assert((await modal.getByText('Şeker seçin', { exact: true }).count()) === 0, 'şeker seçildi ama uyarı duruyor');
            await modal.getByRole('button', { name: /^Ekle/ }).click();
            await modal.waitFor({ state: 'detached' });
            // Zorunlu seçimi olmayan iki boylu ürün: boy düğmesi pencere açmadan ekler
            await page.getByPlaceholder('Ürün ara').fill('Latte');
            await latteTile(page).getByRole('button', { name: new RegExp(`^${M} `) }).click();
            assert((await page.getByRole('dialog').count()) === 0, 'Latte için pencere açıldı');
            await page.getByRole('button', { name: 'Gönder', exact: true }).click();
            await page.getByRole('button', { name: 'Gönder', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
          });
          const sent = await api.call('kasa', 'GET', `/orders/${o.id}`);
          const rows = sent.items.map((i) => `${i.name} ${i.size} ${i.optionsText}`.trim());
          assert(rows.includes('Türk Kahvesi L Sade') && sent.items.some((i) => i.productId === latte.id && i.size === 'M'), `adisyonda beklenen kalemler yok: ${rows.join(', ')}`);
          // Patron "Seçenekli her üründe"yi seçer: Latte'nin boy düğmesi de pencereyi açar
          await withPage(ctx, 'bilgisayar', 'patron', async (page) => {
            await go(ctx, page, '/yonetim/ayarlar');
            await page.getByRole('button', { name: 'Seçenekli her üründe', exact: true }).click();
            await page.getByRole('button', { name: 'Kaydet', exact: true }).first().click();
            await page.getByText('Ayarlar kaydedildi').waitFor({ timeout: 8000 });
          });
          const after = await api.call('kasa', 'GET', '/bootstrap');
          assert(after.settings.askOptions === 'hep', `ayar kaydedilmedi: ${after.settings.askOptions}`);
          await withPage(ctx, 'telefon', 'kasa', async (page) => {
            await go(ctx, page, `/adisyon/${o.id}`);
            await page.getByPlaceholder('Ürün ara').fill('Latte');
            await latteTile(page).getByRole('button', { name: new RegExp(`^${L} `) }).click();
            const modal = page.getByRole('dialog', { name: latte.name });
            await modal.waitFor({ timeout: 8000 });
            assert(!(await modal.getByRole('button', { name: /^Ekle/ }).isDisabled()), 'isteğe bağlı seçenekte Ekle kapalı');
            await page.keyboard.press('Escape');
            await modal.waitFor({ state: 'detached' });
          });
        } finally {
          await api.call('patron', 'PUT', '/admin/settings', { askOptions: 'zorunlu' });
        }
      },
    ],
    [
      'Bilgisayarda patron: Masa planı\'nda masaya QR üretir, kart önizlemesi ve adres görünür; kod yenilenince değişir',
      async () => {
        // Plan ilk bölümle açılır: o bölümün ilk etkin masası
        const floor = await api.call('patron', 'GET', '/admin/floor');
        const table = floor.tables.find((x) => x.sectionId === floor.sections[0].id && x.active && x.kind === 'masa');
        assert(table, 'ilk bölümde masa yok');
        await withPage(ctx, 'bilgisayar', 'patron', async (page) => {
          await go(ctx, page, '/yonetim/masa-plani');
          await page.locator(`[data-table-id="${table.id}"]`).click();
          await page.getByRole('button', { name: 'QR üret', exact: true }).click();
          await page.getByRole('img', { name: `${table.name} QR kodu` }).waitFor({ timeout: 8000 });
          await page.getByText(/^https:\/\/laffogato\.net\/masa\/[0-9A-Z]{10}$/).waitFor();
          await page.screenshot({ path: `${ROOT}/e2e/out/bilgisayar-patron-masa-qr.png` });
        });
        const boot = await api.call('kasa', 'GET', '/bootstrap');
        const row = boot.tables.find((t) => t.id === table.id);
        assert(/^[0-9A-HJKMNP-TV-Z]{10}$/.test(row?.qrCode ?? ''), `masa kodu üretilmedi: ${row?.qrCode}`);
        const rotated = await api.call('patron', 'POST', `/admin/tables/${table.id}/qr`, { rotate: true });
        assert(rotated.qrCode && rotated.qrCode !== row.qrCode, 'kod yenilenmedi');
      },
    ],
    [
      'Bilgisayarda kasiyer: Yemeksepeti deneme siparişini şeritten kabul eder; kuryeye verince platform ödemesiyle kapanır',
      async () => {
        await api.call('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
        const { id } = await api.call('kasa', 'POST', '/platforms/yemeksepeti/test-order', { courier: 'platform' });
        await withPage(ctx, 'bilgisayar', 'kasa', async (page) => {
          await go(ctx, page, '/masalar');
          await page.getByRole('button', { name: /Platform siparişi onay bekliyor/ }).click();
          const dialog = page.getByRole('dialog', { name: 'Onay bekleyen platform siparişleri' });
          await dialog.getByRole('button', { name: /^Kabul et · \d+ dk$/ }).click();
          await dialog.waitFor({ state: 'detached', timeout: 8000 });
          await go(ctx, page, '/siparisler');
          await page.getByText('Yemeksepeti', { exact: false }).first().waitFor({ timeout: 8000 });
        });
        const row = (await api.call('kasa', 'GET', '/platforms')).orders.find((o) => o.id === id);
        assert(row?.status === 'kabul' && row.orderId, `kabul edilmedi: ${row?.status}`);
        await api.call('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'yolda' });
        const o = await api.call('patron', 'GET', `/orders/${row.orderId}`);
        assert(o.status === 'kapali' && o.payments[0]?.methodName === 'Yemeksepeti', `platform ödemesiyle kapanmadı: ${o.status}`);
        await api.call('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'kapali' });
      },
    ],
    [
      'Tablette bar: Hazır sekmesinde siparişi teslim eder, çağrı ekranından düşer; Geri al geri getirir; Geçmiş\'ten yeniden teslim eder',
      async () => {
        const latte = seed.boot.products.find((p) => p.name === 'Latte');
        const o = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        const sent = await api.call('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
        await api.call('bar', 'POST', '/kitchen/status', { itemIds: sent.items.map((i) => i.id), status: 'hazir' });
        const onBoard = async () => {
          const board = await api.call('', 'GET', '/public/board');
          return board.ready.some((e) => e.id === o.id);
        };
        assert(await onBoard(), 'hazır sipariş çağrı ekranında yok');
        await withPage(ctx, 'tablet', 'bar', async (page) => {
          await go(ctx, page, '/mutfak');
          await page.getByRole('tab', { name: /^Hazır/ }).click();
          const card = page.locator('article', { hasText: `Tezgâh #${o.no}` });
          await card.waitFor({ timeout: 8000 });
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-bar-hazir-sekmesi.png` });
          const overflow = await overflowReport(page);
          assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
          const small = await smallTargets(page);
          assert(!small.length, `44 px altı: ${small.join(', ')}`);
          await card.getByRole('button', { name: 'Teslim edildi', exact: true }).click();
          await card.waitFor({ state: 'detached', timeout: 8000 });
          const toast = page.getByRole('status').filter({ hasText: `Tezgâh #${o.no} teslim edildi` });
          await toast.waitFor({ timeout: 5000 });
          assert(!(await onBoard()), 'teslim edilen sipariş çağrı ekranından düşmedi');
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-bar-teslim-geri-al.png` });
          await toast.getByRole('button', { name: 'Geri al', exact: true }).click();
          await card.waitFor({ timeout: 8000 });
          assert(await onBoard(), 'geri alınan sipariş çağrı ekranına dönmedi');
          const back = await api.call('kasa', 'GET', `/orders/${o.id}`);
          assert(back.items.every((i) => i.status === 'hazir'), `kalem hazıra dönmedi: ${back.items.map((i) => i.status).join(', ')}`);

          // Geçmiş'te hazır kalemli fiş Geri al'ın yanında Teslim edildi taşır: teslimi geri alınan eski sipariş (Hazır
          // sekmesinde 30 dakika) buradan yeniden teslim edilir
          await page.getByRole('tab', { name: /^Geçmiş/ }).click();
          const past = page.locator('article', { hasText: `Tezgâh #${o.no}` });
          await past.getByRole('button', { name: 'Teslim edildi', exact: true }).waitFor({ timeout: 8000 });
          assert((await past.getByRole('button', { name: 'Geri al', exact: true }).count()) === 1, 'Geçmiş fişinde Geri al yok');
          await past.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-bar-gecmis-teslim.png` });
          const smallPast = await smallTargets(page);
          assert(!smallPast.length, `44 px altı: ${smallPast.join(', ')}`);
          await past.getByRole('button', { name: 'Teslim edildi', exact: true }).click();
          await past.getByRole('button', { name: 'Teslim edildi', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
        });
        assert(!(await onBoard()), 'Geçmiş\'ten teslim edilen sipariş çağrı ekranında');
        const handed = await api.call('kasa', 'GET', `/orders/${o.id}`);
        assert(handed.items.every((i) => i.status === 'servis'), `Geçmiş'ten teslim edilmedi: ${handed.items.map((i) => i.status).join(', ')}`);
      },
    ],
    [
      'Telefonda kasiyer: hazır gel-al siparişini Siparişler\'den, tezgâh satışını adisyondan teslim eder',
      async () => {
        const latte = seed.boot.products.find((p) => p.name === 'Latte');
        const pickup = await api.call('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Selin Bulut' });
        const p1 = await api.call('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
        const counter = await api.call('kasa', 'POST', '/orders', { type: 'tezgah' });
        const c1 = await api.call('kasa', 'POST', `/orders/${counter.id}/items`, { items: [{ productId: latte.id, size: 'L', qty: 2 }] });
        await api.call('bar', 'POST', '/kitchen/status', { itemIds: [...p1.items, ...c1.items].map((i) => i.id), status: 'hazir' });
        await withPage(ctx, 'telefon', 'kasa', async (page) => {
          await go(ctx, page, '/siparisler');
          const card = page.locator('div.rounded-2xl', { hasText: `Selin Bulut #${pickup.no}` }).filter({ has: page.getByRole('button', { name: 'Teslim edildi' }) });
          await card.waitFor({ timeout: 8000 });
          // Kasanın gel-al siparişinde aşama düğmesi ("Hazır") o arada gizli: tek düğme
          assert((await card.getByRole('button', { name: 'Hazır', exact: true }).count()) === 0, 'gel-al kartında ikinci aşama düğmesi var');
          await card.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-siparisler-hazir.png` });
          let overflow = await overflowReport(page);
          assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
          let small = await smallTargets(page);
          assert(!small.length, `44 px altı: ${small.join(', ')}`);
          await card.getByRole('button', { name: 'Teslim edildi', exact: true }).click();
          await page.getByRole('status').filter({ hasText: `Selin Bulut #${pickup.no} teslim edildi` }).waitFor({ timeout: 5000 });

          await go(ctx, page, `/adisyon/${counter.id}`);
          await page.getByRole('tab', { name: /^Adisyon/ }).click();
          await page.getByText('2 ürün hazır', { exact: true }).waitFor({ timeout: 8000 });
          await page.screenshot({ path: `${ROOT}/e2e/out/telefon-kasa-adisyon-hazir.png` });
          overflow = await overflowReport(page);
          assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
          small = await smallTargets(page);
          assert(!small.length, `44 px altı: ${small.join(', ')}`);
          await page.getByRole('button', { name: 'Teslim edildi', exact: true }).click();
          await page.getByText('2 ürün hazır', { exact: true }).waitFor({ state: 'detached', timeout: 8000 });
        });
        const p = await api.call('kasa', 'GET', `/orders/${pickup.id}`);
        assert(p.deliveryStatus === 'teslim' && p.items.every((i) => i.status === 'servis'), `gel-al teslim edilmedi: ${p.deliveryStatus}`);
        const c = await api.call('kasa', 'GET', `/orders/${counter.id}`);
        assert(c.items.every((i) => i.status === 'servis'), `tezgâh satışı teslim edilmedi: ${c.items.map((i) => i.status).join(', ')}`);
      },
    ],
    [
      'Telefonda kilit ekranı: garson PIN’iyle oturum açar; mesai sekmesi ve satırı yok',
      async () => {
        await withPage(ctx, 'telefon', null, async (page) => {
          await go(ctx, page, '/giris');
          assert(!(await page.getByRole('button', { name: 'Mesai', exact: true }).count()), 'kilit ekranında Mesai sekmesi var');
          for (const d of PINS.garson) await page.getByRole('button', { name: d, exact: true }).click();
          if (PINS.garson.length < 6) await page.getByRole('button', { name: 'Giriş', exact: true }).click();
          await page.waitForURL((u) => u.pathname !== '/giris', { timeout: 8000 });
          await page.getByRole('button', { name: /menüsü$/ }).first().click();
          await page.getByRole('button', { name: /^Ekranı kilitle/ }).waitFor({ timeout: 8000 });
          assert(!(await page.getByRole('button', { name: /^Mesaiyi/ }).count()), 'kullanıcı menüsünde mesai satırı var');
        });
        // Personel çekmecesindeki kayıt (önceki akış) garsonun oturumlarını kapatır: yeni oturum
        api.tokens.garson = (await api.call('', 'POST', '/auth/login', { pin: PINS.garson })).token;
      },
    ],
    [
      'Tablette kasiyer: vardiya devrini sayar, garson PIN’iyle devralır',
      () =>
        withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, '/kasa');
          await page.getByRole('button', { name: 'Vardiya devri', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Vardiya devri' });
          await dialog.getByRole('button', { name: 'Toplam tutar', exact: true }).click();
          await dialog.getByRole('textbox', { name: 'Çekmecedeki nakit' }).fill('1000');
          await dialog.getByRole('combobox', { name: /^Devralan/ }).selectOption({ label: 'Garson' });
          await dialog.getByLabel(/^Devralanın PIN/).fill(PINS.garson);
          await dialog.getByRole('button', { name: /^Devri kaydet/ }).click();
          await dialog.waitFor({ state: 'detached', timeout: 8000 });
          const counts = await api.call('kasa', 'GET', '/cash/shift-counts');
          const last = counts.at(-1);
          assert(last && last.toUserName === 'Garson' && last.confirmed && last.counted === 100000, `vardiya devri yazılmadı: ${JSON.stringify(last)}`);
          await page.getByText('Vardiya devirleri').waitFor({ timeout: 8000 });
        }),
    ],
    [
      // Günü kapattığı için en sonda
      'Tablette kasiyer: gece gün sonundan sonra günü müdürün PIN onayıyla yeniden açar',
      async () => {
        for (const o of await api.call('mudur', 'GET', '/orders')) {
          if (o.source === 'pos') await api.call('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Uçtan uca test' });
        }
        const x = await api.call('mudur', 'GET', '/cash/day');
        const closed = await api.call('mudur', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
        await withPage(ctx, 'tablet', 'kasa', async (page) => {
          await go(ctx, page, '/kasa');
          await page.getByRole('heading', { name: 'Bugünün gün sonu alındı' }).waitFor();
          await page.screenshot({ path: `${ROOT}/e2e/out/tablet-kasa-gun-kapandi.png` });
          const overflow = await overflowReport(page);
          assert(overflow.page <= 1 && !overflow.items.length, `yatay taşma: ${JSON.stringify(overflow)}`);
          const small = await smallTargets(page);
          assert(!small.length, `44 px altı: ${small.join(', ')}`);
          await page.getByPlaceholder('Ör. kapanıştan sonra gelen müşteri').fill('Kapanıştan sonra gelen müşteri');
          await page.getByRole('button', { name: 'Günü yeniden aç', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Yetkili onayı' });
          for (const d of PINS.mudur) await dialog.getByRole('button', { name: d, exact: true }).click();
          await dialog.getByRole('button', { name: 'Onayla', exact: true }).click();
          await page.getByRole('button', { name: /Gün sonu \(Z\)/ }).waitFor({ timeout: 8000 });
        }, [/istek 403: POST \/api\/cash\/days\/[^/]+\/reopen/, /konsol: Failed to load resource: .*403/]);
        const now = await api.call('kasa', 'GET', '/cash/day');
        assert(now.day?.id === closed.day.id && now.day.zNo === closed.day.zNo, 'gün aynı Z ile yeniden açılmadı');
      },
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
