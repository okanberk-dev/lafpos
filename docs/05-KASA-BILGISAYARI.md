# Kasa bilgisayarı: Windows kurulumu, Chrome'da sürekli açık LafPOS

LafPOS'un sunucusu kafedeki **kasa bilgisayarında** çalışır; kasa ekranı aynı bilgisayarda Chrome'da tam ekran
(kiosk) açık durur. Tezgâh tableti, garson telefonları ve bar ekranı aynı sunucuya kafenin ağından bağlanır
(`http://<kasa-ip>:4000`). Ödeme yazarkasa POS'a gider (`docs/04-YAZARKASA.md`), fişler 80 mm yazıcıdan
sessizce çıkar. Neden tek sistem: `docs/06-TEK-SISTEM.md`.

## 1. Gerekenler

| | |
|---|---|
| Bilgisayar | Windows 10/11 (önerilen) ya da macOS; SSD, 8 GB bellek yeter |
| Yazılım | Google Chrome (güncel; yoksa Windows'un Edge'i kullanılır). Kurulum dosyasıyla başka bir şey gerekmez; git ile kurulumda Node.js 24 LTS (en az 22.11) ve Git |
| Fiş yazıcısı | 80 mm termal; Windows'ta **varsayılan yazıcı** yapılır, kağıt 80 mm |
| Para çekmecesi | Yazıcıya bağlı; açılması yazıcı sürücüsünün "belge yazdırılınca çekmeceyi aç" ayarıyla (tarayıcı çekmece açamaz) |
| Ağ | Kasa bilgisayarına sabit IP (modemde DHCP rezervasyonu); tablet ve telefonlar aynı ağda |
| Yazarkasa POS | TokenX Connect bilgileri `.env`'de (kurulum dosyasıyla: Başlat › LafPOS › LafPOS ayarları) |

## 2. Kurulum (bir kez)

### Windows: kurulum dosyası (önerilen)

`LafPOS-Kurulum-<sürüm>.exe` GitHub'daki sürüm sayfasından (Releases) indirilir; Node, Git ya da komut satırı
gerekmez. Dosya imzasız olduğu için Windows "Bilgisayarınız korundu" der: **Ek bilgi › Yine de çalıştır**.
Kurulum yönetici izni ister ve şunları yapar:

| | |
|---|---|
| Uygulama | `C:\Program Files\LafPOS`: Node 24 LTS, sunucu, arayüz, kasa kısayolu. Yalnız yöneticiler değiştirir |
| Veri | `C:\ProgramData\LafPOS`: veritabanı, `secret.key`, günlük yedekler (`backups\`), `ayarlar.env`, sunucu günlüğü (`logs\`). Yalnız SYSTEM ve yöneticiler açar |
| Sunucu | Görev Zamanlayıcı'da "LafPOS Sunucu": Windows açılınca SYSTEM olarak, kimse oturum açmasa da; süre sınırı yok, pilde de çalışır. Bekçi (`app\bekci.mjs`) düşen sunucuyu 1-30 sn içinde yeniden başlatır; bekçi düşerse görevin beş dakikalık güvence tetiği yeniden açar |
| Güvenlik duvarı | TCP 4000 yalnız kafenin ağına ve Tailscale'e (`100.64.0.0/10`) açık |
| Kısayollar | Masaüstünde ve Başlangıç'ta "LafPOS Kasa" (seçilebilir); Başlat › LafPOS: kasa, tarayıcıda aç, ayarlar, sunucuyu yeniden başlat, sunucu günlüğü, kurulum notları, kaldır |
| Güç | "Prizdeyken uyku kapalı" (seçilebilir): uyuyan bilgisayara tablet bağlanamaz |

- **Ayarlar** (site, lafmaliyet, yazarkasa anahtarları): Başlat › LafPOS › LafPOS ayarları. `ayarlar.env`
  Not Defteri'nde açılır; kaydedince (Ctrl+S) bekçi değişikliği görür ve sunucuyu yeni ayarlarla yeniden başlatır.
  İlk kurulumda site bağlantısı kapalıdır (`LAFFOGATO_URL` satırı yorumlu): LafPOS siteye hiç bağlanmaz, menü
  kurulumdaki gibi kalır. Açmak için `docs/03-ENTEGRASYON.md` §8 (açılış sırası).
- **Güncelleme:** yeni kurulum dosyasını çalıştırın. Sunucuyu durdurur, veritabanını
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
  Windows Güvenliği › Uygulama ve tarayıcı denetimi'nden bakın. Kalıcı çözüm kod imzası.

**Kurulum dosyasını derlemek** (macOS, Linux ya da Windows): `npm run kurulum:windows`; gereken NSIS
(`brew install makensis`, `apt install nsis`). Betik (`scripts/kasa/windows/kurulum/derle.mjs`) arayüzü derler,
sunucuyu esbuild'le tek dosyaya paketler, nodejs.org'dan Node'u (SHA-256 denetimiyle) ve better-sqlite3'ün
Windows ikilisini indirir, paketi bu bilgisayarın Node'uyla bekçi üzerinden açıp dener (giriş, açılış verisi,
arayüz, günlük), sonra `dist/windows/LafPOS-Kurulum-<sürüm>.exe`'yi üretir. Windows'a giden Node sürümü betiğin
başında (`NODE_VERSION`, `NODE_ABI`). Sunucuya çalışırken diskten dosya okuyan yeni bir şey eklenirse (göç,
anlık görüntü gibi) betikte pakete de eklenir.

**İlk gerçek Windows kurulumunda bakılacaklar.** Kurulum dosyası macOS'ta derlendi; paket Node 24.22.1 ile
satış akışından geçti, görev XML'i ve Windows ikilileri denetlendi. Windows'a özgü adımlar (kurulum, görev,
güvenlik duvarı, kiosk) henüz gerçek bir Windows'ta koşmadı. İlk kurulumda: Görev Zamanlayıcı'da "LafPOS
Sunucu" çalışıyor; `http://localhost:4000` açılıyor; tablet kafenin ağından bağlanıyor;
`C:\ProgramData\LafPOS\logs\sunucu.log` yazılıyor; bilgisayar yeniden başlayınca sunucu ve kasa ekranı
kendiliğinden geliyor; LafPOS ayarları kaydedilince sunucu yeniden başlıyor.

### Git ile (geliştirici; Windows ya da macOS)

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

**İlk yazdırmadan önce bir kez:** Chrome'u kiosksuz açıp (`chrome --user-data-dir=…\LafPOS\chrome`) bir fişi
yazdırın ve fiş yazıcısını seçin. Chrome kiosk modunda "son kullanılan" yazıcıya basabilir; böylece o fiş
yazıcısı olur. Yazdırma önizlemesini kapatan Chrome ayarını açmayın: kiosk yazdırma önizlemeyle çalışır.

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
- Patronun dışarıdan erişimi: Tailscale (`docs/07-UZAKTAN-ERISIM.md`). LafPOS'u modemden port açarak internete
  açmayın.

## 6. Yedek ve güncelleme

- Yedekler veri klasörünün `backups/`'ında günlük alınır (Yönetim › Ayarlar ve yedek): kurulum dosyasıyla
  `C:\ProgramData\LafPOS\backups`, git ile `data/backups/`. Haftada bir harici diske ya da buluta kopyalayın.
- Güncelleme: kurulum dosyasıyla yeni sürümü çalıştırın (§2). Git ile: `git pull`, `npm ci`, `npm run build`, ardından sunucuyu yeniden başlatın (Windows'ta Görev
  Zamanlayıcı'da "LafPOS Sunucu"yu Sonlandır › Çalıştır; macOS'ta `launchctl kickstart -k gui/$UID/net.laffogato.lafpos`).
