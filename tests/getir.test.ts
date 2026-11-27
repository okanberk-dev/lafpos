import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformLiveStatus, PlatformOrderDTO, PlatformProductDTO } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import type { GetirConfig, GetirOrder, InboxItem } from '../server/delivery/getir';
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
  h = await startApp({ GETIR_APP_SECRET_KEY: KEYS.appSecretKey, GETIR_RESTAURANT_SECRET_KEY: KEYS.restaurantSecretKey, GETIR_API_URL: fake.url, ASILPOS_CLOUD_URL: fake.url, ASILPOS_CLOUD_SECRET: CLOUD_SECRET });
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
const inboxCancel = (orderId: string, reason = 'Müşteri iptal etti'): InboxItem => ({ id: `cn-${orderId}`, kind: 'cancel', receivedAt: Date.now(), orderId, reason });
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
    // Müşteri toplamı = kalemler − bizden − platformdan; platform payı uydurulmaz
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
    // İptal seçenekleri sipariş başına saklanır (uç 10 dk'da 40 istekle sınırlı): yeniden denemede yeniden sorulmaz
    expect(fake.count(`GET ${o.id} cancel-options`)).toBe(1);
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

  it('platformun iptali aktarıcıdan (cancelOrder): kabul edilmiş adisyon iptal olur, platform ödemesi geri; başka restoranın siparişi atlanır ve silinmez, bir kez alarm', async () => {
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
    // Başka restoranın siparişi kutuda kalır (ortak kutuda o restoranın kasası alır); çekim ve silme restoranın kimliğiyle
    expect(fake.inbox.map((i) => i.id)).toEqual([`in-${other.id}`]);
    expect(fake.restoran.slice(-2)).toEqual(['rest-1', 'rest-1']);
    await live.pollPlatform('getir');
    expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes('BASKA_RESTORAN'))).toHaveLength(1);
    expect(fake.inbox.map((i) => i.id)).toEqual([`in-${other.id}`]);
    fake.inbox = [];
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

// ─── Birinci gözden geçirmenin düzeltmeleri ──────────────────────────────────

const cfg = () => ({ ...KEYS, apiUrl: fake.url, cloudUrl: fake.url, cloudSecret: CLOUD_SECRET, stepGapMs: GAP_MS, backupEveryMs: 0 });

/** Kaydın veritabanındaki satırı (DTO'da olmayan aşama ve park alanları için) */
async function dbRow(ext: string) {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.platformOrders).where(eq(schema.platformOrders.externalId, ext)).get()!;
}

async function acceptNow(o: GetirOrder) {
  const row = await arrive(o);
  const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
  return { row, orderId };
}

const delivery = (orderId: string, deliveryStatus: string) => h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus });

/** Bağdaştırıcıyı bir süreliğine değiştirir (yeniden başlatma, farklı ayar) */
async function withAdapter<T>(over: Partial<GetirConfig>, fn: () => Promise<T>): Promise<T> {
  const { setAdapter, adapterFor } = await import('../server/delivery/registry');
  const { getirAdapter } = await import('../server/delivery/getir');
  const real = adapterFor('getir')!;
  setAdapter('getir', getirAdapter({ ...cfg(), ...over }));
  try {
    return await fn();
  } finally {
    setAdapter('getir', real);
  }
}

describe('para ve ödeme (gözden geçirme)', () => {
  it('indirimsiz siparişte 0 gelen indirimli fiyat indirim sayılmaz; müşterinin ödediği iki yönde de esas', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const sum = (o: GetirOrder) => {
      const p = fromGetirOrder(o);
      return [p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal];
    };
    // Sipariş toplamında 0
    expect(sum(gOrder({ totalPrice: 190, totalDiscountedPrice: 0 }))).toEqual([19000, 0, 0, 19000]);
    // Satırda 0, sipariş 190 / 190
    const zeroLine = gOrder();
    zeroLine.products![0] = { ...zeroLine.products![0]!, discountedPriceWithOption: 0, totalDiscountedPriceWithOption: 0 };
    expect(sum(zeroLine)).toEqual([19000, 0, 0, 19000]);
    // Satır indirimi sipariş indiriminden büyük: müşteri 370 ödüyor, adisyon 300'e inmez
    const big = gOrder({ products: [{ product: 'prd-latte', count: 2, name: { tr: 'Latte' }, priceWithOption: 190, totalPriceWithOption: 380, totalDiscountedPriceWithOption: 300 }], totalPrice: 380, totalDiscountedPrice: 370 });
    expect(sum(big)).toEqual([38000, 1000, 0, 37000]);
  });

  it('müşteri kalemlerden fazla öderse fark uydurma satır olmaz, notta "Getir\'den doğrulayın" diye görünür', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const p = fromGetirOrder(gOrder({ ...ownCourierCash, totalPrice: 205, totalDiscountedPrice: 205 }));
    expect([p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal, p.lines.length]).toEqual([19000, 0, 0, 19000, 1]);
    expect(p.note).toMatch(/Getir toplamı .*205,00.*farkı Getir'den doğrulayın/);
  });

  it('sayı metin gelirse okunur (varlık ve okuma aynı kural); satır kimliği eşleme anahtarı olmaz', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const p = fromGetirOrder(gOrder({ totalPrice: '190' as unknown as number, totalDiscountedPrice: '150' as unknown as number }));
    expect([p.subtotal, p.restaurantDiscount, p.customerTotal]).toEqual([19000, 4000, 15000]);
    const q = fromGetirOrder(gOrder({ products: [{ id: 'satir-65f0', count: 1, name: { tr: 'Kurabiye' }, priceWithOption: '45,5' as unknown as number }] }));
    expect(q.lines[0]).toMatchObject({ externalId: null, name: 'Kurabiye', unitPrice: 4550 });
  });

  it('ödeme: Getir\'in metni "Online" ya da "Kapıda" derse karar ona uyar; kod bilinmiyor ya da metinle çelişiyorsa "doğrulayın"', async () => {
    const { paymentOf, fromGetirOrder } = await import('../server/delivery/getir');
    expect(paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { tr: 'Online Kredi/Banka Kartı' } })).toEqual({ online: true, label: 'Online Kredi/Banka Kartı', verify: false });
    expect(paymentOf({ id: 'x', paymentMethod: 22, paymentMethodText: { tr: 'Online Ödeme' } })).toMatchObject({ online: true, verify: false });
    expect(paymentOf({ id: 'x', paymentMethod: 22, paymentMethodText: { tr: 'Yemek kartı' } })).toEqual({ online: false, label: "Yemek kartı: Getir'den doğrulayın", verify: true });
    expect(paymentOf({ id: 'x', paymentMethod: 22 })).toMatchObject({ label: "Ödeme türü 22: Getir'den doğrulayın", verify: true });
    expect(paymentOf({ id: 'x' })).toMatchObject({ label: "Ödeme türü yok: Getir'den doğrulayın", verify: true });
    expect(paymentOf({ id: 'x', paymentMethod: 1, paymentMethodText: { tr: 'Kapıda Nakit' } })).toMatchObject({ online: false, verify: true, label: "Kapıda Nakit (ödeme türü 1): Getir'den doğrulayın" });
    // Kendi kuryemiz, metin online: kasada tahsil edilmez (kural 7)
    const p = fromGetirOrder(gOrder({ deliveryType: 2, paymentMethod: 3, paymentMethodText: { tr: 'Online Kredi/Banka Kartı' } }));
    expect([p.platformCollects, p.paymentLabel]).toEqual([true, 'Online Kredi/Banka Kartı']);
  });

  it('ileri tarihli: etkinleşmiş (400) siparişin süresi checkoutDate\'ten işlemez; 325 işler; saati gelmeyen sipariş notta işaretlenir', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const old = new Date(Date.now() - 4 * 3600_000).toISOString();
    expect(fromGetirOrder(gOrder({ status: 400, isScheduled: true, checkoutDate: old, scheduledDate: new Date(Date.now() + 50 * 60_000).toISOString() })).expiresAt).toBeUndefined();
    expect(fromGetirOrder(gOrder({ status: 325, isScheduled: true, checkoutDate: old })).expiresAt).toBe(Date.parse(old) + 5 * 60_000);
    const p = fromGetirOrder(gOrder({ status: 325, isScheduled: true }));
    expect(p.scheduledFor).toBeNull();
    expect(p.note).toMatch(/İLERİ TARİHLİ: saat Getir panelinde/);
  });

  it('hata sınıfları: Getir\'in bütün hizmet hataları 400; 4, 14, 15, 79 ve giriş hatası geçici, ötekiler kalıcı', async () => {
    const { GetirHttpError } = await import('../server/delivery/getir');
    for (const code of [4, 14, 15, 79]) expect(new GetirHttpError(400, 'x', code).permanent).toBe(false);
    for (const code of [3, 11, 12, 74, 62]) expect(new GetirHttpError(400, 'x', code).permanent).toBe(true);
    expect(new GetirHttpError(404, 'x', 1).permanent).toBe(true);
    expect(new GetirHttpError(400, 'giriş', 73, true).permanent).toBe(false);
    expect(new GetirHttpError(404, 'giriş', null, true).permanent).toBe(false);
  });
});

describe('akış ve dayanıklılık (gözden geçirme)', () => {
  beforeAll(async () => {
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'canli', prepMinutes: 15 });
  });
  const reset = () => {
    fake.unapproved = [];
    fake.cancelledList = [];
    fake.active = [];
    fake.statusFor = {};
    fake.bodyFor = {};
    fake.strict = false;
    fake.gapMs = 0;
    fake.singleToken = false;
  };

  it('handover 1 dk kuralına bağlı değil (prepare\'in hemen ardından gider); kurye henüz gelmedi (15) geçici: park yok, sonraki turda yeniden', async () => {
    reset();
    const o = gOrder();
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    fake.statusFor.handover = [{ status: 400, code: 15 }];
    await delivery(orderId, 'yolda');
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
    expect(fake.count(`POST ${o.id} handover`)).toBe(1);
    let r = await dbRow(o.id);
    expect([r.notifiedStatus, r.notifyParkedAt]).toEqual(['hazir', null]);
    expect(r.lastError).toMatch(/kurye henüz restorana ulaşmadı/);
    const a = await audit();
    expect(a.some((x) => x.action === 'platform.notify_rejected' && x.orderId === orderId)).toBe(false);
    expect(a.filter((x) => x.action === 'platform.notify_failed' && x.orderId === orderId)).toHaveLength(1);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} handover`)).toBe(2);
    r = await dbRow(o.id);
    expect([r.notifiedStatus, r.lastError]).toEqual(['yolda', null]);
  });

  it('kalıcı ret (kod 3) park edilir, alarm düşer, bir daha denenmez', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    await sleep(GAP_MS + 50);
    fake.statusFor.deliver = [{ status: 400, code: 3 }, { status: 400, code: 3 }];
    await delivery(orderId, 'teslim');
    // Getir'deki durum okunamadı (önceki denemenin yanıtı da kaybolmadı): geçici, park yok
    await live.reconcileNotifications();
    let r = await dbRow(o.id);
    expect(r.notifyParkedAt).toBeNull();
    expect(r.lastError).toMatch(/durum okunamadı/);
    // Getir'de sipariş teslimin gerisinde (hazır, 550): kalıcı ret, park ve alarm, bir daha denenmez
    fake.details[o.id] = { ...o, status: 550, prepareDate: new Date().toISOString() };
    await live.reconcileNotifications();
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} deliver`)).toBe(2);
    r = await dbRow(o.id);
    expect(r.notifyParkedAt).not.toBeNull();
    expect((await audit()).find((x) => x.action === 'platform.notify_rejected' && x.orderId === orderId)?.severity).toBe('alarm');
  });

  it('süre kodu (74, 62): bir aralık beklenip bir kez daha denenir; yine gelirse kalıcı', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    fake.statusFor.prepare = [{ status: 400, code: 74 }];
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
    expect((await dbRow(o.id))).toMatchObject({ lastError: null, notifyParkedAt: null });
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(2);
    expect((await dbRow(o.id)).notifiedStatus).toBe('hazir');
    fake.statusFor.deliver = [{ status: 400, code: 62 }, { status: 400, code: 62 }];
    await delivery(orderId, 'teslim');
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect((await dbRow(o.id)).notifyParkedAt).toBeNull();
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} deliver`)).toBe(2);
    expect((await dbRow(o.id)).notifyParkedAt).not.toBeNull();
  });

  it('ileri tarihli siparişte prepare\'e gelen 3: Getir\'de 500\'e (hazırlanıyor) kendisi almışsa "zaten geçildi"', async () => {
    reset();
    const o = gOrder({ ...ownCourierCash, status: 325, isScheduled: true, scheduledDate: new Date(Date.now() + 50 * 60_000).toISOString() });
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    fake.statusFor.prepare = [{ status: 400, code: 3 }];
    fake.details[o.id] = { ...o, status: 500 };
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'hazir', lastError: null, notifyParkedAt: null });
  });

  it('result: false ve nesne olmayan gövde başarı sayılmaz: kabulde kasada kabul yok, aşama ve iptal yeniden denenir', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const row = await arrive(o);
    fake.bodyFor.verify = ['<html>bakım</html>', { result: false }];
    for (let i = 0; i < 2; i++) {
      const r = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
      expect([r.status, r.json.code]).toEqual([502, 'platform_unreachable']);
    }
    expect((await byExt(o.id)).status).toBe('bekliyor');
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await sleep(GAP_MS + 50);
    fake.bodyFor.prepare = [{ result: false }];
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    let r = await dbRow(o.id);
    expect(r.notifiedStatus).not.toBe('hazir');
    expect(r.notifyParkedAt).toBeNull();
    expect(r.lastError).toMatch(/result: false/);
    await live.reconcileNotifications();
    r = await dbRow(o.id);
    expect([r.notifiedStatus, r.lastError]).toEqual(['hazir', null]);
    // Ret: Getir iptali uygulamadı → kasada reddedilmez
    const p = gOrder();
    const prow = await arrive(p);
    fake.bodyFor.cancel = [{ result: false }];
    const fail = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${prow.id}/reject`, { reason: 'Çok yoğunuz' });
    expect([fail.status, fail.json.code]).toEqual([502, 'platform_unreachable']);
    expect((await byExt(p.id)).status).toBe('bekliyor');
    await h.ok('kasa', 'POST', `/platforms/orders/${prow.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('giriş hatası siparişe ait değil: aşama park edilmez, kasadaki iptal kapanmaz, giriş düzelince gider; girişin 404\'ü "sipariş bulunamadı" demez', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    await delivery(orderId, 'hazir');
    fake.tokens.clear();
    fake.statusFor.login = [{ status: 400, code: 73 }];
    await live.reconcileNotifications();
    let r = await dbRow(o.id);
    expect(r.notifyParkedAt).toBeNull();
    expect(r.lastError).toMatch(/giriş olmadı.*uygulama anahtarı tanınmadı/);
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    fake.tokens.clear();
    fake.statusFor.login = [{ status: 400, code: 73 }];
    await live.reconcileNotifications();
    r = await dbRow(o.id);
    expect(r.status).toBe('kabul');
    expect(fake.count(`POST ${o.id} cancel`)).toBe(0);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} cancel`)).toBe(1);
    expect((await dbRow(o.id)).status).toBe('iptal');
    const { GetirClient, GetirHttpError } = await import('../server/delivery/getir');
    fake.statusFor.login = [404];
    const err = (await new GetirClient(cfg()).ready().catch((e: unknown) => e)) as InstanceType<typeof GetirHttpError>;
    expect(err).toBeInstanceOf(GetirHttpError);
    expect(err.permanent).toBe(false);
    expect(err.message).not.toMatch(/sipariş bulunamadı/);
  });

  it('jeton yenilemede tek giriş: aynı anda 401 alan çağrılar aynı girişi bekler (yeni giriş eski jetonu düşürse de)', async () => {
    reset();
    const { GetirClient, GETIR_PATHS } = await import('../server/delivery/getir');
    fake.singleToken = true;
    const client = new GetirClient(cfg());
    await client.ready();
    const before = fake.logins;
    fake.tokens.clear();
    const [a, b, c] = await Promise.all([client.orders(GETIR_PATHS.unapproved), client.orders(GETIR_PATHS.cancelled), client.orders(GETIR_PATHS.active)]);
    expect([a, b, c]).toEqual([[], [], []]);
    expect(fake.logins - before).toBe(1);
    fake.singleToken = false;
  });

  it('aktarıcı düşükken iptal ya da onaylı listesinin hatası onaysız siparişleri düşürmez; {data} sarmalı okunur, biçim hatası uyarı', async () => {
    reset();
    const o = gOrder();
    fake.unapproved = [o];
    fake.statusFor.inbox = [503];
    fake.statusFor.cancelled = [500];
    fake.statusFor.active = [500];
    expect(await live.pollPlatform('getir')).toEqual({ created: 1, cancelled: 0 });
    const err = (await list()).live.getir.lastError;
    expect(err).toMatch(/aktarıcı gelen kutusu alınamadı/);
    expect(err).toMatch(/iptal listesi okunamadı/);
    expect(err).toMatch(/onaylı sipariş listesi okunamadı/);
    const w = gOrder();
    fake.unapproved = [];
    fake.bodyFor.unapproved = [{ data: [w] }];
    expect((await live.pollPlatform('getir'))?.created).toBe(1);
    fake.bodyFor.unapproved = [{ beklenmeyen: true }];
    await live.pollPlatform('getir');
    expect((await list()).live.getir.lastError).toMatch(/yedek yoklama yapılamadı \(sipariş listesi beklenen biçimde gelmedi\)/);
    await live.pollPlatform('getir');
    for (const x of [o, w]) await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(x.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('yedek yoklama en sık dakikada bir (aktarıcı ayaktayken; iptal listesi düşse de); aktarıcı düşükken ve saat geri alınınca her turda', async () => {
    reset();
    await withAdapter({ backupEveryMs: 60_000 }, async () => {
      const t0 = Date.now();
      const n = () => fake.count('POST unapproved');
      const before = n();
      fake.statusFor.cancelled = [500];
      await live.pollPlatform('getir', t0);
      await live.pollPlatform('getir', t0 + 20_000);
      await live.pollPlatform('getir', t0 + 40_000);
      expect(n() - before).toBe(1);
      await live.pollPlatform('getir', t0 + 61_000);
      expect(n() - before).toBe(2);
      fake.statusFor.inbox = [503, 503];
      await live.pollPlatform('getir', t0 + 70_000);
      await live.pollPlatform('getir', t0 + 90_000);
      expect(n() - before).toBe(4);
      // Saat geri alındı: yedek yoklama saat yetişene dek durmaz
      await live.pollPlatform('getir', t0 + 90_000 - 30 * 60_000);
      expect(n() - before).toBe(5);
    });
    reset();
  });

  it('restoran kimliği bilinmeden aktarıcı kaydı alınmaz (gelen kutusunda kalır); giriş olunca başka restoranın siparişi ilk turda ayıklanır ve kutuda kalır', async () => {
    reset();
    await withAdapter({}, async () => {
      const other = gOrder({ restaurant: { id: 'BASKA_ILK_TUR' } });
      const mine = gOrder();
      fake.inbox.push(inboxOrder(other), inboxOrder(mine));
      fake.statusFor.login = [{ status: 400, code: 73 }];
      const blockedAudits = async () => (await audit()).filter((a) => a.action === 'platform.poll_failed' && /giriş olmadı/.test(a.message));
      const before = (await blockedAudits()).length;
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 0 });
      expect(fake.inbox.map((i) => i.id)).toEqual([`in-${other.id}`, `in-${mine.id}`]);
      const lastError = (await list()).live.getir.lastError;
      expect(lastError).toMatch(/giriş olmadı.*gelen kutusunda bekliyor/);
      // Yanıltıcı "siparişler aktarıcıdan alınıyor" yok: aktarıcıdan da alınmıyor
      expect(lastError).not.toMatch(/aktarıcıdan alınıyor/);
      // Siparişin kasaya ulaşmadığı ilk turda denetim kaydına düşer (uyarı)
      const first = await blockedAudits();
      expect(first.length - before).toBe(1);
      expect(first[0]).toMatchObject({ severity: 'uyari' });
      expect(first[0]!.message).toMatch(/Getir uygulamasından/);
      const asked = fake.restoran.length;
      expect(await live.pollPlatform('getir')).toEqual({ created: 1, cancelled: 0 });
      expect((await blockedAudits()).length - before).toBe(1);
      // Girişten sonra restoranın kendi kutusu istenir; başka restoranın siparişi silinmez
      expect(fake.restoran.slice(asked)).toEqual(['rest-1', 'rest-1']);
      expect(fake.inbox.map((i) => i.id)).toEqual([`in-${other.id}`]);
      expect(await byExt(other.id)).toBeUndefined();
      expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes('BASKA_ILK_TUR'))).toHaveLength(1);
      fake.inbox = [];
      await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(mine.id)).id}/reject`, { reason: 'Çok yoğunuz' });
    });
  });

  it('ortak kutuda başka restoranın iptali uygulanmaz ve silinmez; giriş olmadan (restoran bilinmeden) iptal uygulanır ama kutuda kalır, sorgusuz istenir', async () => {
    reset();
    const mine = gOrder();
    await arrive(mine);
    await withAdapter({}, async () => {
      fake.statusFor.login = [{ status: 400, code: 73 }];
      const otherCancel = { ...inboxCancel('ord-baska-restoran'), restaurantId: 'BASKA_IPTAL' } as InboxItem;
      const ownCancel = { ...inboxCancel(mine.id), restaurantId: 'rest-1' } as InboxItem;
      fake.inbox.push(otherCancel, ownCancel);
      const asked = fake.restoran.length;
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 1 });
      expect((await byExt(mine.id)).status).toBe('iptal');
      // Giriş yok: kutu sorgusuz istenir (eski kasa gibi), sahibi belli iptallerin ikisi de kutuda kalır
      expect(fake.restoran.slice(asked)).toEqual([null]);
      expect(fake.inbox.map((i) => i.id)).toEqual([otherCancel.id, ownCancel.id]);
      // Giriş olunca kendi iptali silinir, başka restoranınki kalır (o restoranın kasası alır)
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 0 });
      expect(fake.inbox.map((i) => i.id)).toEqual([otherCancel.id]);
      expect(fake.acked).not.toContain(otherCancel.id);
      fake.inbox = [];
    });
  });

  it('girişte öğrenilen restoran kimliği kalıcı kayda yazılır; yeniden başlayıp giremeyen kasa yalnız kendi kutusunu ister (bütün kutuları okumaz), yine de sipariş almaz', async () => {
    reset();
    // Önceki süreç: giriş olur, kimlik kayda yazılır
    const saved: string[] = [];
    await withAdapter({ restaurantMemory: { load: () => null, save: (id) => saved.push(id) } }, async () => {
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 0 });
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 0 });
    });
    // Bir kez yazılır (kimlik değişmedikçe her turda değil)
    expect(saved).toEqual(['rest-1']);
    // Yeniden başlatma: Getir'e giriş olmuyor, kayıttaki kimlikle kendi kutusu istenir
    const mine = gOrder();
    const cancelled = gOrder();
    await arrive(cancelled);
    await withAdapter({ restaurantMemory: { load: () => saved[0] ?? null, save: (id) => saved.push(id) } }, async () => {
      fake.statusFor.login = [{ status: 400, code: 73 }];
      fake.inbox.push(inboxOrder(mine), { ...inboxCancel(cancelled.id), restaurantId: 'rest-1' } as InboxItem);
      const asked = fake.restoran.length;
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 1 });
      expect(fake.restoran.slice(asked)).toEqual(['rest-1']);
      // Sipariş girişe dek bekler, iptal uygulanır ama ikisi de kutuda kalır
      expect(await byExt(mine.id)).toBeUndefined();
      expect(fake.inbox.map((i) => i.id)).toEqual([`in-${mine.id}`, `cn-${cancelled.id}`]);
      // Giriş olunca sipariş alınır, ikisi de silinir
      expect(await live.pollPlatform('getir')).toEqual({ created: 1, cancelled: 0 });
      expect(fake.restoran.slice(asked)).toEqual(['rest-1', 'rest-1', 'rest-1']);
      expect(fake.inbox).toHaveLength(0);
      expect(saved).toEqual(['rest-1']);
      await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(mine.id)).id}/reject`, { reason: 'Çok yoğunuz' });
    });
  });

  it('yeniden başlatmadan sonra son çağrı bilinmez: açılıştan bir aralık beklenir; Getir\'in akış ve aralık kuralı hiç çiğnenmez', async () => {
    reset();
    fake.strict = true;
    fake.gapMs = GAP_MS;
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await withAdapter({}, async () => {
      await delivery(orderId, 'hazir');
      await live.reconcileNotifications();
      expect(fake.count(`POST ${o.id} prepare`)).toBe(0);
      expect((await dbRow(o.id)).lastError).toBeNull();
      await sleep(GAP_MS + 50);
      await live.reconcileNotifications();
      expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
      await delivery(orderId, 'teslim');
      await live.reconcileNotifications();
      expect(fake.count(`POST ${o.id} deliver`)).toBe(0);
      await sleep(GAP_MS + 50);
      await live.reconcileNotifications();
      expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'teslim', lastError: null, notifyParkedAt: null });
    });
    // Getir panelinden zaten onaylanmış (2): onay anı bilinir, ilk aşama bir aralık bekler
    reset();
    const q = gOrder(ownCourierCash);
    const row = await arrive(q);
    fake.statusFor.verify = [{ status: 400, code: 2 }];
    const { orderId: qid } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await delivery(qid, 'hazir');
    await live.reconcileNotifications();
    expect(fake.count(`POST ${q.id} prepare`)).toBe(0);
  });

  it('saat geri alınsa da aşama en çok bir aralık bekler (tekdüze saat)', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
    const real = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() - 30 * 60_000);
    try {
      await delivery(orderId, 'teslim');
      await sleep(GAP_MS + 50);
      await live.reconcileNotifications();
    } finally {
      spy.mockRestore();
    }
    expect(fake.count(`POST ${o.id} deliver`)).toBe(1);
  });

  it('Getir panelinden onaylanan sipariş (/food-orders/active) kasadan kaybolmaz: bekleyen ve süresi dolmuş kayıt "platformda kabul edildi" olur, hiç görülmemiş sipariş tabletten kabul edilmiş gibi gelir', async () => {
    reset();
    // a) Kabul Getir'e ulaşmadı, personel Getir panelinden onayladı
    const a = gOrder();
    const arow = await arrive(a);
    fake.statusFor.verify = [500];
    expect((await h.call('kasa', 'POST', `/platforms/orders/${arow.id}/accept`, {})).status).toBe(502);
    // b) Süresi dolmuş
    const b = gOrder({ checkoutDate: new Date(Date.now() - 6 * 60_000).toISOString() });
    await arrive(b);
    const { tx } = await import('../server/db/client');
    const { expirePlatformOrders } = await import('../server/delivery/service');
    const { Effects } = await import('../server/lib/effects');
    tx((t) => expirePlatformOrders(t, new Effects()));
    expect((await dbRow(b.id)).status).toBe('suresi_doldu');
    // c) Kasa hiç görmedi; d) onaysız (400) ve e) iptal edilmiş ve f) başka restoranın: alınmaz
    const c = gOrder();
    const d = gOrder();
    // Yanıt şemasında (Get Food Order Response Schema) iptal saati yok: iptal nedeni ve notu iptal belirtisidir;
    // g) teslim edilmiş (900, deliverDate) ve h) eşiğin üstünde belirsiz durum da alınmaz
    const e = gOrder({ cancelReason: { id: 'r-1', messages: { tr: 'Müşteri iptal etti' } }, cancelNote: 'vazgeçti' });
    const f = gOrder({ restaurant: { id: 'BASKA_AKTIF' } });
    const g = gOrder({ deliverDate: new Date().toISOString() });
    const i = gOrder();
    fake.active = [{ ...a, status: 350 }, { ...b, status: 500 }, { ...c, status: 350 }, { ...d, status: 400 }, { ...e, status: 350 }, { ...f, status: 350 }, { ...g, status: 900 }, { ...i, status: 1500 }];
    const verifies = fake.count(`POST ${a.id} verify`);
    await live.pollPlatform('getir');
    fake.active = [];
    for (const x of [a, b]) {
      const dto = await byExt(x.id);
      expect([dto.status, dto.announced]).toEqual(['bekliyor', true]);
      await h.ok('kasa', 'POST', `/platforms/orders/${dto.id}/accept`, {});
      expect((await byExt(x.id)).status).toBe('kabul');
    }
    expect(fake.count(`POST ${a.id} verify`)).toBe(verifies);
    expect(fake.count(`POST ${b.id} verify`)).toBe(0);
    expect((await audit()).filter((x) => x.action === 'platform.accepted_elsewhere')).toHaveLength(2);
    const crow = await byExt(c.id);
    expect(crow.payload).toMatchObject({ preAccepted: true });
    expect(crow.payload.note).toMatch(/Getir panelinden onaylandı/);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${crow.id}/reject`, { reason: 'Çok yoğunuz' })).json.code).toBe('pre_accepted');
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${crow.id}/accept`, {});
    expect(fake.count(`POST ${c.id} verify`)).toBe(0);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
    for (const x of [d, e, f, g, i]) expect(await byExt(x.id)).toBeUndefined();
    const { approvedOnGetir } = await import('../server/delivery/getir');
    expect(approvedOnGetir({ ...e, status: 550, cancelReason: undefined })).toBe(false);
    expect(approvedOnGetir({ ...c, status: 550 })).toBe(true);
  });

  it('push\'ta saati gelmeyen ileri tarihli sipariş: saat Getir\'den sorulur; alınamazsa sipariş yine gelir, notta işaretli', async () => {
    reset();
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const o = gOrder({ status: 325, isScheduled: true });
    fake.details[o.id] = { ...o, scheduledDate: at };
    const row = await arrive(o);
    expect(row.payload.scheduledFor).toBe(Date.parse(at));
    expect(fake.count(`GET ${o.id} order`)).toBe(1);
    // Saat alınamadı: kayıt bir dakikadan eskiyse bekletilmez, sipariş notlu gelir
    const p = gOrder({ status: 325, isScheduled: true });
    fake.inbox.push({ ...inboxOrder(p), receivedAt: Date.now() - 2 * 60_000 });
    await live.pollPlatform('getir');
    const prow = await byExt(p.id);
    expect(prow.payload.scheduledFor).toBeNull();
    expect(prow.payload.note).toMatch(/İLERİ TARİHLİ: saat Getir panelinde/);
    for (const r of [row, prow]) await h.ok('kasa', 'POST', `/platforms/orders/${r.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('ileri tarihli: kasada verify-scheduled ile kabul edilmiş sipariş etkinleşip 400 olarak yeniden onay beklerse /verify gider (gidemezse bir kez alarm); 325 iken o arada etkinleşmişse /verify; etkinleşmiş sipariş süresi dolmuş gelmez', async () => {
    reset();
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const o = gOrder({ status: 325, isScheduled: true, scheduledDate: at });
    const { orderId } = await acceptNow(o);
    expect(fake.count(`POST ${o.id} verify-scheduled`)).toBe(1);
    fake.unapproved = [{ ...o, status: 400 }];
    fake.statusFor.verify = [500];
    await live.pollPlatform('getir');
    expect(fake.count(`POST ${o.id} verify`)).toBe(1);
    const alarms = () => audit().then((a) => a.filter((x) => x.action === 'platform.reconfirm_failed' && x.orderId === orderId));
    expect(await alarms()).toHaveLength(1);
    fake.statusFor.verify = [500];
    await live.pollPlatform('getir');
    expect(await alarms()).toHaveLength(1);
    await live.pollPlatform('getir');
    expect(fake.count(`POST ${o.id} verify`)).toBe(3);
    expect((await audit()).some((x) => x.action === 'platform.reconfirm' && x.orderId === orderId)).toBe(true);
    expect((await dbRow(o.id)).lastError).toBeNull();
    fake.unapproved = [];
    const q = gOrder({ status: 325, isScheduled: true, scheduledDate: at });
    const qrow = await arrive(q);
    fake.statusFor['verify-scheduled'] = [{ status: 400, code: 3 }];
    await h.ok('kasa', 'POST', `/platforms/orders/${qrow.id}/accept`, {});
    expect(fake.count(`POST ${q.id} verify`)).toBe(1);
    const late = await arrive(gOrder({ status: 400, isScheduled: true, scheduledDate: new Date(Date.now() + 50 * 60_000).toISOString(), checkoutDate: new Date(Date.now() - 4 * 3600_000).toISOString() }));
    expect(late.status).toBe('bekliyor');
    await h.ok('kasa', 'POST', `/platforms/orders/${late.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('kasadaki iptalin yeniden denemesi iptal seçeneklerini yeniden sormaz (cancel-options hız sınırlı)', async () => {
    reset();
    const o = gOrder();
    const { orderId } = await acceptNow(o);
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    fake.statusFor.cancel = [500, 500];
    for (let i = 0; i < 3; i++) await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} cancel`)).toBe(3);
    expect(fake.count(`GET ${o.id} cancel-options`)).toBe(1);
    expect((await dbRow(o.id)).status).toBe('iptal');
  });

  it('ödeme türü belirsiz sipariş Yönetim\'de uyarı olur, adisyon notunda "doğrulayın"', async () => {
    reset();
    const row = await arrive(gOrder({ ...ownCourierCash, paymentMethod: 22, paymentMethodText: undefined }));
    expect(row.payload.paymentLabel).toBe("Ödeme türü 22: Getir'den doğrulayın");
    expect((await list()).live.getir.lastError).toMatch(/ödeme türü belirsiz/);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
  });
});

// ─── İkinci gözden geçirmenin düzeltmeleri ───────────────────────────────────

describe('ikinci gözden geçirme', () => {
  beforeAll(async () => {
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'canli', prepMinutes: 15 });
  });
  const reset = () => {
    fake.unapproved = [];
    fake.cancelledList = [];
    fake.active = [];
    fake.statusFor = {};
    fake.bodyFor = {};
    fake.before = {};
    fake.strict = false;
    fake.gapMs = 0;
    fake.singleToken = false;
  };
  const rejected = async (orderId: string) => (await audit()).filter((x) => x.action === 'platform.notify_rejected' && x.orderId === orderId);

  it('yanıtı kaybolan aşama (Getir uyguladı, 502 döndü): yeniden denemeye gelen 3 Getir\'deki durumla geçildi sayılır, park ve yanlış alarm yok, deliver gider', async () => {
    reset();
    fake.strict = true;
    fake.gapMs = GAP_MS;
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    // Getir prepare'i uygular (akış ilerler) ama yanıt ağ geçidinden 502 döner
    fake.before.prepare = () => {
      fake.statusFor.prepare = [502];
      delete fake.before.prepare;
    };
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect(fake.flow.get(o.id)?.stage).toBe('prepared');
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'picked', notifyParkedAt: null });
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(2);
    expect(fake.count(`GET ${o.id} order`)).toBe(1);
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'hazir', notifyParkedAt: null, lastError: null });
    await delivery(orderId, 'teslim');
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} deliver`)).toBe(1);
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'teslim', notifyParkedAt: null, lastError: null });
    expect(await rejected(orderId)).toHaveLength(0);
  });

  it('Getir kuryesi: handover önce 15 (geçici), bu arada kurye siparişi uygulamasından aldı; sonraki denemeye gelen 3 geçildi sayılır', async () => {
    reset();
    fake.strict = true;
    fake.gapMs = GAP_MS;
    const o = gOrder();
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect(fake.flow.get(o.id)?.stage).toBe('prepared');
    fake.statusFor.handover = [{ status: 400, code: 15 }];
    await delivery(orderId, 'yolda');
    await live.reconcileNotifications();
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'hazir', notifyParkedAt: null });
    fake.flow.set(o.id, { stage: 'handed', at: fake.flow.get(o.id)!.at });
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} handover`)).toBe(2);
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'yolda', notifyParkedAt: null, lastError: null });
    expect(await rejected(orderId)).toHaveLength(0);
  });

  it('Getir\'deki durum okunamazsa: yanıtı kaybolan aşama uygulanmış sayılır', async () => {
    reset();
    const o = gOrder(ownCourierCash);
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    // Yanıt gelmedi (zaman aşımı yerine bağlantı koptu: 503), sonra 3; GET /food-orders/{id} 404
    fake.statusFor.prepare = [503, { status: 400, code: 3 }];
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect((await dbRow(o.id)).notifiedStatus).toBe('picked');
    await live.reconcileNotifications();
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'hazir', notifyParkedAt: null, lastError: null });
    expect(await rejected(orderId)).toHaveLength(0);
  });

  it('ileri tarihli sipariş etkinleşmeden (350) ya da yeniden onay beklerken prepare\'e gelen 3 geçildi sayılmaz: hazır bekletilir, etkinleşince gider', async () => {
    reset();
    const o = gOrder({ ...ownCourierCash, status: 325, isScheduled: true, scheduledDate: new Date(Date.now() + 3 * 3600_000).toISOString() });
    const { orderId } = await acceptNow(o);
    await sleep(GAP_MS + 50);
    fake.statusFor.prepare = [{ status: 400, code: 3 }];
    fake.details[o.id] = { ...o, status: 350 };
    await delivery(orderId, 'hazir');
    await live.reconcileNotifications();
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'picked', notifyParkedAt: null, lastError: null });
    // Bir aralık geçmeden yeniden gitmez
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
    fake.details[o.id] = { ...o, status: 500 };
    await sleep(GAP_MS + 50);
    await live.reconcileNotifications();
    expect(fake.count(`POST ${o.id} prepare`)).toBe(2);
    expect(await dbRow(o.id)).toMatchObject({ notifiedStatus: 'hazir', notifyParkedAt: null });
    expect(await rejected(orderId)).toHaveLength(0);
    // Yeniden onay bekleyen (400) de bekler
    const { stageOnGetir } = await import('../server/delivery/getir');
    expect(stageOnGetir({ id: 'x', status: 400, isScheduled: true }, 'prepare')).toBe('waiting');
    expect(stageOnGetir({ id: 'x', status: 325 }, 'prepare')).toBe('waiting');
    expect(stageOnGetir({ id: 'x', status: 350, cancelReason: { id: 'r' } }, 'prepare')).toBe('cancelled');
    expect(stageOnGetir({ id: 'x', status: 550 }, 'deliver')).toBe('behind');
    expect(stageOnGetir({ id: 'x', status: 550, deliverDate: '2026-10-28T10:00:00Z' }, 'deliver')).toBe('passed');
  });

  it('Kapalı\'da etkinleşen ileri tarihli siparişin yeniden itmesi: bir kez onaylanır, bir denetim kaydı, gelen kutusundan silinir; aşama aralıktan sonra gider', async () => {
    reset();
    const o = gOrder({ ...ownCourierCash, status: 325, isScheduled: true, scheduledDate: new Date(Date.now() + 3 * 3600_000).toISOString() });
    const { orderId } = await acceptNow(o);
    expect(fake.count(`POST ${o.id} verify-scheduled`)).toBe(1);
    await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'kapali' });
    try {
      await delivery(orderId, 'hazir');
      fake.inbox.push(inboxOrder({ ...o, status: 400 }));
      for (let i = 0; i < 5; i++) {
        await live.pollPlatform('getir');
        await live.reconcileNotifications();
        await sleep(GAP_MS / 3);
      }
      expect(fake.count(`POST ${o.id} verify`)).toBe(1);
      expect((await audit()).filter((x) => x.action === 'platform.reconfirm' && x.orderId === orderId)).toHaveLength(1);
      expect(fake.inbox).toHaveLength(0);
      await sleep(GAP_MS + 50);
      await live.reconcileNotifications();
      expect(fake.count(`POST ${o.id} prepare`)).toBe(1);
      expect((await dbRow(o.id)).notifiedStatus).toBe('hazir');
      // Getir "zaten onaylı" (2) derse: aralık yeniden başlamaz, denetim kaydı yazılmaz
      const { getirAdapter } = await import('../server/delivery/getir');
      const a = getirAdapter(cfg());
      fake.statusFor.verify = [{ status: 400, code: 2 }];
      expect(await a.reconfirm!((await dbRow(o.id)).payload)).toBe('already');
    } finally {
      await h.ok('patron', 'PUT', '/platforms/getir', { mode: 'canli' });
    }
  });

  it('yeniden onay: Getir tabletinden onaylanıp kasada bekleyen sipariş de onaylanır; adisyonu kasada iptal edilmiş sipariş onaylanmaz', async () => {
    reset();
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    // a) Tabletten onaylı (350), kasa hiç görmedi: tabletten kabul edilmiş gibi gelir
    const a = gOrder({ status: 325, isScheduled: true, scheduledDate: at });
    fake.active = [{ ...a, status: 350 }];
    await live.pollPlatform('getir');
    fake.active = [];
    expect(await byExt(a.id)).toMatchObject({ status: 'bekliyor', payload: { preAccepted: true } });
    fake.unapproved = [{ ...a, status: 400 }];
    await live.pollPlatform('getir');
    expect(fake.count(`POST ${a.id} verify`)).toBe(1);
    expect((await audit()).filter((x) => x.action === 'platform.reconfirm' && x.message.includes(a.confirmationId!))).toHaveLength(1);
    // Liste bir süre daha 400 gösterse de yeniden onay gitmez
    await live.pollPlatform('getir');
    expect(fake.count(`POST ${a.id} verify`)).toBe(1);
    // b) Kasada kabul edilmiş, adisyonu iptal edilmiş; Getir'e iptal geçici hatayla gidemedi
    const b = gOrder({ status: 325, isScheduled: true, scheduledDate: at });
    const { orderId } = await acceptNow(b);
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    fake.statusFor.cancel = [500];
    await live.reconcileNotifications();
    expect((await dbRow(b.id)).status).toBe('kabul');
    fake.unapproved = [{ ...b, status: 400 }];
    await live.pollPlatform('getir');
    expect(fake.count(`POST ${b.id} verify`)).toBe(0);
    expect((await audit()).some((x) => x.action === 'platform.reconfirm_failed' && x.orderId === orderId)).toBe(false);
    fake.unapproved = [];
    await live.reconcileNotifications();
    expect((await dbRow(b.id)).status).toBe('iptal');
  });

  it('geçici kod (14) sürerse alarma çıkar: kasadaki iptal yeniden denenir, süre aşılınca bir kez alarm', async () => {
    reset();
    const { TRANSIENT_ALARM_MS } = await import('../server/delivery/live');
    const o = gOrder();
    const { orderId } = await acceptNow(o);
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    fake.statusFor.cancel = [{ status: 400, code: 14 }, { status: 400, code: 14 }, { status: 400, code: 14 }, { status: 400, code: 14 }];
    const t0 = Date.now();
    const unsynced = async () => (await audit()).filter((x) => x.action === 'platform.cancel_unsynced' && x.orderId === orderId).map((x) => x.severity);
    await live.reconcileNotifications(t0);
    await live.reconcileNotifications(t0 + 60_000);
    expect(await unsynced()).toEqual(['uyari']);
    await live.reconcileNotifications(t0 + TRANSIENT_ALARM_MS.cancel + 1000);
    await live.reconcileNotifications(t0 + TRANSIENT_ALARM_MS.cancel + 60_000);
    expect((await unsynced()).sort()).toEqual(['alarm', 'uyari']);
    expect((await dbRow(o.id)).status).toBe('kabul');
    await live.reconcileNotifications();
    expect((await dbRow(o.id)).status).toBe('iptal');
  });

  it('giriş sürekli olmazsa: ilk turda uyarı, 15. turda alarm (bekleme uygulanmaz)', async () => {
    reset();
    await withAdapter({}, async () => {
      const x = gOrder();
      fake.inbox.push(inboxOrder(x));
      fake.statusFor.login = Array.from({ length: 40 }, () => ({ status: 400, code: 73 }));
      const blocked = async () => (await audit()).filter((a) => a.action === 'platform.poll_failed' && /giriş olmadı/.test(a.message));
      const before = (await blocked()).length;
      const logins = fake.count('POST /auth/login');
      for (let i = 0; i < 15; i++) await live.pollPlatform('getir');
      // Giriş olmayan turda Getir'in listeleri için girişe yeniden gidilmez
      expect(fake.count('POST /auth/login') - logins).toBe(15);
      const got = (await blocked()).slice(0, (await blocked()).length - before);
      expect(got.map((a) => a.severity).sort()).toEqual(['alarm', 'uyari']);
      expect(live.pollDue('getir', Date.now() + 20_000)).toBe(true);
      fake.statusFor.login = [];
      expect(await live.pollPlatform('getir')).toEqual({ created: 1, cancelled: 0 });
      await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(x.id)).id}/reject`, { reason: 'Çok yoğunuz' });
    });
  });

  it('girişi bekleyen siparişin iptal kaydı da bekler: giriş gelince iptal edilmiş sipariş kasaya düşmez', async () => {
    reset();
    await withAdapter({}, async () => {
      const x = gOrder();
      fake.inbox.push(inboxOrder(x), inboxCancel(x.id));
      fake.statusFor.login = [{ status: 400, code: 73 }];
      await live.pollPlatform('getir');
      expect(fake.inbox.map((i) => i.id).sort()).toEqual([`cn-${x.id}`, `in-${x.id}`].sort());
      expect(await live.pollPlatform('getir')).toEqual({ created: 0, cancelled: 0 });
      expect(fake.inbox).toHaveLength(0);
      expect(await byExt(x.id)).toBeUndefined();
    });
  });

  it('ileri tarihli siparişin saati alınamazsa kayıt bir dakikaya dek bekler; yedek liste saati getirirse saatiyle gelir; notlu gelmiş kaydın saati sonradan tamamlanır', async () => {
    reset();
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const o = gOrder({ status: 325, isScheduled: true });
    fake.inbox.push(inboxOrder(o));
    await live.pollPlatform('getir');
    expect(await byExt(o.id)).toBeUndefined();
    expect(fake.inbox.map((i) => i.id)).toEqual([`in-${o.id}`]);
    fake.unapproved = [{ ...o, scheduledDate: at }];
    await live.pollPlatform('getir');
    expect((await byExt(o.id)).payload.scheduledFor).toBe(Date.parse(at));
    expect(fake.inbox).toHaveLength(0);
    fake.unapproved = [];
    // Bir dakikadan eski kayıt notlu gelir; saat sonradan gelince kayıt tamamlanır
    const p = gOrder({ status: 325, isScheduled: true });
    fake.inbox.push({ ...inboxOrder(p), receivedAt: Date.now() - 2 * 60_000 });
    await live.pollPlatform('getir');
    expect((await byExt(p.id)).payload).toMatchObject({ scheduledFor: null, note: expect.stringMatching(/İLERİ TARİHLİ/) });
    fake.unapproved = [{ ...p, scheduledDate: at }];
    await live.pollPlatform('getir');
    fake.unapproved = [];
    const done = (await byExt(p.id)).payload;
    expect(done.scheduledFor).toBe(Date.parse(at));
    expect(done.note ?? '').not.toMatch(/İLERİ TARİHLİ/);
    for (const x of [o, p]) await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(x.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('para: Getir toplamı kalemleri aşarsa fark indirimden ayrı tutulur, indirim Getir\'in alanlarından; açıklanamayan eksik restoran indirimi, platform payı uydurulmaz; push ve yedek yol aynı tutar', async () => {
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const sum = (o: GetirOrder) => {
      const p = fromGetirOrder(o);
      return { n: [p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal], note: p.note };
    };
    // Getir kuryesi, MasterPass; kalemler 190
    let r = sum(gOrder({ totalPrice: 205, totalDiscountedPrice: 175 }));
    expect(r.n).toEqual([19000, 3000, 0, 16000]);
    expect(r.note).toMatch(/Getir toplamı ₺205,00 \(indirimli ₺175,00\), kalemler ₺190,00: ₺15,00 farkı Getir'den doğrulayın/);
    r = sum(gOrder({ totalPrice: 205, totalDiscountedPrice: 190 }));
    expect(r.n).toEqual([19000, 1500, 0, 17500]);
    expect(r.note).toMatch(/₺15,00 farkı/);
    const line = gOrder({ totalPrice: 205, totalDiscountedPrice: 165 });
    line.products![0] = { ...line.products![0]!, totalDiscountedPriceWithOption: 150 };
    r = sum(line);
    expect(r.n).toEqual([19000, 4000, 0, 15000]);
    expect(r.note).toMatch(/₺15,00 farkı/);
    // Kendi kuryemiz, kapıda nakit: notta müşterinin kapıda ödeyeceği
    expect(sum(gOrder({ ...ownCourierCash, totalPrice: 205, totalDiscountedPrice: 190 })).note).toMatch(/müşteri kapıda ₺190,00 öder/);
    // Restoranın ürün indirimi: push (satır indirimi) ve yedek yol (satır indirimi yok) aynı tutar, platform payı 0
    const push = gOrder({ ...ownCourierCash, totalPrice: 150, totalDiscountedPrice: undefined });
    push.products![0] = { ...push.products![0]!, totalDiscountedPriceWithOption: 150 };
    const backup = gOrder({ ...ownCourierCash, totalPrice: 150, totalDiscountedPrice: undefined });
    const a = sum(push);
    const b = sum(backup);
    expect(a.n).toEqual([19000, 4000, 0, 15000]);
    expect(b.n).toEqual(a.n);
    expect(a.note).toBeNull();
    expect(b.note).toMatch(/Kalemler ₺190,00, Getir toplamı ₺150,00: ₺40,00 farkı indirim sayıldı/);
  });

  it('ödeme metni "online" ya da "kapıda" kelimesini içeride de taşıyabilir; çelişen etiket üretilmez', async () => {
    const { paymentOf } = await import('../server/delivery/getir');
    expect(paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { tr: 'Kredi Kartı (Online)' } })).toEqual({ online: true, label: 'Kredi Kartı (Online)', verify: false });
    expect(paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { en: 'Credit Card (Online)' } })).toEqual({ online: true, label: 'Credit Card (Online)', verify: false });
    expect(paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { tr: 'Kredi/Banka Kartı - Online Ödeme' } })).toMatchObject({ online: true, verify: false });
    expect(paymentOf({ id: 'x', paymentMethod: 1, paymentMethodText: { tr: 'Kredi Kartı (Kapıda)' } })).toMatchObject({ online: false, verify: true });
    // İki yön birden: kod karar verir, doğrulatır
    expect(paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { tr: 'Online ya da kapıda kart' } })).toEqual({ online: false, label: "Online ya da kapıda kart (ödeme türü 3): Getir'den doğrulayın", verify: true });
    // Kapıda bilinen koda metin "online" derse kasada tahsil edilmez ama doğrulatır
    expect(paymentOf({ id: 'x', paymentMethod: 4, paymentMethodText: { tr: 'Nakit (Online)' } })).toMatchObject({ online: true, verify: true });
    for (const t of ['Kredi Kartı (Online)', 'Kapıda Nakit', 'Nakit', 'Kart (kapıda)']) {
      const { label } = paymentOf({ id: 'x', paymentMethod: 3, paymentMethodText: { tr: t } });
      expect(label).not.toMatch(/^Kapıda .*online/i);
      expect(label).not.toMatch(/^Online .*kapıda/i);
    }
  });
});
