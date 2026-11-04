import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amountForItems, itemPayLines } from '@shared/order-calc';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Kalemle ("Kalem seç") kısmen ödenen satırın ödenmemiş adetleri iptal, ikram ya da başka adisyona taşımayla ayrılınca
 * kalan satır ödendiği tutarı korur. Bölme satır indirimini yeniden yuvarlıyor, adisyon indirimi de yeni satırlara
 * yeniden dağılıyordu: ödenmiş satırın yeni payı yazılı ödemeyi 1 kuruşla tutmuyordu. Ya adisyon ₺0,01 borçla açık
 * kalıyordu (seçilecek kalem yok, gün sonu açık adisyon yüzünden alınmıyor) ya da işlem "ödenen yeni toplamı aşıyor"
 * diye reddediliyordu (inceleme, 4 Kas 2026: toplam 51985, ödenen 51984). Her durum tezgâhta ve masada, iptal, ikram
 * ve taşımayla denenir.
 */
let h: Harness;
let tableNo = 0;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  // Beklenen tutarlar bu fiyatlara göre yazıldı; sitenin fiyatı değişse de bozulmasın
  await h.pinPrice('Türk Kahvesi', 13000);
  await h.pinPrice('Latte', 19500);
  await h.pinPrice('Espresso', 11000);
});
afterAll(() => h.cleanup());

type Kind = 'tezgah' | 'masa';
type Op = 'void' | 'comp' | 'move';
type Line = { name: string; qty: number; size?: 'M' };
type PayResult = { order: OrderDTO; closed: boolean; amount: number };

const KINDS: Kind[] = ['tezgah', 'masa'];
const OPS: Op[] = ['void', 'comp', 'move'];
const OP_LABEL: Record<Op, string> = { void: 'iptal', comp: 'ikram', move: 'taşıma' };

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const card = () => h.boot.paymentMethods.find((m) => m.name === 'Kredi kartı')!.id;
const getOrder = (id: string) => h.ok<OrderDTO>('kasa', 'GET', `/orders/${id}`);

/** Tezgâh satışı ya da masada ayrı (yeni) adisyon açıp kalemleri ekler */
async function openOrder(kind: Kind, lines: Line[]) {
  const tables = h.boot.tables.filter((t) => t.kind !== 'oda');
  const body = kind === 'masa' ? { type: 'masa', tableId: tables[tableNo++ % tables.length]!.id, newCheck: true } : { type: 'tezgah' };
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', body);
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: lines.map((l) => ({ productId: product(l.name).id, qty: l.qty, ...(l.size ? { size: l.size } : {}) })),
  });
}

const lineDiscount = (o: OrderDTO, itemId: string, value: number) =>
  h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${itemId}/discount`, { type: 'amount', value, reason: 'Yuvarlama' });
const orderDiscount = (o: OrderDTO, type: 'amount' | 'percent', value: number) =>
  h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/discount`, { type, value, reason: 'Müdavim' });

/** Ödeme ekranının "Kalem seç" hesabı (PaymentModal): sunucu kalem ödemesinde aynı tutarı ister */
async function payItems(o: OrderDTO, sel: { itemId: string; qty: number }[]) {
  const picked = amountForItems(o.totals, itemPayLines(o.items, o.payments), sel.map((s) => ({ lineId: s.itemId, qty: s.qty })));
  const r = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card(), amount: Math.min(o.total - o.paid, picked), items: sel });
  return r.order;
}

/** Ödenmemiş adetleri ayırır: iptal, ikram ya da (masada aynı masanın) yeni adisyonuna taşıma. Kaynak adisyonu döner */
async function splitOff(op: Op, o: OrderDTO, itemId: string, qty: number) {
  const r =
    op === 'move'
      ? await h.call<{ code?: string }>('mudur', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId, qty }] })
      : await h.call<{ code?: string }>('mudur', 'POST', `/orders/${o.id}/items/${itemId}/${op}`, { qty, reason: op === 'void' ? 'Yanlış giriş' : 'Müdür ikramı' });
  expect(r.status, `${OP_LABEL[op]}: ${JSON.stringify(r.json)}`).toBe(200);
  return getOrder(o.id);
}

/** Bütün adetleri ödenmiş satırın net payı ödemesine yazılan tutarla aynı: ödenen adetler ödendikleri payı korur */
function expectSettled(o: OrderDTO, itemId: string) {
  const line = itemPayLines(o.items, o.payments).find((l) => l.id === itemId)!;
  expect(line.paidQty).toBe(line.qty);
  expect(o.totals.lineNet[itemId]).toBe(line.paidAmount);
}

/** Kalan ödenmemiş adetler "Kalem seç"le ödenir; kuruş kalmaz, adisyon kapanır (ödenecek kalmadıysa "Adisyonu kapat") */
async function settle(o: OrderDTO) {
  const left = o.items.filter((i) => !i.voided && !i.complimentary && i.qty - i.paidQty > 0 && (o.totals.lineNet[i.id] ?? 0) > 0);
  if (left.length && o.total - o.paid > 0) o = await payItems(o, left.map((i) => ({ itemId: i.id, qty: i.qty - i.paidQty })));
  expect(o.total - o.paid, `ödenecek ${o.total - o.paid} kuruş kaldı`).toBe(0);
  expect(o.items.filter((i) => !i.voided && !i.complimentary && (o.totals.lineNet[i.id] ?? 0) > 0).every((i) => i.paidQty === i.qty)).toBe(true);
  if (o.status === 'acik') o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/close`);
  expect(o.status).toBe('kapali');
}

describe('kalemle kısmen ödenen satırın ödenmemiş adetleri ayrılınca kuruş kalmaz', () => {
  for (const kind of KINDS) {
    for (const op of OPS) {
      it(`${kind}, ${OP_LABEL[op]}: kalem indirimi (4 kahve, 2,50 ₺ indirim); 2 ya da 3 adet ödendikten sonra kalanı`, async () => {
        // 4 x 130 ₺ - 2,50 ₺ = 517,50 ₺: adet payları 129,38 / 129,38 / 129,37 / 129,37
        for (const [paidQty, paid] of [
          [2, 25876],
          [3, 38813],
        ] as const) {
          let o = await openOrder(kind, [{ name: 'Türk Kahvesi', qty: 4 }]);
          const line = o.items[0]!.id;
          o = await lineDiscount(o, line, 250);
          expect(o.total).toBe(51750);
          o = await payItems(o, [{ itemId: line, qty: paidQty }]);
          expect(o.paid).toBe(paid);
          // Eskiden 2 adet ödenince kalan satırın payı 258,75 ₺ oluyordu: 1 kuruş "fazla ödeme" diye reddediliyordu
          o = await splitOff(op, o, line, 4 - paidQty);
          expect([o.total, o.paid]).toEqual([paid, paid]);
          expectSettled(o, line);
          await settle(o);
        }
      });

      it(`${kind}, ${OP_LABEL[op]}: kalem indirimi ve tutar adisyon indirimi birlikte (0,05 ₺ yuvarlama)`, async () => {
        // Diğer kalem yok: ödenmiş 3 kahvenin payı 388,09 ₺; eskiden kalan satır 388,08 ₺ olup işlem reddediliyordu
        let o = await openOrder(kind, [{ name: 'Türk Kahvesi', qty: 4 }]);
        const line = o.items[0]!.id;
        o = await lineDiscount(o, line, 250);
        o = await orderDiscount(o, 'amount', 5);
        expect(o.total).toBe(51745);
        o = await payItems(o, [{ itemId: line, qty: 3 }]);
        expect(o.paid).toBe(38809);
        o = await splitOff(op, o, line, 1);
        expect([o.total, o.paid]).toEqual([38809, 38809]);
        expectSettled(o, line);
        await settle(o);

        // Espresso önce kalemle ödenmiş: ödenecek kalem kalmaz, iki ödenmiş satırın payı ödenenle aynı kalır
        let p = await openOrder(kind, [{ name: 'Türk Kahvesi', qty: 4 }, { name: 'Espresso', qty: 1, size: 'M' }]);
        const [kahve, espresso] = p.items.map((i) => i.id) as [string, string];
        p = await lineDiscount(p, kahve, 250);
        p = await orderDiscount(p, 'amount', 5);
        p = await payItems(p, [{ itemId: kahve, qty: 3 }]);
        p = await payItems(p, [{ itemId: espresso, qty: 1 }]);
        expect(p.paid).toBe(49809);
        p = await splitOff(op, p, kahve, 1);
        expect([p.total, p.paid]).toEqual([49809, 49809]);
        expectSettled(p, kahve);
        expectSettled(p, espresso);
        await settle(p);
      });

      it(`${kind}, ${OP_LABEL[op]}: tutar adisyon indirimi (10 ₺), kalan kalem kalemle ödenince adisyon kapanır`, async () => {
        // Tutar indirimi aynı kalır, ayrılan kahvenin payı kalanlara biner; ödenmiş kahvelerin fazlası Espresso'nun
        // ödemesinden düşer (ödenecek kalanla sınırlı)
        let o = await openOrder(kind, [{ name: 'Türk Kahvesi', qty: 4 }, { name: 'Espresso', qty: 1, size: 'M' }]);
        const [kahve] = o.items.map((i) => i.id) as [string, string];
        o = await orderDiscount(o, 'amount', 1000);
        expect(o.total).toBe(62000);
        o = await payItems(o, [{ itemId: kahve, qty: 3 }]);
        expect(o.paid).toBe(38382);
        o = await splitOff(op, o, kahve, 1);
        expect(o.total).toBe(49000);
        await settle(o);
      });

      it(`${kind}, ${OP_LABEL[op]}: incelemedeki durum: %25 adisyon indirimi, 4 latte (2,50 ₺ kalem indirimi) ve espresso`, async () => {
        for (const espressoFirst of [true, false]) {
          let o = await openOrder(kind, [{ name: 'Latte', qty: 4, size: 'M' }, { name: 'Espresso', qty: 1, size: 'M' }]);
          const [latte, espresso] = o.items.map((i) => i.id) as [string, string];
          o = await lineDiscount(o, latte, 250);
          o = await orderDiscount(o, 'percent', 25);
          expect(o.total).toBe(66562);
          o = await payItems(o, [{ itemId: latte, qty: 3 }]);
          expect(o.paid).toBe(43734);
          if (espressoFirst) o = await payItems(o, [{ itemId: espresso, qty: 1 }]);
          // Eskiden toplam 519,85 ₺, ödenen 519,84 ₺ kalıyordu ve seçilecek kalem yoktu
          o = await splitOff(op, o, latte, 1);
          expect(o.total).toBe(51984);
          expectSettled(o, latte);
          await settle(o);
        }
      });
    }
  }

  it('tutar indirimi ödenmiş adetlere gerçekten binerse (yuvarlama değil) iptal eskisi gibi fazla ödeme diye reddedilir', async () => {
    // 10 ₺ indirim 4 kahveden 3'üne kalır: ödenmiş 3 kahvenin yeni payı 2,50 ₺ az. Bu yuvarlama değil, önce ödeme iptal edilir
    let o = await openOrder('tezgah', [{ name: 'Türk Kahvesi', qty: 4 }]);
    const line = o.items[0]!.id;
    o = await orderDiscount(o, 'amount', 1000);
    o = await payItems(o, [{ itemId: line, qty: 3 }]);
    expect(o.paid).toBe(38250);
    const r = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/items/${line}/void`, { qty: 1, reason: 'Yanlış giriş' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('overpaid');
    const same = await getOrder(o.id);
    expect([same.total, same.paid, same.items.length]).toEqual([51000, 38250, 1]);
  });
});
