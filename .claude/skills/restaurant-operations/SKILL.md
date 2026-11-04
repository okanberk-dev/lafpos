---
name: restaurant-operations
description: Kafenin işletme işleri için yardımcı - menü açıklaması ve sezon ürünü adı, ürün maliyet yüzdesi ve kâr kaçağı analizi, haftalık malzeme tahmini, Google yorumlarına kişisel yanıt, iş ilanı ve barista ya da garson eğitim belgesi. L'Affogato'nun menü metni, maliyet yüzdesi, sipariş tahmini, yorum yanıtı, ilan ya da LafPOS akışlarını anlatan eğitim belgesi istendiğinde kullan; muhasebe, bordro, sağlık mevzuatı ve sözleşme için kullanma.
---

> **Kaynak:** operatörün 4 Kasım 2026'da yapıştırdığı "Restaurant Operations" metni (menü mühendisliği, maliyet analizi,
> stok tahmini, yorum yanıtı, ilan ve eğitim belgesi; yayımlandığı yer ve lisansı belirtilmedi). Metin olduğu gibi
> kopyalanmadı: L'Affogato'ya ve LafPOS verisine uyan kısımları alındı, Türkçeye uyarlandı. Alınmayanlar en altta.

## Bu projede (LafPOS): bu bölüm aşağıdakilerin hepsinden önce gelir

L'Affogato bir kahve barı (espresso bazlı içecekler, demleme, Türk kahvesi, çay, soğuk içecekler, tatlı ve atıştırmalık,
karaoke odası). Bu skill kod yazmaz; işletmenin metin ve hesap işlerini LafPOS'un verisiyle yapar. Kurallar:

- **Veri nereden:** satış adetleri ve ciro LafPOS raporlarından (Raporlar › Ürünler, Saatlik, Personel; CSV), gün sonu
  ve ürün listesi lafmaliyet'ten; reçete maliyeti lafmaliyet'te. Rakam rapordan okunur, tahminle doldurulmaz; rapor
  rakamı yorumlanmadan önce `validate-data`'nın tanımları (ciro KDV dahil, online sipariş ciroya girmez, iş günü 05:00).
- **Kişisel veri yok:** müşteri adı, telefonu, personelin tutarları metne ve dışarıya gitmez; maliyet ve kâr yalnız
  `rapor.maliyet` yetkisi olan kişiyle (patron, müdür) konuşulur (KVKK, `AGENTS.md` kural 3).
- **Menünün sahibi site:** ürün adı, açıklaması ve fiyatı laffogato'da düzenlenir; LafPOS'ta yalnız kısa ad, istasyon
  ve porsiyon sayacı. Menü metni önerisi site paneline girilecek metin olarak verilir.
- **Dil:** doğal Türkçe, sıcak ve yalın; başlıkta sonda nokta yok; abartı ve boş kalıp yok.

## Menü metni ve sezon ürünü

İstenen: ürün adı, ana malzemeler, hazırlanışı, fiyatı ve dükkânın sesi (sıcak, sade, mahalle kahvecisi). Açıklama
somut, duyusal ve doğru olur; her kafeye uyan genel cümle yazılmaz ("özel kahve" değil "çifte shot espresso, ince
mikro köpüklü yulaf sütü, üstünde bal ve tarçın"). Açıklama fiyatı hak ettirir ama ürünü olduğundan farklı göstermez.
Sezon ürününde kahraman malzeme, mevsim ve menünün fiyat basamağı alınır; ad, açıklama ve mevcut menünün fiyat
merdivenine oturan bir fiyat önerilir (benzer boydaki içeceklerin fiyatı LafPOS'un ürün listesinden okunur). Boy ve
seçenek önerisi menünün kuralına uyar: şişe içecek, paketli ürün ve dilim tatlıda boy ya da seçenek önerilmez.

## Maliyet yüzdesi ve kâr kaçağı

Her ürün için üç sayı: satış fiyatı (KDV dahil; hesapta KDV hariç fiyat kullanılır, oran kalemin oranı), bir porsiyonun
bütün malzeme maliyeti (süt, şurup, bardak, kapak, peçete dahil; lafmaliyet reçetesi) ve paket ürünlerde ambalaj.
Maliyet yüzdesi = maliyet ÷ KDV hariç fiyat. Kafe için başlangıç hedefleri (operatör kendi eşiğini verebilir):

| Grup | Hedef |
|---|---|
| Espresso bazlı ve demleme kahve, çay | %15-22 |
| Soğuk içecek, frappe, smoothie | %18-25 |
| Tatlı ve pasta | %20-28 |
| Yiyecek (tost, sandviç) | %25-32 |
| Şişe ve paketli ürün | %35-50 (satın alınıp satılır) |

Eşiği aşan her ürün için tek ve en uygun öneri verilir, hepsi birden değil: fiyatı artır, porsiyonu az küçült, bir
malzemeyi değiştir ya da ürünü kaldır. Seçim ürünün menüdeki rolüne göre: çok satan imza içecekte malzeme değiştirmek
marka riskidir, fiyat ya da porsiyon önce gelir; az satan ve yüksek maliyetli ürün kaldırmaya adaydır. Satış adedi
(aylık) LafPOS ürün raporundan; ikram, ödenmez ve zayi ayrı okunur (Raporlar › İptal ve indirim), maliyet kaçağının bir
kısmı oradadır. Son iki haftanın tedarikçi faturaları verilirse fiyatı artan malzemeler ve eşiği bu yüzden aşan ürünler
listelenir.

## Haftalık malzeme tahmini

Girdi: son dört haftanın günlük adisyon sayısı ve ürün adetleri (LafPOS Raporlar, CSV), bu haftanın rezervasyonları
(karaoke sitede, masa rezervasyonu LafPOS'ta), resmî tatil, okul dönemi, maç ve yerel etkinlikler. Tahmin genel
oranlarla değil kafenin kendi adisyon başına kullanımıyla yapılır (ör. 100 adisyonda kaç litre süt, kaç dilim tatlı).
Geçmişte fazla sipariş edilen ve bozulan ürünler (süt, taze meyve, kremalı tatlı) işaretlenir ve biraz eksik sipariş
önerilir; zayi kayıtları (Raporlar › İptal ve indirim, zayi) buna kanıttır. Etkinlik için kişi sayısı ve menüden malzeme
çekme listesi çıkarılır.

## Google yorumlarına yanıt

Yorumlar olumlu ve olumsuz birlikte verilir; dükkânın adı ve sesi söylenir. Olumsuzda: belirli sorunu kabul et, bahane
ve suçlama yok, tek somut çözüm ("bize doğrudan yazın, düzeltmek istiyoruz"); kaba yorumda da sakin ve saygılı ton.
Olumluda: yorumcunun övdüğü şeyi (affogato, bir baristanın ilgisi, doğum günü) kendine özgü cümleyle yansıt; aynı
açılış iki kez kullanılmaz. Yanıtta müşterinin adı dışında kişisel bilgi, personelin soyadı, iç süreç ya da tutar
yazılmaz. Taslaktır: operatör düzenleyip kendisi yayımlar.

## İş ilanı

Girdi: rol (barista, garson, kasiyer, bar yardımcısı), günlük işler, çalışma düzeni, dükkânın iyi yanı (ekip, öğrenme,
yemek), ücret aralığı. İlan işi açık ve dürüst anlatır: bir günün nasıl geçtiği, yoğun saatler, LafPOS'ta neler yapılacağı
(adisyon, bara gönderme, ödeme, vardiya devri). "Takım oyuncusu", "misafirperverlik tutkunu" gibi içi boş kalıplar
yazılmaz.

## Eğitim belgesi

Girdi: rol, öğretilecek iş ya da süreç ve dükkânın kendi standardı. Çıktı yeni başlayan biri için adım adım belge;
LafPOS ekranlarını gerçek adlarıyla anlatır ve bugünkü akışı izler (ekranlar değiştiyse önce kodu ya da `DESIGN.md`'yi
oku): kilit ekranında PIN'le oturum açma; masayı açma, ürün ekleme, seçenek ve not, **Bara gönder**; hazır kalemi
teslim etme; **Öde** (nakit, kart, yemek kartı, açık hesap), hesabı bölme, ikram, ödenmez ve
zayi; vardiya devri sayımı (devreden sayar, devralan PIN'iyle onaylar); gün sonu
(Z) ve sayım. Yetki gerektiren adımda "yetkili onayı" anlatılır, kasiyerin göremediği rakam (kör kasa) yazılmaz.
Barista için reçete ve sunum standardı operatörden alınır, uydurulmaz.

## Alınmayanlar

- Muhasebe ve bordro: muhasebeci ve bordro programı; lafmaliyet maliyet ve kasa tarafını tutar.
- Sağlık ve gıda mevzuatı belgeleri: yerel otorite ve danışman.
- Kira, tedarikçi sözleşmesi: avukat.
- Dolar ve yabancı örnekler: tutarlar TL, kuruş tam sayı; örnekler L'Affogato menüsünden.
