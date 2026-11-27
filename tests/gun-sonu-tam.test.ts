import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitKdv } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';
import { TEL_KART_ALANI } from '@shared/eski-adlar';

/**
 * Gün sonu eksiksiz lafmaliyet'e (sahibin isteği, 24 Kasım 2026): AsilPOS'ta girilen her şey ve kasanın bildiği cihaz
 * (Pavo) verisi gün gövdesinde (docs/03-ENTEGRASYON.md §4.9). Gün denetimdeki Marina 24.11 gününe benzer: yazarkasada
 * nakit ve kart, yazarkasadan geçmeyen kart ve bahşişi, nakit bahşiş, adisyon ve kalem indirimi, yemek kartı, açık
 * hesap ve tahsilatı (kart ve nakit), havale, vardiya sayımı, föyde yazılan kart slipi, gün sonu notu; gün kapandıktan
 * sonra cihazda fişi iptal edilen kart; gün içinde elle ve kapanıştan sonra alınan iki banka gün sonu.
 */

let h: Harness;
let m: { db: typeof import('../server/db/client').db; schema: typeof import('../server/db/client').schema };

beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
  // Yazarkasa eğitim cihazı (simülatör) Pavo gibi fiş keser; gün sonunda fişler Pavo'nunmuş gibi işaretlenir
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
  const client = await import('../server/db/client');
  m = { db: client.db, schema: client.schema };
}, 60_000);
afterAll(() => h.cleanup());

type Batch = { batchNo: string | null; at: string; total: number | null; trigger: string; dayClosed: boolean };
interface Payload {
  bankPos?: Record<string, unknown> & { batches?: Batch[]; dayCard?: number | null };
  z: Record<string, unknown> & { card: number; cash: number; cardTips: number; cardCollections: number; discounts: number; cashIn: number };
  payments: { name: string; zField: string; channel: string | null; count: number; amount: number; kind?: string }[];
  offDevice: { card: number; cash: number; cardTips?: number };
  okc?: {
    provider: string;
    zReport: boolean;
    docs: number;
    cash: number;
    card: number;
    mealCard: number;
    other: number;
    total: number;
    voided: { count: number; cash: number; card: number };
    vat: { rate: number; total: number; vat: number }[] | null;
  };
  collections?: { name: string; zField: string; channel: string | null; kind: string; count: number; amount: number }[];
  shiftCounts?: Record<string, unknown>[];
  discountLines?: { scope: string; posName: string | null; type: string; value: number; amount: number; reason: string | null }[];
}

const product = (name: string) => h.boot.products.find((x) => x.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((x) => x.name === name)!;
type Pick = { name: string; size?: 'M' | 'L'; qty?: number };
async function sell(items: Pick[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}
const payHere = (o: OrderDTO, name: string, extra: Record<string, unknown> = {}) =>
  h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(name).id, amount: o.total - o.paid, ...extra });
/** Yazarkasada (eğitim cihazı) ödenir: 1 nakit, 3 kredi kartı. Sepetin kimliği döner (cihazda fiş iptali için) */
async function payOnDevice(o: OrderDTO, type: 1 | 3) {
  const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
  await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type, amount: sent.receipt.amount }] });
  return sent.receipt.id;
}
const payloadOf = (dayId: string) => h.ok<Payload>('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);
const tl = (k: number) => Math.round(k) / 100;

describe('gün sonu eksiksiz: kasa ve cihaz verisi gövdede', () => {
  let dayId: string;
  let p: Payload;
  let open: Payload;
  const totals: Record<string, number> = {};
  let orderDiscount = 0;
  let expectedAtShift = 0;
  let deviceBasketToVoid = '';

  beforeAll(async () => {
    dayId = (await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 112000 })).id;
    // O1 yazarkasada nakit; O2 yazarkasada kart (gün kapandıktan sonra cihazda fişi iptal edilecek)
    const o1 = await sell([{ name: 'Latte', size: 'M', qty: 2 }]);
    totals.o1 = o1.total;
    await payOnDevice(o1, 1);
    const o2 = await sell([{ name: 'Türk Kahvesi', size: 'M' }, { name: 'Espresso', size: 'M' }]);
    totals.o2 = o2.total;
    deviceBasketToVoid = await payOnDevice(o2, 3);
    // O3 adisyon indirimi %10, kart AsilPOS'ta (yazarkasadan geçmedi) ve ₺20 kart bahşişi
    let o3 = await sell([{ name: 'Latte', size: 'L' }, { name: 'Espresso', size: 'M' }]);
    o3 = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o3.id}/discount`, { type: 'percent', value: 10, reason: 'Müdavim indirimi' });
    orderDiscount = o3.totals.orderDiscount;
    totals.o3 = o3.total;
    await payHere(o3, 'Kredi kartı', { tip: 2000 });
    // O4 yemek kartı; O5 kalem indirimi ₺10, nakit AsilPOS'ta ve ₺10 nakit bahşiş
    await payHere(await sell([{ name: 'San Sebastian' }]), 'Pluxee');
    let o5 = await sell([{ name: 'Türk Kahvesi', size: 'M' }, { name: 'Espresso', size: 'M' }]);
    const espresso = o5.items.find((i) => i.name === 'Espresso')!;
    o5 = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o5.id}/items/${espresso.id}/discount`, { type: 'amount', value: 1000, reason: 'Personel indirimi' });
    totals.o5 = o5.total;
    await payHere(o5, 'Nakit', { tip: 1000 });
    // O6 karaoke kişi başı (%20 KDV) yazarkasada kart
    const o6 = await sell([{ name: 'Karaoke kişi başı', qty: 2 }]);
    totals.o6 = o6.total;
    await payOnDevice(o6, 3);
    // O7 açık hesaba satış; tahsilatı kartla ve nakitle. O8 havale
    const customer = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Tam Gün Müşterisi' });
    const o7 = await sell([{ name: 'Espresso', size: 'M', qty: 4 }]);
    totals.o7 = o7.total;
    await payHere(o7, 'Açık hesap', { customerId: customer.id });
    await h.ok('mudur', 'POST', '/cash/collect', { customerId: customer.id, methodId: method('Kredi kartı').id, amount: 10000 });
    await h.ok('mudur', 'POST', '/cash/collect', { customerId: customer.id, methodId: method('Nakit').id, amount: 5000 });
    await payHere(await sell([{ name: 'Su' }]), 'Havale / EFT');
    // S1 vardiya sayımı ₺10 eksik
    expectedAtShift = (await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day')).summary.expectedCash;
    await h.ok('mudur', 'POST', '/cash/shift-counts', { countedCash: expectedAtShift - 1000 });

    // Gün içinde elle alınan banka gün sonu (gün açık): gövdede batch var, günün bütün kıyası yok (gün açık)
    const { setSyncState } = await import('../server/lib/settings');
    const midday = {
      status: 'ok',
      batchNo: '000278',
      deviceDateTime: null,
      at: Date.parse('2026-11-24T14:10:00+03:00'),
      grandTotalKurus: totals.o2,
      dayCardKurus: null,
      dayCardSinceBatch: null,
      trigger: 'elle',
      dayClosed: false,
      earlier: [],
      message: null,
      errorCode: null,
      acquirers: [],
      prevBatchNo: null,
      dayId,
    };
    setSyncState(`pavo.eod.${dayId}`, midday);
    open = await payloadOf(dayId);

    // C1 gün sonu: sayılan, föyde kart slipi ₺995,00, not (boşluklarıyla)
    const expected = (await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day')).summary.expectedCash;
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: expected - 500, cashCounts: { [`m:${method('Kredi kartı').id}`]: 99500 }, note: '  Gün sonu notu  ' });
    // Gün kapandıktan sonra O2'nin fişi cihazda iptal edildi: AsilPOS'ta ödeme canlı kalır (fis_iptal; Pavo'nun iptal
    // sonucu kapanmış günde böyle işlenir, okc/service.ts `okc.void_closed_day`; eğitim cihazı kapanmış günde iptal etmez)
    m.db.update(m.schema.fiscalReceipts).set({ status: 'fis_iptal' }).where(eq(m.schema.fiscalReceipts.id, deviceBasketToVoid)).run();
    // Fişler Pavo'nun (gerçek cihaz belgesi)
    const orderIds = m.db.select({ id: m.schema.orders.id }).from(m.schema.orders).where(eq(m.schema.orders.dayId, dayId));
    m.db.update(m.schema.fiscalReceipts).set({ provider: 'pavo' }).where(inArray(m.schema.fiscalReceipts.orderId, orderIds)).run();
    // P1 otomatik gün sonu alınamadı, P2 elle yeniden: batch 000279. Günün kaydı öncekini `earlier`'da taşır
    const { cardBasis } = await import('../server/okc/service');
    const earlier = [{ batchNo: '000278', deviceDateTime: null, grandTotalKurus: totals.o2, at: midday.at, trigger: 'elle', dayClosed: false }];
    const since = cardBasis(dayId, earlier as never).dayCardKurus;
    setSyncState(`pavo.eod.${dayId}`, {
      ...midday,
      batchNo: '000279',
      at: Date.parse('2026-11-25T00:31:00+03:00'),
      grandTotalKurus: since,
      dayCardKurus: since,
      dayCardSinceBatch: '000278',
      dayClosed: true,
      earlier,
      prevBatchNo: '000278',
    });
    p = await payloadOf(dayId);
  }, 120_000);

  it('bankPos.batches: günün bütün başarılı banka gün sonları, eskiden yeniye; son batch kıyası eski anlamında', () => {
    expect(p.bankPos!.batches).toEqual([
      { batchNo: '000278', at: '2026-11-24T11:10:00.000Z', total: tl(totals.o2), trigger: 'elle', dayClosed: false },
      { batchNo: '000279', at: '2026-11-24T21:31:00.000Z', total: p.bankPos!.pavoCard, trigger: 'elle', dayClosed: true },
    ]);
    expect(p.bankPos).toMatchObject({ status: 'ok', batchNo: '000279', diff: 0 });
    expect(p.bankPos!.pavoCard).toBe(p.bankPos![TEL_KART_ALANI]);
  });

  it('bankPos.dayCard: günün bütün kıyası = Z kartı + kart bahşişi + kartla tahsilat − yazarkasadan geçmeyen (bahşişiyle) − cihazda iptal edilen', async () => {
    const { cardBasis } = await import('../server/okc/service');
    expect(p.bankPos!.dayCard).toBe(tl(cardBasis(dayId, []).dayCardKurus!));
    const z = p.z;
    expect(p.bankPos!.dayCard).toBeCloseTo(z.card + z.cardTips + z.cardCollections - p.offDevice.card - p.offDevice.cardTips! - p.okc!.voided.card, 2);
    // Karaoke (yazarkasada kart) + kartla tahsilat; O3 (AsilPOS'ta kart, bahşişiyle) ve cihazda iptal edilen O2 yok
    expect(p.bankPos!.dayCard).toBe(tl(totals.o6 + 10000));
  });

  it('gün açıkken: elle alınan batch listede, günün bütün kıyası null', () => {
    expect(open.bankPos!.batches).toEqual([{ batchNo: '000278', at: '2026-11-24T11:10:00.000Z', total: tl(totals.o2), trigger: 'elle', dayClosed: false }]);
    expect(open.bankPos!.dayCard).toBeNull();
  });

  it('okc: yazarkasanın belgeleri (Pavo, mali Z yok), ödeme alanına göre; iptal edilen fiş ayrı; Z − yazarkasadan geçmeyen − iptal', () => {
    const okc = p.okc!;
    expect(okc).toMatchObject({ provider: 'pavo', zReport: false, docs: 2, cash: tl(totals.o1), card: tl(totals.o6), mealCard: 0, other: 0 });
    expect(okc.total).toBeCloseTo(okc.cash + okc.card + okc.mealCard + okc.other, 2);
    expect(okc.voided).toEqual({ count: 1, cash: 0, card: tl(totals.o2) });
    expect(okc.cash).toBeCloseTo(p.z.cash - p.offDevice.cash - okc.voided.cash, 2);
    expect(okc.card).toBeCloseTo(p.z.card - p.offDevice.card - okc.voided.card, 2);
    // KDV tamamlanan belgelerin sepetlerinden, belge başına yuvarlanmış
    const vat = (k: number, rate: number) => tl(splitKdv(k, rate).kdv);
    expect(okc.vat).toEqual([
      { rate: 10, total: tl(totals.o1), vat: vat(totals.o1, 10) },
      { rate: 20, total: tl(totals.o6), vat: vat(totals.o6, 20) },
    ]);
  });

  it('offDevice.cardTips: yazarkasadan geçmeyen kart satışının bahşişi; z.cashTips: nakit bahşiş (cashIn içinde kalır)', () => {
    expect(p.offDevice).toEqual({ card: tl(totals.o3), cash: tl(totals.o5), cardTips: 20 });
    expect(p.z.cashTips).toBe(10);
    // cashIn = nakit tahsilat ₺50 + nakit bahşiş ₺10 (giriş yok)
    expect(p.z.cashIn).toBe(60);
  });

  it('collections: siparişsiz ödemeler ödeme türüne göre; kart satırları z.cardCollections; müşteri yok', () => {
    expect(p.collections).toEqual([
      { name: 'Kredi kartı', zField: 'card', channel: null, kind: 'kart', count: 1, amount: 100 },
      { name: 'Nakit', zField: 'cash', channel: null, kind: 'nakit', count: 1, amount: 50 },
    ]);
    expect(p.collections!.filter((c) => c.zField === 'card').reduce((a, c) => a + c.amount, 0)).toBeCloseTo(p.z.cardCollections, 2);
    expect(JSON.stringify(p)).not.toContain('Tam Gün Müşterisi');
  });

  it('payments[].kind: ödeme türünün türü (açık hesap ile havale ayrılır)', () => {
    expect(Object.fromEntries(p.payments.map((x) => [x.name, x.kind]))).toEqual({
      Nakit: 'nakit',
      'Kredi kartı': 'kart',
      Pluxee: 'yemek',
      'Açık hesap': 'cari',
      'Havale / EFT': 'havale',
    });
  });

  it('z.closeNote (kırpılmış), z.methodCounts (föyde yazılan slip), shiftCounts (kişisiz)', () => {
    expect(p.z.closeNote).toBe('Gün sonu notu');
    expect(p.z.methodCounts).toEqual([{ name: 'Kredi kartı', zField: 'card', channel: null, counted: 995 }]);
    expect(p.shiftCounts).toHaveLength(1);
    const s = p.shiftCounts![0]!;
    expect(s).toEqual({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), counted: tl(expectedAtShift - 1000), expected: tl(expectedAtShift), diff: -10, confirmed: false });
  });

  it('discountLines: adisyon ve kalem indirimi nedeniyle; toplamı z.discounts; indirimi yapan gitmez', () => {
    expect(p.discountLines).toEqual([
      { scope: 'order', posName: null, type: 'percent', value: 10, amount: tl(orderDiscount), reason: 'Müdavim indirimi' },
      { scope: 'item', posName: 'ESPRESSO MEDIUM', type: 'amount', value: 10, amount: 10, reason: 'Personel indirimi' },
    ]);
    expect(p.discountLines!.reduce((a, d) => a + d.amount, 0)).toBeCloseTo(p.z.discounts, 2);
    expect(JSON.stringify(p.discountLines)).not.toMatch(/Müdür|discountBy/);
  });

  it('kişisel veri yok: kullanıcı adı ve kimliği gövdede geçmez', () => {
    const text = JSON.stringify(p);
    for (const u of h.boot.users) {
      expect(text).not.toContain(u.id);
      expect(text).not.toContain(`"${u.name}"`);
    }
  });
});

describe('alanların varlığı', () => {
  async function freshDay() {
    const { db, schema } = m;
    const { isNull } = await import('drizzle-orm');
    const openDay = db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get();
    if (openDay) await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    let n = 0;
    for (const d of db.select().from(schema.businessDays).all()) db.update(schema.businessDays).set({ date: `2026-08-${String(++n).padStart(2, '0')}` }).where(eq(schema.businessDays.id, d.id)).run();
    return (await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 0 })).id;
  }

  it('boş gün: listeler boş, not null, föy sayımı ve cihaz yok; Pavo yoksa bankPos (ve batches) yok', async () => {
    const id = await freshDay();
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    const q = await payloadOf(id);
    expect(q).toMatchObject({ collections: [], shiftCounts: [], discountLines: [] });
    expect(q.z).toMatchObject({ cashTips: 0, closeNote: null });
    expect(q.z).not.toHaveProperty('methodCounts');
    expect(q.offDevice).toEqual({ card: 0, cash: 0, cardTips: 0 });
    expect(q).not.toHaveProperty('okc');
    expect(q).not.toHaveProperty('bankPos');
  });

  it('yalnız eğitim cihazının belgesi: okc yok; gerçek cihazın belgesi (Token) varsa okc, mali Z basar', async () => {
    const id = await freshDay();
    const o = await sell([{ name: 'Espresso', size: 'M' }]);
    await payOnDevice(o, 3);
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(await payloadOf(id)).not.toHaveProperty('okc');
    m.db.update(m.schema.fiscalReceipts).set({ provider: 'tokenx' }).where(eq(m.schema.fiscalReceipts.orderId, o.id)).run();
    expect((await payloadOf(id)).okc).toMatchObject({ provider: 'tokenx', zReport: true, docs: 1, cash: 0, card: tl(o.total), voided: { count: 0, cash: 0, card: 0 } });
  });

  it('banka gün sonu alınamadı, önceki batch yok: batches boş; önceki batch varsa o', async () => {
    const id = await freshDay();
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    const { setSyncState } = await import('../server/lib/settings');
    const failed = { status: 'failed', batchNo: null, at: Date.now(), grandTotalKurus: null, dayCardKurus: null, message: 'Günsonu alınamadı (kod 5085)', errorCode: '5085', acquirers: [] };
    setSyncState(`pavo.eod.${id}`, failed);
    expect((await payloadOf(id)).bankPos).toMatchObject({ status: 'failed', batches: [] });
    const at = Date.parse('2026-11-24T14:10:00+03:00');
    setSyncState(`pavo.eod.${id}`, { ...failed, earlier: [{ batchNo: '000278', deviceDateTime: null, grandTotalKurus: 24000, at, trigger: 'elle', dayClosed: false }] });
    expect((await payloadOf(id)).bankPos!.batches).toEqual([{ batchNo: '000278', at: '2026-11-24T11:10:00.000Z', total: 240, trigger: 'elle', dayClosed: false }]);
  });
});
