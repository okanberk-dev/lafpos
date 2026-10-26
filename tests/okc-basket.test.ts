import { describe, expect, it } from 'vitest';
import { calcOrder } from '@shared/order-calc';
import { autoSectionMap, type BasketSourceItem, buildBasket, salePayments } from '../server/okc/basket';
import { billableMinutes, roomCharge } from '../server/services/rooms';
import { statusCode } from '../server/okc/tokenx';

const item = (p: Partial<BasketSourceItem> & { id: string }): BasketSourceItem => ({
  name: 'Latte',
  size: 'M',
  qty: 1,
  paidQty: 0,
  unitPrice: 19500,
  kdvRate: 10,
  voided: false,
  complimentary: false,
  ...p,
});

const base = { basketId: '00000000-0000-4000-8000-000000000001', orderNo: 12, title: 'S1', sectionMap: { '1': 3, '10': 1, '20': 2 }, sizeLabels: { M: 'Orta', L: 'Büyük' } };

describe('TokenX sepeti', () => {
  it('fiş toplamı LafPOS toplamıyla kuruşu kuruşuna aynı (adisyon indirimi kalemlere adjust olarak)', () => {
    const items = [item({ id: 'a', qty: 3, unitPrice: 3333 }), item({ id: 'b', unitPrice: 15000, kdvRate: 20, size: 'TEK', name: 'Karaoke' }), item({ id: 'c', voided: true }), item({ id: 'd', complimentary: true })];
    const totals = calcOrder({
      lines: items.map((i) => ({ id: i.id, qty: i.qty, unitPrice: i.unitPrice, kdvRate: i.kdvRate, discount: 0, complimentary: i.complimentary, voided: i.voided })),
      discount: { type: 'percent', value: 15 },
    });
    const { basket, amount, lines } = buildBasket({ ...base, items, totals });
    expect(amount).toBe(totals.total);
    expect(basket.items).toHaveLength(2);
    const fromBasket = basket.items.reduce((a, it) => a + it.price * (it.quantity / 1000) - (it.adjust?.totalValue ?? 0), 0);
    expect(fromBasket).toBe(totals.total);
    expect(basket.items[0]).toMatchObject({ name: 'Latte Orta', price: 3333, quantity: 3000, sectionNo: 1, taxPercent: 1000 });
    expect(basket.items[1]).toMatchObject({ sectionNo: 2, taxPercent: 2000 });
    expect(lines).toEqual([
      { itemId: 'a', qty: 3 },
      { itemId: 'b', qty: 1 },
    ]);
  });

  it('kalem seçimi: yalnız seçilen adetler, ödenmiş adetler atlanır', () => {
    const items = [item({ id: 'a', qty: 3, paidQty: 1, unitPrice: 1000 })];
    const totals = calcOrder({ lines: [{ id: 'a', qty: 3, unitPrice: 1000, kdvRate: 10, discount: 0, complimentary: false, voided: false }] });
    const r = buildBasket({ ...base, items, totals, selection: [{ itemId: 'a', qty: 5 }] });
    expect(r.lines).toEqual([{ itemId: 'a', qty: 2 }]);
    expect(r.amount).toBe(2000);
  });

  it('eşlenmemiş KDV oranı açık hata verir', () => {
    const items = [item({ id: 'a', kdvRate: 8 })];
    const totals = calcOrder({ lines: [{ id: 'a', qty: 1, unitPrice: 19500, kdvRate: 8, discount: 0, complimentary: false, voided: false }] });
    expect(() => buildBasket({ ...base, items, totals })).toThrow(/%8 KDV/);
  });

  it('cihaz sonucu ödemelere çevrilir, fazlası kırpılır, ikram tipi atlanır', () => {
    const pays = salePayments(
      {
        basketID: 'x',
        status: 0,
        paymentItems: [
          { type: 3, amount: 10000, operatorId: 67 },
          { type: 9, amount: 500 },
          { type: 1, amount: 8000 },
        ],
      },
      15000,
    );
    expect(pays).toEqual([
      { kind: 'kart', type: 3, amount: 10000, operatorId: 67, description: null },
      { kind: 'nakit', type: 1, amount: 5000, operatorId: null, description: null },
    ]);
  });

  it('kısım önerisi oranı tutan ilk etkin kısmı seçer', () => {
    expect(
      autoSectionMap([
        { sectionNo: 1, taxPercent: 2000 },
        { sectionNo: 2, taxPercent: 1000, status: 0 },
        { sectionNo: 4, taxPercent: 1000 },
      ]),
    ).toEqual({ '20': 1, '10': 4 });
  });

  it('Token durum kodları belgedeki biçimde', () => {
    expect(statusCode(2)).toBe('0002');
    expect(statusCode('0013')).toBe('0013');
    expect(statusCode(1100)).toBe('1100');
    expect(statusCode(0)).toBe('0');
    expect(statusCode(undefined)).toBeNull();
  });
});

describe('karaoke odası', () => {
  it('faturalama adımı ve en az süre', () => {
    expect(billableMinutes(20 * 60_000, 15, 60)).toBe(60);
    expect(billableMinutes(61 * 60_000, 15, 60)).toBe(75);
    expect(billableMinutes(90 * 60_000, 15, 60)).toBe(90);
    expect(roomCharge(100000, 75)).toBe(125000);
  });
});
