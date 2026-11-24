import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeSite, siteMenuFixture, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Şube fiyatı kasada (sahibin 23.11.2026 kararı 1; laffogato #301, docs/03-ENTEGRASYON.md §2.1 "Şube fiyatı"). Site
 * Marina adına imzalı okumada `priceMinor` / `priceMinorL`'i o an Marina'da geçerli fiyat verir, en üstte şubenin bir
 * sonraki fiyat anını (`nextPriceAt`). O an gelince site hiçbir şey yazmaz, işaret oynamaz: kasa gün açıkken o ana tek
 * bir ETag'siz eşitleme kurar (gün kapalıyken an geçtiyse gün açılınca). İmzalı okuma alınamazsa bağlı ürünün fiyatı
 * herkese açık menünün (Tuzla'nın) fiyatıyla ezilmez: son imzalı fiyat kalır.
 */
const SECRET = 'f'.repeat(48);
const LATTE = 'mnu-0007';
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('patron', 'PUT', '/sync/settings', { menuAutoSync: true });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  const jobs = await import('../server/jobs');
  jobs.resetMenuScheduler();
  h.cleanup();
  await site.close();
});

async function product(extId: string) {
  const { db, schema } = await import('../server/db/client');
  const { and, eq } = await import('drizzle-orm');
  return db.select().from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, extId))).get()!;
}
async function sync(opts: { force?: boolean } = { force: true }) {
  const { runMenuSync } = await import('../server/sync/menu-sync');
  return runMenuSync({ apply: true, force: opts.force });
}
const iso = (ms: number) => new Date(ms).toISOString();
const panelReads = () => site.count('GET /api/panel/menu');
/** Herkese açık menüde (Tuzla) Latte'nin fiyatı */
const publicLatte = () => siteMenuFixture().categories.flatMap((c) => c.items).find((i) => i.id === LATTE)!;
/** Marina'nın Latte fiyatı: tabandan ₺15,00 fazla, iki boy */
const marina = (extra = 1500) => ({ priceMinor: publicLatte().priceMinor + extra, priceMinorL: (publicLatte().priceLargeMinor ?? 0) + extra });

describe('imzalı okuma alınamazsa Tuzla fiyatı yazılmaz', () => {
  it('bağlı ürünün M ve L fiyatı son imzalı fiyatta kalır; ad, yeni ürün yine uygulanır; uyarı Entegrasyon\'da', async () => {
    site.panelPrices.set(LATTE, marina());
    await sync();
    expect(await product(LATTE)).toMatchObject({ price: marina().priceMinor, priceL: marina().priceMinorL });

    // Site Latte'nin adını değiştirir ve yeni bir kalem ekler; imzalı okuma 503 (Tuzla fiyatı herkese açık listede)
    const menu = siteMenuFixture();
    const cat = menu.categories.find((c) => c.items.some((i) => i.id === LATTE))!;
    cat.items = cat.items.map((i) => (i.id === LATTE ? { ...i, name: 'Latte Klasik' } : i));
    cat.items.push({ id: 'mnu-0999', name: 'Yeni Latte', priceMinor: 23000, priceLargeMinor: null });
    site.menu = menu;
    site.panelMenuStatus.push(503);
    const r = await sync();
    expect(r.status).toBe('uygulandi');
    expect(r.warning).toBe('Satışta ve fiyat bilgisi alınamadı, ürünlerin Satışta durumu ve fiyatı değişmedi: Panel menüsü alınamadı (HTTP 503)');
    // Önizleme de Tuzla fiyatını "fiyat" / "boy" değişikliği diye göstermez
    expect(r.preview?.changes.filter((c) => c.extId === LATTE && (c.kind === 'fiyat' || c.kind === 'boy'))).toEqual([]);
    const latte = await product(LATTE);
    expect(latte).toMatchObject({ name: 'Latte Klasik', price: marina().priceMinor, priceL: marina().priceMinorL });
    // Yeni ürünün başka kaynağı yok: herkese açık listenin fiyatıyla oluşur, sonraki imzalı okuma düzeltir
    expect(await product('mnu-0999')).toMatchObject({ price: 23000 });
    const status = await h.ok<{ menu: { state: { lastError?: string } } }>('patron', 'GET', '/sync/status');
    expect(status.menu.state.lastError).toMatch(/fiyat bilgisi alınamadı.*HTTP 503/);

    // Okuma dönünce fiyat yine panelden; sahte "açıklama değişti" yok (saklanan özet panelin fiyatıyla)
    const ok = await sync();
    expect(ok.warning).toBeUndefined();
    expect(ok.preview?.changes.filter((c) => c.extId === LATTE)).toEqual([]);
    expect(await product(LATTE)).toMatchObject({ price: marina().priceMinor, priceL: marina().priceMinorL });
    site.menu = siteMenuFixture();
    await sync();
  });
});

describe('nextPriceAt: şubenin bir sonraki fiyat anında tek eşitleme', () => {
  it('gün açıkken o ana (5 sn sonrasına) bir ETag\'siz eşitleme kurulur; o eşitleme yeni fiyatı alır, ikincisi kurulmaz', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    const at = Date.now() + 10 * 60_000;
    site.panelTop = { now: iso(Date.now()), nextPriceAt: iso(at) };
    await sync();
    await jobs.menuTick();
    expect(jobs.pendingMenuSync()).toEqual({ at: at + jobs.PRICE_SYNC_DELAY_MS, force: true });

    // An geldi: site Marina'nın yeni fiyatını verir, bir sonraki an yok
    site.panelPrices.set(LATTE, marina(2500));
    site.panelTop = { now: iso(at + 1), nextPriceAt: null };
    const reads = panelReads();
    await jobs.runScheduledSync();
    expect(panelReads()).toBe(reads + 1);
    expect(await product(LATTE)).toMatchObject({ price: marina(2500).priceMinor, priceL: marina(2500).priceMinorL });
    expect(jobs.pendingMenuSync()).toBeNull();
    // Sonraki yoklama: herkese açık menü 304, imzalı okuma yok, zamanlayıcı boş
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
    expect(jobs.pendingMenuSync()).toBeNull();
  });

  it('gün kapalıyken kurulmaz; an gece geçtiyse gün açılınca ETag\'siz eşitlenir (herkese açık menü değişmese de)', async () => {
    const jobs = await import('../server/jobs');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    jobs.resetMenuScheduler();
    const at = Date.now() + 10 * 60_000;
    site.panelTop = { now: iso(Date.now()), nextPriceAt: iso(at) };
    await sync();
    const day = (await h.ok<{ day: { id: string } }>('mudur', 'GET', '/cash/day')).day;
    db.update(schema.businessDays).set({ closedAt: Date.now() }).where(eq(schema.businessDays.id, day.id)).run();
    jobs.schedulePriceSync();
    expect(jobs.pendingMenuSync()).toBeNull();

    // Gece an geçti (kaydedilen anı geriye alırız: saat ilerlemiş gibi); site yeni fiyatı verir
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const state = getSyncState<Record<string, unknown>>('laffogato.menu')!;
    setSyncState('laffogato.menu', { ...state, nextPriceAt: iso(Date.now() - 60_000), priceReadAt: iso(Date.now() - 3600_000) });
    site.panelPrices.set(LATTE, marina(3500));
    site.panelTop = { now: iso(Date.now()), nextPriceAt: null };
    db.update(schema.businessDays).set({ closedAt: null }).where(eq(schema.businessDays.id, day.id)).run();
    const reads = panelReads();
    await jobs.onMenuDayOpened();
    expect(panelReads()).toBe(reads + 1);
    expect(await product(LATTE)).toMatchObject({ price: marina(3500).priceMinor });
    // Okunduktan sonra yoklama yine zorunlu değil
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
  });

  it('an 15 dakikalık yoklamada geçmişse (zamanlayıcı kaçtı) yoklama ETag\'siz eşitler; site saati gerideyse döngü yok', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const state = getSyncState<Record<string, unknown>>('laffogato.menu')!;
    setSyncState('laffogato.menu', { ...state, nextPriceAt: iso(Date.now() - 1_000), priceReadAt: iso(Date.now() - 60_000) });
    // Sitenin saati 2 sn geride: aynı anı yine "bir sonraki" der
    site.panelTop = { now: iso(Date.now() - 2_000), nextPriceAt: iso(Date.now() - 1_000) };
    const reads = panelReads();
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
    // An kasanın saatinde geçti: zamanlayıcı kurulmaz (geçmiş ana hemen eşitleme döngüsü yok); sonraki yoklama yine dener
    expect(jobs.pendingMenuSync()).toBeNull();
    site.panelTop = { now: iso(Date.now()), nextPriceAt: null };
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 2);
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 2);
  });

  it('24 saatten uzak an zamanlayıcıya kurulmaz (yoklama yaklaşınca kurar); alanı göndermeyen eski site ve bozuk değer hiçbir şey kurmaz', async () => {
    const jobs = await import('../server/jobs');
    for (const top of [{ now: iso(Date.now()), nextPriceAt: iso(Date.now() + 3 * 86_400_000) }, {}, { now: iso(Date.now()), nextPriceAt: 'yarın sabah' }, { nextPriceAt: 12345 }]) {
      jobs.resetMenuScheduler();
      site.panelTop = top;
      await sync();
      await jobs.menuTick();
      expect(jobs.pendingMenuSync()).toBeNull();
    }
    site.panelTop = {};
  });

  it('bekleyen daha erken bir eşitleme varsa ona katılmaz (zorunlu yapmaz); o eşitlemeden sonra kurulur', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    const at = Date.now() + 10 * 60_000;
    site.panelTop = { now: iso(Date.now()), nextPriceAt: iso(at) };
    await sync();
    // LafPOS'un kendi Satışta yazımından sonraki eşitleme 5 sn sonra bekliyor (ETag'li)
    jobs.menuSyncSoon();
    const soon = jobs.pendingMenuSync()!;
    expect(soon.force).toBe(false);
    jobs.schedulePriceSync();
    expect(jobs.pendingMenuSync()).toEqual(soon);
    await jobs.runScheduledSync();
    expect(jobs.pendingMenuSync()).toEqual({ at: at + jobs.PRICE_SYNC_DELAY_MS, force: true });
    jobs.resetMenuScheduler();
    site.panelTop = {};
  });
});

describe('saf kural (server/sync/laffogato-menu.ts priceInstant)', () => {
  it('okunan andan sonraki an: gelecekteyse kurulacak an, geçtiyse zorunlu; okunmuş ya da bozuksa hiçbiri', async () => {
    const { priceInstant } = await import('../server/sync/laffogato-menu');
    const now = Date.parse('2026-11-25T01:00:00.000Z');
    const read = '2026-11-24T20:00:00.000Z';
    expect(priceInstant({ nextPriceAt: '2026-11-25T02:00:00.000Z', priceReadAt: read }, now)).toEqual({ due: false, at: Date.parse('2026-11-25T02:00:00.000Z') });
    expect(priceInstant({ nextPriceAt: '2026-11-25T00:30:00.000Z', priceReadAt: read }, now)).toEqual({ due: true, at: null });
    // Okuma anı fiyat anından sonra: o an zaten okundu
    expect(priceInstant({ nextPriceAt: '2026-11-25T00:30:00.000Z', priceReadAt: '2026-11-25T00:31:00.000Z' }, now)).toEqual({ due: false, at: null });
    for (const s of [null, {}, { nextPriceAt: null }, { nextPriceAt: 'bozuk' }]) expect(priceInstant(s, now)).toEqual({ due: false, at: null });
  });
});
