import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformLiveStatus, PlatformOrderDTO, PlatformProductDTO } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import type { GetirOrder, InboxItem } from '../server/delivery/getir';
import { type FakeGetir, startFakeGetir } from './fake-getir';
import { startApp, type Harness } from './harness';

/**
 * Getir Yemek canlı bağlantısı (kasa tarafı): Getir siparişi → tek biçim, aktarıcıdan çekme ve silme, yedek olarak
 * Getir'in onaysız ve iptal listeleri (iki yoldan gelen aynı sipariş tekilleşir), kabul önce Getir'e (verify /
 * verify-scheduled), ret iptal seçeneğiyle, aşamalar kurye türüne göre (prepare → handover / deliver, aralarında
 * Getir'in istediği bekleme), platform iptali, kasada iptal, jeton yenileme, ağ hatası Türkçe. Sahte sunucular
 * tests/fake-getir.ts.
 */
const KEYS = { appSecretKey: 'uygulama-anahtari', restaurantSecretKey: 'restoran-anahtari' };
const CLOUD_SECRET = 'g'.repeat(40);
/** Testte Getir'in "aşamalar arasında 1 dk" kuralı kısaltılır */
const GAP_MS = 300;
let h: Harness;
let fake: FakeGetir;
let live: typeof import('../server/delivery/live');
let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  fake = await startFakeGetir(KEYS);
  h = await startApp({ GETIR_APP_SECRET_KEY: KEYS.appSecretKey, GETIR_RESTAURANT_SECRET_KEY: KEYS.restaurantSecretKey, GETIR_API_URL: fake.url, LAFPOS_CLOUD_URL: fake.url, LAFPOS_CLOUD_SECRET: CLOUD_SECRET });
  live = await import('../server/delivery/live');
  const { getirAdapter } = await import('../server/delivery/getir');
  const { setAdapter } = await import('../server/delivery/registry');
  setAdapter('getir', getirAdapter({ ...KEYS, apiUrl: fake.url, cloudUrl: fake.url, cloudSecret: CLOUD_SECRET, stepGapMs: GAP_MS, backupEveryMs: 0 }));
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await fake.close();
});

function gOrder(over: Partial<GetirOrder> = {}): GetirOrder {
  const id = `ord-${++seq}`;
  return {
    id,
    status: 400,
    isScheduled: false,
    confirmationId: String(1000 + seq),
    client: {
      id: 'cl-1',
      name: 'Ayşe K.',
      contactPhoneNumber: '+90 (850) 000-00000 / 123456',
      clientPhoneNumber: '+90 (850) 000-00000 / 123456',
      deliveryAddress: { address: 'Gül Sk. 4', aptNo: 'A Blok', floor: '2', doorNo: '3', city: 'İstanbul', district: 'Tuzla', description: 'Zile basmayın' },
    },
    products: [
      {
        id: 'line-1',
        product: 'prd-latte',
        count: 1,
        name: { tr: 'Latte', en: 'Latte' },
        price: 170,
        optionPrice: 20,
        priceWithOption: 190,
        totalPrice: 170,
        totalOptionPrice: 20,
        totalPriceWithOption: 190,
        displayInfo: { title: { tr: 'Latte', en: 'Latte' }, options: { tr: ['Yulaf sütü'], en: ['Oat milk'] } },
        note: '',
      },
    ],
    clientNote: '',
    doNotKnock: false,
    dropOffAtDoor: false,
    totalPrice: 190,
    totalDiscountedPrice: 190,
    checkoutDate: new Date().toISOString(),
    deliveryType: 1,
    paymentMethod: 1,
    paymentMethodText: { tr: 'MasterPass', en: 'MasterPass' },
    restaurant: { id: 'rest-1', name: "L'Affogato" },
    isQueued: false,
    ...over,
  };
}
const inboxOrder = (o: GetirOrder): InboxItem => ({ id: `in-${o.id}`, kind: 'order', receivedAt: Date.now(), order: o });
const inboxCancel = (orderId: string, reason = 'Müşteri iptal etti'): InboxItem => ({ id: `cn-${orderId}`, kind: 'cancel', receivedAt: Date.now(), orderId, reason, note: '' });
const list = () => h.ok<{ orders: PlatformOrderDTO[]; live: Record<string, PlatformLiveStatus> }>('kasa', 'GET', '/platforms');
const byExt = async (ext: string) => (await list()).orders.find((o) => o.payload.externalId === ext)!;
const audit = () => h.ok<{ action: string; severity: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=200');
/** Kendi kuryemiz, kapıda nakit */
const ownCourierCash: Partial<GetirOrder> = { deliveryType: 2, paymentMethod: 4, paymentMethodText: { tr: 'Nakit', en: 'Cash' } };

/** Siparişi aktarıcının gelen kutusuna koyar, yoklar, kaydını döner */
async function arrive(o: GetirOrder) {
  fake.inbox.push(inboxOrder(o));
  await live.pollPlatform('getir');
  return byExt(o.id);
}

describe('Getir siparişi → tek biçim', () => {
  it('Getir kuryesi, MasterPass: online, tahsilat platformun; seçenek birim fiyatta ve notta; kabul süresi sipariş saatinden 5 dk', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const o = gOrder();
    const p = fromGetirOrder(o);
    expect(p).toMatchObject({ platform: 'getir', courier: 'platform', platformCollects: true, paymentLabel: 'Online MasterPass', code: o.confirmationId, subtotal: 19000, restaurantDiscount: 0, platformDiscount: 0, customerTotal: 19000, test: false });
    expect(p.lines).toEqual([{ externalId: 'prd-latte', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: ['Yulaf sütü'], note: null }]);
    // Getir kuryesinde adres ve telefon kasaya gelmez
    expect(p.customer).toEqual({ name: 'Ayşe K.', phone: null, address: null });
    expect(p.expiresAt).toBe(Date.parse(o.checkoutDate!) + 5 * 60_000);
    expect(p.platformData).toMatchObject({ status: 400, deliveryType: 1, restaurantId: 'rest-1' });
  });

  it('kendi kuryemiz, kapıda nakit: tahsilat kasada, adres ve telefon gelir, Getir\'in Türkçe ödeme adı, kapı notları', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const p = fromGetirOrder(gOrder({ ...ownCourierCash, clientNote: 'Şekersiz olsun', doNotKnock: true, dropOffAtDoor: true }));
    expect(p).toMatchObject({ courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda Nakit', note: 'Şekersiz olsun · Kapıyı çalmayın · Kapıya bırakın' });
    expect(p.customer.phone).toBe('+90 (850) 000-00000 / 123456');
    expect(p.customer.address).toBe('Gül Sk. 4, A Blok, kat 2, daire 3, Tuzla, İstanbul, Zile basmayın');
  });

  it('indirim: Getir kimin karşıladığını yazmaz, restoran kampanyası sayılır; müşteri totalDiscountedPrice öder', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const o = gOrder({
      products: [{ product: 'prd-latte', count: 2, name: { tr: 'Latte' }, price: 170, optionPrice: 20, priceWithOption: 190, totalPriceWithOption: 380, discountedPriceWithOption: 160, totalDiscountedPriceWithOption: 320 }],
      totalPrice: 380,
      totalDiscountedPrice: 320,
    });
    const p = fromGetirOrder(o);
    expect([p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal]).toEqual([38000, 6000, 0, 32000]);
    // Kalemlerden fazlası (anlaşılamayan fark) platformun payı: eşitlik bozulmaz
    const q = fromGetirOrder(gOrder({ totalPrice: 190, totalDiscountedPrice: 150 }));
    expect([q.subtotal, q.restaurantDiscount, q.platformDiscount, q.customerTotal]).toEqual([19000, 4000, 0, 15000]);
    expect(q.subtotal - q.restaurantDiscount - q.platformDiscount).toBe(q.customerTotal);
  });

  it('ileri tarihli (325): saat adisyona; saat dilimi yazılmamış GMT saati UTC sayılır; eksik alanlarda fiyat ürün + seçenek, adet 1, kod kimlikten', async () => {
    const { fromGetirOrder, toMs } = await import('../server/delivery/getir');
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const p = fromGetirOrder(gOrder({ status: 325, isScheduled: true, scheduledDate: at }));
    expect(p.scheduledFor).toBe(Date.parse(at));
    expect(toMs('2026-10-28 09:30:00')).toBe(Date.parse('2026-10-28T09:30:00Z'));
    expect(toMs('2026-10-28T09:30:00+03:00')).toBe(Date.parse('2026-10-28T06:30:00Z'));
    const q = fromGetirOrder({ id: 'abcdef123456', products: [{ name: { tr: 'Çay' }, price: 12.5, optionPrice: 0 }], paymentMethod: 3 });
    expect(q.lines[0]).toMatchObject({ externalId: null, name: 'Çay', qty: 1, unitPrice: 1250 });
    expect([q.code, q.customerTotal, q.paymentLabel, q.courier, q.expiresAt]).toEqual(['3456', 1250, 'Kapıda Kredi / Banka Kartı', 'restoran', undefined]);
  });

  it('ret nedeni → Getir iptal seçeneği: anahtar kelimeyle, yoksa "diğer", o da yoksa ilk', async () => {
    const { pickCancelOption } = await import('../server/delivery/getir');
    expect(pickCancelOption(fake.cancelOptions, 'Ürün tükendi')?.id).toBe('cr-1');
    expect(pickCancelOption(fake.cancelOptions, 'Çok yoğunuz')?.id).toBe('cr-2');
    expect(pickCancelOption(fake.cancelOptions, 'Kapanmak üzereyiz')?.id).toBe('cr-3');
    expect(pickCancelOption(fake.cancelOptions, 'Adres hizmet alanı dışında')?.id).toBe('cr-4');
    expect(pickCancelOption(fake.cancelOptions, 'Müşteri vazgeçti')?.id).toBe('cr-9');
    expect(pickCancelOption([{ id: 'x', message: 'Bilinmeyen' }], 'Ürün tükendi')?.id).toBe('x');
    expect(pickCancelOption([], 'Ürün tükendi')).toBeNull();
  });
});

describe('canlı bağlantı', () => {
  let ext = '';

  it('anahtarlar tanımlı: canlı seçilir; aktarıcıdan çekilen sipariş onay bekler, kabul süresi sipariş saatinden, kayıt silinir', async () => {
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'canli', prepMinutes: 15 });
    const o = gOrder();
    fake.inbox.push(inboxOrder(o));
    const r = await live.pollPlatform('getir');
    expect(r).toEqual({ created: 1, cancelled: 0 });
    expect(fake.acked).toContain(`in-${o.id}`);
    expect(fake.inbox).toHaveLength(0);
    // Yedek yoklama da koştu (girişle), gelen kutusu boşken bile
    expect(fake.count('POST /auth/login')).toBe(1);
    expect(fake.count('POST unapproved')).toBe(1);
    ext = o.id;
    const row = await byExt(ext);
    expect(row.status).toBe('bekliyor');
    expect(row.expiresAt).toBe(Date.parse(o.checkoutDate!) + 5 * 60_000);
    expect(row.payload.code).toBe(o.confirmationId);
    const products = (await h.ok<{ products: PlatformProductDTO[] }>('patron', 'GET', '/platforms/products')).products;
    expect(products.find((x) => x.platform === 'getir' && x.externalId === 'prd-latte')?.name).toBe('Latte');
  });

  it('kabul önce Getir\'e (verify): Getir 500 dönerse yerelde kabul edilmez; sonra kabul, adisyon platform fiyatıyla', async () => {
    const row = await byExt(ext);
    fake.statusFor.verify = [500];
    const fail = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    expect([fail.status, fail.json.code]).toEqual([502, 'platform_unreachable']);
    expect((await byExt(ext)).status).toBe('bekliyor');
    const res = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    expect(fake.count(`POST ${ext} verify`)).toBe(2);
    expect(fake.count('POST /auth/login')).toBe(1);
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${res.orderId}`);
    expect(o).toMatchObject({ type: 'paket', platform: 'getir', status: 'acik' });
    expect(o.items[0]).toMatchObject({ name: 'Latte', unitPrice: 19000 });
  });

  it('Getir kuryesi: hazır → prepare (kabulden 1 dk geçmeden sessizce bekler), yolda → handover; platform ödemesiyle kapanır', async () => {
    const row = await byExt(ext);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'hazir' });
    // Kabulün hemen ardından: Getir aralık ister, bildirim hata sayılmaz
    await live.reconcileNotifications();
    expect(fake.count(`POST ${ext} prepare`)).toBe(0);
    expect((await byExt(ext)).lastError).toBeNull();
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${ext} prepare`)).toBe(1);
    await h.ok('kasa', 'POST', `/orders/${row.orderId}/delivery`, { deliveryStatus: 'yolda' });
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`);
    expect(closed.status).toBe('kapali');
    expect(closed.payments[0]).toMatchObject({ methodName: 'Getir Yemek', amount: 19000 });
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${ext} handover`)).toBe(1);
    expect(fake.count(`POST ${ext} deliver`)).toBe(0);
    expect((await audit()).some((a) => a.action === 'platform.notify_failed' && a.orderId === row.orderId)).toBe(false);
  });

  it('kendi kuryemiz: hazır → prepare, yolda Getir\'e gitmez, teslim → deliver; jeton reddedilince bir kez yeniden giriş; kapıda nakit kasada', async () => {
    const o = gOrder(ownCourierCash);
    const row = await arrive(o);
    // Getir eski jetonu tanımıyor: 401 → bir kez yeniden giriş
    fake.tokens.clear();
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.count('POST /auth/login')).toBe(2);
    await sleep(GAP_MS + 50);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'hazir' });
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} handover`)).toBe(0);
    expect(fake.count(`POST ${o.id} deliver`)).toBe(0);
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'teslim' });
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} deliver`)).toBe(1);
    // Kapıda nakit: adisyon açık, kasada tahsil edilir
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
  });

  it('ileri tarihli sipariş verify-scheduled ile kabul edilir, saati adisyona geçer', async () => {
    const at = new Date(Date.now() + 4 * 3600_000).toISOString();
    const row = await arrive(gOrder({ status: 325, isScheduled: true, scheduledDate: at }));
    expect(row.payload.scheduledFor).toBe(Date.parse(at));
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.count(`POST ${row.payload.externalId} verify-scheduled`)).toBe(1);
    expect(fake.count(`POST ${row.payload.externalId} verify`)).toBe(0);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).scheduledFor).toBe(new Date(Date.parse(at)).toISOString());
  });

  it('ret: iptal seçeneği Getir\'den alınır, cancel neden kimliği ve notla; Getir 500 dönerse yerelde reddedilmez', async () => {
    const o = gOrder();
    const row = await arrive(o);
    fake.statusFor.cancel = [500];
    const fail = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Ürün tükendi' });
    expect([fail.status, fail.json.code]).toEqual([502, 'platform_unreachable']);
    expect((await byExt(o.id)).status).toBe('bekliyor');
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Ürün tükendi' });
    expect(fake.count(`GET ${o.id} cancel-options`)).toBe(2);
    expect(fake.bodies.cancel?.at(-1)).toEqual({ cancelReasonId: 'cr-1', cancelNote: 'Ürün tükendi' });
    expect((await byExt(o.id)).status).toBe('ret');
  });

  it('yedek yoklama: Getir\'in onaysız listesindeki sipariş de gelir, aktarıcıyla aynı sipariş tekilleşir; iptal listesi kabul edilmiş adisyonu iptal eder', async () => {
    const onlyBackup = gOrder();
    const both = gOrder();
    fake.unapproved = [onlyBackup, both];
    fake.inbox.push(inboxOrder(both));
    const r = await live.pollPlatform('getir');
    expect(r).toEqual({ created: 2, cancelled: 0 });
    expect((await list()).orders.filter((x) => x.payload.externalId === both.id)).toHaveLength(1);
    expect(fake.inbox).toHaveLength(0);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${(await byExt(onlyBackup.id)).id}/accept`, {});
    fake.unapproved = [];
    fake.cancelledList = [{ ...onlyBackup, status: 900 }];
    expect((await live.pollPlatform('getir'))?.cancelled).toBe(1);
    fake.cancelledList = [];
    expect((await byExt(onlyBackup.id)).status).toBe('iptal');
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(both.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('platformun iptali aktarıcıdan (cancelOrder): kabul edilmiş adisyon iptal olur, platform ödemesi geri; başka restoranın siparişi atlanır, bir kez alarm', async () => {
    const o = gOrder();
    const row = await arrive(o);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`)).status).toBe('kapali');
    const other = gOrder({ restaurant: { id: 'BASKA_RESTORAN' } });
    fake.inbox.push(inboxCancel(o.id), inboxOrder(other));
    const r = await live.pollPlatform('getir');
    expect(r).toEqual({ created: 0, cancelled: 1 });
    expect((await byExt(o.id)).status).toBe('iptal');
    const cancelled = await h.ok<OrderDTO>('patron', 'GET', `/orders/${orderId}`);
    expect(cancelled.status).toBe('iptal');
    expect(cancelled.payments[0]?.refundedAt).not.toBeNull();
    expect(fake.inbox).toHaveLength(0);
    await live.pollPlatform('getir');
    expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes('BASKA_RESTORAN'))).toHaveLength(1);
  });

  it('kasada iptal edilen kabul edilmiş sipariş Getir\'e cancel ile gider; Getir iptal seçeneği vermiyorsa alarm, uygulamadan iptal', async () => {
    const first = await arrive(gOrder());
    const a = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${first.id}/accept`, {});
    await h.ok('patron', 'POST', `/orders/${a.orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    await live.reconcileNotifications();
    expect(fake.count(`POST ${first.payload.externalId} cancel`)).toBe(1);
    expect(fake.bodies.cancel?.at(-1)).toEqual({ cancelReasonId: 'cr-9', cancelNote: 'Müşteri vazgeçti' });
    expect((await byExt(first.payload.externalId)).status).toBe('iptal');
    expect((await audit()).some((x) => x.action === 'platform.cancel_sent' && x.orderId === a.orderId)).toBe(true);

    const second = await arrive(gOrder());
    const b = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${second.id}/accept`, {});
    await h.ok('patron', 'POST', `/orders/${b.orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    const options = fake.cancelOptions;
    fake.cancelOptions = [];
    await live.reconcileNotifications();
    await live.reconcileNotifications();
    fake.cancelOptions = options;
    expect(fake.count(`POST ${second.payload.externalId} cancel`)).toBe(0);
    const alarm = (await audit()).find((x) => x.action === 'platform.cancel_unsynced' && x.orderId === b.orderId);
    expect(alarm?.severity).toBe('alarm');
    expect(alarm?.message).toMatch(/platform uygulamasından iptal edin/);
    expect((await byExt(second.payload.externalId)).status).toBe('iptal');
  });

  it('Getir panelinden zaten onaylanmış sipariş (hata kodu 2): kasada yalnız adisyon açılır', async () => {
    const row = await arrive(gOrder());
    fake.statusFor.verify = [{ status: 400, code: 2 }];
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
    expect(await byExt(row.payload.externalId)).toMatchObject({ status: 'kabul', lastError: null });
  });

  it('Getir\'de test bayrağı yok: sipariş test sayılmaz, kabul edilir (test ortamı gerçek akışla denenir)', async () => {
    const row = await arrive(gOrder());
    expect(row.payload.test).toBe(false);
    const r = await h.call('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(r.status).toBe(200);
  });

  it('süresi geçmiş sipariş (5 dk) taze süre almaz; bozuk kayıt ötekileri durdurmaz, bir kez denetim kaydına düşer; silme kayıt yazıldıktan sonra', async () => {
    const late = await arrive(gOrder({ checkoutDate: new Date(Date.now() - 6 * 60_000).toISOString() }));
    expect(late.status).toBe('suresi_doldu');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const good = gOrder();
    const bad = gOrder({ products: 5 as unknown as GetirOrder['products'] });
    fake.inbox.push(inboxOrder(bad), inboxOrder(good));
    let atAck: unknown = null;
    fake.beforeAck = () => {
      atAck = db.select({ id: schema.platformOrders.id }).from(schema.platformOrders).where(eq(schema.platformOrders.externalId, good.id)).get() ?? null;
    };
    const r = await live.pollPlatform('getir');
    fake.beforeAck = undefined;
    expect(r?.created).toBe(1);
    expect(atAck).not.toBeNull();
    expect(fake.acked).toEqual(expect.arrayContaining([`in-${bad.id}`, `in-${good.id}`]));
    await live.pollPlatform('getir');
    expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes(bad.id))).toHaveLength(1);
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(good.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('aktarıcı düşerse siparişler yedek yoldan gelir ve Yönetim uyarır; ikisi de düşerse yoklama hatası', async () => {
    const o = gOrder();
    fake.unapproved = [o];
    fake.statusFor.inbox = [503];
    const r = await live.pollPlatform('getir');
    expect(r).toEqual({ created: 1, cancelled: 0 });
    const status = (await list()).live.getir;
    expect(status.lastError).toMatch(/aktarıcı gelen kutusu alınamadı/);
    expect(status.lastError).toMatch(/doğrudan Getir/);
    expect((await audit()).some((a) => a.action === 'platform.poll_failed' && a.message.includes('Getir'))).toBe(false);
    fake.statusFor.inbox = [503];
    fake.statusFor.unapproved = [500];
    await expect(live.pollPlatform('getir')).rejects.toThrow(/aktarıcı: .*; Getir: /);
    expect((await list()).live.getir.lastError).toMatch(/yoklanamadı/);
    fake.unapproved = [];
    await live.pollPlatform('getir');
    expect((await list()).live.getir.lastError).toBeNull();
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(o.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('ağ hatası kasada Türkçe görünür ("bağlantı kurulamadı"); anahtar eksikse canlı seçilemez', async () => {
    const row = await arrive(gOrder());
    const { setAdapter, adapterFor } = await import('../server/delivery/registry');
    const { getirAdapter, getirConfigured } = await import('../server/delivery/getir');
    const real = adapterFor('getir')!;
    setAdapter('getir', getirAdapter({ ...KEYS, apiUrl: 'http://127.0.0.1:9', cloudUrl: fake.url, cloudSecret: CLOUD_SECRET, stepGapMs: GAP_MS, backupEveryMs: 0 }));
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    setAdapter('getir', real);
    expect([r.status, r.json.code]).toEqual([502, 'platform_unreachable']);
    expect(r.json.error).toMatch(/Getir Yemek: kabul bildirilemedi \(bağlantı kurulamadı\)/);
    expect(r.json.error).not.toMatch(/fetch failed/);
    expect(getirConfigured({ ...KEYS, apiUrl: 'x', cloudUrl: '', cloudSecret: '' })).toBe(false);
    expect(getirConfigured({ appSecretKey: '', restaurantSecretKey: 'r', apiUrl: 'x', cloudUrl: fake.url, cloudSecret: CLOUD_SECRET })).toBe(false);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('Kapalı modda gelen kutusundaki yeni sipariş silinmez (Canlı\'ya dönünce gelir); iptal uygulanır', async () => {
    const accepted = await arrive(gOrder());
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${accepted.id}/accept`, {});
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'kapali' });
    const waiting = gOrder();
    fake.inbox.push(inboxOrder(waiting), inboxCancel(accepted.payload.externalId));
    await live.pollPlatform('getir');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect(fake.inbox.map((i) => i.id)).toEqual([`in-${waiting.id}`]);
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'canli' });
    await live.pollPlatform('getir');
    expect((await byExt(waiting.id)).status).toBe('bekliyor');
    expect(fake.inbox).toHaveLength(0);
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(waiting.id)).id}/reject`, { reason: 'Çok yoğunuz' });
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'kapali' });
  });
});
