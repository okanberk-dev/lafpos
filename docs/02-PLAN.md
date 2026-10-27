# Plan: mimari, veri modeli ve dalgalar

## 1. Mimari kararlar

| Karar | Seçim | Neden |
| --- | --- | --- |
| Çalışma biçimi | Kafedeki bir bilgisayarda yerel sunucu; cihazlar Wi-Fi'dan tarayıcıyla bağlanır | İnternet kesilince satış durmamalı (robotPOS'un hibrit yapısının karşılığı). Neon kotasına yük bindirmez |
| Sunucu | Node.js 22+, Hono, `tsx` ile TypeScript | Hafif, hızlı, tek süreç; Next.js'in bulut odaklı yapısı yerel POS'a gereksiz |
| Veritabanı | SQLite (WAL) + Drizzle ORM 0.45 | Kurulumsuz, tek dosya, günlük yedeği kopyalamak yeter; Drizzle ve Zod sürümleri lafmaliyet ile aynı |
| Arayüz | React 19 + Vite 6 + Tailwind 4, tek sayfa uygulama | Dokunmatik, hızlı; tablet ana ekrana eklenebilir |
| Gerçek zamanlı | Sunucu olayları (SSE, `fetch` akışıyla, başlıkta oturum) | WebSocket kütüphanesi gerektirmez, kopunca kendini yeniden bağlar; jeton adres satırına düşmez |
| Para | Kuruş tam sayı; ortak hesap çekirdeği (`shared/order-calc.ts`) hem sunucuda hem istemcide | Tek doğruluk kaynağı; indirim kalemlere en büyük kalan yöntemiyle dağıtılır, kuruş kaybolmaz |
| Kimlik | PIN (sunucu anahtarlı HMAC), süreli oturum, deneme sınırı | Kafede hızlı kullanıcı değişimi; veritabanı dosyası tek başına sızarsa PIN çözülemez |
| Kayıt kimlikleri | ULID (zamana göre sıralı) | Buluta senkronda çakışmaz |
| Node sürümü | 22.11 ile çalışacak paket sürümleri (Vite 6, React Router 7, Vitest 4) | Makinede Node 22.11 var; sistem Node'una dokunulmadı. Üretimde Node 24 LTS önerilir |

## 2. Klasör yapısı

```
lafpos/
  shared/        para, adisyon hesabı, yetkiler, olay tipleri (sunucu + istemci ortak)
  server/
    db/          şema, bağlantı, göç (migration), örnek veri
    lib/         kimlik, olay yayını, denetim, hata, imza (HMAC)
    services/    iş kuralları: adisyon, ödeme, kasa/Z, rapor, karaoke
    routes/      HTTP uçları (modül başına bir dosya)
    sync/        laffogato menü + online sipariş, lafmaliyet dışa aktarım + giden kutusu
    print/       ESC/POS üretici, ağ yazıcısı
  src/           React arayüzü (sayfalar modül başına)
  drizzle/       üretilen SQL göçleri
  tests/         birim ve uç testleri
  docs/          prompt, analiz, plan, entegrasyon sözleşmesi
  data/          (git dışında) veritabanı, gizli anahtar, yedekler
```

## 3. Veri modeli (özet)

| Tablo | Amaç | Not |
| --- | --- | --- |
| `settings` | anahtar → JSON ayar | işletme adı, fiş metinleri, servis oranı, otomatik kilit, senkron ayarları |
| `users`, `sessions` | personel, PIN, rol, kişi bazlı yetki; oturumlar | PIN `HMAC(secret, pin)` olarak tekil |
| `sections`, `tables` | masa planı | `kind: masa | oda` (karaoke), `siteTableCode` (site QR masası eşlemesi), saatlik ücret |
| `stations`, `printers` | bar/mutfak yönlendirme, yazıcılar | ağ yazıcısı (IP:9100) ya da tarayıcı |
| `categories`, `products` | menü | `price` (M/tek), `priceL` (L), `kdvRate`, `extSource/extId` (`laffogato`/`mnu-0011`), POS'a özel alanlar, porsiyon sayacı, `isService` |
| `option_groups`, `option_items`, `product_option_groups` | süt, kavrum, şurup, ekstra shot, şeker | site kodlarıyla (`oat`, `vanilla`…) |
| `happy_hours` | saat/gün/kategori indirim kuralı | |
| `payment_methods` | nakit, kart, yemek kartları, havale, cari | `zField` → lafmaliyet Z alanı (`cash`, `card`, `meal_card`, `online`, `other`), `channel` → komisyon kanalı (`pluxee`…) |
| `business_days` | iş günü (05:00 kuralı), açılış/sayım, Z özeti | `zNo`, `lastOrderNo` |
| `orders`, `order_items`, `payments` | adisyon, kalem, ödeme | kalemde KDV, boy, seçenekler, iptal/ikram/indirim bilgisi, istasyon durumu, ödenen adet; online sipariş alanları (`extId`, `extPaid`); ödemede istemcinin deneme kimliği (`request_id`, adisyon başına tekil: yanıtı kaybolup yeniden gelen aynı istek ikinci kez yazılmaz, ilk sonuç döner; aynı kimlikle başka tür, tutar, pay ya da kalem gelirse ya da o ödeme iptal edildiyse 409 `request_reused` / `request_refunded`, göç 0004) |
| `cash_movements` | harcama, teslim, giriş | lafmaliyet `cash_outs` türleriyle uyumlu |
| `room_sessions` | karaoke odası sayacı | |
| `customers`, `customer_addresses`, `customer_ledger` | müşteri, adres, açık hesap | damga kartı sayacı |
| `reservations` | rezervasyon | |
| `audit_log` | denetim ve patron uyarıları | `severity: info | uyari | alarm` |
| `outbox`, `sync_state` | giden kutusu, senkron durumu (ETag, son çekim) | |

## 4. Dalgalar ve görevler

Her dalga: kod + birim testleri + tip denetimi + tarayıcıda deneme + GitHub'a push (dal ve PR).

### Dalga 0: plan ve iskelet

- [x] Ortam (Node 22.11 uyumu), repo, paketler
- [x] Para ve adisyon hesap çekirdeği, testleri
- [x] Geliştirilmiş prompt, analiz, plan, entegrasyon sözleşmesi

### Dalga 1: çekirdek POS (kafede bir gün satış yapılabilir)

1. Şema, göç, örnek veri (L'Affogato menüsü sitenin yapısıyla, köşk masa planı, personel, ödeme türleri)
2. PIN girişi, oturum, yetki, yetkili onayı, denetim kaydı
3. Uygulama kabuğu: gezinme, gün durumu, bağlantı göstergesi, kilit, tema
4. Masa planı: bölümler, durum renkleri, süre/tutar/garson, tezgâh ve gel-al hızlı satış
5. Adisyon: ürün ızgarası, arama, boy ve seçenek penceresi, not, adet, gönder (istasyona yönlendirme), happy hour
6. Masa işlemleri: taşı, birleştir, kalem taşı (böl), kişi sayısı, garson değiştir
7. İptal, ikram, kalem ve adisyon indirimi: gerekçe, yetki, yetkili PIN onayı, uyarı
8. Ödeme: nakit (para üstü, hızlı banknot), kart, yemek kartı, havale, cari; parçalı, kalem bazlı, kişi başı;
   bahşiş; ödeme iptali; yeniden açma
9. Canlı olay yayını: bütün ekranlar anında güncellenir

Kabul: kabul ölçütlerinin ilk üçü (bkz. geliştirilmiş prompt).

### Dalga 2: bar/mutfak ekranı, kasa, çıktılar

1. Bar/mutfak ekranı: istasyon filtresi, süre renkleri, hazırlanıyor/hazır/servis, ses, iptal fişi, geçmiş
2. Kasa: gün aç, harcama/teslim/giriş, X raporu, Z (ödeme türü, KDV, iptal/ikram/indirim, banknot sayımı, fark)
3. Çıktılar: adisyon, mutfak fişi, Z; 80 mm tarayıcı yazdırma ve ESC/POS ağ yazıcısı

### Dalga 3: entegrasyon

1. laffogato menü senkronu: herkese açık menü (ETag), eşleme, fark önizleme, uygula, POS alanlarını koru
2. İmzalı panel bağlantısı (anahtar varsa): Tükendi/Satışa aç siteye; Tükendi kalemleri görme
3. Online siparişler (anahtar varsa): bar ekranında ve masa planında; aşama düğmeleri; tekrar tahsil yok
4. lafmaliyet: günlük/aylık ürün satış listesi (Satışlar biçimi), Z özeti (Kasa raporu alan sırası),
   ikram listesi; imzalı uç için giden kutusu ve istemci (lafmaliyet tarafı yazılınca açılır)
5. İmza uyumu testi: iki projenin sabitlediği vektörler

### Dalga 4: müşteri, paket, rezervasyon, karaoke, porsiyon

1. Müşteri/cari: telefonla bul, adresler, açık hesap, tahsilat, geçmiş, damga kartı
2. Gel-al ve paket panosu: kurye, durumlar
3. Rezervasyon: gün görünümü, masa ataması, planda gösterim
4. Karaoke odası sayacı: başlat/durdur, saatlik ücret, HİZMET satırı
5. Porsiyon sayacı: günlük adet, sıfırda otomatik Tükendi (ve siteye bildirim)

### Dalga 5: raporlar, patron paneli, yönetim

1. Raporlar: özet, ürün/kategori, saatlik, ödeme türü, personel, iptal/ikram/indirim, KDV, CSV
2. Patron paneli: canlı ciro, geçen haftayla kıyas, saatlik grafik, en çok satanlar, açık masalar,
   uyarı akışı ve anomali kuralları
3. Yönetim: menü ve seçenekler, masa planı düzenleyici, personel ve yetkiler, ödeme türleri,
   istasyon/yazıcı, happy hour, fiş metinleri, entegrasyon ayarları, denetim kaydı, yedekleme

### Dalga 6: sağlamlaştırma

1. Uç testleri (adisyon akışı, ödeme, yetki, gün sonu)
2. Uçtan uca tarayıcı denemesi (tablet ve telefon genişliği)
3. Kurulum kılavuzu (kafe bilgisayarı, tabletler, uzaktan patron erişimi), otomatik yedek

### Durum (26 Ekim 2026)

Dalga 1-6 tamam ve birleşti (RiosenBeq/lafpos#1, 26 Ekim 2026; laffogato#263 ve lafmaliyet#34/#36 aynı gün canlıda). Planın üstüne yapılanlar: yazarkasa POS (TokenX Connect,
`docs/04-YAZARKASA.md`), Innex yönetim paneli ve telefon/tablet uyarlaması (`DESIGN.md`), düzenlenebilir
roller, kör kasa ve kasadan tükendi (Yönetim › Roller ve yetkiler), kasa bilgisayarı kurulumu
(`docs/05-KASA-BILGISAYARI.md`), tek sistem kararı (`docs/06-TEK-SISTEM.md`). Doğrulama (akşam turundan sonra): 107
birim ve API testi, gerçek Chrome'da 121 ekran ve 10 akış (`npm run e2e`, CI'da da).

Bağımsız inceleme (26 Ekim 2026) ve düzeltmeleri, her biri `tests/review-fixes.test.ts`'te bir testle:
yazarkasada sepeti bekleyen adisyonun tutarı ve ödemesi kilitli; indirim, ikram ve iptal ödenmiş tutarın altına
inemez; QR siparişine kalem taşınmaz; aynı kalem iki kez seçilince bir kez ücretlenir; yeniden açma ve ödeme
iptali müşterinin ziyaret, harcama ve damgasını geri alır; cihazda açık hesap müşterisiz ya da sınır aşınca
alarm, fiş iptali cari ekstresini düzeltir; iptal sayılan sepete geç gelen "ödendi" alarm verir; servis ücreti
cihaza ayrı satır; kör kasada kapanmış adisyonun ödeme dökümü gizli; fiş iptali ve kaydedilmiş sayımı
değiştirmek yetkili onayı ister; yetki yükseltme, kendi rolünü değiştirme ve son patronu kapatma yok; PIN
sınırı `X-Forwarded-For`'a bakmaz, ağ genelinde de sınır var; bir iş gününe tek Z, kapanıştan sonra "Günü
yeniden aç"; lafmaliyet'e `cashIn` ve `expectedCash` gider, 409 kalıcıdır. Ayrıca düzenleme uçları
`patchOf` kullanır: Zod 4'te `.partial()` varsayılanı uyguladığı için masanın adı değişince konumu ve türü,
rezervasyonun durumu değişince kişi sayısı ve süresi sıfırlanıyordu.

İkinci bağımsız inceleme (aynı gün, düzeltmelerin üstüne; `tests/review-round2*.test.ts`): patron olmayan yetkili
üstündekinin PIN'ini değiştiremez, onu kapatamaz, rolünü boşaltamaz, kendi indirim sınırının üstünde sınır
veremez; ağ geneli PIN kilidi kayan pencereyle sayar ve doğru PIN'le girmiş cihazları ve yetkili onayını durdurmaz
(alarm yazar); Token kesintisinde takılan sepet yetkili onayıyla LafPOS'ta iptal sayılır; kör kasa süzgeci adisyon
döndüren bütün uçlarda; indirim kayması cihaza "Servis ücreti" diye gitmez; yeniden açılan gün öbür cihazlara
yayılır ve otomatik gün sonu onu hemen kapatmaz (`business_days.reopened_at`); oda sayacı çalışırken hesap cihaza
gitmez, kapanmış adisyona oda ücreti yazılmaz; lafmaliyet'e gönderim sürerken basılan "Gönder" gerçekten gönderir.

Aynı gün akşam (RiosenBeq/lafpos `claude/kasa-sade-tasarim`): kasa ekranları da Innex'e geçti (`DESIGN.md` §1);
**paylaşımlı hesap**: hesap N kişiye kuruşu kuruşuna bölünür, her pay ayrı ödenir, sonradan eklenen kalem ya da
iptal edilen pay kalanlara dağılır (`orders.split_people`, `payments.share_no/share_of`, göç 0003;
`tests/split-bill.test.ts` ve e2e akışı); **Windows kurulum dosyası** (`npm run kurulum:windows`,
`docs/05-KASA-BILGISAYARI.md` §2); **uzaktan canlı erişim** Tailscale ile ve Yönetim › Ağ ve uzaktan erişim
(`docs/07-UZAKTAN-ERISIM.md`, `tests/network.test.ts`); logo laffogato.net'in L'Af vektörü.

Simpra ve robotPOS karşılaştırmasından (26 Ekim gece, `claude/ust-duzey-kasa`): tezgâhta tek ekran (Öde gönderir
ve ödemeyi açar, satış bitince yeni satış; boş tezgâh adisyonu yeniden kullanılır, gün sonunda boşlar kapanır), bar
ekranında Toplam görünümü, Hazır çağrı ekranı (`/cagri`), hazırlama süresi raporu, siparişi alana hazır bildirimi,
elle fiyat, müşteri ekranı (`/musteri-ekrani`), adisyonda görselli ürün kartları ve kategori listesi, LafPOS Uzaktan
(Vercel, salt okunur; `docs/07-UZAKTAN-ERISIM.md` §4). Sırada: patronun telefonuna alarm bildirimi (lafmaliyet Web
Push), vardiya kasa sayımı, personel giriş-çıkış, kampanya kuralları (fiyatın sahibi site; karar gerekir).

Açık: ESC/POS ağ yazıcısına doğrudan basım (şimdilik tarayıcıdan 80 mm), yemek platformlarının canlı
bağlantısı, kasada damga (laffogato M2M), gerçek cihazla (iPhone, Android, fiş yazıcısı, ÖKC) kurulum turu,
kurulum dosyasının gerçek Windows'ta ilk turu (`docs/05-KASA-BILGISAYARI.md` §2 sonundaki liste), kurulum
dosyasının kod imzası (imzasız dosyada Windows SmartScreen uyarır).

## 5. Diğer repolarda gereken işler (ayrı PR, kullanıcı onayıyla)

| Repo | İş | Neden |
| --- | --- | --- |
| lafmaliyet | (RiosenBeq/lafmaliyet#34) İmzalı `POST /api/pos/gun` ucu: günlük satış satırları + Z alanları + ikram; `pos_daily_sales` tablosu ve `loadDailyProductSales` yükleyicisi; Kasa raporunda `CashPrefill { source: "lafpos" }` | Elle Z ve aylık liste girişini bitirir; sözleşme `docs/03-ENTEGRASYON.md` §4 |
| lafmaliyet | İmzalı `GET /api/panel/pos/urunler`: ürün, boy, reçete maliyeti | Patron panelinde ürün kârlılığı (yalnız `rapor.maliyet` yetkisi) |
| laffogato | Ayrı anahtarlı `/api/pos/*` (ortak `KARAOKE_SYNC_SECRET` yerine): RiosenBeq/laffogato#263 | Kafedeki makineye panel anahtarı koymamak, ayrı döndürülebilir anahtar |
| laffogato | Online sipariş için ucuz "değişti mi" sinyali: `GET /api/pos/orders/version` (#263) | 5 dk sorgu sınırı varken siparişi saniyesinde görmek |
| laffogato | Kasada damga (M2M) | Uygulama üyesine kasada damga vermek |

## 6. Riskler

| Risk | Önlem |
| --- | --- |
| Neon kotası (site) | Yalnız CDN'deki menü ucu sık çekilir; imzalı uçlar en sık 5 dakikada bir ya da elle |
| Ortak anahtarın kafe makinesinde durması | Opsiyonel; `.env`'de, dosya izinleri 600; ayrı anahtar için laffogato PR'ı önerildi |
| Mali mevzuat | Adisyon "mali değeri yoktur" bilgi fişi; mali fiş ÖKC'den (TokenX Connect bağlantısı, `docs/04-YAZARKASA.md`) |
| Tek makine arızası | Günlük otomatik SQLite yedeği; kurulum kılavuzunda yedeğin başka diske/buluta kopyası |
| Online siparişin çift sayımı | `extPaid` siparişler tahsil edilmez, lafmaliyet satış listesine girmez |
