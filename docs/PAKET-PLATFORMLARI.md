# Paket platformları

Yemeksepeti, Getir Yemek, Trendyol Go (Uber Eats Türkiye de buradan) ve Migros Yemek siparişleri kasaya düşer.
Araştırma ve platform belgeleri: `calisma/arastirma/paket-platformlari/` (calisma-notlari dalı).

## Akış
1. Sipariş gelir (`platform_orders`, durum `bekliyor`). Her ekranın üstünde şerit; platformun kabul süresi geri
   sayılır (Getir 5 dk, Yemeksepeti ~15 dk, Migros 10 dk; Trendyol Go süre belirtmez). Süre dolunca platformda
   iptal olmuştur (`suresi_doldu`).
2. **Kabul** (`paket.yonet`): hazırlık süresi seçilir; POS adisyonu açılır (kurye ya da gel-al), kalemler platformun
   fiyatıyla, restoranın kampanyası adisyon indirimi olur. Platformun karşıladığı kampanya ciroyu düşürmez.
   Kalemler adla eşlenir; kasada karşılığı olmayan kalem gizli "Platform ürünü" satırı olur, adı notta.
   **Ret** nedeniyle; denetim kaydına yazılır.
3. Bar ve mutfak normal fişi alır; adisyonun adı "Yemeksepeti A7KX" gibi (kurye bu kodu söyler).
4. Tahsilat: platform tahsil ediyorsa (online ödenmiş ya da platform kuryesi kapıda alır) adisyon platform
   kuryesine verilince (Yolda) ya da teslimde (kendi kurye, gel-al) platformun **online** ödeme türüyle (kanal =
   platform, Z'de online) kapanır; kasada tahsil edilmez. Kendi kuryemiz kapıda alıyorsa ödeme kasada alınır.
5. Platform iptal ederse: açık adisyonun platform ödemesi geri alınır, adisyon iptal olur.

lafmaliyet'e platform siparişi POS satışı olarak gider (satış satırları, `payments[].channel` = platform; komisyon
lafmaliyet'te kanala göre hesaplanır). Sözleşme: `docs/03-ENTEGRASYON.md`.

## Modlar
- **Kapalı:** sipariş alınmaz.
- **Deneme:** Yönetim › Paket platformları › "Deneme siparişi gönder" platformdan gelmiş gibi sipariş üretir
  (`server/delivery/simulator.ts`). Tarayıcı demosunda Yemeksepeti, Getir ve Trendyol Go deneme modunda açılır.
- **Canlı (sonraki iş):** gerçek bağdaştırıcılar `server/delivery/` altında, `PlatformOrderPayload`'a çevirir.
  Önce Trendyol Go (yoklama; kasadan doğrudan), sonra Getir; Yemeksepeti ve Getir siparişi push ile gönderir, kasa
  kafe ağında olduğu için LafPOS Uzaktan (Vercel) aktarıcı olur. Anahtarlar `.env`'de; arayüzde ve depoda yazılmaz.

## Uçlar
`GET /api/platforms` · `PUT /api/platforms/:platform` · `POST /api/platforms/:platform/test-order` ·
`POST /api/platforms/orders/:id/accept|reject|platform-cancel` · teslim: `POST /api/orders/:id/delivery`.
