# LafPOS: ürün bağlamı

> impeccable skill'inin okuduğu ürün bağlamı (kim, nerede, hangi ışıkta, ne için). Görünüm kuralları
> `DESIGN.md`'de, mimari `docs/02-PLAN.md`'de.

## Ne

L'Affogato'nun kendi kasa ve adisyon sistemi: masa, tezgâh, gel-al, paket ve sitedeki online siparişler;
bar ekranı, kasa ve gün sonu (Z), yazarkasa (TokenX Connect), raporlar, patron paneli ve yönetim.
Kafedeki bir bilgisayarda yerel çalışır (internet giderse satış sürer), siteyle (laffogato) menü ve online
sipariş, lafmaliyet'le gün sonu ve maliyet alışverişi yapar.

## Kim, nerede, ne yapıyor

| Kişi | Cihaz ve sahne | İşi | Tasarıma etkisi |
|---|---|---|---|
| Garson | Telefon, tek el, ayakta, bahçede gün ışığında ya da akşam loş salonda | Masaya dokun, ürünleri seç, gönder; hazır olanı al | Başparmak bölgesinde birincil eylem, 44 px hedef, alt sekme çubuğu, yüksek kontrast |
| Kasiyer ve barista | Tezgâhta tablet (dikey ya da yatay) ya da dokunmatik ekran | Tezgâh satışı, ödeme, yazarkasaya gönderme, gün sonu | Tablette ürünler ve adisyon yan yana; büyük ödeme düğmeleri |
| Bar ekranı | Barın üstünde tablet, uzaktan okunur | Fişleri hazırla, bitti işaretle | Koyu zemin, büyük yazı, renkli durum |
| Müdür | Bilgisayar ya da tablet, vardiya arasında | İndirim/iptal onayı, kasa, rapor | Yetkili PIN onayı, net tutarlar |
| Patron | Telefon (dışarıdayken) ve bilgisayar (yönetimde) | Canlı ciro, dikkat isteyenler; menü, personel, ayar | Patron paneli telefonda tek sütun; yönetim Innex düzeninde, LafPOS Sade görünümünde |
| Herkes | Kasadaki giriş ekranı ya da kendi telefonu | PIN'le oturum açma; kasiyer çıkarken vardiya devri sayımı (mesai takibi yok, 4 Kasım 2026'da kaldırıldı) | Kilit ekranında yalnız "Oturum aç"; vardiya devri Kasa ekranında |

## Servis modu

Patron Yönetim › Ayarlar ve yedek › Servis modu'ndan seçer; seçince hemen uygulanır (`shared/service-mode.ts`).
Ödeme kuralları ve bara gidiş her modda aynıdır; değişen açılış ekranı, menü ve tezgâh satışının akışıdır.

| Mod | Akış | Sistemde |
|---|---|---|
| Masaya servis (varsayılan) | Garson masayı açar, sipariş masada, hesap sonda | Bugünkü akış: açılış Masalar |
| Yarı self servis | Sipariş ve ödeme kasada, personel masaya götürür | Açılış yeni satış (`/satis`), menüde "Satış" başta; "Öde" önce masa no / numaratör sorar (isteğe bağlı); bar ekranı, çağrı ekranı ve fiş numara yerine "Masa 12" yazar; Masalar doluluk için ikinci planda |
| Self servis | Sipariş ve ödeme kasada, müşteri numarası çağrılınca alır | Açılış yeni satış; ödeme sonucu, bar fişi ve adisyon numarayı büyük yazar; Masalar yalnız masada açık adisyon varsa menüde |
| QR + self servis | Kasada self servis; masadaki QR'ı okutan müşteri uygulamadan masaya sipariş verir | Self gibi açılış yeni satış ve numara; Masalar menüde kalır (QR siparişi masaya düşer, doluluk görünür); Yönetim › Masa planı'nda masa başına QR (`https://laffogato.net/masa/<kod>`, kodu LafPOS üretir) ve A4 masa kartları |

## Kısıtlar

- Para kuruş tam sayı; fiyatlar KDV dahil; personel maliyet ve kâr görmez (KVKK, `rapor.maliyet`).
- Arayüz Türkçe ve doğal; başlıklarda sonda nokta yok; büyük harf dönüşümü Türkçe kurala göre (`lang="tr"`).
- Çevrimdışı çalışır: yazılar pakette (`@fontsource`: Poppins, başlık ve rakamlarda Gabarito), dış kaynaktan yazı ya da betik yüklenmez.
