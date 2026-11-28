# Kasa bilgisayarı: Windows kurulumu, kasa programı

AsilPOS'un sunucusu kafedeki **kasa bilgisayarında** çalışır; kasa ekranı aynı bilgisayarda bir program gibi tam ekran
açık durur (kasa programı: kendi simgesi ve kısayolu, tek pencere, Windows açılınca kendiliğinden; §3 ve §9). Tezgâh tableti, garson telefonları ve bar ekranı aynı sunucuya kafenin ağından bağlanır
(`http://<kasa-ip>:4000`). Ödeme yazarkasa POS'a gider (`docs/04-YAZARKASA.md`), fişler 80 mm yazıcıdan
sessizce çıkar. Neden tek sistem: `docs/06-TEK-SISTEM.md`.

## 1. Gerekenler

| | |
|---|---|
| Bilgisayar | Windows 10/11 (önerilen) ya da macOS; SSD, 8 GB bellek yeter |
| Yazılım | Google Chrome (güncel; yoksa Windows'un Edge'i kullanılır). Kurulum dosyasıyla başka bir şey gerekmez (geliştiricinin git ile kurulumunda Node.js 24 LTS, 22.11 ile 24 arası, ve Git) |
| Fiş yazıcısı | 80 mm termal; Windows'ta **varsayılan yazıcı** yapılır, kağıt 80 mm |
| Para çekmecesi | Yazıcıya bağlı; açılması yazıcı sürücüsünün "belge yazdırılınca çekmeceyi aç" ayarıyla (tarayıcı çekmece açamaz) |
| Ağ | Kasa bilgisayarına sabit IP (modemde DHCP rezervasyonu); tablet ve telefonlar aynı ağda |
| Yazarkasa POS | TokenX Connect bilgileri `.env`'de (kurulum dosyasıyla: Başlat › AsilPOS › AsilPOS ayarları) |

## 2. Kurulum (bir kez)

### Windows: kurulum dosyası (önerilen)

`AsilPOS-Kurulum.exe` GitHub'daki sürüm sayfasından (Releases › Latest; `main`'e her push'ta yayımlanır) bir kez
indirilir; Node, Git ya da komut satırı gerekmez, sahibin adımları README'de ("Windows'a kurulum"). Sonraki
sürümleri kasa kendisi alır (§6). Dosya imzasız olduğu için Windows "Bilgisayarınız korundu" der: **Ek bilgi ›
Yine de çalıştır**. Kurulum yönetici izni ister, başka bir şey sormaz (sayfa yok; §9 "Sorusuz kurulum") ve şunları
yapar:

| | |
|---|---|
| Uygulama | `C:\Program Files\LafPOS`: Node 24 LTS (24.22.3), sunucu, arayüz, kasa kısayolu. Yalnız yöneticiler değiştirir |
| Veri | `C:\ProgramData\LafPOS`: veritabanı, `secret.key`, günlük yedekler (`backups\`), `ayarlar.env`, sunucu günlüğü (`logs\`). Yalnız SYSTEM ve yöneticiler açar |
| Sunucu | Görev Zamanlayıcı'da "LafPOS Sunucu": Windows açılınca SYSTEM olarak, kimse oturum açmasa da; süre sınırı yok, pilde de çalışır. Görev bekçiyi başlatıcıdan açar (`baslat.cmd`, çalışma klasörü kurulum klasörü): otomatik güncelleme bekçiyi 75 koduyla kapatınca başlatıcı onu yeni sürümle yeniden açar, güncelleme Node'u da değiştirdiyse önce `node.yeni`'yi `node`'un yerine koyar. Bekçi (`app\bekci.mjs`) düşen sunucuyu 1-30 sn içinde yeniden başlatır; bekçi düşerse görevin beş dakikalık güvence tetiği yeniden açar. Sunucunun JavaScript belleği sınırlı (`--max-old-space-size`): varsayılan bilgisayarın belleğinin dörtte biri, en az 1024, en çok 4096 MB (8 GB'lık bilgisayarda 2048). Bir sızıntı kasa bilgisayarının belleğini bitirmez, sınıra varan sunucu düşer ve bekçi yeniden açar; taban, uzun dönem raporunun (bir yıl, iki dönem birden) sığması için. Gerekirse `ayarlar.env`'de `ASILPOS_MAX_HEAP_MB` (256-4096; örnek dosyada açıklamalı, yorumlu satır); bekçi seçilen sınırı günlüğe yazar |
| Güvenlik duvarı | TCP 4000 yalnız kafenin ağına ve Tailscale'e (`100.64.0.0/10`) açık |
| Kısayollar | Masaüstünde ve Başlangıç'ta "AsilPOS Kasa" (her kurulumda; Başlangıç'ta yanında kasa bekçisi); Başlat › AsilPOS: kasa, tarayıcıda aç, ayarlar, sunucuyu yeniden başlat, sunucu günlüğü, kurulum notları, kaldır. "AsilPOS Kasa" kasa programını konsolsuz açar (§3). Liste tek yerde (`kurulum-yenile.mjs` `shortcutSpec`): kurulum dosyası, siteden kurulum ve güncelleme aynı betikle yazar (§9) |
| Güç | "Prizdeyken uyku kapalı" (her kurulumda): uyku, hazırda bekletme ve USB'nin seçmeli askıya alınması prizdeyken kapanır (`powercfg`; uyuyan bilgisayara tablet bağlanamaz, uyuyan USB'deki fiş yazıcısı ve dokunmatik ekran kopar). Ağ kartının güç tasarrufu elle kapatılır: Aygıt Yöneticisi › Ağ bağdaştırıcıları › kart › Güç Yönetimi › "Güç tasarrufu için bilgisayarın bu aygıtı kapatmasına izin ver" işaretsiz (BENIOKU'da da yazar) |

- **Ayarlar** (site, lafmaliyet, AsilPOS Uzaktan, Token ve paket platformu anahtarları): programın içinden,
  **Yönetim › Bağlantı bilgileri** (aşağıda). Dosyanın kendisi `C:\ProgramData\LafPOS\ayarlar.env`; Başlat › AsilPOS ›
  AsilPOS ayarları onu Not Defteri'nde de açar. Kaydedince (panelden ya da Ctrl+S) bekçi değişikliği (5 sn'de bir
  bakar) görür ve sunucuyu yeni ayarlarla yeniden başlatır. Pavo'nun adresi ve seri no'su bu dosyada değil, Yönetim ›
  Yazarkasa POS'ta (`docs/04-YAZARKASA.md` §8.1).
  İlk kurulumda site bağlantısı kapalıdır (`LAFFOGATO_URL` satırı yorumlu): AsilPOS siteye hiç bağlanmaz, menü
  kurulumdaki gibi kalır. Açmak için `docs/03-ENTEGRASYON.md` §8 (açılış sırası).
- **Güncelleme:** kendiliğinden (§6). Elle: yeni kurulum dosyasını çalıştırın. Bu bilgisayarda daha yeni bir derleme
  kuruluysa bir şey değiştirmez; aynı anda ikinci kurulum çalışmaz. Gün açıksa sorar (sessiz kurulumda kurmaz), yeni
  sürümü önce yan klasöre (`kurulum.gecici`) açar, sunucuyu durdurur, veritabanını
  `backups\lafpos-guncelleme-<tarih>.db` olarak kopyalar, uygulamayı eskisiyle yer değiştirir (yazılamazsa ya da kurulum
  başka bir yerde yarıda kalırsa eski sürüm döner, sunucu eskisiyle açılır), güncelleme isteğini yazar, sunucuyu başlatıp
  bu sürümle (ya da isteğin hemen getirdiği daha yenisiyle) açıldığını bekler (en çok 2 dk); veri ve ayarlar kalır. **27 Ekim 2026'dan önceki kurulumu güncellerken:** eski `ayarlar.env`'de
  `LAFFOGATO_URL=https://laffogato.net` satırı yorumsuz durur (o günkü örnek dosyadan gelir) ve güncelleme ayar
  dosyasına dokunmaz; site bağlantısı açık kalır. Açılış sırasına (`docs/03-ENTEGRASYON.md` §8) kadar satırı silin
  ya da başına `#` koyun.
- **Kaldırma:** Ayarlar › Uygulamalar › AsilPOS. Görev, güvenlik duvarı kuralı ve kısayollar gider, kasa penceresi ve
  kasa bekçisi kapanır, veri klasörü kalır.
- **Daha önce git ile kurduysanız:** önce `kur.ps1 -Kaldir` ve bilgisayarı yeniden başlatın; eski `data\`'daki
  `lafpos.db`, `lafpos.db-wal` (varsa), `secret.key` ve `uploads\`'ı `C:\ProgramData\LafPOS`'a kopyalayıp
  kurulumu çalıştırın. Veritabanı WAL kipinde: son işlemler `-wal` dosyasında durabilir, onsuz kopya eksik kalır
  (sunucu beş dakikada bir ve düzgün kapanırken bunları ana dosyaya yazar). `secret.key` olmadan eski PIN'ler
  çalışmaz.
- **Kurulum klasörü sabit** (`C:\Program Files\LafPOS`, seçim yok): görev oradaki `node.exe`'yi SYSTEM olarak
  çalıştırır; standart kullanıcının yazabildiği bir klasörde kasiyer hesabı SYSTEM yetkisi alabilirdi.
- **Açılmıyorsa:** imzasız dosyada Windows "Bilgisayarınız korundu" der (Ek bilgi › Yine de çalıştır). Windows
  11'de Akıllı Uygulama Denetimi açıksa imzasız dosyalar (kurulum ve `better_sqlite3.node`) engellenir:
  Windows Güvenliği › Uygulama ve tarayıcı denetimi'nden bakın. Kalıcı çözüm kod imzası (aşağıda).
- **Kod imzası (sertifika alınırsa):** bugün dosya imzasızdır ve "Yine de çalıştır" adımı gerekir. Uyarının hiç
  çıkmaması için bir kod imzalama sertifikası gerekir; en kolayı Microsoft'un **Azure Trusted Signing** hizmeti
  (aylık ücretli, kimlik doğrulaması şirket adına yapılır) ya da bir sertifika sağlayıcısının (Sectigo, DigiCert)
  EV/OV kod imzalama sertifikası (yıllık ücretli, donanım anahtarıyla gelir). Sertifika alınınca yapılacaklar:
  `.github/workflows/windows.yml`'de "Sürümü yayımla"dan önce bir imzalama adımı (Trusted Signing için
  `azure/trusted-signing-action`; anahtarlar depo sırlarına), imzalanacaklar `AsilPOS-Kurulum.exe` ve paketteki
  `node.exe` dışındaki ikililer (`better_sqlite3.node`, Kaldir.exe). İmzalı dosyada SmartScreen itibarı birkaç
  yüz indirmede oluşur; EV sertifika uyarıyı hemen kaldırır.

### Bağlantı bilgileri (Yönetim › Bağlantı bilgileri)

Kurulumdan sonra sahibin dosya açması gerekmez: dış sistemlerin adresleri ve anahtarları programın içinden girilir.
Kod: katalog `shared/baglanti.ts`, dosya yazımı `server/lib/ayar-dosyasi.ts`, uçlar `GET`/`PUT /api/admin/baglanti`,
ekran `src/pages/admin/ConnectionsAdmin.tsx`, testler `tests/baglanti.test.ts` (e2e akışı da yazar).

- **Ne yazılır:** yalnız katalogdaki anahtarlar: lafmaliyet (`LAFMALIYET_URL`, `LAFMALIYET_SYNC_SECRET`), AsilPOS
  Uzaktan (`ASILPOS_CLOUD_URL`, `ASILPOS_CLOUD_SECRET`, isteğe bağlı şube anahtarı `ASILPOS_CLOUD_SUBE_SECRET`;
  `docs/07-UZAKTAN-ERISIM.md` §6), site (`LAFFOGATO_URL`, `LAFFOGATO_SYNC_SECRET`; deneme
  bittikten sonra, `docs/03-ENTEGRASYON.md` §8), Token (`TOKENX_*`, `ASILPOS_PUBLIC_URL`), Yemeksepeti, Getir ve
  Trendyol Go. Bilinmeyen anahtar 400. Adres http(s) olmalı, gizli anahtarın en kısa boyu denetlenir (Uzaktan ve site
  32, webhook 16), boşluk, tırnak ve satır sonu kabul edilmez; boş değer satırı kaldırır.
- **Neden veritabanında değil:** veritabanı buluta yedeklenir ve yedeğin şifresi `ASILPOS_CLOUD_SECRET`'ten türer;
  anahtarlar dosyada kalır, veritabanı dosyası tek başına sızarsa anahtar sızmaz.
- **Yetki:** görmek ayar yetkisiyle (`ayar.yonet`), yazmak yalnız patron (yanlış adrese satış verisi gidebilir).
  Gizli anahtarların değeri hiçbir yanıtta dönmez, yalnız "tanımlı" bilgisi; alan boş gelir, yazılırsa değişir.
  Denetim kaydına `ayar.baglanti` düşer: anahtarların adı ve adreslerin yenisi, gizli değer değil.
- **Dosya:** etkin satır yerinde değişir (aynı anahtarın tekrarı düşer), yoksa örnek dosyadaki yorumlu satırın
  (`# ANAHTAR=`) altına, o da yoksa sona "Yönetim › Bağlantı bilgileri" başlığıyla eklenir. Öbür satırlar, yorumlar,
  BOM ve CRLF korunur; önce geçici dosyaya yazılıp yerine konur. Bekçi dosyanın yerini sunucuya `ASILPOS_AYAR_DOSYASI`
  ile söyler (eski bekçide veri klasöründeki `ayarlar.env`).
- **Yeniden başlama:** bekçi dosyanın değiştiğini görüp sunucuyu yeni ayarlarla açar (birkaç saniye, tabletler bekler).
  Ekran dosya ile çalışan sunucunun ayarları aynı olana dek "AsilPOS yeni bilgilerle yeniden başlıyor" der
  (`pending`), sonra "yeni bilgilerle açıldı".
- **Hazır satırları yapıştır:** sahibe verilen ayar satırları (`asilpos-kasa-ayarlari.env`) olduğu gibi yapıştırılır;
  bilinen anahtarlar tek kayıtta yazılır, `PAVO_URL` ve `PAVO_SERIAL` Pavo'nun ayarına gider, satır sonundaki
  "(deneme bittikten sonra)" gibi notlar düşer, tanınmayan satırlar söylenir.
- Git ile çalışan sunucuda ve tarayıcı demosunda panelden yazılmaz (`.env` elle); e2e sunucusu veri klasöründe bir
  `ayarlar.env` ile açılır (`ASILPOS_AYAR_DOSYASI`).
- **Şube kurulumu kartı** (27 Kasım 2026, salt durum): kasanın şubesi (seçilmediyse neyin beklediği), ladmin'e verilmeyi
  bekleyen kurulum kodu, son denemenin saati ve hatası (kalıcı hata: ladmin › Şubeler'den yeni bağlantı; geçici hata:
  kod durdukça 5 dakikada bir yeniden denenir) ve Merkez kapalıyken (`ASILPOS_MERKEZ_URL=0`) Marina dışındaki şubenin
  uyarısı. Görmek ayar yetkisiyle; kod ve anahtar gösterilmez (`docs/03-ENTEGRASYON.md` §4c).

**Kurulum dosyasını derlemek** (macOS, Linux ya da Windows): `npm run kurulum:windows`; gereken NSIS
(`brew install makensis`, `apt install nsis`; Windows'ta NSIS 3, PATH'te değilse `Program Files\NSIS`'te aranır,
`MAKENSIS` ile de verilir). Betik (`scripts/kasa/windows/kurulum/derle.mjs`) arayüzü derler, sunucuyu esbuild'le
tek dosyaya paketler, nodejs.org'dan Node'u ve better-sqlite3'ün Windows ikilisini indirir, paketi bekçi üzerinden
açıp dener (göçler, ilk kurulum, giriş, açılış verisi, arayüz, ayar değişince yeniden başlama, düzgün kapanış:
`-wal` kalmaz), sonra `dist/windows/AsilPOS-Kurulum-<sürüm>.exe`'yi üretir. Deneme Windows'ta kafeye gidecek
çiftle koşar (paketteki `node.exe` ve indirilen `better_sqlite3.node`); macOS ve Linux'ta Windows ikilisi
yüklenemediği için bu bilgisayarın Node'u ve kendi sqlite ikilisi konur, gerisi aynı paket. Windows'a giden iki ikili
`scripts/kasa/windows/kurulum/surumler.mjs`'te: `NODE_VERSION` (24 LTS'in son güvenlik sürümü), `NODE_ABI`
(nodejs.org/dist/index.json'da "modules"; better-sqlite3'ün ikilisi buna göre iner) ve `NODE_SHA256` (o sürümün
`SHASUMS256.txt`'sindeki `win-x64.zip` özeti; indirilen zip hem listeye hem bu sabite uymalı) birlikte değişir;
`SQLITE_SHA256` better-sqlite3'ün sürümüne göre Windows ikilisinin (`…-node-v<ABI>-win32-x64.tar.gz`) özetidir,
kilit dosyası better-sqlite3'ü yükseltince yeni satır eklenir (yoksa kurulum ve güncelleme kanalı derlenmez).
Kurulum dosyası ile güncelleme kanalı aynı uygulama yükünü kurar (`paket.mjs`: tek dosyalık sunucu, arayüz,
göçler, menü anlık görüntüsü, bekçi ve güncelleyici); sunucuya çalışırken diskten dosya okuyan yeni bir şey
eklenirse (göç, anlık görüntü gibi) orada pakete de eklenir.

**CI'da Windows** (`.github/workflows/windows.yml`, Linux denetiminden ayrı iş akışı): `main`'e her push'ta,
kasaya giden dosyalara dokunan PR'da (`scripts/kasa/windows/**`, `server/**`, `shared/**`, `drizzle/**`, `package.json`,
kilit dosyası, iş akışının kendisi; kasa penceresinin ilk açılışını etkileyen `index.html`, `public/**`,
`src/lib/buildWatch.ts`, `src/main.tsx`) ve Actions'tan elle `windows-latest` üzerinde Node 22 ile `npm ci`, NSIS (imajda
yoksa `choco install nsis`) ve `npm run kurulum:windows` koşar: kurulum dosyası gerçek Windows'ta derlenir ve paket
kafeye gidecek ikililerle açılıp denenir. Sonra kafedeki yol gerçek Windows'ta baştan sona yürünür
(`scripts/kasa/windows/kurulum/ci-kurulum.mjs`, §9 "Windows CI"): GitHub'daki son sürüm (kafede kurulu olan) kurulur,
kasa penceresi kısayoluyla açılır, bu derlemeye kendiliğinden güncellenir; güncellemeden sonraki ilk açılışta pencerenin
yeni sürümü gösterdiği, kasa programı, geri dönüş, kaldırma ve iki kurulumun eşitliği denetlenir. Ekran görüntüleri iş
akışının dosyalarında (`ci-ekran`). `main`'e push'ta ardından GitHub Release yayımlanır: etiket
`v<major.minor>.<çalıştırma no>`, sabit adlı iki dosya (`AsilPOS-Kurulum.exe`, `AsilPOS-Kurulum.exe.sha256`),
`--latest`; son 10 sürüm kalır (`permissions: contents: write`, iş akışının kendi `GITHUB_TOKEN`'ı; ayrıca anahtar
yok). Kurulamayan ya da güncellenemeyen dosya yayımlanmaz. Linux işiyle paralel, onu beklemez. İndirilen Node ve sqlite
ikilisi `actions/cache`'te durur. Özel depoda Windows dakikası Actions kotasından iki kat düşer; yalnız arayüze dokunan
PR bu yüzden onu koşmaz.

**CI'ın denetleyemedikleri** (ilk gerçek kurulumda bakılır): gerçek yeniden başlatma ve otomatik oturum açma, dokunmatik
ekran, ikinci ekran (müşteri ekranı), kafenin fiş yazıcısı ve çekmecesi, SmartScreen ve Akıllı Uygulama Denetimi,
tabletin kafenin ağından bağlanması. İlk kurulumda: bilgisayar yeniden başlayınca sunucu ve kasa ekranı kendiliğinden
geliyor; `C:\ProgramData\LafPOS\logs\sunucu.log` yazılıyor; tablet bağlanıyor; deneme fişi önizlemesiz basılıyor.

### Yeni şube: ladmin'den kurulum

Yeni şubede kurucu ladmin'den gelir: ana yönetici şubeyi e-postasıyla ekleyince şubenin e-postasına (ve şube hesabının
Hesabım sayfasına) şubeye özel indirme bağlantısı gider. Kasa bilgisayarında açılıp inen `AsilPOS-Kur-<şube>.cmd`
çalıştırılır; kurulum bitince kasa şubesini, gün sonu bağlantısını ve AsilPOS Uzaktan'ı kendiliğinden alır, Merkez'e
şubenin adıyla kaydolur. Şube kimliği ya da anahtar elle yazılmaz (`docs/03-ENTEGRASYON.md` §4b).

**Her şubenin kendi kasası (27 Kasım 2026).** Yeni kurulum şubesiz açılır (eskiden `marina` varsayılırdı): şube ladmin
kurulumundan gelene dek gün sonu, devir, personel listesi, site ve platform anahtarları bekler; Yönetim › Bağlantı
bilgileri › Şube kurulumu ve Entegrasyon bunu söyler, hata vermez. Kapanan günler giden kutusunda kalır, şube gelince
hemen gider. Kurulum kodu olmadan elle kurulan kasada şubeyi patron Yönetim › Ayarlar ve yedek › Şube kimliği'ne yazar.
Çok şubeli sürümden önce kurulmuş kasa (geçmişi olan, şube satırı olmayan) bu sürümdeki ilk açılışında `marina`'yı
kalıcı yazar ve Marina'nın kasası olarak sürer; bu denetim veritabanı başına bir kez yapılır, yeni kasanın deneme günleri
ve sonraki açılışları onu Marina yapmaz. Bugünkü panel tek AsilPOS şubesinin gününü alır: ikinci şubenin günleri
`wrong_branch` ile kasada bekler, günde bir yeniden denenir; panel şubeyi kasanın anahtarından tanıyınca kendiliğinden,
kasa yeni anahtarla (aynı şubenin yeni kurulum bağlantısı) açılınca hemen gider. Ayrıntı `docs/03-ENTEGRASYON.md` §4c.

### İlk açılış: deneme modu, sonra gerçek kullanım

Yeni kurulumda sahte işletme verisi yoktur: adisyon, ödeme, gün, müşteri, rezervasyon, platform siparişi yok
(`tests/deneme-modu.test.ts`). Yalnız başlamak için gerekenler gelir: rol hesapları (Patron, Müdür, Kasa, Garson,
Bar ekranı; örnek PIN'li), Bar ve Mutfak istasyonları, tarayıcı yazıcısı, köşkün masa planı ve karaoke odası, ödeme
türleri, sitenin menüsü (pakette anlık görüntü; site bağlantısı açılınca güncellenir) ve kasaya özgü ürünler (karaoke
saati, kişi başı ve etkinlik ücreti, yenilebilir bardak, şeker ve bardak seçimi). Örnek kampanya (happy hour) yalnız
tarayıcı demosunda (`seedIfEmpty({ demo: true })`, ya da `ASILPOS_DEMO_SEED=1`).

Kurulum **deneme modunda** açılır (`docs/03-ENTEGRASYON.md` §4.3): giriş ekranında örnek PIN'ler, yazarkasa eğitim
simülatöründe, her ekranın üstünde "Deneme modu: yapılan satışlar gerçek sayılmaz" şeridi. Bu sırada kapanan gün
eğitim günüdür, lafmaliyet'e gitmez. Kafede her şey gönül rahatlığıyla denenir (satış, ödeme, iptal, gün sonu,
tabletler, yazıcı).

Deneme bitince patron: her ekranın üstündeki deneme şeridinde **Denemeyi bitir** (yalnız patrona görünür; gün açıksa
önce gün sonunu ister) ya da Yönetim › Ayarlar ve yedek › Deneme modu › **Denemeyi bitir, gerçek kullanıma başla**;
ikisi aynı pencereyi açar.
Yalnız patron görür ve çalıştırır; kendi PIN'iyle onaylar. Açık gün varken (önce gün sonu) ve deneme dışında kapanmış
gerçek gün varken çalışmaz. Sırasıyla:

1. Veritabanının yedeği alınır: `backups\lafpos-deneme-oncesi-<an>.db` (günlük yedeklerin döngüsüne girmez,
   silinmez). Yedek alınamazsa hiçbir şey silinmez.
2. Tek işlemde bütün deneme hareketleri silinir: adisyonlar ve satırları, ödemeler, yazarkasa fişleri, oda
   sayaçları, iş günleri ve Z'ler, kasa hareketleri, vardiya sayımları, rezervasyonlar, paket platformu
   siparişleri, müşteriler ve açık hesapları, denetim kaydı, lafmaliyet'e bekleyen kayıtlar, yazarkasanın deneme
   sayaçları. Kalanlar: menü, personel ve roller, masa planı ve QR kodları, ödeme türleri, istasyonlar, yazıcılar,
   bütün ayarlar, siteye bekleyen kurulum yazımları.
3. Örnek PIN'ler kapanır: patron PIN'i hâlâ örnekse aynı pencerede yeni PIN'ini verir; örnek PIN'iyle duran öbür
   hesaplar kapatılır (Personel'den yeni PIN verilip açılır). Gerçek kullanımda örnek PIN'ler bir daha verilmez.
4. Kurulum modu kapanır, yazarkasa simülatörden **Kapalı**'ya geçer (Pavo'yu patron Yönetim › Yazarkasa POS'tan
   seçer), paket platformlarının Deneme modu kapanır. Z numarası baştan (ya da İlk Z numarasından) başlar.
5. Denetim kaydına tek bir uyarı düşer (`deneme.bitir`: silinen sayılar, yedeğin adı, kapatılan hesaplar).
6. AsilPOS Uzaktan bağlıysa silinen günler oradan da en geç 5 dk'da kalkar (raporu boşaltılır; o tarihte geçmiş ciro
   günü varsa o görünür; `docs/07-UZAKTAN-ERISIM.md` §4 "Silinen günler"). "Geçişi tamamla" da aynı.

Bir kez çalışır (`liveSince` ayarı): yeniden basmak hiçbir şey silmez. Sonra kurulum modu yeniden açılmaz.

### Git ile (yalnız geliştirici; Windows ya da macOS)

Kafedeki kasa bilgisayarına bu yol **kurulmaz**; orada kurulum dosyası kullanılır. `kur.ps1` sunucuyu `npm start`
ile (tsx: TypeScript her açılışta yeniden derlenir) çalıştırır: bekçi, bellek sınırı ve günlük dönmesi yoktur,
`data/sunucu.log` sınırsız büyür. Geliştiricinin kendi bilgisayarında denemek içindir.

```bash
git clone https://github.com/okanberk-dev/lafpos.git
cd lafpos
npm ci
npm run build
copy .env.example .env    # macOS: cp .env.example .env ; sonra değerleri doldurun
```

Windows (PowerShell):

```bash
powershell -ExecutionPolicy Bypass -File scripts\kasa\windows\kur.ps1
```

macOS:

```bash
sh scripts/kasa/mac/kur.sh
```

Kurulum betiği şunları yapar:

1. **Sunucu kendiliğinden başlar:** oturum açılınca `npm start` görünmeden çalışır (Windows'ta Görev
   Zamanlayıcı "LafPOS Sunucu", macOS'ta launchd). Çökerse bir dakika içinde yeniden başlar; çıktı
   `data/sunucu.log`.
2. **Kasa ekranı kendiliğinden açılır:** Başlangıç klasörüne (macOS'ta oturum ajanı) "AsilPOS Kasa" kısayolu
   konur; masaüstüne de. Kısayol sunucu hazır olana dek bekler, sonra Chrome'u kiosk açar.
3. Kaldırmak için aynı betik `-Kaldir` (Windows) ya da `--kaldir` (macOS) ile; veriler (`data/`) silinmez.

Windows'ta ayrıca: Ayarlar › Hesaplar › Oturum açma seçeneklerinde otomatik oturum açmayı ve
Güç ayarlarında "ekranı kapatma: hiçbir zaman", "uyku: hiçbir zaman"ı seçin.

## 3. Kasa programı ve kiosk tarayıcının ayarları (`app\kasa-yazici.ps1 -Ac`)

**Kasa programı (27 Kasım 2026, sahibin isteği: "tamamen bir program olacak şekilde").** Masaüstündeki, Başlat
menüsündeki ve Başlangıç'taki **AsilPOS Kasa** kısayolu konsolsuz PowerShell'le `app\kasa-yazici.ps1 -Ac`'yi açar
(görev çubuğunda konsol yok; eskiden `AsilPOS-Kasa.bat` 90 sn'ye kadar küçültülmüş bir konsolla bekliyordu):

1. Kasa penceresi zaten açıksa **öne getirir** (küçültülmüşse açar): ikinci tıklama ikinci pencere açmaz. İki tıklama üst
   üste gelirse ikincisi beklemez.
2. Açık değilse tam ekran markalı **açılış penceresi** görünür (28 Kasım 2026, sahibin isteği: "estetikleştir,
   hızlandır"): ev yeşilinin degradesi (DESIGN.md marka rayının üç durağı), ortada AsilPOS simgesi, "AsilPOS açılıyor" ve
   "Kasa ekranı hazırlanıyor"; görev çubuğunda AsilPOS simgesiyle, kendi iş parçacığında (bekleme onu dondurmaz). Sıra:
   açılış penceresi, sunucu (en çok 90 sn), **kasa penceresi** (ekrana gelince açılış penceresi kapanır), sonra müşteri
   ekranı ve yazıcılar. Yazıcı sorgusu 15 sn'ye kadar sürebildiği için pencereyi artık bekletmez; ilk fişten önce biter
   (araya PIN girişi girer). Müşteri ekranı yeni açıldıysa kasa penceresi yeniden öne gelir (klavye ve barkod okuyucu
   kasaya yazar). Sunucu 20 sn'de gelmezse yazı "Sunucu bekleniyor..." olur; Esc her an, 20 sn'den sonra ekrana dokunmak
   da açılış penceresini kapatır (kasiyer kilitlenmez, kasa sunucu gelince yine açılır). Sunucu 90 sn'de gelmezse pencere
   açılmaz (hata sayfası kalmaz): kısayol bir açma isteği bırakır (kasa profilinin yanında `kasa-ac.istek`), sunucu
   gelince bekçi pencereyi açar ve isteği siler (30 dakikadan eski istek sayılmaz). Sunucu hazırsa bekçiye pencereden
   sonra bakılır; değilse beklemeden önce (sunucu geç gelirse pencereyi o açar).

**Kapatınca kapanır** (sahibin isteği, 28 Kasım 2026; bekçi sürümü 6): kullanıcı kasa penceresini kapatırsa bekçi onu
yeniden açmaz (eskiden 15 sn içinde açıyordu) ve müşteri ekranını da kapatır; uygulama "AsilPOS Kasa" kısayoluyla
yeniden açılır. Bekçi müşteri ekranını yalnız kasa penceresi açıkken açık tutar. Güncelleme pencereyi kapatmaz
(sayfa yeni sürümü kendisi yükler); güncellemeyle gelen yeni betik bekçiyi oturum kapanmadan yeniler.

**Çöken pencere geri gelir** (28 Kasım 2026; bekçi sürümü 7). Sürüm 6 kullanıcının kapattığıyla çökeni ayırmıyordu:
vardiya ortasında tarayıcı düşerse kasa ve müşteri ekranı kapanır, kasiyer masaüstünde kalırdı. Chromium (Chrome da Edge
de) açılıştan birkaç saniye sonra profilin `Default\Preferences` dosyasına `profile.exit_type` = `"Crashed"` yazar; düzgün
kapanınca (Alt+F4, kapatma düğmesi) `"Normal"`, Windows oturumu kapanırken `"SessionEnded"`. Süreç çöker ya da zorla
kapatılırsa (Görev Yöneticisi'nde "Görevi sonlandır", bellek) `"Crashed"` kalır; tarayıcı "sayfaları geri yükle" sorusunu
da buna göre sorar. İkinci işaret sürecin çıkış kodu: bekçi pencereyi görünce sürecin tutamağını alır, düzgün kapanışta
kod 0'dır. Bekçi pencereyi yalnız dosya iki okumada da (3 sn arayla) `"Crashed"` derse ve çıkış kodu 0 değilse çökmüş
sayar; o zaman açma isteği bırakır, pencere sunucu gelince (en geç yarım dakikada) yeniden açılır ve öne gelir. Dosya
okunamazsa, değer yoksa ya da başkaysa, çıkış kodu 0 ise çökme sayılmaz: emin olunamayan pencere açılmaz. Tarayıcı
değeri açılıştan ~10 sn sonra diske yazdığı için açılır açılmaz çöken pencere de açılmaz (güvenli taraf). Bakım arasında
(aşağıda) çöken pencere açılmaz; tarayıcı her açılışta çöküyorsa döngü olmasın diye 10 dakikada en çok 3 kez açılır,
sonra kısayolla açılır. Bekçinin görmediği pencere (bekçi açılmadan önce kapanan) için karar verilmez. Pencere açıkken
bekleyen açma isteği silinir: kullanıcının sonra kapattığı pencere eski bir istekle yeniden açılmaz. Windows CI ikisini
de gerçek Chrome'la dener (§9): düzgün kapatılan (pencereye kapatma iletisi) gelmez, zorla kapatılan gelir.
3. Chrome ya da Edge yoksa Windows uyarısı ("Chrome ya da Edge bulunamadı").

Pencerenin başlığı "AsilPOS", görev çubuğunda ve Alt+Tab'da AsilPOS simgesi (`public/favicon.ico` ve 32 px PNG; sekmede
SVG). Kasa profili ayrı olduğu için pencere kişisel Chrome'dan ayrı durur; Chrome güncellenince açık pencere eski sürümle
çalışmayı sürdürür, yeni Chrome pencere yeniden açılınca gelir. Kasa bekçisi ve tarayıcı kurulum klasöründe çalışır
(`app\` güncellemede taşınabilsin). `AsilPOS-Kasa.bat` eski ya da elle kopyalanmış (görev çubuğuna sabitlenmiş) kısayollar
için aynı programı küçültülmüş açıp (`start /min`; ekranda konsol belirmez) hemen kapanır; betik yoksa (git ile
geliştirici kurulumu) eski yolla Chrome'u açar. Güncelleme bu dosyayı 27 Kasım öncesinin hâli çalışırken (sabah
oturum açılırken sunucuyu bekliyor) değiştirebilir: cmd kaldığı bayttan yeni dosyayı okur. Yeni dosyada o baytlar
(eski hâlin uzun komutlarından sonrası: 881, 1243, 1575) boş etiket satırları; cmd oradan programı açar, program açık
pencereyi öne getirir (ikinci pencere ya da Edge açılmaz; `tests/masaustu-programi.test.ts`).

**Edge (Chrome yoksa ya da `ASILPOS_TARAYICI=edge`):** Edge'in kiosk kipi her zaman InPrivate açar: pencere her yeniden
açılışta oturumu, gönderilmemiş sepeti ve tercihleri kaybediyordu. Artık Edge kalıcı profille tam ekran uygulama
penceresi (`--app=<adres> --start-fullscreen --kiosk-printing`, profil `…\LafPOS\edge`, `--kiosk` ve `--inprivate`
yok); adres çubuğu yine yok, F11 tam ekrandan çıkar. Chrome kiosk kipinde kalır (Chrome'un kiosk'u kalıcı profille).
Kullanıcı ortam değişkeni `ASILPOS_TARAYICI=edge` Chrome kurulu olsa da Edge'i seçer.

Oturum, sepet ve tercihler pencere kapanıp açılınca (kasiyer kapatır, kısayolla açılır) yerinde kalır. Yerel
depoyu Chromium (Chrome da Edge de) diske toplu yazar: değişiklikten yaklaşık 5 sn sonra. Pencere düzgün kapanınca
hepsi yazılır; elektrik kesilir ya da tarayıcı zorla kapatılırsa yalnız son birkaç saniyenin değişikliği kaybolabilir
(Chrome'da da böyle). Windows CI bunu gerçek Edge'le dener (§9): sayfanın yazdığı değer profilin diskine
(`Default\Local Storage\leveldb`) geçince pencere zorla kapatılır, yeniden açılan pencere değeri okur. 27 Kasım'ın ilk
koşusu pencereyi yazımdan 2 sn sonra kapattığı için "tutmadı" görünmüştü; profil kalıcıydı, beklenen deneme yanlıştı.

| Bayrak | Neden |
|---|---|
| `--kiosk` | Tam ekran, adres çubuğu ve sekme yok; kasiyer başka siteye geçemez (yalnız Chrome; Edge'de `--start-fullscreen`) |
| `--kiosk-printing` | Fiş, Z ve X raporu önizlemesiz, doğrudan varsayılan yazıcıdan çıkar |
| `--app=http://localhost:4000/` | Uygulama penceresi; başka bir adres için `ASILPOS_URL` |
| `--user-data-dir=…\LafPOS\chrome` | Kasaya ayrı Chrome profili: kişisel Chrome açık olsa da kiosk ayarları karışmaz |
| `--disable-pinch`, `--overscroll-history-navigation=0` | Dokunmatik ekranda yanlışlıkla yakınlaşma ve kaydırarak geri gitme olmaz |
| `--autoplay-policy=no-user-gesture-required` | Bar ve sipariş zil sesi ilk dokunuşu beklemeden çalar |
| `--no-first-run`, `--disable-session-crashed-bubble`, `--noerrdialogs` | Elektrik kesintisinden sonra "geri yükle" balonu çıkmaz |

**Fiş yazıcısı (kablolu/USB, kendiliğinden):** yazıcıyı USB ile takın; Windows sürücüsünü kurar (kurmazsa
üreticinin sürücüsü). Kasa programı (`app\kasa-yazici.ps1 -Ac`, oturumdaki kullanıcı) kasa penceresini açtıktan sonra
(28 Kasım 2026'dan beri; önceden pencere yazıcı sorgusunu bekliyordu):
bilgisayardaki yazıcıları AsilPOS'a bildirir (`POST /api/kasa/yazicilar`, oturumsuz, yalnız bu bilgisayardan) ve
AsilPOS'un söylediği yazıcıyı o kullanıcının **varsayılan yazıcısı** yapar ("varsayılan yazıcıyı Windows yönetsin"
kapanır); `--kiosk-printing` fişi, Z'yi ve X'i önizlemesiz ona basar. Hangi yazıcı: Yönetim › Ayarlar ve yedek › **Fiş
yazıcısı**'nda seçilen; seçilmediyse PDF, XPS, OneNote ve faks dışındaki tek yazıcı, birden çoksa adından fiş yazıcısı
olduğu anlaşılan tek yazıcı (`server/lib/yazici.ts`, testi `tests/yazici.test.ts`). Kart yazıcıları ve son bildirimi
gösterir; "Bunu kullan" seçer, "Deneme fişi yazdır" kasa bilgisayarında basılınca seçili yazıcıdan çıkar. Seçim kasa
ekranının bir sonraki açılışında geçer (Alt+F4, masaüstünde AsilPOS Kasa). Yazıcılar bir kez sorulur (eskiden iki
kez). Yazıcı adımı hata verirse kasa programının günlüğüne yazılıp geçilir; kasa penceresi zaten açıktır. Betik güncellemeyle gelir (`app\`); kısayolları sunucu bekçisi güncellemeden sonra aynı listeden
yeniden yazar (`kurulum-yenile.mjs`). Chrome bir yazıcıya elle
basıldıysa "son kullanılan"ı hatırlayabilir: yazdırma önizlemesini kapatan Chrome ayarını açmayın.

**Fişin düzeni** (`src/lib/print.tsx`, `src/index.css` `.rc-*`): adisyon, X/Z ve deneme fişi aynı düzende. Başlıkta
işletme adı, fiş üstü, adres, telefon ve Merkez'den gelen şube (dükkân adı ve şube kodu), kalın çizgiler arasında fişin
adı; sonra yer ve adisyon no, tarih, garson. Kalemler adet, ad (uzun ad kesilmez, alta kayar) ve tutar sütununda;
seçenek, not ve kalem indirimi girintili. Ara toplam ve indirim, kalın çizgiler arasında TOPLAM, ödemeler, kalan, KDV
dökümü ve alt yazı. Yazdırma alanı 80 mm, iki yanda 4 mm boşlukla yazı 72 mm (XP-80C'nin basabildiği genişlik); yalnız
siyah yazı ve çizgi (termal kâğıtta gri ve zemin noktalı basılır), sistemin eş aralıklı yazısı (Consolas; yazdırma
anında yüklenecek yazı tipi yok), sütunlu rakam. Tutarlar sunucunun hesabıdır; fiş yeniden hesaplamaz. Adisyona bağlı
müşterinin adı yalnız Yönetim › Ayarlar › İşletme ve fiş › "Fişte müşteri adı" açıkken basılır (varsayılan kapalı;
`tests/fis.test.ts`).

Kiosktan çıkmak: **Alt+F4** (macOS'ta Cmd+Q). Personelin bunu kullanmaması için Windows'ta ayrı bir standart
kullanıcı hesabı önerilir.

Windows kurulumunda kasa bekçisi (`app\kasa-yazici.ps1 -Bekci`) kapatılan kasa penceresini yeniden açmaz (28 Kasım 2026'dan
beri; önceden 15 sn içinde açıyordu, §3 "Kapatınca kapanır"); yalnız kasa kısayolunun bıraktığı açma isteğini yerine getirir
ve çöken pencereyi yeniden açar (§3 "Çöken pencere geri gelir").
Bakım için (Windows ayarı, yazıcı kurulumu, başka bir program) Yönetim › Ağ ve uzaktan erişim › Bu bilgisayar ›
**15 dakika bakım arası** (`ayar.yonet`; `POST /api/admin/kasa-bakim`): bekçi o süre boyunca kısayolun bekleyen açma
isteğini de yerine getirmez, pencere sunucu gelince kendiliğinden açılmaz (`GET /api/kasa/bakim`, oturumsuz, yalnız bu
bilgisayardan; sunucuya ulaşılamazsa ara yok sayılır). Süre bitince ya da **Bakımı bitir**le bekleyen istek yine yerine
getirilir; kalıcı kapatma yoktur. Denetim kaydına yazılır. Kasa kısayolu (`-Ac`) aradan etkilenmez.
Bekçi pencereyi arka planda açar ama öne getirmez (başka bir programın üstüne fırlamaz).

**Bekçi sürümü 5 ve kendini yenileme (27 Kasım 2026).** Bekçi diskteki betiğin özetini 15 sn'de bir karşılaştırır;
otomatik güncelleme `app\`'i değiştirince (betik farklı) kilidini bırakıp yeni betikle yeniden başlar: sonraki pencere
kuralları oturum kapanmayı beklemez. Betik silme paylaşımıyla okunur (güncelleme o an `app\`'i taşıyabilir). Diskteki
betik 5'ten eskiyse (elle geri dönüş) çalışan bekçi sürer. 5'ten önceki bekçi (kendini yenilemeyi bilmez) kasa kısayolunun
güncellemeden sonraki ilk açılışında ya da oturum yeniden açılınca yenisiyle değişir.

**Hız** (28 Kasım 2026, sahibin isteği: "hızlandır"). Açılışı yavaşlatanlar kalktı: Win32 işlevleri (DPI, pencereyi öne
getirme) C# derlemesiyle (`Add-Type`, yavaş kasada 1-3 sn) değil bellekte kurulan tipten çağrılır; tarayıcı önbelleği her
açılışta değil kurulu derleme değişince silinir (§6 "Tarayıcının kendi önbelleği"); yazıcı sorgusu pencereden sonraya
alındı ve bir kez sorulur; bekçi turda tarayıcı süreçlerini bir kez sorar. Arayüzün kendisi de beklerken boş kalmaz:
`index.html` betik yüklenene dek `#root`'ta markalı açılış ekranını (uygulamanın zemini, AsilPOS simgesi ve adı; dış
kaynak yok, koyu temada koyu) gösterir, React ilk çizimde yerini alır (`tests/acilis-ekrani.test.ts`).

### Kasa programının günlüğü

`%LocalAppData%\LafPOS\logs\kasa-programi.log` (oturumdaki kullanıcının, kasa profillerinin yanında; 28 Kasım 2026).
1 MB'a varınca `kasa-programi.log.1`'e döner (tek yedek). Kasa kısayolu (`ac`) ve bekçi (`bekci`) aynı dosyaya yazar;
satır başında an, kip ve süreç numarası. İçinde: her açılışın adım süreleri tek satırda (`acilis: powershell … ms,
denetim … ms, acilis penceresi … ms, sunucu … ms, kasa penceresi … ms, bekci … ms, musteri ekrani … ms, yazicilar … ms;
toplam … ms`), açılış penceresinin göründüğü an, açılan pencereler, silinen önbellek, bekçinin gördüğü ve kapanan
pencereler (`exit_type` ve çıkış kodu, karar), yeniden açmalar, eski bekçinin değişmesi ve eskiden sessizce geçilen her
hatanın iletisi. PIN, parola, anahtar ya da istek gövdesi yazılmaz (`tests/masaustu-programi.test.ts`). Başlat menüsünde
kısayolu yok: dosya Not Defteri'yle açılır. Sunucunun günlüğü ayrı (`C:\ProgramData\LafPOS\logs\sunucu.log`).

### Müşteri ekranı ikinci ekranda (kendiliğinden)

Kasa bilgisayarına ikinci bir ekran takılıysa kasa programı (`app\kasa-yazici.ps1 -Ac`) müşteri
ekranını o ekranda tam ekran açar (`/musteri-ekrani?ekran=kasa`, ayrı Chrome profili `LafPOS\chrome-musteri`); zaten
açıksa yeniden açmaz. Kasa penceresi (Windows'ta, sunucunun çalıştığı bilgisayarda) bu ekrana kendiliğinden yansıtır:
adisyon açıkken kalemler ve tutar, ödemeden sonra teşekkür. İkinci ekranda Windows masaüstü görünüyorsa: ekranın
Windows'ta "Genişlet" modunda olduğuna bakın (Win + P › Genişlet) ve kasa kısayolunu kapatıp yeniden açın. Görünüm ve
metinler Yönetim › Müşteri ekranı'ndan.

Tarayıcı sayfayı çevirmeyi önermez: `index.html` sayfayı çevrilmez diye işaretler (`translate="no"` ve
`<meta name="google" content="notranslate">`). Pencere `--disable-features=Translate` ile açılsa da tarayıcının dili
Türkçe olmayan bilgisayarda müşteri ekranında "Google Translate" balonu çıkıyordu (28 Kasım 2026); işaret sayfanın
kendisinde olduğu için kasa, tablet ve Uzaktan'da da geçerli (`tests/ui-rules.test.ts`).

## 4. Uygulamanın kasa ayarları

- **Ekran kararmasın** (Yönetim › Ayarlar › Kasa ve gün, varsayılan açık): AsilPOS ekran kilidi ister (Screen
  Wake Lock); tabletler ve bar ekranı da gün boyu açık kalır.
- **Otomatik kilit** (dk): dokunulmazsa ekran PIN ekranına döner; kasa paylaşılıyorsa 2-5 dk önerilir.
- **Hatalı PIN sınırı**: aynı cihazda art arda 5 hatadan sonra 15 sn (her hatada ikiye katlanır, en çok 5 dk).
  Araya doğru PIN girmek sayacı sıfırlar ama hatalar ayrıca birikir: cihaz (yetkili onayında PIN'i soran kişi de)
  saatte 12'den fazla hatalı PIN deneyemez, kilit denetim kaydına alarm yazar. Yetkili onayında yanlış PIN ile
  işlemi onaylayamayan kişinin PIN'i aynı yanıtı alır, adı söylenmez. Patron olmayan personel yöneticisi de
  saatte 12'den fazla PIN veremez ("Bu PIN kullanılamaz" yanıtıyla PIN taranmasın; çakışma denetim kaydına
  düşer, o personelin PIN'i değiştirilmeli). Ağda 10 dakikada 30 hatalı PIN olursa son 7 günde AsilPOS'a doğru
  PIN'le girmemiş cihazlar bir süre giremez; kafedeki kasa, tablet ve telefonlar etkilenmez, denetim kaydına
  alarm düşer (ağa bilinmeyen bir cihaz bağlı olabilir).
- **Tam ekran**: kiosk kullanılmayan tablet ya da bilgisayarda kullanıcı menüsünden.
- Kasiyer rolü varsayılan olarak **kör kasa** sayar: ara raporu, beklenen nakdi ve kapanmış adisyonların
  ödeme dökümünü görmez, gün sonunda çekmeceyi sayıp yazar; fark yöneticinin ekranında (Yönetim › Roller ve
  yetkiler).
- **Personel tutarları** (kişi başına ciro) yalnız maliyet yetkisi olana görünür: X ve Z özetindeki personel
  satırları, personel raporu ve başkasının kapanmış adisyonunda garson, kalemi ekleyen ve ödemeyi alan kişi
  (adisyon raporunda Garson sütunu, CSV'de boş). Herkes kendi adisyonunu tam görür; açık adisyonda garson
  herkese görünür (masa planı, bar ekranı, hesap fişi). Kapanmış başka bir adisyonun fişi yeniden basılınca
  garson satırı çıkmaz.
- **Bir iş gününe tek Z.** Gece gün sonu alındıktan sonra satış gerekirse Kasa ekranında "Günü yeniden aç"
  (neden ve yetkili PIN'i ister, denetim kaydına alarm düşer); Z numarası aynı kalır, gün yeniden kapanınca
  lafmaliyet'teki kayıt güncellenir. Yeni gün 05:00'ten sonra açılır.

## 5. Tabletler, telefonlar, patron

- Aynı ağdaki cihazlar: `http://<kasa-ip>:4000`; adres ve karekod Yönetim › Ağ ve uzaktan erişim'de. Kurulum gerekmez.
- **Ana ekrana ekleme (27 Kasım 2026):** kullanıcı menüsünde (kişi düğmesi › Bu cihaz ve oturum) **Ana ekrana ekle**
  cihaza göre yolu söyler ya da açar (`src/lib/pwa.ts`): iPad ve iPhone'da Safari › Paylaş › Ana Ekrana Ekle (kafenin
  ağındaki http adresinde de adres çubuksuz açılır); Chrome ve Edge güvenli adreste (https) kendi yükleme penceresini
  açar. Android'de kafenin ağındaki http adresi güvenli sayılmaz: tarayıcı menüsü › Ana ekrana ekle (Chrome, Samsung
  Internet, Firefox; satırın yol tarifi tarayıcı adı vermez) bir kısayol ekler ama adres çubuklu açılır ve "Ekran
  kararmasın" (Wake Lock) çalışmaz. Tam uygulama için https gerekir: Tailscale'in
  `tailscale serve` adresi (`docs/07-UZAKTAN-ERISIM.md`) ya da tablette `chrome://flags` › "Insecure origins treated as
  secure" alanına kasanın adresini (`http://<kasa-ip>:4000`) yazıp Chrome'u yeniden başlatmak. Uygulamanın kimliği ve
  kapsamı `public/manifest.webmanifest`'te (`id` ve `scope` `/`, `display: standalone`); sayfa önbelleğe alınmaz (`sw.js`
  yalnız Uzaktan'ın bildirimi), eklenen uygulama da her açılışta sunucunun güncel sürümünü alır. Kasa bilgisayarında
  (localhost) önerilmez ve tarayıcının kendi yükleme önerisi bastırılır: kiosk penceresinde yükleme çubuğu çıkmaz.
- Bar ekranı tableti: rol "Mutfak / Bar" olan personelle girilir, açılışta bar ekranı gelir.
- **Kasa yeniden başlarken sipariş kaybolmaz:** gönderilmemiş kalemler tablette saklanır. Gönderim kasaya
  ulaşamazsa (kasa yeniden başlıyor, Wi-Fi koptu) adisyonda "Kasaya ulaşılamıyor: N ürün bekliyor" yazar; tablet
  3 saniyede bir kasaya bakar ve dönünce aynı gönderim kimliğiyle kendiliğinden gönderir. Kasa aynı kimliği bir kez
  yazar: ilk deneme ulaşıp yanıtı kaybolduysa kalem ikinci kez yazılmaz (`src/lib/cart.ts` SendBatch,
  `tests/cevrimdisi.test.ts`, e2e akışı "kasa yeniden başlarken").
- Patronun dışarıdan erişimi: Tailscale (`docs/07-UZAKTAN-ERISIM.md`). AsilPOS'u modemden port açarak internete
  açmayın.

## 6. Yedek ve güncelleme

- Yedekler veri klasörünün `backups/`'ında günlük alınır (Yönetim › Ayarlar ve yedek): kurulum dosyasıyla
  `C:\ProgramData\LafPOS\backups`, git ile `data/backups/`. Haftada bir harici diske ya da buluta kopyalayın.
- Günlük yedekten sonra veritabanı bakımı (günde bir): WAL ana dosyaya yazılıp `lafpos.db-wal` sıfırlanır
  (`wal_checkpoint(TRUNCATE)`) ve SQLite sorgu istatistiklerini tazeler (`PRAGMA optimize`). Gün içinde beş
  dakikada bir PASSIVE denetim noktası; `journal_size_limit` 64 MB: yoğun bir günün şişirdiği `-wal` diski geri verir.
- Güncelleme (kurulum dosyasıyla kurulmuş kasa): kendiliğinden, aşağıda. Elle: yeni kurulum dosyasını çalıştırın
  (§2). Git ile: `git pull`, `npm ci`, `npm run build`, ardından sunucuyu yeniden başlatın (Windows'ta Görev
  Zamanlayıcı'da "LafPOS Sunucu"yu Sonlandır › Çalıştır; macOS'ta `launchctl kickstart -k gui/$UID/net.laffogato.lafpos`).

### Bulut yedeği

Günlük yedek (`backups\lafpos-<tarih>.db`) alınınca kasada sıkıştırılıp şifrelenir (AES-256-GCM; anahtar
`ASILPOS_CLOUD_SECRET`'ten, şube anahtarı varsa ondan türetilir, buluta hiç gitmez; `docs/07-UZAKTAN-ERISIM.md` §6) ve AsilPOS Uzaktan'ın verdiği 15 dakikalık imzalı adrese yüklenir
(Vercel Blob, özel depo `lafpos-yedek`; `server/sync/yedek.ts`, `api/_yedek.ts`). Dükkân başına son 30 yedek kalır;
gidemezse yarım saatte bir yeniden denenir. Durum ve "Şimdi yedekle": Yönetim › Ayarlar ve yedek › Bulut yedeği.

**Anahtar değişince** (27 Kasım 2026 incelemesi; `docs/07-UZAKTAN-ERISIM.md` §7): ladmin'in dağıttığı yeni Uzaktan anahtarı
gün sonunda yazılır, günün yedeği ise gün içinde eski anahtarla gitmiştir. Ertesi günün yedeğine dek buluttaki bütün
yedekler eski anahtarla şifreli kalırdı: o arada yeni anahtarla kurulan bilgisayar hiçbirini açamazdı. Artık:
- Sunucu yeni anahtarla açılınca ilk yedek turunda (yarım dakika) veritabanının şimdiki hâli yeni anahtarla hemen
  yüklenir. Son yüklemenin anahtarı izinden (`yedek.bulut` `lastKey`: anahtarın özeti, kendisi değil) bilinir; yükleme
  gidemezse yarım saatte bir yeniden denenir. Anlık kopya yükleme bitince silinir.
- Ayarlar dosyasındaki ortak ya da şube anahtarı başka değere geçince (ladmin'in dağıtımı, Bağlantı bilgileri, kurulum
  kodu) eski değer `ASILPOS_CLOUD_SECRET_ONCEKI` / `ASILPOS_CLOUD_SUBE_SECRET_ONCEKI` satırında kalır (dosyanın
  adlandırmasıyla; kurulu kasada eski önekle). Geri yükleme önce şimdiki anahtarları, sonra bunları dener: değişimden
  önce alınmış yedek de aynı kasada açılır. Yalnız bir önceki değer tutulur; bu satırla hiçbir istek imzalanmaz.

**Geri yükleme** (yalnız patron, kendi PIN'iyle, gün kapalıyken, Windows kurulumunda): "Buluttan geri yükle" yedeği
seçtirir; seçilen yedek indirilir, çözülür, SQLite olduğu doğrulanır ve veri klasöründe `geri-yukle\hazir.db` olarak
bekler. Sunucu kapanır; bekçi açmadan önce mevcut veritabanının kopyasını alır
(`backups\lafpos-geri-yukleme-oncesi-<an>.db`) ve yedeği yerine koyar (`geri-yukle.mjs`), AsilPOS yarım dakikada
yeniden açılır. **Yeni bilgisayarda:** AsilPOS'u kurup ayarlar.env'e aynı `ASILPOS_CLOUD_URL` ve `ASILPOS_CLOUD_SECRET`
yazılınca eski bilgisayarın yedekleri listede "Kurulum" seçiminden bulunur (şube anahtarı varsa o da yazılır: şube
anahtarıyla alınmış yedekler onunla, öncekiler ortak anahtarla açılır). Denetim kaydına yazılır. **Başka şubenin
yedeği** (27 Kasım 2026) şubesi belli kasaya yüklenmez: yedeğin şubesi kasanınkinden farklıysa 409 `wrong_branch`, hazır
dosya bırakılmaz (`docs/03-ENTEGRASYON.md` §4c).

### Otomatik güncelleme (anahtarsız)

Kasa yeni sürümü kendisi alır; sahibin anahtar ya da ayar girmesi gerekmez.

- **Kanal:** Vercel'deki `lafpos` projesi (adı değişmedi) her `main` derlemesinde `npm run kanal`'ı koşar
  (`scripts/kasa/windows/kurulum/kanal.mjs`): `dist/web/guncelleme/surum.json` ve `lafpos-app-<build>.zip`.
  Zip kurulumun `app\` yüküdür (`node.exe` ve `better_sqlite3.node` hariç), kasa arayüzü Uzaktan derlemesinden
  ayrı derlenir. `build` HEAD commit'inin unix zamanı (`git log -1 --format=%ct`; Vercel derlemesi HEAD commit'ini
  görür, 21 Kasım 2026'da doğrulandı; git geçmişi hiç yoksa derlemenin anı): aynı commit'in kurulum dosyası ve kanalı aynı numarayı taşır, kurulu derleme
  `app\package.json`'da. Manifest zip'in SHA-256'sını ve boyunu, Node ve better-sqlite3'ün sürümünü ve
  özetini (`surumler.mjs`) taşır. `vercel.json` `/guncelleme/*`'ı `index.html`'e çevirmez; `surum.json` her
  istekte yeniden doğrulanır (ETag), zip değişmez önbellekte. Paketin açık adreste durması yeni bir şey açmaz:
  aynı sunucu kodu herkese açık demoda (`/demo`).
- **Kasadaki güncelleyici** (`guncelle.mjs`, bekçinin içinde): sırayla
  `https://lafpos.laffogato.net/guncelleme/surum.json`, `https://lafpos.vercel.app/guncelleme/surum.json`; yalnız
  HTTPS, başka hosta yönlendirme reddedilir (better-sqlite3'ün GitHub dosyası yalnız GitHub'ın depolama hostlarına).
  Açılıştan 2 dk sonra, sonra 3 dk'da bir (`CHECK_EVERY_MS`). Yeni derleme varsa zip'i indirip boyunu ve SHA-256'sını
  doğrular; Node ya da better-sqlite3 değiştiyse nodejs.org'dan ve WiseLibs'in GitHub sürümünden indirip manifestteki
  özetle doğrular. İndirilenler `C:\ProgramData\LafPOS\guncelleme\indirilen`.
- **Kurulum yalnız açık iş günü yokken:** güncelleyici sunucuya `GET /api/kasa/guncelleme-durumu` ile sorar
  (oturumsuz, yalnız bu bilgisayardan: yerel ağ ve Tailscale 403; yanıtta yalnız `dayOpen`, Merkez'in hedefi
  `merkez`, satış/ödeme sürüyor mu `mesgul` ve cihazda banka gün sonu sürüyor mu `eod`). Gün açıksa 5 dk'da
  bir yeniden sorar. Gün kapalı ama yazarkasada banka gün sonu sürüyorsa (`eod`; gün kapanınca arka planda başlar,
  en çok 3 dk) de bekler, 5 dk'da bir yeniden sorar: sunucu o sırada durursa gün sonunun sonucu belirsiz kalır.
  Gün kapalıyken öbür meşguliyet (`mesgul`, ör. bekleyen yazarkasa sepeti) beklenmez, kurulumu süresiz tutmasın
  (`docs/04-YAZARKASA.md` §8.5). Sıra: yük `app.yeni`'ye açılır (yerel modül eskisinden ya da indirilenden, yeni Node
  `node.yeni`'ye), sunucu düzgün durur, veritabanı `backups\lafpos-guncelleme-<build>-<tarih>.db` olarak
  kopyalanır (son 5 güncelleme kopyası kalır), `app` → `app.eski`, `app.yeni` → `app`; yeni sürüm (bekçi ve
  sunucu) deneme olarak açılır. 60 sn içinde `/api/health` yeni derlemeyi söylerse deneme düzgün kapanır, bekçi 75
  koduyla çıkar, başlatıcı onu yeni sürümle açar. Söylemezse `app.eski` geri gelir, sunucu eski sürümle açılır ve
  o derleme bir daha denenmez (durum "Eski sürüme dönüldü"). `app.eski` elle geri dönüş için bir sonraki
  güncellemeye kadar durur.
- **Şimdi güncelle** (Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme; `POST /api/admin/guncelleme`, `ayar.yonet`):
  sunucu `guncelleme\istek.json` yazar, bekçi 2 sn'de bir bakar, dosyayı siler ve güncelleyiciye iletir
  (`requestNow`): kanala hemen sorar, yeni sürüm varsa indirir ve kurar. Gün kapalıysa hemen kurulur; gün açıkken
  patron onaylarsa (`simdi`, AsilPOS bir dakika kadar kapanır, tabletler bekler) hemen, onaysız istek gün sonundan sonra.
  Otomatik güncelleme kapalıyken de çalışır (kapalıyken kendiliğinden denetim olmaz, yalnız düğmeyle). Kafede basılan
  düğme Merkez'in tutmasını aşar (kanalın son sürümü; Merkez'de dükkân "elle"deyken otomatik denetim kurmaz, düğme kurar);
  sorun çıkmış sürüm bir daha denenmez. İki dakikada alınmayan istek beklenmez (bekçi çalışmıyor), bekçi de
  10 dakikadan eski isteği yok sayar. Kurulum bitince kart yeni derlemeyi görür ve "Yenile" önerir. Denetim kaydına
  `guncelleme` düşer. Yalnız Windows kurulumunda (bekçi); git ile çalışan sunucuda düğme yok.
- **Kurulumdan hemen sonra** (28 Kasım 2026): kurulum dosyası (`asilpos.nsi`) sunucuyu açmadan önce aynı dosyayı aynı
  biçimde yazar (`{"at":<ms>,"by":"kurulum","simdi":false}`). Bekçi açılışta alır, kanala hemen sorar (ilk denetimin iki
  dakikasını beklemez); daha yeni sürüm varsa indirir ve gün kapalıyken kurar, gün açıkken asla. Düğme gibi Merkez'in
  tutmasını aşar (siteden kurulum da zaten kanalın son sürümünü kurar). Kimsenin basmadığı bu istek otomatik güncelleme
  kapalıyken (`ASILPOS_GUNCELLEME=kapali`) yok sayılır (`bekci.mjs` `takeRequest`, `tests/kurulum-yenile.test.ts`).
  Siteden kurulum istek yazmaz: kanalın son sürümünü zaten kurar.
- **Uzaktan'dan Şimdi güncelle** (AsilPOS Uzaktan › Merkez › dükkân › "Şimdi güncelle"; `POST /api/merkez/simdi-guncelle`):
  Merkez dükkânın hedefini kanalın son derlemesi yapar ve isteğin anını (`guncelleIstek`) saklar. Kasa bunu bir sonraki
  nabzın yanıtında alır (en geç 5 dakika; ayrı istek yok) ve kasadaki düğmenin yazdığı `istek.json`'un aynısını yazar,
  her zaman `simdi: false`: uzaktan istek gün açıkken asla kurdurmaz, yeni sürüm gün kapalıysa hemen, açıksa gün
  sonundan sonra kurulur. Her istek bir kez işlenir (`sync_state` `merkez.istek`) ve denetim kaydına `guncelleme`
  (kullanıcısız, "Merkez'den güncelleme istendi") yazılır; kasa sonraki nabızda aldığını bildirir (`istekAlindi`),
  panelde "Güncelleme istendi" rozeti düşer. Bekçisiz kurulumda istek yazılmaz, denetim kaydı bunu söyler
  (`server/sync/merkez.ts` `takeRemoteUpdate`, `tests/merkez.test.ts`).
- **Kapatma:** `ayarlar.env`'de `ASILPOS_GUNCELLEME=kapali` (düğme yine çalışır).
- **Durum:** `C:\ProgramData\LafPOS\guncelleme\durum.json` (bekçi yazar, sunucu okur); Yönetim › Ayarlar ve yedek ›
  "Sürüm ve güncelleme" kartı kurulu sürümü, durumu, son denetimi ve son güncellemeyi gösterir; düğmesi "Şimdi güncelle".
  Kanala ulaşılamaması hata sayılmaz: kart son denetimin sonucunu yazar.
- Testler: `tests/guncelleme.test.ts` (manifest, karar, durum, kurulum ve geri dönüş akışı),
  `tests/guncelleme-sunucu.test.ts` (sunucunun iki ucu ve kart). Kurulum derlemesinin denemesi
  (`npm run kurulum:windows`) derleme numarasını, gün sorusunu ve durum dosyasını da sınar.

### Kasada seçim: Şimdi güncelle ya da Gün sonunda güncelle

Yeni sürüm indirilip gün açıkken beklediğinde kasada (gün açıp kapatan ya da ayar yetkisi olan kişiye) bir pencere çıkar
(`src/components/UpdateOffer.tsx`, `GET/POST /api/admin/guncelleme/teklif|secim`):

- **Şimdi güncelle:** AsilPOS bir dakika kadar kapanıp kendiliğinden açılır. **Satış ya da ödeme sürerken kurulmaz**
  (`server/lib/mesgul.ts`: işlenen satış/ödeme isteği, son 5 saniyedeki yazma, yazarkasada bekleyen sepet, cihazda süren
  banka gün sonu); düğme o an reddedilir, güncelleyici de kurmadan hemen önce yeniden sorar ve kasa boşalana dek 5 sn'de
  bir bekler (en çok 15 dk, sonra gün sonuna kalır). Yeniden açılınca ekranlar kendiliğinden yenilenir ve **kaldığı
  yerden devam eder** (`src/lib/buildWatch.ts`): açık masalar ve adisyonlar veritabanında, gönderilmemiş sepet ve oturum
  cihazda, açık ekran adreste durur. Kurulum sorun çıkarırsa eski sürüme dönülür (aşağıdaki geri dönüş) ve kasiyere
  söylenir.
- **Gün sonunda güncelle:** eski davranış; gün kapatılınca (Z'den sonra) kurulur. Gün kapanınca yazarkasada banka gün
  sonu başladıysa güncelleyici onun bitmesini bekler (en çok 3 dk; 5 dk'da bir yeniden sorar), sonra kurar.

Seçim sürüme bağlıdır (yeni sürümde yeniden sorulur) ve Merkez'e nabızla bildirilir: panelde her dükkânın durumu
**Güncel / Kasada seçim bekliyor / Gün sonunda kurulacak / Sorun çıktı** olarak görünür. Uzaktan › Merkez ›
**Güncellemeyi şimdi gönder** kasaya en geç 5 dakikada ulaşır ve aynı pencereyi çıkarır (gün kapalıysa hemen kurulur).
Zorunlu test: `e2e/flows.mjs` "Şimdi güncelle: kasa yeni sürümle açılınca aynı masa ve aynı sepetle devam eder".

### Güncellemeden sonraki ilk açılış yeni sürümle (27 Kasım 2026 düzeltmesi)

Otomatik güncellemeden sonra sahip kasayı (kiosk penceresi ya da tarayıcı) ilk açtığında eski sürüm (eski yeşil kenar
çubuğu) görünüyor, elle yenileyince düzeliyordu. İki yol vardı:

1. **Tarayıcı önbelleği.** Sunucu kökü (`/`, kasa penceresinin adresi) ve derleme dosyalarını önbellek başlığı olmadan,
   yalnız Last-Modified ile veriyordu. Chrome böyle yanıtı sezgisel olarak, son değişikliğin yaşının onda biri kadar
   (birkaç gün önce kurulmuş sürümde saatlerce) sunucuya sormadan açar: güncellemeden sonraki ilk açılışta eski
   `index.html` eski betiği önbellekten yüklüyordu. Artık arayüz sayfası (kök, `/index.html`, arayüz yolları) hiç
   saklanmaz (`no-store`; `no-cache` yeni açılışta sordururdu ama geri gelişte ve oturum geri yüklemesinde tarayıcı saklı
   sayfayı sormadan açar), adı içerik özeti taşımayan dosyalar (sw.js, manifest, simgeler) her açılışta sorulur
   (`no-cache`), adına Vite'ın özetini koyduğu `/assets/` dosyaları bir yıl önbellekte kalır (`server/app.ts`
   `arayuzOnbellegi`).
2. **Güncellemeden hemen önce açılmış sayfa.** Kasa sabah açılınca kasa penceresi eski sunucudan gelir; güncelleme
   (gece kapalıysa) açılıştan 2 dakika sonra kurulur. Giriş ekranında canlı bağlantı olmadığı için sayfa sunucunun
   yenilendiğini görmüyor, girişten sonraki ilk derleme sorusu yeni sunucuya gidiyor ve eski sayfa yeni derlemeyi "bu
   sürüm" sanıp hiç yenilenmiyordu. Artık sayfa kendi ana betiğini sunucunun `index.html`'indekiyle karşılaştırır
   (`src/lib/buildWatch.ts`): açılışta, canlı bağlantı yokken (giriş ekranı, müşteri ve çağrı ekranı, kopukluk) dakikada
   bir, ekrana dönünce ve canlı bağlantı her kurulduğunda. Farklıysa sayfa bir kez kendiliğinden yenilenir (açık pencere
   kapanınca; oturum varsa "Yeni sürüm kuruldu" der); yenilemeden sonra da farklıysa döngüye girmez.

**Tarayıcının kendi önbelleği** (27 Kasım 2026 incelemesi): kasa bekçisi ve kasa kısayolu kasa penceresini ya da müşteri
ekranını yeni bir tarayıcı süreciyle açmadan önce o profilin HTTP önbelleğini (`%LocalAppData%\LafPOS\chrome`, `\edge`
ve `\chrome-musteri` altında `Default\Cache`) siler (`app\kasa-yazici.ps1` `Clear-BrowserCache`). Yalnız o profilin
tarayıcısı açık değilken, pencere kilidinin altında; oturum, ayarlar ve yerel depolama kalır. Böylece eski sunucunun
başlıksız verdiği ve profilde kalmış `index.html` güncellemeden sonra kullanılmaz. 28 Kasım 2026'dan beri her açılışta
değil, yalnız kurulu derleme (`app\package.json` `build`) o profilin son silindiği derlemeden farklıysa silinir: her
açılışta silmek arayüz dosyalarını yeniden yükletip açılışı yavaşlatıyordu. Profilin son silindiği derleme kasa
profillerinin yanındaki `onbellek-derleme.txt`'de (`profil=derleme` satırları); önbellek tam silinemezse yazılmaz,
sonraki açılışta yeniden denenir. Derleme okunamazsa (git ile çalışan kurulum) eskisi gibi her açılışta silinir.

**Bu sürüme geçişte bir kez:** yeni denetim yeni sürümün betiğindedir. Bu düzeltmeyi getiren güncelleme kurulurken eski
sürümün giriş ekranı açıksa o açık sayfa bir kez daha eski görünebilir: elle yenileyince (F5) düzelir. Bilgisayar
yeniden başlayınca ya da pencere kasa kısayoluyla açılınca önbellek silindiği için görünmez (güncellemeden önce başlamış
bekçi eski betiği çalıştırmaya devam eder, yenisini bilgisayar yeniden açılınca alır). Sonraki güncellemelerde görünmez.
Bekçi sürümü 5'ten beri bekçi de güncellemeyle kendini yeniler (§3). Gerçek Windows'ta, kafede kurulu sürümden bu
derlemeye güncellemeyle her CI koşusunda denenir (§9).
Testler:
`tests/arayuz-onbellek.test.ts`; e2e akışları "Güncellemeden sonra ilk açılış", "Eski sürümle açılan sayfa" ve "Giriş
ekranı güncellemeden sonra".

### İnternet yokken ve internet gelince

Uçtan uca denemesi `e2e/internet.mjs` (sahte lafmaliyet ucu kapalı ve açık). İnternetin dönüşü yapılandırılmış
adreslerin kendi portuna TCP ile denenir (adreste port yoksa https 443).

Kasa yerel sunucudur: satış, masa, ödeme ve Pavo internetsiz çalışır; açılışta ve arayüzde interneti bekleyen bir
şey yoktur (yazı tipleri ve görseller pakette, site menüsü kurulumda gelir).

- Dışarı gidecek kayıtlar kaybolmaz: lafmaliyet gün sonu ve sitenin Satışta yazımları giden kutusunda (`outbox`),
  AsilPOS Uzaktan özeti bir sonraki itmede, online siparişler bir sonraki çekimde.
- Elle Tükendi / Satışa aç internetsiz de çalışır: kasada hemen geçerli, kasiyer "İnternet yok: kasada uygulandı, site
  internet gelince güncellenecek" uyarısını görür, sitenin yazımı giden kutusunda bekler (aynı ürüne yeni değişiklik
  gelirse yalnız sonuncusu gider). İnternetin olmadığı biliniyorken siteye hiç denenmez, dokunuş beklemez. Sitenin
  açık reddi (4xx) ve Tükendi kilidi bugünkü gibi (`docs/03-ENTEGRASYON.md` §2.3 "İnternet yokken Tükendi").
- İnternetin durumu yeni istek atmadan izlenir (`server/lib/internet.ts`): imzalı her isteğin sonucu yazılır, ağ
  hatası "yok", yanıt gelen istek (hata koduyla da) "var". İnternet yokken dakikada bir yapılandırılmış hostlardan
  birine yalnız TCP bağlantısı denenir (HTTP isteği yok).
- İnternet gelince (`server/sync/catch-up.ts`) giden kutusunun artan beklemesi (6 saate kadar) beklenmez, bir kez
  gönderilir: lafmaliyet, site, Uzaktan özeti ve online sipariş çekimi (kendi bütçesiyle). İki dönüş eşitlemesi
  arasında en az 5 dakika (AGENTS.md kural 6). Tam bir kez: gönderimler kendi sırasıyla (aynı anda iki kez
  çalışmaz), gönderilen satır `sentAt` alır, kalıcı reddedilen kayıt yeniden denenmez (`tests/internet-donusu.test.ts`).
- Durum alanında (üst çubuk) "İnternet yok · N kayıt bekliyor", hepsi gidince yarım saat "Bekleyenler gönderildi";
  her şey yolundayken ve dış bağlantı kurulmamış kasada rozet yok. Yönetim › Genel bakış › Sistem sağlığı'nda
  "İnternet" satırı ve her sistemin son başarılı gönderimi (site menüsü, online siparişler, lafmaliyet, AsilPOS
  Uzaktan).

## 7. Boşta kaynak kullanımı

Kasa bilgisayarı gün boyu açık; AsilPOS boşta işlemci ve bellek yemesin diye:

- **Sunucu:** JavaScript belleği bilgisayarın belleğinin dörtte biriyle sınırlı (1024-4096 MB; bekçi, §2). AsilPOS
  Uzaktan'a (`docs/07-UZAKTAN-ERISIM.md` §4) özet değişmediyse gitmez: gün kapalıyken (gece) beş dakikalık nabız
  yalnız değişiklikte ya da son itmenin üstünden 15 dakika geçtiyse gider (boşta 15 dakikada bir); gün açıkken
  nabız sürer. Özet zlib'in iş havuzunda sıkıştırılır, kasanın istekleri beklemez.
- **Kasa ekranı:** paket platformu şeridinin saniyelik geri sayımı yalnız onay bekleyen sipariş varken işler;
  platform listesi yalnız bir platform açıkken (deneme ya da canlı) ya da bekleyen sipariş varken 30 sn'de bir
  yoklanır, yeni sipariş canlı akışla zaten gelir. "Hazır" nabzı (salon kartı, teslim ekranı) yalnız transform
  ve opacity canlandırır: ekran kartında döner, kare kare yeniden boyanmaz; hareket azaltmada durur.

## 8. Ad değişikliği (26 Kasım 2026)

Ürünün adı AsilPOS oldu; kurulu kasa olduğu gibi çalışmaya devam eder, yeniden kurmak gerekmez. Değişmeyenler (kurulu
kasada, eski güncelleyicide ve öbür sistemlerde yazılı; liste `shared/eski-adlar.ts`):

- Klasörler: `C:\Program Files\LafPOS`, `C:\ProgramData\LafPOS` (veritabanı `lafpos.db`, yedekler `backups\lafpos-*`),
  kasa ekranının tarayıcı profilleri (`%LocalAppData%\LafPOS\chrome`, `…\LafPOS\edge`, `…\LafPOS\chrome-musteri`).
- Görev Zamanlayıcı ve güvenlik duvarı: `LafPOS Sunucu`; Uygulamalar kaydının anahtarı `Uninstall\LafPOS` (görünen adı
  AsilPOS), siteden kurulumun kaldırıcısı `LafPOS-Kaldir.ps1`.
- Güncelleme kanalı `https://lafpos.laffogato.net/guncelleme/` ve `https://lafpos.vercel.app/guncelleme/`, yükün adı
  `lafpos-app-<build>.zip`. Siteden kurulum iki adla yayımlanır: `AsilPOS-Kur.cmd` ve eski bağlantılar için
  `LafPOS-Kur.cmd` (aynı dosya).
- Ayarlar: `ayarlar.env`'deki `LAFPOS_*` satırları yeni ada çevrilmez, sunucu ve bekçi önce `ASILPOS_*`'u, yoksa eski
  adı okur. Yönetim › Bağlantı bilgileri, ladmin'in kurulum kodu ve anahtar dağıtımı da şimdilik eski adı yazar: dosyadaki
  `LAFPOS_*` satırı yerinde değişir, dosyada hiç yoksa eski adla eklenir (dosyada `ASILPOS_*` satırı varsa o da
  değişir). Bekçi sunucuya iki adı da verir. Böylece eski sürüme dönülürse eski sunucu (yalnız eski adı okur) sonradan
  girilen ayarları da bulur; yazımın yeni ada geçişi sonraki bir sürümde.

Değişenler ilk güncellemede kendiliğinden yenilenir: Başlat menüsü `AsilPOS` klasörüne taşınır, masaüstü ve Başlangıç'taki
kasa kısayolu `AsilPOS Kasa` olur (eskisi silinir; kaldırma ve tarayıcı kısayolu yeni klasöre taşınır). Kurulum
klasörüne `AsilPOS-Kasa.bat` ve `asilpos.ico` gelir; eski kısayollar için `LafPOS-Kasa.bat` yenisine yönlendirir
(yalnız `AsilPOS-Kasa.bat` konabildiyse; konamadıysa eski kısayollar ve eski dosya olduğu gibi kalır, sonraki açılışta
yeniden denenir), `lafpos.ico` aynı simgenin kopyasıdır. Uygulamalar listesinde görünen ad AsilPOS olur. Kurulum
dosyasıyla kurulmuş kasada ad değişikliğinden önceki kaldırıcı (`Kaldir.exe`) yeni adlı kısayolları bilmez (kaldırınca
Başlangıç'taki kasa kısayolu kalır, her oturumda boş bir tam ekran açardı): kısayollar yeni ada geçmeden önce silinir,
Uygulamalar listesi ve Başlat menüsündeki kaldırma siteden kurulumun kaldırıcısını (`LafPOS-Kaldir.ps1`, iki adı da
siler) çalıştırır. Güncel kurulum dosyası yeniden çalıştırılırsa kendi kaldırıcısını koyar. Tarayıcıdaki oturum, sepet ve
tercihler (`lafpos.*` anahtarları) her tarayıcı deposunda bir kez, ilk açılışta `asilpos.*`'a kopyalanır (sonra
uygulamanın sildiği anahtar eski kopyadan geri gelmez); eskiler silinmez.

## 9. Masaüstü programı: kurulum dosyası ve siteden kurulum aynı program (27 Kasım 2026)

Sahibin isteği: _"exe olarak kurulu bilgisayarda ve bu tamamen bir program olacak şekilde yap; exe ve siteden de isteyen
aynı şekilde kurup çalıştırabilmeli; bu iki şeye de uyumlu olsun."_

**Program.** Kasa ekranı bir program gibi davranır (§3): kendi kısayolu ve simgesi, konsolsuz açılış ve "AsilPOS
açılıyor" penceresi, tek pencere (ikinci tıklama öne getirir), Windows açılınca kendiliğinden (Başlangıç; oturum açılması
gerekir: otomatik oturum Başlat › AsilPOS › Kasa hazırlığı'nda), kullanıcı kapatınca kapanır (bekçi yeniden açmaz, müşteri ekranı da kapanır), çökerse bekçi yeniden açar, adres çubuğu yok,
Chrome güncellemesinden etkilenmez (kasa profili ayrı), Edge'de oturum ve sepet kalır.

**Aynı program, iki yol.** Kurulum dosyası (`AsilPOS-Kurulum.exe`, `asilpos.nsi`) ve siteden kurulum (`AsilPOS-Kur.cmd`,
`web-kurucu.ps1`) aynı şeyi kurar:

| | Kurulum dosyası | Siteden kurulum |
|---|---|---|
| Klasörler, görev, güvenlik duvarı, Uygulamalar kaydı | aynı | aynı |
| Kısayollar | `node app\kurulum-yenile.mjs kisayollar --gruplar <gruplar>`, hep iki grup (masaüstü, Başlangıç) | aynı komut, iki grup |
| Soru | yok (sayfa yok); yalnız gün açıkken, veritabanı kopyası alınamayınca ve hatada | yalnız gün açıkken ve hatada |
| Gün açıksa | sorar (sessiz kurulumda kurmaz, kod 3) | sorar (sessizde kurmaz) |
| Çalışan sunucu | görevi kapatıp bitirir | aynı, ayrıca kurulum klasörünün Node'undan çalışan süreçleri (bekçi önce) durdurur |
| Yeni sürüm | yan klasöre açılır, yer değiştirir, yazılamazsa ya da kurulum yarıda kalırsa (`.onInstFailed`) eski döner, sunucu yeniden açılır | aynı |
| Kurulu sürüm daha yeniyse | kurmaz, söyleyip çıkar (sessizde kod 5) | kurmaz, söyleyip çıkar |
| Aynı anda iki kurulum | ikincisi söyleyip çıkar (aynı kilit `Global\AsilPOS-Kurulum`; sessizde kod 6) | aynı |
| Kanaldaki daha yeni sürüm | sunucuyu açmadan önce güncelleme isteği yazar, bekçi hemen ister (§6) | gerekmez: kanalın son sürümünü kurar |
| Sonunda | sunucunun bu derlemeyle (ya da daha yenisiyle) açılmasını bekler; başarıda kasa ekranı açılır, pencere kapanır | aynı; başarıda pencere 10 sn sonra kendiliğinden kapanır |
| Güncelleme kanalı | aynı (`lafpos.laffogato.net/guncelleme`) | aynı |
| Fark | programı içinde taşır (internetsiz kurar); kaldırıcı `Kaldir.exe` | programı indirir; kaldırıcı `LafPOS-Kaldir.ps1`; şube kodu (ladmin) |

Kısayol listesi tek yerde (`kurulum-yenile.mjs` `shortcutSpec`); güncelleme aynı listeyi aynı betikle (`kisayollar.ps1`)
yeniler. Güncellemeden sonra Uygulamalar kaydında sürüm (`DisplayVersion`: kurulu sürüm ve derlemenin tarihi, Güncelleme
kartındaki gibi "0.3.0 (28.11.2026 14:05)"), boyut (`EstimatedSize`, kurulum klasörü) ve tarih (`InstallDate`) de
yenilenir (28 Kasım 2026; derleme başına bir kez, kısayollarla birlikte; `displayVersion`). Önceden otomatik güncelleme
yalnız adı ve simgeyi yeniliyor, liste kurulumdaki sürümü gösteriyordu. Kurulum dosyası kendi sürüm numarasını
(`0.3.<çalıştırma>`) yazar; ilk açılışta bekçi aynı biçime çevirir. Windows CI güncellemeden sonra kaydı denetler (D2).
Biri kuruluyken öbürüyle onarılır ya da güncellenir. Türkçe harfli adlar ("AsilPOS ayarları", "Sunucu günlüğü",
"AsilPOS'u kaldır"): Windows'un kısayol nesnesi (WScript.Shell) yolu "Unicode olmayan programlar" diline çevirir; Türkçe
olmayan Windows'ta ad en yakın harfle yazılırdı ("ayarlari.lnk"; Windows CI, 27 Kasım). Kısayol aynı klasörde ASCII adlı
geçici kopyada yazılıp asıl adına kopyalanır (`kisayollar.ps1`, `web-kurucu.ps1`); Türkçe Windows'ta sonuç aynı. İndir sayfası (AsilPOS Uzaktan) bunu söyler; kurulum
dosyası hâlâ GitHub'dan (depo özel). Siteden doğrudan `.exe` vermek için iki yol var, ikisi de sahibin bir anahtar
eklemesini ister: Vercel'de GitHub'ın salt okunur anahtarıyla sürüm dosyasının kısa ömürlü adresine yönlendiren bir uç ya
da CI'ın dosyayı herkese açık Blob deposuna yüklemesi. Bugün siteden kurulum aynı programı kurduğu için gerekmez.

**Siteden kurulum çalışan kasada (28 Kasım 2026 düzeltmesi).** Sahibin kasasında `AsilPOS-Kur.cmd` "Çalışan AsilPOS
sunucusu durduruluyor, AsilPOS kuruluyor" dedikten sonra "Kurulum yarıda kaldı: The process cannot access the file
because it is being used by another process" diye durdu. Kurucu sunucuyu yalnız görev sorgusu görevi bulursa
durduruyordu; sorgu görevi bulamadı (olası neden: kurucu konsolu UTF-8'e çeviriyor, bazı Windows komutları o kod
sayfasında hata koduyla dönebiliyor; Türkçe Windows'ta denenmedi), sunucu çalışmaya devam etti. Sunucunun çalışma
klasörü `app\` olduğu için Windows klasörün adını değiştirmeyi reddetti. Bugün:

- Görev ayrıca sorulmaz: her durumda kapatılır ve bitirilir (`/Change /DISABLE`, başarısı görevin var olduğunu söyler;
  kurulum dosyası da böyle). Dış komutlar konsolun özgün kod sayfasıyla çalışır.
- Görevden bağımsız: kurulum klasörünün Node'undan (`node\`, `node.yeni\`) çalışan her süreç durdurulur, bekçi önce
  (yoksa durdurulan sunucuyu bir saniyede yeniden açar); hiçbiri kalmayana dek en çok 20 sn.
- Dört yer değiştirme (`app` ve `node` kenara, yenileri yerine) tek denemede, her biri 10 sn'ye kadar yeniden denenir.
  Biri olmazsa yerine konan yeni klasör kalkar, eskiler ayrı ayrı geri gelir, sunucu yeniden açılır (görev varsa görevle,
  yoksa başlatıcıyla), sonra geçici klasör silinir. Ekranda: "Program dosyaları kullanımda olduğu için değiştirilemedi;
  eski sürüm çalışıyor. En kolayı: Yönetim > Ayarlar ve yedek > Sürüm ve güncelleme > Şimdi güncelle. Ya da
  bilgisayarı yeniden başlatıp bu dosyayı yeniden çalıştırın."
- Eski sürümün artıkları (`app.eski`, `node.eski`) silinemezse kurulum yine tamamlanır; uyarı yazar, sonraki güncelleme
  siler.

Kafede bu kurulum dosyası gerekmez: kasanın içinden "Şimdi güncelle" aynı işi bekçinin güncelleyicisiyle yapar (§6).

**Sorusuz kurulum (28 Kasım 2026).** Sahibin isteği: _"Windows'a kurarken hiçbir şey sormasın, tek seferde bitsin;
güncelleme varsa onu da alsın."_ Kurulum dosyası (`asilpos.nsi`):

- Hoş geldiniz, Bileşenler ve Bitiş sayfaları yok: Windows'un izin sorusundan sonra kurulum hemen başlar. Masaüstü
  kısayolu, oturum açılınca kasa ekranı ve prizdeyken uyku kapalı her kurulumda açık (gizli bölümler; sessiz kurulum ve
  CI bugünkü gibi). Başarıda kasa ekranı kendiliğinden açılır (Gezgin üzerinden, kullanıcı olarak) ve pencere kapanır;
  sessiz kurulumda kasa ekranı açılmaz. Sunucu iki dakikada açılmazsa pencere iletiyle açık kalır. Tablet adresi ve örnek
  PIN'ler kurulum notlarında (Başlat › AsilPOS › Kurulum notları) ve programın içinde.
- Kalan sorular: gün açıkken "yine de şimdi kurulsun mu", veritabanı kopyası alınamadı (Tamam/İptal), hata kutuları ve
  kaldırma onayı. Her kutunun sessiz kip yanıtı var.
- Aynı anda tek kurulum: siteden kurulumla aynı adlı kilit (`Global\AsilPOS-Kurulum`), sahiplenilerek kurulur; tutan
  varsa "Bu bilgisayarda başka bir AsilPOS kurulumu sürüyor" deyip çıkar. Kurulu derleme (`app\package.json`) bu dosyanın
  derlemesinden büyükse kurmaz: "Bu bilgisayarda daha yeni bir AsilPOS kurulu; bir şey yapmanız gerekmez."
- Yarıda kalırsa (kopya alınamadı, yer değiştirme olmadı ya da başka bir hata, `.onInstFailed`) yalnız bu kurulumun
  taşıdığı klasörler geri alınır (bayraklarla: otomatik güncellemenin bıraktığı `app.eski` kurulu sürümün yerine geçmez),
  görevi bu kurulum kapattıysa yeniden açılır. Hiçbir hata yolunda görev kapalı, sunucu durmuş kalmaz. Yer değiştirme
  bittikten sonraki bir hatada yeni sürüm yerinde kalır, sunucu yeniden açılır (kök dosyaları yeni bekçi yeniler).
- Sessiz kurulumun çıkış kodları: 0 kuruldu, 2 yarıda kaldı, 3 gün açık (kurmadı), 5 daha yeni sürüm kurulu (kurmadı),
  6 başka kurulum sürüyor.
- Kalan: kurulum tam yer değiştirirken elektrik kesilirse açılışta sunucu başlamaz (görev kapalı); kurulum yeniden
  çalıştırılınca düzelir (`docs/KALANLAR.md` §4).

**Bugün kurulu kasalarla uyum.** Hiçbir ad değişmedi: kısayolların adları (eski `Kaldir.exe` sabit adları siler),
tarayıcı profilleri (`%LocalAppData%\LafPOS\chrome`, `…\LafPOS\edge`, müşteri ekranınınki), kilit adları, görev, veri klasörü,
`baslat.cmd` (baytları aynı). Güncelleme kurulunca sunucu bekçisi kök dosyaları ve kısayolları yeni listeyle yeniler:
kasa kısayolları programa döner. Eski bekçi (sürüm 4) çalışmayı sürdürür ve pencereyi aynı profilden tanır (ikinci pencere
açılmaz); kasa kısayolunun ilk açılışında ya da oturum yeniden açılınca sürüm 5 ile değişir. Uygulama klasöründe kullanıcı
oturumundan açık tutulan dosya yok: geri dönüş (`app.eski`) eskisi gibi çalışır. Veri klasörüne dokunulmaz.

**Windows CI** (`ci-kurulum.mjs`, ekran görüntüleri `ci-ekran`):

1. GitHub'daki son sürüm (kafede kurulu olan) sessiz kurulur; kasa penceresi onun Başlat menüsündeki kısayoluyla (hedefi
   ve argümanları) açılır. Pencere yerel bir vekilden bağlanır (`ci-vekil.mjs`, `ASILPOS_URL`): vekil sayfaya pencerenin
   gerçekten gösterdiği ana betiği (hangi derleme), başlığı ve yerel deponun kalıcılığını bildiren bir betik ekler ve
   istenince 27 Kasım öncesinin sunucusunu taklit eder (önbellek başlıksız, eski Last-Modified: Chrome sayfayı saklar;
   şikâyetteki durum, Chrome'la denenmiştir).
2. Yerel kanaldan bu derlemeye otomatik güncelleme (Node da değişir). Kanal derlemesine verilen işaret
   (`VITE_ASILPOS_CI_DERLEME`, gerçek derlemede yok) ana betiği derlemeye göre değiştirir: yeni sürüm penceredeki betikten
   ayırt edilir.
3. Güncellemeden önce açılmış pencere kendiliğinden yeni sürüme geçer; kısayollar programa döner; kapanan pencereyi yeni
   kısayol açar (ilk sayfa yeni sürüm ve sunucudan, yerel depo kalıcı, eski bekçi yenisiyle değişir); ikinci tıklama
   ikinci pencere açmaz ve öne getirir (masaüstü varsa); Uygulamalar kaydı yeni sürümü, boyutu ve tarihi gösterir; kasa
   programının günlüğü açılış penceresinin göründüğünü ve açılışın adım sürelerini yazar; bekçi düzgün kapatılan pencereyi
   (pencereye kapatma iletisi, Alt+F4 gibi; profil "Normal") yeniden açmaz, kısayol açar; zorla kapatılan (çöken; profil
   "Crashed") pencereyi kendisi yeniden açar ve kararını günlüğe yazar; Edge kalıcı
   profille tam ekran (`--kiosk` ve InPrivate yok): sayfanın yerel depoya yazdığı değer diske geçince (en çok 30 sn
   beklenir) pencere zorla kapatılıp yeniden açılır, değer yerindedir. Tutmazsa profilin depo dosyaları ve Edge
   politikaları (kayıt defteri) yazılır.
4. Bozuk derleme: geri dönüş. Gece kapanan pencere (sayfası eski sunucu gibi saklanmış), yeni arayüz ve yeni kasa betiğiyle
   güncelleme: bekçi kendini yeniler, sabah kısayolla açılan ilk sayfa yeni sürüm ve sunucudan.
5. Kafedeki kaldırıcı (önceki sürümün `Kaldir.exe`'si) iz bırakmaz, veriler kalır. Bu derlemenin kurulum dosyası ve
   siteden kurulum (`AsilPOS-Kur.cmd`, yalnız CI için yerel kanal `ASILPOS_KUR_KANAL` ve sessiz kip `ASILPOS_KUR_SESSIZ`)
   ayrı ayrı kurulur: dosyalar, kısayollar (listeyle de), görev, güvenlik duvarı ve Uygulamalar kaydı aynı (yalnız
   kaldırıcı ve sürüm satırı farklı). Bu sürümün kaldırıcısı kasa penceresini ve bekçiyi de kapatır.
6. Siteden kurulum çalışan kasanın üzerine (kasa penceresi açık, sunucu görevle çalışırken): çıkış 0, sunucu bu
   derlemeyle, `kurulum.gecici`, `app.eski`, `node.eski` kalmaz, veritabanı kopyalanır, görev açık ve çalışıyor. Sonra
   sahibin durumu: görev kapatılıp bekçi görevin dışından açılır (görevi kapatmak sunucuya dokunmaz); kurucu sunucuyu
   süreçlerinden bulup durdurur ve tamamlar. Son olarak çalışma klasörü `app\` olan başka bir program açıkken kurucu
   sıfırdan farklı çıkar ama eski sürüm yerinde kalır (sağlık yanıt verir, `app\bekci.mjs` yerinde, görev açık ve
   çalışıyor); program kapanınca yeniden çalıştırılan kurucu tamamlar.
7. Sorusuz kurulum: daha yeni kurulumun üzerine bu derlemenin (artık eski) kurulum dosyası sessiz çalışınca 5 koduyla
   kurmadan çıkar (kurulu derleme, sunucunun süreçleri, görev aynen); kurulum dosyasının güncelleme isteği bekçiye ulaşır
   (otomatik güncelleme kapalıyken yok sayıldığı günlükte); gün açıkken (patron girişiyle açılır) sessiz kurulum dosyası 3
   koduyla, sessiz siteden kurulum 0 koduyla kurmadan çıkar. Önceki sürüm kurulmadan önce güncelleme kanalı yerel kanala
   çevrilir: kurulumun isteği sitenin kanalına gitmez. İki kurulumun görev karşılaştırması görev okunamazsa geçmez (görev
   Görev Zamanlayıcı nesnesinden okunur).

Deneme ortamı kafeye benzetilir: adım pwsh'ta (PowerShell 7) koşar, pwsh'un `PSModulePath`'i oradan açılan Windows
PowerShell 5.1'e geçince 5.1 kendi modüllerini (`Get-FileHash` gibi) yükleyemez; deneme bu değişkeni siler (kafede
kısayol, görev ve kurulum 5.1'i temiz ortamla açar). Güncellemeden hemen sonra sunucu bir kez daha yeniden başlar (deneme
açılışı, sonra 75 koduyla yeni sürüm): denemenin sunucuya istekleri o arada kopan bağlantıyı yeniden dener. Yerel
güncelleme kanalı ve vekil denemenin kendi sürecinde çalışır: siteden kurulum (kanaldan indirir) olay döngüsünü durdurmadan
beklenir.

**Sonraki adım (isteğe bağlı): kendi penceresi olan `AsilPOS.exe`.** Bugün pencere Chrome'un (ya da Edge'in) uygulama
penceresidir: Görev Yöneticisi'nde tarayıcının altında görünür. WebView2 üzerinde küçük bir `AsilPOS.exe` (kendi süreci,
simgesi, görev çubuğu kimliği; Windows 11'de WebView2 hep var) yapılabilir; sessiz yazdırma (`PrintAsync`), imzasız
dosyanın Akıllı Uygulama Denetimi'ne takılması ve derlemenin nerede yapılacağı önce CI'da denenmeli. Uygulama klasörünün
dışında (`app\` güncellemede taşınır) ve eski bekçiyi kapatarak çalışmalı.

