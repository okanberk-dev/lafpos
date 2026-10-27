import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import type { SiteMenu } from '../server/sync/laffogato-menu';
import { type FakeSite, siteMenuFixture, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Menü senkronu ve Tükendi kilidi (L3 madde 3-4). Herkese açık menü CDN'den gelir, dakikalarca bayat kalabilir;
 * imzalı panel listesi tazedir ve Satışta bilgisinde karar onundur. Sitenin kapattığını kasiyer açamaz.
 */
const SECRET = 'm'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
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
/** Herkese açık menü, bazı kalemler listede yokken (sitede kalktı ya da CDN'deki kopya bayat) */
function without(...ids: string[]): SiteMenu {
  const m = siteMenuFixture();
  m.categories = m.categories.map((c) => ({ ...c, items: c.items.filter((i) => !ids.includes(i.id)) }));
  return m as unknown as SiteMenu;
}
async function sync() {
  const { runMenuSync } = await import('../server/sync/menu-sync');
  return runMenuSync({ apply: true, force: true });
}

describe('menü senkronu: Satışta bilgisi imzalı panel listesinden', () => {
  it('panel "kapalı" derse CDN\'deki bayat liste ürünü açık tutamaz', async () => {
    site.panelActive.set('mnu-0007', false);
    const r = await sync();
    expect(r.preview?.changes).toContainEqual(expect.objectContaining({ kind: 'kalkti', extId: 'mnu-0007', detail: 'Sitede Tükendi' }));
    const latte = await product('mnu-0007');
    expect(latte.active).toBe(false);
    expect(latte.soldOutBy).toBe('site');
  });

  it('panel "açık" derse listede yok diye kapatılmaz; kapalıysa açılır', async () => {
    site.menu = without('mnu-0006', 'mnu-0007') as never;
    site.panelActive.set('mnu-0007', true);
    const r = await sync();
    expect(r.result?.reactivated).toBe(1);
    expect((await product('mnu-0006')).active).toBe(true);
    const latte = await product('mnu-0007');
    expect(latte.active).toBe(true);
    expect(latte.soldOutBy).toBeNull();
    site.menu = siteMenuFixture();
  });

  it('anahtar varken panel listesi alınamazsa tur uygulanmaz, sonraki tur uygular', async () => {
    site.panelActive.set('mnu-0005', false);
    await sync();
    expect((await product('mnu-0005')).active).toBe(false);
    site.panelActive.set('mnu-0005', true);
    site.panelMenuStatus.push(503);
    await expect(sync()).rejects.toThrow(/Panel menüsü alınamadı \(HTTP 503\)/);
    expect((await product('mnu-0005')).active).toBe(false);
    const status = await h.ok<{ menu: { state: { lastError?: string } } }>('patron', 'GET', '/sync/status');
    expect(status.menu.state.lastError).toMatch(/Panel menüsü alınamadı/);
    await sync();
    expect((await product('mnu-0005')).active).toBe(true);
  });

  it('panel listesi yoksa (anahtar yok) bugünkü kural: listede olan satışta, olmayan sitenin Tükendi\'si', async () => {
    const { tx } = await import('../server/db/client');
    const { applyMenu, siteSaysActive } = await import('../server/sync/laffogato-menu');
    expect(siteSaysActive('mnu-0001', true, null)).toBe(true);
    expect(siteSaysActive('mnu-0001', false, null)).toBe(false);
    tx((t) => applyMenu(t, without('mnu-0001')));
    const matcha = await product('mnu-0001');
    expect(matcha.active).toBe(false);
    expect(matcha.soldOutBy).toBe('site');
    tx((t) => applyMenu(t, siteMenuFixture() as unknown as SiteMenu));
    expect((await product('mnu-0001')).active).toBe(true);
  });
});

describe('Tükendi kilidi', () => {
  it('kasiyer sitenin kapattığını açamaz; yönetici açar, sitede de açılır, denetim kaydına düşer', async () => {
    site.panelActive.set('mnu-0022', false);
    await sync();
    const p = await product('mnu-0022');
    expect(p.soldOutBy).toBe('site');
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.products.find((x) => x.id === p.id)?.soldOutBy).toBe('site');
    const posts = site.menuPosts.length;
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: true });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('site_closed');
    expect(r.json.error).toMatch(/sitede satışta değil/);
    expect(site.menuPosts).toHaveLength(posts);
    expect((await h.ok<{ site: string }>('mudur', 'POST', `/sync/products/${p.id}/availability`, { active: true })).site).toBe('guncellendi');
    expect(site.menuPosts.at(-1)).toMatchObject({ id: 'mnu-0022', isActive: true });
    const after = await product('mnu-0022');
    expect(after.active).toBe(true);
    expect(after.soldOutBy).toBeNull();
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.find((a) => a.action === 'product.available')?.message).toMatch(/sitede kapatılmıştı/);
  });

  it('LafPOS\'un kapattığını kasiyer yine açar (site de onu listelemese)', async () => {
    const p = await product('mnu-0023');
    await h.ok('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: false });
    expect(site.menuPosts.at(-1)).toMatchObject({ id: 'mnu-0023', isActive: false });
    expect((await product('mnu-0023')).soldOutBy).toBe('lafpos');
    site.menu = without('mnu-0023') as never;
    await sync();
    expect((await product('mnu-0023')).soldOutBy).toBe('lafpos');
    await h.ok('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: true });
    expect((await product('mnu-0023')).active).toBe(true);
    expect(site.menuPosts.at(-1)).toMatchObject({ id: 'mnu-0023', isActive: true });
    site.menu = siteMenuFixture();
  });
});

describe('yerel damga kartı, site bağlantısı kuruluyken', () => {
  it('kategori yazılsa da kapalı: ekranda yok, hediye kullanılmaz', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { stampCategoryKeys: ['espresso'] });
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.localStamps).toBe(false);
    const c = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Uygulama üyesi' });
    expect((await h.call<{ code: string }>('kasa', 'POST', `/customers/${c.id}/redeem`, {})).json.code).toBe('stamps_off');
  });
});
