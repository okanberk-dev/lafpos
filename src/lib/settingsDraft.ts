/**
 * Ayarlar formunun taslak kuralları (yönetim › Ayarlar). DOM'a dokunmaz; testler doğrudan çağırır.
 */

/** Satır satır liste (neden, hızlı nakit): boşluklar kırpılır, boş satır düşer. Yalnız kaydedilecek değer içindir:
 * alanın metni ayrı taslakta durur, yazarken satır sonu boşluk ve yeni satır silinmez */
export const fromLines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Sunucudan yeni ayar gelince (odak dönüşü, canlı akış, başka cihaz) kaydedilmemiş alanlar korunur: kullanıcının
 * değiştirmediği alan (taslakta önceki sunucu değeriyle aynı) yeni sunucu değerini alır, değiştirdiği kalır.
 */
export function rebaseDraft<T extends Record<string, unknown>>(prevServer: T, draft: T, nextServer: T): T {
  const out: Record<string, unknown> = { ...nextServer };
  for (const k of Object.keys(draft)) {
    if (!same(draft[k], prevServer[k])) out[k] = draft[k];
  }
  return out as T;
}
