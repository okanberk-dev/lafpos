/**
 * AsilPOS uçtan uca denetimi. Önce `npm run build`, sonra `npm run e2e`.
 *
 * 1. Tarama: her rol, izinli her ekranı telefon (390 ve 320 px, dokunmatik), tablet (768 px dikey, 1024 px yatay,
 *    dokunmatik), bilgisayar (1280 px), dokunmatik kasa bilgisayarı (1366 × 768; Windows ölçeği %125 iken 1093 × 614)
 *    ve yatay telefon (844 × 390) boyutunda, patronun ekranlarını ayrıca koyu temada açar (lib.mjs SWEEP_VIEWPORTS).
 *    Konsol ve sayfa hatası, 4xx/5xx istek, yatay taşma, okunmayan yazı, kırpılan ya da ulaşılamayan düğme ve
 *    dokunmatik ekranda 44 px'ten küçük hedef arar; her ekranın görüntüsünü e2e/out/ altına kaydeder.
 * 2. Akışlar: e2e/flows.mjs (telefonda sipariş, ödeme, yönetimde düzenleme).
 * 3. Tarayıcı demosu: e2e/demo.mjs (dist/web/demo; tarama, PIN'siz akışlar, iki sekme).
 * 4. İnternet kesintisi: e2e/internet.mjs (sahte lafmaliyet ucu kapalıyken satış ve gün sonu, rozet, dönüşte tam bir kez).
 * 5. AsilPOS Uzaktan: e2e/uzaktan.mjs (Vercel derlemesi; patron paneli, raporlar ve İndir, girişten önce ve sonra).
 * 6. Personel bağlantısı: e2e/personel.mjs (sahte lafmaliyet personel listesi; önceden seçili aday yok, "Eminim", gün
 *    sonunda workedStaffRefs, Entegrasyon'da personel yanıtı, Kasa › Geçmiş günler › Bugün çalışanlar).
 *
 * Seçenekler: --only=tarama|akis|demo|internet|uzaktan|personel  --viewports=telefon,tablet  --roles=patron  --routes=/yonetim/menu,/raporlar#urunler
 *             --targets=warn (küçük hedefleri yalnız raporla)  --out=klasör (görüntüler; varsayılan e2e/out)
 * Sorun varsa çıkış kodu 1'dir.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDemo } from './demo.mjs';
import { runFlows } from './flows.mjs';
import { runRemote } from './uzaktan.mjs';
import { runInternet } from './internet.mjs';
import { runStaffLink } from './personel.mjs';
import { apiClient, launchBrowser, openContext, overflowReport, ROOT, seedFloor, settle, smallTargets, startServer, SWEEP_VIEWPORTS, VIEWPORT_ROLES } from './lib.mjs';

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

/**
 * Ayrıntılı gün sonu penceresi (sahibin isteği, 25 Kasım 2026): kapanış bildiriminin "Gün sonu al"ı gibi adresle açılır
 * (/kasa?gunsonu=1); başında "Kayda geçecekler" (kör kasada ciro ve beklenen nakit yok). Pencere açılınca parametre silinir
 */
const dayCloseDialog = state('/kasa?gunsonu=1', 'pencere', (page) => page.getByRole('dialog', { name: /^Ayrıntılı gün sonu · Z/ }).waitFor({ timeout: 8000 }));

/**
 * Kapanış saati hatırlatması (sağ altta "Gün sonu al" kartı): sunucuya dokunmadan bootstrap'ın kapanış saati 10 dakika
 * sonraya çekilir. Listenin sonunda: yönlendirme bağlamın kalanında da durur
 */
const closingReminder = state('/kasa', 'kapanis-hatirlatmasi', async (page) => {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now() + 10 * 60_000);
  await page.route('**/api/bootstrap', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.settings.closingTime = hm;
    await route.fulfill({ response: res, json });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('status', { name: 'Kapanış hatırlatması' }).waitFor({ timeout: 8000 });
});

/**
 * Tezgâh satışında gönderilmemiş beş San Sebastian (₺290): bekleyen satır ve dört haneli Öde (₺1.500'ü aşar). Yalnız
 * cihazın sepeti değişir (localStorage), sunucuya bir şey gitmez
 */
const pending = state('@tz', 'bekleyen', async (page) => {
  await page.getByPlaceholder('Ürün ara').fill('San Sebastian', { timeout: 5000 });
  const card = page.getByRole('button', { name: /^San Sebastian/ }).first();
  for (let i = 0; i < 5; i++) await card.click({ timeout: 5000 });
});

/** Telefonda adisyon ürünlerle açılır; hesap ve Öde şeridi alttaki sepet çubuğundan (tablet ve bilgisayarda yan yana) */
const checkTab = async (page) => {
  const bar = page.getByRole('button', { name: /^Sepet: / });
  if (await bar.isVisible()) await bar.click({ timeout: 5000 });
};

/**
 * Masa adisyonunun (@s2, hesap istendi) ödeme penceresi ve İşlemler'in pencereleri: yalnız açılır, hiçbir şey
 * onaylanmaz; sunucuda bir şey değişmez. Taranmayanlar: bölünmüş hesapta Paylaş ve yazarkasada bekleyen sepet
 * (seed.s2'yi değiştirir, flows.mjs onu sonra açar), yarı self Masa no (bütün tarama için başka servis modu ister)
 */
const checkDialogs = [
  ...[
    ['odeme', null],
    ['odeme-nakit', 'Nakit'],
    ['odeme-kalem', 'Kalem seç'],
    ['odeme-paylas', 'Paylaş'],
  ].map(([name, button]) =>
    state('@s2', name, async (page) => {
      await checkTab(page);
      await page.getByRole('button', { name: /^Öde · / }).first().click({ timeout: 5000 });
      const dialog = page.getByRole('dialog', { name: /^Ödeme · / });
      await dialog.waitFor({ timeout: 5000 });
      if (button) await dialog.getByRole('button', { name: button, exact: true }).click({ timeout: 5000 });
    }),
  ),
  ...[
    ['islem-tasi', /^Masa taşı/, 'Masa taşı / birleştir'],
    ['islem-bol', /^Hesabı böl/, 'Hesabı böl / kalem taşı'],
    ['islem-indirim', /^Adisyon indirimi/, 'Adisyon indirimi'],
    ['islem-kisi', /^Kişi sayısı/, 'Kişi sayısı'],
    ['islem-musteri', /^Müşteri ekle/, 'Müşteri'],
    // Ödenmez kişi seçicisi (personel ve müşteriler, neden): yalnız açılır
    ['islem-odenmez', /^Ödenmez kapat/, 'Ödenmez kapat · kimin adına?'],
  ].map(([name, item, title]) =>
    state('@s2', name, async (page) => {
      await page.getByRole('button', { name: 'İşlemler', exact: true }).click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'İşlemler' }).getByRole('button', { name: item }).click({ timeout: 5000 });
      await page.getByRole('dialog', { name: title, exact: true }).waitFor({ timeout: 5000 });
    }),
  ),
];

/**
 * Bar ekranı açık temada (cihaz tercihi: cam önündeki tablet); telefon ve tablette Diğer penceresi açık (56 px
 * satırlar). Tercih tarayıcı bağlamında kalır: listede /mutfak'ın son durumu
 */
const barLight = state('/mutfak', 'acik-tema', async (page) => {
  await page.evaluate(() => localStorage.setItem('asilpos.pref.kds.tema', JSON.stringify('acik')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page);
  const more = page.getByRole('button', { name: 'Diğer', exact: true });
  if (await more.isVisible()) {
    await more.click({ timeout: 5000 });
    await page.getByRole('dialog', { name: 'Bar ekranı' }).waitFor({ timeout: 5000 });
  }
});

const ROUTES = {
  giris: ['/giris'],
  patron: [
    '/patron',
    '/masalar',
    // İki boylu üründe zorunlu seçim: Türk kahvesinin Büyük düğmesi seçenek penceresini açar (şeker seçilmedi, Ekle kapalı)
    state('@tz', 'zorunlu-secenek', async (page) => {
      await page.getByPlaceholder('Ürün ara').fill('Türk Kahvesi', { timeout: 5000 });
      await page.getByRole('button', { name: /^Büyük / }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Türk Kahvesi' }).waitFor({ timeout: 5000 });
    }),
    pending,
    '/siparisler',
    // Kapanan: arama, gün seçici; ilk adisyonun dökümü (varsa)
    state('/siparisler', 'kapanan', async (page) => {
      await page.getByRole('tab', { name: /^Kapanan/ }).click({ timeout: 5000 });
      await page.getByRole('searchbox', { name: 'Kapanan adisyonlarda ara' }).waitFor({ timeout: 5000 });
    }),
    state('/siparisler', 'kapanan-detay', async (page) => {
      await page.getByRole('tab', { name: /^Kapanan/ }).click({ timeout: 5000 });
      await page.getByRole('searchbox', { name: 'Kapanan adisyonlarda ara' }).waitFor({ timeout: 5000 });
      const card = page.locator('[data-order-card]').first();
      if (await card.isVisible().catch(() => false)) {
        await card.click({ timeout: 5000 });
        await page.getByRole('button', { name: 'Hesabı yeniden yazdır', exact: true }).waitFor({ timeout: 5000 });
      }
    }),
    // Kalem iadesi penceresi (kapanmış siparişte): bir latte seçilince geri verilecek tutar ve ödeme yolu kutusu. Sunucu
    // başına bir kez indirimli, iki türle ödenmiş bir tezgâh satışı kapatılır (yalnız bu durum için; iade yapılmaz)
    state('/siparisler', 'kapanan-iade', async (page) => {
      const id = await page.evaluate(async () => {
        const call = async (method, path, body) => {
          const res = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('asilpos.token')}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
          if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
          return res.json();
        };
        const boot = await call('GET', '/bootstrap');
        const latte = boot.products.find((p) => p.name === 'Latte');
        // Üç orta latte, %10 indirim: önceki ekranlarda kapatılan aynı satış yeniden kullanılır (iade onaylanmaz)
        const total = Math.round(latte.price * 3 * 0.9);
        const found = (await call('GET', '/reports/checks')).rows.find((r) => r.status === 'kapali' && r.total === total);
        if (found) return found.id;
        const nakit = boot.paymentMethods.find((m) => m.kind === 'nakit');
        const kart = boot.paymentMethods.find((m) => m.zField === 'card');
        let o = await call('POST', '/orders', { type: 'tezgah', reuse: null });
        o = await call('POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 3 }] });
        o = await call('POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Kampanya' });
        const half = Math.floor(o.total / 2);
        await call('POST', `/orders/${o.id}/payments`, { methodId: nakit.id, amount: half });
        await call('POST', `/orders/${o.id}/payments`, { methodId: kart.id, amount: o.total - half });
        return o.id;
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.getByRole('tab', { name: /^Kapanan/ }).click({ timeout: 5000 });
      await page.getByRole('searchbox', { name: 'Kapanan adisyonlarda ara' }).waitFor({ timeout: 5000 });
      await page.locator(`[data-order-card][data-order-id="${id}"]`).click({ timeout: 5000 });
      await page.getByRole('button', { name: 'Kalem iade et', exact: true }).click({ timeout: 5000 });
      const dialog = page.getByRole('dialog', { name: 'Kalem iade et' });
      await dialog.getByRole('button', { name: /bir artır$/ }).first().click({ timeout: 5000 });
      await dialog.getByText('Geri verilecek', { exact: true }).waitFor({ timeout: 5000 });
    }),
    '/mutfak',
    // Tükenen ürünler › Seçenekler (yulaf sütü bitti); telefon ve tablette araçlar "Diğer" penceresinde
    state('/mutfak', 'tukenen-secenekler', async (page) => {
      const more = page.getByRole('button', { name: 'Diğer', exact: true });
      if (await more.isVisible()) await more.click({ timeout: 5000 });
      await page.getByRole('button', { name: 'Tükendi', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('dialog', { name: 'Tükenen ürünler' }).getByRole('tab', { name: /Seçenekler/ }).click({ timeout: 5000 });
    }),
    state('/mutfak', 'hazir', (page) => page.getByRole('tab', { name: /^Hazır/ }).click({ timeout: 5000 })),
    state('/mutfak', 'gecmis', (page) => page.getByRole('tab', { name: /^Geçmiş/ }).click({ timeout: 5000 })),
    barLight,
    '/cagri',
    '/musteri-ekrani',
    state('/musteri-ekrani', 'uzun-masa', async (page) => {
      // Teşekkür ekranı uzun masa no ile (yarı self, harfli masa no): çağrı kutusu telefonda taşmasın
      await page.evaluate(async () => {
        const res = await fetch('/api/display/e2e-uzun', {
          method: 'PUT',
          headers: { authorization: `Bearer ${localStorage.getItem('asilpos.token')}`, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'thanks', total: 12345, call: 'Masa WWWWWW' }),
        });
        if (!res.ok) throw new Error(`PUT /display → ${res.status}`);
      });
      await page.goto(new URL('/musteri-ekrani?ekran=e2e-uzun', page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.getByText('Masa WWWWWW', { exact: true }).waitFor({ timeout: 5000 });
    }),
    '/kasa',
    dayCloseDialog,
    '/cihaz',
    '/musteriler',
    '/rezervasyon',
    '/raporlar',
    state('/raporlar', 'urunler', (page) => page.getByRole('tab', { name: 'Ürünler', exact: true }).click({ timeout: 5000 })),
    state('/raporlar', 'platformlar', async (page) => {
      // Rapor boş görünmesin: sunucu başına bir kez deneme modunda bir Getir siparişi teslim edilir, biri reddedilir
      await page.evaluate(async () => {
        const call = async (method, path, body) => {
          const res = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('asilpos.token')}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
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
    // Raporun öteki sekmeleri de taranır (44 px, taşma; görüntüsü tasarım denetimi için)
    ...[
      ['saatlik', 'Saatlik'],
      ['hazirlama', 'Hazırlama süresi'],
      ['adisyon', 'Adisyonlar'],
      ['kayip', 'İptal ve indirim'],
      ['happy', 'Happy hour'],
      ['personel', 'Personel'],
      ['aktarim', 'lafmaliyet aktarımı'],
    ].map(([name, label]) => state('/raporlar', name, (page) => page.getByRole('tab', { name: label, exact: true }).click({ timeout: 5000 }))),
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
    // Kişi çekmecesi: lafmaliyet personeli bölümü (taramada bağlantı yok: sakin not; seçici e2e/personel.mjs'te)
    state('/yonetim/personel', 'kisi', async (page) => {
      // Telefonda tablo gizli, satır kartı görünür: görünen ilk "Kasa"
      await page.locator('main >> text="Kasa" >> visible=true').first().click({ timeout: 5000 });
      await page.getByRole('heading', { name: 'lafmaliyet personeli', exact: true }).waitFor({ timeout: 5000 });
    }),
    '/yonetim/roller',
    '/yonetim/odeme',
    '/yonetim/yazarkasa',
    '/yonetim/entegrasyon',
    '/yonetim/platformlar',
    '/yonetim/baglanti-bilgileri',
    '/yonetim/ag',
    '/yonetim/ayarlar',
    '/yonetim/denetim',
    // Sık sorulan sorular (sohbet balonları) ve açık bir yanıt: yanıt balonu, L'Af karosu, ekran adı etiketleri
    '/yardim',
    state('/yardim', 'yanit', async (page) => {
      await page.getByRole('button', { name: 'Gün sonunu (Z) nasıl alırım?', exact: true }).click({ timeout: 5000 });
      await page.getByRole('region', { name: 'Gün sonunu (Z) nasıl alırım?' }).waitFor({ timeout: 5000 });
    }),
    state('/yardim', 'arama', (page) => page.getByRole('searchbox', { name: 'Sorularda ara' }).fill('yazıcı', { timeout: 5000 })),
  ],
  garson: [
    '/masalar',
    // Bahçe: yuvarlak masalar
    state('/masalar', 'bahce', (page) => page.getByRole('tab', { name: /^Bahçe/ }).click({ timeout: 5000 })),
    '/siparisler',
    state('/siparisler', 'kapanan', async (page) => {
      await page.getByRole('tab', { name: /^Kapanan/ }).click({ timeout: 5000 });
      await page.getByRole('searchbox', { name: 'Kapanan adisyonlarda ara' }).waitFor({ timeout: 5000 });
    }),
    '/mutfak',
    '@s1',
    '/yardim',
  ],
  kasa: [
    '/kasa',
    state('/kasa', 'vardiya', (page) => page.getByRole('button', { name: 'Vardiya devri', exact: true }).click({ timeout: 5000 })),
    // Teslim penceresi: "Kime" (patron ve müdür hesapları, Banka, Başka)
    state('/kasa', 'teslim', async (page) => {
      await page.getByRole('button', { name: 'Teslim', exact: true }).click({ timeout: 5000 });
      await page.getByRole('group', { name: 'Kime' }).waitFor({ timeout: 5000 });
    }),
    dayCloseDialog,
    '/masalar',
    '/satis',
    '@s2',
    ...checkDialogs,
    '@tz',
    pending,
    '/cihaz',
    '/yardim',
    closingReminder,
  ],
  bar: ['/mutfak', state('/mutfak', 'hazir', (page) => page.getByRole('tab', { name: /^Hazır/ }).click({ timeout: 5000 })), state('/mutfak', 'gecmis', (page) => page.getByRole('tab', { name: /^Geçmiş/ }).click({ timeout: 5000 })), barLight],
};

/** Kendiliğinden başka adrese geçen ekranlar: "/satis" boş tezgâh satışını açıp adisyona geçer */
const LANDS = { '/satis': '/adisyon/' };

const slug = (route) => route.replace(/^\/|^@/, '').replace(/[/?=&]+/g, '-') || 'kok';

async function sweep(server, api, seed, browser) {
  const outDir = args.out ?? join(ROOT, 'e2e/out');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const viewports = list(args.viewports) ?? Object.keys(SWEEP_VIEWPORTS);
  const roles = list(args.roles) ?? Object.keys(ROUTES);
  const only = list(args.routes);
  const strictTargets = args.targets !== 'warn';
  const failures = [];
  const warnings = [];
  let pages = 0;

  for (const viewport of viewports) {
    for (const role of roles) {
      if (VIEWPORT_ROLES[viewport] && !VIEWPORT_ROLES[viewport].includes(role)) continue;
      const token = role === 'giris' ? null : api.tokens[role];
      const { context, page, problems } = await openContext(browser, viewport, token);
      // Kayma denetimi (sahibin isteği, 22 Kas 2026): tablette ve bilgisayarda marka rayı (sol menü) ve ekranlarının
      // yeri her ekranda aynı olmalı; üst çubuk, uyarı şeritleri ve sekmeler yalnız sağ sütunda açılıp kapanır
      let railAt = null;
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
        const rail = await page.evaluate(() => {
          const nav = document.querySelector('nav.lp-rail');
          if (!nav || !nav.offsetParent) return null;
          const r = nav.getBoundingClientRect();
          const first = nav.querySelector('.lp-rail-list > *')?.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), item: first ? Math.round(first.top) : null };
        });
        if (rail) {
          if (!railAt) railAt = { ...rail, route };
          else if (rail.top !== railAt.top || rail.left !== railAt.left || rail.width !== railAt.width || rail.height !== railAt.height || rail.item !== railAt.item) {
            problems.push(`sol ray kaydı (${railAt.route} → bu ekran): üst ${railAt.top}→${rail.top}, sol ${railAt.left}→${rail.left}, en ${railAt.width}→${rail.width}, boy ${railAt.height}→${rail.height}, ilk ekran ${railAt.item}→${rail.item}`);
          }
        }
        const overflow = await overflowReport(page);
        if (overflow.page > 1) problems.push(`sayfa ${overflow.page} px yatay taşıyor`);
        for (const o of overflow.items) problems.push(`${o.kind ?? 'taşan öğe'}: ${o.text} (sol ${o.left}, sağ ${o.right})`);
        if (SWEEP_VIEWPORTS[viewport].hasTouch) {
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
    if (!args.only || args.only === 'internet') {
      const results = await runInternet(browser);
      for (const r of results) console.log(`  ${r.ok ? 'tamam' : 'HATA '}  ${r.name}${r.ok ? '' : `: ${r.error}`}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`İnternet kesintisi: ${results.length - failed}/${results.length} geçti`);
      if (failed || results.length < 3) exitCode = 1;
    }
    if (!args.only || args.only === 'personel') {
      const results = await runStaffLink(browser);
      for (const r of results) console.log(`  ${r.ok ? 'tamam' : 'HATA '}  ${r.name}${r.ok ? '' : `: ${r.error}`}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`Personel bağlantısı: ${results.length - failed}/${results.length} geçti`);
      if (failed || results.length < 4) exitCode = 1;
    }
    if (!args.only || args.only === 'uzaktan') {
      const { failures, pages } = await runRemote(browser);
      for (const f of failures) console.log(`  HATA   ${f}`);
      console.log(`Uzaktan: ${pages} ekran, ${failures.length} sorun`);
      if (failures.length) exitCode = 1;
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
