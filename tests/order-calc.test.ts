import { describe, expect, it } from 'vitest';
import { amountForItems, type CalcInput, calcOrder, type CalcLine, itemPayLines, refundCalc, refundKeeps, remainingDue, splitLineDiscount } from '@shared/order-calc';

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

describe('kalem bölünürken indirimin bölüşü (iptal, ikram, taşıma)', () => {
  /** Satırın ilk `qty` adedini kalem bazlı ödeyen ödeme: tutar ödeme ekranının hesabı (`amountForItems`) */
  const paidLines = (input: CalcInput, paid: Record<string, number>) => {
    const t = calcOrder(input);
    const items = input.lines.map((l) => ({ id: l.id, qty: l.qty, paidQty: paid[l.id] ?? 0 }));
    const payments = Object.entries(paid).map(([id, qty]) => {
      const amount = amountForItems(t, itemPayLines(items.map((i) => ({ ...i, paidQty: 0 })), []), [{ lineId: id, qty }]);
      return { items: [{ itemId: id, qty, amount }] };
    });
    return itemPayLines(items, payments);
  };
  /** Bölmeden sonraki adisyon: kalan parça `kept` indirimiyle kalır, ayrılan parça adisyondan çıkar */
  const after = (input: CalcInput, id: string, part: number, kept: number) =>
    calcOrder({ ...input, lines: input.lines.map((l) => (l.id === id ? { ...l, qty: l.qty - part, discount: kept } : l)) });

  it('ödenmiş adedi olmayan satır eskisi gibi adetle orantılı bölünür', () => {
    const input = { lines: [line({ id: 'a', qty: 4, unitPrice: 13000, discount: 250 })] };
    expect(splitLineDiscount(input, paidLines(input, {}), 'a', 1)).toEqual({ kept: 187, part: 63 });
    const one = { lines: [line({ id: 'a', qty: 3, unitPrice: 13000, discount: 1 })] };
    expect(splitLineDiscount(one, paidLines(one, {}), 'a', 1)).toEqual({ kept: 1, part: 0 });
  });

  it('ödenmiş adetler adet paylarındaki indirimi korur, ayrılan parça kalanını alır', () => {
    // 517,50 ₺ adet payları 129,38 / 129,38 / 129,37 / 129,37: ilk iki adet 258,76 ₺ ödendi
    const input = { lines: [line({ id: 'a', qty: 4, unitPrice: 13000, discount: 250 })] };
    const lines = paidLines(input, { a: 2 });
    expect(lines[0]!.paidAmount).toBe(25876);
    // Orantılı bölüş 125 / 125 olurdu: kalan satır 258,75 ₺, ödenenden 1 kuruş az
    const split = splitLineDiscount(input, lines, 'a', 2);
    expect(split).toEqual({ kept: 124, part: 126 });
    expect(after(input, 'a', 2, split.kept).lineNet.a).toBe(25876);
    // Kalan adetlerin bir kısmı ödenmemişse de ödenmiş adet payını korur; kalanı sonra kalem kalanıyla ödenir
    expect(splitLineDiscount(input, paidLines(input, { a: 1 }), 'a', 1)).toEqual({ kept: 187, part: 63 });
  });

  it('adisyon indiriminin yeni dağılımındaki yuvarlama kalan parçanın indirimiyle kapatılır, gerçek kayma kapatılmaz', () => {
    // İncelemedeki durum: 4 latte (2,50 ₺ kalem indirimi) ve espresso, %25 adisyon indirimi; 3 latte ve espresso ödendi
    const input: CalcInput = {
      lines: [line({ id: 'latte', qty: 4, unitPrice: 19500, discount: 250 }), line({ id: 'espresso', unitPrice: 11000 })],
      discount: { type: 'percent', value: 25 },
    };
    const lines = paidLines(input, { latte: 3, espresso: 1 });
    expect(lines.map((l) => l.paidAmount)).toEqual([43734, 8250]);
    // Adet paylarına göre bölüş 187 / 63: toplam 519,85 ₺, ödenen 519,84 ₺. Kalan parçaya 1 kuruş indirim kayar
    const split = splitLineDiscount(input, lines, 'latte', 1);
    expect(split).toEqual({ kept: 188, part: 62 });
    expect(after(input, 'latte', 1, split.kept).total).toBe(43734 + 8250);

    // 10 ₺ tutar indirimi 4 kahveden 3'üne kalır: ödenmiş kahvelerin payı 2,50 ₺ düşer. Bölüş değişmez (fazla ödeme)
    const amount: CalcInput = { lines: [line({ id: 'a', qty: 4, unitPrice: 13000, discount: 250 })], discount: { type: 'amount', value: 1000 } };
    const paid = paidLines(amount, { a: 3 });
    expect(splitLineDiscount(amount, paid, 'a', 1)).toEqual({ kept: 187, part: 63 });
    expect(paid[0]!.paidAmount! - after(amount, 'a', 1, 187).total).toBe(250);
  });
});

describe('kalem iadesinin hesabı (refundCalc)', () => {
  const line = (id: string, qty: number, unitPrice: number, extra: Partial<CalcLine> = {}): CalcLine => ({ id, qty, unitPrice, kdvRate: 10, discount: 0, complimentary: false, voided: false, ...extra });

  it('indirimsiz adisyonda adet × birim fiyat', () => {
    expect(refundCalc({ lines: [line('a', 3, 19500)] }, [{ lineId: 'a', qty: 1 }])).toEqual({ discount: null, total: 39000, refund: 19500 });
  });

  it('yüzde indirim oranını korur', () => {
    const r = refundCalc({ lines: [line('a', 3, 19500)], discount: { type: 'percent', value: 20 } }, [{ lineId: 'a', qty: 1 }]);
    expect(r).toEqual({ discount: { type: 'percent', value: 20 }, total: 31200, refund: 15600 });
  });

  it('tutar indirimi kalanla orantılı küçülür; iade edilen kalemin payı geri verilir', () => {
    const r = refundCalc({ lines: [line('a', 3, 19500)], discount: { type: 'amount', value: 19500 } }, [{ lineId: 'a', qty: 1 }]);
    expect(r).toEqual({ discount: { type: 'amount', value: 13000 }, total: 26000, refund: 13000 });
    // İki lattede tek latte iadesi adisyonu sıfırlamaz
    expect(refundCalc({ lines: [line('a', 2, 19500)], discount: { type: 'amount', value: 19500 } }, [{ lineId: 'a', qty: 1 }])).toEqual({ discount: { type: 'amount', value: 9750 }, total: 9750, refund: 9750 });
    // Hepsi iade: indirim sıfırlanır, ödenenin tamamı geri verilir
    expect(refundCalc({ lines: [line('a', 2, 19500)], discount: { type: 'amount', value: 19500 } }, [{ lineId: 'a', qty: 2 }])).toEqual({ discount: { type: 'amount', value: 0 }, total: 0, refund: 19500 });
  });

  it('kalem indirimi adetle bölünür; ikram ve iptal satır seçilse de tutar değişmez', () => {
    const lines = [line('a', 2, 10000, { discount: 3000 }), line('b', 1, 5000, { complimentary: true }), line('c', 1, 5000, { voided: true })];
    expect(refundCalc({ lines }, [{ lineId: 'a', qty: 1 }]).refund).toBe(8500);
    expect(refundCalc({ lines }, [{ lineId: 'b', qty: 1 }, { lineId: 'c', qty: 1 }]).refund).toBe(0);
  });

  it('iade her zaman toplam farkıdır: geri verilen + kalan = ödenen', () => {
    for (const discount of [null, { type: 'percent' as const, value: 15 }, { type: 'amount' as const, value: 7777 }]) {
      const input = { lines: [line('a', 3, 19500), line('b', 2, 8950, { discount: 333 }), line('c', 1, 24500)], discount, serviceRate: 0 };
      const paid = calcOrder(input).total;
      const r = refundCalc(input, [{ lineId: 'a', qty: 2 }, { lineId: 'b', qty: 1 }]);
      expect(r.refund + r.total).toBe(paid);
      expect(r.refund).toBeGreaterThan(0);
      expect(r.refund).toBeLessThan(2 * 19500 + 8950);
    }
  });
});

describe('iade sonrası kalan ödemeler (refundKeeps)', () => {
  it('ödemeler alındıkları sırayla kalanı karşılar; son alınandan iade edilir', () => {
    expect(refundKeeps([{ amount: 39000 }, { amount: 19500 }], 19500)).toEqual([19500, 0]);
    expect(refundKeeps([{ amount: 19500 }, { amount: 39000 }], 19500)).toEqual([19500, 0]);
    expect(refundKeeps([{ amount: 19500 }, { amount: 39000 }], 39000)).toEqual([19500, 19500]);
    expect(refundKeeps([{ amount: 19500 }], 0)).toEqual([0]);
  });
});
