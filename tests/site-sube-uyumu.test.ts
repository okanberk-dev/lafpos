import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';
import { SITE_SUBELER_ENV, TUKENDI_KASA } from '@shared/eski-adlar';

/**
 * AsilPOS ↔ laffogato (site) bağlantısının şubeli sitedeki kenarları (laffogato `src/lib/panel/branches.ts`, 21 Kas
 * 2026): herkese açık menü yalnız sitenin ana şubesinin (Tuzla) Satışta'sını gösterir, ETag yine de yazılır; Tükendi
 * kilidi yalnız sitenin menüden kaldırdığı kalemde (`onMenu: false`), açma isteğinin 409 `site_closed`'u okunur;
 * masa listesi sitenin 200 sınırını aşmaz; karaokenin şube reddi saat hatası gibi okunmaz.
 */
const SECRET = 's'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const sync = await import('../server/sync/menu-sync');
  return { db, schema, eq, settings, sync };
}

const productByName = async (name: string) => {
  const { db, schema, eq } = await mod();
  const boot = h.boot;
  const p = boot.products.find((x) => x.name === name)!;
  return { p, row: () => db.select().from(schema.products).where(eq(schema.products.id, p.id)).get()! };
};

describe('menü: Marina kasası, Tuzla listesi', () => {
  it("Tuzla'da tükenen, Marina'da satılan ürün herkese açık listede yok: kasada açık kalır, ETag yazılır, sonraki yoklama 304", async () => {
    const { sync, settings } = await mod();
    const { p, row } = await productByName('Latte');
    const full = structuredClone(site.menu);
    try {
      // Herkese açık liste Tuzla'nın: Latte Tuzla'da Tükendi, listede yok. Marina'nın panel satırı açık
      site.menu.categories = site.menu.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.id !== p.extId) }));
      site.panelActive.set(p.extId!, true);
      const r = await sync.runMenuSync({ apply: true, force: true });
      expect(r.status).toBe('uygulandi');
      expect(row().active).toBe(true);
      // Liste "bayat" görünür (bir kez ETag'siz yeniden denenir) ama ETag yazılır: her 15 dakikada tam liste ve imzalı
      // panel okuması istenmez
      expect(r.cdnStale).toBe(true);
      const etag = settings.getSyncState<{ etag?: string }>('laffogato.menu')?.etag;
      expect(etag).toBeTruthy();
      const before = site.queries.length;
      const again = await sync.runMenuSync({ apply: true });
      expect(again.status).toBe('degismedi');
      // 304: imzalı panel okunmadı
      expect(site.queries.slice(before).filter((q) => q.startsWith('GET /api/panel/menu'))).toEqual([]);
    } finally {
      site.menu = full;
      await sync.runMenuSync({ apply: true, force: true });
    }
  });
});

describe('Tükendi kilidi: sitenin menüden kaldırdığı ile şubenin Tükendi’si', () => {
  it("şubede Tükendi (menüde) kasiyerce açılır; site menüden kaldırdıysa kilitli, müdürün açışı okunur 409 alır ve yerelde değişmez", async () => {
    const { sync } = await mod();
    const { p, row } = await productByName('Americano');
    try {
      // Köşkün paneli Marina'da Tükendi yazdı: kalem menüde, yalnız bu şubede kapalı
      site.panelOnMenu.set(p.extId!, true);
      site.panelActive.set(p.extId!, false);
      await sync.runMenuSync({ apply: true, force: true });
      expect(row()).toMatchObject({ active: false, soldOutBy: TUKENDI_KASA });
      // Kasiyer açar: site kabul eder
      const opened = await h.call('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: true });
      expect(opened.status).toBe(200);
      expect(row().active).toBe(true);

      // Site kalemi menüden kaldırdı: kilit
      site.panelOnMenu.set(p.extId!, false);
      site.panelActive.set(p.extId!, false);
      await sync.runMenuSync({ apply: true, force: true });
      expect(row()).toMatchObject({ active: false, soldOutBy: 'site' });
      const cashier = await h.call<{ code: string }>('kasa', 'POST', `/sync/products/${p.id}/availability`, { active: true });
      expect(cashier.status).toBe(403);
      const manager = await h.call<{ code: string; error: string }>('mudur', 'POST', `/sync/products/${p.id}/availability`, { active: true });
      expect(manager.status).toBe(409);
      expect(manager.json).toMatchObject({ code: 'site_closed' });
      expect(manager.json.error).toContain('menüden kaldırmış');
      expect(row().active).toBe(false);
    } finally {
      site.panelOnMenu.clear();
      site.panelActive.set(p.extId!, true);
      await sync.runMenuSync({ apply: true, force: true });
    }
  });

  it('internetsizken açılıp sitede reddedilen (409 site_closed) ürün kasada da kapanır', async () => {
    const { db, schema, eq } = await mod();
    const { enqueueSiteAvailability, flushSiteOutbox } = await import('../server/sync/site-outbox');
    const { p, row } = await productByName('Americano');
    try {
      expect(row().active).toBe(true);
      site.panelOnMenu.set(p.extId!, false);
      enqueueSiteAvailability(db, { extSource: 'laffogato', extId: p.extId! }, true, 'test');
      await flushSiteOutbox();
      expect(row()).toMatchObject({ active: false, soldOutBy: 'site' });
      const parked = db.select().from(schema.outbox).where(eq(schema.outbox.kind, 'menu.isActive')).all().at(-1);
      expect(parked?.lastError).toContain('kasada da kapatıldı');
      // Denetim kaydı ürüne bağlı, açışı kimin yaptığını söyler
      const rec = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'product.sold_out')).all().at(-1);
      expect(rec).toMatchObject({ entity: 'product', entityId: p.id });
      expect(rec?.message).toBe("Americano sitede menüden kaldırılmış; test kullanıcısının AsilPOS'taki açışı geri alındı");
    } finally {
      site.panelOnMenu.clear();
      db.update(schema.products).set({ active: true, soldOutBy: null }).where(eq(schema.products.id, p.id)).run();
    }
  });

  it('yeni gelen ürün yalnız bu şubede Tükendi ise (menüde) kasada açılabilir, kilitli gelmez', async () => {
    const { db, schema, eq, sync } = await mod();
    // Testin başka yerde kullanmadığı, siteye bağlı bir ürün
    const p = h.boot.products.find((x) => x.extId && !['Latte', 'Americano'].includes(x.name))!;
    // Ürün kasada hiç yok: eşitleme onu yeni ekler
    db.delete(schema.productOptionGroups).where(eq(schema.productOptionGroups.productId, p.id)).run();
    db.delete(schema.products).where(eq(schema.products.id, p.id)).run();
    try {
      site.panelOnMenu.set(p.extId!, true);
      site.panelActive.set(p.extId!, false);
      await sync.runMenuSync({ apply: true, force: true });
      const fresh = db.select().from(schema.products).where(eq(schema.products.extId, p.extId!)).get()!;
      expect(fresh).toMatchObject({ active: false, soldOutBy: TUKENDI_KASA });
    } finally {
      site.panelOnMenu.clear();
      site.panelActive.set(p.extId!, true);
      await sync.runMenuSync({ apply: true, force: true });
    }
  });

  it('şube öncesi site (onMenu yok): eski kural, sitenin kapattığı kilitli', async () => {
    const { sync } = await mod();
    const { p, row } = await productByName('Americano');
    try {
      site.panelActive.set(p.extId!, false);
      await sync.runMenuSync({ apply: true, force: true });
      expect(row()).toMatchObject({ active: false, soldOutBy: 'site' });
    } finally {
      site.panelActive.set(p.extId!, true);
      await sync.runMenuSync({ apply: true, force: true });
    }
  });
});

describe('masa QR listesi', () => {
  it('canlı masalar ve emekli kodlar sitenin 200 sınırını aşmaz: canlılar tam, emeklilerin en yenileri', async () => {
    const { db, schema, eq, settings } = await mod();
    const { enqueueSiteTables, RETIRED_CODES_STATE, SITE_TABLES_MAX } = await import('../server/sync/site-outbox');
    await h.ok('patron', 'POST', '/admin/tables/qr', {});
    const live = h.boot.tables.filter((t) => t.kind === 'masa').length;
    const old = Array.from({ length: 200 }, (_, i) => `R${String(i).padStart(9, '0')}`);
    settings.setSyncState(RETIRED_CODES_STATE, old);
    expect(enqueueSiteTables(db)).toBe(true);
    const row = db.select().from(schema.outbox).where(eq(schema.outbox.kind, 'tables.sync')).all().at(-1)!;
    const tables = (row.payload as { tables: { code: string; active: boolean }[] }).tables;
    expect(tables.length).toBe(SITE_TABLES_MAX);
    expect(tables.filter((t) => t.active).length).toBe(live);
    // En yeni emekli kod gider, en eskisi sığmadıysa düşer
    expect(tables.some((t) => t.code === old.at(-1))).toBe(true);
    expect(tables.some((t) => t.code === old[0])).toBe(false);
    db.delete(schema.outbox).where(eq(schema.outbox.kind, 'tables.sync')).run();
    settings.setSyncState(RETIRED_CODES_STATE, []);
  });
});

describe('karaoke', () => {
  it('sitenin şube reddi (403 field: branch) saat hatası gibi okunmaz; öteki 403 yine saati söyler', async () => {
    const { failureMessage } = await import('../server/sync/laffogato-karaoke');
    const branch = failureMessage(403, { error: 'forbidden', field: 'branch' });
    expect(branch).toContain('şubesine (marina)');
    expect(branch).toContain(`${SITE_SUBELER_ENV}`);
    expect(branch).not.toContain('saati');
    expect(failureMessage(403, { error: 'forbidden' })).toContain('tarihi ya da saati yanlış');
  });
});
