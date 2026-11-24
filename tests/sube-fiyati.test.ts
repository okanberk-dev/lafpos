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
/**
 * Bekleyen zorunlu eşitleme beklenen anda mı. An kasanın saatine okumadaki saat farkıyla çevrilir: sahte sitenin `now`'u
 * isteğin gidişinden önce yazıldığı için fark isteğin süresi kadar kayar (birkaç yüz ms)
 */
function expectPriceSync(p: { at: number; force: boolean } | null, at: number) {
  expect(p?.force).toBe(true);
  expect(Math.abs(p!.at - at)).toBeLessThan(3_000);
}
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
    expectPriceSync(jobs.pendingMenuSync(), at + jobs.PRICE_SYNC_DELAY_MS);

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

  it('an 15 dakikalık yoklamada geçmişse (zamanlayıcı kaçtı) yoklama ETag\'siz eşitler; site saati gerideyse an sitenin saatiyle kurulur', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const state = getSyncState<Record<string, unknown>>('laffogato.menu')!;
    setSyncState('laffogato.menu', { ...state, nextPriceAt: iso(Date.now() - 1_000), priceReadAt: iso(Date.now() - 60_000), priceReadLocalAt: null });
    // Sitenin saati 2 sn geride: an onun saatinde henüz gelmedi, aynı anı yine "bir sonraki" der
    site.panelTop = { now: iso(Date.now() - 2_000), nextPriceAt: iso(Date.now() - 1_000) };
    const reads = panelReads();
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
    // An kasanın saatinde geçti ama sitenin saatinde 1 sn sonra: tek zamanlayıcı, sitenin anına (kasanın saatiyle) + 5 sn
    const pending = jobs.pendingMenuSync()!;
    expect(pending.force).toBe(true);
    expect(pending.at - Date.now()).toBeGreaterThan(4_000);
    expect(pending.at - Date.now()).toBeLessThanOrEqual(1_000 + jobs.PRICE_SYNC_DELAY_MS);
    // Sonraki yoklama zorunlu değil (an sitenin saatinde gelmedi)
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
    site.panelTop = { now: iso(Date.now()), nextPriceAt: null };
    await jobs.runScheduledSync();
    expect(panelReads()).toBe(reads + 2);
    expect(jobs.pendingMenuSync()).toBeNull();
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 2);
  });

  it('kasanın saati ileriyse eşitleme sitenin anına kurulur (okumadaki `now` ile saat farkı)', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    // Kasa 30 sn ileri: sitenin saati 30 sn geride
    const skew = 30_000;
    const siteAt = Date.now() - skew + 10 * 60_000;
    site.panelTop = { now: iso(Date.now() - skew), nextPriceAt: iso(siteAt) };
    await sync();
    jobs.schedulePriceSync();
    const at = jobs.pendingMenuSync()!.at;
    expect(Math.abs(at - (siteAt + skew + jobs.PRICE_SYNC_DELAY_MS))).toBeLessThan(1_000);
    // An kasanın saatinde geçti, sitenin saatinde 20 sn sonra (eski kural "geçti" deyip zamanlayıcı kurmazdı)
    jobs.resetMenuScheduler();
    site.panelTop = { now: iso(Date.now() - skew), nextPriceAt: iso(Date.now() - 10_000) };
    await sync();
    jobs.schedulePriceSync();
    const later = jobs.pendingMenuSync()!;
    expect(later.force).toBe(true);
    expect(Math.abs(later.at - (Date.now() + 20_000 + jobs.PRICE_SYNC_DELAY_MS))).toBeLessThan(1_000);
    jobs.resetMenuScheduler();
    site.panelTop = { now: iso(Date.now()), nextPriceAt: null };
    await sync();
    site.panelTop = {};
  });

  it('yakın fiyat anları tek okumada toplanır: zorunlu eşitlemeler arası en az 60 sn', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    // İşaret eşitlemesi (zorunlu) şimdi; okuma 20 sn sonraki bir fiyat anını söyler
    site.panelTop = { now: iso(Date.now()), nextPriceAt: iso(Date.now() + 20_000) };
    jobs.onSiteMenuChanged();
    await jobs.runScheduledSync();
    const pending = jobs.pendingMenuSync()!;
    expect(pending.force).toBe(true);
    expect(pending.at - Date.now()).toBeGreaterThan(55_000);
    jobs.resetMenuScheduler();
    site.panelTop = { now: iso(Date.now()), nextPriceAt: null };
    await sync();
    site.panelTop = {};
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
    expectPriceSync(jobs.pendingMenuSync(), at + jobs.PRICE_SYNC_DELAY_MS);
    jobs.resetMenuScheduler();
    site.panelTop = {};
  });
});

describe('kasa yeniden başlarsa (bellekteki işaret ve an yok)', () => {
  it('süreç başlayınca ilk eşitleme ETag\'siz: kapalıyken yazılan şube fiyatı gün açılınca alınır, sonra yoklama 304', async () => {
    const jobs = await import('../server/jobs');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    site.panelTop = {};
    await sync();
    // Kasa kapalıyken (gece) Marina'ya yeni fiyat yazıldı, herkese açık menü (Tuzla) değişmedi; kasa yeniden başlar
    site.panelPrices.set(LATTE, marina(4500));
    jobs.resetMenuScheduler();
    const day = (await h.ok<{ day: { id: string } }>('mudur', 'GET', '/cash/day')).day;
    db.update(schema.businessDays).set({ closedAt: Date.now() }).where(eq(schema.businessDays.id, day.id)).run();
    const reads = panelReads();
    await jobs.menuTick();
    expect(panelReads()).toBe(reads);
    db.update(schema.businessDays).set({ closedAt: null }).where(eq(schema.businessDays.id, day.id)).run();
    await jobs.onMenuDayOpened();
    expect(panelReads()).toBe(reads + 1);
    expect(await product(LATTE)).toMatchObject({ price: marina(4500).priceMinor, priceL: marina(4500).priceMinorL });
    // Süreç başına bir kez: sonraki yoklama ETag'li (304, imzalı okuma yok)
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 1);
    // Gün açıkken yeniden başlarsa ilk yoklama da ETag'siz
    jobs.resetMenuScheduler();
    await jobs.menuTick();
    expect(panelReads()).toBe(reads + 2);
    jobs.resetMenuScheduler();
  });
});

describe('imzalı okuma alınamazken önizleme', () => {
  it('yalnız okuma düştüyse şube fiyatı farklı ürün için sahte "diğer" değişikliği çıkmaz (her turda)', async () => {
    site.panelPrices.set(LATTE, marina());
    await sync();
    for (let n = 0; n < 2; n++) {
      site.panelMenuStatus.push(503);
      const r = await sync();
      expect(r.warning).toMatch(/HTTP 503/);
      expect(r.preview?.changes.filter((c) => c.extId === LATTE)).toEqual([]);
    }
    site.panelMenuStatus.push(503);
    const { runMenuSync } = await import('../server/sync/menu-sync');
    const preview = await runMenuSync({ apply: false, force: true });
    expect(preview.preview?.changes.filter((c) => c.extId === LATTE)).toEqual([]);
    expect(await product(LATTE)).toMatchObject({ price: marina().priceMinor });
    await sync();
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
    // Saat farkı: okumada sitenin saati kasanınkinden 30 sn geri. An kasanın saatiyle 30 sn sonra gelir
    const skewed = { nextPriceAt: '2026-11-25T01:00:10.000Z', priceReadAt: '2026-11-25T00:59:30.000Z', priceReadLocalAt: '2026-11-25T01:00:00.000Z' };
    expect(priceInstant(skewed, now)).toEqual({ due: false, at: Date.parse('2026-11-25T01:00:40.000Z') });
    expect(priceInstant(skewed, Date.parse('2026-11-25T01:00:40.000Z'))).toEqual({ due: true, at: null });
  });
});
