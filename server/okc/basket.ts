import { allocate } from '@shared/money';
import { type OrderTotals, SERVICE_KDV_RATE } from '@shared/order-calc';
import { TOKENX_PAYMENT, type TokenxBasket, type TokenxItem, type TokenxSale } from './tokenx';

/**
 * Adisyondan cihaz sepeti üretir (saf fonksiyon). Kurallar:
 * - İptal ve ikram kalemleri sepete girmez (ücretsiz).
 * - Her kalem liste fiyatıyla gider; indirim payı kaleme `adjust.totalValue` olarak eklenir, böylece fişin
 *   toplamı LafPOS'un hesabıyla kuruşu kuruşuna aynıdır.
 * - Kalem bazlı seçimde yalnız seçilen adetler gider (indirim payı adetle orantılı, en büyük kalan yöntemi).
 * - KDV oranı cihazdaki kısım (sectionNo) ile eşlenir; eşleşmeyen oran hata verir.
 * - Bütün adisyon gönderiminde cihaz fişlerinin toplamı her KDV oranında LafPOS'un dökümüne tamamlanır (`prior`).
 */

/** Servis ücreti satırının adı (önceki fişlerde cihaza giden servis bununla bulunur) */
export const SERVICE_LINE = 'Servis ücreti';
/** Oranın kalan kalemlerine yazılamayan fark için satır (ör. ödenmiş kaleme düşen indirim payı küçüldü) */
export const ADJUST_LINE = 'İndirim farkı';

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
  totals: Pick<OrderTotals, 'lineNet'> & Partial<Pick<OrderTotals, 'service' | 'kdv'>>;
  /** Seçilmezse ödenmemiş bütün adetler */
  selection?: { itemId: string; qty: number }[] | null;
  sectionMap: Record<string, number>;
  sizeLabels: { M: string; L: string };
  callbackUrl?: string;
  /**
   * Seçimsiz (bütün adisyon) gönderimde adisyonun kalan tutarı; sepet toplamı buna eşitlenir, cihaz adisyonu kapatır.
   * Servis ücreti (`totals.service`, kalemlerin net payında yok) ayrı satır olarak gider; daha önce cihaza giden
   * servis düşülür. Kalem bazlı ödemeden sonra kalem eklenince adisyon indirimi kalemlere yeniden dağılır; bu kayma
   * aynı KDV oranının kalemlerine işlenir, "Servis ücreti" diye gitmez (inceleme, 26 ve 27 Eki 2026).
   */
  remainingDue?: number;
  /**
   * Bütün adisyon gönderiminde adisyonun daha önce ödenmiş kısmının KDV oranına göre brütü (cihaz fişleri ve
   * LafPOS'ta kalem seçerek alınan ödemeler) ve cihaza giden servis ücreti. Verilirse sepet her oranda
   * `totals.kdv - prior.byRate` olur: cihaz fişlerinin KDV dökümü LafPOS'unkiyle aynı kalır.
   */
  prior?: { byRate: Record<string, number>; service: number };
  /** Servis ücretinin KDV oranı (shared/order-calc.ts ile aynı) */
  serviceKdvRate?: number;
}

export interface BuiltBasket {
  basket: TokenxBasket;
  amount: number;
  lines: { itemId: string; qty: number }[];
}

const MAX_NAME = 32;

export function buildBasket(input: BuildBasketInput): BuiltBasket {
  const sectionOf = (rate: number) => {
    const section = input.sectionMap[String(rate)];
    if (section == null) throw new Error(`Cihazda %${rate} KDV kısmı eşlenmemiş (Yönetim › Yazarkasa POS)`);
    return section;
  };
  /** Sepet satırları; `cap` satırın çıkabileceği en yüksek tutar (liste fiyatı; servis ve fark satırı artmaz) */
  const slots: { item: TokenxItem; rate: number; gross: number; net: number; cap: number; kind: 'kalem' | 'servis' | 'fark' }[] = [];
  const lines: { itemId: string; qty: number }[] = [];
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
    const label = it.size === 'TEK' ? it.name : `${it.name} ${input.sizeLabels[it.size]}`;
    const item: TokenxItem = {
      name: label.slice(0, MAX_NAME),
      price: it.unitPrice,
      sectionNo: sectionOf(it.kdvRate),
      taxPercent: it.kdvRate * 100,
      quantity: qty * 1000,
      unit: 'Adet',
    };
    slots.push({ item, rate: it.kdvRate, gross, net: partNet, cap: gross, kind: 'kalem' });
    lines.push({ itemId: it.id, qty });
  }
  const sum = () => slots.reduce((a, p) => a + p.net, 0);
  /** Farkı verilen satırlara işler (en büyükten başlayarak; satır tavanını aşmaz, sıfırın altına inmez); kalanı döner */
  const absorb = (list: typeof slots, drift: number) => {
    for (const p of [...list].sort((a, b) => b.net - a.net)) {
      if (drift === 0) break;
      const d = drift > 0 ? Math.min(drift, p.cap - p.net) : Math.max(drift, -p.net);
      p.net += d;
      drift -= d;
    }
    return drift;
  };
  const flat = (rate: number, name: string, price: number, kind: 'servis' | 'fark') => {
    const item: TokenxItem = { name, price, sectionNo: sectionOf(rate), taxPercent: rate * 100, quantity: 1000, unit: 'Adet' };
    slots.push({ item, rate, gross: price, net: price, cap: price, kind });
  };

  if (!input.selection && input.remainingDue != null) {
    // Servis ücretinin cihaza gitmemiş kısmı (önceki bütün adisyon fişleri servisin o anki tutarını taşıdı)
    const serviceRate = input.serviceKdvRate ?? SERVICE_KDV_RATE;
    const service = Math.max(0, input.totals.service ?? 0) - (input.prior?.service ?? 0);
    if (service > 0) flat(serviceRate, SERVICE_LINE, service, 'servis');

    // Oran oran: sepet LafPOS'un KDV dökümünden önceki fişleri düşünce kalan brüte eşitlenir. Fark önce aynı oranın
    // satırlarına işlenir; yazılamayan artı fark yuvarlamadan büyükse o oranda "İndirim farkı" satırı olur
    if (input.prior && input.totals.kdv) {
      const target = new Map<number, number>();
      for (const k of input.totals.kdv) target.set(k.rate, k.gross);
      for (const [rate, gross] of Object.entries(input.prior.byRate)) target.set(Number(rate), (target.get(Number(rate)) ?? 0) - gross);
      for (const p of slots) if (!target.has(p.rate)) target.set(p.rate, 0);
      for (const [rate, want] of target) {
        const own = slots.filter((p) => p.rate === rate);
        const left = absorb(own, want - own.reduce((a, p) => a + p.net, 0));
        // Kalem başına en çok 2 kuruşluk kayma indirim yuvarlamasıdır; oranlar arasında dengelenir
        const rounding = 2 * input.items.filter((i) => i.kdvRate === rate && !i.voided && !i.complimentary).length;
        if (left > rounding) flat(rate, ADJUST_LINE, left, 'fark');
      }
    }

    // Kalan kayma (yuvarlama, eksi fark): en büyük satırdan başlayarak indirim payına
    if (absorb(slots.filter((p) => p.kind !== 'fark'), input.remainingDue - sum()) !== 0) {
      throw new Error("Cihaz sepeti adisyonun kalanını tutmuyor; kalanı kalem seçerek ya da LafPOS'ta alın");
    }
  }
  const items: TokenxItem[] = slots.map(({ item, gross, net, kind }) =>
    kind === 'kalem' ? (gross - net > 0 ? { ...item, adjust: { description: 'İndirim', discountOrSurcharge: 0, type: 0, totalValue: gross - net } } : item) : { ...item, price: net },
  );
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
  return { basket, amount: sum(), lines };
}

/** Gönderilmiş sepetin KDV oranına göre brütü ve içindeki servis ücreti (önceki fişler için) */
export function basketByRate(basket: Pick<TokenxBasket, 'items'>): { byRate: Record<string, number>; service: number } {
  const byRate: Record<string, number> = {};
  let service = 0;
  for (const it of basket.items ?? []) {
    const gross = Math.round((it.price * it.quantity) / 1000) - (it.adjust?.totalValue ?? 0);
    const rate = String(Math.round(it.taxPercent / 100));
    byRate[rate] = (byRate[rate] ?? 0) + gross;
    if (it.name === SERVICE_LINE) service += gross;
  }
  return { byRate, service };
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
  const raw = (sale.paymentItems ?? [])
    .filter((p) => p.type !== TOKENX_PAYMENT.IKRAM && p.type !== TOKENX_PAYMENT.ODEMESIZ)
    .map((p) => ({ kind: methodKindFor(p.type), type: p.type, amount: Math.round(p.amount), operatorId: p.operatorId ?? null, description: p.description ?? null }));
  return clampPayments(raw, basketAmount);
}

/** Ödemeleri sepet tutarına kırpar: toplamı aşan kısım atılır, sıfır ve eksi kalemler düşer (her sağlayıcı için) */
export function clampPayments<T extends { amount: number }>(payments: T[], basketAmount: number): T[] {
  const out: T[] = [];
  let left = basketAmount;
  for (const p of payments) {
    if (left <= 0) break;
    const amount = Math.min(Math.round(p.amount), left);
    if (amount <= 0) continue;
    out.push({ ...p, amount });
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
