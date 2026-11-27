# Uzaktan yönetim: kasayı AsilPOS Uzaktan'dan yönetmek

Sözleşme (türler, doğrulama, imza metni): `shared/kontrol.ts`. Bulut: `api/_kontrol.ts` (panel uçları ve kuyruk),
`api/_merkez.ts` (nabızla teslim), `api/uzaktan.ts` (yönlendirme ve üye rolleri). Kasa: `server/sync/kontrol.ts`
(uygulama), `server/sync/merkez.ts` (nabız), `server/lib/auth.ts` (iç istek kimliği). Arayüz: `src/pages/kontrol/`.

## Sahibe kısaca

- lafpos.laffogato.net'te soldaki menüde **Uzaktan yönetim**: telefondan personel ekleme, rol ve indirim sınırı
  değiştirme, hesabı kapatma/açma, **kasa şifresini (PIN) değiştirme**, rollerin yetkileri, ürün ve seçeneklerde
  **Tükendi / Satışa aç**, **servis modu**. Patron panelinde de "Kasayı uzaktan yönet" kartı.
- Değişiklik kasaya en geç **5 dakika** içinde ulaşır (kasa zaten 5 dakikada bir Merkez'e uğruyor; yeni yoklama yok).
  Bir komut aldıktan sonra kasa 10 dakika boyunca dakikada bir uğrar: art arda değişiklikler beklemez. Ekranda her
  işlem "Bekliyor → Uygulandı" ya da "Reddedildi (neden)" olarak görünür; bekleyen işlem iptal edilebilir.
- Kasa kapalıysa ya da internet yoksa işlem bekler, kasa açılınca uygulanır; 24 saat içinde ulaşmazsa uygulanmaz.
- **Gün sonu al ve güncelle** (Kasa sekmesi, yalnız sahip): yalnız kasa bağlıyken (çevrimdışı kasada düğme kapalı, bulut
  da reddeder). Kasa isteği 30 dakika içinde almazsa ya da bu arada kasada gün kapatılıp yeniden açılırsa gün sonu
  alınmaz: gece çevrimdışı kasaya verilen istek ertesi sabah açılan günü kapatmasın. Güncelleme Merkez'in "Şimdi
  güncelle"siyle aynı yoldan gider (hedef, gönderim, istek) ve ancak gün sonu kasada uygulanınca istenir; gün sonu
  reddedilirse (açık adisyon, eski istek) hemen kurulmaz, Merkez'in gönderdiği sürüm olağan yoldan gün kapanınca kurulur.
  Gün sonu kasaya gitmeden iptal edilirse güncelleme isteği de geri alınır (Merkez'de "Güncelleme istendi" kalmaz,
  "Şimdi güncelle" açılır); gönderilen sürüm yine gün kapanınca kurulur. Denetim kaydında "Uzaktan (e-posta) gün sonu
  aldı".
- **Panele kim girer** (Uzaktan yönetim › Panel erişimi): Sahip (Vercel'deki e-postalar) e-posta ekler ve rol seçer:
  **Yönetici** (personeli, Tükendi'yi ve servis modunu yönetir; patron hesabına ve rol yetkilerine dokunamaz) ya da
  **Yalnız görür**. Eklenen kişiye bir kez görünen **davet kodu** verilir (7 gün geçerli; kaybolursa satırdaki **Yeni kod**);
  kişi Üye girişi › **Davet kodum var** ile kodu yazıp kendi parolasını belirler. Kaldırılan kişinin oturumu en geç bir
  dakikada kapanır. Merkez ve bildirimler yalnız sahibe açık (menüde de yalnız sahipte). Bu, kasadaki "Patron paneli"
  yetkisinden ayrıdır: o yetki kasadaki ekranı açar; burası internetteki paneli. Parolasız görünümde (üye girişi yok)
  Uzaktan yönetim kapalıdır; menüde görünmez.
- Kasada Yönetim › Ağ ve uzaktan erişim › **Uzaktan yönetim** anahtarı: kapatılırsa kasa uzaktan gelen her işlemi
  reddeder (varsayılan açık). Uzaktan yapılan her işlem kasanın denetim kaydına "Uzaktan (e-posta)" adıyla yazılır.
- Marina kasası bu özelliği içeren sürümü kurana dek ekran "Kasa güncel değil: önce güncelleme gönderin" der (yönetici
  ve izleyiciye "panelin sahibine haber verin"). Kasa hiç bağlanmadıysa "Kasa henüz bağlanmadı" ve İndir.
- Kasa çevrimdışıyken ekran bunu söyler; gönderilen işlem kasa açılınca (24 saat içinde) uygulanır.

## Akış

1. Panel `POST /api/kontrol/komut` (dükkân `x-laf-dukkan` başlığından, uzaktan görünümün dükkân seçimi). Bulut:
   üyenin rolünü denetler (`uyeYapabilir`), kasanın son özeti var ve komut türünü destekliyor mu bakar, `komutDogrula`
   ile doğrular (gün sonunda kasanın son nabzı Merkez'in "çevrimiçi" süresinde mi: değilse 409 `kasa_cevrimdisi`),
   `komutOzeti` ile özetler, `imzaMetni`ni (kurulum kimliği ve üyenin rolü dahil) ASILPOS_CLOUD_SECRET ile HMAC-SHA256
   imzalar, kuyruğa koyar.
2. Kasa nabzı (`POST /api/merkez/nabiz`) isteğe `kontrol: { ozet, durum?, sonuclar? }` ekler. Bulut yanıta
   `kontrol: { durumIste, komutlar }` ekler (eski kasa alanı görmez, eski bulut alanı göndermez: iki yön geriye uyumlu).
3. Kasa her komutu sırayla: `komutDogrula` → imza (kendi kurulum kimliğiyle; sabit zamanlı karşılaştırma) → daha önce
   işlendi mi (son 500 kimlik; listeden düşenlerin en yeni anı alt sınır olur, ondan eski komut uygulanmaz) → süre
   (`KOMUT_OMRU_MS`; gün sonu `GUN_SONU_OMRU_MS`, açık gün istekten sonra açıldıysa ya da yeniden açıldıysa da ret;
   gelecekten `SAAT_PAYI_MS`) → kasada uzaktan yönetim açık mı → üyenin rolü (izleyici hiç; yönetici
   patron hesabına ve rol yetkilerine dokunamaz, hedefin rolü kasanın kendi kaydından) → PIN'i özel anahtarla çözer →
   kasadaki yönetim ekranının kullandığı uca iç istek (aşağıda) → sonucu kendi adlarıyla özetleyip saklar. Sonra hemen
   bir nabız daha atar (sonuçlar ve değişen özet beklemesin) ve 10 dakika hızlı nabza geçer.
4. Bulut sonuçları geçmişe yazar (özet kasanınki: kuyruktaki ürün adı istekten gelir, doğrulanmaz), komutları kuyruktan
   siler; panel bekleyen/geçmiş listesini gösterir, reddedileni ayrıca duyurur.

## Kasada uygulama: iç istek

Komut, kasanın kendi uçlarına süreç içi istekle gider; yetki, doğrulama, denetim kaydı ve canlı olaylar yönetim
ekranındakiyle birebir aynıdır (ayrı iş kuralı yazılmaz):

| Komut | Uç |
|---|---|
| `personel.ekle` | `POST /api/admin/users` `{ name, role, color?, maxDiscountPct?, pin }` |
| `personel.duzenle` | `PATCH /api/admin/users/:id` `{ name?, role?, active?, maxDiscountPct? }` |
| `personel.pin` | `PATCH /api/admin/users/:id` `{ pin }` |
| `rol.yetki` | `PUT /api/admin/roles/:role` `{ permissions }` |
| `urun.satis` | `POST /api/sync/products/:id/availability` `{ active }` |
| `secenek.satis` | `POST /api/option-items/:id/sold-out` `{ soldOut }` |
| `ayar.servis` | `PUT /api/admin/settings` `{ serviceMode }` |
| `urun.gorunum` | `PATCH /api/admin/products/:id` `{ hidden }` (siteden gelen üründe de: kasa alanı) |
| `urun.gorsel` | `PATCH /api/admin/products/:id` `{ image }` (yalnız `https://laffogato.net/` adresi ya da null). Yalnız kasaya özel üründe: siteden gelen ürünün görselini menü eşitlemesi her seferinde yeniden yazar, uç reddeder (409 `synced_field`, "görseli siteden gelir"). Panelde henüz düğmesi yok |
| `urun.ekle` | `POST /api/admin/products` `{ categoryId, name, price, kdvRate, groupIds }` |
| `gun.sonu` | `POST /api/cash/day/close` `{ countedCash: null, note }` (yalnız sahip ve kasa bağlıyken; kapanış sistem kapanışı gibi, `closedBy` boş; denetim kaydı `uzaktan` kimliği ve "Uzaktan (e-posta) gün sonu aldı"). `guncelle: true` ise Merkez'in "Şimdi güncelle"si (`requestUpdateNow`: hedef, gönderim, istek) bu gün sonuna bağlı yazılır (`guncelleKomut`): kasa güncellemeyi ancak gün sonu uygulanınca ister, reddedilirse ya da 30 dakikada gelmezse istek güncelleme başlatmadan kapanır |
| `secenek.duzenle` | `PUT /api/admin/option-groups/:id` (grubun bugünkü seçenekleri ve bağları + yenileri; yalnız ekleme) |
| `secenek.grubu` | `POST /api/admin/option-groups` `{ name, kind: 'single', required, maxSelect: 1, items, productIds }` |

İç isteğin kimliği: `server/lib/auth.ts`'te süreç içi `WeakMap<Request, AuthUser>`; kimlik doğrulama ara katmanı
isteğin kendisi bu haritadaysa oturum aramaz. Harita yalnız bellekte: ağdan gelen hiçbir istek bu kimliği taşıyamaz.
Adı `Uzaktan (e-posta)`. Sahibin komutu patron rolüyle; yöneticinin komutu müdür rolüyle (`remoteActor`): kasanın
kendi kuralları onu kasadaki müdür gibi tutar (patron hesabını açamaz, değiştiremez; personele PIN verme denemesi saatte
12, çakışma uyarı olarak kayda düşer: patronun PIN'i taranamaz). `assertPatronRemains`, PIN tekilliği, örnek PIN yasağı
ikisinde de işler.

## Güvenlik

- Yalnız gerçek oturum (üye ya da parolalı giriş); `izleyici` ve parolasız görünüm 403, demo 403 `remote_readonly`.
- Patron hesabına dokunan personel komutları ve rol yetkileri yalnız `sahip`.
- Komut bulutta HMAC'le imzalanır; imza metninde kurulum kimliği ve üyenin rolü de var. Redis'e yazabilen biri
  (ASILPOS_CLOUD_SECRET'ı bilmeden) kasaya komut sokamaz, bir şubenin komutunu başka şubeye taşıyamaz, rolü
  değiştiremez. Kasa kimliği ve alt sınır tekrar oynatmayı, süre ve saat payı eski/gelecek komutu engeller.
- Rol kapısı iki yerde: bulut kasanın son özetiyle, kasa uygulama anında kendi kaydıyla (özet eski olabilir: kuyrukta
  bekleyen rol değişikliği, kasada yeni patron).
- PIN tarayıcıda kasanın açık anahtarıyla şifrelenir (RSA-OAEP 2048, SHA-256; Web Crypto). Kasa açık anahtarı kurulum
  kimliğine bağlı olarak ASILPOS_CLOUD_SECRET ile imzalar (`anahtarImza`); bulut anahtarı panele yalnız imza tutarsa
  verir. Bulut yalnız şifreli metni görür ve saklar; kasa uygulayınca komut kuyruktan silinir. Açık PIN hiçbir günlüğe,
  özete, geçmişe, denetim kaydına, hata iletisine girmez (testle). Özel anahtar yalnız kasanın veritabanında.
- Güvencenin sınırı: Redis'e yazabilen ama ortak anahtarı bilmeyen saldırgana karşıdır. Vercel ortamını (ortak anahtar)
  ele geçiren her şeyi yapabilir; anahtar kasada ve Vercel'de saklı tutulur.
- Şube anahtarı (27 Kasım 2026, `docs/07-UZAKTAN-ERISIM.md` §6): bulut kasanın şube anahtarını kabul ettiyse kasa
  özetinde şubesini söyler (`sube`); bulut o kasanın komutlarını ve açık anahtar imzasını `ASILPOS_CLOUD_SECRET_<ŞUBE>`
  ile işler (yoksa ortak anahtar). Kasa o sırada ortak anahtarla imzalı komutu reddeder: ortak anahtarı bilen ve
  Redis'e yazabilen biri şube anahtarlı kasaya komut sokamaz. Uzaktan yönetim şube anahtarına yalnız bulutun kabulüyle
  geçer (`server/lib/kafe-anahtari.ts` `kontrolAnahtari`; kabul kasada kalıcı, retle silinir): bulut tanımıyorken
  kasanın 10 dakikada bir yaptığı yeniden deneme özeti ve komut imzasını değiştirmez, iki taraf aynı anahtarda kalır.
  Anahtarın başladığı ya da kaldırıldığı anda kuyrukta bekleyen bir komut reddedilebilir; panelden yeniden gönderilir.
- Kuyruk dükkân başına en çok `KUYRUK_EN_COK` (son 10 yer sahibe ayrılır), saatte üye başına `SAATLIK_EN_COK` komut:
  bir yönetici sınırı doldurup sahibin acil işlemini (hesabı kapat) bekletemez.

## Redis (Upstash) ve bütçe

| Anahtar | İçerik |
|---|---|
| `lafpos:kontrol:komut:<kurulum>` | HASH: komut kimliği → `KomutKaydi` JSON |
| `lafpos:kontrol:var:<kurulum>` | Kuyrukta komut var işareti (nabzın tek MGET'ine girer). Kuyruk boş görülünce silinir ve kuyruk yeniden sayılır: arada komut girdiyse geri konur |
| `lafpos:kontrol:teslim:<kurulum>` | Kasaya teslim anı: nabız kuyruğu okumadan önce yazar (şimdi + 2 sn); bu andan eski komut iptal edilmez (409 `delivered`). İptal silmeden sonra yeniden bakar, arada teslim edildiyse komutu geri koyar |
| `lafpos:kontrol:durum:<kurulum>` | Kasanın son `KontrolDurumu` |
| `lafpos:kontrol:ozet:<kurulum>` | O özetin parmak izi (nabzın tek MGET'ine girer) |
| `lafpos:kontrol:gecmis:<kurulum>` | LIST: bitmiş işlemler (`KontrolGecmisi`, en çok `GECMIS_EN_COK`) |
| `lafpos:kontrol:sayac:<kurulum>:<saat>:<üye>` | Üye başına saatlik sınır sayacı (EX 2 saat) |
| `lafpos:uye:<e-posta>` | Üye kaydı `{ h, at, rol? }` (rol yalnız panelden davet edilende) |
| `lafpos:uye-davet:<e-posta>` | Davet `{ kod (özet), rol, at, kim }`, EX 7 gün |
| `lafpos:uyeler` | SET: panelden davet edilen e-postalar |

Nabız Redis komut sayısını artırmaz: kurulum, durum, `var`, `ozet` ve `teslim` anahtarları tek MGET'te okunur; kuyruk
yalnız `var` işaretliyse okunur (teslim anı yazılır, HVALS). Sonuç ve özet yazımı yalnız değişince. Hızlı nabız
(dakikada bir, 10 dakika) yalnız komut gelince; kasanın saati geri alınırsa nabız durmaz. Panel bekleyen işlem varken ve
kasa çevrimiçiyken 15 sn'de bir, yoksa 60 sn'de bir sorar. Üye rolü oturum denetiminin zaten okuduğu üye kaydından gelir
(ek okuma yok).

## Testler

`tests/kontrol-sozlesme.test.ts` (doğrulama, imza metni, parmak izi, üye yetkisi; api/uzaktan.ts'in eriştiği dosyalar
Vercel gibi dosya dosya ESM'e derlenip Node'la yüklenir: uzantısız göreli yol bütün /api/* uçlarını düşürürdü),
`tests/kontrol-bulut.test.ts` (rol kapısı, kuyruk, üye başına sınır ve sahibin payı, nabızla teslim ve sonuç, işaret ve
iptal yarışları, anahtarın imzası, PIN sızmaz, davet ve üye kaldırma, çevrimdışı kasaya gün sonu yok, "Gün sonu al ve
güncelle" Merkez'in "Şimdi güncelle"siyle aynı kayıt), `tests/kontrol-kasa.test.ts` (imza, başka şube ve rol değişimi,
tekrar ve alt sınır, süre, eski ya da günü değişmiş gün sonu, uzaktan gün sonunun denetim kaydı, bağlı güncelleme yalnız
gün sonu uygulanınca, siteden gelen ürünün görseli, kapalı anahtar, yöneticinin kasadaki rol kapısı ve PIN sınırı, PIN
çözülür ve yeni PIN'le giriş, son patron korunur, sonuç ve kasanın özeti, saat geri alınınca nabız, eski bulut),
`tests/kontrol-arayuz.test.ts` (rol kapısı, kasa bağlı değil, gün sonu düğmesi ve duyurusu, güncelleme isteği gider,
yoklama, son giriş, menü erişimi, davetlinin ilk girişi).
