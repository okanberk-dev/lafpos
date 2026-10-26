# Geliştirilmiş prompt: LafPOS

> Kullanıcının ilk isteği (26 Eki 2026):
> "downloads'a bir klasör oluştur ve buraya modpos narpos robot pos tarzı bir sistem istiyorum, sen de
> tarayıcıdan patron.gafgidi.com'a veya panel.gafgidi.com'a claude chrome ile bağlanıp bakabilirsin nasıl
> yapılmış diye, aynı özelliklerde daha gelişmiş bir sistem yapar mısın?"
> Ekler: klasör adı `lafpos` olsun, laffogato ve lafmaliyet repolarıyla bağlantılı olsun ve aynı ürünleri
> çekebilsin, GitHub'a (`RiosenBeq/lafpos`) ara ara gönderilsin.

Aşağıdaki metin bu isteğin, bir mühendise ya da yapay zekâ ajanına tek başına verilebilecek, belirsizliği
giderilmiş hâlidir.

---

## Rol ve bağlam

Sen L'Affogato'nun (Tuzla, İstanbul; 200 yıllık köşkte kafe, bahçe ve karaoke odası) yazılım ekibisin.
Kafede bugün kasa olarak **ModPOS** (arka ofisi "Patron") kullanılıyor. Bunun yerine kafenin kendi satış
noktası sistemini, **LafPOS**'u yazacaksın.

Kafenin bugün iki sistemi var ve LafPOS bunlarla konuşmak zorunda:

| Sistem | Repo | Görevi | LafPOS ile ilişkisi |
| --- | --- | --- | --- |
| Site + mobil uygulama API'si | `RiosenBeq/laffogato` (Next.js 16, Neon) | Menü, online sipariş (masa QR, gel-al, kurye), sadakat damgası | **Ürün, fiyat, KDV ve Satışta/Tükendi bilgisinin sahibi.** LafPOS menüyü buradan çeker, online siparişleri buradan görür |
| Maliyet / arka ofis paneli | `RiosenBeq/lafmaliyet` (Next.js 16, Drizzle, Neon) | Reçete, maliyet, hammadde, tedarikçi, cari, kasa raporu (Z), zayi/ikram, personel onayları | **Reçete, maliyet, stok ve kasa raporunun sahibi.** LafPOS satış ve Z verisini buraya taşır, elle giriş biter |

Referans ürünler: ModPOS (Patron), NarPOS, robotPOS ve kullanıcının gösterdiği Gafgidi patron/yönetim
panelleri. Hedef, bunların kafe için anlamlı bütün özelliklerini karşılamak ve aşağıdaki "daha gelişmiş"
maddeleriyle geçmek.

## Amaç

`~/Downloads/lafpos` klasöründe (GitHub: `RiosenBeq/lafpos`) çalışan, kafede gün boyu gerçek satış
yapılabilecek, dokunmatik tablet, telefon ve bilgisayarda çalışan bir POS sistemi:

1. Garson ve barista masada ya da tezgâhta sipariş alır, ürünler bara/mutfağa düşer, hesap parçalı
   alınabilir, gün sonunda Z alınır.
2. Patron, kafede olmasa da canlı ciroyu, açık masaları, iptal/ikram/indirimleri ve kasa farkını görür.
3. Ürünler ve fiyatlar **tek yerden** (site) gelir; ModPOS'taki üçüncü kopya ve elle fiyat güncelleme
   ortadan kalkar.
4. Günlük satış ve Z verisi lafmaliyet'e elle yazılmaz; LafPOS üretir.

## Kapsam (modüller)

1. **Giriş ve yetki:** PIN ile hızlı giriş, hızlı kullanıcı değiştirme, otomatik kilit. Rol ve kişi bazlı
   yetkiler. Yetkisi olmayan işlem yetkili PIN'iyle o an onaylanır. Her hassas işlem denetim kaydına
   yazılır. Personel maliyet, kâr ve maaş bilgisini görmez (lafmaliyet'in KVKK kuralı).
2. **Masa planı:** bölümler (salon, bahçe, köşk üst kat, karaoke), sürükle-bırak plan düzenleyici, masa
   durum renkleri (boş, dolu, hesap istendi, kısmi ödendi, rezerve, online sipariş), açık kalma süresi,
   tutar ve garson adı.
3. **Adisyon:** kategori ve ürün ızgarası, arama, sık satılanlar, M/L boy, seçenekler (süt, kavrum, şurup,
   ekstra shot, şeker), not, adet, kalem kopyalama, bar/mutfak istasyonuna gönderme, masasız hızlı tezgâh
   satışı, happy hour indiriminin otomatik uygulanması.
4. **Masa işlemleri:** taşıma, birleştirme, kalem taşıyarak bölme, kişi sayısı, garson değiştirme.
5. **İptal, ikram, indirim:** gerekçe zorunlu; yetki ve yetkili onayı; gönderilmiş kalemin iptali bar
   ekranına düşer; hepsi patron uyarı akışına girer.
6. **Ödeme:** nakit (para üstü, hızlı banknot), kredi kartı, yemek kartları (Pluxee, Multinet, Edenred,
   Setcard, Metropol), havale, açık hesap (cari); parçalı, kalem bazlı ve kişi başı ödeme; bahşiş; ödeme
   iptali ve kapanmış adisyonu yeniden açma (yetkili).
7. **Bar / mutfak ekranı:** istasyona göre fişler, bekleme süresine göre renk, hazırlanıyor / hazır,
   sesli uyarı, iptal bildirimi, online siparişler aynı ekranda, hazırlama süresi ölçümü.
8. **Kasa ve gün sonu:** gün açma (açılış nakiti), kasa hareketleri (harcama, teslim), ara rapor (X), gün
   sonu (Z): ödeme türü ve KDV kırılımı, iptal/ikram/indirim, banknot sayımı, kasa farkı. İş günü 05:00'te
   döner (lafmaliyet ile aynı kural).
9. **Müşteri ve cari:** telefonla bulma, adres, açık hesap ve tahsilat, sipariş geçmişi, damga kartı.
10. **Gel-al ve paket:** sipariş kartları, kurye atama, durumlar.
11. **Rezervasyon:** gün görünümü, masa ataması, masa planında gösterim.
12. **Karaoke odası:** süreli hizmet (saat ücreti, KDV %20, lafmaliyet'te "HİZMET" satırı).
13. **Raporlar:** özet, ürün ve kategori, saatlik, ödeme türleri, personel, iptal/ikram/indirim, KDV,
    CSV dışa aktarım.
14. **Patron paneli:** canlı ciro, geçen haftanın aynı günüyle kıyas, saatlik grafik, en çok satanlar,
    açık masalar, uyarı akışı ve basit anomali tespiti (alışılmadık iptal oranı, kasa farkı, büyük indirim).
15. **Yönetim:** menü (senkron ve POS'a özel ürünler), seçenek grupları, istasyon yönlendirme, masa planı,
    personel ve yetkiler, ödeme türleri, yazıcılar, fiş metinleri, happy hour kuralları, entegrasyon
    ayarları, yedekleme.
16. **Yazdırma:** 80 mm adisyon, mutfak fişi ve Z çıktısı; tarayıcıdan ve ağ yazıcısından (ESC/POS, 9100).

## Entegrasyon kuralları

- **laffogato'dan menü:** herkese açık, CDN önbellekli `GET /api/mobile/v1/menu` (ETag) ile çekilir;
  Neon'u uyandırmaz. Ürün kimliği site kimliğidir (`mnu-0011`), boy `M | L | TEK`. POS'a özel alanlar
  (istasyon, kısa ad, renk, sıra) senkronda korunur. Değişiklik önce önizlenir, sonra uygulanır.
- **İmzalı panel uçları** (`/api/panel/menu`, `/api/panel/orders`, `/api/panel/orders/stage`): anahtar
  verilirse açılır. İmza sitenin `x-laf-timestamp` + `x-laf-signature: v1=<hex>` kuralıyla bayt bayt
  aynıdır ve iki projenin sabitlediği test vektörleriyle doğrulanır. Tükendi bilgisi önce siteye yazılır,
  2xx gelince yerelde kaydedilir.
- **Neon bütçesi:** hiçbir periyodik istek 5 dakikadan sık değildir, yeni cron yoktur (lafmaliyet
  `docs/planlar/senkron.md`).
- **Online ödenmiş sipariş LafPOS'ta tekrar tahsil edilmez** ve lafmaliyet'e POS satışı olarak gitmez
  (çift sayım).
- **lafmaliyet'e:** bugün kod değişmeden kabul edilen biçimlerde dışa aktarım (Satışlar ürün listesi, Kasa
  raporu alanları sırasıyla Z özeti); lafmaliyet'te imzalı alım ucu yazıldığında aynı veri giden kutusundan
  (outbox) otomatik gider. Satır biçimi lafmaliyet'in planladığı `DailyProductSale` ile birebirdir.
- Sistemler arası giden her alan beyaz listededir (KVKK); müşteri telefonu, e-postası gibi veriler gitmez.

## Teknik gereksinimler

- **Yerel öncelikli:** kafedeki bir bilgisayarda çalışan sunucu (Node.js, SQLite), tabletler ve telefonlar
  tarayıcıdan bağlanır. İnternet kesilince satış durmaz; senkron kuyruğu internet gelince gönderir.
- **Gerçek zamanlı:** bütün cihazlar değişikliği anında görür (sunucu olayları, SSE).
- **Para:** her yerde kuruş cinsinden tam sayı; fiyatlar KDV dahil; KDV oranı satış anında kaleme dondurulur.
- **Arayüz:** Türkçe, dokunmatik öncelikli, L'Affogato renkleri (orman yeşili, bordo, krem, pirinç), açık
  ve koyu tema (bar ekranı koyu).
- **Güvenlik:** PIN'ler anahtarlı özetle saklanır, oturumlar süreli, deneme sınırı, denetim kaydı, günlük
  yedek.
- **Test:** hesap çekirdeği, yetki, ödeme ve imza için birim testleri; ekranlar gerçek tarayıcıda denenir.

## Teslim biçimi

- Dalgalar hâlinde ilerle. Her dalganın sonunda testler ve tip denetimi yeşil olsun, dal GitHub'a gönderilsin.
- Dal adı `claude/dalga-<n>-<konu>`, PR başlığı "Dalga N: …" (lafmaliyet ile aynı düzen).
- `docs/` altında plan, analiz ve entegrasyon sözleşmesi güncel tutulsun.

## Kabul ölçütleri

- Kasiyer PIN'le girer, gün açar, masa açar, M/L ve seçenekli ürün ekler, bara gönderir; bar ekranında
  fiş saniyesinde görünür.
- Bir adisyon üç kişi arasında kalem bazlı ve kısmen nakit, kısmen kartla kapanır; kuruş kaybolmaz.
- Garsonun gönderilmiş kalem iptali yetkili PIN'i olmadan yapılamaz; yapılınca patron panelinde uyarı çıkar.
- Gün sonu Z'si ödeme türü ve KDV kırılımını, iptal/ikram/indirimi ve kasa farkını verir; lafmaliyet Kasa
  raporu alanları aynı sırada kopyalanabilir.
- "Siteyle eşitle" sitedeki menüyü çeker; fiyatı değişen ve yeni ürünleri önceden gösterir.
- İnternet kesikken satış devam eder.

## Kapsam dışı (bilinçli)

- ~~ÖKC / yazarkasa entegrasyonu~~ (ilk planda kapsam dışıydı; operatör isteğiyle yapıldı: TokenX Connect,
  `docs/04-YAZARKASA.md`). Mali fiş yine GİB onaylı cihazdan kesilir; LafPOS'un adisyonu bilgi fişidir.
- **e-Arşiv / e-Fatura:** lafmaliyet'te ve Paraşüt tarafında kalır.
- **Yemek platformları (Yemeksepeti, Getir, Trendyol) canlı entegrasyonu:** platform anlaşması ve anahtar
  gerektirir; adaptör arayüzü hazırlanır.
- **Reçete, hammadde, tedarikçi, maliyet yönetimi:** lafmaliyet'in işi; LafPOS kopyalamaz.

---

## Ek istek 2 (26 Ekim 2026): kasa bilgisayarı, roller, tek sistem mi iki sistem mi

**Operatörün sözü:** _"Kasa bilgisayarında açık olacak bu Chrome, ona göre ayarla ve POS cihazına vs gidecek
ödeme olacak rapor olacak falan; ModPOS'a gir bak ne zaman istersen. Ayrıca rol yetki tanımlama yap, kasiyer
olarak girince belli şeyleri görecek. NarPOS, robotPOS falan bak veya yurt dışı muadillerine: eğer 2 farklı
sistem oluyorsa ürün yüklemek ve kasa için öyle yap, tek sistem oluyorsa öyle yap, hangisi daha iyiyse.
laffogato ve lafmaliyet repolarında da istediğin değişikliği yapabilirsin, uyumlu olacak şekilde; md
dosyalarına not edip merge et."_

### Geliştirilmiş hâli

Sen LafPOS'un baş geliştiricisisin. LafPOS kafedeki **kasa bilgisayarında Chrome'da** sürekli açık duracak;
tablet ve telefonlar aynı sunucuya ağdan bağlanır. Şunları yap ve her birini gerçek tarayıcıda doğrula:

1. **Kasa bilgisayarı:** Chrome'u kiosk (tam ekran, adres çubuksuz) ve sessiz fiş yazdırma ile açan
   başlatıcılar (Windows öncelikli, macOS da), bilgisayar açılınca LafPOS sunucusunun ve Chrome'un kendiliğinden
   başlaması, ekranın kararmaması (Wake Lock), yanlışlıkla geri gitme ve yakınlaştırmanın engellenmesi, fiş
   yazıcısı ve para çekmecesi notları. Kurulum belgesi: `docs/05-KASA-BILGISAYARI.md`.
2. **Ödeme cihazı ve raporlar:** ödeme yazarkasa POS'a (TokenX Connect) sepet olarak gider, sonuç adisyona
   işlenir; X/Z ve satış raporları rolün izin verdiği kadar görünür.
3. **Roller ve yetkiler (ModPOS "Pozisyonlar" ve "Özel Yetkiler" gibi):** rol yetki setleri yönetimden
   düzenlenebilir (patron rolü kilitli), kişiye ek ya da kaldırılan yetki kalır. Yeni yetkiler: kör kasa
   (kasiyer sayımda sistem rakamlarını görmez), ara rapor (X), ürünü kasadan tükendi işaretleme. Kasiyer
   girince yalnız işinin ekranlarını görür; adresle girmeye çalıştığı yönetim sayfası açılmaz, sunucu da
   reddeder.
4. **Tek sistem mi iki sistem mi:** NarPOS, robotPOS, ModPOS, Toast, Square, Lightspeed'e bak; kararı ve
   gerekçesini `docs/06-TEK-SISTEM.md`'ye yaz, ürün yükleme ve kasa akışını karara göre düzenle.
5. **laffogato ve lafmaliyet:** bağlantı PR'larını (laffogato#263, lafmaliyet#34) güncel ana dala göre
   tamamla, bağımsız incelemeden geçir, CI yeşilken birleştir; değişiklikleri iki reponun md belgelerine
   yaz. Üretim yalnız ana daldan yayınlanır; birleştirme sonrası canlıda kontrol et.
6. **Kapanış:** typecheck, birim testleri, derleme ve e2e (telefon, tablet, bilgisayar, koyu tema, akışlar)
   yeşil; LafPOS PR'ı açılıp birleştirilir; açık kalan ve operatörün yapması gereken adımlar (Vercel ortam
   değişkeni, gerçek cihaz turu) ayrıca listelenir.

### Görevler (açık işlerle birlikte)

| # | Görev | Durum |
|---|---|---|
| 1 | Innex yönetim paneli, telefon ve tablet uyarlaması, e2e ve birim testleri | Tamam (commit `0022871`) |
| 2 | Yazarkasa belgesi (`docs/04-YAZARKASA.md`) ve `.env` örneği | Tamam |
| 3 | Bu bölüm: geliştirilmiş istek ve görevler | Tamam |
| 4 | Tek sistem / iki sistem araştırması ve kararı (`docs/06-TEK-SISTEM.md`) | Açık |
| 5 | Roller: düzenlenebilir rol yetkileri, kör kasa, X raporu, kasadan tükendi; kasiyer görünümü ve testleri | Açık |
| 6 | Kasa bilgisayarı: Chrome kiosk başlatıcıları, otomatik başlatma, Wake Lock, yazdırma; belge | Açık |
| 7 | laffogato#263 ve lafmaliyet#34: güncelle, incele, CI, md notları, birleştir | Açık |
| 8 | LafPOS PR'ı: bütün kapılar, inceleme, birleştir | Açık |
| 9 | Operatöre kalanlar: `LAFPOS_SYNC_SECRET` (laffogato Vercel ve lafmaliyet), kasa `.env`, gerçek cihaz turu | Açık |
