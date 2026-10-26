import { allocate } from '@shared/money';
import type { OrderTotals } from '@shared/order-calc';
import { TOKENX_PAYMENT, type TokenxBasket, type TokenxItem, type TokenxSale } from './tokenx';

/**
 * Adisyondan cihaz sepeti üretir (saf fonksiyon). Kurallar:
 * - İptal ve ikram kalemleri sepete girmez (ücretsiz).
 * - Her kalem liste fiyatıyla gider; indirim payı kaleme `adjust.totalValue` olarak eklenir, böylece fişin
 *   toplamı LafPOS'un hesabıyla kuruşu kuruşuna aynıdır.
 * - Kalem bazlı seçimde yalnız seçilen adetler gider (indirim payı adetle orantılı, en büyük kalan yöntemi).
 * - KDV oranı cihazdaki kısım (sectionNo) ile eşlenir; eşleşmeyen oran hata verir.
 */

export interface BasketSourceItem {
  id: string;
  name: string;
  size: 'M' | 'L' | 'TEK';
  qty: number;
  paidQty: number;
  unitPrice: number;
  kdvRate: number;
  voided: boolean;
  complimentary: boolean;
}

export interface BuildBasketInput {
  basketId: string;
  orderNo: number;
  title: string;
  filter?: string;
  note?: string;
  items: BasketSourceItem[];
  totals: Pick<OrderTotals, 'lineNet'>;
  /** Seçilmezse ödenmemiş bütün adetler */
  selection?: { itemId: string; qty: number }[] | null;
  sectionMap: Record<string, number>;
  sizeLabels: { M: string; L: string };
  callbackUrl?: string;
}

export interface BuiltBasket {
  basket: TokenxBasket;
  amount: number;
  lines: { itemId: string; qty: number }[];
}

const MAX_NAME = 32;

export function buildBasket(input: BuildBasketInput): BuiltBasket {
  const items: TokenxItem[] = [];
  const lines: { itemId: string; qty: number }[] = [];
  let amount = 0;
  for (const it of input.items) {
    if (it.voided || it.complimentary) continue;
    const unpaid = it.qty - it.paidQty;
    const wanted = input.selection ? (input.selection.find((s) => s.itemId === it.id)?.qty ?? 0) : unpaid;
    const qty = Math.min(wanted, unpaid);
    if (qty <= 0) continue;
    const net = input.totals.lineNet[it.id] ?? 0;
    if (net <= 0) continue;
    // Kalemin net payını adetlere böl; daha önce ödenen adetler baştaki payları tüketmiş sayılır
    const perUnit = allocate(net, Array.from({ length: it.qty }, () => 1));
    let partNet = 0;
    for (let i = it.paidQty; i < it.paidQty + qty; i++) partNet += perUnit[i] ?? 0;
    const gross = it.unitPrice * qty;
    const section = input.sectionMap[String(it.kdvRate)];
    if (section == null) throw new Error(`Cihazda %${it.kdvRate} KDV kısmı eşlenmemiş (Yönetim › Yazarkasa POS)`);
    const label = it.size === 'TEK' ? it.name : `${it.name} ${input.sizeLabels[it.size]}`;
    const item: TokenxItem = {
      name: label.slice(0, MAX_NAME),
      price: it.unitPrice,
      sectionNo: section,
      taxPercent: it.kdvRate * 100,
      quantity: qty * 1000,
      unit: 'Adet',
    };
    const discount = gross - partNet;
    if (discount > 0) item.adjust = { description: 'İndirim', discountOrSurcharge: 0, type: 0, totalValue: discount };
    items.push(item);
    lines.push({ itemId: it.id, qty });
    amount += partNet;
  }
  if (!items.length) throw new Error('Cihaza gönderilecek ücretli kalem yok');
  const basket: TokenxBasket = {
    basketID: input.basketId,
    checkNumber: input.orderNo,
    title: input.title.slice(0, 40),
    ...(input.filter ? { filter: input.filter.slice(0, 40) } : {}),
    ...(input.note ? { note: input.note.slice(0, 100) } : {}),
    documentType: 0,
    createInvoice: false,
    isVoid: false,
    items,
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
  };
  return { basket, amount, lines };
}

export type MethodKind = 'nakit' | 'kart' | 'yemek' | 'havale' | 'cari' | 'online' | 'diger';

/** Cihazdaki ödeme tipini LafPOS ödeme türüne çevirir */
export function methodKindFor(type: number): MethodKind {
  switch (type) {
    case TOKENX_PAYMENT.NAKIT:
      return 'nakit';
    case TOKENX_PAYMENT.KREDI_KARTI:
    case TOKENX_PAYMENT.EPOS:
    case TOKENX_PAYMENT.MOBIL:
    case TOKENX_PAYMENT.E_PARA:
      return 'kart';
    case TOKENX_PAYMENT.YEMEK_KARTI:
      return 'yemek';
    case TOKENX_PAYMENT.ACIK_HESAP:
      return 'cari';
    case TOKENX_PAYMENT.PARA_TRANSFERI:
      return 'havale';
    default:
      return 'diger';
  }
}

export interface SalePayment {
  kind: MethodKind;
  type: number;
  amount: number;
  operatorId: number | null;
  description: string | null;
}

/**
 * Cihaz sonucundaki ödeme kalemlerini LafPOS ödemelerine çevirir. Toplam sepet tutarını aşan kısım (ör.
 * yuvarlama) kırpılır; eksik kalan kısım için kalem üretilmez (adisyon açık kalır, kalan LafPOS'ta alınır).
 */
export function salePayments(sale: TokenxSale, basketAmount: number): SalePayment[] {
  const out: SalePayment[] = [];
  let left = basketAmount;
  for (const p of sale.paymentItems ?? []) {
    if (left <= 0) break;
    if (p.type === TOKENX_PAYMENT.IKRAM || p.type === TOKENX_PAYMENT.ODEMESIZ) continue;
    const amount = Math.min(Math.round(p.amount), left);
    if (amount <= 0) continue;
    out.push({ kind: methodKindFor(p.type), type: p.type, amount, operatorId: p.operatorId ?? null, description: p.description ?? null });
    left -= amount;
  }
  return out;
}

/** KDV oranı → kısım no eşlemesi: cihazdaki kısımlardan, oranı tutan ilk etkin kısım */
export function autoSectionMap(sections: { sectionNo: number; taxPercent: number; status?: number }[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of sections) {
    if (s.status === 0) continue;
    const rate = String(Math.round(s.taxPercent / 100));
    if (!(rate in map)) map[rate] = s.sectionNo;
  }
  return map;
}
