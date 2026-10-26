/**
 * Para her yerde kuruş cinsinden tam sayıdır (1 ₺ = 100 kuruş). Kayan nokta yalnız gösterimde ve
 * oran hesabının ara adımında kullanılır; sonuç her zaman yarım-yukarı yuvarlanmış tam kuruştur.
 */
export type Kurus = number;

const currency = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'TRY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plain = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** 123450 -> "₺1.234,50" */
export function tl(k: Kurus): string {
  return currency.format(k / 100);
}

/** 123450 -> "1.234,50" (para birimi simgesi olmadan, fiş ve tablolar için) */
export function tlPlain(k: Kurus): string {
  return plain.format(k / 100);
}

/** 8500 -> "85", 8550 -> "85,5" (ürün düğmeleri gibi dar yerler için) */
export function tlCompact(k: Kurus): string {
  return compact.format(k / 100);
}

/** 8500 -> "₺85", 8550 -> "₺85,50": dar yerler (masa, ürün kartı) için kısa tutar; simge tl() ile aynı yerde */
export function tlShort(k: Kurus): string {
  return k % 100 === 0 ? `₺${compact.format(k / 100)}` : tl(k);
}

/**
 * Kullanıcının yazdığı tutarı kuruşa çevirir. "12", "12,5", "12.50", "1.234,56", "₺ 1 234,56" kabul edilir.
 * Tanınmayan girdi için null döner.
 */
export function parseTL(input: string): Kurus | null {
  let s = input.replace(/[₺\s]|TL/gi, '').trim();
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Hangisi sondaysa ondalık ayracıdır, diğeri binlik.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  } else if (lastDot > -1) {
    // "1.234" binlik mi ondalık mı? Noktadan sonra tam 3 hane ve birden çok nokta/uzun sayı varsa binlik say.
    const parts = s.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1 && !/^0$/.test(parts[0]))) {
      s = parts.join('');
    }
  }
  if (!/^\d+(\.\d*)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  // İki haneden uzun kesir kuruşa yuvarlanır ("0.255" -> 26 kuruş).
  const value = Number(whole) * 100 + roundHalfUp(Number(`0.${frac || '0'}`) * 100);
  return neg ? -value : value;
}

/** Yarım-yukarı (sıfırdan uzağa) yuvarlama: 0,5 -> 1, -0,5 -> -1. */
export function roundHalfUp(x: number): number {
  // Kayan nokta artığını (ör. 2.675 * 100 = 267.49999) temizlemek için önce 1e-9 hassasiyetle düzelt.
  const fixed = Math.round(x * 1e6) / 1e6;
  return fixed >= 0 ? Math.floor(fixed + 0.5) : -Math.floor(-fixed + 0.5);
}

/** Tutarın yüzdesi, kuruşa yuvarlanmış: percentOf(12345, 10) = 1235 */
export function percentOf(amount: Kurus, ratePct: number): Kurus {
  return roundHalfUp((amount * ratePct) / 100);
}

/** KDV dahil tutarı matrah ve KDV'ye ayırır. splitKdv(11000, 10) = { net: 10000, kdv: 1000 } */
export function splitKdv(gross: Kurus, ratePct: number): { net: Kurus; kdv: Kurus } {
  if (ratePct <= 0) return { net: gross, kdv: 0 };
  const net = roundHalfUp((gross * 100) / (100 + ratePct));
  return { net, kdv: gross - net };
}

/**
 * Toplamı ağırlıklara göre kuruşu kuruşuna dağıtır (en büyük kalan yöntemi). Dağıtılan parçaların toplamı
 * her zaman `total`a eşittir. Ağırlıkların hepsi sıfırsa eşit dağıtır.
 */
export function allocate(total: Kurus, weights: number[]): Kurus[] {
  const n = weights.length;
  if (n === 0) return [];
  const sumW = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const w = sumW > 0 ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const sum = sumW > 0 ? sumW : n;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = w.map((x) => (abs * x) / sum);
  const base = raw.map((x) => Math.floor(x + 1e-9));
  let rest = abs - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % n, rest--) base[order[k].i] += 1;
  return base.map((x) => x * sign);
}

/** Toplamı n eşit parçaya böler; artan kuruşlar ilk parçalara gider. splitEven(1000, 3) = [334, 333, 333] */
export function splitEven(total: Kurus, parts: number): Kurus[] {
  if (parts < 1) return [];
  return allocate(total, Array.from({ length: parts }, () => 1));
}

/** Nakit ödemede para üstü: verilen tutar ödenecekten azsa 0. */
export function changeDue(due: Kurus, given: Kurus): Kurus {
  return Math.max(0, given - due);
}
