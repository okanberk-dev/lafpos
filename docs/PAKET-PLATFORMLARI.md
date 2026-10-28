# Paket platformları

Yemeksepeti, Getir Yemek, Trendyol Go (Uber Eats Türkiye de buradan) ve Migros Yemek siparişleri kasaya düşer.
Araştırma ve platform belgeleri: `calisma/arastirma/paket-platformlari/` (calisma-notlari dalı).

## Akış
1. Sipariş gelir (`platform_orders`, durum `bekliyor`). Her ekranın üstünde şerit; platformun kabul süresi geri
   sayılır (Getir 5 dk, Yemeksepeti ~15 dk, Migros 10 dk; Trendyol Go süre belirtmez). Süre dolunca platformda
   iptal olmuştur (`suresi_doldu`).
2. **Kabul** (`paket.yonet`): hazırlık süresi seçilir; POS adisyonu açılır (kurye ya da gel-al), kalemler platformun
   fiyatıyla, restoranın kampanyası adisyon indirimi olur. Platformun karşıladığı kampanya ciroyu düşürmez.
   Kalemler adla eşlenir; kasada karşılığı olmayan kalem gizli "Platform ürünü" satırı olur, adı notta.
   **Ret** nedeniyle; denetim kaydına yazılır.
3. Bar ve mutfak normal fişi alır; adisyonun adı "Yemeksepeti A7KX" gibi (kurye bu kodu söyler).
4. Tahsilat: platform tahsil ediyorsa (online ödenmiş ya da platform kuryesi kapıda alır) adisyon platform
   kuryesine verilince (Yolda) ya da teslimde (kendi kurye, gel-al) platformun **online** ödeme türüyle (kanal =
   platform, Z'de online) kapanır; kasada tahsil edilmez. Kendi kuryemiz kapıda alıyorsa ödeme kasada alınır; o
   siparişte platformun karşıladığı kampanya varsa platformun payı kabulde platformun ödeme türüyle yazılır, kasada
   yalnız müşterinin ödediği kalır.
5. Platform iptal ederse: açık adisyonun platform ödemesi geri alınır, adisyon iptal olur.

lafmaliyet'e platform siparişi POS satışı olarak gider (satış satırları, `payments[].channel` = platform; komisyon
lafmaliyet'te kanala göre hesaplanır). Sözleşme: `docs/03-ENTEGRASYON.md`.

## Modlar
- **Kapalı:** yeni sipariş alınmaz. Platformdan gelmiş, henüz kapanmamış sipariş platformla konuşmaya devam eder:
  kabul, ret ve teslim aşamaları platforma gider; onay bekleyen ya da adisyonu açık gerçek sipariş varken yoklama da
  sürer ki platformun iptali kasaya ulaşsın (o yoklamada yeni paket kayda girmez).
- **Deneme:** Yönetim › Paket platformları › "Deneme siparişi gönder" platformdan gelmiş gibi sipariş üretir
  (`server/delivery/simulator.ts`). Tarayıcı demosunda Yemeksepeti, Getir ve Trendyol Go deneme modunda açılır.
- **Canlı:** gerçek bağdaştırıcı (`server/delivery/adapter.ts` arayüzü, `registry.ts`) siparişi
  `PlatformOrderPayload`'a çevirir ve kabul / ret / aşama çağrılarını yapar; akış, ödeme ve kilit yukarıdaki gibi.
  Canlı yalnız bağdaştırıcısı olan ve anahtarı `.env`'de tanımlı platformda seçilebilir (yoksa 409 `not_supported` /
  `not_configured`); anahtarlar arayüzde ve depoda yazılmaz. Deneme siparişi (`simulated`) platforma hiç gitmez.
  - **Trendyol Go Yemek** (`server/delivery/trendyol.ts`; Uber Eats Türkiye siparişleri de buradan): yalnız yoklama,
    kasadan doğrudan, 20 saniyede bir (`server/delivery/live.ts` `liveTick`; art arda hatada bekleme 5 dakikaya
    kadar, ilk ve her 15. hata denetim kaydına). `.env`: `TRENDYOL_SUPPLIER_ID`, `TRENDYOL_API_KEY`,
    `TRENDYOL_API_SECRET`; test ortamı için `TRENDYOL_API_URL`, entegratör adı `TRENDYOL_AGENT_NAME` (boşsa LafPOS).
    Yeni paketler (`Created`) onay şeridine düşer; platformun iptali (`Cancelled`) bekleyen kaydı kapatır, kabul edilmiş
    adisyonu platform ödemesini geri alıp iptal eder (kasada alınmış ödeme varsa durur, alarm düşer).
    **Kabul ve ret önce platforma** (`picked` hazırlık süresiyle, `unsupplied` neden koduyla): platform reddederse
    502 `platform_unreachable`, yerelde yapılmaz; kasiyer yeniden dener ya da platform uygulamasından karar verir.
    Kabulden önce adisyon yerelde denenip geri alınır (gün açık, ürün tükenmemiş, porsiyon yetiyor): kasada
    açılamayacak sipariş platforma "kabul" diye gitmez. Platform kabul edip adisyon yine de açılamazsa (arada son
    porsiyon satıldı) kayıt `notified_status = picked` ile bekler: şeritte hata ve "Adisyonu aç" görünür, süre dolmaz,
    yeniden deneme platforma ikinci kez gitmez, patrona alarm (`platform.accept_failed`). Aynı siparişe iki ekrandan
    aynı anda karar verilmez (409 `busy`). Anahtar `.env`'den kaldırılmışsa gerçek siparişe yerelde karar verilmez
    (409 `platform_off`).
    Teslim aşamaları (`POST /orders/:id/delivery`) sırayla platforma yazılır: hazır → `invoiced`; kendi kuryemizde
    yolda → `manual-shipped`, teslim → `manual-delivered` (platform kuryesinde yolda ve teslimi platform yazar).
    Yazılamayan `platform_orders.notified_status` ve `last_error` ile kalır, sonraki turda yeniden denenir; ilk
    hata denetim kaydına uyarı. Platform kalıcı olarak reddederse (400, 404, 409, 410, 422) o siparişin aşamaları
    yeniden denenmez (`notify_parked_at`), patrona alarm: aşama platform uygulamasından işaretlenir; kasada iptal yine
    platforma gider. Aşama turu tek koşudur (20 sn'lik tur ile teslim olayı aynı anda isterse ikincisi bekler), son 48
    saatte kabul edilenlere bakar ve her kaydı işlemden hemen önce yeniden okur (tur ağ beklerken gelen platform iptali
    "kasada iptal" sanılmaz). Kabul ya da ret platforma giderken süre dolumu o kayda dokunmaz.
    **Kasada iptal edilen** kabul edilmiş sipariş platforma "tedarik edilemedi" (`unsupplied`) olarak gider ve kayıt
    kapanır; platform kabul etmezse alarm (`platform.cancel_unsynced`): sipariş platform uygulamasından iptal edilir.
    **Platformun iptali** kasada alınmış ödeme yüzünden uygulanamazsa (`cancel_pending_at`) alarm bir kez düşer,
    şeritte görünür; kasiyer ödemeyi geri alınca sonraki turda adisyon kendiliğinden iptal olur. Ödeme geri
    alınamıyorsa (kapanmış güne ait) iptal yetkisi olan kişi şeritten "iptali kayda al" der
    (`POST /api/platforms/orders/:id/cancel-close`): kayıt kapanır, para yerinde kalır, patrona alarm.
    İleri tarihli siparişin saati adisyona geçer (mutfak fişi ve sipariş şeridi) ve onay kartında görünür.
    Ağ hataları kasada Türkçe görünür ("bağlantı kurulamadı", "yanıt gelmedi"); çevrilemeyen paket ötekileri
    durdurmaz, atlanıp bir kez denetim kaydına düşer (`platform.package_invalid`). Yönetim'deki "açık sipariş"
    adisyonu açık kabul edilmiş siparişlerdir.
    Uç yolları, durum adları ve neden kodları `trendyol.ts`'in başındaki sabitlerde: canlıya geçmeden Trendyol'un test
    ortamında bir tur atılır (IP izni; `developers.tgoapps.com` bu depodan erişilemediği için alan adları araştırma
    notundan yazıldı), uyuşmayan ad yalnız orada değişir.
  - **Ürün eşleme** (Yönetim › Paket platformları › Ürün eşleme, `platform_products`): platformdan gelen her kalem
    (platform ürün kimliğiyle) listelenir; kasadaki ürüne bağlanan kalem adı değişse de doğru ürüne düşer,
    bağlanmayan ada göre eşlenir, kasada yoksa kabulde "Platform ürünü" satırı olur. Bağlanan ürün sonradan menüden
    gizlense de o ürün olarak açılır (ada göre eşlemede yalnız menüdeki ürünler). Uçlar `GET /api/platforms/products`,
    `PUT /api/platforms/products/:id { productId }` (menü ya da bağlantı yetkisi).
  - **Yemeksepeti** (Delivery Hero POS middleware; `server/delivery/yemeksepeti.ts`, aktarıcı `api/uzaktan.ts`):
    platform siparişi kasaya değil herkese açık bir adrese iter. LafPOS Uzaktan (Vercel) aktarıcıdır: Delivery Hero'nun
    JWT'sini (`service: middleware`, HS512/HS256) `YEMEKSEPETI_PLUGIN_SECRET` ile doğrular, siparişi Upstash Redis'teki
    gelen kutusuna koyar ve hemen `remoteOrderId` (sipariş belirteci) ile yanıtlar. Delivery Hero'ya verilecek adresler:
    sipariş `POST https://lafpos.vercel.app/api/yemeksepeti/order/{remoteId}`, durum bildirimi
    `PUT https://lafpos.vercel.app/api/yemeksepeti/remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`
    (iptal `ORDER_CANCELLED` gelen kutusundan kasaya gelir, adisyonu iptal eder). Kasa gelen kutusunu kafe anahtarıyla
    (`LAFPOS_CLOUD_SECRET`) imzalı olarak 20 saniyede bir çeker (en çok 50 kayıt ya da 2 MB); kayıtlar kasada
    yazıldıktan sonra silinir (kasa düşerse yeniden gelir, tekilleştirilir). Kayda alınmayan (Kapalı), kaydı düşen ve
    iptali ertelenen kayıt kutuda kalır. Kutu en çok 500 kayıt ve 2 gün tutar; doluysa kırpılmaz, Delivery Hero 503
    alır ve yeniden dener. Yalnız `ORDER_CANCELLED` durumu saklanır (ötekiler 200 ile geçilir), siparişlerden ayrı
    listede ve önce verilir: kasanın beklettiği siparişler iptalin önünü tıkamaz. Sipariş gövdesi en çok 256 KB,
    belirteç en çok 512 karakter. Başka restoranın kimliğiyle gelen kayıt atlanır ama bir kez alarm düşer (Kapalı'da
    kutuda kalır, Canlı'ya dönünce bildirilir).
    Kabul ve ret kasadan middleware'e gider (`POST /v2/login` jetonuyla, 401'de bir kez yeniden giriş), yalnız
    siparişin `callbackUrls` adreslerine ve yalnız adres middleware'in alan adındaysa (jeton başka sunucuya gitmez).
    Kabulde `order_accepted` + `remoteOrderId` + `acceptanceTime`: platformun saatine uyulur (gel-alda alma saati,
    kendi kuryemizde teslim saati, Yemeksepeti kuryesinde kuryenin alma saati), o saat yoksa ya da hazırlıktan
    erkense şimdi + hazırlık (kendi kuryemizde +20 dk). Retde `order_rejected` + neden kodu (`ITEM_UNAVAILABLE`,
    `TOO_BUSY`, `CLOSED`, kendi kuryemizde `OUTSIDE_DELIVERY_AREA`; test siparişinde `TEST_ORDER`). Kabul süresi
    platformun `expiryDate`'i (geçmişse sipariş süresi dolmuş gelir).
    **Dolaylı akış** (siparişte `orderAcceptedUrl` yok; Türkiye'de tabletli restoranlarda yaygın): sipariş tablette
    kabul edilmiş gelir. Kabul süresi işlemez, kasadaki Kabul platforma gitmeden adisyonu açar, ret ve iptal tabletten
    yapılır (kasadan 409 `pre_accepted`); adresi olmayan aşama gönderilmez. Sipariş (ileri tarihlide teslim) saatinden
    3 saat sonra kasaya alınmaz: kasa kapalıyken tablette kabul edilip teslim edilmiş sipariş yeniden hazırlanmasın.
    Aşamalar: Yemeksepeti kuryesinde yalnız hazır → `preparation-completed` (adres verildiyse); kendi kuryemizde ve
    gel-alda yolda → `order_picked_up` bir kez (adres verildiyse). Kasada iptal edilen kabul edilmiş sipariş
    Yemeksepeti'ne gönderilmez (kabulden sonraki neden kodları kurye ve teslim olaylarına özgü): alarm düşer, sipariş
    Yemeksepeti uygulamasından iptal edilir. Platformun test siparişi kabul edilmez (mutfağa düşmesin), yalnız
    reddedilir.
    Kurye: `expeditionType: pickup` gel-al; `riderPickupTime` doluysa Yemeksepeti kuryesi, boşsa kendi kuryemiz
    (adres ve telefon yalnız o zaman kasaya gelir). Ücretler (`deliveryFees`: teslimat, ambalaj…) adlarıyla ayrı satır
    olur (gizli "Platform ücreti" ürünü, KDV %20, istasyonsuz kategoride: bar ve mutfak ekranına düşmez; Ürün
    eşleme'den başka ürüne bağlanabilir); yalnız Yemeksepeti kuryesinin teslimat ücreti platformundur. Kendi kuryemizin
    kapıda alacağı `collectFromCustomer` (sıfırdan büyükse), yoksa `grandTotal`; ödenmemiş siparişte bu sıfır görünürse
    tamamı kasada istenir (platform payı sayılmaz). Yemeksepeti kuryesi kapıda nakit alıp kasaya `payRestaurant`
    bırakıyorsa o tutar kasada alınır, platform kendiliğinden kapatmaz. İndirimlerin restoran payı `VENDOR`
    sponsorluğu. İleri tarihli siparişin saati adisyona geçer ve platforma bildirilen saatle aynıdır (gel-alda alma,
    Yemeksepeti kuryesinde kuryenin alma, kendi kuryemizde teslim saati). Canlıya geçmeden Delivery Hero'nun test
    ortamında bir tur atılmalı (alanlar belgeden yazıldı).
    Kafede `.env`: `YEMEKSEPETI_MW_URL`, `YEMEKSEPETI_USERNAME`, `YEMEKSEPETI_PASSWORD`, `YEMEKSEPETI_REMOTE_ID` ve
    LafPOS Uzaktan'ın `LAFPOS_CLOUD_URL`, `LAFPOS_CLOUD_SECRET`'i. Vercel'de: `YEMEKSEPETI_PLUGIN_SECRET` (Delivery
    Hero'nun verdiği JWT anahtarı), isteğe bağlı `YEMEKSEPETI_REMOTE_ID` (başka restoranın siparişi 400). Kurulum
    durumu `GET /api/uzaktan/kurulum`'da `yemeksepeti: true|false` (değer asla).
  - **Getir Yemek** (GetirFood API; `server/delivery/getir.ts`, aktarıcı `api/uzaktan.ts` `getir/*`): Getir siparişi
    bizim verdiğimiz iki adrese iter; LafPOS Uzaktan (Vercel) aktarıcıdır. Getir'e verilecek adresler: yeni sipariş
    `POST https://lafpos.vercel.app/api/getir/order`, iptal `POST https://lafpos.vercel.app/api/getir/cancel`; ikisinde
    de başlıkta bizim ürettiğimiz anahtar (`x-api-key` = Vercel'deki `GETIR_WEBHOOK_SECRET`, en az 16 karakter, sabit
    zamanlı karşılaştırılır; yoksa aktarıcı 503). Kayıt Redis'teki gelen kutusuna girer (siparişler `lafpos:getir:inbox`,
    iptaller ayrı listede `lafpos:getir:status`, yalnız sipariş kimliği ve nedeniyle; önce iptaller verilir). Kutu,
    doluluk ve boyut kuralları Yemeksepeti'ninkiyle aynı (500 kayıt, 2 gün, dolu → 503, gövde 256 KB, kimlik 512
    karakter); kasa aynı imzalı uçlardan (`GET /api/getir/inbox`, `POST /api/getir/inbox/ack`) 20 saniyede bir çeker
    ve işlediğini siler. **Yedek yol:** kasa Getir'in onaysız (`POST /food-orders/periodic/unapproved`) ve iptal
    (`/periodic/cancelled`) listelerini de doğrudan okur, en sık dakikada bir (belge "sürekli sorgulanmamalı"),
    aktarıcı düşmüşse her turda; iki yoldan gelen aynı sipariş tekilleşir. Aktarıcı düşüp Getir çalışıyorsa yoklama
    başarılı sayılır, Yönetim'de "aktarıcı gelen kutusu alınamadı … doğrudan Getir'den alınıyor" uyarısı görünür;
    ikisi de düşerse yoklama hatası. Girişte Getir'in verdiği restoran kimliğiyle uyuşmayan sipariş atlanır, bir kez
    alarm düşer (Vercel'de isteğe bağlı `GETIR_RESTAURANT_ID` aynı siparişi 400 ile reddeder).
    Kimlik: `POST /auth/login` {appSecretKey, restaurantSecretKey} → jeton (1 saat; 55 dakikada yenilenir, 401'de bir
    kez yeniden giriş), her istekte `token` başlığı. **Kabul önce Getir'e:** `POST /food-orders/{id}/verify` (ileri
    tarihli onaysız sipariş, durum 325: `/verify-scheduled`); hazırlık süresi Getir'e sipariş başına gitmez (uç
    gövdesiz). Getir "zaten onaylı" (hata kodu 2) derse kasada yalnız adisyon açılır. **Ret ve kasada iptal** aynı
    yoldan: `GET /food-orders/{id}/cancel-options`'tan seçenek (kasadaki neden anahtar kelimeyle eşlenir, bulunamazsa
    "diğer", o da yoksa ilk), `POST /food-orders/{id}/cancel` {cancelReasonId, cancelNote}; Getir seçenek vermiyorsa
    (kurye yolda) kalıcı ret: kayıt kapanır, alarm düşer, sipariş Getir uygulamasından iptal edilir. Kabul süresi
    sipariş saatinden (`checkoutDate`, GMT) 5 dk; Getir 30 sn'de yanıt yoksa restoranı IVR ile arar, 5 dk'da
    restoranı kapatır.
    **Aşamalar** kurye türüne göre (belge "Order Flow"): hazır → `/prepare`; Getir kuryesinde (`deliveryType` 1) yolda
    → `/handover` (bağdaştırıcı `handover` bayrağı; teslimi Getir yazar), kendi kuryemizde (2) yolda Getir'e gitmez,
    teslim → `/deliver`. Getir akış çağrıları arasında **en az 1 dakika** ister: kabulden ya da bir önceki aşamadan 1
    dk geçmeden aşama gönderilmez, hata sayılmaz (425, sessiz), sonraki turda gider; kasa yeniden başlatılırsa önceki
    çağrının saati bilinmez ve beklenmez.
    Kurye ve ödeme: `deliveryType` 1 Getir kuryesi (adres ve telefon kasaya gelmez), 2 kendi kuryemiz (maskeli telefon
    ve adres gelir; gel-al Getir belgesinde yok). `paymentMethod` 1 MasterPass, 2 BKM Express, 15 MobilExpress, 16
    GetirMoney ve 19 Sodexo Online **online** sayılır (kasada tahsil edilmez); 3 Kredi / Banka Kartı dahil ötekiler
    kapıda (kendi kuryemizde kasada alınır; Getir kuryesinde platform tahsil eder). Ücret satırı yok: Getir kuryesinin
    ücretini Getir müşteriden kendisi alır. İndirim (`totalPrice` − `totalDiscountedPrice`) **kimin karşıladığını belge
    yazmaz:** restoran kampanyası sayılır (adisyon müşterinin ödediğini gösterir); Getir'in karşıladığı kampanya varsa
    fark hesap kesiminde görünür. Test siparişi bayrağı yok: Getir'in test ortamı (`GETIR_API_URL` test adresi) gerçek
    akışla denenir. Saatler GMT; saat dilimi yazılmamış değer UTC sayılır.
    **Belgeden emin olunmayanlar** (`getir.ts` başındaki sabitler ve yorumlar; canlıya geçmeden Getir'in test ortamında
    doğrulanır): girişin gövdesi (swagger JSON şema verir, açıklama "HTTP Basic Auth" der), hata gövdesindeki `code`
    alanı, `result: false` yanıtı, hangi ödeme türlerinin online olduğu, iptal seçeneği metinleri, `/periodic`
    uçlarının yanıt biçimi (dizi; `{data: [...]}` sarmalı da kabul edilir), ürün kimliği alanı (`product`, zincirde
    `chainProduct`), ileri tarihli siparişin Getir'ce kendiliğinden "hazırlanıyor"a (500) alınmasından sonra
    `/prepare`'in kabul edilip edilmediği.
    Kafede `.env`: `GETIR_APP_SECRET_KEY`, `GETIR_RESTAURANT_SECRET_KEY`, test ortamı için `GETIR_API_URL`
    (boşsa canlı `https://food-external-api-gateway.getirapi.com`) ve LafPOS Uzaktan'ın `LAFPOS_CLOUD_URL`,
    `LAFPOS_CLOUD_SECRET`'i. Vercel'de: `GETIR_WEBHOOK_SECRET` (bizim ürettiğimiz; Getir'e adreslerle birlikte verilir),
    isteğe bağlı `GETIR_RESTAURANT_ID`. Kurulum durumu `GET /api/uzaktan/kurulum`'da `getir: true|false` (değer asla).
  - **Sonraki:** Migros Yemek (belge herkese açık değil; görüşme gerekir).

## Uçlar
`GET /api/platforms` (ayarlar, siparişler, `live` canlı durum) · `PUT /api/platforms/:platform` · `POST /api/platforms/:platform/test-order` ·
`POST /api/platforms/orders/:id/accept|reject|platform-cancel|cancel-close` · teslim: `POST /api/orders/:id/delivery` ·
ürün eşleme: `GET /api/platforms/products`, `PUT /api/platforms/products/:id`.
