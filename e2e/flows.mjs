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
          await page.getByRole('button', { name: 'Kişi artır' }).click();
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
