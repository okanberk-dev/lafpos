import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Bağımlılık güvenlik açıkları (Dependabot, Kasım 2026): hono 4.13.23 ve @hono/node-server 2.1.11'e yükseltildi.
 *
 * Bizim kodumuz hono'nun `csrf()`, `validator()`, `mount()` ve `css` yardımcılarını kullanmaz; WebSocket de yok (canlı
 * akış SSE). Açıklardan bize dokunabilecek olanlar:
 * - RegExpRouter kodlanmış satır sonu (%0A, %0D, %E2%80%A8, %E2%80%A9) taşıyan yolda joker ara katmanı atlıyordu
 *   (GHSA-h7mg-cq63-vhpq). Yetki `app.use('/api/*', authMiddleware)` ile joker ara katmanda. Bugün uygulamanın
 *   rotaları SmartRouter'ı TrieRouter'a düşürüyor (etkilenmiyor), ama bir rota değişikliği RegExpRouter'a geçirebilir.
 * - @hono/node-server yoldaki ters eğik çizgiyi `/` sayıyordu (GHSA-jpvv-r467-5p4w). Kasanın önünde yola göre karar
 *   veren bir vekil yok, yetki uygulamanın içinde ve dönüştürülmüş yola bakıyordu; artık böyle istek 400 alır.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const TERMINATORS = ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'];
const PROTECTED = ['/bootstrap', '/orders', '/reports/summary', '/admin/users', '/cash/current'];

describe('joker ara katman (yetki) satır sonlu yolda da çalışır', () => {
  it.each(TERMINATORS)('oturumsuz istek %s ile korunan uca ulaşmaz', async (t) => {
    for (const p of PROTECTED) {
      for (const path of [`${p}${t}`, `${p}/${t}`, `${t}${p}`]) {
        const r = await h.call('', 'GET', path);
        // 401 (oturum yok) ya da 404 (uç yok): ikisi de veri döndürmez. `/api%0A/...` API yolu değildir: derlenmiş arayüz
        // varsa (npm run build) arayüz sayfası döner (200, HTML), JSON veri asla
        if (r.status === 200) expect(typeof r.json, `${path} → 200`).toBe('string');
        else expect([401, 404], `${path} → ${r.status}`).toContain(r.status);
        expect(JSON.stringify(r.json)).not.toMatch(/"(products|tables|users|orders)"/);
      }
    }
  });

  it("satır sonlu yolda yetki ara katmanı yanıtlar, hono'nun düz 404 metni değil", async () => {
    const r = await h.call('', 'GET', '/orders%0A');
    expect(typeof r.json).toBe('object');
    expect((r.json as { code?: string }).code).toBe('unauthorized');
  });

  it('oturumlu istek satır sonlu yolda da kendi yetkisiyle yanıtlanır', async () => {
    const r = await h.call('garson', 'GET', '/admin/users%0A');
    expect([403, 404]).toContain(r.status);
  });

  it('RegExpRouter seçilse de joker ara katman satır sonlu yolda çalışır (hono ≥ 4.13.16)', async () => {
    const app = new Hono({ router: new RegExpRouter() });
    app.use('/api/*', async (c, next) => (c.req.header('authorization') ? next() : c.json({ code: 'unauthorized' }, 401)));
    app.get('/api/orders', (c) => c.json({ orders: [] }));
    app.get('/api/orders/:id', (c) => c.json({ order: c.req.param('id') }));
    app.all('/api/*', (c) => c.json({ code: 'not_found' }, 404));
    for (const t of TERMINATORS) {
      for (const path of [`/api/orders${t}`, `/api/${t}orders`, `/api/orders${t}/x`, `/api/orders/x${t}`]) {
        const r = await app.request(path);
        expect(r.status, path).toBe(401);
      }
    }
  });
});

describe('@hono/node-server: yolda ters eğik çizgi', () => {
  it('ham ters eğik çizgili istek 400 alır, uygulamaya dönüştürülmüş yol olarak ulaşmaz; düz istek çalışır', async () => {
    const { createApp } = await import('../server/app');
    const server = serve({ fetch: createApp().fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const raw = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const s = connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
        let out = '';
        s.on('data', (d) => (out += d.toString()));
        s.on('end', () => resolve(out));
        s.on('error', reject);
      });
    try {
      // Bekçinin oturumsuz, yalnız bu bilgisayardan sorusu: düz yol çalışır
      expect(await raw('/api/kasa/bakim')).toMatch(/^HTTP\/1\.1 200/);
      // `/api/public\..\bootstrap` eskiden `/api/bootstrap` olurdu; şimdi istek hiç uygulamaya gitmez
      expect(await raw('/api/public\\..\\bootstrap')).toMatch(/^HTTP\/1\.1 400/);
      expect(await raw('/api\\health')).toMatch(/^HTTP\/1\.1 400/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('kilit dosyası düzeltilmiş sürümlerde', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
  const atLeast = (v: string, min: string) => {
    const a = v.split('.').map(Number);
    const b = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };
  it.each([
    ['hono', '4.13.23'],
    ['@hono/node-server', '2.1.11'],
    ['zod', '4.6.6'],
  ])('%s ≥ %s', (name, min) => {
    for (const [k, p] of Object.entries(lock.packages)) {
      if (k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)) expect(atLeast(p.version, min), `${k} ${p.version}`).toBe(true);
    }
  });
  it('drizzle-kit altındaki esbuild ≥ 0.24.3 (geliştirme sunucusu açığı, GHSA-67mh-4wv8-2f99)', () => {
    for (const [k, p] of Object.entries(lock.packages)) {
      if (k === 'node_modules/esbuild' || k.endsWith('/node_modules/esbuild')) expect(atLeast(p.version, '0.24.3'), `${k} ${p.version}`).toBe(true);
    }
  });
});
