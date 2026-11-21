# Kasa bilgisayarı: Windows kurulumu, Chrome'da sürekli açık LafPOS

LafPOS'un sunucusu kafedeki **kasa bilgisayarında** çalışır; kasa ekranı aynı bilgisayarda Chrome'da tam ekran
(kiosk) açık durur. Tezgâh tableti, garson telefonları ve bar ekranı aynı sunucuya kafenin ağından bağlanır
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
| Yazarkasa POS | TokenX Connect bilgileri `.env`'de (kurulum dosyasıyla: Başlat › LafPOS › LafPOS ayarları) |

## 2. Kurulum (bir kez)

### Windows: kurulum dosyası (önerilen)

`LafPOS-Kurulum.exe` GitHub'daki sürüm sayfasından (Releases › Latest; `main`'e her push'ta yayımlanır) bir kez
indirilir; Node, Git ya da komut satırı gerekmez, sahibin adımları README'de ("Windows'a kurulum"). Sonraki
sürümleri kasa kendisi alır (§6). Dosya imzasız olduğu için Windows "Bilgisayarınız korundu" der: **Ek bilgi ›
Yine de çalıştır**. Kurulum yönetici izni ister ve şunları yapar:

| | |
|---|---|
| Uygulama | `C:\Program Files\LafPOS`: Node 24 LTS (24.22.3), sunucu, arayüz, kasa kısayolu. Yalnız yöneticiler değiştirir |
| Veri | `C:\ProgramData\LafPOS`: veritabanı, `secret.key`, günlük yedekler (`backups\`), `ayarlar.env`, sunucu günlüğü (`logs\`). Yalnız SYSTEM ve yöneticiler açar |
| Sunucu | Görev Zamanlayıcı'da "LafPOS Sunucu": Windows açılınca SYSTEM olarak, kimse oturum açmasa da; süre sınırı yok, pilde de çalışır. Görev bekçiyi başlatıcıdan açar (`baslat.cmd`, çalışma klasörü kurulum klasörü): otomatik güncelleme bekçiyi 75 koduyla kapatınca başlatıcı onu yeni sürümle yeniden açar, güncelleme Node'u da değiştirdiyse önce `node.yeni`'yi `node`'un yerine koyar. Bekçi (`app\bekci.mjs`) düşen sunucuyu 1-30 sn içinde yeniden başlatır; bekçi düşerse görevin beş dakikalık güvence tetiği yeniden açar. Sunucunun JavaScript belleği sınırlı (`--max-old-space-size`): varsayılan bilgisayarın belleğinin dörtte biri, en az 1024, en çok 4096 MB (8 GB'lık bilgisayarda 2048). Bir sızıntı kasa bilgisayarının belleğini bitirmez, sınıra varan sunucu düşer ve bekçi yeniden açar; taban, uzun dönem raporunun (bir yıl, iki dönem birden) sığması için. Gerekirse `ayarlar.env`'de `LAFPOS_MAX_HEAP_MB` (256-4096; örnek dosyada açıklamalı, yorumlu satır); bekçi seçilen sınırı günlüğe yazar |
| Güvenlik duvarı | TCP 4000 yalnız kafenin ağına ve Tailscale'e (`100.64.0.0/10`) açık |
| Kısayollar | Masaüstünde ve Başlangıç'ta "LafPOS Kasa" (seçilebilir); Başlat › LafPOS: kasa, tarayıcıda aç, ayarlar, sunucuyu yeniden başlat, sunucu günlüğü, kurulum notları, kaldır |
| Güç | "Prizdeyken uyku kapalı" (seçilebilir): uyku, hazırda bekletme ve USB'nin seçmeli askıya alınması prizdeyken kapanır (`powercfg`; uyuyan bilgisayara tablet bağlanamaz, uyuyan USB'deki fiş yazıcısı ve dokunmatik ekran kopar). Ağ kartının güç tasarrufu elle kapatılır: Aygıt Yöneticisi › Ağ bağdaştırıcıları › kart › Güç Yönetimi › "Güç tasarrufu için bilgisayarın bu aygıtı kapatmasına izin ver" işaretsiz (BENIOKU'da da yazar) |

- **Ayarlar** (site, lafmaliyet, LafPOS Uzaktan, Token ve paket platformu anahtarları): programın içinden,
  **Yönetim › Bağlantı bilgileri** (aşağıda). Dosyanın kendisi `C:\ProgramData\LafPOS\ayarlar.env`; Başlat › LafPOS ›
  LafPOS ayarları onu Not Defteri'nde de açar. Kaydedince (panelden ya da Ctrl+S) bekçi değişikliği (5 sn'de bir
  bakar) görür ve sunucuyu yeni ayarlarla yeniden başlatır. Pavo'nun adresi ve seri no'su bu dosyada değil, Yönetim ›
  Yazarkasa POS'ta (`docs/04-YAZARKASA.md` §8.1).
  İlk kurulumda site bağlantısı kapalıdır (`LAFFOGATO_URL` satırı yorumlu): LafPOS siteye hiç bağlanmaz, menü
  kurulumdaki gibi kalır. Açmak için `docs/03-ENTEGRASYON.md` §8 (açılış sırası).
- **Güncelleme:** kendiliğinden (§6). Elle: yeni kurulum dosyasını çalıştırın. Sunucuyu durdurur, veritabanını
  `backups\lafpos-guncelleme-<tarih>.db` olarak kopyalar, uygulamayı değiştirir, sunucuyu başlatır; veri ve
  ayarlar kalır. **27 Ekim 2026'dan önceki kurulumu güncellerken:** eski `ayarlar.env`'de
  `LAFFOGATO_URL=https://laffogato.net` satırı yorumsuz durur (o günkü örnek dosyadan gelir) ve güncelleme ayar
  dosyasına dokunmaz; site bağlantısı açık kalır. Açılış sırasına (`docs/03-ENTEGRASYON.md` §8) kadar satırı silin
  ya da başına `#` koyun.
- **Kaldırma:** Ayarlar › Uygulamalar › LafPOS. Görev, güvenlik duvarı kuralı ve kısayollar gider, veri
  klasörü kalır.
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
  `azure/trusted-signing-action`; anahtarlar depo sırlarına), imzalanacaklar `LafPOS-Kurulum.exe` ve paketteki
  `node.exe` dışındaki ikililer (`better_sqlite3.node`, Kaldir.exe). İmzalı dosyada SmartScreen itibarı birkaç
  yüz indirmede oluşur; EV sertifika uyarıyı hemen kaldırır.

### Bağlantı bilgileri (Yönetim › Bağlantı bilgileri)

Kurulumdan sonra sahibin dosya açması gerekmez: dış sistemlerin adresleri ve anahtarları programın içinden girilir.
Kod: katalog `shared/baglanti.ts`, dosya yazımı `server/lib/ayar-dosyasi.ts`, uçlar `GET`/`PUT /api/admin/baglanti`,
ekran `src/pages/admin/ConnectionsAdmin.tsx`, testler `tests/baglanti.test.ts` (e2e akışı da yazar).

- **Ne yazılır:** yalnız katalogdaki anahtarlar: lafmaliyet (`LAFMALIYET_URL`, `LAFMALIYET_SYNC_SECRET`), LafPOS
  Uzaktan (`LAFPOS_CLOUD_URL`, `LAFPOS_CLOUD_SECRET`), site (`LAFFOGATO_URL`, `LAFFOGATO_SYNC_SECRET`; deneme
  bittikten sonra, `docs/03-ENTEGRASYON.md` §8), Token (`TOKENX_*`, `LAFPOS_PUBLIC_URL`), Yemeksepeti, Getir ve
  Trendyol Go. Bilinmeyen anahtar 400. Adres http(s) olmalı, gizli anahtarın en kısa boyu denetlenir (Uzaktan ve site
  32, webhook 16), boşluk, tırnak ve satır sonu kabul edilmez; boş değer satırı kaldırır.
- **Neden veritabanında değil:** veritabanı buluta yedeklenir ve yedeğin şifresi `LAFPOS_CLOUD_SECRET`'ten türer;
  anahtarlar dosyada kalır, veritabanı dosyası tek başına sızarsa anahtar sızmaz.
- **Yetki:** görmek ayar yetkisiyle (`ayar.yonet`), yazmak yalnız patron (yanlış adrese satış verisi gidebilir).
  Gizli anahtarların değeri hiçbir yanıtta dönmez, yalnız "tanımlı" bilgisi; alan boş gelir, yazılırsa değişir.
  Denetim kaydına `ayar.baglanti` düşer: anahtarların adı ve adreslerin yenisi, gizli değer değil.
- **Dosya:** etkin satır yerinde değişir (aynı anahtarın tekrarı düşer), yoksa örnek dosyadaki yorumlu satırın
  (`# ANAHTAR=`) altına, o da yoksa sona "Yönetim › Bağlantı bilgileri" başlığıyla eklenir. Öbür satırlar, yorumlar,
  BOM ve CRLF korunur; önce geçici dosyaya yazılıp yerine konur. Bekçi dosyanın yerini sunucuya `LAFPOS_AYAR_DOSYASI`
  ile söyler (eski bekçide veri klasöründeki `ayarlar.env`).
- **Yeniden başlama:** bekçi dosyanın değiştiğini görüp sunucuyu yeni ayarlarla açar (birkaç saniye, tabletler bekler).
  Ekran dosya ile çalışan sunucunun ayarları aynı olana dek "LafPOS yeni bilgilerle yeniden başlıyor" der
  (`pending`), sonra "yeni bilgilerle açıldı".
- **Hazır satırları yapıştır:** sahibe verilen ayar satırları (`lafpos-kasa-ayarlari.env`) olduğu gibi yapıştırılır;
  bilinen anahtarlar tek kayıtta yazılır, `PAVO_URL` ve `PAVO_SERIAL` Pavo'nun ayarına gider, satır sonundaki
  "(deneme bittikten sonra)" gibi notlar düşer, tanınmayan satırlar söylenir.
- Git ile çalışan sunucuda ve tarayıcı demosunda panelden yazılmaz (`.env` elle); e2e sunucusu veri klasöründe bir
  `ayarlar.env` ile açılır (`LAFPOS_AYAR_DOSYASI`).

**Kurulum dosyasını derlemek** (macOS, Linux ya da Windows): `npm run kurulum:windows`; gereken NSIS
(`brew install makensis`, `apt install nsis`; Windows'ta NSIS 3, PATH'te değilse `Program Files\NSIS`'te aranır,
`MAKENSIS` ile de verilir). Betik (`scripts/kasa/windows/kurulum/derle.mjs`) arayüzü derler, sunucuyu esbuild'le
tek dosyaya paketler, nodejs.org'dan Node'u ve better-sqlite3'ün Windows ikilisini indirir, paketi bekçi üzerinden
açıp dener (göçler, ilk kurulum, giriş, açılış verisi, arayüz, ayar değişince yeniden başlama, düzgün kapanış:
`-wal` kalmaz), sonra `dist/windows/LafPOS-Kurulum-<sürüm>.exe`'yi üretir. Deneme Windows'ta kafeye gidecek
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
kasaya giden dosyalara dokunan PR'da (`scripts/kasa/windows/**`, `server/**`, `drizzle/**`, `package.json`, kilit
dosyası, iş akışının kendisi) ve Actions'tan elle `windows-latest` üzerinde Node 22 ile `npm ci`, NSIS (imajda yoksa
`choco install nsis`) ve `npm run kurulum:windows` koşar: kurulum dosyası gerçek Windows'ta derlenir ve paket
kafeye gidecek ikililerle açılıp denenir. `main`'e push'ta ardından GitHub Release yayımlanır: etiket
`v<major.minor>.<çalıştırma no>`, sabit adlı iki dosya (`LafPOS-Kurulum.exe`, `LafPOS-Kurulum.exe.sha256`),
`--latest`; son 10 sürüm kalır (`permissions: contents: write`, iş akışının kendi `GITHUB_TOKEN`'ı; ayrıca anahtar
yok). Linux işiyle paralel, onu beklemez. İndirilen Node ve sqlite ikilisi `actions/cache`'te durur. Kurulum
dosyasını çalıştırmaz: görev, güvenlik duvarı ve kiosk ilk gerçek kurulumda denenir (aşağıda). Özel depoda Windows
dakikası Actions kotasından iki kat düşer; yalnız arayüze dokunan PR bu yüzden onu koşmaz.

**İlk gerçek Windows kurulumunda bakılacaklar.** Kurulum dosyası macOS'ta derlendi; paket Node 24.22.1 ile
satış akışından geçti, görev XML'i ve Windows ikilileri denetlendi (21 Kasım 2026'da Node 24.22.3'e geçildi:
aynı ABI 137, güvenlik sürümü). Paketin Windows'ta açılması artık CI'da denenir; kurulumun kendisi (görev,
güvenlik duvarı, güç ayarları, kiosk) henüz gerçek bir Windows'ta koşmadı. İlk kurulumda: Görev Zamanlayıcı'da "LafPOS
Sunucu" çalışıyor; `http://localhost:4000` açılıyor; tablet kafenin ağından bağlanıyor;
`C:\ProgramData\LafPOS\logs\sunucu.log` yazılıyor; bilgisayar yeniden başlayınca sunucu ve kasa ekranı
kendiliğinden geliyor; LafPOS ayarları kaydedilince sunucu yeniden başlıyor.

### İlk açılış: deneme modu, sonra gerçek kullanım

Yeni kurulumda sahte işletme verisi yoktur: adisyon, ödeme, gün, müşteri, rezervasyon, platform siparişi yok
(`tests/deneme-modu.test.ts`). Yalnız başlamak için gerekenler gelir: rol hesapları (Patron, Müdür, Kasa, Garson,
Bar ekranı; örnek PIN'li), Bar ve Mutfak istasyonları, tarayıcı yazıcısı, köşkün masa planı ve karaoke odası, ödeme
türleri, sitenin menüsü (pakette anlık görüntü; site bağlantısı açılınca güncellenir) ve kasaya özgü ürünler (karaoke
saati, kişi başı ve etkinlik ücreti, yenilebilir bardak, şeker ve bardak seçimi). Örnek kampanya (happy hour) yalnız
tarayıcı demosunda (`seedIfEmpty({ demo: true })`, ya da `LAFPOS_DEMO_SEED=1`).

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

Bir kez çalışır (`liveSince` ayarı): yeniden basmak hiçbir şey silmez. Sonra kurulum modu yeniden açılmaz.

### Git ile (yalnız geliştirici; Windows ya da macOS)

Kafedeki kasa bilgisayarına bu yol **kurulmaz**; orada kurulum dosyası kullanılır. `kur.ps1` sunucuyu `npm start`
ile (tsx: TypeScript her açılışta yeniden derlenir) çalıştırır: bekçi, bellek sınırı ve günlük dönmesi yoktur,
`data/sunucu.log` sınırsız büyür. Geliştiricinin kendi bilgisayarında denemek içindir.

```bash
git clone https://github.com/RiosenBeq/lafpos.git
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
2. **Kasa ekranı kendiliğinden açılır:** Başlangıç klasörüne (macOS'ta oturum ajanı) "LafPOS Kasa" kısayolu
   konur; masaüstüne de. Kısayol sunucu hazır olana dek bekler, sonra Chrome'u kiosk açar.
3. Kaldırmak için aynı betik `-Kaldir` (Windows) ya da `--kaldir` (macOS) ile; veriler (`data/`) silinmez.

Windows'ta ayrıca: Ayarlar › Hesaplar › Oturum açma seçeneklerinde otomatik oturum açmayı ve
Güç ayarlarında "ekranı kapatma: hiçbir zaman", "uyku: hiçbir zaman"ı seçin.

## 3. Kiosk Chrome'un ayarları (`scripts/kasa/*/LafPOS-Kasa.*`)

Windows'ta Chrome yoksa aynı bayraklarla Edge açılır (`--kiosk <adres> --edge-kiosk-type=fullscreen`, profil
`…\LafPOS\edge`).

| Bayrak | Neden |
|---|---|
| `--kiosk` | Tam ekran, adres çubuğu ve sekme yok; kasiyer başka siteye geçemez |
| `--kiosk-printing` | Fiş, Z ve X raporu önizlemesiz, doğrudan varsayılan yazıcıdan çıkar |
| `--app=http://localhost:4000/` | Uygulama penceresi; başka bir adres için `LAFPOS_URL` |
| `--user-data-dir=…\LafPOS\chrome` | Kasaya ayrı Chrome profili: kişisel Chrome açık olsa da kiosk ayarları karışmaz |
| `--disable-pinch`, `--overscroll-history-navigation=0` | Dokunmatik ekranda yanlışlıkla yakınlaşma ve kaydırarak geri gitme olmaz |
| `--autoplay-policy=no-user-gesture-required` | Bar ve sipariş zil sesi ilk dokunuşu beklemeden çalar |
| `--no-first-run`, `--disable-session-crashed-bubble`, `--noerrdialogs` | Elektrik kesintisinden sonra "geri yükle" balonu çıkmaz |

**Fiş yazıcısı (kablolu/USB, kendiliğinden):** yazıcıyı USB ile takın; Windows sürücüsünü kurar (kurmazsa
üreticinin sürücüsü). Kasa kısayolu Chrome'u açmadan önce `app\kasa-yazici.ps1`'i oturumdaki kullanıcı olarak çalıştırır:
bilgisayardaki yazıcıları LafPOS'a bildirir (`POST /api/kasa/yazicilar`, oturumsuz, yalnız bu bilgisayardan) ve
LafPOS'un söylediği yazıcıyı o kullanıcının **varsayılan yazıcısı** yapar ("varsayılan yazıcıyı Windows yönetsin"
kapanır); `--kiosk-printing` fişi, Z'yi ve X'i önizlemesiz ona basar. Hangi yazıcı: Yönetim › Ayarlar ve yedek › **Fiş
yazıcısı**'nda seçilen; seçilmediyse PDF, XPS, OneNote ve faks dışındaki tek yazıcı, birden çoksa adından fiş yazıcısı
olduğu anlaşılan tek yazıcı (`server/lib/yazici.ts`, testi `tests/yazici.test.ts`). Kart yazıcıları ve son bildirimi
gösterir; "Bunu kullan" seçer, "Deneme fişi yazdır" kasa bilgisayarında basılınca seçili yazıcıdan çıkar. Seçim kasa
ekranının bir sonraki açılışında geçer (Alt+F4, masaüstünde LafPOS Kasa). Betik hata verirse sessizce çıkar, kasa yine
açılır. Kısayol (`LafPOS-Kasa.bat`) ve betik güncellemeyle gelir: betik `app\`'te, kısayolun yenisini bekçi açılışta
kurulum klasörüne koyar (kısayol Chrome'u açıp hemen çıktığı için çalışırken değişmez). Chrome bir yazıcıya elle
basıldıysa "son kullanılan"ı hatırlayabilir: yazdırma önizlemesini kapatan Chrome ayarını açmayın.

Kiosktan çıkmak: **Alt+F4** (macOS'ta Cmd+Q). Personelin bunu kullanmaması için Windows'ta ayrı bir standart
kullanıcı hesabı önerilir.

## 4. Uygulamanın kasa ayarları

- **Ekran kararmasın** (Yönetim › Ayarlar › Kasa ve gün, varsayılan açık): LafPOS ekran kilidi ister (Screen
  Wake Lock); tabletler ve bar ekranı da gün boyu açık kalır.
- **Otomatik kilit** (dk): dokunulmazsa ekran PIN ekranına döner; kasa paylaşılıyorsa 2-5 dk önerilir.
- **Hatalı PIN sınırı**: aynı cihazda art arda 5 hatadan sonra 15 sn (her hatada ikiye katlanır, en çok 5 dk).
  Araya doğru PIN girmek sayacı sıfırlar ama hatalar ayrıca birikir: cihaz (yetkili onayında PIN'i soran kişi de)
  saatte 12'den fazla hatalı PIN deneyemez, kilit denetim kaydına alarm yazar. Yetkili onayında yanlış PIN ile
  işlemi onaylayamayan kişinin PIN'i aynı yanıtı alır, adı söylenmez. Patron olmayan personel yöneticisi de
  saatte 12'den fazla PIN veremez ("Bu PIN kullanılamaz" yanıtıyla PIN taranmasın; çakışma denetim kaydına
  düşer, o personelin PIN'i değiştirilmeli). Ağda 10 dakikada 30 hatalı PIN olursa son 7 günde LafPOS'a doğru
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

- Aynı ağdaki cihazlar: `http://<kasa-ip>:4000`; adres ve karekod Yönetim › Ağ ve uzaktan erişim'de. Chrome
  menüsünden "Ana ekrana ekle" ile uygulama gibi açılır.
- Bar ekranı tableti: rol "Mutfak / Bar" olan personelle girilir, açılışta bar ekranı gelir.
- **Kasa yeniden başlarken sipariş kaybolmaz:** gönderilmemiş kalemler tablette saklanır. Gönderim kasaya
  ulaşamazsa (kasa yeniden başlıyor, Wi-Fi koptu) adisyonda "Kasaya ulaşılamıyor: N ürün bekliyor" yazar; tablet
  3 saniyede bir kasaya bakar ve dönünce aynı gönderim kimliğiyle kendiliğinden gönderir. Kasa aynı kimliği bir kez
  yazar: ilk deneme ulaşıp yanıtı kaybolduysa kalem ikinci kez yazılmaz (`src/lib/cart.ts` SendBatch,
  `tests/cevrimdisi.test.ts`, e2e akışı "kasa yeniden başlarken").
- Patronun dışarıdan erişimi: Tailscale (`docs/07-UZAKTAN-ERISIM.md`). LafPOS'u modemden port açarak internete
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
`LAFPOS_CLOUD_SECRET`'ten türetilir, buluta hiç gitmez) ve LafPOS Uzaktan'ın verdiği 15 dakikalık imzalı adrese yüklenir
(Vercel Blob, özel depo `lafpos-yedek`; `server/sync/yedek.ts`, `api/_yedek.ts`). Dükkân başına son 30 yedek kalır;
gidemezse yarım saatte bir yeniden denenir. Durum ve "Şimdi yedekle": Yönetim › Ayarlar ve yedek › Bulut yedeği.

**Geri yükleme** (yalnız patron, kendi PIN'iyle, gün kapalıyken, Windows kurulumunda): "Buluttan geri yükle" yedeği
seçtirir; seçilen yedek indirilir, çözülür, SQLite olduğu doğrulanır ve veri klasöründe `geri-yukle\hazir.db` olarak
bekler. Sunucu kapanır; bekçi açmadan önce mevcut veritabanının kopyasını alır
(`backups\lafpos-geri-yukleme-oncesi-<an>.db`) ve yedeği yerine koyar (`geri-yukle.mjs`), LafPOS yarım dakikada
yeniden açılır. **Yeni bilgisayarda:** LafPOS'u kurup ayarlar.env'e aynı `LAFPOS_CLOUD_URL` ve `LAFPOS_CLOUD_SECRET`
yazılınca eski bilgisayarın yedekleri listede "Kurulum" seçiminden bulunur. Denetim kaydına yazılır.

### Otomatik güncelleme (anahtarsız)

Kasa yeni sürümü kendisi alır; sahibin anahtar ya da ayar girmesi gerekmez.

- **Kanal:** Vercel'deki `lafpos` projesi her `main` derlemesinde `npm run kanal`'ı koşar
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
  Açılıştan 2 dk sonra, sonra 30 dk'da bir. Yeni derleme varsa zip'i indirip boyunu ve SHA-256'sını doğrular; Node
  ya da better-sqlite3 değiştiyse nodejs.org'dan ve WiseLibs'in GitHub sürümünden indirip manifestteki özetle
  doğrular. İndirilenler `C:\ProgramData\LafPOS\guncelleme\indirilen`.
- **Kurulum yalnız açık iş günü yokken:** güncelleyici sunucuya `GET /api/kasa/guncelleme-durumu` ile sorar
  (oturumsuz, yalnız bu bilgisayardan: yerel ağ ve Tailscale 403; yanıtta yalnız `dayOpen`). Gün açıksa 5 dk'da
  bir yeniden sorar. Sıra: yük `app.yeni`'ye açılır (yerel modül eskisinden ya da indirilenden, yeni Node
  `node.yeni`'ye), sunucu düzgün durur, veritabanı `backups\lafpos-guncelleme-<build>-<tarih>.db` olarak
  kopyalanır (son 5 güncelleme kopyası kalır), `app` → `app.eski`, `app.yeni` → `app`; yeni sürüm (bekçi ve
  sunucu) deneme olarak açılır. 60 sn içinde `/api/health` yeni derlemeyi söylerse deneme düzgün kapanır, bekçi 75
  koduyla çıkar, başlatıcı onu yeni sürümle açar. Söylemezse `app.eski` geri gelir, sunucu eski sürümle açılır ve
  o derleme bir daha denenmez (durum "Eski sürüme dönüldü"). `app.eski` elle geri dönüş için bir sonraki
  güncellemeye kadar durur.
- **Şimdi güncelle** (Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme; `POST /api/admin/guncelleme`, `ayar.yonet`):
  sunucu `guncelleme\istek.json` yazar, bekçi 2 sn'de bir bakar, dosyayı siler ve güncelleyiciye iletir
  (`requestNow`): kanala hemen sorar, yeni sürüm varsa indirir ve kurar. Gün kapalıysa hemen kurulur; gün açıkken
  patron onaylarsa (`simdi`, LafPOS bir dakika kadar kapanır, tabletler bekler) hemen, onaysız istek gün sonundan sonra.
  Otomatik güncelleme kapalıyken de çalışır (kapalıyken kendiliğinden denetim olmaz, yalnız düğmeyle). Kafede basılan
  düğme Merkez'in tutmasını aşar (kanalın son sürümü; Merkez'de dükkân "elle"deyken otomatik denetim kurmaz, düğme kurar);
  sorun çıkmış sürüm bir daha denenmez. İki dakikada alınmayan istek beklenmez (bekçi çalışmıyor), bekçi de
  10 dakikadan eski isteği yok sayar. Kurulum bitince kart yeni derlemeyi görür ve "Yenile" önerir. Denetim kaydına
  `guncelleme` düşer. Yalnız Windows kurulumunda (bekçi); git ile çalışan sunucuda düğme yok.
- **Kapatma:** `ayarlar.env`'de `LAFPOS_GUNCELLEME=kapali` (düğme yine çalışır).
- **Durum:** `C:\ProgramData\LafPOS\guncelleme\durum.json` (bekçi yazar, sunucu okur); Yönetim › Ayarlar ve yedek ›
  "Sürüm ve güncelleme" kartı kurulu sürümü, durumu, son denetimi ve son güncellemeyi gösterir; düğmesi "Şimdi güncelle".
  Kanala ulaşılamaması hata sayılmaz: kart son denetimin sonucunu yazar.
- Testler: `tests/guncelleme.test.ts` (manifest, karar, durum, kurulum ve geri dönüş akışı),
  `tests/guncelleme-sunucu.test.ts` (sunucunun iki ucu ve kart). Kurulum derlemesinin denemesi
  (`npm run kurulum:windows`) derleme numarasını, gün sorusunu ve durum dosyasını da sınar.

### İnternet yokken ve internet gelince

Uçtan uca denemesi `e2e/internet.mjs` (sahte lafmaliyet ucu kapalı ve açık). İnternetin dönüşü yapılandırılmış
adreslerin kendi portuna TCP ile denenir (adreste port yoksa https 443).

Kasa yerel sunucudur: satış, masa, ödeme ve Pavo internetsiz çalışır; açılışta ve arayüzde interneti bekleyen bir
şey yoktur (yazı tipleri ve görseller pakette, site menüsü kurulumda gelir).

- Dışarı gidecek kayıtlar kaybolmaz: lafmaliyet gün sonu ve sitenin Satışta yazımları giden kutusunda (`outbox`),
  LafPOS Uzaktan özeti bir sonraki itmede, online siparişler bir sonraki çekimde.
- İnternetin durumu yeni istek atmadan izlenir (`server/lib/internet.ts`): imzalı her isteğin sonucu yazılır, ağ
  hatası "yok", yanıt gelen istek (hata koduyla da) "var". İnternet yokken dakikada bir yapılandırılmış hostlardan
  birine yalnız TCP bağlantısı denenir (HTTP isteği yok).
- İnternet gelince (`server/sync/catch-up.ts`) giden kutusunun artan beklemesi (6 saate kadar) beklenmez, bir kez
  gönderilir: lafmaliyet, site, Uzaktan özeti ve online sipariş çekimi (kendi bütçesiyle). İki dönüş eşitlemesi
  arasında en az 5 dakika (AGENTS.md kural 6). Tam bir kez: gönderimler kendi sırasıyla (aynı anda iki kez
  çalışmaz), gönderilen satır `sentAt` alır, kalıcı reddedilen kayıt yeniden denenmez (`tests/internet-donusu.test.ts`).
- Durum alanında (üst çubuk) "İnternet yok · N kayıt bekliyor", hepsi gidince yarım saat "Bekleyenler gönderildi";
  her şey yolundayken ve dış bağlantı kurulmamış kasada rozet yok. Yönetim › Genel bakış › Sistem sağlığı'nda
  "İnternet" satırı ve her sistemin son başarılı gönderimi (site menüsü, online siparişler, lafmaliyet, LafPOS
  Uzaktan).

## 7. Boşta kaynak kullanımı

Kasa bilgisayarı gün boyu açık; LafPOS boşta işlemci ve bellek yemesin diye:

- **Sunucu:** JavaScript belleği bilgisayarın belleğinin dörtte biriyle sınırlı (1024-4096 MB; bekçi, §2). LafPOS
  Uzaktan'a (`docs/07-UZAKTAN-ERISIM.md` §4) özet değişmediyse gitmez: gün kapalıyken (gece) beş dakikalık nabız
  yalnız değişiklikte ya da son itmenin üstünden 15 dakika geçtiyse gider (boşta 15 dakikada bir); gün açıkken
  nabız sürer. Özet zlib'in iş havuzunda sıkıştırılır, kasanın istekleri beklemez.
- **Kasa ekranı:** paket platformu şeridinin saniyelik geri sayımı yalnız onay bekleyen sipariş varken işler;
  platform listesi yalnız bir platform açıkken (deneme ya da canlı) ya da bekleyen sipariş varken 30 sn'de bir
  yoklanır, yeni sipariş canlı akışla zaten gelir. "Hazır" nabzı (salon kartı, teslim ekranı) yalnız transform
  ve opacity canlandırır: ekran kartında döner, kare kare yeniden boyanmaz; hareket azaltmada durur.
