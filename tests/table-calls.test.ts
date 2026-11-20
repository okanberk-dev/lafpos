import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import type { BootstrapDTO, FloorStateDTO } from '@shared/types';
import { type FakeSite, type PanelCallFixture, panelCall, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Masadan çağrılar (lafmobil "Garson çağır", su, peçete; docs/03-ENTEGRASYON.md §2.3 "Masa çağrıları"): sipariş
 * listesinin `calls` alanından gelir (yeni istek yok), masaya siparişlerin kuralıyla düşer (QR kodu, sonra etiket),
 * yeni çağrı cihazlarda çalar (yalnız masa ve sebep), "Gördüm" sitede yanıtlar, denetim kaydına yazar ve her yerden
 * düşürür. Hiç iş günü yokken liste yazılmaz, gün açılınca hemen çekilir.
 */
const SECRET = 'c'.repeat(48);
let h: Harness;
let site: FakeSite;
let boot: BootstrapDTO;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
  await h.ok('patron', 'POST', '/admin/users', { name: 'Kurye Ali', role: 'kurye', pin: '6161' });
  await h.login('bar', '3333');
  await h.login('kurye', '6161');
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

const table = (name: string) => boot.tables.find((t) => t.name === name)!;
const pulls = () => site.count('GET /api/panel/orders');
const alerts = (who = 'garson') => h.ok<SiteAlertsDTO>(who, 'GET', '/sync/alerts');

async function online() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.orders).where(eq(schema.orders.source, 'laffogato')).all();
}

/** Fonksiyon süresince yayılan canlı olaylar */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; events: LiveEvent[] }> {
  const { bus } = await import('../server/lib/events');
  const events: LiveEvent[] = [];
  const listen = (e: LiveEvent) => events.push(e);
  bus.on('event', listen);
  try {
    return { result: await fn(), events };
  } finally {
    bus.off('event', listen);
  }
}

describe('hiç iş günü yokken', () => {
  it('liste yazılmaz, durum "Gün açılmadı" der, sürüm kaydedilmez; zamanlayıcı istek atmaz; gün açılınca hemen çekilir', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    orders.resetOnlineTimer();
    const r = await orders.syncOnlineOrders();
    expect(r.waiting).toBe(true);
    expect(await online()).toHaveLength(0);
    const status = await h.ok<{ online: { state: { lastError?: string | null; lastSuccessAt?: number } } }>('patron', 'GET', '/sync/status');
    expect(status.online.state.lastError).toBe('Gün açılmadı; online siparişler gün açılınca alınır');
    expect(status.online.state.lastSuccessAt).toBeUndefined();

    // Zamanlayıcı: sipariş yazılacak gün yok, siteye hiç istek gitmez (sinyal de)
    const before = site.calls.length;
    await orders.onlineOrdersTick();
    expect(site.calls.length).toBe(before);

    // Günü açmak hemen bir çekim başlatır (zamanlayıcı açıkken; testler zamanlayıcıyı kapalı başlatır)
    delete process.env.LAFPOS_NO_JOBS;
    try {
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      await orders.onlineOrdersTick();
    } finally {
      process.env.LAFPOS_NO_JOBS = '1';
    }
    expect(pulls()).toBe(2);
    expect(await online()).toHaveLength(4);
    const after = await h.ok<{ online: { state: { lastError?: string | null } } }>('patron', 'GET', '/sync/status');
    expect(after.online.state.lastError).toBeNull();
    // Sürüm bu kez kaydedildi: sinyal aynıyken yeni çekim yok
    await orders.onlineOrdersTick();
    expect(pulls()).toBe(2);
  });
});

const water = panelCall({ id: 'tcl-aaaaaaaaaaaaaaaa', label: 'Masa S4', reason: 'water', createdAt: new Date(Date.now() - 3 * 60_000).toISOString() });
const waiter = panelCall({ id: 'tcl-bbbbbbbbbbbbbbbb', tableCode: 'b9b9-b9b9b9', label: 'Masa 99', reason: 'waiter', createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
const unknown = panelCall({ id: 'tcl-cccccccccccccccc', label: 'Masa 77', reason: 'bill', createdAt: new Date(Date.now() - 60_000).toISOString() });

describe('masa çağrıları', () => {
  it('listeyle gelir: masaya QR koduyla ya da etiketle düşer, yeni çağrı yalnız masa ve sebeple çalar, okunamayan satır atlanır', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.tables).set({ qrCode: 'B9B9B9B9B9' }).where(eq(schema.tables.id, table('B9').id)).run();
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    site.tableCalls = [
      water,
      waiter,
      unknown,
      { id: 5, label: 'Masa 1', reason: 'water', createdAt: new Date().toISOString() } as unknown as PanelCallFixture,
      panelCall({ id: 'tcl-dddddddddddddddd', createdAt: 'yok' }),
      panelCall({ id: 'kötü kimlik' }),
      panelCall({ id: 'tcl-eeeeeeeeeeeeeeee', label: '' }),
    ];
    const { events } = await capture(() => syncOnlineOrders());
    const rang = events.filter((e) => e.kind === 'site.call.new');
    expect(rang.map((e) => [e.topic, e.message, e.tableId ?? null])).toEqual([
      ['tables', 'S4 · Su istiyor', table('S4').id],
      ['tables', 'B9 · Garson çağırıyor', table('B9').id],
      ['tables', 'Masa 77 · Çağırıyor', null],
    ]);

    const before = site.calls.length;
    const a = await alerts();
    expect(site.calls.length).toBe(before);
    expect(a.calls?.map((c) => [c.id, c.label, c.reason, c.tableId])).toEqual([
      [water.id, 'S4', 'water', table('S4').id],
      [waiter.id, 'B9', 'waiter', table('B9').id],
      [unknown.id, 'Masa 77', 'bill', null],
    ]);
    // Misafirin adı, siparişin notu ve kalemi hiçbir yerde
    expect(JSON.stringify(a.calls)).not.toMatch(/Ayşe|Zeynep|Can|Fındık|Latte/);
    const floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.siteCalls?.map((c) => c.id)).toEqual([water.id, waiter.id, unknown.id]);

    // Aynı liste yeniden: çalmaz
    const again = await capture(() => syncOnlineOrders());
    expect(again.events.some((e) => e.kind === 'site.call.new' || e.kind === 'site.call.done')).toBe(false);
  });

  it('yetki: siparişi alan ve bar ekranı görür, kurye göremez ve yanıtlayamaz', async () => {
    expect((await alerts('bar')).calls).toHaveLength(3);
    expect((await h.call('kurye', 'GET', '/sync/alerts')).status).toBe(403);
    const r = await h.call('kurye', 'POST', `/sync/calls/${water.id}/ack`);
    expect(r.status).toBe(403);
    expect(site.callAcks).toHaveLength(0);
  });

  it('sitede yanıtlanan (listeden düşen) çağrı her yerden düşer', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    site.tableCalls = [water, waiter];
    const { events } = await capture(() => syncOnlineOrders());
    expect(events.filter((e) => e.kind === 'site.call.done').map((e) => [e.topic, e.tableId ?? null])).toEqual([['tables', null]]);
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([water.id, waiter.id]);
  });

  it('Gördüm: siteye imzalı yanıt (id ve ad), denetim kaydı, bütün cihazlardan düşer; eski liste geri getirmez', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    const { events, result } = await capture(() => h.ok<{ ok: boolean }>('garson', 'POST', `/sync/calls/${water.id}/ack`));
    expect(result).toEqual({ ok: true });
    expect(site.callAcks).toEqual([{ id: water.id, actor: 'Garson' }]);
    expect(events.filter((e) => e.kind === 'site.call.done').map((e) => [e.topic, e.tableId])).toEqual([['tables', table('S4').id]]);
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([waiter.id]);
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.find((x) => x.action === 'table.call_ack')?.message).toBe('Garson: masa çağrısını gördü (S4 · Su istiyor)');

    // Yanıttan önce istenmiş bir liste (yanıt ağdayken) çağrıyı yeniden getirmez, çaldırmaz
    site.tableCalls = [water, waiter];
    const stale = await capture(() => syncOnlineOrders());
    expect(stale.events.some((e) => e.kind === 'site.call.new')).toBe(false);
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([waiter.id]);

    // Başka cihazdan ikinci "Gördüm": siteye gitmeden tamam
    expect(await h.ok('bar', 'POST', `/sync/calls/${water.id}/ack`)).toEqual({ ok: true, already: true });
    expect(site.callAcks).toHaveLength(1);
    // Bilinmeyen çağrı
    expect((await h.call('garson', 'POST', '/sync/calls/tcl-zzzzzzzzzzzzzzzz/ack')).status).toBe(404);
  });

  it('siteye ulaşılamazsa 502, çağrı açık kalır; site "bulunamadı" derse yerelde düşer', async () => {
    site.callAckStatus.push(503);
    const r = await h.call<{ code: string }>('bar', 'POST', `/sync/calls/${waiter.id}/ack`);
    expect(r.status).toBe(502);
    expect(r.json.code).toBe('site_call');
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([waiter.id]);

    site.callAckStatus.push(404);
    expect(await h.ok('bar', 'POST', `/sync/calls/${waiter.id}/ack`)).toEqual({ ok: true });
    expect(site.callAcks.at(-1)).toEqual({ id: waiter.id, actor: 'Bar ekranı' });
    expect((await alerts()).calls).toEqual([]);
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.find((x) => x.action === 'table.call_ack' && x.message.includes('B9'))?.message).toBe('Bar ekranı: masa çağrısını gördü (B9 · Garson çağırıyor); çağrı sitede yoktu');
  });

  it('15 dakikası dolan çağrı liste yenilenmeden düşer ve çalmaz; alanı göndermeyen eski site eldeki listeyi bozmaz', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    const old = panelCall({ id: 'tcl-ffffffffffffffff', createdAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    const fresh = panelCall({ id: 'tcl-gggggggggggggggg', reason: 'napkin' });
    site.tableCalls = [old, fresh];
    const { events } = await capture(() => syncOnlineOrders());
    expect(events.filter((e) => e.kind === 'site.call.new').map((e) => e.message)).toEqual(['S4 · Peçete istiyor']);
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([fresh.id]);
    site.tableCalls = null;
    const legacy = await capture(() => syncOnlineOrders());
    expect(legacy.events.some((e) => e.kind === 'site.call.done')).toBe(false);
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([fresh.id]);
    site.tableCalls = [];
  });
});
