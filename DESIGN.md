# LafPOS tasarım sistemi: LafPOS Sade

> Ürün bağlamı `PRODUCT.md`'de. **2 Kasım 2026** operatör kararı: _"tüm sistemdeki her parçası için sistem mantığı
> anlayışına uygun claude design ile tasarımlar yap ve yerleştir, yazı tipi Poppins ve benzeri, minimalist, basit ve
> UI/UX olarak üst düzey"_. Tasarımlar Claude Design tuvalinde (tasarım sistemi, giriş, masalar, adisyon, bar ekranı,
> patron telefonda, mesai ve vardiya devri) ve kodda aynı değerlerle. Yerleşim Innex'ten kaldı (`docs/ADMIN-INNEX.md`:
> kenar çubuğu, sayfa başlığı şeridi, KPI şeridi, tablo, çekmece); görünüm yeni: Poppins, sıcak kırık beyaz, mürekkep
> eylem. Değerler `src/index.css`'te; erişilebilirlik oranları `tests/design-tokens.test.ts` ve `tests/ui-kit.test.ts`'te
> sabit. Test düşerse değeri düzelt, eşiği gevşetme.

## 1. İlkeler

1. **Sade:** gri değil sıcak kırık beyaz zemin (kâğıt), üstünde beyaz kartlar, kâğıt inceliğinde çizgi ve gölge. Süs yok;
   boşluk, yazı ağırlığı ve hizayla düzen.
2. **Renk anlam taşır:** eylem rengi mürekkeptir (açıkta siyah, koyuda kırık beyaz). Mavi, yeşil, amber, kırmızı, pembe ve
   mor yalnız durumdur; düğmeyi süslemek için kullanılmaz. Renk tek başına durum taşımaz, yanında yazı ya da ikon olur.
3. **Marka yerinde:** L'Affogato yeşili, krem harf ve pirinç çekirdek yalnız logo karosunda (`LafTile`, uygulama ikonunun
   kendisi), giriş ekranının marka yüzeyinde, müşteriye dönük ekranların ışıltısında ve grafik serisinde.
4. **Dokunmatik önce:** her hedef en az 44 px (AGENTS.md kural 8), POS düğmeleri 44-64 px; fareyle yönetimde 36, sıkı
   görünümde 32 px.

## 2. Belirteçler

### Yazı

- **Poppins** 400/500/600/700 harfler için; **Outfit** (değişken, `LafPOS Rakam` adıyla yalnız 0-9) rakamlar için.
  Poppins'in rakamları orantılıdır ve tablo rakamı (`tnum`) yoktur; tutarlar alt alta hizalansın diye bütün rakamlar
  ona çok benzeyen Outfit'ten gelir: metinde orantılı, `.tabular` / `tabular-nums` ile eşit genişlikte. Dosyalar pakette
  (`@fontsource/poppins`, `@fontsource-variable/outfit`), latin ve latin-ext ayrı (`unicode-range`: Türkçe harfler ve ₺
  latin-ext'te), dış kaynaktan yazı yüklenmez.
- **Ölçek:** sayfa başlığı 20/600 (telefonda 18), bölüm 16/600, kart başlığı 15/600, gövde 14/400, açıklama 13, mikro
  12/500 (en küçük 11); KPI 26/600 (`strong` 32), büyük tutar 30-44/600, saat 96/300. Başlıklarda -0.015em, büyük
  rakamda -0.02em; büyük harf yalnız kenar çubuğu grup etiketlerinde (+0.06em). İkon çizgisi 1.75.

### Renk

| Rol | Açık | Koyu |
|---|---|---|
| Zemin (kartların arası) | `#F4F3EF` | `#0F0E0D` |
| Kart | `#FFFFFF` | `#181715` |
| Kuyu (tablo başlığı, tuş) | `#FAF9F7` | `#1D1C1A` |
| Gri (etkin satır, sayaç, segment rayı) | `#EFEDE8` | `#272522` |
| Çizgi / satır ayracı / alan kenarı | `#E7E4DE` / `#F0EEE9` / `#8A857C` | `#2E2C29` / `#22211E` / `#7A766E` |
| Mürekkep / gövde / etiket | `#1A1917` / `#46433D` / `#6B675F` | `#F3F1EC` / `#CFCBC3` / `#A39F96` |
| Birincil (eylem, seçim) | `#1A1917` (üstünde beyaz) | `#F3F1EC` (üstünde `#161513`) |
| Durum mavisi (dolu, hazırlanıyor, bilgi, odak halkası) | `#2B55E6` zemin `#EDF1FE` | `#8BA0FF` zemin `#1F2647` |
| Durum tonları | yeşil `#15803D`, amber `#B45309`, kırmızı `#B42318`, pembe `#C0264A`, mor `#6D3FEA`, camgöbeği `#0B7392` (açık zeminleriyle) | aynı roller, açık tonlar |
| Grafik serisi | L'Affogato yeşili `#1F6F58` | `#5CC9A2` |
| Marka karosu | `radial-gradient(#25896B → #1C6A53 → #0D3F30)`, krem `#FBF6F1`, pirinç `#E8C877` | aynı |

- Değer adları `--admin-*` (`:root` açık, `.dark` koyu); ortak adlar (`--bg`, `--ink`, `--primary`, `--focus`...) onlara
  çözülür. Tailwind anlam adları iki temada doğru tonu verir: `text-blue-ink`, `bg-blue-soft`, `border-blue-line`,
  `text-danger-ink`, `bg-warning-soft`, `border-success-line`... Ham ölçekler (`danger-600`, `success-600`...) koyuda
  değişmez; yalnız beyaz yazılı dolu yüzeyde (dolu düğme, alarm süre rozeti, hazır rozeti) kalır, `tests/ui-rules.test.ts`
  izinli listeyle tutar.
- **Odak halkası** 2 px durum mavisi, 2 px dışarıda: mürekkep düğmenin etrafında da, kırık beyaz zeminde de seçilir.
  Alan odakta mürekkep kenar ve yumuşak gri halka alır; seçim (`::selection`) mavinin açık tonu.

### Biçim

- **Köşeler:** küçük denetim (sekme içi, tuş takımı tuşu, ikon kutusu) 10, düğme ve alan 12, kart 16, pencere ve
  çekmece 20; rozet, sekme, kategori çipi ve segment hap biçimi (`rounded-full`).
- **Gölge:** kart `--shadow-card` (kâğıt: 1 px, %4); yüzen katman (pencere, menü, bildirim, ipucu) `--shadow-pop`.
  Koyuda kart gölgesiz, ayrımı çizgi yapar.
- **Boşluk:** 4'ün katları; kart arası 12, pencereye 8, kart içi 16-20.
- **Hareket:** yalnız değişen özelliğe 150 ms, üstel yavaşlayan; basılı ölçek 0.98; hareket azaltmada dekoratif hareket
  ve nabız durur.

## 3. Kasa ekranları (masalar, adisyon, bar, kasa, patron)

- **Yerleşim:** tablet ve bilgisayarda 84 px beyaz ikon rayı (etkin ekran mürekkep hapta, yazısı kalın), yanında ekranın
  kendi kartları (pencereye 8 px); telefonda üst şerit ve alt sekme çubuğu (etkin sekmenin ikonu gri hapta). Adisyon iki
  kart: ürünler | hesap.
- **Durum renkleri:** masa boş beyaz, dolu mavi, hesap istendi amber, kısmen ödendi pembe (zemin `*-soft`, kenar
  `*-line`); online (siteden gelen) sipariş her ekranda mor. Bar ekranında kalem bekliyor nötr (gri halka),
  hazırlanıyor mavi, hazır yeşil, teslim edildi gri (yazıyla "Teslim edildi"); amber yalnız zamanı söyler (ayardaki
  dakikayı geçen fişin süre rozeti, planlı saat), kırmızı alarm ve iptal.
- **Masa kartı:** köşe 16, ad üstte, tutar kartın en büyük yazısı (20/600), altında süre ve garson; bara gitmiş ve hazır
  kalemler küçük hap, hazır olan yeşil ve nabızlı.
- **Ürün kartı:** köşe 16, ad 15/500, fiyat 14/600; sitedeki görsel (dekupaj kuyuda, fotoğraf kuyuyu doldurur), görseli
  olmayanda baş harfler kategori renginin açık tonunda. Telefonda kategoriler hap çip (seçili mürekkep dolgu).
- **Logo:** L'Af, laffogato.net ve uygulama ikonuyla aynı vektör (`src/components/LafMark.tsx`); karoda (`LafTile`)
  uygulama ikonunun kendisi. Yazı tipine bağlı değil, Didot'u olmayan Windows ve Android'de de aynı.
- **Giriş ekranı:** solda marka yüzeyi (yeşil, krem yazı, 96 px saat, bugünkü ekip), sağda PIN kartı (sade tuşlar,
  mürekkep "Giriş"); **Mesai** sekmesinde aynı PIN'le giriş-çıkış yapılır, oturum açılmaz.
- **Ödeme penceresi** üç yol: Tutar (nakit ya da kart, para üstü), Kalem (seçili kalemler), Paylaş (hesap N
  kişiye eşit bölünür, paylar sırayla ve istenen yöntemle alınır; pay tutarını sunucu hesaplar,
  `shared/order-calc.ts` `splitState`). Yazarkasada fiş tek kesilir, paylar cihazda ayrı ödeme.
- **Adisyon:** geniş ekranda kategoriler solda dikey liste (sayılarıyla), ürün kartında sitedeki görsel; "/" aramaya
  götürür.
- **Müşteriye dönük ekranlar** (kasa menüsü olmadan, otomatik kilit yok): çağrı ekranı `/cagri` (Hazırlanıyor ve
  büyük numaralı Hazır; platformun gel-al siparişinde platformun kodu ve adı), müşteri ekranı `/musteri-ekrani`
  (kalemler ve büyük tutar; teşekkür, self serviste çağrı numarasıyla; uzun kimlik, "Masa WWWWWW", çağrı ekranındaki
  gibi ekranla küçülen yazı ve kırılan kelimeyle telefonda da taşmaz; hoş geldiniz, logo karosunun arkasında L'Affogato
  yeşili ışıltı). İkisi de ilk karesinden koyu açılır (gece loş salonda en parlak yüzey olmasın); müşteri ekranı
  `?tema=acik` ile açık açılır.
- **Grafik:** tek seri tek renk (L'Affogato yeşili), kıyas serisi gri çizgi, tek eksen; tutar ekseninde kesirli
  adım yok, verisi olmayan dönemde eksen yerine ekranın zamanını söyleyen boş durum çizilir (Bugün henüz satış
  yok, Bu günde satış yok, Bu dönemde satış yok; `ColumnChart` `emptyLabel`, `src/components/charts.tsx`). Isı haritası
  aynı yeşilin tonları.

## 4. Yönetim paneli

Panel açıkken `<html data-area="admin">`; aynı değerler, yalnız sıklık farklı (fareyle 36 px düğme, "Sıkı görünüm"de 32).

- **Yerleşim** (Innex §1.1): zemin üstünde iki beyaz kart, köşe 16, pencereye 8 px, aralarında 12 px.
  Kenar çubuğu 15.5rem; sayfa kartının ilk şeridi üst çubuk (yol, ⌘K arama, sıkı görünüm, canlı bağlantı),
  altında sayfa başlığı şeridi (20 px başlık, 13 px açıklama, sağda önce ikincil sonra birincil düğme).
- **Kenar çubuğu:** gruplar büyük harfli küçük etiketle (Genel, Menü, Salon ve kasa, Ekip, Bağlantılar,
  Sistem), etkin satır gri ve renksiz, sayaç hap ve yalnız iş bekleyen yerde (tükenen ürün, gönderilemeyen gün, şu an
  mesaide olan). Altta "Kasa ekranlarına dön", "Menüyü daralt" ve kullanıcı.
- **Bileşenler** (`src/components/admin/ui.tsx`): `PageHeader`, `Card`, `KpiStrip` (tek kart, hücreler
  arası 1 px, her rakamın yanında referans), `StatusTabs` (sayılı hap çipler, etkin mürekkep kenar), `Segmented` (gri
  hap ray, beyaz hap), `DataTable` (kuyuda başlık, satır ayracı, yapışkan eylem sütunu, seçili satır solda mürekkep
  çizgi), `ActionMenu` (⋯, köşe 14, portalda), `QuickLook` (sağdan hızlı bakış ve düzenleme çekmecesi, köşe 20),
  `ActionRows`, `Timeline`, `Badge`, `EmptyState`, `SearchField`. Düğme köşe 12, 14 px; dokunmatikte 44, farede 36,
  sıkı görünümde 32 px.
- **Sayfalar:** Genel bakış (KPI şeridi: net ciro geçen haftanın aynı günü aynı saatine göre, adisyon,
  açık adisyon, indirim ve ikram, online sipariş; saatlik grafik; en çok satanlar; dikkat isteyenler;
  sistem sağlığı), Ürünler, Seçenekler, Masa planı, Ödeme türleri, Personel ve yetki, Mesai çizelgesi, Yazarkasa, Site
  ve lafmaliyet, Ağ ve uzaktan erişim (yerel adres ve Tailscale karekodu), Ayarlar, Denetim kaydı (zaman çizelgesi),
  Raporlar (dönem segmenti, rapor sekmeleri, önceki dönemle KPI şeridi).

### LafPOS'un Innex'e göre eklemeleri

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

## 5. Ortak bileşenler ve etkileşim (28 Ekim 2026 yenilemesi)

Kasa ekranları `src/components/ui/*`, yönetim `src/components/admin/ui.tsx` kullanır; ikisi aynı belirteçlerden
ve aynı kurallardan çizilir. Yeni ekran önce bu parçalara bakar, kendi denetimini yazmaz.

- **Ölçek:** sayfa başlığı 18/600 ve 13 px açıklama (`PageHeader`), bölüm 16/600, kart başlığı 15/600, mikro
  etiket 12/500; kart arası 12 px, pencereye 8 px. KPI karosu tek bileşen (`Stat`: 13 px etiket, 24 px rakam,
  `strong` 30 px); rakam yerine kelime yazılmaz ("—" ve ipucunda "Sayılmadı").
- **Durumlar:** her denetimin dinlenme, üzerine gelme, basılı (zemin bir ton koyu; dokunmatikte `hover`
  çalışmadığı için basılı renk ayrıca yazılır), odak (2 px birincil halka) ve devre dışı hali var. Devre dışı
  birincil düğme gri zemin ve soluk yazıdır, yarı saydam mavi değil; bir bilgi cümlesi devre dışı düğme olarak
  çizilmez ("Ödemeyi kasa alır" düğmenin altında yazıdır).
- **Sekme ve seçim:** `Tabs` (bölüm, istasyon, sipariş listesi; seçili gri zemin, sayı hapı sıfırsa gizli, dar
  ekranda yatay kayar) ve `Segmented` (2-4 eşit seçenek; gri ray, beyaz hap). Seçim rengi mavidir; amber durum
  rengidir, seçim için kullanılmaz.
- **Boş, yükleniyor, hata:** `EmptyState` (kart içinde `compact`, sayfada varsayılan, bar ve çağrı ekranında
  `large`; başlık ekranın sözüyle, "Liste boş" değil), `Skeleton` / `ListSkeleton` (ilk yüklemede), `ErrorState`
  (yeniden dene ile). Yüklenirken ya da hata varken "yok" yazılmaz.
- **Onay ve metin isteme:** tarayıcının `confirm()` / `prompt()` pencereleri yok; `confirmDialog` /
  `promptDialog` (`src/components/ui/Confirm.tsx`) eylemi adlandıran düğmeyle, yıkıcı eylemde kırmızı. Para ya da
  kayıt değiştiren her düğme istek sürerken kilitlidir (`loading`), ikinci dokunuş gitmez.
- **Tutar girişi:** ekrandaki tuş takımı (`Numpad`) fiziksel klavyeyle de çalışır: rakam, `,` ve sayısal
  takımın ondalığı virgül; ana sıradaki `.` ardından üç rakam gelirse binlik ayıracı ("2.000"), değilse ondalık
  ("45.90" = 45,90 TL); Enter onaylar, odaktaki tuşa yeniden basmaz. Önceden dolu tutarın üstüne ilk tuş yazar.
  Kalandan fazlası sessizce kırpılmaz, alan uyarır.
- **Bildirim:** telefonda alt sekmenin üstünde, tablet ve bilgisayarda sağ üstte (aksiyon şeridini örtmez);
  "Geri al" gibi tek eylem taşıyabilir, eylem bir kez çalışır. Hata bildirimi daha uzun kalır.
- **Sınıflar:** `cn()` (`src/lib/cn.ts`) çakışan Tailwind sınıflarını birleştirir, sonraki kazanır (`px-0`
  `px-3`'ü, `max-sm:hidden` gizlemeyi ezer). Geçiş yalnız değişen özelliklere, 150 ms; hareket azaltmada dekoratif
  hareket ve nabız durur.
- **Kaydedilmemiş değişiklik:** uzun ayar formu değişiklik varken altta yapışkan şerit (Vazgeç, Kaydet) gösterir;
  sekme kapanırken, uygulama içi geçişte ve geri tuşunda sorar (`src/lib/unsavedGuard.ts`).

## 6. Telefon ve tablet (impeccable `adapt`)

- Kırılımlar: telefon `< 768`, tablet `768-1023`, bilgisayar `1024+`. Giriş türü genişlikten değil
  `pointer-coarse` / `pointer-fine` sorgusundan: dokunmatikte her hedef en az 44 px.
- Telefon: tek sütun, alt sekme çubuğu (en çok 4 ekran + "Daha"), birincil eylem altta (adisyonda
  Gönder / Ödeme şeridi), modal yerine alt sayfa, tablo yerine satır kartı, çentik için `safe-area`.
- Tablet: adisyonda ürünler ve hesap yan yana (`min-width: 768px`), yönetimde dar ikon menüsü.
- Dokunmatikte alan yazısı en az 16 px (iOS odaklanınca yakınlaştırmasın).
- **Doğrulama:** `npm run build && npm run e2e`. Tarama her rolün her ekranını 390 px (dokunmatik), 768 px
  (dokunmatik), 1280 px ve koyu temada açar; konsol ve ağ hatası, yatay taşma ve 44 px altı hedefi hata
  sayar; görüntüler `e2e/out/`. Emülasyon gerçek iPhone ve Android dokunuşunu, Safari'yi kanıtlamaz; ilk
  kurulumda gerçek cihazda bir tur atılmalı.
