import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformLiveStatus, PlatformOrderDTO, PlatformProductDTO } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import { type FakeTrendyol, startFakeTrendyol } from './fake-trendyol';
import { startApp, type Harness } from './harness';
import type { TrendyolPackage } from '../server/delivery/trendyol';

/**
 * Trendyol Go canlı bağlantısının çekişmeli gözden geçirme bulguları: kabul platforma gitmeden yerelde denenir,
 * platform kabul edip adisyon açılamazsa kayıt bunu tutar, iki ekrandan eşzamanlı karar yok, aşama turu tek koşu,
 * kasada iptal platforma gider, platform iptali kasada ödeme yüzünden durursa alarm bir kez, platform kampanyasının
 * payı kapıda tahsilatta kasadan istenmez, "Kapalı" yalnız yeni siparişi durdurur, ağ hatası Türkçe, bozuk paket
 * ötekileri durdurmaz, açık sipariş sayısı ve gizli ürüne eşleme.
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
  await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'canli' });
});
afterAll(async () => {
  h.cleanup();
  await fake.close();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const list = () => h.ok<{ orders: PlatformOrderDTO[]; live: Record<string, PlatformLiveStatus> }>('kasa', 'GET', '/platforms');
const byExt = async (ext: string | number) => (await list()).orders.find((o) => o.payload.externalId === String(ext))!;
const audit = () => h.ok<{ action: string; severity: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=200');

let seq = 5000;
function pkg(over: Partial<TrendyolPackage> = {}, now = Date.now()): TrendyolPackage {
  const id = ++seq;
  return {
    id,
    orderNumber: `TY${id}`,
    orderCode: `R${String(id).slice(-2)}`,
    packageStatus: 'Created',
    deliveryType: 'GO',
    storePickupSelected: false,
    packageCreationDate: now - 60_000,
    packageModificationDate: now - 30_000,
    customer: { firstName: 'A***', lastName: 'K***' },
    lines: [{ productId: 55, name: 'Latte', price: 200, quantity: 1 }],
    payment: { paymentType: 'PAY_WITH_CREDIT_CARD' },
    totalPrice: 200,
    ...over,
  };
}
const ownCourierCash = { deliveryType: 'STORE', storePickupSelected: false, payment: { paymentType: 'PAY_WITH_CASH' }, address: { address1: 'Aydınlı Mh.', phone: '0 5** *** ** 90' } } as const;

/** Paketi platforma koyar, yoklar, kaydını döner */
async function arrive(over: Partial<TrendyolPackage> = {}) {
  const p = pkg(over);
  fake.packages.push(p);
  await live.pollPlatform('trendyol');
  return { p, row: await byExt(p.id) };
}

describe('Trendyol Go gözden geçirme bulguları', () => {
  it('kabul önce yerelde denenir: kasada tükenmiş ürün varsa platforma hiç "kabul" gitmez', async () => {
    const { p, row } = await arrive();
    await h.ok('patron', 'POST', `/sync/products/${product('Latte').id}/availability`, { active: false });
    const r = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect([r.status, r.json.code]).toEqual([409, 'sold_out']);
    expect(fake.count(`PUT ${p.id} picked`)).toBe(0);
    expect((await byExt(p.id)).status).toBe('bekliyor');
    await h.ok('patron', 'POST', `/sync/products/${product('Latte').id}/availability`, { active: true });
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('platform kabul edip adisyon açılamazsa: kayıt bunu tutar, süre dolmaz, alarm; yeniden deneme platforma gitmez', async () => {
    const { p, row } = await arrive();
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const latte = product('Latte').id;
    // Platform kabul ederken başka kasada son porsiyon satıldı (ürün tükendi)
    fake.before.picked = () => db.update(schema.products).set({ active: false }).where(eq(schema.products.id, latte)).run();
    const r = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    delete fake.before.picked;
    expect([r.status, r.json.code]).toEqual([409, 'sold_out']);
    expect(fake.count(`PUT ${p.id} picked`)).toBe(1);
    const stuck = await byExt(p.id);
    expect(stuck).toMatchObject({ status: 'bekliyor', announced: true });
    expect(stuck.lastError).toMatch(/Platformda kabul edildi ama adisyon açılamadı/);
    expect((await audit()).filter((a) => a.action === 'platform.accept_failed' && a.severity === 'alarm')).toHaveLength(1);
    // Kabul süresi geçse de platformda yaşıyor: iptal sayılmaz
    const { expirePlatformOrders } = await import('../server/delivery/service');
    const { Effects } = await import('../server/lib/effects');
    const { tx } = await import('../server/db/client');
    tx((t) => expirePlatformOrders(t, new Effects(), Date.now() + 3600_000));
    expect((await byExt(p.id)).status).toBe('bekliyor');
    // Ürün açılınca "Adisyonu aç": platforma ikinci kez gitmez
    db.update(schema.products).set({ active: true }).where(eq(schema.products.id, latte)).run();
    const ok = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.count(`PUT ${p.id} picked`)).toBe(1);
    expect(await byExt(p.id)).toMatchObject({ status: 'kabul', orderId: ok.orderId, lastError: null });
  });

  it('iki ekrandan aynı anda kabul ve ret: ikincisi 409, platforma tek karar gider', async () => {
    const { p, row } = await arrive();
    fake.delayFor.picked = 300;
    const accepting = h.call<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await new Promise((r) => setTimeout(r, 60));
    const rejected = await h.call<{ code: string }>('mudur', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect([rejected.status, rejected.json.code]).toEqual([409, 'busy']);
    expect((await accepting).status).toBe(200);
    fake.delayFor.picked = 0;
    expect(fake.count(`PUT ${p.id} unsupplied`)).toBe(0);
    expect((await byExt(p.id)).status).toBe('kabul');
  });

  it('aşama turu tek koşu: zamanlayıcı ve teslim olayı aynı anda isterse "Hazır" bir kez gider', async () => {
    const { p, row } = await arrive();
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'hazir' });
    fake.delayFor.invoiced = 200;
    await Promise.all([live.reconcileNotifications(), live.reconcileNotifications(), live.reconcileNotifications()]);
    fake.delayFor.invoiced = 0;
    expect(fake.count(`PUT ${p.id} invoiced`)).toBe(1);
    // Platform kuryesi aldı: adisyon platform ödemesiyle kapanır (açık sipariş sayısından düşer)
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'yolda' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('kapali');
  });

  it('kasada iptal edilen kabul edilmiş sipariş platforma "tedarik edilemedi" gider; platform reddederse yeniden denenmez, alarm', async () => {
    const first = await arrive();
    const a = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${first.row.id}/accept`, {});
    await h.ok('patron', 'POST', `/orders/${a.orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    await live.reconcileNotifications();
    expect(fake.count(`PUT ${first.p.id} unsupplied`)).toBe(1);
    expect(fake.bodies.unsupplied?.at(-1)).toEqual({ reasonCode: 627 });
    expect((await byExt(first.p.id)).status).toBe('iptal');
    expect((await audit()).some((x) => x.action === 'platform.cancel_sent' && x.orderId === a.orderId)).toBe(true);

    const second = await arrive();
    const b = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${second.row.id}/accept`, {});
    await h.ok('patron', 'POST', `/orders/${b.orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    fake.statusFor.unsupplied = [409];
    await live.reconcileNotifications();
    await live.reconcileNotifications();
    expect(fake.count(`PUT ${second.p.id} unsupplied`)).toBe(1);
    const alarm = (await audit()).find((x) => x.action === 'platform.cancel_unsynced' && x.orderId === b.orderId);
    expect(alarm?.severity).toBe('alarm');
    expect(alarm?.message).toMatch(/platform uygulamasından iptal edin/);
  });

  it('platform iptali kasada ödeme yüzünden durursa alarm bir kez; ödeme geri alınınca kendiliğinden kapanır', async () => {
    const { p, row } = await arrive(ownCourierCash);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: method('Nakit').id, amount: 5000 });
    p.packageStatus = 'Cancelled';
    p.packageModificationDate = Date.now();
    expect((await live.pollPlatform('trendyol'))?.cancelled).toBe(0);
    await live.pollPlatform('trendyol');
    await live.reconcileNotifications();
    expect((await audit()).filter((x) => x.action === 'platform.cancel_blocked' && x.orderId === orderId)).toHaveLength(1);
    const pending = await byExt(p.id);
    expect(pending).toMatchObject({ status: 'kabul', cancelPending: true });
    expect(pending.lastError).toMatch(/iptal etti ama adisyon kapatılamadı/);
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    await h.ok('patron', 'POST', `/orders/${orderId}/payments/${o.payments[0]!.id}/refund`, { reason: 'Platform iptal etti' });
    await live.reconcileNotifications();
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect(await byExt(p.id)).toMatchObject({ status: 'iptal', cancelPending: false, lastError: null });
  });

  it('kendi kuryemiz kapıda alırken platform kampanyası: platformun payı kabulde yazılır, kasada müşterinin ödediği kalır', async () => {
    const { row } = await arrive({ ...ownCourierCash, promotions: [{ name: 'Trendyol kuponu', amount: { value: 30, sellerCoverageRatio: 0 } }], totalPrice: 170 });
    expect(row.payload).toMatchObject({ platformCollects: false, platformDiscount: 3000, customerTotal: 17000 });
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect([o.total, o.paid, o.status]).toEqual([20000, 3000, 'acik']);
    expect(o.payments[0]).toMatchObject({ methodName: 'Trendyol Go', amount: 3000 });
  });

  it('"Kapalı" yalnız yeni siparişi durdurur: bekleyen gerçek sipariş yine platforma bildirilir; anahtar yoksa karar verilmez', async () => {
    const { p, row } = await arrive();
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'kapali' });
    const { setAdapter, adapterFor } = await import('../server/delivery/registry');
    const real = adapterFor('trendyol')!;
    setAdapter('trendyol', { ...real, configured: () => false });
    const off = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect([off.status, off.json.code]).toEqual([409, 'platform_off']);
    setAdapter('trendyol', real);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(fake.count(`PUT ${p.id} picked`)).toBe(1);
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'canli' });
  });

  it('ağ hatası kasada Türkçe görünür ("bağlantı kurulamadı")', async () => {
    const { row } = await arrive();
    const { setAdapter, adapterFor } = await import('../server/delivery/registry');
    const { trendyolAdapter } = await import('../server/delivery/trendyol');
    const real = adapterFor('trendyol')!;
    setAdapter('trendyol', trendyolAdapter({ ...KEYS, apiUrl: 'http://127.0.0.1:9', agentName: 'LafPOS' }));
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    setAdapter('trendyol', real);
    expect([r.status, r.json.code]).toEqual([502, 'platform_unreachable']);
    expect(r.json.error).toMatch(/Trendyol Go: kabul bildirilemedi \(bağlantı kurulamadı\)/);
    expect(r.json.error).not.toMatch(/fetch failed/);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('bozuk paket ötekileri durdurmaz; denetim kaydına bir kez düşer', async () => {
    const bad = pkg({ lines: 5 as unknown as TrendyolPackage['lines'] });
    const good = pkg();
    fake.packages.push(bad, good);
    const r = await live.pollPlatform('trendyol');
    expect(r?.created).toBe(1);
    expect((await byExt(good.id)).status).toBe('bekliyor');
    await live.pollPlatform('trendyol');
    expect((await audit()).filter((a) => a.action === 'platform.package_invalid' && a.message.includes(String(bad.id)))).toHaveLength(1);
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(good.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('açık sipariş sayısı yalnız adisyonu açık kabul edilmişleri sayar', async () => {
    const before = (await list()).live.trendyol.openOrders;
    const open = await arrive();
    await h.ok('kasa', 'POST', `/platforms/orders/${open.row.id}/accept`, {});
    const closed = await arrive();
    const c = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${closed.row.id}/accept`, {});
    // Platform kuryesi aldı: platform ödemesiyle kapanır, sayıdan düşer
    await h.ok('kasa', 'POST', `/orders/${c.orderId}/delivery`, { deliveryStatus: 'yolda' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${c.orderId}`)).status).toBe('kapali');
    expect((await list()).live.trendyol.openOrders).toBe(before + 1);
  });

  it('Ürün eşleme ile bağlanan ürün menüden gizlense de o ürün olarak açılır', async () => {
    // Kasada adı olmayan kalem: eşleme olmadan "Platform ürünü" satırı olurdu
    const line = { productId: 77, name: 'TY Özel Latte', price: 200, quantity: 1 };
    await arrive({ lines: [line] });
    const products = (await h.ok<{ products: PlatformProductDTO[] }>('patron', 'GET', '/platforms/products')).products;
    const mapped = products.find((x) => x.externalId === '77')!;
    const americano = product('Americano');
    await h.ok('patron', 'PUT', `/platforms/products/${mapped.id}`, { productId: americano.id });
    await h.ok('patron', 'PATCH', `/admin/products/${americano.id}`, { hidden: true });
    const { row } = await arrive({ lines: [line] });
    expect(row.unmatched).toEqual([]);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
    expect(o.items[0]).toMatchObject({ productId: americano.id, unitPrice: 20000 });
    await h.ok('patron', 'PATCH', `/admin/products/${americano.id}`, { hidden: false });
    await h.ok('patron', 'PUT', `/platforms/products/${mapped.id}`, { productId: null });
  });

  it('Kapalı modda da platformun iptali gelir (açık gerçek sipariş varken); yeni paket kayda girmez', async () => {
    const { p, row } = await arrive();
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'kapali' });
    const fresh = pkg();
    fake.packages.push(fresh);
    p.packageStatus = 'Cancelled';
    p.packageModificationDate = Date.now();
    // Zamanlayıcı turu (yoklama aralığı dolmuş)
    await live.liveTick(Date.now() + 60_000);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('iptal');
    expect((await byExt(p.id)).status).toBe('iptal');
    expect((await list()).orders.some((o) => o.payload.externalId === String(fresh.id))).toBe(false);
    await h.ok('patron', 'PUT', '/platforms/trendyol', { mode: 'canli' });
    // Canlı'ya dönünce yeni paket gelir
    await live.pollPlatform('trendyol');
    await h.ok('kasa', 'POST', `/platforms/orders/${(await byExt(fresh.id)).id}/reject`, { reason: 'Çok yoğunuz' });
  });

  it('aşaması kalıcı reddedilen siparişte de kasada iptal platforma gider', async () => {
    const { p, row } = await arrive(ownCourierCash);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/delivery`, { deliveryStatus: 'hazir' });
    fake.statusFor.invoiced = [400];
    await live.reconcileNotifications();
    expect((await audit()).find((a) => a.action === 'platform.notify_rejected' && a.orderId === orderId)?.severity).toBe('alarm');
    await h.ok('patron', 'POST', `/orders/${orderId}/cancel`, { reason: 'Müşteri vazgeçti' });
    await live.reconcileNotifications();
    expect(fake.count(`PUT ${p.id} unsupplied`)).toBe(1);
    expect((await byExt(p.id)).status).toBe('iptal');
    // Park edilen aşama yeniden denenmez
    expect(fake.count(`PUT ${p.id} invoiced`)).toBe(1);
  });

  it('tur ağ beklerken platform başka siparişi iptal ederse o sipariş "kasada iptal" sanılmaz', async () => {
    const first = await arrive();
    const a = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${first.row.id}/accept`, {});
    const second = await arrive();
    await h.ok('kasa', 'POST', `/platforms/orders/${second.row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${a.orderId}/delivery`, { deliveryStatus: 'hazir' });
    fake.delayFor.invoiced = 300;
    const turn = live.reconcileNotifications();
    await new Promise((r) => setTimeout(r, 80));
    second.p.packageStatus = 'Cancelled';
    second.p.packageModificationDate = Date.now();
    await live.pollPlatform('trendyol');
    await turn;
    fake.delayFor.invoiced = 0;
    expect((await byExt(second.p.id)).status).toBe('iptal');
    expect(fake.count(`PUT ${second.p.id} unsupplied`)).toBe(0);
    expect((await audit()).some((x) => x.action === 'platform.cancel_sent' && x.message.includes(second.row.payload.code))).toBe(false);
  });

  it('ödeme geri alınamayan platform iptalini yetkili kayda alır; kasiyer alamaz; alarm', async () => {
    const { p, row } = await arrive(ownCourierCash);
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await h.ok('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: method('Nakit').id, amount: 5000 });
    p.packageStatus = 'Cancelled';
    p.packageModificationDate = Date.now();
    await live.pollPlatform('trendyol');
    expect((await byExt(p.id)).cancelPending).toBe(true);
    expect((await h.call('kasa', 'POST', `/platforms/orders/${row.id}/cancel-close`, {})).status).toBe(403);
    await h.ok('mudur', 'POST', `/platforms/orders/${row.id}/cancel-close`, {});
    expect(await byExt(p.id)).toMatchObject({ status: 'iptal', cancelPending: false });
    expect((await audit()).find((x) => x.action === 'platform.cancel_closed' && x.orderId === orderId)?.severity).toBe('alarm');
    // Para yerinde: adisyon ve ödeme dokunulmadı
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).paid).toBe(5000);
    const again = await h.call<{ code: string }>('mudur', 'POST', `/platforms/orders/${row.id}/cancel-close`, {});
    expect([again.status, again.json.code]).toEqual([409, 'not_cancel_pending']);
  });

  it('kabul platforma giderken süre dolumu kaydı kapatmaz', async () => {
    const { p, row } = await arrive();
    const { expirePlatformOrders } = await import('../server/delivery/service');
    const { Effects } = await import('../server/lib/effects');
    const { tx } = await import('../server/db/client');
    fake.delayFor.picked = 250;
    const accepting = h.call<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    await new Promise((r) => setTimeout(r, 80));
    tx((t) => expirePlatformOrders(t, new Effects(), Date.now() + 3600_000));
    expect((await accepting).status).toBe(200);
    fake.delayFor.picked = 0;
    expect((await byExt(p.id)).status).toBe('kabul');
  });

  it('istek hiç çıkmadıysa (geçersiz adres) ağ sorunu gibi gösterilmez', async () => {
    const { row } = await arrive();
    const { setAdapter, adapterFor } = await import('../server/delivery/registry');
    const { trendyolAdapter } = await import('../server/delivery/trendyol');
    const real = adapterFor('trendyol')!;
    setAdapter('trendyol', trendyolAdapter({ ...KEYS, apiUrl: 'adres-yok', agentName: 'LafPOS' }));
    const r = await h.call<{ error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    setAdapter('trendyol', real);
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/istek gönderilemedi, ayarı denetleyin/);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
  });
});
