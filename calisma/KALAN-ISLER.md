# LafPOS: kalan işler (27 Ekim 2026, akşamüstü)

Bu dosya kaldığın yerden devam etmek içindir. Her şey GitHub'da (`RiosenBeq/lafpos`). Ayrıntılı geçmiş:
`calisma/PLAN.md`. Kurallar: depodaki `AGENTS.md` (para kuruş, yetki sunucuda, denetim kaydı, `patchOf`, Türkçe metin,
`data/` ve `.env` asla commit'lenmez, dal `claude/<konu>`, PR başlığı Türkçe, main'e doğrudan push yok).

## Kullanıcı kararları (27 Ekim 2026)
- **Bahşiş yok.** Ödeme ekranında alan yok, sunucu `tip > 0`'ı 400 `tip_disabled` ile reddeder (Ayarlar
  `tipsEnabled` varsayılan kapalı). Eski kayıtlardaki bahşiş raporlarda okunur. Yeni işte bahşiş ekleme.
- **Satışı geliştir (27 Ekim, yeni istek):** "menüler laffogato ya da lafmaliyet'ten otomatik gelsin ama sistem
  gelişmiş olsun; self servis ve yarı selfe uygun; ikram, ödenmez, yemek kartı vs.; Yemeksepeti, Uber Eats alt
  yapısı ve bu tarz ne varsa". Aşağıda 1. madde.
- **Demo aşamasında giriş yok.** Web kasa demosu PIN sormadan açılacak. LafPOS Uzaktan, kafe bağlıyken de
  parolasız (yapıldı, PR #16). Gerçek kullanımdan önce Vercel'de `LAFPOS_UZAKTAN_PAROLA_GEREKLI=1` ve
  `LAFPOS_UZAKTAN_PAROLA` tanımlanmalı. Bunu v0.2.0 öncesi kullanıcıya hatırlat.

## Bitenler (bugün main'e girdi)
| PR | İçerik |
|---|---|
| #13 | Denetimin 74 bulgusunun düzeltmeleri: 7 `claude/fix-*` dalı + PR #11 birleşti. İki bağımsız çekişmeli para gözden geçirmesi ("kır": 180 rastgele adisyon dizisi temiz; "gerileme": 3 bulgu, hepsi kapandı). Göç `0004_odeme_istegi` |
| #14 | Servis modu (masaya servis, yarı self, self) + gözden geçirmenin 6 bulgusu, her biri testle. Göç `0005_servis_modu` |
| #15 | Bahşiş yok |
| #16 | LafPOS Uzaktan ilk etapta parolasız |
| #18 | **Ödenmez** ve **hepsini ikram et**: adisyonun tamamı ciro dışı (`POST /orders/:id/comp`), yetki `siparis.odenmez`, göç `0006_odenmez` (`comp_kind`), Z/X'te ayrı satır, lafmaliyet `ikram[]`'de "Ödenmez: <neden>". Çekişmeli gözden geçirme: 6 bulgu kapandı |
| #17 | Web kasa demosu (`/demo`): gerçek LafPOS sunucusu tarayıcıda (Hono + sql.js), PIN'siz, rol şeridi, Sıfırla, örnek ilk gün, çok sekme (Web Locks + BroadcastChannel). Sunucu testlerinin hepsi sql.js ile de koşar. `docs/DEMO.md`, AGENTS kural 13 |

Her PR'da kapılar yerelde geçti: `npm run typecheck && npm test && npm run build && npm run e2e` (son durum 38 test
dosyası × 2 proje (better-sqlite3, sql.js) = 604 test; 132 ekran 0 sorun; 12/12 akış; demo 39 ekran, 5/5 akış).

**Vercel günlük dağıtım sınırı doldu (27 Ekim):** canlıdaki son main dağıtımı #13; #14-#18'in dağıtımları ve #17'nin main dağıtımı "Deployment rate limited — retry in 24
hours" ile reddedildi; demo henüz canlıda değil. Sınır açılınca main'e ilk push dağıtır ya da Vercel'de son main
dağıtımında Redeploy. Canlıda `/demo` ve Uzaktan'daki "Kasa ekranını dene" bağlantısını dene.

**GitHub Actions çalışmıyor:** hesapta ödeme / harcama limiti sorunu ("recent account payments have failed").
Kullanıcı GitHub › Settings › Billing'den düzeltmeli. O zamana kadar kapılar yerelde çalıştırılıp PR'a yazılır.

## Sırayla yapılacaklar

### 1. Satışı geliştir: ödenmez, paket platformları, self ve yarı self (kullanıcının 27 Ekim isteği)
- Var olan: site menüsü otomatik (ETag), servis modları (#14), kalem ikramı, yemek kartları ödeme türü, site online
  siparişleri (`server/sync/laffogato-orders.ts`).
- ~~Ödenmez kapanış~~ (#18'de bitti).
- Yapılacak: **paket platformları alt yapısı** (Yemeksepeti, Getir Yemek, Trendyol Yemek, Migros Yemek, Uber Eats): ortak
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
- lafpos projesinde `LAFPOS_CLOUD_SECRET` okunmuyor (`/api/uzaktan/kurulum` → `secret:false`). Kafeyi bağlarken
  Mac'te `bash scripts/vercel/baglanti-kur.sh --yenile`; anahtarları yeniden üretir, kafe satırlarını
  `~/Downloads/lafpos-kasa-ayarlari.env`'e yazar.
- lafpos projesine yanlışlıkla eklenen kafe değişkenlerini sil: `LAFFOGATO_*`, `LAFMALIYET_*`, `LAFPOS_CLOUD_URL`.
- Üretim yalnız main'den. Günlük 100 dağıtım sınırı (Hobby): main'e günde birkaç kez birleştir.

### 7. Operatörün yapacakları
- GitHub faturalama (Actions çalışsın).
- Token'a TokenX entegratör maili.
- Örnek PIN'leri değiştir, kurulum modunu kapat.
- Gerçek Windows bilgisayarda ve gerçek cihazla bir tur.
- Smart App Control ve kod imzalama kararı.

## Çalışma dersleri
- Kullanım limiti: aynı anda tek iş akışı (≤ 6 ajan); büyük işten önce kullanıma bak. Bugün birleştirme, iki
  gözden geçirici, servis modu ve iki küçük PR 5 saatlik pencerenin ~%80'ini kullandı.
- Her dal kendi worktree'sinde (`~/Downloads/lafpos-wt/<ad>`), `node_modules` ana klondan bağ. `.gitignore` artık
  `node_modules` (eğik çizgisiz): bağ bir kez commit'e girmişti, `git add -A`'dan önce `git status`'a bak.
- Site menüsü testleri: Türk Kahvesi sitenin kalemi (130 TL, iki boy); fiyatı API'den değişmez, testte
  `h.pinPrice(ad, kuruş)`. Dünün günü 05:00'ten sonra açıksa yeni adisyon açılmaz (`stale_day`).
- Kalem bazlı ödemede istemci tutarı sunucununkiyle aynı göndermeli (`items_changed`): `itemPayLines` +
  `amountForItems`, kalana sınırlı.
- Para ya da durum değiştiren her şey main'den önce bağımsız, çekişmeli gözden geçirmeden geçer.
