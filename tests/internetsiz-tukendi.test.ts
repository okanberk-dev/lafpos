import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { type AvailabilityResultDTO, availabilityNotice } from '@shared/tukendi';
import type { OrderDTO } from '@shared/types';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';
import { TUKENDI_KASA } from '@shared/eski-adlar';

/**
 * İnternet yokken kasada elle Tükendi / Satışa aç (server/sync/laffogato-orders.ts `setAvailability`,
 * docs/03-ENTEGRASYON.md §2.3 "İnternet yokken Tükendi"): siteye ulaşılamazsa (ağ hatası, zaman aşımı) değişiklik
 * kasada hemen geçerli, yazım sitenin giden kutusunda; internet gelince kayıt sırasıyla ve tam bir kez gider, aynı ürüne
 * arada gelen yeni değişiklik eskisinin yerini alır. Sitenin açık reddi (4xx) ve Tükendi kilidi (`soldOutBy`) bugünkü
 * gibi. Üst çubuktaki "İnternet yok · N kayıt bekliyor" bekleyeni sayar.
 */
const SECRET = 'i'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  // Dönüş eşitlemesi online sipariş ve karaoke çekimini de çalıştırır: bu dosya yalnız Satışta yazımlarına bakar
  site.orders = { complete: true, orders: [] };
  site.karaoke = [];
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
}, 60_000);
afterAll(async () => {
  // Dönüş eşitlemesinin 5 dakikalık bekleme sayacı kalmasın
  (await import('../server/sync/catch-up')).resetCatchUp();
  h?.cleanup();
  await site?.close();
});

async function product(extId: string) {
  const { db, schema } = await import('../server/db/client');
  const { and, eq } = await import('drizzle-orm');
  return db.select().from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, extId))).get()!;
}
/** Sitenin giden kutusunda bekleyen Satışta yazımları, kayıt sırasıyla */
async function pending() {
  const { db, schema } = await import('../server/db/client');
  const { and, asc, eq, isNull } = await import('drizzle-orm');
  return db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'laffogato'), eq(schema.outbox.kind, 'menu.isActive'), isNull(schema.outbox.sentAt)))
    .orderBy(asc(schema.outbox.id))
    .all();
}
const pendingOf = async (extId: string) => (await pending()).filter((r) => r.dedupeKey === `menu:${extId}`);
/** Siteye ulaşan Satışta yazımları (yanıt kodu ne olursa olsun) */
const postsOf = (...extIds: string[]) => site.menuPosts.filter((p) => extIds.includes(p.id)).map((p) => ({ id: p.id, isActive: p.isActive }));
const tap = (who: string, productId: string, active: boolean) => h.call<AvailabilityResultDTO & { code?: string }>(who, 'POST', `/sync/products/${productId}/availability`, { active });
async function audit(action: string) {
  return (await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50')).filter((a) => a.action === action).map((a) => a.message);
}
async function syncMenu() {
  const { runMenuSync } = await import('../server/sync/menu-sync');
  return runMenuSync({ apply: true, force: true });
}
/** Koşul tutana dek bekler (makine yüklüyken dönüş eşitlemesi birkaç saniye sürebilir) */
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; !(await cond()) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
}

describe('internet yokken elle Tükendi', () => {
  it('ağ hatası: Tükendi kasada hemen geçerli, yazım giden kutusunda; rozet sayar, biten ürün satılmaz', async () => {
    const { bus } = await import('../server/lib/events');
    const p = await product('mnu-0043');
    expect(p.active).toBe(true);
    const seen: LiveEvent[] = [];
    const listen = (e: LiveEvent) => seen.push(e);
    bus.on('event', listen);
    site.offline = true;
    try {
      const r = await tap('kasa', p.id, false);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ site: 'kuyrukta', neden: 'internet' });
    } finally {
      bus.off('event', listen);
    }
    // İstek denendi ama siteye ulaşmadı
    expect(site.dropped).toContain('POST /api/panel/menu');
    expect(postsOf('mnu-0043')).toEqual([]);
    const after = await product('mnu-0043');
    expect([after.active, after.soldOutBy]).toEqual([false, TUKENDI_KASA]);
    // Giden kutusunda tek kayıt, kimin bastığıyla
    const rows = await pendingOf('mnu-0043');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ id: 'mnu-0043', isActive: false, actor: 'Kasa' });
    expect(rows[0]!.sentAt).toBeNull();
    // Üst çubuk: "İnternet yok · 1 kayıt bekliyor"; kuyruğa giriş her cihazda rozeti hemen yeniler (`sync` olayı)
    expect(await h.ok<{ state: string; pending: number }>('garson', 'GET', '/sync/internet')).toMatchObject({ configured: true, state: 'yok', pending: 1 });
    expect(seen.some((e) => e.topic === 'sync' && e.kind === 'site.menu.queued')).toBe(true);
    expect(seen.some((e) => e.topic === 'menu' && e.kind === 'product.sold_out')).toBe(true);
    // Gönderim hemen tetiklenmez (site az önce yanıt vermedi)
    expect(seen.some((e) => e.topic === 'sync' && e.kind === 'availability.push')).toBe(false);
    // Biten ürün kasada satılmaz
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const add = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: p.id, qty: 1, ...(p.priceL != null ? { size: 'M' } : {}) }] });
    expect(add.status).toBe(409);
    expect(add.json.code).toBe('sold_out');
    expect(await audit('product.sold_out')).toContain('Kasa: Frappe tükendi (site: kuyrukta, internet yok)');
  });

  it('internetin olmadığı biliniyorken siteye hiç denenmez: dokunuş zaman aşımını beklemez', async () => {
    const p = await product('mnu-0044');
    const tried = site.dropped.length;
    const r = await tap('kasa', p.id, false);
    expect(r.json).toEqual({ site: 'kuyrukta', neden: 'internet' });
    expect(site.dropped).toHaveLength(tried);
    expect((await product('mnu-0044')).active).toBe(false);
    expect((await pendingOf('mnu-0044')).map((x) => x.payload)).toEqual([{ id: 'mnu-0044', isActive: false, actor: 'Kasa' }]);
    expect(await h.ok<{ pending: number }>('kasa', 'GET', '/sync/internet')).toMatchObject({ state: 'yok', pending: 2 });
  });

  it('zaman aşımı da internet yok sayılır', async () => {
    const net = await import('../server/lib/internet');
    // İnternet durumu henüz bilinmiyor (yeniden başlatılmış kasa): istek denenir, site 8 sn içinde yanıt vermez. fetch
    // zaman aşımında bu hatayla döner (AbortSignal.timeout); gerçek bekleme yerine aynısı verilir
    net.resetInternet();
    site.offline = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    try {
      const r = await tap('kasa', (await product('mnu-0047')).id, false);
      expect(r.json).toEqual({ site: 'kuyrukta', neden: 'internet' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toBe(`${site.url}/api/panel/menu`);
    } finally {
      spy.mockRestore();
    }
    expect(net.internetState().state).toBe('yok');
    expect((await product('mnu-0047')).active).toBe(false);
    expect((await pendingOf('mnu-0047')).map((x) => x.payload)).toEqual([{ id: 'mnu-0047', isActive: false, actor: 'Kasa' }]);
    expect(postsOf('mnu-0047')).toEqual([]);
  });

  it('art arda değişikliklerde yalnız sonuncusu bekler; internet gelince kayıt sırasıyla ve tam bir kez gider', async () => {
    site.offline = true;
    // Frappe (Tükendi bekliyordu) yeniden açılır: bekleyen Tükendi düşer, yerine Satışa aç girer
    const frappe = await product('mnu-0043');
    expect((await tap('kasa', frappe.id, true)).json).toEqual({ site: 'kuyrukta', neden: 'internet' });
    // Mocha Frappe üç kez değişir: yalnız sonuncusu (Tükendi) bekler
    const mocha = await product('mnu-0045');
    for (const active of [false, true, false]) expect((await tap('kasa', mocha.id, active)).json.site).toBe('kuyrukta');
    expect([(await product('mnu-0043')).active, (await product('mnu-0045')).active]).toEqual([true, false]);
    expect((await pending()).map((r) => r.payload)).toEqual([
      { id: 'mnu-0044', isActive: false, actor: 'Kasa' },
      { id: 'mnu-0047', isActive: false, actor: 'Kasa' },
      { id: 'mnu-0043', isActive: true, actor: 'Kasa' },
      { id: 'mnu-0045', isActive: false, actor: 'Kasa' },
    ]);
    expect(await h.ok<{ pending: number }>('kasa', 'GET', '/sync/internet')).toMatchObject({ state: 'yok', pending: 4 });
    // Hiçbiri siteye ulaşmadı
    expect(postsOf('mnu-0043', 'mnu-0044', 'mnu-0045', 'mnu-0047')).toEqual([]);

    // İnternet gelir: dakikalık TCP denemesi bağlanır, dönüş eşitlemesi giden kutusunu gönderir
    const cu = await import('../server/sync/catch-up');
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    for (const t of cu.startCatchUp()) clearInterval(t);
    site.offline = false;
    await cu.probeTick(async () => true);
    await until(async () => (await pending()).length === 0);
    expect(await pending()).toEqual([]);
    expect(site.menuPosts.filter((p) => ['mnu-0043', 'mnu-0044', 'mnu-0045', 'mnu-0047'].includes(p.id))).toEqual([
      { id: 'mnu-0044', isActive: false, actor: 'Kasa', branch: 'marina' },
      { id: 'mnu-0047', isActive: false, actor: 'Kasa', branch: 'marina' },
      { id: 'mnu-0043', isActive: true, actor: 'Kasa', branch: 'marina' },
      { id: 'mnu-0045', isActive: false, actor: 'Kasa', branch: 'marina' },
    ]);
    expect([site.panelActive.get('mnu-0043'), site.panelActive.get('mnu-0044'), site.panelActive.get('mnu-0045'), site.panelActive.get('mnu-0047')]).toEqual([true, false, false, false]);
    await until(async () => !!(await h.ok<{ sent: unknown }>('kasa', 'GET', '/sync/internet')).sent);
    expect(await h.ok('kasa', 'GET', '/sync/internet')).toMatchObject({ state: 'var', pending: 0, sent: { count: 4 } });

    // Aynı anda gelen dönüş eşitlemesi ve dakikalık turlar ikinci kez göndermez
    const before = site.menuPosts.length;
    await Promise.all([cu.catchUp(), flushSiteOutbox(), flushSiteOutbox()]);
    expect(site.menuPosts).toHaveLength(before);
    // Kasadaki durum değişmedi; eşitleme de değiştirmez
    await syncMenu();
    expect([(await product('mnu-0043')).active, (await product('mnu-0044')).active, (await product('mnu-0045')).active, (await product('mnu-0047')).active]).toEqual([true, false, false, false]);
  }, 60_000);

  it('siteye doğrudan yazılan değişiklik aynı ürünün bekleyenini iki yönde de düşürür; site 5xx\'te "site yanıt vermiyor"', async () => {
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    const mango = await product('mnu-0048');
    // İnternet var, site geçici olarak yanıt vermiyor (503): yine kasada hemen, neden "site"
    site.menuPostStatus.push(503);
    expect((await tap('kasa', mango.id, false)).json).toEqual({ site: 'kuyrukta', neden: 'site' });
    expect(await audit('product.sold_out')).toContain('Kasa: Mango tükendi (site: kuyrukta, site yanıt vermedi)');
    expect(await pendingOf('mnu-0048')).toHaveLength(1);
    // Satışa aç siteye doğrudan gider: bekleyen Tükendi düşer
    expect((await tap('kasa', mango.id, true)).json).toEqual({ site: 'guncellendi' });
    expect(await pendingOf('mnu-0048')).toEqual([]);
    // Ters yön: bekleyen Satışa aç, doğrudan giden Tükendi'yle düşer (gönderim anını beklemez, rozet saymaz)
    expect((await tap('kasa', mango.id, false)).json).toEqual({ site: 'guncellendi' });
    site.menuPostStatus.push(503);
    expect((await tap('kasa', mango.id, true)).json).toEqual({ site: 'kuyrukta', neden: 'site' });
    expect(await pendingOf('mnu-0048')).toHaveLength(1);
    expect((await tap('kasa', mango.id, false)).json).toEqual({ site: 'guncellendi' });
    expect(await pendingOf('mnu-0048')).toEqual([]);
    const posts = postsOf('mnu-0048').length;
    expect(await flushSiteOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(postsOf('mnu-0048')).toHaveLength(posts);
    expect(site.panelActive.get('mnu-0048')).toBe(false);
    expect((await product('mnu-0048')).active).toBe(false);
  });

  it('site açıkça reddederse (4xx) bugünkü gibi: 502, kasada da giden kutusunda da değişiklik yok', async () => {
    const cilek = await product('mnu-0051');
    for (const code of [400, 401, 403, 404, 409, 422]) {
      site.menuPostStatus.push(code);
      const r = await tap('kasa', cilek.id, false);
      expect(r.status).toBe(502);
      expect(r.json.code).toBe('site_menu');
      expect((await product('mnu-0051')).active).toBe(true);
      expect(await pendingOf('mnu-0051')).toEqual([]);
    }
    // Satışa aç yönünde de
    expect((await tap('kasa', cilek.id, false)).json).toEqual({ site: 'guncellendi' });
    site.menuPostStatus.push(409);
    const r = await tap('kasa', cilek.id, true);
    expect(r.status).toBe(502);
    const after = await product('mnu-0051');
    expect([after.active, after.soldOutBy]).toEqual([false, TUKENDI_KASA]);
    expect(await pendingOf('mnu-0051')).toEqual([]);
    expect((await audit('product.available')).some((m) => m.includes('Çilek'))).toBe(false);
  });

  it('Tükendi kilidi internetsiz de korunur: sitenin kapattığını kasiyer açamaz, menü yetkilisi açar ve kuyruktan gider', async () => {
    const { flushSiteOutbox } = await import('../server/sync/site-outbox');
    const frambuaz = await product('mnu-0052');
    site.panelActive.set('mnu-0052', false);
    await syncMenu();
    expect([(await product('mnu-0052')).active, (await product('mnu-0052')).soldOutBy]).toEqual([false, 'site']);

    site.offline = true;
    const tried = site.dropped.length;
    const denied = await tap('kasa', frambuaz.id, true);
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('site_closed');
    // Kilit siteye istekten önce: istek denenmez, kayıt girmez, ürün kapalı kalır
    expect(site.dropped).toHaveLength(tried);
    expect(await pendingOf('mnu-0052')).toEqual([]);
    expect([(await product('mnu-0052')).active, (await product('mnu-0052')).soldOutBy]).toEqual([false, 'site']);

    // Menü yetkilisi açar: istek denenir, internet yok, açış kuyruktan
    expect((await tap('mudur', frambuaz.id, true)).json).toEqual({ site: 'kuyrukta', neden: 'internet' });
    expect([(await product('mnu-0052')).active, (await product('mnu-0052')).soldOutBy]).toEqual([true, null]);
    expect(await audit('product.available')).toContain('Müdür: Frambuaz satışa açıldı (sitede kapatılmıştı) (site: kuyrukta, internet yok)');
    // Kasiyerin kendi Tükendi'si (`asilpos`) internetsiz de yine kasiyerce açılır; yalnız son durum bekler
    expect((await tap('kasa', frambuaz.id, false)).json.site).toBe('kuyrukta');
    expect((await product('mnu-0052')).soldOutBy).toBe(TUKENDI_KASA);
    expect((await tap('kasa', frambuaz.id, true)).json.site).toBe('kuyrukta');
    expect((await pendingOf('mnu-0052')).map((x) => x.payload)).toEqual([{ id: 'mnu-0052', isActive: true, actor: 'Kasa' }]);

    // İnternet gelir; yazım gitmeden eşitleme olursa sitenin eski "kapalı" görüntüsü ürünü yeniden kapatmaz
    site.offline = false;
    await syncMenu();
    expect([(await product('mnu-0052')).active, (await product('mnu-0052')).soldOutBy]).toEqual([true, null]);
    expect(await flushSiteOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(postsOf('mnu-0052')).toEqual([{ id: 'mnu-0052', isActive: true }]);
    expect(site.panelActive.get('mnu-0052')).toBe(true);
    await syncMenu();
    expect((await product('mnu-0052')).active).toBe(true);
    expect(await pendingOf('mnu-0052')).toEqual([]);
  });
});

describe('kasiyerin bildirimi', () => {
  it('internet yokken kısa uyarı; site 5xx\'te "internet yok" denmez; yönetimde anahtar ve bağlantı da söylenir', () => {
    expect(availabilityNotice('Americano', false, { site: 'kuyrukta', neden: 'internet' })).toEqual({
      tone: 'warn',
      text: 'Americano tükendi. İnternet yok: kasada uygulandı, site internet gelince güncellenecek',
    });
    expect(availabilityNotice('Americano', true, { site: 'kuyrukta', neden: 'internet' }).text).toBe('Americano satışa açıldı. İnternet yok: kasada uygulandı, site internet gelince güncellenecek');
    // Nedeni söylemeyen yanıt internet yok sayılır
    expect(availabilityNotice('Americano', false, { site: 'kuyrukta' }).text).toMatch(/İnternet yok: kasada uygulandı/);
    expect(availabilityNotice('Americano', false, { site: 'kuyrukta', neden: 'site' })).toEqual({
      tone: 'warn',
      text: 'Americano tükendi. Site şu an yanıt vermiyor: kasada uygulandı, site düzelince güncellenecek',
    });
    expect(availabilityNotice('Americano', false, { site: 'guncellendi' })).toEqual({ tone: 'ok', text: 'Americano tükendi; site ve uygulama da güncellendi' });
    expect(availabilityNotice('Tost', true, { site: 'bagli_degil' })).toEqual({ tone: 'ok', text: 'Tost satışa açıldı' });
    expect(availabilityNotice('Latte', false, { site: 'anahtar_yok' })).toEqual({ tone: 'ok', text: 'Latte tükendi' });
    expect(availabilityNotice('Latte', false, { site: 'anahtar_yok' }, { admin: true }).text).toBe('Latte tükendi; site anahtarı yok, yalnız AsilPOS');
    expect(availabilityNotice('Latte', false, { site: 'baglanti_yok' }, { admin: true }).text).toBe('Latte tükendi; site bağlantısı kurulmadı, yalnız AsilPOS');
  });
});
