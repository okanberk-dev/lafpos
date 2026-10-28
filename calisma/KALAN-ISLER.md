# LafPOS: kalan işler (28 Ekim 2026, gece)

Bu dosya kaldığın yerden devam etmek içindir. Her şey GitHub'da (`RiosenBeq/lafpos`). Ayrıntılı geçmiş:
`calisma/PLAN.md`. Kurallar: depodaki `AGENTS.md` (para kuruş, yetki sunucuda, denetim kaydı, `patchOf`, Türkçe metin,
`data/` ve `.env` asla commit'lenmez, dal `claude/<konu>`, PR başlığı Türkçe, main'e doğrudan push yok).

## Kullanıcı kararları (27 Ekim 2026)
- **Bahşiş yok.** Ödeme ekranında alan yok, sunucu `tip > 0`'ı 400 `tip_disabled` ile reddeder (Ayarlar
  `tipsEnabled` varsayılan kapalı). Eski kayıtlardaki bahşiş raporlarda okunur. Yeni işte bahşiş ekleme.
- **İşletme self servis (27 Ekim):** "masa, salon olmasın, menüler gözüksün; masalı olanı da yap ama bana self
  servis ekranı gözüksün" (#20'de yapıldı). Aynı gün ek istekler (aşağıda 0. madde): ödeme ekranına İkram, Ödenmez,
  Zayi; varyant eklemede seçenek; "QR + self servis" modu ve masaya özel QR'ı LafPOS'ta üretip kaydetme; ölü CSS.
- **Vercel değişkenleri (27 Ekim, kullanıcı onayıyla):** lafpos projesindeki kullanılmayan kafe değişkenleri silindi;
  `LAFPOS_CLOUD_SECRET` 48 karakterle yenilendi (`/api/uzaktan/kurulum` → `secret:true`); kafe satırı Mac'te
  `~/Downloads/lafpos-kasa-ayarlari.env` (600). laffogato ve lafmaliyet'te `LAFPOS_SYNC_SECRET` zaten var.
- **Satışı geliştir (27 Ekim, yeni istek):** "menüler laffogato ya da lafmaliyet'ten otomatik gelsin ama sistem
  gelişmiş olsun; self servis ve yarı selfe uygun; ikram, ödenmez, yemek kartı vs.; Yemeksepeti, Uber Eats alt
  yapısı ve bu tarz ne varsa". Aşağıda 1. madde.
- **Demo aşamasında giriş yok.** Web kasa demosu PIN sormadan açılacak. LafPOS Uzaktan, kafe bağlıyken de
  parolasız (yapıldı, PR #16). Gerçek kullanımdan önce Vercel'de `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` ve
  `LAFPOS_UZAKTAN_PAROLA` tanımlanmalı. Bunu v0.2.0 öncesi kullanıcıya hatırlat.

## 28 Ekim 2026: durum ve canlıya geçiş

Kullanıcının isteği (28 Ekim): "kalan işleri yap, main'e al; diğer repolarla bağlantılı mısın bak, henüz demo, ben
aktif ol deyince olabilecek misin; tüm bileşen tasarımlarını en ufak ayrıntısına kadar geliştir".

**Bugün main'e girenler:** #29 Getir Yemek canlı bağlantısı, #30 tasarım yenilemesi, gece #32 (seçenek ve senkron)
ve #31 (paket satışı) (aşağıdaki tabloda). laffogato'da #268 (LafPOS masa kodları: panel siparişinde `tableCode`,
imzalı `PUT /api/panel/tables`, yalnız LafPOS anahtarıyla) ve #271 (belge: LafPOS'un sipariş çekme sıklığı).
**v0.2.0 kurulum dosyası** derlendi (main af0410d): `LafPOS-Kurulum-0.2.0.exe`, 24,7 MB, SHA-256
`94006e9750e51243a3fbeeb69be6a8fcc08a1f74f3afb1c104bb91e3d2982254`; kullanıcıya gönderildi. GitHub Release'i kullanıcı
açar (bu oturumda release aracı yok); not metni oturumda verildi.
Önce/sonra ekranları: https://claude.ai/artifact/CzWAiSWwAP6uPk4fZxb4oX (özel sayfa; paylaşmak sahibin işi).

**Bağlantılar:**
- laffogato: bu oturuma bağlı, push var; #268 birleşti. Site tarafında LafPOS'un istediği iki uç artık var; LafPOS'un
  `sendTables` 200 alınca "site henüz almıyor" durumu kendiliğinden kalkar.
- lafmaliyet: GitHub'da bağlanabilir görünüyor (`check_repo_access` → attachable) ama bağlama isteği oturumun izin
  denetiminde reddedildi; kullanıcı izin verirse sözleşme karşılaştırması yapılır (4. madde).
- Bu bulut ortamının ağ politikası `laffogato.net` ve `lafpos.vercel.app`'i reddediyor (403): canlı uçlar ve Vercel
  dağıtımı buradan denetlenemiyor. Ortam ayarlarında Network access › Allowed domains'e iki alan adı eklenirse olur.
- GitHub Actions hâlâ çalışmıyor ("denetim" işi günlük üretmeden 1 sn'de düşüyor, faturalama). Kapılar yerelde.

**"Aktif ol" dendiğinde sırayla (anahtarları Claude yazmaz, değerleri ekrana basmaz):**
1. Vercel › lafpos: `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` ve `LAFPOS_UZAKTAN_PAROLA` (demo parolasız; gerçek kullanımdan
   önce şart). `LAFPOS_CLOUD_SECRET` dolu ve en az 32 karakter (`/api/uzaktan/kurulum` → `secret:true`).
2. Kasa bilgisayarının `.env`'i: `LAFFOGATO_URL=https://laffogato.net`, `LAFFOGATO_SYNC_SECRET` (sitedeki
   `LAFPOS_SYNC_SECRET` ile aynı değer), `LAFMALIYET_URL`, `LAFMALIYET_SYNC_SECRET`, `LAFPOS_CLOUD_URL`,
   `LAFPOS_CLOUD_SECRET`. Sitede `LAFPOS_SYNC_SECRET` tanımlı ve `KARAOKE_SYNC_SECRET`'ten farklı olmalı (eşitse
   kapalı sayılır, docs/LAFPOS.md "Varsayılan kapalı").
3. Ayarlar: kurulum modunu kapat, örnek PIN'leri değiştir; servis modu seç (self servis varsayılan).
4. Paket platformları (her biri önce test ortamında bir tur, sonra Yönetim › Paket platformları'nda "Canlı"):
   Trendyol Go (`TRENDYOL_*`), Yemeksepeti (`YEMEKSEPETI_*`, Vercel'de `YEMEKSEPETI_PLUGIN_SECRET`), Getir
   (`GETIR_APP_SECRET_KEY`, `GETIR_RESTAURANT_SECRET_KEY`, test için `GETIR_API_URL`; Vercel'de ayrı bir
   `GETIR_WEBHOOK_SECRET`, Getir'e `https://lafpos.vercel.app/api/getir/order` ve `/api/getir/cancel`).
5. Masa kartları: Yönetim › Masa planı › QR üret ve yazdır; kodlar siteye `PUT /api/panel/tables` ile gider.
6. v0.2.0 Windows kurulumu (5. madde) ve kafede gerçek cihazla bir tur (iPhone, Android, Windows dokunmatik).

## Bitenler
| PR | İçerik |
|---|---|
| #32 | **Seçenek ve senkron**: varyant eklerken seçenek (iki boylu üründe zorunlu seçimde pencere, zorunlu grupta önseçim yok, "Seçenekleri sor" ayarı; kullanıcı cevap vermedi, ModPOS anlamıyla yorumlandı), **seçenek tükendi** (göç `0013_secenek_tukendi`; kasa satışında açık seçim ya da zorunlu grubun varsayılanı 409, isteğe bağlı grubun tükenen varsayılanı satışı durdurmaz, site ve platform reddedilmez; sepet tahmini sunucuyla birebir), seçenek grubu ürün çekmecesinden ve gruptan ürünlere (tek işlem, denetim kaydı), **İlk Z numarası** (`zNoStart`), site liste `version` denetimi, `engines.node` ">=22.11 <25", docs/03 kaymaları. Dört çekişmeli tur (1 yüksek: sütsüz satış duruyordu). Kapılar: 1290 test, 164 ekran 0 sorun, 21/21, demo 7/7 |
| #31 | **Paket satışı**: isteğe bağlı otomatik kabul (varsayılan kapalı; katı koşullar, kasadaki karar denemesi ezilmez, seçeneği tükenmiş ürün elle), Raporlar › Paket platformları (tahmini komisyon yalnız `rapor.maliyet`; oran açılış verisinden ve denetim iletisinden çıktı), bar Hazır sekmesi + Teslim edildi + Geri al, kasa gel-al aşaması kalemlerden, çağrı ekranında platform kodu, müşteri ekranında numara. Üç tur + son doğrulama + #32 ile birleşim turu (1 kritik: başarısız ret otomatik kabul ediliyordu). Kapılar (birleşik): 1394 test, 179 ekran 0 sorun, 23/23, demo 7/7 |
| #30 | **Tasarım yenilemesi** ("aydınlık ve sade"): 8 mercekli denetim (adisyon, salon, telefon, yönetim, bileşenler, mekanik, koyu tema ve bar, durumlar ve kopya) ve bulgularının hepsi; ortak bileşenler (basılı durum, `Tabs`, `Stat`, üç boy `EmptyState`, `ErrorState`, `Skeleton`, `confirmDialog` / `promptDialog`, `NumberInput`, `SearchInput`, `cn()` sınıf birleştirme), fiziksel klavyeyle tutar, çift gönderim kilitleri, kaydedilmemiş değişiklik koruması, telefon ve koyu tema. İki çekişmeli tur: 33 + 19 bulgu (ikincisi "45.90" → 4.590 TL hatasını yakaladı). `DESIGN.md` §3. Kapılar: 1168 test, 148 ekran 0 sorun, 16/16, demo 47/0 ve 6/6 |
| #29 | **Getir Yemek canlı bağlantısı**: aktarıcı (LafPOS Uzaktan, `x-api-key`), yedek yoklama, verify / verify-scheduled / prepare / handover / deliver / cancel. İki çekişmeli tur: 26 + 15 bulgu (geçici hata kodları, ileri tarihli sipariş, `result:false`, indirim, kişisel verinin aktarıcıda süresi). Test saat bombası düzeltmesi (`tests/fake-site.ts`) |
| #28 | **Yemeksepeti canlı bağlantısı**: Delivery Hero siparişi LafPOS Uzaktan'a (Vercel, `api/uzaktan.ts`) JWT ile gelir, Redis gelen kutusuna girer; kasa imzalı çeker, kayıt yazılınca siler. Dolaylı akış (tablette kabul edilmiş, geri çağrı adresi yok) desteklenir; kabul saati platformun saatine uyar; ücretler ayrı satır (KDV %20, mutfağa gitmez); kuryenin bıraktığı nakit kasada; test siparişi kabul edilmez. İki çekişmeli tur: 11 doğrulanmış + 13 doğrulanmamış bulgu kapandı |
| #27 | **Trendyol Go canlı bağlantısı** (Uber Eats Türkiye dahil): yoklama, kabul / ret önce platforma (önce yerelde prova), aşamalar sırayla, kasada iptal platforma, ürün eşleme, göç `0012_platform_canli`. İki çekişmeli tur: 20 bulgu kapandı (Kapalı modda iptal yoklaması, karar kilidi, tek koşu tur, bekleyen iptali kayda alma…) |
| #26 | **QR + self servis** modu (`qr_self`) ve masaya özel QR'ı LafPOS üretir (`tables.qrCode`, göç `0010_masa_qr`, sitenin 10 simgelik Crockford biçimi, `https://laffogato.net/masa/<kod>`); A4 masa kartları; kodlar siteye `PUT /api/panel/tables` ile giden kutusundan (site ucu yoksa 6 saatte bir) |
| #24 | **Ödeme ekranında İkram / Ödenmez / Zayi** (`CompKind` `zayi`, `zayiReasons`, Z/X ve raporlarda ayrı satır, lafmaliyet `"Zayi: …"`); kalem düzeyinde "Zayi yaz" |
| #23 | Ölü CSS temizliği |
| #22, #25 | Başka oturumlar: lafmaliyet geçişi (göç `0009_lafmaliyet_yanit`), karaoke site bağlantısı (göç `0011_karaoke_rezervasyonu`) |
| #13 | Denetimin 74 bulgusunun düzeltmeleri: 7 `claude/fix-*` dalı + PR #11 birleşti. İki bağımsız çekişmeli para gözden geçirmesi ("kır": 180 rastgele adisyon dizisi temiz; "gerileme": 3 bulgu, hepsi kapandı). Göç `0004_odeme_istegi` |
| #14 | Servis modu (masaya servis, yarı self, self) + gözden geçirmenin 6 bulgusu, her biri testle. Göç `0005_servis_modu` |
| #15 | Bahşiş yok |
| #16 | LafPOS Uzaktan ilk etapta parolasız |
| #20 | **Self servis varsayılan:** yeni kurulum ve demo satış ekranında (menü) açılır, Masalar menüde yok; masalı sürüm demo şeridinden / Ayarlar'dan. Demonun ilk günü self servis (tezgâh satışları, çağrı ekranında numaralar, platform siparişleri) |
| #21 | Demo: ilk gün değişince kayıtlı demo yeni ilk günle açılır (eski masalı kayıt kalmasın) |
| #19 | **Paket platformları alt yapısı** (Yemeksepeti, Getir, Trendyol Go / Uber Eats, Migros): onay şeridi, kabul / ret, platform fiyatıyla paket adisyonu, platform tahsil ediyorsa kuryeye verilince online ödemeyle kapanış (yalnız platformun tutarı; fark varsa alarm), içerik kilidi, deneme modu (yalnız kurulum modunda), Yönetim › Paket platformları, göç `0008`. **Demo:** şeritte servis modu ve "Platform siparişi"; kafe bağlanana dek `lafpos.vercel.app` doğrudan demoyu açar (`?uzaktan=1` uzaktan görünüm). main'deki #12 birleşti; sql.js projesinde düşen media testi düzeldi |
| #18 | **Ödenmez** ve **hepsini ikram et**: adisyonun tamamı ciro dışı (`POST /orders/:id/comp`), yetki `siparis.odenmez`, göç `0006_odenmez` (`comp_kind`), Z/X'te ayrı satır, lafmaliyet `ikram[]`'de "Ödenmez: <neden>". Çekişmeli gözden geçirme: 6 bulgu kapandı |
| #17 | Web kasa demosu (`/demo`): gerçek LafPOS sunucusu tarayıcıda (Hono + sql.js), PIN'siz, rol şeridi, Sıfırla, örnek ilk gün, çok sekme (Web Locks + BroadcastChannel). Sunucu testlerinin hepsi sql.js ile de koşar. `docs/DEMO.md`, AGENTS kural 13 |

Her PR'da kapılar yerelde geçti: `npm run typecheck && npm test && npm run build && npm run e2e` (son durum 38 test
dosyası × 2 proje (better-sqlite3, sql.js) = 604 test; 132 ekran 0 sorun; 12/12 akış; demo 39 ekran, 5/5 akış).

**Vercel:** günlük sınır açıldı; #19'un main dağıtımı canlıda (27 Ekim akşam): demo, servis modları, ödenmez,
platformlar `lafpos.vercel.app`'te. Günde birkaç birleştirme kuralı sürüyor.

**GitHub Actions çalışmıyor:** hesapta ödeme / harcama limiti sorunu ("recent account payments have failed").
Kullanıcı GitHub › Settings › Billing'den düzeltmeli. O zamana kadar kapılar yerelde çalıştırılıp PR'a yazılır.

## Sırayla yapılacaklar

### 0. Kullanıcının 27 Ekim akşam istekleri (sırayla; her biri ayrı PR, para değiştirenler çekişmeli gözden geçirmeyle)

**Durum (28 Ekim gece):** dördü de bitti. 3 (varyant) kullanıcı cevap vermediği için en olası anlamla (ModPOS'taki
"varyant" = satışta açılan seçim) #32'de yapıldı; (c) şıkkı (grubu ürün çekmecesinde açmak) da #32'de. Yorum yanlışsa:
(a) sitede mağaza varyantına hazır değerler laffogato işi; (b) adlı boylar (Tek/Duble) şema işi, aşağıda 3. madde.
Eski not: LafPOS'ta
"varyant" kavramı yok; Yönetim › Menü'de ürün düzenlerken seçenek grubu bağlama zaten var (`MenuAdmin.tsx` "Seçenek
grupları"), boy yalnız M/L. Kelime sitenin (laffogato) mağaza ürünü sihirbazında geçiyor (paket kahve 250 g / 1 kg
gibi adlı varyantlar). Sorulan seçenekler: (a) sitede mağaza ürününe varyant eklerken hazır seçeneklerden seçmek
(laffogato deposu, ayrı iş), (b) LafPOS'ta ürüne M/L dışında adlı boylar ("Tek / Duble", "S / M / L") ve her boya
kendi seçenek grupları (şema değişikliği), (c) LafPOS'ta yeni ürün eklerken seçenek grubunu orada oluşturmak.
Cevaba göre `claude/varyant-secenek` dalında yapılır.

**Sitede yapılacak (QR, #26):** laffogato iki şey eklemeli: `GET /api/panel/orders` masa siparişinde `tableCode` ve
imzalı `PUT /api/panel/tables` `{ tables: [{ code, name, active }], actor }` (`docs/03-ENTEGRASYON.md` §2.3 "Masa
QR"). O zamana dek LafPOS'un ürettiği QR menüyü açar, uygulamadan masaya sipariş etiketle eşlenir; Yönetim ›
Entegrasyon "site henüz almıyor" der.
1. **Ödeme ekranında İkram, Ödenmez, Zayi** ("ödeme kısımlarına ödenmez, ikram da ekle ve zayi kısmı da ekle"):
   - `CompKind`'a `zayi` (comp_kind metin; göç gerekmez ama tür ve rapor güncellenir), `zayiReasons` ayarı
     (Döküldü, Yanlış hazırlandı, Bozuk / bayat, Müşteri iade etti), yetki `siparis.odenmez` (zayi de).
   - `PaymentModal` ödeme türü ızgarasının sonunda üç düğme: İkram / Ödenmez / Zayi → gerekçe → `POST
     /orders/:id/comp` (#18'deki `compOrder`; ödeme alınmışsa kapalı, ipucuyla). İşlemler menüsüne "Zayi" de.
   - Z/X: İkram, Ödenmez, Zayi ayrı satır (`odenmez` gibi `zayi` alanı); rapor özeti, ikram listesi türü, CSV;
     lafmaliyet `ikram[]` reason `"Zayi: …"` (sözleşmede alan yok; `docs/03-ENTEGRASYON.md`'ye not). İsterse
     kalem düzeyinde de (CartPanel kalem sayfası: İkram et yanında Zayi).
2. **"QR + self servis" servis modu** (`shared/service-mode.ts` yeni mod, ör. `qr_self`): kasada self servis (satış
   ekranı, menü) ama masalar görünür, çünkü laffogato uygulamasından masaya özel QR ile gelen siparişler masaya
   düşer (`server/sync/laffogato-orders.ts` masa eşlemesi). Self modda masalar gizli kalır.
   - **Masaya özel QR**: LafPOS üretir ve kaydeder (masa başına kalıcı kod/jeton, `tables` tablosunda alan; göç
     `npm run db:generate`). QR içeriği sitenin/uygulamanın masa adresiyle aynı biçimde olmalı: önce laffogato'nun
     QR biçimini ve `docs/03-ENTEGRASYON.md`'yi oku (sitede masa QR'ı nasıl çözülüyor), sözleşmede yoksa ekle.
     `uqr` paketi bağımlılıklarda var. Yönetim › Masa planı'nda masa başına QR, toplu yazdırma (A4, masa adı).
3. **Varyant eklemede seçenek** ("varyant ekleme de seçenekli olsun"): Yönetim › Ürünler'de boy/varyant ekleme ve
   seçenek grubu bağlama akışını incele; kullanıcıya kısa sor ya da en olası anlamı (ürüne varyant eklerken hazır
   seçenek gruplarından seçmek) uygula. Belirsizse önce AskUserQuestion.
4. **Ölü CSS temizliği**: `src/index.css` ve sınıf kullanımı; kullanılmayan değişken, sınıf ve keyframe'ler
   (tasarım belirteç testi `tests/design-tokens.test.ts` geçmeli). e2e taraması değişmemeli.

### 1. Paket platformları B2: gerçek API (kullanıcı: "yemek sepeti uber API de ekle")

**Durum (28 Ekim):** Trendyol Go (#27), Yemeksepeti (#28) ve Getir (#29) main'de; üçü de canlı ortamda hiç denenmedi
(uç ve alan adları belgeden; bu ortamdan `developers.tgoapps.com` ve Delivery Hero'ya erişim yok). Sırada:
- **Kullanıcının adımları** (anahtarları Claude yazmaz): Trendyol için kasa `.env`'ine `TRENDYOL_SUPPLIER_ID`,
  `TRENDYOL_API_KEY`, `TRENDYOL_API_SECRET`; Yemeksepeti için Delivery Hero'dan POS entegrasyonu, kasa `.env`'ine
  `YEMEKSEPETI_MW_URL`, `YEMEKSEPETI_USERNAME`, `YEMEKSEPETI_PASSWORD`, `YEMEKSEPETI_REMOTE_ID`, Vercel'e
  `YEMEKSEPETI_PLUGIN_SECRET` (isteğe bağlı `YEMEKSEPETI_REMOTE_ID`); Delivery Hero'ya sipariş adresi
  `https://lafpos.vercel.app/api/yemeksepeti/order/{remoteId}`, durum adresi
  `.../api/yemeksepeti/remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`.
- Her iki platformun test ortamında bir tur; uyuşmayan alan adı yalnız bağdaştırıcıda değişir.
- ~~**Getir**~~ (#29). Migros Yemek: belgeler herkese açık değil, görüşme gerekir.
- Platform başına satış ve komisyon raporu; platformdan otomatik kabul (isteğe bağlı).
- B1 (#19) hazır: `server/delivery/` (service, simulator), `shared/platforms.ts` (`PlatformOrderPayload` tek biçim),
  `docs/PAKET-PLATFORMLARI.md`. Bağdaştırıcı yalnız siparişi bu biçime çevirir ve kabul/ret/hazır/yolda çağrılarını
  yapar; akış, ödeme ve kilit B1'de.
- Sıra: **Trendyol Go** (Uber Eats Türkiye; yoklama, kasadan doğrudan; `GET …/meal/suppliers/{id}/packages`,
  `picked`, `invoiced`, `manual-shipped`, `manual-delivered`, `unsupplied`; Basic + supplierId; 10 sn'de 50 istek;
  hesap kesiminde komisyon) → **Yemeksepeti** (Delivery Hero POS middleware; push: POS ucu `POST /order/{remoteId}`
  herkese açık olmalı → LafPOS Uzaktan (Vercel) aktarıcı + Redis kuyruğu, kasa oradan çeker; `POST /v2/login`,
  `POST /v2/order/status/{token}`) → Getir (push + `/periodic/unapproved` yedek). Ayrıntı ve belgeler:
  `calisma/arastirma/paket-platformlari/` (DH YAML'ları, Getir swagger).
- Her bağdaştırıcı: platform modu `canli` (ayarda), anahtarlar `.env`'de (Claude yazmaz; kullanıcıya adım),
  sahte sunucuyla test (`tests/fake-site.ts` gibi), platforma bildirim hatası `platform_orders.last_error`,
  denetim kaydı. Ürün eşleme tablosu (platform ürün kimliği → LafPOS ürünü) ve Yönetim'de eşleşmeyenler listesi.
- Para ya da durum değiştiren her parça bağımsız çekişmeli gözden geçirmeden geçer.

### 1b. Satışı geliştir: kalanlar (kullanıcının 27 Ekim isteği)
- Var olan: site menüsü otomatik (ETag), servis modları (#14), kalem ikramı, yemek kartları ödeme türü, site online
  siparişleri (`server/sync/laffogato-orders.ts`).
- ~~Ödenmez kapanış~~ (#18), ~~paket platformları B1 ve demo düğmeleri~~ (#19).
- **28 Ekim gece:** "sipariş hazır" bildirimi, otomatik kabul ve platform raporu #31'de bitti. Kalan: kiosk (self
  servis kafede değeri düşük, ertelendi; QR'dan sipariş lafmobil'in masa ekranlı sürümünü bekliyor) ve lafmaliyet
  komisyonunun kasada tahsil edilen platform siparişini kaçırması: gün paketine eklemeli `day.platforms`
  (`{ channel, orders, revenue }`, kaynak `orders.platform`) önce docs/03'e, sonra lafmaliyet PR'ı (erişim yok).
  Eski not: **paket platformları alt yapısı** (Yemeksepeti, Getir Yemek, Trendyol Yemek, Migros Yemek, Uber Eats): ortak
  sağlayıcı arayüzü, simülatör (demoda da), sipariş al / kabul / durum, menü ve stok kapatma, komisyon raporu;
  self ve yarı self için eksikler; POS araştırmasının "şimdi yap" listesi (3. madde) bununla birlikte.
- Araştırma bitti: `calisma/arastirma/paket-platformlari/README.md` (Uber Eats Türkiye'de Trendyol Go API'si
  üzerinden; Yemeksepeti ve Getir push, Trendyol yoklama; Migros kapalı). Plan: B1 ortak arayüz + simülatör +
  kabul/ret/hazır/teslim akışı + Yönetim › Paket platformları + Siparişler'de bekleyen siparişler + demo; B2 gerçek
  bağdaştırıcılar (önce Trendyol Go, sonra Getir; Yemeksepeti push için Vercel aktarıcı). Platform siparişi POS
  satışıdır: ön ödemeli olanın ödemesi platformun `online` yöntemiyle (kanal = platform) yazılır, kasada tahsil
  edilmez. Gerçek anahtarlar kullanıcıdan; Claude yazmaz.

### 2. ~~Tasarım yenilemesi~~ (#30, 28 Ekim). Kalan küçükler: Ayarlar'da kayıttan sonra geçmişte fazladan bir giriş
kalıyor (geri tuşuna bir kez fazla basılır); otomatik kilit kaydedilmemiş değişikliği sormuyor; ham Tailwind ölçeği
bekçisi `tests/ui-rules.test.ts`'te izinli listeyle var, yeni ekranlar `--admin-*` kullanmalı. Eski not:
Apple tarzı: beyaz zemin, az renk, bol boşluk, ince tipografi, her şey tek bakışta okunur. Varsayılan tema açık,
koyu tema ayarda kalır. Kasa ekranları ve yönetim tek dilde (Innex yapısı sadeleşerek kalır). Önce/sonra ekran
görüntülerini kullanıcıya göster; 1. maddedeki demoda görünsün. Skill'ler: `impeccable`, `web-interface-guidelines`.

### 3. POS araştırmasını bitir ve eksikleri yap

**28 Ekim gece keşfi** (`origin/main` 44bcfce'ye karşı; ayrıntı oturumda): yapılabilir adaylar önem sırasıyla:
p-3 yedeğin kafe dışına kopyası ve geri yükleme betiği (canlıdan önce güvenlik), p-7 vardiya kasa devri (kör ara sayım,
X fişi başlığı; para), p-8 patronun telefonuna anlık alarm ve gün sonu özeti, p-5 platformlarda Tükendi ve mağaza
durumu (aç, kapat, yoğun), p-1 kasada uygulama damgası (laffogato M2M ucu gerekir, kullanıcı onayı), v-5 ürün başına
boy adı (Tek/Duble; göç), v-6 sitede mağaza varyantına hazır değerler (laffogato). Bitenler: servis modları, ikram,
ödenmez, zayi, paket platformları, masa QR, müşteri ve çağrı ekranı, kör kasa, seçenek tükendi (p-6, #32), teslim
adımı (p-2, #31).
- Hazır: LafPOS envanteri, Toast/Square, Lightspeed/TouchBistro, Loyverse/Odoo, Simpra/robotPOS, Türk kafe
  POS'ları (`calisma/arastirma/`).
- Kalan: ModPOS incelemesi (kullanıcının Chrome'unda panel.gafdigi.com ve patron.gafdigi.com, yalnız okuma,
  hiçbir şey kaydedilmez); sentez ve eleştiri (`calisma/is-akislari/lafpos-pos-research-*.js`).
- Çıkan "şimdi yap" listesini alanlara bölüp uygula. Bahşiş önerilerini atla (karar: bahşiş yok).

### 4. laffogato ve lafmaliyet ile bağlantı

**28 Ekim gece:** 12 maddenin 10'u kapandı (s-3..s-12; #32 ve laffogato #271). Açık: s-1 anahtarlar (operatör), s-2
Upstash Redis + uzaktan parola (operatör). lafmaliyet tarafında doğrulanacaklar (erişim yok): "Z no sırası"
denetimi hangi zincire bakıyor (LafPOS gün Z'si mi yazarkasa Z'si mi; İlk Z numarası yalnız LafPOS zincirini
etkiler), `matched`/`unmatched` yanıtı, B09-B11'in durumu, `day.platforms`.
- `calisma/arastirma/contract-laffogato-lafmaliyet-vercel.md`'deki 12 maddeyi main'le karşılaştır (fix-senkron
  ve PR #11 main'de: M/L ayrımı, servis satırı `SERVİS ÜCRETİ`, `cash_pair`, gün paketi).
- Kalanları uygun repoda dal + PR ile kapat. lafmaliyet'te başka oturumlar çalışıyor; main'e almadan önce CI ve
  inceleme. `cardTips` artık yalnız eski kayıtlarda 0'dan büyük.

### 5. Sürüm v0.2.0 (kafeye giden Windows kurulumu)

**28 Ekim gece:** derlendi (yukarıda SHA-256); Linux'ta `apt-get install nsis` ile (3.09), göçler 0000-0013 pakette,
paket denemesi geçti; 0.1.0 veritabanından yükseltme denemesi geçti (paketin kendisiyle: göçler 4'ten 14'e, satır sayıları ve eski Z'nin 28 alanı aynı, açık adisyon ödendi, Z sırası sürdü; not: Özet'te satılan adet ikramı saymaz, 0.1.0'da kapanan günler lafmaliyet'e 0.2.0'dan gitmez). Kalan: kullanıcı GitHub › Releases ›
Draft a new release (etiket `v0.2.0`, hedef main af0410d), notu yapıştırır, `.exe`'yi yükler; kafede kurulum ve
`docs/05-KASA-BILGISAYARI.md` §2 sonundaki tur. Eski not:
- `npm run kurulum:windows`: macOS'ta makensis, betik LC_ALL'u UTF-8 yapar. Göç 0004 ve 0005 pakete giriyor mu bak
  (`scripts/kasa/windows/kurulum/derle.mjs`, AGENTS kural 12).
- GitHub Release `v0.2.0` ve `.exe`. Kafe bilgisayarına kur.
- Uzaktan erişime veri yalnız 0.2.0 gönderir; 0.1.0 göndermez.

### 6. Vercel ve anahtarlar (kullanıcı yapar; gizli değerleri Claude yazmaz)
- 27 Ekim (kullanıcı onayıyla, yukarıda "Kullanıcı kararları"): kafe değişkenleri lafpos projesinden silindi,
  `LAFPOS_CLOUD_SECRET` 48 karakterle yenilendi (`/api/uzaktan/kurulum` → `secret:true`). Yeniden gerekirse Mac'te
  `bash scripts/vercel/baglanti-kur.sh --yenile` (anahtarları üretir, kafe satırlarını
  `~/Downloads/lafpos-kasa-ayarlari.env`'e yazar).
- Upstash Redis Frankfurt'ta (eu-central) bağlı olmalı: `/api/uzaktan/kurulum` `redis:true`.
- Üretim yalnız main'den. Günlük 100 dağıtım sınırı (Hobby): main'e günde birkaç kez birleştir.
- Yemeksepeti için Vercel'e `YEMEKSEPETI_PLUGIN_SECRET` (Delivery Hero'nun JWT anahtarı) ve isteğe bağlı
  `YEMEKSEPETI_REMOTE_ID` eklenmeli; `GET /api/uzaktan/kurulum` `yemeksepeti: true` döner. Değer Delivery Hero'dan gelir.
- Getir için Vercel'e `GETIR_WEBHOOK_SECRET` (bizim ürettiğimiz, en az 16, `LAFPOS_CLOUD_SECRET` ve Yemeksepeti
  anahtarından farklı; eşitse reddedilir) ve isteğe bağlı `GETIR_RESTAURANT_ID`; kurulum `getir: true` döner.

### 7. Operatörün yapacakları
- GitHub faturalama (Actions çalışsın).
- Token'a TokenX entegratör maili.
- Örnek PIN'leri değiştir, kurulum modunu kapat.
- Gerçek Windows bilgisayarda ve gerçek cihazla bir tur.
- Smart App Control ve kod imzalama kararı.

## Çalışma dersleri
- **Göç numarası çakışır:** başka oturumlar da göç ekliyor (bugün 0009, 0010, 0011 aynı gün). PR'dan önce main'i
  al; çakışırsa kendi `.sql`'ini ve meta dosyalarını main'inkiyle değiştirip `npx drizzle-kit generate --name <ad>`
  ile yeniden üret, kapıları birleşmiş ağaçta koş.
- **Çekişmeli tur iki kez:** ilk turun düzeltmeleri yeni hata getiriyor (Trendyol ve Yemeksepeti'de ikinci tur 6 ve 5
  yeni doğrulanmış bulgu buldu). Para ya da durum değiştiren işte düzeltmelerden sonra kısa bir ikinci tur koş.
  Workflow'ta ajan sayısını 10'un altında tut (50 ajanlık tur oturum sınırına takıldı, doğrulayıcıların çoğu düştü).
- `npx prettier --write` depoya uygulanmaz (depo prettier biçiminde değil, yüzlerce satır gürültü yapar).
- `pkill -f <ad>` komutu kendi kabuğunu da öldürür (komut satırında aynı ad geçer).
- Bu ortamın vekil sunucusu `lafpos.vercel.app`'i ve `laffogato.net`'i engelliyor (403): canlı denetim buradan
  yapılamıyor; ortamın Allowed domains listesine eklenirse olur, yoksa kullanıcı bakmalı.
- **Saat bombası:** sabit tarihli fikstür bir gün sonra testi düşürdü (28 Ekim, `tests/site-orders.test.ts`).
  Zamana bağlı pencereye giren fikstür gerçek saate kaydırılır (`tests/fake-site.ts` `siteOrdersFixture`).
- **Büyük arayüz işi:** dosya sahipliğine göre böl (önce ortak bileşenler tek başına, sonra sayfa grupları paralel),
  sonra bağımsız doğrulayıcı ve iki çekişmeli tur. İkinci tur yine para hatası buldu ("45.90" → 4.590 TL).
- Kullanım limiti 28 Ekim'de iki kez doldu (5 saatlik pencere); yarım ajanlar SendMessage ile, iş akışları
  `resumeFromRunId` ile kaldığı yerden sürdü.

- **Konteyner yeniden başlayabilir** (28 Ekim gece bir kez): arka plandaki iş akışları durur, sonuç bildirimi gelmez.
  Ajanların commit'leri ve iş akışı günlükleri (`journal.jsonl`) kalır; yarım kalanı commit'lere ve günlüğe bakıp
  yeniden kur. Gözden geçiricilerin `--detach` kopyalarını `git worktree remove --force` ile temizle.
- **İki büyük dalı ayrı birleştirince bir birleşim turu koş:** #32 ile #31 tek tek temizdi; birleşimde otomatik kabul,
  seçeneği tükenmiş ürünü kabul ediyordu (git çakışması değil, anlam çakışması). Önce birini main'e al, öbürüne main'i
  al, tam kapılar + iki mercekli kısa tur.
- **Paralel dallar, sonra birleştirme:** sekiz iş sekiz worktree'de (iki iş akışı × 2 eşzamanlı ajan), sonra iki PR
  dalına `git merge`; çakışmalar belge ve aynı yere eklenen satırlardı. Ajanlara "değişikliğini derli toplu tut, başka
  dal aynı dosyaya dokunuyor" demek işe yaradı.
- Kullanım limiti: aynı anda tek iş akışı (≤ 6 ajan); büyük işten önce kullanıma bak. Bugün birleştirme, iki
  gözden geçirici, servis modu ve iki küçük PR 5 saatlik pencerenin ~%80'ini kullandı.
- Her dal kendi worktree'sinde (`~/Downloads/lafpos-wt/<ad>`), `node_modules` ana klondan bağ. `.gitignore` artık
  `node_modules` (eğik çizgisiz): bağ bir kez commit'e girmişti, `git add -A`'dan önce `git status`'a bak.
- Site menüsü testleri: Türk Kahvesi sitenin kalemi (130 TL, iki boy); fiyatı API'den değişmez, testte
  `h.pinPrice(ad, kuruş)`. Dünün günü 05:00'ten sonra açıksa yeni adisyon açılmaz (`stale_day`).
- Kalem bazlı ödemede istemci tutarı sunucununkiyle aynı göndermeli (`items_changed`): `itemPayLines` +
  `amountForItems`, kalana sınırlı.
- Para ya da durum değiştiren her şey main'den önce bağımsız, çekişmeli gözden geçirmeden geçer.

## Devam istemi (yeni oturuma yapıştır)

> LafPOS'ta (`RiosenBeq/lafpos`) kaldığın yerden devam et. `git fetch`, sonra `origin/claude/calisma-notlari`
> dalındaki `calisma/KALAN-ISLER.md`'yi oku ve `AGENTS.md`'ye uy. İşletme self servis; sistem henüz demo. Sırayla:
> (1) kullanıcı "aktif ol" derse "28 Ekim: durum ve canlıya geçiş" listesini sırayla yürüt (anahtarları sen yazma,
> değer basma; Vercel değişkeni ekleyebilirsin); platformların test ortamında birer tur; v0.2.0 Release'ini kullanıcı
> açtıysa kafede kurulum turunu yönlendir; (2) 3. maddenin "28 Ekim gece keşfi" listesi (önce p-3 yedek ve p-7 vardiya
> devri; p-1 için kullanıcı onayı ve laffogato ucu); (3) lafmaliyet bağlanabilirse 4. maddedeki doğrulamalar ve
> `day.platforms`; (4) varyant yorumu yanlış çıkarsa 0. maddedeki (a)/(b). Her iş ayrı dal ve worktree
> (`/home/user/lafpos-wt/<ad>`, `node_modules` ana klondan bağ); para ya da durum değiştiren iş bağımsız çekişmeli
> gözden geçirmeden iki tur geçer (iş akışı başına ajan sayısı 10'un altında); kapıları (typecheck, test, build, e2e)
> yerelde geçir ve PR'a yaz; PR'dan önce main'i al ve göç numarasını denetle; iki büyük dal art arda girecekse
> birleşim turu koş; PR ile main'e al (merge commit); Vercel sınırı yüzünden main'e günde birkaç kez; birleştirince
> canlıya bak (bu ortamda engelliyse kullanıcıya söyle). Kullanımın %90'ına gelince bu dosyayı güncelle ve yeni devam
> istemi ver.
