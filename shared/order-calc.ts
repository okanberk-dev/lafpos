import { allocate, type Kurus, percentOf, splitKdv } from './money';

/**
 * Adisyon hesabının tek kaynağı. Sunucu her yazmada bunu çalıştırıp sonucu saklar (otoriter); istemci aynı
 * fonksiyonla gönderilmemiş kalemleri anında gösterir. Fiyatlar KDV dahildir.
 */

export interface CalcLine {
  id: string;
  qty: number;
  /** Seçeneklerin fark fiyatları dahil birim fiyat */
  unitPrice: Kurus;
  kdvRate: number;
  /** Kaleme özel indirim, satırın toplamı için (birim değil) */
  discount: Kurus;
  /** İkram: ücretlendirilmez ama değeri raporlanır */
  complimentary: boolean;
  /** İptal: ücretlendirilmez, iptal raporuna girer */
  voided: boolean;
}

export type OrderDiscount = { type: 'percent' | 'amount'; value: number } | null;

export interface CalcInput {
  lines: CalcLine[];
  discount?: OrderDiscount;
  /** Servis ücreti yüzdesi (kafede genelde 0) */
  serviceRate?: number;
  serviceKdvRate?: number;
}

export interface KdvRow {
  rate: number;
  /** KDV dahil tutar */
  gross: Kurus;
  /** Matrah */
  base: Kurus;
  kdv: Kurus;
}

export interface OrderTotals {
  /** İptal ve ikram dışındaki kalemlerin brüt toplamı (adet x birim fiyat) */
  gross: Kurus;
  lineDiscounts: Kurus;
  orderDiscount: Kurus;
  /** İkram edilen kalemlerin liste fiyatı değeri */
  complimentary: Kurus;
  /** İptal edilen kalemlerin liste fiyatı değeri */
  voided: Kurus;
  service: Kurus;
  /** Ödenecek tutar */
  total: Kurus;
  kdv: KdvRow[];
  /** Her kalemin bütün indirimler düşüldükten sonra ödenecek payı (iptal/ikram için 0) */
  lineNet: Record<string, Kurus>;
}

export function lineGross(line: Pick<CalcLine, 'qty' | 'unitPrice'>): Kurus {
  return line.qty * line.unitPrice;
}

export function calcOrder(input: CalcInput): OrderTotals {
  const lineNet: Record<string, Kurus> = {};
  let gross = 0;
  let lineDiscounts = 0;
  let complimentary = 0;
  let voided = 0;

  const chargeable: { line: CalcLine; afterLineDiscount: Kurus }[] = [];
  for (const line of input.lines) {
    const g = lineGross(line);
    if (line.voided) {
      voided += g;
      lineNet[line.id] = 0;
      continue;
    }
    if (line.complimentary) {
      complimentary += g;
      lineNet[line.id] = 0;
      continue;
    }
    const d = Math.min(Math.max(0, line.discount), g);
    gross += g;
    lineDiscounts += d;
    chargeable.push({ line, afterLineDiscount: g - d });
  }

  const subtotal = gross - lineDiscounts;
  let orderDiscount = 0;
  const disc = input.discount;
  if (disc && subtotal > 0) {
    if (disc.type === 'percent') orderDiscount = percentOf(subtotal, Math.min(100, Math.max(0, disc.value)));
    else orderDiscount = Math.min(subtotal, Math.max(0, Math.round(disc.value)));
  }

  // Adisyon indirimini kalemlere matrahları oranında dağıt: KDV dökümü ve kalem bazlı ödeme doğru kalsın.
  const shares = allocate(
    orderDiscount,
    chargeable.map((c) => c.afterLineDiscount),
  );
  const byRate = new Map<number, Kurus>();
  chargeable.forEach((c, i) => {
    const net = c.afterLineDiscount - (shares[i] ?? 0);
    lineNet[c.line.id] = net;
    byRate.set(c.line.kdvRate, (byRate.get(c.line.kdvRate) ?? 0) + net);
  });

  const afterDiscount = subtotal - orderDiscount;
  const service = input.serviceRate ? percentOf(afterDiscount, input.serviceRate) : 0;
  if (service > 0) {
    const r = input.serviceKdvRate ?? 10;
    byRate.set(r, (byRate.get(r) ?? 0) + service);
  }

  const kdv: KdvRow[] = [...byRate.entries()]
    .filter(([, g]) => g !== 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, g]) => {
      const { net, kdv: tax } = splitKdv(g, rate);
      return { rate, gross: g, base: net, kdv: tax };
    });

  return {
    gross,
    lineDiscounts,
    orderDiscount,
    complimentary,
    voided,
    service,
    total: afterDiscount + service,
    kdv,
    lineNet,
  };
}

/**
 * Kalem bazlı ödemede seçilen adetlerin tutarı. Bir kalemin tamamı seçildiyse kalan payının tamamı
 * alınır (yuvarlama artığı kalmasın diye); kısmi adetler orantılı yuvarlanır.
 */
export function amountForItems(
  totals: Pick<OrderTotals, 'lineNet'>,
  lines: { id: string; qty: number; paidQty: number }[],
  selection: { lineId: string; qty: number }[],
): Kurus {
  let sum = 0;
  for (const sel of selection) {
    const line = lines.find((l) => l.id === sel.lineId);
    if (!line || sel.qty <= 0) continue;
    const net = totals.lineNet[line.id] ?? 0;
    const unpaid = line.qty - line.paidQty;
    const qty = Math.min(sel.qty, unpaid);
    if (qty <= 0) continue;
    const perUnitShares = allocate(net, Array.from({ length: line.qty }, () => 1));
    // Daha önce ödenen adetler baştaki payları tüketmiş say; sıradaki `qty` payı topla.
    for (let i = line.paidQty; i < line.paidQty + qty; i++) sum += perUnitShares[i] ?? 0;
  }
  return sum;
}

export interface PaymentLike {
  amount: Kurus;
  refunded?: boolean;
}

export function paidTotal(payments: PaymentLike[]): Kurus {
  return payments.reduce((a, p) => a + (p.refunded ? 0 : p.amount), 0);
}

export function remainingDue(total: Kurus, payments: PaymentLike[]): Kurus {
  return total - paidTotal(payments);
}
