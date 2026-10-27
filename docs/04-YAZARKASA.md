# Yazarkasa POS (ÖKC) bağlantısı

Mali fiş ÖKC'den (yazarkasa POS) kesilir. LafPOS adisyonu cihaza **sepet** olarak gönderir; ödeme ve mali fiş
cihazda alınır; sonuç (Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir.
Kod: `server/okc/` (markadan bağımsız akış `service.ts`, sepet hesabı `basket.ts`, sağlayıcılar `providers/`:
sözleşme `types.ts`, Token `tokenx.ts` + istemci `../tokenx.ts`, eğitim cihazı `index.ts`), uçlar
`server/routes/okc.ts`, ekranlar adisyondaki **Yazarkasa** bölümü, `/cihaz` (eğitim cihazı) ve
Yönetim › Yazarkasa POS. Testler: `tests/okc-basket.test.ts`, `tests/tokenx-client.test.ts`,
`tests/api-flow.test.ts`, `tests/okc-providers.test.ts`, `tests/audit-yazarkasa.test.ts` (27 Eki 2026 denetimi:
birleşen adisyonda fiş iptali, kapanmış güne ait iptal, yanıtı alınamayan gönderim, ödemesiz kapanan fiş, servis
ve KDV dökümü, açılışta sorgu, denetim kaydı).

## 1. Sağlayıcılar

| Ayar (`okcProvider`) | Ne olur |
|---|---|
| `kapali` | Yazarkasa düğmeleri görünmez; ödeme LafPOS'ta alınır, mali fiş ayrıca kesilir |
| `simulator` (eğitim cihazı) | Sepet `/cihaz` ekranına düşer; orada nakit/kart/yemek kartı seçilip "ödendi" denir. **Gerçek fiş kesilmez**; kurulum ve personel eğitimi içindir. İlk kurulum bununla gelir |
| `tokenx` | TokenX Connect (Cloud) üzerinden gerçek cihaz |

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
| **Pavo** (N86, N96, UN20, N6, CT20) | Yerel ağda IP REST (port 4567, cihazda "Eşleştir"), APP-TO-APP, bulut | Yalnız iş ortaklarına belge; VUK 507 cihazları e-Arşiv keser, kafenin e-Arşiv entegratör hesabı gerekir | IP REST / bulut API belgesi; entegratör parmak izimiz; iş ortaklığı sözleşmesi ve ücret; test cihazı; sonuç alanları (e-Arşiv ETTN/no, ödemeler); bölünmüş ödeme, iptal, iade; hangi model ÖKC, hangisi VUK 507 |
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
  (kalem bazlı ödeme).
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
  eklenebilir. Karaoke oda sayacı çalışırken hesap cihaza gönderilmez (`room_running`).
- **Paylaşımlı hesap:** hesap kişilere bölünmüş olsa da cihaza tek sepet gider, mali fiş tek kesilir; paylar
  cihazda ayrı ödemeler olarak alınır (kişi başı nakit ya da kart). Adisyondaki Yazarkasa bölümü pay tutarlarını
  sırayla gösterir. Kişiye ayrı fiş gerekiyorsa paylar yerine **Kalem** ile ödenir: her kişinin kalemleri ayrı
  sepet olur.

## 6. Sonuç

Token sonucu `fromTokenxSale` ile ortak sonuca çevrilir (`0` → `paid`, `99` → `voided`, `-1` → `cancelled`).

| Cihazdan gelen (Token) | LafPOS'ta |
|---|---|
| `sale.status = 0` | Ödeme kalemleri adisyona işlenir (1 nakit, 3 kart, 7 yemek kartı, 17 açık hesap, 18 havale; ödeme türü eşlemesi Yönetim › Yazarkasa'da), Z ve fiş no yazılır, kalan yoksa adisyon kapanır |
| `0`, ödemeler sepeti karşılamıyor | Cihaz ikram (9), ödemesiz (8) ya da LafPOS'ta karşılığı olmayan türle kapattıysa alınan ödemeler tutar olarak işlenir, kalemler ödenmiş sayılmaz; sepet `hata` olur ve yöneticiye alarm düşer (`okc.underpaid`). Kalan kasadan alınana ya da fiş cihazdan iptal edilene kadar adisyon cihaza yeniden gönderilmez (`okc_unresolved`): aynı kalemler ikinci fişe girerdi. LafPOS'a işlenemeyen "ödendi" sonucu da böyle |
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
