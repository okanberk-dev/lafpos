# Entegrasyon sözleşmesi: LafPOS ↔ laffogato ↔ lafmaliyet

Bu belge LafPOS'un diğer iki sistemle hangi uçtan, hangi alanlarla, ne sıklıkla konuştuğunu tanımlar.
Bir alan burada yoksa sistemler arasında gitmez (KVKK beyaz liste kuralı).

**Bütün bağlantılar varsayılan kapalı** (sahibin 26 Ekim 2026 kararı: "lafposu tüm hepsinde aktif edince kullanmaya
başlayayım, hemen aktif olmasın ki şu anki sistem bozulmasın"). `.env`'de adres ve anahtar yokken LafPOS dışarıya
hiç istek atmaz; kasa ModPOS'ken laffogato ve lafmaliyet bugünkü gibi çalışır. Açma adımları tek listede: §8
**Açılış sırası** (lafmaliyet `docs/LAFPOS.md` › "Açılış sırası" ile aynı adımlar).

## 1. Sahiplik

| Veri | Sahibi | LafPOS'ta |
| --- | --- | --- |
| Satış fiyatı (M, L), Satışta/Tükendi, KDV oranı, ürün adı, kategori, görsel, alerjen | laffogato | salt okunur kopya; Tükendi değişikliği önce siteye yazılır (internet yokken kasada hemen geçerli, siteye giden kutusundan gider); sitenin kapattığını kasiyer açamaz (§2.3 Tükendi kilidi) |
| Seçenekler (süt, kavrum, şurup, ekstra shot, şeker) ve fiyatları | laffogato (kod sabiti; panelde düzenlenmez, site koduyla değişir) | menüyle birlikte gelir, salt okunur; kasaya özel seçenek LafPOS'ta yerel gruptur. Seçeneğin kasadaki Tükendi'si (`option_items.soldOut`) yalnız LafPOS'ta, siteye gitmez (§2.3 Seçenek tükendi) |
| POS'a özel alanlar: istasyon, kısa ad, düğme rengi, POS sırası, gizli, porsiyon sayacı, `posName` | LafPOS | senkron dokunmaz |
| POS'a özel ürünler (karaoke saati, kampanya) | LafPOS | `extSource` boş |
| Reçete, hammadde, maliyet, stok, tedarikçi, cari, kasa raporu | lafmaliyet | LafPOS kopyalamaz |
| Masa, adisyon, ödeme, gün sonu, personel PIN'leri | LafPOS | |
| Online sipariş (uygulama, web, masa QR) | laffogato (şubeli; §2 "Şube") | kasanın şubesinin siparişleri bar ekranında gösterilir, aşaması geri yazılır, tahsil edilmez; başka şubenin siparişi gelmez |
| Karaoke rezervasyonu (gün, saat, ödeme) | laffogato (`/karaoke` ve uygulama) | bugünkü liste salt okunur (§2.4); oda yerel rezervasyona verilmez, sayaç rezervasyona bağlanır |
| Sadakat damgası | laffogato (uygulama) | LafPOS'un yerel damga kartı varsayılan kapalı (`stampCategoryKeys: []`), site bağlantısı kuruluyken hiç açılmaz |

## 2. laffogato → LafPOS: menü

**Bağlantı varsayılan kapalı** (sahibin 26 Ekim kararı): LafPOS siteye yalnız kasa bilgisayarının `.env`'inde
(Windows kurulumunda `ayarlar.env`) `LAFFOGATO_URL` açıkça yazılıysa bağlanır; varsayılan adres yoktur. Yazılmamışsa
hiçbir istek gitmez: menü yoklaması, ürün görseli, sipariş sürüm sinyali, Tükendi yazımı. Yönetim › Entegrasyon
"Site bağlantısı kurulmadı" der, elle "Siteyle eşitle" ve online sipariş "Yenile" aynı mesajla 409 `not_configured`
döner, Tükendi yalnız LafPOS'ta değişir. İmzalı uçlar (§2.3) ayrıca `LAFFOGATO_SYNC_SECRET` ister. Kurulum betiği
(`scripts/vercel/baglanti-kur.sh`) kafeye girecek ayar dosyasına `LAFFOGATO_URL=https://laffogato.net` satırını yazar;
`.env.example`'da (ve ondan üretilen `ayarlar.env.ornek`'te) satır yorumludur. Kurulum ayar dosyasını yalnız ilk
kurulumda yazar, güncelleme dokunmaz: bu sürümden önce kurulmuş bir kasada `ayarlar.env`'de yorumsuz
`LAFFOGATO_URL=https://laffogato.net` kalır ve bağlantı açık kalır; açılış sırasına kadar satır silinir ya da başına
`#` konur (`docs/05-KASA-BILGISAYARI.md` "Güncelleme").

### Şube (22 Kasım 2026; laffogato #279)

Site şubelidir: sipariş, masa kodu (`cafe_tables`), masa çağrısı ve Satışta bilgisi bir şubenindir (masa siparişi ve
çağrısı masanın şubesi; gel-al, kurye, kargo ve karaoke Tuzla'nın). LafPOS'un anahtarı sitenin `LAFPOS_BRANCHES`'teki
şubeler adına konuşur (varsayılan `marina`; laffogato `docs/LAFPOS.md` "Şube"). LafPOS her imzalı istekte kendi şubesini
söyler (`siteBranch()` = Yönetim › Ayarlar › Şube kimliği `branchId`, varsayılan `marina`; `server/sync/laffogato-link.ts`):

- GET'te sorguda `?branch=<id>` (imzanın içinde): `/api/panel/orders`, `/api/panel/menu`, `/api/panel/karaoke`.
  Sürüm sinyali (`/api/pos/orders/version`) şubesizdir, sorgu almaz.
- POST / PUT gövdesinde `"branch": "<id>"`: aşama, çağrıya "Gördüm", Satışta yazımı (giden kutusundaki de, gönderim
  anındaki şubeyle) ve masa kodları.
- **Yanıtın şubesi:** `GET /api/panel/orders` ve `GET /api/panel/menu` yanıtındaki `branch` kasanın şubesi değilse liste
  okunmaz: siparişler için çekim 502 `site_branch` olur, hiçbir sipariş yazılmaz ya da kapanmaz; panel menüsünde
  Satışta bilgisine dokunulmaz (fiyat ve ürünler herkese açık listeden uygulanır, eşitleme uyarı yazar). Alanı
  göndermeyen eski site bugünkü gibi okunur.
- **Başka şubenin kaydı** (site 409 `wrong_branch`): aşama yazımında yeniden denenmez, sipariş bu kasanın ekranından
  kalkar (`extStage = 'gone'`, `extOutcome = 'other'`, "Online (sitede ödendi)" toplamına girmez, denetim
  `online.gone`), kullanıcıya 409 `wrong_branch`. Çağrıya "Gördüm"de kart düşer (sitede yok gibi; denetim metni
  "çağrı başka şubenin"). Masa kodlarında liste park edilir; Entegrasyon "bir kod sitede başka şubenin masası" der,
  düzeltme sitenin panelinde (Masalar › masa › Düzenle › Şube).
- Karaoke odası Tuzla'dadır: başka şube adına site boş liste (`complete: true`) verir.
- Fiyat her şube için tektir ve sitenindir; LafPOS yazamaz.

### 2.1 Herkese açık menü

`GET {LAFFOGATO_URL}/api/mobile/v1/menu` · `If-None-Match: <son ETag>` · anahtar gerekmez.

- CDN'den gelir (`s-maxage=60, stale-while-revalidate=60`; 21 Kasım 2026'da sitenin kodundan doğrulandı). CDN'deki kopya eskiyince istek sitenin veritabanını
  okur (laffogato `listMenuItems`); Neon 5 dakika boşta kalınca uyuduğu için her ıska bir uyanmadır, gece
  uyanmaları en büyük israftır.
- 304 gelirse değişiklik yok. 200 gelirse fark hesaplanır.
- **Sıklık:** açık iş günü varken 15 dakikada bir otomatik (ayarla kapatılabilir). Açık gün yokken (gece) hiç; gün
  açılınca (ya da yeniden açılınca) bir kez. LafPOS siteye kendi Satışta yazımını yaptıktan (Tükendi, Satışa aç,
  porsiyon) 5 saniye sonra bir kez: site o an zaten uyanık; bekleyen bir eşitleme varsa ya da son 20 saniyede
  eşitlendiyse bu eşitleme kurulmaz (işaret eşitlemesi onu kapsar). Ayrıca "Siteyle eşitle" düğmesi. **Sitede fiyat
  ya da Satışta değişince** (sitenin menü formu ya da lafmaliyet panelinin yazımı) 20 saniyelik sipariş sürüm
  sinyalindeki `menu` işareti değişir; LafPOS gün açıkken 1 saniye sonra ETag'siz eşitler, **işaret eşitlemeleri arası
  en az 60 saniye**: art arda düzenlemeler (lafmaliyet'ten 30 fiyat) sonda tek eşitlemede toplanır (`server/jobs.ts`
  `MARKER_SYNC_MIN_MS`). **Gece** (açık gün yokken) işaret değişse de istek gitmez; gün açılınca bir kez ETag'siz.
  Sitenin her yayını (deploy) `version`, `karaoke` ve `menu` işaretlerinin üçünü birden yeniler (laffogato işaret
  anahtarı `VERCEL_DEPLOYMENT_ID` içerir): gün açıkken bir eşitleme, gece hiçbir şey. Eski site işareti göndermez:
  15 dakikalık yoklama.
- **Fiyatın taze kaynağı imzalı panel listesidir** (anahtar varsa, `GET /api/panel/menu`; `withPanelPrices`): CDN'deki
  herkese açık menü 2 dakikaya kadar bayat olabilir, kasa eski fiyattan satmasın. Herkese açık listede olmayan bağlı
  ürünün (sitede Tükendi, ya da yeniden açıldı ama CDN henüz eski) fiyatı da panelden yazılır; önizleme bunu "fiyat" ve
  "boy" diye gösterir. Panel alınamazsa herkese açık menünün fiyatı.
- **CDN bayatlığı:** panelde satışta olan bağlı ürün herkese açık listede yoksa liste CDN'de eskidir (`cdnStale`):
  2 dakika sonra (s-maxage + swr) **bir kez** ETag'siz yeniden eşitler, ad, KDV ve görsel de taze listeden gelsin. Yine
  bayatsa 15 dakikalık yoklama bekler (döngü yok). ETag yine yazılır: CDN yenilenince ETag değişir, yoklama taze listeyi
  alır. Herkese açık liste yalnız sitenin ana şubesinin (Tuzla) Satışta'sını gösterir (laffogato `src/lib/mobile/menu.ts`):
  Tuzla'da tükenen, Marina'da satılan ürün listede yoktur ve "bayat" görünür; ETag yazılmasaydı her yoklama tam liste ve
  imzalı panel okuması isterdi. Böyle bir ürünün adı, KDV'si ve görseli Tuzla'da satışa dönene dek yenilenmez; Tuzla'da
  tükenmişken sitede açılan yeni ürün Marina'da o zamana dek oluşmaz (sitenin şubeli herkese açık menüsü yok).
- **Sessiz bayatlama uyarısı** (`menuStaleError`): gün açıkken, bağlantı ve otomatik eşitleme açıkken menü 40 dakikadır
  (iki yoklama ve pay; gün açılışından önce sayılmaz) başarıyla kontrol edilmediyse ve kayıtlı hata yoksa
  `GET /api/sync/status` bunu menünün hatası olarak verir: Entegrasyon "Hata" der, yönetim çubuğu sayar. Yoklama hiç
  çalışmazsa hata yazılmaz ve kasa eski fiyattan satmaya devam ederdi.
- Yalnız satıştaki kalemleri içerir ve dakikalarca bayat kalabilir. **Satışta bilgisinde karar imzalı panel
  listesinindir** (anahtar varsa, §2.3 `GET /api/panel/menu`; her kalemi satışta olsun olmasın veritabanından taze
  verir): herkese açık listede görünen ama panelde kapalı kalem kapanır, listede görünmeyen ama panelde açık kalem
  kapanmaz (kapalıysa açılır), panelde hiç olmayan kalem sitede silinmiştir. Anahtar varken panel listesi alınamazsa
  (saat kayması, anahtar uyuşmazlığı, site hatası) fiyat, ad, KDV, açıklama, görsel ve yeni ürünler yine uygulanır,
  var olan ürünlerin Satışta bilgisine dokunulmaz: bayat liste Tükendi ürünü yeniden açmasın, kasa eski fiyattan da
  satmasın. Hata Yönetim › Entegrasyon'da görünür, ETag yazılmaz, sonraki tur yeniden dener. Anahtar yoksa listede
  olmayan bağlı ürün "sitede satışta değil" sayılır. Kapanan ürün POS'ta Tükendi olur (silinmez,
  geçmiş satışlar bozulmasın); porsiyonu biten ürünü site açamaz.
- Ürün kartının görseli bir kez indirilip veri klasöründe kalır: sitenin küçültme ucuna (`/_next/image`, 256 px)
  sürümlü adresle (`?v=`) gidilir, site fotoğrafı değişince yenisi gelir; uç yanıt vermezse sürümlü asıl görsel.

### 2.2 Eşleme

| Site alanı | LafPOS alanı | Kural |
| --- | --- | --- |
| `categories[].key` | `categories.extKey` | 12 sabit kategori; `title` → ad |
| `items[].id` (`mnu-0011`) | `products.extId`, `extSource = 'laffogato'` | tekil |
| `name` | `name` | |
| `description` | `description` | |
| `priceMinor` | `price` | M ya da tek boy, kuruş, KDV dahil |
| `priceLargeMinor` (null = tek boy) | `priceL` | |
| `taxRatePct` | `kdvRate` | satış anında kaleme dondurulur |
| `image` | `image` | sürümlü mutlak adres |
| `allergens`, `tags` | `allergens`, `tags` | |
| `customization.milks/roasts/syrups/extraShotMinor/sugarMax` | `option_groups` + `option_items` (`extKey`: `milk`, `roast`, `syrup`, `extraShot`, `sugar`; kalem `code`: site kimliği) | `dessert`, `snack`, `extras` kategorilerindeki ürünlere bağlanmaz (sitenin `NON_CUSTOMIZABLE_CATEGORIES` kuralı) |

Elle "Siteyle eşitle" önce **önizleme** gösterir: yeni ürün, fiyatı değişen, adı değişen, KDV'si değişen, siteden
kalkan, yeniden satışa çıkan; onaylanınca uygular. Otomatik senkron önizlemesiz uygular. İkisi de tek veritabanı
işleminde yapılır ve değişiklik varsa `audit_log`'a "menü senkronu" olarak yazılır. POS sırası yalnız ürün ilk
gelirken sitenin sırasından verilir; sonra LafPOS'undur.

**Satışta / Tükendi:**

- Anahtar varsa imzalı panelin `isActive` bilgisi geçerlidir (§2.1; CDN'deki herkese açık menü birkaç dakika eski
  olabilir): sitede Tükendi olan ürün, eski menü listelese de açılmaz; sitede yeniden açılan, eski menü
  listelemese de kapanmaz.
- Anahtar yokken herkese açık menüde listelenen satışta sayılır; yalnız son eşitlemede de listelenmiş ve o
  zamandan beri LafPOS'ta Tükendi yapılmış ürün (site değişmedikçe) kapalı kalır.
- Porsiyon sayacı biten ürünü site açamaz. Sayaç 0'dan doldurulunca (Yönetim › Ürünler) Tükendi ürün önce sitede
  satışa açılır (`POST /api/panel/menu`); site kabul etmezse sayaç da değişmez. Sayacı bitmemiş ürünün başka bir
  alanını (istasyon, renk) kaydetmek Satışta bilgisine dokunmaz, siteye istek göndermez.
- LafPOS'un siteye henüz gönderemediği Satışta yazımı bekleyen ürünün (giden kutusu, §2.3 "Porsiyon") Satışta
  bilgisine eşitleme dokunmaz: site görüntüsü o yazımdan eskidir. Site zaten istenen durumdaysa ya da kalem sitede
  artık yoksa bekleyen yazım düşer.
- Eşitlemenin panel okuması ve uygulaması, siteye giden Satışta yazımlarıyla aynı kilitte yapılır: istek yoldayken
  kasada basılan Tükendi, yazımdan önceki panel görüntüsüyle geri alınmaz.

### 2.3 İmzalı panel uçları (anahtar verilirse)

`.env`: `LAFFOGATO_URL` ve `LAFFOGATO_SYNC_SECRET`. Anahtarın değeri sitenin **`LAFPOS_SYNC_SECRET`** ortam
değişkeniyle aynıdır (en az 32 karakter). Site bu anahtarı panel uçlarında `KARAOKE_SYNC_SECRET`'a ek olarak kabul eder
(laffogato#263); iki anahtar ayrı döndürülür. **Panelin `KARAOKE_SYNC_SECRET`'ı kafe makinesine konmaz:** site, LafPOS
anahtarı panelinkiyle aynıysa onu LafPOS anahtarı saymaz (laffogato `src/lib/panel/signed-callers.ts`); sürüm sinyali
503 döner, yazımlar panelinmiş gibi kaydedilirdi.

İmza sitenin `src/lib/panel/karaoke-sync-core.ts` kuralının aynısı:

```
kanonik = ts + "\n" + METHOD + "\n" + path + "\n" + sıralı-ve-kodlanmış-sorgu + "\n" + sha256hex(gövde)
x-laf-timestamp: <unix saniye>
x-laf-signature: v1=<hmac_sha256_hex(anahtar, kanonik)>
```

Uyum, iki projenin sabitlediği vektörlerle `tests/signature.test.ts`'te doğrulanır.

| Uç | LafPOS kullanımı | Sıklık |
| --- | --- | --- |
| `GET /api/panel/menu` | Satışta bilgisinin ve fiyatın taze kaynağı (`isActive`, §2.1) | menü senkronunda: herkese açık menü değişince, `menu` işareti değişince (gün açıkken en sık 60 sn, gece yok) ve elle |
| `POST /api/panel/menu {id, isActive, actor, branch}` | POS'ta Tükendi / Satışa aç ve porsiyon sayacının doldurulması → önce site, 2xx gelince yerel; Tükendi / Satışa aç'ta siteye ulaşılamazsa (internet yok ya da site 5xx/429) yerelde hemen, yazım giden kutusundan (aşağıda "İnternet yokken Tükendi"); porsiyon sayacı sıfıra inince Tükendi, hazırlanmadan iptal edilen kalemle sıfırdan dönünce Satışta (`actor: LafPOS porsiyon`, giden kutusundan) | kullanıcı işlemi ya da porsiyon |
| `GET /api/pos/orders/version` | sipariş sürüm sinyali (aşağıda) | gün açıkken 20 sn'de bir, gece en sık 3 dk'da bir; veritabanına gitmez |
| `GET /api/panel/orders` | online siparişler (masa, gel-al, kurye): bar ekranı ve masa planı; yanındaki `calls` masa çağrıları (aşağıda) | sinyal değişince; gün açılınca bir kez; gün açıkken 15 dk'da bir güvenlik çekimi; elle "Yenile" (en sık 30 sn); sinyal yoksa 5 dk'da bir |
| `POST /api/panel/orders/stage {id, action, from, actor}` | Hazırlanıyor / Hazır / Teslim edildi; 409 ve 404'te liste yeniden çekilir | kullanıcı işlemi |
| `POST /api/panel/calls/ack {id, actor, branch}` | masa çağrısına "Gördüm" (aşağıda "Masa çağrıları") | kullanıcı işlemi |
| `GET /api/panel/karaoke?from=<gün>&to=<gün>` | bugünün karaoke rezervasyonları: oda kutusu, masa planı, oda ücreti (§2.4) | `karaoke` işareti değişince, gün açıkken en sık 5 dk'da bir; oda kutusu açılınca ve sayaç dururken liste geride kaldıysa; elle (en sık 30 sn) |

`actor` LafPOS kullanıcısının adıdır. LafPOS anahtarıyla gelen yazımlar site olay kaydına `lafpos:<ad>` diye düşer.

**Sipariş sürüm sinyali:** `GET /api/pos/orders/version` (imzalı, `LAFPOS_SYNC_SECRET`) → `{ "version": "<metin>",
"karaoke": "<metin>" }` (`karaoke` laffogato#264'ten beri; karaoke okumasının işareti, §2.4).
Sitenin veri önbelleğinden (`live:orders` etiketi) gelir, veritabanına dokunmaz; sipariş yazımı etiketi
düşürünce değer değişir. LafPOS bunu gün açıkken 20 saniyede bir sorar, değer değişince `GET /api/panel/orders`'ı
çeker. Böylece online sipariş Neon kotasını harcamadan yarım dakika içinde bar ekranına düşer. Veritabanına dokunmadığı
için 5 dakika kuralının (`AGENTS.md` kural 6) dışındadır.
- **Gece** (açık iş günü yokken) sinyal en sık 3 dakikada bir sorulur (21 Kasım 2026; kasa bilgisayarı ve site gece
  boşuna çalışmasın). Gece de sorulur, çünkü gün kapalıyken gelen sipariş ödeme anının iş gününe işlenir. Gün açılınca
  (Kasa › Gün açılışı ya da günü yeniden açma) bir tur hemen döner ve sinyal değişmemiş olsa da liste bir kez çekilir;
  sonra yeniden 20 saniyede bir.
- **Hiç iş günü yokken** (ilk kurulum, henüz gün açılmadı) siparişin yazılacağı gün yoktur: zamanlayıcı siteye istek
  atmaz, elle "Yenile" listeyi alır ama sipariş yazmaz, sürüm kaydedilmez ve Yönetim › Entegrasyon "Gün açılmadı;
  online siparişler gün açılınca alınır" der. İlk gün açılınca liste hemen çekilir.
- Sürüm yalnız çekim başarılıysa kaydedilir: başarısız çekim sonraki turda (20 sn) yeniden denenir, art arda
  başarısızlıkta bekleme katlanır (en çok 5 dk). Sipariş kaybolmaz. Sinyal okunamazsa (5xx, bozuk gövde) 5 dakikalık
  çekmeye düşülür.
- Sinyal çalışırken de açık iş günü varken 15 dakikada bir tam çekim yapılır: sinyali kaçan bir değişiklik ya da
  süresi dolup listeden sessizce düşen sipariş (sitede yazım olmaz, sinyal değişmez) kalmasın. Gece yapılmaz.

`GET /api/panel/orders` yanıtında `orders` dizisi yoksa (bakım sayfası, ağ geçidi, beklenmeyen gövde) çekme
başarısız sayılır, hiçbir sipariş kapatılmaz. **Biçim sürümü:** iki imzalı liste de `version` taşır (laffogato
`PANEL_ORDERS_VERSION`, `PANEL_MENU_VERSION`; bugün `1`). Değer `1` değilse (başka sayı, metin, `null`) LafPOS listeyi
okumaz: sipariş çekimi başarısız sayılır (502 `site_orders`, "Site siparişleri tanınmayan biçimde (sürüm N)"; hiçbir
sipariş kapanmaz, hata Yönetim › Entegrasyon'da görünür), menü senkronu panel listesi alınamamış gibi davranır
(fiyat, ad, KDV ve yeni ürünler uygulanır, Satışta bilgisine dokunulmaz). Alanı hiç göndermeyen eski site okunur.

Liste, istendiği andaki hâldir: istek gittikten sonra LafPOS'ta değişen sipariş (kasada "Teslim edildi", aşama, araya
giren daha yeni bir çekmenin getirdiği yeni sipariş) o listeyle ne yeniden açılır ne kapanır ne de aşaması geri
alınır; sonraki çekme geçerlidir.

**Sözleşme eklemeleri (21 Kasım 2026; LafPOS hazır, laffogato'da açık iş):** `GET /api/panel/orders` yanıtına üç
alan eklenir. Hepsi isteğe bağlıdır; göndermeyen site bugünkü gibi okunur.

1. `orders[].paidAtTill: boolean` — kasada ödendi. Site, siparişin `payment_transactions`'ında `manual:nakit` ya da
   `manual:kart` varsa `true` yazar (sitenin `paidAtTill(paymentsFor(order))` kuralı; `havale` ve `diger` `false`;
   laffogato `docs/PANEL-SALES.md` "paidAtTill"). Bkz. aşağıda "Kasada ödenen".
2. `orders[].lines[].index: number` — satırın `orders.items` içindeki konumu. `set_order_item_status` yerinde yazdığı
   için sabittir; iptal edilen satır listeden çıkar, konumu değişmez. Bkz. "Kalem iptali".
3. `closed: [{ id, outcome }]` — son 48 saatte akıştan çıkan kafe siparişleri, `outcome`: `completed`, `cancelled` ya
   da `refunded`. Okunamayan satır atlanır. Bkz. "Kapanış".

Online siparişler LafPOS'ta `orders.source = 'laffogato'`, `extPaid = true` olarak tutulur:
tahsilat düğmesi kapalıdır, gün sonu cirosuna ve lafmaliyet satış listesine girmez (çift sayım). Raporlarda
"Online (sitede ödendi)" olarak görünür: gün açıksa açık güne, değilse ödeme anının iş gününe (05:00 kuralı)
yazılır; o tarihin günü henüz açılmadıysa gün açılınca oraya taşınır.
- **Masa:** `fulfillment = 'table'` olan sipariş masa planında ilgili masada rozet olarak görünür. Masa önce Yönetim ›
  Masa planı'ndaki "Sitedeki masa adı" (`tables.siteTableCode`) `label` ile kıyaslanarak bulunur; o alanı boş
  masalarda yedek, yerel masa adıdır, sitenin etiket kuralıyla (ad "masa" diye başlamıyorsa önüne "Masa " gelir:
  yerel `S4` ↔ sitedeki `Masa S4`). Büyük-küçük harf ve boşluk farkı gözetilmez, birden çok masaya uyan ad eşlenmez;
  sitenin masa QR kodu gerekmez. Masayı tutmaz: garson masaya dokununca kendi adisyonunu açar (masada yalnız online
  sipariş varsa seçimde "Yeni hesap aç"), masa taşımada dolu sayılmaz ve online siparişle birleştirilmez.
- **Masa QR'ı LafPOS üretir** (27 Ekim 2026, `claude/qr-self-servis`): Yönetim › Masa planı'nda masa başına 10 simgelik
  Crockford kod (`tables.qrCode`; sitenin `cafe_tables.code` kuralıyla aynı: `shared/table-qr.ts`, laffogato
  `src/lib/admin/cafe-tables-core.ts`), QR içeriği sitenin masa adresi `https://laffogato.net/masa/<kod>` (apex'e
  sabit; basılı kart adres değişse de çalışır). A4 masa kartları aynı ekrandan yazdırılır; "Kodu yenile" yeni kod
  üretir, eski kod siteye `active: false` ile gider (sitede de kapanır; site ucu gelene dek eski kart menüyü açmaya
  devam eder, sipariş kodla değil etiketle eşlenir). Liste sitenin sınırını (200 masa, `PANEL_TABLES_MAX`) aşmaz:
  canlı masalar tam, emekli kodlardan en yenileri sığdığı kadar (eskiler sitede zaten kapandı; aşan liste 400 alır ve
  hiçbir kod gitmezdi). Sipariş eşlemesi önce `tableCode` (yalnız etkin masa; aşağıda),
  sonra yukarıdaki etiket kuralı.
  Sitenin LafPOS'un kodunu tanıması için sözleşmeye iki alan eklendi; ikisi de **laffogato#268 (28 Ekim 2026) ile
  sitede**:
  1. `GET /api/panel/orders` masa siparişinde `tableCode` (siparişin `orders.tableCode` anlık görüntüsü; eski site
     göndermez, LafPOS etiketle eşlemeye düşer).
  2. İmzalı `PUT /api/panel/tables` (LafPOS'un anahtarı) `{ tables: [{ code, name, active }], actor }`: kodu
     `cafe_tables`'a ekler (yeni satır, `rotatedAt` boş) ya da aynı kodlu satırın adını ve etkinliğini günceller;
     listede olmayan, sitede tanımlı masaya dokunmaz; `active: false` sitede devre dışı bırakır. Liste en çok 200
     masa, gövde en çok 64 KB. 200 `{ ok: true, count, created, updated, unchanged }`, 400 `{ error: "invalid", field }`,
     401, 413 `too_large` (64 KB'ı aşan gövde), 503 `not_configured` (sitede `LAFPOS_SYNC_SECRET` yok) ya da
     `unavailable` (veritabanına yazılamadı). LafPOS kod üretince, yenileyince ve QR'lı masanın adı ya da etkinliği
     değişince tam listeyi giden kutusundan gönderir (kind `tables.sync`, tek kayıt, son liste geçerli).
     Site 404 / 405 / 501 dönerse "site henüz almıyor" sayılır, kayıt kalır ve 6 saatte bir yeniden denenir (kod
     üretimi ve Yönetim › Entegrasyon'daki "Şimdi yeniden gönder" (`POST /api/admin/tables/qr/sync`) hemen dener);
     400 / 403 / 409 / 413 / 422 park edilir; 503 ve ağ hatası artan beklemeyle (en çok 6 saat) yeniden denenir.
- **Kapanış:** site listeyi keserse (`complete: false`, en çok 200 sipariş) ya da okunamayan kalem varsa LafPOS
  `closed`'da adı geçenler dışında hiçbir siparişi kapatmaz. Bütün listede olmayan açık online sipariş "Siteden kalktı"
  diye kapanır (`extStage = 'gone'`): servis edilmiş sayılmaz, bar ve çağrı ekranından düşer, denetim kaydına yazılır.
  Neden kalktığını `closed` söyler (`orders.extOutcome`; denetim metni "sitede iptal edildi" gibi); `closed`
  göndermeyen site için "sitede tamamlandı, iptal edildi ya da süresi geçti". Sonucu sonradan gelen kapanmış siparişe
  de yazılır. **Sitede iptal ya da iade edilen** (`cancelled`, `refunded`) ve kasada ödenen (`till`) sipariş "Online
  (sitede ödendi)" toplamına (Z, Raporlar, Uzaktan özet; `onlineCounted`) girmez: site ve lafmaliyet'in online kanalı
  onu saymaz. Sonucu bilinmeyen sayılır. Yerelde kapanmış ama sitede hâlâ açık görünen sipariş yeniden açılır (sonucu
  silinir). LafPOS'ta son aşamaya getirilen sipariş `extStage = 'done'` kapanır.
- **Kasada ödenen** (`paidAtTill: true`; uygulama siparişinde kart düştü, müşteri kasada ödedi, personel sitede
  "Ödendi olarak işaretle"): parası ve mali fişi kasanındır, site onu `counter` sayıp online cirodan ve tüketim
  satırlarından çıkarır. LafPOS onu **yazmaz**: "sitede ödendi" kaydı açılmaz, bara fiş düşmez, toplama girmez; tek fiş
  ve tek satış personelin çaldığı adisyondur (§8 personel yordamı). Cihazlara bir kez uyarı düşer (`orders` ›
  `online.till`, "Online sipariş #N kasada ödendi; adisyon olarak çalın"; ses ve bildirim) ve denetim kaydına uyarı
  (`online.paid_at_till`); görülen kimlik 48 saat saklanır (`sync_state` `laffogato.paidAtTill`), uyarı tekrar etmez.
  Önceden "sitede ödendi" yazılmış sipariş (alan sonradan geldi) kapanır (`extOutcome = 'till'`), hazırlanmamış
  kalemleri bar ekranında iptal görünür. Faz 2 L5 aynı alanla siparişi site fiyatlarıyla açık adisyona çevirebilir.
- **Kalem iptali** (sitede `changeItemStatus`, paid/preparing siparişte satır "İptal"): site satırı listeden çıkarır,
  tutar değişmez. LafPOS kalemleri her çekimde uzlaştırır: satırın konumu (`lines[].index`, LafPOS'ta
  `order_items.extLine`) listede yoksa kalem iptal olur (`voidReason` "Sitede iptal edildi", bar ekranında 10 dakika
  "iptal" görünür, denetim `online.line_cancelled`); servis edilmiş kaleme dokunulmaz. Sitede "Bekliyor"a geri alınan
  satır kalemi geri açar (`online.line_restored`), LafPOS'ta hiç olmayan satır eklenir. Konum gelmeyen (eski) sitede
  satırlar içeriğiyle (ürün, boy, seçenek metni, not, adet) sayılarak eşlenir; aynı iki satırdan hangisinin iptal
  edildiği ayırt edilemez, birinin iptali yeter. Konumu yazılmamış eski kalem, site konum göndermeye başlayınca içeriği
  tutan satırın konumunu alır. Tutar ve `extTotal` değişmez (para sitede). Siparişin bütün satırları iptal edilirse
  sipariş listeden düşer ("Kapanış").
- **Aşama:** site 409 `wrong_branch` dönerse sipariş başka şubenindir, yeniden denenmez (§2 "Şube"). 409 (`stale`,
  sipariş bu arada değişti) ya da 404 (`not_found`, "Sipariş sitede bulunamadı")
  dönerse liste yeniden çekilir.
- **Bar istasyonu** (21 Kasım 2026): kalem, sitenin `menuItemId`'sine bağlı LafPOS ürününün ya da kategorisinin
  istasyonuna düşer. Ürün LafPOS'ta yoksa (menü henüz eşitlenmedi, sitede yeni açılan kalem) ya da ürünün ve
  kategorisinin istasyonu yoksa barın istasyonuna (`kind = 'bar'`, yoksa `mutfak`; menü eşitlemesinin kuralı) düşer:
  sitede ödenmiş sipariş bar ekranından ve çağrı ekranından kaybolmaz. Ürünü ya da istasyonu boş kalmış kalem (eski
  sürüm, sonradan eşitlenen menü) sonraki çekimde yeniden bağlanır (ürün, KDV oranı, istasyon); tutar ve iş günü
  değişmez.
- **Planlı sipariş** (`scheduledFor`, 21 Kasım 2026): kalemlerin bar ekranına gönderim anı (`order_items.sentAt`)
  ödeme anı değil, `max(ödeme anı, planlı saat − 30 dk)`'dır; saat sitede değişince yeniden damgalanır. Geceden
  ödenmiş sabah gel-al'ı bar ekranının ve çağrı ekranının penceresinde (açık günün başı, en az 12 saat; gün yoksa 24
  saat) ve sesli uyarının 4 saatlik penceresinde (§2.5) saatinde görünür, erken ödenmiş sipariş ödendiği anda
  "gecikti" diye kızarmaz. Para, iş günü ve ödeme anı (`orders.openedAt`) değişmez. Yalnız saati ya da kaleminin
  bağlantısı değişen sipariş `online.detail` yayar (`online.updated` cihazın zilini susturur, sipariş hâlâ yeni).
- **Masa çağrıları** (21 Kasım 2026; laffogato 6 Kas 2026, `src/lib/admin/table-calls-core.ts`): uygulamada masadan
  "Garson çağır", su, peçete. Site açık çağrıları sipariş listesinin yanında verir: `calls: [{id, tableCode, label,
  reason, createdAt}]` (en eskisi önce, en çok 50, 15 dakikadan genç ve yanıtlanmamış; misafirin adı yok). **Yeni
  istek yok:** çağrılar sipariş çekimiyle gelir, sinyal değişince (çağrı yazımı sitenin `live:orders` etiketini
  düşürür). Okunamayan satır (kimlik, etiket ya da zaman yok) atlanır; bilinmeyen sebep "Çağırıyor" diye görünür; alanı
  göndermeyen eski site eldeki listeye dokunmaz. Masa siparişlerin kuralıyla bulunur (önce QR kodu, sonra etiket);
  bulunamazsa sitenin etiketiyle görünür. Liste `sync_state` (`laffogato.calls`) içinde durur ve her başarılı çekimde
  yenisiyle değişir: listeden düşen çağrı (sitede ya da köşkün panelinde yanıtlandı, süresi geçti) LafPOS'tan da düşer,
  15 dakikası dolan çağrı liste yenilenmeden de düşer. Yeni çağrı `tables` › `site.call.new` yayar ("Masa 4 · Su
  istiyor"; yalnız masa ve sebep), cihazlarda çalar (§2.5) ve masa planında masanın kartında mor zil rozeti çıkar.
  **"Gördüm"** (`POST /api/sync/calls/:id/ack`; `siparis.al` ya da `mutfak.ekran`) çağrıyı sitede yanıtlar (imzalı
  `POST /api/panel/calls/ack {id, actor, branch}` (`branch` 22 Kasım 2026, §2 "Şube"), `actor` kullanıcının adı en çok 80 karakter; site
  `lafpos:<ad>` yazar), sonra yerelde düşürür, denetim kaydına yazar (`table.call_ack`) ve `site.call.done` yayar:
  bütün cihazlarda susar. Site 404 (çağrı sitede yok) ya da 409 `wrong_branch` (başka şubenin) derse yine düşer; siteye ulaşılamazsa ya da site başka bir kod
  dönerse 502 `site_call`, çağrı açık kalır, yeniden denenir. LafPOS'ta yanıtlanan çağrı, yanıttan önce istenmiş bir
  listede gelse de geri gelmez; daha yeni bir listeden önce istenmiş (ağda gecikmiş) liste yok sayılır. Bilgisayarın
  saati geri alınırsa (Windows saat eşitlemesi) saklanan an ileride kalır: liste yine işlenir, an bugünün saatine döner
  (siparişlerin kuralı).

**Tükendi kilidi** (`products.soldOutBy`): LafPOS'un kapattığı ürün (kasadan, bardan, porsiyon bitince) `lafpos`,
sitenin kapattığı (senkron) `site` diye işaretlenir. Şubeli site panel menüsünde `onMenu` gönderir: kilit yalnız
sitenin menüden kaldırdığı kalemde (`onMenu: false`); menüde olup yalnız bu şubede Tükendi olan kalem (kasa ya da köşkün
paneli kapattı) `lafpos` sayılır, site onu LafPOS'tan açtırır. `onMenu` göndermeyen eski sitede sitenin kapattığı her
kalem kilitlidir. Kasiyer (`urun.tukendi`) yalnız `lafpos`'u açar; kilitli olan kasada "Sitede satışta değil" diye
görünür, düğmesi yoktur, sunucu 403 `site_closed` döner. Menü yetkisi olan (`menu.yonet`) açmayı dener: açış önce
siteye yazılır, denetim kaydına "sitede kapatılmıştı" düşer. Site menüden kaldırılmış kalemi LafPOS'a açtırmaz (409
`site_closed`): kasa "Site bu ürünü menüden kaldırmış; sitenin yönetim panelinde menüye geri koyun" der (409), yerelde
değişmez; internetsizken kuyruğa giren açış aynı metinle Entegrasyon'da kalır, sonraki eşitleme kasada da kapatır.

**İnternet yokken Tükendi** (Tükenen ürünler penceresi, Yönetim › Ürünler; `POST /api/sync/products/:id/availability`):
kasada elle Tükendi / Satışa aç internetsiz de çalışır. Siteye ulaşılamazsa (ağ hatası, 8 sn'lik zaman aşımı; ya da
site 5xx/429 dönerse) değişiklik yerelde hemen geçerli olur, yazım giden kutusuna kimin bastığıyla girer (aşağıda
"Porsiyon": ürün başına tek kayıt, son istenen durum) ve yanıt `{ site: 'kuyrukta', neden: 'internet' | 'site' }`
olur. İnternetin olmadığı zaten biliniyorsa (son dış istek ağ hatası aldı, `server/lib/internet.ts`) istek hiç
denenmez: kasiyer her dokunuşta zaman aşımını beklemez. Kasiyere kısa uyarı: "Americano tükendi. İnternet yok: kasada
uygulandı, site internet gelince güncellenecek" (site 5xx'te "Site şu an yanıt vermiyor: ... site düzelince
güncellenecek"; `shared/tukendi.ts`). Üst çubuktaki "İnternet yok · N kayıt bekliyor" rozeti bekleyen yazımı sayar
(yazım kuyruğa girince her cihazda hemen yenilenir). Arada aynı ürüne yeni bir değişiklik gelirse eski bekleyen
düşer, siteye yalnız sonuncusu gider; siteye doğrudan yazılan değişiklik de aynı ürünün bekleyenini düşürür. İnternet
gelince (`server/sync/catch-up.ts`) yazımlar kayıt sırasıyla ve tam bir kez gider; o ana dek menü eşitlemesi ürünün
Satışta bilgisine dokunmaz (site görüntüsü yazımdan eskidir). Site açıkça reddederse (4xx) yerelde de hiçbir şey
değişmez, 502 `site_menu` (bugünkü gibi); kuyruktaki yazımı site sonradan reddederse yazım "site reddetti" diye
Entegrasyon'da kalır, sitenin durumu geçerlidir. Tükendi kilidi internetsiz de geçerlidir: sitenin kapattığını kasiyer
açamaz (403), menü yetkisi olan açar, açış kuyruktan gider. Porsiyon doldurma (Yönetim › Ürünler) kuyruğa girmez:
önce site, site yanıt vermezse hiçbir alan kaydedilmez (aşağıda "Porsiyon"). Seçeneğin Tükendi'si zaten yalnız
LafPOS'tadır. Testler: `tests/internetsiz-tukendi.test.ts`.

**Seçenek tükendi** (`option_items.soldOut`, göç 0013): yulaf sütü bitince kasiyer ya da bar (`urun.tukendi`, menü
yetkisi olan da) Tükenen ürünler › Seçenekler'den seçeneği Tükendi yapar ve açar (`POST /api/option-items/:id/sold-out
{soldOut}`; denetim kaydı `menu.option_sold_out`, `menu` olayıyla bütün kasalar anında görür). Site grubunun seçeneği de
işaretlenir. Sözleşmede böyle bir alan olmadığı için siteye ve uygulamaya gitmez; menü senkronu ve Yönetim › Seçenekler
düzenlemesi işarete dokunmaz, gün açılışında sıfırlanmaz (ürünün Tükendi'si gibi). Seçenek penceresinde tükenen seçenek
gri ve "Tükendi" yazar, seçilemez. Varsayılanı tükenen grup önseçili gelmez. Zorunlu grupta (Türk kahvesinde Orta şeker)
başka biri seçilene kadar Ekle kapalıdır, hızlı ekleme de pencereyi açar. İsteğe bağlı grupta (Normal süt) satış
durmaz: grup başlığında yalnız bilgi notu ("Normal tükendi") çıkar, Ekle açıktır, hızlı ekleme pencere açmaz ve sunucu
o grup için seçenek yazmaz. Site Süt ve Kavrum gruplarını sudan çaya bütün içeceklere bağlar; normal süt bitti diye su
ve espresso satılamaz olmasın, yerine Laktozsuz ya da Yulaf da yazılmasın (lafmaliyet'e yanlış `ALTERNATIF SÜT`
satırı, fazladan ek fiyat). Pencere açıkken tükenen ya da sepetteki gönderilmemiş satırda açıkça seçilmiş seçenek seçili
kalır (seçim, not ve adet korunur): grubu "Yulaf tükendi, başka birini seçin" (isteğe bağlı grupta "... ya da bırakın")
der, alt çubuk aynı nedeni "Süt: ..." diye yazar, Ekle / Güncelle kasiyer onu bırakana ya da başkasını seçene dek
kapalıdır. İsteğe bağlı grubun varsayılanı (pencerenin önseçtiği Normal süt) seçili olsa da seçim sayılmaz: tükenince
pencere onu bırakır (yalnız bilgi notu, Ekle açık), sepetteki satır işaretlenmez, Gönder onu satırdan çıkarır ve sunucu
o grup için seçenek yazmaz (Su süt yazılmadan satılır; `sendableOptions`). Sepetteki gönderilemeyecek satırın altında
kırmızı neden yazar ("Yulaf tükendi", "Orta tükendi, şeker seçin", grubu kapandıysa "Seçeneği kalktı, düzenleyin");
dokununca düzenleme penceresi açılır. İşaretsiz satırın sepette, "Öde" düğmesinde ve müşteri ekranında görünen tutarı
ve seçenek metni sunucunun yazacağıyla aynıdır (`menuUnit`, `pendingOptionsText`): seçimi olmayan tek seçimlik grupta
varsayılan, tükenmemişse, ücretiyle ve adıyla girer. Ücretli varsayılan (Karton +₺5) satır eklenirken tükenikti ve satır
sepetteyken satışa açıldıysa sepet ₺85 ve "Karton" gösterir, sunucu da onu yazar; iki boylu ürünün pencere açılmadan
eklenmesi de böyle (`tests/secenek-tahmin.test.ts`, node ve sql.js). Pencere açıkken ürünün bir grubu kapanır ya da
açılırsa, seçenek tükenir ya da satışa açılırsa seçim uzlaştırılır (`reconcilePicks`): kapanan grubun seçimi atılır;
seçimi boşalan her isteğe bağlı tek seçimlik grubun (yeni açılan, varsayılanı yeniden satışa açılan, seçili seçeneği
kaldırılan) varsayılanı seçili gelir, ücretli varsayılan ekranda görünmeden ücrete girmez. Sunucu yalnız kasa satışını
(`POST /api/orders/:id/items`) reddeder: tükenen seçenek açıkça seçildiyse (her grupta) ya da zorunlu tek seçimlik grup
boş gönderildi ve varsayılanı tükendiyse 409 `option_sold_out` ("Yulaf tükendi", "Orta tükendi; Şeker seçin"). Siteden
gelen ödenmiş sipariş ve paket platformu siparişi reddedilmez.

**Porsiyon:** siteye bağlı ürünün porsiyonu bitince Tükendi yazımı adisyon kalemiyle aynı işlemde giden kutusuna
girer (`outbox`: target `laffogato`, kind `menu.isActive`, ürün başına tek kayıt `menu:<extId>`, son istenen durum) ve
hemen gönderilir. Hazırlanmadan iptal edilen kalemle porsiyonu sıfırdan dönen ürün yerelde açılır, aynı kayda
"Satışta" yazımı girer (bekleyen Tükendi'nin yerini alır). Gönderilemeyen yazım artan beklemeyle yeniden denenir;
site 404 dönerse (kalem sitede yok) yazım tamamlanmış sayılır, 400/403/409/413/422 dönerse "site reddetti, yeniden
denenmeyecek" diye Yönetim › Entegrasyon ve Genel bakış'ta görünür (anahtar yokken sayılmaz). Ürün bu arada başka
yoldan açılır ya da kapanırsa kayıt düşer. Porsiyon doldurulunca (Yönetim › Ürünler) kapalı ürün önce sitede açılır,
2xx'ten sonra yerelde; site kabul etmezse hiçbir alan kaydedilmez. Siteye giden bütün Satışta yazımları ve menü
eşitlemesinin panel okuması sırayla gider (tek kilit): geç kalan bir "kapalı" yeni bir açılışın üstüne yazılmaz.
Giden kutusunu lafmaliyet de kullanır; her biri yalnız kendi kayıtlarını gönderir.

### 2.4 Karaoke rezervasyonları (yalnız okuma)

Karaoke odası sitede (`/karaoke` ve uygulama) rezerve edilir ve çoğunlukla orada ödenir; sitede ödenen saat online
karaoke cirosudur (laffogato `docs/PANEL-SALES.md`, lafmaliyet onu sitenin satışlarından ekler). LafPOS bugünün
rezervasyonlarını okur: oda sitede rezerveyken kasada boş görünmesin, sitede ödenmiş saat kasada yeniden ücretlenmesin.
Rezervasyonu yalnız site yazar, taşır, iptal eder; LafPOS hiçbir şey yazmaz. Kod: `server/sync/laffogato-karaoke.ts`
(okuma), `shared/karaoke.ts` (kurallar), `server/services/rooms.ts` (ücret).

**Uç:** `GET /api/panel/karaoke?from=<iş günü>&to=<iş günü>`, imzalı, LafPOS anahtarıyla (laffogato#264; yanıt panelin
aldığıyla aynı, laffogato `docs/LAFPOS.md` › "Karaoke satırını kasa nasıl okur"). Pencere kasanın iş günüdür (05:00
kuralı, `from = to`); rezervasyon en geç 24:00'te biter, gece yarısını aşmaz. Site LafPOS'un anahtarına yalnız dünden
yarına (İstanbul) açar; daha geniş pencere 403. Hiç istek gitmez: `.env`'de `LAFFOGATO_URL` ya da
`LAFFOGATO_SYNC_SECRET` yoksa ya da planda oda türünde (`kind: 'oda'`) etkin masa yoksa. Oda Tuzla'nındır: başka şube
adına site boş liste verir (§2 "Şube").

```json
{ "now": "…", "from": "2026-10-27", "to": "2026-10-27", "complete": true,
  "reservations": [ { "id": "krk-00044", "date": "2026-10-27", "startHour": 20, "hours": 2,
    "startsAt": "…", "endsAt": "…", "guests": 4, "status": "confirmed", "paymentStatus": "paid",
    "firstName": "Ayşe", "note": "Doğum günü", "totalMinor": 180000, "channel": "web" } ] }
```

LafPOS `id`, `date`, `startHour`, `hours`, `guests`, `status`, `paymentStatus`, `firstName`, `note`, `totalMinor` ve
`channel`'ı okur (`startsAt`/`endsAt` gün ve saatten yeniden hesaplanır, İstanbul sabit UTC+3); `createdAt`/`updatedAt`
ve `refundMinor` okunmaz. `refundMinor` (laffogato 29 Ekim 2026, ekleme) iptal edilmiş rezervasyonun iade tutarıdır;
`0` hiçbir şeyin geri gitmediğini söyler (sitede %0 kuralında misafirin geç isteğiyle saat satışa açıldı, ödeme
durumu yine `refunded`). Kasa iptal satırını ödeme durumundan önce "İptal" diye okur ve hiçbir şeye saymaz, bu yüzden
tutar kasada bir şey değiştirmez; köşkün panelindeki (lafmaliyet) bar ekranı onu "iade yok" yazmak için okur.
`reservations` dizisi olmayan 200 başarısız çekimdir, eldeki liste silinmez; okunamayan bir satır listeyi düşürmez.
Bilinmeyen durum sitenin kuralıyla güvenli tarafa okunur: bilinmeyen `status` `requested`, bilinmeyen `paymentStatus`
`none`.

**Satır nasıl okunur** (sitenin kuralı, `shared/karaoke.ts`):

| `status` | `paymentStatus` | Oda | Blok kasada | "Sayacı başlat"ta |
| --- | --- | --- | --- | --- |
| `requested` / `confirmed` | `paid` | tutulu | sitede ödendi: yalnız bloğu aşan süre, odanın saat ücretiyle | önerilir |
| `requested` / `confirmed` | `none` | tutulu | köşkte ödenecek: blok satırın `totalMinor`'ı (üye indirimi içinde), aşan süre saat ücretiyle; `totalMinor` 0 (köşkün telafi saati) ücretsiz | önerilir |
| `requested` | `pending` | tutulu | sayaç durunca ödenmişse `paid`, değilse bütün süre saat ücretiyle | önerilir |
| `requested` / `confirmed` | `refunding`, `refunded`, `expired` | tutulu | yok: bütün süre saat ücretiyle | önerilmez |
| `cancelled` | herhangi | boş | yok | önerilmez, masa planında görünmez |

**Ne zaman çekilir** (`AGENTS.md` kural 6: bu okuma sitenin veritabanına gider):
- Sürüm sinyalinin (20 sn) `karaoke` değeri değişince ya da iş günü dönünce, **açık iş günü varken**, otomatik çekimler
  arası en az 5 dakika. Gece (açık gün yokken) hiç; gün açılınca ilk turda bir kez. `karaoke` alanı olmayan (eski) site:
  günde bir, gün açılınca. Sinyal siparişlerle ortaktır ama "Online siparişleri çek" anahtarına bağlı değildir: anahtar
  kapalıyken sipariş çekilmez, sinyal yalnız karaoke için ve yalnız gün açıkken (planda oda varken) okunur. Yönetim ›
  Entegrasyon'daki site kartı son çekimi, rezervasyon sayısını ve son hatayı gösterir.
- Oda kutusu açılınca liste geride kaldıysa: sinyal canlıysa yalnız işaret değiştiyse, değilse liste 5 dakikadan
  eskiyse. Sayaç dururken bağlı rezervasyon varsa aynı kural (ödemesi bu arada tamamlanmış olabilir).
- Elle "Yenile" (oda kutusu): en sık 30 saniyede bir.
- 401, 403 ya da 503 `not_configured`: "site karaokeyi LafPOS'a açmadı"; otomatik çekim 30 dakika bekler, oda kutusu
  bunu sakin bir notla söyler. Diğer hatalarda eldeki liste "güncel olmayabilir" notuyla gösterilir.

**Oda sayacı.** Oda kutusu listeyi alırken "Başlat" bekler ("Rezervasyonlar yükleniyor"): sitede ödenmiş rezervasyon
görünmeden sayaç rezervasyonsuz başlamaz. Bağlanabilir (tabloda "önerilir") ve bitmemiş bir rezervasyon varsa ya da
liste okunamadıysa seçim penceresi açılır: önce o saate düşenler (başlangıcına en çok bir saat kalmış), sonra "Bugün
daha sonra" (erken gelen grup). Seçilen rezervasyon sayaca bağlanır (`room_sessions.bookingId`; `booking`: ad ve not
olmadan koşulun anlık görüntüsü; `prepaidMinutes`: bloğun bu oturuma düşen kalanı). Aynı rezervasyon aynı anda tek
sayaca bağlanır; listede olmayan ya da bağlanamayan (iptal, iadesi süren, ödeme süresi dolmuş) rezervasyon 409.
"Rezervasyonsuz başlat" bugünkü gibi çalışır. Rezervasyonsuz başlamış, çalışan sayaç sonradan "Rezervasyona bağla" ile
bağlanır (`POST /api/orders/:id/room/link {bookingId}`, `siparis.al`; aynı kurallar, blok sayacın başladığı andan
sayılır, denetim kaydına `room.link`); bağlı sayaç ikinci kez bağlanmaz (409 `room_linked`).

**Ücret** (sayaç durunca, rezervasyonun o anki durumuyla):
- Blok süreyle ölçülür, saatle değil: geç gelen grup bloğunu yine tam kullanır, erken gelen bloğu erken bitirir.
- Bloğu aşan süre bugünkü kuralla faturalama adımına yukarı yuvarlanır ve odanın saat ücretiyle alınır; en az süre
  kuralı bloğa uygulanmaz. Sitede ödenen blok içinde kalan oturum adisyona satır yazmaz, denetim kaydına "kasada ücret
  yok" düşer.
- Satır oda hizmet ürünüdür (KDV ürünün oranı), metni "aşan 30 dk (2 sa sitede ödendi)" ya da "1 sa rezervasyon +
  30 dk", notu "Site rezervasyonu KRK-00044".
- Sayaç durdurulup yeniden başlarsa bloğun kalanı geçer; köşkte ödenecek blok tutarı bir kez alınır. "Alındı" yalnız
  gerçek satıra bakar (`room_sessions.blockCharge` ve `itemId`): o satır iptal edildiyse ya da adisyonu iptal olduysa
  tutar sonraki oturumda yeniden yazılır; iptal edilen adisyonun oturumu bloktan da düşülmez.
- Rezervasyon kendi gününün okunan listesinden düştüyse (panel başka güne taşıdı) blok o güne aittir, burada sayılmaz;
  oturum koşulu saklamaz (`booking` null), rezervasyon geri gelirse bloğu tam ve tutarıyla geçer. Liste başka güne
  aitse (iş günü döndü) ya da site ulaşılamıyorsa bağlanırken saklanan koşul geçer.
- Süre "Durdur"a basıldığı andan ölçülür: sayaç dururken siteden yapılan okuma (en çok 8 sn) ücrete eklenmez.
- Blokta kalan oturum satır yazmaz; adisyonda başka kalem ve ödeme yoksa adisyon da kapanır (`kapali`, 0 TL; denetim
  kaydında "boş adisyon kapandı"), oda planda boşalır.

**Ekranlar.** Adisyondaki oda kutusu: sayaç, bağlı rezervasyonun bloğu ("blokta 40 dk kaldı"), bugünün odayı tutan ve
bitmemiş rezervasyonları (saat, ad, kişi, ödeme durumu, not), "Yenile". Masa planı: boş oda kartında sıradaki
rezervasyon, yan listede bugünkü rezervasyonlar. Rezervasyon ekranında oda seçilmez. Oda kutusunun listesi
(`GET /api/sync/karaoke`) `siparis.al` ya da `rezervasyon.yonet` ister. Masa planındaki satırlar (saat, ad, kişi,
ödeme durumu) planı gören herkese görünür; serbest metin not yalnız bu iki yetkiden birine (bar ekranı, kurye gibi
roller notu boş alır).

**Yerel rezervasyon.** Oda türündeki masaya yerel rezervasyon (`POST`/`PATCH /api/reservations`) 409
`room_reservation`: "Karaoke rezervasyonu sitedeki /karaoke'den alınır". Masa rezervasyonu (kafenin kendi defteri)
olduğu gibi kalır.

**Saat ücreti.** Yönetim › Masa planı açılınca sitenin karaoke saat ücreti herkese açık
`GET /api/mobile/v1/karaoke/availability`'den (`hourlyMinor`) okunur: ekran başına bir istek (sunucuda bir dakikalık
önbellek), otomatik yoklama yok, yalnız `LAFFOGATO_URL` varken ve planda oda varken. Odanın saat ücreti farklıysa ekran
uyarır: aşan süre kasada odanın ücretiyle alınır.

**Kişisel veri.** Siteden yalnız ad, gün ve saat, kişi sayısı, durumlar, not, tutar ve kanal gelir; soyad, e-posta,
telefon, ödeme referansı gelmez (sitenin `toPanelReservation` beyaz listesi). LafPOS listeyi yalnız son okunan iş
günü için tutar (`sync_state`, yeni gün gelince üzerine yazılır); sayaç oturumunda, adisyon satırında ve denetim
kaydında ad ve not yoktur, yalnız rezervasyon kodu. LafPOS Uzaktan'a giden özette site rezervasyonunun adı, notu ve kodu (KRK-…; oda satırının notunda da) yoktur: yalnız
saat, kişi sayısı ve ödeme durumu. Laffogato `docs/LAFPOS.md` "Kişisel veri" rezervasyonu yalnız kafedeki makineye
açar.

### 2.5 Sesli uyarılar (20 Kasım 2026)

Operatör: "diğerlerine sipariş, karaoke gelince LafPOS'ta da ötsün, ses çıkarsın ki ayarlama yapabilelim". Uyarılar
yalnız var olan çekimlerden doğar (§2.3 online siparişler, §2.4 karaoke): **yeni uç, yeni alan, yeni istek yok**, sıklık
değişmez (`AGENTS.md` kural 6); LafPOS siteye yalnız masa çağrısının "Gördüm"ünü yazar (kullanıcı işlemi, §2.3 "Masa
çağrıları"), siparişin ve karaokenin "Gördüm"ü yalnız o cihazda kalır. Kod:
`shared/site-alerts.ts`, `src/lib/siteAlerts.ts` (kurallar), `src/components/SiteInbox.tsx` (şerit ve ses),
`src/lib/sound.ts` (zil); olay türleri `shared/events.ts` `SITE_EVENT`.

- **Yeni online sipariş** (uygulama, web, masa QR): sitenin panelindeki ve köşk bar ekranındaki (ladmin) zille aynı
  motif (Do6, Mi6, Sol6, iki kez; sıkıştırıcıdan) 3 saniyede bir çalar, masa siparişi biraz daha yüksek; ekranın üstünde
  mor şerit durur ("Yeni online sipariş · #10101 · Masa 4", dokununca liste, "Aç" adisyonu açar). Susar: o cihazda
  "Gördüm" (24 saat hatırlanır), sipariş o cihazda açılınca, aşaması değişince (LafPOS'ta, sitede ya da köşkte
  "Hazırlanıyor"), siteden kalkınca ya da ödemesinden 4 saat geçince. Duyan: `siparis.al` ya da `mutfak.ekran`. Liste
  `GET /api/sync/alerts` (aynı yetki; yalnız yerel veritabanı, açık ve sitede hâlâ `new` aşamasındaki siparişler).
  Bar ekranı online fişte kendi sesini çalmaz (kabuğun zili çalıyorsa). Planlı siparişin 4 saati planlı saatinden 30
  dakika önce başlar (`dueAt`, §2.3 "Planlı sipariş"): geceden ödenmiş sabah siparişi o ana dek çalmaz, saati gelince
  çalar. Saatinden önce denen "Gördüm" (aşaması ya da masası değişti, ekranda açıldı) onu susturmaz: cihaz "Gördüm"ü
  planlı siparişte saatiyle hatırlar (`kimlik@dueAt`), saati sitede değişen sipariş yeni saatinde yine çalar.
- **Masa çağrısı** (§2.3 "Masa çağrıları"): aynı zil, aynı döngüde, masa siparişi gibi tam düzeyde; şeridin başında
  ("Masa çağrısı · S4 · Su istiyor") ve bildirim "Masa çağrısı · S4 · Su istiyor". "Gördüm" çağrıyı sitede yanıtlar,
  bütün cihazlarda susar; site yanıtı almazsa çağrı her cihazda açık kalır. Sitede ya da köşkte yanıtlanınca ya da 15
  dakika dolunca da susar. Duyan ve yanıtlayan: `siparis.al` ya da `mutfak.ekran`; tercihi online siparişle bir.
  Liste aynı `GET /api/sync/alerts`'in `calls` alanı (yalnız yerel kayıt).
- **Siteden kalkan sipariş** (§2.3 "Kapanış"): tek sakin nota ve bildirim "Online sipariş #N siteden kalktı".
- **Karaoke:** aynı iş gününün iki listesi kıyaslanır, günün ilk listesi kıyaslanmaz (sabahtan beri alınanlar çalmasın).
  Yeni rezervasyon (iptal olmayan) bir kez zil, iptal edilen inen ses, saati ya da süresi değişen ve (iki liste de tamsa)
  günün listesinden düşen tek nota; bildirim "Yeni rezervasyon · Karaoke 20:00 · 2 sa · 4 kişi". Ad ve not uyarıya
  girmez. Duyan: `siparis.al` ya da `rezervasyon.yonet`. Çekim en sık 5 dakikada bir olduğu için uyarı o kadar gecikebilir.
- **Tercihler cihazda** (Araçlar › Sesli uyarılar): ses açık / kapalı (kapalıyken şerit ve bildirim kalır), düzey
  (Kısık, Orta, Yüksek), online sipariş ve karaoke ayrı ayrı, "Sesi dene". Tarayıcı sesi ancak sayfaya dokunulunca
  açar: kabuk ilk dokunuşta açar, kilitliyken şerit "Sesi açmak için dokunun" der.
- `.env`'de `LAFFOGATO_URL` yoksa (varsayılan; tarayıcı demosu da) hiçbiri çalmaz: liste boş, olay yok, istek yok.

## 3. LafPOS → lafmaliyet: elle yedek (CSV / kopyala)

Bağlantı kurulmamışken (ya da lafmaliyet'teki geçiş gününden önceki aylar için) gün sonu ve ürün satışları elle
aktarılır. Bağlantı kuruluyken günler §4 ile kendiliğinden gider; Raporlar › lafmaliyet aktarımı bunu söyler:
geçiş gününden sonraki günlerin listesi Satışlar'a yüklenmez (aynı satış iki kez sayılır; lafmaliyet geçiş gününden
sonraki ayın listesini reddeder).

### 3.1 Ürün satış listesi (Satışlar ekranına yükleme)

`GET /api/sync/lafmaliyet/satislar.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` (yetki: `rapor.gor`; Raporlar › lafmaliyet
aktarımı)

Dönem raporlarla aynı denetlenir: varsayılanı bugün (açık iş günü), olmayan tarih 422 `validation`, en çok
400 gün (daha uzunu 422 `range_too_long`), ters verilen tarihler çevrilir. Hücreler `server/lib/csv.ts` ile yazılır:
lafmaliyet'in yapıştırma ayrıştırıcısı tırnak bilmediği ve sekmeyi ayraç saydığı için POS adındaki satır sonu ve
sekme boşluğa, noktalı virgül virgüle döner (her satır bir ürün, üç hücre); `=`, `+`, `-`, `@` ile başlayan adın
başına `'` konur (Excel'de formül çalışmaz, lafmaliyet adın başındaki `'`'u atar).

```
Ürün;Adet;Tutar
LATTE MEDIUM;42;8.190,00
LATTE LARGE;17;3.570,00
KARAOKE ODASI;3;3.000,00
```

- lafmaliyet'in ayrıştırıcısı (`src/lib/calc/pos-paste.ts`) başlıktaki "Ürün / Adet / Tutar"ı tanır,
  noktalı virgülü ve Türkçe ondalığı okur. Tutar KDV dahil.
- **POS adı** (`shared/pos-name.ts`, kalem satışta dondurulur): ürünün `posName`'i yoksa `BÜYÜK HARF ad + boy
  eki` (M → `MEDIUM`, L → `LARGE`, tek boy ek yok; ekler ayarlardan değişir). `posName` doluysa tek boylu üründe
  olduğu gibi; **iki boylu üründe taban addır** ve boy eki eklenir (`LATTE` → `LATTE MEDIUM` / `LATTE LARGE`;
  sonuna boy eki yazılmışsa ikinci kez eklenmez). Boşluklar lafmaliyet'teki gibi sadeleşir (`trim`, art arda
  boşluk tek); boş ya da yalnız boşluk `posName` yok sayılır, ad ürünün adından gelir (oda satırı dahil).
  Satılmış kalemin adı dondurulmuştur, boy eki ayarı sonradan değişse de aynen gider (`soldPosName`). Yalnız boy
  eki olmadan saklanmış eski iki boylu kalem (`LATTE`) satılan boyun ekini alır (`LATTE LARGE`), M ve L birleşmez.
  lafmaliyet I/İ ve büyük/küçük harf farkını yok saydığı için ModPOS'tan öğrenilmiş `pos_mappings` kayıtları
  çalışmaya devam eder; tutmayan ad bir kez eşlenir.
- **Satır anahtarı `posName | siteMenuId | slot`** (ad harf farkı gözetmeden). lafmaliyet bir günde bir ada bir
  satır ister; aynı ad iki ayrı kaleme ya da boya düşerse ikincisine boy eki, yine çakışırsa site kimliği eklenir
  (`KAHVE MEDIUM (mnu-0006)`). Siteye bağlı satır `siteMenuId + slot` ile eşleştiği için ad yalnız bağsız (yerel)
  üründe önemlidir; bağsız satır adını korur. Aynı adı taşıyan iki yerel ürün tek satırda toplanır (ModPOS'taki
  gibi). Yönetim, başka bir ürünün ya da boyun adını taşıyacak `posName`'i 409 `pos_name_taken` ile reddeder.
- İkram ve iptal satırları listeye girmez (ciro değil); online ödenmiş siparişler girmez.
- Karaoke gibi `isService` ürünler aynı listede çıkar; lafmaliyet bunları HİZMET olarak eşler. Paket platformunun
  teslimat ya da ambalaj ücreti (`PLATFORM ÜCRETİ`, gizli ürün; oda sayacı karışmasın diye ürünü hizmet işaretsiz)
  gün sonu paketinde `isService: true` gider: mal maliyeti yazılmaz, net hizmet KDV'siyle hesaplanır. Ürün eşlemede
  başka ürüne bağlanmış ücret o ürünün adıyla normal satırdır.
- Masa servis ücreti `SERVİS ÜCRETİ` adıyla ayrı hizmet satırıdır (adet: servis ücretli adisyon sayısı).
  Satırların toplamı günün Z toplamına (`z_total`) eşittir.

### 3.2 Z özeti (Kasa raporu formuna)

Gün sonu ekranında, lafmaliyet Kasa raporu alanları **aynı sırada** gösterilir, "Kopyala" ile metin olarak
alınır, `GET /api/cash/days/:id/lafmaliyet.json` ile JSON indirilir.

| lafmaliyet alanı | LafPOS kaynağı |
| --- | --- |
| `z_no` | `business_days.zNo` (geçişte ModPOS'un son Z'sinden devam eder: Yönetim › Ayarlar › İlk Z numarası, §8) |
| `receipts` | tutarı 0'dan büyük kapanan POS adisyonu sayısı (online, iptal ve tamamı ikram adisyonlar hariç) |
| `z_total` | ödemelerin toplamı (cari tahsilat ve bahşiş hariç) |
| `cash` | `zField = cash` ödemeler (ödeme anında dondurulan Z alanı; beklenen nakit de aynı alandan hesaplanır, ödeme türü sonradan değişse de ikisi aynı ödemeleri sayar. Yönetim Z'de nakdi yalnız Nakit türüne verir) |
| `card` | `zField = card` |
| `meal_card` | `zField = meal_card` (Pluxee, Multinet, Edenred, Setcard, Metropol) |
| `online` | `zField = online` (yemek platformları) |
| `other` | `zField = other` (havale, açık hesap/cari dahil) |
| `off_revenue` | kapanmış adisyonlarda ikram edilen, ödenmez ve zayi kapanan kalemlerin menü değeri |
| `discounts` | kalem + adisyon indirimleri |
| `opening_cash` | gün açılış nakiti |
| `cash_out` | harcama türü kasa hareketleri |
| `counted_cash` | gün sonu sayımı |
| `handed_over` | teslim türü kasa hareketleri |
| `cash_in` | nakit satış dışında çekmeceye giren nakit: giriş türü kasa hareketleri, nakit cari tahsilatı, nakit bahşiş |
| `expected_cash` | beklenen nakit: açılış + nakit satış + `cash_in` − harcama − teslim |
| `cash_diff` | sayılan − beklenen nakit |

İş günü tarihi lafmaliyet ile aynı kuralla belirlenir: gün 05:00'ten önce açıldıysa önceki takvim günü.
**Dünden açık kalan güne satış yazılmaz:** gün sonu alınmadan 05:00 geçerse yeni adisyon, kalem ve oda sayacı
409 `stale_day` ile reddedilir ("Dünün günü açık (25 Ekim, Z 14). Önce gün sonunu alın"; Kasa ekranında aynı
bant). Ödeme, iptal, hesap bölme (kalemi yeni adisyona taşımak yeni satış değildir) ve gün sonu serbesttir;
böylece bugünün satışı lafmaliyet'e dünün tarihiyle gitmez. Otomatik gün sonu varsayılan kapalı kalır (sayımsız
kapatır).
**Bir iş gününe tek Z:** gün sonu alındıktan sonra aynı tarihte yeni gün açılmaz; kapanıştan sonra satış
gerekirse kasa ekranındaki "Günü yeniden aç" (yetkili onayı, neden zorunlu, denetim kaydına alarm) aynı Z
numarasıyla günü açar. Gün yeniden kapanınca lafmaliyet'e aynı tarih ve Z ile gider, öncekinin yerine geçer.

## 4. LafPOS → lafmaliyet: imzalı gün sonu (canlıda)

lafmaliyet'te canlı (lafmaliyet#34, #36; durum ve geçiş günü B07 #44, günlük satışlar B08 #46). Kafedeki sunucu
internetten erişilebilir olmadığı için "ping + çekme" yerine **imzalı itme**: LafPOS gün sonunda ve sonradan
düzeltmede (yeniden sayım, yeniden açılıp kapanan gün) aynı iş gününü yeniden gönderir (aynı `date` üzerine yazar,
idempotent). İstek giden kutusunda (`outbox`) bekler; internet yoksa artan beklemeyle sonra gider. `.env`'de
`LAFMALIYET_URL` ve `LAFMALIYET_SYNC_SECRET` yokken hiçbir şey kuyruğa girmez, istek gitmez. Kurulum modunda kapanan
gün (eğitim günü) hiç gitmez, kurulum modu sonra kapansa da (§4.3).

**Şube (`sube`, 4 Kasım 2026; 21 Kasım 2026'da güncellendi).** lafmaliyet ciroyu şubeye göre ayırır (lafmaliyet
`docs/SUBE.md`). Paket, kasanın şubesinin kimliğini taşır: Yönetim › Ayarlar'daki `branchId` (varsayılan `marina`),
lafmaliyet'teki kimliğin aynısı (harfle başlar, küçük harf / rakam / tire, 2-24 karakter). **Sahibin kararı (21 Kasım
2026): ilk LafPOS kasası Marina'da, Tuzla ModPOS'ta kalır.** lafmaliyet'te LafPOS'un şubesi tek sabittir
(`LAFPOS_BRANCH_ID = "marina"`): gün o şubeye yazılır, geçiş günü yalnız o şubenin kasasınındır, kilit ve Z denetimi
(gün, şube) başına. Paketin `sube`'si bundan başkaysa gün yazılmaz: 409 `wrong_branch` (kasa bunu kalıcı hata sayar ve
"Şube'yi düzeltip yeniden gönderin" der). Marina'nın ModPOS'u da yedek olarak çekilmeye devam eder (şubenin kasa
kaynağı lafmaliyet'te ModPOS kalır): geçiş gününden önce o sayılır, sonra LafPOS'un günü; ModPOS'unki saklanır ama
hesaba girmez. Tuzla da LafPOS'a geçince lafmaliyet'te LafPOS'un şubesi listeye döner (ayrı iş).

```
POST {LAFMALIYET_URL}/api/pos/gun
x-laf-timestamp, x-laf-signature (aynı kural; anahtar: lafmaliyet'te LAFPOS_SYNC_SECRET, LafPOS'ta LAFMALIYET_SYNC_SECRET)
{
  "version": 1,
  "source": "lafpos",
  "sube": "marina",
  "date": "2026-10-26",
  "z": {
    "zNo": 128, "receipts": 214, "zTotal": 45210.5,
    "cash": 12000, "card": 29110.5, "mealCard": 3100, "online": 0, "other": 1000,
    "offRevenue": 640, "discounts": 380,
    "openingCash": 1500, "cashOut": 450, "countedCash": 12980, "handedOver": 0, "cashDiff": -70,
    "cashIn": 0, "expectedCash": 13050, "cardTips": 120, "cardCollections": 400
  },
  "lines": [
    { "posName": "LATTE MEDIUM", "siteMenuId": "mnu-0007", "slot": "M", "qty": 42, "revenue": 8190, "isService": false },
    { "posName": "ALTERNATIF SÜT", "siteMenuId": "mnu-0082", "slot": "M", "qty": 9, "revenue": 175, "isService": false }
  ],
  "ikram": [
    { "posName": "LATTE LARGE", "siteMenuId": "mnu-0007", "slot": "L", "qty": 1, "menuValue": 210, "reason": "Doğum günü" },
    { "posName": "EXTRA SHOT", "siteMenuId": "mnu-0081", "slot": "M", "qty": 1, "menuValue": 50, "reason": "Doğum günü" }
  ],
  "payments": [
    { "name": "Pluxee", "zField": "meal_card", "channel": "pluxee", "count": 7, "amount": 1850 }
  ]
}
```

- Gövde en çok 256 KB, katı JSON. `date` ve `zNo` aynı olan ikinci istek öncekinin yerine geçer (idempotent,
  yeniden açılıp kapanan gün). Aynı `date` başka bir `zNo` ile gelirse lafmaliyet hiçbir şey yazmaz, 409
  `{ error: "z_conflict", date, zNo }` döner (`zNo` kayıtlı olanınki); LafPOS bir tarihe tek Z verdiği için bu
  yalnız elle karışıklıkta olur.
- `cashIn` ve `expectedCash` isteğe bağlıdır (eski gövdede yok): lafmaliyet beklenen nakdi bunlarla
  LafPOS'unkine eşitler; `cashIn` yoksa 0 sayar.
- `cardTips` (kartla bahşiş) ve `cardCollections` (kartla cari tahsilatı) isteğe bağlıdır, TL: banka POS'unun
  gördüğü ama Z'nin `card` alanına girmeyen tutarlar. lafmaliyet kart farkını bunlarla açıklar; okumayan sürüm
  alanı atar (`z.object`), yani gönderim sırası serbesttir.
  İşletme bahşiş almaz (Ayarlar `tipsEnabled` varsayılan kapalı, ödeme `tip > 0` 400 `tip_disabled`): `cardTips`
  yalnız eski kayıtlarda 0'dan büyük olur.
- `bankPos` (22 Kasım 2026, #154) isteğe bağlıdır: yazarkasa POS'unun (Pavo) banka gün sonu ve LafPOS kıyası. Yalnız
  günün banka gün sonu denendiyse ve bittiyse gider (`status` `ok`, `failed` ya da `unknown`; cihazda sürerken alan
  gitmez); Pavo yoksa ya da denenmediyse alan yoktur. `lafposCard` kartla bahşişi ve kartla açık hesap tahsilatını
  da içerir (ikisi de bankaya gider). Banka gün sonu çoğu zaman gün
  kapandıktan sonra biter: sonucu gelince aynı gün yeniden gönderilir (`date` ve `zNo` aynı, idempotent). Okumayan
  sürüm alanı atar (`z.object`).
  ```
  "bankPos": {
    "status": "ok",                     // ok · failed · unknown (alındı mı bilinmiyor) · running (sürüyor)
    "batchNo": "0042", "at": "2026-10-26T23:41:07.000Z",
    "pavoCard": 29230.5,                // cihazın bankalara gönderdiği kart toplamı (TL); bilinmiyorsa null
    "lafposCard": 29230.5,              // LafPOS'ta bankaya giden kart tutarı (kart ödemeleri ve kartla bahşiş, TL); aynı
                                        // günün ikinci gün sonunda yalnız öncekinden sonra alınanlar; bilinmiyorsa null
    "diff": 0,                          // pavoCard − lafposCard; ikisinden biri yoksa null
    "acquirers": [{ "name": "Garanti BBVA", "count": 51, "total": 18120.5 }],
    "message": null                     // başarısız ya da belirsizse cihazın ya da LafPOS'un açıklaması
  }
  ```
- **Ekler** (süt, şurup, ekstra shot) içeceğin satırından ayrı satırdır: `ALTERNATIF SÜT`, `SYRUP`, `EXTRA SHOT`;
  kimlik önce sitenin sabit kalemleri (`mnu-0082`, `mnu-0080`, `mnu-0081`), yoksa `extras` kategorisinde ada göre.
  Seçim fiyata göre değil **koda göre**: `milk` kodu `normal` değilse (laktozsuz süt 0 TL'dir ama alternatif
  süttür, ciro 0 satır), `syrup` kodu `none` değilse, ekstra shot adediyle. Satırın net cirosu ana ürün ve ekler
  arasında liste fiyatları oranında bölünür.
- `ikram` yalnız **kapanmış** POS adisyonlarından gelir (Z'nin `offRevenue`'uyla aynı kapsam; iptal edilen
  adisyonun ikramı tüketim değildir); ikram edilen içeceğin ekleri ayrı kayıttır, menü değeri satıştaki oranla
  bölünür. `ikram` menü değerlerinin toplamı `offRevenue`'a eşittir. Ödenmez kapanan adisyonun kalemleri
  (personel yemeği, patron hesabı) de buradadır; ayrı alan yoktur, `reason` "Ödenmez: " ile başlar
  (ör. `"Ödenmez: Personel yemeği"`); ödenmezin LafPOS'ta bağlandığı kayıtlı kişi (personel ya da müşteri) pakete
  girmez. Zayi yazılan kalem (döküldü, yanlış hazırlandı, bozuk; ödeme ekranındaki
  "Zayi" ya da kalem sayfasındaki "Zayi yaz") de aynı listededir, `reason` "Zayi: " ile başlar (ör. `"Zayi: Döküldü"`);
  lafmaliyet bunları `waste_entries`'e `kind = 'zayi'` ile alabilir. Ön ekler `shared/comp.ts` `compReasonText`.
- `payments` yemek kartı ve platform kanallarını lafmaliyet'in komisyon anahtarlarıyla verir (`pluxee`,
  `multinet`, `edenred`, `setcard`, `metropol`, `yemeksepeti`, `trendyol`, `getir`, `migros`; kanalsız türde
  `null`, alan her zaman var). LafPOS'ta kanal serbest metin değil bu listeden seçilir (`shared/labels.ts`
  `PAYMENT_CHANNELS`); Komisyon ekranı aylık kanal satışını buradan doldurabilir. Nakit türü (`kind = nakit`)
  yalnız `zField = cash`'e bağlanır, `cash`'e de yalnız nakit türü. Beklenen nakit de Z'nin nakit alanı da
  ödemeye dondurulan `zField`'dan sayılır: ödeme almış bir tür sonradan nakitten karta çevrilse de iki rakam
  ayrışmaz.

- Tutarlar TL (lafmaliyet'in para biçimi), iki ondalık. `lines` lafmaliyet'in planladığı
  `DailyProductSale` biçimiyle birebir (`date` gövdede, `productId` lafmaliyet'in `site_menu_id + slot`
  eşlemesinden bulunur, bulunamazsa `posMatchKey(posName)` ile `pos_mappings`).
- Kişisel veri yok: müşteri, personel adı, telefon gitmez.
- lafmaliyet tarafı: gün `pos_day_reports` ve `pos_daily_sales`'e yazılır; neyin sayıldığına geçiş günü karar verir
  (§4.2). Ürün satışları aylık modele (B08), Kasa raporu ön doldurması, ikram ve ödeme kanalları geçiş gününden
  sonraki günlerde lafmaliyet partileriyle (B09-B11) okunur; ikram lafmaliyet'te `ikram[]` olarak saklanır, Zayi
  & ikram'a elle girilmez. Yanıtlar §4.2'de. 400, 409, 413 ve 422 kalıcıdır: LafPOS tekrar denemez, kaydı giden
  kutusunda hata olarak gösterir (Yönetim › Genel bakış ve Entegrasyon; metin "Kendiliğinden yeniden denenmez" der);
  düzeltilince Kasa › Geçmiş günler'de günün Z raporundaki "Gönder" ile yeniden gider.
- Aynı gün içinde `posName` tekildir (§3.1 satır anahtarı ve çakışma kuralı). lafmaliyet karşılığı:
  [RiosenBeq/lafmaliyet#34](https://github.com/RiosenBeq/lafmaliyet/pull/34).
- **Ortak örnek gövde:** `tests/fixtures/lafmaliyet-gun.golden.json` (iki boy, ek, ikram ve eki, karaoke, cari,
  kartla bahşiş ve tahsilat). `tests/lafmaliyet-gun.test.ts` LafPOS'un ürettiği gövdenin bu dosyayla bayt bayt
  aynı olduğunu sabitler; lafmaliyet aynı dosyayı kendi ayrıştırıcısıyla okur (B07). Gövde bilerek değişirse
  `LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts` ile yeniden üretilir ve lafmaliyet'teki kopya
  aynı PR serisinde güncellenir. İmza vektörleri (`/api/pos/gun`, `/api/panel/pos/urunler`)
  `tests/signature.test.ts`'te iki tarafta aynı.

### 4.1 Ürün maliyetleri (lafmaliyet → LafPOS)

```
GET {LAFMALIYET_URL}/api/panel/pos/urunler     (imzalı, aynı anahtar)
{ "version": 1, "now": "…", "items": [
  { "siteMenuId": "mnu-0003", "slot": "M", "name": "Latte", "size": "M", "costMinor": 4210, "active": true }
] }
```

`costMinor`: reçeteden birim maliyet, kuruş, KDV hariç. LafPOS bunu yalnız `rapor.maliyet` yetkisi olanlara
gösterir (patron panelinde ve Raporlar › Ürünler'de brüt kâr, Yönetim › Ürünler'de marj). Başka alan gitmez.
Kâr ve marj **KDV hariç** fiyattan hesaplanır (`shared/money.ts` `netOfKdv`, `netMarginPct`): Yönetim › Ürünler'deki
"KDV hariç marj" M / tek boy fiyatından (maliyet M'nin; iki boylu üründe "(M)"). Raporlar'ın brüt kârı eklerin
(şurup `mnu-0080`, ekstra shot `mnu-0081`, alternatif süt `mnu-0082`) reçete maliyetini de sayar: gün sonunun kuralıyla
(`addonsOf`, `addonSiteIds`), ekin M maliyeti × kalem adedi × ek adedi, ana ürünün satırına; maliyeti bilinmeyen ek 0
sayılır ve satır "maliyet eksik" işaretlenir (`costPartial`, tabloda `*`).
Maliyetin son çekim tarihi ve çekim hatası da yalnız bu yetkiye gider: `GET /api/sync/status` (Entegrasyon, Genel
bakış, menü sayacı; giriş yapan herkes okur) `costsAt` ve `costsError`'u başkasına göndermez, Entegrasyon'daki
maliyet bölümü ve "Maliyetleri çek" (`senkron.yonet` **ve** `rapor.maliyet`) yalnız ona görünür.

- **Doğrulama:** gövde Zod ile okunur (`version: 1`, `items[]`: `siteMenuId`, `slot` `M`/`L`, `costMinor` ≥ 0).
  Bozuk gövdede ya da HTTP hatasında önceki maliyetler olduğu gibi kalır, istek 502 `lafmaliyet_costs` döner ve
  hata Yönetim › Entegrasyon'da görünür.
- **0 = bilinmiyor:** reçetesi olmayan ürün 0 gelir; saklanmaz, kâr "maliyet yok" görünür.
- **`products.cost` önbellektir:** tek boy ve M maliyeti ürünün alanına gösterim için yazılır; haritada olmayan site
  ürünününki boşalır (eski rakam kalmasın). Hesabın sahibi lafmaliyet'tir.
- **Sıklık:** her gün sonunda (kasadan ya da otomatik gün sonu) maliyetler o iş gününde (05:00 kuralı) çekilmediyse
  bir kez çekilir; kapanış saati bir öncekinden erken olsa da her gün yenilenir. Ayrıca Yönetim › Entegrasyon ›
  "Maliyetleri çek". Hata gün sonunu bozmaz, sonraki gün sonu yeniden dener. Son çekim 7 günden eskiyse Raporlar ›
  Ürünler ve patron paneli "Maliyetler N gün önce alındı" der; bu satır ve tarihi yalnız `rapor.maliyet` yetkisine
  gider, personel maliyetin varlığını da görmez.
- **Geçiş günü bu uçta yoktur:** LafPOS onu yalnız gün sonu yanıtından öğrenir (§4.2; tek kaynak). Bu uç kurulum
  modunda da çalışır: yazmayan imzalı GET olduğu için anahtarı ve saati sınamanın yoludur.

### 4.2 Yanıt ve geçiş günü

LafPOS'a geçiş gününün **sahibi lafmaliyet'tir** (Ayarlar › LafPOS (kasa) › LafPOS'a geçiş günü). LafPOS kendi
tarihini tutmaz, bütün gerçek günleri gönderir; neyin hesaplara girdiğine lafmaliyet karar verir ve yanıtta söyler:
geçiş gününden önceki (ya da geçiş günü seçilmemişken gelen) gün **deneme** olarak saklanır, hiçbir hesaba girmez.

| Yanıt | Gövde | LafPOS |
| --- | --- | --- |
| 200 | `{ ok, date, lines, matched, unmatched[], counted, switchDay }` | Gönderildi, ancak gövde `ok: true` ve gönderilen `date` ise (değilse adres lafmaliyet değil: yeniden denenir, gün işaretlenmez). `counted`, `switchDay`, `matched`, `unmatched` (en çok 50 ad), `lines` giden kutusu satırında (`outbox.response`) ve `lafmaliyet.push` durumunda (`lastAnswer`) saklanır; gün `business_days.exportedAt` ile işaretlenir (paket günün son kapanışından sonra hazırlandıysa) |
| 400 | `{ error: "invalid", field }` | Kalıcı: tekrar denenmez, alan `lastError`'da ("Kendiliğinden yeniden denenmez; LafPOS'u ve lafmaliyet'i güncelleyip Kasa › Geçmiş günler › Z › Gönder ile yeniden gönderin") |
| 401 | `{ error: "unauthorized" }` | Yeniden denenir; ipucu: "LAFMALIYET_SYNC_SECRET paneldeki LAFPOS_SYNC_SECRET ile aynı mı, kasa bilgisayarının saati doğru mu (±5 dk)" |
| 409 | `{ error: "wrong_branch", sube, expected }` | Kalıcı: kasanın şubesi (`sube`) lafmaliyet'in LafPOS şubesi (`expected`, marina) değil; Yönetim › Ayarlar › Şube düzeltilip yeniden gönderilir. Şube gönderirken güncel ayardan yazılır |
| 409 | `{ error: "z_conflict", date, zNo }` | Kalıcı; `lastError` "lafmaliyet'te bu güne Z 127 kayıtlı, gönderilen Z 128. Kendiliğinden yeniden denenmez: lafmaliyet Ayarlar › LafPOS (kasa)'da günün kaydı silinince Kasa › Geçmiş günler › Z › Gönder ile yeniden gönderin" der |
| 413 | `{ error: "too_large" }` | Kalıcı (gövde 256 KB'tan büyük) |
| 422 | (lafmaliyet bugün göndermez) | Kalıcı |
| 503 | `{ error: "not_configured" }` | Yeniden denenir; "lafmaliyet'te LAFPOS_SYNC_SECRET tanımlı değil". Gövdesi başka olan 503 (bakım, barındırma) geçici hata yazar |
| 404, 405 | — | Yeniden denenir; adres yanlış ("adreste lafmaliyet yok") |
| 3xx | — | İzlenmez, yeniden denenir; adres yönlendiriyor (http, www ya da sonda yol): adres yönlendirmesiz yazılır |
| 500 | `{ error: "server_error" }` | Yeniden denenir |

- `counted`: gün geçiş gününden önce değilse `true`. `switchDay`: lafmaliyet'teki geçiş günü (`null`: seçilmedi, kasa
  ModPOS). Eski lafmaliyet bu alanları göndermez: yoksa ya da bozuksa yazılmaz, LafPOS "geçiş günü bilinmiyor" der.
- Yönetim › Entegrasyon son gönderilen günü yazar: "lafmaliyet 3 Kasım gününü saymıyor (geçiş günü 10 Kasım): deneme
  olarak saklandı" ya da "12 Kasım lafmaliyet'te sayılıyor"; eşleşmeyen satır varsa "lafmaliyet'te eşleşmeyen N ürün"
  ve adları (lafmaliyet Ayarlar › LafPOS (kasa) › Bağla ya da Ürünler › Site menüsü; kayıtlı günler yeniden
  gönderilmeden bağlanır). N = `lines - matched` (lafmaliyet en çok 50 ad gönderir; ikisi yoksa gelen adların sayısı).
- Giden kutusu sayıları: `pending` gönderilmemiş bütün günler, `failing` bunlardan denenip gidemeyenler (hata ya da
  kalıcı ret). Genel bakış'ın alarmı ve menü sayacı yalnız `failing`'i sayar; "Geçmiş günleri gönder"le kuyruğa yeni
  giren gün hata değildir, "N gün sırada" görünür (dakikada 20 gün gider).
- **"Gönder"** (Kasa › Geçmiş günler › Z, `POST /api/sync/lafmaliyet/gun/:dayId/push`, `kasa.gun` ya da
  `senkron.yonet`): sonuç günün kendi giden kutusu kaydından (`dedupeKey = gun:<tarih>`) okunur; o gün gitmediyse
  502 `lafmaliyet_push` (aynı turda başka bir günün gitmesi başarı sayılmaz). Kuyrukta önünde bekleyen günler varsa
  sırası gelene kadar gönderim sürer. Yanıtta `answer` (yukarıdaki alanlar) döner. Hata yeniden denenecekse metin
  "Giden kutusunda bekliyor, sonra tekrar denenecek" der; kalıcı retteyse demez (ne yapılacağını `lastError` söyler).

### 4.3 Deneme (kurulum) modu: eğitim günleri gitmez

Kurulum verisi deneme (kurulum) modunda başlar (`demoMode: true`, örnek PIN'ler; `okcProvider: 'simulator'`, eğitim
yazarkasası); kasa her ekranda "Deneme modu: yapılan satışlar gerçek sayılmaz" şeridini gösterir (bootstrap
`integrations.deneme`). `demoMode` açıkken **ya da** yazarkasa simülatördeyken:

- Gün sonu **eğitim günü** olarak işaretlenir (`business_days.trainingDay = true`, gün sonunda yazılır). Eğitim günü
  lafmaliyet'e **hiç** gitmez, kurulum modu sonradan kapansa da: gün sonu ve yeniden sayım kuyruğa koymaz, "Geçmiş
  günleri gönder" onu atlar (yanıtta `training`: atlanan eğitim günü sayısı), "Gönder" 409 `training_day` döner
  ("Bu gün kurulum modunda kapandı (eğitim günü); lafmaliyet'e gönderilmez"). Kasa › Geçmiş günler › Z'de "Gönder"
  görünmez, kart nedenini yazar.
- Kurulum modu açıkken "Gönder" ve "Geçmiş günleri gönder" 409 `training_mode` döner ("Kurulum modunda lafmaliyet'e
  gün gönderilmez").
- Bu işaretten önce kapanan gün (`trainingDay` boş) de gitmez: LafPOS o zaman canlıda değildi, o günler eğitimdi.
  lafmaliyet'e yalnız kurulum modu dışında kapanan gün (`trainingDay = false`) gider. Gün yeniden açılınca işaret
  silinir, yeniden kapanışta yeniden yazılır.

Böylece eğitim günleri lafmaliyet'e düşmez. Deneme bitince patron Yönetim › Ayarlar ve yedek › Deneme modu ›
**Denemeyi bitir, gerçek kullanıma başla** der (`POST /api/admin/deneme/bitir`, yalnız patron, kendi PIN'iyle;
`server/services/deneme.ts`): önce yedek (`backups/lafpos-deneme-oncesi-<an>.db`), sonra tek işlemde bütün deneme
hareketleri (adisyon, ödeme, fiş, gün, kasa hareketi, rezervasyon, platform siparişi, müşteri, denetim kaydı,
lafmaliyet'e bekleyen kayıt) silinir; kurulum kalır. `demoMode` kapanır, simülatör `kapali` olur, patronun örnek PIN'i
değişir, örnek PIN'li öbür hesaplar kapanır, `liveSince` yazılır ve denetime `deneme.bitir` düşer. Açık gün varken
409 `day_open`, deneme dışında kapanmış gün (`trainingDay = false`) varken 409 `real_days`; ikinci kez yalnız
`already: true` döner, hiçbir şey silinmez. Ayrıntı `docs/05-KASA-BILGISAYARI.md` §2 "İlk açılış". Veri klasörünü
silmek çözüm değildir: kurulumu (personel, masalar, ödeme türleri) de siler ve boş veritabanı yeniden deneme modunda
başlar.

Patron PIN'i değişince kurulum modu kapanır (Yönetim › Ayarlar'dan da kapatılır; yalnız `demoMode`, kayıtlar
silinmez); yazarkasa Yönetim › Yazarkasa POS'ta `kapali` ya da `tokenx` olur. Kurulum modu kapandıktan sonra açılıp kapanan ilk gerçek gün §8'deki **deneme
gönderimidir** (gün kurulum modu açıkken açıldıysa sabahki eğitim satışları da onda olur; kurulum modunu gün
açılmadan kapatın). İmzayı sınamak için kurulum modunda da "Maliyetleri çek" (§4.1) yeterli.

### 4.4 Geçmiş günler

Bağlantı sonradan kurulduysa (`enqueueDay` yapılandırma yokken kuyruğa koymaz) ya da günler gidemediyse:
`POST /api/sync/lafmaliyet/backfill { from, to }` (`senkron.yonet`; Yönetim › Entegrasyon › "Geçmiş günleri gönder").

- Aralıktaki **gün sonu alınmış ve hiç 200 almamış** (`business_days.exportedAt` boş) gerçek günler tarih sırasıyla
  kuyruğa girer (gün başına tek kayıt, bekleyen kaydın yerine geçer) ve gönderim başlar. Açık gün, eğitim günü (§4.3)
  ve daha önce gitmiş gün gitmez; tek günü yeniden göndermek Kasa › Geçmiş günler › Z › Gönder'dir (ör. lafmaliyet'te silinen gün).
- Varsayılan aralık: son yanıttaki `switchDay`'den (yoksa elle seçilir) düne. Ekran o aralıkta gönderilmemiş
  kapanmış gerçek gün sayısını yazar. Yanıt `{ queued, days, training }`: `training` aralıkta atlanan eğitim günü
  sayısıdır, ekran "N eğitim günü (kurulum modunda kapandı) gönderilmez" der. En çok 400 gün; bitiş bugünden sonra olamaz, başlangıç bitişten sonra olamaz (422).
- Kuyruğa giren gün varsa denetim kaydına `sync.lafmaliyet_backfill` (aralık ve günler) düşer. Kurulum modunda 409
  `training_mode`.
- `exportedAt` yalnız `reopenDay` ile sıfırlanır (gün yeniden açılınca yeniden kapanışta tekrar gider).

## 5. Sıklık ve bütçe

`.env`'de `LAFFOGATO_URL` yoksa aşağıdaki site işlerinin hiçbiri çalışmaz (§2).

| İş | Sıklık | Neon'a etkisi |
| --- | --- | --- |
| Herkese açık menü | gün açıkken 15 dk (ETag); gece yok; gün açılınca ve kendi Satışta yazımından sonra bir kez; `menu` işareti değişince gün açıkken en sık 60 sn, sonda tek eşitleme, gece yok (gün açılınca bir kez ETag'siz); CDN bayatsa 2 dk sonra bir kez; elle | CDN ıskasında okuma (uyanma) |
| İmzalı menü okuma | senkronda (herkese açık menü değişince, `menu` işareti değişince: gün açıkken en sık 60 sn, gece yok) ve elle | küçük okuma |
| Sipariş sürüm sinyali | gün açıkken 20 sn, gece en sık 3 dk; hiç iş günü yokken hiç; "Online siparişleri çek" kapalıyken yalnız karaoke için, gün açıkken ve planda oda varken | yok (veri önbelleği, veritabanına gitmez) |
| Online sipariş okuma (masa çağrıları dahil; kasanın şubesinin, §2 "Şube") | sinyal değişince + gün açılınca bir kez + gün açıkken 15 dk'da bir güvenlik + elle (en sık 30 sn); sinyal yoksa 5 dk | küçük okuma |
| Tükendi / aşama yazma, masa çağrısı "Gördüm" | kullanıcı işlemi; porsiyon Tükendi'si ve internetsiz basılan Tükendi / Satışa aç giden kutusundan (internet yokken istek denenmez, internet gelince tek yazım) | tek yazım |
| Karaoke rezervasyonları (§2.4) | `karaoke` işareti değişince ya da gün dönünce, gün açıkken en sık 5 dk ("Online siparişleri çek" kapalıyken de); oda kutusu açılınca ve sayaç dururken liste geride kaldıysa; elle (en sık 30 sn); gece yok; planda oda yoksa hiç | küçük okuma |
| Karaoke saat ücreti (§2.4) | Yönetim › Masa planı açılınca (en sık dakikada bir) | küçük okuma (herkese açık uç) |
| Sesli uyarılar (§2.5) | yeni istek yok: sipariş (masa çağrıları dahil) ve karaoke çekimlerinin listesinden | yok |
| lafmaliyet günlük itme | gün sonunda bir kez (+ düzeltme, + elle "Geçmiş günleri gönder"); eğitim günü hiç | yok (lafmaliyet'in kendi veritabanı) |
| lafmaliyet maliyet okuma | her gün sonunda bir kez (o iş gününde çekilmediyse); + elle | yok |

## 6. Durum (28 Ekim 2026)

| Durum | Repo | İş |
| --- | --- | --- |
| Birleşti | laffogato#263 (d1de10f) | `LAFPOS_SYNC_SECRET` panel uçlarında ek anahtar; `GET /api/pos/orders/version` |
| Birleşti | lafmaliyet#34, #36 | `POST /api/pos/gun`, `GET /api/panel/pos/urunler`, `pos_daily_sales`, Kasa raporunda "LafPOS'tan doldur" |
| Birleşti | lafmaliyet#44 (B07) | LafPOS durumu ve onarımı (Ayarlar › LafPOS (kasa)), geçiş günü ayarı, 200 yanıtına `counted` ve `switchDay`, Kasa bandı geçiş gününe bağlı, eşit anahtar engeli |
| Birleşti | lafmaliyet#46 (B08) | LafPOS günlük satışları aylık modele; 200 yanıtına `matched` ve `unmatched` |
| Birleşti | lafpos#11 (L1), #12 (L3), #22 (L2) | Gün sonu satırları, ekler, eski gün engeli; site bağlantısı (sipariş sinyali, Tükendi, menü yoklaması, `.env`'siz istek yok); eğitim günü kapısı, geçmiş günler, yanıt alanları, maliyet doğrulaması ve günlük çekim, açılış sırası (§8) |
| Birleşti | laffogato#264 (cc0e40a), #265 (F1) | `GET /api/panel/karaoke` LafPOS anahtarına açık (dünden yarına), sürüm yanıtında `karaoke` işareti |
| Birleşti | lafpos#24 | Ödeme ekranında Zayi: gün sonu `ikram[]` satırında `reason` "Zayi: " ile başlar (§4) |
| Birleşti | lafpos#26 | Masa QR'ı LafPOS üretir; siparişte `tableCode` ile eşleme, kodlar giden kutusundan `PUT /api/panel/tables`'a (§2.3) |
| Birleşti | lafpos#25 (L4) | Karaoke: LafPOS bugünün site rezervasyonlarını okur (§2.4), sayaç rezervasyona bağlanır, ödenmiş saat yeniden ücretlenmez, oda yerel rezervasyona verilmez |
| Birleşti | laffogato#268 | Panel siparişinde `tableCode`; imzalı `PUT /api/panel/tables` (LafPOS anahtarı; §2.3) |
| Açık | lafmaliyet B09-B11 | Kasa raporu uzlaşması; komisyon kanalları ve ikram; geçişten sonra ModPOS metinleri ve "Kasadaki fiyatlar" |
| Birleşti | laffogato#279 + lafpos | Site şubeli; LafPOS her imzalı istekte şubesini söyler, başka şubenin listesini ve kaydını yazmaz (§2 "Şube") |
| Açık | laffogato | Panel siparişinde `paidAtTill`, `lines[].index` ve yanıtta `closed` (§2.3 "Sözleşme eklemeleri"); LafPOS hazır, alan gelmezse bugünkü davranış |
| Faz 2 | laffogato F2 + lafpos L5 | Kasada ödenen site siparişinin adisyona aktarılması (bugün §8'deki personel yordamı; `paidAtTill` ile LafPOS onu bara düşürmez) |
| Faz 2 | laffogato | Kasada damga (M2M) ucu |

## 7. Yazarkasa POS (ÖKC) bağlantısı

Mali fiş ÖKC'den kesilir; LafPOS adisyonu cihaza "sepet" olarak gönderir, ödeme ve fiş cihazda olur, sonuç
(Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir. Ayrıntı:
`docs/04-YAZARKASA.md`.

## 8. Açılış sırası

Sahibin istediği tek liste (26 Ekim 2026). lafmaliyet deposunda `docs/LAFPOS.md` › "Açılış sırası" aynı adımlardır:
**1. anahtarlar → 2. deneme gönderimi → 3. geçiş günü**; aşağıdakiler her adımın LafPOS tarafındaki ayrıntısıdır.
PR'ların birleşip yayına çıkması hiçbir şeyi açmaz: anahtar, `.env` ve geçiş günü yokken laffogato, lafmaliyet ve
LafPOS bugünkü gibi çalışır, kasa ModPOS'tur.

**Ön koşul.** LafPOS (L1-L4), lafmaliyet (B07-B08; B09-B11 durumu §6) ve laffogato (F1) birleşmiş ve yayında (durum
§6); LafPOS kafe bilgisayarına kurulmuş. Anahtarlar **en erken lafmaliyet B07 yayındayken** girilir: o sürümden önce
lafmaliyet Kasa formu LafPOS gününü geçiş günü olmadan gösterirdi.

1. **Anahtarlar**
   - lafmaliyet Production (Vercel): `LAFPOS_SYNC_SECRET`, en az 32 karakter (`openssl rand -base64 48`); paneli
     yeniden yayınlayın.
   - laffogato Production: `LAFPOS_SYNC_SECRET`, **ayrı bir değer**. İki projede adları aynı, değerleri ayrıdır;
     ikisi de sitenin `KARAOKE_SYNC_SECRET`'ından ayrıdır (aynıysa site ve panel LafPOS'u kabul etmez).
   - LafPOS `.env` (Windows kurulumunda Başlat › LafPOS › LafPOS ayarları, `ayarlar.env`), şimdilik yalnız
     lafmaliyet satırları: `LAFMALIYET_URL=https://ladmin.laffogato.net`, `LAFMALIYET_SYNC_SECRET` = panelin
     `LAFPOS_SYNC_SECRET`'ı (`server/env-config.ts`). Kurulum modundayken bunlar güvenlidir: gün gitmez (§4.3),
     yalnız maliyet okuma çalışır (gün sonunda ve "Maliyetleri çek"; yazmayan imzalı GET). İsteğe bağlı LafPOS Uzaktan: `LAFPOS_CLOUD_URL`,
     `LAFPOS_CLOUD_SECRET`.
   - **Şube:** site şubelidir (§2 "Şube"); Marina kasasının Şube kimliği `marina` kalır (sitenin `LAFPOS_BRANCHES`
     varsayılanı da `marina`). Anahtar girilince kasa yalnız Marina'nın siparişlerini, çağrılarını ve Satışta'sını
     okur ve yazar; Tuzla'nınkine dokunmaz.
   - Site satırları (`LAFFOGATO_URL`, `LAFFOGATO_SYNC_SECRET`) bu adımda **girilmez**, 2. adımın başında girilir:
     girildiği andan itibaren LafPOS'taki Tükendi / Satışa aç ve online sipariş aşamaları canlı siteyi ve uygulamayı
     değiştirir, kurulum modunda da. `scripts/vercel/baglanti-kur.sh` anahtarları üretip üç projeye yazar ve kafeye
     girecek satırları bir dosyaya döker; site satırlarını o dosyadan 2. adımda alın.
   - Panelin `KARAOKE_SYNC_SECRET`'ı kafe makinesine konmaz (laffogato `docs/LAFPOS.md`).
2. **Deneme gönderimi**
   - Eğitim bitti: LafPOS'ta "Denemeyi bitir, gerçek kullanıma başla" (§4.3) yapıldı; kurulum modu kapalı, Yönetim ›
     Yazarkasa POS **`kapali`** (eğitim simülatörü değil). ModPOS'la paralel deneme gününde `kapali` kalır, mali fişi ModPOS
     keser; `tokenx` ancak geçiş gününden itibaren ve Token'ın test ortamından sonra açılır (`docs/04-YAZARKASA.md`).
     Simülatörde kalan gün eğitim günüdür ve hiç gitmez (§4.3).
   - Şimdi site satırları LafPOS `.env`'ine girilir: `LAFFOGATO_URL=https://laffogato.net` (varsayılanı yok),
     `LAFFOGATO_SYNC_SECRET` = sitenin `LAFPOS_SYNC_SECRET`'ı; LafPOS yeniden başlatılır.
   - Yönetim › Entegrasyon › "Maliyetleri çek" 200 döner: imza ve saat çalışıyor. Kart "Kurulum modu" demiyor.
   - Karaoke (§2.4): karaoke odasının adisyonunda oda kutusu bugünün site rezervasyonlarını gösterir ("site karaokeyi
     LafPOS'a açmadı" diyorsa sitenin `LAFPOS_SYNC_SECRET`'ı ile `LAFFOGATO_SYNC_SECRET` aynı değil). Yönetim › Masa
     planı'nda saat ücreti uyarısı yoksa odanın ücreti sitedekiyle aynıdır.
   - Gerçek bir gün LafPOS'ta (kurulum modu kapandıktan sonra) açılıp kapatılır (ModPOS'la paralel olabilir).
     lafmaliyet Ayarlar › LafPOS (kasa)'da gün **Deneme** görünür, yanıt `counted: false`; LafPOS Entegrasyon'da
     "lafmaliyet … gününü saymıyor: geçiş günü seçilmedi". Başka hiçbir ekranda görünmez. Retler iki kartta da
     görünür.
   - Eşleşmeyen ürünler (iki kartta da listelenir): lafmaliyet'te **Bağla** ya da Ürünler › Site menüsü'nde sitenin
     kalemine bağlanır; "Yalnız sitede" boşlukları satılan her kalem için kapanır. Liste öneridir, ön koşul değil.
   - Yalnız ModPOS'ta satılan ürünler (Su (PET), Kuzu Kulağı, Ice Caramel Latte …) için karar: siteye eklenir
     (tercih) ya da LafPOS yerel ürünü olur, `posName` = eski ModPOS adı.
   - LafPOS Yönetim › Ödeme türleri'nde yemek kartı ve platform kanalları (`pluxee` … `yemeksepeti` …) seçili.
   - Eğitim günleri lafmaliyet'e gitmez (§4.3); "Denemeyi bitir" onları LafPOS'tan da siler (öncesinde yedek). Veri
     klasörü silinmez (kurulumu da siler, LafPOS deneme moduna döner). lafmaliyet kartında yine de bir eğitim günü görünürse orada silinir.
3. **Geçiş günü**
   - lafmaliyet Ayarlar › LafPOS (kasa) › LafPOS'a geçiş günü girilir (tercihen ayın 1'i). Ay ortasıysa o ayın
     ModPOS ürün listesi geçiş gününden önceki günler için Satışlar'a yüklenir (1-9 Kasım; yükleme o güne kırpar).
   - LafPOS geçiş gününü bir sonraki gün sonunun yanıtından öğrenir (Entegrasyon'da yazar, "Geçmiş günler"in
     varsayılan başlangıcı olur). Geçiş gününden bu yana kapanmış ama gitmemiş gün varsa "Geçmiş günleri gönder" (§4.4);
     eğitim günlerini atlar.
   - Yazarkasa gerçek fişe geçecekse Yönetim › Yazarkasa POS `tokenx` (Token'ın test ortamında denendikten sonra).
   - **İlk Z numarası:** ModPOS'ta son gün sonu alındıktan sonra, geçiş günü LafPOS'ta gün açılmadan önce Yönetim ›
     Ayarlar › Kasa ve gün › İlk Z numarası = ModPOS'un son Z numarası + 1 (son Z 1200 ise 1201); Z zinciri, dolayısıyla
     Kasa raporunun Z no'su ModPOS'unkinden devam eder. Açılan günün Z'si kayıtlı en büyük Z + 1'dir, ilk Z numarası daha
     büyükse odur (`shared/z-no.ts`): ayar yalnız yukarı doğru etkiler, kayıtlı günlerin numarası değişmez (eğitim ve
     deneme günleri de zincirdedir), geçmiş gün yeniden gönderilince `z_conflict` çıkmaz. Son Z ve altı reddedilir
     (422 `z_start_low`, "Z numarası geri alınamaz; son Z N"); boşaltmak zinciri geri almaz. Yalnız ayar yetkisiyle
     (`ayar.yonet`) değişir, denetim kaydına uyarı olarak düşer (`settings.z_start`, eski → yeni). Alanın altında son Z
     ve sıradaki günün Z'si yazar.
   - İlk gün: LafPOS'ta gün sonu → lafmaliyet kartında gün, `counted: true`; Kasa raporu kendiliğinden dolu, banka
     POS ve yazarkasa Z eklenip gönderilir; Kasadaki fiyatlar kaybolur.

**Personel yordamı** (kod değil): uygulama / web siparişi kasada nakit ya da kartla ödenirse sitede "Ödendi"
işaretlenir ve LafPOS'ta normal adisyon olarak çalınır, bugün ModPOS'ta olduğu gibi (site onu `counter` sayıp online
cirodan ve tüketim satırlarından çıkarır, çift sayım olmaz; otomatik aktarım Faz 2). Site `paidAtTill` gönderince
LafPOS o siparişi "sitede ödendi" diye yazmaz ve bara düşürmez, yalnız "#N kasada ödendi; adisyon olarak çalın" uyarısı
verir: bara tek fiş, Z'ye tek satış gider (§2.3 "Kasada ödenen").

**Geri almak:** lafmaliyet'te geçiş gününü boşaltmak her şeyi ModPOS'a döndürür, hiçbir kayıt silinmez. LafPOS
`.env`'deki satırları silmek (ya da başına `#`) bağlantıyı kapatır; LafPOS yeniden başlayınca dışarıya istek gitmez.
