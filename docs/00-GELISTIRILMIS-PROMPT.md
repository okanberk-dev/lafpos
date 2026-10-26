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

- **ÖKC / yazarkasa entegrasyonu:** mali fiş GİB onaylı cihazdan kesilir. LafPOS'un adisyonu "mali değeri
  yoktur" bilgi fişidir (ModPOS ile aynı konum). Cihaz entegrasyonu ayrı bir proje.
- **e-Arşiv / e-Fatura:** lafmaliyet'te ve Paraşüt tarafında kalır.
- **Yemek platformları (Yemeksepeti, Getir, Trendyol) canlı entegrasyonu:** platform anlaşması ve anahtar
  gerektirir; adaptör arayüzü hazırlanır.
- **Reçete, hammadde, tedarikçi, maliyet yönetimi:** lafmaliyet'in işi; LafPOS kopyalamaz.
