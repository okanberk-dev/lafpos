# Kalan işler (devir notu)

Bu dosya, işi başka bir oturumun (ya da başka bir Claude'un) kaldığı yerden sürdürmesi içindir. Önce `AGENTS.md`'yi
oku; kurallar orada. Bitirdiğin maddeyi buradan sil, yarım bıraktığını "Durum" satırıyla güncelle.

Son güncelleme: 21 Kasım 2026.

## Main'de olanlar (bitti)

- **Kasa:** Pavo N86 (satış, iptal, eşleştirme, banka gün sonu; `docs/04-YAZARKASA.md` §8), lafmobil masa çağrıları,
  Windows 10'da düşük kaynak, deneme modu ve "Denemeyi bitir, gerçek kullanıma başla".
- **Kurulum ve güncelleme:** LafPOS-Kurulum.exe her main push'unda GitHub Release; anahtarsız otomatik güncelleme
  (`/guncelleme/`, gün kapalıyken); Windows CI'da gerçek kurulum, güncelleme (75 kodu, `app.eski`, `node.yeni`) ve
  geri dönüş denemesi (`ci-kurulum.mjs`); Vercel kanalının derleme numarası commit zamanı (doğrulandı).
- **Site:** lafpos.laffogato.net'te e-posta, parola ve davet koduyla üyelik; İndir ve anahtarsız web kurucusu.
- **Merkez** (`/merkez`): dükkânlar, kayıt ve imza, lisans (14 gün deneme, bitişe 14 gün kala uyarı, süresi dolunca
  uyarı, 7 gün sonra satış kapanır; internetsiz kasada satış hiç kapanmaz, yalnız uyarı), şube kodu, seçerek
  güncelleme gönderme ve dükkân bazında "Şimdi güncelle", dükkân bazında uzaktan görünüm ve dükkân seçici.
- **Uzaktan raporlar:** bütün sekmeler ve CSV kasadakiyle birebir (`shared/remote-calc.ts`, `shared/report-csv.ts`),
  gün aşırı ödeme ve bugünkü kategori, "Raporları yeniden gönder".
- **Sağlamlık:** internet kesintisi e2e (`e2e/internet.mjs`), telefonda Yönetim şeridinde internet rozeti; tabletler
  kasaya ulaşamayınca siparişi bekletip kendiliğinden ve tam bir kez gönderir (`SendBatch`).
- **Patrona telefon bildirimi** (Web Push): büyük iptal ve ikram, kasa farkı, internet kesintisi, güncelleme ve Pavo
  sorunları; eşikler Yönetim › Ağ ve uzaktan erişim.
- **Bulut yedeği:** günlük şifreli yedek Vercel Blob'a (özel), buluttan geri yükleme sihirbazı (patron, PIN).
- **Karşılama sihirbazı:** Genel bakış'ta kurulum adımları.
- **Fiyat işareti:** sitede değişen fiyat, online sipariş ve karaoke kapalıyken de gün açıkken hemen eşitlenir.
- **Fiş yazıcısı kendiliğinden** (kablolu/USB): kasa kısayolu yazıcıları bildirir, tek fiş yazıcısını varsayılan yapar;
  Yönetim › Ayarlar ve yedek › Fiş yazıcısı (`docs/05-KASA-BILGISAYARI.md` §3). İndirim nedenleri Öğrenci ve Çalışan,
  dokununca %15. Sekmesiz ekranda üst çubuk yok (`DESIGN.md` Kabuk).
- **Her şey programın içinden:** Pavo'nun adresi ve seri no'su Yönetim › Yazarkasa POS'tan (ağda arama, kaydedince
  hemen eşleştirme; `docs/04-YAZARKASA.md` §8.1); lafmaliyet, Uzaktan, site, Token ve paket platformu anahtarları
  Yönetim › Bağlantı bilgileri'nden (hazır satırları yapıştırma da; `docs/05-KASA-BILGISAYARI.md` §2); "Şimdi
  güncelle" düğmesi (§6).

## 1. Kafede ilk kurulumda bakılacaklar (sahibin ya da kafedeki birinin)

Kod hazır ve denendi; aşağıdakiler yalnız gerçek cihaz ve gerçek internetle görülür.

- **İlk kurulum:** LafPOS-Kurulum.exe (ya da sitede İndir) ile kurulum; Yönetim › Bağlantı bilgileri › "Hazır
  satırları yapıştır"a bağlantı satırları (aşağıda; "deneme bittikten sonra" notlu satırlar o an atlanır). Genel
  bakış'taki Kurulum kartı adımları sırayla gösterir. İlk gerçek Windows'ta bakılacak: kaydedince bekçinin sunucuyu
  birkaç saniyede yeniden başlattığı ve ekranın "yeni bilgilerle açıldı" dediği.
- **Pavo:** Yönetim › Yazarkasa POS › Pavo › "Cihazı ağda ara" (ya da IP), seri no, Kaydet, Eşleştir; küçük bir
  deneme satışı ve "Cihazın son yanıtları". Ağda aramanın gerçek N86'yı bulduğu ilk kurulumda görülür.
- **Fiş yazıcısı:** yazıcı USB ile takılı ve sürücüsü kurulu; kasa ekranını kapatıp açınca Ayarlar ve yedek › Fiş
  yazıcısı'nda listelenmeli ve "Fiş buradan" yazmalı; "Deneme fişi yazdır" kasa bilgisayarında basılınca kâğıt çıkmalı.
- **Şimdi güncelle:** bu sürümden sonraki ilk yayında Ayarlar ve yedek › Sürüm ve güncelleme › "Şimdi güncelle";
  gün kapalıyken bir dakika içinde kurulup "Yeni sürüm kuruldu · Yenile" demeli.
- **Denemeyi bitir:** gün sonu, sonra Yönetim › Ayarlar ve yedek › Denemeyi bitir; yedeğin
  `C:\ProgramData\LafPOS\backups`'a yazıldığı ve kapanan hesapların Personel'den yeni PIN'le açıldığı görülür.
- **İnternet:** kafede interneti kesip bir gün sonu; üst çubukta "İnternet yok · 1 kayıt bekliyor", internet gelince
  "Bekleyenler gönderildi" ve lafmaliyet'te gün bir kez.
- **Uzaktan raporlar:** kafe bağlanınca tarama yaklaşık bir saatte 400 günü iter; Raporlar › Ciro "Geçen ay"
  kafedekiyle aynı olmalı. Upstash › Usage'de günlük komut sayısı izlenir: uzaktan ekranın yoklaması koşullu (özet
  değişmediyse 304, tek küçük okuma), tek ekran gün boyu açıkken (12 saat açık gün, 12 saat gece) ekran ve kasanın
  itmesi günde ~5 bin komut (eskiden ~27 bin; `docs/07-UZAKTAN-ERISIM.md` §4 "Upstash bütçesi"). Merkez nabzı ve
  rapor itmesi bunun üstüne; ilk tam günde toplam bu düzeyde kalmalı.
- **Telefon bildirimi:** Uzaktan › Merkez › Telefon bildirimleri › "Bu telefonda aç" (iPhone'da önce Ana Ekrana
  Ekle); Yönetim › Ağ › "Deneme bildirimi gönder".
- **Bulut yedeği:** ilk gün sonundan sonra Ayarlar ve yedek › Bulut yedeği'nde "Son yedek" dolmalı.

Kafedeki bağlantı satırları (Yönetim › Bağlantı bilgileri'ne yapıştırılır). **Anahtarlar 21 Kasım 2026'da yenilendi:**
Vercel kayıtlarında kasanın 20 Kasım'daki istekleri siteden ve lafmaliyet'ten 401 almıştı (kasadaki anahtarlar
Vercel'dekilerle uyuşmuyordu), LafPOS Uzaktan'a imzalı istek hiç gelmemişti. Üç projede anahtar yeniden üretildi
(laffogato ve lafmaliyet `LAFPOS_SYNC_SECRET`, lafpos `LAFPOS_CLOUD_SECRET`; üretim yeniden yayımlandı) ve yeni satırlar
sahibe dosya olarak verildi (`lafpos-kasa-ayarlari.env`, 21 Kasım). Mac'teki eski `~/Downloads/lafpos-kasa-ayarlari.env`
**geçersiz**. Dosya kaybolursa anahtarlar yeniden üretilir (`scripts/vercel/baglanti-kur.sh --yenile` ya da Vercel'de
elle) ve kasaya yeniden yapıştırılır; Vercel'deki değerler "sensitive", geri okunamaz. Kasa bağlanınca doğrulama: Yönetim
› Genel bakış › Sistem sağlığı ve Site ve lafmaliyet sayfasındaki durum satırları.

```
LAFMALIYET_URL=https://ladmin.laffogato.net
LAFMALIYET_SYNC_SECRET=...
LAFPOS_CLOUD_URL=https://lafpos.laffogato.net
LAFPOS_CLOUD_SECRET=...
LAFFOGATO_URL=https://laffogato.net        (deneme bittikten sonra)
LAFFOGATO_SYNC_SECRET=...                  (deneme bittikten sonra)
PAVO_URL=https://<cihazın IP adresi>:4567
PAVO_SERIAL=<cihazın seri numarası>
```

## 2. Sahibin kararını bekleyenler (sormadan yapılmaz)

- **Personel mesaisi:** 4 Kasım 2026'da sahibin kararıyla kaldırıldı (`docs/02-PLAN.md` "Mesai kaldırıldı"). Yeniden
  istenirse eski tasarım ve tablo (`time_entries`) duruyor; yalnız vardiya kasa sayımı kullanılıyor.
- **Marina şubesi (karar verildi, 21 Kasım 2026):** önce Marina LafPOS'a geçer, Tuzla ModPOS'ta kalır. LafPOS'un
  varsayılan şubesi `marina`; lafmaliyet'te LafPOS'un şubesi Marina (`LAFPOS_BRANCH_ID`), başka şubeye ayarlı kasanın
  günü reddedilir. Marina'nın ModPOS'u yedek olarak çekilmeye devam eder (lafmaliyet'te şubenin kasa kaynağı ModPOS
  kalır); geçiş gününden sonra sayılan LafPOS'un günüdür. Marina'da LafPOS kurulup denenince lafmaliyet'te geçiş günü
  seçilir. Tuzla da geçecekse lafmaliyet'te LafPOS'un şubesi listeye döner (ayrı iş).
- **Stok ve reçete düşümü:** lafmaliyet'in tasarımı aylık sayım ve dönemsel FIFO (`docs/STOK-DEGERLEME.md`); satıştan
  anlık düşüm yok. Kritik stok uyarısı isteniyorsa önce lafmaliyet'te anlık stok tasarımı gerekir.
- **Merkez için iki aşamalı giriş:** üye girişi davet kodu, parola ve deneme sınırıyla korunuyor. Telefonda doğrulama
  uygulaması (TOTP) eklenebilir; sahip kullanmak isterse.
- **Kod imzası:** sertifika alınırsa izlenecek yol `docs/05-KASA-BILGISAYARI.md` §2 "Kod imzası"; alınmazsa
  "Yine de çalıştır" anlatımı kalır.
- **Vercel planı:** ekip ücretli planda görünüyor (21 Kasım faturası günde ~0,4 $, LafPOS'un payı çok küçük). Kafe
  bağlanınca bir ay sonra Vercel › Usage ve Upstash › Usage bir kez bakılır.

## 3. Dış bilgi gelince yapılacaklar

- **Pavo bulut kanalı (UniCloud) ve masada ödeme listesi:** Pavo App Token ve belgeleri gelmeden tahmin yürütülmez
  (`docs/04-YAZARKASA.md` §8.4).
- **Yemeksepeti ve Getir canlı denemesi:** platformların verdiği anahtarlar ve test restoranı gerekir
  (`docs/PAKET-PLATFORMLARI.md`); aktarıcılar hazır.

## 4. Sıradaki geliştirmeler (öneri sırası)

1. **baslat.cmd güncellemeyle değişmez (bilerek):** kurulum klasöründe durur, otomatik güncelleme yalnız `app\`'i
   değiştirir. Çalışan toplu dosyayı değiştirmek güvenli değil (cmd.exe dosyayı satır satır okur). 21 Kasım'daki Node
   değişimi yeniden denemesi yeni kurulumlarda var; eski kurulumda değişim ertelenirse bir sonraki açılışta tamamlanır.
2. **Tasarım turu (sürüyor):** ekran ekran ızgara ve hizalama; bu oturumda örnek masa planı, patron ciro kartı ve
   tek boylu üründe boy rozeti düzeldi. Sırada adisyon ürün karoları ve yönetim formları (`DESIGN.md`).

## Çalışma kuralları (kısa)

- Dal `claude/<konu>`; `main`'e doğrudan push yok, PR ile. Sahip main'e göndermeyi istedi: CI yeşilse PR birleştirilir.
- Commit öncesi `npm run typecheck && npm test`; arayüze dokunduysan `npm run build && npm run e2e`
  (`LAFPOS_E2E_CHROME=/opt/pw-browsers/chromium` bulut ortamında).
- Gizli değer hiçbir dosyaya ve commit'e girmez; `data/` ve `.env` asla.
- Sahip yazılımcı değil: arayüz ve belge dili sade Türkçe; ondan teknik adım istenmez.
