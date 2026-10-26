# Kasa bilgisayarı: Chrome'da sürekli açık LafPOS

LafPOS'un sunucusu kafedeki **kasa bilgisayarında** çalışır; kasa ekranı aynı bilgisayarda Chrome'da tam ekran
(kiosk) açık durur. Tezgâh tableti, garson telefonları ve bar ekranı aynı sunucuya kafenin ağından bağlanır
(`http://<kasa-ip>:4000`). Ödeme yazarkasa POS'a gider (`docs/04-YAZARKASA.md`), fişler 80 mm yazıcıdan
sessizce çıkar. Neden tek sistem: `docs/06-TEK-SISTEM.md`.

## 1. Gerekenler

| | |
|---|---|
| Bilgisayar | Windows 10/11 (önerilen) ya da macOS; SSD, 8 GB bellek yeter |
| Yazılım | Google Chrome (güncel), Node.js 24 LTS (en az 22.11), Git |
| Fiş yazıcısı | 80 mm termal; Windows'ta **varsayılan yazıcı** yapılır, kağıt 80 mm |
| Para çekmecesi | Yazıcıya bağlı; açılması yazıcı sürücüsünün "belge yazdırılınca çekmeceyi aç" ayarıyla (tarayıcı çekmece açamaz) |
| Ağ | Kasa bilgisayarına sabit IP (modemde DHCP rezervasyonu); tablet ve telefonlar aynı ağda |
| Yazarkasa POS | TokenX Connect bilgileri `.env`'de |

## 2. Kurulum (bir kez)

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
- **Tam ekran**: kiosk kullanılmayan tablet ya da bilgisayarda kullanıcı menüsünden.
- Kasiyer rolü varsayılan olarak **kör kasa** sayar: ara raporu ve beklenen nakdi görmez, gün sonunda
  çekmeceyi sayıp yazar; fark yöneticinin ekranında (Yönetim › Roller ve yetkiler).

## 5. Tabletler, telefonlar, patron

- Aynı ağdaki cihazlar: `http://<kasa-ip>:4000`. Chrome menüsünden "Ana ekrana ekle" ile uygulama gibi açılır.
- Bar ekranı tableti: rol "Mutfak / Bar" olan personelle girilir, açılışta bar ekranı gelir.
- Patronun dışarıdan erişimi: kasa bilgisayarına Tailscale gibi bir VPN ya da tünel; LafPOS'u doğrudan
  internete açmayın.

## 6. Yedek ve güncelleme

- Yedekler `data/backups/` altında günlük alınır (Yönetim › Ayarlar ve yedek). Haftada bir harici diske ya da
  buluta kopyalayın.
- Güncelleme: `git pull`, `npm ci`, `npm run build`, ardından sunucuyu yeniden başlatın (Windows'ta Görev
  Zamanlayıcı'da "LafPOS Sunucu"yu Sonlandır › Çalıştır; macOS'ta `launchctl kickstart -k gui/$UID/net.laffogato.lafpos`).
