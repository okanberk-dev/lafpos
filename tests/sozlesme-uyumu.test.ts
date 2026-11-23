import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { netMarginPct, netOfKdv } from '@shared/money';
import type { LiveEvent } from '@shared/events';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { type FakeSite, type PanelOrderFixture, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Sistemler arası sözleşme uyumu (docs/03-ENTEGRASYON.md): site şubelidir, LafPOS kendi şubesi adına okur ve yazar,
 * başka şubenin listesini ve kaydını yazmaz; kasada ödenen site siparişi bara düşmez ve "sitede ödendi" sayılmaz;
 * sitede iptal edilen kalem LafPOS'ta da iptal olur; CDN'deki bayat liste fiyatı geri bırakmaz; menü işareti bütçeli
 * (gece yok, en sık 60 sn); marj KDV hariç; platform ücreti hizmet satırı; eklerin maliyeti brüt kâra girer.
 */
const SECRET = 's'.repeat(48);
let h: Harness;
let site: FakeSite;
let lafmaliyet: Server;
const lmPosts: { date?: string; sube?: string }[] = [];

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  lafmaliyet = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/pos/gun') lmPosts.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/pos/gun' ? { ok: true, date: JSON.parse(raw).date, lines: 0, matched: 0, unmatched: [], counted: true, switchDay: null } : { version: 1, now: new Date().toISOString(), items: [] }));
    });
  });
  await new Promise<void>((r) => lafmaliyet.listen(0, '127.0.0.1', r));
  h = await startApp({
    LAFFOGATO_URL: site.url,
    LAFFOGATO_SYNC_SECRET: SECRET,
    LAFMALIYET_URL: `http://127.0.0.1:${(lafmaliyet.address() as AddressInfo).port}`,
    LAFMALIYET_SYNC_SECRET: 'l'.repeat(48),
  });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
  lafmaliyet.close();
});

async function mod() {
  const client = await import('../server/db/client');
  const { eq, and } = await import('drizzle-orm');
  const orders = await import('../server/sync/laffogato-orders');
  const settings = await import('../server/lib/settings');
  const { bus } = await import('../server/lib/events');
  return { ...client, eq, and, orders, settings, bus };
}

/** Sitenin `toPanelOrder` biçiminde bir sipariş (ödenmiş, masa değil) */
const panelOrder = (id: string, no: number, lines: PanelOrderFixture['lines'], extra: Partial<PanelOrderFixture> = {}) =>
  ({
    id,
    orderNo: no,
    stage: 'new',
    fulfillment: 'pickup',
    label: 'Gel-al',
    firstName: 'Ayşe',
    scheduledFor: '',
    note: '',
    paidAt: new Date().toISOString(),
    lines,
    totalMinor: 45000,
    ...extra,
  }) as PanelOrderFixture;
const line = (menuItemId: string, name: string, index?: number, qty = 1) => ({ menuItemId, name, size: 'M' as const, detail: 'M', note: '', qty, ...(index === undefined ? {} : { index }) });

async function onlineRow(extId: string) {
  const { db, schema, eq, and } = await mod();
  return db.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.extId, extId))).get();
}
async function itemsOf(orderId: string) {
  const { db, schema, eq } = await mod();
  return db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).all();
}
async function audits(action: string) {
  const { db, schema, eq } = await mod();
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).all();
}
function collect(bus: { on: (e: 'event', f: (e: LiveEvent) => void) => void; off: (e: 'event', f: (e: LiveEvent) => void) => void }) {
  const events: LiveEvent[] = [];
  const on = (e: LiveEvent) => events.push(e);
  bus.on('event', on);
  return { events, stop: () => bus.off('event', on) };
}

describe('şube: site şubeli (laffogato #279), LafPOS kendi şubesi adına okur ve yazar', () => {
  it('istekler kasanın şubesini söyler; başka şubenin listesi yazılmaz, eski site bugünkü gibi', async () => {
    const { orders } = await mod();
    site.answerBranch = null;
    site.orders.orders = [panelOrder('ord-b1', 9001, [line('mnu-0003', 'Latte')])];
    await orders.syncOnlineOrders();
    expect(site.queries.filter((q) => q.startsWith('GET /api/panel/orders')).at(-1)).toBe('GET /api/panel/orders?branch=marina');
    expect(await onlineRow('ord-b1')).toBeDefined();

    // Site başka şubenin listesini verdi: hiçbir şey yazılmaz, açık sipariş kapanmaz
    site.answerBranch = 'tuzla';
    site.orders.orders = [panelOrder('ord-b2', 9002, [line('mnu-0003', 'Latte')])];
    await expect(orders.syncOnlineOrders()).rejects.toMatchObject({ code: 'site_branch' });
    expect(await onlineRow('ord-b2')).toBeUndefined();
    expect((await onlineRow('ord-b1'))?.status).toBe('acik');

    // Alanı göndermeyen eski site: liste okunur
    site.answerBranch = undefined;
    await orders.syncOnlineOrders();
    expect(await onlineRow('ord-b2')).toBeDefined();
    site.orders.orders = [];
    await orders.syncOnlineOrders();
  });

  it('sürüm sinyali de kasanın şubesini söyler (laffogato #298: işaret şubenin)', async () => {
    const { orders } = await mod();
    const before = site.queries.length;
    orders.resetOnlineTimer();
    await orders.onlineOrdersTick();
    expect(site.queries.slice(before).filter((q) => q.startsWith('GET /api/pos/orders/version'))).toContain('GET /api/pos/orders/version?branch=marina');
  });

  it('başka şubenin siparişi (409 wrong_branch) yeniden denenmez, ekrandan kalkar ve toplama girmez', async () => {
    const { orders } = await mod();
    orders.upsertOnlineOrders([panelOrder('ord-k1', 9003, [line('mnu-0003', 'Latte')], { totalMinor: 20000 })] as never);
    const online = async () => (await h.ok<{ summary: { onlineTotal: number } }>('mudur', 'GET', '/cash/day')).summary.onlineTotal;
    const before = await online();
    const k1 = (await onlineRow('ord-k1'))!;
    site.conflictError = 'wrong_branch';
    site.stageStatus = [409];
    const stage = await h.call<{ code: string }>('kasa', 'POST', `/sync/online/${k1.id}/stage`, { action: 'preparing' });
    site.conflictError = 'stale';
    expect(stage.status).toBe(409);
    expect(stage.json.code).toBe('wrong_branch');
    expect(site.stagePosts.at(-1)).toMatchObject({ id: 'ord-k1', branch: 'marina' });
    expect(await onlineRow('ord-k1')).toMatchObject({ status: 'kapali', extOutcome: 'other' });
    expect(await online()).toBe(before - 20000);
    expect((await audits('online.gone')).at(-1)?.message).toMatch(/#9003 başka şubenin/);
  });

  it('başka şubenin çağrısı (409 wrong_branch) kartı düşürür; Tükendi ve panel menüsü şube adına', async () => {
    const { orders } = await mod();
    const { panelCall } = await import('./fake-site');
    site.tableCalls = [panelCall({ id: 'call-b1' })];
    await orders.syncOnlineOrders();
    site.conflictError = 'wrong_branch';
    site.callAckStatus = [409];
    const ack = await h.call('kasa', 'POST', '/sync/calls/call-b1/ack');
    site.conflictError = 'stale';
    expect(ack.status).toBe(200);
    expect(site.callAcks.at(-1)).toMatchObject({ id: 'call-b1' });
    expect((await h.ok<{ calls: unknown[] }>('kasa', 'GET', '/sync/alerts')).calls).toEqual([]);
    site.tableCalls = [];

    // Tükendi yazımı gövdede şubeyle
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const latte = boot.products.find((p) => p.name === 'Latte')!;
    await h.ok('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: false });
    expect(site.menuPosts.at(-1)).toMatchObject({ id: latte.extId, isActive: false, branch: 'marina' });
    await h.ok('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: true });

    // Panel menüsü şube adına okunur; başka şubenin Satışta'sı yazılmaz (fiyat ve ürünler yine uygulanır)
    const sync = await import('../server/sync/menu-sync');
    site.answerBranch = 'tuzla';
    const r = await sync.runMenuSync({ apply: true, force: true });
    site.answerBranch = undefined;
    expect(site.queries.filter((q) => q.startsWith('GET /api/panel/menu')).at(-1)).toBe('GET /api/panel/menu?branch=marina');
    expect(r.warning).toMatch(/başka şubenin \(tuzla\)/);
  });
});

describe('kasada ödenen site siparişi (paidAtTill)', () => {
  it('yazılmaz, bara düşmez, toplama girmez; bir kez uyarı ve denetim kaydı', async () => {
    const { orders, bus } = await mod();
    const ev = collect(bus);
    try {
      const till = panelOrder('ord-till', 9101, [line('mnu-0003', 'Latte')], { paidAtTill: true });
      orders.upsertOnlineOrders([till] as never);
      expect(await onlineRow('ord-till')).toBeUndefined();
      expect(ev.events.filter((e) => e.kind === 'ticket.new')).toHaveLength(0);
      expect(ev.events.find((e) => e.kind === 'online.till')?.message).toBe('Online sipariş #9101 kasada ödendi; adisyon olarak çalın');
      // İkinci çekim: yeni kayıt ya da uyarı yok
      orders.upsertOnlineOrders([till] as never);
      expect(await audits('online.paid_at_till')).toHaveLength(1);
      expect(ev.events.filter((e) => e.kind === 'online.till')).toHaveLength(1);
      // Alanı göndermeyen (eski) site: bugünkü gibi "sitede ödendi"
      orders.upsertOnlineOrders([till, panelOrder('ord-old', 9102, [line('mnu-0003', 'Latte')])] as never);
      expect((await onlineRow('ord-old'))?.extPaid).toBe(true);
    } finally {
      ev.stop();
    }
  });

  it('önceden "sitede ödendi" yazılmış sipariş kasada ödendi olunca kapanır, kalemleri iptal, Z toplamından düşer', async () => {
    const { orders } = await mod();
    const o = panelOrder('ord-flip', 9103, [line('mnu-0003', 'Latte')], { totalMinor: 30000 });
    orders.upsertOnlineOrders([o] as never);
    const online = async () => (await h.ok<{ summary: { onlineTotal: number } }>('mudur', 'GET', '/cash/day')).summary.onlineTotal;
    const before = await online();
    orders.upsertOnlineOrders([{ ...o, paidAtTill: true }] as never);
    const row = (await onlineRow('ord-flip'))!;
    expect(row).toMatchObject({ status: 'kapali', extOutcome: 'till' });
    expect((await itemsOf(row.id)).every((i) => i.voided && i.voidAfterSend)).toBe(true);
    expect(await online()).toBe(before - 30000);
  });
});

describe('kalem iptali: sitede iptal edilen satır LafPOS bar ekranında kalmaz', () => {
  it('konumla (index): iptal edilen kalem iptal, geri alınan geri gelir; tutar değişmez', async () => {
    const { orders } = await mod();
    const lines = [line('mnu-0003', 'Latte', 0, 2), line('mnu-0011', 'Cheesecake', 1)];
    orders.upsertOnlineOrders([panelOrder('ord-line', 9201, lines)] as never);
    const row = (await onlineRow('ord-line'))!;
    expect((await itemsOf(row.id)).map((i) => i.extLine)).toEqual([0, 1]);
    // Sitede cheesecake iptal: listeden çıkar, konumu değişmez
    orders.upsertOnlineOrders([panelOrder('ord-line', 9201, [lines[0]])] as never);
    let items = await itemsOf(row.id);
    expect(items.find((i) => i.extLine === 1)).toMatchObject({ voided: true, voidReason: 'Sitede iptal edildi', voidAfterSend: true });
    expect(items.find((i) => i.extLine === 0)?.voided).toBe(false);
    expect((await audits('online.line_cancelled')).map((a) => a.message)).toEqual(['Online sipariş #9201: 1× Cheesecake sitede iptal edildi']);
    // Bar ekranı iptali görür (10 dk), kalem hazırlanacaklar arasında değil
    const tickets = await h.ok<{ orderId: string; items: { name: string; voided: boolean }[] }[]>('patron', 'GET', '/kitchen');
    expect(tickets.find((t) => t.orderId === row.id)?.items.find((i) => i.name === 'Cheesecake')?.voided).toBe(true);
    // Sitede iptal geri alındı ("Bekliyor"): kalem geri gelir
    orders.upsertOnlineOrders([panelOrder('ord-line', 9201, lines)] as never);
    items = await itemsOf(row.id);
    expect(items).toHaveLength(2);
    expect(items.every((i) => !i.voided)).toBe(true);
    expect(await audits('online.line_restored')).toHaveLength(1);
    expect((await onlineRow('ord-line'))?.extTotal).toBe(45000);
  });

  it('konum gelmeyen (eski) site: içerikle sayarak; aynı iki satırdan biri iptal edilince biri kalır', async () => {
    const { orders } = await mod();
    const lines = [line('mnu-0003', 'Latte'), line('mnu-0003', 'Latte'), line('mnu-0011', 'Cheesecake')];
    orders.upsertOnlineOrders([panelOrder('ord-old-line', 9202, lines)] as never);
    const row = (await onlineRow('ord-old-line'))!;
    orders.upsertOnlineOrders([panelOrder('ord-old-line', 9202, [lines[0], lines[2]])] as never);
    const items = await itemsOf(row.id);
    expect(items.filter((i) => i.name === 'Latte' && !i.voided)).toHaveLength(1);
    expect(items.filter((i) => i.name === 'Cheesecake' && !i.voided)).toHaveLength(1);
  });

  it('konumu yazılmamış eski kalem, site konum göndermeye başlayınca içerikle eşlenir; yalnız iptal edilen düşer', async () => {
    const { orders } = await mod();
    orders.upsertOnlineOrders([panelOrder('ord-mig', 9203, [line('mnu-0003', 'Latte'), line('mnu-0011', 'Cheesecake')])] as never);
    const row = (await onlineRow('ord-mig'))!;
    expect((await itemsOf(row.id)).map((i) => i.extLine)).toEqual([null, null]);
    orders.upsertOnlineOrders([panelOrder('ord-mig', 9203, [line('mnu-0011', 'Cheesecake', 1)])] as never);
    const items = await itemsOf(row.id);
    expect(items.find((i) => i.name === 'Cheesecake')).toMatchObject({ voided: false, extLine: 1 });
    expect(items.find((i) => i.name === 'Latte')?.voided).toBe(true);
  });

  it('konum ilk gelince aynı içerikli iki kalemden iptal edilen değil canlı olan sitenin satırını alır', async () => {
    const { orders, db, schema, eq } = await mod();
    orders.upsertOnlineOrders([panelOrder('ord-twin', 9204, [line('mnu-0003', 'Latte'), line('mnu-0003', 'Latte')])] as never);
    const row = (await onlineRow('ord-twin'))!;
    const [first] = (await itemsOf(row.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    // Kalemlerden biri kasada iptal edildi (konum gelmeden önce); sitede iki satır da duruyor
    db.update(schema.orderItems).set({ voided: true, voidReason: 'Kasada iptal' }).where(eq(schema.orderItems.id, first!.id)).run();
    // Site konum göndermeye başladı ve bu arada satırlardan birini (konum 0) kendisi iptal etti: kalan tek satır konum 1
    orders.upsertOnlineOrders([panelOrder('ord-twin', 9204, [line('mnu-0003', 'Latte', 1)])] as never);
    const items = await itemsOf(row.id);
    // Sitenin canlı satırı kasada da canlı kalır (eski kodda iptal edilen kalem konumu alıyor, canlı ikizi "sitede iptal
    // edildi" sayılıyordu: hiç canlı kalem kalmıyordu)
    const live = items.filter((i) => !i.voided);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ extLine: 1 });
  });

  it('sitede iptal edilmiş eski ikiz, kasada iptal edilenden sonra eşlenir: sitenin canlı satırıyla geri açılmaz', async () => {
    const { orders, db, schema, eq } = await mod();
    orders.upsertOnlineOrders([panelOrder('ord-twin3', 9205, [line('mnu-0003', 'Latte'), line('mnu-0003', 'Latte'), line('mnu-0003', 'Latte')])] as never);
    const row = (await onlineRow('ord-twin3'))!;
    const [a, b] = (await itemsOf(row.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
    // En eski ikiz sitede iptal edildi (konum gelmeden önce), ikincisi kasada; sitede iki satır canlı (konum 1 ve 2)
    db.update(schema.orderItems).set({ voided: true, voidReason: orders.SITE_LINE_VOID, voidBy: 'Site' }).where(eq(schema.orderItems.id, a!.id)).run();
    db.update(schema.orderItems).set({ voided: true, voidReason: 'Kasada iptal' }).where(eq(schema.orderItems.id, b!.id)).run();
    orders.upsertOnlineOrders([panelOrder('ord-twin3', 9205, [line('mnu-0003', 'Latte', 1), line('mnu-0003', 'Latte', 2)])] as never);
    const items = await itemsOf(row.id);
    // Sitede iptal edilen geri gelmez; sitenin ikinci canlı satırını kasada iptal edilen alır, iptali kasanındır
    expect(items.find((i) => i.id === a!.id)).toMatchObject({ voided: true, voidReason: orders.SITE_LINE_VOID });
    expect(items.find((i) => i.id === b!.id)).toMatchObject({ voided: true, extLine: 2 });
    expect(items.filter((i) => !i.voided)).toHaveLength(1);
  });
});

describe('kapanış sonucu (closed): iptal ve iade online toplamına girmez', () => {
  it('listeden kalkan iptal edilmiş sipariş sayılmaz; kesik listede de kapanır; sonradan gelen sonuç yazılır', async () => {
    const { orders } = await mod();
    const online = async () => (await h.ok<{ summary: { onlineTotal: number; onlineOrders: number } }>('mudur', 'GET', '/cash/day')).summary;
    const a = panelOrder('ord-c1', 9301, [line('mnu-0003', 'Latte')], { totalMinor: 45000 });
    const b = panelOrder('ord-c2', 9302, [line('mnu-0003', 'Latte')], { totalMinor: 20000 });
    orders.upsertOnlineOrders([a, b] as never);
    const before = await online();
    // Kesik liste (complete: false): yalnız sitenin kapandığını söylediği kapanır
    orders.upsertOnlineOrders([b] as never, false, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c1', outcome: 'cancelled' }]);
    expect(await onlineRow('ord-c1')).toMatchObject({ status: 'kapali', extStage: 'gone', extOutcome: 'cancelled' });
    expect((await onlineRow('ord-c2'))?.status).toBe('acik');
    expect((await online()).onlineTotal).toBe(before.onlineTotal - 45000);
    // Sonucu bilinmeden kapanan sipariş: sonraki listenin `closed`'ı iade der
    orders.upsertOnlineOrders([] as never);
    expect((await onlineRow('ord-c2'))?.extOutcome).toBeNull();
    orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c2', outcome: 'refunded' }]);
    expect((await onlineRow('ord-c2'))?.extOutcome).toBe('refunded');
    expect((await online()).onlineTotal).toBe(before.onlineTotal - 65000);
    expect((await audits('online.gone')).some((x) => x.message.includes('#9301 siteden kalktı (sitede iptal edildi)'))).toBe(true);
  });

  it('teslimden sonra sitede iade ya da iptal edilen sipariş online toplamdan düşer, denetim kaydına yazılır; tamamlandı geri yazılmaz', async () => {
    const { orders, bus } = await mod();
    const online = async () => (await h.ok<{ summary: { onlineTotal: number } }>('mudur', 'GET', '/cash/day')).summary;
    orders.upsertOnlineOrders([panelOrder('ord-c3', 9303, [line('mnu-0003', 'Latte')], { totalMinor: 30000 })] as never);
    const before = await online();
    orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c3', outcome: 'completed' }]);
    expect((await onlineRow('ord-c3'))?.extOutcome).toBe('completed');
    expect((await online()).onlineTotal).toBe(before.onlineTotal);
    const ev = collect(bus);
    try {
      orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c3', outcome: 'refunded' }]);
      // Kasa ekranının X'i ve patron özeti yeniden okunur (tables/online.sync yalnız masa planını yeniler)
      expect(ev.events.filter((e) => e.topic === 'cash' && e.kind === 'online.outcome')).toHaveLength(1);
    } finally {
      ev.stop();
    }
    expect((await onlineRow('ord-c3'))?.extOutcome).toBe('refunded');
    expect((await online()).onlineTotal).toBe(before.onlineTotal - 30000);
    // Gün açık: X değişir; tutar kayıtta
    const rec = (await audits('online.outcome')).find((x) => x.message.includes('#9303 sitede iade edildi'));
    expect(rec?.message).toBe('Online sipariş #9303 sitede iade edildi; online toplamdan düştü');
    expect(rec?.amount).toBe(30000);
    // Eski bir liste "tamamlandı" dese de iade geri alınmaz
    orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c3', outcome: 'completed' }]);
    expect((await onlineRow('ord-c3'))?.extOutcome).toBe('refunded');
  });

  it("kapanmış günün siparişi sonradan iade edilirse kayıt Z'nin değişmediğini söyler", async () => {
    const { orders, db, schema, eq } = await mod();
    orders.upsertOnlineOrders([panelOrder('ord-c4', 9304, [line('mnu-0003', 'Latte')], { totalMinor: 12000 })] as never);
    orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c4', outcome: 'completed' }]);
    // Siparişin günü kapanmış (Z'si dondurulmuş) bir gün olsun
    const at = Date.now() - 86_400_000;
    db.insert(schema.businessDays).values({ id: 'day-eski-c4', date: '2026-11-01', zNo: 9001, openedAt: at, openingCash: 0, closedAt: at + 3_600_000 }).run();
    db.update(schema.orders).set({ dayId: 'day-eski-c4' }).where(eq(schema.orders.extId, 'ord-c4')).run();
    orders.upsertOnlineOrders([] as never, true, Number.POSITIVE_INFINITY, null, [{ id: 'ord-c4', outcome: 'cancelled' }]);
    const rec = (await audits('online.outcome')).find((x) => x.message.includes('#9304'));
    expect(rec?.message).toBe("Online sipariş #9304 sitede iptal edildi; Raporlar'daki online toplamdan düştü, kapanmış günün Z'si değişmez");
    expect(rec?.amount).toBe(12000);
  });

  it('`closed` okunamayan satırı atlar; alanı göndermeyen site null', async () => {
    const { orders } = await mod();
    expect(orders.parsePanelClosed(undefined)).toBeNull();
    expect(orders.parsePanelClosed([{ id: 'a', outcome: 'cancelled' }, { id: 'b', outcome: 'x' }, { outcome: 'completed' }, null])).toEqual([{ id: 'a', outcome: 'cancelled' }]);
  });
});

describe('menü: CDN bayatken yeniden açılan ürün eski fiyattan satılmaz', () => {
  it('listede olmayan ürün panelden fiyat alır, eşitleme CDN bayatlığını söyler; ETag listenin kendisininki', async () => {
    const { db, schema, eq, settings } = await mod();
    const sync = await import('../server/sync/menu-sync');
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const p = boot.products.find((x) => x.name === 'Latte')!;
    const full = structuredClone(site.menu);
    // Ürün sitede Tükendi: herkese açık listede yok
    site.menu.categories = site.menu.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.id !== p.extId) }));
    site.panelActive.set(p.extId!, false);
    await sync.runMenuSync({ apply: true, force: true });
    const row = () => db.select().from(schema.products).where(eq(schema.products.id, p.id)).get()!;
    expect(row().active).toBe(false);
    // Tükendi'yken fiyat değişti ve ürün açıldı; CDN listesi hâlâ eski (ürün yok)
    const price = row().price + 2000;
    site.panelActive.set(p.extId!, true);
    site.panelPrices.set(p.extId!, { priceMinor: price, priceMinorL: (row().priceL ?? 0) + 2000 });
    const etag = settings.getSyncState<{ etag?: string }>('laffogato.menu')?.etag;
    const preview = await sync.runMenuSync({ apply: false, force: true });
    expect(preview.preview?.changes.some((c) => c.kind === 'fiyat' && c.extId === p.extId)).toBe(true);
    const r = await sync.runMenuSync({ apply: true, force: true });
    expect(r.cdnStale).toBe(true);
    expect(row()).toMatchObject({ active: true, price });
    // ETag gelen listeninki (bayat da olsa): CDN yenilenince değişir, sonraki yoklama taze listeyi alır
    expect(settings.getSyncState<{ etag?: string }>('laffogato.menu')?.etag).toBe(etag);
    // CDN yenilendi: bayatlık biter
    site.menu = full;
    const fresh = await sync.runMenuSync({ apply: true, force: true });
    expect(fresh.cdnStale).toBeUndefined();
    site.panelPrices.clear();
    await sync.runMenuSync({ apply: true, force: true });
  });
});

describe('menü işareti bütçesi', () => {
  it('gün açıkken en sık 60 sn, art arda değişiklik tek eşitleme; kendi yazımı bekleyen eşitlemeye katılır', async () => {
    const jobs = await import('../server/jobs');
    jobs.resetMenuScheduler();
    const menus = () => site.count('GET /api/mobile/v1/menu');
    const t0 = Date.now();
    jobs.onSiteMenuChanged(t0);
    expect(jobs.pendingMenuSync()).toMatchObject({ force: true });
    expect(jobs.pendingMenuSync()!.at - t0).toBeLessThanOrEqual(1_000);
    const before = menus();
    await jobs.runScheduledSync();
    expect(menus()).toBe(before + 1);
    // İkinci ve üçüncü işaret: tek bekleyen eşitleme, son eşitlemeden 60 sn sonra
    jobs.onSiteMenuChanged();
    jobs.onSiteMenuChanged();
    const pending = jobs.pendingMenuSync()!;
    expect(pending.at - Date.now()).toBeGreaterThan(50_000);
    // LafPOS'un kendi Tükendi yazımı: bekleyen eşitleme varken ikinci eşitleme kurulmaz
    jobs.onSiteMenuWritten();
    expect(jobs.pendingMenuSync()).toEqual(pending);
    await jobs.runScheduledSync();
    expect(menus()).toBe(before + 2);
    // Yeni eşitlemeden hemen sonra kendi yazımı: atlanır
    jobs.onSiteMenuWritten();
    expect(jobs.pendingMenuSync()).toBeNull();
  });

  it('gece işaret değişince istek yok; gün açılınca bir kez ETag\'siz', async () => {
    const jobs = await import('../server/jobs');
    const { db, schema, eq } = await mod();
    jobs.resetMenuScheduler();
    const menus = () => site.count('GET /api/mobile/v1/menu');
    const day = (await h.ok<{ day: { id: string } }>('mudur', 'GET', '/cash/day')).day;
    // Gün kapalı (açık gün yok) gibi: kapanış anı yazılır
    db.update(schema.businessDays).set({ closedAt: Date.now() }).where(eq(schema.businessDays.id, day.id)).run();
    const before = menus();
    jobs.onSiteMenuChanged();
    expect(jobs.pendingMenuSync()).toBeNull();
    expect(jobs.menuSyncDirty()).toBe(true);
    expect(menus()).toBe(before);
    db.update(schema.businessDays).set({ closedAt: null }).where(eq(schema.businessDays.id, day.id)).run();
    await jobs.onMenuDayOpened();
    expect(menus()).toBe(before + 1);
    expect(jobs.menuSyncDirty()).toBe(false);
    jobs.resetMenuScheduler();
  });
});

describe('marj KDV hariç (Yönetim › Ürünler, Raporlar)', () => {
  it('KDV dahil fiyattan KDV hariç maliyet çıkarılmaz', () => {
    expect(netOfKdv(20000, 10)).toBe(18182);
    expect(netMarginPct(20000, 10, 6000)).toBe(67);
    expect(netMarginPct(20000, 20, 6000)).toBe(64);
    expect(netMarginPct(0, 10, 100)).toBeNull();
  });
});

describe('platform ücreti ve eklerin maliyeti', () => {
  const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
  const option = (groupKey: string, code: string) => h.boot.optionGroups.find((g) => g.extKey === groupKey)!.items.find((i) => i.code === code)!;

  it('platform ücreti lafmaliyet\'e hizmet satırı olarak gider (ürünün işareti kapalı kalır)', async () => {
    const { db, schema } = await mod();
    const { ulid } = await import('../server/lib/ids');
    const cat = db.select().from(schema.categories).get()!;
    const id = ulid();
    db.insert(schema.products).values({ id, categoryId: cat.id, name: 'Platform ücreti', price: 1500, kdvRate: 20, hidden: false, posName: 'PLATFORM ÜCRETİ', sort: 999 }).run();
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    const day = (await h.ok<{ day: { id: string } }>('mudur', 'GET', '/cash/day')).day;
    const payload = await h.ok<{ lines: { posName: string; isService: boolean }[] }>('patron', 'GET', `/sync/lafmaliyet/gun/${day.id}`);
    expect(payload.lines.find((l) => l.posName === 'PLATFORM ÜCRETİ')?.isService).toBe(true);
    expect(db.select().from(schema.products).all().find((p) => p.id === id)?.isService).toBe(false);
  });

  it('brüt kâr eklerin reçete maliyetini sayar; bilinmeyen ek 0 sayılır ve satır işaretlenir', async () => {
    const { settings } = await mod();
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const map = { [`${latte.extId}:L`]: 5000, 'mnu-0080:M': 700, 'mnu-0081:M': 900, 'mnu-0082:M': 400 };
    settings.setSyncState('lafmaliyet.costs', { at: Date.now(), map, lastError: null, lastErrorAt: null });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const syrup = h.boot.optionGroups.find((g) => g.extKey === 'syrup')!.items.find((i) => i.code !== 'none')!;
    const options = [{ itemId: syrup.id }, { itemId: option('extraShot', 'extraShot').id, qty: 1 }, { itemId: option('milk', 'lactose-free').id }];
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, qty: 2, size: 'L', options }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    type Row = { name: string; size: string; cost: number | null; costPartial?: boolean };
    const rep = await h.ok<{ products: Row[] }>('patron', 'GET', '/reports/products');
    const row = rep.products.find((p) => p.name === 'Latte' && p.size === 'L')!;
    expect(row.cost).toBe(2 * (5000 + 700 + 900 + 400));
    expect(row.costPartial).toBe(false);
    // Şurubun maliyeti bilinmiyor: 0 sayılır, satır işaretlenir (ana ürünün maliyeti var)
    settings.setSyncState('lafmaliyet.costs', { at: Date.now(), map: { ...map, 'mnu-0080:M': undefined }, lastError: null, lastErrorAt: null });
    const partial = (await h.ok<{ products: Row[] }>('patron', 'GET', '/reports/products')).products.find((p) => p.name === 'Latte' && p.size === 'L')!;
    expect(partial).toMatchObject({ cost: 2 * (5000 + 900 + 400), costPartial: true });
    // Maliyet yetkisi olmayan maliyeti ve işareti görmez
    const staff = (await h.ok<{ products: Row[] }>('kasa', 'GET', '/reports/products').catch(() => ({ products: [] as Row[] }))).products.find((p) => p.name === 'Latte' && p.size === 'L');
    if (staff) expect(staff).not.toHaveProperty('costPartial');
  });
});
