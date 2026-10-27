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
      'Self servis: patron modu seçer, yönetimden kasaya dönüş yeni satışa; kasiyer açılışta yeni satışta, Öde ile alır, numara sonuçta büyük',
      async () => {
        assert(simple, 'seçeneksiz tek boy ürün bulunamadı');
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
          await withPage(ctx, 'tablet', 'kasa', async (page) => {
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
          });
          const order = await api.call('kasa', 'GET', `/orders/${orderId}`);
          assert(order.status === 'kapali' && order.type === 'tezgah', `tezgâh satışı kapanmadı: ${order.type} ${order.status}`);
          const board = await api.call('', 'GET', '/public/board');
          const entry = [...board.preparing, ...board.ready].find((e) => e.id === orderId);
          assert(entry && entry.no === order.no && !entry.table, `çağrı ekranında numara yok: ${JSON.stringify(entry)}`);
        } finally {
          await api.call('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
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
