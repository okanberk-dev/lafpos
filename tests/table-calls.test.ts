import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import type { BootstrapDTO, FloorStateDTO } from '@shared/types';
import { type FakeSite, type PanelCallFixture, panelCall, startFakeSite } from './fake-site';
import { type Harness, PINS, startApp } from './harness';

/**
 * Masadan çağrılar (lafmobil "Garson çağır", su, peçete; docs/03-ENTEGRASYON.md §2.3 "Masa çağrıları"): sipariş
 * listesinin `calls` alanından gelir (yeni istek yok), masaya siparişlerin kuralıyla düşer (QR kodu, sonra etiket),
 * yeni çağrı cihazlarda çalar (yalnız masa ve sebep), "Gördüm" sitede yanıtlar, denetim kaydına yazar ve her yerden
 * düşürür. Hiç iş günü yokken liste yazılmaz, gün açılınca (ve yeniden açılınca) hemen çekilir. Bilgisayarın saati geri
 * giderse liste yine işlenir.
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

    // Günü açmak hemen bir çekim başlatır (zamanlayıcı açıkken; testler zamanlayıcıyı kapalı başlatır): çekimi turu
    // kimse elle çağırmadan, açma ucunun kancası yapar
    await withJobs(() => h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 }));
    await hookPulled(2);
    expect(await online()).toHaveLength(4);
    const after = await h.ok<{ online: { state: { lastError?: string | null } } }>('patron', 'GET', '/sync/status');
    expect(after.online.state.lastError).toBeNull();
    // Sürüm bu kez kaydedildi: sinyal aynıyken yeni çekim yok
    await orders.onlineOrdersTick();
    expect(pulls()).toBe(2);
  });

  it('gün yeniden açılınca sinyal değişmemiş olsa da bir kez çekilir', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    const day = await h.ok<{ day: { id: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(pulls()).toBe(2);
    await withJobs(() => h.ok('kasa', 'POST', `/cash/days/${day.day.id}/reopen`, { reason: 'Geç gelen müşteri', approverPin: PINS.mudur }));
    await hookPulled(3);
    // Tek çekim: sürüm aynı, sonraki tur yeniden çekmez
    await orders.onlineOrdersTick();
    expect(pulls()).toBe(3);
  });
});

/** Zamanlayıcı açıkken (gün açma kancası yalnız o zaman çeker; testler zamanlayıcıyı kapalı başlatır) */
async function withJobs<T>(fn: () => Promise<T>): Promise<T> {
  delete process.env.LAFPOS_NO_JOBS;
  try {
    return await fn();
  } finally {
    process.env.LAFPOS_NO_JOBS = '1';
  }
}

/** Kancanın çekimi bitti: siteye `n`. sipariş isteği gitti ve tur kapandı (testte tur elle çağrılmaz) */
async function hookPulled(n: number) {
  await vi.waitFor(
    async () => {
      expect(pulls()).toBe(n);
      const status = await h.ok<{ online: { state: { lastSuccessAt?: number } } }>('patron', 'GET', '/sync/status');
      expect(status.online.state.lastSuccessAt).toBeGreaterThanOrEqual(lastSuccess);
      lastSuccess = status.online.state.lastSuccessAt! + 1;
    },
    { timeout: 5000, interval: 20 },
  );
}
let lastSuccess = 0;

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

  it('bilgisayarın saati geri giderse (Windows saat eşitlemesi) liste yine işlenir; ağda gecikmiş eski liste yine yok sayılır', async () => {
    const { syncOnlineOrders, upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    const { parsePanelCalls } = await import('../server/sync/table-calls');
    const first = panelCall({ id: 'tcl-hhhhhhhhhhhhhhhh', reason: 'water' });
    site.tableCalls = [first];
    await syncOnlineOrders();
    expect((await alerts()).calls?.map((c) => c.id)).toEqual([first.id]);

    // Saat 10 dakika geri: saklanan an ileride kalır
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 10 * 60_000);
    try {
      const second = panelCall({ id: 'tcl-iiiiiiiiiiiiiiii', reason: 'napkin' });
      site.tableCalls = [second];
      const { events } = await capture(() => syncOnlineOrders());
      expect(events.filter((e) => e.kind === 'site.call.new').map((e) => e.message)).toEqual(['S4 · Peçete istiyor']);
      expect(events.filter((e) => e.kind === 'site.call.done')).toHaveLength(1);
      expect((await alerts()).calls?.map((c) => c.id)).toEqual([second.id]);

      // An geri alınan saate döndü: sonraki çekim de işlenir
      const third = panelCall({ id: 'tcl-jjjjjjjjjjjjjjjj', reason: 'waiter' });
      site.tableCalls = [second, third];
      const next = await capture(() => syncOnlineOrders());
      expect(next.events.filter((e) => e.kind === 'site.call.new').map((e) => e.message)).toEqual(['S4 · Garson çağırıyor']);
      expect((await alerts()).calls?.map((c) => c.id)).toEqual([second.id, third.id]);

      // Daha yeni listeden önce istenmiş (ağda gecikmiş) liste hâlâ yok sayılır
      const stale = await capture(async () => upsertOnlineOrders([], false, Date.now() - 30_000, parsePanelCalls([first])));
      expect(stale.events.some((e) => e.kind === 'site.call.new' || e.kind === 'site.call.done')).toBe(false);
      expect((await alerts()).calls?.map((c) => c.id)).toEqual([second.id, third.id]);
    } finally {
      clock.mockRestore();
    }
    site.tableCalls = [];
  });
});
