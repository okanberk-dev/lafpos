/**
 * Kayan rakamlı sayacın (AnimatedCounter.tsx) saf hesabı: ekranın biçimleyicisinin yazdığı metni (tl, tlShort, sayı)
 * hücrelere böler ve her hücreye değer değişince yerinde kalan bir anahtar verir. React ve tarayıcı içermez; testler
 * (tests/kayan-sayac.test.ts) doğrudan bunu okur.
 *
 * Biçim yazılmaz, metin olduğu gibi kullanılır: sayaç `tl()` ne yazıyorsa onu yazar (kuruş, binlik nokta, ₺, eksi).
 * Lira basamağı basamak değeriyle (birler `i1`, onlar `i2`…), kuruş basamağı virgülden sonraki sırasıyla (`f0`, `f1`)
 * anahtarlanır: ₺999 → ₺1.000'de eski sütunlar yerinde döner, ₺85 → ₺85,50'de liranın basamakları kaymaz.
 */

export type Cell =
  | { kind: 'digit'; key: string; digit: number; frac: boolean }
  | { kind: 'mark'; key: string; char: string; frac: boolean };

const isDigit = (c: string) => c >= '0' && c <= '9';

/** Metni hücrelere böler; `decimal` ondalık ayırıcı (Türkçe virgül). Virgülden sonrası `frac` (ekranda soluk kuruş) */
export function toCells(text: string, decimal = ','): Cell[] {
  const chars = [...text];
  const cut = chars.lastIndexOf(decimal);
  const intEnd = cut >= 0 ? cut : chars.length;
  let intDigits = 0;
  for (let i = 0; i < intEnd; i++) if (isDigit(chars[i]!)) intDigits++;

  const cells: Cell[] = [];
  const seenMark = new Map<string, number>();
  // Aynı bölgede aynı işaret ikinci kez gelirse (ör. "--") anahtar yine tekil olsun
  const markKey = (base: string) => {
    const n = seenMark.get(base) ?? 0;
    seenMark.set(base, n + 1);
    return `${base}-${n}`;
  };
  let intSeen = 0;
  let fracSeen = 0;
  chars.forEach((ch, i) => {
    const frac = cut >= 0 && i >= cut;
    if (isDigit(ch)) {
      cells.push(i < intEnd ? { kind: 'digit', key: `i${intDigits - intSeen++}`, digit: Number(ch), frac } : { kind: 'digit', key: `f${fracSeen++}`, digit: Number(ch), frac });
      return;
    }
    let base: string;
    if (i === cut) base = 'dec';
    // Rakamdan önceki işaret (₺, eksi) kendi karakteriyle: eksi gelip gidince ₺ aynı hücre kalır
    else if (i < intEnd && intSeen === 0) base = `lead-${ch}`;
    // Binlik nokta ardından gelen basamağın yerine bağlı (binler, milyonlar)
    else if (i < intEnd && intSeen < intDigits) base = `sep${intDigits - intSeen}-${ch}`;
    else base = `tail-${ch}`;
    cells.push({ kind: 'mark', key: markKey(base), char: ch, frac });
  });
  return cells;
}

/** Hücrelerin ekrandaki yazısı (testler: biçimleyicinin metniyle aynı olmalı) */
export const cellsText = (cells: Cell[]) => cells.map((c) => (c.kind === 'digit' ? String(c.digit) : c.char)).join('');

export const mod = (n: number, m: number) => ((n % m) + m) % m;
