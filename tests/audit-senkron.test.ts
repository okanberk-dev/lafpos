import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PanelOrder } from '../server/sync/laffogato-orders';
import { type Harness, startApp } from './harness';

/**
 * Senkron denetiminin bulguları (27 Eki 2026), her biri bir testle: online siparişlerin sürüm sinyali, bozuk
 * yanıt ve masa eşlemesi; menü eşitlemesinde Tükendi, porsiyon sayacı ve POS sırası; lafmaliyet satış listesinde
 * boylar, servis ücreti ve beklenen nakit; gün açılmadan gelen online siparişin iş günü. Site sahte: `fetch` sitenin
 * adresinde bu dosyanın yönlendiricisine düşer.
 */
const SITE = 'https://laffogato.test';
const KEY = 's'.repeat(40);
let h: Harness;

type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
let site: Route = () => undefined;
/** Sahte Upstash (LafPOS Uzaktan) */
const redis = new Map<string, string>();
let realFetch: typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  h = await startApp({ LAFFOGATO_URL: SITE, LAFFOGATO_SYNC_SECRET: KEY, LAFPOS_SESSION_HOURS: '1000000' });
  realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, value] = JSON.parse(String(init.body)) as string[];
      if (cmd === 'SET') redis.set(key!, value!);
      return json({ result: cmd === 'GET' ? (redis.get(key!) ?? null) : 'OK' });
    }
    if (!url.startsWith(SITE)) return realFetch(input, init);
    const path = url.slice(SITE.length);
    return (await site(path, init)) ?? json({ error: 'not_found' }, 404);
  });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.cleanup();
});

const db = async () => {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return { db, schema, eq };
};

const panelOrder = (id: string, extra: Partial<PanelOrder> = {}): PanelOrder => ({
  id,
  orderNo: Number(id.replace(/\D/g, '')) || 1,
  stage: 'new',
  fulfillment: 'pickup',
  label: 'Gel-al',
  firstName: 'Ece',
  scheduledFor: '',
  note: '',
  paidAt: new Date().toISOString(),
  lines: [{ menuItemId: 'mnu-0001', name: 'Matcha Latte', size: 'single', detail: '', note: '', qty: 1 }],
  totalMinor: 21500,
  ...extra,
});

async function onlineRow(extId: string) {
  const { db: d, schema, eq } = await db();
  const o = d.select().from(schema.orders).where(eq(schema.orders.extId, extId)).get();
  const items = o ? d.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id)).all() : [];
  return o ? { ...o, itemStatus: items.map((i) => i.status) } : undefined;
}

describe('online siparişler', () => {
  it('sürüm değiştikten sonra başarısız çekme 5 dk içinde yeniden denenir; arada siteye yüklenilmez', async () => {
    // Bu test dosyanın ilk online testi olmalı: zamanlayıcının modül durumu (son sürüm, son çekme) temiz
    const { onlineOrdersTick } = await import('../server/sync/laffogato-orders');
    let fail = true;
    let pulls = 0;
    site = (path) => {
      if (path === '/api/pos/orders/version') return json({ version: 'v-yeni-siparis' });
      if (path === '/api/panel/orders') {
        pulls++;
        if (fail) {
          fail = false;
          return json({ error: 'unavailable' }, 503);
        }
        return json({ version: 1, complete: true, orders: [panelOrder('ord-surum')] });
      }
      return undefined;
    };
    const t0 = Date.now();
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // 20 sn'de bir, 6 dakika
      for (let i = 0; i <= 18; i++) {
        offset = i * 20_000;
        await onlineOrdersTick();
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
    expect(await onlineRow('ord-surum'), 'sitede ödenmiş sipariş bar ekranına düşmeli').toBeTruthy();
    // İlk deneme + 5 dk sonra bir yeniden deneme; her 20 sn'de değil
    expect(pulls).toBe(2);
  });

  it('200 ama siparişsiz ya da bozuk gövde başarısız çekme sayılır; açık online sipariş kapanmaz', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    let reply: () => Response = () => json({ version: 1, complete: true, orders: [panelOrder('ord-bozuk')] });
    site = (path) => (path === '/api/panel/orders' ? reply() : undefined);
    await syncOnlineOrders();
    expect((await onlineRow('ord-bozuk'))?.status).toBe('acik');

    for (const bad of [
      () => new Response('<html>Bakım</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => json({ error: 'x' }),
      () => json({ orders: 'yok' }),
    ]) {
      reply = bad;
      await expect(syncOnlineOrders()).rejects.toThrow();
      const row = await onlineRow('ord-bozuk');
      expect(row?.status).toBe('acik');
      expect(row?.itemStatus).toEqual(['yeni']);
    }

    // Kesik liste (sitenin 200 sınırı aşıldı): listede olmayan açık sipariş kapatılmaz
    reply = () => json({ version: 1, complete: false, orders: [] });
    await syncOnlineOrders();
    expect((await onlineRow('ord-bozuk'))?.status).toBe('acik');
  });

  it('yerelde kapanmış ama sitede hâlâ açık sipariş yeniden açılır; site bitirince kapanır', async () => {
    const { upsertOnlineOrders, onlineStatus } = await import('../server/sync/laffogato-orders');
    upsertOnlineOrders([panelOrder('ord-hayalet')]);
    // Eski sürümün bozuk yanıtla kapattığı sipariş
    upsertOnlineOrders([]);
    expect((await onlineRow('ord-hayalet'))?.status).toBe('kapali');
    const openBefore = onlineStatus().open;

    upsertOnlineOrders([panelOrder('ord-hayalet', { stage: 'preparing' })]);
    const back = await onlineRow('ord-hayalet');
    expect(back?.status).toBe('acik');
    expect(back?.closedAt).toBeNull();
    expect(back?.extStage).toBe('preparing');
    expect(back?.itemStatus).toEqual(['hazirlaniyor']);
    expect(onlineStatus().open).toBe(openBefore + 1);

    upsertOnlineOrders([]);
    const done = await onlineRow('ord-hayalet');
    expect(done?.status).toBe('kapali');
    expect(done?.itemStatus).toEqual(['servis']);
  });

  it('masa siparişi etiketteki masa adıyla da masaya düşer (site masa kodu tanımlı değilken)', async () => {
    const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    const s2 = h.boot.tables.find((t) => t.name === 'S2')!;
    const b3 = h.boot.tables.find((t) => t.name === 'B3')!;
    expect(s2.siteTableCode).toBeNull();
    upsertOnlineOrders([
      panelOrder('ord-masa1', { fulfillment: 'table', label: 'S2' }),
      panelOrder('ord-masa2', { fulfillment: 'table', label: 'Masa b3' }),
      panelOrder('ord-masa3', { fulfillment: 'table', label: 'Masa 99' }),
    ]);
    expect((await onlineRow('ord-masa1'))?.tableId).toBe(s2.id);
    expect((await onlineRow('ord-masa2'))?.tableId).toBe(b3.id);
    expect((await onlineRow('ord-masa3'))?.tableId).toBeNull();
  });

  it('masada yalnız sitede ödenmiş online sipariş varken garson masaya kendi adisyonunu açar ve masaya adisyon taşınır', async () => {
    const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    const s3 = h.boot.tables.find((t) => t.name === 'S3')!;
    const s4 = h.boot.tables.find((t) => t.name === 'S4')!;
    const b1 = h.boot.tables.find((t) => t.name === 'B1')!;
    // QR'dan masa siparişleri (sitede ödendi), masa adıyla masaya düşer
    upsertOnlineOrders([panelOrder('ord-qr-77', { fulfillment: 'table', label: 'Masa S3', stage: 'preparing' }), panelOrder('ord-qr-78', { fulfillment: 'table', label: 'B1' })], false);
    expect((await onlineRow('ord-qr-77'))?.tableId).toBe(s3.id);
    expect((await onlineRow('ord-qr-78'))?.tableId).toBe(b1.id);

    // Garson masa planında S3'e dokunur (POST /orders masa): online sipariş değil, kasa adisyonu açılır
    type Opened = { id: string; source: string; extPaid: boolean; tableId: string | null };
    const opened = await h.ok<Opened>('garson', 'POST', '/orders', { type: 'masa', tableId: s3.id, guests: 2 });
    expect(opened).toMatchObject({ source: 'pos', extPaid: false, tableId: s3.id });
    const water = h.boot.products.find((p) => !p.extSource && p.active) ?? h.boot.products.find((p) => p.active)!;
    expect((await h.call('garson', 'POST', `/orders/${opened.id}/items`, { items: [{ productId: water.id, qty: 1 }] })).status).toBe(200);
    // Masaya yeniden dokunmak aynı kasa adisyonuna götürür
    expect((await h.ok<Opened>('garson', 'POST', '/orders', { type: 'masa', tableId: s3.id })).id).toBe(opened.id);

    // Yalnız online siparişi olan masa taşımada dolu sayılmaz; kasa adisyonu olan masa dolu
    const other = await h.ok<Opened>('garson', 'POST', '/orders', { type: 'masa', tableId: s4.id });
    expect((await h.ok<Opened>('mudur', 'POST', `/orders/${other.id}/move`, { tableId: b1.id })).tableId).toBe(b1.id);
    const busy = await h.call<{ code: string }>('mudur', 'POST', `/orders/${other.id}/move`, { tableId: s3.id });
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe('table_busy');

    // Gün sonunu tutmasın
    await h.ok('mudur', 'POST', `/orders/${opened.id}/cancel`, { reason: 'Deneme' });
  });
});

// ─── Menü ───────────────────────────────────────────────────────────────────

type SiteItem = { id: string; name: string; priceMinor: number; priceLargeMinor: number | null };
type SiteMenu = { categories: { key: string; items: SiteItem[] }[] };
const snapshot = JSON.parse(readFileSync(new URL('../server/db/menu-snapshot.json', import.meta.url), 'utf8')) as SiteMenu;
const allItems = snapshot.categories.flatMap((c) => c.items);
/** Sitenin Satışta bilgisi (false = Tükendi) ve LafPOS'un siteye yazdıkları */
const siteActive = new Map<string, boolean>();
const posts: { id: string; isActive: boolean; actor: string }[] = [];
const without = (menu: SiteMenu, ids: string[]): SiteMenu => ({ ...menu, categories: menu.categories.map((c) => ({ ...c, items: c.items.filter((i) => !ids.includes(i.id)) })) });
/** Herkese açık menü yalnız satıştakileri listeler */
const liveMenu = () => without(snapshot, allItems.filter((i) => siteActive.get(i.id) === false).map((i) => i.id));
let rejectPost = false;

/** `publicMenu`: CDN'den gelen (eski olabilir) herkese açık menü; imzalı panel her zaman güncel */
const menuSite =
  (publicMenu: () => SiteMenu): Route =>
  (path, init) => {
    if (path === '/api/mobile/v1/menu') return json(publicMenu());
    if (path === '/api/panel/menu' && init.method === 'POST') {
      if (rejectPost) return json({ error: 'unavailable' }, 503);
      const b = JSON.parse(String(init.body)) as { id: string; isActive: boolean; actor: string };
      posts.push(b);
      siteActive.set(b.id, b.isActive);
      return json({ item: { id: b.id, isActive: b.isActive } });
    }
    if (path === '/api/panel/menu') {
      return json({ version: 1, items: allItems.map((i) => ({ id: i.id, isActive: siteActive.get(i.id) !== false, priceMinor: i.priceMinor, priceMinorL: i.priceLargeMinor ?? 0 })) });
    }
    return undefined;
  };

async function product(extId: string) {
  const { db: d, schema, eq } = await db();
  return d.select().from(schema.products).where(eq(schema.products.extId, extId)).get()!;
}
type Applied = { status: string; preview: { changes: { kind: string; extId: string; detail: string }[] } };
const applyMenu = () => h.ok<Applied>('mudur', 'POST', '/sync/menu/apply');
const changesOf = (r: Applied, extId: string) => r.preview.changes.filter((c) => c.extId === extId).map((c) => c.kind);

describe('menü senkronu', () => {
  it('anahtar varken imzalı panelin Satışta bilgisi geçerli: önbellekteki eski menü Tükendi ürünü açmaz', async () => {
    // CDN'deki menü (s-maxage=300) Tükendi yapılan ürünü bir süre daha listeler
    site = menuSite(() => snapshot);
    const americano = await product('mnu-0006');
    expect((await h.ok<{ site: string }>('kasa', 'POST', `/sync/products/${americano.id}/availability`, { active: false })).site).toBe('guncellendi');
    const r = await applyMenu();
    expect(r.status).toBe('uygulandi');
    expect((await product('mnu-0006')).active).toBe(false);
    expect(changesOf(r, 'mnu-0006')).toEqual([]);

    // Tersi: site ürünü yeniden açtı ama CDN'deki menü henüz listelemiyor; LafPOS'ta açık kalır
    const espresso = await product('mnu-0005');
    await h.ok('kasa', 'POST', `/sync/products/${espresso.id}/availability`, { active: false });
    await h.ok('kasa', 'POST', `/sync/products/${espresso.id}/availability`, { active: true });
    site = menuSite(() => without(snapshot, ['mnu-0005']));
    const r2 = await applyMenu();
    expect((await product('mnu-0005')).active).toBe(true);
    expect(changesOf(r2, 'mnu-0005')).toEqual([]);
  });

  it('anahtar yokken yerelde Tükendi yapılan ürün site değişmedikçe açılmaz; sitede geri gelen açılır', async () => {
    const { env } = await import('../server/env');
    const saved = env.laffogatoPanelSecret;
    env.laffogatoPanelSecret = '';
    try {
      const iced = await product('mnu-0022');
      expect((await h.ok<{ site: string }>('kasa', 'POST', `/sync/products/${iced.id}/availability`, { active: false })).site).toBe('anahtar_yok');
      // Başka bir değişiklik (site Buzlu Caffè Latte'yi satıştan kaldırdı) eşitlemeyi tetikler
      site = menuSite(() => without(snapshot, ['mnu-0023']));
      const r = await applyMenu();
      expect((await product('mnu-0022')).active).toBe(false);
      expect(changesOf(r, 'mnu-0022')).toEqual([]);
      expect((await product('mnu-0023')).active).toBe(false);
      expect(changesOf(r, 'mnu-0023')).toEqual(['kalkti']);

      // Site kalemi yeniden satışa koydu: LafPOS'ta da açılır; kasiyerin Tükendi'si sürer
      site = menuSite(() => snapshot);
      const r2 = await applyMenu();
      expect((await product('mnu-0023')).active).toBe(true);
      expect(changesOf(r2, 'mnu-0023')).toEqual(['geri']);
      expect((await product('mnu-0022')).active).toBe(false);
      expect(changesOf(r2, 'mnu-0022')).toEqual([]);
    } finally {
      env.laffogatoPanelSecret = saved;
    }
  });

  it('porsiyon sayacı doldurulunca bağlı ürün sitede de satışa açılır; sonraki eşitleme kapatmaz', async () => {
    const { pushSoldOut } = await import('../server/sync/laffogato-orders');
    site = menuSite(liveMenu);
    const cake = await product('mnu-0058');
    await h.ok('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 1 });
    const nakit = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    const o = await h.ok<{ id: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sold = await h.ok<{ total: number }>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: cake.id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: nakit.id, amount: sold.total });
    expect((await product('mnu-0058')).active).toBe(false);
    // Son porsiyon satılınca (jobs.ts olay dinleyicisi) site de Tükendi olur
    await pushSoldOut([cake.id]);
    expect(siteActive.get('mnu-0058')).toBe(false);

    // Site kabul etmezse ya da ulaşılamazsa sayaç da değişmez (önce site, sonra LafPOS)
    rejectPost = true;
    const failed = await h.call('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 8 });
    rejectPost = false;
    expect(failed.status).toBe(502);
    const offline = site;
    site = (path, init) => (path === '/api/panel/menu' && init.method === 'POST' ? Promise.reject(new TypeError('fetch failed')) : offline(path, init));
    const unreachable = await h.call<{ code: string }>('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 8 });
    site = offline;
    expect(unreachable.status).toBe(502);
    expect(unreachable.json.code).toBe('site_menu');
    expect((await product('mnu-0058')).portionsLeft).toBe(0);

    await h.ok('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 8 });
    expect(siteActive.get('mnu-0058')).toBe(true);
    expect(posts.at(-1)).toMatchObject({ id: 'mnu-0058', isActive: true });
    const r = await applyMenu();
    const after = await product('mnu-0058');
    expect(after.active).toBe(true);
    expect(after.portionsLeft).toBe(8);
    expect(changesOf(r, 'mnu-0058')).toEqual([]);
  });

  it('menü eşitlemesi bağlı ürünün POS sırasına dokunmaz', async () => {
    site = menuSite(liveMenu);
    const latte = await product('mnu-0007');
    await h.ok('mudur', 'PATCH', `/admin/products/${latte.id}`, { sort: -5 });
    await applyMenu();
    expect((await product('mnu-0007')).sort).toBe(-5);
  });
});

// ─── lafmaliyet ─────────────────────────────────────────────────────────────

type DayPayload = {
  z: Record<string, number | null>;
  lines: { posName: string; siteMenuId: string | null; slot: string | null; qty: number; revenue: number; isService: boolean }[];
  ikram: { posName: string; slot: string | null }[];
};
const nakit = () => h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
async function paidSale(items: { productId: string; size?: 'M' | 'L'; qty?: number }[], extra: Record<string, unknown> = { type: 'tezgah' }) {
  const o = await h.ok<{ id: string }>('kasa', 'POST', '/orders', extra);
  const withItems = await h.ok<{ id: string; total: number; totals: { service: number }; items: { id: string; posName?: string }[] }>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: items.map((i) => ({ qty: 1, ...i })),
  });
  await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: nakit().id, amount: withItems.total });
  return withItems;
}
const todayPayload = async () => {
  const { day } = await h.ok<{ day: { id: string } }>('mudur', 'GET', '/cash/day');
  return h.ok<DayPayload>('mudur', 'GET', `/sync/lafmaliyet/gun/${day.id}`);
};
const kurus = (tl: number) => Math.round(tl * 100);

describe('lafmaliyet satış listesi', () => {
  it('lafmaliyet adı verilmiş iki boylu ürünün M ve L satışları ayrı satırda, kendi boyuyla gider', async () => {
    const latte = await product('mnu-0007');
    const espresso = await product('mnu-0005');
    // Yönetim'deki örnek gibi boyuyla yazılmış ad ve boysuz ad
    await h.ok('mudur', 'PATCH', `/admin/products/${latte.id}`, { posName: 'LATTE MEDIUM' });
    await h.ok('mudur', 'PATCH', `/admin/products/${espresso.id}`, { posName: 'ESPRESSO' });
    await paidSale([{ productId: latte.id, size: 'L' }, { productId: latte.id, size: 'M', qty: 2 }, { productId: espresso.id, size: 'L' }, { productId: espresso.id, size: 'M' }]);
    // Düzeltmeden önce satılmış kalem boy eki olmadan saklandı: rapor yine boyuna göre ayırır
    const old = await paidSale([{ productId: latte.id, size: 'L' }]);
    const { db: d, schema, eq } = await db();
    d.update(schema.orderItems).set({ posName: 'LATTE' }).where(eq(schema.orderItems.id, old.items[0]!.id)).run();

    const { lines } = await todayPayload();
    const of = (id: string) => lines.filter((l) => l.siteMenuId === id).map((l) => ({ posName: l.posName, slot: l.slot, qty: l.qty }));
    expect(of('mnu-0007')).toEqual(expect.arrayContaining([{ posName: 'LATTE LARGE', slot: 'L', qty: 2 }, { posName: 'LATTE MEDIUM', slot: 'M', qty: 2 }]));
    expect(of('mnu-0007')).toHaveLength(2);
    expect(of('mnu-0005')).toEqual(expect.arrayContaining([{ posName: 'ESPRESSO LARGE', slot: 'L', qty: 1 }, { posName: 'ESPRESSO MEDIUM', slot: 'M', qty: 1 }]));
    expect(new Set(lines.map((l) => l.posName)).size).toBe(lines.length);
    const csv = await h.call<string>('mudur', 'GET', '/sync/lafmaliyet/satislar.csv');
    expect(csv.json).toContain('LATTE LARGE;2;');
    expect(csv.json).toContain('LATTE MEDIUM;2;');
  });

  it('servis ücreti ayrı hizmet satırı olarak gider: satırların toplamı Z toplamına eşit', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
    try {
      const table = h.boot.tables.find((t) => t.name === 'S5')!;
      const latte = await product('mnu-0007');
      const order = await paidSale([{ productId: latte.id, size: 'M', qty: 3 }], { type: 'masa', tableId: table.id, guests: 2 });
      expect(order.totals.service).toBeGreaterThan(0);
      const { z, lines } = await todayPayload();
      const service = lines.find((l) => l.posName === 'SERVİS ÜCRETİ');
      expect(service).toMatchObject({ siteMenuId: null, slot: null, isService: true, qty: 1, revenue: order.totals.service / 100 });
      expect(lines.reduce((a, l) => a + kurus(l.revenue), 0)).toBe(kurus(z.zTotal!));
      const csv = await h.call<string>('mudur', 'GET', '/sync/lafmaliyet/satislar.csv');
      expect(csv.json).toContain('SERVİS ÜCRETİ;1;');
    } finally {
      await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 0 });
    }
  });

  it('Z\'de nakit sayılan ödeme türü Nakit türünde olmalı: beklenen nakit lafmaliyet\'te de aynı hesaplanır', async () => {
    const bad = await h.call<{ code: string }>('patron', 'POST', '/admin/payment-methods', { name: 'Döviz', kind: 'diger', zField: 'cash' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('cash_kind');
    const doviz = await h.ok<{ id: string }>('patron', 'POST', '/admin/payment-methods', { name: 'Döviz', kind: 'diger', zField: 'other' });
    expect((await h.call('patron', 'PATCH', `/admin/payment-methods/${doviz.id}`, { zField: 'cash' })).status).toBe(400);
    expect((await h.call('patron', 'PATCH', `/admin/payment-methods/${nakit().id}`, { kind: 'diger' })).status).toBe(400);
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${nakit().id}`, { name: 'Nakit' });

    // Günün paketi: lafmaliyet'in formülü (açılış + nakit + giren − harcama − teslim) LafPOS'un beklenen nakdini verir
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'harcama', amount: 5000, description: 'Buz' });
    const { z } = await todayPayload();
    expect(kurus(z.openingCash! + z.cash! + z.cashIn! - z.cashOut! - z.handedOver!)).toBe(kurus(z.expectedCash!));
  });

  it('kullanılmış ödeme türünün türü sonradan değişse de Z nakdi ve beklenen nakit aynı ödemeleri sayar', async () => {
    const before = (await todayPayload()).z;
    const kasa2 = await h.ok<{ id: string }>('patron', 'POST', '/admin/payment-methods', { name: 'Kasa 2', kind: 'nakit', zField: 'cash' });
    const water = h.boot.products.find((p) => !p.extSource && p.active) ?? h.boot.products.find((p) => p.active)!;
    const o = await h.ok<{ id: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const r = await h.ok<{ total: number }>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: water.id, qty: 5 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: kasa2.id, amount: r.total });
    // Yönetici türü düzeltir (Kart, Z alanı kart): denetim kabul eder; ödeme Z'de alındığı alanda kalır
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${kasa2.id}`, { kind: 'kart', zField: 'card' });
    const { z } = await todayPayload();
    expect(kurus(z.cash! - before.cash!)).toBe(r.total);
    expect(kurus(z.expectedCash! - before.expectedCash!)).toBe(r.total);
    expect(kurus(z.cashIn!)).toBe(kurus(before.cashIn!));
    expect(kurus(z.openingCash! + z.cash! + z.cashIn! - z.cashOut! - z.handedOver!)).toBe(kurus(z.expectedCash!));
  });

  it('lafmaliyet adındaki boy eki büyük-küçük harf ve I/İ farkı gözetmeden tanınır; aynı ad tek satırda', async () => {
    const { sizedPosName } = await import('../server/services/menu');
    expect(sizedPosName('LATTE MEDİUM', 'L')).toBe('LATTE LARGE');
    expect(sizedPosName('Latte Medium', 'L')).toBe('Latte LARGE');
    expect(sizedPosName('latte medıum', 'M')).toBe('latte MEDIUM');
    expect(sizedPosName('Latte  large ', 'M')).toBe('Latte MEDIUM');
    expect(sizedPosName('LATTE LARGE', 'L')).toBe('LATTE LARGE');
    expect(sizedPosName('Latte Medium', 'TEK')).toBe('Latte Medium');

    // Yönetim › Menü'de yöneticinin yazdığı ad (yer tutucu "ör. LATTE MEDIUM"): baş harfi büyük
    const latte = await product('mnu-0007');
    await h.ok('mudur', 'PATCH', `/admin/products/${latte.id}`, { posName: 'Latte Medium' });
    await paidSale([{ productId: latte.id, size: 'M' }, { productId: latte.id, size: 'L' }]);
    const { lines, ikram } = await todayPayload();
    // lafmaliyet'in posMatchKey'i gibi: büyük-küçük harf ve I/İ farkı yok
    const key = (s: string) => s.toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');
    // Önceki satışlar "LATTE MEDIUM" adıyla: yazımı farklı aynı ad ayrı satır olmaz
    expect(lines.filter((l) => l.siteMenuId === 'mnu-0007').map((l) => `${l.slot}:${key(l.posName)}`).sort()).toEqual(['L:LATTE LARGE', 'M:LATTE MEDIUM']);
    expect(new Set(lines.map((l) => key(l.posName))).size).toBe(lines.length);
    expect(ikram.every((i) => !/MEDIUM (LARGE|MEDIUM)/.test(key(i.posName)))).toBe(true);
    const csv = await h.call<string>('mudur', 'GET', '/sync/lafmaliyet/satislar.csv');
    expect(key(csv.json)).not.toMatch(/MEDIUM (LARGE|MEDIUM)/);
  });
});

// ─── LafPOS Uzaktan ve ürün görseli (önceki düzeltmelerin denetimi) ───────────

describe('LafPOS Uzaktan ve ürün görseli', () => {
  it('eski ya da yeniden gönderilen özet yenisini ezmez', async () => {
    const CLOUD = 'c'.repeat(40);
    Object.assign(process.env, { LAFPOS_CLOUD_SECRET: CLOUD, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't' });
    const { signedHeaders } = await import('../server/lib/signature');
    const { POST } = await import('../api/uzaktan');
    const push = (at: number) => {
      const body = JSON.stringify({ gz: gzipSync(JSON.stringify({ v: 1, at, orders: {} })).toString('base64') });
      const url = new URL('https://lafpos.vercel.app/api/uzaktan/push');
      return POST(new Request('https://lafpos.vercel.app/api/uzaktan?yol=uzaktan/push', { method: 'POST', body, headers: signedHeaders(CLOUD, 'POST', url, body) }));
    };
    expect((await push(2000)).status).toBe(200);
    // Yakalanıp 300 sn içinde yeniden gönderilen eski itme
    const replay = await push(1000);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { stale?: boolean }).stale).toBe(true);
    expect((JSON.parse(redis.get('lafpos:snapshot')!) as { at: number }).at).toBe(2000);
  });

  it('görsel indirme yönlendirmeyi izlemez: site başka adrese yönlendirse de istek gitmez', async () => {
    const hits: string[] = [];
    const listen = async (srv: Server) => {
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      return (srv.address() as AddressInfo).port;
    };
    const internal = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('ic-ag');
    });
    const internalPort = await listen(internal);
    const fake = createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/gizli${req.url}` });
      res.end();
    });
    const sitePort = await listen(fake);
    site = (path, init) => realFetch(`http://127.0.0.1:${sitePort}${path}`, init);
    try {
      const { thumbFor } = await import('../server/services/media');
      expect(await thumbFor(`${SITE}/menu/yonlendirme.webp`)).toBeNull();
      expect(hits).toEqual([]);
    } finally {
      internal.close();
      fake.close();
    }
  });
});

// ─── İş günü (en sonda: saat taklit edilir, açık gün kapatılır) ──────────────

describe('online siparişin iş günü', () => {
  it('gün açılmadan gelen online sipariş kapanmış önceki güne değil kendi iş gününe yazılır', async () => {
    const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    const ist = (s: string) => Date.parse(`${s}:00+03:00`);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = (s: string) => vi.setSystemTime(ist(s));
      at('2026-11-02T09:00');
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      at('2026-11-03T03:00');
      await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
      // Gece 04:25'te ödenen sipariş 2 Kasım'ın; sabah 07:55'te ödenen 3 Kasım'ın (gün 09:00'da açılır)
      at('2026-11-03T04:30');
      upsertOnlineOrders([panelOrder('ord-gece', { paidAt: new Date(ist('2026-11-03T04:25')).toISOString(), totalMinor: 20000 })]);
      at('2026-11-03T08:00');
      upsertOnlineOrders([panelOrder('ord-sabah', { paidAt: new Date(ist('2026-11-03T07:55')).toISOString(), totalMinor: 30000 })]);
      at('2026-11-03T09:00');
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      at('2026-11-03T09:30');
      upsertOnlineOrders([panelOrder('ord-acik', { paidAt: new Date(ist('2026-11-03T09:28')).toISOString(), totalMinor: 40000 })]);
      // Site hepsini tamamladı (raporlar kapanmış siparişleri sayar)
      at('2026-11-03T09:40');
      upsertOnlineOrders([]);
      at('2026-11-03T12:00');

      type Online = { online: { orders: number; amount: number } };
      const nov2 = await h.ok<Online>('mudur', 'GET', '/reports/summary?from=2026-11-02&to=2026-11-02');
      const nov3 = await h.ok<Online>('mudur', 'GET', '/reports/summary?from=2026-11-03&to=2026-11-03');
      const live = await h.ok<Online>('patron', 'GET', '/reports/patron');
      expect(nov2.online).toEqual({ orders: 1, amount: 20000 });
      expect(nov3.online).toEqual({ orders: 2, amount: 70000 });
      expect(live.online.orders).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
