/**
 * lafmaliyet'e giden POS adı (satış satırı, ikram, CSV). lafmaliyet adı `trim` + boşluk sadeleştirmesiyle okur ve
 * bir günde bir ada bir satır ister (`src/lib/lafpos/day.ts`); eşleştirme büyük / küçük harf ve I / İ farkını yok
 * sayar (`posMatchKey`). Kural burada tek yerde: sunucunun adisyon kalemi, oda satırı, gün paketi ve yönetimin çakışma
 * denetimi aynı işlevleri kullanır. docs/03-ENTEGRASYON.md §3.1
 */

export type PosSize = 'M' | 'L' | 'TEK';
export type PosSizeSuffix = Record<PosSize, string>;

const upperTR = (s: string) => s.toLocaleUpperCase('tr-TR');

/** Boşlukları sadeleştirir; boşsa (ya da yalnız boşluksa) yedek adı büyük harfle, o da boşsa "ADSIZ ÜRÜN" */
export function normalizePosName(name: string | null | undefined, fallback?: string | null): string {
  const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
  const own = clean(name);
  if (own) return own;
  const alt = clean(fallback);
  return alt ? upperTR(alt) : 'ADSIZ ÜRÜN';
}

/** Çakışma anahtarı: lafmaliyet'in posMatchKey'iyle aynı sadeleştirme (harf, I / İ, kesme işareti) */
export function posNameKey(name: string): string {
  return upperTR(
    name
      .normalize('NFC')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[’‘`´]/g, "'"),
  )
    .replace(/İ/g, 'I')
    .replace(/̇/g, '');
}

/** Sonundaki boy ekini atar ("LATTE MEDIUM" → "LATTE"): iki boylu üründe override taban addır, ek ikinci kez eklenmez */
function stripSizeSuffix(name: string, suffix: PosSizeSuffix): string {
  const words = name.split(' ');
  for (const s of [suffix.M, suffix.L]) {
    const tail = s.trim() ? s.trim().split(/\s+/) : [];
    if (!tail.length || words.length <= tail.length) continue;
    if (posNameKey(words.slice(-tail.length).join(' ')) === posNameKey(tail.join(' '))) return words.slice(0, -tail.length).join(' ');
  }
  return name;
}

/**
 * Ürünün bir boydaki POS adı. Override (`posName`) varsa: tek boylu üründe olduğu gibi, iki boylu üründe taban ad
 * ve boy eki (`LATTE` → `LATTE MEDIUM` / `LATTE LARGE`). Override yoksa `BÜYÜK HARF ad + boy eki`. Boş ya da yalnız
 * boşluk override yok sayılır.
 */
export function posNameOf(product: { name: string; posName: string | null; priceL: number | null }, size: PosSize, suffix: PosSizeSuffix): string {
  const override = (product.posName ?? '').trim().replace(/\s+/g, ' ');
  const twoSizes = product.priceL != null;
  const base = override ? (twoSizes ? stripSizeSuffix(override, suffix) : override) : upperTR(normalizePosName(product.name));
  if (override && !twoSizes) return override;
  return [base, (suffix[size] ?? '').trim()].filter(Boolean).join(' ');
}

/**
 * Satılmış kalemin lafmaliyet adı: satışta dondurulan ad aynen gider (boy eki ayarı sonradan değişse de). Tek istisna
 * boy eki olmadan saklanmış eski iki boylu kalem ("LATTE"): bilinen hiçbir boy ekiyle (bugünkü ayar ya da varsayılan
 * MEDIUM / LARGE) bitmiyorsa satılan boyun eki eklenir, M ve L tek satırda birleşmez.
 */
export function soldPosName(posName: string | null | undefined, name: string, size: PosSize, suffix: PosSizeSuffix): string {
  const frozen = normalizePosName(posName, name);
  if (size === 'TEK') return frozen;
  const known = { M: suffix.M, L: suffix.L, TEK: '' };
  const sized = [known, { M: 'MEDIUM', L: 'LARGE', TEK: '' }].some((sx) => stripSizeSuffix(frozen, sx) !== frozen);
  if (sized) return frozen;
  return [frozen, (suffix[size] ?? '').trim()].filter(Boolean).join(' ');
}

/** Ürünün satılabildiği boyların POS adları (yönetimin çakışma denetimi) */
export function posNamesOf(product: { name: string; posName: string | null; priceL: number | null }, suffix: PosSizeSuffix): { size: PosSize; name: string }[] {
  const sizes: PosSize[] = product.priceL != null ? ['M', 'L'] : ['TEK'];
  return sizes.map((size) => ({ size, name: posNameOf(product, size, suffix) }));
}

/** lafmaliyet'in satır anahtarı: siteye bağlı üründe kalem + boy; yerel üründe ikisi de null */
export function posSlotOf(extProductId: string | null, size: PosSize): 'M' | 'L' | null {
  return extProductId ? (size === 'L' ? 'L' : 'M') : null;
}
