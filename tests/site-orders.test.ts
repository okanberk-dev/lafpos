import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import { type FakeSite, siteOrdersFixture, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Online siparişler (L3 madde 1-2): başarısız çekim siparişi kaybettirmez, sinyal çalışırken de gün açıkken 15 dk'da bir
 * güvenlik çekimi, kesik liste (`complete: false`) kapatmaz, listeden düşen "Siteden kalktı" kapanır, masa adı yedeği,
 * aşama 404 ve 409'da yeniden çekim. Site yanıtları sitenin `toPanelOrder` çıktısından (tests/fake-site.ts).
 */
const SECRET = 'o'.repeat(48);
let h: Harness;
let site: FakeSite;
let boot: BootstrapDTO;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

async function online() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.orders).where(eq(schema.orders.source, 'laffogato')).all();
}
const byExt = async (extId: string) => (await online()).find((o) => o.extId === extId)!;
const table = (name: string) => boot.tables.find((t) => t.name === name)!;
const pulls = () => site.count('GET /api/panel/orders');

/**
 * Saat dosya boyunca tek: gerçek zaman artı elle eklenen süre (zamanlayıcının belleği testler arasında sürer). Sahte
 * site imzayı zaman penceresine bakmadan doğrular.
 */
let offset = 0;
const realNow = Date.now.bind(Date);
function clock() {
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  return { advance: (ms: number) => (offset += ms), restore: () => spy.mockRestore() };
}

describe('online sipariş zamanlayıcısı', () => {
  it('başarısız çekim sonraki turda yeniden denenir; sürüm yalnız başarılı çekimden sonra kaydedilir', async () => {
    // Masa eşlemesi: B9 sitedeki "Masa 9" (Yönetim › Masa planı); S4'ün alanı boş, yerel adıyla eşlenir
    await h.ok('patron', 'PATCH', `/admin/tables/${table('B9').id}`, { siteTableCode: 'masa 9' });
    const orders = await import('../server/sync/laffogato-orders');
    orders.resetOnlineTimer();
    const c = clock();
    try {
      site.ordersStatus.push(503);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(1);
      expect(await online()).toHaveLength(0);
      // Sinyal aynı ("v1") ama önceki çekim başarısızdı: 20 sn sonraki turda yeniden denenir
      c.advance(20_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(2);
      expect((await online()).map((o) => o.extId).sort()).toEqual(['ord-0101', 'ord-0102', 'ord-0103', 'ord-0104']);
      // Sinyal değişmedi, güvenlik çekiminin zamanı gelmedi: çekim yok
      c.advance(20_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(2);
      expect(site.count('GET /api/pos/orders/version')).toBe(3);
    } finally {
      c.restore();
    }
  });

  it('masa siparişi: önce "Sitedeki masa adı", alanı boş masada yerel ad (Masa S4 → S4)', async () => {
    expect((await byExt('ord-0101')).tableId).toBe(table('S4').id);
    expect((await byExt('ord-0104')).tableId).toBe(table('B9').id);
    expect((await byExt('ord-0102')).tableId).toBeNull();
    const { siteTableLabel } = await import('../server/sync/laffogato-orders');
    expect(siteTableLabel('S4')).toBe('Masa S4');
    expect(siteTableLabel('Masa 4')).toBe('Masa 4');
    expect(siteTableLabel('masa9')).toBe('masa9');
  });

  it('gün açıkken sinyal değişmese de 15 dk\'da bir güvenlik çekimi; gece yalnız sinyal', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    const c = clock();
    try {
      c.advance(15 * 60_000 + 1000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(3);
      // Gün sonu: açık gün yokken güvenlik çekimi yok (siteyi gece uyandırmaz), sinyal değişince yine çeker
      const day = await h.ok<{ summary: { expectedCash: number } }>('patron', 'GET', '/cash/day');
      await h.ok('patron', 'POST', '/cash/day/close', { countedCash: day.summary.expectedCash });
      c.advance(16 * 60_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(3);
      site.version = 'v2';
      c.advance(20_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(4);
    } finally {
      c.restore();
    }
  });

  it('okunamayan sinyal (boş sürüm) 5 dk\'lık yedek çekmeye düşer, her turda çekmez', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    const c = clock();
    try {
      site.version = '';
      c.advance(20_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(4);
      c.advance(5 * 60_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(5);
      c.advance(20_000);
      await orders.onlineOrdersTick();
      expect(pulls()).toBe(5);
    } finally {
      site.version = 'v3';
      c.restore();
    }
  });
});

describe('liste ve kapanış', () => {
  it('kesik liste (complete: false) listede olmayanı kapatmaz', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    site.orders = { complete: false, orders: siteOrdersFixture().orders.filter((o) => o.id !== 'ord-0103') };
    await syncOnlineOrders();
    expect((await byExt('ord-0103')).status).toBe('acik');
  });

  it('bütün listeden düşen sipariş "Siteden kalktı" kapanır: servis sayılmaz, bar ekranından düşer, geri gelirse açılır', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    site.orders = { complete: true, orders: siteOrdersFixture().orders.filter((o) => o.id !== 'ord-0103') };
    expect((await syncOnlineOrders()).closed).toBe(1);
    const gone = await byExt('ord-0103');
    expect(gone.status).toBe('kapali');
    expect(gone.extStage).toBe('gone');
    const items = db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, gone.id)).all();
    expect(items.every((i) => i.status === 'servis' && i.servedAt === null)).toBe(true);
    const audit = await h.ok<{ action: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.find((a) => a.action === 'online.gone' && a.orderId === gone.id)?.message).toMatch(/siteden kalktı/);
    const tickets = await h.ok<{ orderId: string }[]>('mudur', 'GET', '/kitchen');
    expect(tickets.some((t) => t.orderId === gone.id)).toBe(false);
    const tableOrder = await byExt('ord-0101');
    expect(tickets.some((t) => t.orderId === tableOrder.id)).toBe(true);

    site.orders = { complete: true, orders: siteOrdersFixture().orders };
    await syncOnlineOrders();
    const back = await byExt('ord-0103');
    expect(back.status).toBe('acik');
    expect(back.extStage).toBe('new');
  });

  it('tanınmayan biçim (version 1 değil) okunmaz: çekim başarısız, hiçbir sipariş kapanmaz; alanı göndermeyen eski site okunur', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    // Site biçimi değiştirdi ve ord-0103 listede yok: eski kuralla okunsaydı "Siteden kalktı" kapanırdı
    site.orders = { complete: true, orders: siteOrdersFixture().orders.filter((o) => o.id !== 'ord-0103') };
    try {
      for (const v of [2, '1', null]) {
        site.ordersVersion = v;
        await expect(syncOnlineOrders()).rejects.toMatchObject({ status: 502, code: 'site_orders' });
        expect((await byExt('ord-0103')).status).toBe('acik');
      }
      const status = await h.ok<{ online: { state: { lastError?: string | null } } }>('patron', 'GET', '/sync/status');
      expect(status.online.state.lastError).toBe('Site siparişleri tanınmayan biçimde (sürüm null)');
      // Eski site alanı hiç göndermez: liste okunur, listede olmayan kapanır, hata temizlenir
      site.ordersVersion = undefined;
      expect((await syncOnlineOrders()).closed).toBe(1);
      expect((await byExt('ord-0103')).extStage).toBe('gone');
      const after = await h.ok<{ online: { state: { lastError?: string | null } } }>('patron', 'GET', '/sync/status');
      expect(after.online.state.lastError).toBeNull();
    } finally {
      site.ordersVersion = 1;
      site.orders = { complete: true, orders: siteOrdersFixture().orders };
      await syncOnlineOrders();
    }
    expect((await byExt('ord-0103')).status).toBe('acik');
  });
});

describe('aşama yazımı', () => {
  it('409: sipariş sitede değişmiş, liste yeniden çekilir', async () => {
    const before = pulls();
    site.stageStatus.push(409);
    const r = await h.call<{ code: string }>('kasa', 'POST', `/sync/online/${(await byExt('ord-0101')).id}/stage`, { action: 'preparing' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('stale');
    expect(pulls()).toBe(before + 1);
  });

  it('404: "Sipariş sitede bulunamadı", liste yeniden çekilir ve sipariş Siteden kalktı kapanır', async () => {
    const before = pulls();
    const pickup = await byExt('ord-0102');
    site.stageStatus.push(404);
    site.orders = { complete: true, orders: siteOrdersFixture().orders.filter((o) => o.id !== 'ord-0102') };
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/online/${pickup.id}/stage`, { action: 'ready' });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('site_not_found');
    expect(r.json.error).toBe('Sipariş sitede bulunamadı; liste yenilendi');
    expect(pulls()).toBe(before + 1);
    expect((await byExt('ord-0102')).extStage).toBe('gone');
    expect(site.stagePosts.at(-1)).toMatchObject({ id: 'ord-0102', action: 'ready', from: 'preparing' });
  });
});
