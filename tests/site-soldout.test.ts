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
