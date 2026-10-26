# Yazarkasa POS (ÖKC) bağlantısı: TokenX Connect

Mali fiş ÖKC'den (yazarkasa POS) kesilir. LafPOS adisyonu cihaza **sepet** olarak gönderir; ödeme ve mali fiş
cihazda alınır; sonuç (Z no, fiş no, ödeme kalemleri) LafPOS'a döner ve adisyonun ödemesi olarak kaydedilir.
Kod: `server/okc/` (istemci `tokenx.ts`, sepet hesabı `basket.ts`, akış `service.ts`), uçlar
`server/routes/okc.ts`, ekranlar adisyondaki **Yazarkasa** bölümü, `/cihaz` (eğitim cihazı) ve
Yönetim › Yazarkasa POS. Testler: `tests/okc-basket.test.ts`, `tests/tokenx-client.test.ts`,
`tests/api-flow.test.ts`.

## 1. Sağlayıcılar

| Ayar (`okcProvider`) | Ne olur |
|---|---|
| `kapali` | Yazarkasa düğmeleri görünmez; ödeme LafPOS'ta alınır, mali fiş ayrıca kesilir |
| `simulator` (eğitim cihazı) | Sepet `/cihaz` ekranına düşer; orada nakit/kart/yemek kartı seçilip "ödendi" denir. **Gerçek fiş kesilmez**; kurulum ve personel eğitimi içindir. İlk kurulum bununla gelir |
| `tokenx` | TokenX Connect (Cloud) üzerinden gerçek cihaz |

Gerçek cihazla deneme yapılmaz: önce eğitim cihazı, sonra Token'ın test ortamı, en son canlı cihaz.

## 2. Token'dan istenecekler ve `.env`

| Değişken | Ne |
|---|---|
| `TOKENX_AUTH_URL` | Kimlik doğrulama adresi (LafPOS `POST {auth}/v1/auth/token`, Basic kimlikle erişim jetonu alır, süresi dolmadan yeniler) |
| `TOKENX_BASKET_URL` | Sepet servisinin adresi (`/v1/basket/...`) |
| `TOKENX_SETTINGS_URL` | Ayar servisi (kısımlar, terminaller); boşsa sepet adresi kullanılır |
| `TOKENX_CLIENT_ID`, `TOKENX_CLIENT_SECRET` | Uygulama kimliği |
| `TOKENX_TERMINAL_ID` | **Anlık** sepette hedef cihaz |
| `TOKENX_BRANCH_ID` | **Liste** sepette şube |
| `TOKENX_APP_RESOURCE` | `x-application-resource` başlığı (Token isterse) |
| `LAFPOS_PUBLIC_URL` | Webhook için LafPOS'un internetten erişilen adresi (yoksa yoklama) |
| `TOKENX_WEBHOOK_SECRET` | Webhook'un `Authorization: Bearer` anahtarı, en az 16 karakter |

Değerler yalnız kasa bilgisayarındaki `.env` dosyasında durur; depoya girmez.

## 3. Kurulum adımları

1. `.env`'yi doldurun, LafPOS'u yeniden başlatın.
2. Yönetim › Yazarkasa POS: sağlayıcı **TokenX**, mod **Anlık** ya da **Liste**.
3. **Bağlantıyı dene**: jeton alınır, terminal ve kısımlar okunur; hata Türkçe gösterilir (`STATUS_TEXT`).
4. **KDV → kısım eşlemesi**: cihazdaki kısımlar okunup oranına göre otomatik eşlenir (`autoSectionMap`);
   varsayılan `%1 → 3`, `%10 → 1`, `%20 → 2`. Cihazınızın kısım numaraları farklıysa buradan düzeltin.
5. **Sonuç bildirimi**: `LAFPOS_PUBLIC_URL` ve `TOKENX_WEBHOOK_SECRET` varsa "Webhook'u kaydet"
   (`POST /api/okc/webhook/register`); adres `…/api/public/okc/tokenx/webhook`. Yoksa LafPOS sonucu
   kendisi sorar (anlık sepette 2,5 sn, listede 10 sn).
6. Eğitim cihazıyla bir tur: tezgâh satışı → Yazarkasa → `/cihaz`'da öde → adisyon kendiliğinden kapanır.

## 4. Anlık ve liste sepet

| | Anlık (`okcMode: anlik`) | Liste (`okcMode: liste`) |
|---|---|---|
| Hedef | Tek cihaz (`TOKENX_TERMINAL_ID`) | Şubedeki her cihaz (`TOKENX_BRANCH_ID`) |
| Cihazda | Sepet ekrana kendiliğinden düşer | Kasiyer listeden seçer |
| Ne zaman | Tek kasa | Birden çok POS cihazı, masaya giden el terminali |

## 5. Sepet nasıl hesaplanır (`basket.ts`)

- Tutarlar kuruş; `taxPercent` oran × 100, `quantity` adet × 1000, kısım KDV oranından.
- İkram ve iptal edilen kalem gitmez; ödenmiş adet düşülür; istenirse yalnız seçili kalemler gönderilir
  (kalem bazlı ödeme).
- Adisyon indirimi ve servis payı satırlara en büyük kalan yöntemiyle dağıtılır; cihazın toplamı LafPOS'un
  toplamıyla kuruşu kuruşuna aynı olsun diye son satırda `totalValue` düzeltilir.
- Aynı adisyon için açık bir sepet varken ikincisi gönderilmez (409).

## 6. Sonuç

| Cihazdan gelen | LafPOS'ta |
|---|---|
| `sale.status = 0` | Ödeme kalemleri adisyona işlenir (1 nakit, 3 kart, 7 yemek kartı, 17 açık hesap, 18 havale; ödeme türü eşlemesi Yönetim › Yazarkasa'da), Z ve fiş no yazılır, kalan yoksa adisyon kapanır |
| `-1` | Kasiyer cihazda vazgeçti; sepet kapanır, adisyon açık kalır |
| `99` | Fiş iptal edildi; o fişin ödemeleri iade olarak düşülür, adisyon yeniden ödenebilir |
| `BASKET_LOCKED` / `UNLOCKED` | Sepet cihazda açıkken LafPOS'ta kilit gösterilir |

Her sonuç denetim kaydına yazılır; son hata Genel bakış › Sistem sağlığı'nda ve Yazarkasa sayfasında görünür.

## 7. Sık sorunlar

- **"TokenX bilgileri .env dosyasında eksik"**: `TOKENX_AUTH_URL`, `TOKENX_BASKET_URL`, `TOKENX_CLIENT_ID`,
  `TOKENX_CLIENT_SECRET` ve moda göre terminal ya da şube kimliği gerekli.
- **1106 terminal bulunamadı**: `TOKENX_TERMINAL_ID` yanlış ya da cihaz Token'da tanımlı değil.
- **Toplam farkı**: kısım eşlemesindeki KDV oranı cihazdakiyle aynı olmalı.
- **Sonuç gelmiyor**: webhook adresine dışarıdan erişilemiyorsa anahtarı kaldırın; LafPOS yoklamaya döner.
