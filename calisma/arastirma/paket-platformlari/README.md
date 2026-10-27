# Paket platformları: entegrasyon araştırması (27 Ekim 2026)

Amaç: LafPOS'ta tek bir sağlayıcı arayüzü (OKC sağlayıcıları gibi, `server/okc/providers`) ve simülatör; gerçek
anahtarlar gelince platform başına bağdaştırıcı. Kaynaklar sonda; indirilen belgeler bu klasörde
(`yemeksepeti-dh/*.yaml`: Delivery Hero POS middleware ve plugin API; `getir/swagger.json` ve `doc_*.json`).

## Kısa sonuç
- **Uber Eats Türkiye'de Trendyol Go üzerinden:** Uber, Trendyol Go'nun %85'ini 17 Haziran 2025'te aldı; Rekabet
  Kurulu Getir'in yemek ve market teslimatını Uber'e devrini 19 Haziran 2026'da onayladı. Trendyol Go belgeleri
  "GetirYemek by Uber Eats" siparişlerinin de Trendyol Go API'sinden geldiğini gösteriyor (`appName=Galaxy`).
  Getir'in kendi API'si kapanacak mı, belli değil.
- **Herkese açık API:** Yemeksepeti (Delivery Hero, NDA ve yerel sorumlu gerekir), Getir Yemek, Trendyol Go.
  **Migros Yemek** kapalı (belge herkese açık değil; SambaPOS gibi entegratörler var).
- **Sipariş alma:** Yemeksepeti push (POS'un herkese açık HTTPS ucu gerekir), Getir push + yedek yoklama
  (`/periodic/unapproved`), Trendyol Go yalnız yoklama (10 sn'de 50 istek). Kasa kafe ağında: push için LafPOS
  Uzaktan (Vercel) aktarıcı olur, kasa oradan çeker; Trendyol doğrudan kasadan.
- **Süreler:** Getir 30 sn içinde yanıt yoksa otomatik arama, 5 dk'da restoran kapanır; Yemeksepeti `expiryDate`
  (~15 dk, yanıtsız NO_RESPONSE iptali, tekrarında mağaza kapanır); Uber global 11,5 dk; Trendyol belgesiz.

## Platformlar
### Yemeksepeti (Delivery Hero POS middleware)
- Erişim: NDA + Delivery Hero yerel sorumlusu; anahtarlar PGP ile; `POST /v2/login` (client_credentials) → JWT
  (~1800 sn). Hazırlık (staging) ortamı var.
- "Direct" akış (POS kabul eder) duruma göre; çoğu yerde platform tableti kabul eder, POS yalnız kabul edilmişi alır.
- Sipariş: POS'ta `POST /order/{remoteId}`; birkaç saniyede `remoteOrderId` ile yanıt. 429/5xx'te 10 kez yeniden
  dener: aynı sipariş iki kez gelebilir (kimlikle tekilleştir).
- Çağrılar: `POST /v2/order/status/{token}`: `order_accepted`, `order_rejected` (~25 neden: ITEM_UNAVAILABLE,
  TOO_BUSY, CLOSED…), `order_picked_up` (kendi kurye / gel-al). Platform → POS: ORDER_CANCELLED, ORDER_PICKED_UP,
  COURIER_ARRIVED_AT_VENDOR (`PUT …/posOrderStatus`).
- Gövde: `code`, `shortCode` (mağazada gün içinde tekil), `selectedToppings`, müşteri notu, indirimlerde
  `sponsorships` (PLATFORM/VENDOR/THIRD_PARTY), `payment.status` paid|pending, `collectFromCustomer`, ön sipariş;
  tutarlar ondalık metin. Kurye: `expeditionType` + `delivery.riderPickupTime`.
- Menü tam gönderim, ürün açık/kapalı, mağaza açık / N dk kapalı / kapalı. Komisyon alanı kullanılmıyor.

### Getir Yemek
- Erişim: POS firması portalda başvurur; test ve canlı anahtar (`appSecretKey` + `restaurantSecretKey`);
  `/auth/login` 1 saatlik jeton.
- Sipariş: verdiğimiz iki adrese push (`newOrder`, `cancelOrder`, bizim belirlediğimiz `x-api-key`); yedek
  `/periodic/unapproved` (sürekli değil) ya da `/active`.
- Akış: `/verify` (ileri tarihli: `/verify-scheduled`) → `/prepare` → `/handover` (Getir kuryesi) ya da `/deliver`
  (kendi kurye); `/cancel` nedeni `/cancel-options`'tan. Çağrılar en az 1 dk arayla.
- Gövde: ürün başına seçenek ve `note`, `clientNote`, `totalPrice`/`totalDiscountedPrice` (indirimi kimin
  karşıladığı yok), `paymentMethod` sayısal (1 MasterPass, 3 kart, 4 nakit, 5 Multinet, 6 Sodexo, 8 Ticket,
  10 Setcard, 11 Metropol…), maskeli telefon, `isScheduled`, saatler GMT.
- Menü gönderimi yok; ürün/seçenek aç-kapa, zincir fiyat; 15/30/45 dk kapat, yoğun mod (+15 dk). Komisyon yok.

### Trendyol Go (Uber Eats Trendyol Go), yemek
- Erişim: satıcı panelinden supplierId + API anahtarı/gizli; Basic; başlıklar `User-Agent: "SellerId -
  Entegratör"`, `x-agentname`, `x-executor-user`; 10 sn'de uç başına 50 istek. Test ortamı IP izniyle (0850 210 7555).
- Sipariş: yalnız yoklama `GET /integrator/order/meal/suppliers/{id}/packages` (durum ve değişiklik zamanı süzgeci,
  sayfa başına 50).
- Akış: `PUT …/picked` (kabul, hazırlık süresi), `/invoiced` (hazır), `/manual-shipped`, `/manual-delivered`
  (kendi kurye), `/unsupplied` (tam ya da kalem kalem iptal, neden 621-627).
- Gövde: `deliveryType` STORE/GO, `storePickupSelected`, `modifierProducts`, `extra/removedIngredients`,
  `promotions` + `sellerCoverageRatio`, ödeme online ya da kapıda (nakit, kart, Multinet, Pluxee, Edenred, Setcard,
  Metropol, Tokenflex…), müşteri baş harfleri ve çağrı merkezi numarası; GO siparişinde adres "TGO Yemek".
- Menü okuma, ürün ACTIVE/PASSIVE, kategori aç-kapa, fiyat (1000'lik toplu); mağaza OPEN/CLOSED, saatler.
- **Komisyon var:** hesap kesimi ucu sipariş başına `commissionRate`, `commissionAmount`, `sellerRevenue`.
- Uber geçişi (önce Bilecik): sipariş kodu 3 → 5 karakter, dinamik telefon + `pinCode`, sipariş kendiliğinden
  "hazır"a geçebilir, açık adres yalnız `address1`'de.

### Migros Yemek
- Herkese açık belge yok (403). Üçüncü taraf koda göre (doğrulanmadı): Migros sipariş/iptal/kurye webhook'u,
  POS `gourmet.migrosonline.com`'a `XApiKey` ve AES şifreli gövdeyle `Order/v2/UpdateOrderStatus`.

### Uber Eats (genel API, yalnız başvuru için)
- NDA + ortak onayı, OAuth client_credentials (30 günlük jeton), sandbox; `orders.notification` webhook (HMAC-SHA256),
  11,5 dk kabul süresi (90 sn'de otomatik arama), menü gönderimi, `promo_funding_splits`, `cash_amount_due`.

## Bağdaştırıcının ortak işleri
Her sağlayıcı: kimlik doğrulama ve jeton yenileme; sipariş alma (push ya da yoklama); tek biçime çevirme (kimlik ve
kısa kod, kalem-seçenek-not, tutarlar kuruşa, indirimi kim karşıladı, ön ödemeli mi kapıda mı (yemek kartları
dahil; ön ödemeli kasada tahsil edilmez), kurye türü, ileri tarih, maskeli iletişim); kabul (hazırlık süresiyle);
ret / iptal (platformun neden kodlarıyla); hazır; platform iptalini alma, tekilleştirme; mağaza aç/kapa; ürün
satışta/değil.
Platforma göre: alındı/teslim (yalnız kendi kurye), kuryeye teslim (Getir), tam menü (DH, Uber), fiyat (Trendyol,
Getir zincir), yoğun mod (Getir, DH), kısmi iptal (Trendyol, DH), ileri tarih onayı (Getir), komisyon (Trendyol),
fatura bağlantısı (Getir, Trendyol).
Simülatör süreleri de taklit etmeli: Getir 30 sn / 5 dk, Uber 11,5 dk, DH ~15 dk.

## Kaynaklar
1. https://integration.foodpanda.com/en/documentation/
2. https://developers.deliveryhero.com/documentation/pos.html
3. https://integration-middleware.stg.restaurant-partners.com/apidocs/pos-plugin-api
4. https://integration-middleware.stg.restaurant-partners.com/apidocs/pos-middleware-api
5. https://developers.getir.com/food/documentation
6. https://food-external-api-gateway.getirapi.com/swagger.json
7. https://webrazzi.com/2026/06/19/rekabet-kurulu-uberin-getirin-yemek-ve-market-teslimati-islerini-devralmasina-onay-verdi/
8. https://developers.tgoapps.com/docs/authorization ve /docs/canli-test-ortam-bilgileri
9. https://developers.tgoapps.com/docs/trendyol-go-yemek-entegrasyonu/siparis-entegrasyonu/ymk-siparis-paketlerini.cekme
10. https://developers.tgoapps.com/docs/trendyol-go-yemek-entegrasyonu/siparis-entegrasyonu/ymk-paket-modelleri
11. https://developers.tgoapps.com/docs/duyurular
12. https://developers.tgoapps.com/docs/category/4-muhasebe-ve-finans-entegrasyonu
13. https://developers.tgoapps.com/docs/uber-eats-gecisi/ymk-uber-eats-gecisi-degisiklikleri
14. https://developers.tgoapps.com/docs/trendyol-go-hizli-market-entegrasyonu/siparis-entegrasyonu/tgo-uber-eats-webhook-entegrasyonu
15. https://developers.tgoapps.com/docs/trendyol-go-yemek-entegrasyonu/menu-entegrasyonu/ymk-urun-fiyat-guncelleme
16. https://github.com/canakboyraz/siparisgeldi/blob/main/integrations/migros.py
17. https://sambapos.com/migrosyemek-integration/
18. https://techcrunch.com/2020/05/04/uber-eats-exits-seven-markets-transfers-one-as-part-of-competitive-retooling/
19. https://www.sec.gov/Archives/edgar/data/1543151/000154315126000015/uber-20251231.htm
20. https://developer.uber.com/docs/eats/guides/getting-started
21. https://developer.uber.com/docs/eats/guides/webhooks
22. https://developer.uber.com/docs/eats/guides/order-integration
23. https://developer.uber.com/docs/eats/references/api/v2/get-eats-order-orderid
