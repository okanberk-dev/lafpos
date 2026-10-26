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
| Patron | Telefon (dışarıdayken) ve bilgisayar (yönetimde) | Canlı ciro, dikkat isteyenler; menü, personel, ayar | Patron paneli telefonda tek sütun; yönetim Innex düzeninde |

## Kısıtlar

- Para kuruş tam sayı; fiyatlar KDV dahil; personel maliyet ve kâr görmez (KVKK, `rapor.maliyet`).
- Arayüz Türkçe ve doğal; başlıklarda sonda nokta yok; büyük harf dönüşümü Türkçe kurala göre (`lang="tr"`).
- Çevrimdışı çalışır: yazılar pakette (`@fontsource`), dış kaynaktan yazı ya da betik yüklenmez.
