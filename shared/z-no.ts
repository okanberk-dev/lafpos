/**
 * Z numarası zinciri: her iş günü açılırken bir Z alır, kayıtlı en büyük Z'nin bir fazlasını. Geçişte zincir
 * ModPOS'un son Z'sinden devam etsin diye Yönetim › Ayarlar'da ilk Z numarası (`zNoStart`) girilir; yalnız yukarı
 * doğru etkiler, kayıtlı günlerin numarası değişmez (docs/03-ENTEGRASYON.md §8).
 */

/** İlk Z numarasının üst sınırı (8 hane) */
export const Z_NO_MAX = 99_999_999;

/** Açılacak günün Z'si: kayıtlı en büyük Z'den (gün yoksa 0) bir fazlası; ilk Z numarası daha büyükse o */
export function nextZNo(lastZ: number, zNoStart: number | null | undefined): number {
  return Math.max(lastZ, (zNoStart ?? 1) - 1) + 1;
}
