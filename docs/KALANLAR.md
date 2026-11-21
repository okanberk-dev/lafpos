# Kalan işler (devir notu)

Bu dosya, işi başka bir oturumun (ya da başka bir Claude'un) kaldığı yerden sürdürmesi içindir. Önce `AGENTS.md`'yi
oku; kurallar orada. Bitirdiğin maddeyi buradan sil, yarım bıraktığını "Durum" satırıyla güncelle.

Son güncelleme: 21 Kasım 2026 (siteden üyelik ve indirme main'de; 1. ve 3. madde: gerçek ortam denemesi kaldı).

## Main'de olanlar (bitti)

- Pavo N86 yazarkasa: satış, sonuç, iptal, eşleştirme, banka gün sonu (`docs/04-YAZARKASA.md` §8). Gerçek cihazla
  henüz denenmedi: ilk satış küçük tutarla yapılır, "Cihazın son yanıtları" (Yönetim › Yazarkasa POS) incelenir.
- lafmobil ve site siparişleri: masa çağrıları ("Garson çağır"), bar istasyonu yedeği, planlı sipariş penceresi
  (`docs/03-ENTEGRASYON.md`).
- Siteden üyelik ve indirme: lafpos.laffogato.net'te e-posta ve parolayla "Üye girişi" (ilk girişte parola
  belirlenir), girişten sonra İndir ve anahtarsız web kurucusu (README "Siteden kurulum").
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
- **Siteden kurulum (LafPOS-Kur.cmd):** PowerShell 5.1'de hiç çalıştırılmadı (Linux'ta yalnız üretim, sözdizimi
  denetimi ve e2e). Boş bir Windows 10/11'de: indirme (Edge "sık indirilmiyor" uyarısı, SmartScreen), UAC ile
  yeniden açılma, üç indirme ve doğrulama, görev, güvenlik duvarı, kısayollar, Uygulamalar listesi, "LafPOS'u
  kaldır"; sonra kurulu bilgisayarda ikinci kez çalıştırma (gün açıkken soru, veritabanı kopyası, onarım).
- **İnternet dönüşü:** kafede interneti kesip bir gün sonu al: Genel bakış'ta "İnternet · Yok · 1 kayıt bekliyor",
  üst çubukta rozet; interneti aç: en geç bir dakikada "Bekleyenler gönderildi", lafmaliyet'te gün bir kez.

## 2. Merkez: dükkân bazında raporlar

**Durum:** Merkez main'de (dükkânlar, kayıt ve imza, lisans, seçerek güncelleme; `docs/07-UZAKTAN-ERISIM.md` §4
"Merkez"). Kalan: uzaktan raporlar ve anlık ciro dükkân bazında olsun. Redis anahtarlarındaki `default` yerine dükkân
kimliği (kurulum kimliği), itme kurulumun kimliğiyle; mevcut `default` verisi ilk onaylanan dükkâna taşınır; Raporlar
ve patron panelinin üstünde dükkân seçici.

## 3. Uzaktan raporlar (lafpos.laffogato.net)

**Durum:** kod bitti (`claude/uzaktan-raporlar`, PR #58'in üstünde); gerçek Vercel ve Upstash'te henüz koşmadı.
Ayrıntı `docs/07-UZAKTAN-ERISIM.md` §4 "Raporlar" ve "Anlık ciro". Kalanlar:

- **Gerçek ortamda deneme:** kafede `LAFPOS_CLOUD_URL` tanımlıyken ilk açılışta tarama yaklaşık bir saatte 400
  günü iter; Uzaktan'da Raporlar › Ciro'nun "Geçen ay"ı kafedekiyle aynı rakamı vermeli. Upstash'te
  `lafpos:rapor:default:gun:*` anahtarları ve günlük istek sayısı (Upstash › Usage) izlenir.
- **Merkez'deki dükkân seçici:** anahtarlar dükkân kimliğini taşır (bugün yalnız `default`); Merkez (2) gelince
  itme kurulumun dükkân kimliğiyle yapılır, Raporlar'ın üstünde dükkân seçilir.
- **Uzakta olmayan sekmeler:** hazırlama süresi, adisyon listesi, paket platformları, iptal ve indirim listeleri
  (kalem kalem), happy hour, lafmaliyet aktarımı ve CSV'ler yalnız kafede. Toplamları (iptal, ikram, ödenmez, zayi,
  indirim) Ciro ve Personel'de uzakta da var.
- **Redis sıfırlanırsa** kasa günleri gönderilmiş sayar; günlük tarama yalnız değişen günü iter. Yeniden göndermek
  için kasada `sync_state`'teki `cloud.reports` satırı silinir (yönetimde düğmesi yok).

## 4. Sahibin yapacakları (kafede)

Başlat › LafPOS › LafPOS ayarları'na (anahtar değerleri Mac'te `~/Downloads/lafpos-kasa-ayarlari.env`; yoksa
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

LafPOS ilk açılışta deneme modundadır (örnek PIN'ler, eğitim yazarkasası, "Deneme modu" şeridi). Kafede denendikten
sonra gün sonu alınır ve patron Yönetim › Ayarlar ve yedek › **Denemeyi bitir, gerçek kullanıma başla** der
(yedek, deneme kayıtları silinir, patron yeni PIN'ini verir; `docs/05-KASA-BILGISAYARI.md` §2 "İlk açılış"). Gerçek
Windows'ta henüz denenmedi: yedek dosyasının `C:\ProgramData\LafPOS\backups`'a yazılması ve kapanan hesapların
Personel'den yeni PIN'le açılması ilk kurulumda bakılacak.

Sonra Yönetim › Yazarkasa POS › Pavo › Eşleştir ve küçük bir deneme satışı; lafmaliyet'te geçiş günü
(`docs/03-ENTEGRASYON.md`).

## Çalışma kuralları (kısa)

- Dal `claude/<konu>`; `main`'e doğrudan push yok, PR ile. Sahip main'e göndermeyi istedi: CI yeşilse PR birleştirilir.
- Commit öncesi `npm run typecheck && npm test`; arayüze dokunduysan `npm run build && npm run e2e`
  (`LAFPOS_E2E_CHROME=/opt/pw-browsers/chromium` bulut ortamında).
- Gizli değer hiçbir dosyaya ve commit'e girmez; `data/` ve `.env` asla.
- Sahip yazılımcı değil: arayüz ve belge dili sade Türkçe; ondan teknik adım istenmez.
