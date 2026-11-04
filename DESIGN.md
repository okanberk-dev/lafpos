# LafPOS tasarım sistemi: LafPOS Sade, L'Affogato kimliğinde

> Ürün bağlamı `PRODUCT.md`'de. **2 Kasım 2026** operatör kararları: _"tüm sistemdeki her parçası için sistem mantığı
> anlayışına uygun claude design ile tasarımlar yap ve yerleştir, yazı tipi Poppins ve benzeri, minimalist, basit ve
> UI/UX olarak üst düzey"_, _"laffogato.net reposuna bak, orada logomuz vs. var, oradan alıp buraya uyarla"_ ve _"tüm
> sayfaların butonların bileşenlerine kadar en estetik tasarımı yap; 2 ekranlı kasalarda müşteriye gözüken kısmı da
> tasarla, o da değiştirilebilsin"_. Tasarımlar Claude Design tuvalinde (tasarım sistemi, bileşenler, giriş, masalar,
> adisyon, bar ekranı, patron telefonda, vardiya devri, müşteri ekranının üç durumu ve özelleştirmesi) ve kodda
> aynı değerlerle. Renk ve yazı laffogato.net'in kimliği (laffogato `docs/BRAND.md`, `src/app/globals.css`); yerleşim
> Innex'ten kaldı (`docs/ADMIN-INNEX.md`: kenar çubuğu, sayfa başlığı şeridi, KPI şeridi, tablo, çekmece). Değerler
> `src/index.css`'te; erişilebilirlik oranları `tests/design-tokens.test.ts` ve `tests/ui-kit.test.ts`'te sabit. Test
> düşerse değeri düzelt, eşiği gevşetme.

## 1. İlkeler

1. **Sade ve sıcak:** porselen zemin (`#F7F3ED`), üstünde beyaz kartlar, ince çizgi ve sıcak toprak gölge. Süs yok; boşluk,
   yazı ağırlığı ve hizayla düzen.
2. **Renk anlam taşır:** ev yeşili birincil eylem ve seçimdir (sitenin "birincil düğme her zaman yeşil" kuralı); ödeme
   ve tahsilat ticari son adımdır, mürekkep (sitenin `.btn-ink`'i). Kobalt, amber, kırmızı, pembe ve mor yalnız
   durumdur. Renk tek başına durum taşımaz, yanında yazı ya da ikon olur.
3. **Marka yerinde:** L'Af logosu (harfler + kahve çekirdeği kesme işareti) ve uygulama ikonunun yeşili logo karosunda
   (`LafTile`), giriş ekranının marka yüzeyinde, müşteri ekranında ve grafik serisinde; bayrak çizgisi (yeşil, porselen,
   bordo) yalnız marka anlarında. Boş durumlar sitenin elle çizilmiş çizimleriyle.
4. **Dokunmatik önce:** her hedef en az 44 px (AGENTS.md kural 8), POS düğmeleri 44-64 px; fareyle yönetimde 36, sıkı
   görünümde 32 px.

## 2. Belirteçler

### Yazı (sitenin iki sesi)

- **Gabarito** (değişken 400-900): sayfa, bölüm ve kart başlığı (`h1`-`h3` kendiliğinden), gösterim rakamı (KPI,
  ödenecek tutar, masa kartındaki tutar; `font-headline`). Sitenin Biennale yerine seçtiği serbest yazı.
- **Poppins** 400/500/600/700: gövde, etiket, düğme, form. Poppins'in rakamları orantılıdır ve tablo rakamı (`tnum`)
  yoktur; kasada tutarlar alt alta hizalansın diye **bütün rakamlar Gabarito'dan** gelir (`LafPOS Rakam`, yalnız 0-9):
  metinde orantılı, `.tabular` / `tabular-nums` ile eşit genişlikte (sitede liste fiyatları Poppins'tir; kasada hizalı
  rakam şart olduğu için bilinçli ayrışma). Dosyalar pakette (`@fontsource/poppins`, `@fontsource-variable/gabarito`),
  latin ve latin-ext ayrı (`unicode-range`: Türkçe harfler ve ₺ latin-ext'te), dış kaynaktan yazı yüklenmez.
- **Ölçek:** sayfa başlığı Gabarito 22/700 (telefonda 20), kart başlığı 15/600, gövde 14/400, açıklama 13, mikro 12/500
  (en küçük 11); KPI 28/700 (`strong` 34; rakam tek satır, dar karoda boyu karonun iç genişliğinin %17'sine iner, 11
  karakterden uzun tutar ayrıca küçülür: `fitFigure`), müşteri ekranında tutar 48-88/800, saat 96. Başlıkta -0.01em,
  büyük rakamda -0.02/-0.035em; büyük harf yalnız kenar çubuğu grup etiketlerinde. İkon çizgisi 1.75.

### Renk

| Rol | Açık | Koyu |
|---|---|---|
| Zemin (porselen) | `#F7F3ED` | `#0F0E0D` |
| Kart | `#FFFFFF` | `#181715` |
| Sıcak şerit / kuyu (tablo başlığı, tuş) | `#FBF8F4` | `#1D1C1A` |
| Taş (etkin satır, sayaç, segment rayı) | `#F2ECE4` | `#272522` |
| Çizgi / satır ayracı / alan kenarı | `#EBE5DC` / `#F2EDE6` / `#877D74` | `#2E2C29` / `#22211E` / `#7A766E` |
| Mürekkep / gövde / etiket | `#211C18` / `#564D46` / `#675E56` | `#F3F1EC` / `#CFCBC3` / `#A39F96` |
| Birincil: ev yeşili (eylem, seçim, olumlu durum, odak halkası) | `#1D6D56`, basılı `#165543`, üstünde `#FBF8F4` | `#5CC9A2`, üstünde `#0B1F18` |
| Mürekkep dolgu (ödeme, tahsilat) | `#211C18`, üstünde `#FBF8F4` | `#F3F1EC`, üstünde `#161513` |
| Kobalt (dolu masa, hazırlanıyor, bilgi) | `#3442B8` zemin `#ECEEFB` | `#9AA8FF` zemin `#1F2647` |
| Pirinç (damga kartı, ödül düğmesi `variant="gold"`: Hediye içecek; L'Af çekirdeği) | dolgu `#E8C877` üstünde `#2E2113` (`bg-gold-fill text-on-gold`), metin `#765923` (`text-gold-ink`) | dolgu ve üstündeki aynı, metin `#E8C877` |
| Bordo (imza yüzeyi, ekran başına bir) | `#9D2543` zemin `#F9E6EA` | `#F6E9EC` |
| Durum tonları | amber `#B45309`, kırmızı `#B42318`, pembe `#C0264A`, mor `#6D3FEA`, camgöbeği `#0B7392` (açık zeminleriyle) | aynı roller, açık tonlar |
| Grafik serisi ve ısı haritası | ev yeşili `#1D6D56` | `#5CC9A2` |
| Marka karosu (uygulama ikonu) | `radial-gradient(#23876A → #1D6D56 → #0C3B2D)`, krem `#FBF6F1`, pirinç `#E8C877` | aynı |

- Değer adları `--admin-*` (`:root` açık, `.dark` koyu); ortak adlar (`--bg`, `--ink`, `--primary`, `--focus`...) onlara
  çözülür. Tailwind anlam adları iki temada doğru tonu verir: `text-blue-ink`, `bg-blue-soft`, `border-blue-line`,
  `text-gold-ink`, `bg-gold-fill` (üstünde `text-on-gold`), `text-danger-ink`, `bg-warning-soft`... Ham ölçekler (`danger-600`, `success-600`...)
  koyuda değişmez; yalnız beyaz yazılı dolu yüzeyde (dolu düğme, alarm süre rozeti, hazır rozeti) kalır,
  `tests/ui-rules.test.ts` izinli listeyle tutar. Olumlu durum (hazır, ödendi) sitedeki gibi ev yeşilidir.
- **Odak halkası** 2 px ev yeşili, 2 px dışarıda; alan odakta yeşil kenar ve yumuşak yeşil halka (sitenin `--ring`'i).
  Mürekkep zeminli bildirimde halka krem ve düğmenin içinde (yeşil mürekkepte 3:1'in altında kalır).
- **İkon kutusu** (`IconBox`: KPI hücresi, hızlı bakış satırı, telefondaki yönetim listesi) varsayılan nötr taş; renk
  yalnız anlam taşıyınca (`src/components/admin/hues.ts`): mor online, kobalt açık / dolu, yeşil ciro ve olumlu durum
  (satışta, bağlı), pembe kayıp ve iptal, amber gecikme ve bekleyen; durumsuz sayı ve süre nötr.

### Biçim

- **Köşeler** (sitenin ölçüsü): küçük denetim 10, alan, iç kutu ve tuş 14, kart 20, pencere ve alt sayfa 28; düğme,
  rozet, sekme, kategori çipi ve segment kapsül (`rounded-full`).
- **Gölge** sıcak topraktır (`#3B2A1E`, en çok %12; nötr siyah porselende griye kaçar): kart `--shadow-card`, seçili ya
  da basılabilir öğe `--shadow-lift`, yüzen katman `--shadow-pop`; denetimin cam kenarı `--rim` (üstte beyaz dudak).
  Koyuda kart gölgesiz, ayrımı çizgi yapar.
- **Boşluk:** 4'ün katları; kart arası 12, pencereye 8, kart içi 16-20.
- **Hareket:** yalnız değişen özelliğe 150 ms, `--ease-out` (0.2, 0.7, 0.2, 1); basılı ölçek 0.97 (uygulamanın
  `pressScale`'i); hareket azaltmada dekoratif hareket ve nabız durur.

### Çizimler

laffogato'nun çizimleri (`public/illustrations/`, docs/BRAND.md §6.1: düz dolgu, 2 px espresso kontur, altı renk,
yazısız) `src/assets/illustrations/`'ta; `EmptyState art=` ya da `<Illustration>` basar (`alt=""`, anlamı başlık taşır;
koyu temada porselen bir disk üstünde). Eşleme: fiş (açık sipariş yok), boş fincan tabağı (sonuçsuz arama), boş kek
standı (kategoride ürün yok), fincan (adisyon boş), espresso (bekleyen fiş yok), çalar saat (hazırlanan kalem yok), bilet
(rezervasyon yok), kupon (müşteri yok), kapı (gün açılmadı), affogato (bugün satış yok), kalp (her şey yolunda).

## 3. Kasa ekranları (masalar, adisyon, bar, kasa, patron)

- **Yerleşim:** tablet ve bilgisayarda 84 px beyaz ikon rayı (etkin ekran yeşil hapta, yazısı kalın), yanında ekranın
  kendi kartları (pencereye 8 px); telefonda üst şerit ve alt sekme çubuğu (etkin sekmenin ikonu gri hapta). Adisyon iki
  kart: ürünler | hesap.
- **Durum renkleri:** masa boş beyaz, dolu mavi, hesap istendi amber, kısmen ödendi pembe (zemin `*-soft`, kenar
  `*-line`); online (siteden gelen) sipariş her ekranda mor. Bar ekranında kalem bekliyor nötr (gri halka),
  hazırlanıyor mavi, hazır yeşil, teslim edildi gri (yazıyla "Teslim edildi"); amber yalnız zamanı söyler (ayardaki
  dakikayı geçen fişin süre rozeti, planlı saat), kırmızı alarm ve iptal.
- **Masa kartı:** köşe 20, ad üstte, tutar kartın en büyük yazısı (Gabarito 22/700, dar kartta 17), altında süre ve garson; bara gitmiş ve hazır
  kalemler küçük hap, hazır olan yeşil ve nabızlı.
- **Ürün kartı:** köşe 20, ad 15/500, fiyat 14/600; sitedeki görsel (dekupaj kuyuda, fotoğraf kuyuyu doldurur), görseli
  olmayanda baş harfler kategori renginin açık tonunda. Telefonda kategoriler hap çip (seçili yeşil dolgu).
- **Logo:** L'Af, laffogato.net ve uygulama ikonuyla aynı vektör (`src/components/LafMark.tsx`); karoda (`LafTile`)
  uygulama ikonunun kendisi. Yazı tipine bağlı değil, Didot'u olmayan Windows ve Android'de de aynı. Karo uygulama
  ikonunun oranında: logo karonun yüksekliğinin yarısı, köşe kenarın %22'si (arayüzün köşe ölçeğinden bağımsız; `TILE`,
  `src/components/LafMark.tsx`).
- **Giriş ekranı:** solda marka yüzeyi (yeşil, krem yazı, 96 px saat, ekip), sağda PIN kartı (sade tuşlar,
  yeşil "Giriş"); kilit ekranında yalnız oturum açılır (mesai 4 Kasım 2026'da kaldırıldı).
- **Ödeme penceresi** üç yol: Tutar (nakit ya da kart, para üstü), Kalem (seçili kalemler), Paylaş. Paylaş'ta önce
  "Kaç kişiye bölünsün?": 2, 3, 4, 5, 6 büyük çipler (56 px, Gabarito rakam) tek dokunuşla böler, daha kalabalık masa
  adet seçiciyle (en çok 30). Altında **Eşit | Elle**: Eşit'te kalan kuruşu kuruşuna bölünür; Elle'de her ödenmemiş
  payın kendi tutar alanı olur, eşit bölüşle dolu gelir, son pay kalanı kendisi gösterir ("Kalanı alır"); pay sıfır ya
  da eksi olamaz, toplam kalana eşittir, düğme "Payları kaydet" (kaydedilmeden ödeme düğmesi "Önce payları kaydedin"
  der). Paylar sırayla ve istenen yöntemle alınır: sıradaki pay mürekkep kenarlı, ödenen pay yeşil onaylı. Pay tutarını
  sunucu hesaplar (`shared/order-calc.ts` `splitState`, elle tutarlar `orders.split_amounts`); hesap değişince (kalem,
  iptal, indirim, ödeme iptali) elle paylar düşer, kalan yeniden eşit bölünür ve pencere bunu kısa notla söyler. Yazarkasada fiş tek kesilir, paylar cihazda ayrı ödeme. Ödeme düğmesi
  pencerenin alt şeridinde, kaydırınca kaybolmaz; yanında para üstü, eksik ya da bahşiş notu. Düğmenin tutarı bahşişi
  içerir (kartta bankanın POS'una girilen tutar) ve eksik adımı söyler ("Ödenecek kalemleri seçin", "Önce hesabı
  bölün"; açık hesapta "açık hesaba yaz"). Tablet ve bilgisayarda iki sütun: solda tutar, tuş takımı, yazarkasa ve
  alınan ödemeler; sağda ödeme türleri, Verilen, Bahşiş ve ciro dışı kapanış. Sepet yazarkasada beklerken LafPOS'ta
  ödeme, ciro dışı kapanış ve ödeme iptali kapalı; durum ve "Sepeti iptal et" en üstte. Sonuç ekranında para üstü en
  üstte, mürekkep kenarlı nötr kutuda.
- **Adisyon:** geniş ekranda kategoriler solda dikey liste (sayılarıyla), ürün kartında sitedeki görsel; "/" aramaya
  götürür.
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

Panel açıkken `<html data-area="admin">`; aynı değerler, yalnız sıklık farklı (fareyle 36 px düğme, "Sıkı görünüm"de 32).

- **Yerleşim** (Innex §1.1): zemin üstünde iki beyaz kart, köşe 14 (içlerindeki kartlar 20), pencereye 8 px, aralarında 12 px.
  Kenar çubuğu 15.5rem; sayfa kartının ilk şeridi üst çubuk (yol, ⌘K arama, sıkı görünüm, canlı bağlantı),
  altında sayfa başlığı şeridi (Gabarito 22/700 başlık, 13 px açıklama, sağda önce ikincil sonra birincil düğme).
- **Kenar çubuğu:** gruplar büyük harfli küçük etiketle (Genel, Menü, Salon ve kasa, Ekip, Bağlantılar,
  Sistem), etkin satır gri ve renksiz, sayaç hap ve yalnız iş bekleyen yerde (tükenen ürün,
  gönderilemeyen gün). Üstte logo karosu, işletme ve "Menüyü daralt"; altta "Kasa ekranlarına dön" ve kullanıcı.
  Tablette dar ikon menüsünde iş bekleyen bölümün ikonunun köşesinde nötr sayaç (renk değil sayı); "Menüyü aç" adlı ve
  sayaçlı tam menüyü soldan çekmecede açar.
- **Bileşenler** (`src/components/admin/ui.tsx`): `PageHeader`, `Card` (başlık eylemlerle dikeyde ortalı, başlık
  bloğunun taban genişliği 9rem: geniş eylem telefonda alt satıra iner), `KpiStrip` (tek kart, hücreler arası 1 px, her
  rakamın yanında referans), `StatusTabs` (sayılı hap çipler, etkin mürekkep kenar; telefonda kayan rayda seçili çip
  görünür kalır, gizlenen kenar solar), `Segmented` (gri hap ray, beyaz hap; telefonda tam genişlikte satıra kırılır;
  radyo grubu klavyesi: Tab seçili seçenekte girer, oklar ve Home/End gezer, Enter ya da boşluk seçer), `DataTable`
  (kuyuda başlık, satır ayracı, yapışkan eylem sütunu, seçili satır solda ev yeşili çizgi), `ActionMenu` (⋯, köşe 14,
  portalda), `QuickLook` (sağdan hızlı bakış ve düzenleme çekmecesi, köşe 28, telefonda alt sayfa), `ActionRows`,
  `Timeline`, `Badge`, `EmptyState`, `SearchField`. Düğme kapsül, 14 px; dokunmatikte 44, farede 36, sıkı görünümde
  32 px.
- **Sayfalar:** Genel bakış (KPI şeridi: net ciro geçen haftanın aynı günü aynı saatine göre, adisyon,
  açık adisyon, indirim ve ikram, online sipariş; saatlik grafik; en çok satanlar; dikkat isteyenler;
  sistem sağlığı), Ürünler, Seçenekler, Masa planı, Ödeme türleri, Personel ve yetki, Yazarkasa, Site
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

- **Ölçek:** sayfa başlığı Gabarito 22/700 (telefonda 20) ve 13 px açıklama (`PageHeader`), bölüm 16/600, kart başlığı 15/600, mikro
  etiket 12/500; kart arası 12 px, pencereye 8 px. KPI karosu tek bileşen (`Stat`: 13 px etiket, Gabarito 28 px rakam,
  `strong` 34 px); rakam yerine kelime yazılmaz ("—" ve ipucunda "Sayılmadı").
- **Durumlar:** her denetimin dinlenme, üzerine gelme, basılı (zemin bir ton koyu; dokunmatikte `hover`
  çalışmadığı için basılı renk ayrıca yazılır), odak (2 px birincil halka) ve devre dışı hali var. Devre dışı
  birincil düğme gri zemin ve soluk yazıdır, yarı saydam değil; bir bilgi cümlesi devre dışı düğme olarak
  çizilmez ("Ödemeyi kasa alır" düğmenin altında yazıdır).
- **Sekme ve seçim:** `Tabs` (bölüm, istasyon, sipariş listesi; seçili gri zemin, sayı hapı sıfırsa gizli, dar
  ekranda yatay kayar: seçili sekme rayda görünür kalır, içeriğin gizlendiği kenar solar, `useRail`) ve `Segmented`
  (2-4 eşit seçenek; gri ray, beyaz hap). Dolu yeşil seçim yalnız gezinmede: raydaki
  etkin ekran ve telefondaki seçili kategori çipi. Öteki seçimler gri zemin, beyaz hap ya da yeşil veya mürekkep
  kenardır; sekme sayısı ve sıradaki pay nötrdür (beyaz hap, mürekkep kenar), dolu yeşil hap olumlu durumla (hazır,
  ödendi) karışmasın. Amber durum rengidir, seçim için kullanılmaz; bağlantı birincil yeşil, kobalt yalnız durum.
  Seçim çipi `Chip` (`src/components/ui/Field.tsx`; kapsül, `aria-pressed`): seçenek ve süzgeçte yeşil kenar ve açık
  yeşil zemin (`tone="primary"`), hazır neden ve süre seçiminde mürekkep kenar, taş zemin ve tik (`tone="ink"`). Adet
  ve kişi sayısı `Stepper` ile: alan kenarlı grup, eksi, değer, artı; en küçük adette Kaldır; tek değerli pencerede
  `size="lg"`. Seçenek penceresinin 10 px seçenek çipleri tükendi durumuyla ayrı kalır.
- **Boş, yükleniyor, hata:** `EmptyState` (kart içinde `compact`, sayfada varsayılan, bar ve çağrı ekranında
  `large`; başlık ekranın sözüyle, "Liste boş" değil), `Skeleton` / `ListSkeleton` (ilk yüklemede), `ErrorState`
  (boş durumla aynı ölçek ve üç boy: kart içinde `compact`, sayfada varsayılan, tam ekranda ve bar ekranında `large`;
  yeniden dene ile). Yüklenirken ya da hata varken "yok" yazılmaz.
- **Onay ve metin isteme:** tarayıcının `confirm()` / `prompt()` pencereleri yok; `confirmDialog` /
  `promptDialog` (`src/components/ui/Confirm.tsx`) eylemi adlandıran düğmeyle, yıkıcı eylemde kırmızı. Para ya da
  kayıt değiştiren her düğme istek sürerken kilitlidir (`loading`), ikinci dokunuş gitmez. Pencere ve çekmece başlığı
  18/700, Kapat başlığın ilk satırında; pencerede başlık kesilmez, hızlı bakış çekmecesinde en çok iki satır. Onay ve
  metin isteme penceresinde Kapat yok (Vazgeç aynı işi yapar, Escape ve arka plan da vazgeçer).
- **Tutar girişi:** ekrandaki tuş takımı (`Numpad`) fiziksel klavyeyle de çalışır: rakam, `,` ve sayısal
  takımın ondalığı virgül; ana sıradaki `.` ardından üç rakam gelirse binlik ayıracı ("2.000"), değilse ondalık
  ("45.90" = 45,90 TL); Enter onaylar, odaktaki tuşa yeniden basmaz. Önceden dolu tutarın üstüne ilk tuş yazar.
  Kalandan fazlası sessizce kırpılmaz, alan uyarır. Tümünü silen tuş "Temizle", tek rakamı ⌫ siler.
- **Alan:** kısa ipucu (16 karaktere kadar: "zorunlu", "5–120") etiketin sağında; uzunu alanın altında yardım metni ve
  alanın açıklaması (`aria-describedby`); etiket satırı tek satır kalır, iki sütunlu formda alanlar hizalı. Odakta yeşil
  kenar ve 3 px hale, hatada kırmızı kenar ve ileti alanın altında (`Field`, `src/components/ui/Field.tsx`).
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
  sekme kişinin menüsü; `phoneTabs`, `src/lib/nav.ts`), birincil eylem altta (adisyonda Gönder / Ödeme şeridi), modal
  yerine alt sayfa, tablo yerine satır kartı, çentik için `safe-area`.
- Tablet: adisyonda ürünler ve hesap yan yana (`min-width: 768px`), yönetimde dar ikon menüsü (sayaçlı; "Menüyü aç"
  tam menüyü çekmecede açar).
- Yönetim › Masa planı'nda masa klavyeyle seçilir (Tab, Enter ya da boşluk), oklarla taşınır, Shift ve oklarla
  boyutlanır; kutunun boyu plandan geldiği için `data-tap-ok` taşır (44 px denetiminin dışında).
- Dokunmatikte alan yazısı en az 16 px (iOS odaklanınca yakınlaştırmasın). Kural katmansızdır ve alanın yazı boyu
  sınıfını ezer: daha büyük alan yazısı (ör. 36 px tutar) alanın kabına verilir, alan onu 1em ile alır.
- **Doğrulama:** `npm run build && npm run e2e`. Tarama her rolün her ekranını 390 px (dokunmatik), 768 px
  (dokunmatik), 1280 px ve koyu temada açar; konsol ve ağ hatası, yatay taşma ve 44 px altı hedefi hata
  sayar; görüntüler `e2e/out/`. Emülasyon gerçek iPhone ve Android dokunuşunu, Safari'yi kanıtlamaz; ilk
  kurulumda gerçek cihazda bir tur atılmalı.
