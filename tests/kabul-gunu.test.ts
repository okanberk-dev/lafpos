import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Kabul günü: Marina 22.11.2026'nın LafPOS günü, kasada adisyonlarla kurulur ve gün sonu gövdesi (`POST /api/pos/gun`,
 * docs/03-ENTEGRASYON.md §4) iki deponun ortak dosyasıyla bayt bayt karşılaştırılır: lafmaliyet aynı dosyayı
 * (`tests/fixtures/kabul-gunu-2026-11-22.json`) kendi ayrıştırıcısıyla okur ve aynı rakamları bekler. Rakamlar hesap
 * sözleşmesinin (docs/hesap-sozlesmesi.md) örnek günüdür; her biri aşağıda ayrıca denetlenir. Gün bilerek değişirse
 * yeniden üretilir: LAFPOS_KABUL=1 npx vitest run tests/kabul-gunu.test.ts (lafmaliyet'teki kopya aynı PR serisinde).
 *
 * Gün: açılış ₺1.120,00; liste ₺7.440,00, iki adisyon indirimi (₺52,50 + ₺37,50), ikram ₺130,00, ödenmez ₺935,00,
 * ciro ₺6.285,00 (kart ₺5.030,00, nakit ₺1.255,00, yemek kartı yok), 26 fiş, KDV %10 matrah ₺5.713,64 KDV ₺571,36
 * (adisyon başına yuvarlanmış); 58 ürün ve 2 ek (şurup); yazarkasadan geçmeyen kart ₺870,00 ve nakit ₺200,00; iki kart
 * ödemesi iptali (₺50,00 + ₺45,00); 12 iptal parçası ₺2.395,00 (hazırlanmış ve hazırlanmamış); harcama ₺800,00 (Diğer
 * fatura dışı, fişsiz), beklenen ₺1.575,00, sayılan ₺1.279,50, fark −₺295,50, devir ₺1.279,50. Yazarkasa eğitim
 * cihazı (simülatör) Pavo gibi fiş keser; banka gün sonu yazarkasadan geçen kartı (₺4.160,00) görür.
 */
const FIXTURE = new URL('./fixtures/kabul-gunu-2026-11-22.json', import.meta.url);
const DATE = '2026-11-22';

interface Line { posName: string; siteMenuId: string | null; slot: string | null; qty: number; revenue: number; gross: number; isService: boolean; isAddon: boolean }
interface Payload {
  version: number;
  revision: number;
  correction?: unknown;
  bankPos?: Record<string, unknown>;
  sube: string;
  date: string;
  z: Record<string, number | null> & { vat: { rate: number; base: number; vat: number }[]; okcZNo: string | null; openedAt: string; closedAt: string | null };
  lines: Line[];
  ikram: { posName: string; qty: number; menuValue: number; reason: string | null; kind: string; personKind: string | null }[];
  payments: { name: string; zField: string; channel: string | null; count: number; amount: number }[];
  offDevice: { card: number; cash: number };
  refunds: { amount: number; zField: string; name: string; channel: string | null; reason: string | null }[];
  iptal: { posName: string; siteMenuId: string | null; slot: string | null; qty: number; listValue: number; prepared: boolean; reason: string | null; refund: boolean }[];
}

let h: Harness;

beforeAll(async () => {
  h = await startApp();
  // Gerçek gün: kurulum modu kapalı, gerçek kullanım başlamış. Yazarkasa eğitim cihazında (simülatör): cihazdan geçen
  // ödemenin fişi kesilir, LafPOS'ta alınan ödeme yazarkasadan geçmeyen sayılır
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, liveSince: Date.parse('2026-11-21T23:00:00+03:00') });
  // ModPOS'un son Z'si Z-2026-010 (21.11): LafPOS'un ilk günü Z 11
  await h.ok('patron', 'PUT', '/admin/settings', { zNoStart: 11 });
}, 60_000);
afterAll(() => h.cleanup());

const product = (name: string) => {
  const p = h.boot.products.find((x) => x.name === name);
  if (!p) throw new Error(`Ürün yok: ${name}`);
  return p;
};
const option = (groupKey: string, code: string) => h.boot.optionGroups.find((g) => g.extKey === groupKey)!.items.find((i) => i.code === code)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const user = (name: string) => h.boot.users.find((u) => u.name === name)!;

type Pick = { name: string; size?: 'M' | 'L'; options?: { itemId: string; qty?: number }[] };
/** Kalem kısaltmaları: iki boylu ürün M, tek boylu boy almaz */
const M = (name: string): Pick => ({ name, size: 'M' });
const T = (name: string): Pick => ({ name });
async function sell(items: Pick[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: items.map((i) => ({ productId: product(i.name).id, qty: 1, ...(i.size ? { size: i.size } : {}), ...(i.options ? { options: i.options } : {}) })),
  });
}
/** Adisyonun `n`'inci (0'dan) etkin kalemi bu adla */
const nth = (o: OrderDTO, name: string, n = 0) => o.items.filter((i) => i.name === name && !i.voided && !i.complimentary)[n]!;
const prepare = (o: OrderDTO, name: string, n = 0) => h.ok('kasa', 'POST', '/kitchen/status', { itemIds: [nth(o, name, n).id], status: 'hazirlaniyor' });
const voidItem = (o: OrderDTO, name: string, reason: string, n = 0) => h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${nth(o, name, n).id}/void`, { reason });
const comp = (o: OrderDTO, name: string, body: Record<string, unknown>) => h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${nth(o, name).id}/comp`, body);
const discount = (o: OrderDTO, value: number, reason: string) => h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value, reason });
/** LafPOS'ta alınan ödeme (yazarkasadan geçmez) */
const payHere = (o: OrderDTO, methodName: string, amount = o.total - o.paid) => h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(methodName).id, amount });
/** Yazarkasada (eğitim cihazı) alınan ödeme: sepet gider, cihaz öder, fiş kesilir; 1 nakit, 3 kredi kartı */
async function payOnDevice(o: OrderDTO, type: 1 | 3) {
  const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
  expect(sent.receipt.amount).toBe(o.total);
  await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type, amount: sent.receipt.amount }] });
}
/** Ödemeyi iptal eder (yetkili): kör kasada ödeme kimliği müdürün dökümünden */
async function refundFirstPayment(o: OrderDTO, reason: string) {
  const full = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
  return h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/payments/${full.payments[0]!.id}/refund`, { reason });
}

describe('kabul günü: Marina 22.11.2026', () => {
  let p: Payload;
  let dayId: string;
  let basis: number | null;
  let orderDiscounts: number[];

  beforeAll(async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    dayId = (await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 112000 })).id;

    // A · müdavim masası, ₺52,50 indirim (liste ₺1.365,00: kalemlere 1/26 oranında, kuruş artığı yok); yazarkasada kart
    let a = await sell([M('Latte'), M('Latte'), T('Rosbeef Sandviç'), M('Cappuccino'), M('Türk Kahvesi'), M('Türk Kahvesi'), M('Türk Kahvesi')]);
    a = await discount(a, 5250, 'Müdavim masası');
    await payOnDevice(a, 3);
    // B · iki şuruplu içecek, ₺37,50 indirim (liste ₺500,00, %7,5); yazarkasada kart
    let b = await sell([
      { name: 'Flat White', size: 'M', options: [{ itemId: option('syrup', 'caramel').id }] },
      { name: 'Latte', size: 'L', options: [{ itemId: option('syrup', 'vanilla').id }] },
    ]);
    b = await discount(b, 3750, 'Doğum günü');
    await payOnDevice(b, 3);

    // Yazarkasadan geçmeyen kart (LafPOS'ta alındı) ₺870,00: iki ödeme iptaliyle (₺50,00 ve ₺45,00) ve iki iptalle
    let r1 = await sell([M('Espresso'), M('Espresso')]);
    await prepare(r1, 'Espresso', 1);
    r1 = await voidItem(r1, 'Espresso', 'Yanlış sipariş', 1);
    await payHere(r1, 'Kredi kartı', 5000);
    r1 = await refundFirstPayment(r1, 'Yanlış tutar girildi');
    expect((await payHere(r1, 'Kredi kartı')).closed).toBe(true);
    let r2 = await sell([M('Türk Kahvesi'), M('Türk Kahvesi')]);
    r2 = await voidItem(r2, 'Türk Kahvesi', 'Vazgeçti', 1);
    await payHere(r2, 'Kredi kartı', 4500);
    r2 = await refundFirstPayment(r2, 'Kart reddedildi');
    expect((await payHere(r2, 'Kredi kartı')).closed).toBe(true);
    // ikram (Türk kahvesi), hazırlanmış (Brownie) ve hazırlanmamış (Rosbeef) iptal
    let o3 = await sell([T('Hindi Fümeli Sandviç'), T('Brownie'), T('Brownie'), T('Rosbeef Sandviç'), M('Türk Kahvesi')]);
    await prepare(o3, 'Brownie', 1);
    o3 = await voidItem(o3, 'Brownie', 'Yanlış ürün', 1);
    o3 = await voidItem(o3, 'Rosbeef Sandviç', 'Vazgeçti');
    o3 = await comp(o3, 'Türk Kahvesi', { reason: 'Müdavim' });
    expect((await payHere(o3, 'Kredi kartı')).closed).toBe(true);

    // Yazarkasadan geçmeyen nakit ₺200,00: müşterinin şikâyetiyle ödenmez çay, fazla yazılan iki kalem iptal
    const customer = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Kabul Günü Müşterisi' });
    let o4 = await sell([M('Çay'), T('Su'), T('Soda'), M('Çay'), M('Çay'), T('Su')]);
    o4 = await comp(o4, 'Çay', { kind: 'odenmez', reason: 'Şikâyet', person: { kind: 'customer', id: customer.id } });
    o4 = await voidItem(o4, 'Çay', 'Fazla yazıldı', 1);
    o4 = await voidItem(o4, 'Su', 'Fazla yazıldı', 1);
    expect((await payHere(o4, 'Nakit')).closed).toBe(true);

    // Ödenmez, tutarı 0 kapanan adisyonlar (fiş sayılmaz): personel yemeği; patronun ürün denemesi ("Deneme")
    let staff = await sell([T('Rosbeef Sandviç'), M('Latte')]);
    staff = await comp(staff, 'Rosbeef Sandviç', { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: user('Garson').id } });
    staff = await comp(staff, 'Latte', { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: user('Kasa').id } });
    await h.ok('mudur', 'POST', `/orders/${staff.id}/close`, {});
    let trial = await sell([T('San Sebastian')]);
    trial = await comp(trial, 'San Sebastian', { kind: 'odenmez', reason: 'Deneme', person: { kind: 'user', id: user('Patron').id } });
    await h.ok('mudur', 'POST', `/orders/${trial.id}/close`, {});

    // İptal edilen masa: bar başlamıştı (Mocha, ekstra shot'lı Latte, Rosbeef), başlamamıştı (Cappuccino, San Sebastian)
    const k = await sell([M('Mocha'), { name: 'Latte', size: 'M', options: [{ itemId: option('extraShot', 'extraShot').id, qty: 1 }] }, M('Cappuccino'), T('San Sebastian'), T('Rosbeef Sandviç')]);
    for (const name of ['Mocha', 'Latte', 'Rosbeef Sandviç']) await prepare(k, name);
    await h.ok('mudur', 'POST', `/orders/${k.id}/cancel`, { reason: 'Müşteri gitti' });

    // Yazarkasadan geçen 20 adisyon: kart ₺2.385,00, nakit ₺1.055,00 (toplamları ve KDV yuvarlaması örnek günün)
    const deviceSales: [Pick[], 1 | 3][] = [
      [[M('Latte')], 3],
      [[M('Espresso'), T('Karabuğday Simit')], 3],
      [[M('Espresso'), M('Çay')], 3],
      [[M('Türk Kahvesi'), T('Su')], 1],
      [[M('Americano'), T('Karabuğday Simit')], 1],
      [[T('San Sebastian'), M('Çay')], 3],
      [[M('Espresso'), T('Karabuğday Simit'), T('Karabuğday Simit')], 3],
      [[M('Çay'), M('Çay')], 3],
      [[M('Çay'), M('Çay')], 3],
      [[M('Çay'), M('Çay'), T('Su')], 3],
      [[M('Çay'), M('Çay'), T('Soda')], 1],
      [[M('Çay'), T('Su')], 3],
      [[M('Çay'), T('Soda')], 1],
      [[M('Çay'), M('Çay'), T('Karabuğday Simit')], 1],
      [[T('Su'), T('Su')], 3],
      [[M('Çay'), M('Çay')], 3],
      [[M('Çay')], 1],
      [[T('Soda'), T('Su')], 3],
      [[M('Çay'), M('Çay')], 3],
      [[T('Soda'), M('Çay')], 3],
    ];
    for (const [items, type] of deviceSales) await payOnDevice(await sell(items), type);

    // Kasadan çıkan: Diğer fatura dışı, fişsiz
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'harcama', amount: 80000, description: 'Diğer fatura dışı (fişsiz)' });
    // Satışlar bugünün gününe yazılır (eski güne satış engeli); gün sonundan hemen önce 22.11'e alınır, sayım ₺1.279,50
    db.update(schema.businessDays).set({ date: DATE }).where(eq(schema.businessDays.id, dayId)).run();
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 127950 });
    // Açılış ve kapanış anı saatten bağımsız: gövde bayt bayt aynı kalsın
    db.update(schema.businessDays)
      .set({ openedAt: Date.parse('2026-11-22T08:02:00+03:00'), closedAt: Date.parse('2026-11-23T00:24:00+03:00') })
      .where(eq(schema.businessDays.id, dayId))
      .run();
    // Banka gün sonu (Pavo): batch'te yalnız yazarkasadan geçen kart. LafPOS'un kıyas tutarı yazarkasadan geçmeyen
    // ₺870,00'ı beklemez (okc/service.ts cardBasis)
    const { cardBasis } = await import('../server/okc/service');
    basis = cardBasis(dayId, []).dayCardKurus;
    const { setSyncState } = await import('../server/lib/settings');
    setSyncState(`pavo.eod.${dayId}`, {
      status: 'ok',
      batchNo: '0001',
      at: Date.parse('2026-11-23T00:26:00+03:00'),
      grandTotalKurus: 416000,
      dayCardKurus: basis,
      message: null,
      errorCode: null,
      acquirers: [{ name: 'Garanti BBVA', count: 16, totalKurus: 416000 }],
    });
    orderDiscounts = db
      .select({ totals: schema.orders.totals })
      .from(schema.orders)
      .where(eq(schema.orders.dayId, dayId))
      .all()
      .map((o) => o.totals?.orderDiscount ?? 0)
      .filter((d) => d > 0)
      .sort((x, y) => y - x);

    p = await h.ok<Payload>('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);
    if (process.env.LAFPOS_KABUL === '1') {
      mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(p, null, 2)}\n`);
    }
  }, 120_000);

  it('gövde ortak dosyayla bayt bayt aynı', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    expect(`${JSON.stringify(p, null, 2)}\n`).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('gün, şube, Z ve gönderim sırası', () => {
    expect(p).toMatchObject({ version: 1, revision: 1, sube: 'marina', date: DATE });
    expect(p).not.toHaveProperty('correction');
    expect(p.z.zNo).toBe(11);
    expect(p.z.okcZNo).toBe('11');
    expect([p.z.openedAt, p.z.closedAt]).toEqual(['2026-11-22T05:02:00.000Z', '2026-11-22T21:24:00.000Z']);
  });

  it('liste ₺7.440,00 − indirim ₺90,00 (₺52,50 + ₺37,50) − ikram ₺130,00 − ödenmez ₺935,00 = ciro ₺6.285,00', () => {
    expect(p.z.listValue).toBe(7440);
    expect(p.z.discounts).toBe(90);
    expect(orderDiscounts).toEqual([5250, 3750]);
    expect(p.z.ikramTotal).toBe(130);
    expect(p.z.odenmezTotal).toBe(935);
    expect(p.z.zayiTotal).toBe(0);
    expect(p.z.offRevenue).toBe(1065);
    expect(p.z.zTotal).toBe(6285);
    expect(p.z.listValue! - p.z.discounts! - p.z.ikramTotal! - p.z.odenmezTotal!).toBeCloseTo(p.z.zTotal!, 2);
    expect(p.lines.reduce((a, l) => a + l.revenue, 0)).toBeCloseTo(6285, 2);
    expect(p.lines.reduce((a, l) => a + (l.gross - l.revenue), 0)).toBeCloseTo(90, 2);
  });

  it('kart ₺5.030,00, nakit ₺1.255,00, yemek kartı yok; 26 fiş; KDV %10 matrah ₺5.713,64, KDV ₺571,36', () => {
    expect(p.z).toMatchObject({ card: 5030, cash: 1255, mealCard: 0, online: 0, other: 0, receipts: 26 });
    expect(p.payments.map((x) => [x.name, x.zField, x.amount])).toEqual([
      ['Kredi kartı', 'card', 5030],
      ['Nakit', 'cash', 1255],
    ]);
    expect(p.z.vat).toEqual([{ rate: 10, base: 5713.64, vat: 571.36 }]);
  });

  it('58 ürün ve 2 ek (şurup ₺92,50); Latte M satırı ₺570,00', () => {
    expect(p.lines.filter((l) => !l.isAddon).reduce((a, l) => a + l.qty, 0)).toBe(58);
    expect(p.lines.filter((l) => l.isAddon).reduce((a, l) => a + l.qty, 0)).toBe(2);
    expect(p.lines.find((l) => l.posName === 'SYRUP')).toMatchObject({ qty: 2, revenue: 92.5, gross: 100, isAddon: true, siteMenuId: 'mnu-0080' });
    expect(p.lines.find((l) => l.posName === 'LATTE MEDIUM')).toMatchObject({ qty: 3, revenue: 570, gross: 585, isAddon: false });
    expect(p.lines.every((l) => !l.isService)).toBe(true);
  });

  it('ikram ve ödenmez türleriyle; ödenmezde yalnız kişi türü ("Deneme" patronun ürün denemesi)', () => {
    expect(p.ikram.map((i) => [i.posName, i.menuValue, i.kind, i.personKind, i.reason])).toEqual([
      ['TÜRK KAHVESİ MEDIUM', 130, 'ikram', null, 'Müdavim'],
      ['ÇAY MEDIUM', 60, 'odenmez', 'musteri', 'Ödenmez: Şikâyet'],
      ['ROSBEEF SANDVİÇ', 390, 'odenmez', 'personel', 'Ödenmez: Personel yemeği'],
      ['LATTE MEDIUM', 195, 'odenmez', 'personel', 'Ödenmez: Personel yemeği'],
      ['SAN SEBASTİAN', 290, 'odenmez', 'patron', 'Ödenmez: Deneme'],
    ]);
    const text = JSON.stringify(p);
    for (const secret of ['Garson', 'Kasa"', 'Patron', 'Kabul Günü', user('Garson').id, user('Kasa').id, user('Patron').id]) expect(text).not.toContain(secret);
  });

  it('yazarkasadan geçmeyen kart ₺870,00 ve nakit ₺200,00; iki kart ödemesi iptali ₺50,00 + ₺45,00', () => {
    expect(p.offDevice).toEqual({ card: 870, cash: 200 });
    expect(p.refunds).toEqual([
      { amount: 50, zField: 'card', name: 'Kredi kartı', channel: null, reason: 'Yanlış tutar girildi' },
      { amount: 45, zField: 'card', name: 'Kredi kartı', channel: null, reason: 'Kart reddedildi' },
    ]);
  });

  it('12 iptal parçası ₺2.395,00: hazırlanmış (bar başlamıştı) ve hazırlanmamış; kalem iadesi yok', () => {
    expect(p.iptal).toHaveLength(12);
    expect(p.iptal.reduce((a, r) => a + r.listValue, 0)).toBeCloseTo(2395, 2);
    expect(p.iptal.filter((r) => r.prepared).map((r) => r.posName).sort()).toEqual(['BROWNİE', 'ESPRESSO MEDIUM', 'EXTRA SHOT', 'LATTE MEDIUM', 'MOCHA MEDIUM', 'ROSBEEF SANDVİÇ']);
    expect(p.iptal.filter((r) => !r.prepared).map((r) => r.posName).sort()).toEqual(['CAPPUCCİNO MEDIUM', 'ROSBEEF SANDVİÇ', 'SAN SEBASTİAN', 'SU', 'TÜRK KAHVESİ MEDIUM', 'ÇAY MEDIUM']);
    expect(p.iptal.every((r) => !r.refund && r.qty === 1)).toBe(true);
  });

  it('kasa: açılış ₺1.120,00 + nakit satış ₺1.255,00 − harcama ₺800,00 = beklenen ₺1.575,00; sayılan ₺1.279,50, fark −₺295,50, devir ₺1.279,50', () => {
    expect(p.z).toMatchObject({ openingCash: 1120, cashOut: 800, cashIn: 0, handedOver: 0, expectedCash: 1575, countedCash: 1279.5, cashDiff: -295.5 });
    // Devir = sayılan − gün sonu teslim (LafPOS'ta gün sonu teslim yok): ertesi günün beklenen açılışı
    expect(p.z.countedCash! - p.z.handedOver!).toBe(1279.5);
  });

  it("banka gün sonu: LafPOS yazarkasadan geçmeyen ₺870,00'ı Pavo'nun batch'inde beklemez (fark yok)", () => {
    expect(basis).toBe(416000);
    expect(p.bankPos).toMatchObject({ status: 'ok', pavoCard: 4160, lafposCard: 4160, diff: 0, errorCode: null });
  });
});
