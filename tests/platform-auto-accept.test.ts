import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformOrderDTO, PlatformOrderPayload, PlatformSettings } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import type { DhOrder, InboxItem as YsInboxItem } from '../server/delivery/yemeksepeti';
import type { GetirOrder, InboxItem as GetirInboxItem } from '../server/delivery/getir';
import type { TrendyolPackage } from '../server/delivery/trendyol';
import { type FakeGetir, startFakeGetir } from './fake-getir';
import { type FakeTrendyol, startFakeTrendyol } from './fake-trendyol';
import { type FakeYemeksepeti, startFakeYemeksepeti } from './fake-yemeksepeti';
import { startApp, type Harness } from './harness';

/**
 * Paket platformu siparişini otomatik kabul (docs/PAKET-PLATFORMLARI.md "Otomatik kabul"): ayar varsayılan kapalı ve
 * kabul eden kişi şart; Canlı'da yoklamanın yeni siparişi kasadaki Kabul'ün yoluyla, platforma bir kez giderek kabul
 * edilir (Trendyol Go, Yemeksepeti, Getir sahte sunucularıyla); koşullardan biri tutmazsa sipariş nedeniyle elle kabul
 * bekler; platform reddi, yerelde açılamayan adisyon, elle kabulle yarış ve yeniden deneme çift kabul yapmaz; kasada
 * karar denenmiş kayıt (ret platforma gidemedi, elle kabul yerelde düştü) hiçbir zaman otomatik kabul edilmez; Deneme'de
 * deneme siparişi platforma gitmeden kabul edilir. "sqljs" projesinde demonun veritabanıyla da koşar.
 */
const TY = { supplierId: '777', apiKey: 'anahtar', apiSecret: 'gizli' };
const YS = { username: 'pos-kullanici', password: 'pos-parola' };
const GK = { appSecretKey: 'uygulama-anahtari', restaurantSecretKey: 'restoran-anahtari' };
const CLOUD_SECRET = 'c'.repeat(40);

let h: Harness;
let ty: FakeTrendyol;
let ys: FakeYemeksepeti;
let gf: FakeGetir;
let live: typeof import('../server/delivery/live');
let service: typeof import('../server/delivery/service');
let ids: { kasa: string; garson: string };

beforeAll(async () => {
  ty = await startFakeTrendyol(TY);
  ys = await startFakeYemeksepeti(YS);
  gf = await startFakeGetir(GK);
  h = await startApp({
    TRENDYOL_SUPPLIER_ID: TY.supplierId,
    TRENDYOL_API_KEY: TY.apiKey,
    TRENDYOL_API_SECRET: TY.apiSecret,
    TRENDYOL_API_URL: ty.url,
    YEMEKSEPETI_MW_URL: ys.url,
    YEMEKSEPETI_USERNAME: YS.username,
    YEMEKSEPETI_PASSWORD: YS.password,
    YEMEKSEPETI_REMOTE_ID: 'POS_1',
    LAFPOS_CLOUD_URL: ys.url,
    LAFPOS_CLOUD_SECRET: CLOUD_SECRET,
    GETIR_APP_SECRET_KEY: GK.appSecretKey,
    GETIR_RESTAURANT_SECRET_KEY: GK.restaurantSecretKey,
    GETIR_API_URL: gf.url,
  });
  live = await import('../server/delivery/live');
  service = await import('../server/delivery/service');
  const { getirAdapter } = await import('../server/delivery/getir');
  const { setAdapter } = await import('../server/delivery/registry');
  setAdapter('getir', getirAdapter({ ...GK, apiUrl: gf.url, cloudUrl: gf.url, cloudSecret: CLOUD_SECRET, stepGapMs: 0, backupEveryMs: 0 }));
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const user = (name: string) => h.boot.users.find((u) => u.name === name)!.id;
  ids = { kasa: user('Kasa'), garson: user('Garson') };
});
afterAll(async () => {
  h.cleanup();
  await Promise.all([ty.close(), ys.close(), gf.close()]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = () => import('../server/db/client');
const list = () => h.ok<{ orders: PlatformOrderDTO[]; settings: Record<string, PlatformSettings>; acceptors: { id: string; name: string }[] }>('patron', 'GET', '/platforms');
const byExt = async (ext: string) => (await list()).orders.find((o) => o.payload.externalId === ext)!;
const audit = () => h.ok<{ action: string; severity: string; orderId: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=300');
const setPlatform = (platform: string, body: Partial<PlatformSettings>) => h.ok<PlatformSettings>('patron', 'PUT', `/platforms/${platform}`, body);
/** Trendyol'a giden kabuller (tüm siparişler ya da bir paket) */
const picked = (ext?: string) => ty.calls.filter((c) => (ext ? c === `PUT ${ext} picked` : c.endsWith(' picked'))).length;

let seq = 5000;
function tyPkg(over: Partial<TrendyolPackage> = {}): TrendyolPackage {
  const id = ++seq;
  const now = Date.now();
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
    lines: [{ productId: 55, name: 'Latte', price: 190, quantity: 1, modifierProducts: [{ name: 'Yulaf sütü', price: 10 }] }],
    payment: { paymentType: 'PAY_WITH_CREDIT_CARD' },
    totalPrice: 200,
    ...over,
  };
}

/** Trendyol paketi gelir, yoklanır (otomatik kabul yoklamanın sonunda) */
async function tyArrive(over: Partial<TrendyolPackage> = {}) {
  const p = tyPkg(over);
  ty.packages.push(p);
  await live.pollPlatform('trendyol');
  return String(p.id);
}

/** Elle yazılmış canlı sipariş (Trendyol Go, gerçek): koşulların tek tek denenmesi */
function payload(over: Partial<PlatformOrderPayload> = {}): PlatformOrderPayload {
  const lines = over.lines ?? [{ externalId: '55', name: 'Latte', qty: 1, unitPrice: 20000, modifiers: [], note: null }];
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  return {
    platform: 'trendyol',
    simulated: false,
    externalId: `el-${++seq}`,
    code: `E${seq}`,
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

async function ingest(p: PlatformOrderPayload) {
  const { tx } = await db();
  const { Effects } = await import('../server/lib/effects');
  const fx = new Effects();
  const res = tx((t) => service.ingestPlatformOrder(t, fx, p));
  fx.flush();
  return res.row;
}

/** Sipariş otomatik kabul edilmez: neden şeritte (DTO `lastError`) ve denetim kaydında, platforma gidilmez */
async function expectSkip(p: PlatformOrderPayload, reason: string | RegExp) {
  const before = picked();
  const row = await ingest(p);
  expect(await live.autoAccept(row.id)).toBe('skipped');
  const dto = (await list()).orders.find((o) => o.id === row.id)!;
  expect(dto.status === 'bekliyor' || dto.status === 'suresi_doldu').toBe(true);
  expect(dto.orderId).toBeNull();
  const note = dto.lastError ?? '';
  expect(note.startsWith('Otomatik kabul edilmedi: ')).toBe(true);
  if (typeof reason === 'string') expect(note).toBe(`Otomatik kabul edilmedi: ${reason}`);
  else expect(note).toMatch(reason);
  expect((await audit()).some((a) => a.action === 'platform.auto_skip' && a.message.includes(p.code))).toBe(true);
  expect(picked()).toBe(before);
  return row;
}

describe('ayar', () => {
  it('varsayılan kapalı; açarken kabul eden etkin ve paket yetkili olmalı (422); açıp kapamak denetim kaydına uyarı', async () => {
    const r = await list();
    expect(r.settings.trendyol).toMatchObject({ autoAccept: false, autoAcceptUserId: null, autoAcceptMaxKurus: 150000 });
    expect(r.acceptors.map((a) => a.name)).toContain('Kasa');
    expect(r.acceptors.map((a) => a.name)).not.toContain('Garson');
    expect((await h.call('kasa', 'PUT', '/platforms/trendyol', { autoAccept: true, autoAcceptUserId: ids.kasa })).status).toBe(403);
    const none = await h.call<{ code: string }>('patron', 'PUT', '/platforms/trendyol', { autoAccept: true });
    expect([none.status, none.json.code]).toEqual([422, 'auto_accept_user']);
    const waiter = await h.call<{ code: string; error: string }>('patron', 'PUT', '/platforms/trendyol', { autoAccept: true, autoAcceptUserId: ids.garson });
    expect([waiter.status, waiter.json.code]).toEqual([422, 'auto_accept_user']);
    expect(waiter.json.error).toMatch(/Garson.*paket yetkisi yok/);
    expect((await h.call('patron', 'PUT', '/platforms/trendyol', { autoAcceptMaxKurus: 50 })).status).toBe(422);
    expect((await list()).settings.trendyol.autoAccept).toBe(false);

    const on = await setPlatform('trendyol', { autoAccept: true, autoAcceptUserId: ids.kasa });
    expect(on).toMatchObject({ autoAccept: true, autoAcceptUserId: ids.kasa, autoAcceptMaxKurus: 150000 });
    let a = (await audit()).find((x) => x.action === 'platform.settings')!;
    expect(a.severity).toBe('uyari');
    expect(a.message).toContain('otomatik kabul açık (Kasa, en çok ₺1.500,00)');
    // Düzenleme gövdesinde gönderilmeyen alan değişmez (patchOf)
    expect(await setPlatform('trendyol', { prepMinutes: 25 })).toMatchObject({ autoAccept: true, autoAcceptUserId: ids.kasa, prepMinutes: 25 });
    expect((await audit()).find((x) => x.action === 'platform.settings')!.severity).toBe('info');
    await setPlatform('trendyol', { autoAccept: false, prepMinutes: 20 });
    a = (await audit()).find((x) => x.action === 'platform.settings')!;
    expect([a.severity, a.message.includes('otomatik kabul kapalı')]).toEqual(['uyari', true]);
  });
});

describe('Canlı', () => {
  beforeAll(async () => {
    // Kurulum modunda ve yazarkasanın eğitim simülatöründe (kurulum verisi onunla başlar) canlı sipariş otomatik kabul
    // edilmez: kasa canlıda
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: false });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'kapali' });
    for (const p of ['trendyol', 'yemeksepeti', 'getir']) await setPlatform(p, { mode: 'canli', autoAccept: true, autoAcceptUserId: ids.kasa });
  });

  it('ayar kapalıyken hiçbir şey değişmez: sipariş notsuz onay bekler, platforma gidilmez', async () => {
    await setPlatform('trendyol', { autoAccept: false });
    const ext = await tyArrive();
    const row = await byExt(ext);
    expect([row.status, row.lastError ?? null]).toEqual(['bekliyor', null]);
    expect(picked(ext)).toBe(0);
    expect(await live.autoAccept(row.id)).toBe('off');
    expect((await audit()).some((a) => a.action === 'platform.auto_skip' && a.message.includes(row.payload.code))).toBe(false);
    await setPlatform('trendyol', { autoAccept: true });
  });

  it('Trendyol Go: yoklamanın yeni siparişi kabul eden kişi adına kabul edilir; platforma bir kez, hazırlık süresiyle', async () => {
    const ext = await tyArrive();
    const row = await byExt(ext);
    expect(row).toMatchObject({ status: 'kabul', decidedBy: 'Kasa', reason: '20 dk, otomatik' });
    expect(picked(ext)).toBe(1);
    expect(ty.bodies.picked?.at(-1)).toEqual({ preparationTime: 20 });
    const o = await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`);
    expect(o).toMatchObject({ type: 'paket', platform: 'trendyol', status: 'acik', total: 20000 });
    expect(o.items[0]).toMatchObject({ name: 'Latte', unitPrice: 20000 });
    const a = (await audit()).find((x) => x.action === 'platform.auto_accept' && x.orderId === row.orderId)!;
    expect(a.message).toMatch(/^Kasa \(otomatik\) Trendyol Go siparişini kabul etti/);
    // Sonraki yoklama ve yeniden deneme (kasa yeniden başladı) ikinci kez kabul etmez, platforma gitmez
    await live.pollPlatform('trendyol');
    expect(await live.autoAccept(row.id)).toBe('not_pending');
    expect(picked(ext)).toBe(1);
  });

  it('Yemeksepeti: aktarıcıdan gelen ödenmiş sipariş kabul edilir; middleware\'e bir kez', async () => {
    const token = `tok-oto-${++seq}`;
    const order: DhOrder = {
      token,
      code: `n0s1-${seq}`,
      shortCode: String(seq),
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
      price: { deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '215.00' },
      products: [{ id: 'P-LATTE', remoteCode: 'latte-m', name: 'Latte', quantity: '1', unitPrice: '190.00', paidPrice: '190.00', selectedToppings: [], comment: null }],
      callbackUrls: { orderAcceptedUrl: `${ys.url}/cb/accepted/${token}`, orderRejectedUrl: `${ys.url}/cb/rejected/${token}`, orderPickedUpUrl: `${ys.url}/cb/pickedup/${token}`, orderPreparedUrl: `${ys.url}/cb/prepared/${token}` },
      localInfo: { platform: 'Yemeksepeti', platformKey: 'YS_TR' },
    };
    const item: YsInboxItem = { id: `in-${token}`, kind: 'order', remoteId: 'POS_1', receivedAt: Date.now(), order };
    ys.inbox.push(item);
    await live.pollPlatform('yemeksepeti');
    const row = await byExt(token);
    expect(row).toMatchObject({ status: 'kabul', decidedBy: 'Kasa' });
    expect(ys.count(`POST /cb/accepted/${token}`)).toBe(1);
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`)).total).toBe(19000);
  });

  it('Getir: aktarıcıdan gelen online sipariş kabul edilir; Getir\'e bir kez verify', async () => {
    const id = `ord-oto-${++seq}`;
    const order: GetirOrder = {
      id,
      status: 400,
      isScheduled: false,
      confirmationId: String(seq),
      client: { id: 'cl-1', name: 'Ayşe K.' },
      products: [{ id: 'line-1', product: 'prd-latte', count: 1, name: { tr: 'Latte', en: 'Latte' }, price: 190, priceWithOption: 190, totalPriceWithOption: 190 }],
      totalPrice: 190,
      totalDiscountedPrice: 190,
      checkoutDate: new Date().toISOString(),
      deliveryType: 1,
      paymentMethod: 1,
      paymentMethodText: { tr: 'MasterPass', en: 'MasterPass' },
      restaurant: { id: 'rest-1', name: "L'Affogato" },
    };
    const item: GetirInboxItem = { id: `in-${id}`, kind: 'order', receivedAt: Date.now(), order };
    gf.inbox.push(item);
    await live.pollPlatform('getir');
    const row = await byExt(id);
    expect(row).toMatchObject({ status: 'kabul', decidedBy: 'Kasa' });
    expect(gf.count(`POST ${id} verify`)).toBe(1);
  });

  it('koşul tutmayan sipariş elle kabul bekler: nedeni şeritte; elle Kabul her zamanki gibi', async () => {
    const ext = await tyArrive({ lines: [{ productId: 991, name: 'Menüde olmayan tatlı', price: 120, quantity: 1 }], totalPrice: 120 });
    const row = await byExt(ext);
    expect(row.status).toBe('bekliyor');
    expect(row.lastError).toBe('Otomatik kabul edilmedi: eşleşmeyen kalem (Menüde olmayan tatlı)');
    expect(picked(ext)).toBe(0);
    const res = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, { prepMinutes: 15 });
    expect(picked(ext)).toBe(1);
    expect(await byExt(ext)).toMatchObject({ status: 'kabul', orderId: res.orderId, lastError: null, reason: '15 dk' });
  });

  it('koşulların her biri: test, deneme siparişi, tablette ya da panelde kabul, ileri tarihli, süre, tahsilat, tutar, eşleme, tükenmiş', async () => {
    await expectSkip(payload({ test: true }), 'platformun test siparişi');
    await expectSkip(payload({ simulated: true }), 'deneme siparişi');
    await expectSkip(payload({ preAccepted: true }), 'platformun tabletinde kabul edilmiş');
    await expectSkip(payload({ scheduledFor: Date.now() + 3600_000 }), 'ileri tarihli sipariş');
    await expectSkip(payload({ scheduledUnknown: true }), 'ileri tarihli sipariş');
    await expectSkip(payload({ expiresAt: Date.now() + 10_000 }), 'kabul süresi dolmak üzere');
    await expectSkip(payload({ courier: 'restoran', platformCollects: false, paymentLabel: 'Kapıda nakit' }), 'ödeme kasada alınacak');
    await expectSkip(payload({ amountReview: "Trendyol'da ödenen ₺999,00, kalemler ₺200,00: farkı Trendyol'dan doğrulayın" }), "Trendyol'da ödenen ₺999,00, kalemler ₺200,00: farkı Trendyol'dan doğrulayın");
    const bad = 'platformun tutarları birbirini tutmuyor';
    await expectSkip(payload({ subtotal: 21000, customerTotal: 21000 }), bad);
    await expectSkip(payload({ customerTotal: 15000 }), bad);
    await expectSkip(payload({ restaurantDiscount: 20000, customerTotal: 0 }), bad);
    await expectSkip(payload({ lines: [{ externalId: '55', name: 'Latte', qty: 1.5, unitPrice: 20000, modifiers: [], note: null }], subtotal: 30000, customerTotal: 30000 }), bad);
    await expectSkip(payload({ lines: [{ externalId: '55', name: 'Latte', qty: 1, unitPrice: 20000.5, modifiers: [], note: null }], subtotal: 20000.5, customerTotal: 20000.5 }), bad);
    await expectSkip(payload({ lines: [{ externalId: '55', name: 'Latte', qty: 9, unitPrice: 20000, modifiers: [], note: null }] }), 'tutar ₺1.500,00 sınırının üstünde');
    // Ücret satırı eşlenmemiş olabilir; ürün kalemi olamaz
    await expectSkip(payload({ lines: [{ externalId: 'x-tatli', name: 'Menüde olmayan tatlı', qty: 1, unitPrice: 12000, modifiers: [], note: null }] }), 'eşleşmeyen kalem (Menüde olmayan tatlı)');
    // Platformun panelinden kabul edilmiş (kasada adisyonu yok): Kabul yalnız adisyonu açar, elle
    const { db: d, schema } = await db();
    const { eq } = await import('drizzle-orm');
    const elsewhere = payload();
    const row = await ingest(elsewhere);
    d.update(schema.platformOrders).set({ notifiedStatus: 'picked' }).where(eq(schema.platformOrders.id, row.id)).run();
    expect(await live.autoAccept(row.id)).toBe('skipped');
    expect((await list()).orders.find((o) => o.id === row.id)?.lastError).toBe('Otomatik kabul edilmedi: platformda zaten kabul edilmiş');
    // Tükenmiş ürün ve porsiyonu yetmeyen ürün (prova): platforma gidilmez
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    d.update(schema.products).set({ active: false }).where(eq(schema.products.id, latte.id)).run();
    await expectSkip(payload(), 'tükenmiş kalem (Latte)');
    d.update(schema.products).set({ active: true, portionsLeft: 1 }).where(eq(schema.products.id, latte.id)).run();
    await expectSkip(payload({ lines: [{ externalId: '55', name: 'Latte', qty: 2, unitPrice: 20000, modifiers: [], note: null }] }), /^Otomatik kabul edilmedi: adisyon açılamıyor: Latte: son 1 porsiyon kaldı/);
    d.update(schema.products).set({ portionsLeft: null }).where(eq(schema.products.id, latte.id)).run();
  });

  it('kasa kurulum ya da eğitim modunda, gün güncel değil ya da kabul eden uygun değilse çalışmaz (kişide bir kez uyarı)', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: true });
    await expectSkip(payload(), 'kasa kurulum ya da eğitim modunda');
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: false });
    // Yazarkasanın eğitim simülatörü açıkken günün satışı eğitim günüdür: gerçek sipariş ona yazılmaz (yoklamadan da)
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    await expectSkip(payload(), 'kasa kurulum ya da eğitim modunda');
    const ext = await tyArrive();
    expect(await byExt(ext)).toMatchObject({ status: 'bekliyor', orderId: null, lastError: 'Otomatik kabul edilmedi: kasa kurulum ya da eğitim modunda' });
    expect(picked(ext)).toBe(0);
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'kapali' });

    const { db: d, schema } = await db();
    const { eq, isNull } = await import('drizzle-orm');
    const day = d.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get()!;
    d.update(schema.businessDays).set({ date: '2020-01-01' }).where(eq(schema.businessDays.id, day.id)).run();
    await expectSkip(payload(), 'önceki günün gün sonu alınmadı');
    d.update(schema.businessDays).set({ date: day.date }).where(eq(schema.businessDays.id, day.id)).run();

    d.update(schema.users).set({ active: false }).where(eq(schema.users.id, ids.kasa)).run();
    const first = await expectSkip(payload(), 'kabul eden kişi (Kasa) etkin değil');
    const second = await expectSkip(payload(), 'kabul eden kişi (Kasa) etkin değil');
    d.update(schema.users).set({ active: true, permRevoke: ['paket.yonet'] }).where(eq(schema.users.id, ids.kasa)).run();
    await expectSkip(payload(), 'kabul eden kişinin (Kasa) paket yetkisi yok');
    d.update(schema.users).set({ permRevoke: [] }).where(eq(schema.users.id, ids.kasa)).run();
    const skips = (await audit()).filter((a) => a.action === 'platform.auto_skip');
    const sev = (code: string) => skips.find((a) => a.message.includes(code))!.severity;
    expect([sev(first.payload.code), sev(second.payload.code)]).toEqual(['uyari', 'info']);
  });

  it('platform kabulü reddederse kayıt elle kabul bekler (platformun hatası şeritte, uyarı); tek platform çağrısı', async () => {
    ty.statusFor.picked = [500];
    const ext = await tyArrive();
    const row = await byExt(ext);
    expect(row.status).toBe('bekliyor');
    expect(row.lastError).toMatch(/^Trendyol Go: kabul bildirilemedi/);
    expect(picked(ext)).toBe(1);
    const a = (await audit()).find((x) => x.action === 'platform.auto_skip' && x.message.includes(row.payload.code))!;
    expect([a.severity, a.message.includes('platform kabulü almadı')]).toEqual(['uyari', true]);
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(picked(ext)).toBe(2);
    expect((await byExt(ext)).status).toBe('kabul');
  });

  it('platform kabul edip adisyon açılamazsa alarm; Kabul yalnız adisyonu açar, platforma ikinci kez gidilmez', async () => {
    const { db: d, schema } = await db();
    const { eq } = await import('drizzle-orm');
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    // Platform kabul ederken son Latte satıldı
    ty.before.picked = () => d.update(schema.products).set({ active: false }).where(eq(schema.products.id, latte.id)).run();
    const p = tyPkg();
    ty.packages.push(p);
    const ext = String(p.id);
    await live.pollPlatform('trendyol');
    delete ty.before.picked;
    const row = await byExt(ext);
    expect(row.status).toBe('bekliyor');
    expect(row.announced).toBe(true);
    expect(row.lastError).toMatch(/^Platformda kabul edildi ama adisyon açılamadı/);
    expect(picked(ext)).toBe(1);
    expect((await audit()).some((a) => a.action === 'platform.accept_failed' && a.severity === 'alarm' && a.message.includes(row.payload.code))).toBe(true);
    // Otomatik kabul yeniden denense de (panelden kabul edilmiş gibi) elle kalır
    expect(await live.autoAccept(row.id)).toBe('skipped');
    expect((await byExt(ext)).lastError).toMatch(/^Platformda kabul edildi/);
    d.update(schema.products).set({ active: true }).where(eq(schema.products.id, latte.id)).run();
    await h.ok('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(picked(ext)).toBe(1);
    expect((await byExt(ext)).status).toBe('kabul');
  });

  it('elle kabulle yarış: biri kabul ederken öteki 409 busy; otomatik kabul o kayda dönmez, çift kabul yok', async () => {
    // Elle kabul sürerken otomatik kabul gelir: karar kişinin, otomatik kabul kaydı bırakır (yeniden denemez)
    await setPlatform('trendyol', { autoAccept: false });
    const ext = await tyArrive();
    const row = await byExt(ext);
    await setPlatform('trendyol', { autoAccept: true });
    ty.delayFor.picked = 300;
    const manual = h.call<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    for (let i = 0; i < 100 && picked(ext) === 0; i++) await sleep(10);
    expect(await live.autoAccept(row.id)).toBe('busy');
    expect((await manual).status).toBe(200);
    await live.pollPlatform('trendyol');
    expect(picked(ext)).toBe(1);
    // Elle kabul otomatik kabulün "kasada karar veriliyor" notunu temizler
    expect(await byExt(ext)).toMatchObject({ status: 'kabul', reason: '20 dk', lastError: null });

    // Otomatik kabul sürerken elle Kabul
    await setPlatform('trendyol', { autoAccept: false });
    const ext2 = await tyArrive();
    const row2 = await byExt(ext2);
    await setPlatform('trendyol', { autoAccept: true });
    const auto = live.autoAccept(row2.id);
    const busy = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row2.id}/accept`, {});
    expect([busy.status, busy.json.code]).toEqual([409, 'busy']);
    expect(await auto).toBe('accepted');
    delete ty.delayFor.picked;
    expect(picked(ext2)).toBe(1);
    expect(await byExt(ext2)).toMatchObject({ status: 'kabul', reason: '20 dk, otomatik' });
  });

  it('otomatik kabul platform çağrısındayken Reddet: 409 auto_accepting ve ileti (başka ekran değil); ret denemesi denetimde, kayıt kasadaki karar', async () => {
    await setPlatform('trendyol', { autoAccept: false });
    const ext = await tyArrive();
    const row = await byExt(ext);
    await setPlatform('trendyol', { autoAccept: true });
    ty.delayFor.picked = 300;
    const auto = live.autoAccept(row.id);
    const rej = await h.call<{ code: string; error: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect([rej.status, rej.json.code, rej.json.error]).toEqual([409, 'auto_accepting', 'Otomatik kabul ediliyor; kabul edilirse adisyondan iptal edin']);
    // Ret denemesi kayıt: kasadaki karar sayılır (kabul düşseydi otomatik kabul yeniden denemezdi)
    const { manualDecision } = await import('../server/delivery/locks');
    expect(manualDecision.has(row.id)).toBe(true);
    expect(await auto).toBe('accepted');
    delete ty.delayFor.picked;
    expect(ty.count(`PUT ${ext} unsupplied`)).toBe(0);
    expect((await byExt(ext)).status).toBe('kabul');
    const tried = (await audit()).filter((a) => a.action === 'platform.reject_try' && a.message.includes(`${row.payload.code} `));
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatchObject({ severity: 'info' });
    expect(tried[0]!.message).toBe(`Kasa Trendyol Go ${row.payload.code} siparişini reddetmek istedi (Çok yoğunuz); otomatik kabul o an sürüyordu, ret gitmedi`);
    // Kilit bitince Reddet bugünkü gibi: sipariş artık onay beklemiyor
    const late = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Çok yoğunuz' });
    expect([late.status, late.json.code]).toEqual([409, 'not_pending']);
  });

  it('elle ret platforma gidemedi (aynı yoklamada): otomatik kabul personelin reddetmeye çalıştığı siparişi kabul etmez', async () => {
    const a = tyPkg();
    const b = tyPkg();
    ty.packages.push(a, b);
    const extA = String(a.id);
    const extB = String(b.id);
    // İlk siparişin otomatik kabulü platformda beklerken personel ikincisini reddeder; ret platforma gidemez
    ty.delayFor.picked = 400;
    ty.statusFor.unsupplied = [500];
    const poll = live.pollPlatform('trendyol');
    for (let i = 0; i < 200 && picked(extA) === 0; i++) await sleep(10);
    const rowB = await byExt(extB);
    expect(rowB.status).toBe('bekliyor');
    const rej = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${rowB.id}/reject`, { reason: 'Ürün kalmadı' });
    expect([rej.status, rej.json.code]).toEqual([502, 'platform_unreachable']);
    await poll;
    delete ty.delayFor.picked;
    expect((await byExt(extA)).status).toBe('kabul');
    const after = await byExt(extB);
    expect([after.status, after.orderId]).toEqual(['bekliyor', null]);
    expect(after.lastError).toMatch(/^Trendyol Go: ret bildirilemedi/);
    expect(picked(extB)).toBe(0);
    expect((await audit()).some((x) => x.action === 'platform.auto_skip' && x.message.includes(`${after.payload.code}: otomatik kabul edilmedi (kasada karar denendi)`))).toBe(true);
    // Kasa yeniden başlasa da (süreç belleği boş) kayıttaki not otomatik kabulü durdurur
    const { manualDecision } = await import('../server/delivery/locks');
    manualDecision.delete(after.id);
    expect(await live.autoAccept(after.id)).toBe('skipped');
    expect(picked(extB)).toBe(0);
    // Platform düzelince personel yeniden reddeder
    await h.ok('kasa', 'POST', `/platforms/orders/${after.id}/reject`, { reason: 'Ürün kalmadı' });
    expect((await byExt(extB)).status).toBe('ret');
    expect(picked(extB)).toBe(0);
  });

  it('elle ret sürerken otomatik kabul gelir (busy): kayıt elle kalır; ret düşünce sonraki yoklama da kabul etmez', async () => {
    await setPlatform('trendyol', { autoAccept: false });
    const ext = await tyArrive();
    const row = await byExt(ext);
    await setPlatform('trendyol', { autoAccept: true });
    // Platform yavaş ve sonunda 500
    ty.delayFor.unsupplied = 300;
    ty.statusFor.unsupplied = [500];
    const reject = h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/reject`, { reason: 'Ürün kalmadı' });
    for (let i = 0; i < 100 && ty.count(`PUT ${ext} unsupplied`) === 0; i++) await sleep(10);
    expect(await live.autoAccept(row.id)).toBe('busy');
    const r = await reject;
    expect([r.status, r.json.code]).toEqual([502, 'platform_unreachable']);
    delete ty.delayFor.unsupplied;
    // Eskiden "busy" sonraki yoklamada yeniden denenir ve kabul edilirdi
    await live.pollPlatform('trendyol');
    expect(await live.autoAccept(row.id)).toBe('skipped');
    const after = await byExt(ext);
    expect([after.status, after.orderId]).toEqual(['bekliyor', null]);
    expect(after.lastError).toMatch(/^Trendyol Go: ret bildirilemedi/);
    expect(picked(ext)).toBe(0);
    const skips = (await audit()).filter((x) => x.action === 'platform.auto_skip' && x.message.includes(`${row.payload.code}:`));
    expect(skips.some((x) => x.message.includes('(kasada karar veriliyor)'))).toBe(true);
    expect(skips.some((x) => x.message.includes('(kasada karar denendi)'))).toBe(true);
  });

  it('elle kabul yerelde düştü (kayda hata yazılmadı): otomatik kabul o kayda da dokunmaz', async () => {
    await setPlatform('trendyol', { autoAccept: false });
    const ext = await tyArrive();
    const row = await byExt(ext);
    await setPlatform('trendyol', { autoAccept: true });
    const { db: d, schema } = await db();
    const { eq } = await import('drizzle-orm');
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    // Porsiyon bitti: prova düşer, platforma gidilmez, kayda not yazılmaz
    d.update(schema.products).set({ portionsLeft: 0 }).where(eq(schema.products.id, latte.id)).run();
    const res = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect([res.status, res.json.code]).toEqual([409, 'portions']);
    d.update(schema.products).set({ portionsLeft: null }).where(eq(schema.products.id, latte.id)).run();
    expect((await byExt(ext)).lastError ?? null).toBeNull();
    expect(await live.autoAccept(row.id)).toBe('skipped');
    expect((await byExt(ext)).lastError).toBe('Otomatik kabul edilmedi: kasada karar denendi');
    expect(picked(ext)).toBe(0);
  });
});

describe('Canlı: platformda zaten kabul edilmiş ve eski sipariş', () => {
  it('Getir /verify "zaten onaylı" (2) derse otomatik kabul adisyonu açmaz: bekler, alarm; elle Kabul açar, ikinci verify yok', async () => {
    const id = `ord-ivr-${++seq}`;
    const order: GetirOrder = {
      id,
      status: 400,
      isScheduled: false,
      confirmationId: String(seq),
      client: { id: 'cl-2', name: 'Can D.' },
      products: [{ id: 'line-1', product: 'prd-latte', count: 1, name: { tr: 'Latte', en: 'Latte' }, price: 190, priceWithOption: 190, totalPriceWithOption: 190 }],
      totalPrice: 190,
      totalDiscountedPrice: 190,
      checkoutDate: new Date().toISOString(),
      deliveryType: 1,
      paymentMethod: 1,
      paymentMethodText: { tr: 'MasterPass', en: 'MasterPass' },
      restaurant: { id: 'rest-1', name: "L'Affogato" },
    };
    // Sipariş kasaya gelmeden Getir panelinden ya da IVR'dan onaylanmış (onaylı listede henüz yok)
    gf.statusFor.verify = [{ status: 400, code: 2 }];
    gf.inbox.push({ id: `in-${id}`, kind: 'order', receivedAt: Date.now(), order } satisfies GetirInboxItem);
    await live.pollPlatform('getir');
    delete gf.statusFor.verify;
    const row = await byExt(id);
    expect([row.status, row.orderId, row.announced]).toEqual(['bekliyor', null, true]);
    expect(row.lastError).toBe('Platformun panelinden kabul edildi: Kabul yalnız adisyonu açar');
    expect(gf.count(`POST ${id} verify`)).toBe(1);
    const alarm = (await audit()).find((x) => x.action === 'platform.accepted_elsewhere' && x.message.includes(row.payload.code))!;
    expect(alarm.severity).toBe('alarm');
    expect((await audit()).some((x) => x.action === 'platform.auto_accept' && x.message.includes(row.payload.code))).toBe(false);
    // Yeniden denense de (kasa yeniden başladı) elle kalır
    expect(await live.autoAccept(row.id)).toBe('skipped');
    expect((await byExt(id)).orderId).toBeNull();
    // Elle Kabul yalnız adisyonu açar: Getir'e ikinci kez gidilmez
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    expect(gf.count(`POST ${id} verify`)).toBe(1);
    expect(await byExt(id)).toMatchObject({ status: 'kabul', orderId, decidedBy: 'Kasa' });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`)).status).toBe('acik');
  });

  it('elle Kabul\'de Getir "zaten onaylı" derse adisyon her zamanki gibi açılır (davranış değişmedi)', async () => {
    await setPlatform('getir', { autoAccept: false });
    const id = `ord-el-${++seq}`;
    const order: GetirOrder = {
      id,
      status: 400,
      confirmationId: String(seq),
      products: [{ id: 'line-1', product: 'prd-latte', count: 1, name: { tr: 'Latte' }, price: 190, priceWithOption: 190, totalPriceWithOption: 190 }],
      totalPrice: 190,
      checkoutDate: new Date().toISOString(),
      deliveryType: 1,
      paymentMethod: 1,
      restaurant: { id: 'rest-1' },
    };
    gf.inbox.push({ id: `in-${id}`, kind: 'order', receivedAt: Date.now(), order } satisfies GetirInboxItem);
    await live.pollPlatform('getir');
    const row = await byExt(id);
    expect(row.status).toBe('bekliyor');
    gf.statusFor.verify = [{ status: 400, code: 2 }];
    const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
    delete gf.statusFor.verify;
    expect(await byExt(id)).toMatchObject({ status: 'kabul', orderId, lastError: null });
    await setPlatform('getir', { autoAccept: true });
  });

  it('bağlantı kopukken birikmiş sipariş (2 saat önce oluşmuş, hâlâ Created) otomatik kabul edilmez: sipariş eski', async () => {
    const { fmtTime } = await import('@shared/time');
    const at = Date.now() - 2 * 3600_000;
    const ext = await tyArrive({ packageCreationDate: at, packageModificationDate: Date.now() - 60_000 });
    const row = await byExt(ext);
    expect([row.status, row.orderId]).toEqual(['bekliyor', null]);
    expect(row.lastError).toBe(`Otomatik kabul edilmedi: sipariş eski (${fmtTime(at)})`);
    expect(picked(ext)).toBe(0);
    // 30 dakikanın içindeki sipariş kabul edilir
    const fresh = await tyArrive({ packageCreationDate: Date.now() - 20 * 60_000 });
    expect((await byExt(fresh)).status).toBe('kabul');
  });
});

describe('bağdaştırıcıların tutar ve ödeme işaretleri', () => {
  it('toplam gelmezse üç bağdaştırıcıda da tutar doğrulanır (otomatik kabul edilmez)', async () => {
    const { fromTrendyolPackage } = await import('../server/delivery/trendyol');
    const { fromGetirOrder } = await import('../server/delivery/getir');
    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    expect(fromTrendyolPackage(tyPkg({ totalPrice: undefined })).amountReview).toBe('Trendyol ödenen tutarı vermedi');
    const g: GetirOrder = { id: 'g-yok', status: 400, products: [{ id: 'l', product: 'prd-latte', count: 1, name: { tr: 'Latte' }, price: 190, priceWithOption: 190, totalPriceWithOption: 190 }], checkoutDate: new Date().toISOString(), deliveryType: 1, paymentMethod: 1 };
    expect(fromGetirOrder(g).amountReview).toBe("Getir toplamı gelmedi: tutarı Getir'den doğrulayın");
    expect(fromGetirOrder({ ...g, totalPrice: 190 }).amountReview).toBeUndefined();
    const paid = fromDhOrder(dh({ deliveryFees: [] }, { status: 'paid', type: 'online' }), 'POS_1');
    expect(paid.amountReview).toBe("Yemeksepeti toplamı gelmedi: tutarı Yemeksepeti'nden doğrulayın");
    expect(paid.customerTotal).toBe(19000);
    const row = await ingest(paid);
    expect(live.autoAcceptBlocker(row)).toBe("Yemeksepeti toplamı gelmedi: tutarı Yemeksepeti'nden doğrulayın");
  });

  it("Yemeksepeti: ödenen toplam kalemleri aşarsa doğrulanır; kurye bahşişi ve Yemeksepeti kuryesinin teslimat ücreti tek başına aşmaz", async () => {
    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    const ok = fromDhOrder(dh({ deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '215.00' }, { status: 'paid', type: 'online' }), 'POS_1');
    expect([ok.amountReview, ok.customerTotal]).toEqual([undefined, 19000]);
    const tip = fromDhOrder(dh({ deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '235.00', riderTip: '20.00' }, { status: 'paid', type: 'online' }), 'POS_1');
    expect([tip.amountReview, tip.customerTotal]).toEqual([undefined, 19000]);
    const over = fromDhOrder(dh({ deliveryFees: [{ name: 'delivery', value: 25 }], grandTotal: '265.00', riderTip: '20.00' }, { status: 'paid', type: 'online' }), 'POS_1');
    expect(over.amountReview).toBe("Yemeksepeti'nde ödenen ₺220,00, kalemler ₺190,00: farkı Yemeksepeti'nden doğrulayın");
    // Adisyon kalemlerle kalır (fark adisyona ve platform alacağına girmez), sipariş elle kabul edilir
    expect(over.customerTotal).toBe(19000);
    await expectSkip(over, "Yemeksepeti'nde ödenen ₺220,00, kalemler ₺190,00: farkı Yemeksepeti'nden doğrulayın");
  });

  it('Trendyol Go: kendi kuryemizin siparişinde tanınmayan ödeme türü doğrulanır; tahsilat davranışı aynı, platform kuryesinde bayrak yok', async () => {
    const { fromTrendyolPackage, paymentOf } = await import('../server/delivery/trendyol');
    const own: Partial<TrendyolPackage> = { deliveryType: 'STORE', storePickupSelected: false, address: { address1: 'Aydınlı Mh.', phone: '0 5** *** ** 90' } };
    const unknown = fromTrendyolPackage(tyPkg({ ...own, payment: { paymentType: 'PAY_WITH_POS' } }));
    expect(unknown.amountReview).toBe("Ödeme türü tanınmadı (PAY_WITH_POS): tahsilatı Trendyol'dan doğrulayın");
    // Elle kabulde tahsilat bugünkü gibi (online sayılır), yalnız işaretli
    expect([unknown.courier, unknown.platformCollects, unknown.paymentLabel]).toEqual(['restoran', true, 'Online kart']);
    expect(fromTrendyolPackage(tyPkg({ payment: { paymentType: 'PAY_WITH_POS' } })).amountReview).toBeUndefined();
    // Tanınan türler: online kart işaretsiz, kapıda nakit kasada
    expect(fromTrendyolPackage(tyPkg({ ...own, payment: { paymentType: 'PAY_WITH_CREDIT_CARD' } })).amountReview).toBeUndefined();
    expect(paymentOf(tyPkg({ payment: 'pay_with_credit_card' }))).toEqual({ online: true, label: 'Online kart' });
    expect(paymentOf(tyPkg({ payment: { paymentType: 'PAY_WITH_CASH' } }))).toEqual({ online: false, label: 'Kapıda nakit' });
    expect(paymentOf(tyPkg({ payment: { paymentType: 'PAY_WITH_POS' } }))).toMatchObject({ online: true, verify: true, raw: 'PAY_WITH_POS' });
  });
});

/** Yemeksepeti siparişi (Yemeksepeti kuryesi, tablette kabul edilmemiş): 1 Latte 190 TL */
function dh(price: DhOrder['price'], payment: DhOrder['payment']): DhOrder {
  return {
    token: `tok-${++seq}`,
    code: `c${seq}`,
    createdAt: new Date().toISOString(),
    delivery: { address: null, expectedDeliveryTime: null, riderPickupTime: new Date(Date.now() + 20 * 60_000).toISOString() },
    expeditionType: 'delivery',
    payment,
    products: [{ id: 'P', remoteCode: 'latte-m', name: 'Latte', quantity: '1', unitPrice: '190.00', selectedToppings: [] }],
    price,
    callbackUrls: { orderAcceptedUrl: `${ys.url}/cb/accepted/tok-${seq}`, orderRejectedUrl: `${ys.url}/cb/rejected/tok-${seq}` },
  };
}

describe('Deneme', () => {
  beforeAll(async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: true });
    await setPlatform('migros', { mode: 'deneme', autoAccept: true, autoAcceptUserId: ids.kasa, autoAcceptMaxKurus: 5_000_000 });
  });

  it('deneme siparişi platforma gitmeden kabul edilir; yanıtta autoAccepted', async () => {
    const res = await h.ok<{ id: string; autoAccepted: boolean }>('kasa', 'POST', '/platforms/migros/test-order', { courier: 'gelal' });
    expect(res.autoAccepted).toBe(true);
    const row = (await list()).orders.find((o) => o.id === res.id)!;
    expect(row).toMatchObject({ status: 'kabul', decidedBy: 'Kasa', reason: '20 dk, otomatik' });
    const o = await h.ok<OrderDTO>('patron', 'GET', `/orders/${row.orderId}`);
    expect(o).toMatchObject({ type: 'gelal', platform: 'migros' });
    expect(o.total).toBe(row.payload.subtotal - row.payload.restaurantDiscount);
  });

  it('ücret satırı eşlenmemiş olabilir; Deneme modunda gerçek sipariş otomatik kabul edilmez', async () => {
    const lines: PlatformOrderPayload['lines'] = [
      { externalId: 'm-latte', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: [], note: null },
      { externalId: 'm-ucret', name: 'Paket ücreti', qty: 1, unitPrice: 500, modifiers: [], note: null, kind: 'fee' },
    ];
    const fee = await ingest(payload({ platform: 'migros', simulated: true, lines, subtotal: 19500, customerTotal: 19500 }));
    expect(await live.autoAccept(fee.id)).toBe('accepted');
    const o = await h.ok<OrderDTO>('patron', 'GET', `/orders/${(await list()).orders.find((x) => x.id === fee.id)!.orderId}`);
    expect(o.items.map((i) => i.name).sort()).toEqual(['Latte', 'Platform ücreti']);
    expect(o.total).toBe(19500);
    await expectSkip(payload({ platform: 'migros' }), 'platform Deneme modunda');
  });

  it('bağdaştırıcılar doğrulanacak siparişi işaretler: Getir farkı ve belirsiz ödeme, Yemeksepeti sıfır tutar, Trendyol ödenen tutar; saati bilinmeyen ileri tarihli', async () => {
    const { fromTrendyolPackage } = await import('../server/delivery/trendyol');
    expect(fromTrendyolPackage(tyPkg()).amountReview).toBeUndefined();
    expect(fromTrendyolPackage(tyPkg({ totalPrice: 999 })).amountReview).toMatch(/Trendyol'da ödenen ₺999,00/);
    expect(fromTrendyolPackage(tyPkg({ totalPrice: undefined })).amountReview).toBe('Trendyol ödenen tutarı vermedi');
    // Ödeme türü yoksa online sayılır: platform kuryesinde önemsiz, kendi kuryemizde tahsilat doğrulanmalı
    expect(fromTrendyolPackage(tyPkg({ payment: undefined })).amountReview).toBeUndefined();
    expect(fromTrendyolPackage(tyPkg({ payment: undefined, deliveryType: 'STORE' })).amountReview).toMatch(/Ödeme türü gelmedi/);
    // Yalnız boşluk da gelmemiş sayılır (`paymentOf`'un kırptığı değer): eskiden işaretlenmeyip otomatik kabul ediliyordu
    for (const payment of [' ', { paymentType: '  ' }] as TrendyolPackage['payment'][]) {
      const own = fromTrendyolPackage(tyPkg({ payment, deliveryType: 'STORE' }));
      expect([own.courier, own.platformCollects, own.paymentLabel]).toEqual(['restoran', true, 'Online']);
      expect(own.amountReview).toBe("Ödeme türü gelmedi: tahsilatı Trendyol'dan doğrulayın");
      expect(fromTrendyolPackage(tyPkg({ payment })).amountReview).toBeUndefined();
    }

    const { fromDhOrder } = await import('../server/delivery/yemeksepeti');
    const dh = (price: DhOrder['price'], payment: DhOrder['payment']): DhOrder => ({
      token: 'tok-x',
      code: 'c',
      createdAt: new Date().toISOString(),
      delivery: { address: null, expectedDeliveryTime: null, riderPickupTime: new Date(Date.now() + 20 * 60_000).toISOString() },
      expeditionType: 'delivery',
      payment,
      products: [{ id: 'P', name: 'Latte', quantity: '1', unitPrice: '190.00', selectedToppings: [] }],
      price,
      callbackUrls: {},
    });
    expect(fromDhOrder(dh({ grandTotal: '190.00' }, { status: 'paid', type: 'online' }), 'POS_1').amountReview).toBeUndefined();
    const zero = fromDhOrder(dh({ grandTotal: '0.00' }, { status: 'pending', type: 'cash' }), 'POS_1');
    expect(zero).toMatchObject({ courier: 'platform', platformCollects: true, customerTotal: 19000 });
    expect(zero.amountReview).toMatch(/sıfır göründü/);
    const pre = fromDhOrder({ ...dh({ grandTotal: '190.00' }, { status: 'paid', type: 'online' }), preOrder: true, delivery: { address: null, expectedDeliveryTime: null, riderPickupTime: null } }, 'POS_1');
    expect([pre.scheduledFor, pre.scheduledUnknown]).toEqual([null, true]);

    const { fromGetirOrder } = await import('../server/delivery/getir');
    const g = (over: Partial<GetirOrder>): GetirOrder => ({
      id: 'g-1',
      status: 400,
      products: [{ id: 'l', product: 'prd-latte', count: 1, name: { tr: 'Latte' }, price: 190, priceWithOption: 190, totalPriceWithOption: 190 }],
      checkoutDate: new Date().toISOString(),
      deliveryType: 1,
      paymentMethod: 1,
      ...over,
    });
    expect(fromGetirOrder(g({ totalPrice: 190, totalDiscountedPrice: 190 })).amountReview).toBeUndefined();
    const gap = fromGetirOrder(g({ totalPrice: 250, totalDiscountedPrice: 250 }));
    expect(gap.amountReview).toMatch(/farkı Getir'den doğrulayın/);
    expect(gap.note).toContain(gap.amountReview!);
    // Kendi kuryemiz, ödeme türü bilinmiyor: online mı kapıda mı tahmin
    expect(fromGetirOrder(g({ totalPrice: 190, deliveryType: 2, paymentMethod: 77 })).amountReview).toMatch(/Getir'den doğrulayın/);
    expect(fromGetirOrder(g({ totalPrice: 190, paymentMethod: 77 })).amountReview).toBeUndefined();
    expect(fromGetirOrder(g({ totalPrice: 190, isScheduled: true })).scheduledUnknown).toBe(true);
  });
});
