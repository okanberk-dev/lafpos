/**
 * Türkçe duyarsız arama anahtarı: küçük harf, ı→i, aksanlar atılır ("cay" "Çay"ı, "sut" "Süt"ü bulur). Sunucunun
 * geçmiş aramaları (bar geçmişi, kapanan adisyonlar) bununla süzer: SQLite'ın LIKE'ı Türkçe harfte büyük-küçük eşlemez.
 */
export function foldTr(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Aramanın sözcükleri (katlanmış); boş arama boş liste */
export function searchTerms(q: string | null | undefined): string[] {
  return foldTr(q ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/^#/, ''))
    .filter(Boolean);
}

/** Metin aramanın bütün sözcüklerini içeriyor mu ("12 latte": 12 numaralı, latte'li). Sözcük yoksa her şey eşleşir */
export function matchesTerms(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = foldTr(text);
  return terms.every((w) => hay.includes(w));
}
