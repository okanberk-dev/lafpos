# Yazarkasa POS (ÖKC) bağlantısı

Mali fiş ÖKC'den (yazarkasa POS) kesilir. LafPOS adisyonu cihaza **sepet** olarak gönderir; ödeme ve mali fiş
cihazda alınır; sonuç (Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir.
Kod: `server/okc/` (markadan bağımsız akış `service.ts`, sepet hesabı `basket.ts`, sağlayıcılar `providers/`:
sözleşme `types.ts`, Token `tokenx.ts` + istemci `../tokenx.ts`, Pavo `pavo.ts` + istemci `../pavo.ts`, eğitim cihazı
`index.ts`), uçlar
`server/routes/okc.ts`, ekranlar adisyondaki **Yazarkasa** bölümü, `/cihaz` (eğitim cihazı) ve
Yönetim › Yazarkasa POS. Testler: `tests/okc-basket.test.ts`, `tests/tokenx-client.test.ts`,
`tests/api-flow.test.ts`, `tests/okc-providers.test.ts`, `tests/pavo.test.ts` (sahte Pavo cihazı `tests/fake-pavo.ts`),
`tests/audit-yazarkasa.test.ts` (27 Eki 2026 denetimi:
birleşen adisyonda fiş iptali, kapanmış güne ait iptal, yanıtı alınamayan gönderim, ödemesiz kapanan fiş, servis
ve KDV dökümü, açılışta sorgu, denetim kaydı).

## 1. Sağlayıcılar

| Ayar (`okcProvider`) | Ne olur |
|---|---|
| `kapali` | Yazarkasa düğmeleri görünmez; ödeme LafPOS'ta alınır, mali fiş ayrıca kesilir |
| `simulator` (eğitim cihazı) | Sepet `/cihaz` ekranına düşer; orada nakit/kart/yemek kartı seçilip "ödendi" denir. **Gerçek fiş kesilmez**; kurulum ve personel eğitimi içindir. İlk kurulum bununla gelir |
| `tokenx` | TokenX Connect (Cloud) üzerinden gerçek cihaz |
| `pavo` | Pavo (N86 ve diğer PavoPay cihazları) kafenin yerel ağında REST ile; yalnız kasada ödeme (§8) |

Gerçek cihazla deneme yapılmaz: önce eğitim cihazı, sonra Token'ın test ortamı, en son canlı cihaz.

### 1.1 Yeni marka eklemek

Her marka `providers/` altında bir `FiscalProvider`'dır: `send` (sepeti cihaza yolla; çekme kanalında sepet
LafPOS'ta bekler), `cancel` (cihazdan sil), `poll` (durum sorgula), `test` (bağlantıyı dene) ve yetenekler
(kasada/masada ödeme, bölünmüş ödeme, belge türleri). Cihazın cevabı markadan bağımsız `FiscalResult`'a
çevrilir: `paid` / `cancelled` / `voided`, belge türü (`okc_fis`, `bilgi_fisi`, `e_arsiv`, `e_fatura`), Z no,
fiş no, e-belge no ve ödemeler. Bekleyen sepet, kilit, zorla iptal, geç gelen sonuç ve ödemelerin sepet
tutarına kırpılması `service.ts`'te her marka için aynıdır; yeni marka bunlara dokunmaz.

### 1.2 Markalar (Ekim 2026)

| Marka | Kanal | Durum | Üreticiden istenecek |
|---|---|---|---|
| **Token · Beko** (300TR, X30TR; 400TR e-belge) | TokenX Connect Cloud | **Bağlı** | Canlı ve test client-id/secret; 300TR ve 400TR'nin Cloud desteği; Cloud'dan iade ve `documentType` değerleri; terminal başına TokenX Connect üyelik ücreti; webhook'ların geldiği IP listesi |
| **Hugin** (Tiger T300, S1...) | Cloud Link: Hugin TSM bizim HTTPS adresimizi çağırır (`GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/result`, `POST /sales`, `X-ApiKey`) | Belge eksik; para yolu tahminle kurulmaz | Postman koleksiyonu ya da OpenAPI; `/sales` gövdesinin tamamı (ödeme kalemleri ve türleri, Z no, fiş no, cihaz seri no, siparişle bağı); iptal/iade bildirimi; tekrar gönderim ve idempotency; satıştan sonra siparişin listeden düşme kuralı, iki cihaz aynı masayı açarsa kilit; `documentType` değerleri; ödeme kodlarının anlamı (`CHECK`); desteklenen modeller, lisans ve kayıt |
| **Pavo** (N86, N96, UN20, N6, CT20) | Yerel ağda REST (cihazda "Eşleştir"); Intent, Cloud, UniCloud da var | **Bağlı (yerel ağ, Kasım 2026)**; gerçek cihazda ilk satışla doğrulanacak (§8). VUK 507 cihazları e-Arşiv keser, kafenin e-Arşiv hesabı gerekir | §8.4'teki liste: PavoPay REST belgesi, ödeme tipi ve belge türü kodları, `GetSaleResult` yanıtı, iptal ve iade |
| **Ingenico** (Move5000F, iDE280, A910SF) | GMP-3, Windows DLL (USB/TCP) | Geliştirici ücreti ve her sürümün hash kaydı gerekir | Geliştirici programı, GMPSmartDLL ve belgesi, test cihazı, sürüm başına hash kaydı, bulut/TSM kanalı var mı |
| **Verifone, Inpos, Profilo, PayGo, Vera** | TSM ya da kablolu | Açık belge yok | TSM/bulut satış API'si var mı; belge, sözleşme, test cihazı |
| **Hepsi** | | | Güvenlik Taahhütnamesi (GMP-3 §5.3, §5.5: yazılım değişikliği üreticiye bildirilir); masada ödeme için GMP-3 §6.1'e uygunluğun yazılı teyidi |

Kablolu (DLL) markalar için ileride kafe bilgisayarında küçük bir yardımcı program (üreticinin kütüphanesini
yükler, LafPOS'la localhost üzerinden konuşur) gerekir; GMP-3 §3.3 tarayıcıdan çalışan satış yazılımı için bunu
ister. Eşleştirme ve hash o programa bağlı olduğundan ayrı sürümlenir.

### 1.3 Mevzuat notları

- **Masada ödeme (GMP-3 §6.1 madde 2-4):** hizmetten sonra ödenen masada ÖKC siparişin başında tekil bir kimlik
  verir ve mutfağa giden her satırı (iptaller dahil) kaydeder. LafPOS sepeti ödeme anında gönderir; madde 17'deki
  TSM yolu (Hesap Özeti Bilgi Fişi ve TSM'de saklama) bunu karşılar, bu yüzden üreticinin bulut kanalının bunu
  yaptığı yazılı teyit edilmeli. Önce ödenen tezgâh satışı bundan muaftır (madde 16).
- **Yemek kartı:** yemek kartı ödemesinde mali fiş değil bilgi fişi kesilir (§6.1 madde 9). LafPOS sonucu
  `bilgi_fisi` olarak kaydeder (Token'da yemek kartı ödeme kalemi gelince).
- **VUK 507 cihazları** (Pavo, Token 400TR) ÖKC fişi ve Z yerine e-Arşiv/e-Fatura keser; sonuçta e-belge no
  (`docId`) saklanır.
- VUK Tebliğ 483 m.8(3): adisyon sistemi kullanan işletmede ÖKC ile entegrasyon zorunlu. GİB yazılımı
  onaylamaz; her üretici kendi yetkili servisiyle eşleştirir.

## 2. Token'dan istenecekler ve `.env`

| Değişken | Ne |
|---|---|
| `TOKENX_AUTH_URL` | Kimlik doğrulama adresi (LafPOS `POST {auth}/v1/auth/token`, Basic kimlikle erişim jetonu alır, süresi dolmadan yeniler) |
| `TOKENX_BASKET_URL` | Sepet servisinin adresi (`/v1/basket/...`) |
| `TOKENX_SETTINGS_URL` | Ayar servisi (kısımlar, terminaller); boşsa sepet adresi kullanılır |
| `TOKENX_CLIENT_ID`, `TOKENX_CLIENT_SECRET` | Uygulama kimliği |
| `TOKENX_TERMINAL_ID` | **Anlık** sepette hedef cihaz |
| `TOKENX_BRANCH_ID` | **Liste** sepette şube |
| `TOKENX_APP_RESOURCE` | `x-application-resource` başlığı (Token isterse) |
| `LAFPOS_PUBLIC_URL` | Webhook için LafPOS'un internetten erişilen adresi (yoksa yoklama) |
| `TOKENX_WEBHOOK_SECRET` | Webhook'un `Authorization: Bearer` anahtarı, en az 16 karakter |

Değerler yalnız kasa bilgisayarındaki `.env` dosyasında durur; depoya girmez. Windows kurulum dosyasıyla
kurulan bilgisayarda bu dosya `C:\ProgramData\LafPOS\ayarlar.env` ve **Yönetim › Bağlantı bilgileri › Token
yazarkasa**'dan yazılır (patron; gizli değer ekrana geri gelmez); kaydedince sunucu birkaç saniyede yeniden başlar
(`docs/05-KASA-BILGISAYARI.md` §2 "Bağlantı bilgileri"). Başlat › LafPOS › LafPOS ayarları dosyayı Not Defteri'nde
de açar.

## 3. Kurulum adımları

1. Yönetim › Bağlantı bilgileri › Token yazarkasa'yı doldurun (LafPOS kendiliğinden yeniden başlar).
2. Yönetim › Yazarkasa POS: sağlayıcı **TokenX**, mod **Anlık** ya da **Liste**.
3. **Bağlantıyı dene**: jeton alınır, terminal ve kısımlar okunur; hata Türkçe gösterilir (`STATUS_TEXT`).
4. **KDV → kısım eşlemesi**: cihazdaki kısımlar okunup oranına göre otomatik eşlenir (`autoSectionMap`);
   varsayılan `%1 → 3`, `%10 → 1`, `%20 → 2`. Cihazınızın kısım numaraları farklıysa buradan düzeltin.
5. **Sonuç bildirimi**: `LAFPOS_PUBLIC_URL` ve `TOKENX_WEBHOOK_SECRET` varsa "Webhook'u kaydet"
   (`POST /api/okc/webhook/register`); adres `…/api/public/okc/tokenx/webhook`. Yoksa LafPOS sonucu
   kendisi sorar (anlık sepette 2,5 sn, listede 10 sn); sunucu yeniden başlarsa bekleyen sepetleri sormaya
   açılışta devam eder.
6. Eğitim cihazıyla bir tur: tezgâh satışı → Yazarkasa → `/cihaz`'da öde → adisyon kendiliğinden kapanır.

## 4. Anlık ve liste sepet

| | Anlık (`okcMode: anlik`) | Liste (`okcMode: liste`) |
|---|---|---|
| Hedef | Tek cihaz (`TOKENX_TERMINAL_ID`) | Şubedeki her cihaz (`TOKENX_BRANCH_ID`) |
| Cihazda | Sepet ekrana kendiliğinden düşer | Kasiyer listeden seçer |
| Ne zaman | Tek kasa | Birden çok POS cihazı, masaya giden el terminali |

### 4.1 Tek dokunuş: "Ödemeyi al" cihaza gönderir (Kasım 2026)

Yönetim › Yazarkasa POS › **Ödemeyi alınca cihaza gönder** (`okcAuto`; yalnız kasada ödemede görünür). Varsayılan
gerçek cihazda (Pavo, Token) açık, eğitim cihazında kapalı: deneme modunda nakit satış eğitim cihazını beklemez;
elle açılır ya da kapatılır, seçilen değer bağlantı değişse de kalır (`okcAutoOn`). Açıkken ödeme penceresinde ayrı "Yazarkasaya gönder" düğmesi yoktur: kasiyer türü seçip **Ödemeyi al**'a
basınca hesap (ya da seçilen kalemler) aynı uçla (`POST /api/okc/orders/:id/send`) cihaza gider, pencere "Cihazda ödeme
bekleniyor" der. Ödeme türü cihazda seçilir: Pavo'ya ödeme bilgisi gönderilmez (§8.2, belgede yok), Token sepetinin
ödeme alanı (`paymentItems`) da sahada denenmediği için kullanılmaz. Cihaz ödeyince
ödeme bugünkü sonuç yoluyla (`applyResult`, `okc.paid`) yazılır, pencere sonuç ekranını (nakitte para üstü) gösterir.

| Durum | Ne olur |
|---|---|
| Tamamı nakit, kart (Token ve eğitim cihazında yemek kartı da) | Sepet cihaza gider |
| Kalem seç | Seçilen kalemler cihaza gider |
| Kısmi tutar, bahşiş, paylaşımlı hesap (pay), açık hesap, havale, LafPOS'ta alınmış ödeme varken bütün hesap | Bugünkü gibi LafPOS'a yazılır; düğmenin yanında nedeni bir cümle (`shared/odeme-fisi.ts` › `deviceRoute`) |
| Cihaz reddetti, cihazda vazgeçildi, cihaza ulaşılamadı | Sade neden ve **Yeniden dene**; adisyon açık kalır, ödeme yazılmaz |
| Yanıt alınamadı (`okc_unknown`) | Sepet bekleyen kalır, sonucu sorgulanır (§7) |
| Çift dokunuş, yeniden deneme | Tek sepet: süren istek düğmeyi kilitler; bekleyen sepet varken sunucu ikincisini yazmaz (`okc_pending`, pencere bunu hata saymaz) |

Online ödenmiş sipariş cihaza gitmez ve tahsil edilmez; ikram, ödenmez ve zayi ödeme penceresinin ciro dışı kapanışıyla
bugünkü gibi. Ayar kapalıysa ya da bağlantı masada ödemedeyse pencere bugünkü gibidir. Testler:
`tests/yazarkasa-tek-dokunus.test.ts`, `tests/yazarkasa-tek-dokunus-pavo.test.ts`; e2e akışı eğitim cihazıyla.

**Ödeme sonrası fişler.** Müşterinin mali fişini cihaz basar. Başarılı ödemeden sonra fiş yazıcısından iki ayrı kâğıt
çıkar, yazarkasa bağlıyken de (`src/lib/after-payment.tsx`, `src/lib/print.tsx`): önce **müşteri nüshası** (sipariş
numarası ya da masa çok büyük, çağrı için; kalemler; "mali değeri yoktur"; `BillReceipt`), sonra **işyeri nüshası** (bar
ve hazırlık için: adisyon no, masa ya da tür, tarih-saat, kalemler ve seçenekler, ikram edilen kalemde tutar yerine türü,
indirimli kalemin altında indirimi, adisyondaki gibi ara toplam, indirim ve servis, adisyon toplamı, ödeme türleri,
yazarkasa fiş ve Z no'su varsa, kasiyer; `StoreCopyReceipt`). Ayarlar Yönetim › Ayarlar
ve yedek › Fiş yazıcısı kartında, her kâğıt kendi ayarıyla: "Ödeme sonrası müşteri nüshası" (`receiptInfoSlip`) ve
"Ödeme sonrası işyeri nüshası" (`receiptStoreCopy`), ikisi de varsayılan açık (`shared/odeme-fisi.ts` ›
`afterPaymentParts`). İkram, ödenmez ve zayi kapanışında da aynı iki kâğıt (işyeri nüshasında kapanış türü). Her ödeme
için tam bir kez; yalnız kasa bilgisayarının ekranında (`localhost`) ve kasa kısayolu bir fiş yazıcısı bildirdiyse
(`integrations.receiptPrinter`); yoksa sessizce atlanır. LafPOS'ta alınan ödemenin kâğıtlarını ödemeyi alan ekran basar.
Her kâğıt ayrı yazdırma işi, yazıcı her birinin sonunda keser. Bütün çıktılar (nüshalar, Z, X, gün sonu kâğıdı, deneme
fişi) tek sıradan geçer (`printQueue`, `tests/fis-sirasi.test.ts`): biri bitmeden (doğrudan basmada sunucunun yanıtı,
tarayıcıda `afterprint`) öteki başlamaz; eskiden art arda iki ödemenin kâğıtları üst üste binince biri öbürünün fişini,
öteki boş kâğıt basabiliyordu. Pavo'nun banka gün sonu kâğıdı (Z ve Pavo - LafPOS kıyası) bu iki ayara bağlı değil: fiş
yazıcılı kasa ekranında, kendi ayarıyla (Yönetim › Yazarkasa POS › "Gün sonu kâğıdı fiş yazıcısından da çıksın";
`shared/odeme-fisi.ts` › `bankEodSlipHere`).

**Cihaz ödemesinin işyeri nüshası sunucuda bekler** (22 Kasım 2026; sunucu `server/okc/store-copy.ts`, ekran
`src/lib/store-copies.ts`). Eskiden nüshayı yalnız canlı olay (`okc.paid`) bastırıyordu: ödeme anında kasa ekranı
kapalıysa, yenileniyorsa, kilitliyse ya da canlı bağlantı (SSE) kopuksa nüsha hiç çıkmıyordu.

- Sepeti nüsha basan kasa ekranı (fiş yazıcısı var, iki nüshadan en az biri açık) gönderirse
  (`POST /api/okc/orders/:id/send`, `storeCopy: true`) fişe "bekliyor" yazılır (`fiscal_receipts.store_copy`).
  Telefondan ya da yazıcısız ekrandan giden sepetin nüshası yoktur (eskisi gibi).
- Cihaz ödeyince `okc.paid` olayı fişin kimliğini (`receiptId`) taşır; kasa ekranı nüshayı bu kimlikle alır
  (`POST /api/okc/store-copies/:id/claim`), basar ve "basıldı" der (`…/printed`; denetim kaydı `okc.store_copy`,
  geç basıldıysa "ödemeden 12 dk sonra"). Fiş kimliği taşımayan eski olayda ekran bekleyenleri sorar.
- Olay kaçtıysa kasa ekranı açılınca (giriş, sayfa yenileme) ve canlı bağlantı yeniden kurulunca bekleyenleri sorar
  (`GET /api/okc/store-copies`) ve her birini basar: her ödemenin müşteri ve işyeri nüshası (ayarı açık olanlar) ayrı
  yazdırma işi. İşyeri nüshası ödemenin saatini yazar. Görünmeyen sekme (arkada ya da simge durumunda; tarayıcı orada
  yazdırmayı bekletir) nüsha almaz, görünür olunca sorar.
- Alma atomiktir: iki sekme ya da iki cihaz aynı nüshayı isterse yalnız biri alır, öbürü 409 `copy_taken` alır ve
  basmaz. Alınıp 2 dk içinde "basıldı" denmeyen nüsha (ekran basarken kapandı) yeniden verilir; denetim kaydı iki kez
  basılmış olabileceğini yazar.
- Yalnız açık günün ödemeleri: gün kapanınca bekleyen nüsha basılmaz. İki nüsha ayarı da kapalıysa hiçbiri; yalnız
  müşteri nüshası açıksa nüsha yine bekler ve ekran yalnız onu basar (eskiden işyeri nüshası kapalıyken cihaz
  ödemesinin müşteri nüshası hiç çıkmıyordu). Fişi iptal edilen ödemenin nüshası da basılmaz. Uçlar `odeme.al` ister.
  Kör kasada nüsha yine bu fişin ödemesini yazar (aynı döküm `okc.paid` olayıyla zaten her ekrana gider); adisyonun
  öteki ödemeleri gitmez.
- Testler: `tests/isyeri-nushasi.test.ts`.

### 4.2 Yazarkasadan geçmeyen (X, Z, patron paneli, Uzaktan; Kasım 2026)

Sahip gün içinde cihazdan geçmeyen satışı görür: satış ödemelerinden mali fişi yazarkasada kesilmeyenlerin **kart** ve
**nakit** toplamı. Tanım tek yerde: `shared/order-calc.ts` › `offDeviceTotals` (saf işlev, kuruş).

- Ödeme cihazdan geçmiştir, ancak bir yazarkasa fişinin ödemesiyse: cihaz belgeyi kesip sonucu LafPOS'a işleyince ödemenin
  kimliği fişin `paymentIds`'ine yazılır (§6; eksik ödenen `hata` fişinin işlenen ödemeleri de). Eğitim cihazının fişi de
  sayılır: eğitimde satır gerçek kullanımdaki gibi çalışır (eğitim günü lafmaliyet'e gitmez).
- Geri kalan kart ve nakit sayılır: "LafPOS'a yaz (fiş ayrıca)", "cihazsız kaydet", cihaz reddedince "Başka yoldan aldım",
  kısmi tutar, paylaşımlı hesabın payı, yazarkasa bağlantısı kapalıyken alınan. Bunların mali fişi cihazda ayrıca kesilir.
- Tür, ödemenin Z alanından: `cash` nakit, `card` kart. Yemek kartı (mali fiş değil bilgi fişi kesilir; Pavo'da cihaza
  hiç gitmez), havale, açık hesap, online ve diğer girmez; Z'de kendi satırlarındadır.
- Bahşiş girmez (satış değil; mali fiş satış tutarına kesilir). Kısmi ödemede her ödeme ayrı sayılır: hesabın LafPOS'ta
  alınan kısmı girer, aynı hesabın cihazdan geçen kısmı girmez. İptal edilen ödeme (cihazda fişi iptal edilen dahil) ve
  açık hesap tahsilatı girmez.
- Değişmez: X ve Z'nin kart ve nakit alanı = cihazdan geçen + yazarkasadan geçmeyen.
- Bilinen sınır: alarm düşen iki durumda (cihazda eksik ödenen fiş, `okc.underpaid`; LafPOS'ta iptal sayılıp cihazda
  ödenen sepet, `okc.late_paid`) kalanı kasadan alınan tutar yazarkasadan geçmeyen görünür, oysa fişi cihazda kesilmiştir.
  LafPOS hangi kasa ödemesinin o fişe düştüğünü bilmez; alarm durumu ayrıca söyler.

| Nerede | Ne görünür |
|---|---|
| Kasa › Ara rapor (X) ve Z ekranı | Ödeme türleri kartında "Yazarkasadan geçmeyen": Kart, Nakit ve tek cümle açıklama |
| X ve Z fişi | "Yazarkasadan geçmeyen" başlığı altında Kart ve Nakit |
| Patron paneli › Gün içi | Bugünün toplamı, altında kart ve nakit; dokununca neyi saydığı yazar; ikisi de sıfırsa "yok" |
| Raporlar › Ciro (kafede ve Uzaktan'da) | Ödeme türleri kartının altında dönemin kartı ve nakdi |
| LafPOS Uzaktan › Patron paneli | Gün içi satırı; gün kapalıyken gün sonu kartında |

**Kör kasa:** `kasa.rakam` ya da `rapor.gor` yetkisi olmayan bu rakamı görmez: X ve Z özeti ona hiç gitmez, patron paneli
verilmiş olsa da satır gelmez. Buluta yalnız patron rolü kasa rakamlarını görüyorsa gider (gün sonu kartının kasa farkıyla
aynı kural; patron rolü kilitli olduğundan bugün hep gider).

**Eski kayıt:** bu sürümden önce kapanan Z'de alan yoktur; ekran, fiş ve gün sonu kartı satırı yazmaz (₺0 göstermez).
Uzakta dönemin bir günü eski kasadan geldiyse dönem toplamı yazılmaz (`shared/remote-calc.ts` › `sumOffDevice`); kasa
güncellenince günlük tarama geçmiş günleri yeni alanla yeniden iter (yaklaşık bir saat), sonra satır görünür. lafmaliyet'e
gitmez (sözleşmede yok). Testler: `tests/yazarkasadan-gecmeyen.test.ts`, `tests/report-reconciliation.test.ts`.

## 5. Sepet nasıl hesaplanır (`basket.ts`)

- Tutarlar kuruş; `taxPercent` oran × 100, `quantity` adet × 1000, kısım KDV oranından.
- İkram ve iptal edilen kalem gitmez; ödenmiş adet düşülür; istenirse yalnız seçili kalemler gönderilir
  (kalem bazlı ödeme). Seçilen adetlerin tutarı ödeme ekranıyla aynı hesaptır (`itemsBreakdown`): satırın kalan
  bütün adetleri satırın kalanını alır (net pay eksi canlı ödemelerin bu satıra ödediği), kısmi adetler adet
  paylarından sırayla. Sepetin satır tutarları cihaz ödemesinin kalem işaretine yazılır; ödeme iptal edilip adet
  yeniden ödenince kuruş kalmaz.
- Adisyon indirimi satırlara en büyük kalan yöntemiyle dağıtılır (`adjust.totalValue`). Servis ücreti ayrı
  "Servis ücreti" satırıdır ve yalnız bütün adisyon gönderilince gider; daha önce cihaza giden servis düşülür.
  Kalem kalem ödenen masada kalan servis tek satırlık sepet olur.
- Bütün adisyon gönderilince sepet her KDV oranında LafPOS'un KDV dökümüne tamamlanır: o orandan daha önce ödenen
  kısım (cihaz fişleri gönderilen sepetten, LafPOS'ta kalem seçerek alınan ödemeler kalemlerin payıyla) düşülür,
  sepetin toplamı adisyonun kalanıdır. Kalem bazlı ödemeden sonra kalem eklenip adisyon indirimi yeniden
  dağıldığında fark aynı oranın kalemlerine işlenir; o oranda ödenmemiş kalem yoksa o oranda "İndirim farkı"
  satırı olur. Kalem başına 2 kuruşa kadar yuvarlama oranlar arasında dengelenir. Ödenmiş orana düşen fark eksiyse
  (ödemeden sonra indirim artırıldı ya da ödenmemiş kalem iptal edildi) cihaz eksi satır almadığı için fark diğer
  oranların indirimine yazılır.
- Fark hiçbir zaman servis satırına yazılmaz: cihazdaki "Servis ücreti" LafPOS'un servisinin cihaza gitmemiş
  kısmıdır, müşteri iki ayrı servis tutarı görmez. Tek istisna sepette indirimi taşıyacak kalem kalmamasıdır
  (yalnız servis kaldı); o zaman sepetin toplamı adisyonun kalanından sapmasın diye fark servis satırından düşer.
- Cihazdan gelen ödeme (bölünmüş ödemenin ikincisi, servis fişi) kalem taşımasa da "tutar olarak alınmış ödeme"
  sayılmaz. LafPOS'ta tutar ya da pay olarak alınmış ödeme varsa bütün adisyon gitmez (`okc_partial`), kalem
  seçilerek gider.
- Aynı adisyon için açık bir sepet varken ikincisi gönderilmez (409). Sepet cihazda beklerken adisyonun tutarı ve
  ödemeleri kilitlidir (iptal, ikram, indirim, ödeme, taşıma, birleştirme, iptal: 409 `okc_pending`); kalem
  eklenebilir. Karaoke oda sayacı çalışırken hesap cihaza gönderilmez (`room_running`), sepet cihazda beklerken de
  sayaç başlamaz (`okc_pending`). Sayaç yine de çalışıyorsa (eski veri, gönderimi hata görünen sepet) cihazdan gelen
  ödeme adisyonu kapatmaz: adisyon açık kalır, uyarı düşer, oda ücreti sayaç durunca ayrıca alınır.
- **Paylaşımlı hesap:** hesap kişilere bölünmüş olsa da cihaza tek sepet gider, mali fiş tek kesilir; paylar
  cihazda ayrı ödemeler olarak alınır (kişi başı nakit ya da kart). Adisyondaki Yazarkasa bölümü pay tutarlarını
  sırayla gösterir. Kişiye ayrı fiş gerekiyorsa paylar yerine **Kalem** ile ödenir: her kişinin kalemleri ayrı
  sepet olur.

## 6. Sonuç

Token sonucu `fromTokenxSale` ile ortak sonuca çevrilir (`0` → `paid`, `99` → `voided`, `-1` → `cancelled`).

| Cihazdan gelen (Token) | LafPOS'ta |
|---|---|
| `sale.status = 0` | Ödeme kalemleri adisyona işlenir (1 nakit, 3 kart, 7 yemek kartı, 17 açık hesap, 18 havale; ödeme türü eşlemesi Yönetim › Yazarkasa'da), Z ve fiş no yazılır, kalan yoksa (oda sayacı çalışmıyorsa) adisyon kapanır |
| `0`, ödemeler sepeti karşılamıyor | Cihaz ikram (9), ödemesiz (8) ya da LafPOS'ta karşılığı olmayan türle kapattıysa alınan ödemeler tutar olarak işlenir, kalemler ödenmiş sayılmaz; sepet `hata` olur ve yöneticiye alarm düşer (`okc.underpaid`). Bu fişin kalemleri cihaza yeniden gönderilmez, başka adisyona taşınmaz ve sepet LafPOS'ta silinemez (`okc_unresolved`): aynı kalemler ikinci fişe girerdi. Kalan kasadan (tutar ya da kalem olarak) alınır ya da fiş cihazdan iptal edilir; adisyonun fişe girmemiş kalemleri bu arada "Kalem seç" ile cihaza gönderilebilir. Bütün adisyon, fişteki kalemler LafPOS'ta ödenmedikçe gitmez. LafPOS'a işlenemeyen "ödendi" sonucu da böyle |
| `-1` | Kasiyer cihazda vazgeçti; sepet kapanır, adisyon açık kalır |
| `0`, sepet LafPOS'ta iptal sayılmış | Adisyon kendiliğinden kapanmaz, yöneticiye alarm düşer (`okc.late_paid`); Z ve fiş no sepete yazılır. Aynı bildirim tekrar gelirse alarm tekrarlanmaz |
| `99` | Fiş iptal edildi; o fişin ödemeleri iade olarak düşülür, adisyon yeniden ödenebilir. Ödeme birleştirmeyle başka adisyona geçtiyse o adisyondan düşer (birleştirmede fişler de hedef adisyona taşınır). Kapanmış adisyon yalnız ödenecek tutar doğarsa açılır: ödemesi LafPOS'ta zaten iptal edilip yeniden alınmışsa kapalı kalır. LafPOS'a ödemesi işlenmiş her fiş (eksik ödenmiş `hata` fişi de) böyle geri alınır |
| `99`, fiş kesilmemiş sepet | Bekleyen sepet `iptal` olur (`okc.cancelled`). LafPOS'ta silinmiş ya da cihazda vazgeçilmiş sepetin durumu değişmez; bir kez not düşülür (`okc.void`, uyarı). Geç "ödendi" bildirimi gelmiş sepette fiş kesilip iptal edilmiştir: fiş `fis_iptal` olur, alarm düşer |
| `99`, fiş kapanmış güne ait | Kapanmış günün Z'si değişmez: ödeme geri alınmaz, adisyon açılmaz, fiş `fis_iptal` olur ve yöneticiye alarm düşer (`okc.void_closed_day`). Müşteriye para iade edildiyse bugünün kasasından çıkış olarak işlenir. Eğitim cihazında bu iptal hiç yapılamaz (`day_closed`) |
| `BASKET_LOCKED` / `UNLOCKED` | Sepet cihazda açıkken LafPOS'ta kilit gösterilir |

Her sonuç denetim kaydına yazılır: gönderim (`okc.send`), ödendi (`okc.paid`), cihazda vazgeçme ya da cihazdan
silinme (`okc.cancelled`), LafPOS'tan sepet iptali (`okc.delete`, ulaşılamadıysa `okc.force_cancel`), cihaza
ulaşmayan gönderim (`okc.not_delivered`), fiş iptali (`okc.void`, `okc.void_closed_day`) ve alarmlar
(`okc.underpaid`, `okc.apply_failed`, `okc.late_paid`). Pavo'da cihazın banka gün sonu `okc.eod` (§8.5). İşyeri
nüshası basılınca `okc.store_copy` (§4.1). Aynı sonuç ikinci kez gelirse işlem ve kayıt tekrarlanmaz.
Son hata Genel bakış › Sistem sağlığı'nda ve Yazarkasa sayfasında görünür.

## 7. Sık sorunlar

- **"TokenX bilgileri .env dosyasında eksik"**: `TOKENX_AUTH_URL`, `TOKENX_BASKET_URL`, `TOKENX_CLIENT_ID`,
  `TOKENX_CLIENT_SECRET` ve moda göre terminal ya da şube kimliği gerekli.
- **1106 terminal bulunamadı**: `TOKENX_TERMINAL_ID` yanlış ya da cihaz Token'da tanımlı değil.
- **Toplam farkı**: kısım eşlemesindeki KDV oranı cihazdakiyle aynı olmalı.
- **Sonuç gelmiyor**: webhook adresine dışarıdan erişilemiyorsa anahtarı kaldırın; LafPOS yoklamaya döner.
- **Yazarkasadan yanıt alınamadı** (`okc_unknown`): gönderim zaman aşımına uğradı, bağlantı koptu (yanıtın gövdesi
  okunurken kopması da) ya da Token durum kodu olmayan bir yanıt verdi (JSON olmayan 2xx, 5xx); sepet cihaza ulaşmış
  olabilir. Sepet bekleyen kalır (adisyon kilitli, LafPOS'ta ikinci kez tahsil edilmez) ve LafPOS durumunu sorar:
  cihazda ödendiyse adisyon kendiliğinden kapanır; Token sepeti hiç görmediyse (1006) sepet hataya düşer ve adisyon
  kasadan alınabilir. Token'ın kodla reddettiği, 4xx dönen ya da bağlantının hiç kurulamadığı gönderim hemen
  hataya düşer. Sonuç gönderim isteği sürerken geldiyse (webhook) işlenmiş sepet hatayla ezilmez; silme
  sürerken gelen "ödendi" de öyle.
- **İnternet ya da Token kesik, sepet silinemiyor** (`okc_delete`): adisyondaki "İptal"e basınca LafPOS sorar;
  onaylanırsa sepet yetkili PIN'iyle LafPOS'ta iptal sayılır, adisyon kasadan alınır ve gün kapanabilir. Denetim
  kaydına alarm düşer (`okc.force_cancel`). Cihazda yine de o sepetten ödeme alındıysa geç gelen sonuç ikinci bir
  alarm verir (`okc.late_paid`): mali fiş cihazdan iptal edilir. Onay penceresi açıkken cihazda fiş kesildiyse
  (sepet ödendi ya da eksik ödenip `hata` oldu) iptal reddedilir (`okc_paid`, `okc_unresolved`): fişi kesilmiş
  sepet hiçbir yoldan "silindi" sayılmaz, fiş iptali ödemesini geri alabilsin.

## 8. Pavo (N86) yerel ağ bağlantısı

Pavo cihazı kafenin ağında bir HTTP sunucusudur; LafPOS (kasa bilgisayarı) satışı ona gönderir, kasiyer ödemeyi
cihazda (nakit, kart; bölünmüş de) alır, cihaz VUK 507 belgesini keser (e-Arşiv, e-Fatura ya da bilgi fişi; Z yok).
İnternet ya da bulut gerekmez; cihaz ile kasa bilgisayarı aynı ağda olmalı. Kod: istemci `server/okc/pavo.ts`,
sağlayıcı `server/okc/providers/pavo.ts`, testler `tests/pavo.test.ts`.

### 8.1 Kurulum

1. Cihazda Ayarlar › Çevresel Donanımlar › Network Ayarları: REST açık, REST ağı Wi-Fi ya da Ethernet (mobil veri
   REST'te çalışmaz). Cihazın IP adresini modemden sabitleyin.
2. Yönetim › Yazarkasa POS: bağlantı **Pavo** (ödeme yeri kendiliğinden kasada ödeme). Pavo kartında cihazın **IP
   adresi** ve **seri numarası** yazılır (21 Kasım 2026'dan beri ayar dosyası gerekmez). Seri no cihazda Terminal
   Ayarları › Terminal Bilgileri › Seri Numarası'dır (N86'da `PAV86…`, 12 karakter); aynı ekrandaki Terminal ID
   (bankanın terminal no'su) REST'te kullanılmaz. Adres `192.168.1.50` gibi
   yazılır: şema yoksa `https`, port yoksa `4567` (`pavoAddress`); `192.168.1.50:4568` ya da `http://…` da kabul.
   **Cihazı ağda ara** kasanın yerel ağında (yalnız özel adresler, `/24`, en çok üç ağ) 4567 ve 4568 portlarını
   yoklar, açık bulduğuna `/Ping` gönderir (`server/okc/pavo-bul.ts`); yanıt veren adresler listelenir, tek cihaz
   bulunursa adres kendiliğinden yazılır. Seri no yazılıysa `/Ping` onunla gider ve "Seri no tutuyor" görünür. Kaydet
   (`PUT /api/okc/pavo`, `ayar.yonet`) yeniden başlatma istemez; adres ya da seri no değiştiyse eşleştirme sıfırlanır
   (sıra no ve sertifika izi silinir), denetim kaydına `okc.pavo_device` düşer. Cihazda süren satış ya da gün sonu
   varken (409 `okc_busy`) ve cihaz sonucunu bekleyen sepet varken (409 `okc_pending`) cihaz değişmez.

   | Ayar | Ne |
   |---|---|
   | Yönetimden (`pavoDevice` ayarı) | Cihazın adresi ve seri no'su; varsa geçerli olan budur |
   | `PAVO_URL`, `PAVO_SERIAL` | Eski kurulumların ayar dosyası satırları; yönetimden girilmediyse kullanılır ("Kaynak: Ayarlar dosyası") |
   | `PAVO_FINGERPRINT` | İsteğe bağlı; tanımlıysa her şeyden önce o gider (aşağıda "Program kimliği") |

   **Program kimliği** (Pavo'nun `Fingerprint` alanı, eşleştirmede cihaza kaydedilir, her istekte aynısı gider):
   kuruluma özel ve kalıcıdır. İlk eşleştirmede üretilir ve saklanır (`sync_state` `pavo.fingerprint`): `LafPOS-` ve 6
   harf-rakam (ör. `LafPOS-K7Q2XM`; biçim en çok 32 karakter, harf, rakam ve tire). Geriye uyum: kimlik saklanmadan
   eşleştirilmiş eski kurulum `LafPOS` ile devam eder (ilk okunuşta saklanır; yeniden eşleştirme gerekmez).
   Cihaz değişince (adres ya da seri no) eşleştirme sıfırlanır ama kimlik aynı kalır. Kimlik Yönetim › Yazarkasa POS ›
   Pavo kartında salt okunur görünür. Cihaz başka programla eşleşmişse (73/74) "Son hata" kutusunda doğrudan **Yeniden
   eşleştir** düğmesi çıkar. Testler: `tests/pavo-kimlik.test.ts`, `tests/pavo-panel.test.ts`.

   Pavo'nun belgesi 4568 HTTPS, 4567 HTTP der; entegratörlerin kodu N86'da `https://…:4567` kullanır. "Cihazı ağda
   ara" ve "Bağlantıyı dene" hangisinin açık olduğunu söyler.
3. **Eşleştir** (cihazda onay ekranı açılır, kasiyer onaylar; LafPOS en çok 2 dk bekler), **Bağlantıyı dene** (cihaz
   yanıt veriyor mu, eşleştirme geçerli mi, cihazdaki ödeme araçları). Testler: `tests/pavo-panel.test.ts`.
4. İlk satışı küçük tutarla deneyin: cihaz gerçek e-Arşiv belgesi keser. "Cihazın son yanıtları" (yönetim
   sayfasının altında) yanıtın alanlarını gösterir; tanınmayan biçim orada görünür.
5. **Gün sonu (banka)** kartı: "Gün kapanınca cihazda gün sonu al" varsayılan açık; LafPOS gün sonundan hemen sonra
   cihaz bankalardaki kart işlemlerini kapatır (§8.5). Cihazın kendi menüsünden gün sonu alınıyorsa kapatın. İlk
   kurulumda "Cihazda gün sonu al" ile bir kez elle deneyin.

Pavo bulut API anahtarı (PavoPay portalında üretilen, 64 karakterlik) bu bağlantıda kullanılmaz: bulut kanalı ayrıca
Pavo'nun entegratöre verdiği "App Token"ı ister (§8.4). Cihazın adresi ve seri no'su gizli değildir (cihaz yerel ağda,
kimliği eşleştirme ve sertifika izi); veritabanındaki ayarlarda durur, depoya girmez.

### 8.2 Akış

- **Eşleştirme** (`/Pairing`): sıra no 1'e döner; LafPOS cihazın sertifikasının parmak izini saklar. Sonraki her
  istekte gövde gönderilmeden sertifika karşılaştırılır; farklıysa istek gitmez ("Cihazın sertifikası
  eşleştirmedekinden farklı"): aynı ağdaki başka bir makine kendini cihaz gibi gösteremez. Cihaz değiştiyse ya da
  uygulaması güncellendiyse yeniden eşleştirilir. Pavo günde bir eşleştirmeyi önerir.
- **Her istek**: `TransactionHandle` (seri no, parmak izi, sıra no, yerel saat `yyyy-MM-ddTHH:mm:ss.fff`). Sıra no
  kalıcıdır (`sync_state` `pavo.sequence`) ve istek gitmeden artırılır; yanıtı alınamayan istekten sonra da aynı
  numara tekrar gitmez (cihaz tekrarı reddeder). Kasa bilgisayarının saati cihazınkinden 5 dakikadan fazla sapmamalı.
- **Satış** (`/CompleteSale`): sepet Pavo satışına çevrilir (`pavoSale`). Tutarlar TL, KDV dahil; KDV grubu orandan
  (`KDV10`, `KDV20`); birim `C62` (adet); sipariş no sepet kimliğinden (`pavoOrderNo`, 16 karakter). İndirim ayrı
  alanla değil kalemin tutarıyla gider: tutar adede tam bölünmüyorsa satır iki olur (n-1 adet ve son adet), fiş
  toplamı LafPOS'un hesabıyla kuruşu kuruşuna aynıdır. Kasada seçilen tür (nakit, kart) `PaymentInformations`
  (`Mediator` 1 nakit, 2 kart; tutar fişin toplamı) ile gider, cihaz o türle açılır (Yönetim › Yazarkasa POS › "Ödeme türü
  cihazda hazır gelsin", varsayılan açık; alan adları entegratörlerin açık kodundan, ilk gerçek satışta doğrulanacak).
  Yemek kartı ve öteki türlerde ödeme bilgisi gönderilmez: kasiyer cihazda seçer. `KDV10` ve
  `KDV20` dışındaki oranlı kalem (%0, %1) cihaza gitmez: sepet kaydı yazılmadan "%0 KDV'li kalem Pavo'ya
  gönderilemez; ürünün KDV oranını düzeltin ya da hesabı kasadan alın" (400 `okc_basket`), adisyon kilitlenmez.
  Cihazın başka grupları bilip bilmediği belgede yok (§8.4).
- **Bekleme**: cihaz aynı anda tek istek işler; satış ekranı açıkken (yanıt gelene dek) sepet LafPOS'ta "kilitli"
  görünür ve LafPOS cihaza başka istek göndermez. Cihaz ilk 6 sn içinde reddederse (KDV grubu, eşleştirme) kasiyer
  hatayı hemen görür, sepet hataya düşer, adisyon kilitli kalmaz.
- **Sonuç**: cihazın yanıtındaki satış kaydı (`Data` ya da `Data.Sale`): `AddedPayments` (`StatusId` 2 etkin;
  `PaymentTypeId` 1 nakit, 2 kart; `PaymentAmount` TL) ve `FinancialDocuments` (`InvoiceNo` belge no, `Type.Name`
  belge türü). Kasiyer vazgeçerse (`HasAbondon`) sepet kapanır, adisyon açık kalır. Hata dönen satışta belge kesilip
  kesilmediği bir kez `/GetSaleResult` ile sorulur; belge yoksa sepet vazgeçildi sayılır, bu sorguyu cihaz eşleştirme
  bozuk diye reddederse (73, 74) sepet kapanmaz (aşağıda). Yanıt gelmezse (sunucu yeniden başladı, bağlantı koptu)
  sonuç sipariş no ile `/GetSaleResult`'tan sorulur (en sık 5 sn'de bir). 8 saatten eski bekleyen sepet kendiliğinden
  sorgulanmaz (yalnız onlar kaldıysa sorgu döngüsü durur); adisyondaki "Yenile" ile elle sorulur.
  Sorgu "başarısız" derse (hata, satış kaydı yok; kart reddinden sonra satış cihazdan düştü) ve cihaz o satışla meşgul
  değilse sepet vazgeçildi sayılır, adisyon açılır ve yeniden gönderilebilir (#131, sahada kart reddinden sonra sepet
  "Cihazda ödeme bekleniyor"da kalıyordu). Cihazın "satış yok" kodu belgesiz ve tek okuma isteğin geçici reddi de
  olabilir (cihaz meşgul): sepet ancak aynı kodlu okuma en az 15 sn sonraki bir sorguda da gelirse kapanır
  (`pavoTiming.failConfirmMs`); arada gelen başka her okuma (başka kodlu "başarısız" da) sayacı baştan başlatır.
  Eşleştirme bozuk derse (73, 74) sepet hiç kapanmaz: yanıt satış hakkında değil, müşteri cihazda ödemiş olabilir
  (yeniden gönderim kartı ikinci kez çekerdi). Sorgu eşleştirme mesajıyla hata verir ("Son hata"da "Yeniden
  eşleştir"), eşleşince sonuç gelir (hata dönen satışın belge sorgusunda da: eşleşince sonuç sorgusu belgeyi ya da
  kesinleşen "satış yok"u okur). Kapanan sepetin sonucunda cihazın ham yanıtı saklanır: gerçek cihazın "satış yok"
  kodu oradan öğrenilir.
- **İptal**: satış cihazın ekranındayken LafPOS'tan silinmez, cihazda vazgeçilir. Ekranda değilse LafPOS cihaza
  sorar: ödenmişse sonuç işlenir, ödenmemişse cihazda silinecek bir şey yoktur. Cihaza ulaşılamazsa yetkili onayıyla
  LafPOS'ta iptal sayılır (§7, `okc.force_cancel`). LafPOS cihaza iptal (`/CancelSale`) göndermez: belgenin
  anlamı belgesiz.

### 8.3 Temkin kuralları (para yolu tahminle kurulmaz)

- Satış kaydı tanınmayan **hatasız** yanıt ödendi sayılmaz; sonuç sorulur. Hatasız ama satış kaydı yoksa sepet
  bekler. Hata dönen ama satış kaydı olmayan sorgu sepeti ancak aynı kodla en az 15 sn arayla iki kez gelirse kapatır
  (vazgeçildi; §8.2 Sonuç); eşleştirme reddi (73, 74) hiç kapatmaz, hata dönen satışın belge sorgusunda da.
  Eşleştirme bozukken elle iptal de cihaza ulaşılamamış gibi yalnız yetkili onayıyla yapılır (`okc.force_cancel`):
  sepetin cihazda ödenip ödenmediği bilinmez.
- Anlamı belgelenmemiş ödeme tipi (1 ve 2 dışı: yemek kartı, havale...) tahminle bir türe yazılmaz: ödemesi
  LafPOS'a işlenmez, sepet eksik ödenmiş sayılır (`okc.underpaid` alarmı), kalemler yeniden gönderilmez; kalanı
  yönetici doğru türle kasadan alır.
- Belge kesilmişse (`InvoiceNo` ya da etkin ödeme var) hata dönen yanıt da ödendi sayılır (ör. yazıcı hatası).
- Cihazın ham yanıtı sepetin sonucunda (`fiscal_receipts.result.raw`) saklanır; ilk gerçek satıştan sonra alan
  adları buradan doğrulanır.

### 8.4 Kaynaklar ve Pavo'dan istenecekler

Pavo'nun belge sitesi (docs.pavopay.dev) projeye özel ve kapalı. Doğrulanan: REST bağlantı kuralları ve eşleştirme
(Pavo'nun REST sayfasının Ağustos 2026 kaydı); satış kaydının biçimi (Pavo'nun satış API'sinin yanıt modeli, bir
entegratörün açık kodu); banka gün sonu (`/PerformEOD`, `/PrintEODCopy`) ve hata kodları (Pavo'nun REST paketi
"BKM TechPOS 509 REST V39", örnek istek ve yanıtlarıyla). Entegratör kodundan, belgesiz: `/CompleteSale` ve
`/GetSaleResult` uç adları ve satış gövdesi, `MainDocumentType: 1`, `KDV{oran}` grup kodu, N86'da port. Pavo'dan
(info@pavo.com.tr, 0850 611 04 44) istenecekler:

1. N86 / PavoPay (VUK 507) REST belgesine erişim (docs.pavopay.dev) ve hata kodları.
2. `/CompleteSale` ve `/GetSaleResult` yanıtının tam biçimi; `PaymentTypeId`, `MainDocumentType`, `TaxGroupCode` ve
   belge türü değerlerinin listesi (`KDV1` ve `KDV0` grubu var mı; yoksa %1'lik ürün nasıl satılır).
3. Kesilmiş belgenin iptali ve iadesi (e-Arşiv iptali) ve LafPOS'a nasıl bildirildiği.
4. Bulut kanalı için App Token (kafenin PavoPay API anahtarıyla kullanılır) ve bulutta kalemli satışın seri no ile
   cihaza gönderilmesi.
5. Masada ödeme (cihazın açık hesap listesi) desteği.
6. Banka gün sonunun VUK 507 cihazında (N86) da aynı uçla alındığı; boş batch'te gün sonunun yanıtı.

### 8.5 Gün sonu (banka)

Kartla alınan ödemeler bankada bir "batch"te birikir; cihazın banka gün sonu batch'i kapatır ve para hesaba geçer.
Gün sonundan sonra o işlemler cihazda iptal edilemez, yalnız iade edilir. LafPOS bunu kendi gün sonuna bağlar ama
**ona bağımlı kılmaz**: LafPOS günü önce kapanır (tek işlem, Z yazılır), cihaz gün sonu ardından arka planda başlar
(`deviceEndOfDay`, `server/okc/service.ts`; elle ve otomatik gün sonu ikisi de). Cihaz yanıt vermese, hata dönse ya da
hiç bağlı olmasa da gün kapalı kalır.

- **İstek** (`/PerformEOD`): `useSummary: true`, `print: true` (cihaz kendi gün sonu slibini basar; gün kapanınca da
  elle de, sahibin isteği), `receiptImage: false`, `printData` kapalı (slip görüntüsü, JSON ve metin istenmez).
  `POST /api/okc/eod` gövdesinde `print: false` yalnız o istekte slipi kapatır (arayüzde yok). Yanıt en çok 3 dk
  beklenir; süre boyunca cihaz meşgul sayılır, yeni satış "Cihazda gün sonu sürüyor" diye reddedilir; bekleyen sepet
  sorgulanmaz (cihaz satışı hatayla bitirdiyse de belge sorgusu gün sonunun arkasında kuyruğa girmez: yanıt saklanır,
  gün sonu bitince sorulur), iptali 409 `okc_busy` alır (cihaz meşgul ama ulaşılabilir: "ulaşılamadı, LafPOS'ta iptal
  say" yoluna düşmez). Kasa da meşgul sayılır (`server/lib/mesgul.ts`; `GET /api/kasa/guncelleme-durumu` ayrıca
  `eod: true` der): güncelleme gün sonu bitmeden kurulmaz, sunucu yeniden başlayıp sonucu belirsiz bırakmaz. Gün
  kapalıyken güncelleyicinin beklediği tek meşguliyet budur (`guncelle.mjs` `installDecision`; en çok 3 dk, 5 dk'da bir
  yeniden sorar): bekleyen sepet gün kapalıyken de kalabildiğinden (site siparişi) kurulumu süresiz tutmaz.
- **Kâğıt**: cihazın slibi her gün sonunda (yukarıda). Yönetim › Yazarkasa POS › "Gün sonu kâğıdı fiş yazıcısından da
  çıksın" (`okcPavoEodFis`, varsayılan açık) yalnız fiş yazıcısını yönetir: açıkken işyeri nüshası basan kasa ekranı
  `POST /api/okc/eod/slip` (`odeme.al`) ile son başarılı gün sonunun kâğıdını alır (batch başına bir kez, ilk soran
  ekrana; 12 saatten eskisi basılmaz) ve önce kapanan günün LafPOS Z'sini, sonra bankalar, toplam ve Pavo - LafPOS
  kart kıyasını basar. Kıyas kayıt kâğıdı olduğundan kör kasada da basılır; Z kasa uçlarının kuralıyla gider
  (`server/lib/kor-kasa.ts`): kasa rakamlarını görmeyene hiç (`z: null`, kâğıt yalnız banka kısmıyla), maliyet yetkisi
  olmayana personel tutarları gizli.
- **Göndermeden önce** (cihaz meşgul işaretliyken, araya satış girmez): cihazın son gün sonu `/PrintEODCopy` ile
  okunur (`print: false`) ve denemenin **tabanı** olur (`prevBatchNo`, `prevBatchFrom`: `cihaz`; cihazda kayıtlı gün
  sonu yoksa `bos`; uç yanıt verip özet vermezse LafPOS'un bildiği son batch, `lafpos`). "Özet vermedi" yalnız uç
  yoksa (HTTP 404, 405, 501) ya da başarılı yanıtın gövdesi boşsa (2xx) sayılır (`eodCopyUnavailable`); cihazın iç
  hatası (HTTP 500, 503...) kopya yok sayılmaz. Cihaz bu soruya yanıt vermezse (bağlantı, zaman aşımı) ya da iç hata
  verirse gün sonu **gönderilmez**: sonuç `failed` ("gün sonu gönderilmedi"), yeniden
  denenebilir. Ardından "sürüyor" kaydı yazılır (`running`, yönetimde "Sürüyor"); süreç gün sonu sürerken kapanırsa
  açılışta (`startJobs` › `recoverDeviceEod`) `unknown` olur ve alarm düşer.
- **Ne zaman atlanır** (bilgi kaydı `okc.eod`, sonuç `skipped`): Pavo bilgileri eksik, kurulum (eğitim) modu, cihaz
  eşleştirilmemiş, cihazda süren satış var, ya da "Gün kapanınca cihazda gün sonu al" kapalı (`okcPavoAutoEod`;
  yalnız otomatik denemede). Otomatik denemede ayrıca: son sonuç ya da bu günün sonucu belirsiz / sürüyor ("önce
  Doğrula", `okc_eod_unknown`), ya da bu gün için gün kapandıktan sonra cihaz gün sonu zaten alınmış
  (`okc_eod_done`). Yeniden açılan gün aynı kimlikle kapanır: ikinci `/PerformEOD` kendiliğinden gitmez, gerekirse
  elle alınır. Gün açıkken elle alınan gün sonu kapanışın gün sonunu engellemez (sonraki kart işlemlerini o kapatır).
  Atlanan deneme belirsiz ya da süren sonucu ve aynı günün sonucunu ezmez. Bağlantı Pavo değilse hiçbir şey yazılmaz
  (Pavo'suz kurulumda her gün sonunda kayıt gürültü olurdu).
- **Sonuç** (`sync_state` `pavo.eod.<gün kimliği>` ve `pavo.eod.last`): yalnız özet. Batch no, cihaz saati
  (`gg.aa.yyyy ss:dd`), genel toplam (TL satırı, kuruş; "1.234,56 TL" `parseTL` ile), banka başına ad, işlem sayısı ve
  toplam, LafPOS günün kart toplamı (Z'nin kart alanı ve kartla alınan bahşiş). Kart numarası, işlem dökümü, işyeri
  ve vergi bilgisi, slip **saklanmaz**. Durum: `ok` alındı · `failed` cihaz alamadı (ör. 5085 "Günsonu alınamadı",
  bağlantı kurulamadı) · `unknown` istek gitti ama yanıt gelmedi (zaman aşımı, bağlantı koptu) ya da özetsiz yazıcı
  hatası (5066-5072): gün sonu alınmış olabilir · `running` sürüyor · `skipped` denenmedi. Özeti olan yanıt hata
  taşısa da alındı sayılır. Bir günün başarılı gün sonları ezilmez: günün kaydı öncekileri `earlier`'da (batch no,
  cihaz saati, toplam, deneme anı, gün kapalı mıydı) taşır.
- **Denetim kaydı** `okc.eod`: alındıysa bilgi; cihazın genel toplamı LafPOS'un kıyas tutarından farklıysa uyarı
  (cihazda LafPOS dışı ya da başka güne ait kart işlemi, başka cihazda alınan kart ödemesi); alınamadı ve belirsiz
  alarm. Gün kapanınca alınamayan ya da belirsiz kalan gün sonu patronun telefonuna da bildirilir (`afterDeviceEod`;
  kasadan, uzaktan ve otomatik gün sonunda). Kıyas tutarı (`dayCardKurus`) günün ilk gün sonunda kapanmış günün kart
  toplamı; aynı günün sonraki gün sonunda önceki gün sonundan (`dayCardSinceBatch`) sonra alınan, iade edilmemiş kart
  ödemeleri (bahşiş dahil).
- **Yeniden deneme kendiliğinden yapılmaz.** Belirsiz sonucun üstüne ikinci gün sonu, bankada boş ya da yanlış batch
  açar. Yönetim › Yazarkasa POS › Gün sonu (banka):
  - **Cihazda gün sonu al** (`POST /api/okc/eod`, `kasa.gun`): onay sorulur; ayar kapalı olsa da çalışır. Son
    kapanan günün denemesi alınamadı ya da atlandıysa bu onun yenisidir ve o güne yazılır (ertesi sabah gün açılmış
    olsa da); değilse açık güne, yoksa son kapanan güne. Son sonuç belirsizse önce doğrulama ister (409
    `okc_eod_unknown`; cihaz doğrulamaya da yanıt vermiyorsa gövdede `force: true` bu korumayı yalnız o istek için
    aşar, arayüzde yok). Cihazın hatası 502 (`pavo_eod`, belirsizse `pavo_eod_unknown`).
  - **Doğrula** (`POST /api/okc/eod/verify`, `kasa.gun`): cihazın son gün sonu `/PrintEODCopy` ile sorulur
    (`batchNo` yok: son gün sonu; Pavo'da bu ucun varsayılanı slip basmak olduğundan `print: false` açıkça gider).
    Son deneme alınamadı, belirsiz ya da atlandıysa ve cihazdaki gün sonu ondan sonraysa (`eodAfter`: batch no
    tabandan büyük, taban `bos` ise her batch; cihaz saati okunabiliyorsa denemeden en çok 6 dk önce, daha eskisi
    cihazın menüsünden önceden alınmıştır; taban bilinmiyorsa cihaz saati karar verir) sonuç "alındı" olur, tutarlar
    cihazınki. Taban gönderimden hemen önce cihazdan okunduğu için menüden önceden alınmış gün sonu bu denemenin
    sonucu sanılmaz. Açılışta belirsize dönen "sürüyor" kaydı da böyle doğrulanır.
    Cihazın menüsünden alınan gün sonu da böyle LafPOS'a işlenir. Belirsiz deneme cihazda karşılık bulamazsa
    "alınamadı" olur ve yeniden denenebilir. 5075 "Batch bulunamadı": cihazda kayıtlı gün sonu yok (belirsiz deneme
    de alınmamış sayılır).
- **Kör kasa**: son sonuç `GET /api/okc/status` › `pavo.eod`'da; kasa rakamlarını görmeyen (`kasa.rakam` ya da
  `rapor.gor` yok) durum, batch no ve işlem sayılarını görür, tutarları görmez (`amountsHidden`). Kullanıcısız durum
  (Genel bakış › Sistem sağlığı) tutar taşımaz.
- **Testler**: `tests/pavo.test.ts` (sahte cihaz `tests/fake-pavo.ts`: kartla alınan ödemeler açık batch'e girer;
  `eodMode` `ok`, `fail` 5085, `silent` gün sonu alınır ama yanıt gelmez, `drop` istek işlenmez ve yanıt gelmez;
  `eodDelayMs` yanıtı geciktirir; `menuEod` cihazın menüsünden gün sonu; `saleResultReply` sonuç sorgusunu isteğin
  reddiyle yanıtlar, ör. 73). Bekleme süreleri `pavoTiming.eodMs` ve `eodCopyMs` (taban ve doğrulama) ile kısalır;
  testler "satış yok" okumasını `failConfirmMs: 0` ile ilk okumada kesinleştirir (süreli hâlinin ayrı testi var).
  Testler yeni gün için bugün kapanan günleri geçmiş tarihe alır (bir iş gününe tek Z).

