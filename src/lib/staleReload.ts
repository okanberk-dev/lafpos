/**
 * Müşteri ekranının kendini yenilemesi (CustomerDisplayPage): kasadan uzun süre yanıt alamayan ekran ancak sağlık
 * sorusu (`probe`, /api/health) yanıt verince yenilenir; yanıt yoksa sayfa yerinde kalır, son durumu ya da karşılamayı
 * göstermeye devam eder (inceleme, 23 Kas 2026: kasa yeniden başlarken, uzun güncellemede ya da tablet Wi-Fi'den
 * düşünce yenilemek çalışan sayfayı tarayıcının hata sayfasıyla değiştiriyordu; müşteriye dönük tabletin tarayıcısı o
 * sayfayı kendiliğinden yeniden denemez). Soru en sık `gapMs`'de bir sorulur, aynı anda biri. Tarayıcıya dokunmaz
 * (yenilemeyi sayfa verir): testler de çalıştırır
 */
export function staleReload(probe: () => Promise<boolean>, reload: () => void, gapMs = 30_000): (now: number) => Promise<void> {
  let busy = false;
  let last = Number.NEGATIVE_INFINITY;
  return async (now) => {
    if (busy || now - last < gapMs) return;
    busy = true;
    last = now;
    try {
      if (await probe()) reload();
    } catch {
      /* yanıt yok: sayfa yerinde kalır */
    } finally {
      busy = false;
    }
  };
}
