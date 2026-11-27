---
name: restaurant-pos
description: Kafe ve restoran POS'u bir POS ürün mimarı gözüyle geliştirmek - masa, adisyon, bar ekranı, kasa, ödeme, personel ve rapor özelliklerini gerçek işletme akışına göre tasarlamak, para ve yetki kurallarını korumak. AsilPOS'ta yeni bir satış, ödeme, kasa, masa, bar, müşteri ya da rapor özelliği planlarken, eksik özelliği kurgularken ya da yerli (NarPOS, robotPOS, ModPOS) ve yabancı (Toast, Square, Lightspeed) sistemlerle kıyaslarken kullan.
---

> **Kaynak:** operatörün 4 Kasım 2026'da yapıştırdığı "Restaurant POS Development Skill" metni (NarPOS benzeri kafe ve
> restoran POS'u kurma rehberi; yayımlandığı yer ve lisansı belirtilmedi). Metin olduğu gibi kopyalanmadı: AsilPOS'a
> uyan kısımları alındı, Türkçeye çevrildi ve projenin kurallarına bağlandı. Alınmayanlar en altta, nedenleriyle.

## Bu projede (AsilPOS): bu bölüm aşağıdakilerin hepsinden önce gelir

Rehberin amacı AsilPOS'un amacıyla aynı: demo değil, gerçek bir kafede her gün çalışan, güvenilir, hızlı, sade bir
kasa. Önce `AGENTS.md`, `docs/02-PLAN.md`, `docs/03-ENTEGRASYON.md` ve arayüzde `DESIGN.md` okunur; çakışmada onlar
geçerlidir. Rehberin genel kuralları AsilPOS'ta şu karşılıklarla zaten bağlayıcı:

| Rehberin kuralı | AsilPOS'taki karşılığı |
|---|---|
| Para küsuratsız (minor units), kayan nokta yok | Kuruş tam sayı; hesap yalnız `shared/money.ts` ve `shared/order-calc.ts` (kural 1) |
| İstemci toplamına güvenme | Sunucu her yazmada toplamı yeniden hesaplar; pay, indirim ve ödeme tutarı sunucuda doğrulanır |
| KDV dahil/hariç kuralı tanımlı | Fiyatlar KDV dahil; oran satış anında kaleme dondurulur (kural 2) |
| Ön yüzdeki yetki gizlemesine güvenme | Her uç `requirePermission`; gizleme yalnız kolaylık; maliyet ve kâr `rapor.maliyet` (kural 3) |
| Denetim izi | İptal, ikram, ödenmez, indirim, ödeme iptali, yeniden açma, kasa hareketi, gün sonu, fiyat, senkron, bölüş denetime (kural 4) |
| Para işlemi yarım yazılmaz | Her yazma tek veritabanı işlemi, sonra `bus.publish` (kural 5) |
| Çift sipariş ve çift ödeme yok | Ödemede istemcinin deneme kimliği `request_id` (409 `request_reused`), düğmeler istek sürerken kilitli (`loading`) |
| Gerçek zamanlı eşitleme | Sunucu olayları (SSE); masa, adisyon, bar, ödeme ve stok aynı anda bütün ekranlarda |
| Çevrimdışı dayanıklılık | Sunucu kafedeki bilgisayarda: internet giderse satış sürer; dışarıya giden her şey giden kutusunda (`outbox`) artan beklemeyle |
| Mali entegrasyon ayrı | ÖKC TokenX Connect üzerinden ve ayrı katmanda (`server/okc/`, `docs/04-YAZARKASA.md`); adisyon "mali değeri yoktur" bilgi fişi |
| Donanım adaptörü | Yazarkasa sağlayıcıları `server/okc/providers`, yazdırma `src/lib/print.tsx` (80 mm), müşteri ekranı `/musteri-ekrani` |
| Türkiye | TRY, Türkçe arayüz, İstanbul saati ve 05:00 iş günü kuralı (`shared/time.ts`), yemek kartları ve platform kanalları |

### Modüllerin AsilPOS'taki durumu (yeni iş planlarken bak)

- **Kasa ekranı ve adisyon:** kategoriler, boy ve seçenek (zorunlu ve isteğe bağlı grup), not, adet, indirim, iptal,
  ikram, ödenmez, zayi, taşı, birleştir, ayrı hesap, hesap bölme (2-6 çipleri, eşit ve elle paylar), parçalı ve kalem
  bazlı ödeme,
  yeniden açma. Ekranlar `src/pages/order/`, kurallar `server/services/orders.ts`.
- **Masa:** plan, bölümler, karaoke odası sayacı, durum renkleri, süre ve garson, rezervasyon. `server/services/floor.ts`.
- **Bar ve mutfak ekranı:** istasyonlar, hazırlanıyor, hazır, teslim, hazırlama süresi raporu, çağrı ekranı.
- **Ürün:** menünün ve fiyatın sahibi site (laffogato); AsilPOS kısa ad, istasyon, porsiyon sayacı ve kasadan tükendi
  tutar. Happy hour kuralı var. Fiyatı AsilPOS'ta değiştirmek denetime düşer.
- **Stok, reçete, maliyet, tedarikçi, satın alma:** lafmaliyet'te. AsilPOS gün sonunda satış listesini gönderir, maliyeti
  çeker; AsilPOS'ta yalnız porsiyon sayacı ve zayi kaydı. Burada yeni stok modülü kurulmaz.
- **Kasa:** gün açma, kasa hareketi, X ve Z, banknotla sayım, kör kasa (`kasa.rakam`), **vardiya devri** (devreden sayar,
  devralan PIN'iyle onaylar). Personel mesaisi (giriş-çıkış) 4 Kasım 2026'da operatör kararıyla kaldırıldı; rehberdeki
  "shift management" AsilPOS'ta yalnız vardiya devri sayımıdır.
- **Personel:** PIN, rol, kişiye özel yetki, indirim sınırı, oturum ve denetim kaydı; performans Raporlar › Personel'de.
- **Müşteri:** telefonla bul, adres, açık hesap (cari), damga kartı; kampanya kuralı açık karar (fiyatın sahibi site).
- **Rapor:** özet, ürün, kategori, saatlik, ödeme türü, personel, iptal-ikram-indirim, KDV, hazırlama süresi, platform,
  CSV; rapor rakamı değişecekse önce `validate-data`.

### Geliştirme sırası (rehberin 11. bölümü, AsilPOS'ta)

1. Var olanı incele: ilgili servis, uç, ekran ve testleri oku (`git grep`); aynı iş kuralını ikinci kez yazma.
2. Etkilenen tabloları bul; şema değişince `npm run db:generate` ve göçü commit'le, PATCH gövdesi `patchOf` (kural 9).
3. Var olan bileşene bak (`src/components/ui/*`, `src/components/admin/ui.tsx`); kendi denetimini yazma.
4. Planla: yetki, denetim kaydı, canlı olay, kör kasa, yazarkasa beklerken davranış, online ödenmiş sipariş (tahsil
   edilmez), tarayıcı demosu (kural 13) ve Windows paketi (kural 12).
5. Uygula; yükleniyor, boş ve hata durumlarını unutma (yüklenirken "yok" yazılmaz).
6. Kenar durumlarını sına: eşzamanlı iki cihaz, yinelenen istek, kapanmış gün, iptal edilen ödeme, kuruş kalanı.
7. Var olan akışı doğrula: `npm run typecheck && npm test`, arayüzde `npm run build && npm run e2e`.

### Rehberin test listesi ve AsilPOS'taki yeri

Adisyon açma ve değişiklik, iptal, parçalı ve bölünmüş ödeme, çoklu ödeme türü, KDV, indirim, stok düşümü (porsiyon),
kasa mutabakatı, eşzamanlı masa işlemleri, senkron ve yetki: hepsi `tests/` altında süreç içi uygulamayla
(`tests/harness.ts`) ve sql.js ile ikinci kez koşar. Yeni kural yeni testle gelir; rakam değişmezleri
`tests/report-reconciliation.test.ts`'te.

### Alınmayanlar

- **Çok şube, organizasyon, terminal tabloları:** tek kafe, tek sunucu; gerekirse ayrı karar.
- **Ayrı stok, reçete, tedarikçi ve satın alma modülü:** lafmaliyet'in işi (tek sistem kararı, `docs/06-TEK-SISTEM.md`).
- **Personel mesaisi ve vardiya planlama:** operatör kararıyla yok (yalnız vardiya devri sayımı).
- **Sadakat puanı, doğum günü teklifi, segment:** damga kartı ve sitedeki üyelik; kampanya için operatörün kararı gerekir.
- **"Yasal uyumu sağlar" iddiası:** mali konuda doğrulanmadan söz verilmez; ÖKC kuralları `docs/04-YAZARKASA.md`'de.
- **Barkod okuyucu ve para çekmecesi adaptörü:** bugün kafede yok; gelirse yazarkasa sağlayıcıları gibi ayrı katmanda.

## Rehberin özü (AsilPOS diliyle)

**Rol:** kıdemli yazılım mimarı ve POS uzmanı gibi düşün; ön yüzcü gibi değil. Her özellik gerçek işletme ihtiyacından
çıkar: yoğun saatte tek elle çalışan garson, tezgâhta kuyruğa bakan barista, gün sonunda kasayı sayan müdür.

**Öncelik sırası:** güvenilirlik, hız, sade kullanım, veri tutarlılığı, çevrimdışı dayanıklılık, güvenlik, kuruşu
kuruşuna doğru hesap.

**Arayüz:** dokunmatik önce, büyük hedefler, en az dokunuş, hızlı gezinme, açık ve koyu tema, net yazı, tutarlı boşluk,
erişilebilir renk. Kasa ekranı görsel süsten önce hızı seçer: solda gezinme, ortada çalışma alanı, sağda adisyon özeti
ve hızlı eylemler (AsilPOS'ta telefonda önce ürünler, alttaki yapışkan sepet çubuğu).

**Mimari:** ön yüz, arka uç, veritabanı, kimlik, iş kuralları, ödeme ve donanım ayrı katmanlarda; iş kuralı bileşenin
içinde değil serviste; yeniden kullanılan bileşen ve tanımlı servis katmanı.

**Veritabanı:** gerçek yabancı anahtar, dizin, işlem, doğrulama, tekil kısıt, oluşturma ve güncelleme zamanı; para
kaydı iz bırakmadan silinmez (iptal edilir, denetime yazılır).

**Asla:** iş kuralını çoğaltma, parasal değeri koda gömme, istemcinin toplamına güvenme, mali kaydı izsiz silme,
yükleniyor ve hata durumunu atlama, çalışan akışı bozma, gereksiz bağımlılık ekleme.
