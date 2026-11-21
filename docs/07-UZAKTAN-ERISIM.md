# Uzaktan erişim: LafPOS'a kafenin dışından canlı bakmak

LafPOS'un sunucusu kafedeki kasa bilgisayarında çalışır (`docs/05-KASA-BILGISAYARI.md`). Kafenin Wi-Fi'ındaki
tabletler ona yerel adresle bağlanır. Patron evden ya da yoldan aynı ekranları **Tailscale** ile açar: masalar,
adisyonlar, bar ekranı, kasa, raporlar, patron paneli ve yönetim, kafedeki ekranlarla aynı anda güncellenir
(sunucu olayları anlık iletir). Uzaktan yapılan her işlem kafedeki gibi PIN ve yetkiyle olur, denetim
kaydına düşer.

## 1. Neden Tailscale

| Yol | Durum |
|---|---|
| **Tailscale** (önerilen) | Kasa bilgisayarı ve telefon aynı özel ağa girer; bağlantı uçtan uca şifreli, yalnız sizin hesabınızdaki cihazlar görür. Modemde ayar yok, sabit IP gerekmez. Kişisel kullanım ücretsiz |
| Modemden port açmak | **Yapmayın.** LafPOS internete açılır, PIN'i tahmin etmeye çalışan herkes kapıya gelir |
| Bulut sunucusu | Kafede internet kesilince kasa durur; LafPOS bilerek yerelde çalışır (`docs/06-TEK-SISTEM.md`) |

Gün sonu rakamları lafmaliyet'e zaten gider (`docs/03-ENTEGRASYON.md`); Tailscale anlık ekranlar ve uzaktan
işlem içindir.

## 2. Kurulum (bir kez, 10 dakika)

1. **Kasa bilgisayarı:** https://tailscale.com/download adresinden Windows sürümünü kurun, Google ya da
   Apple hesabınızla girin. Saat yanındaki Tailscale simgesinden **Preferences › Run unattended**'ı açın:
   Windows'a kimse girmeden de (elektrik kesintisinden sonra) bağlı kalır.
2. **Telefon:** App Store ya da Google Play'den Tailscale'i kurun, **aynı hesapla** girin.
3. Kafede LafPOS'ta **Yönetim › Ağ ve uzaktan erişim**'i açın. "Dışarıdan (Tailscale)" kartında "Bağlı"
   yazar; adres `http://100.x.y.z:4000` ve karekodu oradadır.
4. Telefonda Tailscale açıkken karekodu okutun ya da adresi yazın, PIN'inizle girin. Tarayıcı menüsünden
   "Ana ekrana ekle" ile uygulama gibi açılır.

LafPOS'un Windows kurulumu güvenlik duvarında 4000 numaralı portu yalnız kafenin ağına ve Tailscale aralığına
(`100.64.0.0/10`) açar; başka ayar gerekmez. Git ile kurulan bilgisayarda Windows ilk açılışta izin sorar:
"Özel ağlar"ı işaretleyin.

## 3. Ayrıntılar

- **Adres değişmez:** Tailscale cihaza sabit bir `100.x` adresi verir. Tailscale'de MagicDNS açıksa
  bilgisayarın adıyla da açılır (`http://<bilgisayar-adı>:4000`).
- **HTTPS (isteğe bağlı):** kasa bilgisayarında yönetici komut isteminde `tailscale serve --bg 4000` LafPOS'u
  `https://<bilgisayar-adı>.<tailnet>.ts.net` adresinde geçerli sertifikayla sunar. Tarayıcı bu adreste ekran
  kilidini ve panoyu da açar. Bu yolda bütün uzak istekler sunucuya bilgisayarın kendisinden gelmiş görünür:
  PIN deneme sınırı uzaktaki cihazları birbirinden ayıramaz, adres yine yalnız sizin Tailscale ağınıza açıktır.
  Kapatmak: `tailscale serve reset`.
- **Funnel kullanmayın:** `tailscale funnel` LafPOS'u herkese açık internete çıkarır.
- **Personel telefonları** uzaktan erişime gerek duymaz; kafede yerel adresle bağlanır. Tailscale hesabına
  yalnız patron ve yönetici cihazlarını ekleyin.
- **Bağlantı kopunca** ekranın üstündeki durum noktası kırmızıya döner, LafPOS kendini yeniden bağlar.

## 4. LafPOS Uzaktan (Vercel): kurulumsuz, salt okunur

Telefona uygulama kurmadan, herhangi bir tarayıcıdan: `https://lafpos.vercel.app`, patron parolasıyla. Patron
paneli, masalar, açık adisyonların kalemleri, bar kuyruğu ve Raporlar (aşağıda); işlem yapılmaz (iptal, ödeme, Tükendi kafedeki kasadan
ya da Tailscale ile). Kafedeki sunucu canlı özeti (`server/sync/cloud.ts`) şu ritimle iter:

- **Değişiklikte** (sipariş, ödeme, masa, bar): en sık 15 sn'de bir; aradaki değişiklikler bir sonrakine girer.
- **Değişmeyen özet gitmez:** içerik aynıysa istek atılmaz (özetin, açılış verisinin ve panelin saati değişiklik
  sayılmaz). Sunucu 5 dk'da bir nabızla bakar.
- **Gün açıkken** nabız özet değişmese de iter: uzaktan panelin saati ve adisyon süreleri 5 dk'da bir tazelenir.
- **Gün kapalıyken** (gece) nabız değişmeyen özeti yalnız son itmenin üstünden 15 dk geçtiyse iter: boşta 15 dk'da
  bir (bir değişiklikten sonraki ilk boş itme, nabız 5 dk'da bir baktığı için 15-20 dk içinde). Uzaktan sayfadaki
  "… itibarıyla" saati son itmenin saatidir.

Bulut özeti Upstash Redis'te tutar (`api/uzaktan.ts`), ekran 10 sn'de bir yenilenir. Maliyet ve kâr, PIN'ler,
müşteri telefonları gitmez.

- **İnternet yokken** itme gidemez; özet kaybolmaz, bir sonraki itme son hâli taşır. İnternet gelince bekleyenlerle
  birlikte hemen bir kez itilir (`server/sync/catch-up.ts`, `docs/05-KASA-BILGISAYARI.md` §6 "İnternet yokken").
  Kafede durum alanı "İnternet yok · N kayıt bekliyor", sonra "Bekleyenler gönderildi"; son başarılı itme Yönetim ›
  Genel bakış › Sistem sağlığı › LafPOS Uzaktan'da.
- **Anlık ciro (patron paneli):** bugünün cirosu, adisyon sayısı ve ortalaması, açık masaların tahsil edilecek
  tutarı, ödeme türleri, geçen haftanın aynı günüyle "bu saate kadar" kıyas ve saat saat grafik (bugün ve geçen
  hafta aynı gün), uyarılar (iptal, ikram, indirim sıçraması) canlı özetten gelir: satıştan en geç ~15 sn sonra
  itilir, sayfa 10 sn'de bir yeniler (yeni yoklama yok). Durum satırı saniyesiyle "son güncelleme 14:05:09" yazar; gün açıkken son
  veri 10 dakikadan eskiyse (kasa nabzı 5 dk'da bir) "Kafeden veri gelmiyor" uyarısı çıkar (`remoteFreshness`,
  `src/lib/remote.ts`). Gün kapalıyken son gün sonunun kartı: Z, ciro, adisyon, ödeme türleri ve kasa farkı (beklenen,
  sayılan; yalnız patron rolü kasa rakamlarını görüyorsa, kör kasa kuralı). Maliyet ve kâr yok.
- **Raporlar:** kasa her iş gününün rapor özetini ayrıca iter (`server/sync/cloud-reports.ts`,
  `POST /api/uzaktan/rapor`): ciro ve döküm, ödeme türleri, satış türleri, KDV, ürün ürün satış (maliyetsiz), saatlik
  dağılım, Z numaraları, iptal, ikram, ödenmez, zayi, indirim, personel satışı ve kapanışların dakikası (bugünü
  içeren dönemin "aynı saate kadar" kıyası). Rakamlar Raporlar'ın kendi servisleriyle kurulur; Uzaktan'daki Raporlar
  (Ciro, Ürünler, Saatlik, Personel) dönemin günlerini toplar ve kafedekiyle aynı rakamı verir
  (`tests/uzaktan-raporlar.test.ts`). Dönem en çok 400 gün; kıyas dönemi 420 günden eskiyse boş görünür.
  - Ritim: bugün ve dün değişiklikte en sık 5 dk'da bir (değişmeyen gün gitmez); ilk açılışta geçmiş 400 gün dakikada
    7 günlük paketlerle (yaklaşık bir saat); sonra günde bir kez, gün kapalıyken aynı tarama yalnız sonradan değişen
    günü (ör. eski güne ödeme iptali) iter. İnternetsizken gidemeyen gün kuyrukta bekler, durum alanında sayılır
    ("Uzaktan raporu N gün"); internet dönünce catch-up onu bir kez gönderir.
  - Upstash: gün başına bir anahtar `lafpos:rapor:<dükkân>:gun:<tarih>` (bugün dükkân `default`; Merkez gelince
    dükkân kimliği), süresi günün kendisinden 420 gün (EXAT); kasanın "bugün"ü `lafpos:rapor:<dükkân>:son`. Okuma
    parça parça MGET (60 gün). Eski özet (aynı günün önceki kuruluşu) yenisini ezmez.
  - Buluta gitmez: maliyet ve kâr, PIN'ler, müşteri adı ve telefonu (ödenmez kişisi de), iptal ve ikram nedenleri.
    Uzakta yalnız kafede olan sekmeler gizli, CSV yok.
- **Güncelleme kanalı da bu projede:** aynı derleme `dist/web/guncelleme/`'yi yazar (`npm run kanal`): kafedeki
  kasa `https://lafpos.laffogato.net/guncelleme/surum.json`'dan yeni sürümü alır (anahtarsız; ayrıntı
  `docs/05-KASA-BILGISAYARI.md` §6 "Otomatik güncelleme"). `vercel.json` `/guncelleme/*`'ı arayüz sayfasına çevirmez.
- **Üye girişi ve İndir (siteden kurulum):** giriş ekranı sitenin "Üye girişi"dir (aynı patron girişi); girişten
  sonra menüde **İndir** (`/indir`, yalnız Uzaktan derlemesinde; kafeden veri gelmemişken de kabuksuz açılır).
  Sayfa kanalın yanındaki anahtarsız web kurucusuna bağlanır: `/guncelleme/LafPOS-Kur.cmd` (`npm run kanal`
  yazar, `scripts/kasa/windows/kurulum/web-kurucu.mjs`; `vercel.json` onu indirme olarak sunar). Dosya herkese
  açıktır ama gizli bir şey taşımaz (`tests/web-kurucu.test.ts`); bağlantı yalnız oturumda görünür. Kurucu cmd ve
  PowerShell 5.1 iki dilli tek dosyadır: yönetici izni ister, kanalın surum.json'unu okur (okunamazsa içine gömülü
  derlemeyi kullanır), Node'u nodejs.org'dan, better-sqlite3'ün Windows ikilisini GitHub'dan, uygulama yükünü
  kanaldan SHA-256 ile doğrulayarak indirir, `lafpos.nsi` ile aynı klasörleri, görevi, güvenlik duvarını,
  kısayolları ve Uygulamalar kaydını yazar. Yeniden çalıştırmak onarır ya da son sürüme günceller (gün açıksa
  sorar, önce veritabanının kopyasını alır). Kurulum dosyasının Kaldir.exe'si yoksa kaldırma
  `LafPOS-Kaldir.ps1` ile. Tam kurulum dosyası (LafPOS-Kurulum.exe) GitHub Releases'ta kalır: depo özel ve
  Vercel NSIS derleyemez.

| Nerede | Ne |
|---|---|
| Vercel › lafpos › Storage | Upstash Redis (ücretsiz plan yeter; `KV_REST_API_URL`, `KV_REST_API_TOKEN` kendiliğinden gelir) |
| Vercel › lafpos › Environment Variables | `LAFPOS_CLOUD_SECRET` (en az 32 karakter); parolayı açmak için `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` ve `LAFPOS_UZAKTAN_PAROLA` (en az 10) |
| Kafede `ayarlar.env` / `.env` | `LAFPOS_CLOUD_URL=https://lafpos.vercel.app`, `LAFPOS_CLOUD_SECRET` (Vercel'dekiyle aynı) |
| Vercel › lafpos › Environment Variables (Yemeksepeti) | `YEMEKSEPETI_PLUGIN_SECRET` (Delivery Hero'nun verdiği JWT anahtarı), isteğe bağlı `YEMEKSEPETI_REMOTE_ID`; aktarıcı `docs/PAKET-PLATFORMLARI.md` |
| Vercel › lafpos › Environment Variables (Getir) | `GETIR_WEBHOOK_SECRET` (bizim ürettiğimiz, en az 16 karakter, `LAFPOS_CLOUD_SECRET`'ten ve Yemeksepeti anahtarından ayrı, ör. `openssl rand -hex 24`; Getir'e `x-api-key` olarak sipariş ve iptal adresleriyle birlikte verilir), isteğe bağlı `GETIR_RESTAURANT_ID`; aktarıcı `docs/PAKET-PLATFORMLARI.md` |

**İlk etapta parolasız** (27 Ekim 2026 kararı): `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` yokken kafe bağlıyken de giriş parola
sormaz; bağlantıyı bilen herkes gerçek ciroyu ve personel adlarını salt okunur görür. Gerçek kullanıma geçmeden
parolayı açın.

Vercel yalnız `main`'i dağıtır: `vercel.json` `git.deploymentEnabled` `claude/**` dallarına önizleme açmaz (26 Ekim
2026: ekip Hobby planın 24 saatte 100 dağıtım sınırına takıldı ve canlı dağıtımlar da reddedildi). Dalda değişiklik
yerelde `npm run build` ile denenir.

Neden kasa Neon'a taşınmadı: kasa internet kesilince de çalışmalı; Neon'un ücretsiz planındaki aylık işlem süresi
açık saatler boyunca uyanık bir veritabanına yetmez ve lafmaliyet'in veritabanını da durdururdu. Kalıcı geçmiş gün
sonunda lafmaliyet'e (Neon) gider; anlık görünüm için Redis yeterli ve ucuz. Parola denemesi IP başına 15 dakikada 8.
Durum: Yönetim › Ağ ve uzaktan erişim › LafPOS Uzaktan. Giriş ekranı kurulumu baştan sorar (`GET
/api/uzaktan/kurulum`, yalnız var/yok döner): eksik adım varsa parola alanı yerine kontrol listesi görünür.

**Tek komutla kurulum** (operatörün Mac'inde, Vercel CLI girişiyle): `scripts/vercel/baglanti-kur.sh`. Üç ortak
anahtarı üretir ve Vercel'e yazar (laffogato ve lafmaliyet'e `LAFPOS_SYNC_SECRET`, lafpos'a `LAFPOS_CLOUD_SECRET`),
parolayı sorar (tanımlıysa dokunmaz), Upstash Redis'i ekler (koşulları operatör onaylar), üç projenin main'den gelen
son üretim dağıtımını yeniden derler ve kafe bilgisayarına girecek satırları `~/Downloads/lafpos-kasa-ayarlari.env`
dosyasına yazar (izin 600; lafmaliyet ve Uzaktan satırları 1. adım, site satırları kurulum modu kapandıktan sonra 2.
adım başlığıyla, `docs/03-ENTEGRASYON.md` §8). Anahtarlar ekrana basılmaz; tanımlı bir değişkene `--yenile` olmadan dokunmaz.

## 5. Sorun giderme

| Belirti | Bakılacak yer |
|---|---|
| Kartta "Kurulmadı" | Kasa bilgisayarında Tailscale kurulu ve girişli mi; sayfa 15 sn'de bir yenilenir |
| Telefonda sayfa açılmıyor | Telefonda Tailscale açık mı, iki cihaz aynı hesapta mı; Tailscale uygulamasında kasa bilgisayarı "Connected" mı |
| Kafede açılıyor, dışarıda açılmıyor | Kasa bilgisayarı uykuda olabilir: Windows kurulumundaki "Prizdeyken uyku kapalı" seçeneği |
| "Bu işlem için yetkiniz yok" | Uzaktan da rol yetkileri geçerli (Yönetim › Roller ve yetkiler) |
| LafPOS Uzaktan "Kafeden henüz veri gelmedi" | Kafede `LAFPOS_CLOUD_URL` ve `LAFPOS_CLOUD_SECRET`, Vercel'de aynı anahtar; Yönetim › Ağ'daki son hata |
| LafPOS Uzaktan "Upstash Redis bağlı değil" | Vercel › lafpos › Storage'dan Upstash Redis ekleyip yeniden yayınlayın |

Kod: adresler `server/lib/network.ts`, sayfa `src/pages/admin/NetworkAdmin.tsx`, bulut `api/uzaktan.ts`, `server/sync/cloud.ts` ve `server/sync/cloud-reports.ts`; testler `tests/network.test.ts`, `tests/cloud-api.test.ts`, `tests/uzaktan-raporlar.test.ts`.
