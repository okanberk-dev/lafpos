import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformOrderDTO, PlatformProductDTO } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import { type FakeTrendyol, startFakeTrendyol } from './fake-trendyol';
import { startApp, type Harness } from './harness';
import type { TrendyolPackage } from '../server/delivery/trendyol';

/**
 * Trendyol Go canlı bağlantısı (B2): paket → tek biçim çevirisi, yoklama (yeni sipariş, platformun iptali), kabul ve
 * ret önce platforma, teslim aşamaları sırayla platforma ve yeniden deneme, ürün eşleme, anahtar yokken canlı mod yok.
 * Sahte sunucu tests/fake-trendyol.ts.
 */
const KEYS = { supplierId: '777', apiKey: 'anahtar', apiSecret: 'gizli' };
let h: Harness;
let fake: FakeTrendyol;
let live: typeof import('../server/delivery/live');

beforeAll(async () => {
  fake = await startFakeTrendyol(KEYS);
  h = await startApp({ TRENDYOL_SUPPLIER_ID: KEYS.supplierId, TRENDYOL_API_KEY: KEYS.apiKey, TRENDYOL_API_SECRET: KEYS.apiSecret, TRENDYOL_API_URL: fake.url });
  live = await import('../server/delivery/live');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await fake.close();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const list = () => h.ok<{ orders: PlatformOrderDTO[] }>('kasa', 'GET', '/platforms').then((r) => r.orders);
const byExt = async (ext: string) => (await list()).find((o) => o.payload.externalId === ext)!;

let seq = 1000;
function pkg(over: Partial<TrendyolPackage> = {}, now = Date.now()): TrendyolPackage {
  const id = ++seq;
  return {
    id,
    orderNumber: `TY${id}`,
    orderCode: `K${String(id).slice(-2)}`,
    packageStatus: 'Created',
    deliveryType: 'GO',
    storePickupSelected: false,
    packageCreationDate: now - 60_000,
    packageModificationDate: now - 30_000,
    customer: { firstName: 'A***', lastName: 'K***' },
    address: { address1: 'TGO Yemek', phone: '0850 000 00 00' },
    callCenterPhone: '0850 210 7555',
    lines: [{ productId: 55, name: 'Latte', price: 190, quantity: 1, modifierProducts: [{ name: 'Yulaf sütü', price: 10 }] }],
    payment: { paymentType: 'PAY_WITH_CREDIT_CARD' },
    totalPrice: 200,
    ...over,
  };
}

describe('paket → tek biçim', () => {
  it('GO siparişi: platform kuryesi, online ödeme, seçenek fiyatı birim fiyata, kampanyalar paylara', async () => {
    const { fromTrendyolPackage } = await import('../server/delivery/trendyol');
    const p = fromTrendyolPackage(
      pkg({
        lines: [
          { productId: 1, name: 'Latte', price: 190, quantity: 2, modifierProducts: [{ name: 'Yulaf sütü', price: 10 }], extraIngredients: [{ name: 'Tarçın', price: 0 }], removedIngredients: [{ name: 'Şeker' }], promotions: [{ name: 'İkinci kahve', amount: { value: 20, sellerCoverageRatio: 0.5 } }] },
          { productId: 2, name: 'Cheesecake', price: 150, items: [{}], note: 'Çatalsız' },
        ],
        promotions: [{ name: 'Trendyol kuponu', amount: { value: 30, sellerCoverageRatio: 0 } }],
        totalPrice: 480,
        customerNote: 'Kapıyı çalmayın',
        pinCode: '4821',
      }),
    );
    expect(p).toMatchObject({ platform: 'trendyol', simulated: false, courier: 'platform', platformCollects: true, paymentLabel: 'Online kart', note: 'Kapıyı çalmayın · Teslim PIN 4821' });
    expect(p.lines[0]).toMatchObject({ externalId: '1', name: 'Latte', qty: 2, unitPrice: 20000, modifiers: ['Yulaf sütü', '+Tarçın', '−Şeker'] });
    expect(p.lines[1]).toMatchObject({ externalId: '2', qty: 1, unitPrice: 15000, note: 'Çatalsız' });
    expect(p.subtotal).toBe(55000);
    // İkinci kahve 20 TL × 2 adet, yarısı bizden (2000); Trendyol kuponu 30 TL platformdan; müşteri 480 TL ödedi
    expect(p.restaurantDiscount).toBe(2000);
    expect(p.customerTotal).toBe(48000);
    expect(p.platformDiscount).toBe(p.subtotal - p.restaurantDiscount - p.customerTotal);
    // GO siparişinde adres ve telefon kasaya gelmez (platform kuryesi taşır)
    expect(p.customer).toEqual({ name: 'A*** K***', phone: null, address: null });
  });

  it('STORE siparişi: gel-al ya da kendi kuryemiz; kapıda nakit tahsilatı kasada, kapıda yemek kartı adıyla', async () => {
    const { fromTrendyolPackage, courierOf, paymentOf } = await import('../server/delivery/trendyol');
    const own = fromTrendyolPackage(pkg({ deliveryType: 'STORE', storePickupSelected: false, payment: { paymentType: 'PAY_WITH_CASH' }, address: { address1: 'Postane Mh. Tuzla Cd.', apartmentNumber: '3', doorNumber: '7', district: 'Tuzla', city: 'İstanbul', phone: '0 5** *** ** 12' } }));
    expect(own).toMatchObject({ courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda nakit' });
    expect(own.customer.address).toBe('Postane Mh. Tuzla Cd., Apt 3 Daire 7, Tuzla, İstanbul');
    expect(own.customer.phone).toBe('0 5** *** ** 12');
    const pickup = fromTrendyolPackage(pkg({ deliveryType: 'STORE', storePickupSelected: true, payment: 'PAY_WITH_MULTINET' }));
    expect(pickup).toMatchObject({ courier: 'gelal', platformCollects: false, paymentLabel: 'Kapıda Multinet' });
    const goCash = fromTrendyolPackage(pkg({ deliveryType: 'GO', payment: { paymentType: 'PAY_AT_DOOR', cardType: 'Pluxee' } }));
    // Kapıda ödemeyi Trendyol Go kuryesi alır: tahsilat platformun
    expect(goCash).toMatchObject({ courier: 'platform', platformCollects: true, paymentLabel: 'Kapıda Pluxee' });
    expect(courierOf({ id: 1, deliveryType: 'go' })).toBe('platform');
    expect(paymentOf({ id: 1 })).toEqual({ online: true, label: 'Online' });
  });

  it('eksik ya da bozuk alanlar: kuruşa çevrim, adet 1, kod paketten; ödenen tutar kalemleri aşarsa dokunulmaz', async () => {
    const { fromTrendyolPackage } = await import('../server/delivery/trendyol');
    const p = fromTrendyolPackage({ id: '9', lines: [{ name: 'Çay', price: '12,50' as unknown as number }], totalPrice: 999 });
    expect(p.lines[0]).toMatchObject({ externalId: null, qty: 1, unitPrice: 1250 });
    expect([p.subtotal, p.customerTotal, p.platformDiscount, p.code]).toEqual([1250, 1250, 0, '9']);
  });
});

describe('canlı bağlantı', () => {
  let createdExt = '';

  it('canlı mod yalnız bağdaştırıcısı ve anahtarı olan platformda; durum GET /platforms içinde', async () => {
    expect((await h.call<{ code: string }>('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'canli' })).json.code).toBe('not_supported');
    const { setAdapter, adapterFor } = await import('../server/delivery/registry');
    const real = adapterFor('trendyol')!;
    setAdapter('trendyol', { ...real, configured: () => false });
    expect((await h.call<{ code: string }>('patron', 'PUT', '/platforms/trendyol', { mode: 'canli' })).json.code).toBe('not_configured');
    setAdapter('trendyol', real);
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'canli', prepMinutes: 25 });
    const r = await h.ok<{ live: Record<string, { supported: boolean; configured: boolean; lastPollAt: number | null }> }>('kasa', 'GET', '/platforms');
    expect(r.live.trendyol).toMatchObject({ supported: true, configured: true, lastPollAt: null });
    expect(r.live.yemeksepeti.supported).toBe(false);
    const audit = await h.ok<{ action: string; severity: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.find((a) => a.action === 'platform.settings')?.severity).toBe('uyari');
  });

  it('yoklama: yeni paket onay bekler, aynı paket ikinci kez açılmaz, kalemler ürün eşleme listesine düşer', async () => {
    const p = pkg();
    fake.packages.push(p);
    const r1 = await live.pollPlatform('trendyol');
    expect(r1).toEqual({ created: 1, cancelled: 0 });
    expect(fake.count('GET packages Created')).toBe(1);
    expect(fake.count('GET packages Cancelled')).toBe(1);
    createdExt = String(p.id);
    const row = await byExt(createdExt);
    expect(row).toMatchObject({ status: 'bekliyor', platform: 'trendyol' });
    expect(row.payload.code).toBe(p.orderCode);
    expect(row.expiresAt! - row.receivedAt).toBe(30 * 60_000);
    expect((await live.pollPlatform('trendyol'))?.created).toBe(0);
    const products = (await h.ok<{ products: PlatformProductDTO[] }>('patron', 'GET', '/platforms/products')).products;
    expect(products.find((x) => x.externalId === '55')).toMatchObject({ platform: 'trendyol', name: 'Latte', productId: null });
    const status = await h.ok<{ live: Record<string, { lastPollAt: number | null; lastError: string | null }> }>('kasa', 'GET', '/platforms');
    expect(status.live.trendyol.lastPollAt).not.toBeNull();
  });

  it('ürün eşleme: platform kimliği kasadaki ürüne bağlanınca ad tutmasa da o ürün', async () => {
    const products = (await h.ok<{ products: PlatformProductDTO[] }>('patron', 'GET', '/platforms/products')).products;
    const latte = products.find((x) => x.externalId === '55')!;
    expect((await h.call('garson', 'PUT', `/platforms/products/${latte.id}`, { productId: product('Americano').id })).status).toBe(403);
    await h.ok('patron', 'PUT', `/platforms/products/${latte.id}`, { productId: product('Americano').id });
    expect((await h.call<{ code: string }>('patron', 'PUT', `/platforms/products/${latte.id}`, { productId: 'yok' })).status).toBe(404);
    const row = await byExt(createdExt);
    expect(row.unmatched).toEqual([]);
    await h.ok('patron', 'PUT', `/platforms/products/${latte.id}`, { productId: null });
  });

  it('kabul önce platforma: platform 500 dönerse yerelde kabul edilmez; sonra picked ve hazırlık süresi gider', async () => {
    const row = await byExt(createdExt);
    fake.statusFor.picked = [500];
    const fail = await h.call<{ code: string; error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 20 });
    expect([fail.status, fail.json.code]).toEqual([502, 'platform_unreachable']);
    expect((await byExt(createdExt)).status).toBe('bekliyor');
    const ok = await h.ok<{ orderId: string; prepMinutes: number }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 20 });
    expect(fake.count(`PUT ${createdExt} picked`)).toBe(2);
    expect(fake.bodies.picked?.at(-1)).toEqual({ preparationTime: 20 });
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${ok.orderId}`);
    expect(o).toMatchObject({ type: 'paket', platform: 'trendyol', status: 'acik' });
    expect(o.items[0]).toMatchObject({ name: 'Latte', unitPrice: 20000 });
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    expect(db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, row.id)).get()?.notifiedStatus).toBe('picked');
  });

  it('teslim aşamaları sırayla platforma: hazır → invoiced; platform kuryesinde yolda platforma gitmez, ödeme yazılır', async () => {
    const row = await byExt(createdExt);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'hazir' });
    await live.reconcileNotifications();
    expect(fake.count(`PUT ${createdExt} invoiced`)).toBe(1);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'yolda' });
    await live.reconcileNotifications();
    expect(fake.count(`PUT ${createdExt} manual-shipped`)).toBe(0);
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`);
    expect(closed.status).toBe('kapali');
    expect(closed.payments[0]).toMatchObject({ methodName: 'Trendyol Go', amount: 20000 });
  });

  it('kendi kuryemiz: kabulden doğrudan teslime geçince invoiced, manual-shipped, manual-delivered sırayla; hata yeniden denenir', async () => {
    const p = pkg({ deliveryType: 'STORE', storePickupSelected: false, payment: { paymentType: 'PAY_WITH_CASH' }, address: { address1: 'Aydınlı Mh.', phone: '0 5** *** ** 90' } });
    fake.packages.push(p);
    await live.pollPlatform('trendyol');
    const row = await byExt(String(p.id));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    fake.statusFor.invoiced = [503];
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    const first = await live.reconcileNotifications();
    expect(first.failed).toBe(1);
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const stuck = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, row.id)).get()!;
    expect(stuck.notifiedStatus).toBe('picked');
    expect(stuck.lastError).toMatch(/"Hazır" bildirilemedi/);
    const second = await live.reconcileNotifications();
    expect(second.sent).toBe(1);
    const calls = fake.calls.filter((c) => c.startsWith(`PUT ${p.id} `));
    expect(calls).toEqual([`PUT ${p.id} picked`, `PUT ${p.id} invoiced`, `PUT ${p.id} invoiced`, `PUT ${p.id} manual-shipped`, `PUT ${p.id} manual-delivered`]);
    const done = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, row.id)).get()!;
    expect([done.notifiedStatus, done.lastError]).toEqual(['teslim', null]);
    // Kapıda nakit: tahsilat kasada, adisyon açık kalır
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
    const audit = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=30');
    expect(audit.some((a) => a.action === 'platform.notify_failed')).toBe(true);
  });

  it('ret önce platforma (unsupplied, neden kodu); platformun iptali yoklamada kabul edilmiş adisyonu iptal eder', async () => {
    const p = pkg();
    fake.packages.push(p);
    await live.pollPlatform('trendyol');
    const row = await byExt(String(p.id));
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect(fake.bodies.unsupplied?.at(-1)).toEqual({ reasonCode: 622 });
    expect((await byExt(String(p.id))).status).toBe('ret');

    const q = pkg();
    fake.packages.push(q);
    await live.pollPlatform('trendyol');
    const accepted = await byExt(String(q.id));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${accepted.id}/accept`, {});
    q.packageStatus = 'Cancelled';
    q.packageModificationDate = Date.now();
    const r = await live.pollPlatform('trendyol');
    expect(r?.cancelled).toBe(1);
    expect((await byExt(String(q.id))).status).toBe('iptal');
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
  });

  it('yoklama hatası: anahtar reddedilince durum ve denetim kaydı; bekleme katlanır, sonra düzelir', async () => {
    fake.statusFor.packages = [401];
    await expect(live.pollPlatform('trendyol')).rejects.toThrow(/anahtar reddedildi/);
    const status = await h.ok<{ live: Record<string, { lastError: string | null }> }>('kasa', 'GET', '/platforms');
    expect(status.live.trendyol.lastError).toMatch(/yoklanamadı/);
    expect(live.pollDue('trendyol')).toBe(false);
    const audit = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=10');
    expect(audit.some((a) => a.action === 'platform.poll_failed')).toBe(true);
    await live.pollPlatform('trendyol');
    expect((await h.ok<{ live: Record<string, { lastError: string | null }> }>('kasa', 'GET', '/platforms')).live.trendyol.lastError).toBeNull();
  });

  it('deneme siparişi canlı modda üretilmez; kapalı modda yoklama yok', async () => {
    expect((await h.call<{ code: string }>('kasa', 'POST', '/platforms/trendyol/test-order')).json.code).toBe('not_test_mode');
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'kapali' });
    const before = fake.calls.length;
    expect(await live.pollPlatform('trendyol')).toBeNull();
    await live.liveTick();
    expect(fake.calls.length).toBe(before);
  });
});
