# Karar: tek sistem, iki yüz (26 Ekim 2026)

**Soru (operatör):** Ürün yüklemek ve kasa için iki ayrı sistem mi olmalı, tek sistem mi? NarPOS, robotPOS ve yurt
dışındaki muadillerine bakıp hangisi daha iyiyse onu yap.

## Bakılanlar

| Sistem | Ne gördük | Kaynak |
|---|---|---|
| ModPOS Integra | Tek hesap ve tek veri üstünde ayrı yüzler: web paneli (ürünler, varyantlar, stok, faturalar, masa, cihazlar, çalışanlar ve pozisyonlar, raporlar, entegrasyonlar), patron uygulaması ve kasa/POS cihaz uygulaması. Ürün panelde yüklenir, cihaza kendiliğinden iner | Panel ve patron uygulaması bizzat incelendi (`docs/01-ANALIZ.md` §1) |
| NarPOS | Adisyon, ödeme, muhasebe, garson el terminali, mutfak ekranı, kiosk ve yazarkasa entegrasyonu tek pakette; "parçalı yapıyı birleştirdik" | [Para dergisi](https://www.paradergi.com.tr/girisimcilik/2026/02/03/restoran-ekonomisinde-140-milyon-tllik-tasarruf-sagladi), [KobiTime](https://kobitime.com/narpos/) (firma anlatımı) |
| robotPOS | Bulut arka ofis ve POS; kaynakla doğrulanamadı | Arama sonuç vermedi |
| Lightspeed Restaurant | Arka ofiste menü, rapor, çok şube; POS internet giderken de çalışır | [Lightspeed](https://www.lightspeedhq.com/referrals/explore-lightspeed-restaurant) (firma anlatımı) |
| Toast, Square | Web arka ofis (Toast Web, Square Dashboard) ve kasa uygulaması aynı hesapta | Genel bilgi; resmi belgeyle ayrıca doğrulanmadı |

Hepsinde ortak olan **tek veri, iki yüz**: ürün, fiyat ve rapor için web arka ofis; tezgâhta kasa ekranı.
Verisi ayrı iki sistem (ürünü bir yerde yükleyip kasaya elle aktarmak) hiçbirinde yok; çift giriş ve
"kasadaki fiyat başka, sitedeki başka" hatası doğurur.

## LafPOS'un kararı

1. **LafPOS tek sistemdir, iki yüzü vardır.** Aynı sunucu ve veritabanı:
   - **Kasa:** kasa bilgisayarında Chrome kiosk (`docs/05-KASA-BILGISAYARI.md`), tezgâh tableti, garson
     telefonu, bar ekranı. Masalar, adisyon, ödeme, yazarkasa, kasa ve gün sonu.
   - **Yönetim:** Innex paneli (`DESIGN.md`), herhangi bir tarayıcıdan: ürünler, roller ve personel, masa
     planı, ödeme türleri, yazarkasa, bağlantılar, raporlar, denetim kaydı.
   Hangi yüzü kimin gördüğünü **rol ve yetki** belirler (Yönetim › Roller ve yetkiler); kasiyer yönetimi
   görmez, adresle girse de sunucu reddeder.
2. **Ürünün tek ana kaydı laffogato'nun yönetim panelidir.** Site, uygulama ve kasa aynı menüyü okur; ad,
   fiyat, boy, KDV, fotoğraf orada değişir. LafPOS menüyü kendisi çeker (5 dakikada bir, ETag ile),
   değişikliği uygulamadan önce gösterir. Kasaya özgü alanları (istasyon, kısa ad, porsiyon, seçenek grubu,
   sık kullanılan) LafPOS tutar. Yönetim › Ürünler'deki **"Sitede ürün ekle"** laffogato panelinin yeni
   ürün sayfasını açar.
3. **Yalnız kafede satılan hizmetler** (karaoke odası saatlik ücreti, etkinlik ücreti) LafPOS'ta
   "yerel ürün"dür; sitede satılmadıkları için laffogato'ya girmez.
4. **Maliyet, reçete, stok ve muhasebenin kaynağı lafmaliyet'tir.** LafPOS gün sonunu oraya gönderir,
   maliyeti oradan okur (`docs/03-ENTEGRASYON.md`); kopyalamaz.
5. **Neden bulut değil kafedeki bilgisayar:** internet giderken de satış sürmeli (ModPOS ve Lightspeed'in
   çevrimdışı çalışma gereği). Patronun dışarıdan erişimi tünel ya da VPN ile (`docs/05`).

## Sonuçları

- Ürün yüklemek için ayrı bir "LafPOS ürün paneli" yapılmadı; yerel ürün yalnız hizmetler için.
- laffogato'da şema değişikliği gerekmedi: imzalı `GET /api/panel/menu` menüdeki ve menü dışındaki her
  kalemi zaten veriyor; LafPOS bağlantısı için ayrı imza anahtarı ve sipariş sürüm sinyali laffogato#263'te.
- lafmaliyet'te LafPOS'un gün sonunu alan uç ve ürün maliyeti ucu lafmaliyet#34'te.
