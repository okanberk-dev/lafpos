# Hesap sözleşmesi: LafPOS ve ladmin

Bu belge iki depoda bayt bayt aynıdır: LafPOS `docs/hesap-sozlesmesi.md` ile lafmaliyet `docs/hesap-sozlesmesi.md`.
Her depodaki bir test belgenin SHA-256 özetini sabitler (LafPOS `tests/hesap-sozlesmesi.test.ts`, lafmaliyet
`tests/hesap-sozlesmesi.test.ts`); belge değişince iki kopya ve iki test aynı PR serisinde güncellenir.

Belge yalnız formülleri, yuvarlamayı ve formüllerin hangi gövde alanına bağlandığını tanımlar. Gün sonu gövdesinin
(`POST /api/pos/gun`, sürüm 1) alan tanımı burada değil, LafPOS `docs/03-ENTEGRASYON.md` §4 ve lafmaliyet
`docs/LAFPOS.md`'dedir.

## 1. Birimler

- Para LafPOS'ta tam sayı kuruştur; hesap yalnız `shared/order-calc.ts` ve `shared/money.ts` ile yapılır.
- Gün sonu gövdesinde tutarlar TL'dir, iki ondalık (`toTL`). lafmaliyet TL saklar ve iki ondalığa yuvarlar
  (`round2`). Ekranda iki ondalık gösterilir.
- Saat dilimi Europe/Istanbul.
- Fiyatlar KDV dahildir. KDV oranı satış anında kaleme dondurulur; ürünün oranı sonradan değişse de eski kalem
  değişmez.
- Liste fiyatı, kaleme dondurulan birim fiyattır: mutlu saat indirimi bu fiyata işlenmiştir ve indirim sayılmaz.

## 2. İş günü

- İş günü gün açılışından Z'ye kadar sürer. Adisyon açıldığı iş gününe aittir.
- Gövdenin anahtarı (`sube`, `date`). Aynı tarihe tek Z gider (`z.zNo`); başka Z no ile gelen gövde `z_conflict`
  olur.
- Kurulum (eğitim) modunda kapanan gün hiç gönderilmez.
- Kapanan gün yalnız gerekçeyle yeniden açılır; aynı tarih ve Z no ile, artan `revision` ve `correction.reason`
  ile yeniden gönderilir.

## 3. Satır durumları

| Durum | Ciroya girer | Liste değerine girer | Tüketim (malzeme) |
| --- | --- | --- | --- |
| Satıldı | evet, `net` ile | evet | evet |
| İkram | hayır | evet | evet |
| Ödenmez | hayır | evet | evet |
| Zayi | hayır | hayır | evet |
| Hazırlanmadan iptal | hayır | hayır | hayır |
| Hazırlandıktan sonra iptal | hayır | hayır | evet (zayi sayılır) |

- Hazırlanmış sayılmak için kalemin bar ya da mutfak ekranında başlamış (`startedAt`) ya da hazır (`readyAt`)
  olması gerekir. "Bara gönderildi" (`voidAfterSend`) hazırlandı demek değildir.
- Ödenmezin kişisi gövdeye girmez; yalnız türü gider (`personKind`: personel, musteri, patron).

## 4. İndirim ve net

- Satır indirimi önce satıra uygulanır, satırın tutarını aşamaz.
- Adisyon indirimi satılan satırlara, satır indiriminden sonraki tutarları oranında dağıtılır. Kuruş artığı en
  büyük kalana gider (`money.ts` `allocate`); lafmaliyet de aynı kuralı kullanır.
- Satırın `net`'i = liste − indirim payı. Yalnız satılan satırda vardır; öteki durumlarda 0'dır.
- Gövdede `lines[].gross` satırın liste değeri (indirim öncesi), `lines[].revenue` net'idir.

## 5. Gün toplamları

| Toplam | Formül | Gövde alanı |
| --- | --- | --- |
| Liste değeri | Σ liste (satılan + ikram + ödenmez; servis ücreti dahil) | `z.listValue` |
| İndirim | Σ indirim payı | `z.discounts` |
| İkram | Σ liste (ikram) | `z.ikramTotal` |
| Ödenmez | Σ liste (ödenmez) | `z.odenmezTotal` |
| Zayi | Σ liste (zayi) | `z.zayiTotal` |
| Ciro dışı | ikram + ödenmez | `z.ikramTotal + z.odenmezTotal` |
| Ciro (KDV dahil) | liste değeri − indirim − ciro dışı | `z.zTotal` |

- Ciro = Σ `lines[].revenue` = Σ ödeme (bahşiş hariç).
- LafPOS'un `z.offRevenue`'su zayiyi de içerir: `offRevenue = ikramTotal + odenmezTotal + zayiTotal`.
- Ödeme kırılımı: `z.cash + z.card + z.mealCard + z.online + z.other = z.zTotal`.
- Online ödenmiş sipariş kasada tahsil edilmez ve satış listesine girmez.

## 6. KDV

- Oran başına: matrah = round(Σnet_oran × 100 / (100 + oran)), KDV = Σnet_oran − matrah.
- LafPOS KDV'yi adisyon başına yuvarlar (mali fişle aynı); gün toplamında oran başına kuruş farkı çıkabilir.
  **Günün KDV'si LafPOS'un dökümüdür** (`z.vat[]`: oran, matrah, KDV); lafmaliyet onu yeniden hesaplamaz.
- Ayın KDV'si ve KDV hariç cirosu günlerin toplamıdır. Ay düzeyinde yeniden yuvarlamak kuruş farkı verebilir:
  Marina Kasım 2026'da günlerin toplamı 30.576,15, ay cirosunun tek seferde yuvarlanması 30.576,14'tür. Esas olan
  günlerin toplamıdır.
- ModPOS günlerinde KDV dökümü yoksa ciro günün tek oranıyla (%10) bölünür, aynı formülle.

## 7. Fiş sayısı

- `z.receipts`: kapanmış ve tutarı 0'dan büyük adisyon. Tamamı iptal edilen ve 0 tutarla kapanan (tamamı ikram,
  ödenmez, zayi ya da %100 indirim) adisyon sayılmaz.
- Bu, adisyon sayısıdır; mali fiş sayısı değildir.

## 8. Z numaraları

- `z.zNo`: LafPOS'un Z serisi (ModPOS günlerinde ModPOS'un Z'si, ör. "Z-2026-010").
- `z.okcZNo`: yazarkasanın (Pavo) mali Z'si. İki alan ayrıdır; lafmaliyet'te `z_no` ve `okc_z_no`.

## 9. Kasa

- Beklenen = açılış + nakit satış + nakitle cari tahsilatı + giren − harcama − gün içi teslim.
- Fark = sayılan − beklenen.
- Devir = sayılan − gün sonu teslim. LafPOS'ta gün sonu teslim yoktur (teslim gün içinde yazılır), devir sayılandır.
- Ertesi günün beklenen açılışı önceki gerçek günün devridir. lafmaliyet devri düzelttiyse ertesi açılışta o
  kullanılır (`nextOpening`); ulaşılamazsa yerel zincir geçerlidir. Açılış beklenenden en az 1 TL farklıysa neden
  zorunludur (`z.openingDiff`, `z.openingReason`).

## 10. Banka POS komisyonu

- Tek fonksiyon, iki sayfa (Satışlar ve Gelir-gider): komisyon = Σ şube (kart tutarı × şubenin POS oranı).
- Kart tutarı yemek kartını içermez: LafPOS günlerinde `z.card`, ModPOS günlerinde kasa raporunun kartı.
- Satırlara ciro payıyla dağıtılır: satırın payı = komisyon × satır cirosu ÷ Σ satır cirosu.
- Süren ayda pencere farklıdır: Satışlar komisyonu satış listesinin günleri için sayar (o günlerin kasa kartı), Gelir-gider ayın bugüne kadarki bütün kasa raporlarıyla; liste kasa raporlarına yetişince iki tutar aynı olur.
- Marina Kasım 2026: 24.774,25 × %2 = 495,49.

## 11. Tutarlılık

- LafPOS günü: Σ `lines[].revenue` = `z.zTotal`. İndirim satırlardan bir daha düşülmez.
- ModPOS günü: ModPOS ürün listesi indirimden öncedir; Σ liste − indirim = Z.
- Hiçbir kalem iki kez sayılmaz: "Tümü" şubelerin toplamı ve işletme geneli kalemlerin bir kez toplamıdır.
