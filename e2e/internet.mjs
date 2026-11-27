/**
 * İnternet kesintisi (docs/05-KASA-BILGISAYARI.md §6 "İnternet yokken"): sahte lafmaliyet ucu kapalıyken satış ve gün
 * sonu yapılır, kasa durmaz; gün sonu giden kutusunda bekler ve üst çubukta "İnternet yok · 1 kayıt bekliyor" rozeti
 * görünür. Uç açılınca (kasa dakikada bir TCP ile dener, istek bütçesine girmez) bekleyen gün kendiliğinden ve tam bir
 * kez gider, rozet "Bekleyenler gönderildi" der. Sunucu işleri açık (ASILPOS_NO_JOBS yok), dış adres yalnız sahte uç.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { apiClient, freePort, openContext, PINS, ROOT, settle, startServer } from './lib.mjs';

const NEW_PIN = '8642';

/** Sahte lafmaliyet: gün sonu POST'larını sayar; `up()` ile açılır, başta kapalı (bağlantı reddedilir) */
function fakeLafmaliyet(port) {
  const received = [];
  let server = null;
  return {
    received,
    up: () =>
      new Promise((ok) => {
        server = createServer((req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            if (req.method === 'POST' && req.url === '/api/pos/gun') {
              const day = JSON.parse(body);
              received.push({ signed: String(req.headers['x-laf-signature'] ?? '').startsWith('v1='), body: day });
              // lafmaliyet'in 200'ü gönderilen günü yineler (yoksa AsilPOS gönderildi saymaz)
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, date: day.date, counted: true, switchDay: null }));
              return;
            }
            // Maliyet çekimi gibi öteki uçlar: boş yanıt (bu denemenin konusu değil)
            res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"yok"}');
          });
        });
        server.listen(port, '127.0.0.1', ok);
      }),
    down: () => new Promise((ok) => (server ? server.close(() => ok()) : ok())),
  };
}

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${label}: ${Math.round(timeoutMs / 1000)} sn içinde olmadı`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function runInternet(browser) {
  const results = [];
  const port = await freePort();
  const fake = fakeLafmaliyet(port);
  const server = await startServer({ jobs: true, env: { LAFMALIYET_URL: `http://127.0.0.1:${port}`, LAFMALIYET_SYNC_SECRET: 'e'.repeat(40) } });
  const step = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e?.message ?? e).split('\n')[0] });
      throw e;
    }
  };
  try {
    const api = apiClient(server.base);
    await api.loginAll();
    // Deneme modunda gün lafmaliyet'e gitmez: gerçek kullanıma geçilir (patronun yeni PIN'i), eğitim yazarkasası kapanır
    await api.call('patron', 'POST', '/admin/deneme/bitir', { pin: PINS.patron, newPin: NEW_PIN });
    api.tokens.patron = (await api.call('', 'POST', '/auth/login', { pin: NEW_PIN })).token;
    await api.call('patron', 'PUT', '/admin/settings', { okcProvider: 'kapali' }).catch(() => null);
    // Yeni kurulum şubesiz açılır, şubesiz kasa gün göndermez (docs/03-ENTEGRASYON.md §4c): kasa Marina'nınki
    await api.call('patron', 'PUT', '/admin/settings', { branchId: 'marina' });

    let date = '';
    await step('İnternet yokken satış ve gün sonu durmaz; gün giden kutusunda bekler', async () => {
      await api.call('patron', 'POST', '/cash/day/open', { openingCash: 0 });
      const boot = await api.call('patron', 'GET', '/bootstrap');
      const product = boot.products.find((p) => p.active !== false && !p.soldOut) ?? boot.products[0];
      let o = await api.call('patron', 'POST', '/orders', { type: 'tezgah' });
      o = await api.call('patron', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty: 1 }] });
      const cash = boot.paymentMethods.find((m) => m.name === 'Nakit') ?? boot.paymentMethods[0];
      await api.call('patron', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total });
      const closed = await api.call('patron', 'POST', '/cash/day/close', { countedCash: o.total });
      date = closed.day.date;
      const net = await until(async () => {
        const s = await api.call('patron', 'GET', '/sync/internet');
        return s.state === 'yok' && s.pending >= 1 ? s : null;
      }, 20_000, 'internet yok ve 1 kayıt bekliyor');
      if (fake.received.length) throw new Error('uç kapalıyken istek ulaştı');
      return net;
    });

    await step('Üst çubukta "İnternet yok · 1 kayıt bekliyor" rozeti (bilgisayar ve telefon)', async () => {
      for (const viewport of ['bilgisayar', 'telefon']) {
        const { context, page } = await openContext(browser, viewport, api.tokens.patron);
        try {
          await page.goto(`${server.base}/yonetim`, { waitUntil: 'domcontentloaded' });
          const badge = page.locator('[role="status"][title^="İnternet yok · 1 kayıt bekliyor"] >> visible=true');
          await badge
            .first()
            .waitFor({ timeout: 30_000 })
            .catch(async (e) => {
              await page.screenshot({ path: join(ROOT, 'e2e/out', `hata-internet-${viewport}.png`) });
              throw e;
            });
          await settle(page);
          await page.screenshot({ path: join(ROOT, 'e2e/out', `internet-yok-${viewport}.png`) });
        } finally {
          await context.close();
        }
      }
    });

    await step('İnternet dönünce bekleyen gün kendiliğinden ve tam bir kez gider; rozet "Bekleyenler gönderildi"', async () => {
      await fake.up();
      // Kasa internet yokken dakikada bir dener
      await until(() => fake.received.length > 0, 90_000, 'bekleyen gün gönderilmedi');
      await until(async () => (await api.call('patron', 'GET', '/sync/internet')).state === 'var', 10_000, 'internet var görünmedi');
      await new Promise((r) => setTimeout(r, 3000));
      const days = fake.received.filter((x) => x.body?.date === date);
      if (days.length !== 1) throw new Error(`gün ${days.length} kez gitti (bir olmalı)`);
      if (!days[0].signed) throw new Error('istek imzasız');
      const s = await api.call('patron', 'GET', '/sync/internet');
      if (s.pending !== 0 || !s.sent) throw new Error(`bekleyen ${s.pending}, gönderildi bilgisi ${JSON.stringify(s.sent)}`);
      const { context, page } = await openContext(browser, 'bilgisayar', api.tokens.patron);
      try {
        await page.goto(`${server.base}/yonetim`, { waitUntil: 'domcontentloaded' });
        await page.locator('[role="status"][title*="gönderildi"] >> visible=true').first().waitFor({ timeout: 15_000 });
        await page.screenshot({ path: join(ROOT, 'e2e/out', 'internet-dondu-bilgisayar.png') });
      } finally {
        await context.close();
      }
    });
  } catch {
    /* adım sonucu yazıldı */
  } finally {
    await fake.down();
    await server.stop();
  }
  return results;
}
