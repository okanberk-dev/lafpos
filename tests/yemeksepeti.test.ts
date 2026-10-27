import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformOrderDTO, PlatformProductDTO } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import type { DhOrder, InboxItem } from '../server/delivery/yemeksepeti';
import { type FakeYemeksepeti, startFakeYemeksepeti } from './fake-yemeksepeti';
import { startApp, type Harness } from './harness';

/**
 * Yemeksepeti canlı bağlantısı (kasa tarafı): aktarıcıdan çekme ve silme, Delivery Hero siparişi → tek biçim, kabul ve ret
 * middleware'e (geri çağrı adresleriyle, acceptanceTime), aşamalar (hazır → preparation-completed, alındı →
 * order_picked_up), platformun iptali, jeton yenileme. Sahte sunucular tests/fake-yemeksepeti.ts.
 */
const CREDS = { username: 'pos-kullanici', password: 'pos-parola' };
const CLOUD_SECRET = 'y'.repeat(40);
let h: Harness;
let fake: FakeYemeksepeti;
let live: typeof import('../server/delivery/live');
let seq = 0;

beforeAll(async () => {
  fake = await startFakeYemeksepeti(CREDS);
  h = await startApp({ YEMEKSEPETI_MW_URL: fake.url, YEMEKSEPETI_USERNAME: CREDS.username, YEMEKSEPETI_PASSWORD: CREDS.password, YEMEKSEPETI_REMOTE_ID: 'POS_1', LAFPOS_CLOUD_URL: fake.url, LAFPOS_CLOUD_SECRET: CLOUD_SECRET });
  live = await import('../server/delivery/live');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await fake.close();
});

function dhOrder(over: Partial<DhOrder> = {}): DhOrder {
  const token = `tok-${++seq}`;
  return {
    token,
    code: `n0s1-w0k${seq}`,
    shortCode: String(40 + seq),
    comments: { customerComment: null },
    createdAt: new Date().toISOString(),
    customer: { firstName: 'Ayşe', lastName: 'K.', mobilePhone: '+90 555 000 00 00' },
    delivery: { address: null, expectedDeliveryTime: new Date(Date.now() + 40 * 60_000).toISOString(), riderPickupTime: new Date(Date.now() + 20 * 60_000).toISOString() },
    discounts: [],
    expeditionType: 'delivery',
    expiryDate: new Date(Date.now() + 15 * 60_000).toISOString(),
    payment: { status: 'paid', type: 'online' },
    test: false,
    preOrder: false,
    pickup: null,
    price: { deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '215.00', payRestaurant: '190.00' },
    products: [{ id: 'P-LATTE', remoteCode: 'latte-m', name: 'Latte', quantity: '1', unitPrice: '170.00', paidPrice: '190.00', selectedToppings: [{ id: 'T-OAT', name: 'Yulaf sütü', price: '20.00', quantity: 1, type: 'EXTRA', children: [] }], comment: null }],
    callbackUrls: { orderAcceptedUrl: `${fake.url}/cb/accepted/${token}`, orderRejectedUrl: `${fake.url}/cb/rejected/${token}`, orderPickedUpUrl: `${fake.url}/cb/pickedup/${token}`, orderPreparedUrl: `${fake.url}/cb/prepared/${token}` },
    localInfo: { platform: 'Yemeksepeti', platformKey: 'YS_TR' },
    ...over,
  };
}
const inboxOrder = (o: DhOrder): InboxItem => ({ id: `in-${o.token}`, kind: 'order', remoteId: 'POS_1', receivedAt: Date.now(), order: o });
const list = () => h.ok<{ orders: PlatformOrderDTO[] }>('kasa', 'GET', '/platforms').then((r) => r.orders);
const byExt = async (ext: string) => (await list()).find((o) => o.payload.externalId === ext)!;

describe('Delivery Hero siparişi → tek biçim', () => {
  it('Yemeksepeti kuryesi (riderPickupTime dolu): online ödendi, teslimat ücreti platformun, seçenek birim fiyata', async () => {
    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    const p = fromDhOrder(dhOrder(), 'POS_1');
    expect(p).toMatchObject({ platform: 'yemeksepeti', courier: 'platform', platformCollects: true, paymentLabel: 'Online online', subtotal: 19000, restaurantDiscount: 0, platformDiscount: 0, customerTotal: 19000 });
    expect(p.lines).toEqual([{ externalId: 'latte-m', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: ['Yulaf sütü'], note: null }]);
    expect(p.customer).toEqual({ name: 'Ayşe K.', phone: null, address: null });
    expect(p.expiresAt).toBeGreaterThan(Date.now());
    expect((p.platformData as { callbackUrls: { orderAcceptedUrl: string } }).callbackUrls.orderAcceptedUrl).toContain('/cb/accepted/');
  });

  it('kendi kuryemiz (riderPickupTime boş): kapıda ödeme kasada, adres ve telefon gelir, teslimat ücreti bizim satırımız, VENDOR sponsorluğu bizden', async () => {
    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    const o = dhOrder({
      delivery: { address: { street: 'Gül Sk.', number: '4', flatNumber: '3', floor: '2', deliveryMainArea: 'Tuzla', city: 'İstanbul', deliveryInstructions: 'Zile basmayın' }, expectedDeliveryTime: null, riderPickupTime: null },
      payment: { status: 'pending', type: 'cash' },
      discounts: [{ name: 'İlk sipariş', amount: '30.00', sponsorships: [{ sponsor: 'PLATFORM', amount: '20.00' }, { sponsor: 'VENDOR', amount: '10.00' }] }],
      price: { deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '185.00', collectFromCustomer: '185.00' },
      products: [{ id: 'P-LATTE', remoteCode: 'latte-m', name: 'Latte', quantity: '1', unitPrice: '170.00', paidPrice: '190.00', selectedToppings: [{ name: 'Yulaf sütü', price: '20.00', quantity: 1 }], discounts: [{ name: 'İlk sipariş', amount: '30.00', sponsorships: [{ sponsor: 'PLATFORM', amount: '20.00' }, { sponsor: 'VENDOR', amount: '10.00' }] }] }],
    });
    const p = fromDhOrder(o, 'POS_1');
    expect(p).toMatchObject({ courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda cash' });
    expect(p.lines.map((l) => l.name)).toEqual(['Latte', 'Teslimat ücreti']);
    // Kalemler 190 + 25 = 215; bizden 10; müşteri 185 → platformdan 20
    expect([p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal]).toEqual([21500, 1000, 2000, 18500]);
    expect(p.customer.phone).toBe('+90 555 000 00 00');
    expect(p.customer.address).toBe('Gül Sk. 4, kat 2, daire 3, Tuzla, İstanbul, Zile basmayın');
  });

  it('gel-al: teslim kodu notta, ileri tarihli sipariş saatli, test siparişi kodda', async () => {
    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const p = fromDhOrder(dhOrder({ expeditionType: 'pickup', delivery: null, pickup: { pickupTime: at, pickupCode: 'K7' }, preOrder: true, test: true, price: { deliveryFees: [], grandTotal: '190.00' } }), 'POS_1');
    expect(p).toMatchObject({ courier: 'gelal', platformCollects: true, scheduledFor: Date.parse(at), note: 'TEST SİPARİŞİ · Teslim kodu K7' });
    expect(p.code.startsWith('TEST ')).toBe(true);
  });
});

describe('canlı bağlantı', () => {
  let ext = '';

  it('anahtarlar tanımlı: canlı seçilir; aktarıcıdan çekilen sipariş onay bekler, kabul süresi platformun, kayıt silinir', async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'canli', prepMinutes: 15 });
    const o = dhOrder();
    fake.inbox.push(inboxOrder(o));
    const r = await live.pollPlatform('yemeksepeti');
    expect(r).toEqual({ created: 1, cancelled: 0 });
    expect(fake.acked).toContain(`in-${o.token}`);
    expect(fake.inbox).toHaveLength(0);
    ext = o.token;
    const row = await byExt(ext);
    expect(row.status).toBe('bekliyor');
    expect(row.expiresAt).toBe(Date.parse(o.expiryDate!));
    expect(row.payload.code).toBe(o.shortCode);
    const products = (await h.ok<{ products: PlatformProductDTO[] }>('patron', 'GET', '/platforms/products')).products;
    expect(products.find((x) => x.platform === 'yemeksepeti' && x.externalId === 'latte-m')?.name).toBe('Latte');
  });

  it('kabul: önce middleware (geri çağrı adresi), jeton bir kez alınır; acceptanceTime ve remoteOrderId gider', async () => {
    const row = await byExt(ext);
    const res = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    expect(fake.count('POST /v2/login')).toBe(1);
    expect(fake.calls).toContain(`POST /cb/accepted/${ext}`);
    const body = fake.bodies.accepted?.at(-1) as { status: string; acceptanceTime: string; remoteOrderId: string };
    expect(body).toMatchObject({ status: 'order_accepted', remoteOrderId: ext });
    expect(Date.parse(body.acceptanceTime) - Date.now()).toBeGreaterThan(10 * 60_000);
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${res.orderId}`);
    expect(o).toMatchObject({ type: 'paket', platform: 'yemeksepeti', status: 'acik' });
    expect(o.items[0]).toMatchObject({ name: 'Latte', unitPrice: 19000 });
  });

  it('Yemeksepeti kuryesi: hazır → preparation-completed; yolda platforma gitmez, platform ödemesiyle kapanır', async () => {
    const row = await byExt(ext);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'hazir' });
    await live.reconcileNotifications();
    expect(fake.calls).toContain(`POST /cb/prepared/${ext}`);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'yolda' });
    await live.reconcileNotifications();
    expect(fake.calls.filter((c) => c === `POST /cb/pickedup/${ext}`)).toHaveLength(0);
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`);
    expect(closed.status).toBe('kapali');
    expect(closed.payments[0]).toMatchObject({ methodName: 'Yemeksepeti', amount: 19000 });
  });

  it('kendi kuryemiz: hazır platforma gitmez, yolda → order_picked_up (bir kez); jeton süresi dolunca yeniden giriş', async () => {
    const o = dhOrder({ delivery: { address: { street: 'Lale Sk.', number: '9', city: 'İstanbul' }, expectedDeliveryTime: null, riderPickupTime: null }, payment: { status: 'pending', type: 'cash' }, price: { deliveryFees: [], grandTotal: '190.00' } });
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    const row = await byExt(o.token);
    // Middleware eski jetonu tanımıyor: 401 → bir kez yeniden giriş
    fake.tokens.clear();
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.count('POST /v2/login')).toBe(2);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'hazir' });
    await live.reconcileNotifications();
    expect(fake.calls.filter((c) => c === `POST /cb/prepared/${o.token}`)).toHaveLength(0);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    await live.reconcileNotifications();
    expect(fake.calls.filter((c) => c === `POST /cb/pickedup/${o.token}`)).toHaveLength(1);
    expect(fake.bodies.pickedup?.at(-1)).toEqual({ status: 'order_picked_up' });
    // Kapıda nakit: adisyon açık, kasada tahsil edilir
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
  });

  it('ret: order_rejected neden koduyla; middleware 409 dönerse yerelde reddedilmez', async () => {
    const o = dhOrder();
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    const row = await byExt(o.token);
    fake.statusFor.rejected = [409];
    const fail = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Ürün tükendi' });
    expect([fail.status, fail.json.code]).toEqual([502, 'platform_unreachable']);
    expect((await byExt(o.token)).status).toBe('bekliyor');
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Ürün tükendi' });
    expect(fake.bodies.rejected?.at(-1)).toEqual({ status: 'order_rejected', reason: 'ITEM_UNAVAILABLE', message: 'Ürün tükendi' });
    expect((await byExt(o.token)).status).toBe('ret');
  });

  it('platformun iptali (ORDER_CANCELLED) gelen kutusundan: kabul edilmiş adisyon iptal olur; başka restoranın kaydı atlanır', async () => {
    const o = dhOrder();
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    const row = await byExt(o.token);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    fake.inbox.push({ id: 'st-1', kind: 'status', remoteId: 'POS_1', receivedAt: Date.now(), remoteOrderId: o.token, status: 'ORDER_CANCELLED', message: 'Customer cancelled' });
    fake.inbox.push({ id: 'st-2', kind: 'status', remoteId: 'POS_1', receivedAt: Date.now(), remoteOrderId: o.token, status: 'COURIER_ARRIVED_AT_VENDOR' });
    fake.inbox.push(inboxOrder(dhOrder()));
    fake.inbox[2] = { ...fake.inbox[2]!, remoteId: 'BASKA' } as InboxItem;
    const r = await live.pollPlatform('yemeksepeti');
    expect(r).toEqual({ created: 0, cancelled: 1 });
    expect((await byExt(o.token)).status).toBe('iptal');
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect(fake.inbox).toHaveLength(0);
  });

  it('gelen kutusu kayıt kasada yazıldıktan sonra silinir; bozuk sipariş ötekileri durdurmaz, bir kez denetim kaydına düşer', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const good = dhOrder();
    const bad = dhOrder({ products: 5 as unknown as DhOrder['products'] });
    fake.inbox.push(inboxOrder(bad), inboxOrder(good));
    let atAck: unknown = null;
    fake.beforeAck = () => {
      atAck = db.select({ id: schema.platformOrders.id }).from(schema.platformOrders).where(eq(schema.platformOrders.externalId, good.token)).get() ?? null;
    };
    const r = await live.pollPlatform('yemeksepeti');
    fake.beforeAck = undefined;
    expect(r?.created).toBe(1);
    expect(atAck).not.toBeNull();
    expect(fake.acked).toEqual(expect.arrayContaining([`in-${bad.token}`, `in-${good.token}`]));
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.filter((a) => a.action === 'platform.package_invalid' && a.message.includes(bad.token))).toHaveLength(1);
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(good.token)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('kasada iptal edilen kabul edilmiş sipariş Yemeksepeti\'ne gönderilmez (kabulden sonraki neden kodları kasanın iptalini karşılamaz): alarm, uygulamadan iptal', async () => {
    const o = dhOrder();
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${(await byExt(o.token)).id}/accept`, {});
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    await live.reconcileNotifications();
    await live.reconcileNotifications();
    expect(fake.calls.filter((c) => c === `POST /cb/rejected/${o.token}`)).toHaveLength(0);
    const audit = await h.ok<{ action: string; severity: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    const alarm = audit.find((a) => a.action === 'platform.cancel_unsynced' && a.orderId === orderId);
    expect(alarm?.severity).toBe('alarm');
    expect(alarm?.message).toMatch(/Yemeksepeti uygulamasından iptal edin/);
    expect((await byExt(o.token)).status).toBe('iptal');
  });

  it('test siparişi TEST_ORDER koduyla reddedilir', async () => {
    const o = dhOrder({ test: true });
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(o.token)).id}/reject`, { reason: 'Çok yoğunuz' });
    expect(fake.bodies.rejected?.at(-1)).toMatchObject({ status: 'order_rejected', reason: 'TEST_ORDER' });
  });

  it('aktarıcı erişilemezse yoklama hatası kaydedilir; anahtar eksikse canlı seçilemez', async () => {
    fake.statusFor.inbox = [503];
    await expect(live.pollPlatform('yemeksepeti')).rejects.toThrow(/gelen kutusu/);
    const status = await h.ok<{ live: Record<string, { lastError: string | null; configured: boolean }> }>('kasa', 'GET', '/platforms');
    expect(status.live.yemeksepeti.lastError).toMatch(/yoklanamadı/);
    const { yemeksepetiConfigured } = await import('../server/delivery/yemeksepeti');
    expect(yemeksepetiConfigured({ mwUrl: 'x', username: 'u', password: 'p', remoteId: 'r', cloudUrl: '', cloudSecret: '' })).toBe(false);
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'kapali' });
  });
});

describe('Yemeksepeti gözden geçirme bulguları', () => {
  beforeAll(async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'canli' });
  });
  const audit = () => h.ok<{ action: string; severity: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=100');
  async function arrive(o: DhOrder) {
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('yemeksepeti');
    return byExt(o.token);
  }

  it('dolaylı akış (geri çağrı adresi yok): sipariş tablette kabul edilmiş gelir; Kabul platforma gitmez, süre işlemez, ret kasadan yapılmaz', async () => {
    const o = dhOrder({ callbackUrls: {}, delivery: { address: { street: 'Lale Sk.', number: '9' }, expectedDeliveryTime: null, riderPickupTime: null }, payment: { status: 'pending', type: 'cash' }, price: { deliveryFees: [], grandTotal: '190.00' } });
    const row = await arrive(o);
    expect(row.payload.preAccepted).toBe(true);
    expect(row.expiresAt).toBeNull();
    const rejected = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect([rejected.status, rejected.json.code]).toEqual([409, 'pre_accepted']);
    const before = fake.calls.length;
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.calls.slice(before).filter((c) => !c.includes('/v2/login'))).toEqual([]);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    await live.reconcileNotifications();
    // Alındı adresi de yok: gönderilmez (genel durum ucuna düşülmez)
    expect(fake.calls.some((c) => c.includes(o.token))).toBe(false);
  });

  it('ileri tarihli gel-al: saat adisyona geçer, kabul saati müşterinin alma saatidir', async () => {
    const pickupTime = new Date(Date.now() + 5 * 3600_000).toISOString();
    const o = dhOrder({ expeditionType: 'pickup', preOrder: true, pickup: { pickupTime, pickupCode: 'K7' }, delivery: null, price: { grandTotal: '190.00' } });
    const row = await arrive(o);
    expect(row.payload.scheduledFor).toBe(Date.parse(pickupTime));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).scheduledFor).toBe(new Date(Date.parse(pickupTime)).toISOString());
    expect((fake.bodies.accepted?.at(-1) as { acceptanceTime: string }).acceptanceTime).toBe(new Date(Date.parse(pickupTime)).toISOString());
  });

  it('ücretler adlarıyla ayrı satır (KDV %20, mutfağa gitmez) ve eşlenebilir; gel-alda kapıda alınacak tutar collectFromCustomer', async () => {
    const o = dhOrder({
      expeditionType: 'pickup',
      delivery: null,
      payment: { status: 'pending', type: 'cash' },
      price: { deliveryFees: [{ name: 'packaging', value: '5.00' }], grandTotal: '195.00', collectFromCustomer: '195.00' },
    });
    const row = await arrive(o);
    expect(row.payload.lines.at(-1)).toMatchObject({ name: 'Ambalaj ücreti', unitPrice: 500, kind: 'fee' });
    expect(row.payload).toMatchObject({ platformCollects: false, subtotal: 19500, customerTotal: 19500, platformDiscount: 0 });
    expect(row.unmatched).toEqual([]);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const ord = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect(ord.total).toBe(19500);
    const fee = ord.items.find((i) => i.unitPrice === 500)!;
    expect(fee).toMatchObject({ name: 'Platform ücreti', kdvRate: 20 });
    const products = (await h.ok<{ products: { externalId: string; name: string }[] }>('patron', 'GET', '/platforms/products')).products;
    expect(products.some((x) => x.externalId === 'ys-ucret:ambalaj ücreti')).toBe(true);
  });

  it('Yemeksepeti kuryesi kapıda nakit alıp kasaya payRestaurant bırakıyorsa tahsilat kasada; platform kendiliğinden kapatmaz', async () => {
    const o = dhOrder({ payment: { status: 'pending', type: 'cash' }, price: { deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '215.00', payRestaurant: '190.00' } });
    const row = await arrive(o);
    expect(row.payload).toMatchObject({ courier: 'platform', platformCollects: false, customerTotal: 19000, platformDiscount: 0 });
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    const ord = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect([ord.status, ord.paid]).toEqual(['acik', 0]);
  });

  it('middleware alan adında olmayan geri çağrı adresine jeton gitmez', async () => {
    const o = dhOrder();
    o.callbackUrls = { ...o.callbackUrls, orderAcceptedUrl: `https://kotu.example/cb/${o.token}` };
    const row = await arrive(o);
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/güvenilmedi/);
  });

  it('başka restoranın kaydı sessizce silinmez: bir kez alarm; test siparişi kabul edilmez; süresi geçmiş sipariş taze süre almaz', async () => {
    const other = dhOrder();
    fake.inbox.push({ ...inboxOrder(other), remoteId: 'BASKA_RESTORAN' });
    await live.pollPlatform('yemeksepeti');
    expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes('BASKA_RESTORAN'))).toHaveLength(1);
    const t = await arrive(dhOrder({ test: true }));
    const r = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${t.id}/accept`, {});
    expect([r.status, r.json.code]).toEqual([409, 'test_order']);
    const late = await arrive(dhOrder({ expiryDate: new Date(Date.now() - 60_000).toISOString() }));
    expect(late.status).toBe('suresi_doldu');
  });

  it('Kapalı modda gelen kutusundaki yeni sipariş silinmez (Canlı\'ya dönünce gelir); iptal uygulanır', async () => {
    const accepted = await arrive(dhOrder());
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${accepted.id}/accept`, {});
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'kapali' });
    const waiting = dhOrder();
    fake.inbox.push(inboxOrder(waiting));
    fake.inbox.push({ id: 'st-kapali', kind: 'status', remoteId: 'POS_1', receivedAt: Date.now(), remoteOrderId: accepted.payload.externalId, status: 'ORDER_CANCELLED' });
    await live.pollPlatform('yemeksepeti');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect(fake.inbox.map((i) => i.id)).toEqual([`in-${waiting.token}`]);
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'canli' });
    await live.pollPlatform('yemeksepeti');
    expect((await byExt(waiting.token)).status).toBe('bekliyor');
    expect(fake.inbox).toHaveLength(0);
  });
});
