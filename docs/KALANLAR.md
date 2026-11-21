# Kalan işler (devir notu)

Bu dosya, işi başka bir oturumun (ya da başka bir Claude'un) kaldığı yerden sürdürmesi içindir. Önce `AGENTS.md`'yi
oku; kurallar orada. Bitirdiğin maddeyi buradan sil, yarım bıraktığını "Durum" satırıyla güncelle.

Son güncelleme: 21 Kasım 2026.

## Main'de olanlar (bitti)

- Pavo N86 yazarkasa: satış, sonuç, iptal, eşleştirme, banka gün sonu (`docs/04-YAZARKASA.md` §8). Gerçek cihazla
  henüz denenmedi: ilk satış küçük tutarla yapılır, "Cihazın son yanıtları" (Yönetim › Yazarkasa POS) incelenir.
- lafmobil ve site siparişleri: masa çağrıları ("Garson çağır"), bar istasyonu yedeği, planlı sipariş penceresi
  (`docs/03-ENTEGRASYON.md`).
- Windows 10: boşta düşük kaynak, bellek sınırı, Windows'ta kurulum paketi denemesi (`.github/workflows/windows.yml`,
  `docs/05-KASA-BILGISAYARI.md`).

## 1. Kurulum dosyası, otomatik güncelleme, internet dönüşü

**Durum:** yarım. Başlangıcı GitHub'da `claude/exe-guncelleme-wip` dalında (doğrulanmadı):
`scripts/kasa/windows/kurulum/guncelle.mjs` (güncelleyici yardımcıları, 587 satır) ve `arsiv.mjs` (zip açma).
Bu dal main'den (#54) sonraki duruma göre `main`'le birleştirilip aşağıdaki tarife göre tamamlanır; henüz
bekçiye, derle.mjs'e, CI'a, vercel.json'a ve README'ye bağlanmadı, testi yok.

Sahibin isteği: "Uygulama Windows'a exe olarak kurulsun; README'de basitçe anlat; GitHub'a her yüklemede kasa
kendiliğinden güncellensin; ben anahtar (token) oluşturmayayım; internet yokken de çalışsın; internet gelince o
sürede yapılan satışlar gönderilsin ve sistemde görünsün."

- **İlk kurulum dosyası:** main'e her push'ta GitHub Actions (windows-latest) `LafPOS-Kurulum.exe` ve
  `LafPOS-Kurulum.exe.sha256`'yı sabit adlarla GitHub Release olarak yayımlar (`gh release create`,
  `permissions: contents: write`). Sürüm: `package.json`'ın major.minor'u + çalıştırma no. Sahip exe'yi bir kez
  Releases'tan indirir.
- **Güncelleme kanalı (gizli anahtar yok):** Vercel'deki `lafpos` projesi main'i zaten kendisi yayımlıyor. Onun
  derlemesi `dist/web/guncelleme/surum.json` ve `lafpos-app-<build>.zip` üretir: kurulumun `app/` yükü, `node.exe` ve
  `better_sqlite3.node` hariç. `build` = HEAD commit'inin unix zamanı (`git log -1 --format=%ct`); aynı commit'in
  GitHub ve Vercel derlemesi aynı numarayı taşır. Manifestte zip'in sha256'sı ve boyutu, Node ve better-sqlite3
  sürümleri ve sha256'ları (derle.mjs sabitlerinden) bulunur. `vercel.json` SPA yönlendirmesi `/guncelleme/*`'ı
  `index.html`'e çevirmemeli. Paketin açık adreste durması yeni bir şey açmaz: aynı sunucu kodu zaten herkese açık
  demoda (`/demo`).
- **Kasadaki güncelleyici (bekçi):** ayar gerekmez. Sırayla
  `https://lafpos.laffogato.net/guncelleme/surum.json`, `https://lafpos.vercel.app/guncelleme/surum.json`; yalnız
  HTTPS, başka hosta yönlendirme reddedilir; açılıştan 2 dk sonra, sonra 30 dk'da bir (ETag). Yeni build varsa
  indirir, sha256 ve boyutu doğrular, **yalnız açık iş günü yokken** kurar: veritabanı yedeği, sunucuyu düzgün durdur,
  `app` → `app.eski`, yeni zip'i aç, sağlık denetimi (60 sn), olmazsa geri dön ve o build'i bir daha deneme. Node ya
  da better-sqlite3 değiştiyse açık kaynaklarından (nodejs.org, WiseLibs) indirip manifestteki sha256 ile doğrular;
  çalışan `node.exe`'nin yerine geçmek için zamanlanmış görev küçük bir başlatıcıdan (`baslat.cmd`) çalışır.
  `LAFPOS_GUNCELLEME=kapali` kapatır. Durum `C:\ProgramData\LafPOS\guncelleme\durum.json`'da; Yönetim › Ayarlar ve
  yedek'te sürüm ve durum görünür.
- **İnternet yokken:** kasa yerel sunucudur, satış, masa, ödeme ve Pavo internetsiz çalışır. Açılışta ve arayüzde
  interneti bekleyen bir şey kalmamalı.
- **İnternet gelince:** lafmaliyet gün sonu, site outbox'ı, Uzaktan özeti ve online sipariş çekimi kuyrukta bekleyeni
  kaybetmeden ve iki kez göndermeden yollar; bağlantı dönünce aralık beklemeden bir kez eşitler (`AGENTS.md` kural 6'nın
  istek bütçesi içinde). Durum alanında "İnternet yok · N kayıt bekliyor" ve sonra "Bekleyenler gönderildi" görünür,
  her sistemin son başarılı gönderim saati Genel bakış › Sistem sağlığı'nda.
- **README:** "Windows'a kurulum" bölümü (indirme, SmartScreen "Ek bilgi › Yine de çalıştır", kurulum, ayarlar,
  güncellemeler, elle güncelleme, kapatma, internetsiz çalışma, sorun giderme, geliştirici notu).

## 2. Merkez: dükkânlar, lisans, seçerek güncelleme

**Durum:** başlamadı (1'in üstüne kurulur).

Sahibin isteği: "Yazılımı güncellediğimde uzaktan açıp güncelleme gönder diyebileyim, hangi dükkânların
kullandığına bakayım, tek tek seçip gönderebileyim; lisans tanımlaması da olsun."

Verilen kararlar (sahip itiraz etmedi; değişirse burayı güncelle):

- Panel `https://lafpos.laffogato.net/merkez`, LafPOS Uzaktan'ın patron parolasıyla (`LAFPOS_UZAKTAN_PAROLA`,
  Vercel). Veri Upstash Redis'te (lafpos projesine bağlı).
- Her kurulum ilk açılışta bir kurulum kimliği ve gizli anahtar üretir, internete ilk çıktığında Merkez'e kendini
  bildirir (ilk görüşte güven), Merkez'de "Onay bekliyor" görünür. Dükkânda kimse anahtar girmez.
- Sahip dükkâna ad verir, lisansı "Aktif (şu tarihe kadar)" ya da "Pasif" yapar. Onaysız kurulum 14 gün deneme
  modunda çalışır. Pasif ya da süresi dolan lisans önce uyarı gösterir, 7 gün sonra yeni satışı kapatır; kayıtlar ve
  raporlar açık kalır. Son geçerli lisans kasada saklanır: internet ya da Merkez yokken kasa durmaz.
- Merkez listesi: dükkân adı, kurulu sürüm, son görülme, çevrimiçi mi, güncelleme durumu ("İndiriliyor", "Gün
  kapanınca kurulacak", "Kuruldu", "Sorun çıktı, eski sürüme döndü"). Dükkânlar seçilip "Güncelleme gönder";
  dükkân başına "otomatik güncelle" ya da "ben gönderince" (varsayılan: ben gönderince). Yeni sürüm main'e girince
  Merkez'de "Yeni sürüm hazır" ve kısa değişiklik notuyla görünür.
- Güncelleyici bu durumda genel manifest yerine Merkez'e kendi kurulum kimliğiyle imzalı sorar ("hangi build'i
  çalıştırayım"), Merkez yoksa son bildiği hedefte kalır.

## 3. Uzaktan raporlar (lafpos.laffogato.net)

**Durum:** başlamadı (2 ile birlikte).

Bugün Uzaktan'da yalnız bugünün patron paneli, masalar ve bar kuyruğu var; Raporlar sayfası yalnız kafedeki
bilgisayarda. Yapılacak:

- Kasa her kapanan günün ve gün boyu bugünün rapor özetini buluta gönderir: ciro, ödeme türleri, ürün ürün satış,
  saatlik dağılım, KDV dökümü, Z, iptal, ikram, indirim, personel satışı. İlk açılışta geçmiş 400 günü yavaş yavaş
  gönderir; internetsizken kuyrukta bekler.
- Uzaktan'da kafedekiyle aynı Raporlar sayfası açılır (tarih aralığı seçilir); rakamlar günlük özetlerden toplanır.
  Merkez'deki her dükkânın raporu ayrı; üstte dükkân seçilir.
- Buluta gitmez: maliyet ve kâr (lafmaliyet'te), PIN'ler, müşteri adı ve telefonu (`docs/07-UZAKTAN-ERISIM.md` §4).

## 4. Sahibin yapacakları (kafede)

Başlat › LafPOS › LafPOS ayarları'na (anahtar değerleri Mac'te `~/Downloads/lafpos-kasa-ayarlari.env`; yoksa
`scripts/vercel/baglanti-kur.sh --yenile`):

```
LAFMALIYET_URL=https://ladmin.laffogato.net
LAFMALIYET_SYNC_SECRET=...
LAFPOS_CLOUD_URL=https://lafpos.laffogato.net
LAFPOS_CLOUD_SECRET=...
LAFFOGATO_URL=https://laffogato.net        (kurulum modu kapandıktan sonra)
LAFFOGATO_SYNC_SECRET=...                  (kurulum modu kapandıktan sonra)
PAVO_URL=https://<cihazın IP adresi>:4567
PAVO_SERIAL=<cihazın seri numarası>
```

Sonra Yönetim › Yazarkasa POS › Pavo › Eşleştir ve küçük bir deneme satışı; lafmaliyet'te geçiş günü
(`docs/03-ENTEGRASYON.md`).

## Çalışma kuralları (kısa)

- Dal `claude/<konu>`; `main`'e doğrudan push yok, PR ile. Sahip main'e göndermeyi istedi: CI yeşilse PR birleştirilir.
- Commit öncesi `npm run typecheck && npm test`; arayüze dokunduysan `npm run build && npm run e2e`
  (`LAFPOS_E2E_CHROME=/opt/pw-browsers/chromium` bulut ortamında).
- Gizli değer hiçbir dosyaya ve commit'e girmez; `data/` ve `.env` asla.
- Sahip yazılımcı değil: arayüz ve belge dili sade Türkçe; ondan teknik adım istenmez.
