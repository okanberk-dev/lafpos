# Analiz: referans POS'lar ve L'Affogato sistemleri

Tarih: 26 Eki 2026.

## 1. Gafgidi panelleri

`patron.gafgidi.com` ve `panel.gafgidi.com` adresleri ile denenen bütün varyantlar (`gafgidi.com`, `.com.tr`,
`.net`, `.app`, `.io`, `kafgidi.com`) DNS'te kayıtlı değil; Chrome da "sayfa açılamadı" verdi. Web aramasında
bu adla bir POS ürünü çıkmadı. lafmaliyet belgeleri ModPOS'un arka ofisinin adını "Patron" olarak geçiriyor;
adres büyük olasılıkla ModPOS Patron paneline ait ve yazımı farklı. **Doğru adres gelince bu bölüm ekran ekran
özellik karşılaştırmasıyla güncellenecek.** O zamana kadar karşılaştırma aşağıdaki yayımlanmış kaynaklarla
yapıldı.

## 2. Referans ürünlerin özellikleri

Kaynaklar: robotPOS'un [kafe](https://en.robotpos.com/cafe-pos-system) ve
[restoran](https://en.robotpos.com/restaurant-pos-system) sayfaları, NarPOS'un yayımlanmış tanıtımı, lafmaliyet
belgelerindeki ModPOS (Patron) kullanımı.

| Özellik | ModPOS (bugün kafede) | robotPOS | NarPOS | LafPOS |
| --- | --- | --- | --- | --- |
| Masa planı ve masa işlemleri | var | var | var | var, sürükle-bırak düzenleyici |
| Seçenekli ürün (süt, shot, şurup) | kısıtlı | var | var | var, siteyle aynı seçenekler |
| Hızlı tezgâh satışı | var | var | var | var |
| Bar / mutfak ekranı | yazıcı fişi | var | var | var, süre renkleri ve ses |
| Parçalı, kalem bazlı, kişi başı ödeme | kısmen | var | var | var, kuruş kaybı yok (testli) |
| Yemek kartları | var | var | var | var, lafmaliyet komisyon kanallarıyla aynı anahtarlar |
| İptal / ikram / indirim yetkisi | rol bazlı | rol bazlı | rol bazlı | kişi bazlı yetki + anlık yetkili PIN onayı |
| Gün sonu Z, kasa sayımı | var | var | var | var, banknot sayacı, lafmaliyet Kasa raporu alanlarıyla birebir |
| Patron (uzaktan) raporu | var | var | var | canlı panel, geçen haftayla kıyas, uyarı akışı |
| Anomali tespiti | yok | var (aiR) | yok | iptal oranı, kasa farkı, büyük indirim, yeniden açılan adisyon |
| Online sipariş tek ekranda | yok (site ayrı) | platformlar | platformlar | site/uygulama siparişleri bar ekranında ve masada |
| Menü tek kaynaktan | **yok**: ürün ve fiyat elle üçüncü kopya | merkezi menü | merkezi menü | site menüsünden senkron, önizlemeli |
| Tükendi her yerde birden | yok | var | var | POS'tan Tükendi → site ve uygulama |
| Reçeteli stok, maliyet | var | var | var | lafmaliyet'te (kopyalanmaz), satış verisi oraya akar |
| Happy hour | elle | kampanya | kampanya | saat/gün/kategori kuralıyla otomatik |
| Karaoke / süreli hizmet | elle | yok | yok | oda sayacı, saatlik ücret, HİZMET KDV %20 |
| Çevrimdışı çalışma | ? | hibrit | ? | yerel sunucu + giden kutusu |
| Sadakat | yok | damga, puan | ? | damga kartı (LafPOS içi); site sadakatiyle birleşme sonraki iş |
| ÖKC (yazarkasa) | ayrı cihaz | entegre | entegre | kapsam dışı: bilgi fişi, mali fiş ÖKC'den |
| e-Fatura / e-Arşiv | ? | var | var | kapsam dışı (lafmaliyet + Paraşüt) |
| Yemek platformu entegrasyonu | yok | var | var | adaptör arayüzü; canlı bağlantı anlaşma ister |

## 3. laffogato (site + mobil API)

- **Veritabanı:** Neon Postgres (ücretsiz plan, ayda 100 CU-saat; 5 dakika boşta kalınca uyur, her istek
  uyandırır; 29 Eyl - 1 Eki'de kota yüzünden kesinti yaşandı). ORM yok.
- **Menü (`menu_items`):** `id` (`mnu-NNNN`), `categoryKey` (12 sabit kategori: matcha, espresso,
  ice-coffee, cold, hot, frappe, smoothie, frozen, ice-tea, dessert, snack, extras), `name`, `desc`,
  `priceMinor` (M ya da tek boy, kuruş, KDV dahil), `priceMinorL` (L; 0 = tek boy), `image`, `isActive`
  (Satışta / Tükendi), `sortOrder`, `taxRatePct` (boşsa varsayılan %10), `allergens`, `tags`.
- **Seçenekler kodda sabit** (`src/lib/mobile/customization.ts`): süt (Normal 0, Laktozsuz 0, Yulaf 25 ₺,
  Badem 25 ₺), kavrum (Yoğun, Hafif), şurup (Yok, Vanilya, Karamel, Fındık: 50 ₺), ekstra shot 50 ₺, şeker
  0-3. Tatlı, atıştırmalık ve ekstralar kategorilerinde seçenek yok.
- **Herkese açık menü:** `GET /api/mobile/v1/menu` (CDN'de 5 dk, ETag, 304). Tükendi kalemleri içermez.
- **İmzalı panel uçları:** `GET/POST /api/panel/menu` (Tükendi dahil liste; fiyat ve Satışta yazma),
  `GET /api/panel/orders` (ödenmiş kafe siparişleri: masa, gel-al, kurye), `POST /api/panel/orders/stage`
  (hazırlanıyor / hazır / teslim), `GET /api/panel/sales`. İmza: HMAC-SHA256, kanonik metin
  `ts\nMETHOD\npath\nsıralı-sorgu\nsha256(gövde)`, başlıklar `x-laf-timestamp`, `x-laf-signature: v1=<hex>`,
  ±300 sn, anahtar `KARAOKE_SYNC_SECRET` (≥32 karakter, site ile lafmaliyet ortak).
- **Kural:** site menüsünün fiyat ve Satışta bilgisi sitenin; reçete ve maliyet panelin. Site arka ucu
  ayrı PR'la değişir, `/api/mobile/v1` yalnız eklemeli değişir.
- **ModPOS:** "üçüncü kopya"; ürün ve fiyatı elle güncelleniyor. Uygulama/web siparişleri ModPOS'ta
  çalınmıyor; kasada ödenenler ÖKC fişi alıyor.

## 4. lafmaliyet (maliyet ve arka ofis)

- **Yığın:** Next 16.4, React 19.3, Drizzle 0.45 + postgres.js, Zod 4, Node 24, Neon (sitenin
  veritabanından ayrı). Para TL cinsinden ondalık; iş günü 05:00'te döner.
- **Ürün (`products`):** ad, boy (`M | L | Tek`), fiyat, `site_menu_id` + `site_menu_slot` (site
  kimliğiyle eşleme), reçete satırları (`recipe_items`, `qty_expr` formülleri), hammadde (`ingredients`).
- **Satış verisi bugün elle:** aylık ModPOS ürün listesi (ad, adet, tutar) Satışlar'a yapıştırılır ve
  `pos_mappings` ile isimden eşlenir; gece Z'si Kasa raporu formuna yazılır ya da fotoğraftan okunur.
- **Kasa raporu (`cash_reports`):** ModPOS Z alanları `z_no, receipts, z_total, cash, card, meal_card,
  online, other, off_revenue (ödenmez/ikram), discounts`; `bank_pos`; kasa alanları `opening_cash, cash_out,
  counted_cash, handed_over, cash_diff`.
- **Hazır bağlantı noktası:** `loadDailyProductSales(from, to)` bugün `null` dönüyor; planlanan satır
  biçimi `DailyProductSale { date, posName, productId | null, qty, revenue (TL, KDV dahil), isService }`.
  Mal siparişi, satış tahmini ve tatlı karışımı bu veriyi bekliyor. `CashPrefill { source: "modpos" }`
  tipi Z ön doldurma için tanımlı.
- **Dışarıdan yazma ucu yok.** Bütün değişiklikler oturumlu panel arayüzünden. Senkron kuralı: içeriksiz
  imzalı ping + imzalı çekme, 5 dakikadan sık periyodik iş yok, yeni cron yok, her alan beyaz listede.
- **KVKK:** personel maliyet, maaş, kâr ve karaoke tutarlarını görmez.

## 5. Sonuç: LafPOS'un yeri

```
                 ┌──────────────────────────────┐
  müşteri ─────▶ │ laffogato (site + uygulama)  │  menü, fiyat, Tükendi, online sipariş
                 └──────┬───────────────▲───────┘
            menü (CDN)  │               │ Tükendi, sipariş aşaması (imzalı)
            siparişler  ▼               │
                 ┌──────────────────────┴───────┐
  garson/barista │ LafPOS (kafedeki sunucu)     │  masa, adisyon, bar ekranı, ödeme, kasa, Z
  patron ──────▶ │ tablet · telefon · bilgisayar│
                 └──────┬───────────────────────┘
       günlük satış, Z  │ (bugün dışa aktarım, yarın imzalı uç)
                        ▼
                 ┌──────────────────────────────┐
                 │ lafmaliyet (arka ofis)       │  reçete, maliyet, stok, cari, kasa raporu
                 └──────────────────────────────┘
```

LafPOS ön cephedir. Ürünü site, maliyeti lafmaliyet bilir; LafPOS ikisini kopyalamaz, aralarındaki elle
taşımayı (fiyat kopyası, Z yazma, aylık liste yapıştırma) ortadan kaldırır.
