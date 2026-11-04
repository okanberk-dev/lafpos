import { allocate, type Kurus, percentOf, splitEven, splitKdv, tl } from './money';
import { hmToMinutes, istanbulParts } from './time';

/** Servis ücretinin KDV oranı (yiyecek-içecek servisi; yazarkasa sepetindeki servis satırı da bunu kullanır) */
export const SERVICE_KDV_RATE = 10;

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

/** Happy hour kuralı (veritabanı satırı ve açılış verisindeki `HappyHourDTO` aynı alanları taşır) */
export interface HappyHourRule {
  /** 1 = Pazartesi … 7 = Pazar */
  days: number[];
  /** "HH:MM", İstanbul saati */
  start: string;
  end: string;
  percent: number;
  categoryIds: string[];
  productIds: string[];
  active: boolean;
}

/**
 * Ürüne şu an geçerli happy hour indirimi (yüzde, kuralların en yükseği). Gece yarısını aşan aralıkta gece
 * kısmı önceki günün kuralına aittir. Sunucu kalemi eklerken, istemci gönderilmemiş kalemi tahmin ederken
 * aynı fonksiyonu çalıştırır; elle girilen fiyata happy hour uygulanmaz.
 */
export function happyHourPercentAt(rules: HappyHourRule[], product: { id: string; categoryId: string }, nowMs: number): number {
  const p = istanbulParts(nowMs);
  const minute = p.hour * 60 + p.minute;
  let best = 0;
  for (const r of rules) {
    if (!r.active) continue;
    const start = hmToMinutes(r.start);
    const end = hmToMinutes(r.end);
    const inRange = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
    const day = start > end && minute < end ? (p.weekday === 1 ? 7 : p.weekday - 1) : p.weekday;
    if (!inRange || !r.days.includes(day)) continue;
    const scoped = r.productIds.length || r.categoryIds.length;
    const matches = !scoped || r.productIds.includes(product.id) || r.categoryIds.includes(product.categoryId);
    if (matches) best = Math.max(best, r.percent);
  }
  return best;
}

/** Happy hour indirimli birim fiyat: happyHourUnit(14000, 20) = 11200 */
export function happyHourUnit(unit: Kurus, pct: number): Kurus {
  return pct > 0 ? unit - percentOf(unit, pct) : unit;
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
    const r = input.serviceKdvRate ?? SERVICE_KDV_RATE;
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

type DiscountTotals = Pick<OrderTotals, 'gross' | 'lineDiscounts' | 'orderDiscount'>;

/**
 * Adisyon küçülünce (kalem iptali, ikram, başka adisyona taşıma) saklı indirimin büyüyen kısmı: kalan indirim eksi
 * küçülmeden önceki indirim oranının kalan brüte düşen payı. Tutar indirimi aynı kalırken brüt küçülür, kalem
 * indirimi kalanın daha büyük payı olur; yüzde adisyon indiriminde yalnız 1-2 kuruşluk yuvarlama farkı çıkar.
 */
export function discountGrowth(before: DiscountTotals, after: DiscountTotals): Kurus {
  const now = after.lineDiscounts + after.orderDiscount;
  if (now <= 0) return 0;
  if (before.gross <= 0) return now;
  return now - Math.round(((before.lineDiscounts + before.orderDiscount) * after.gross) / before.gross);
}

/** Kalem bazlı ödemenin bir satırı: kaç adet ve (tutarı yazılan ödemelerde) bu adetlere düşen tutar */
export interface PaidItem {
  itemId: string;
  qty: number;
  amount?: Kurus;
}

/** Kalem bazlı ödeme için satır: ödenen adet ve, biliniyorsa, canlı ödemelerin bu satıra ödediği tutar */
export interface ItemPayLine {
  id: string;
  qty: number;
  paidQty: number;
  /** Bilinmiyorsa (tutarı yazılmamış eski ya da yazarkasa ödemesi) null: adet payları sırayla sayılır */
  paidAmount?: Kurus | null;
}

/**
 * Kalemlerin ödeme satırları. Satırın ödenmiş tutarı ancak bütün ödenmiş adetleri tutarı yazılmış canlı
 * ödemelerden geliyorsa bilinir; iptal edilen ödeme sayılmaz. Sunucu ve ödeme ekranı aynı hesabı kullanır.
 */
export function itemPayLines(
  items: { id: string; qty: number; paidQty: number }[],
  payments: { items: PaidItem[] | null; refundedAt?: number | null }[],
): ItemPayLine[] {
  const paid = new Map<string, { qty: number; amount: Kurus | null }>();
  for (const p of payments) {
    if (p.refundedAt) continue;
    for (const s of p.items ?? []) {
      const cur = paid.get(s.itemId) ?? { qty: 0, amount: 0 };
      paid.set(s.itemId, { qty: cur.qty + s.qty, amount: cur.amount != null && s.amount != null ? cur.amount + s.amount : null });
    }
  }
  return items.map((i) => {
    const p = paid.get(i.id);
    const paidAmount = i.paidQty === 0 ? 0 : p && p.qty === i.paidQty ? p.amount : null;
    return { id: i.id, qty: i.qty, paidQty: i.paidQty, paidAmount };
  });
}

/**
 * Kalem bazlı ödemede seçilen adetlerin satır satır tutarı. Kısmi adetler kalemin net payının adetlere bölünmüş
 * paylarından sırayla alınır. Kalemin kalan bütün adetleri seçildiyse kalan payının tamamı alınır: net pay eksi
 * bu satıra şimdiye kadar ödenen (yuvarlama artığı kalmasın). Ödenen tutar bilinmiyorsa paylar sırayla sayılır;
 * daha önce ödenen adetler baştaki payları tüketmiş sayılır. Bilinmesi önemli: baştaki (büyük) payı ödeyen ödeme
 * iptal edilip adet yeniden ödenirse sıradaki pay 1 kuruş küçük kalır, bütün kalemler ödendiği hâlde adisyonda
 * 0,01 ₺ borç kalıyordu (denetim, 26 Eki 2026).
 */
export function itemsBreakdown(
  totals: Pick<OrderTotals, 'lineNet'>,
  lines: ItemPayLine[],
  selection: { lineId: string; qty: number }[],
): { lineId: string; qty: number; amount: Kurus }[] {
  const out: { lineId: string; qty: number; amount: Kurus }[] = [];
  for (const sel of selection) {
    const line = lines.find((l) => l.id === sel.lineId);
    if (!line || sel.qty <= 0) continue;
    const net = totals.lineNet[line.id] ?? 0;
    const unpaid = line.qty - line.paidQty;
    const qty = Math.min(sel.qty, unpaid);
    if (qty <= 0) continue;
    let amount = 0;
    if (qty === unpaid && line.paidAmount != null) amount = Math.max(0, net - line.paidAmount);
    else {
      const perUnitShares = allocate(net, Array.from({ length: line.qty }, () => 1));
      for (let i = line.paidQty; i < line.paidQty + qty; i++) amount += perUnitShares[i] ?? 0;
    }
    out.push({ lineId: line.id, qty, amount });
  }
  return out;
}

/**
 * Bölmede ödenmiş satırların yeniden hesaplanan net payıyla ödenen tutarı arasındaki bu kadar fark yuvarlamadır
 * (`splitLineDiscount`); indirim büyümesi denetimiyle aynı sınır (server/services/orders.ts `approveDiscountShrink`)
 */
const SPLIT_ROUNDING: Kurus = 2;

/** Tamamı ödenmiş, ödenen tutarı bilinen satırlarda net pay eksi ödenen tutarın toplamı (0: ödenenle aynı) */
function settledResidue(totals: Pick<OrderTotals, 'lineNet'>, lines: ItemPayLine[]): Kurus {
  let residue = 0;
  for (const l of lines) if (l.paidQty > 0 && l.paidQty >= l.qty && l.paidAmount != null) residue += (totals.lineNet[l.id] ?? 0) - l.paidAmount;
  return residue;
}

/**
 * Satırın ödenmemiş adetlerinden bir kısmı ayrılırken (iptal, ikram, başka adisyona taşıma) kalem indiriminin kalan
 * ve ayrılan parçaya bölüşü; ikisinin toplamı satırın indirimidir. `input` bölmeden önceki adisyon, `lines` onun
 * ödeme satırları (`itemPayLines`).
 * - Ödenmiş adedi olmayan satırda indirim adetle orantılı bölünür (ayrılan parçanın payı yarım-yukarı yuvarlanır).
 * - Ödenmiş adedi olan satırda kalan adetler kalem bazlı ödemenin adet paylarındaki (`itemsBreakdown`, en büyük kalan)
 *   indirimi korur, ayrılan parça kalanını alır. Kalan adetlerin hepsi ödenmişse adisyon indiriminin yeni dağılımının
 *   yuvarlaması da kapatılır: kalan parçanın indirimi en çok `SPLIT_ROUNDING` kuruş kaydırılarak ödenmiş satırların
 *   net payı ödenen tutara eşitlenir. Daha büyük fark yuvarlama değildir (tutar indirimi kalan adetlere biner): bölüş
 *   değişmez, fazla ödeme eskisi gibi reddedilir.
 * Yoksa ödenmiş satırın yeni payı yazılı ödemeyi 1 kuruşla tutmuyordu: adisyon ₺0,01 borçla ve seçilecek kalem
 * kalmadan açık kalıyor ya da işlem "ödenen yeni toplamı aşıyor" diye reddediliyordu (inceleme, 4 Kas 2026).
 */
export function splitLineDiscount(input: CalcInput, lines: ItemPayLine[], lineId: string, part: number): { kept: Kurus; part: Kurus } {
  const line = input.lines.find((l) => l.id === lineId);
  if (!line || part <= 0) return { kept: line?.discount ?? 0, part: 0 };
  if (part >= line.qty) return { kept: 0, part: line.discount };
  const keep = line.qty - part;
  const pay = lines.find((l) => l.id === lineId);
  if (!pay || pay.paidQty <= 0) {
    const share = Math.round((line.discount * part) / line.qty);
    return { kept: line.discount - share, part: share };
  }
  const gross = lineGross(line);
  const discount = Math.min(Math.max(0, line.discount), gross);
  const unitShares = allocate(gross - discount, Array.from({ length: line.qty }, () => 1));
  const natural = keep * line.unitPrice - unitShares.slice(0, keep).reduce((a, b) => a + b, 0);
  const split = (kept: Kurus) => ({ kept, part: line.discount - kept });
  if (pay.paidQty < keep || pay.paidAmount == null) return split(natural);

  const keptLines = lines.map((l) => (l.id === lineId ? { ...l, qty: keep } : l));
  const residueWith = (kept: Kurus) =>
    settledResidue(calcOrder({ ...input, lines: input.lines.map((l) => (l.id === lineId ? { ...l, qty: keep, discount: kept } : l)) }), keptLines);
  const residue = residueWith(natural);
  if (residue === 0 || Math.abs(residue) > SPLIT_ROUNDING) return split(natural);
  // Net pay ödenenden fazlaysa kalan parçanın indirimi artar, azsa azalır; ayrılan parça kendi brütünden fazlasını almaz
  const step = residue > 0 ? 1 : -1;
  const lo = Math.max(0, discount - part * line.unitPrice);
  const hi = Math.min(discount, keep * line.unitPrice);
  for (let n = 1, kept = natural + step; n <= SPLIT_ROUNDING && kept >= lo && kept <= hi; n++, kept += step) {
    if (residueWith(kept) === 0) return split(kept);
  }
  return split(natural);
}

/** Kalem bazlı ödemede seçilen adetlerin tutarı (`itemsBreakdown` toplamı) */
export function amountForItems(totals: Pick<OrderTotals, 'lineNet'>, lines: ItemPayLine[], selection: { lineId: string; qty: number }[]): Kurus {
  return itemsBreakdown(totals, lines, selection).reduce((a, l) => a + l.amount, 0);
}

/**
 * Kalemin ödenmemiş adetlerinin tutarı ("Kalem seç"te satırın kalanı): satırın kalanının tamamını tek başına seçmek
 * bu tutarı öder. Sunucu kalem ödemesini adisyonun ödenecek kalanıyla sınırlar (`remaining` = toplam − ödenen):
 * kısmi ödemeden sonra adisyona indirim yapılınca ödenmiş adetlerin payı küçülür, kalan adetlerin payı ödenecek
 * kalanı aşabilir. Satır da aynı sınırla gösterilir ki kart terminaline fazla tutar girilmesin. Satır `itemPayLines`'tan
 * verilirse satıra ödenmiş tutar düşülür (seçince alınacak tutarla aynı).
 */
export function unpaidLineAmount(totals: Pick<OrderTotals, 'lineNet'>, line: ItemPayLine, remaining: Kurus): Kurus {
  return Math.min(amountForItems(totals, [line], [{ lineId: line.id, qty: line.qty - line.paidQty }]), Math.max(0, remaining));
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

export interface SplitState {
  /** Hesabın bölündüğü kişi sayısı */
  people: number;
  /** Ödenmiş pay sayısı */
  paid: number;
  /** Ödenmemiş pay sayısı */
  left: number;
  /** Ödenmemiş payların tutarları, sırayla (toplamları kalan tutara eşit; eşit bölüşte kuruş artığı baştakilere) */
  shares: Kurus[];
  /** Paylar elle girildi: `shares` kayıtlı tutarlardır. Eşit bölüşte ya da kayıtlı tutarlar geçersizse false */
  manual: boolean;
}

/** Elle payların doğrulamasındaki hata: Türkçe ileti ve kodu (sunucu 400 olarak döner, ekran aynı iletiyi söyler) */
export interface SplitAmountsError {
  code: 'split_amounts_count' | 'split_amount_kurus' | 'split_amount_positive' | 'split_amounts_total';
  message: string;
}

/**
 * Elle girilen pay tutarları geçerli mi: ödenmemiş her paya bir tutar, her biri tam sayı kuruş ve sıfırdan büyük,
 * toplamı o anki kalan tutara kuruşu kuruşuna eşit. Geçerliyse null. Sunucu kaydederken de okurken de buna bakar:
 * hesap değiştiyse kayıtlı tutarlar tutmaz, eşit bölüşe dönülür (bayat tutar çekilmez)
 */
export function splitAmountsError(amounts: readonly number[], left: number, remaining: Kurus): SplitAmountsError | null {
  if (amounts.length !== left) {
    return { code: 'split_amounts_count', message: `Ödenmemiş ${left} pay var; her paya bir tutar girin (${amounts.length} tutar geldi)` };
  }
  if (amounts.some((a) => !Number.isSafeInteger(a))) return { code: 'split_amount_kurus', message: 'Pay tutarı tam kuruş olmalı' };
  if (amounts.some((a) => a <= 0)) return { code: 'split_amount_positive', message: 'Pay sıfır ya da eksi olamaz' };
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum !== remaining) {
    return { code: 'split_amounts_total', message: `Payların toplamı (${tl(sum)}) kalan tutara (${tl(remaining)}) eşit olmalı` };
  }
  return null;
}

/**
 * Paylaşımlı hesap: kalan tutar ödenmemiş paylara eşit bölünür ya da elle girilen tutarlarla (`amounts`, ödenmemiş
 * payların tutarları sırayla). Elle tutarlar yalnız geçerliyse kullanılır (`splitAmountsError`): bölündükten sonra
 * kalem eklenir, iptal edilir ya da bir pay iptal edilirse sunucu onları düşürür ve paylar kendiliğinden yeniden eşit
 * dağılır; sunucu ödemeyi de bu hesapla alır (istemciye güvenilmez).
 */
export function splitState(people: number, paidShares: number, remaining: Kurus, amounts?: readonly Kurus[] | null): SplitState {
  const left = Math.max(0, people - paidShares);
  if (left <= 0 || remaining <= 0) return { people, paid: paidShares, left, shares: [], manual: false };
  const manual = !!amounts && splitAmountsError(amounts, left, remaining) === null;
  return { people, paid: paidShares, left, shares: manual ? [...amounts!] : splitEven(remaining, left), manual };
}
