/**
 * Kabul ya da ret kararı o an verilen platform siparişleri (platform çağrısı sürüyor). Karar uçları kilitler; süre
 * dolumu ve platform iptali bu kayıtlara dokunmaz, sonraki turu bekler. Tek süreç, bellekte.
 */
export const deciding = new Set<string>();

/**
 * Kasada bir kişinin karar denediği kayıtlar (kabul, ret, platform iptali, iptalin elle kapatılması; başarılı ya da
 * başarısız): otomatik kabul bunları hiçbir zaman kabul etmez. Ret platforma gidemeyince kayıt onay bekler görünür;
 * otomatik kabul onu kabul ederse kişinin reddettiği sipariş hazırlanır (gözden geçirme, 28 Eki 2026). Kaydın
 * `lastError`'u da aynı şeyi söyler (`autoAcceptBlocker`); bu küme hata yazılmayan başarısızlık yolları için
 * emniyettir. Tek süreç, bellekte; yeniden başlayınca boşalır.
 */
export const manualDecision = new Set<string>();
