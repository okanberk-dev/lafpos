# LafPOS tasarım sistemi

> Ürün bağlamı `PRODUCT.md`'de. Kasa ekranları da yönetim paneli de **Innex**'te (26 Ekim 2026, operatör:
> "İnnex skills dosyası gibi olabilir, daha estetik ve modern"). Değerler `src/index.css`'te; erişilebilirlik
> oranları `tests/design-tokens.test.ts`'te sabit. Test düşerse değeri düzelt, eşiği gevşetme.

## 1. Kasa ekranları (masalar, adisyon, bar, kasa, patron)

Yönetimle aynı Innex değerleri (§2 tablosu): gri zemin üstünde beyaz kartlar, 1 px çizgi, köşe 12, gölge yok,
Inter, birincil mavi. `--admin-*` değerleri `:root`'ta (açık) ve `.dark`'ta (koyu); ortak adlar (`--bg`, `--ink`,
`--primary`...) onlara çözülür.

- **Yerleşim:** tablet ve bilgisayarda 84 px beyaz ikon rayı, yanında ekranın kendi kartları (pencereye 8 px);
  telefonda üst şerit ve alt sekme çubuğu. Adisyon iki kart: ürünler | hesap.
- **Durum renkleri** belirteçlerden, iki temada da AA: durum rengi `--admin-{primary,warning,rose,success,danger}`,
  yumuşak zemini `*-soft`, kenarı `*-line` (sınıf adları `bg-primary-soft`, `border-warning-line`,
  `text-danger-ink`...). Masa boş beyaz, dolu mavi, hesap istendi amber, kısmen ödendi pembe (zemin `*-soft`,
  kenar `*-line`); online (siteden gelen) sipariş her ekranda mor. Bar ekranında kalem bekliyor nötr (gri halka),
  hazırlanıyor mavi, hazır yeşil; amber yalnız zamanı söyler (ayardaki dakikayı geçen fişin süre rozeti, planlı
  saat), kırmızı alarm ve iptal. Ham Tailwind ölçekleri (`danger-600`, `success-600`...) koyuda değişmez; yalnız
  beyaz yazılı dolu yüzeyde (dolu düğme, alarm süre rozeti, hazır rozeti) kalır, `tests/ui-rules.test.ts` izinli
  listeyle tutar. Renk durumu tek başına taşımaz, yanında yazı ya da ikon olur.
- **Logo:** L'Af, laffogato.net ve uygulama ikonuyla aynı vektör (`src/components/LafMark.tsx`): harfler
  yazının rengi, çekirdek pirinç (açık zeminde `#B08A2E`, koyuda ve gece karosunda `#E8C877`). Yazı tipine
  bağlı değil, Didot'u olmayan Windows ve Android'de de aynı. Favicon, PWA ikonları ve Windows simgesi sitenin
  uygulama ikonu (yeşil kare, krem harfler).
- **Yazı:** Inter 400-700; tutarlar tablo rakamıyla (`.tabular`), `₺1.250` biçiminde (`tlShort`). İkon
  çizgisi 1.75.
- **Ölçü:** dokunmatik hedef en az 44 px (AGENTS.md kural 8), POS düğmeleri 44-64 px.
- **Ödeme penceresi** üç yol: Tutar (nakit ya da kart, para üstü), Kalem (seçili kalemler), Paylaş (hesap N
  kişiye eşit bölünür, paylar sırayla ve istenen yöntemle alınır; pay tutarını sunucu hesaplar,
  `shared/order-calc.ts` `splitState`). Yazarkasada fiş tek kesilir, paylar cihazda ayrı ödeme.
- **Adisyon:** geniş ekranda kategoriler solda dikey liste (sayılarıyla), ürün kartında sitedeki görsel (dekupaj gri
  sahnede, fotoğraf sahneyi doldurur, görseli olmayanda baş harfler); "/" aramaya götürür.
- **Müşteriye dönük ekranlar** (kasa menüsü olmadan, otomatik kilit yok): çağrı ekranı `/cagri` (Hazırlanıyor ve
  büyük numaralı Hazır), müşteri ekranı `/musteri-ekrani` (kalemler ve büyük tutar; teşekkür; hoş geldiniz).
  İkisi de ilk karesinden koyu açılır (gece loş salonda en parlak yüzey olmasın); müşteri ekranı `?tema=acik` ile
  açık açılır.
- **Grafik:** tek seri tek renk (birincil mavi), kıyas serisi gri çizgi, tek eksen; tutar ekseninde kesirli
  adım yok, verisi olmayan dönemde eksen yerine ekranın zamanını söyleyen boş durum çizilir (Bugün henüz satış
  yok, Bu günde satış yok, Bu dönemde satış yok; `ColumnChart` `emptyLabel`, `src/components/charts.tsx`).

## 2. Yönetim paneli (Innex)

Kaynak `docs/ADMIN-INNEX.md` (Filllo'nun Innex serisinin ölçülmüş tarifi) ve laffogato'nun aynı tarifle
yaptığı panel (değer adları aynı: `--admin-*`). Panel açıkken `<html data-area="admin">`; LafPOS'un ortak
değerleri (`--bg`, `--ink`, `--primary`...) Innex'e döner, ortak bileşenler de Innex görünür.

| Rol | Açık | Koyu (LafPOS eklemesi) |
|---|---|---|
| Zemin (kartların arası) | `#EDEFF1` | `#0D0F13` |
| Kart | `#FFFFFF` | `#16191F` |
| Kuyu (tablo başlığı) | `#F9FBFC` | `#1B1F26` |
| Gri (etkin menü, sayaç, segment rayı) | `#F3F5F7` | `#232832` |
| Çizgi / satır ayracı / alan kenarı | `#E8E8E8` / `#F2F2F2` / `#898D94` | `#2A2F38` / `#20242C` / `#6F7682` |
| Mürekkep / gövde / etiket | `#0C0E1B` / `#3D4048` / `#616367` | `#F2F4F7` / `#C9CDD4` / `#9AA1AC` |
| Birincil | `#2F58F7` (üstünde beyaz) | `#7B93FF` (üstünde `#0B1020`) |
| Durum tonları | yeşil `#15803D`, turuncu `#B45309`, kırmızı `#B42318`, camgöbeği `#0B7392`, mor `#6D3FEA` (açık zeminleriyle) | aynı roller, açık tonlar |

- **Yerleşim** (Innex §1.1): gri zemin üstünde iki beyaz kart, köşe 12, pencereye 8 px, aralarında 12 px.
  Kenar çubuğu 15.5rem; sayfa kartının ilk şeridi üst çubuk (yol, ⌘K arama, sıkı görünüm, canlı bağlantı),
  altında sayfa başlığı şeridi (18 px başlık, 13 px açıklama, sağda önce ikincil sonra birincil düğme).
- **Kenar çubuğu:** gruplar büyük harfli küçük etiketle (Genel, Menü, Salon ve kasa, Ekip, Bağlantılar,
  Sistem), etkin satır gri ve renksiz, sayaç yalnız iş bekleyen yerde (tükenen ürün, gönderilemeyen gün).
  Altta "Kasa ekranlarına dön", "Menüyü daralt" ve kullanıcı.
- **Yazı:** Inter 400-700 (`@fontsource/inter`, çevrimdışı), rakamlar tablo hizalı. Etiketler cümle
  düzeninde; büyük harf yalnız kenar çubuğu grup etiketlerinde.
- **Bileşenler** (`src/components/admin/ui.tsx`): `PageHeader`, `Card`, `KpiStrip` (tek kart, hücreler
  arası 1 px, her rakamın yanında referans), `StatusTabs` (sayılı kutu çipler), `Segmented` (gri ray, beyaz
  hap), `DataTable` (kuyuda başlık, satır ayracı, yapışkan eylem sütunu), `ActionMenu` (⋯, köşe 10, portalda),
  `QuickLook` (sağdan hızlı bakış ve düzenleme çekmecesi, karartma %20), `ActionRows`, `Timeline`, `Badge`,
  `EmptyState`, `SearchField`. Düğme köşe 8, 14 px; dokunmatikte 44, farede 36, sıkı görünümde 32 px.
- **Sayfalar:** Genel bakış (KPI şeridi: net ciro geçen haftanın aynı günü aynı saatine göre, adisyon,
  açık adisyon, indirim ve ikram, online sipariş; saatlik grafik; en çok satanlar; dikkat isteyenler;
  sistem sağlığı), Ürünler, Seçenekler, Masa planı, Ödeme türleri, Personel ve yetki, Yazarkasa, Site ve
  lafmaliyet, Ağ ve uzaktan erişim (yerel adres ve Tailscale karekodu), Ayarlar, Denetim kaydı (zaman çizelgesi), Raporlar (dönem segmenti, rapor sekmeleri, önceki
  dönemle KPI şeridi).

### LafPOS'un Innex'e ve laffogato'ya göre eklemeleri ("biraz daha geliştir")

1. **Koyu tema:** Innex ve laffogato paneli yalnız açık. LafPOS kafede gece de açık; aynı roller koyu
   değerlerle, her çift AA'da test ediliyor.
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

## 3. Ortak bileşenler ve etkileşim (28 Ekim 2026 yenilemesi)

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

## 4. Telefon ve tablet (impeccable `adapt`)

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
