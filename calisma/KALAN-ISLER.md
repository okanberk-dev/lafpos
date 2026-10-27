# LafPOS: kalan işler (27 Ekim 2026, gece)

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

## Bitenler (bugün main'e girdi)
| PR | İçerik |
|---|---|
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

**Durum (27 Ekim gece):** 1 (#24), 2 (#26) ve 4 (#23) bitti. **3 (varyant) kullanıcının cevabını bekliyor**: LafPOS'ta
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

**Durum (27 Ekim gece):** Trendyol Go (#27) ve Yemeksepeti (#28) main'de; ikisi de canlı ortamda hiç denenmedi
(uç ve alan adları belgeden; bu ortamdan `developers.tgoapps.com` ve Delivery Hero'ya erişim yok). Sırada:
- **Kullanıcının adımları** (anahtarları Claude yazmaz): Trendyol için kasa `.env`'ine `TRENDYOL_SUPPLIER_ID`,
  `TRENDYOL_API_KEY`, `TRENDYOL_API_SECRET`; Yemeksepeti için Delivery Hero'dan POS entegrasyonu, kasa `.env`'ine
  `YEMEKSEPETI_MW_URL`, `YEMEKSEPETI_USERNAME`, `YEMEKSEPETI_PASSWORD`, `YEMEKSEPETI_REMOTE_ID`, Vercel'e
  `YEMEKSEPETI_PLUGIN_SECRET` (isteğe bağlı `YEMEKSEPETI_REMOTE_ID`); Delivery Hero'ya sipariş adresi
  `https://lafpos.vercel.app/api/yemeksepeti/order/{remoteId}`, durum adresi
  `.../api/yemeksepeti/remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`.
- Her iki platformun test ortamında bir tur; uyuşmayan alan adı yalnız bağdaştırıcıda değişir.
- **Getir** (push + `/periodic/unapproved` yedek): Yemeksepeti'deki aktarıcı deseniyle.
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
- Kalan: self / yarı self için kiosk ya da masadan QR sipariş (onay kuyruğuyla; QR sitede var), "sipariş hazır"
  bildirimi, platformdan otomatik kabul, platform başına satış ve komisyon raporu. Eski not: **paket platformları alt yapısı** (Yemeksepeti, Getir Yemek, Trendyol Yemek, Migros Yemek, Uber Eats): ortak
  sağlayıcı arayüzü, simülatör (demoda da), sipariş al / kabul / durum, menü ve stok kapatma, komisyon raporu;
  self ve yarı self için eksikler; POS araştırmasının "şimdi yap" listesi (3. madde) bununla birlikte.
- Araştırma bitti: `calisma/arastirma/paket-platformlari/README.md` (Uber Eats Türkiye'de Trendyol Go API'si
  üzerinden; Yemeksepeti ve Getir push, Trendyol yoklama; Migros kapalı). Plan: B1 ortak arayüz + simülatör +
  kabul/ret/hazır/teslim akışı + Yönetim › Paket platformları + Siparişler'de bekleyen siparişler + demo; B2 gerçek
  bağdaştırıcılar (önce Trendyol Go, sonra Getir; Yemeksepeti push için Vercel aktarıcı). Platform siparişi POS
  satışıdır: ön ödemeli olanın ödemesi platformun `online` yöntemiyle (kanal = platform) yazılır, kasada tahsil
  edilmez. Gerçek anahtarlar kullanıcıdan; Claude yazmaz.

### 2. Tasarım yenilemesi (kullanıcının seçimi: "Aydınlık ve sade")
Apple tarzı: beyaz zemin, az renk, bol boşluk, ince tipografi, her şey tek bakışta okunur. Varsayılan tema açık,
koyu tema ayarda kalır. Kasa ekranları ve yönetim tek dilde (Innex yapısı sadeleşerek kalır). Önce/sonra ekran
görüntülerini kullanıcıya göster; 1. maddedeki demoda görünsün. Skill'ler: `impeccable`, `web-interface-guidelines`.

### 3. POS araştırmasını bitir ve eksikleri yap
- Hazır: LafPOS envanteri, Toast/Square, Lightspeed/TouchBistro, Loyverse/Odoo, Simpra/robotPOS, Türk kafe
  POS'ları (`calisma/arastirma/`).
- Kalan: ModPOS incelemesi (kullanıcının Chrome'unda panel.gafdigi.com ve patron.gafdigi.com, yalnız okuma,
  hiçbir şey kaydedilmez); sentez ve eleştiri (`calisma/is-akislari/lafpos-pos-research-*.js`).
- Çıkan "şimdi yap" listesini alanlara bölüp uygula. Bahşiş önerilerini atla (karar: bahşiş yok).

### 4. laffogato ve lafmaliyet ile bağlantı
- `calisma/arastirma/contract-laffogato-lafmaliyet-vercel.md`'deki 12 maddeyi main'le karşılaştır (fix-senkron
  ve PR #11 main'de: M/L ayrımı, servis satırı `SERVİS ÜCRETİ`, `cash_pair`, gün paketi).
- Kalanları uygun repoda dal + PR ile kapat. lafmaliyet'te başka oturumlar çalışıyor; main'e almadan önce CI ve
  inceleme. `cardTips` artık yalnız eski kayıtlarda 0'dan büyük.

### 5. Sürüm v0.2.0 (kafeye giden Windows kurulumu)
- `npm run kurulum:windows`: macOS'ta makensis, betik LC_ALL'u UTF-8 yapar. Göç 0004 ve 0005 pakete giriyor mu bak
  (`scripts/kasa/windows/kurulum/derle.mjs`, AGENTS kural 12).
- GitHub Release `v0.2.0` ve `.exe`. Kafe bilgisayarına kur.
- Uzaktan erişime veri yalnız 0.2.0 gönderir; 0.1.0 göndermez.

### 6. Vercel ve anahtarlar (kullanıcı yapar; gizli değerleri Claude yazmaz)
- 27 Ekim denetimi: `LAFPOS_CLOUD_SECRET` Vercel'de var ama 32 karakterden kısa ya da boş (`/api/uzaktan/kurulum`
  → `secret:false`). Kafe değişkenleri (`LAFFOGATO_URL`, `LAFFOGATO_SYNC_SECRET`, `LAFMALIYET_URL`,
  `LAFMALIYET_SYNC_SECRET`, `LAFPOS_CLOUD_URL`) lafpos projesinde hâlâ duruyor; Vercel işlevi okumuyor. Kullanıcıya
  soruldu; silme onayı gelmedi.
- lafpos projesinde `LAFPOS_CLOUD_SECRET` okunmuyor (`/api/uzaktan/kurulum` → `secret:false`). Kafeyi bağlarken
  Mac'te `bash scripts/vercel/baglanti-kur.sh --yenile`; anahtarları yeniden üretir, kafe satırlarını
  `~/Downloads/lafpos-kasa-ayarlari.env`'e yazar.
- lafpos projesine yanlışlıkla eklenen kafe değişkenlerini sil: `LAFFOGATO_*`, `LAFMALIYET_*`, `LAFPOS_CLOUD_URL`.
- Üretim yalnız main'den. Günlük 100 dağıtım sınırı (Hobby): main'e günde birkaç kez birleştir.
- Yemeksepeti için Vercel'e `YEMEKSEPETI_PLUGIN_SECRET` (Delivery Hero'nun JWT anahtarı) ve isteğe bağlı
  `YEMEKSEPETI_REMOTE_ID` eklenmeli; `GET /api/uzaktan/kurulum` `yemeksepeti: true` döner. Değer Delivery Hero'dan gelir.

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
- Bu ortamın vekil sunucusu `lafpos.vercel.app`'i engelliyor (403): canlı denetim buradan yapılamıyor, kullanıcı bakmalı.

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
> dalındaki `calisma/KALAN-ISLER.md`'yi oku ve `AGENTS.md`'ye uy. İşletme self servis. Sırayla: (1) 0. maddenin 3.
> işi "varyant eklemede seçenek": kullanıcının cevabına göre (cevap yoksa önce sor) `claude/varyant-secenek`
> dalında yap; (2) 1. madde: kullanıcı anahtarları verdiyse Trendyol Go ve Yemeksepeti'nin test ortamında bir tur
> (anahtarları sen yazma, `.env` ve Vercel değişkenleri kullanıcıda), sonra Getir bağdaştırıcısı (Yemeksepeti'deki
> aktarıcı deseni); (3) 1b ve sonraki maddeler. Her iş ayrı dal ve worktree (`~/Downloads/lafpos-wt/<ad>`); para ya
> da durum değiştiren iş bağımsız çekişmeli gözden geçirmeden iki tur geçer (ajan sayısı 10'un altında); kapıları
> (typecheck, test, build, e2e) yerelde geçir ve PR'a yaz; PR'dan önce main'i al ve göç numarasını denetle; PR ile
> main'e al (merge commit); Vercel sınırı yüzünden main'e günde birkaç kez; birleştirince canlıya bak.
> Kullanımın %90'ına gelince bu dosyayı güncelle ve yeni devam istemi ver.
