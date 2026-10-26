import { describe, expect, it } from 'vitest';
import { amountForItems, calcOrder, type CalcLine, remainingDue } from '@shared/order-calc';

const line = (p: Partial<CalcLine> & { id: string }): CalcLine => ({
  qty: 1,
  unitPrice: 10000,
  kdvRate: 10,
  discount: 0,
  complimentary: false,
  voided: false,
  ...p,
});

describe('adisyon hesabı', () => {
  it('iptal ve ikram ücretlendirilmez ama raporlanır', () => {
    const t = calcOrder({
      lines: [
        line({ id: 'a', qty: 2, unitPrice: 8500 }),
        line({ id: 'b', unitPrice: 12000, complimentary: true }),
        line({ id: 'c', unitPrice: 9000, voided: true }),
      ],
    });
    expect(t.gross).toBe(17000);
    expect(t.complimentary).toBe(12000);
    expect(t.voided).toBe(9000);
    expect(t.total).toBe(17000);
    expect(t.lineNet).toEqual({ a: 17000, b: 0, c: 0 });
  });

  it('yüzde indirim kalemlere dağıtılır ve KDV dökümü tutar', () => {
    const t = calcOrder({
      lines: [line({ id: 'kahve', unitPrice: 8500 }), line({ id: 'bira', unitPrice: 15000, kdvRate: 20 })],
      discount: { type: 'percent', value: 15 },
    });
    // 23500 * %15 = 3525
    expect(t.orderDiscount).toBe(3525);
    expect(t.total).toBe(19975);
    expect(t.lineNet.kahve + t.lineNet.bira).toBe(19975);
    const kdvGross = t.kdv.reduce((a, r) => a + r.gross, 0);
    expect(kdvGross).toBe(t.total);
    expect(t.kdv.map((r) => r.rate)).toEqual([10, 20]);
    for (const r of t.kdv) expect(r.base + r.kdv).toBe(r.gross);
  });

  it('tutar indirimi ara toplamı aşamaz, kalem indirimi kalemi aşamaz', () => {
    const t = calcOrder({
      lines: [line({ id: 'a', unitPrice: 5000, discount: 9000 })],
      discount: { type: 'amount', value: 100000 },
    });
    expect(t.lineDiscounts).toBe(5000);
    expect(t.total).toBe(0);
  });

  it('servis ücreti indirimden sonra hesaplanır', () => {
    const t = calcOrder({
      lines: [line({ id: 'a', unitPrice: 10000 })],
      discount: { type: 'amount', value: 1000 },
      serviceRate: 10,
    });
    expect(t.service).toBe(900);
    expect(t.total).toBe(9900);
  });

  it('kalem bazlı ödeme: kısmi adetlerin toplamı kalemin tamamına eşit', () => {
    const t = calcOrder({
      lines: [line({ id: 'a', qty: 3, unitPrice: 3333 })],
      discount: { type: 'percent', value: 10 },
    });
    const net = t.lineNet.a;
    const first = amountForItems(t, [{ id: 'a', qty: 3, paidQty: 0 }], [{ lineId: 'a', qty: 1 }]);
    const rest = amountForItems(t, [{ id: 'a', qty: 3, paidQty: 1 }], [{ lineId: 'a', qty: 2 }]);
    expect(first + rest).toBe(net);
    // Ödenmiş adetten fazlası seçilemez
    expect(amountForItems(t, [{ id: 'a', qty: 3, paidQty: 3 }], [{ lineId: 'a', qty: 1 }])).toBe(0);
  });

  it('kalan tutar iade edilen ödemeyi saymaz', () => {
    expect(remainingDue(10000, [{ amount: 4000 }, { amount: 6000, refunded: true }])).toBe(6000);
  });
});
