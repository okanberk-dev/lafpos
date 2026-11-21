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
- **Merkez** (`/merkez`): dükkânlar, kayıt ve imza, lisans (14 gün deneme, uyarı, 7 gün sonra satış kapanır,
  internetsiz son kayıt), seçerek güncelleme gönderme, dükkân bazında uzaktan görünüm ve dükkân seçici.
- **Uzaktan raporlar:** bütün sekmeler ve CSV kasadakiyle birebir (`shared/remote-calc.ts`, `shared/report-csv.ts`),
  gün aşırı ödeme ve bugünkü kategori, "Raporları yeniden gönder".
- **Sağlamlık:** internet kesintisi e2e (`e2e/internet.mjs`), telefonda Yönetim şeridinde internet rozeti; tabletler
  kasaya ulaşamayınca siparişi bekletip kendiliğinden ve tam bir kez gönderir (`SendBatch`).
- **Patrona telefon bildirimi** (Web Push): büyük iptal ve ikram, kasa farkı, internet kesintisi, güncelleme ve Pavo
  sorunları; eşikler Yönetim › Ağ ve uzaktan erişim.
- **Bulut yedeği:** günlük şifreli yedek Vercel Blob'a (özel), buluttan geri yükleme sihirbazı (patron, PIN).
- **Karşılama sihirbazı:** Genel bakış'ta kurulum adımları.

## 1. Kafede ilk kurulumda bakılacaklar (sahibin ya da kafedeki birinin)

Kod hazır ve denendi; aşağıdakiler yalnız gerçek cihaz ve gerçek internetle görülür.

- **İlk kurulum:** LafPOS-Kurulum.exe (ya da sitede İndir) ile kurulum; Başlat › LafPOS › LafPOS ayarları'na
  bağlantı satırları (aşağıda). Genel bakış'taki Kurulum kartı adımları sırayla gösterir.
- **Pavo:** Yönetim › Yazarkasa POS › Pavo › Eşleştir; küçük bir deneme satışı ve "Cihazın son yanıtları".
- **Denemeyi bitir:** gün sonu, sonra Yönetim › Ayarlar ve yedek › Denemeyi bitir; yedeğin
  `C:\ProgramData\LafPOS\backups`'a yazıldığı ve kapanan hesapların Personel'den yeni PIN'le açıldığı görülür.
- **İnternet:** kafede interneti kesip bir gün sonu; üst çubukta "İnternet yok · 1 kayıt bekliyor", internet gelince
  "Bekleyenler gönderildi" ve lafmaliyet'te gün bir kez.
- **Uzaktan raporlar:** kafe bağlanınca tarama yaklaşık bir saatte 400 günü iter; Raporlar › Ciro "Geçen ay"
  kafedekiyle aynı olmalı. Upstash › Usage'de günlük istek sayısı izlenir (uzaktan ekran gün boyu açık kalırsa
  ücretsiz kotaya yaklaşabilir).
- **Telefon bildirimi:** Uzaktan › Merkez › Telefon bildirimleri › "Bu telefonda aç" (iPhone'da önce Ana Ekrana
  Ekle); Yönetim › Ağ › "Deneme bildirimi gönder".
- **Bulut yedeği:** ilk gün sonundan sonra Ayarlar ve yedek › Bulut yedeği'nde "Son yedek" dolmalı.

Kafedeki ayarlar.env satırları (değerler Mac'te `~/Downloads/lafpos-kasa-ayarlari.env`; yoksa
`scripts/vercel/baglanti-kur.sh --yenile`):

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
- **Marina şubesi:** kasada şube ayarı (Yönetim › Ayarlar › Şube) ve Merkez'de ayrı dükkân hazır. lafmaliyet gelen
  gün sonundaki `sube`'yi okumuyor, hepsini Tuzla'ya yazıyor (`lafmaliyet/src/server/lafpos/ingest.ts`, kilit ve Z
  denetimi gün başına). Marina LafPOS'a geçecekse önce lafmaliyet'te ayrı PR: şemanın `sube`'yi kabul etmesi, kilidin ve
  Z denetiminin (gün, şube) olması, tanınmayan şubenin reddedilmesi.
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

1. **Fiyat işareti:** sitede fiyat değişince kasaya hemen gelmesi yalnız online sipariş turu çalışırken (açık gün,
   online sipariş ya da karaoke açık); öteki durumlarda 15 dakikalık menü çekimini bekler
   (`server/sync/laffogato-orders.ts` `onlineOrdersTick`). Sürüm sinyali menü için ayrıca okunabilir (20 sn bütçesi).
2. **Tasarım turu (sürüyor):** ekran ekran ızgara ve hizalama; bu oturumda örnek masa planı, patron ciro kartı ve
   tek boylu üründe boy rozeti düzeldi. Sırada adisyon ürün karoları ve yönetim formları (`DESIGN.md`).

## Çalışma kuralları (kısa)

- Dal `claude/<konu>`; `main`'e doğrudan push yok, PR ile. Sahip main'e göndermeyi istedi: CI yeşilse PR birleştirilir.
- Commit öncesi `npm run typecheck && npm test`; arayüze dokunduysan `npm run build && npm run e2e`
  (`LAFPOS_E2E_CHROME=/opt/pw-browsers/chromium` bulut ortamında).
- Gizli değer hiçbir dosyaya ve commit'e girmez; `data/` ve `.env` asla.
- Sahip yazılımcı değil: arayüz ve belge dili sade Türkçe; ondan teknik adım istenmez.
