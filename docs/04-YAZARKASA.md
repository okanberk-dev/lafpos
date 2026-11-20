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
kurulan bilgisayarda bu dosya `C:\ProgramData\LafPOS\ayarlar.env`: Başlat › LafPOS › LafPOS ayarları açar,
kaydedip kapatınca sunucu yeniden başlar.

## 3. Kurulum adımları

1. `.env`'yi doldurun, LafPOS'u yeniden başlatın.
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
(`okc.underpaid`, `okc.apply_failed`, `okc.late_paid`). Aynı sonuç ikinci kez gelirse işlem ve kayıt tekrarlanmaz.
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
2. Kasa bilgisayarının ayarlarına (`.env` / `C:\ProgramData\LafPOS\ayarlar.env`):

   | Değişken | Ne |
   |---|---|
   | `PAVO_URL` | Cihazın adresi ve REST portu, ör. `https://192.168.1.50:4567`. Pavo'nun belgesi 4568 HTTPS, 4567 HTTP der; entegratörlerin kodu N86'da `https://…:4567` kullanır. "Bağlantıyı dene" hangisinin açık olduğunu söyler |
   | `PAVO_SERIAL` | Cihazın seri numarası (her istekte gider, cihaz kendi seri noyla karşılaştırır) |
   | `PAVO_FINGERPRINT` | İsteğe bağlı (varsayılan `LafPOS`); eşleştirmede cihaza kaydedilir, her istekte aynısı gider |

3. Yönetim › Yazarkasa POS: bağlantı **Pavo** (ödeme yeri kendiliğinden kasada ödeme), **Eşleştir** (cihazda onay
   ekranı açılır, kasiyer onaylar; LafPOS en çok 2 dk bekler), **Bağlantıyı dene** (cihaz yanıt veriyor mu, eşleştirme
   geçerli mi, cihazdaki ödeme araçları).
4. İlk satışı küçük tutarla deneyin: cihaz gerçek e-Arşiv belgesi keser. "Cihazın son yanıtları" (yönetim
   sayfasının altında) yanıtın alanlarını gösterir; tanınmayan biçim orada görünür.

Pavo bulut API anahtarı (PavoPay portalında üretilen, 64 karakterlik) bu bağlantıda kullanılmaz: bulut kanalı ayrıca
Pavo'nun entegratöre verdiği "App Token"ı ister (§8.4). Anahtar yalnız kafedeki ayar dosyasında durur, depoya girmez.

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
  toplamı LafPOS'un hesabıyla kuruşu kuruşuna aynıdır. Ödeme bilgisi gönderilmez: kasiyer cihazda seçer.
- **Bekleme**: cihaz aynı anda tek istek işler; satış ekranı açıkken (yanıt gelene dek) sepet LafPOS'ta "kilitli"
  görünür ve LafPOS cihaza başka istek göndermez. Cihaz ilk 6 sn içinde reddederse (KDV grubu, eşleştirme) kasiyer
  hatayı hemen görür, sepet hataya düşer, adisyon kilitli kalmaz.
- **Sonuç**: cihazın yanıtındaki satış kaydı (`Data` ya da `Data.Sale`): `AddedPayments` (`StatusId` 2 etkin;
  `PaymentTypeId` 1 nakit, 2 kart; `PaymentAmount` TL) ve `FinancialDocuments` (`InvoiceNo` belge no, `Type.Name`
  belge türü). Kasiyer vazgeçerse (`HasAbondon`) sepet kapanır, adisyon açık kalır. Hata dönen satışta belge kesilip
  kesilmediği bir kez `/GetSaleResult` ile sorulur. Yanıt gelmezse (sunucu yeniden başladı, bağlantı koptu) sonuç
  sipariş no ile `/GetSaleResult`'tan sorulur (en sık 5 sn'de bir).
- **İptal**: satış cihazın ekranındayken LafPOS'tan silinmez, cihazda vazgeçilir. Ekranda değilse LafPOS cihaza
  sorar: ödenmişse sonuç işlenir, ödenmemişse cihazda silinecek bir şey yoktur. Cihaza ulaşılamazsa yetkili onayıyla
  LafPOS'ta iptal sayılır (§7, `okc.force_cancel`). LafPOS cihaza iptal (`/CancelSale`) göndermez: belgenin
  anlamı belgesiz.

### 8.3 Temkin kuralları (para yolu tahminle kurulmaz)

- Satış kaydı tanınmayan **hatasız** yanıt ödendi sayılmaz; sonuç sorulur. Satış kaydı hiç gelmezse sepet bekler,
  kasiyer cihaza bakıp iptal eder.
- Anlamı belgelenmemiş ödeme tipi (1 ve 2 dışı: yemek kartı, havale...) tahminle bir türe yazılmaz: ödemesi
  LafPOS'a işlenmez, sepet eksik ödenmiş sayılır (`okc.underpaid` alarmı), kalemler yeniden gönderilmez; kalanı
  yönetici doğru türle kasadan alır.
- Belge kesilmişse (`InvoiceNo` ya da etkin ödeme var) hata dönen yanıt da ödendi sayılır (ör. yazıcı hatası).
- Cihazın ham yanıtı sepetin sonucunda (`fiscal_receipts.result.raw`) saklanır; ilk gerçek satıştan sonra alan
  adları buradan doğrulanır.

### 8.4 Kaynaklar ve Pavo'dan istenecekler

Pavo'nun belge sitesi (docs.pavopay.dev) projeye özel ve kapalı. Doğrulanan: REST bağlantı kuralları ve eşleştirme
(Pavo'nun REST sayfasının Ağustos 2026 kaydı); satış kaydının biçimi (Pavo'nun satış API'sinin yanıt modeli, bir
entegratörün açık kodu). Entegratör kodundan, belgesiz: `/CompleteSale` ve `/GetSaleResult` uç adları ve satış
gövdesi, `MainDocumentType: 1`, `KDV{oran}` grup kodu, N86'da port. Pavo'dan (info@pavo.com.tr, 0850 611 04 44)
istenecekler:

1. N86 / PavoPay (VUK 507) REST belgesine erişim (docs.pavopay.dev) ve hata kodları.
2. `/CompleteSale` ve `/GetSaleResult` yanıtının tam biçimi; `PaymentTypeId`, `MainDocumentType`, `TaxGroupCode` ve
   belge türü değerlerinin listesi.
3. Kesilmiş belgenin iptali ve iadesi (e-Arşiv iptali) ve LafPOS'a nasıl bildirildiği.
4. Bulut kanalı için App Token (kafenin PavoPay API anahtarıyla kullanılır) ve bulutta kalemli satışın seri no ile
   cihaza gönderilmesi.
5. Masada ödeme (cihazın açık hesap listesi) desteği.

