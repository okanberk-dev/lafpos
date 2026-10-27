import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Porsiyon ve site (L3 madde 5): porsiyonu biten ürünün Tükendi'si giden kutusundan siteye gider (tekrar denenir,
 * ürün açılınca düşer), doldurulan porsiyon önce sitede açar. Giden kutusunu lafmaliyet de kullanır: birbirinin
 * kaydını göndermezler.
 */
const SECRET = 'p'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  // lafmaliyet de bağlı (sahte sitenin adresine): onun giden kutusu sitenin kayıtlarına dokunmamalı
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET, LAFMALIYET_URL: site.url, LAFMALIYET_SYNC_SECRET: 'l'.repeat(48) });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

async function product(extId: string) {
  const { db, schema } = await import('../server/db/client');
  const { and, eq } = await import('drizzle-orm');
  return db.select().from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, extId))).get()!;
}
async function pending() {
  const { db, schema } = await import('../server/db/client');
  const { and, eq, isNull } = await import('drizzle-orm');
  return db.select().from(schema.outbox).where(and(eq(schema.outbox.target, 'laffogato'), isNull(schema.outbox.sentAt))).all();
}
/** Ürünün son porsiyonunu satar */
async function sellLast(extId: string) {
  const p = await product(extId);
  await h.ok('mudur', 'PATCH', `/admin/products/${p.id}`, { portionsLeft: 1 });
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: p.id, qty: 1, ...(p.priceL != null ? { size: 'M' } : {}) }] });
  return p;
}

describe('porsiyon biter: Tükendi giden kutusundan siteye', () => {
  it('yazım kalemle aynı işlemde kuyruğa girer, siteye gider', async () => {
    await sellLast('mnu-0005');
    const espresso = await product('mnu-0005');
    expect(espresso.active).toBe(false);
    expect(espresso.portionsLeft).toBe(0);
    expect(espresso.soldOutBy).toBe('lafpos');
    expect(await pending()).toEqual([expect.objectContaining({ kind: 'menu.isActive', dedupeKey: 'menu:mnu-0005' })]);
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    expect(await flushSiteOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(site.menuPosts.at(-1)).toEqual({ id: 'mnu-0005', isActive: false, actor: 'LafPOS porsiyon' });
    expect(await pending()).toHaveLength(0);
  });

  it('gönderilemeyen yazım bekler ve görünür; lafmaliyet giden kutusu onu göndermez, saymaz', async () => {
    await sellLast('mnu-0006');
    site.menuPostStatus.push(503);
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 1 });
    const [row] = await pending();
    expect(row.lastError).toMatch(/HTTP 503/);
    const { flushOutbox, lafmaliyetStatus } = await import('../server/sync/lafmaliyet');
    await flushOutbox();
    expect(site.count('POST /api/pos/gun')).toBe(0);
    expect(lafmaliyetStatus().pending).toBe(0);
    const status = await h.ok<{ online: { soldOutPush: { pending: number; lastError: string } } }>('patron', 'GET', '/sync/status');
    expect(status.online.soldOutPush.pending).toBe(1);
    expect(status.online.soldOutPush.lastError).toMatch(/HTTP 503/);
  });

  it('ürün yeniden açılınca bekleyen Tükendi yazımı düşer', async () => {
    const americano = await product('mnu-0006');
    await h.ok('mudur', 'POST', `/sync/products/${americano.id}/availability`, { active: true });
    expect(site.menuPosts.at(-1)).toMatchObject({ id: 'mnu-0006', isActive: true });
    expect(await pending()).toHaveLength(0);
  });
});

describe('porsiyon doldurulur: önce site', () => {
  it('site reddederse hiçbir alan kaydedilmez; kabul ederse yerelde de açılır, sonraki senkron kapatmaz', async () => {
    const before = await product('mnu-0005');
    expect(before.active).toBe(false);
    site.menuPostStatus.push(503);
    const r = await h.call<{ code: string }>('mudur', 'PATCH', `/admin/products/${before.id}`, { portionsLeft: 5, shortName: 'ESP' });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe('site_menu');
    const unchanged = await product('mnu-0005');
    expect([unchanged.active, unchanged.portionsLeft, unchanged.shortName]).toEqual([false, 0, before.shortName]);

    const ok = await h.ok<{ site: string }>('mudur', 'PATCH', `/admin/products/${before.id}`, { portionsLeft: 5 });
    expect(ok.site).toBe('guncellendi');
    expect(site.menuPosts.at(-1)).toMatchObject({ id: 'mnu-0005', isActive: true });
    const open = await product('mnu-0005');
    expect([open.active, open.portionsLeft, open.soldOutBy]).toEqual([true, 5, null]);
    const { runMenuSync } = await import('../server/sync/menu-sync');
    await runMenuSync({ apply: true, force: true });
    expect((await product('mnu-0005')).active).toBe(true);
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.find((a) => a.action === 'product.available')?.message).toMatch(/porsiyonu dolduruldu \(5\)/);
  });
});

async function status() {
  return (await h.ok<{ online: { soldOutPush: { pending: number; rejected: number; lastError: string | null } } }>('patron', 'GET', '/sync/status')).online.soldOutPush;
}
async function syncMenu() {
  const { runMenuSync } = await import('../server/sync/menu-sync');
  return runMenuSync({ apply: true, force: true });
}

describe('porsiyon geri döner: site de açılır', () => {
  it('hazırlanmadan iptal edilen son porsiyon: Satışta yazımı giden kutusundan gider; site ulaşılamazken eşitleme ürünü kapatmaz', async () => {
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    const cake = await product('mnu-0057');
    await h.ok('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: 1 });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: cake.id, qty: 1 }] });
    expect(await flushSiteOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(site.panelActive.get('mnu-0057')).toBe(false);

    // Kasiyer kalemi hemen iptal eder: ürün yerelde açılır, siteye Satışta yazımı kuyruğa girer; site o an yanıt vermez
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { reason: 'Yanlış ürün' });
    const reopened = await product('mnu-0057');
    expect([reopened.active, reopened.portionsLeft, reopened.soldOutBy]).toEqual([true, 1, null]);
    expect(await pending()).toEqual([expect.objectContaining({ dedupeKey: 'menu:mnu-0057', payload: { id: 'mnu-0057', isActive: true, actor: 'LafPOS porsiyon' } })]);
    site.menuPostStatus.push(503);
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 1 });

    // Site hâlâ "Tükendi" diyor ama LafPOS'un yazımı bekliyor: eşitleme ürünü kapatmaz, "Sitede satışta değil" yazmaz
    const r = await syncMenu();
    expect(r.preview?.changes.filter((c) => c.extId === 'mnu-0057')).toEqual([]);
    const held = await product('mnu-0057');
    expect([held.active, held.soldOutBy]).toEqual([true, null]);

    // Bekleme dolunca yazım gider; site açılır, sonraki eşitleme kaydı da ürünü de olduğu gibi bırakır
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.outbox).set({ nextAttemptAt: Date.now() }).where(eq(schema.outbox.dedupeKey, 'menu:mnu-0057')).run();
    expect(await flushSiteOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(site.panelActive.get('mnu-0057')).toBe(true);
    await syncMenu();
    expect((await product('mnu-0057')).active).toBe(true);
    expect(await pending()).toHaveLength(0);
    await h.ok('kasa', 'POST', `/orders/${o.id}/close`);
    await h.ok('mudur', 'PATCH', `/admin/products/${cake.id}`, { portionsLeft: null });
  });
});

describe('porsiyon sayacı bitmemişken kayıt Satışta bilgisine dokunmaz', () => {
  it('sitenin kapattığı sayaçlı ürünün istasyonu ya da rengi kaydedilir; siteye istek gitmez, ürün kapalı kalır', async () => {
    const tea = await product('mnu-0073');
    await h.ok('mudur', 'PATCH', `/admin/products/${tea.id}`, { portionsLeft: 5 });
    site.panelActive.set('mnu-0073', false);
    await syncMenu();
    const closed = await product('mnu-0073');
    expect([closed.active, closed.soldOutBy, closed.portionsLeft]).toEqual([false, 'site', 5]);

    const posts = site.menuPosts.length;
    // Yönetim › Ürünler formu sayacı her kayıtta gönderir
    const r = await h.ok<{ ok: boolean; site?: string }>('mudur', 'PATCH', `/admin/products/${tea.id}`, {
      shortName: null,
      posName: null,
      barcode: null,
      portionsLeft: 5,
      stationId: closed.stationId,
      color: '#123456',
    });
    expect(r.site).toBeUndefined();
    expect(site.menuPosts).toHaveLength(posts);
    const after = await product('mnu-0073');
    expect([after.active, after.soldOutBy, after.color]).toEqual([false, 'site', '#123456']);
    site.panelActive.set('mnu-0073', true);
    await h.ok('mudur', 'POST', `/sync/products/${tea.id}/availability`, { active: true });
    await h.ok('mudur', 'PATCH', `/admin/products/${tea.id}`, { portionsLeft: null });
  });

  it('kasiyerin sayaçlı üründeki Tükendi\'si başka bir alanın kaydıyla açılmaz', async () => {
    const sandwich = await product('mnu-0074');
    await h.ok('mudur', 'PATCH', `/admin/products/${sandwich.id}`, { portionsLeft: 3 });
    await h.ok('kasa', 'POST', `/sync/products/${sandwich.id}/availability`, { active: false });
    const posts = site.menuPosts.length;
    await h.ok('mudur', 'PATCH', `/admin/products/${sandwich.id}`, { portionsLeft: 3, shortName: 'ROSB' });
    expect(site.menuPosts).toHaveLength(posts);
    const after = await product('mnu-0074');
    expect([after.active, after.soldOutBy, after.shortName]).toEqual([false, 'lafpos', 'ROSB']);
    await h.ok('kasa', 'POST', `/sync/products/${sandwich.id}/availability`, { active: true });
    await h.ok('mudur', 'PATCH', `/admin/products/${sandwich.id}`, { portionsLeft: null });
  });
});

describe('site Satışta yazımını reddeder', () => {
  it('404: kalem sitede yok, yazım tamam sayılır, uyarı kalmaz', async () => {
    const before = (await status()).pending;
    site.menuPostStatus.push(404);
    await sellLast('mnu-0075');
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 0 });
    expect((await pending()).filter((r) => r.dedupeKey === 'menu:mnu-0075')).toHaveLength(0);
    expect((await status()).pending).toBe(before);
  });

  it('400: "site reddetti" ayrı sayılır, yeniden denenmez; anahtar yokken sayılmaz; ürün açılınca düşer', async () => {
    site.menuPostStatus.push(400);
    const p = await sellLast('mnu-0037');
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 1 });
    const s = await status();
    expect(s.rejected).toBe(1);
    expect(s.lastError).toMatch(/reddetti \(HTTP 400\)/);
    const posts = site.menuPosts.length;
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(site.menuPosts).toHaveLength(posts);

    const { env } = await import('../server/env');
    const key = env.laffogatoPanelSecret;
    env.laffogatoPanelSecret = '';
    try {
      expect(await status()).toEqual({ pending: 0, rejected: 0, lastError: null });
    } finally {
      env.laffogatoPanelSecret = key;
    }
    await h.ok('mudur', 'PATCH', `/admin/products/${p.id}`, { portionsLeft: 4 });
    expect((await status()).rejected).toBe(0);
  });
});
