import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('anahtar varken panel listesi alınamazsa fiyat ve ürünler yine uygulanır, Satışta bilgisi değişmez; sonraki tur uygular', async () => {
    site.panelActive.set('mnu-0005', false);
    await sync();
    expect((await product('mnu-0005')).active).toBe(false);
    const latteBefore = await product('mnu-0007');
    expect(latteBefore.active).toBe(true);

    // Site espresso'yu yeniden açar ve Latte'nin fiyatını 10 TL artırır; panel 401 döner (kafe saati kaydı)
    site.panelActive.set('mnu-0005', true);
    site.panelActive.set('mnu-0007', false);
    const raised = siteMenuFixture();
    for (const c of raised.categories) for (const i of c.items) if (i.id === 'mnu-0007') i.priceMinor += 1000;
    site.menu = raised;
    site.panelMenuStatus.push(401);
    const { runMenuSync } = await import('../server/sync/menu-sync');
    const r = await runMenuSync({ apply: true });
    expect(r.status).toBe('uygulandi');
    expect(r.warning).toMatch(/Satışta bilgisi alınamadı.*HTTP 401/);
    expect(r.preview?.changes.filter((c) => c.kind === 'geri' || c.kind === 'kalkti')).toEqual([]);
    const latte = await product('mnu-0007');
    expect(latte.price).toBe(latteBefore.price + 1000);
    expect(latte.active).toBe(true);
    expect((await product('mnu-0005')).active).toBe(false);
    const status = await h.ok<{ menu: { state: { lastError?: string } } }>('patron', 'GET', '/sync/status');
    expect(status.menu.state.lastError).toMatch(/HTTP 401/);

    // ETag yazılmadı: sonraki otomatik tur menüyü yeniden alır (304 değil) ve Satışta bilgisini uygular
    const r2 = await runMenuSync({ apply: true });
    expect(r2.status).toBe('uygulandi');
    expect(r2.warning).toBeUndefined();
    expect((await product('mnu-0005')).active).toBe(true);
    expect((await product('mnu-0007')).active).toBe(false);
    site.panelActive.set('mnu-0007', true);
    site.menu = siteMenuFixture();
    await sync();
  });

  it('panel listesi tanınmayan biçimde gelirse (version 1 değil) Satışta bilgisi değişmez; alanı göndermeyen eski site okunur', async () => {
    const { runMenuSync } = await import('../server/sync/menu-sync');
    expect((await product('mnu-0007')).active).toBe(true);
    // Panel Latte'yi Tükendi der ama biçimi LafPOS bilmiyor: liste okunmaz, fiyat ve ürünler yine uygulanır
    site.panelActive.set('mnu-0007', false);
    const raised = siteMenuFixture();
    for (const c of raised.categories) for (const i of c.items) if (i.id === 'mnu-0007') i.priceMinor += 500;
    site.menu = raised;
    const before = (await product('mnu-0007')).price;
    try {
      for (const v of [2, '1']) {
        site.panelMenuVersion = v;
        const r = await runMenuSync({ apply: true, force: true });
        expect(r.status).toBe('uygulandi');
        expect(r.warning).toBe(`Satışta bilgisi alınamadı, ürünlerin Satışta durumu değişmedi: Panel menüsü tanınmayan biçimde (sürüm ${JSON.stringify(v)})`);
        expect(r.preview?.changes.filter((c) => c.kind === 'geri' || c.kind === 'kalkti')).toEqual([]);
        const latte = await product('mnu-0007');
        expect(latte.active).toBe(true);
        expect(latte.price).toBe(before + 500);
      }
      const status = await h.ok<{ menu: { state: { lastError?: string } } }>('patron', 'GET', '/sync/status');
      expect(status.menu.state.lastError).toMatch(/tanınmayan biçimde \(sürüm "1"\)/);
      // Eski site alanı hiç göndermez: liste okunur, Latte kapanır
      site.panelMenuVersion = undefined;
      const r = await runMenuSync({ apply: true, force: true });
      expect(r.warning).toBeUndefined();
      expect((await product('mnu-0007')).active).toBe(false);
    } finally {
      site.panelMenuVersion = 1;
      site.panelActive.set('mnu-0007', true);
      site.menu = siteMenuFixture();
      await sync();
    }
    expect((await product('mnu-0007')).active).toBe(true);
  });

  it('panel listesi yoksa (anahtar yok) bugünkü kural: listede olan satışta, olmayan sitenin Tükendi\'si', async () => {
    const { tx } = await import('../server/db/client');
    const { applyMenu } = await import('../server/sync/laffogato-menu');
    tx((t) => applyMenu(t, without('mnu-0001')));
    const matcha = await product('mnu-0001');
    expect(matcha.active).toBe(false);
    expect(matcha.soldOutBy).toBe('site');
    tx((t) => applyMenu(t, siteMenuFixture() as unknown as SiteMenu));
    expect((await product('mnu-0001')).active).toBe(true);
  });

  it('eşitleme yanıtı ağdayken basılan Tükendi eski panel görüntüsüyle geri alınmaz', async () => {
    const p = await product('mnu-0011');
    expect(p.active).toBe(true);
    let release!: () => void;
    site.panelMenuGate = new Promise<void>((r) => (release = r));
    const posts = site.menuPosts.length;
    const reads = site.count('GET /api/panel/menu');
    // Panel ürünü "açık" okur, yanıt bekler; kasiyer bu arada Tükendi'ye basar
    const syncing = sync();
    while (site.count('GET /api/panel/menu') === reads) await new Promise((r) => setTimeout(r, 2));
    const tap = h.ok<{ site: string }>('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: false });
    await new Promise((r) => setTimeout(r, 30));
    release();
    site.panelMenuGate = null;
    await syncing;
    expect((await tap).site).toBe('guncellendi');
    expect(site.menuPosts.slice(posts)).toEqual([expect.objectContaining({ id: 'mnu-0011', isActive: false })]);
    const after = await product('mnu-0011');
    expect(after.active).toBe(false);
    expect(after.soldOutBy).toBe('lafpos');
    await h.ok('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: true });
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

describe('site kapalıyken', () => {
  it('menü eşitlemesi Node\'un "fetch failed"ı yerine "Siteye ulaşılamadı" ve nedenini yazar; kart ve bildirim aynısını gösterir', async () => {
    const { getSyncState } = await import('../server/lib/settings');
    const lastError = () => getSyncState<{ lastError: string | null }>('laffogato.menu')?.lastError;
    const real = globalThis.fetch;
    // Node fetch'inin ağ hatası: "fetch failed", nedeni cause'da (ECONNREFUSED); zaman aşımı TimeoutError
    let failure: unknown = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => (String(input).includes('/api/mobile/v1/menu') ? Promise.reject(failure) : real(input, init)));
    try {
      await expect(sync()).rejects.toThrow(/^Siteye ulaşılamadı \(ECONNREFUSED\)$/);
      expect(lastError()).toBe('Siteye ulaşılamadı (ECONNREFUSED)');
      // Elle eşitlemenin bildirimi
      const manual = await h.call<{ error: string; code: string }>('patron', 'POST', '/sync/menu/preview', {});
      expect(manual.status).toBe(502);
      expect(manual.json).toMatchObject({ code: 'site_menu', error: 'Site menüsü alınamadı: Siteye ulaşılamadı (ECONNREFUSED)' });

      failure = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      await expect(sync()).rejects.toThrow(/^Siteye ulaşılamadı \(15 saniyede yanıt yok\)$/);
      expect(lastError()).toBe('Siteye ulaşılamadı (15 saniyede yanıt yok)');
    } finally {
      spy.mockRestore();
    }
    // Site dönünce eşitleme yine çalışır, hata kalkar
    await sync();
    expect(lastError()).toBeNull();
  });
});
