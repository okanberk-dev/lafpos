# Entegrasyon sözleşmesi: LafPOS ↔ laffogato ↔ lafmaliyet

Bu belge LafPOS'un diğer iki sistemle hangi uçtan, hangi alanlarla, ne sıklıkla konuştuğunu tanımlar.
Bir alan burada yoksa sistemler arasında gitmez (KVKK beyaz liste kuralı).

## 1. Sahiplik

| Veri | Sahibi | LafPOS'ta |
| --- | --- | --- |
| Satış fiyatı (M, L), Satışta/Tükendi, KDV oranı, ürün adı, kategori, görsel, alerjen | laffogato | salt okunur kopya; Tükendi değişikliği önce siteye yazılır |
| Seçenekler (süt, kavrum, şurup, ekstra shot, şeker) ve fiyatları | laffogato (kod sabiti) | menüyle birlikte gelir |
| POS'a özel alanlar: istasyon, kısa ad, düğme rengi, POS sırası, gizli, porsiyon sayacı, `posName` | LafPOS | senkron dokunmaz |
| POS'a özel ürünler (karaoke saati, kampanya) | LafPOS | `extSource` boş |
| Reçete, hammadde, maliyet, stok, tedarikçi, cari, kasa raporu | lafmaliyet | LafPOS kopyalamaz |
| Masa, adisyon, ödeme, gün sonu, personel PIN'leri | LafPOS | |
| Online sipariş (uygulama, web, masa QR) | laffogato | bar ekranında gösterilir, aşaması geri yazılır, tahsil edilmez |

## 2. laffogato → LafPOS: menü

### 2.1 Herkese açık menü (her zaman açık)

`GET https://laffogato.net/api/mobile/v1/menu` · `If-None-Match: <son ETag>` · anahtar gerekmez.

- CDN'den gelir (`s-maxage=300`), sitenin veritabanını uyandırmaz.
- 304 gelirse değişiklik yok. 200 gelirse fark hesaplanır.
- **Sıklık:** en çok 5 dakikada bir otomatik (ayarla kapatılabilir) + "Siteyle eşitle" düğmesi.
- Yalnız satıştaki kalemleri içerir; listede olmayan bağlı ürün "sitede satışta değil" sayılır ve
  POS'ta Tükendi olur (silinmez, geçmiş satışlar bozulmasın).

### 2.2 Eşleme

| Site alanı | LafPOS alanı | Kural |
| --- | --- | --- |
| `categories[].key` | `categories.extKey` | 12 sabit kategori; `title` → ad |
| `items[].id` (`mnu-0011`) | `products.extId`, `extSource = 'laffogato'` | tekil |
| `name` | `name` | |
| `description` | `description` | |
| `priceMinor` | `price` | M ya da tek boy, kuruş, KDV dahil |
| `priceLargeMinor` (null = tek boy) | `priceL` | |
| `taxRatePct` | `kdvRate` | satış anında kaleme dondurulur |
| `image` | `image` | sürümlü mutlak adres |
| `allergens`, `tags` | `allergens`, `tags` | |
| `customization.milks/roasts/syrups/extraShotMinor/sugarMax` | `option_groups` + `option_items` (`extKey`: `milk`, `roast`, `syrup`, `extraShot`, `sugar`; kalem `code`: site kimliği) | `dessert`, `snack`, `extras` kategorilerindeki ürünlere bağlanmaz (sitenin `NON_CUSTOMIZABLE_CATEGORIES` kuralı) |

Senkron önce **önizleme** üretir: yeni ürün, fiyatı değişen, adı değişen, KDV'si değişen, siteden kalkan.
Uygulama tek veritabanı işleminde yapılır, `audit_log`'a "menü senkronu" olarak yazılır.

### 2.3 İmzalı panel uçları (anahtar verilirse)

`.env`: `LAFFOGATO_SYNC_SECRET`. Değeri sitenin **`LAFPOS_SYNC_SECRET`** ortam değişkeniyle aynıdır (en az 32
karakter). Site bu anahtarı panel uçlarında `KARAOKE_SYNC_SECRET`'a ek olarak kabul eder (laffogato
`claude/lafpos-baglantisi` PR'ı); böylece panelin anahtarı kafedeki makinede durmaz ve iki anahtar ayrı
döndürülebilir. Site değişikliği yayına girene kadar geçici olarak `KARAOKE_SYNC_SECRET` değeri de çalışır.

İmza sitenin `src/lib/panel/karaoke-sync-core.ts` kuralının aynısı:

```
kanonik = ts + "\n" + METHOD + "\n" + path + "\n" + sıralı-ve-kodlanmış-sorgu + "\n" + sha256hex(gövde)
x-laf-timestamp: <unix saniye>
x-laf-signature: v1=<hmac_sha256_hex(anahtar, kanonik)>
```

Uyum, iki projenin sabitlediği vektörlerle `tests/signature.test.ts`'te doğrulanır.

| Uç | LafPOS kullanımı | Sıklık |
| --- | --- | --- |
| `GET /api/panel/menu` | Tükendi kalemleri de görmek (`isActive`) | menü senkronunda, en çok 5 dk'da bir |
| `POST /api/panel/menu {id, isActive, actor}` | POS'ta Tükendi / Satışa aç → önce site, 2xx gelince yerel | kullanıcı işlemi |
| `GET /api/panel/orders` | online siparişler (masa, gel-al, kurye): bar ekranı ve masa planı | 5 dk'da bir + ekran açılınca + elle |
| `POST /api/panel/orders/stage {id, action, from, actor}` | Hazırlanıyor / Hazır / Teslim edildi | kullanıcı işlemi |

`actor` LafPOS kullanıcısının adıdır. LafPOS anahtarıyla gelen yazımlar site olay kaydına `lafpos:<ad>` diye düşer.

**Sipariş sürüm sinyali:** `GET /api/pos/orders/version` (imzalı, `LAFPOS_SYNC_SECRET`) → `{ "version": "<metin>" }`.
Sitenin veri önbelleğinden (`live:orders` etiketi) gelir, veritabanına dokunmaz; sipariş yazımı etiketi
düşürünce değer değişir. LafPOS bunu 20 saniyede bir sorar, değer değişince `GET /api/panel/orders`'ı çeker.
Böylece online sipariş Neon kotasını harcamadan yarım dakika içinde bar ekranına düşer. Sürüm ancak çekme
başarılı olunca kaydedilir: başarısız çekme her 20 saniyede değil, 5 dakika dolunca yeniden denenir; sinyal
okunamazsa (5xx, bozuk gövde) 5 dakikalık çekmeye düşülür.

`GET /api/panel/orders` yanıtında `orders` dizisi yoksa (bakım sayfası, ağ geçidi, beklenmeyen gövde) çekme
başarısız sayılır, hiçbir sipariş kapatılmaz. Listede olmayan açık sipariş yalnız liste tamken bitmiş sayılır:
`complete: false` (sitenin sınırını aşan kesik liste) ya da okunamayan kalem varsa kapatılmaz. Yerelde kapanmış
ama sitede hâlâ açık görünen sipariş yeniden açılır.

Online siparişler LafPOS'ta `orders.source = 'laffogato'`, `extPaid = true` olarak tutulur:
tahsilat düğmesi kapalıdır, gün sonu cirosuna ve lafmaliyet satış listesine girmez (çift sayım).
`fulfillment = 'table'` olan sipariş, `tables.siteTableCode` ya da `label` içindeki masa adı eşlemesiyle
("S2", "Masa S2"; büyük/küçük harf farkı yok, birden çok masaya uyan ad eşlenmez) masa planında ilgili masada
rozet olarak görünür.

## 3. LafPOS → lafmaliyet: bugün (kod değişmeden)

### 3.1 Ürün satış listesi (Satışlar ekranına yükleme)

`GET /api/integrations/lafmaliyet/satislar.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` (yetki: `rapor.gor`)

```
Ürün;Adet;Tutar
LATTE MEDIUM;42;8.190,00
LATTE LARGE;17;3.570,00
KARAOKE ODASI;3;3.000,00
```

- lafmaliyet'in ayrıştırıcısı (`src/lib/calc/pos-paste.ts`) başlıktaki "Ürün / Adet / Tutar"ı tanır,
  noktalı virgülü ve Türkçe ondalığı okur. Tutar KDV dahil.
- **POS adı:** ürünün `posName` alanı doluysa o; yoksa `BÜYÜK HARF ad + boy eki` (M → `MEDIUM`,
  L → `LARGE`, tek boy ek yok). Ekler ayarlardan değişir. lafmaliyet I/İ ve büyük/küçük harf farkını yok
  saydığı için ModPOS'tan öğrenilmiş `pos_mappings` kayıtları çalışmaya devam eder; tutmayan ad bir kez
  eşlenir.
- İkram ve iptal satırları listeye girmez (ciro değil); online ödenmiş siparişler girmez.
- Karaoke gibi `isService` ürünler aynı listede çıkar; lafmaliyet bunları HİZMET olarak eşler.

### 3.2 Z özeti (Kasa raporu formuna)

Gün sonu ekranında, lafmaliyet Kasa raporu alanları **aynı sırada** gösterilir, "Kopyala" ile metin olarak
alınır, `GET /api/cash/days/:id/lafmaliyet.json` ile JSON indirilir.

| lafmaliyet alanı | LafPOS kaynağı |
| --- | --- |
| `z_no` | `business_days.zNo` |
| `receipts` | kapanan adisyon sayısı (online hariç) |
| `z_total` | ödemelerin toplamı (cari tahsilat ve bahşiş hariç) |
| `cash` | `zField = cash` ödeme türleri |
| `card` | `zField = card` |
| `meal_card` | `zField = meal_card` (Pluxee, Multinet, Edenred, Setcard, Metropol) |
| `online` | `zField = online` (yemek platformları) |
| `other` | `zField = other` (havale, açık hesap/cari dahil) |
| `off_revenue` | ikram edilen kalemlerin menü değeri |
| `discounts` | kalem + adisyon indirimleri |
| `opening_cash` | gün açılış nakiti |
| `cash_out` | harcama türü kasa hareketleri |
| `counted_cash` | gün sonu sayımı |
| `handed_over` | teslim türü kasa hareketleri |
| `cash_in` | nakit satış dışında çekmeceye giren nakit: giriş türü kasa hareketleri, nakit cari tahsilatı, nakit bahşiş |
| `expected_cash` | beklenen nakit: açılış + nakit satış + `cash_in` − harcama − teslim |
| `cash_diff` | sayılan − beklenen nakit |

İş günü tarihi lafmaliyet ile aynı kuralla belirlenir: gün 05:00'ten önce açıldıysa önceki takvim günü.
**Bir iş gününe tek Z:** gün sonu alındıktan sonra aynı tarihte yeni gün açılmaz; kapanıştan sonra satış
gerekirse kasa ekranındaki "Günü yeniden aç" (yetkili onayı, neden zorunlu, denetim kaydına alarm) aynı Z
numarasıyla günü açar. Gün yeniden kapanınca lafmaliyet'e aynı tarih ve Z ile gider, öncekinin yerine geçer.

## 4. LafPOS → lafmaliyet: önerilen imzalı uç (lafmaliyet PR'ı gerekir)

Kafedeki sunucu internetten erişilebilir olmadığı için "ping + çekme" yerine **imzalı itme** önerilir.
LafPOS gün sonunda ve sonradan düzeltmede aynı iş gününü yeniden gönderir (aynı `date` üzerine yazar,
idempotent). İstek giden kutusunda (`outbox`) bekler; internet yoksa sonra gider.

```
POST {LAFMALIYET_URL}/api/pos/gun
x-laf-timestamp, x-laf-signature (aynı kural; anahtar: lafmaliyet'te LAFPOS_SYNC_SECRET, LafPOS'ta LAFMALIYET_SYNC_SECRET)
{
  "version": 1,
  "source": "lafpos",
  "date": "2026-10-26",
  "z": {
    "zNo": 128, "receipts": 214, "zTotal": 45210.5,
    "cash": 12000, "card": 29110.5, "mealCard": 3100, "online": 0, "other": 1000,
    "offRevenue": 640, "discounts": 380,
    "openingCash": 1500, "cashOut": 450, "countedCash": 12980, "handedOver": 0, "cashDiff": -70,
    "cashIn": 0, "expectedCash": 13050
  },
  "lines": [
    { "posName": "LATTE MEDIUM", "siteMenuId": "mnu-0003", "slot": "M", "qty": 42, "revenue": 8190, "isService": false }
  ],
  "ikram": [
    { "posName": "TIRAMISU", "siteMenuId": "mnu-0090", "slot": "M", "qty": 1, "menuValue": 260, "reason": "Doğum günü" }
  ],
  "payments": [
    { "name": "Pluxee", "zField": "meal_card", "channel": "pluxee", "count": 7, "amount": 1850 }
  ]
}
```

- Gövde en çok 256 KB, katı JSON. `date` ve `zNo` aynı olan ikinci istek öncekinin yerine geçer (idempotent,
  yeniden açılıp kapanan gün). Aynı `date` başka bir `zNo` ile gelirse lafmaliyet hiçbir şey yazmaz, 409
  `{ error: "z_conflict", date, zNo }` döner (`zNo` kayıtlı olanınki); LafPOS bir tarihe tek Z verdiği için bu
  yalnız elle karışıklıkta olur.
- `cashIn` ve `expectedCash` isteğe bağlıdır (eski gövdede yok): lafmaliyet beklenen nakdi bunlarla
  LafPOS'unkine eşitler; `cashIn` yoksa 0 sayar.
- `payments` yemek kartı ve platform kanallarını lafmaliyet'in komisyon anahtarlarıyla verir (`pluxee`,
  `multinet`, `edenred`, `setcard`, `metropol`, `yemeksepeti`…); Komisyon ekranı aylık kanal satışını buradan
  doldurabilir.

- Tutarlar TL (lafmaliyet'in para biçimi), iki ondalık. `lines` lafmaliyet'in planladığı
  `DailyProductSale` biçimiyle birebir (`date` gövdede, `productId` lafmaliyet'in `site_menu_id + slot`
  eşlemesinden bulunur, bulunamazsa `posMatchKey(posName)` ile `pos_mappings`).
- Kişisel veri yok: müşteri, personel adı, telefon gitmez.
- lafmaliyet tarafı: `pos_daily_sales` tablosu, `loadDailyProductSales` yükleyicisi (bugün `null`),
  Kasa raporunda `CashPrefill { source: "lafpos" }` ile ön doldurma, `ikram` → `waste_entries`
  (`kind = 'ikram'`) önerisi. Yanıt: 200 `{ ok: true, date, lines }`, 400 `{ error: "invalid", field }`, 401,
  409 `{ error: "z_conflict" }`, 413, 503. 400, 409 ve 413 kalıcıdır: LafPOS tekrar denemez, kaydı giden
  kutusunda hata olarak gösterir (Yönetim › Genel bakış ve Entegrasyon); düzeltilince Kasa › Geçmiş günler'de
  günün Z raporundaki "Gönder" ile yeniden gider.
- Aynı gün içinde `posName` tekildir (LafPOS satırları zaten ada göre toplar). lafmaliyet karşılığı:
  [RiosenBeq/lafmaliyet#34](https://github.com/RiosenBeq/lafmaliyet/pull/34).

LafPOS istemcisi hazırdır; `LAFMALIYET_URL` ve `LAFMALIYET_SYNC_SECRET` verilince giden kutusu çalışır.

### 4.1 Ürün maliyetleri (lafmaliyet → LafPOS)

```
GET {LAFMALIYET_URL}/api/panel/pos/urunler     (imzalı, aynı anahtar)
{ "version": 1, "now": "…", "items": [
  { "siteMenuId": "mnu-0003", "slot": "M", "name": "Latte", "size": "M", "costMinor": 4210, "active": true }
] }
```

`costMinor`: reçeteden birim maliyet, kuruş, KDV hariç. LafPOS bunu yalnız `rapor.maliyet` yetkisi olanlara
gösterir (patron panelinde ürün kârlılığı). Başka alan gitmez.

## 5. Sıklık ve bütçe

| İş | Sıklık | Neon'a etkisi |
| --- | --- | --- |
| Herkese açık menü | 5 dk (ETag) | yok (CDN) |
| İmzalı menü okuma | senkronda, ≥5 dk | küçük okuma |
| Online sipariş okuma | 5 dk + ekran açılınca + elle | küçük okuma |
| Tükendi / aşama yazma | kullanıcı işlemi | tek yazım |
| lafmaliyet günlük itme | gün sonunda bir kez (+ düzeltme) | tek yazım |

## 6. Diğer repolardaki işler

| Repo | Dal | İş |
| --- | --- | --- |
| laffogato | `claude/lafpos-baglantisi` | `LAFPOS_SYNC_SECRET` panel uçlarında ek anahtar; `GET /api/pos/orders/version` |
| lafmaliyet | `claude/lafpos-baglantisi` | `POST /api/pos/gun`, `GET /api/panel/pos/urunler`, `pos_daily_sales` ve `loadDailyProductSales`, Kasa raporunda "LafPOS'tan doldur" |
| laffogato (sonra) | | Kasada damga (M2M) ucu |

## 7. Yazarkasa POS (ÖKC) bağlantısı

Mali fiş ÖKC'den kesilir; LafPOS adisyonu cihaza "sepet" olarak gönderir, ödeme ve fiş cihazda olur, sonuç
(Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir. Ayrıntı:
`docs/04-YAZARKASA.md`.
