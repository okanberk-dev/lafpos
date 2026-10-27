# Entegrasyon sözleşmesi: LafPOS ↔ laffogato ↔ lafmaliyet

Bu belge LafPOS'un diğer iki sistemle hangi uçtan, hangi alanlarla, ne sıklıkla konuştuğunu tanımlar.
Bir alan burada yoksa sistemler arasında gitmez (KVKK beyaz liste kuralı).

## 1. Sahiplik

| Veri | Sahibi | LafPOS'ta |
| --- | --- | --- |
| Satış fiyatı (M, L), Satışta/Tükendi, KDV oranı, ürün adı, kategori, görsel, alerjen | laffogato | salt okunur kopya; Tükendi değişikliği önce siteye yazılır; sitenin kapattığını kasiyer açamaz (§2.3 Tükendi kilidi) |
| Seçenekler (süt, kavrum, şurup, ekstra shot, şeker) ve fiyatları | laffogato (kod sabiti) | menüyle birlikte gelir |
| POS'a özel alanlar: istasyon, kısa ad, düğme rengi, POS sırası, gizli, porsiyon sayacı, `posName` | LafPOS | senkron dokunmaz |
| POS'a özel ürünler (karaoke saati, kampanya) | LafPOS | `extSource` boş |
| Reçete, hammadde, maliyet, stok, tedarikçi, cari, kasa raporu | lafmaliyet | LafPOS kopyalamaz |
| Masa, adisyon, ödeme, gün sonu, personel PIN'leri | LafPOS | |
| Online sipariş (uygulama, web, masa QR) | laffogato | bar ekranında gösterilir, aşaması geri yazılır, tahsil edilmez |
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

### 2.1 Herkese açık menü

`GET {LAFFOGATO_URL}/api/mobile/v1/menu` · `If-None-Match: <son ETag>` · anahtar gerekmez.

- CDN'den gelir (`s-maxage=300, stale-while-revalidate=3600`). CDN'deki kopya eskiyince istek sitenin veritabanını
  okur (laffogato `listMenuItems`); Neon 5 dakika boşta kalınca uyuduğu için her ıska bir uyanmadır, gece
  uyanmaları en büyük israftır.
- 304 gelirse değişiklik yok. 200 gelirse fark hesaplanır.
- **Sıklık:** açık iş günü varken 15 dakikada bir otomatik (ayarla kapatılabilir). Açık gün yokken (gece) hiç; gün
  açılınca (ya da yeniden açılınca) bir kez. LafPOS siteye kendi Satışta yazımını yaptıktan (Tükendi, Satışa aç,
  porsiyon) 5 saniye sonra bir kez: site o an zaten uyanık. Ayrıca "Siteyle eşitle" düğmesi.
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
| `GET /api/panel/menu` | Satışta bilgisinin taze kaynağı (`isActive`, §2.1) | menü senkronunda: herkese açık menü değişince ve elle |
| `POST /api/panel/menu {id, isActive, actor}` | POS'ta Tükendi / Satışa aç ve porsiyon sayacının doldurulması → önce site, 2xx gelince yerel; porsiyon sayacı sıfıra inince Tükendi, hazırlanmadan iptal edilen kalemle sıfırdan dönünce Satışta (`actor: LafPOS porsiyon`, giden kutusundan) | kullanıcı işlemi ya da porsiyon |
| `GET /api/pos/orders/version` | sipariş sürüm sinyali (aşağıda) | 20 sn'de bir, gece de; veritabanına gitmez |
| `GET /api/panel/orders` | online siparişler (masa, gel-al, kurye): bar ekranı ve masa planı | sinyal değişince; gün açıkken 15 dk'da bir güvenlik çekimi; elle "Yenile" (en sık 30 sn); sinyal yoksa 5 dk'da bir |
| `POST /api/panel/orders/stage {id, action, from, actor}` | Hazırlanıyor / Hazır / Teslim edildi; 409 ve 404'te liste yeniden çekilir | kullanıcı işlemi |

`actor` LafPOS kullanıcısının adıdır. LafPOS anahtarıyla gelen yazımlar site olay kaydına `lafpos:<ad>` diye düşer.

**Sipariş sürüm sinyali:** `GET /api/pos/orders/version` (imzalı, `LAFPOS_SYNC_SECRET`) → `{ "version": "<metin>" }`.
Sitenin veri önbelleğinden (`live:orders` etiketi) gelir, veritabanına dokunmaz; sipariş yazımı etiketi
düşürünce değer değişir. LafPOS bunu 20 saniyede bir sorar (gece de: gün kapalıyken gelen sipariş ödeme anının iş
gününe işlenir), değer değişince `GET /api/panel/orders`'ı çeker. Böylece online sipariş Neon kotasını harcamadan yarım
dakika içinde bar ekranına düşer. Veritabanına dokunmadığı için 5 dakika kuralının (`AGENTS.md` kural 6) dışındadır.
- Sürüm yalnız çekim başarılıysa kaydedilir: başarısız çekim sonraki turda (20 sn) yeniden denenir, art arda
  başarısızlıkta bekleme katlanır (en çok 5 dk). Sipariş kaybolmaz. Sinyal okunamazsa (5xx, bozuk gövde) 5 dakikalık
  çekmeye düşülür.
- Sinyal çalışırken de açık iş günü varken 15 dakikada bir tam çekim yapılır: sinyali kaçan bir değişiklik ya da
  süresi dolup listeden sessizce düşen sipariş (sitede yazım olmaz, sinyal değişmez) kalmasın. Gece yapılmaz.

`GET /api/panel/orders` yanıtında `orders` dizisi yoksa (bakım sayfası, ağ geçidi, beklenmeyen gövde) çekme
başarısız sayılır, hiçbir sipariş kapatılmaz. Liste, istendiği andaki hâldir: istek gittikten sonra LafPOS'ta
değişen sipariş (kasada "Teslim edildi", aşama, araya giren daha yeni bir çekmenin getirdiği yeni sipariş) o listeyle
ne yeniden açılır ne kapanır ne de aşaması geri alınır; sonraki çekme geçerlidir.

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
- **Kapanış:** site listeyi keserse (`complete: false`, en çok 200 sipariş) ya da okunamayan kalem varsa LafPOS hiçbir
  siparişi kapatmaz. Bütün listede olmayan açık online sipariş "Siteden kalktı" diye kapanır (`extStage = 'gone'`:
  sitede tamamlandı, iptal edildi ya da süresi geçti): servis edilmiş sayılmaz, bar ve çağrı ekranından düşer, denetim
  kaydına yazılır. Yerelde kapanmış ama sitede hâlâ açık görünen sipariş yeniden açılır. LafPOS'ta son aşamaya
  getirilen sipariş `extStage = 'done'` kapanır.
- **Aşama:** site 409 (`stale`, sipariş bu arada değişti) ya da 404 (`not_found`, "Sipariş sitede bulunamadı")
  dönerse liste yeniden çekilir.

**Tükendi kilidi** (`products.soldOutBy`): LafPOS'un kapattığı ürün (kasadan, bardan, porsiyon bitince) `lafpos`,
sitenin kapattığı (senkron) `site` diye işaretlenir. Kasiyer (`urun.tukendi`) yalnız LafPOS'un kapattığını açar;
sitenin kapattığı kasada "Sitede satışta değil" diye görünür, düğmesi yoktur, sunucu 403 `site_closed` döner. Menü
yetkisi olan (`menu.yonet`) hepsini açar: açış önce siteye yazılır, denetim kaydına "sitede kapatılmıştı" düşer.

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

## 3. LafPOS → lafmaliyet: bugün (kod değişmeden)

### 3.1 Ürün satış listesi (Satışlar ekranına yükleme)

`GET /api/sync/lafmaliyet/satislar.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` (yetki: `rapor.gor`; Raporlar › Aktarım)

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
- Karaoke gibi `isService` ürünler aynı listede çıkar; lafmaliyet bunları HİZMET olarak eşler.
- Masa servis ücreti `SERVİS ÜCRETİ` adıyla ayrı hizmet satırıdır (adet: servis ücretli adisyon sayısı).
  Satırların toplamı günün Z toplamına (`z_total`) eşittir.

### 3.2 Z özeti (Kasa raporu formuna)

Gün sonu ekranında, lafmaliyet Kasa raporu alanları **aynı sırada** gösterilir, "Kopyala" ile metin olarak
alınır, `GET /api/cash/days/:id/lafmaliyet.json` ile JSON indirilir.

| lafmaliyet alanı | LafPOS kaynağı |
| --- | --- |
| `z_no` | `business_days.zNo` |
| `receipts` | tutarı 0'dan büyük kapanan POS adisyonu sayısı (online, iptal ve tamamı ikram adisyonlar hariç) |
| `z_total` | ödemelerin toplamı (cari tahsilat ve bahşiş hariç) |
| `cash` | `zField = cash` ödemeler (ödeme anında dondurulan Z alanı; beklenen nakit de aynı alandan hesaplanır, ödeme türü sonradan değişse de ikisi aynı ödemeleri sayar. Yönetim Z'de nakdi yalnız Nakit türüne verir) |
| `card` | `zField = card` |
| `meal_card` | `zField = meal_card` (Pluxee, Multinet, Edenred, Setcard, Metropol) |
| `online` | `zField = online` (yemek platformları) |
| `other` | `zField = other` (havale, açık hesap/cari dahil) |
| `off_revenue` | kapanmış adisyonlarda ikram edilen kalemlerin menü değeri |
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

## 4. LafPOS → lafmaliyet: önerilen imzalı uç (lafmaliyet PR'ı gerekir)

Kafedeki sunucu internetten erişilebilir olmadığı için "ping + çekme" yerine **imzalı itme** önerilir.
LafPOS gün sonunda ve sonradan düzeltmede aynı iş gününü yeniden gönderir (aynı `date` üzerine yazar,
idempotent). İstek giden kutusunda (`outbox`) bekler; internet yoksa sonra gider.

```
POST {LAFMALIYET_URL}/api/pos/gun
x-laf-timestamp, x-laf-signature (aynı kural; anahtar: lafmaliyet'te LAFPOS_SYNC_SECRET, LafPOS'ta LAFMALIYET_SYNC_SECRET)
{
  "version": 1,
  "source": "lafpos",
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
- **Ekler** (süt, şurup, ekstra shot) içeceğin satırından ayrı satırdır: `ALTERNATIF SÜT`, `SYRUP`, `EXTRA SHOT`;
  kimlik önce sitenin sabit kalemleri (`mnu-0082`, `mnu-0080`, `mnu-0081`), yoksa `extras` kategorisinde ada göre.
  Seçim fiyata göre değil **koda göre**: `milk` kodu `normal` değilse (laktozsuz süt 0 TL'dir ama alternatif
  süttür, ciro 0 satır), `syrup` kodu `none` değilse, ekstra shot adediyle. Satırın net cirosu ana ürün ve ekler
  arasında liste fiyatları oranında bölünür.
- `ikram` yalnız **kapanmış** POS adisyonlarından gelir (Z'nin `offRevenue`'uyla aynı kapsam; iptal edilen
  adisyonun ikramı tüketim değildir); ikram edilen içeceğin ekleri ayrı kayıttır, menü değeri satıştaki oranla
  bölünür. `ikram` menü değerlerinin toplamı `offRevenue`'a eşittir.
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
- lafmaliyet tarafı: `pos_daily_sales` tablosu, `loadDailyProductSales` yükleyicisi (bugün `null`),
  Kasa raporunda `CashPrefill { source: "lafpos" }` ile ön doldurma, `ikram` → `waste_entries`
  (`kind = 'ikram'`) önerisi. Yanıt: 200 `{ ok: true, date, lines }`, 400 `{ error: "invalid", field }`, 401,
  409 `{ error: "z_conflict" }`, 413, 503. 400, 409 ve 413 kalıcıdır: LafPOS tekrar denemez, kaydı giden
  kutusunda hata olarak gösterir (Yönetim › Genel bakış ve Entegrasyon); düzeltilince Kasa › Geçmiş günler'de
  günün Z raporundaki "Gönder" ile yeniden gider.
- Aynı gün içinde `posName` tekildir (§3.1 satır anahtarı ve çakışma kuralı). lafmaliyet karşılığı:
  [RiosenBeq/lafmaliyet#34](https://github.com/RiosenBeq/lafmaliyet/pull/34).
- **Ortak örnek gövde:** `tests/fixtures/lafmaliyet-gun.golden.json` (iki boy, ek, ikram ve eki, karaoke, cari,
  kartla bahşiş ve tahsilat). `tests/lafmaliyet-gun.test.ts` LafPOS'un ürettiği gövdenin bu dosyayla bayt bayt
  aynı olduğunu sabitler; lafmaliyet aynı dosyayı kendi ayrıştırıcısıyla okur (B07). Gövde bilerek değişirse
  `LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts` ile yeniden üretilir ve lafmaliyet'teki kopya
  aynı PR serisinde güncellenir. İmza vektörleri (`/api/pos/gun`, `/api/panel/pos/urunler`)
  `tests/signature.test.ts`'te iki tarafta aynı.

LafPOS istemcisi hazırdır; `LAFMALIYET_URL` ve `LAFMALIYET_SYNC_SECRET` verilince giden kutusu çalışır.

### 4.1 Ürün maliyetleri (lafmaliyet → LafPOS)

```
GET {LAFMALIYET_URL}/api/panel/pos/urunler     (imzalı, aynı anahtar)
{ "version": 1, "now": "…", "items": [
  { "siteMenuId": "mnu-0003", "slot": "M", "name": "Latte", "size": "M", "costMinor": 4210, "active": true }
] }
```

`costMinor`: reçeteden birim maliyet, kuruş, KDV hariç. LafPOS bunu yalnız `rapor.maliyet` yetkisi olanlara
gösterir (patron panelinde ürün kârlılığı). Başka alan gitmez.

## 5. Sıklık ve bütçe

`.env`'de `LAFFOGATO_URL` yoksa aşağıdaki site işlerinin hiçbiri çalışmaz (§2).

| İş | Sıklık | Neon'a etkisi |
| --- | --- | --- |
| Herkese açık menü | gün açıkken 15 dk (ETag); gece yok; gün açılınca ve kendi Satışta yazımından sonra bir kez; elle | CDN ıskasında okuma (uyanma) |
| İmzalı menü okuma | senkronda (herkese açık menü değişince) ve elle | küçük okuma |
| Sipariş sürüm sinyali | 20 sn, gece de | yok (veri önbelleği, veritabanına gitmez) |
| Online sipariş okuma | sinyal değişince + gün açıkken 15 dk'da bir güvenlik + elle (en sık 30 sn); sinyal yoksa 5 dk | küçük okuma |
| Tükendi / aşama yazma | kullanıcı işlemi; porsiyon Tükendi'si giden kutusundan | tek yazım |
| lafmaliyet günlük itme | gün sonunda bir kez (+ düzeltme) | tek yazım |

## 6. Diğer repolardaki işler

| Repo | Dal | İş |
| --- | --- | --- |
| laffogato | `claude/lafpos-baglantisi` | `LAFPOS_SYNC_SECRET` panel uçlarında ek anahtar; `GET /api/pos/orders/version` |
| lafmaliyet | `claude/lafpos-baglantisi` | `POST /api/pos/gun`, `GET /api/panel/pos/urunler`, `pos_daily_sales` ve `loadDailyProductSales`, Kasa raporunda "LafPOS'tan doldur" |
| laffogato (sonra) | | Kasada damga (M2M) ucu |

## 7. Yazarkasa POS (ÖKC) bağlantısı

Mali fiş ÖKC'den kesilir; LafPOS adisyonu cihaza "sepet" olarak gönderir, ödeme ve fiş cihazda olur, sonuç
(Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir. Ayrıntı:
`docs/04-YAZARKASA.md`.
