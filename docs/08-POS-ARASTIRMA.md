# POS araştırması: adisyon, hesap bölme, ikram, seçenekler ve yönetim paneli

4 Kasım 2026 · LafPOS için araştırma notu (operatör: _"Narpos, robotpos, modpos vs. gibi yerellere bak yurt dışındakilere
bak gelişmiş sistem yap, tasarım olarak da her şey olarak ama basit olsun ve UI UX gelişmiş olsun"_).

> **Durum notu:** "LafPOS'ta bugün olanlar" bölümü bu araştırma yazılırken (aynı günün işleri birleşmeden önce) geçerliydi.
> Sonradan uygulananlar: Paylaş'ta 2-6 kişi çipleri ve elle paylar, ödenmezde zorunlu "kimin adına" (personel ya da
> müşteri) ve raporlarda kişi kişi döküm, seçenek profili ve tek boylu üründe tek dokunuş, adisyon ekranının yeni
> düzeni. Ayrıntı `docs/02-PLAN.md`. Bağlantılar aramadan alınan resmî sayfalara gider; sayfalar bu oturumdan doğrudan
> açılamadığı için görsel ölçüler doğrulanmadı (aşağıda "Yöntem ve sınırlar").

Soru: yerli (NarPOS, robotPOS, ModPOS, SambaPOS, Adisyo, Simpra, Menulux) ve yabancı (Toast, Square for Restaurants,
Lightspeed Restaurant K-Series, TouchBistro, Clover, Loyverse, Revel, SpotOn, Odoo) sistemler beş konuda ne yapıyor ve
LafPOS bundan sade kalarak ne almalı: adisyon ekranı, hesap bölme, ikram ve personel yemeği, seçenek sormama kuralları,
yönetim panelinin görsel dili.

## Kısa sonuç

- Büyük yabancı sistemler adisyonu aynı iskelette kuruyor: hesap bir yanda, menü öbür yanda, eylem şeridi altta sabit
  (Gönder, Öde), kalem eylemleri kaleme dokununca açılan tek bir menüde. LafPOS'un iki kartlı adisyonu ve telefondaki alt
  şeridi bu iskeletle örtüşüyor. Eksik olan küçük hız araçları: "Bir daha" (tekrarla), karta uzun basınca Tükendi,
  aramanın altında son eklenenler.
- Eşit bölmede herkes "kaç kişi" diye soruyor. Hazır 2 · 3 · 4 çipini belgelerinde açıkça gösteren bir sistem
  bulunamadı. Toast sayıyı bir listeden seçtiriyordu (en çok dokuz), 2025'te serbest sayı girişi ekledi; Lightspeed kişi
  (cover) sayısıyla tek dokunuşta bölüyor; Loyverse ± ile seçtiriyor ve sonra parça tutarını elle değiştirmeye izin
  veriyor. LafPOS'un "kalan, ödenmemiş paylara yeniden bölünür" kuralı belgelenen sistemlerin çoğundan öngörülebilir.
- İkramı ya da personel yemeğini kişiye bağlamak çoğu sistemde yamalı: Toast'ta gerekçe ve zorunlu yorum (yorum fişe
  basılmıyor), Square'de yalnız hazır gerekçe listesi, TouchBistro'da personele özel indirim, Lightspeed'de indirimi
  "zayi" işaretleme. "Personel yemeği → hangi personel" alanını düzgün bir alan olarak belgeleyen sistem bulunamadı. LafPOS
  ödenmez kapanışa yapılandırılmış bir "Kim için" alanı ekleyerek bunu sade biçimde çözebilir.
- "Ne zaman sorma" sorusunda yabancılar aynı yerde buluşuyor: Toast isteğe bağlı grubu kendiliğinden açmıyor (ancak
  "zorla göster" denirse açıyor), Square ürün başına "mümkünse özelleştirmeyi atla" ve "ilk varyasyonu önseç" sunuyor,
  SambaPOS ilk porsiyonu kendiliğinden seçiyor. L'Affogato'da cevabı olmadan hazırlanamayan ve doğru varsayılanı olmayan
  tek soru pratikte Türk kahvesinin şekeri (bir de açık fiyatlı kalemin tutarı).
- Yönetim panellerinde "kurumsal" duyguyu süs değil düzen veriyor: her raporda aynı süzgeç şeridi (hazır dönem,
  karşılaştırma, dışa aktarma), referansı yazılı karşılaştırmalı KPI, yoğun ama hizalı tablo, sabit gezinme. Square'in
  yeni kenar çubuğu tıklama sayısını artırdığı için satıcılardan tepki aldı: sadelik gezinmeyi derinleştirmek değil.

## Yöntem ve sınırlar

- Bu oturumda ağ politikası yüzünden sayfalar doğrudan açılamadı: `support.toasttab.com` ve `squareup.com` sayfa
  getirme aracında çözülmedi, vekil sunucu 403 döndü; bu yüzden başka siteler denenmedi. Bulgular arama motorunun resmî
  yardım ve güncelleme sayfalarından verdiği alıntılara dayanıyor; bağlantılar o sayfalara gidiyor. Ekran görüntüsü
  görülmedi; köşe yarıçapı ve gölge gibi görsel ölçüler belgelerden doğrulanamadı.
- Öncelik resmî yardım merkezi ve ürün güncellemesi sayfalarında. Topluluk forumu, blog ve üçüncü taraf kaynak yanında
  ayrıca belirtildi. Tarih, sayfanın verdiği "son güncelleme" ya da duyuru tarihidir; tarih görünmüyorsa yazılmadı.
- Yerli sistemlerin (NarPOS, Adisyo, Simpra, Menulux) kamuya açık kullanım belgesi az; bulguların çoğu tanıtım
  sayfasından. robotPOS ve SambaPOS belgeleri daha ayrıntılı. ModPOS için kamuya açık belge bulunamadı; kafedeki kurulumun
  26 Ekim 2026 incelemesi kullanıldı (`docs/01-ANALIZ.md`).
- LafPOS'un bugünkü davranışı koddan okundu; yanında dosya yolu var.

## LafPOS'ta bugün olanlar (kıyas için)

- Adisyon iki kart (ürünler | hesap); telefonda önce ürünler, altta Gönder ve tutarı yazan "Öde" şeridi; tezgâhta "Öde"
  kalemleri bara gönderip ödemeyi açıyor (`DESIGN.md` §3, `src/pages/order/OrderPage.tsx`).
- Hesap kartında gönderilmemiş kalemler amber "Gönderilmedi" bloğunda; gönderilenlerde durum yazısı: Bara gitti,
  Hazırlanıyor, Hazır, Teslim (`src/pages/order/CartPanel.tsx`).
- Künye: tür, kişi (yalnız masada), garson, açılış saati, müşteri, not (`OrderPage.tsx`).
- Ürün ızgarasında "Sık" kategorisi, arama ("/"), iki boylu üründe kartta M ve L düğmeleri, tükenen kart soluk
  (`src/pages/order/ProductPanel.tsx`).
- Seçenek: zorunlu grupta (Türk kahvesi şekeri) önseçim yok ve seçilene dek Ekle kapalı; isteğe bağlı tek seçimlik grupta
  varsayılan önseçili (Normal süt, Cam bardak); ayar "Seçenekleri sor" iki değerli: "zorunlu" ya da "hep"; tek boylu ve
  seçenekli ürün her durumda pencereyle ekleniyor (`src/lib/boot.ts` `defaultPicks`, `asksOptions`;
  `src/pages/order/OptionsModal.tsx`; `ProductPanel.tsx`).
- Gönderilmiş kalemin menüsü: İptal et, İkram et (ya da geri al), Zayi yaz, Kaleme indirim (`CartPanel.tsx`).
- Ödeme penceresi üç yol: Tutar, Kalem, Paylaş. Paylaş'ta kişi sayısı ± ile (başlangıç adisyonun kişi sayısı, en az 2,
  en çok 30); pay tutarını sunucu hesaplıyor; hesap değişince kalan, ödenmemiş paylara yeniden bölünüyor; bütün paylar
  ödendiği hâlde kalan varsa pencere uyarıyor (`src/pages/order/PaymentModal.tsx`, `shared/order-calc.ts` `splitState`).
- Ciro dışı üç tür: ikram, ödenmez (personel yemeği, patron hesabı), zayi; gerekçe listeleri ayarlarda (ödenmez için
  varsayılan: Personel yemeği, Patron / ortak, Müşteri şikâyeti, Deneme). Kalemde işlemi kimin yaptığı (`compBy`)
  tutuluyor, kimin için yapıldığı tutulmuyor (`shared/comp.ts`, `server/lib/settings.ts`, `server/services/orders.ts`).

## 1. Adisyon ekranı

### Tablet ve bilgisayarda yerleşim

- **Toast:** hızlı sipariş (Quick Order) ekranında hesap solda; sol üstten başlayıp saat yönünün tersine masa numarası,
  sekme adı, garson, servis ücreti, bölme, indirim ve kişi sayısı denetimleri sıralanıyor; menü üç katman: menü, grup,
  ürün ([Toast, Manage Orders With Toast POS](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens),
  son güncelleme 25 Mart 2026). Menünün üstünde arama kutusu, yanında açık ürün ("Open Item") düğmesi; sonuçta ürünün
  POS'taki yeri görünüyor, tükenen ürün gri, kutunun altında son seçilen ürünler hızlı yeniden sipariş için listeleniyor
  ([Toast, Use Menu Item Search on POS](https://support.toasttab.com/en/article/Menu-Item-Search)). Arama kutusu ayardan
  kapatılabiliyor ([Toast, Remove Search Bar](https://support.toasttab.com/en/article/How-can-I-remove-the-search-bar-from-the-POS-order-screen)).
- **Toast Open View:** küçük ve orta boy menüler için renk kodlu düz sütunlar; bütün seçenekler aynı anda görünüyor,
  menüler solda, gruplar sağda dikey kayan rayda; karşılanmamış zorunlu grubun başlığında kırmızı X, karşılanınca yeşil
  tik; el terminalinde yok ([Toast, Get Started With Open View](https://support.toasttab.com/en/article/Get-Started-Open-View)).
- **Lightspeed K-Series:** Kasa (Register) ekranı üç parça: sipariş özeti, tuş takımı, menü. Özet kalemleri, koltuk ve
  kurs bilgisini, etiketleri, vergiyi ve ödenecek tutarı gösteriyor; Eylemler düğmesi indirim ve sipariş etiketlerini
  açıyor; ortada ana kategoriler, seçilince sağda alt menü; Öde ekranın altında ve sipariş boşken ödeme başlamıyor
  ([Lightspeed, Understanding the Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen)).
  Ürün arama düğmesi isteğe bağlı, POS ayarından açılıyor
  ([Lightspeed, Managing and understanding POS configurations](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804606610-Managing-and-understanding-POS-configurations)).
  Eski sürüm ayarlarında ürün düğmelerinin satır ve sütun sayısı dikey ve yatay için ayrı, fişin yeri sol ya da sağ
  ([Lightspeed, Restaurant app settings](https://resto-support.lightspeedhq.com/hc/en-us/articles/234749548-Restaurant-app-settings)).
- **TouchBistro:** sipariş ekranı dört bölüm; sol üstte menü, sağ üstte o anki sipariş
  ([TouchBistro, Taking Orders](https://cdn.touchbistro.com/help/articles/taking-orders)). Ödeme Kasa (Register)
  ekranında; sol altta hızlı ödeme düğmeleri ([TouchBistro, The Register Screen](https://cdn.touchbistro.com/help/articles/the-register-screen)).
- **Loyverse:** tablette ürünler varsayılan olarak ızgarada, istenirse tek sütun liste; elle düzenlenen özel sayfalar
  ([Loyverse, How to Change Home Sale Screen Layout](https://help.loyverse.com/help/home-sale-screen-layouts)), en çok 6
  sayfa ve sayfa başına 20 öğe ([Loyverse Glossary](https://support.loyverse.com/en/articles/10010378-loyverse-glossary)).
- **Odoo 18:** üstte Plan, Masa ve masaya bağlı olmayan sipariş düğmesi; ürünler eklenince "Order" ile onaylanıyor,
  "Payment" ile yöntem seçilip "Validate"
  ([Odoo 18, Restaurant features](https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale/restaurant.html)).
  Odoo 20'de üst düğmeler Tables, Register, Orders
  ([Odoo 20, Restaurant features](https://www.odoo.com/documentation/20.0/applications/sales/point_of_sale/restaurant.html)).
- **robotPOS:** satış ekranında soldan ekran grubu seçiliyor, ortadaki ürünlere dokunularak adisyona ekleniyor
  ([robotPOS, Kasa işlemleri kılavuzu](https://docs.robotpos.com/klavuz-kasaislemleri)).
- **SambaPOS:** kategoriler ekranın ortasında, ürünler sağda
  ([SambaPOS, How to Take Order to Customer](https://kb.sambapos.com/en/5-1-1-b-how-to-take-order-to-customer/)).

### Telefonda

- **Toast Go 2:** hesaba ürün eklenmeden önce menü görünüyor; hesap büyüdükçe ayrıntısı menünün üstüne yığılıyor;
  gönderilince masa ekranına dönülüyor ([Toast, Manage Orders](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens)).
  El terminalinde "eşit böl" üç nokta menüsünde ([Toast, Manage Payments With Toast POS](https://support.toasttab.com/en/article/New-POS-Managing-Payments)).
- **Lightspeed K-Series, yeni gezinme (beta):** iPhone'da altta masa planı, sipariş yönetimi ve ayarlar; Kasa ekranı
  açılınca çubuk gizleniyor, sol üstteki Kapat ile geri geliyor; Mayıs 2026'dan sonra kaydolanlarda varsayılan
  ([Lightspeed, About the new POS navigation](https://k-series-support.lightspeedhq.com/hc/en-us/articles/43162671781659-About-the-new-POS-navigation)).
  Nisan 2026 notu bunu tek elle, başparmağa uygun gezinme ve %15'e kadar daha fazla ekran alanı diye tanıtıyor
  ([Lightspeed, What's New: April 2026](https://k-series-support.lightspeedhq.com/hc/en-us/articles/49458066662171-What-s-New-April-2026-Table-pacing-reservations-pricing-insights-and-more)).
- **Square for Restaurants (mobil):** masa seç, kişi sayısı, ürün ekle, "Add to bill", Gönder; hesabı görmek için
  "Bill" ([Square, Take orders tableside](https://squareup.com/help/us/en/article/8152-take-orders-tableside-with-square-for-restaurants-mobile-pos)).
- **Loyverse:** telefonda ürünler varsayılan olarak liste, istenirse üç sütun ızgara
  ([Loyverse, Home Sale Screen Layout](https://help.loyverse.com/help/home-sale-screen-layouts)); özel sayfa yerine en çok
  30 ürünlük Favoriler ([Loyverse, Favorites on Smartphones](https://help.loyverse.com/help/favorites-on-smartphones));
  tahsil düğmesi ("Charge") sağ altta ([Loyverse, How to Make Sales](https://help.loyverse.com/help/make-sales)).
- **Ortak desen:** telefonda önce menü; hesap ya menünün üstüne yığılıyor (Toast) ya ayrı görünümde (Square'in "Bill"i);
  tahsil düğmesi altta (Loyverse). Toast ve Square'de telefonda sürekli görünen bir sepet çubuğunun ayrıntısı
  belgelerden doğrulanamadı.

### Adisyonun başlığı (künye)

- **Toast:** hesabın üstünde masa, sekme adı, garson, servis ücreti, bölme, indirim ve kişi sayısı; az kullanılanlar
  (bölme, kişi sayısı) taşma menüsünde ([Toast, Manage Orders](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens)).
  Hızlı sipariş başlığında garson adı artık hep görünüyor, bölme ve servis ücreti başlığa taşındı
  ([Toast, Updates to the new POS experience](https://updates.toasttab.com/announcements/updates-to-the-new-pos-experience)).
  Her yeni sipariş 1 kişiyle açılıyor, doğru kişi sayısı için personel elle düzeltmeli
  ([Toast, Total Guest Counts](https://support.toasttab.com/en/article/How-is-Guest-Count-Calculated)). Koltuğa göre
  sipariş açıksa hesapta numaralı koltuk başlıkları, sağ üstte önceki ve sonraki koltuk düğmeleri
  ([Toast, Use Order by Seat](https://support.toasttab.com/en/article/Order-by-Seat)).
- **Square:** masa açılırken kişi sayısı seçiliyor ([Square, Take orders tableside](https://squareup.com/help/us/en/article/8152-take-orders-tableside-with-square-for-restaurants-mobile-pos));
  koltuk izleme cihaz başına açılıyor, koltuk eklenip çıkarıldıkça kişi sayısı kendiliğinden güncelleniyor
  ([Square, Manage seats](https://squareup.com/help/us/en/article/8583-manage-seats-in-your-restaurant)).
- **Lightspeed K-Series:** özette görünüm (kurs ya da koltuk), "Covers" (kişi; hesabı eşit böler) ve sipariş profili
  (paket, kurye) düğmeleri ([Lightspeed, Understanding the Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen)).
- **LafPOS:** künye (tür, kişi, garson, açılış saati, müşteri, not) Toast'un başlığının kafeye gereken kısmını zaten
  taşıyor; masa kartında süre ve garson var (`OrderPage.tsx`, `DESIGN.md` §3).

### Kalemleri duruma ve kursa göre gruplama

- **Toast:** Gönder, Kal ve Beklet düğmeleri hesaba ürün eklenince çıkıyor ve ekranın altına sabit; Kal girileni
  gönderip ekranda bırakıyor, Beklet henüz gönderilmeyecek kalemler için; "ödemeden sonra gönder" ayarı açıksa Gönder ve
  Beklet kalkıyor; menü grubuna kurs bağlanabiliyor ([Toast, Use the Send, Stay and Hold Buttons](https://support.toasttab.com/en/article/Differences-Between-the-Send-Stay-and-Hold-Buttons)).
  Kurs kullanımı hızlı sipariş ve masa servisi için ayrı ayrı zorunlu, isteğe bağlı ya da kapalı
  ([Toast, Manage Course Firing Options](https://support.toasttab.com/en/article/Course-Firing-Options), son güncelleme
  31 Aralık 2025).
- **Square:** kursun yanındaki ateş simgesi, sonra Gönder ([Square, Take orders tableside](https://squareup.com/help/us/en/article/8152-take-orders-tableside-with-square-for-restaurants-mobile-pos),
  [Square, Hold and fire courses](https://squareup.com/help/article/8172-hold-and-fire-courses-with-square-kds-and-square-for-restaurants)).
- **TouchBistro:** Gönder; içecekleri ve ilk kursu önce yollamak için Kurs; 12'ye kadar kurs; Beklet seçenekleri kurs
  ekranında; koltuklar renk kodlu ([TouchBistro, Taking Orders](https://cdn.touchbistro.com/help/articles/taking-orders),
  [TouchBistro, Sending Drinks and Courses at Separate Times](https://cdn.touchbistro.com/help/articles/sending-drinks-and-courses-at-separate-times)).
- **SpotOn:** kalemin durumu eylemi belirliyor: gönderilmemiş kalem "Kaldır", gönderilmiş kalem "İptal"
  ([SpotOn, Item Commands Menu](https://help.spoton.com/space/SK/2055536951/Item+Commands+Menu+%7C+SpotOn+Restaurant+FOH)).
- **SambaPOS:** masa rengi durumu söylüyor (turuncu: sipariş gönderildi, masa dolu; koyu kırmızı: hesap yazdırıldı ama
  ödenmedi); gönderilmiş kalem "Void" ile iptal edilip stoğa dönüyor
  ([SambaPOS Staff Training Manual](https://forum.sambapos.com/uploads/short-url/d3FCrHF3Iuf5aOL7F2WAeEoNBd8.pdf)).
- **Kafe için anlamı:** kurs ve beklet masa servisli restoranın aracı; Toast'ta bile ayarla kapatılıyor. LafPOS'un
  "Gönderilmedi" bloğu ve kalem durumu kafenin ihtiyacını karşılıyor.

### Kalem eylemleri ve dokunuş sayısı

- **Square:** adisyonu aç, kaleme dokun, "…", İkram (Comp), gerekçe seç, İkram: kalem başına dört dokunuş; iptal aynı
  yoldan; adisyonun tamamı için Eylemler menüsü; devretme ve taşıma da orada
  ([Square, Comp, void, and reassign checks](https://squareup.com/help/us/en/article/8166-comp-void-and-reassign-checks-with-square-for-restaurants)).
  Beta "Real Time Check View"da sepette çoklu seçim ve toplu İkram, İptal, Taşı, Kaldır; toplu işlem tekli işlemle aynı
  yetkiyi istiyor ([Square, Real Time Check View](https://squareup.com/help/us/en/article/8633-set-up-and-manage-real-time-check-view-for-restaurants)).
- **Toast:** hesaptaki kaleme dokununca adet, açıklama ve görsel, Tekrarla, Sil ve kalem ayarları (servis türü, kurs,
  bölme, özel istek, indirim) ([Toast, Manage Orders](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens));
  iptalde kalem, İptal, onay ve (tanımlıysa zorunlu) gerekçe; yetkisi olmayana yönetici kodu
  ([Toast, Void Items, Payments, and Checks](https://support.toasttab.com/en/article/Voiding-Items-Payments-and-Checks)).
  Çoklu kalem seçimi cihaz başına açılan bir kip ([Toast, Multi-Item Selection Mode](https://support.toasttab.com/en/article/Multi-Item-Selection-Mode));
  gönderilmiş kalemin seçeneğini değiştirmek ayrı yetki ([Toast, Permissions Reference](https://support.toasttab.com/en/article/Access-Permissions-Reference)).
- **SpotOn:** bir ya da birkaç kalem seçilince "Kalem Komutları": İndirim ekle, Tekrarla, İptal, İptali geri al,
  Beklet, Bırak, Kaldır; düğmeler kalemin durumuna ve yetkiye göre
  ([SpotOn, Item Commands Menu](https://help.spoton.com/space/SK/2055536951/Item+Commands+Menu+%7C+SpotOn+Restaurant+FOH));
  kilitli indirim yönetici onayı istiyor ([SpotOn, Apply Discounts](https://help.spoton.com/space/SK/2666627613)).
- **Lightspeed K-Series:** tuş takımının yan düğmelerinde "Edit" (indirim ve kalem aktarımı) ve "Quickpay"
  ([Lightspeed, Understanding the Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen)).
- **LafPOS:** gönderilmiş kaleme dokun, İkram et, gerekçe, "1 adet ikram" (gerekirse PIN): Square'le aynı, dört dokunuş
  (`CartPanel.tsx`). Toast ve SpotOn'daki "Tekrarla" yok.

### Öde ve Gönder

- **Toast:** Gönder, Kal, Beklet altta sabit ([Toast, Send, Stay and Hold](https://support.toasttab.com/en/article/Differences-Between-the-Send-Stay-and-Hold-Buttons));
  perakende kipinde Öde işlemi bitiriyor ([Toast, Get Started With Retail POS Mode](https://support.toasttab.com/en/article/Get-Started-With-Retail-POS-Mode)).
- **Lightspeed K-Series:** Gönder kalemleri mutfağa yolluyor, sipariş kapanana dek açık kalıyor
  ([Lightspeed, Placing basic orders](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050308894-Placing-basic-orders));
  Öde altta ([Lightspeed, Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen)).
- **TouchBistro** hızlı ödeme düğmeleri ([TouchBistro, The Register Screen](https://cdn.touchbistro.com/help/articles/the-register-screen)),
  **Loyverse** sağ altta "Charge" ([Loyverse, How to Make Sales](https://help.loyverse.com/help/make-sales)), **Odoo**
  "Order" ve "Payment" ([Odoo 18](https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale/restaurant.html)).
- **LafPOS:** altta Gönder ve tutarı yazan "Öde"; tezgâhta Öde hem gönderiyor hem ödemeyi açıyor (`OrderPage.tsx`). Bu,
  Toast'un "ödemeden sonra gönder" ayarının tezgâh karşılığı.

### Ürün ızgarası: arama, kategori, boy, tükendi

- **Kategori:** Toast'ta menü, grup, ürün; Open View'da menüler solda, gruplar sağda dikey ray
  ([Toast, Open View](https://support.toasttab.com/en/article/Get-Started-Open-View)); Lightspeed'de ortada ana
  kategori, sağda alt menü ([Lightspeed, Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen));
  Loyverse telefonda kategori açılır listesi ("All items") ve arama ([Loyverse, How to Make Sales](https://help.loyverse.com/help/make-sales));
  robotPOS'ta solda ekran grupları ([robotPOS, Kasa işlemleri](https://docs.robotpos.com/klavuz-kasaislemleri)).
  Square'de kart boyu ayarı: "Tall" (varsayılan, 4 sütun, yoğun ve hızlı) ya da "Wide" (2 sütun, uzun adlar için)
  ([Square, Troubleshoot item details and variation selection](https://squareup.com/help/us/en/article/8665-troubleshoot-item-details-and-variation-selection-on-square-point-of-sale)).
- **Kartta boy:** Toast'ta boya göre fiyatlanan üründe seçenek grupları arasında bir "Size" düğmesi çıkıyor ve
  varsayılan olarak seçili ([Toast, Size price](https://doc.toasttab.com/doc/platformguide/adminSizePrice.html));
  kahveciler için önerisi her boyu ayrı ürün yapmak (personel neyi hazırlayacağını tam bilsin) ya da boy fiyatı
  ([Toast, Configure Menus for Bakeries or Coffee Shops](https://support.toasttab.com/en/article/Menu-Best-Practices-for-Bakeries-Coffee-Shops)).
  Square'de ürün başına "ilk varyasyonu önseç" ([Square, item details](https://squareup.com/help/us/en/article/8665-troubleshoot-item-details-and-variation-selection-on-square-point-of-sale)).
  SambaPOS'ta porsiyonlu ürün eklenince ilk porsiyon kendiliğinden seçiliyor, düğme belirli bir porsiyona
  bağlanabiliyor ([SambaPOS, How to Design Detailed Menu](https://kb.sambapos.com/en/2-3-8-a-how-to-design-detailed-menu/));
  kullanıcılar seçenek ekranını atlamak için porsiyon başına ayrı düğme kuruyor
  ([SambaPOS forumu, Portion Buttons](https://forum.sambapos.com/t/portion-buttons-questions/13228),
  [SambaPOS forumu, Popup tags/portions](https://forum.sambapos.com/t/popup-tags-portions/2566)).
- **Tükendi:** Toast'ta karta basılı tutup hızlı düzenlemede "Out of Stock"; kart gri, seçilemiyor, köşesinde 0;
  adet 0'a inince kendiliğinden; cihazda yönetici kodu ister
  ([Toast, 86 an Item](https://support.toasttab.com/en/article/86-an-Item), son güncelleme 17 Aralık 2025). Square'de
  menüde ürüne uzun basıp "Edit Availability", Tükendi; iş günü sonunda kendiliğinden satışa dönüyor
  ([Square, Managing items with Square for Restaurants](https://squareup.com/help/us/en/article/6425-managing-items-with-square-for-restaurants));
  duyuruya göre tükenen ürün online sipariş edilemiyor, içeride adisyona eklenmeden önce uyarı çıkıyor
  ([Square duyurusu](https://www.sellercommunity.com/t5/Product-Updates/Mark-an-Item-as-Sold-Out-with-Square-and-86-Items-with-Square/ba-p/299271)).
  SpotOn'da kart görünür ama gri ([SpotOn, Mark an Item Unavailable](https://help.spoton.com/space/SK/2665578707)).
  ModPOS'ta şube menüsünde ürün başına "Satışa açık", "Ekranda gizle", "Kısayol" (`docs/01-ANALIZ.md` §1).
- **Hızlı erişim:** Toast aramanın altında son seçilenler ([Toast, Menu Item Search](https://support.toasttab.com/en/article/Menu-Item-Search));
  robotPOS ana ekranda "Hızlı Menü veya Favori Ürünler" grubu ([robotPOS SSS](https://docs.robotpos.com/sorucevap));
  Loyverse telefonda Favoriler ([Loyverse](https://help.loyverse.com/help/favorites-on-smartphones)).

### Yerli sistemlerde

- **robotPOS:** ürüne zorunlu özellik tanımlanıp seçim yapılmadan sipariş onaylanmayabiliyor; adisyon onaylanmadan ya
  da ödeme alınmadan çıkılırsa iptal sebebi soruluyor ve rapora yazılıyor ([robotPOS SSS](https://docs.robotpos.com/sorucevap));
  ayar açıkken masa taşıma ve ürün ayırmada sebep soruluyor ([robotPOS sürüm notları](https://docs.robotpos.com/surumnotlari-infinia)).
- **NarPOS:** garson uygulaması NarApp telefon ve tablette siparişi takip ediyor, son sürümde "garson masa açma rolü"
  geliştirildi ([App Store, NarApp](https://apps.apple.com/us/app/id6471075475)); dokunmatik masa takibi ve hızlı
  sipariş girişi ([NarPOS, Kafe](https://narpos.com.tr/isletme/kafe)).
- **Adisyo:** tanıtıma göre masa, gel-al ve paket siparişleri ve dış kanal siparişleri tek panelde ([Adisyo](https://adisyo.com/)).
- **Menulux Garson:** masa ve adisyon takibi, indirim, iptal, iade, kısmi ödeme, internetsiz çalışma
  ([App Store, Menulux Garson](https://apps.apple.com/us/app/-/id6742921152)).
- NarPOS, Adisyo, Simpra ve Menulux'un adisyon ekranı yerleşimini anlatan kamuya açık kullanım belgesi bulunamadı.

### LafPOS için öneri

1. **Koruyun:** iki kartlı adisyon; telefonda önce ürünler, altta Gönder ve "Öde · tutar". Kurs, beklet ve koltuk
   eklemeyin; bar tek istasyon ve Toast'ta bile kurs ayarla kapanıyor.
2. **Şimdi:** gönderilmiş kalemin menüsüne "Bir daha": aynı ürün ve aynı seçeneklerle Gönderilmedi bloğuna bir adet
   (Toast ve SpotOn'daki Tekrarla). Çay, su gibi tekrar eden siparişte tek dokunuş.
3. **Şimdi:** ürün kartına uzun basınca "Tükendi" ya da "Satışta" (yetkiyle, denetim kaydıyla), Toast ve Square'deki
   gibi. Kart soluk kalırken üstünde "Tükendi" yazsın; renk tek başına durum taşımasın.
4. **Şimdi:** arama kutusu boşken altında son eklenen birkaç ürün (Toast). "Sık" kategorisi kalır.
5. **Sonra, ihtiyaç görülürse:** çoklu seçimle toplu İkram, İptal, Taşı (Square'in betası, Toast'un kipi) ve kalemi
   başka adisyona taşıma (Square Move). Bugün yalnız adisyonun tamamı taşınıyor; tek tek işlem yetiyorsa eklemeyin.
6. **Yapmayın:** bütün seçenekleri aynı anda açan ekran (Toast Open View). Toast bunu seçeneği bol küçük menüye
   öneriyor; L'Affogato'da seçenek az ve çoğu varsayılanla geçiyor.

## 2. Hesap bölme

### Eşit bölme ve kişi sayısı

- **Toast:** ödeme ekranının altındaki "Split evenly" hesabı seçilen sayıda eşit hesaba bölüyor, el terminalinde üç
  nokta menüsünde; bölme ekranında Eşit böl, Koltuğa göre böl ve Bitti; koltuğa göre bölme ancak kalemlere koltuk
  girilmişse ([Toast, Manage Payments](https://support.toasttab.com/en/article/New-POS-Managing-Payments)). Hesaptaki
  servis ücreti kişilere eşit bölünüyor; kalem seçiliyken "Split evenly" o kalemi istenen sayıya bölüyor; bölme düğmesi
  en çok dokuz parça ([Toast, Split Checks on the POS](https://support.toasttab.com/en/article/Splitting-Checks-by-Item-1492811097734),
  son güncelleme 29 Ocak 2026). El terminali ve Flex'e "Split by #" ile serbest sayı girişi geldi; ABD'de 11 Kasım
  2025'ten itibaren ([Toast, Open input for split checks](https://updates.toasttab.com/announcements/open-input-for-split-checks)).
- **Square:** ödemeyi bölmede "Split Amount" ile tutar ya da eşit ödemeler altında kaç parça
  ([Square, Split a payment and check](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants),
  [Square, Process split tender payments](https://squareup.com/help/us/en/article/5097)).
- **Lightspeed K-Series:** özetteki "Covers" hesabı kişi sayısına eşit bölüyor
  ([Lightspeed, Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen));
  koltuğa ya da kişiye göre eşit pay; önce Back Office'te gelişmiş bölme açılmalı
  ([Lightspeed, Splitting a bill](https://k-series-support.lightspeedhq.com/hc/articles/360051089493-Splitting-a-bill)).
- **TouchBistro:** "Split Evenly By #" ile hesap sayısı giriliyor, bölünen hesaplar ödeme ekranının altında diziliyor
  ([TouchBistro, Checkout](https://cdn.touchbistro.com/help/articles/checkout/)).
- **SpotOn:** Ödeme, "Divide Balance", kişi sayısı, Kabul (100 dolar 4 kişiye 4 × 25)
  ([SpotOn, Split Items, Checks, and Payment Types](https://help.spoton.com/space/SK/846954605/Split+Items%2C+Checks%2C+and+Payment+Types+%7C+SpotOn+Restaurant+FOH)).
- **Loyverse:** ödeme ekranında + ve − ile ödeme sayısı; tutar varsayılan olarak eşit bölünüyor
  ([Loyverse, How to Split Payment](https://help.loyverse.com/help/payment-loyvers)).
- **SambaPOS:** Payment Sense modülünde kişi sayısı girilip F1 kişi başı, F2 çift başı, F3 özel bölme
  ([SambaPOS, Payment Sense settings](https://kb.sambapos.com/en/6-2-how-to-configure-payment-sense-pay-at-table-settings/)).
  Standart kurulumda tek adisyonu eşit tutarlara bölmek yerleşik değil; forumda kişi sayısı etiketine bölen fiş şablonu
  ve "Move" ile ayrı adisyon öneriliyor ([SambaPOS forumu, Divide one bill](https://forum.sambapos.com/t/divide-one-bill-for-multi-people-and-can-print-out-receipt-for-each-people-by-every-time-payment-done/10561),
  [SambaPOS, Splitting Items or Ticket](https://kb.sambapos.com/en/5-4-5-how-to-get-payment-by-splitting-items-or-ticket/)).
- **Odoo:** masaya dokununca kişi sayısı 1 ([Odoo 18, Restaurant features](https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale/restaurant.html));
  bir forum yanıtına göre kişi sayısı kişi başı tutar öneriyor ama her ayrı faturaya eşit tutar bölünemiyor
  ([Odoo forumu, POS Bill Splitting by person](https://www.odoo.com/forum/help-1/pos-bill-splitting-by-person-269868)).
- **Revel:** 2013 duyurusuna göre istenen sayıda kişiye eşit ya da kaleme göre
  ([Revel blog, 2013](https://blog.revelsystems.com/blog/2013/09/30/new-feature-split-bill-capabilities)).
- **Clover:** kendi blog yazısına göre eşit, kaleme ya da koltuğa göre
  ([Clover blog](https://blog.clover.com/creating-your-own-restaurant-split-check-policy)); resmî adım adım belge
  bulunamadı.
- **Hazır 2 · 3 · 4 çipi:** hiçbir sistemin belgesinde açıkça bulunamadı. Toast'un dokuz parça sınırı ve sonradan eklenen
  serbest giriş, sayının bir listeden seçildiğini düşündürüyor; ekran görülmediği için çip mi tuş mu olduğu
  doğrulanamadı.

### Farklı tutarlı paylar

- **Square:** ödeme bölmede her ödemenin tutarı elle giriliyor ve bakiye kapanana dek ödeme ekleniyor; "Edit Split" ile
  tutar değiştirilip ödemeler iptal edilebiliyor ([Square 8165](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants)).
  Bir Square makalesine göre bölünmüş ödeme beş dakikada tamamlanmazsa hesap zaman aşımına uğrayıp alınmış ödemeleri
  geçersiz kılabiliyor ([Square 5097](https://squareup.com/help/us/en/article/5097)).
- **Loyverse:** eşit bölünen her parçanın tutarı elle değiştirilebiliyor; her parçaya ödeme türü seçilip sırayla
  tahsil ediliyor; satış tek fiş ([Loyverse, How to Split Payment](https://help.loyverse.com/help/payment-loyvers)).
- **SpotOn:** ödeme türüne göre bölme (hediye çeki ve kalanı nakit ya da kart)
  ([SpotOn, Split](https://help.spoton.com/space/SK/846954605/Split+Items%2C+Checks%2C+and+Payment+Types+%7C+SpotOn+Restaurant+FOH));
  SambaPOS Payment Sense'te özel bölme (F3) ([SambaPOS](https://kb.sambapos.com/en/6-2-how-to-configure-payment-sense-pay-at-table-settings/)).
- **Toast, Mart 2026 düzeltmesi:** "indirim gibi say" ayarlı nakit ve diğer ödemeler eşit bölmeye katılmıyordu, her pay
  kalan yerine tam tutardan hesaplanıyordu; artık kısmi ödemeden sonra kalan bölünüyor (sürüm 2.104, 24 Mart 2026)
  ([Toast, Split payment amounts now include all payment types](https://updates.toasttab.com/announcements/split-payment-amounts-now-include-all-payment-types)).

### Kaleme ya da kişiye göre bölme

- **Toast:** bölme kipinde kalemlere dokunup yeni hesaba taşıma; servis ücreti bölünen hesaplara geçmiyor, elle
  ekleniyor ([Toast, Split Checks](https://support.toasttab.com/en/article/Splitting-Checks-by-Item-1492811097734)).
  Koltuğa göre bölme ekranına "Actions" geldi: seçili koltuklar arasında kalem paylaştır, başka hesaba taşı (Eylül 2025
  İngiltere, İrlanda ve Kanada; ABD'de 6 Nisan 2026, sürüm 2.104)
  ([Toast, Improved experience for splitting and moving items](https://updates.toasttab.com/announcements/improved-experience-for-splitting-and-moving-items),
  [Toast, Split checks actions workflow in the USA](https://updates.toasttab.com/announcements/split-checks-actions-workflow-is-now-available-to-locations-in-the-usa)).
- **Square:** koltuğa göre (cihazda koltuk izleme açıksa; birden çok koltuğa atanmış kalem eşit bölünüyor) ve kaleme
  göre; kalem bölme Plus aboneliğinde ([Square 8165](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants)).
  Bölünmüş kalemin bir parçası iptal edilince kalem kendiliğinden birleşiyor; bölünmüş kalem üçüncü taraf
  entegrasyonlara geçmiyor ve raporda birden çok satış gibi görünebiliyor
  ([Square, Item splits](https://squareup.com/help/ca/en/article/8450-beta-item-splits)).
- **TouchBistro:** "Split By Seating" (kendi koltuğu ve paylaşılan kalemlerin payı) ve tek koltuğu ayrı ödetme
  (paylaşılanlar orantılı) ([TouchBistro, Checkout](https://cdn.touchbistro.com/help/articles/checkout/)); koltuklar
  arasında kaydırarak bölme patentli ([TouchBistro basın bülteni](https://www.touchbistro.com/press-releases/touchbistro-ipad-pos-awarded-patent-for-its-feature-to-easily-and-quickly-split-bills-between-customers/)).
- **SpotOn:** "Split By Guest"; bir kalemi birkaç kişiye bölmek geri alınamıyor
  ([SpotOn, Split](https://help.spoton.com/space/SK/846954605/Split+Items%2C+Checks%2C+and+Payment+Types+%7C+SpotOn+Restaurant+FOH)).
- **Odoo:** Actions, Split, ürün seç, alt sipariş; ana siparişe dönmeden alt sipariş ödenmeli
  ([Odoo 18](https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale/restaurant.html)); Odoo 20'de
  bölme ekranından doğrudan ödeme ve başka masaya aktarma ([Odoo 20](https://www.odoo.com/documentation/20.0/applications/sales/point_of_sale/restaurant.html)).
- **Loyverse:** açık adisyonu bölme; her parça siparişin ayrıntısını ve seçeneklerini koruyor
  ([Loyverse, How to Split an Open Ticket](https://help.loyverse.com/help/how-split-open-ticket-loyverse-pos)).
- **Revel:** kaleme ya da koltuk numarasına göre ([Revel, Split Bills](https://support.revelsystems.com/hc/en-us/articles/205125635-Split-Bills-));
  bölünen pizzada malzeme fiyatı bölünsün mü bölünmesin mi ayarı ([Revel blog, 2019](https://blog.revelsystems.com/blog/2019/02/26/pizza-updates)).

### Sıradaki pay ve ödenen paylar

- TouchBistro bölünen hesapları ödeme ekranının altında sıralıyor ([TouchBistro, Checkout](https://cdn.touchbistro.com/help/articles/checkout/));
  Square'de bakiye kapanana dek ödeme ekleniyor ([Square 8165](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants));
  Loyverse'te her parça kendi ödeme türüyle sırayla alınıyor ([Loyverse](https://help.loyverse.com/help/payment-loyvers)).
  Toast'ta eşit bölme ayrı hesaplar üretiyor; ödeme ekranının kalanı nasıl gösterdiği belgelerden doğrulanamadı.
- Toast topluluğunda bir kullanıcı eşit bölmeden sonra her ödemenin tutarını elle girmek zorunda kaldığından yakınıyor
  ([Toast topluluğu](https://community.toasttab.com/t5/restaurant-operations/simplify-splitting-a-ticket-in-a-table-in-toast/m-p/13813)):
  sıradaki payın tutarı ödeme düğmesinde hazır gelmeli.

### Bölündükten sonra hesap değişirse

- Toast Mobile Order & Pay'de bölünmüş hesaba garson Toast Go ya da POS'tan kalem ekleyip iptal edebiliyor
  ([Toast, Split Payments With Mobile Order & Pay](https://support.toasttab.com/en/article/Split-Payments-with-Toast-Mobile-Order-Pay),
  son güncelleme 8 Nisan 2026); POS'ta bölünmüş hesaba sonradan eklenen kalemin nasıl dağıldığı belgelerden doğrulanamadı.
- Square'de bölünmüş kalemin bir parçasını iptal etmek kalemi birleştiriyor ([Square 8450](https://squareup.com/help/ca/en/article/8450-beta-item-splits));
  bölünmüş ödeme tamamlanmazsa alınmış ödemeler iptal olabiliyor ([Square 5097](https://squareup.com/help/us/en/article/5097)).
- Toast'un Mart 2026 düzeltmesi, kalan yerine toplamdan bölmenin gerçek bir hata sınıfı olduğunu gösteriyor
  ([Toast duyurusu](https://updates.toasttab.com/announcements/split-payment-amounts-now-include-all-payment-types)).
- LafPOS'ta kalan, ödenmemiş paylara yeniden bölünüyor; bütün paylar ödendiği hâlde kalan varsa pencere "kişi ekleyin ya
  da Tutar ile alın" diyor (`shared/order-calc.ts`, `PaymentModal.tsx`).

### Özet tablo

| Sistem | Eşit bölme, sayı nasıl seçiliyor | Farklı tutarlı pay | Kaleme ya da koltuğa göre |
|---|---|---|---|
| Toast | Listeden (en çok 9); 2025'ten serbest giriş | Ödeme tutarı elle | Var; koltuk ekranında Actions (2025-2026) |
| Square | Kaç parça | "Split Amount" | Var; kalem bölme Plus'ta |
| Lightspeed K | "Covers" (kişi sayısı) | Belgede doğrulanamadı | Koltuk, kişi |
| TouchBistro | "Split Evenly By #" | Belgede doğrulanamadı | Koltuk, tek koltuk |
| SpotOn | "Divide Balance", kişi sayısı | Ödeme türüne göre | Kişiye göre; kalem bölme geri alınamaz |
| Loyverse | ± ile ödeme sayısı | Parça tutarı elle | Açık adisyonu bölme |
| SambaPOS | Payment Sense: kişi, çift, özel | Özel bölme (F3) | Move ile ayrı adisyon |
| Odoo | Kişi sayısı yalnız öneri | Belgede doğrulanamadı | Alt sipariş |
| LafPOS | ± (başlangıç kişi sayısı) | Pay açıkken yok; Tutar yolu ayrı | Kalem yolu |

### LafPOS için öneri

1. **Koruyun:** Paylaş'ın kuralı (sunucu kalanı ödenmemiş paylara böler, hesap değişince paylar kendiliğinden
   güncellenir). Bunu sınayan test kalsın; Toast'un Mart 2026 hatası tam bu noktadaydı.
2. **Şimdi:** kişi seçiminde adisyonun kişi sayısı önseçili kalsın (Lightspeed'in "Covers"ı), yanına tek dokunuşla
   2 · 3 · 4 çipi, fazlası ±. Çip belgelenmiş bir rakip özelliği değil; masaların çoğunun 2-4 kişi olduğu varsayımına
   dayanan bir kolaylık.
3. **Şimdi (denetim listesi):** sıradaki payın tutarı ödeme düğmesinde hazır ("Pay 2/4 · ₺145"), ödenen paylar
   yöntem ve saatle listede. Toast kullanıcısının yakındığı elle tutar girme olmasın.
4. **Şimdi:** bölündükten sonra kalem eklenir ya da iptal edilirse pencerede tek satır: "Hesap değişti: kalan 3 pay
   ₺X". Paylar zaten kendiliğinden güncelleniyor; kasiyer bunu görsün.
5. **Sonra:** "Bu payı farklı al": sıradaki payın tutarı değiştirilebilsin, kalan, kalan kişilere yeniden bölünsün
   (Loyverse'te parça tutarı değişiyor, Square'de tutarla bölme var). `splitState` zaten kalanı kalan paylara böldüğü için
   hesap aynı; bugün sunucu pay açıkken pay dışı ödemeyi reddediyor, yani bu bir sunucu kuralı değişikliği.
6. **Yapmayın:** yarım kalan bölünmüş ödemeyi zaman aşımıyla iptal etmek (Square'in anlattığı davranış) ve kalemi
   kesirlere bölmek (SpotOn'da geri alınamıyor, Square'de birleşme kuralı ve rapor bozulması var). Paylaşılan tatlı için
   "Kalem" yolu yeter.

## 3. İkram, personel yemeği ve patron hesabı

### Kavramlar: ikram, iptal, zayi

- **Square:** ikram (comp) hazırlanmış ya da teslim edilmiş kalemin ücretini kaldırmak, iptal (void) yanlış girilmiş ve
  henüz hazırlanmamış kalem ([Square, Get started with comp and void](https://squareup.com/help/us/en/article/5814-get-started-with-comp-and-void));
  iptal müşteri fişinde görünmüyor, ikram görünüyor; ikram satış ve stok raporlarında
  ([Square, Comp and void FAQ](https://squareup.com/help/us/en/article/6146-comp-and-void-faqs)).
- **Revel:** ikram hazırlanmış yemeğe, iptal hazırlanmamışa; ikram yalnız gönderilmiş ya da kapanmış kaleme
  ([Revel, Refund, Void, Comp, or Exchange Items](https://support.revelsystems.com/hc/en-us/articles/115005088546-Refund-Void-Comp-or-Exchange-Items)).
- **SambaPOS:** ikram (Gift) stoktan düşüyor, iptal (Void) stoğa dönüyor
  ([SambaPOS Staff Training Manual](https://forum.sambapos.com/uploads/short-url/d3FCrHF3Iuf5aOL7F2WAeEoNBd8.pdf));
  ikramın ve iptalin geri alınması ayrı komut ([SambaPOS, How to Cancel, Gift or Void Items](https://kb.sambapos.com/en/5-1-2-how-to-cancel-gift-or-void-items/)).
- **Lightspeed K-Series:** indirim "zayi" (wastage) işaretlenebiliyor; o indirimle kapanan kalem raporda kayıp görünüyor
  ([Lightspeed, Understanding discounts](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804657089-Understanding-discounts)).
- **Toast:** ayrı bir ikram türü yerine çoğunlukla %100 indirim; topluluk moderatörü personel yemeği için sabit %100
  indirim ve gerekçe öneriyor ([Toast topluluğu, How to track employee meals](https://community.toasttab.com/t5/restaurant-operations/how-to-track-employee-meals/m-p/3708));
  gerekçe ayarının adı "indirim ve gıda zayi gerekçeleri" ([Toast, Report on Discounts and Promo Codes](https://support.toasttab.com/en/article/Reporting-for-Discounts-Promo-Codes)).
- **Lightspeed'in "on the house"u:** K-Series belgelerinde bu adla bir ödeme yöntemi ya da indirim bulunamadı.
- LafPOS'un üçlüsü (ikram, ödenmez, zayi) bunlarla örtüşüyor. "Ödenmez" (personel, patron) yabancı sistemlerde ayrı tür
  olarak yok; orada ya indirim ya ikram gerekçesi. Bir üçüncü taraf muhasebe firması Toast için ikram gerekçelerini
  personel, sahip, işi geliştirme ve müşteri sorunu diye ayırmayı öneriyor
  ([Restaurant Accounting, Toast Best Practices](https://restacct.zendesk.com/hc/en-us/articles/4415064404883-Toast-Best-Practices)).

### Gerekçe zorunlu mu

- **Square:** her ikram ve iptalde ekip üyesi gerekçe seçmek zorunda; gerekçeler panelde tanımlanıyor
  ([Square, Comp and void FAQ](https://squareup.com/help/us/en/article/6146-comp-and-void-faqs)); serbest metin not yok,
  yalnız hazır liste ([Square topluluğu](https://community.squareup.com/t5/Questions-How-To/Can-I-change-or-add-to-the-reasons-for-comping-a-ticket/m-p/38122),
  [Square topluluğu, Add a note when voiding and comping](https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Add-a-note-when-voiding-and-comping-that-I-can-see-on-my/m-p/219391)).
- **Toast:** indirime gerekçe listesi atanınca POS'ta sormak varsayılan; gerekçe zorunlu yapılabiliyor, ayrıca "yorum
  zorunlu" ([Toast, Requiring a discount reason](https://doc.toasttab.com/doc/platformguide/adminDiscountReasons.html)).
  İptal gerekçesi tanımlıysa seçmek zorunlu, tanımlı değilse yalnız "Emin misiniz?"
  ([Toast, Void Items](https://support.toasttab.com/en/article/Voiding-Items-Payments-and-Checks)); gerekçeler Toast
  Web'de tanımlanıp yayımlanıyor ([Toast, Add Void Reasons](https://support.toasttab.com/en/article/Add-Void-Reasons)).
- **TouchBistro:** üç hazır iptal gerekçesi, yenisi eklenebiliyor ([TouchBistro, Void Reasons](https://cdn.touchbistro.com/help/articles/void-reasons));
  indirimde yönetici kodu isteği bir ayar ([TouchBistro, Discounts](https://www.touchbistro.com/help/articles/discounts/)).
- **Revel:** sık gerekçeler ayarda; elle gerekçe yazmayı kapatan alt ayar var
  ([Revel, Advanced POS Settings](https://support.revelsystems.com/hc/en-us/articles/204947635-Advanced-POS-Settings)).
- **SambaPOS:** ikram ve iptal gerekçeleri otomasyon komutunun değerleri; raporlar gerekçeye göre gruplanabiliyor
  ([SambaPOS, How to Create Gift and Void Reasons](https://kb.sambapos.com/en/2-3-8-d-how-to-create-gift-and-void-reasons/),
  [SambaPOS forumu](https://forum.sambapos.com/t/configuring-gift-void-reasons/2748)).
- **robotPOS:** günün sipariş iptalleri ve iadeleri nedenleriyle raporlanıyor
  ([robotPOS blog, Adisyon takibi](https://www.robotpos.com/blog_new/cafe-restoran-adisyon-takibi)).

### Kişiye bağlama: kim yedi, kim verdi, kim onayladı

- **Toast:** zorunlu yorumla alıcının adı yazılabiliyor ama yorum fişe basılmıyor (topluluk elçisi doğruluyor);
  kullanıcılar personeli adisyonun garsonu yapıyor ya da her personele ayrı indirim tanımlıyor
  ([Toast topluluğu, Print discount comment](https://community.toasttab.com/t5/restaurant-operations/print-discount-comment/m-p/13469));
  vardiya dışı yemekler için ortak bir "hayalet personel" PIN'i öneriliyor
  ([Toast topluluğu, aynı başlık](https://community.toasttab.com/t5/restaurant-operations/how-to-track-employee-meals/m-p/3711)).
- **TouchBistro:** personel indirimi her personelin kendi ayrıntı sayfasında tanımlanıyor, yüzde olabiliyor ve yönetici
  onayı isteyebiliyor; %100 ikram belirli personel türlerine (yönetici) sınırlanabiliyor
  ([TouchBistro, Discounts](https://www.touchbistro.com/help/articles/discounts/)); indirim ayrıntı raporu kimin verdiğini
  ve kimin onayladığını gösteriyor ([TouchBistro, Discounts and Void Reports](https://cdn.touchbistro.com/help/articles/discount-void-reports/)).
- **Lightspeed K-Series:** hangi indirimi kimin uygulayacağı kullanıcı grubuyla sınırlanıyor
  ([Lightspeed, Managing POS user groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804594730-Managing-POS-user-groups));
  "Discounts" raporu personeli indirim ve ikram etkinliğine göre sıralıyor ve brüt satışın indirimlenen yüzdesini
  gösteriyor; bu rapor (Advanced Insights) yalnız bazı bölgelerde ve istekle açılıyor
  ([Lightspeed, Discounts report](https://k-series-support.lightspeedhq.com/hc/en-us/articles/7367707150875-Discounts-report)).
- **Square:** raporda gerekçe var; çalışan sütunu olup olmadığı doğrulanamadı; satıcılar saat, tarih, kalem, çalışan ve
  ikram türüyle liste istiyor ([Square topluluğu, Inventory, voids, discounts, and comps reports](https://community.squareup.com/t5/Questions-How-To/Inventory-voids-discounts-and-comps-reports/m-p/653918)).
- **Sonuç:** "kimin için" alanını yapılandırılmış biçimde sunan bir sistem belgelerde bulunamadı; en yakını TouchBistro'nun
  personele özel indirimi.

### Açık hesap (house account) ve patron hesabı

- **Toast:** açık hesap POS'ta bir ödeme yöntemi; ödenince sipariş POS'ta kapanıyor, tutar müşterinin bakiyesine
  ekleniyor; kasiyer yönetici onayı olmadan kullanabiliyor; borç POS'ta kısmen, tamamen ya da fazlasıyla ödenebiliyor;
  vergiden muaf yapılamıyor; Toast Web'den POS'a eşitleme 30 dakikayı bulabiliyor
  ([Toast, Set Up and Manage House Accounts](https://support.toasttab.com/en/article/House-Accounts-1492809352564),
  son güncelleme 29 Ocak 2026; [Toast, Paying for orders with a house account](https://doc.toasttab.com/doc/platformguide/platformHouseAccountsPaymentMethod.html)).
- **Square:** açık hesapta müşteri, harcama sınırı ve not; POS'ta ödeme seçeneği olarak ekleniyor
  ([Square House Accounts for restaurants](https://squareup.com/us/en/house-accounts/restaurants),
  [Square topluluğu, Square house accounts](https://community.squareup.com/t5/Product-Updates/Square-house-accounts/ba-p/679122)).
- **Patron hesabı** için belgelenmiş özel bir kavram yok: ya açık hesap (sonra ödenecek) ya ikram gerekçesi ("sahip").
  LafPOS'ta ikisi de var: açık hesap (cari) ve "Ödenmez: Patron / ortak" (`server/lib/settings.ts`).

### Raporlar: kişi ve gerekçe kırılımı

- **Toast Web:** Raporlar, Nakit ve kayıp yönetimi, İndirimler: İndirim özeti, İndirim gerekçeleri, Onaylayana göre,
  Bütün indirimli siparişler; bu rapor yönetici ikram raporu olarak da kullanılıyor
  ([Toast, Report on Discounts and Promo Codes](https://support.toasttab.com/en/article/Reporting-for-Discounts-Promo-Codes),
  [Toast, Cash and Loss Management Reports Overview](https://support.toasttab.com/en/article/Exceptions-Report-Overview));
  iptallerde onaylayana göre rapor ([Toast, Void Items](https://support.toasttab.com/en/article/Voiding-Items-Payments-and-Checks)).
- **TouchBistro:** indirim ayrıntısı (veren, onaylayan, adisyon, saat) ve özeti; iptal ayrıntısı ve türe göre özeti
  ([TouchBistro, Discounts and Void Reports](https://cdn.touchbistro.com/help/articles/discount-void-reports/)).
- **Lightspeed:** "Discount Breakdown" varsayılan olarak bu ay, bütün kullanıcı ve cihazlar
  ([Lightspeed, Discount Breakdown report](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4403189301659-Discount-Breakdown-report)).
- **NarPOS:** "İade İkram Raporu"; ürün satış raporunda yalnız ikramları listeleme; yönetici uygulaması NarBOSS'a anlık
  ikram ve zayi bildirimi ([NarPOS, İade İkram Raporu](https://narpos.com.tr/ozellik/iade-ikram-raporu/38),
  [NarPOS, Ürün Satış Raporu](https://narpos.com.tr/ozellik/urun-satis-raporu/33),
  [NarPOS, Kafe](https://narpos.com.tr/isletme/kafe)).
- **ModPOS Patron:** ayrı "Ödenmez", "İkram" ve "Silinenler" raporları (`docs/01-ANALIZ.md` §1).
- **robotPOS:** personel performans ve personel ürün bazlı satış raporları ([robotPOS SSS](https://docs.robotpos.com/sorucevap));
  merkezi platformda personel yemekleri ayrı süreç ([robotPOS FAQ](https://en.robotpos.com/faq)). Blog yazısına göre
  personel yemeği için gider pusulası ya da uygun bir mali belge gerekebilir, işletmenin kendi takdiriyle verdiği ikram
  stok ve maliyet için POS'a kaydedilmeli ([robotPOS blog, ÖKC 2026](https://www.robotpos.com/blog_new/restoranda-yazarkasa-okc-entegrasyonu-2026-mevzuat-rehberi)).
  Bu mali bir yorum; mali müşavirle doğrulanmalı.

### LafPOS için öneri

1. **Koruyun:** üç tür (ikram, ödenmez, zayi), her birinde hazır gerekçe listesi, gerekçe zorunlu; serbest metin listenin
   altında.
2. **Şimdi:** ödenmez penceresine "Kim için" alanı. Gerekçe "Personel yemeği" seçilince personel listesinden kişi seçmek
   zorunlu (önseçili: oturumu açık kişi); "Patron / ortak"ta patron seçilir. Serbest yorum değil, kayıtlı kişi: Toast'ta
   yorumla yapılan iş raporlanamıyor ve fişe basılmıyor.
3. **Şimdi:** ikramda adisyona bağlı müşteri varsa ikram o müşteriye yazılsın; yoksa ayrıca sorulmasın.
4. **Şimdi:** ciro dışı raporu tek tablo: tür, gerekçe, kimin için; sütunlarda adet, tutar, yapan, onaylayan (Toast'un
   dört görünümü ve TouchBistro'nun veren ve onaylayan sütunları tek tabloda). Kişi başı personel yemeği dökümünü yalnız
   rapor yetkisi olan görsün.
5. **Şimdi:** patron için pencerede açık seçim: "Sonra ödenecek: açık hesaba yaz" ya da "Ücretsiz: ödenmez". Toast ve
   Square açık hesabı ödeme yöntemi olarak kuruyor; borç bakiyeye gidiyor, ciro dışına değil.
6. **Sonra, istenirse:** kişi başına aylık personel yemeği sınırı ya da uyarısı. Belgelenmiş bir rakip özelliği değil,
   operatör kararı.
7. **Doğrulatın:** personel yemeğinin mali belgesi (gider pusulası vb.) mali müşavirle.

## 4. Seçenekler: ne zaman sormamalı

### Zorunlu, isteğe bağlı ve kendiliğinden açılan grup

- **Toast:** üç davranış: zorunlu (seçmeden eklenmez), isteğe bağlı ve zorla göster (kaleme eklenince kendiliğinden
  açılır ama geçilebilir), isteğe bağlı (kendiliğinden açılmaz, personel grubu açar); en az seçim yalnız zorunlu grupta
  ([Toast, Configure Modifier Behavior](https://support.toasttab.com/en/article/Required-Optional-Modifiers)). Zorunlu
  gruplar akışta hep önce soruluyor ([Toast, Manage Modifier Group Display Order](https://support.toasttab.com/en/article/Editing-Managing-Modifier-Group-Display-Order)).
- **Square:** ürün başına "Skip customization when possible": açıksa seçim zorunlu değilse ayrıntı ekranı atlanıyor;
  yiyecek-içecek kipinde ayar her üründe uygulanıyor, standart kipte varyasyonu ve zorunlu seçeneği olmayan ürün her
  zaman doğrudan sepete gidiyor ([Square, Troubleshoot item details](https://squareup.com/help/us/en/article/8665-troubleshoot-item-details-and-variation-selection-on-square-point-of-sale)).
  Topluluk: zorunlu seçenek ayrıntı ekranını tetikliyor; 400'den fazla seçenekli ürünü olan bir satıcı toplu ayar istiyor
  ([Square topluluğu](https://community.squareup.com/t5/Square-for-Retail/Items-with-a-single-Pre-selected-Modifier-now-prompting-the-Item/m-p/641239)).
- **Lightspeed K-Series:** grupta "Selection is required" açılınca en az ve en çok seçim (1-99)
  ([Lightspeed, Understanding modifiers and modifier groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/51623634913051-Understanding-modifiers-and-modifier-groups));
  ürün gruplarında varsayılan seçim önceden belirlenebiliyor
  ([Lightspeed, Creating and editing item groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/25623969715995-Creating-and-editing-item-groups)).
- **TouchBistro:** zorunlu grupta en az seçim 1 ve ürün sipariş edilince seçenek ekranı açılıyor; eksik seçimde kalem
  kırmızı, ayara göre mutfağa gönderilmiyor; grubu sonradan isteğe bağlı yapmak bağlı ürünlere kendiliğinden yansımıyor
  ([TouchBistro, Creating Modifier Groups](https://cdn.touchbistro.com/help/articles/creating-modifier-groups),
  [TouchBistro, Working with Menu Modifiers](https://cdn.touchbistro.com/help/articles/working-menu-modifiers),
  [TouchBistro, Changing a modifier's force setting](https://cdn.touchbistro.com/help/articles/changing-a-modifiers-force-setting-to-non-forced-after-it-has-been-associated-with-menu-items)).
- **Revel:** ürün başına en az ve en çok seçenek; "Ekle ya da Gönder'de zorunlu seçenekleri doğrula" ayarı
  ([Revel, Advanced Modifier Features](https://support.revelsystems.com/hc/en-us/articles/204854565-Modifiers-Advanced-Features)).
- **Clover:** geliştirici belgesinde grup için en az ve en çok alanları
  ([Clover, Manage modifier groups](https://docs.clover.com/docs/managing-modifier-groups-modifiers)); POS'ta "sipariş
  girişinde göster" işareti yalnız üçüncü taraf rehberinde ([Grubbrr](https://help.grubbrr.com/articles/8039389327-clover-smb-how-to-configure-modifiers-in-clover-and-in-the-merchant-portal)).
- **robotPOS:** zorunlu özellik seçilmeden sipariş onaylanmayabiliyor; porsiyon seçenekleri çeyrek, yarım, bir buçuk ve
  iki ([robotPOS SSS](https://docs.robotpos.com/sorucevap)); kombo tanımında "Zorunlu" kutucuğu ve seçilecek ürün sayısı
  ([robotPOS, IQ-ERP Kullanım Kılavuzu](https://docs.robotpos.com/klavuz-iqerp)).
- **SambaPOS:** porsiyonlu ürün eklenince ilk porsiyon kendiliğinden; seçim ekranının her seferinde açılması için "Auto
  Select" ([SambaPOS, How to Design Detailed Menu](https://kb.sambapos.com/en/2-3-8-a-how-to-design-detailed-menu/)).
- **Odoo:** varyant oluşturma kipi "Never" olan özellik POS'ta seçim penceresi açıyor (topluluk); Odoo 17 self-order'da
  pencere ilk değeri varsayılan seçmiyor, müşteri her özelliği seçmek zorunda kalıyor
  ([Odoo forumu, POS product variants](https://www.odoo.com/forum/point-of-sale-15/pos-product-variants-questions-213754),
  [Odoo forumu, self order](https://www.odoo.com/forum/help-1/product-variants-on-pos-self-order-243664)); görüntü
  türleri (hap, radyo) belgede ([Odoo 18, Product variants](https://www.odoo.com/documentation/18.0/applications/sales/sales/products_prices/products/variants.html)).
- **Loyverse:** varyantlı ürün seçilince varyant penceresi; ürün başına en çok 3 seçenek ve 200 bileşim
  ([Loyverse, How to Use Variants of Items](https://help.loyverse.com/help/how-use-variants-items)).

### Varsayılan ve kendiliğinden ilerleme

- Toast kioskunda grupta en çok seçime ulaşılınca müşteri kendiliğinden sonraki gruba geçiyor (5 Kasım 2024)
  ([Toast güncellemeleri, Aralık 2024](https://updates.toasttab.com/?date=2024-12-01)); kioskta önseçili seçeneği kaldırma
  ayrı bir güncelleme ([Toast, Guests can now deselect preselected modifiers](https://updates.toasttab.com/announcements/guests-can-now-deselect-preselected-modifiers-on-toast-kiosk-devices)).
- Square'de seçenek setinde önseçim ve ürün düzeyinde geçersiz kılma
  ([Square, Create and manage item modifiers](https://squareup.com/help/gb/en/article/5119-create-and-manage-item-modifiers));
  ürün başına "ilk varyasyonu önseç" ([Square 8665](https://squareup.com/help/us/en/article/8665-troubleshoot-item-details-and-variation-selection-on-square-point-of-sale)).
- Toast'ta boy fiyatlı üründe "Size" düğmesi önseçili ([Toast, Size price](https://doc.toasttab.com/doc/platformguide/adminSizePrice.html)).

### Kahvecilere verilen öneriler

- Toast: her içecek boyu ayrı ürün ya da boy fiyatı; bütün kahveler için ortak seçenek grubu (sıcak ya da buzlu, ekstra
  shot, karamel ya da vanilya); süt grubu zorla gösterilebilir; şurup gibi boyla fiyatı değişen seçenekte seçenek boy
  fiyatı; önce ürün boy fiyatı kurulmalı ([Toast, Configure Menus for Bakeries or Coffee Shops](https://support.toasttab.com/en/article/Menu-Best-Practices-for-Bakeries-Coffee-Shops)).
  Aynı seçeneğin birden çok seçilmesi (ör. birkaç ekstra shot) ayrı bir ayar
  ([Toast, Set Up and Use Multiple Modifier Selection](https://support.toasttab.com/en/article/Duplicate-Modifiers-in-Online-Ordering)).
  Boy adları ürün ve seçenekte birebir aynı olmalı ("Small" ile "Sm" eşleşmez)
  ([Toast, Configure Size Pricing for Modifier Groups](https://support.toasttab.com/en/article/Product-Guide-Configuring-Size-Pricing-on-Modifier-Groups-and-Modifier-Options)).
- Üçüncü taraf: MarginEdge, boyların raporda okunması için boyu seçenek değil boy fiyatıyla tutmayı öneriyor
  ([MarginEdge, Best Practices for Toast](https://help.marginedge.com/hc/en-us/articles/37454938773523-Best-Practices-for-Toast-me-PMIX)).

### L'Affogato'nun menüsü ve LafPOS'un bugünkü davranışı

- Sitenin seçenekleri kodda sabit: süt (Normal ve Laktozsuz ücretsiz, Yulaf ve Badem 25 ₺), kavrum (Yoğun, Hafif),
  şurup (Yok, Vanilya, Karamel, Fındık: 50 ₺), ekstra shot 50 ₺, şeker 0-3; tatlı, atıştırmalık ve ekstralar
  kategorilerinde seçenek yok (`docs/01-ANALIZ.md` §3). ModPOS'ta bardak seçimi, Türk kahvesi bardağı ve şekeri (4
  seviye), çay bardağı, şurup (10), süt (3) var (`docs/01-ANALIZ.md` §1).
- LafPOS: zorunlu grupta önseçim yok ve Ekle kapalı; isteğe bağlı tek seçimlik grupta varsayılan önseçili; boş kalan
  isteğe bağlı gruba sunucu varsayılanı yazıyor; iki boylu üründe karta ya da M/L düğmesine dokunmak doğrudan ekliyor;
  tek boylu seçenekli ürün ise her seferinde pencereyle ekleniyor (`src/lib/boot.ts`, `OptionsModal.tsx`,
  `ProductPanel.tsx`).

### Kafe menüsü için kural seti

Sor, ancak üçü birden doğruysa: barista cevap olmadan hazırlayamaz; herkes için güvenli tek bir varsayılan yok; cevap
hazırlığı ya da fiyatı sık sık değiştiriyor. Değilse varsayılanla ekle, değişiklik kalemden (gönderilmeden önce satıra,
sonra kalem menüsüne dokunarak).

| Ürün | Sorulur mu | Varsayılan | Değişiklik |
|---|---|---|---|
| Şişe su, maden suyu, gazoz, meşrubat | Hayır | Tek | Yok |
| Paketli atıştırmalık, kurabiye, dilim pasta, tatlılar (site: dessert, snack) | Hayır | Tek | Not ("ısıt") kalemden |
| Ekstralar, yenilebilir bardak (ayrı ürün) | Hayır | Tek | Yok |
| Çay | Hayır | Kafenin bardağı (ör. ince belli) | Kalemden: fincan, kupa |
| Espresso, Americano, filtre kahve | Hayır | Karta dokunuş = M ya da tek boy; L kartın düğmesi | Kalemden: shot, kavrum |
| Latte, cappuccino, flat white, matcha latte | Hayır | M ve Normal süt | Kalemden: süt, şurup, shot |
| Buzlu kahve, frappe, smoothie, frozen, ice tea | Hayır | M | Kalemden |
| Türk kahvesi | Evet, yalnız şeker (sade, az, orta, şekerli) | Yok, zorunlu | Seçim ürünü ekler |
| Açık fiyatlı kalem (etkinlik ücreti, özel pasta) | Evet, tutar | Yok | Yok |
| Karaoke kişi başı | Evet, kişi sayısı (sayaç) | Yok | Yok |

Ek kurallar:

1. Ücretli seçenek hiçbir zaman sessizce eklenmez; isteğe bağlı grupta varsayılan her zaman ücretsiz seçenek.
2. Boy kartın üstünde; karta dokunmak varsayılan boyu ekler. Boy adları sitedeki M ve L'yle aynı kalır (Toast'un birebir
   ad kuralı).
3. Tek zorunlu grup tek seçimlikse seçim ürünü ekler; ikinci "Ekle" dokunuşu gerekmez (Toast kioskunun kendiliğinden
   ilerlemesinin kasa karşılığı).
4. Seçenek ekranı ürün başına değil grup başına "her seferinde göster" ile açılır; varsayılan kapalı (Toast'un isteğe
   bağlı ve zorla göster ayrımı).

### LafPOS için öneri

1. **Şimdi:** "Seçenekleri sor: zorunlu" kipinde tek boylu ve yalnız isteğe bağlı grubu olan ürün de tek dokunuşla
   eklensin; değişiklik kartın köşesindeki seçenek düğmesinden ya da Gönderilmedi satırından. Bugün bu ürünler her
   seferinde pencere açıyor; sunucu boş isteğe bağlı gruba varsayılanı zaten yazdığı için hesap değişmez. (Square'in
   "mümkünse atla"sı, Toast'un kendiliğinden açılmayan isteğe bağlı grubu.)
2. **Şimdi:** tek zorunlu grup tek seçimlikse (Türk kahvesi şekeri) seçeneğe dokunmak ürünü eklesin; pencerede başka bir
   şey değiştirilmediyse ikinci "Ekle" kalksın.
3. **Koruyun:** zorunlu grupta önseçim yok; isteğe bağlı grupta ücretsiz varsayılan önseçili; iki boylu üründe kartta M
   ve L.
4. **Sonra, gerçek bir ürün isterse:** grup başına "her seferinde göster" işareti (Toast'un zorla göster'i); genel
   "hep" ayarı ancak o zaman kalkar.
5. **Yapmayın:** her boyu ayrı ürün yapmak (Toast'un kahveci önerisi). LafPOS'ta boy ve fiyat sitenin tek kaynağından
   geliyor; ayrı ürün üçüncü kopya sorununu geri getirir.

## 5. Yönetim paneli ve raporların görsel dili

### Toast Web

- Raporlar sol gezinme menüsünde ([Toast, How do I access sales reports?](https://support.toasttab.com/en/article/How-do-I-access-sales-reports)).
  Ana sayfa net satış, saatlik işçilik maliyeti yüzdesi ve indirimlerin anlık özeti; zaman süzgeci bugün ya da dün;
  haftalık görünümde bu hafta ya da geçen hafta ve seçilen döneme göre yüzde değişim
  ([Toast, Reporting Dashboard: Weekly Overview](https://support.toasttab.com/en/article/How-to-Use-the-Toast-Reporting-Dashboard),
  son güncelleme 24 Mart 2026).
- Satış özeti: hazır dönemler hemen uygulanıyor, özel aralık "Apply" istiyor; "More filters" (saat, haftanın günü, gelir
  merkezi, servis alanı); dişli simgesiyle bölümlerin sırası değiştiriliyor; e-posta ve CSV ya da XLS dışa aktarma
  süzgeçleri yansıtıyor ([Toast, Sales Summary Report Overview](https://support.toasttab.com/en/article/Sales-Summary-Report),
  [Toast, Sales Summary FAQ](https://support.toasttab.com/en/article/Sales-Summary-FAQ)). İki dönemi ya da iki şubeyi
  kıyaslamak ayrı raporda (Sales analytics) ([Toast, How do I access sales reports?](https://support.toasttab.com/en/article/How-do-I-access-sales-reports)).
- Bileşen kitaplığının adı "Buffet" (iş ilanına göre React ve TypeScript); kamuya açık belgesi bulunamadı
  ([iş ilanı](https://builtindublin.ie/job/staff-frontend-engineer/7056494)).

### Square Dashboard

- Ana sayfada widget'lar: ödeme türleri, satılan ürün ve kategoriler, müşteriler; her biri dönemle süzülüp ilgili
  rapora açılıyor ([Square duyurusu, The Dashboard home page now has widgets](https://community.squareup.com/t5/Product-Updates/New-The-Dashboard-home-page-now-has-widgets/ba-p/679368)).
- Yeni kenar çubuğu menüleri birleştirdi; satıcılar fazladan tıklamadan (iki tık üçe çıktı) ve kendi hızlı
  bağlantılarının kalkmasından yakındı; eski gezinmeye dönüş seçeneği verildi
  ([Square topluluğu, New Dashboard Interface Navigation Pain](https://community.squareup.com/t5/Square-Invoices/New-Dashboard-Interface-Navigation-Pain/m-p/794929)).
- Satıcılara göre satış özetinin kıyası dar (geçen pazartesi ile bu pazartesi; özel aralıkta yalnız önceki eş dönem)
  ([Square topluluğu, Dashboard Sales Summary Report Feedback](https://community.squareup.com/t5/Square-Point-of-Sale/Dashboard-Sales-Summary-Report-Feedback/m-p/709135));
  Square ekibi 2023'te özel dönemi 52 hafta ve bir yıl öncesiyle kıyaslamayı, haftayı ve ayı sonraya bıraktığını söyledi
  ([Square topluluğu, Dashboard iOS App soru-cevap](https://community.squareup.com/t5/Event-Discussions/Dashboard-iOS-App-Ask-us-anything-about-the-updates-to-sales/m-p/633647/highlight/true)).
- Tasarım sistemi "Market": iş ilanlarına göre React bileşen kitaplığı, panel için üstünde ikinci bir kitaplık,
  erişilebilirlikte WCAG vurgusu; kamuya açık belgesi bulunamadı
  ([iş ilanı](https://www.builtinla.com/job/product-manager-foundations-ui-systems/7103616)).

### Lightspeed Back Office

- Yeni kenar çubuğu bölümleri: Raporlar, Kıyaslar ve Eğilimler, Gelişmiş İçgörüler, Menü, POS, İşletme, Donanım,
  Operasyon, Ödeme, Müşteriler, Stok, Entegrasyonlar, Finans; eski ve yeni yerleri eşleyen tablo var; herkese 1 Ekim
  2025'te açıldı (sayfada 6 Ekim de geçiyor)
  ([Lightspeed, About Back Office navigation changes](https://k-series-support.lightspeedhq.com/hc/en-us/articles/36985562334363-About-Back-Office-navigation-changes)).
- Panel ana sayfasında satış kartları: brüt, net, sipariş, sipariş ortalaması, kişi, kişi ortalaması; her biri önceki
  dönemle; Bugün ve Dün geçen haftanın aynı günüyle, Bu hafta geçen haftayla, Bu ay geçen ayla kıyaslanıyor
  ([Lightspeed, Understanding the Dashboard page](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4403208456603-Understanding-the-Dashboard-page)).
- Satış raporunda "Compare with" süzgeci tablonun her bölümüne özgün dönem, kıyas dönemi ve fark yüzdesi sütunlarını
  ekliyor ([Lightspeed, Understanding the Sales Report dashboard](https://k-series-support.lightspeedhq.com/hc/en-us/articles/35539237853467-Understanding-the-Sales-Report-dashboard)).
- Tasarım belirteçleri npm'de (`@lightspeed/flame-tokens`; köşe yarıçapı ölçeği var, değerleri doğrulanamadı)
  ([npm, flame-tokens](https://www.npmjs.com/package/@lightspeed/flame-tokens)).

### Odoo

- Arama çubuğu görünümün üstünde; açılır menüde Süzgeç, Grupla ve Sık kullanılanlar; sık kullanılan arama görünümün
  varsayılanı yapılabiliyor ve herkesle paylaşılabiliyor
  ([Odoo 18, Search, filter, and group records](https://www.odoo.com/documentation/18.0/applications/essentials/search.html)).
- Raporlama genelde grafik ve pivot görünümleriyle; pivotta satır ve sütun gruplaması değişiyor, eksenler çevrilebiliyor
  ([Odoo 17, Reporting](https://www.odoo.com/documentation/17.0/applications/essentials/reporting.html)). Odoo 17 yeni bir
  arayüz tasarımı getirdi ([Odoo 17 Release Notes](https://www.odoo.com/odoo-17-release-notes)).

### Yerli sistemlerde

- **ModPOS Patron** (mobil web, koyu tema): canlı ciro, "Kıyas · 09:40 itibarıyla" ile geçen haftanın ve geçen ayın aynı
  gün aynı saati; raporlarda dönem (bugün, dün, hafta, bu ay, geçen ay, yıl, özel) ve şube süzgeci. Yönetim paneli açık
  temada, ⌘K aramalı (`docs/01-ANALIZ.md` §1).
- **robotPOS** web raporlamasında denetim bölümü: iptal, indirim ve kasa kontrol raporları
  ([robotPOS, Web Raporlama Platformu](https://docs.robotpos.com/urunler/webraporlama)).

### "Kurumsal ve keskin" duygusunu ne veriyor

Aşağısı yukarıdaki belgelerden çıkarım; görsel ölçüler (köşe, gölge) doğrulanamadı.

1. **Tek süzgeç kalıbı:** her raporda aynı yerde dönem, karşılaştırma, ek süzgeç ve dışa aktarma (Toast'un satış özeti,
   Odoo'nun arama çubuğu).
2. **Referansı yazılı kıyas:** rakamın yanında neye göre olduğu (Lightspeed'in aynı gün kuralı, Toast'un seçilen döneme
   göre yüzdesi).
3. **Tablo önde, grafik özet:** kıyas sütunları tabloda (Lightspeed), pivot ve liste (Odoo).
4. **Sabit ve sığ gezinme:** Square örneği, menüleri birleştirip derinleştirmenin "sade" değil "yavaş" algılandığını
   gösteriyor.

### LafPOS için öneri

1. **Şimdi:** her rapor sayfasında aynı üst şerit: dönem segmenti (Bugün, Dün, Bu hafta, Bu ay, Özel), "Karşılaştır"
   (Geçen haftanın aynı günü, Önceki dönem, Geçen yıl), sağda "CSV indir". Hazır dönem hemen uygulanır, özel aralık
   "Uygula" ister (Toast).
2. **Koruyun:** KPI şeridinde her rakamın yanında fark ve referans ("geçen salıya göre, 14:20 itibarıyla"); Lightspeed'in
   aynı gün kuralı LafPOS'un genel bakışında zaten var (`DESIGN.md` §4).
3. **Şimdi:** "Karşılaştır" açıkken tablolarda üç sütun: dönem, kıyas, fark yüzdesi (Lightspeed); rakamlar sağa hizalı
   ve eşit genişlikte (Gabarito tablo rakamı), en altta toplam satırı.
4. **Koruyun:** kenar çubuğu grupları ve ⌘K; sık sayfaya en çok iki tık; gezinmeyi derinleştirmeyin (Square'in tepkisi).
5. **Şimdi (öneri, kanıt değil):** raporlarda kart içinde kart yerine tek kart ve tablo; ayraç 1 px; renk yalnız durumda;
   boş, yükleniyor ve hata durumları aynı ölçekte (`DESIGN.md` §5'in kuralları).
6. **Yapmayın:** pivot, kayıtlı görünüm ve bölüm sırasını kullanıcıya bırakmak (Odoo, Toast); tek kafe için yük.

## Doğrulanamayanlar ve açık sorular

- Sayfalar açılamadığı için bütün bulgular arama motorunun resmî sayfalardan verdiği alıntılara dayanıyor; ekran
  görüntüsü görülmedi.
- Lightspeed K-Series'te "on the house" adlı bir ödeme yöntemi ya da indirim bulunamadı.
- Eşit bölmede hazır 2 · 3 · 4 çipi hiçbir sistemde belgelenmiş olarak bulunamadı; Toast'ta sayının bir listeden mi tuş
  takımından mı seçildiği doğrulanamadı.
- Square ikram raporunda çalışan sütunu olup olmadığı; Toast'ta POS'ta bölünmüş hesaba sonradan eklenen kalemin nasıl
  dağıldığı; Toast ödeme ekranının kalanı nasıl gösterdiği.
- Clover'ın resmî bölme ve seçenek belgeleri (yalnız blog ve üçüncü taraf); SpotOn'un ikram gerekçeleri; Revel
  belgelerinin güncelliği (birkaç yıllık).
- Toast ve Square'de telefonda sürekli görünen sepet çubuğu; Square'in tablet yerleşimi; Odoo'nun telefon yerleşimi
  (yalnız üçüncü taraf modül bulundu).
- Yerli sistemler: NarPOS, Adisyo, Simpra ve Menulux'un adisyon ekranı, hesap bölme ve ikram akışının ayrıntısı (yalnız
  tanıtım düzeyinde bilgi: Adisyo'da parçalı ödeme ve hesap bölme ([Adisyo, Fast food](https://adisyo.com/fast-food-isletme-adisyon-programi)),
  Simpra'da kişiye ya da ürüne göre çoklu hesap ve kısmi ödeme ([myPOS AppMarket, Simpra POS](https://www.mypos.com/en-gb/appmarket/application/13525)),
  Menulux'ta kısmi ödeme ([App Store](https://apps.apple.com/us/app/-/id6742921152))). ModPOS için kamuya açık belge
  bulunamadı.
- Toast, Square ve Lightspeed panellerinin köşe yarıçapı, gölge ve yoğunluk değerleri.

## Ek: e-Adisyon notu (kapsam dışı ama önemli)

- 509 sıra no.lu VUK Genel Tebliği'ne göre GİB, adisyon düzenleyen işletmelere hasılatlarına göre en az üç ay geçiş
  süresi verip yazılı bildirim ya da ebelge.gib.gov.tr duyurusuyla e-Adisyon zorunluluğu getirebiliyor; bildirim alan
  işletme süresi içinde geçmek zorunda ([GİB, 509 sıra no.lu Tebliğ'in güncel metni](https://ebelge.gib.gov.tr/dosyalar/tebligler/Guncel_Sekli_ile_509_Sira_No'lu_VUK_Genel_Tebligi.pdf)).
  Teknik kılavuz 30 Temmuz 2021'de yayımlandı ([Sovos](https://sovos.com/tr/blog/kdv/e-adisyon-donemi-basliyor-beklenen-kilavuz-yayimlandi/)).
- LafPOS belgelerinde e-Adisyon geçmiyor. L'Affogato'ya bir bildirim gelip gelmediği mali müşavirle doğrulanmalı;
  Menulux ve GoPOS e-Adisyon çözümü sunduklarını söylüyor ([Menulux, LinkedIn](https://linkedin.com/company/menulux),
  [DonanımHaber, GoPOS incelemesi](https://www.donanimhaber.com/gopos-inceleme--205943)).

## Kaynaklar

Erişim: 4 Kasım 2026, arama motoru alıntıları üzerinden (yukarıdaki sınırlara bakın).

**Toast**
- [Manage Orders With Toast POS](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens) ·
  [Manage Payments With Toast POS](https://support.toasttab.com/en/article/New-POS-Managing-Payments) ·
  [Split Checks on the POS](https://support.toasttab.com/en/article/Splitting-Checks-by-Item-1492811097734) ·
  [Split Payments With Mobile Order & Pay](https://support.toasttab.com/en/article/Split-Payments-with-Toast-Mobile-Order-Pay)
- [Send, Stay and Hold](https://support.toasttab.com/en/article/Differences-Between-the-Send-Stay-and-Hold-Buttons) ·
  [Course Firing Options](https://support.toasttab.com/en/article/Course-Firing-Options) ·
  [Order by Seat](https://support.toasttab.com/en/article/Order-by-Seat) ·
  [Total Guest Counts](https://support.toasttab.com/en/article/How-is-Guest-Count-Calculated) ·
  [Retail POS Mode](https://support.toasttab.com/en/article/Get-Started-With-Retail-POS-Mode)
- [Menu Item Search](https://support.toasttab.com/en/article/Menu-Item-Search) ·
  [Remove Search Bar](https://support.toasttab.com/en/article/How-can-I-remove-the-search-bar-from-the-POS-order-screen) ·
  [Open View](https://support.toasttab.com/en/article/Get-Started-Open-View) ·
  [86 an Item](https://support.toasttab.com/en/article/86-an-Item) ·
  [Multi-Item Selection Mode](https://support.toasttab.com/en/article/Multi-Item-Selection-Mode) ·
  [Permissions Reference](https://support.toasttab.com/en/article/Access-Permissions-Reference)
- [Configure Modifier Behavior](https://support.toasttab.com/en/article/Required-Optional-Modifiers) ·
  [Modifier Group Display Order](https://support.toasttab.com/en/article/Editing-Managing-Modifier-Group-Display-Order) ·
  [Size price](https://doc.toasttab.com/doc/platformguide/adminSizePrice.html) ·
  [Size Pricing for Modifier Groups](https://support.toasttab.com/en/article/Product-Guide-Configuring-Size-Pricing-on-Modifier-Groups-and-Modifier-Options) ·
  [Bakeries or Coffee Shops](https://support.toasttab.com/en/article/Menu-Best-Practices-for-Bakeries-Coffee-Shops) ·
  [Multiple Modifier Selection](https://support.toasttab.com/en/article/Duplicate-Modifiers-in-Online-Ordering)
- [Void Items, Payments, and Checks](https://support.toasttab.com/en/article/Voiding-Items-Payments-and-Checks) ·
  [Add Void Reasons](https://support.toasttab.com/en/article/Add-Void-Reasons) ·
  [Requiring a discount reason](https://doc.toasttab.com/doc/platformguide/adminDiscountReasons.html) ·
  [Report on Discounts and Promo Codes](https://support.toasttab.com/en/article/Reporting-for-Discounts-Promo-Codes) ·
  [Cash and Loss Management Reports](https://support.toasttab.com/en/article/Exceptions-Report-Overview) ·
  [House Accounts](https://support.toasttab.com/en/article/House-Accounts-1492809352564) ·
  [Paying with a house account](https://doc.toasttab.com/doc/platformguide/platformHouseAccountsPaymentMethod.html)
- [Sales Summary Report](https://support.toasttab.com/en/article/Sales-Summary-Report) ·
  [Sales Summary FAQ](https://support.toasttab.com/en/article/Sales-Summary-FAQ) ·
  [How do I access sales reports?](https://support.toasttab.com/en/article/How-do-I-access-sales-reports) ·
  [Reporting Dashboard](https://support.toasttab.com/en/article/How-to-Use-the-Toast-Reporting-Dashboard)
- Güncellemeler: [Open input for split checks](https://updates.toasttab.com/announcements/open-input-for-split-checks) ·
  [Split payment amounts include all payment types](https://updates.toasttab.com/announcements/split-payment-amounts-now-include-all-payment-types) ·
  [Splitting and moving items](https://updates.toasttab.com/announcements/improved-experience-for-splitting-and-moving-items) ·
  [Split checks actions in the USA](https://updates.toasttab.com/announcements/split-checks-actions-workflow-is-now-available-to-locations-in-the-usa) ·
  [Updates to the new POS experience](https://updates.toasttab.com/announcements/updates-to-the-new-pos-experience) ·
  [Aralık 2024 listesi](https://updates.toasttab.com/?date=2024-12-01) ·
  [Deselect preselected modifiers](https://updates.toasttab.com/announcements/guests-can-now-deselect-preselected-modifiers-on-toast-kiosk-devices)
- Topluluk: [Employee meals](https://community.toasttab.com/t5/restaurant-operations/how-to-track-employee-meals/m-p/3708) ·
  [Print discount comment](https://community.toasttab.com/t5/restaurant-operations/print-discount-comment/m-p/13469) ·
  [Simplify splitting](https://community.toasttab.com/t5/restaurant-operations/simplify-splitting-a-ticket-in-a-table-in-toast/m-p/13813)
- Diğer: [Buffet iş ilanı](https://builtindublin.ie/job/staff-frontend-engineer/7056494) ·
  [Restaurant Accounting, Toast Best Practices](https://restacct.zendesk.com/hc/en-us/articles/4415064404883-Toast-Best-Practices) ·
  [MarginEdge](https://help.marginedge.com/hc/en-us/articles/37454938773523-Best-Practices-for-Toast-me-PMIX)

**Square**
- [8165 Split a payment and check](https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants) ·
  [5097 Split tender](https://squareup.com/help/us/en/article/5097) ·
  [8450 Item splits](https://squareup.com/help/ca/en/article/8450-beta-item-splits) ·
  [8152 Tableside](https://squareup.com/help/us/en/article/8152-take-orders-tableside-with-square-for-restaurants-mobile-pos) ·
  [8583 Seats](https://squareup.com/help/us/en/article/8583-manage-seats-in-your-restaurant) ·
  [8172 Hold and fire](https://squareup.com/help/article/8172-hold-and-fire-courses-with-square-kds-and-square-for-restaurants)
- [8166 Comp, void, reassign](https://squareup.com/help/us/en/article/8166-comp-void-and-reassign-checks-with-square-for-restaurants) ·
  [5814 Comp and void](https://squareup.com/help/us/en/article/5814-get-started-with-comp-and-void) ·
  [6146 Comp and void FAQ](https://squareup.com/help/us/en/article/6146-comp-and-void-faqs) ·
  [8633 Real Time Check View](https://squareup.com/help/us/en/article/8633-set-up-and-manage-real-time-check-view-for-restaurants)
- [8665 Item details and variations](https://squareup.com/help/us/en/article/8665-troubleshoot-item-details-and-variation-selection-on-square-point-of-sale) ·
  [5119 Modifiers](https://squareup.com/help/gb/en/article/5119-create-and-manage-item-modifiers) ·
  [6425 Managing items](https://squareup.com/help/us/en/article/6425-managing-items-with-square-for-restaurants) ·
  [Tükendi duyurusu](https://www.sellercommunity.com/t5/Product-Updates/Mark-an-Item-as-Sold-Out-with-Square-and-86-Items-with-Square/ba-p/299271) ·
  [House accounts](https://squareup.com/us/en/house-accounts/restaurants)
- Topluluk: [Comp reasons](https://community.squareup.com/t5/Questions-How-To/Can-I-change-or-add-to-the-reasons-for-comping-a-ticket/m-p/38122) ·
  [Comp note](https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Add-a-note-when-voiding-and-comping-that-I-can-see-on-my/m-p/219391) ·
  [Comps reports](https://community.squareup.com/t5/Questions-How-To/Inventory-voids-discounts-and-comps-reports/m-p/653918) ·
  [Pre-selected modifier](https://community.squareup.com/t5/Square-for-Retail/Items-with-a-single-Pre-selected-Modifier-now-prompting-the-Item/m-p/641239) ·
  [House accounts duyurusu](https://community.squareup.com/t5/Product-Updates/Square-house-accounts/ba-p/679122) ·
  [Dashboard widgets](https://community.squareup.com/t5/Product-Updates/New-The-Dashboard-home-page-now-has-widgets/ba-p/679368) ·
  [Navigation Pain](https://community.squareup.com/t5/Square-Invoices/New-Dashboard-Interface-Navigation-Pain/m-p/794929) ·
  [Sales Summary Feedback](https://community.squareup.com/t5/Square-Point-of-Sale/Dashboard-Sales-Summary-Report-Feedback/m-p/709135) ·
  [Dashboard iOS soru-cevap](https://community.squareup.com/t5/Event-Discussions/Dashboard-iOS-App-Ask-us-anything-about-the-updates-to-sales/m-p/633647/highlight/true)
- Diğer: [Market iş ilanı](https://www.builtinla.com/job/product-manager-foundations-ui-systems/7103616)

**Lightspeed Restaurant (K-Series)**
- [Register screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328394-Understanding-the-Register-screen) ·
  [POS configurations](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804606610-Managing-and-understanding-POS-configurations) ·
  [Placing basic orders](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050308894-Placing-basic-orders) ·
  [New POS navigation](https://k-series-support.lightspeedhq.com/hc/en-us/articles/43162671781659-About-the-new-POS-navigation) ·
  [What's New: April 2026](https://k-series-support.lightspeedhq.com/hc/en-us/articles/49458066662171-What-s-New-April-2026-Table-pacing-reservations-pricing-insights-and-more) ·
  [Restaurant app settings (eski)](https://resto-support.lightspeedhq.com/hc/en-us/articles/234749548-Restaurant-app-settings)
- [Splitting a bill](https://k-series-support.lightspeedhq.com/hc/articles/360051089493-Splitting-a-bill) ·
  [Modifiers and modifier groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/51623634913051-Understanding-modifiers-and-modifier-groups) ·
  [Item groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/25623969715995-Creating-and-editing-item-groups)
- [Understanding discounts](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804657089-Understanding-discounts) ·
  [POS user groups](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804594730-Managing-POS-user-groups) ·
  [Discounts report](https://k-series-support.lightspeedhq.com/hc/en-us/articles/7367707150875-Discounts-report) ·
  [Discount Breakdown](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4403189301659-Discount-Breakdown-report)
- [Back Office navigation changes](https://k-series-support.lightspeedhq.com/hc/en-us/articles/36985562334363-About-Back-Office-navigation-changes) ·
  [Dashboard page](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4403208456603-Understanding-the-Dashboard-page) ·
  [Sales Report dashboard](https://k-series-support.lightspeedhq.com/hc/en-us/articles/35539237853467-Understanding-the-Sales-Report-dashboard) ·
  [flame-tokens](https://www.npmjs.com/package/@lightspeed/flame-tokens)

**TouchBistro**
- [Taking Orders](https://cdn.touchbistro.com/help/articles/taking-orders) ·
  [Drinks and courses](https://cdn.touchbistro.com/help/articles/sending-drinks-and-courses-at-separate-times) ·
  [Register Screen](https://cdn.touchbistro.com/help/articles/the-register-screen) ·
  [Checkout](https://cdn.touchbistro.com/help/articles/checkout/) ·
  [Patent](https://www.touchbistro.com/press-releases/touchbistro-ipad-pos-awarded-patent-for-its-feature-to-easily-and-quickly-split-bills-between-customers/)
- [Creating Modifier Groups](https://cdn.touchbistro.com/help/articles/creating-modifier-groups) ·
  [Working with Menu Modifiers](https://cdn.touchbistro.com/help/articles/working-menu-modifiers) ·
  [Force setting](https://cdn.touchbistro.com/help/articles/changing-a-modifiers-force-setting-to-non-forced-after-it-has-been-associated-with-menu-items) ·
  [Void Reasons](https://cdn.touchbistro.com/help/articles/void-reasons) ·
  [Discounts](https://www.touchbistro.com/help/articles/discounts/) ·
  [Discount and Void Reports](https://cdn.touchbistro.com/help/articles/discount-void-reports/)

**SpotOn**
- [Split Items, Checks, and Payment Types](https://help.spoton.com/space/SK/846954605/Split+Items%2C+Checks%2C+and+Payment+Types+%7C+SpotOn+Restaurant+FOH) ·
  [Item Commands Menu](https://help.spoton.com/space/SK/2055536951/Item+Commands+Menu+%7C+SpotOn+Restaurant+FOH) ·
  [Apply Discounts](https://help.spoton.com/space/SK/2666627613) ·
  [Mark an Item Unavailable](https://help.spoton.com/space/SK/2665578707)

**Clover**
- [Split check policy (blog)](https://blog.clover.com/creating-your-own-restaurant-split-check-policy) ·
  [Modifier groups (geliştirici)](https://docs.clover.com/docs/managing-modifier-groups-modifiers) ·
  [Grubbrr rehberi (üçüncü taraf)](https://help.grubbrr.com/articles/8039389327-clover-smb-how-to-configure-modifiers-in-clover-and-in-the-merchant-portal)

**Loyverse**
- [Split Payment](https://help.loyverse.com/help/payment-loyvers) ·
  [Split an Open Ticket](https://help.loyverse.com/help/how-split-open-ticket-loyverse-pos) ·
  [Variants](https://help.loyverse.com/help/how-use-variants-items) ·
  [Home Sale Screen Layout](https://help.loyverse.com/help/home-sale-screen-layouts) ·
  [Favorites on Smartphones](https://help.loyverse.com/help/favorites-on-smartphones) ·
  [How to Make Sales](https://help.loyverse.com/help/make-sales) ·
  [Glossary](https://support.loyverse.com/en/articles/10010378-loyverse-glossary)

**Revel**
- [Refund, Void, Comp, or Exchange Items](https://support.revelsystems.com/hc/en-us/articles/115005088546-Refund-Void-Comp-or-Exchange-Items) ·
  [Advanced POS Settings](https://support.revelsystems.com/hc/en-us/articles/204947635-Advanced-POS-Settings) ·
  [Advanced Modifier Features](https://support.revelsystems.com/hc/en-us/articles/204854565-Modifiers-Advanced-Features) ·
  [Split Bills](https://support.revelsystems.com/hc/en-us/articles/205125635-Split-Bills-) ·
  [Blog 2013](https://blog.revelsystems.com/blog/2013/09/30/new-feature-split-bill-capabilities) ·
  [Blog 2019](https://blog.revelsystems.com/blog/2019/02/26/pizza-updates)

**Odoo**
- [Restaurant features 18](https://www.odoo.com/documentation/18.0/applications/sales/point_of_sale/restaurant.html) ·
  [Restaurant features 20](https://www.odoo.com/documentation/20.0/applications/sales/point_of_sale/restaurant.html) ·
  [Bill splitting by person (forum)](https://www.odoo.com/forum/help-1/pos-bill-splitting-by-person-269868) ·
  [Product variants 18](https://www.odoo.com/documentation/18.0/applications/sales/sales/products_prices/products/variants.html) ·
  [POS variants (forum)](https://www.odoo.com/forum/point-of-sale-15/pos-product-variants-questions-213754) ·
  [Self order variants (forum)](https://www.odoo.com/forum/help-1/product-variants-on-pos-self-order-243664) ·
  [Search, filter, group 18](https://www.odoo.com/documentation/18.0/applications/essentials/search.html) ·
  [Reporting 17](https://www.odoo.com/documentation/17.0/applications/essentials/reporting.html) ·
  [Odoo 17 Release Notes](https://www.odoo.com/odoo-17-release-notes)

**SambaPOS**
- [Take Order to Customer](https://kb.sambapos.com/en/5-1-1-b-how-to-take-order-to-customer/) ·
  [Detailed Menu](https://kb.sambapos.com/en/2-3-8-a-how-to-design-detailed-menu/) ·
  [Splitting Items or Ticket](https://kb.sambapos.com/en/5-4-5-how-to-get-payment-by-splitting-items-or-ticket/) ·
  [Payment Sense](https://kb.sambapos.com/en/6-2-how-to-configure-payment-sense-pay-at-table-settings/) ·
  [Cancel, Gift or Void](https://kb.sambapos.com/en/5-1-2-how-to-cancel-gift-or-void-items/) ·
  [Gift and Void Reasons](https://kb.sambapos.com/en/2-3-8-d-how-to-create-gift-and-void-reasons/) ·
  [Staff Training Manual](https://forum.sambapos.com/uploads/short-url/d3FCrHF3Iuf5aOL7F2WAeEoNBd8.pdf) ·
  forum: [Divide one bill](https://forum.sambapos.com/t/divide-one-bill-for-multi-people-and-can-print-out-receipt-for-each-people-by-every-time-payment-done/10561),
  [Gift & Void Reasons](https://forum.sambapos.com/t/configuring-gift-void-reasons/2748),
  [Portion Buttons](https://forum.sambapos.com/t/portion-buttons-questions/13228),
  [Popup tags/portions](https://forum.sambapos.com/t/popup-tags-portions/2566)

**Yerli**
- robotPOS: [SSS](https://docs.robotpos.com/sorucevap) · [Kasa işlemleri](https://docs.robotpos.com/klavuz-kasaislemleri) ·
  [IQ-ERP](https://docs.robotpos.com/klavuz-iqerp) · [Sürüm notları](https://docs.robotpos.com/surumnotlari-infinia) ·
  [Web raporlama](https://docs.robotpos.com/urunler/webraporlama) · [FAQ](https://en.robotpos.com/faq) ·
  [Blog: adisyon takibi](https://www.robotpos.com/blog_new/cafe-restoran-adisyon-takibi) ·
  [Blog: ÖKC 2026](https://www.robotpos.com/blog_new/restoranda-yazarkasa-okc-entegrasyonu-2026-mevzuat-rehberi)
- NarPOS: [Kafe](https://narpos.com.tr/isletme/kafe) · [İade İkram Raporu](https://narpos.com.tr/ozellik/iade-ikram-raporu/38) ·
  [Ürün Satış Raporu](https://narpos.com.tr/ozellik/urun-satis-raporu/33) · [NarApp](https://apps.apple.com/us/app/id6471075475)
- Adisyo: [Ana sayfa](https://adisyo.com/) · [Fast food](https://adisyo.com/fast-food-isletme-adisyon-programi)
- Simpra: [myPOS AppMarket](https://www.mypos.com/en-gb/appmarket/application/13525)
- Menulux: [Menulux Garson](https://apps.apple.com/us/app/-/id6742921152) · [LinkedIn](https://linkedin.com/company/menulux)
- GoPOS: [DonanımHaber incelemesi](https://www.donanimhaber.com/gopos-inceleme--205943)
- ModPOS: kafedeki kurulumun 26 Ekim 2026 incelemesi, `docs/01-ANALIZ.md`
- e-Adisyon: [GİB, 509 sıra no.lu Tebliğ](https://ebelge.gib.gov.tr/dosyalar/tebligler/Guncel_Sekli_ile_509_Sira_No'lu_VUK_Genel_Tebligi.pdf) ·
  [Sovos](https://sovos.com/tr/blog/kdv/e-adisyon-donemi-basliyor-beklenen-kilavuz-yayimlandi/)
