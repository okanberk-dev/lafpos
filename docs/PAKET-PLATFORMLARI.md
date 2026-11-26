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
3. Bar ve mutfak normal fişi alır; adisyonun adı "Yemeksepeti A7KX" gibi (kurye bu kodu söyler). Gel-al siparişi
   çağrı ekranında AsilPOS numarasıyla değil bu kodla ve platformun adıyla görünür (müşteri uygulamada kodu görür);
   Siparişler'de teslim aşamasına geçince düşer. Bar ekranının Hazır sekmesine gelmez: teslimi platformun akışında.
4. Tahsilat: platform tahsil ediyorsa (online ödenmiş ya da platform kuryesi kapıda alır) adisyon platform
   kuryesine verilince (Yolda) ya da teslimde (kendi kurye, gel-al) platformun **online** ödeme türüyle (kanal =
   platform, Z'de online) kapanır; kasada tahsil edilmez. Kendi kuryemiz kapıda alıyorsa ödeme kasada alınır; o
   siparişte platformun karşıladığı kampanya varsa platformun payı kabulde platformun ödeme türüyle yazılır, kasada
   yalnız müşterinin ödediği kalır.
5. Platform iptal ederse: açık adisyonun platform ödemesi geri alınır, adisyon iptal olur.

lafmaliyet'e platform siparişi POS satışı olarak gider (satış satırları, `payments[].channel` = platform; komisyon
lafmaliyet'te kanala göre hesaplanır). Sözleşme: `docs/03-ENTEGRASYON.md`.

**Açık iş (lafmaliyet komisyonu):** kanal yalnız platformun online ödeme türünde var. Tahsilatı kasada olan platform
siparişi (kendi kuryemizin kapıda aldığı ya da Yemeksepeti kuryesinin kapıda alıp kasaya `payRestaurant` bıraktığı)
nakit ya da kart türüyle kapanır, kanalı `null` kalır: o siparişin cirosu lafmaliyet'in platform komisyonuna girmez.
AsilPOS'ta doğru rakam Raporlar › Paket platformları'ndadır (siparişin kaynağına göre, aşağıda). Öneri: gün paketine
(`day`) yalnız ekleme olarak `platforms: [{ channel, orders, revenue }]` (kapanmış POS adisyonlarından
`orders.platform`'a göre, TL, iki ondalık; rapordaki ciroyla aynı kural). Önce `docs/03-ENTEGRASYON.md`'ye yazılır,
lafmaliyet'te ayrı PR ile Komisyon ekranı bu alanı tercih eder; o güne dek alan gönderilmez.

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
    `TRENDYOL_API_SECRET`, işlemi yapanın e-postası `TRENDYOL_EXECUTOR_EMAIL` (`x-executor-user`). Adres canlı
    `https://api.tgoapis.com` (IP izni gerekmez); test ortamı için `TRENDYOL_API_URL=https://stageapi.tgoapis.com`
    (IP izni yalnız testte). Yazılım bizim: `User-Agent: "<satıcı no> - SelfIntegration"` (`TRENDYOL_AGENT_NAME`,
    boşsa SelfIntegration). Paketler `packageStatuses` süzgeciyle çekilir (virgüllü çoklu durum).
    Yeni paketler (`Created`) onay şeridine düşer; platformun iptali (`Cancelled`) bekleyen kaydı kapatır, kabul edilmiş
    adisyonu platform ödemesini geri alıp iptal eder (kasada alınmış ödeme varsa durur, alarm düşer).
    **Kabul ve ret önce platforma** (`PUT …/packages/picked` `{ packageId, preparationTime }`; ret
    `PUT …/packages/unsupplied` `{ packageId, itemIdList, reasonId }`, birim kimlikleri `GET …/packages/{packageId}`'den,
    iptal edilmemiş bütün `packageItemId`'ler; neden kodları 621 ürün tükendi, 622 kapanmak üzereyiz, 623 çok yoğunuz ve
    diğer, kendi kuryemizde çok yoğunuz 624 ve adres dışı 626): platform reddederse
    502 `platform_unreachable`, yerelde yapılmaz; kasiyer yeniden dener ya da platform uygulamasından karar verir.
    Kabulden önce adisyon yerelde denenip geri alınır (gün açık, ürün tükenmemiş, porsiyon yetiyor): kasada
    açılamayacak sipariş platforma "kabul" diye gitmez. Platform kabul edip adisyon yine de açılamazsa (arada son
    porsiyon satıldı) kayıt `notified_status = picked` ile bekler: şeritte hata ve "Adisyonu aç" görünür, süre dolmaz,
    yeniden deneme platforma ikinci kez gitmez, patrona alarm (`platform.accept_failed`). Aynı siparişe iki ekrandan
    aynı anda karar verilmez (409 `busy`). Anahtar `.env`'den kaldırılmışsa gerçek siparişe yerelde karar verilmez
    (409 `platform_off`).
    Teslim aşamaları (`POST /orders/:id/delivery`) sırayla platforma yazılır: hazır → `PUT …/packages/invoiced`
    `{ packageId, actualDate }`; kendi kuryemizde yolda → `…/packages/{packageId}/manual-shipped`, teslim →
    `…/manual-delivered` (`{ actualDate }`; platform kuryesinde yolda ve teslimi platform yazar).
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
    Ödeme türü (`payment.paymentType`): belgede online `PAY_WITH_CARD` (`mealCard` doluysa "Online yemek kartı"),
    kapıda `PAY_WITH_ON_DELIVERY` ve türü `onDelivery`'de (CASH nakit, CARD kart, SODEXO / MULTINET / EDENRED /
    SETCARD / METROPOL / TOKENFLEX / PAYEKART / IWALLET adıyla): kapıda ödeme online sayılmaz, kendi kuryemizde kasada
    tahsil edilir. Eski adlar (nakit, yemek kartı, "kapıda") da kapıda; tanınan online türler
    (`TRENDYOL_ONLINE_PAYMENTS`) online. Tanınmayan tür online sayılır (tahsilat
    davranışı değişmez) ama kendi kuryemizin siparişinde işaretlenir: "Ödeme türü tanınmadı (X): tahsilatı Trendyol'dan
    doğrulayın", otomatik kabul edilmez.
    Ağ hataları kasada Türkçe görünür ("bağlantı kurulamadı", "yanıt gelmedi"); çevrilemeyen paket ötekileri
    durdurmaz, atlanıp bir kez denetim kaydına düşer (`platform.package_invalid`). Yönetim'deki "açık sipariş"
    adisyonu açık kabul edilmiş siparişlerdir.
    Fiyat: satırın `price`'ı seçenekleri içerir (belgedeki örneklerde `totalPrice` = Σ `price` × birim);
    `modifierProducts[].price` eklenmez, adet iptal edilmemiş birim (`items`) sayısıdır. Kampanyalar satırda, birimde
    (`items[].promotions`, `coupon`) ve pakette (`promotions`, `coupon`). Adreste "TGO Yemek" dolgusu yazılmaz (model 1'de
    apartman, kat, kapı; model 2'de bütün alanlar). Panelden gelen test paketi (`testPackage`) notta "Test siparişi"
    ile işaretli, otomatik kabul edilmez; `userInformation.appName = Galaxy` GetirYemek by Uber Eats siparişidir, notta
    "Getir (Uber) siparişi". Uber Eats geçişi (5 karakterli kod, `pinCode`) şimdilik yalnız Bilecik mağazalarında.
    Uç yolları, durum adları ve neden kodları `trendyol.ts`'in başındaki sabitlerde; resmi belgeye (developers.tgoapps.com,
    22 Kasım 2026) göre yazıldı (#74). Canlıya geçmeden test ortamında (IP izniyle) ya da panelden test siparişiyle bir tur
    atılır.
  - **Ürün eşleme** (Yönetim › Paket platformları › Ürün eşleme, `platform_products`): platformdan gelen her kalem
    (platform ürün kimliğiyle) listelenir; kasadaki ürüne bağlanan kalem adı değişse de doğru ürüne düşer,
    bağlanmayan ada göre eşlenir, kasada yoksa kabulde "Platform ürünü" satırı olur. Bağlanan ürün sonradan menüden
    gizlense de o ürün olarak açılır (ada göre eşlemede yalnız menüdeki ürünler). Uçlar `GET /api/platforms/products`,
    `PUT /api/platforms/products/:id { productId }` (menü ya da bağlantı yetkisi).
  - **Yemeksepeti** (Delivery Hero POS middleware; `server/delivery/yemeksepeti.ts`, aktarıcı `api/uzaktan.ts`):
    platform siparişi kasaya değil herkese açık bir adrese iter. AsilPOS Uzaktan (Vercel) aktarıcıdır: Delivery Hero'nun
    JWT'sini (`service: middleware`, HS512/HS256) `YEMEKSEPETI_PLUGIN_SECRET` ile doğrular, siparişi Upstash Redis'teki
    gelen kutusuna koyar ve hemen `remoteOrderId` (sipariş belirteci) ile yanıtlar. Delivery Hero'ya verilecek adresler:
    sipariş `POST https://lafpos.vercel.app/api/yemeksepeti/order/{remoteId}`, durum bildirimi
    `PUT https://lafpos.vercel.app/api/yemeksepeti/remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`
    (iptal `ORDER_CANCELLED` gelen kutusundan kasaya gelir, adisyonu iptal eder). Kasa gelen kutusunu kafe anahtarıyla
    (`ASILPOS_CLOUD_SECRET`) imzalı olarak 20 saniyede bir çeker (en çok 50 kayıt ya da 2 MB); kayıtlar kasada
    yazıldıktan sonra silinir (kasa düşerse yeniden gelir, tekilleştirilir). Kayda alınmayan (Kapalı), kaydı düşen ve
    iptali ertelenen kayıt kutuda kalır. Kutu en çok 500 kayıt ve 2 gün tutar; doluysa kırpılmaz, Delivery Hero 503
    alır ve yeniden dener. Yalnız `ORDER_CANCELLED` durumu saklanır (ötekiler 200 ile geçilir), siparişlerden ayrı
    listede ve önce verilir: kasanın beklettiği siparişler iptalin önünü tıkamaz. Sipariş gövdesi en çok 256 KB,
    belirteç en çok 512 karakter. **Kutu restorana (şubeye) ayrılır:** `remoteId` Vercel'de tanımlıysa kayıt o
    restoranın kendi listelerine girer (`lafpos:ys:inbox:r:<kimliğin özeti>`, `…:status:r:…`), kasa imzalı sorguda kendi
    kimliğini verir (`?restoran=<YEMEKSEPETI_REMOTE_ID>`) ve yalnız onları çeker ve siler: bir şubenin kasası öbürünün
    siparişine dokunamaz, komut sayısı ortak kutuyla aynı. Vercel'de hiçbir kimlik yoksa ortak liste (`lafpos:ys:inbox`,
    `lafpos:ys:status`) kullanılır; sorgusuz eski kasa ortak listeyle birlikte bütün restoranlarınkini görür (güncellenene
    dek sipariş kaçmasın). Ortak kutuda başka restoranın kimliğiyle gelen kayıt atlanır ve **silinmez** (o restoranın
    kasası alır), bir kez alarm düşer. Kimliği platform canlıya geçmeden Vercel'e girin: sonradan girilirse ortak
    listede kalmış kayıt (en çok 2 gün) güncel kasaya gelmez.
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
    tamamı kasada istenir (platform payı sayılmaz). `grandTotal` (Yemeksepeti kuryesinin teslimat ücreti ve kuryenin
    bahşişi `riderTip` düşülünce) kalemleri aşarsa fark adisyona girmez ve tutar Yemeksepeti'nden doğrulanır; ödenmiş
    siparişte `grandTotal` hiç gelmezse de (otomatik kabul edilmez). Yemeksepeti kuryesi kapıda nakit alıp kasaya `payRestaurant`
    bırakıyorsa o tutar kasada alınır, platform kendiliğinden kapatmaz. İndirimlerin restoran payı `VENDOR`
    sponsorluğu. İleri tarihli siparişin saati adisyona geçer ve platforma bildirilen saatle aynıdır (gel-alda alma,
    Yemeksepeti kuryesinde kuryenin alma, kendi kuryemizde teslim saati). Canlıya geçmeden Delivery Hero'nun test
    ortamında bir tur atılmalı (alanlar belgeden yazıldı).
    Kafede `.env`: `YEMEKSEPETI_MW_URL`, `YEMEKSEPETI_USERNAME`, `YEMEKSEPETI_PASSWORD`, `YEMEKSEPETI_REMOTE_ID` ve
    AsilPOS Uzaktan'ın `ASILPOS_CLOUD_URL`, `ASILPOS_CLOUD_SECRET`'i. Vercel'de: `YEMEKSEPETI_PLUGIN_SECRET` (Delivery
    Hero'nun verdiği JWT anahtarı), isteğe bağlı `YEMEKSEPETI_<ŞUBE>_REMOTE_ID` (aktarıcı bunların hepsini ve eski
    öneksiz `YEMEKSEPETI_REMOTE_ID`'yi kabul eder, her birinin kendi gelen kutusu olur, başka restoranın siparişi 400;
    hiçbiri yoksa süzgeç yok, kutu ortak). Kurulum durumu `GET /api/uzaktan/kurulum`'da `yemeksepeti: true|false`
    (değer asla).
  - **Getir Yemek** (GetirFood API; `server/delivery/getir.ts`, aktarıcı `api/uzaktan.ts` `getir/*`): Getir siparişi
    bizim verdiğimiz iki adrese iter; AsilPOS Uzaktan (Vercel) aktarıcıdır. Getir'e verilecek adresler: yeni sipariş
    `POST https://lafpos.vercel.app/api/getir/order`, iptal `POST https://lafpos.vercel.app/api/getir/cancel`; ikisinde
    de başlıkta bizim ürettiğimiz anahtar (`x-api-key` = Vercel'deki `GETIR_WEBHOOK_SECRET`, en az 16 karakter, sabit
    zamanlı karşılaştırılır; yoksa ya da `ASILPOS_CLOUD_SECRET`'e veya `YEMEKSEPETI_PLUGIN_SECRET`'e eşitse aktarıcı
    503: üçüncü tarafa verilen değer gelen kutularını okuyan, özeti ezen anahtar olamaz; ayrı üretin, ör.
    `openssl rand -hex 24`). Kayıt Redis'teki gelen kutusuna girer (siparişler `lafpos:getir:inbox`, iptaller ayrı
    listede `lafpos:getir:status`, yalnız sipariş kimliği, nedeni ve restoran kimliğiyle, serbest metin not saklanmaz;
    önce iptaller verilir). Kutu Yemeksepeti'ndeki gibi restorana ayrılır: `restaurant.id` Vercel'de tanımlıysa
    (`GETIR_<ŞUBE>_RESTAURANT_ID` ya da eski öneksiz `GETIR_RESTAURANT_ID`) kayıt o restoranın kendi listelerine
    (`lafpos:getir:inbox:r:<kimliğin özeti>`, `…:status:r:…`) girer; kasa girişte öğrendiği restoran kimliğini imzalı
    sorguda verir (`?restoran=`) ve yalnız onları çeker ve siler. Kimlik kasada da saklanır (`sync_state`
    `platform.getir.restaurant`): yeniden başlayıp Getir'e giremeyen kasa da yalnız kendi kutusunu ister. Hiç giriş
    olmamışsa (ilk kurulum) sorgusuz ister, aktarıcı bütün kutuları verir; girişe dek kayıtlar bekletilir, restoranı
    belli iptal uygulanır ama silinmez. Sipariş kaydı yalnız kasanın okuduğu alanlarla saklanır: müşteri ve kurye
    konumu ile kurye hiç, Getir kuryesinde müşterinin telefonu ve adresi de saklanmaz; kendi kuryemizde tek telefon
    (kasanın kullandığı: iletişim ya da maskeli numara, maskesiz numara yalnız ikisi yoksa). Kutu, doluluk ve boyut kuralları Yemeksepeti'ninkiyle
    aynı (500 kayıt, dolu → 503, gövde 256 KB, kimlik 512 karakter); ayrıca kayıt 1 gün sonra verilmez ve silinir
    (itmede ve çekimde), liste 1 gün etkinliksiz kalınca düşer: itme ve çekim olmasa da hiçbir kayıt 2 günden uzun
    kalmaz. Kasa aynı imzalı uçlardan (`GET /api/getir/inbox`, `POST /api/getir/inbox/ack`) 20 saniyede bir çeker ve
    işlediğini siler. Kasa yeniden başlayınca restoran kimliği girişte öğrenilene dek aktarıcının sipariş kaydı (ve
    aynı siparişin iptal kaydı) alınmaz, gelen kutusunda kalır; giriş olmayan turda Getir'in listeleri de okunmaz.
    Bu durum yoklama hatası sayılmaz (iptaller işlenir, bekleme uzamaz) ama siparişin kasaya ulaşmadığı ilk turda
    denetim kaydına uyarı (`platform.poll_failed`), sürerse 15 turda bir (≈5 dk, Getir'in restoranı kapatma süresi)
    alarm düşer: siparişi Getir uygulamasından yönetin.
    **Yedek yol:** kasa Getir'in onaysız (`POST /food-orders/periodic/unapproved`), iptal (`/periodic/cancelled`) ve
    onaylı (`POST /food-orders/active`) listelerini de doğrudan okur, en sık dakikada bir (belge "sürekli
    sorgulanmamalı"; `/periodic` uçları hız sınırı dışında, `/active` jeton başına dakikada 300 isteğe sayılır),
    aktarıcı düşmüşse her turda; iki yoldan gelen aynı sipariş tekilleşir. Listeler ayrı ayrı okunur: iptal ya da
    onaylı listesinin hatası onaysız siparişleri düşürmez, uyarı olur. Aktarıcı düşüp Getir çalışıyorsa yoklama
    başarılı sayılır, Yönetim'de "aktarıcı gelen kutusu alınamadı … doğrudan Getir'den alınıyor" uyarısı görünür;
    aktarıcı ve onaysız liste birlikte düşerse yoklama hatası. Girişte Getir'in verdiği restoran kimliğiyle uyuşmayan
    sipariş atlanır ve gelen kutusundan silinmez (iptali de; o restoranın kasası alır), bir kez alarm düşer (Vercel'de
    isteğe bağlı `GETIR_<ŞUBE>_RESTAURANT_ID` tanımlıysa tanımsız restoranın siparişi 400 ile reddedilir).
    **Getir panelinden onaylanan sipariş** (belge "Time Limit for Order Confirmation": kabul Getir'e ulaşmadı ya da
    yanıtı kayboldu, personel Getir panelinden onayladı): onaylı listede görünür (350 ve üstü, 400 değil, teslim
    edilmemiş, iptal belirtisi yok: yanıt şemasında iptal nedeni ve notu); kasada onay bekleyen ya da süresi
    dolmuş kayıt "platformda kabul edildi" olur (süre işlemez, Kabul yalnız adisyonu açar, patrona bir kez alarm),
    kasanın hiç görmediği sipariş tabletten kabul edilmiş gibi gelir (Kabul adisyonu açar; ret ve iptal Getir'den).
    Kimlik: `POST /auth/login` {appSecretKey, restaurantSecretKey} → jeton (1 saat; 55 dakikada yenilenir, 401'de bir
    kez yeniden giriş; aynı anda tek giriş), her istekte `token` başlığı. Giriş hatası siparişe ait değildir, hiçbir
    zaman kalıcı sayılmaz (aşama park edilmez, kasadaki iptal kapanmaz; anahtar düzelince gider). **Kabul önce
    Getir'e:** `POST /food-orders/{id}/verify` (ileri tarihli onaysız sipariş, durum 325: `/verify-scheduled`; o
    arada etkinleşmişse 3 döner ve `/verify` denenir); hazırlık süresi Getir'e sipariş başına gitmez (uç gövdesiz).
    Getir "zaten onaylı" (hata kodu 2) derse elle Kabul'de kasada yalnız adisyon açılır; otomatik kabulde adisyon
    açılmaz, sipariş "platformun panelinden kabul edildi" olarak elle kalır ("Otomatik kabul"). `result: false` ya da nesne olmayan gövde
    (vekil sunucunun sayfası) hiçbir uçta başarı sayılmaz. **Ret ve kasada iptal** aynı yoldan:
    `GET /food-orders/{id}/cancel-options`'tan seçenek (kasadaki neden anahtar kelimeyle eşlenir, bulunamazsa
    "diğer", o da yoksa ilk; sipariş başına 5 dk saklanır: uç 10 dk'da 40 istekle sınırlı), `POST
    /food-orders/{id}/cancel` {cancelReasonId, cancelNote}; Getir seçenek vermiyorsa (kurye yolda) kalıcı ret: kayıt
    kapanır, alarm düşer, sipariş Getir uygulamasından iptal edilir. Kabul süresi sipariş saatinden (`checkoutDate`,
    GMT) 5 dk; etkinleşmiş (400) ileri tarihli siparişte kasaya geliş anından. Getir 30 sn'de yanıt yoksa restoranı IVR
    ile arar, 5 dk'da restoranı kapatır.
    **İleri tarihli:** push gövdesinde saat (`scheduledDate`) yok: `GET /food-orders/{id}`'den alınır, alınamazsa
    sipariş yine gelir ve notunda "İLERİ TARİHLİ: saat Getir panelinde" yazar. Kasada `/verify-scheduled` ile kabul
    edilmiş sipariş etkinleşince onaysız listede 400 olarak yeniden görünürse kasa `/verify`'ı kendisi gönderir
    (gidemezse bir kez alarm, sonraki yoklamada yeniden): sipariş başına bir kez (5 dk içinde yeniden 400 görünse de
    gitmez; Getir "zaten onaylı" derse aralık yeniden başlamaz, denetim kaydı yazılmaz). Getir tabletinden onaylanıp
    kasada onay bekleyen sipariş de yeniden onaylanır; adisyonu kasada iptal edilmiş sipariş onaylanmaz. Kapalı'da
    kasada kaydı olan siparişin yeniden itmesi gelen kutusundan silinir (her turda yeniden işlenmez). Push'ta saati
    gelmeyen ileri tarihli siparişin saati okunamazsa kayıt bir dakikaya dek bekletilir (yedek liste ya da sonraki tur
    saati getirsin), sonra notlu alınır; saat sonradan gelirse onay bekleyen kaydın saati ve notu tamamlanır.
    **Aşamalar** kurye türüne göre (belge "Order Flow"): hazır → `/prepare`; Getir kuryesinde (`deliveryType` 1) yolda
    → `/handover` (bağdaştırıcı `handover` bayrağı; teslimi Getir yazar), kendi kuryemizde (2) yolda Getir'e gitmez,
    teslim → `/deliver`. Getir verify, prepare ve deliver arasında **en az 1 dakika** ister (handover bu kurala bağlı
    değil, kurye beklemez): kabulden ya da bir önceki aşamadan 1 dk geçmeden aşama gönderilmez, hata sayılmaz (425,
    sessiz), sonraki turda gider. Aralık tekdüze saatle tutulur (Windows saati geri alsa da en çok 1 dk); kasa yeniden
    başlatılınca önceki çağrının saati bilinmez, açılıştan 1 dk beklenir. **Hata sınıfları:** Getir'in bütün hizmet
    hataları HTTP 400'dür; 4 (kilit), 14 (kurye durumu), 15 (kurye henüz restorana ulaşmadı) ve 79 (ileri tarihli
    henüz etkinleşmedi) geçicidir (bir kez uyarı, sonraki turda yeniden); 74 ve 62 (süre sınırları) ilk gelişte bir
    aralık beklenip bir kez daha denenir, yine gelirse kalıcı. 3 (durum geçersiz) gelirse Getir'deki durum
    `GET /food-orders/{id}`'den okunur: aşama geçilmişse (`prepareDate` / `handoverDate` / `deliverDate` ya da durum
    eşiği) başarı sayılır ve sonraki aşama gider (yanıtı kaybolan denememiz uygulanmış, kurye siparişi uygulamasından
    almış, ileri tarihli sipariş Getir'ce 500'e alınmış); etkinleşmemiş ya da yeniden onay bekleyen ileri tarihli
    siparişte (325, 350, 400) hazır bir aralık sonra yeniden denenir; iptal edilmiş ya da geride kalan durum kalıcı.
    Durum okunamazsa önceki denemenin yanıtı kaybolduysa (ağ, 5xx) uygulanmış, değilse geçici sayılır. Öteki kodlar
    kalıcı ret (aşama park edilir, alarm). Geçici hata sürerse patrona bir kez alarm düşer (aşamada 10 dk, kasadaki
    iptalde 5 dk; yeniden deneme sürer): durum zamanla düzelmiyor olabilir.
    Kurye ve ödeme: `deliveryType` 1 Getir kuryesi (adres ve telefon kasaya gelmez), 2 kendi kuryemiz (maskeli telefon
    ve adres gelir; gel-al Getir belgesinde yok). `paymentMethod` 1 MasterPass, 2 BKM Express, 15 MobilExpress, 16
    GetirMoney ve 19 Sodexo Online **online** sayılır (kasada tahsil edilmez); 3 Kredi / Banka Kartı dahil ötekiler
    kapıda (kendi kuryemizde kasada alınır; Getir kuryesinde platform tahsil eder); Getir'in metninde "online" ya da
    "kapıda" kelimesi geçiyorsa (başta ya da içeride: "Kredi Kartı (Online)") karar ona uyar ve etiket kararla hiç
    çelişmez; tür kodu bilinmiyorsa, metin iki kelimeyi birden taşıyorsa ya da bilinen kodun yönüyle çelişiyorsa
    etiket "Getir'den doğrulayın" der ve Yönetim uyarır. Ücret satırı yok: Getir kuryesinin ücretini Getir müşteriden
    kendisi alır. İndirim Getir'in kendi alanlarından okunur (`totalPrice` − `totalDiscountedPrice`, satır indirimi;
    büyük olan) ve **kimin karşıladığını belge yazmaz:** restoran kampanyası sayılır; Getir'in karşıladığı kampanya
    varsa fark hesap kesiminde görünür. İndirimli değer yalnız 0 < değer < taban ise indirimdir (indirim yokken 0
    gelebilir). Getir'in toplamı ile kalemler arasındaki açıklanamayan fark indirimden ayrı tutulur: toplam kalemleri
    aşarsa fark adisyona ve platform alacağına girmez (uydurma ücret satırı yok), notta Getir'in toplamı, indirimli
    toplamı ve kalemler, kendi kuryemizin kapıda nakit siparişinde müşterinin ödeyeceği yazar ("farkı Getir'den
    doğrulayın"); müşterinin ödediği indirimin açıklayamayacağı kadar düşükse fark restoran indirimi sayılır (adisyon
    ödenenin üstünde kalmaz, platform payı uydurulmaz), notta görünür. Aynı sipariş push'tan da yedek listeden de aynı
    tutarla gelir. Ürün kimliği yoksa kalem ada göre eşlenir (satır kimliği her siparişte yenidir,
    eşleme anahtarı olmaz). Sayısal metin ("150") sayı gibi okunur. Test siparişi bayrağı yok: Getir'in test ortamı (`GETIR_API_URL` test adresi) gerçek
    akışla denenir. Saatler GMT; saat dilimi yazılmamış değer UTC sayılır.
    **Belgeden emin olunmayanlar** (`getir.ts` başındaki yorum; güvenli taraf seçildi, canlıya geçmeden Getir'in test
    ortamında bir turla doğrulanır): girişin gövdesi (swagger JSON şema verir, açıklama "HTTP Basic Auth" der), hata
    gövdesindeki `code` alanı, 74 ve 62'nin anlamı (1 dk kuralı mı süre aşımı mı), `result: false` yanıtı, hangi ödeme
    türlerinin online olduğu, iptal seçeneği metinleri, `/periodic` ve `/active` uçlarının yanıt biçimi (dizi;
    `{data: [...]}` sarmalı da kabul edilir) ve `/active`'teki durum kodları, ürün kimliği alanı (`product`, zincirde
    `chainProduct`), indirimsiz siparişte indirim alanlarının değeri, kalemleri aşan Getir toplamının ne olduğu
    (kendi kuryemiz, kapıda nakit siparişte `totalPrice` ile kalemlerin toplamı karşılaştırılır), ileri tarihli
    siparişin akışı (325 → `/verify-scheduled` → etkinleşince 400 olarak yeniden `/verify` istiyor mu, 400'ün 5
    dakikası neye göre işliyor), yinelenen ya da geçilmiş aşamaya Getir'in 3 dönmesi ve aşamanın geçildiğini gösteren
    durum eşikleri (`GETIR_PASSED_STATUS`: hazır 500, belgede "hazırlanıyor"; kuryeye verildi 600, teslim 900 ve iptal
    1500 belgede yok; önce swagger'daki aşama tarihlerine bakılır). Kalıcı reddedilip park edilen aşamayı kasadan
    yeniden denetecek bir uç yok (ayrı iş): alarm personele aşamayı Getir uygulamasından işaretlemesini söyler.
    Kafede `.env`: `GETIR_APP_SECRET_KEY`, `GETIR_RESTAURANT_SECRET_KEY`, test ortamı için `GETIR_API_URL`
    (boşsa canlı `https://food-external-api-gateway.getirapi.com`) ve AsilPOS Uzaktan'ın `ASILPOS_CLOUD_URL`,
    `ASILPOS_CLOUD_SECRET`'i. Vercel'de: `GETIR_WEBHOOK_SECRET` (bizim ürettiğimiz; Getir'e adreslerle birlikte verilir),
    isteğe bağlı her şubenin `GETIR_<ŞUBE>_RESTAURANT_ID`'si (Getir'in restoran kimliği; Marina için
    `GETIR_MARINA_RESTAURANT_ID`, eski öneksiz `GETIR_RESTAURANT_ID` de sayılır; her birinin kendi gelen kutusu olur,
    hiçbiri yoksa kutu ortak). Kurulum durumu `GET /api/uzaktan/kurulum`'da `getir: true|false` (değer asla).
  - **Sonraki:** Migros Yemek (belge herkese açık değil; görüşme gerekir).

## Anahtarlar buluttan

Anahtarlar **şubeye göre** durur: Vercel'de her değerin adı `<PLATFORM>_<ŞUBE>_<ALAN>`; kasa yalnız kendi şubesininkileri
alır. ŞUBE, kasanın **Şube kimliği**nden gelir (Yönetim › Ayarlar ve yedek › Kasa ve gün › Şube kimliği; lafmaliyet'teki
şube kimliği, ilk kasada `marina`). Kural: büyük harf, Türkçe harf İngilizce karşılığına (ç→C, ğ→G, ı→I, ö→O, ş→S, ü→U),
harf ve rakam dışındaki her şey (tire de) atılır: `marina` → `MARINA`, `tuzla` → `TUZLA`, `tuzla-2` → `TUZLA2`.
Merkez'deki **Şube kodu** (`TZL` gibi, fişin başlığındaki) başka bir şeydir, Vercel adında kullanılmaz. Kasa hangi adı
beklediğini Yönetim › Bağlantı bilgileri'nde platform kartında yazar ("Şube: TUZLA · Vercel'de TRENDYOL_TUZLA_… adıyla").
Kasada Bağlantı bilgilerine platform anahtarı girmek gerekmez.

Sahibin adımları, Tuzla AsilPOS'a geçince (Marina'da Trendyol yok):

1. Tuzla kasasında Yönetim › Ayarlar ve yedek › Kasa ve gün › **Şube kimliği** = `tuzla` (yalnız patron değiştirir),
   Kaydet. Şube değişince kasa eski şubenin anahtarlarını hemen bırakır ve yenisininkileri ister.
2. Trendyol satıcı paneli › Hesap Bilgileri › Entegrasyon Bilgileri: satıcı no, API Key, API Secret.
3. Vercel › `lafpos` projesi › Settings › Environment Variables, ortam **Production**, gizliler **Sensitive**:
   `TRENDYOL_TUZLA_SUPPLIER_ID` (satıcı no; o olmadan Trendyol tanımlı sayılmaz), `TRENDYOL_TUZLA_API_KEY`,
   `TRENDYOL_TUZLA_API_SECRET`, `TRENDYOL_TUZLA_EXECUTOR_EMAIL` (panelde işlemi yapan kullanıcının e-postası). Satıcı no
   ve e-posta Vercel'de öneksiz adla (`TRENDYOL_SUPPLIER_ID`, `TRENDYOL_EXECUTOR_EMAIL`) zaten var: aynı değerleri şube
   adıyla yeniden girin; eksik olan API Key ve API Secret. Yemeksepeti bilgileri gelince, şubesinin adıyla (Marina için):
   `YEMEKSEPETI_MARINA_MW_URL`, `YEMEKSEPETI_MARINA_USERNAME`, `YEMEKSEPETI_MARINA_PASSWORD`,
   `YEMEKSEPETI_MARINA_REMOTE_ID`. Sonra Deployments › son yayın › Redeploy (ortam yayınla geçer).
4. Öneksiz girilmiş eski değerleri (`TRENDYOL_SUPPLIER_ID`, `TRENDYOL_API_KEY`, `TRENDYOL_API_SECRET`,
   `TRENDYOL_EXECUTOR_EMAIL`, `YEMEKSEPETI_MW_URL`, `YEMEKSEPETI_USERNAME`, `YEMEKSEPETI_PASSWORD`,
   `YEMEKSEPETI_REMOTE_ID`) şube adıyla girdikten sonra silin: #86'dan beri **hiçbir kasaya gitmezler**, bir şubenin
   anahtarı yanlışlıkla öbürüne gitmesin diye. (Aktarıcının `YEMEKSEPETI_PLUGIN_SECRET`'i şubesiz kalır.)
5. O şubenin kasası en geç 10 dakika içinde çeker; platform kartı "Kaynak: bulut · son çekim SS:DD" der. Son çekim
   başarılıysa ve şubede değer yoksa "Bu şubede tanımlı değil"; hiç çekilmediyse, çekim olmadıysa ya da AsilPOS Uzaktan
   kurulu değilse nedenini yazar. Platform Kapalı kalır: Yönetim › Paket platformları'ndan açmak sahibin kararı.

Şubesini göndermeyen (eski) ya da şube kimliği geçersiz kasa hiçbir platform anahtarı almaz.

Nasıl çalışır: kasa `GET /api/uzaktan/anahtarlar?sube=<Şube kimliği>`'ni kafe anahtarıyla (`ASILPOS_CLOUD_SECRET`, gelen
kutusu uçlarıyla aynı imza; sorgu da imzanın içinde) açılışta, 10 dakikada bir ve şube kimliği değişince hemen çeker.
Uç yalnız Vercel ortamını okur, Redis'e dokunmaz; yanlış imzada 401, her yanıtta `cache-control: no-store`. Bulutta
dolu olan değer kasadaki yerel değeri ezer, bulutta boşsa (ya da yalnız boşluksa) yerel kalır. Değer değişince kasa veri
klasöründeki `platform-anahtarlari.json`'a (yalnız sahibine okunur) hangi şube için çekildiğiyle birlikte yazar,
bağdaştırıcıyı yeniden başlatmadan kurar ve denetim kaydına değersiz bir satır düşer ("Trendyol anahtarları buluttan
güncellendi"). Dosyadaki değerler yalnız kasanın şimdiki şubesi için çekildiyse kullanılır: şube kimliği değişince
eskisininkiler bırakılır (şubesiz eski dosyada da), bir sonraki çekim yenisininkileri getirir. Değerler arayüzde,
günlükte, denetim kaydında, veritabanında, bulut özetinde ve depoda hiç yazılmaz. İnternet yokken kasa son çekilen
değerlerle sürer (`tests/platform-anahtar-bulut.test.ts`).

**Bilinen sınırlar.** Kafe anahtarı (`ASILPOS_CLOUD_SECRET`) bütün şubelerde aynı: `?sube=` imzalıdır (imzadan sonra
değiştirilemez) ama uç isteyen kasanın gerçekten o şube olduğunu doğrulamaz. Şube adı bir yanlışlık önlemidir (Marina
kasası Tuzla'nın anahtarını yanlışlıkla almaz), yetki sınırı değildir: kafe anahtarını bilen her şubenin anahtarını
isteyebilir. Şube başına ayrı anahtar ileride (`docs/KALANLAR.md`). Yemeksepeti ve Getir'in gelen kutusu restorana
ayrıdır (restoran kimliği Vercel'de tanımlıysa; yukarıda Yemeksepeti ve Getir): kasa yalnız kendi restoranının
kutusunu çeker ve siler; aynı kafe anahtarıyla bu da yanlışlık önlemidir, yetki sınırı değil.

## Otomatik kabul
İsteğe bağlı ve **varsayılan kapalı**, platform başına (Yönetim › Paket platformları, platform kartında "Otomatik
kabul"; ayar `PlatformSettings.autoAccept`, `autoAcceptUserId`, `autoAcceptMaxKurus`, ayar JSON'unda durur). Açarken
"Kabul eden" seçilir: etkin ve paket yetkili (`paket.yonet`) bir kişi; seçilmemişse ya da kişi uygun değilse ayar
kaydedilmez (422 `auto_accept_user`). Açıp kapamak, kişiyi ya da sınırı değiştirmek denetim kaydına uyarı düşer.

Yoklama yeni siparişi kayda aldıktan sonra (aynı turdaki platform iptali ve panelden kabul işlendikten sonra) her
yeni kaydı **bir kez** dener; kasadaki Kabul ile aynı yoldan gider (`server/delivery/live.ts` `acceptFlow`: aynı
kilit, yerelde prova, önce platforma, sonra adisyon). Deneme modunda "Deneme siparişi gönder" de aynı yoldan dener
(platforma gitmez). Kabul edilmiş kayıt yeniden denense de (kasa yeniden başladı) kilit ve durum denetimi ikinci
kabulü ve ikinci platform çağrısını önler.

**Kasadaki karar önce gelir.** Kasada bir kişi kayıt üzerinde karar denediyse (Kabul, Ret, platform iptali, iptalin
elle kapatılması; başarılı ya da başarısız) otomatik kabul o kaydı **hiçbir zaman** kabul etmez. Ret platforma
gidemeyince (502) kayıt onay bekler görünür; eskiden turun sonundaki otomatik kabul ya da "meşgul" sonrası yeniden
deneme personelin reddettiği siparişi kabul edip bara gönderiyordu (gözden geçirme, 28 Eki 2026). Üç kat:
- O an kasada karar veriliyorsa (409 `busy`: kasadaki Kabul ya da Ret platform çağrısını bekliyor) otomatik kabul
  kaydı bırakır, yeniden denemez; nedeni "kasada karar veriliyor".
- Tersi: otomatik kabul platform çağrısındayken kasada Reddet'e basılırsa ret gitmez (kabul platformda sürüyor) ve
  "başka bir ekranda işleniyor" denmez: 409 `auto_accepting`, "Otomatik kabul ediliyor; kabul edilirse adisyondan
  iptal edin" (şerit kartta ve bildirimde gösterir). Kişinin ret denemesi denetim kaydına bilgi olarak yazılır
  (`platform.reject_try`, nedeniyle) ve kayıt kasadaki karar sayılır (`manualDecision`): kabul düşerse sipariş elle
  kalır. Elle Kabul aynı anda 409 `busy` alır (bugünkü gibi).
- Kilidin içinde okunan kayıtta otomatik kabulün kendi notundan ("Otomatik kabul edilmedi: …") başka bir not varsa
  (ör. "ret bildirilemedi") atlanır: "kasada karar denendi". Kasa yeniden başlasa da kayıtta durur.
- Kasadaki karar uçları (`accept`, `reject`, `platform-cancel`, `cancel-close`) kilidin içinde kaydı süreç belleğindeki
  `manualDecision` kümesine de koyar (`server/delivery/locks.ts`): kayda hata yazılmayan başarısızlıkta da (ör. elle
  Kabul'ün provası porsiyon yüzünden düştü) otomatik kabul o kaydı atlar.

Şüphede sipariş elle kabule kalır: otomatik kabul para ve durum değiştirir.

Bütün koşullar sağlanmazsa sipariş **elle kabul bekler**: nedeni şeritte bilgi notu olarak görünür ("Otomatik kabul
edilmedi: eşleşmeyen kalem (…)"; tutar ya da ödeme doğrulanacaksa bağdaştırıcının metni; kayıtta platformun hatası gibi
başka bir not varsa o ezilmez) ve denetim kaydına bir kez düşer (`platform.auto_skip`). Koşullar (`autoAcceptBlocker`, sırayla):
1. Ayar açık ve platform Kapalı değil.
2. Platformun test siparişi değil.
3. Mod: Canlı'da yalnız gerçek sipariş ve kasa kurulum ya da eğitim modunda değil (`trainingMode`: kurulum modu ya
   da yazarkasanın eğitim simülatörü; o günün satışı eğitim günüdür, gerçek sipariş ona yazılmaz); Deneme'de (yalnız
   kurulum modunda) yalnız deneme siparişi.
4. Platformun tabletinde kabul edilmiş değil (`preAccepted`: barda çift hazırlık riski), platformun panelinden kabul
   edilmiş değil (`notifiedStatus` boş), kasada karar denenmemiş (yukarıda), ileri tarihli değil (saati okunamamış
   ileri tarihli de: `scheduledUnknown`), eski değil: sipariş saatinden 30 dakikadan fazla geçmişse ("sipariş eski
   (HH:MM)", `AUTO_ACCEPT_MAX_AGE_MS`) elle; bağlantı kopukken birikmiş Trendyol Go paketi kabul süresini kasaya
   geliş anından aldığı için taze görünürdü.
5. Kabul süresinin bitmesine en az 30 saniye var.
6. Kabul eden kişi her denemede yeniden okunur: etkin ve paket yetkili değilse çalışmaz (ilk seferde uyarı).
7. Gün açık ve güncel (05:00 kuralı; önceki günün gün sonu alınmamışsa olmaz).
8. Tahsilat platformda (`platformCollects`): kendi kuryemizin kapıda alacağı ya da Yemeksepeti kuryesinin kasaya
   nakit bırakacağı sipariş elle.
9. Tutar tutarlı: bağdaştırıcı tutarı ya da tahsilatı doğrulanmalı diye işaretlemedi (`amountReview`). Üç
   bağdaştırıcıda aynı kural: platformun toplamı hiç gelmezse ("Getir toplamı gelmedi", Yemeksepeti'nde ödenmiş
   siparişte `grandTotal` yok, "Trendyol ödenen tutarı vermedi") ya da kalemleri aşarsa (Getir'in açıklanamayan farkı;
   Yemeksepeti'nde `grandTotal` − Yemeksepeti kuryesinin teslimat ücreti − kuryenin bahşişi `riderTip` kalemleri
   aşıyorsa, bahşiş tek başına aşmaz; Trendyol Go'da ödenen tutar) tutar doğrulanır, fark adisyona girmez. Ayrıca
   Yemeksepeti'nde ödenmemiş siparişte alınacak tutarın sıfır görünmesi ve kendi kuryemizin siparişinde ödeme türünün
   belirsiz olması: Getir'de "Getir'den doğrulayın" etiketi, Trendyol Go'da ödeme türünün gelmemesi (boş ya da yalnız
   boşluk: `paymentOf`'un kırptığı değer, "Ödeme türü gelmedi") ya da
   tanınmaması ("Ödeme türü tanınmadı (X)": tanınan online türler `TRENDYOL_ONLINE_PAYMENTS`'ta açıkça listeli,
   kapıda türler ayrı; tanınmayan tür elle kabulde bugünkü gibi online sayılır, yalnız işaretlenir); tutarlar kuruş tam sayı ve sıfırdan küçük değil, adetler tam sayı; Σ(birim × adet) = kalemler;
   restoran kampanyası + platform kampanyası + müşterinin ödediği = kalemler; müşterinin ödediği sıfırdan büyük.
10. Müşterinin ödediği ayardaki en yüksek tutarı (varsayılan 1.500 TL) aşmıyor.
11. Bütün kalemler kasadaki ürüne eşleşmiş (ücret satırı serbest) ve hiçbiri tükenmemiş; eşleşen ürünün seçeneklerinden
    biri kasada tükendi işaretliyse (yulaf sütü bitti) de elle: platformun seçimi notta metindir, kişi okur
    (`soldOutOptionsOf`; elle kabul ve adisyon açma etkilenmez, platform siparişi reddedilmez).
12. Prova geçiyor (porsiyon yetiyor) ve provadaki adisyonun tutarı platformun ödeyeceğine (kalemler − restoran
    kampanyası) eşit.

Hazırlık süresi ayardaki `prepMinutes`. Kabul eden ayarda seçilen kişidir (`decidedBy`); denetim kaydında
`platform.auto_accept` ve "<ad> (otomatik)", kayıtta "20 dk, otomatik". Kasada bildirim çıkar, bar fişi her zamanki
gibi düşer. Platform kabulü almazsa kayıt bekler (uyarı; elle kabul edilir), platform kabul edip adisyon açılamazsa
`platform.accept_failed` alarmı (Kabul yalnız adisyonu açar, platforma ikinci kez gidilmez). Platform kabulü "zaten
kabul edilmiş" diye yanıtlarsa (Getir `/verify` 400 kod 2: Getir panelinden ya da IVR'dan onaylanmış; bağdaştırıcının
`accept`'i `'already'` döner) otomatik kabul adisyonu **açmaz**: kayıt platformun panelinden kabul edilmiş gibi
işaretlenir (`notifiedStatus` picked, "Platformun panelinden kabul edildi: Kabul yalnız adisyonu açar",
`platform.accepted_elsewhere` alarmı) ve sipariş elle kalır; kasadaki koşul (panelden kabul edilmişi otomatik kabul
etme, barda çift hazırlık riski) böyle delinmez. Elle Kabul'de "zaten onaylı" yanıtı eskisi gibi adisyonu açar; elle
Kabul işaretli kayıtta platforma ikinci kez gitmez.

Siparişin "alanı" (adisyonun garsonu) kabul edendir; otomatik kabulde ayarda seçilen kişi kafede olmayabilir. Bu
yüzden platform siparişinin "N ürün hazır" uyarısı (`items.ready`, `platform` alanıyla; "Yemeksepeti A7KX · 1 ürün
hazır") paket yetkili (`paket.yonet`, şeritteki siparişleri yöneten) her cihazda ve kabul edende çalar; bir cihazda bir
kez (`shared/events.ts` `readyAlertFor`). Elle alınan masa, tezgâh ve gel-al siparişinde yalnız siparişi alan görür.

## Rapor
Raporlar › Paket platformları (`rapor.gor`; `GET /api/reports/platforms?from&to`, CSV `type=platformlar`),
`server/services/reports.ts` `platformReport`:
- **Ciro** Raporlar › Ciro'nun kuralıyla: kapanmış POS adisyonu, adisyonun açıldığı iş günü, KDV dahil; platforma
  siparişin kaynağından (`orders.platform`) bağlanır, tahsilatı kim yaparsa yapsın. Platformların toplamı Ciro'nun
  `netSales`'inin içindedir (`tests/platform-report.test.ts`, `tests/report-reconciliation.test.ts`). Sipariş sayısı
  Ciro'daki adisyon ölçütüyle (tutarı olan adisyon), ortalama sepet ciro / sipariş.
- **İndirim:** restoranın karşıladığı (adisyonun kalem ve adisyon indirimi; platformun kampanyasındaki restoran payı
  dahil) ve platformun karşıladığı kampanya (kabul edilen siparişin `platformDiscount`'u; ciroyu düşürmez, bilgi).
- **Tahsilat:** platformun ödeme türü (kanal = platform) "platformda", öteki türler "kasada"; ikisinin toplamı ciro.
- **Açık:** kabul edilmiş, henüz kapanmamış adisyonlar; ciroya girmez.
- **Kaçan:** reddedilen, süresi dolan (zamanlayıcı işaretlemeden süresi geçen de), iptal edilen (platformun ya da
  kasanın; kabulden önce ya da sonra) ve platformda kabul edilip 3 saatte kasaya alınmayan (ayrı nedeni "kasaya
  alınmadı"; ekrandaki tanım ve boş KPI açıklaması da onu sayar). Kabul edilmemiş kayıt geldiği anın iş gününe (05:00 kuralı), kabul edilip
  iptal edilen adisyonun gününe yazılır; tutar müşterinin ödeyeceği (`customerTotal`), ciroya girmez. Platformda
  kabul edilmiş, 3 saat içinde kasaya alınmamış sipariş "süresi doldu" değil "kasaya alınmadı" sayılır: platformda
  teslim edilmiş olabilir, kasada kaydı yoktur. Bu, tablette kabul edilmişe (`preAccepted`) ve kasada "onay bekliyor"
  görünen ama platformda kabul edilmiş kayda (`notifiedStatus` = `picked`: platformun panelinden kabul edilmiş ya da
  kasadan kabulü platforma gidip adisyonu açılamamış) aynı süreyle uygulanır: sipariş saatinden (ileri tarihlide teslim
  saatinden) 3 saat sonra (`PRE_ACCEPTED_TTL_MS`). Platformun test siparişi sayılmaz. Onay bekleyen sipariş hiçbir
  rakama girmez, yalnız sayısı yazılır; platformda kabul edilmiş kayıt karar beklemediği için o sayıya girmez.
- **Tahmini komisyon** yalnız `rapor.maliyet` yetkisine gider (uçta ve CSV'de; yoksa alan hiç yok): platformun
  cirosu × Yönetim › Paket platformları'ndaki **bugünkü** oran, kuruşa yuvarlanmış (`percentOf`). Oran sipariş anında
  dondurulmaz, değişirse geçmiş dönemin tahmini de değişir; gerçek komisyon platformun hesap kesiminde ve lafmaliyet'te
  (Trendyol Go'nun hesap kesimi ucu bağdaştırıcıda henüz yok).

## Uçlar
`GET /api/platforms` (ayarlar, siparişler, `live` canlı durum, `acceptors` otomatik kabulde seçilebilecek kişiler;
komisyon oranı `commissionPct` maliyettir, yalnız `rapor.maliyet`, `ayar.yonet` ya da `senkron.yonet` yetkisine gider,
garson ve raporcu almaz; platform ayarları sunucuya özel ayarlardadır, `/api/bootstrap` ve bulut anlık görüntüsü
onları hiç taşımaz) ·
`PUT /api/platforms/:platform` (`mode`, `prepMinutes`, `commissionPct`, `autoAccept`, `autoAcceptUserId`,
`autoAcceptMaxKurus`; denetim kaydı `platform.settings` iletisinde oran yazmaz, değiştiyse "tahmini komisyon oranı
değişti" der: ileti uyarı olarak `alerts` olayıyla her ekrana ve patron paneline gider. Oranın eskisi ve yenisi kaydın
`data`'sında; `/api/admin/audit` onu, ve eski kayıtların iletisindeki "%N komisyon" parçasını, `rapor.maliyet`,
`ayar.yonet` ya da `senkron.yonet` yetkisi olmayana (yalnız patron paneli yetkilisi) maskeler, `server/delivery/commission.ts`) · `POST /api/platforms/:platform/test-order` (`autoAccepted`) ·
`POST /api/platforms/orders/:id/accept|reject|platform-cancel|cancel-close` · teslim: `POST /api/orders/:id/delivery` ·
ürün eşleme: `GET /api/platforms/products`, `PUT /api/platforms/products/:id` · rapor: `GET /api/reports/platforms`,
`GET /api/reports/export.csv?type=platformlar`.
