import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentOf } from '@shared/money';
import type { PlatformId, PlatformOrderPayload } from '@shared/platforms';
import { addDays, businessDayStartMs } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { startApp, type Harness } from './harness';

/**
 * Raporlar › Paket platformları: ciro Raporlar › Ciro'nun kuralıyla (kapanmış POS adisyonu, KDV dahil), siparişin
 * kaynağına göre; platformun kampanyası ciroyu düşürmez; tahsilat platformda ve kasada ayrı; kaçan sipariş (ret,
 * süre dolumu, iptal) ciroya girmez, geldiği iş gününe yazılır; tahmini komisyon bugünkü oranla ve yalnız maliyet
 * yetkisine (CSV'de de).
 */
let h: Harness;
let service: typeof import('../server/delivery/service');
let today: string;

beforeAll(async () => {
  h = await startApp();
  service = await import('../server/delivery/service');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  today = (await h.ok<{ day: { date: string } }>('kasa', 'GET', '/cash/day')).day.date;
  await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme', commissionPct: 18.5 });
  await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'deneme', commissionPct: 25 });
  await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'deneme' });
  // Rapor gören ama maliyet görmeyen kişi
  await h.ok('patron', 'POST', '/admin/users', { name: 'Raporcu', role: 'kasiyer', permGrant: ['rapor.gor'], pin: '4747' });
  await h.login('raporcu', '4747');
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;

function payload(platform: PlatformId, over: Partial<PlatformOrderPayload> = {}): PlatformOrderPayload {
  const lines = over.lines ?? [
    { externalId: `${platform}-latte`, name: 'Latte', qty: 2, unitPrice: 19000, modifiers: [], note: null },
    { externalId: `${platform}-turk`, name: 'Türk Kahvesi', qty: 1, unitPrice: 9000, modifiers: [], note: null },
  ];
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const restaurantDiscount = over.restaurantDiscount ?? 0;
  const platformDiscount = over.platformDiscount ?? 0;
  return {
    platform,
    simulated: true,
    externalId: `${platform}-${Math.random()}`,
    code: 'R1PT',
    placedAt: Date.now(),
    scheduledFor: null,
    courier: 'platform',
    platformCollects: true,
    paymentLabel: 'Online kart',
    customer: { name: 'Deniz A.', phone: null, address: null },
    note: null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal: subtotal - restaurantDiscount - platformDiscount,
    ...over,
  };
}

async function ingest(p: PlatformOrderPayload, now = Date.now()) {
  const { tx } = await import('../server/db/client');
  const { Effects } = await import('../server/lib/effects');
  const fx = new Effects();
  const res = tx((t) => service.ingestPlatformOrder(t, fx, p, now));
  fx.flush();
  return res.row;
}

const accept = (id: string) => h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${id}/accept`, {}).then((r) => r.orderId);
const order = (id: string) => h.ok<OrderDTO>('patron', 'GET', `/orders/${id}`);

interface PlatformRow {
  platform: PlatformId;
  label: string;
  orders: number;
  revenue: number;
  avgBasket: number;
  share: number;
  discounts: number;
  platformDiscount: number;
  collectedByPlatform: number;
  collectedAtCounter: number;
  open: { orders: number; amount: number };
  missed: { orders: number; amount: number; rejected: number; expired: number; cancelled: number; unrecorded: number };
  commissionPct?: number;
  commission?: number;
}
interface Report {
  netSales: number;
  revenue: number;
  orders: number;
  avgBasket: number;
  share: number;
  open: { orders: number; amount: number };
  missed: { orders: number; amount: number };
  pending: number;
  commission?: number;
  platforms: PlatformRow[];
}

const report = (who: string, from = today, to = today) => h.ok<Report>(who, 'GET', `/reports/platforms?from=${from}&to=${to}`);
const csv = async (who: string) => {
  const r = await h.call<string>(who, 'GET', `/reports/export.csv?type=platformlar&from=${today}&to=${today}`);
  expect(r.status).toBe(200);
  return r.json.replace(/^﻿/, '').trim().split('\r\n');
};

describe('Raporlar › Paket platformları', () => {
  const expected = { ysOrders: [] as string[], tezgah: 0, getirOpen: '', cancelledTotal: 0, rejectedGetir: 0, expiredGetir: 0, unrecordedGetir: 0, trendyolToday: 0 };

  it('satışlar, açık, kaçan ve bekleyen siparişler kurulur', async () => {
    // 1) Yemeksepeti, platform kuryesi ve online ödeme: restoranın ve platformun kampanyası; kuryeye verilince kapanır
    const a = await ingest(payload('yemeksepeti', { restaurantDiscount: 5000, platformDiscount: 3000 }));
    const aId = await accept(a.id);
    await h.ok('kasa', 'POST', `/orders/${aId}/delivery`, { deliveryStatus: 'yolda' });
    expect((await order(aId)).status).toBe('kapali');
    expected.ysOrders.push(aId);

    // 2) Yemeksepeti, kendi kuryemiz kapıda nakit: platformun kampanya payı kabulde platformun ödemesi, kalanı kasada
    const b = await ingest(payload('yemeksepeti', { courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda nakit', platformDiscount: 2000 }));
    const bId = await accept(b.id);
    const bOrder = await order(bId);
    expect(bOrder.paid).toBe(2000);
    await h.ok('kasa', 'POST', `/orders/${bId}/payments`, { methodId: method('Nakit').id, amount: bOrder.total - 2000 });
    expect((await order(bId)).status).toBe('kapali');
    expected.ysOrders.push(bId);

    // 3) Yemeksepeti kabul edilip platformca iptal edildi: kaçan (iptal), ciroya girmez
    const c = await ingest(payload('yemeksepeti', { lines: [{ externalId: 'ys-esp', name: 'Espresso', qty: 1, unitPrice: 12000, modifiers: [], note: null }] }));
    await accept(c.id);
    await h.ok('kasa', 'POST', `/platforms/orders/${c.id}/platform-cancel`, { reason: 'Müşteri vazgeçti' });
    expected.cancelledTotal = c.payload.customerTotal;

    // 4) Getir kabul edildi, henüz kapanmadı: açık
    const d = await ingest(payload('getir'));
    expected.getirOpen = await accept(d.id);

    // 5) Getir reddedildi; biri süresi doldu (zamanlayıcı işaretlemeden de sayılır)
    const e = await ingest(payload('getir', { lines: [{ externalId: 'g-mocha', name: 'Mocha', qty: 1, unitPrice: 21000, modifiers: [], note: null }] }));
    await h.ok('kasa', 'POST', `/platforms/orders/${e.id}/reject`, { reason: 'Çok yoğunuz' });
    expected.rejectedGetir = e.payload.customerTotal;
    const start = businessDayStartMs(today);
    const f = await ingest(payload('getir', { placedAt: start, expiresAt: start + 1 }), start);
    expected.expiredGetir = f.payload.customerTotal;
    // Getir panelinden onaylanmış (tablette kabul edilmiş) sipariş 3 saat içinde kasaya alınmadı: süresi dolan değil
    const g = await ingest(payload('getir', { preAccepted: true, placedAt: start - 4 * 3600_000 }), start);
    expected.unrecordedGetir = g.payload.customerTotal;

    // 6) Trendyol Go: iş günü sınırında iki ret (05:00'ten bir an önce dünün, 05:00'te bugünün); test siparişi sayılmaz
    const yesterday = await ingest(payload('trendyol', { placedAt: start - 1 }), start - 1);
    const atStart = await ingest(payload('trendyol', { placedAt: start }), start);
    for (const r of [yesterday, atStart]) await h.ok('kasa', 'POST', `/platforms/orders/${r.id}/reject`, { reason: 'Ürün tükendi' });
    expected.trendyolToday = atStart.payload.customerTotal;
    const testOrder = await ingest(payload('trendyol', { test: true }));
    await h.ok('kasa', 'POST', `/platforms/orders/${testOrder.id}/reject`, { reason: 'Diğer' });

    // 7) Onay bekleyen Trendyol siparişi: hiçbir rakama girmez
    await ingest(payload('trendyol'));

    // 8) Platform dışı tezgâh satışı: ciroda var, platformda yok
    const t = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const tFull = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${t.id}/items`, { items: [{ productId: product('Americano').id, qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${t.id}/payments`, { methodId: method('Kredi kartı').id, amount: tFull.total });
    expected.tezgah = tFull.total;
  });

  it('platform cirosu, kampanyalar, tahsilat ve tahmini komisyon (maliyet yetkisiyle)', async () => {
    const r = await report('patron');
    const [a, b] = await Promise.all(expected.ysOrders.map(order));
    const ys = r.platforms.find((p) => p.platform === 'yemeksepeti')!;
    expect(ys).toMatchObject({
      label: 'Yemeksepeti',
      orders: 2,
      revenue: a!.total + b!.total,
      avgBasket: Math.round((a!.total + b!.total) / 2),
      discounts: 5000,
      platformDiscount: 3000 + 2000,
      collectedByPlatform: a!.total + 2000,
      collectedAtCounter: b!.total - 2000,
      open: { orders: 0, amount: 0 },
      missed: { orders: 1, amount: expected.cancelledTotal, rejected: 0, expired: 0, cancelled: 1, unrecorded: 0 },
      commissionPct: 18.5,
      commission: percentOf(a!.total + b!.total, 18.5),
    });
    // Restoranın kampanyası adisyon indirimi; platformunki ciroyu düşürmez: ciro = kalemler − restoranın payı
    expect(a!.total).toBe(2 * 19000 + 9000 - 5000);
    expect(ys.collectedByPlatform + ys.collectedAtCounter).toBe(ys.revenue);

    const getir = r.platforms.find((p) => p.platform === 'getir')!;
    const open = await order(expected.getirOpen);
    expect(getir).toMatchObject({
      orders: 0,
      revenue: 0,
      open: { orders: 1, amount: open.total },
      missed: { orders: 3, amount: expected.rejectedGetir + expected.expiredGetir + expected.unrecordedGetir, rejected: 1, expired: 1, cancelled: 0, unrecorded: 1 },
      commissionPct: 25,
      commission: 0,
    });
    const trendyol = r.platforms.find((p) => p.platform === 'trendyol')!;
    expect(trendyol.missed).toEqual({ orders: 1, amount: expected.trendyolToday, rejected: 1, expired: 0, cancelled: 0, unrecorded: 0 });
    expect(trendyol.commission).toBe(0);
    // Hareketi olmayan platform satır almaz; ciroya göre sıralı
    expect(r.platforms.map((p) => p.platform)).toEqual(['yemeksepeti', 'getir', 'trendyol']);

    expect(r).toMatchObject({
      revenue: ys.revenue,
      orders: 2,
      open: { orders: 1, amount: open.total },
      missed: { orders: 5, amount: expected.cancelledTotal + expected.rejectedGetir + expected.expiredGetir + expected.unrecordedGetir + expected.trendyolToday },
      pending: 1,
      commission: ys.commission,
    });
  });

  it('Raporlar › Ciro ile mutabık: platform cirosu özetin içindeki bu adisyonların cirosu', async () => {
    const r = await report('patron');
    const summary = await h.ok<{ netSales: number; receipts: number; types: { type: string; amount: number }[] }>('patron', 'GET', `/reports/summary?from=${today}&to=${today}`);
    const closed = await Promise.all(expected.ysOrders.map(order));
    expect(r.netSales).toBe(summary.netSales);
    expect(r.revenue).toBe(closed.reduce((a, o) => a + o.total, 0));
    expect(summary.netSales - expected.tezgah).toBe(r.revenue);
    expect(summary.types.find((t) => t.type === 'paket')?.amount).toBe(r.revenue);
    expect(r.share).toBe(Math.round((r.revenue / summary.netSales) * 1000) / 10);
  });

  it('kaçan sipariş geldiği iş gününe yazılır (05:00 kuralı)', async () => {
    const both = await report('patron', addDays(today, -1), today);
    expect(both.platforms.find((p) => p.platform === 'trendyol')!.missed.rejected).toBe(2);
    const before = await report('patron', addDays(today, -1), addDays(today, -1));
    expect(before.platforms.map((p) => [p.platform, p.missed.orders])).toEqual([['trendyol', 1]]);
    expect(before.netSales).toBe(0);
  });

  it('zamanlayıcı süresi geçeni işaretleyince rakam değişmez', async () => {
    const getir = async () => (await report('patron')).platforms.find((p) => p.platform === 'getir')!.missed;
    const was = await getir();
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    expect(tx((t) => service.expirePlatformOrders(t, new Effects()))).toBeGreaterThanOrEqual(1);
    expect(await getir()).toEqual(was);
    expect((await report('patron')).pending).toBe(1);
  });

  it('komisyon bugünkü oranla: oran değişince dönemin tahmini de değişir', async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { commissionPct: 20 });
    const ys = (await report('patron')).platforms.find((p) => p.platform === 'yemeksepeti')!;
    expect(ys.commission).toBe(percentOf(ys.revenue, 20));
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { commissionPct: 18.5 });
  });

  it('maliyet yetkisi olmayana komisyon gitmez (uç ve CSV); rapor yetkisi olmayana rapor yok', async () => {
    const r = await report('raporcu');
    expect(r.revenue).toBeGreaterThan(0);
    expect(r).not.toHaveProperty('commission');
    for (const p of r.platforms) {
      expect(p).not.toHaveProperty('commission');
      expect(p).not.toHaveProperty('commissionPct');
    }
    const lines = await csv('raporcu');
    expect(lines[0]).not.toMatch(/omisyon/);
    expect((await h.call('garson', 'GET', `/reports/platforms?from=${today}&to=${today}`)).status).toBe(403);
    expect((await h.call('garson', 'GET', `/reports/export.csv?type=platformlar&from=${today}&to=${today}`)).status).toBe(403);
  });

  it('CSV: platform başına satır, Excel Türkçe biçimi; komisyon yalnız maliyet yetkisinde', async () => {
    const lines = await csv('patron');
    const head = lines[0]!.split(';');
    expect(head.slice(0, 3)).toEqual(['Platform', 'Sipariş', 'Ciro']);
    expect(head.at(-1)).toBe('Tahmini komisyon');
    const r = await report('patron');
    const ys = r.platforms.find((p) => p.platform === 'yemeksepeti')!;
    const row = lines.find((l) => l.startsWith('Yemeksepeti;'))!.split(';');
    expect(row[1]).toBe('2');
    expect(row[2]).toBe((ys.revenue / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(row.at(-2)).toBe('18,5');
    expect(row.at(-1)).toBe((ys.commission! / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(lines).toHaveLength(1 + r.platforms.length);
  });

  it('platformda kabul edilip kasaya alınmamış sipariş karar beklemez; 3 saat sonra "kasaya alınmadı"', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const { platformReport } = await import('../server/services/reports');
    await h.ok('patron', 'PUT', '/platforms/migros', { mode: 'deneme' });
    const before = await report('patron');
    const start = businessDayStartMs(today);
    // Platformun panelinden kabul edilmiş (applyConfirmed) ya da kabulü platforma gidip adisyonu açılamamış
    // (acceptFailedLocally) kayıtlar: biri 4 saat önce, biri şimdi geldi. Kabul süresi geçse de süre dolmaz
    const old = await ingest(payload('migros', { placedAt: start - 4 * 3600_000, expiresAt: start - 3 * 3600_000 }), start);
    const fresh = await ingest(payload('migros', { expiresAt: Date.now() - 1000 }));
    for (const r of [old, fresh]) {
      db.update(schema.platformOrders).set({ notifiedStatus: 'picked', lastError: 'Platformun panelinden kabul edildi: Kabul yalnız adisyonu açar' }).where(eq(schema.platformOrders.id, r.id)).run();
    }
    const after = await report('patron');
    const migros = after.platforms.find((p) => p.platform === 'migros')!;
    expect(migros.missed).toEqual({ orders: 1, amount: old.payload.customerTotal, rejected: 0, expired: 0, cancelled: 0, unrecorded: 1 });
    // İkisi de karar beklemiyor: onay bekleyen sayısı değişmez
    expect(after.pending).toBe(before.pending);
    // Zamanlayıcı bu kayıtlara dokunmaz, rakam değişmez
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    tx((t) => service.expirePlatformOrders(t, new Effects()));
    expect((await report('patron')).platforms.find((p) => p.platform === 'migros')!.missed).toEqual(migros.missed);
    // 3 saat dolunca yeni gelen de kasaya alınmadı sayılır
    const later = platformReport({ from: today, to: today }, true, fresh.payload.placedAt + service.PRE_ACCEPTED_TTL_MS);
    expect(later.platforms.find((p) => p.platform === 'migros')!.missed).toMatchObject({ orders: 2, unrecorded: 2, amount: old.payload.customerTotal + fresh.payload.customerTotal });
    // Kasada Kabul (yalnız adisyonu açar) gelince kayıt kaçan değil açık sipariş olur
    await accept(old.id);
    const opened = (await report('patron')).platforms.find((p) => p.platform === 'migros')!;
    expect(opened.missed.unrecorded).toBe(0);
    expect(opened.open.orders).toBe(1);
  });

  it('gelen kutusu: komisyon oranı yalnız maliyeti gören ya da ayarı yönetene gider (garson ve raporcu almaz)', async () => {
    type Inbox = { settings: Record<string, Record<string, unknown>> };
    const patron = await h.ok<Inbox>('patron', 'GET', '/platforms');
    expect(patron.settings.yemeksepeti!.commissionPct).toBe(18.5);
    expect(patron.settings.getir!.commissionPct).toBe(25);
    for (const who of ['garson', 'raporcu', 'kasa']) {
      const r = await h.ok<Inbox>(who, 'GET', '/platforms');
      for (const st of Object.values(r.settings)) {
        expect(st).not.toHaveProperty('commissionPct');
        // Gelen kutusunun kullandığı alanlar durur
        expect(st).toMatchObject({ mode: expect.any(String), prepMinutes: expect.any(Number) });
      }
    }
  });

  it('platform siparişi olmayan dönem boş döner', async () => {
    const empty = await report('patron', addDays(today, -30), addDays(today, -20));
    expect(empty).toMatchObject({ netSales: 0, revenue: 0, orders: 0, pending: 0, platforms: [] });
  });
});
