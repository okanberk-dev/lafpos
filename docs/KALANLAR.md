# Kalan işler (devir notu)

Bu dosya, işi başka bir oturumun (ya da başka bir Claude'un) kaldığı yerden sürdürmesi içindir. Önce `AGENTS.md`'yi
oku; kurallar orada. Bitirdiğin maddeyi buradan sil, yarım bıraktığını "Durum" satırıyla güncelle.

Son güncelleme: 21 Kasım 2026 (1. madde: kod bitti, gerçek ortam denemesi kaldı).

## Main'de olanlar (bitti)

- Pavo N86 yazarkasa: satış, sonuç, iptal, eşleştirme, banka gün sonu (`docs/04-YAZARKASA.md` §8). Gerçek cihazla
  henüz denenmedi: ilk satış küçük tutarla yapılır, "Cihazın son yanıtları" (Yönetim › Yazarkasa POS) incelenir.
- lafmobil ve site siparişleri: masa çağrıları ("Garson çağır"), bar istasyonu yedeği, planlı sipariş penceresi
  (`docs/03-ENTEGRASYON.md`).
- Windows 10: boşta düşük kaynak, bellek sınırı, Windows'ta kurulum paketi denemesi (`.github/workflows/windows.yml`,
  `docs/05-KASA-BILGISAYARI.md`).

## 1. Kurulum dosyası, otomatik güncelleme, internet dönüşü: gerçek ortamda denenecekler

**Durum:** kod bitti (`claude/exe-guncelleme-wip`). Linux'ta denendi: birim testleri, `npm run kurulum:windows`
(paket denemesi derleme numarasını, gün sorusunu ve durum dosyasını sınar) ve gerçek bekçiyle bir güncelleme
(yerel kanaldan indirme, klasör değişimi, yeni sürümün deneme açılışı, 75 koduyla çıkış). Aşağıdakiler gerçek
ortamda henüz koşmadı.
Tarif ve yerleri: README "Windows'a kurulum", `docs/05-KASA-BILGISAYARI.md` §6 ("Otomatik güncelleme",
"İnternet yokken").

- **GitHub Release:** `main`'e ilk push'ta `.github/workflows/windows.yml`'in "Sürümü yayımla" adımı (Actions'ın
  `GITHUB_TOKEN`'ı, `contents: write`). Releases'ta `LafPOS-Kurulum.exe` ve `.sha256` görünmeli.
- **Vercel kanalı:** `lafpos` projesinin main derlemesinde `npm run kanal`; ardından
  `https://lafpos.laffogato.net/guncelleme/surum.json` JSON dönmeli (sayfa değil) ve `build` HEAD commit'inin zamanı
  olmalı. Vercel'de git geçmişi yoksa betik derlemenin anını kullanır (günlükte "git geçmişi yok"); o zaman aynı
  commit'in kurulum dosyası kanaldan bir kez daha "güncellenir" (zararsız).
- **Gerçek Windows'ta:** görev artık `cmd.exe /d /c baslat.cmd` (çalışma klasörü kurulum klasörü); bekçinin 75
  koduyla yeniden açılması, `app` klasörünün adının sunucu durunca değişebilmesi, deneme bekçisinin `taskkill /T`
  ile kapanması, Node değişince `node.yeni`'nin yerine geçmesi. İlk kurulumdan sonra bir gün sonu yapıp
  Ayarlar ve yedek › Sürüm ve güncelleme'de "Güncellendi" görülmeli; `logs\sunucu.log`'da `[güncelleme]` satırları.
- **İnternet dönüşü:** kafede interneti kesip bir gün sonu al: Genel bakış'ta "İnternet · Yok · 1 kayıt bekliyor",
  üst çubukta rozet; interneti aç: en geç bir dakikada "Bekleyenler gönderildi", lafmaliyet'te gün bir kez.

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

## 4. Site üzerinden üyelik ve indirme

**Durum:** başlamadı (2 ile birlikte; sahibin isteği, 21 Kasım 2026).

Sahibin isteği: lafpos.laffogato.net'te üyelikle giriş ve bir indirme sayfası; Windows programı doğrudan siteden
kurulsun.

- Giriş Merkez'in sahip hesabıyla (dükkânların kullanıcıları sonra, Merkez üzerinden).
- İndirme anahtar istemez. Depo özel ve Vercel NSIS kurulumunu derleyemez: anahtarsız küçük bir web kurucusu
  (ör. `LafPOS-Kur.cmd`/`.ps1` ya da CI'ın derleyip güncelleme kanalına koyduğu küçük bir başlatıcı exe) Node'u
  nodejs.org'dan, uygulama zip'ini `/guncelleme/`'den sha256 doğrulamasıyla indirir ve `lafpos.nsi` ile aynı
  düzeni ve görevleri kurar. Tam kurulum dosyası GitHub Releases'ta kalır.

## 5. Sahibin yapacakları (kafede)

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
