import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformOrderDTO, PlatformOrderPayload } from '@shared/platforms';
import type { OrderDTO, ZSummary } from '@shared/types';
import { startApp, type Harness } from './harness';

/**
 * Paket platformları (B1): gelen sipariş onay bekler, kabulde platformun fiyatıyla POS adisyonu açılır; tahsilatı
 * platform yapıyorsa kuryeye verilince ya da teslimde platformun online ödeme türüyle kapanır.
 */
let h: Harness;
let service: typeof import('../server/delivery/service');

beforeAll(async () => {
  h = await startApp();
  service = await import('../server/delivery/service');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;

function payload(over: Partial<PlatformOrderPayload> = {}): PlatformOrderPayload {
  const lines = over.lines ?? [
    { externalId: 'ys-latte', name: 'Latte', qty: 2, unitPrice: 19000, modifiers: [], note: null },
    { externalId: 'ys-americano', name: 'americano', qty: 1, unitPrice: 17500, modifiers: ['Büyük'], note: 'Buzsuz' },
  ];
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  return {
    platform: 'yemeksepeti',
    simulated: true,
    externalId: `ys-${Math.random()}`,
    code: 'A7KX',
    placedAt: Date.now(),
    scheduledFor: null,
    courier: 'platform',
    platformCollects: true,
    paymentLabel: 'Online kart',
    customer: { name: 'Ayşe K.', phone: null, address: null },
    note: null,
    lines,
    subtotal,
    restaurantDiscount: 0,
    platformDiscount: 0,
    customerTotal: subtotal,
    ...over,
  };
}

async function ingest(p: PlatformOrderPayload, now = Date.now()) {
  const { tx } = await import('../server/db/client');
  const { Effects } = await import('../server/lib/effects');
  const fx = new Effects();
  const res = tx((t) => service.ingestPlatformOrder(t, fx, p, now));
  fx.flush();
  return res;
}

const list = () => h.ok<{ orders: PlatformOrderDTO[] }>('kasa', 'GET', '/platforms').then((r) => r.orders);

describe('paket platformları', () => {
  it('ayarlar: başta kapalı; kapalı platform sipariş almaz, deneme siparişi yalnız deneme modunda', async () => {
    const s = await h.ok<{ settings: Record<string, { mode: string }> }>('kasa', 'GET', '/platforms');
    expect(Object.values(s.settings).every((x) => x.mode === 'kapali')).toBe(true);
    expect((await h.call('kasa', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' })).status).toBe(403);
    await expect(ingest(payload())).rejects.toThrow(/kapalı/);
    const off = await h.call<{ code: string }>('kasa', 'POST', '/platforms/getir/test-order');
    expect(off.json.code).toBe('not_test_mode');
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme', prepMinutes: 15, commissionPct: 18 });
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'deneme' });
    const test = await h.ok<{ id: string }>('kasa', 'POST', '/platforms/getir/test-order');
    const got = (await list()).find((o) => o.id === test.id)!;
    expect(got.status).toBe('bekliyor');
    expect(got.expiresAt! - got.receivedAt).toBe(5 * 60_000);
    expect(got.payload.lines.length).toBeGreaterThan(0);
  });

  it('kabul: platform fiyatıyla paket adisyonu, restoranın kampanyası adisyon indirimi; aynı sipariş ikinci kez açılmaz', async () => {
    const p = payload({ restaurantDiscount: 5000 });
    const first = await ingest(p);
    expect(first.created).toBe(true);
    expect((await ingest(p)).created).toBe(false);
    expect((await h.call('garson', 'POST', `/platforms/orders/${first.row.id}/accept`, {})).status).toBe(403);
    const res = await h.ok<{ orderId: string; prepMinutes: number }>('kasa', 'POST', `/platforms/orders/${first.row.id}/accept`, {});
    expect(res.prepMinutes).toBe(15);
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${res.orderId}`);
    expect(o).toMatchObject({ type: 'paket', platform: 'yemeksepeti', platformCode: 'A7KX', status: 'acik', deliveryName: 'Ayşe K.' });
    const latte = o.items.find((i) => i.name === 'Latte')!;
    expect(latte.unitPrice).toBe(19000);
    const americano = o.items.find((i) => i.name === 'Americano')!;
    expect(americano).toMatchObject({ size: product('Americano').priceL != null ? 'L' : 'TEK', unitPrice: 17500, note: 'Büyük · Buzsuz' });
    expect(o.totals.orderDiscount).toBe(5000);
    expect(o.total).toBe(2 * 19000 + 17500 - 5000);
    const audit = await h.ok<{ action: string; orderId: string | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.some((a) => a.action === 'platform.accept' && a.orderId === o.id)).toBe(true);
    expect(audit.some((a) => a.action === 'item.price_override' && a.orderId === o.id)).toBe(false);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${first.row.id}/accept`, {})).json.code).toBe('not_pending');
  });

  it('platform tahsil ediyorsa kuryeye verilince online ödemeyle kapanır; Z online ve kanal', async () => {
    const { row } = await ingest(payload({ code: 'B2CD' }));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 25 });
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'hazir' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    // Kör kasa: kasiyer kapanmış adisyonun ödeme dökümünü görmez; patron görür
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`);
    expect(closed.status).toBe('kapali');
    expect(closed.payments).toHaveLength(1);
    expect(closed.payments[0]).toMatchObject({ amount: closed.total, methodName: 'Yemeksepeti' });
    const { summary } = await h.ok<{ summary: ZSummary }>('patron', 'GET', '/cash/day');
    expect(summary.byZField.online).toBe(closed.total);
    expect(summary.payments.find((x) => x.channel === 'yemeksepeti')?.amount).toBe(closed.total);
  });

  it('kendi kuryemiz kapıda alıyorsa ödeme kasada: teslimde kendiliğinden kapanmaz', async () => {
    const { row } = await ingest(payload({ code: 'C3DE', courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda nakit', customer: { name: 'Can D.', phone: '0 5** *** ** 12', address: 'Postane Mh.' } }));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect(o.status).toBe('acik');
    expect(o.payments).toHaveLength(0);
    expect(o.deliveryAddress).toBe('Postane Mh.');
  });

  it('ret nedeniyle; süresi geçmiş kabul edilmez ve zamanlayıcı işaretler', async () => {
    const r = await ingest(payload({ code: 'D4EF' }));
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${r.row.id}/reject`, { reason: ' ' })).json.code).toBe('reason_required');
    await h.ok('kasa', 'POST', `/platforms/orders/${r.row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect((await list()).find((o) => o.id === r.row.id)).toMatchObject({ status: 'ret', reason: 'Çok yoğunuz', decidedBy: 'Kasa' });

    const old = await ingest(payload({ code: 'E5FG' }), Date.now() - 16 * 60_000);
    expect((await list()).find((o) => o.id === old.row.id)?.status).toBe('suresi_doldu');
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${old.row.id}/accept`, {})).json.code).toBe('expired');
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    expect(tx((t) => service.expirePlatformOrders(t, new Effects()))).toBe(1);
  });

  it('eşleşmeyen kalem gizli "Platform ürünü" satırı olur, adı notta; platform iptali adisyonu iptal eder', async () => {
    const p = payload({ code: 'F6GH', lines: [{ externalId: 'x', name: 'Menüde olmayan tatlı', qty: 1, unitPrice: 12000, modifiers: [], note: null }] });
    const { row } = await ingest(p);
    expect((await list()).find((o) => o.id === row.id)?.unmatched).toEqual(['Menüde olmayan tatlı']);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ name: 'Platform ürünü', unitPrice: 12000, note: 'Menüde olmayan tatlı' });
    // Kasanın ürün listesinde gizli (karaoke oda ücreti gibi): yalnız platform satırında kullanılır
    const boot = await h.ok<{ products: { name: string; hidden: boolean }[] }>('kasa', 'GET', '/bootstrap');
    expect(boot.products.find((x) => x.name === 'Platform ürünü')?.hidden).toBe(true);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/platform-cancel`, { reason: 'Müşteri vazgeçti' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect((await list()).find((o) => o.id === row.id)?.status).toBe('iptal');
  });

  it('platform siparişinin içeriği değişmez: ürün eklenmez, masa birleştirilmez', async () => {
    const { row } = await ingest(payload({ code: 'G7HJ' }));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const add = await h.call<{ code: string }>('kasa', 'POST', `/orders/${orderId}/items`, { items: [{ productId: product('Latte').id, qty: 4 }] });
    expect(add.json.code).toBe('platform_order');
    const t = h.boot.tables.find((x) => x.kind === 'masa')!;
    const table = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: t.id, guests: 1 });
    await h.ok('garson', 'POST', `/orders/${table.id}/items`, { items: [{ productId: product('Latte').id, qty: 4 }] });
    const merge = await h.call<{ code: string }>('garson', 'POST', `/orders/${orderId}/merge`, { sourceOrderId: table.id });
    expect(merge.json.code).toBe('platform_order');
    await h.ok('patron', 'POST', `/orders/${table.id}/cancel`, { reason: 'Deneme' });
  });

  it('otomatik platform ödemesi: yalnız paket yetkilisi, aşamaya ilk geçişte, tutar platformunkine eşitse', async () => {
    const { row } = await ingest(payload({ code: 'H8JK' }));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    // Garson teslim derse adisyon açık kalır
    await h.ok('garson', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
    // Kalem iptal edildi: tutar platformunkinden farklı, ödeme yazılmaz, alarm düşer
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    await h.ok('patron', 'POST', `/orders/${orderId}/items/${o.items[0].id}/void`, { qty: 1, reason: 'Ürün bitti' });
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    const after = await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`);
    expect([after.status, after.payments.length]).toEqual(['acik', 0]);
    const audit = await h.ok<{ action: string; orderId: string | null; severity: string }[]>('patron', 'GET', '/admin/audit?limit=30');
    expect(audit.find((a) => a.action === 'platform.mismatch' && a.orderId === orderId)?.severity).toBe('alarm');
  });

  it('iade edilen platform ödemesi kurye değişince yeniden yazılmaz', async () => {
    const { row } = await ingest(payload({ code: 'J9KL' }));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`);
    await h.ok('mudur', 'POST', `/orders/${orderId}/payments/${closed.payments[0].id}/refund`, { reason: 'Yanlış' });
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { courierId: null });
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`)).payments.filter((p) => !p.refundedAt)).toHaveLength(0);
  });

  it('platform iptali: kasada alınmış ödeme varsa durur; kapanmış siparişte platform ödemesi geri alınır', async () => {
    const real = await ingest(payload({ code: 'K1LM', simulated: false }));
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${real.row.id}/platform-cancel`, { reason: 'x' })).json.code).toBe('not_test_order');

    const cash = await ingest(payload({ code: 'L2MN', courier: 'restoran', platformCollects: false }));
    const a = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${cash.row.id}/accept`, {});
    const nakit = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    await h.ok('kasa', 'POST', `/orders/${a.orderId}/payments`, { methodId: nakit.id, amount: 10000 });
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${cash.row.id}/platform-cancel`, { reason: 'x' })).json.code).toBe('has_payments');

    const done = await ingest(payload({ code: 'M3NP' }));
    const b = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${done.row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${b.orderId}/delivery`, { deliveryStatus: 'yolda' });
    await h.ok('kasa', 'POST', `/platforms/orders/${done.row.id}/platform-cancel`, { reason: 'Müşteri vazgeçti' });
    const cancelled = await h.ok<OrderDTO>('patron', 'GET', `/orders/${b.orderId}`);
    expect(cancelled.status).toBe('iptal');
    expect(cancelled.payments.every((p) => p.refundedAt)).toBe(true);
  });

  it('tükenmiş ürün kabul edilmez; deneme modu yalnız kurulum modunda', async () => {
    const latte = product('Latte');
    await h.ok('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: false });
    const { row } = await ingest(payload({ code: 'N4PR' }));
    expect((await list()).find((o) => o.id === row.id)?.soldOut).toEqual(['Latte']);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {})).json.code).toBe('sold_out');
    await h.ok('kasa', 'POST', `/sync/products/${latte.id}/availability`, { active: true });

    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: false });
    expect((await h.call<{ code: string }>('patron', 'PUT', '/platforms/trendyol', { mode: 'deneme' })).json.code).toBe('not_setup_mode');
    expect((await h.call<{ code: string }>('kasa', 'POST', '/platforms/yemeksepeti/test-order')).json.code).toBe('not_setup_mode');
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: true });
  });
});
