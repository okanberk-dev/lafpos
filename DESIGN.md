# LafPOS tasarım sistemi: LafPOS Pano

> Ürün bağlamı `PRODUCT.md`'de. **20 Kasım 2026** operatör kararları: _"Modern Financial Dashboard UI … bu tasarım
> metrikleriyle uygun bizim renklerimize uygun şekilde uyarlayıp lafposa uyarlar mısın … olmayanları sen bu metriklerle
> uyarla branding yap"_, _"tüm tasarımı o şekilde yaptığından menüsüne kadar 1:1 olduğundan da emin ol … kullanıcı
> davranışı çok önemli, daha kolay olduğunu anlarsan öyle yap"_, _"yazı tipini de görseldeki gibi yapabilirsin"_ ve
> _"menü kısımlarını da daha güzel tasarla"_. Kaynak Dribbble'daki "Modern Financial Dashboard UI" (Qubecoe, M. Zeeshan
> Nadeem): tek açık gri zemin, zeminde yüzen beyaz kartlar (köşe 18, yumuşak gölge), solda doygun marka rengi dikey ray
> (ikon üstte ad altta, seçili ekran beyaz karo), üst çubukta logo, ortada sekmeler, sağda arama ve kişi; başlık satırında
> "Welcome back, Alex" (ad marka renginde) ve sağda tarih ile ana eylem; kartta başlık, soluk alt satır ve sağda yumuşak
> tonlu ikon dairesi; değişim rozeti, vurgulu tek sütunlu grafik ve değer hapı; yazı Inter. Panonun mavisi yerine
> L'Affogato'nun ev yeşili; kimlik (L'Af logosu, marka karosu, ok halkası, çizimler) korunur. Panoda olmayan ekranlar
> (adisyon, bar, kasa, giriş, müşteri ekranı) aynı ölçülerle kuruldu; kullanıcı akışını yavaşlatacak yerde (ürün
> yoğunluğu, 44 px hedef, telefonda alt sekme) panodan bilerek ayrılındı. Değerler `src/index.css`'te; erişilebilirlik
> oranları `tests/design-tokens.test.ts` ve `tests/ui-kit.test.ts`'te sabit. Test düşerse değeri düzelt, eşiği gevşetme.
> Önceki "LafPOS Sahne" (17-18 Kasım 2026, gnbsite'ın Area Board kiti: sahne, yaprak, mürekkep ana eylem, Poppins ve
> Gabarito) bunun yerine geçti; ok halkası, tek açılış anı ve bantlar ondan kaldı.

## 1. İlkeler

1. **Zemin, kart, ray:** üst çubuk ve içerik tek açık gri zeminde (`--admin-bg` = `--admin-stage`); içerik beyaz kartlarda
   (köşe 18, ince saç teli çerçeve, çok hafif gölge) ya da ekranın büyük beyaz yaprağında (o da çerçeveli), kendi içinde kayar. Kart içinde kart yok;
   yaprağın içindeki kart saç teli kenarlı ve gölgesizdir (`--card-line`, `--card-shadow`). Tablette ve bilgisayarda solda
   ev yeşilinin degradesinde marka rayı: ekranlar arası gezinme yalnız orada.
2. **Renk anlam taşır:** ev yeşili ana eylem ve seçimdir (Öde, Kaydet, seçili çip, segment); açık nane seçili sekme,
   alt menü satırı ve kategori, yumuşak ikon dairesi; dolu masa yeşil degrade; zamanı daralan (hesap istendi, onay bekleyen platform siparişi)
   canlı ahududu; amber uyarı ve gecikme, kırmızı hata ve iptal, kobalt hazırlanıyor ve bilgi, mor online sipariş, pirinç
   ödül. Renk tek başına durum taşımaz, yanında yazı ya da ikon olur.
3. **Sakin başlık, iri rakam:** ekranın adı başlık satırında (Inter 700, 28-32 px, büyük harf yok; patron panelinde
   selamlama, ad ev yeşilinde); öne çıkan rakamdır (tutar, KPI, büyük sayılar: Inter kalın, sıkı aralık).
4. **Dokunmatik önce, aşırı büyük değil:** dokunmatikte her hedef en az 44 px (AGENTS.md kural 8); fareyle ölçülü:
   düğme ve alan 40 px, küçük düğme 32, büyük 44, en büyük 48; yönetimde fareyle 36, sıkı görünümde 32 px. Raydaki ekran
   56 px (alçak ekranda 54, 768 px ve altında 44); alt menü ve kategori satırı 38 px, dokunmatikte 44.
5. **Kullanıcı davranışı önce:** panonun görünümü akışı yavaşlatmaz: ürün kartları sık (ızgarada 4-6 sütun), kategoriler
   tek dokunuş, ana eylem başlık satırının ya da hesabın dibinde hep aynı yerde; telefonda ray yerine alt sekme çubuğu.
6. **Tek açılış anı:** ekrana girerken başlık aşağıdan açılır, yaprak ve kartlar gelir, ilk satırlar 30 ms arayla; sonra
   sakin. Hareket azaltmada hepsi kapalı.

## 2. Belirteçler

### Yazı

- **Inter** (değişken: ağırlık 100-900 ve optik boy; `@fontsource-variable/inter`, `opsz` dosyaları, latin ve latin-ext
  ayrı, pakette, çevrimdışı). Gövde, denetim, başlık ve rakam tek aileden (`--font-sans` = `--font-headline` = Inter);
  iri başlık ve tutarda optik boy kendiliğinden Display'e yaklaşır. Tutarlar `.tabular` / `tabular-nums` ile eşit
  genişlikte. Türkçe harfler (ğ, ş, İ, ı) ve ₺ Inter'de var (latin-ext). Dış kaynaktan yazı yüklenmez.
- **Ölçek:** başlık satırı (`.lp-name`) telefonda 22, tablette 28, geniş ekranda 32 px / 700 / -0.035em; durum cümlesi
  14 px soluk; kart başlığı 17/700 -0.025em, alt satır 13 px soluk; gövde 14-15; mikro 12/500 (en küçük 11). Büyük sayılar
  (`.lp-hs`) 20-22 px kalın; KPI 30-34 px; marka ciro kartında 42 px; müşteri ekranında tutar 48-88/800. Büyük harf
  dönüşümü yok.

### Renk

| Rol | Açık | Koyu |
|---|---|---|
| Zemin (üst çubuk ve sahne tek) | `#F1F4F2` | siyah `#000000` |
| Kart, yaprak | `#FFFFFF` | nötr `#1C1C1E` (yüzen yüzey `#2C2C2E`) |
| Kart içi hafif alan / taş (segment rayı, tuş, kuyu) | `#F7F9F8` / `#EDF1EE` | `#232325` / `#2A2A2C` |
| Saç teli / ince çizgi / satır ayracı / alan kenarı | `#E3E8E4` / `#D2D9D4` / `#EDF1EE` / `#868F8A` (kartta 3.3:1) | `#38383A` / `#48484A` / `#38383A` / `#7C7C7F` (yüzen yüzeyde 3.4:1) |
| Mürekkep / gövde / etiket | `#0F1513` / `#3F4A45` / `#58635E` | kırık beyaz `#F5F5F7` / `#D1D1D6` / `#9E9EA4` (kartta 15.6 / 6.4:1) |
| Ana eylem ve seçim (eylem dolgusu, `--admin-ink-fill`) | ev yeşili `#0A6E52`, üstünde `#FFFFFF` (6.2:1) | ev yeşili `#0A8560`, üstünde beyaz (4.6:1) |
| Ok halkası (ana düğmenin sağı) | açık nane `#D8F6E8`, ok `#075A43` | açık nane `#DFF7EA`, ok `#075A43` |
| Marka rayı | `linear-gradient(180deg, #0B6449 → #095A42 → #074A37)`; yazı `#FFFFFF`, ikinci `#E3F2EA`, soluk `#B9E3CF` (en açık durakta 5.1:1); seçili karo `#FFFFFF` üstünde `#0A6E52` | ev yeşili `#0A5C44 → #084C38 → #063D2D` (beyaz 8:1); seçili karo `#F5F5F7` üstünde `#0A6E52`, ikon karosu `#D3EEE0` |
| Seçili sekme (açık nane) | `#DDF5EA` üstünde `#0A6E52` (5.4:1) | `#10301F` üstünde `#34D399` |
| Derin yeşil (bağlantı, olumlu, odak halkası) | `#0A6E52`, yumuşak `#DDF5EA` | açık ev yeşili `#34D399` (kartta 8.9:1), yumuşak `#10301F`; odak halkası bir ton açık `#8FF0C0` |
| Dolu masa | yeşil degrade `#0E7A5A → #086348 → #05432F`, beyaz yazı | aynı |
| Zamanı daralan (ahududu) | `#C8175D` zemin `#FCE4EE` | `#FF8CC0` zemin `#3D1529` |
| Mavi (hazırlanıyor, bilgi) | `#2459E0` zemin `#E6EEFF` | `#8CB4FF` zemin `#162544` |
| Mor (online sipariş) | `#6D28D9` zemin `#F1EAFF` | `#C9B8FF` zemin `#291F45` |
| Turuncu (uyarı, gecikme) / kırmızı (hata, iptal) | `#B45309` / `#C81E1E` | kehribar `#F7B93E` zemin `#33250B` / mercan `#FF7B72` zemin `#3D1A1B`; artış ve başarı yeşil `#4ADE80` zemin `#12301C` |
| Grafik | vurgulu sütun ev yeşili `#0A6E52`, öteki sütunlar açık nane `#BFE8D4`, değer hapı ev yeşili üstünde beyaz | `#34D399` / `#1F4034` |
| Pirinç (ödül) | dolgu `#F2C94C` üstünde `#2E2113`, metin `#765923` | dolgu aynı, metin `#F2C94C` |
| Bant (Araçlar, bildirim) | `#0B100E` + yeşil hâle | `#0A0A0B`, hâle kısık |
| Marka karosu (uygulama ikonu) | `radial-gradient(#23876A → #1D6D56 → #0C3B2D)`, krem `#FBF6F1`, pirinç `#E8C877` | aynı |

- **Panonun rengi ev yeşili:** panonun mavisi (ray, seçili sekme, ana düğme, segment, değer hapı, grafik) LafPOS'ta ev
  yeşilidir; açık mavi tonlar açık nane. Bütün çiftler iki temada AA (`tests/design-tokens.test.ts`).
- Değer adları `--admin-*` (`:root` açık, `.dark` koyu); ortak adlar (`--bg`, `--ink`, `--primary`, `--focus`...) onlara
  çözülür; panonun adları: `--rail*`, `--card-line`, `--card-shadow`, `--chart-soft`. Tailwind anlam
  adları iki temada doğru tonu verir: `text-signal-ink`, `bg-signal-soft`, `text-blue-ink`, `bg-warning-soft`... Ham
  ölçekler (`danger-600`, `success-600`...) koyuda değişmez; yalnız beyaz yazılı dolu yüzeyde kalır, `tests/ui-rules.test.ts`
  izinli listeyle tutar.
- **Koyu tema: gece** (sahibin isteği, 22 Kasım 2026: bordo geceyi beğenmedi, "daha estetik, farklı"; örneği telefonun
  koyu gruplanmış listesi). Nötr ve sakin: renk yalnız anlam taşıyan yerde. Kurallar:
  - **Ton merdiveni (renksiz gri):** zemin `--admin-bg` siyah `#000000` → kart `--admin-surface` `#1C1C1E` → kart içi alan
    `--admin-surface-2` `#232325` → kuyu `--admin-panel` `#2A2A2C`; yüzen yüzey `--surface-raised` `#2C2C2E`. Gölge yok.
    Zemindeki kart (pano, bar ekranı) **kenarsız**: siyahtan yalnız tonla ayrılır (`--card-line` şeffaf); yüzey üstündeki
    kart ve alan ince nötr saç teliyle (`--admin-border` `#38383A`). Satır ayracı aynı ince çizgi.
  - **Metin** kırık beyaz `--admin-text` `#F5F5F7`; ikincil `#D1D1D6`, soluk `#9E9EA4` (yüzen yüzeyde de 5:1).
  - **Kimlik ev yeşili** (açık temayla aynı ton; bordo yok): marka rayı ve dolu masa yeşil degradede, ana eylem dolgusu
    (Öde, Kaydet, Tezgâh satışı, barın "Hepsi hazır"ı) `--admin-ink-fill` `#0A8560` üstünde beyaz; bağlantı, seçim ve grafik
    açık ev yeşili `--admin-primary` `#34D399`. İnce üç renk ayraç (yeşil, beyaz, mercan) yalnız müşteri ekranında, marka
    ayrıntısı olarak.
  - **Durum renkleri canlı, zeminleri yumuşak hap:** artış ve başarı yeşil `#4ADE80` (zemin `#12301C`), düşüş ve tehlike
    mercan `#FF7B72` (zemin `#3D1A1B`), uyarı kehribar `#F7B93E`, bilgi mavi `#6CC8FF`, zamanı daralan ahududu `#FF8CC0`.
    Yön ve durum hep ok, işaret ya da yazıyla birlikte; renk tek başına taşımaz.
  - Deneme şeridi gecede nötr yüzeyde durur (bilgi rengi yalnız küçük noktada); bandın yeşil hâlesi kısık.
  - Bileşen sabit renk yazmaz; her şey `.dark` belirteçlerinden. Müşteri ekranının "gece" paleti aynı değerlerde. Bar
    ekranı, çağrı ekranı, Uzaktan ve Merkez aynı belirteçleri okur.
  - Ölçü `tests/koyu-tema.test.ts`: zemin ve yüzeyler renksiz (kanal farkı en çok 3/255), her metin ve durum rengi her
    yüzeyde 4.5:1, rozet yazısı kendi zemininde 4.5:1, eylem dolgusu, alan kenarı ve odak halkası her yüzeyde 3:1; yeşilin
    açık temanın tonunda olduğu ve hiçbir koyu belirtecin bordo olmadığı da denetlenir. Açık tema değişmez.
- **Odak halkası** 2 px ev yeşili, 2 px dışarıda; rayda beyaz, bantta açık yeşil. Alan odakta ev yeşili kenar ve 3 px
  açık nane hâle.

### Biçim

- **Köşeler** (panonun merdiveni, 20 Kasım 2026'da bir boy sıkı; operatör: "radiusu biraz azalt"): ray ve pencere 22
  (`--r-stage`), yaprak, kart, üst çubuk ve cam çubuk 18 (`--r-leaf`, `--r-card`, `--r-glass`), kart içindeki karo ve ürün
  karosu 12 (`--r-tile`), alan ve düğme 10 (`--r-control`, `--r-btn`), rozet ve süzgeç çipi 6 (`--r-chip`); Tailwind'in
  `rounded-lg/xl/2xl/3xl`'i 8/10/14/18. Segment, adet seçici ve iz hap. Sütun grafiğinin üst köşesi 6, yatay çubuk hap.
  `.surface-soft` müşteri ekranının yönetimdeki önizlemesinde aynı merdiveni çizer. Patron panelinin gruplanmış liste
  kartı rayın köşesinde (`--r-group` 22): geniş köşe, ferah iç boşluk.
- **Gölge** ev yeşilinin gecesi (`#0F231C`): zeminde yüzen kart `--shadow-card` (1 px ve 28 px yumuşak), yaprak
  `--shadow-leaf`, açılan ve yüzen parça (pencere, menü) `--shadow-pop`. Koyuda kart gölgesiz; ayrımı nötr ton merdiveni
  yapar (zemindeki kart kenarsız).
- **Boşluk:** 4'ün katları; kabuk payı 12, kartlar arası 16, kart iç payı 20, sahnede başlık satırıyla yaprak arası 16.
- **Hareket:** üzerine gelme 160 ms, durum 280 ms, açılış 620-1000 ms; hep `--ease-out` (0.16, 1, 0.3, 1). Basılı ölçek
  0.97; kart üstüne gelince 2 px kalkar; ok halkası üstüne gelince ve odakta 45° döner.

### Çizimler

laffogato'nun çizimleri (`public/illustrations/`, docs/BRAND.md §6.1: düz dolgu, 2 px espresso kontur, altı renk,
yazısız) `src/assets/illustrations/`'ta; `EmptyState art=` ya da `<Illustration>` basar (`alt=""`, anlamı başlık taşır;
koyu temada porselen bir disk üstünde). Eşleme: fiş (açık sipariş yok), boş fincan tabağı (sonuçsuz arama), boş kek
standı (kategoride ürün yok), fincan (adisyon boş), espresso (bekleyen fiş yok), çalar saat (hazırlanan kalem yok), bilet
(rezervasyon yok), kupon (müşteri yok), kapı (gün açılmadı), affogato (bugün satış yok), kalp (her şey yolunda).

## 3. Kasa ekranları (masalar, adisyon, bar, kasa, patron)

- **Kabuk** (`src/components/AppShell.tsx`; panonun kabuğu, "menüsüne kadar 1:1"): tablette ve bilgisayarda (md+)
  solda **tam boy marka rayı** (`.lp-rail`, 84 / 100 px, köşe 22, ev yeşilinin degradesi; başında L'Af karosu, ana
  ekrana götürür), sağ sütunda 64 px **üst çubuk**: **ortada ekranın sekmeleri** (sayfanın `Stage menu`'sü buraya
  taşınır: Masalar'ın bölümleri, Siparişler'in görünümleri, Kasa'nın günleri; panonun ortalı sekmeleri, seçili açık
  nane zeminde yeşil), sağda durum (canlı nokta, saat, Z; dokununca kasa; kopunca kırmızı, gün kapalıyken amber hap),
  arama (⌘K) ve kişinin düğmesi (avatar ve aşağı ok; kişinin menüsünü açar). **Üst çubuk yalnız ekranın sekmeleri
  varken görünür** (sahibin isteği, 21 Kas 2026): sekmesiz ekranda (yönetim, raporlar, patron) kalkar, içerik yukarı
  yayılır; durum (nokta ve saat, dokununca kasa), internet rozeti ve genişte arama rayın dibinde tek satırda, kişinin
  menüsü raydaki Araçlar'da. **Kayma yok** (sahibin isteği, 22 Kas 2026): üst çubuk ve uyarı şeritleri (platform
  siparişi, site zili, deneme, lisans) yalnız sağ sütunda açılıp kapanır, ray hiçbir ekranda ve hiçbir uyarıda yerinden
  oynamaz (e2e taraması her ekranda rayın yerini karşılaştırır); çubuğun açılıp kapanması çizimden önce belirlenir
  (`TopTabsClaim`); seçili sekmenin kalın yazısı genişliği önceden ayırır (`data-text`); yaprakta `scrollbar-gutter:
  stable`. Rayda her ekran ikon üstte kısa ad altta (`NavItem.label`), satır 56 px (alçak ekranda 52 ve 44); seçili
  ekran beyaz karoda, ikonu açık nane karede yeşil, adı yeşil ve kalın (panonun seçili rayı); menüde olmayan ekranın
  yeri de seçili görünür (adisyonun geldiği ekran, Eğitim cihazında Kasa; `data-on`). Dipte ince çizginin altında
  **Araçlar** (kişinin menüsü: tema, tam ekran, ekranlar) ve **Kilitle** (oturumu kapatır; uzaktan görünümde Çıkış).
  Ray sığmazsa kendi içinde kayar, dip yerinde kalır. Telefonda ray yok: üst şerit (karo, ekranın adı, arama,
  bağlantı ve gün, kişi) ve alt sekme çubuğu (etkin sekmenin ikonu açık nane hapta, yeşil). Platform siparişi onay
  bekliyorsa üst çubuğun altında ahududu hap şerit.
- **Araçlar çekmecesi** (`src/components/ToolsDrawer.tsx`): tam ekran gece zemini, üstte yumuşak yeşil ışık, yukarıdan
  perde gibi iner; satırlar ölçülü (18 px yarı kalın, 56 px), sırayla gelir, üstüne gelince ve etkin ekranda küçük ok
  halkası belirir. İki grup: Ekranlar; Bu cihaz ve oturum (Ekranı kilitle, tema Açık / Koyu / Cihaz ya da bar teması,
  tam ekran, uzaktan çıkış). Raydaki Araçlar, üst çubuktaki kişinin düğmesi ve telefonda avatar ile "Daha" açar.
- **Sahne** (`src/components/ui/Stage.tsx`; panonun içerik alanı): zeminin üstünde **başlık satırı** (panonun "Welcome
  back, Alex" satırı): solda başlık (Inter 700, 28-32 px) ve tek cümle durum, sağda büyük sayılar (`Hero`: küçük beyaz
  kartlar, köşe 12, etiket üstte soluk, sayı kalın) ve eylemler (önce ikincil, en sağda ana eylem). Altında içeriğin
  kendi içinde kaydığı **beyaz yaprak** (köşe 18) ve geniş ekranda (lg) sağda **ikinci dizin kartı** (`aside`: Masalar'da
  masasız siparişler ve bugünkü rezervasyonlar). `float` yaprak zeminsizdir: kartlar zeminde yüzer (patron paneli,
  yönetim, raporlar). Telefonda başlığı üst şerit yazar (sahnedeki yalnız ekran okuyucuda), durum cümlesi, sayılar ve
  eylemler alt alta, sekmeler başlığın altında yatay hap şeridi. Sayfanın `PageHeader`'ı başlık satırına, eylemleri
  eylemlerin yerine taşınır (portal). Yönetimde (`headerInLeaf`) başlık yaprağın başında, solda beyaz **alt menü kartı**.
- **Sekmeler** (`.lp-menu`, `.lp-menu-item`): satır ikon, ad ve sağda soluk sayı; köşe 10; üstüne gelince çok açık gri,
  seçili açık nane zeminde yeşil yazı, ikon ve sayı (5.4:1), kalın; kenar, gölge, renk geçişi yok. Üst çubukta 40 px
  (dokunmatikte 44), alt menü kartında (`.lp-subnav`) alt alta (satır 38 px, grup başlığı 12 px soluk). Üst çubuğun
  sekmesi, telefonun sekme şeridi, yönetimin alt menüsü ve adisyonun kategorileri aynı bileşendir (§5 "Yerleşim ve
  ızgara").
- **Durum renkleri:** masa boş kesikli kenarlı açık kart, dolu L'Affogato yeşilinin degradesinde beyaz yazılı kart (iki
  temada), hesap istendi soldaki ahududu şerit ve "Hesap" hapı, kısmen ödendi altta beyaz ilerleme çubuğu ve "₺X kaldı";
  hazır kalem beyaz hapta nabızlı; online (siteden gelen) sipariş her
  ekranda mor. Bar ekranında kalem bekliyor nötr (gri halka), hazırlanıyor mavi, hazır yeşil, teslim edildi gri (yazıyla
  "Teslim edildi"); amber yalnız zamanı söyler (ayardaki dakikayı geçen fişin süre rozeti, planlı saat), kırmızı alarm ve
  iptal.
- **Masalar:** başlık satırında "Masalar" ve tarihli durum cümlesi; sağda büyük sayılar (dolu masa, hesap istendi
  ahududu, açık hesap) ve eylemler (Gel-al, Paket, ana eylem Tezgâh satışı); bölümler üst çubuğun ortasında (dolu
  sayısıyla). Yaprakta bölümün adı, görünüm (plan / liste) ve plan: kabın hem enine hem boyuna sığar (16:10). Geniş
  ekranda sağdaki kartta masasız siparişler ve bugünkü rezervasyonlar, darda yaprağın altında. Masa kartı köşe 18, ad
  kalın, tutar kartın en büyük yazısı (26/700), altında süre ve garson; bara gitmiş ve hazır kalemler küçük hap, hazır
  olan yeşil ve nabızlı.
- **Adisyon** (20 Kasım 2026, operatör: "espresso based vs. kısmı da ekteki gibi olabilir, componentleri bir yap"):
  geniş ekranda (xl) solda **alt menü kartı**, yönetimin alt menüsüyle aynı bileşen (`.lp-subnav`, `.lp-menu-col`,
  genişlik `--side-w` 240): "Kategoriler" grup başlığı küçük ve soluk, kategoriler alt alta 38 px satırlarda
  (dokunmatikte 44); her satırda adından eşlenen **tek renk ikon** (16 px; `src/lib/categoryIcon.ts`: matcha yaprak,
  espresso ve sıcak fincan, soğuk kahve ve frappe pipetli bardak, smoothie narenciye, frozen kar tanesi, tatlı pasta
  dilimi, atıştırmalık sandviç, karaoke mikrofon, ekstra artı…; eşleşmeyende etiket; sık kullanılanlar yıldız), ad ve
  sağda soluk ürün sayısı. Seçili kategori açık nane zeminde yeşil ve kalın. Tablette ve telefonda aynı satırlar yatay
  **sekme şeridinde** (üst çubuğun sekmeleri gibi; seçili sekme görünür alana kayar, şeridin sağı solarak biter).
  Renkli karo, dolu yeşil seçim ve gölgeli hap çip kalktı.
- **Satış ekranı sade** (20 Kasım 2026, operatör: "satış kısmını minimalist, güzel, temiz bir yapıda sun"): ortada arama
  (beyaz, saç teli, gölgesiz, "/" kısayolu) ve ürün **karoları**: beyaz, köşe 12, saç teli çerçeve; gölge, kalkma, süs
  şerit ve ekle dairesi yok (kartın tamamı ekler). Ad 14.5/600 iki satır, tek boyluda fiyat dipte (15/600); seçenekli
  üründe sağ üstte zeminsiz soluk seçenek simgesi (44 px dokunma alanı); iki boyluda kartın dibinde ikiye bölünmüş sade
  şerit (saç teli, ortada ayraç; boy adı soluk, fiyat mürekkep; dokununca açık nane). Durum yalnız yazıyla (Tükendi
  kırmızı, Son N amber). Sağda hesap yaprağı: masanın adı (24-28/700) ve künye; gönderilmemişler öteki gruplarla aynı
  sade başlıkta (amber yalnız noktada; amber zemin, başlık çipi ve toplamın altındaki uyarı satırı kalktı: durumu grup
  başlığı ve "Bara gönder (N)" söyler); satırda sade adet seçici (ince çerçeveli boş daireler, çöp soluk), satırın
  kendisi düzenlemeye açar; seçenekler soluk tek satır. Toplam 32 px, gönderilmemiş varken etiketi "Toplam · tahmini".
  Altta tek saç teliyle ayrılan blok: hızlı işlemler (48 px), ikincil "Bara gönder (N)" ve tek ana eylem "Öde · ₺X" ev
  yeşili ve ok halkası.
- **Bar ekranı ve "Bara gönder" ayarı** (Yönetim › Ayarlar, varsayılan açık; operatör 20 Kas 2026): kapalıyken kalem
  hiçbir istasyona gitmez (istasyonsuz yazılır, teslim sayılır), adisyonda "Bara gönder (N)" yerine "Kaydet (N)" (onay
  ikonu), Bar rayda, telefon sekmelerinde ve komut paletinde yok; adres elle açılırsa "Bar ekranı kapalı" notu.
- **Patron paneli** (sahibin örneği, 22 Kasım 2026: telefonun gruplanmış listesi; `src/pages/patron`). En üstte
  **bugünün cirosu** kartsız, zeminde, ekranın en büyük öğesi (Inter kalın, tablo rakamı; ₺ işareti ve kuruş soluk; boyu
  kabın enine göre, telefonda "₺357" ekranın yarısını doldurur); altında küçük satır "KDV dahil · N adisyon · ortalama ₺X"
  ve canlılık (nokta ve yazı: "Gün açık · az önce", "3 dk önce", eskiyse "son güncelleme 11:41"). Hemen altında **Kıyas**
  kartı: başlık satırı solda "Kıyas · 11:40 itibarıyla" (gün kapandıysa "Kıyas · gün sonu"), sağda soluk canlılık; ince
  ayraçlı satırlar "Dün", "Geçen hafta bugün", "Geçen ay bugün": solda soluk etiket, sağda yarı kalın tutar (aynı saate
  kadar) ve **değişim hapı** (tam yuvarlak, yumuşak zemin; düşüş ok aşağı ve "%63,4", artış ok yukarı ve "+%83,1"). O gün
  satış yoksa "satış yok", veri yoksa "veri yok", yalnız gün sonu toplamı biliniyorsa tutarın yanında "gün sonu". Satıra
  dokununca ayrıntı açılır (tarih ve gün adı, gün sonu toplamı, adisyon, ₺ fark). Öteki kartlar aynı dilde (`Group`,
  `Row`): Gün boyu (birikimli, saatlik ya da tablo; sakin yazı sekmeleri), Gün içi (açık adisyon, indirim ve ikram, iptal,
  yazarkasadan geçmeyen, online, masadaki kişi), Ödeme türleri (Kasa ve Raporlar), Hafta ve ay (gün sonu tahminiyle), Açık adisyonlar, Dikkat
  isteyenler, En çok satanlar. Kart başına tek başlık satırı; ikon karosu, tekrar eden kenarlık ve gölge yok (gecede kart
  kenarsız, açık temada panonun saç teli ve yumuşak gölgesi). Yerleşim `.lp-patron`: telefonda ve dik tablette tek sütun
  (ciro, kıyas, grafik, gün içi, ödemeler, hafta ve ay, sonra listeler), 1024'ten iki, 1440'tan üç sütun. Kıyasın verisi
  üç yoldan gelir (`shared/today-stats.ts` `StatsSource`): kasa, eski kasada bulutun gün raporları, ikisi de yoksa özetin
  iki rakamı.
- **Kasa, Siparişler, Rezervasyon, Müşteriler, Eğitim cihazı:** aynı sahne; görünüm sekmeleri (Bugün / Geçmiş günler;
  Açık / Online / Paket ve gel-al / Kapanan) üst çubuğun ortasında, içerik yaprakta; Müşteriler iki yaprak (liste, kayıt).
- **Bar ekranı:** sahnede üstte cam çubuk (karo, "Bar ve mutfak", sekmeler, araçlar), altında sayaç şeridi (34 px rakam)
  ve fiş ızgarası.
- **Yaprağın içindeki kartlar** saç teli kenarlı ve gölgesizdir, zemindekiler de saç teli çerçeveli ve çok hafif gölgeli
  (`--card-line`, `--card-shadow`); seçili kartın kenarı ev yeşili.
- **Logo:** L'Af, laffogato.net ve uygulama ikonuyla aynı vektör (`src/components/LafMark.tsx`); karoda (`LafTile`)
  uygulama ikonunun kendisi. Yazı tipine bağlı değil, Didot'u olmayan Windows ve Android'de de aynı. Karo uygulama
  ikonunun oranında: logo karonun yüksekliğinin yarısı, köşe kenarın %22'si (arayüzün köşe ölçeğinden bağımsız; `TILE`,
  `src/components/LafMark.tsx`).
- **Giriş ekranı** (pano): açık gri zeminde solda ev yeşilinin degradesinde **marka kartı** (köşe 22; L'Af karosu,
  işletmenin adı, 112 px saat, tarih ve ekip), sağda beyaz PIN kartı (köşe 22, yumuşak gölge): "Hoş geldiniz", PIN
  noktaları, açık gri yumuşak tuşlar (köşe 18, kalın rakam) ve ev yeşili "Giriş" tuşu ok halkasıyla. Telefonda marka ve
  saat kartın üstünde yeşil şerit. Kilit ekranında yalnız oturum açılır (mesai 4 Kasım 2026'da kaldırıldı).
- **Ödeme penceresi** üç yol: Tutar (nakit ya da kart, para üstü), Kalem (seçili kalemler), Paylaş. Paylaş'ta önce
  "Kaç kişiye bölünsün?": 2, 3, 4, 5, 6 büyük çipler (56 px, kalın rakam) tek dokunuşla böler, daha kalabalık masa
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
  solda kategorilerin alt menü kartı (sayılarıyla), darda aynı sekmeler şeritte; kartta sitedeki görsel ya da kategori renginde baş
  harf, ad, fiyat, iki boylu üründe boy düğmeleri, tükendi soluk ve rozetli. Hesap bir bakışta okunur:
  - **Başlık:** masa adı (22/700) ve numara; künye (kişi, garson, açılış saati ve süresi, müşteri, not); durum
    çipleri (Kapandı, İptal, Birleşti; Hesap yazdırıldı amber, Kısmen ödendi pembe, "3 kişiye bölündü", "2 ürün
    gönderilmedi").
  - **Kalemler duruma göre gruplu** (`src/pages/order/cartGroups.ts`): Gönderilmedi (amber, cihazdaki sepet, en üstte),
    Barda (kobalt nokta; bekliyor mu hazırlanıyor mu kalemde yazar), Hazır (yeşil), Teslim (nötr; bara gitmeyen kalem
    de), İptal edilenler (kırmızı). Grup başlığı yapışkan, sayısıyla. Her kalemde adet hapı, ad ve boy, seçenek çipleri,
    not ve sağa hizalı kalın tutar.
  - **Kalem işlemleri kalemden tek dokunuşta:** İkram et, Ödenmez yaz (kişi seçilir), Zayi yaz, Kaleme indirim, Taşı
    (taşıma penceresi kalem seçili açılır), Not ekle (bar fişi canlı görür, `PUT /orders/:id/items/:itemId/note`), en
    altta kırmızı İptal et.
  - **Toplam** 28/700; altında hızlı işlemler sakin bir sırada, ikon ve kısa ad: Böl, İndirim, Taşı, Hesap
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
    karşılama (L'Af, 800 ağırlıkta başlık, bayrak çizgisi, slogan; dönen duyurular, karekod, saat), adisyon açıkken
    kalemler ve markanın yüzeyinde büyük tutar, ödemeden sonra teşekkür (self serviste çağrı numarası; uzun kimlik,
    "Masa WWWWWW", ekranla küçülen yazı ve kırılan kelimeyle telefonda da taşmaz). **Değiştirilebilir:** Yönetim ›
    Müşteri ekranı'ndan tema (gece, porselen, ev yeşili), karşılama başlığı ve alt satırı, teşekkür başlığı, en çok 6
    duyuru, karekod adresi ve yazısı, saat ve seçenekler; sağda gerçek ekranın canlı önizlemesi (aynı bileşen,
    `CustomerDisplayView`). Ayar sunucuda (`customerDisplay`), ekran oturumsuz okur (`GET /api/public/display-config`,
    yarım dakikada bir; son görünüm cihazda saklanır). `?tema=acik` porselen açar (eski kurulum adresleri).
  - **Çağrı ekranı** `/cagri`: Hazırlanıyor ve büyük numaralı Hazır; platformun gel-al siparişinde platformun kodu ve adı.
  İkisi de ilk karesinden koyu açılır (gece loş salonda en parlak yüzey olmasın).
- **Grafik** (pano): tek seri; sütunlar açık nane, tek vurgulu sütun ev yeşili (en yüksek değer ya da sayfanın seçtiği;
  tepesinde beyaz nokta ve üstünde ev yeşili değer hapı; üzerine gelinen sütun vurguyu alır), sütun en çok 36 px, üst
  köşe 6; kıyas serisi gri çizgi, tek eksen; tutar ekseninde kesirli
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

- **Yerleşim** (`src/components/admin/AdminShell.tsx`): kabuğun rayında "Yönetim" seçili; sahnede geniş ekranda (lg)
  solda beyaz **alt menü kartı** (köşe 18, zeminde yüzer): grup başlıkları küçük ve soluk (Genel, Menü, Salon ve kasa,
  Ekip, Bağlantılar, Sistem), altında bölümler ikon ve adlarıyla; seçili satır açık nane zeminde yeşil; sayaç yalnız iş
  bekleyen yerde (tükenen ürün, gönderilemeyen gün), ne saydığı ipucunda ve ekran okuyucuda; dipte "Kasa ekranlarına
  dön" ve "Sıkı görünüm". Sağda pano yaprağı (`float`): sayfanın başlığı zeminin üstünde (30/700, çizgisiz), açıklaması ve
  eylemleri (sağda önce ikincil sonra ana eylem), altında zeminde yüzen kartlar (`Stage headerInLeaf`). Tablette alt
  menü yatay kayan hap şeridi, telefonda kabuğun kendi üst şeridi (geri, bölümün adı, arama, bağlantı, kişi) ve
  `/yonetim`'de gruplu bölüm listesi.
- **Tablolar:** yalnız başlık ve satır çizgileri (başlık şeridi zeminsiz, `--table-head-bg`), rakam sağa hizalı ve
  tablo rakamı (`tabular-nums`); kitin `DataTable`'ı, raporların `ReportTable`'ı ve roller matrisi aynı başlığı çizer; seçili
  satır solda 3 px mürekkep çizgi.
- **Kasa ekranının önizlemesi:** yönetimdeki birebir önizleme (Yönetim › Müşteri ekranı) `.surface-soft` ile kasa
  köşelerinde kalır (@theme köşeleri ve `:root`'un `--r-*` değerleri); gerçek ekranla aynı görünür.
- **KPI şeridi** (pano): her hücre kendi kartı (`KpiStrip`, köşe 18, aralarında 12 px), solda yumuşak tonlu ikon karosu ve
  etiket, rakam 34 px kalın sıkı, değişim rozeti (köşe 8) rakamın sağında; seçili hücre ev yeşili kenarlı.
- **Bileşenler** (`src/components/admin/ui.tsx`): `PageHeader` (yaprağın başında zeminin üstünde; `headerInLeaf` değilse başlık
  satırına taşınır), `Card` (köşe 18, saç teli çerçeve; zeminde çok hafif gölge; başlık 16/600, alt
  satır 13 px), `KpiStrip`, `StatusTabs` (beyaz çipler, köşe 8, seçili ev yeşili dolgu), `Segmented` (kitin `.seg`'i: açık gri hap ray, ince kenar, seçili ev yeşili hap; telefonda tam
  genişlikte satıra kırılır; radyo grubu klavyesi), `DataTable`, `ActionMenu` (⋯, köşe 14, portalda), `QuickLook` (sağdan
  hızlı bakış, köşe 22, telefonda alt sayfa), `ActionRows`, `Timeline`, `Badge`, `EmptyState`, `SearchField`. Düğme köşe 10;
  dokunmatikte 44, farede 36, sıkı görünümde 32 px.
- **Sayfalar:** Genel bakış (KPI şeridi: net ciro geçen haftanın aynı günü aynı saatine göre, adisyon,
  açık adisyon, indirim ve ikram, online sipariş; saatlik grafik; en çok satanlar; dikkat isteyenler;
  sistem sağlığı), Ürünler, Seçenekler, Masa planı, Ödeme türleri, Personel ve yetki, Yazarkasa, Site
  ve lafmaliyet, Ağ ve uzaktan erişim (yerel adres ve Tailscale karekodu), Ayarlar, Denetim kaydı (zaman çizelgesi),
  Raporlar (dönem segmenti, rapor sekmeleri, önceki dönemle KPI şeridi).

### LafPOS'un eklemeleri (Innex ve Area Board kitine göre)

1. **Koyu tema:** aynı roller nötr gece değerleriyle (§2 "Koyu tema: gece"), her çift AA'da test ediliyor.
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

- **Düğme** (`src/components/ui/Button.tsx`; panonun düğmesi): köşe 10 (`--r-btn`). `primary` ve `ink` ekranın tek ana
  eylemi: ev yeşili dolgu, beyaz kalın yazı, sağında açık nane **ok halkası** (`Ring`, `.lp-ring`; üstüne gelince ve
  odakta ok 45° döner, devre dışıyken gri); geniş ana düğmede yazı solda, halka sağda. Ana eylemde baştaki ikon yok.
  `soft` açık nane zeminde yeşil yazı (panonun "Receive" düğmesi), `secondary` beyaz ve ince kenar (üstüne gelince
  mürekkep kenar), `ghost` kenarsız, `success` dolu yeşil (bar ekranında "Hepsi hazır"),
  `danger*` kırmızı. Kapat düğmesi yumuşak gri daire (panonun ikon dairesi). Kare ikon düğmesinde halka yok.
  Gölgeler: ana eylem ev yeşili yumuşak gölge (`--shadow-action`), ikincil, alan ve çip çok hafif gölge
  (`--shadow-control`); gecede ikisi de yok. İkincil düğmenin üstüne gelince zemin açık gri, kenar alanın kenarı. Ölçü merdiveni (fareyle /
  dokunmatikte): `sm` 32 / 44, `md` 40 / 44 (yönetimde fareyle 36), `lg` 44 / 48, `xl` 48 / 56; yazı 13, 14, 15, 16 px.
  Giriş alanı, açılır liste ve arama alanı düğmeyle aynı boyda (40 / 44; yönetimde fareyle 36), yazı fareyle 14 px.
- **Ölçek:** sayfa başlığı 28-32/700 ve 13 px açıklama (`PageHeader`), bölüm 16/700, kart başlığı 17/700, mikro
  etiket 12/500; kart arası 16 px. KPI karosu tek bileşen (`Stat`: 13 px etiket, 30 px kalın rakam, `strong` 40
  px, sıkı aralık); rakam yerine kelime yazılmaz ("—" ve ipucunda "Sayılmadı").
- **Durumlar:** her denetimin dinlenme, üzerine gelme, basılı (zemin bir ton koyu; dokunmatikte `hover`
  çalışmadığı için basılı renk ayrıca yazılır), odak (2 px birincil halka) ve devre dışı hali var. Devre dışı
  birincil düğme gri zemin ve soluk yazıdır, yarı saydam değil; bir bilgi cümlesi devre dışı düğme olarak
  çizilmez ("Ödemeyi kasa alır" düğmenin altında yazıdır).
- **Sekme ve seçim** (panonun dili: seçim ev yeşilidir): `Tabs` (bölüm, istasyon, sipariş listesi; seçili ev yeşili hap,
  sayı hapı sıfırsa gizli, dar ekranda yatay kayar: seçili sekme rayda görünür kalır, içeriğin gizlendiği kenar solar,
  `useRail`) ve `Segmented` (2-4 eşit seçenek; açık gri hap ray, ince kenar, seçili ev yeşili hap). Seçim çipi `Chip`
  (`src/components/ui/Field.tsx`; hap, `aria-pressed`): beyaz, ince kenar, seçili ev yeşili dolgu; hazır neden ve süre
  seçiminde (`tone="ink"`) ayrıca tik. Dolu yeşil hap yalnız olumlu durumdur (hazır, ödendi); amber durum rengidir,
  seçim için kullanılmaz; bağlantı ev yeşili, kobalt yalnız durum. Adet ve kişi sayısı `Stepper` ile: hap grup, yuvarlak
  eksi ve artı, değer; en küçük adette Kaldır; tek değerli pencerede `size="lg"`. Tuş takımı (`Numpad`): açık gri yumuşak tuşlar
  (köşe 18, kalın rakam), onay tuşu ev yeşili ve ok halkalı.
- **Boş, yükleniyor, hata:** `EmptyState` (kart içinde `compact`, sayfada varsayılan, bar ve çağrı ekranında
  `large`; başlık ekranın sözüyle, "Liste boş" değil), `Skeleton` / `ListSkeleton` (ilk yüklemede), `ErrorState`
  (boş durumla aynı ölçek ve üç boy: kart içinde `compact`, sayfada varsayılan, tam ekranda ve bar ekranında `large`;
  yeniden dene ile). Yüklenirken ya da hata varken "yok" yazılmaz.
- **Onay ve metin isteme:** tarayıcının `confirm()` / `prompt()` pencereleri yok; `confirmDialog` /
  `promptDialog` (`src/components/ui/Confirm.tsx`) eylemi adlandıran düğmeyle, yıkıcı eylemde kırmızı. Para ya da
  kayıt değiştiren her düğme istek sürerken kilitlidir (`loading`), ikinci dokunuş gitmez. Pencere ve hızlı bakış
  çekmecesi köşe 22, kenarsız, derin yumuşak gölge (gecede saç teli); başlık 20/700, Kapat
  (yumuşak gri daire) başlığın ilk satırında; pencerede başlık kesilmez, hızlı bakış çekmecesinde en çok iki satır. Onay ve
  metin isteme penceresinde Kapat yok (Vazgeç aynı işi yapar, Escape ve arka plan da vazgeçer).
- **Tutar girişi:** ekrandaki tuş takımı (`Numpad`) fiziksel klavyeyle de çalışır: rakam, `,` ve sayısal
  takımın ondalığı virgül; ana sıradaki `.` ardından üç rakam gelirse binlik ayıracı ("2.000"), değilse ondalık
  ("45.90" = 45,90 TL); Enter onaylar, odaktaki tuşa yeniden basmaz. Önceden dolu tutarın üstüne ilk tuş yazar.
  Kalandan fazlası sessizce kırpılmaz, alan uyarır. Tümünü silen tuş "Temizle", tek rakamı ⌫ siler.
- **Alan:** kısa ipucu (16 karaktere kadar: "zorunlu", "5–120") etiketin sağında; uzunu alanın altında yardım metni ve
  alanın açıklaması (`aria-describedby`); etiket satırı tek satır kalır (13/600 mürekkep), iki sütunlu formda alanlar
  hizalı. Köşe 12 (arama alanı da), çok hafif gölge. Odakta ev yeşili kenar ve 3 px açık nane hâle, hatada kırmızı kenar,
  açık kırmızı hâle ve ileti alanın altında (`Field`, `src/components/ui/Field.tsx`). Aramanın temizle düğmesi küçük gri
  dairede çarpı. **Anahtar** (`Toggle`): açıkken ev yeşili ve beyaz topta küçük tik, kapalıyken gri (3:1).
  **Adet seçici** (`Stepper`): açık gri hap ray, içinde beyaz yuvarlak eksi ve artı.
- **Bildirim:** mürekkep zeminli kart (köşe 16); dört tonda da (başarı, bilgi, uyarı, hata) durum rengi yalnız ikonda,
  ikon yarı saydam dairede, bilgi renksiz; eylem ("Geri al") küçük yumuşak düğme; koyu temada yüzen yüzey. Telefonda alt sekme çubuğunun üstünde, ev çubuğu payıyla; alt eylem şeridi olan
  ekranda (`data-action-bar`: adisyonun Gönder / Ödeme şeridi) şeridin de üstünde. Tablet ve bilgisayarda üst ortada.
  "Geri al" gibi tek eylem taşıyabilir, eylem bir kez çalışır; hata ve uyarı hemen okunur ve daha uzun kalır.
- **Sınıflar:** `cn()` (`src/lib/cn.ts`) çakışan Tailwind sınıflarını birleştirir, sonraki kazanır (`px-0`
  `px-3`'ü ezer). Yalnız aynı varyanttaki sınıflar birleşir: sayfanın `max-md:hidden` sınıfı kitin `max-sm:flex`
  sınıfını ezmez, ikisi de kalır ve derlenmiş CSS'te sonra gelen kazanır; kit bileşenini bir kırılımda gizlemek için ona
  sınıf vermeyin, `max-md:hidden` sınıflı bir kaba sarın. Geçiş yalnız değişen özelliklere, 150 ms; hareket azaltmada
  dekoratif hareket ve nabız durur.
- **Kaydedilmemiş değişiklik:** uzun ayar formu değişiklik varken altta yapışkan şerit (Vazgeç, Kaydet) gösterir;
  sekme kapanırken, uygulama içi geçişte ve geri tuşunda sorar (`src/lib/unsavedGuard.ts`).

### Bileşen turu (20 Kasım 2026, operatör: "bileşenleri ve elementleri tek tek daha estetik hale getir")

Panonun ölçüleriyle her parça tek tek elden geçti; davranış ve erişilebilirlik aynı (44 px, 3:1 kenar, AA metin).

- **Rozet:** köşe 8, 12 px yarı kalın, açık tonlu zemin ve aynı tonda çok ince iç kenar (panonun "+12,8%" rozeti).
- **Süzgeç sekmesi ve seçim çipi** (`StatusTabs`, `Chip`): köşe 10, beyaz ve çok hafif gölge; üstüne gelince açık gri zemin
  ve alanın kenarı; seçili ev yeşili dolgu ve yeşil yumuşak gölge. Kasanın `Tabs`'ı hap, seçili aynı dolgu ve gölge.
- **Boş durum ve hata:** ikon açık nane (hatada açık kırmızı) dairede, çevresinde daha açık bir hâle; çizimli boş durum
  aynı. Pano yaprağında tek başına duran boş durum ve hata kartta (`FLOAT_CARD`).
- **Uyarı kutusu** (`Notice`): ikon beyaz dairede, renk ikonda; zemin durumun yumuşak tonu.
- **Tablo** (`DataTable`): başlık 12,5 px soluk, satır 56 px; seçili satır açık nane ve solda 3 px ev yeşili çizgi;
  yapışkan eylem sütununun gölgesi yeşilin gecesi.
- **Açılır menü** (`ActionMenu`): köşe 14, her öğenin ikonu küçük yumuşak karede (tehlikelide açık kırmızı).
- **Hızlı işlem satırları** (`ActionRows`): açık gri kap, ince iç kenar, köşe 18.
- **Komut paleti:** köşe 18, kenarsız; büyüteç açık nane dairede; seçili satır açık nane zeminde yeşil, ikon karede.
- **Araçlar çekmecesi:** marka rayının ev yeşili degradesinde, sağ üstte nane ışığı; tema segmenti yarı saydam rayda.
- **Ödeme türleri** (`PaymentModal`): her tür kendi renginin açık tonunda karoda ikonuyla (nakit banknot, kart, yemek
  kartı çatal bıçak, havale banka, açık hesap defter); seçili tür açık nane zeminde, karo beyaz. Türler gruplu (operatör
  20 Kas 2026: "seçenekleri kolay bulacak şekilde"): önce sık kullanılan **Nakit ve Kart** iri (56 px, iki sütun), sonra
  **Yemek kartı** ve **Diğer** (havale, açık hesap) sıkı düğmelerde (44 px); boş grup çizilmez.
- **Ödeme penceresinin yerleşimi** (`.lp-pay`; operatör: "küçült, geniş yap"): pencere geniş ekranda 70rem ve üç sütun:
  tutar ve sıkı tuş takımı (44 px tuş, altında Tamamı ve Yarısı) | ödeme türleri, verilen ve bahşiş | yazarkasa, alınan
  ödemeler ve ciro dışı kapanış. Tablette iki sütun (sağda türlerin altında ek işler), telefonda tek sütun ve türler
  tutarın hemen altında (tuş takımından önce). Tutarın üstünde tek satır "Alınacak tutar · Kalan ₺X". Tablet ve
  bilgisayarda kaydırmadan sığar; ödeme düğmesi pencerenin alt şeridinde.
- **Masa kartı:** boş masa açık gri ve kesikli kenarlı; üstüne gelince düz ev yeşili kenar, beyaz zemin ve yumuşak gölge.
- **Sipariş ve rezervasyon kartı:** pano kartı (köşe 18, zeminde yüzer), üstüne gelince kalkar. Kasa, Siparişler ve
  Rezervasyon pano yaprağında (`float`): kartlar zeminde yüzer, eylem çubuğu zeminin üstünde.

### İskelet, çerçeve ve yazı ölçeği (20 Kasım 2026, operatör: "belli bir iskelet, çerçevelerle ayrım, yazı tiplerini aynı yap")

- **İskelet:** tablette ve bilgisayarda ekran üç çerçeveli bloktan oluşur, aralarında hep 12 px: üstte beyaz **üst çubuk**
  (ince kenar, köşe 18), solda yeşil **marka rayı** (köşe 22), sağda içerik. Platform şeridi üst çubukla içerik arasında
  aynı aralıkla, köşe 18. İçerikte başlık satırı zeminin üstünde, altında çerçeveli beyaz yaprak ya da çerçeveli kartlar.
- **Çerçeve:** bölgeler gölgeyle değil ince çerçeveyle ayrılır: yaprak, kart, büyük sayı kartı, ikinci dizin, menü ve
  alt menü kartı, ürün ve masa kartı 1 px saç teli (`--admin-border`), gölge yalnız çok hafif derinlik
  (`--shadow-card`, `--shadow-control`). Kart içindeki bölümler satır ayracıyla.
- **Yazı ölçeği (Inter, tek aile):** ekran başlığı 28 (geniş ekranda 30) / 700; pencere ve çekmece başlığı 20 / 700;
  bölüm başlığı (yaprağın başı) 18 / 700; kart başlığı 16 / 600, alt satırı 13 / 400 soluk; etiket 13 / 500 soluk; gövde
  14; mikro 12; büyük sayı kartı 22 / 700; KPI ve karo rakamı 30 / 700; marka ciro kartı 40 / 700. 800 ağırlık yalnız
  müşteri ekranında.
- **Salon ve masalar (sade):** yaprağın başında bölümün adı (18 / 700) ve yanında üç sayaç (toplam masa, ev yeşili
  noktalı dolu, boş); plan görünümünde masalar açık gri **noktalı salon zemininde** (20 px aralık, köşe 18, ince
  çerçeve): boş masa beyaz kart, ince düz çerçeve (kesikli değil), adı mürekkepte, altında kişi sayısı; dolu masa ev
  yeşili degrade; açıklama satırında kutucuklar masa kartının küçük kopyası.

### Yerleşim ve ızgara (20 Kasım 2026, operatör: "componentleri bir yap, belli yerlerde sabit olsun; layoutları gridleri de belirle")

- **Aralık belirteçleri** (`src/index.css`, `:root`; bileşen sayı yazmaz, adı okur): kabuk `--shell-gap` 12 (ray, üst
  çubuk, bildirim şeridi ve sahne arası, ekran kenarı); sahne `--grid-gap` 16 (sütunlar, başlık satırı ile gövde, pano
  kartları ve bölümler arası); kart ızgarası `--tile-gap` 12 (ürün, masa, sipariş ve KPI kartları arası). Kart içinde
  boşluk 16-20, satırlar arası 8-12.
- **Sabit sütunlar:** marka rayı solda (tablette 84, bilgisayarda 100 px); alt menü kartı `--side-w` 240 **hep solda**
  (yönetimin bölümleri, adisyonun kategorileri); sağ dizin kartı `--aside-w` 312 **hep sağda** (masasız siparişler,
  bugünkü rezervasyonlar); adisyonun hesabı `--cart-w` 320-440 **hep sağda**. Orta sütun kalan yeri alır
  (`minmax(0, 1fr)`); sabit sütun hiçbir ekranda yer değiştirmez, darda gizlenir ya da şeride döner.
- **Dört sayfa kalıbı** (başkası yok):
  1. **Pano** (`Stage float`): başlık satırı, altında zeminde yüzen kartlar; patron panelinde `.lp-patron` (telefonda ve
     dik tablette tek sütun, 1024'ten iki, 1440'tan üç). Patron, raporlar, siparişler, kasa, rezervasyonlar.
  2. **Liste** (`Stage` yaprak ve `aside`): başlık satırı, altında çerçeveli beyaz yaprak, geniş ekranda (lg) sağda
     ikinci dizin kartı. Masalar.
  3. **Alt menülü** (`Stage headerInLeaf`): iki sütunlu ızgara, solda alt menü kartı, sağda içerik (başlık içeriğin
     başında). Yönetim; tablette alt menü içeriğin üstünde sekme şeridi.
  4. **İş ekranı** (adisyon): solda kategorilerin alt menü kartı (xl), ortada arama, kategori şeridi (xl altında) ve
     ürün karoları, sağda hesap yaprağı. Bar ekranı tam en (`side={false}`).
- **Kart ızgaraları:** karo ızgarası `.lp-tiles` (ürün ve masa; en dar sütun `--tile-min` 140, masada 150) ve kart
  ızgarası `.lp-cards` (sipariş kartı; en dar sütun `--card-min` 280); ikisinde de aralık `--tile-gap`, satır içeriği
  kadar, sütun sayısını genişlik belirler (kaç sığarsa). KPI şeridi aynı aralıkla kendi ızgarasında (telefonda 2,
  tablette 2-3, geniş ekranda hücre sayısı kadar; iskeleti de ayrı kartlar).
- **Sabit yerler:** ekranlar arası gezinme yalnız marka rayında (telefonda alt sekme çubuğu; ray 768 px yüksekliğe
  kadar kaydırmadan sığar); ekranın sekmeleri üst çubuğun ortasında (telefonda başlığın altında şerit); bölüm ve kategori
  menüsü solda alt menü kartında (darda içeriğin üstünde aynı sekmeler şeritte); ana eylem başlık satırının en sağında,
  adisyonda hesabın dibinde; ikinci dizin sağda; bildirim şeridi üst çubuğun altında.
- **Tek menü bileşeni:** üst çubuğun sekmeleri, telefonun sekme şeridi, yönetimin alt menüsü ve adisyonun kategorileri
  aynı `.lp-menu-item` satırıdır: tek renk ikon (16 px), ad, sağda soluk sayı; üstüne gelince çok açık gri, seçili açık
  nane zeminde yeşil ve kalın. Alt alta dizilişte (`.lp-menu-col`) grup başlığı 12 px soluk ("Genel", "Kategoriler"),
  satır 38 px (dokunmatikte 44). Menüde renkli karo, dolu yeşil seçim ya da gölgeli hap çip kullanılmaz.

## 6. Telefon ve tablet (impeccable `adapt`)

- Kırılımlar: telefon `< 768`, tablet `768-1023`, bilgisayar `1024+`. Giriş türü genişlikten değil
  `pointer-coarse` / `pointer-fine` sorgusundan: dokunmatikte her hedef en az 44 px.
- Telefon: tek sütun, alt sekme çubuğu (beş yer: ekran azsa hepsi sekme, "Daha" yok; çoksa dört ekran ve "Daha";
  patron panelini görende Patron sekmesi Bar'ın yerinde; üst şeridi olmayan bar ve adisyon ekranında yer varsa son
  sekme kişinin menüsü; `phoneTabs`, `src/lib/nav.ts`), birincil eylem altta (adisyonda "Bara gönder" / "Öde" şeridi; ürünlerdeyken yapışkan sepet çubuğu), modal
  yerine alt sayfa, tablo yerine satır kartı, çentik için `safe-area`.
- Tablet: solda dar marka rayı (84 px, ekranlar ikon ve kısa adla), üst çubuğun ortasında ekranın sekmeleri; sahnede
  başlık satırı (sayılar ve eylemler sığmazsa alt satırda); adisyonda ürünler ve hesap yan yana (`min-width: 768px`),
  kategoriler ve yönetimin bölümleri aynı sekme şeridinde (alt menü kartının yatay hali).
- Yönetim › Masa planı'nda masa klavyeyle seçilir (Tab, Enter ya da boşluk), oklarla taşınır, Shift ve oklarla
  boyutlanır; kutunun boyu plandan geldiği için `data-tap-ok` taşır (44 px denetiminin dışında).
- Dokunmatikte alan yazısı en az 16 px (iOS odaklanınca yakınlaştırmasın). Kural katmansızdır ve alanın yazı boyu
  sınıfını ezer: daha büyük alan yazısı (ör. 36 px tutar) alanın kabına verilir, alan onu 1em ile alır.
- **Doğrulama:** `npm run build && npm run e2e`. Tarama her rolün her ekranını 390 px (dokunmatik), 768 px
  (dokunmatik), 1280 px ve koyu temada açar; konsol ve ağ hatası, yatay taşma ve 44 px altı hedefi hata
  sayar; görüntüler `e2e/out/`. Emülasyon gerçek iPhone ve Android dokunuşunu, Safari'yi kanıtlamaz; ilk
  kurulumda gerçek cihazda bir tur atılmalı.
