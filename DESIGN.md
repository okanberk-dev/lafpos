# LafPOS tasarım sistemi: LafPOS Sahne

> Ürün bağlamı `PRODUCT.md`'de. **17 Kasım 2026** operatör kararları: _"gnbsite reposuna bak, ordaki tasarımı style css vs.
> tüm hepsini al ve lafposa göre uyarlayıp yenilikçi güzel bir tasarım yap; sisteme uygun, UI/UX olarak gelişmiş"_,
> _"tasarımı sen harmanla ve bize uyarla, pos sistemine uyarlayarak devam et"_, _"dev patron vs. yazmasına gerek yok,
> renkleri de sen uyarla"_ ve _"side bar kısmını daha basit ve shadcn tarzında, estetik ama profesyonel, kolay"_.
> Kaynak gnbsite'ın **Area Board UI** kiti (`area-board-ui/`: `css/00-tokens.css` … `13-pages.css`, `docs/UX.md`,
> `docs/LAYOUTS.md`): kutu ve pencere değil **sahne**; derinlik gölgeyle değil tonla (sayfa → gri sahne → beyaz yaprak);
> her etkileşimli öğe hap; ekranın tek ana eylemi **mürekkep hap ve sağında yeşil ok halkası**; cam filtre çubuğu;
> siyah bantta dalga çizgileri; tek açılış anı. Kimlik L'Affogato'nun (laffogato `docs/BRAND.md`): L'Af logosu, ev yeşili,
> yeşilimsi mürekkep, canlı durum renkleri (18 Kasım 2026 canlı tur); yazı Poppins ve Gabarito (kitin Helvetica'sı yerine, pakette, çevrimdışı).
> Kitten bilerek alınmayanlar: dev büyük harfli ekran adı (ölçülü başlık var), masaüstüne özel düzen (telefon ve tablet
> birinci sınıf), koyu temasızlık (LafPOS'ta sıcak gece var), Helvetica. Değerler `src/index.css`'te; erişilebilirlik
> oranları `tests/design-tokens.test.ts` ve `tests/ui-kit.test.ts`'te sabit. Test düşerse değeri düzelt, eşiği gevşetme.
> Önceki "LafPOS Sade" (2 Kasım 2026, Innex yerleşimi ve kurumsal yönetim yüzeyi) bunun yerine geçti.

## 1. İlkeler

1. **Sahne, yaprak, cam:** ekranı dolduran açık adaçayı rengi sahne (`--admin-stage`), içerik beyaz yaprakta kendi içinde
   kayar; üstte buzlu cam çubuk. Kart içinde kart yok; bölümler boşluk ve saç teliyle ayrılır. Gölge yalnız açılan ve
   yüzen parçada (pencere, menü, cam çubuk, mürekkep masa kartı); kart ve satır tonla ayrılır.
2. **Renk anlam taşır:** mürekkep ana eylem ve seçimdir (seçili çip, sekme, segment); dolu masa yeşil degrade; ok halkası
   ve olumlu durum zümrüt; zamanı daralan (hesap istendi, onay bekleyen platform siparişi) canlı ahududu (kitin magentası);
   amber uyarı ve gecikme, kırmızı hata ve iptal, kobalt hazırlanıyor ve bilgi, mor online sipariş, pirinç ödül. Renk
   tek başına durum taşımaz, yanında yazı ya da ikon olur.
3. **Sakin başlık, iri rakam:** ekranın adı ölçülü (Gabarito 700, 22-28 px, büyük harf yok); öne çıkan rakamdır (büyük
   sayılar, tutar, masa kartındaki toplam: Gabarito kalın, sıkı aralık).
4. **Dokunmatik önce, aşırı büyük değil:** dokunmatikte her hedef en az 44 px (AGENTS.md kural 8); fareyle ölçülü
   (18 Kasım 2026, operatör: "butonları düzgün yap, aşırı büyük yapma"): düğme ve alan 40 px, küçük düğme 32, büyük 44,
   en büyük 48; yönetimde fareyle 36, sıkı görünümde 32 px.
5. **Tek açılış anı:** ekrana girerken cam çubuk kalkar, başlık aşağıdan açılır, yaprak gelir, ilk satırlar 30 ms arayla;
   sonra sakin. Sürekli hareket yalnız siyah bantlarda (90-120 sn'de bir kayan dalgalar) ve hazır rozetinin nabzı.
   Hareket azaltmada hepsi kapalı.

## 2. Belirteçler

### Yazı

- **Gabarito** (değişken 400-900): ekran ve bölüm başlığı (`h1`-`h3` kendiliğinden), gösterim rakamı (büyük sayılar,
  ödenecek tutar, masa kartındaki tutar; `font-headline`), menü ve sekme etiketi değil.
- **Poppins** 400/500/600/700: gövde, etiket, düğme, form, yan menü. Bütün rakamlar Gabarito'dan (`LafPOS Rakam`, yalnız
  0-9): metinde orantılı, `.tabular` / `tabular-nums` ile eşit genişlikte. Dosyalar pakette (`@fontsource/poppins`,
  `@fontsource-variable/gabarito`), latin ve latin-ext ayrı; dış kaynaktan yazı yüklenmez.
- **Ölçek:** ekran başlığı (`.lp-name`) 22, geniş ekranın sol sütununda 24 px / 700 / -0.03em; durum cümlesi 13 px; kart
  başlığı 16/700 -0.025em; gövde 14-15; mikro 12/500 (en küçük 11). Büyük sayılar (`.lp-hs`) 28-44 px, tutar 22-34 px,
  -0.045em; KPI 30-40 px; müşteri ekranında tutar 48-88/800. Büyük harf dönüşümü yok (yalnız kısaltmalar kendiliğinden).

### Renk

| Rol | Açık | Koyu |
|---|---|---|
| Sayfa / sahne (açık adaçayı) | `#F5F6F3` / `#E9ECE7` | `#0B0E0D` / `#121715` |
| Yaprak, kart | `#FFFFFF` | `#19201D` |
| Yüzey içi hafif alan / taş (rozet, segment, kuyu) | `#F8F9F7` / `#EEF1EC` | `#1E2622` / `#26302B` |
| Saç teli / ince çizgi / satır ayracı / alan kenarı | `#E3E7E1` / `#D3D9D1` / `#EDF0EB` / `#7A837E` | `#2A332F` / `#36413C` / `#212925` / `#78837D` |
| Mürekkep / gövde / etiket | `#0F1513` / `#3F4A45` / `#58635E` | `#F1F5F3` / `#C9D2CD` / `#9AA6A0` |
| Ana eylem ve seçim (mürekkep dolgu) | `#111816`, üstünde `#FFFFFF` | `#F1F5F3`, üstünde `#0F1513` |
| Ok halkası (ana düğmenin sağı) | canlı zümrüt `#12B886`, ok `#06261B` | `#059669`, ok `#04261A` |
| Derin yeşil (bağlantı, olumlu, odak halkası) | `#0A6E52`, yumuşak `#DDF5EA` | `#34D399`, yumuşak `#0F3327` |
| Dolu masa | yeşil degrade `#0E7A5A → #086348 → #05432F`, beyaz yazı | aynı |
| Zamanı daralan (ahududu) | `#C8175D` zemin `#FCE4EE` | `#FF7EB6` zemin `#3D1528` |
| Mavi (hazırlanıyor, bilgi) | `#2459E0` zemin `#E6EEFF` | `#8FB0FF` zemin `#172548` |
| Mor (online sipariş) | `#6D28D9` zemin `#F1EAFF` | `#C4B5FD` zemin `#261D45` |
| Turuncu (uyarı, gecikme) / kırmızı (hata, iptal) | `#B45309` / `#C81E1E` | `#FBBF24` / `#FCA5A5` |
| Grafik serisi | canlı zümrüt `#0E9F6E` | `#34D399` |
| Pirinç (ödül) | dolgu `#F2C94C` üstünde `#2E2113`, metin `#765923` | dolgu aynı, metin `#F2C94C` |
| Bant (giriş, Araçlar, bildirim) | `#0B100E` + yeşil hâle + krema dalgaları | `#060908` |
| Marka karosu (uygulama ikonu) | `radial-gradient(#23876A → #1D6D56 → #0C3B2D)`, krem `#FBF6F1`, pirinç `#E8C877` | aynı |

- **Canlı tur (18 Kasım 2026, operatör: "renkleri canlı yap, modernleştir ve estetikleştir"):** bej ve sütlü kahve yerine
  ferah, hafif yeşil tonlu nötrler (kitin kendi sahne grisine yakın); renk durumlarda ve marka anlarında canlı: dolu
  masalar L'Affogato yeşilinin degradesi, zamanı daralan ahududu, ok halkası parlak zümrüt, ürün kartının tepesinde
  kategori renginde kısa şerit, bantlarda yeşil hâle, yan menüde ve üst çubukta seçili öğenin yeşili. Bütün çiftler iki
  temada AA (`tests/design-tokens.test.ts`).
- Değer adları `--admin-*` (`:root` açık, `.dark` koyu); ortak adlar (`--bg`, `--ink`, `--primary`, `--focus`...) onlara
  çözülür; kitin adları: `--admin-stage`, `--ok-ring`, `--ok-arrow`, `--admin-signal*`, `--band*`, `--glass`, `--waves-*`.
  Tailwind anlam adları iki temada doğru tonu verir: `text-signal-ink`, `bg-signal-soft`, `bg-stage`, `text-blue-ink`,
  `bg-warning-soft`... Ham ölçekler (`danger-600`, `success-600`...) koyuda değişmez; yalnız beyaz yazılı dolu yüzeyde
  kalır, `tests/ui-rules.test.ts` izinli listeyle tutar.
- **Odak halkası** 2 px ev yeşili, 2 px dışarıda; bantta açık yeşil. Alan odakta mürekkep kenar ve 1 px mürekkep halka
  (kitin formu).

### Biçim

- **Köşeler** (kitin merdiveni): sahne 28 (`--r-stage`), yaprak ve pencere 24 (`--r-leaf`, `rounded-3xl`), cam çubuk 22
  (`--r-glass`), kart ve tuş 18 (`--r-card`, `rounded-2xl`), alan 12 (`--r-control`, `rounded-xl`), küçük denetim 10;
  düğme, çip, rozet, sekme, segment ve arama alanı hap. Sütun grafiğinin üst köşesi 3, yatay çubuk hap. Kasa ve yönetim
  aynı merdivende (kurumsal 6 px yüzey kalktı); `.surface-soft` müşteri ekranının yönetimdeki önizlemesinde kalır.
- **Gölge** sıcak topraktır (`#3B2A1E`): kart neredeyse yok (`--shadow-card`, 1 px), cam çubuk ve mürekkep kart
  `--shadow-lift`, yaprak `--shadow-leaf`, pencere ve menü `--shadow-pop`. Koyuda kart gölgesiz, ayrımı ton ve çizgi yapar.
- **Boşluk:** 4'ün katları; sahne iç payı 8 (telefon) / 12 (tablet) / 14 (geniş), sütunlar arası 18, kart arası 10-12.
- **Hareket:** üzerine gelme 160 ms, durum 280 ms, açılış 620-1000 ms; hep `--ease-out` (0.16, 1, 0.3, 1). Basılı ölçek
  0.97; ok halkası üstüne gelince ve odakta 45° döner.

### Çizimler

laffogato'nun çizimleri (`public/illustrations/`, docs/BRAND.md §6.1: düz dolgu, 2 px espresso kontur, altı renk,
yazısız) `src/assets/illustrations/`'ta; `EmptyState art=` ya da `<Illustration>` basar (`alt=""`, anlamı başlık taşır;
koyu temada porselen bir disk üstünde). Eşleme: fiş (açık sipariş yok), boş fincan tabağı (sonuçsuz arama), boş kek
standı (kategoride ürün yok), fincan (adisyon boş), espresso (bekleyen fiş yok), çalar saat (hazırlanan kalem yok), bilet
(rezervasyon yok), kupon (müşteri yok), kapı (gün açılmadı), affogato (bugün satış yok), kalp (her şey yolunda).

## 3. Kasa ekranları (masalar, adisyon, bar, kasa, patron)

- **Kabuk** (`src/components/AppShell.tsx`, kitin `.rail`'i): tablet ve bilgisayarda 64 px buzlu üst çubuk: solda
  L'Af karosu ve "L'Affogato · LafPOS · rol", ortada ekranlar (düz yazı; seçilinin altında mürekkep çizgi, üstüne gelince
  soldan çizilir; sığmayanlar ölçülüp Araçlar'a geçer, etkin ekran hep görünür), sağda durum hapı (canlı nokta, saat, Z;
  dokununca kasa; kopunca kırmızı), arama (⌘K) ve **Araçlar**: mürekkep hap, kişinin avatarı, sığmayan ekran sayısı ve
  yeşil ok halkası. Telefonda üst şerit (karo, ekranın adı, arama, bağlantı ve gün, kişi) ve alt sekme çubuğu (etkin
  sekmenin ikonu mürekkep hapta). Platform siparişi onay bekliyorsa üst çubuğun altında bordo hap şerit (kitin "N
  waiting in Review" hapı).
- **Araçlar çekmecesi** (`src/components/ToolsDrawer.tsx`, kitin Tools'u): tam ekran espresso gecesi, kayan krema
  dalgaları, yukarıdan perde gibi iner; satırlar iri (Gabarito 22-30, büyük harf yok), satırlar sırayla gelir, üstüne
  gelince ve etkin ekranda yeşil ok halkası belirir. İki grup: Ekranlar; Bu cihaz ve oturum (Ekranı kilitle, tema
  Açık / Koyu / Cihaz ya da bar teması, tam ekran, uzaktan çıkış). Kişinin menüsü de budur ("… menüsü"): telefonda
  avatar ve "Daha" sekmesi açar.
- **Sahne** (`src/components/ui/Stage.tsx`, kitin `.sahne-sayfa`'sı): geniş ekranda (lg) iki sütun. Solda ekranın kimliği:
  başlık ve tek cümle durum, isteğe bağlı görsel (kadran), yan menü, ikinci dizin (masasız siparişler), altta büyük
  sayılar (`Hero`) ve tek ana eylem; sağda yaprak. Dar ekranda tek sütun: başlık ve sayılar bir şeritte, eylemler altında,
  yan menü yatay hap şeridi; telefonda başlığı üst şerit yazar (sahnedeki yalnız ekran okuyucuda). Sayfanın `PageHeader`'ı
  sahnede başlığını sol sütuna, eylemlerini ana eylemin yerine taşır (portal); `headerInLeaf` ile yaprağın başında kalır.
- **Sol sütun paneli** (18 Kasım 2026, operatör: "modernleştir, açık ve canlı renkler"): geniş ekranda sütun 240 px
  (80rem üstünde 264), yaprakla aynı köşede açık şafak paneli: beyaza yakın zemin (`--side-base`), sol üstte açık nane
  (`--side-tint-a`), sağ üstte buz mavisi (`--side-tint-b`), dip düz; beyaz saç teli kenar ve yeşilimsi yumuşak gölge. Ana
  eylem sütun kaysa da dipte yapışık kalır. Koyu temada
  aynı şafak düşük ışıkta.
- **Yan menü** (`.lp-menu`, shadcn'in Sidebar'ı gibi): satır 36 px (dokunmatikte 44), ikon, ad, sağda soluk sayı. İkon açık
  renkli çipte, ton sırayla zümrüt, mavi, mor, kehribar, gül (`--admin-hue-*`; yalnız süs). Seçili satır zümrütten
  camgöbeğine canlı geçiş (`--menu-active-from/via/to`), beyaz yazı ve sayı (her durakta 4.9:1 üstü), altında yeşil hâle;
  üstüne gelince yarı saydam beyaz; grup başlığı küçük ve soluk (`.lp-menu-label`). Numara yok. Dar ekranda hap şeridi
  (seçili hap aynı canlı geçişte).
- **Durum renkleri:** masa boş kesikli kenarlı açık kart, dolu L'Affogato yeşilinin degradesinde beyaz yazılı kart (iki
  temada), hesap istendi soldaki ahududu şerit ve "Hesap" hapı, kısmen ödendi altta beyaz ilerleme çubuğu ve "₺X kaldı";
  hazır kalem beyaz hapta nabızlı; online (siteden gelen) sipariş her
  ekranda mor. Bar ekranında kalem bekliyor nötr (gri halka), hazırlanıyor mavi, hazır yeşil, teslim edildi gri (yazıyla
  "Teslim edildi"); amber yalnız zamanı söyler (ayardaki dakikayı geçen fişin süre rozeti, planlı saat), kırmızı alarm ve
  iptal.
- **Masalar:** sahnede solda başlık ve tarihli durum cümlesi, bölümler yan menüde (dolu sayısıyla), masasız siparişler ve
  bugünkü rezervasyonlar ikinci dizinde, altta büyük sayılar (dolu masa, hesap istendi bordo, açık hesap) ve Gel-al,
  Paket, ana eylem Tezgâh satışı. Yaprakta bölümün adı, görünüm (plan / liste) ve plan: kabın hem enine hem boyuna sığar
  (16:10). Masa kartı köşe 18, ad Gabarito kalın, tutar kartın en büyük yazısı (Gabarito 26/700), altında süre ve garson;
  bara gitmiş ve hazır kalemler küçük hap, hazır olan yeşil ve nabızlı.
- **Adisyon:** sahnede solda kategoriler yan menüde (renk noktası, ad, ürün sayısı; telefon ve tablette hap çip, seçili
  mürekkep), ortada arama (hap) ve ürün kartları sahnenin üstünde beyaz (köşe 18, ad Gabarito 16/700, fiyat Gabarito;
  sitedeki görsel ya da kategori renginde baş harf; iki boyluda hap boy düğmeleri), sağda hesap yaprağı: masanın adı
  (Gabarito 24-28/700), toplam Gabarito 34 px, tek ana eylem "Öde · ₺X" mürekkep hap ve ok halkası.
- **Patron paneli:** solda başlık, canlılık, kitin **24 saat kadranı** (`src/components/ui/Dial.tsx`: her saat bir çizgi,
  boyu o saatin cirosu, şimdiki saat yeşil; ortada bugünkü adisyon sayısı), altta ortalama adisyon ve açık adisyon; sağda
  ciro kartı, karolar, dikkat isteyenler, grafik, ödeme türleri ve en çok satanlar.
- **Kasa, Siparişler, Rezervasyon, Müşteriler, Eğitim cihazı:** aynı sahne; görünüm sekmeleri (Bugün / Geçmiş günler;
  Açık / Online / Paket ve gel-al / Kapanan) yan menüde, içerik yaprakta; Müşteriler iki yaprak (liste, kayıt).
- **Bar ekranı:** sahnede üstte cam çubuk (karo, "Bar ve mutfak", sekmeler, araçlar), altında sayaç şeridi (Gabarito 34
  rakam) ve fiş ızgarası.
- **Ürün kartı ve masa kartı dışındaki kartlar** gölgesiz ve saç teli kenarlıdır; seçili ya da üstüne gelinen kartın kenarı
  mürekkep.
- **Logo:** L'Af, laffogato.net ve uygulama ikonuyla aynı vektör (`src/components/LafMark.tsx`); karoda (`LafTile`)
  uygulama ikonunun kendisi. Yazı tipine bağlı değil, Didot'u olmayan Windows ve Android'de de aynı. Karo uygulama
  ikonunun oranında: logo karonun yüksekliğinin yarısı, köşe kenarın %22'si (arayüzün köşe ölçeğinden bağımsız; `TILE`,
  `src/components/LafMark.tsx`).
- **Giriş ekranı** (kitin girişi): espresso bandı ve yavaş kayan krema dalgaları; solda işletme, 112 px saat, tarih ve
  ekip; sağda beyaz PIN kartı (köşe 28): "Hoş geldiniz", PIN noktaları, beyaz tuşlar (köşe 18, Gabarito rakam) ve mürekkep
  "Giriş" tuşu ok halkasıyla. Kilit ekranında yalnız oturum açılır (mesai 4 Kasım 2026'da kaldırıldı).
- **Ödeme penceresi** üç yol: Tutar (nakit ya da kart, para üstü), Kalem (seçili kalemler), Paylaş. Paylaş'ta önce
  "Kaç kişiye bölünsün?": 2, 3, 4, 5, 6 büyük çipler (56 px, Gabarito rakam) tek dokunuşla böler, daha kalabalık masa
  adet seçiciyle (en çok 30). Altında **Eşit | Elle**: Eşit'te kalan kuruşu kuruşuna bölünür; Elle'de her ödenmemiş
  payın kendi tutar alanı olur, eşit bölüşle dolu gelir, son pay kalanı kendisi gösterir ("Kalanı alır"); pay sıfır ya
  da eksi olamaz, toplam kalana eşittir, düğme "Payları kaydet" (kaydedilmeden ödeme düğmesi "Önce payları kaydedin"
  der). Paylar sırayla ve istenen yöntemle alınır: sıradaki pay mürekkep kenarlı, ödenen pay yeşil onaylı. Pay tutarını
  sunucu hesaplar (`shared/order-calc.ts` `splitState`, elle tutarlar `orders.split_amounts`); hesap değişince (kalem,
  iptal, indirim, ödeme iptali) elle paylar düşer, kalan yeniden eşit bölünür ve pencere bunu kısa notla söyler.
- **Ödenmez kişi seçimi** (`OdenmezModal`): ödenmez (adisyonun tamamı, ödeme penceresinden ya da İşlemler'den; tek
  kalem, kalem sayfasındaki "Ödenmez yaz") kayıtlı bir kişi seçilmeden yapılmaz. Tek pencere: "Kimin adına?" araması
  (ad ya da telefon), iki grup: Personel (etkin kullanıcılar, avatar ve rolüyle) ve Müşteriler (boş aramada son gelenler,
  telefonun son 4 hanesiyle "Telefon •• 1122"); seçili satır yeşil kenar ve tik. Altında neden çipleri (mürekkep) ve
  alan; personel seçilince "Personel yemeği", patron seçilince "Patron hesabı" önerilir, yazılan neden ezilmez. Kişi
  seçilmeden onaylanınca ileti alanın altında ("Kimin adına yazılacağını seçin"). İkram ve zayide kişi sorulmaz.
  Sepette ödenmez kalem "Ödenmez · Garson" diye işaretlenir; raporda "Garson adına", Z'de ödenmez satırının altında
  kişi kişi döküm. Yazarkasada fiş tek kesilir, paylar cihazda ayrı ödeme. Ödeme düğmesi
  pencerenin alt şeridinde, kaydırınca kaybolmaz; yanında para üstü, eksik ya da bahşiş notu. Düğmenin tutarı bahşişi
  içerir (kartta bankanın POS'una girilen tutar) ve eksik adımı söyler ("Ödenecek kalemleri seçin", "Önce hesabı
  bölün"; açık hesapta "açık hesaba yaz"). Tablet ve bilgisayarda iki sütun: solda tutar, tuş takımı, yazarkasa ve
  alınan ödemeler; sağda ödeme türleri, Verilen, Bahşiş ve ciro dışı kapanış. Sepet yazarkasada beklerken LafPOS'ta
  ödeme, ciro dışı kapanış ve ödeme iptali kapalı; durum ve "Sepeti iptal et" en üstte. Sonuç ekranında para üstü en
  üstte, mürekkep kenarlı nötr kutuda.
- **Adisyon** (4 Kasım 2026 yenilemesi): iki kart, ürünler | hesap. Ürünlerde üstte arama ("/" ile), geniş ekranda
  solda kategori rayı (sayılarıyla), telefonda kategori çipleri; kartta sitedeki görsel ya da kategori renginde baş
  harf, ad, fiyat, iki boylu üründe boy düğmeleri, tükendi soluk ve rozetli. Hesap bir bakışta okunur:
  - **Başlık:** Gabarito masa adı (22/700) ve numara; künye (kişi, garson, açılış saati ve süresi, müşteri, not); durum
    çipleri (Kapandı, İptal, Birleşti; Hesap yazdırıldı amber, Kısmen ödendi pembe, "3 kişiye bölündü", "2 ürün
    gönderilmedi").
  - **Kalemler duruma göre gruplu** (`src/pages/order/cartGroups.ts`): Gönderilmedi (amber, cihazdaki sepet, en üstte),
    Barda (kobalt nokta; bekliyor mu hazırlanıyor mu kalemde yazar), Hazır (yeşil), Teslim (nötr; bara gitmeyen kalem
    de), İptal edilenler (kırmızı). Grup başlığı yapışkan, sayısıyla. Her kalemde adet hapı, ad ve boy, seçenek çipleri,
    not ve sağa hizalı Gabarito tutar.
  - **Kalem işlemleri kalemden tek dokunuşta:** İkram et, Ödenmez yaz (kişi seçilir), Zayi yaz, Kaleme indirim, Taşı
    (taşıma penceresi kalem seçili açılır), Not ekle (bar fişi canlı görür, `PUT /orders/:id/items/:itemId/note`), en
    altta kırmızı İptal et.
  - **Toplam** Gabarito 28/700; altında hızlı işlemler sakin bir sırada, ikon ve kısa ad: Böl, İndirim, Taşı, Hesap
    yazdır, İşlemler (İşlemler telefonda başlıkta). Tek birincil eylem mürekkep "Öde · ₺X" (gönderilmemiş varsa önce
    gönderir); gönderilmemiş kalem varken ikincil "Bara gönder (N)" ve geri alınabilir çöp kutusu. Ödeme alamayan rolde
    (garson) birincil eylem "Bara gönder (N)" ya da "Hesap yazdır" ve altında "Ödemeyi kasa alır".
  - **Telefonda önce ürünler:** alttaki yapışkan sepet çubuğu ("3 ürün · ₺780 · Sepet", gönderilmemiş sayısı amber
    rozette: yumuşak zemin, koyu amber yazı) sepeti açar, yanında "Bara gönder" (erişilebilir adı "Bara gönder (N)");
    tutar kısa yazılır, 360 px'te de kesilmez. Kalemsiz adisyonda da durur ("Sepet boş"): oda sayacı, "Masayı boşalt"
    ve boş durum sepette. Sepette en üstte "Ürün ekle" ürünlere döner; geçişte odak öteki görünümün geçiş düğmesine
    geçer. Bildirim alttaki bloğun (hızlı işlemler ve eylem şeridi ya da sepet çubuğu) ölçülen boyunun üstünde durur
    (`--action-bar-h`).
  - **Durumlar:** boş masa (fincan çizimi, "Masayı boşalt"), kapanmış adisyon (yeşil "Kapandı", katalog yok, adisyon
    ortada), sitede ödenmiş online sipariş (mor şerit, tahsil edilmez, Z'ye girmez), tezgâh satışı (Öde kalemleri ödeme
    bekleyen olarak yazar ve ödemeyi açar, ödeme alınınca kalemler kendiliğinden bara gider, satış bitince yeni satış).
  - **Ödeme bekliyor:** tezgâh satışında "Öde"den sonra ödeme alınmadan pencere kapanırsa kalemler sepette en üstte
    amber noktalı "Ödeme bekliyor" grubunda ("Ödeme alınınca bara ve mutfağa gider"); bar ve çağrı ekranı görmez,
    Siparişler kartı "barda" saymaz, amber "Ödeme bekliyor" rozeti gösterir. Grubun "Ödemeden gönder"i (sipariş
    yetkisi) bekleyenleri hemen bara yollar; istek sürerken kilitli. Ödeme alamayan rol (garson) "Öde" görmez, boş
    sepette "Bara gönder" ipucunu görür.
- **Bar ekranı:** fişler kabın genişliğine göre 1-5 sütunlu ızgarada (telefon 1, tablet dikey 2, bilgisayar 3, geniş
  ekran 4-5; container query). Aynı satırdaki fişler eşit boyda, Başla ve Hepsi hazır dipte hizalı. Üstte sayaç şeridi
  tek çerçevede, ince bölmeli (Bekliyor, Hazırlanıyor, Teslim bekliyor, Geciken; sıfırken gri; telefonda başlıkta hap
  sayaç). İkon kutusu yalnız geniş ekranda (lg); tablet dikeyde hücre etiket ve rakamdır, etiket kesilmez. Şerit veriye
  bağlı: bağlantı kopunca eski fişlerle birlikte kalır. Fişin üstünde 4 px durum çizgisi (gri bekliyor, mavi
  hazırlanıyor, yeşil hazır, amber ve kırmızı gecikme); başlıkta yer (masa, numara, çağrı) en büyük yazı, ikinci satırda
  numara, garson ve gönderim saati, tahsil edilecek bir şey yoksa yeşil "Ödendi" (hesap kapanmış ya da tamamı ödenmiş,
  ya da fişin kalemleri seçilerek ödenmiş; tezgâh satışı ödeme alınınca düşer; "Ödemeden gönder" ile gidende yok,
  teslimde tahsil edilir). Ödeme ya da iade anında görünür ya da kalkar.
- **Müşteriye dönük ekranlar** (kasa menüsü olmadan, otomatik kilit yok):
  - **Müşteri ekranı** `/musteri-ekrani` (iki ekranlı kasanın ikinci monitörü ya da müşteriye dönük tablet): boşta
    karşılama (L'Af, Gabarito 800 başlık, bayrak çizgisi, slogan; dönen duyurular, karekod, saat), adisyon açıkken
    kalemler ve markanın yüzeyinde büyük tutar, ödemeden sonra teşekkür (self serviste çağrı numarası; uzun kimlik,
    "Masa WWWWWW", ekranla küçülen yazı ve kırılan kelimeyle telefonda da taşmaz). **Değiştirilebilir:** Yönetim ›
    Müşteri ekranı'ndan tema (gece, porselen, ev yeşili), karşılama başlığı ve alt satırı, teşekkür başlığı, en çok 6
    duyuru, karekod adresi ve yazısı, saat ve seçenekler; sağda gerçek ekranın canlı önizlemesi (aynı bileşen,
    `CustomerDisplayView`). Ayar sunucuda (`customerDisplay`), ekran oturumsuz okur (`GET /api/public/display-config`,
    yarım dakikada bir; son görünüm cihazda saklanır). `?tema=acik` porselen açar (eski kurulum adresleri).
  - **Çağrı ekranı** `/cagri`: Hazırlanıyor ve büyük numaralı Hazır; platformun gel-al siparişinde platformun kodu ve adı.
  İkisi de ilk karesinden koyu açılır (gece loş salonda en parlak yüzey olmasın).
- **Grafik:** tek seri tek renk (ev yeşili), kıyas serisi gri çizgi, tek eksen; tutar ekseninde kesirli
  adım yok, verisi olmayan dönemde eksen yerine ekranın zamanını söyleyen boş durum çizilir (Bugün henüz satış
  yok, Bu günde satış yok, Bu dönemde satış yok; `ColumnChart` `emptyLabel`, `src/components/charts.tsx`). Dokunmatikte
  grafiğin tamamı tek hedeftir (telefonda 24 saatin sütunu 11 px): dokunulan ya da parmak yana kaydırılınca altına gelen
  sütunun değeri dışarı dokunulana dek kalır, dikey kaydırma sayfanındır; klavyede grafik odak alır, oklar sütunlar
  arasında gezer; ekran okuyucu gizli veri tablosundan okur. Süre grafiğinin ekseni dakikayla (0, 2 dk, 4 dk;
  `ColumnChart` `unitDivisor` 60 ve `tickFormat`). Kıyas döneminde hiç değer yoksa kıyas çizgisi, açıklaması ve ipucu
  satırı çizilmez. Isı haritası aynı yeşilin tonları; dokunmatikte hücresi 44 px (harita yana kayar), dokunulan hücrenin
  değeri lejantın altında.

## 4. Yönetim paneli

Panel açıkken `<html data-area="admin">`; aynı renkler ve aynı sahne, sıklık farklı (fareyle 36 px düğme, "Sıkı
görünüm"de 32). Kurumsal 6 px yüzey (4 Kasım 2026) kalktı: yönetim ve raporlar kasayla aynı köşe merdiveninde.

- **Yerleşim** (`src/components/admin/AdminShell.tsx`): kasanın üst çubuğunun altında sahne. Geniş ekranda (lg) solda
  **shadcn'in Sidebar'ı gibi sade yan menü**: grup başlıkları küçük ve soluk (Genel, Menü, Salon ve kasa, Ekip,
  Bağlantılar, Sistem), altında bölümler renkli ikon çipleri ve adlarıyla; seçili satır canlı zümrüt geçişte; sayaç yalnız iş
  bekleyen yerde (tükenen ürün, gönderilemeyen gün), ne saydığı ipucunda ve ekran okuyucuda; dipte "Kasa ekranlarına
  dön" ve "Sıkı görünüm". Sağda beyaz yaprakta sayfanın başlığı (Gabarito 26/700), açıklaması ve eylemleri (sağda önce
  ikincil sonra ana eylem), altında içerik (`Stage headerInLeaf`). Tablette menü yatay kayan hap şeridi, telefonda kabuğun
  kendi üst şeridi (geri, bölümün adı, arama, bağlantı, kişi) ve `/yonetim`'de gruplu bölüm listesi.
- **Tablolar:** yalnız başlık ve satır çizgileri (başlık şeridi zeminsiz, `--table-head-bg`), rakam sağa hizalı ve
  Gabarito tablo rakamı; kitin `DataTable`'ı, raporların `ReportTable`'ı ve roller matrisi aynı başlığı çizer; seçili
  satır solda 3 px mürekkep çizgi.
- **Kasa ekranının önizlemesi:** yönetimdeki birebir önizleme (Yönetim › Müşteri ekranı) `.surface-soft` ile kasa
  köşelerinde kalır (@theme köşeleri ve `:root`'un `--r-*` değerleri); gerçek ekranla aynı görünür.
- **KPI şeridi:** ince bölmeli, tek çerçeveli ızgara (`KpiStrip`, hücreler arası 1 px), rakam Gabarito 34 px sıkı.
- **Bileşenler** (`src/components/admin/ui.tsx`): `PageHeader` (sahnede yaprağın başında; `headerInLeaf` değilse sol
  sütuna taşınır), `Card` (köşe 18, saç teli, gölgesiz; başlık 16/700), `KpiStrip`, `StatusTabs` (beyaz hap çipler,
  seçili mürekkep dolgu), `Segmented` (kitin `.seg`'i: beyaz hap ray, ince kenar, seçili mürekkep hap; telefonda tam
  genişlikte satıra kırılır; radyo grubu klavyesi), `DataTable`, `ActionMenu` (⋯, köşe 20, portalda), `QuickLook` (sağdan
  hızlı bakış, köşe 24, telefonda alt sayfa), `ActionRows`, `Timeline`, `Badge`, `EmptyState`, `SearchField`. Düğme hap;
  dokunmatikte 44, farede 36, sıkı görünümde 32 px.
- **Sayfalar:** Genel bakış (KPI şeridi: net ciro geçen haftanın aynı günü aynı saatine göre, adisyon,
  açık adisyon, indirim ve ikram, online sipariş; saatlik grafik; en çok satanlar; dikkat isteyenler;
  sistem sağlığı), Ürünler, Seçenekler, Masa planı, Ödeme türleri, Personel ve yetki, Yazarkasa, Site
  ve lafmaliyet, Ağ ve uzaktan erişim (yerel adres ve Tailscale karekodu), Ayarlar, Denetim kaydı (zaman çizelgesi),
  Raporlar (dönem segmenti, rapor sekmeleri, önceki dönemle KPI şeridi).

### LafPOS'un eklemeleri (Innex ve Area Board kitine göre)

1. **Koyu tema:** aynı roller koyu değerlerle (sıcak gece), her çift AA'da test ediliyor.
2. **⌘K komut paleti** (Innex §1.2 önerisi): ekranlara, yönetim bölümlerine, ürünlere ve personele atlar;
   "Yerel ürün ekle", "Personel ekle", tema, kilit gibi eylemler. Türkçe harfleri katlayarak arar
   ("cay" Çay'ı, "sut" Süt'ü bulur). Kasa ekranlarında da çalışır (Ctrl K ya da sol menüdeki büyüteç).
3. **Daraltılabilen kenar çubuğu** ve **sıkı görünüm** (Innex §4 "yoğunluğu bir ayar olarak düşün"):
   cihazda saklanır. Sıkı görünüm yalnız fareyle etkilidir; dokunmatikte hedefler 44 px kalır.
4. **Telefon ve tablet** (Innex'in hiç çizmediği; impeccable `adapt`): telefonda kart yok, yönetimin
   girişi gruplu bölüm listesi, tablo satır kartına, çekmece alt sayfaya döner; tablette dar ikon menüsü
   ve sığmayan ikincil sütunlar gizlenir.
5. **Derin bağlantı:** hızlı bakış adresle açılır (`?urun=`, `?kisi=`); geri tuşu çekmeceyi kapatır, komut
   paleti doğrudan kayda götürür.
6. **Sistem sağlığı kartı** (Innex §3 fikir 5): site menüsü, online sipariş, lafmaliyet, yazarkasa ve
   yedeğin durumu tek yerde.

## 5. Ortak bileşenler ve etkileşim (28 Ekim 2026, 17 Kasım 2026'da kitin diline geçti)

Kasa ekranları `src/components/ui/*`, yönetim `src/components/admin/ui.tsx` kullanır; ikisi aynı belirteçlerden
ve aynı kurallardan çizilir. Yeni ekran önce bu parçalara bakar, kendi denetimini yazmaz.

- **Düğme** (`src/components/ui/Button.tsx`, kitin `.btn`'i): her düğme hap. `primary` ve `ink` ekranın tek ana eylemi:
  mürekkep hap, yazı kalın, sağında yeşil **ok halkası** (`Ring`, `.lp-ring`; üstüne gelince ve odakta ok 45° döner,
  devre dışıyken gri); geniş ana düğmede yazı solda, halka sağda. Ana eylemde baştaki ikon yok. `secondary` beyaz hap ve
  ince kenar (üstüne gelince mürekkep kenar), `ghost` kenarsız, `success` dolu yeşil (bar ekranında "Hepsi hazır"),
  `danger*` kırmızı. Kapat düğmesi mürekkep halkalı daire. Kare ikon düğmesinde halka yok. Ölçü merdiveni (fareyle /
  dokunmatikte): `sm` 32 / 44, `md` 40 / 44 (yönetimde fareyle 36), `lg` 44 / 48, `xl` 48 / 56; yazı 13, 14, 15, 16 px.
  Giriş alanı, açılır liste ve arama alanı düğmeyle aynı boyda (40 / 44; yönetimde fareyle 36), yazı fareyle 14 px.
- **Ölçek:** sayfa başlığı Gabarito 22-26/700 ve 13 px açıklama (`PageHeader`), bölüm 16/700, kart başlığı 16/700, mikro
  etiket 12/500; kart arası 10-12 px. KPI karosu tek bileşen (`Stat`: 13 px etiket, Gabarito 30 px rakam, `strong` 40
  px, sıkı aralık); rakam yerine kelime yazılmaz ("—" ve ipucunda "Sayılmadı").
- **Durumlar:** her denetimin dinlenme, üzerine gelme, basılı (zemin bir ton koyu; dokunmatikte `hover`
  çalışmadığı için basılı renk ayrıca yazılır), odak (2 px birincil halka) ve devre dışı hali var. Devre dışı
  birincil düğme gri zemin ve soluk yazıdır, yarı saydam değil; bir bilgi cümlesi devre dışı düğme olarak
  çizilmez ("Ödemeyi kasa alır" düğmenin altında yazıdır).
- **Sekme ve seçim** (kitin dili: seçim mürekkeptir): `Tabs` (bölüm, istasyon, sipariş listesi; seçili mürekkep hap,
  sayı hapı sıfırsa gizli, dar ekranda yatay kayar: seçili sekme rayda görünür kalır, içeriğin gizlendiği kenar solar,
  `useRail`) ve `Segmented` (2-4 eşit seçenek; beyaz hap ray, ince kenar, seçili mürekkep hap). Seçim çipi `Chip`
  (`src/components/ui/Field.tsx`; hap, `aria-pressed`): beyaz, ince kenar, seçili mürekkep dolgu; hazır neden ve süre
  seçiminde (`tone="ink"`) ayrıca tik. Dolu yeşil hap yalnız olumlu durumdur (hazır, ödendi); amber durum rengidir,
  seçim için kullanılmaz; bağlantı ev yeşili, kobalt yalnız durum. Adet ve kişi sayısı `Stepper` ile: hap grup, yuvarlak
  eksi ve artı, değer; en küçük adette Kaldır; tek değerli pencerede `size="lg"`. Tuş takımı (`Numpad`): beyaz tuşlar
  (köşe 18, Gabarito rakam), onay tuşu mürekkep ve ok halkalı.
- **Boş, yükleniyor, hata:** `EmptyState` (kart içinde `compact`, sayfada varsayılan, bar ve çağrı ekranında
  `large`; başlık ekranın sözüyle, "Liste boş" değil), `Skeleton` / `ListSkeleton` (ilk yüklemede), `ErrorState`
  (boş durumla aynı ölçek ve üç boy: kart içinde `compact`, sayfada varsayılan, tam ekranda ve bar ekranında `large`;
  yeniden dene ile). Yüklenirken ya da hata varken "yok" yazılmaz.
- **Onay ve metin isteme:** tarayıcının `confirm()` / `prompt()` pencereleri yok; `confirmDialog` /
  `promptDialog` (`src/components/ui/Confirm.tsx`) eylemi adlandıran düğmeyle, yıkıcı eylemde kırmızı. Para ya da
  kayıt değiştiren her düğme istek sürerken kilitlidir (`loading`), ikinci dokunuş gitmez. Pencere köşe 24; pencere ve
  çekmece başlığı Gabarito 20/800, Kapat (mürekkep halkalı daire) başlığın ilk satırında; pencerede başlık kesilmez, hızlı bakış çekmecesinde en çok iki satır. Onay ve
  metin isteme penceresinde Kapat yok (Vazgeç aynı işi yapar, Escape ve arka plan da vazgeçer).
- **Tutar girişi:** ekrandaki tuş takımı (`Numpad`) fiziksel klavyeyle de çalışır: rakam, `,` ve sayısal
  takımın ondalığı virgül; ana sıradaki `.` ardından üç rakam gelirse binlik ayıracı ("2.000"), değilse ondalık
  ("45.90" = 45,90 TL); Enter onaylar, odaktaki tuşa yeniden basmaz. Önceden dolu tutarın üstüne ilk tuş yazar.
  Kalandan fazlası sessizce kırpılmaz, alan uyarır. Tümünü silen tuş "Temizle", tek rakamı ⌫ siler.
- **Alan:** kısa ipucu (16 karaktere kadar: "zorunlu", "5–120") etiketin sağında; uzunu alanın altında yardım metni ve
  alanın açıklaması (`aria-describedby`); etiket satırı tek satır kalır (13/600 mürekkep), iki sütunlu formda alanlar
  hizalı. Köşe 12, arama alanı hap. Odakta mürekkep kenar ve 1 px mürekkep halka (kitin formu), hatada kırmızı kenar ve
  ileti alanın altında (`Field`, `src/components/ui/Field.tsx`).
- **Bildirim:** mürekkep zeminli hap; dört tonda da (başarı, bilgi, uyarı, hata) durum rengi yalnız ikonda, bilgi
  renksiz; koyu temada yüzen yüzey. Telefonda alt sekme çubuğunun üstünde, ev çubuğu payıyla; alt eylem şeridi olan
  ekranda (`data-action-bar`: adisyonun Gönder / Ödeme şeridi) şeridin de üstünde. Tablet ve bilgisayarda üst ortada.
  "Geri al" gibi tek eylem taşıyabilir, eylem bir kez çalışır; hata ve uyarı hemen okunur ve daha uzun kalır.
- **Sınıflar:** `cn()` (`src/lib/cn.ts`) çakışan Tailwind sınıflarını birleştirir, sonraki kazanır (`px-0`
  `px-3`'ü ezer). Yalnız aynı varyanttaki sınıflar birleşir: sayfanın `max-md:hidden` sınıfı kitin `max-sm:flex`
  sınıfını ezmez, ikisi de kalır ve derlenmiş CSS'te sonra gelen kazanır; kit bileşenini bir kırılımda gizlemek için ona
  sınıf vermeyin, `max-md:hidden` sınıflı bir kaba sarın. Geçiş yalnız değişen özelliklere, 150 ms; hareket azaltmada
  dekoratif hareket ve nabız durur.
- **Kaydedilmemiş değişiklik:** uzun ayar formu değişiklik varken altta yapışkan şerit (Vazgeç, Kaydet) gösterir;
  sekme kapanırken, uygulama içi geçişte ve geri tuşunda sorar (`src/lib/unsavedGuard.ts`).

## 6. Telefon ve tablet (impeccable `adapt`)

- Kırılımlar: telefon `< 768`, tablet `768-1023`, bilgisayar `1024+`. Giriş türü genişlikten değil
  `pointer-coarse` / `pointer-fine` sorgusundan: dokunmatikte her hedef en az 44 px.
- Telefon: tek sütun, alt sekme çubuğu (beş yer: ekran azsa hepsi sekme, "Daha" yok; çoksa dört ekran ve "Daha";
  patron panelini görende Patron sekmesi Bar'ın yerinde; üst şeridi olmayan bar ve adisyon ekranında yer varsa son
  sekme kişinin menüsü; `phoneTabs`, `src/lib/nav.ts`), birincil eylem altta (adisyonda "Bara gönder" / "Öde" şeridi; ürünlerdeyken yapışkan sepet çubuğu), modal
  yerine alt sayfa, tablo yerine satır kartı, çentik için `safe-area`.
- Tablet: üst çubukta sığan ekranlar ve Araçlar; sahnede kimlik şeridi ve yan menünün hap şeridi; adisyonda ürünler ve
  hesap yan yana (`min-width: 768px`); yönetimde bölümler hap şeridinde.
- Yönetim › Masa planı'nda masa klavyeyle seçilir (Tab, Enter ya da boşluk), oklarla taşınır, Shift ve oklarla
  boyutlanır; kutunun boyu plandan geldiği için `data-tap-ok` taşır (44 px denetiminin dışında).
- Dokunmatikte alan yazısı en az 16 px (iOS odaklanınca yakınlaştırmasın). Kural katmansızdır ve alanın yazı boyu
  sınıfını ezer: daha büyük alan yazısı (ör. 36 px tutar) alanın kabına verilir, alan onu 1em ile alır.
- **Doğrulama:** `npm run build && npm run e2e`. Tarama her rolün her ekranını 390 px (dokunmatik), 768 px
  (dokunmatik), 1280 px ve koyu temada açar; konsol ve ağ hatası, yatay taşma ve 44 px altı hedefi hata
  sayar; görüntüler `e2e/out/`. Emülasyon gerçek iPhone ve Android dokunuşunu, Safari'yi kanıtlamaz; ilk
  kurulumda gerçek cihazda bir tur atılmalı.
