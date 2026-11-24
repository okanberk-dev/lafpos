# Hesap uyumu: yeni oturum için devam promptu (24.11.2026)

Aşağıdaki metin yeni bir Claude Code oturumuna olduğu gibi verilir.

---

"LafPOS ile ladmin'i (lafmaliyet) hesapta birebir uyumlu yap" görevine ve sahibin son isteklerine kaldığın yerden devam et.
Önceki oturum kullanım limitinde durdu; her şey GitHub'da, hiçbir şey kaybolmadı.

## 0. Depolar ve erişim

- `okanberk-dev/lafpos`: kafenin kasası LafPOS (Vite + Node, sqlite/drizzle, sql.js demo, vitest, Playwright e2e). Para kuruş tam sayı.
- `okanberk-dev/lafmaliyet`: köşkün iç paneli ladmin (Next.js 16, Drizzle + Postgres, node:test). Para TL ondalık.
- `okanberk-dev/laffogato`: site (Next.js 16, pg). Kod, commit ve PR İngilizce; arayüz Türkçe.
- Üçüne de push erişimi ekle (`add_repo`, access push); klonla, `register_repo_root`.
- Her deponun kendi `AGENTS.md` / `CLAUDE.md` kuralları bağlayıcıdır.

## 1. Önce oku

`okanberk-dev/lafpos` deposunun **`claude/hesap-uyumu-notlar`** dalında `docs/devam/hesap-uyumu/` klasörü:

- `DEVAM.md`: §1 ortam kurulumu, **§2 güncel durum**, §5 dersler, **§6 yeni oturumda başlangıç**.
- `CONTRACT.md`: bağlayıcı uygulama sözleşmesi. **Sahip kararları §1 ve §9'da; yeniden sorma.** §2 gün gövdesi alanları, §3 ladmin
  yanıtları ve imzalı uçlar, §4 paketler ve dallar, §6 kabul rakamları (çıktı tam bu rakamları vermeli), §8 şube fiyatı.
- `hesap-sozlesmesi.md`: iki depoda bayt bayt aynı paylaşılan hesap belgesi (SHA-256 testle kilitli).
- `maps/*.md`: kod haritaları (eski commit'lere göre yazıldı; satır numaralarını yeniden doğrula).
- `NOTES.md`: oturum günlüğü.
- `*-final.json`, `LM-4-impl-review.json`: ajan raporları ve LM-4'ün inceleme bulguları.
- İş akışı betikleri: `gunsonu.js` (gün sonu tam otomatik), `wave3.js` (LP-C, LM-3, LP-E, LM-4, LM-4b, LM-5 tanımları),
  `cont.js`, `wave2.js`.

## 2. Ortamı kur (DEVAM.md §1 ve §6)

1. Üç depoyu `/home/user/lafpos`, `/home/user/lafmaliyet`, `/home/user/laffogato` olarak klonla; her birinde `npm ci`.
2. Postgres: `service postgresql start`; `CREATE USER ci WITH PASSWORD 'ci' SUPERUSER;` `CREATE DATABASE test OWNER ci;`
   `CREATE DATABASE laffogato_test OWNER ci;`. Kapsayıcı yeniden başlayınca Postgres kapanır: tekrar `service postgresql start`.
3. Uzak dalları getirmek için sığ klonlarda: `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'` ve `git fetch`.
4. Notları kendi scratchpad'ine kopyala. Betikleri çalışma dizininden erişilebilir bir yere (ör. `/home/user/wt/scripts`) kopyala
   ve içlerindeki eski scratchpad yolunu (`/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad`)
   kendi scratchpad'inle değiştir (`sed`). Betiklerdeki depo ve worktree yolları `/home/user/...`; farklıysa onları da değiştir.
5. Worktree'ler (her birinde `node_modules` ana klonun `node_modules`'üne symlink):
   - lafpos `claude/gun-sonu-tam` → `/home/user/wt/lafpos-gunsonu`
   - lafmaliyet `claude/gun-sonu-tam` → `/home/user/wt/lafmaliyet-gunsonu`
   - lafmaliyet `claude/personel-sube-kira` → `/home/user/wt/lafmaliyet-faz5`
6. Temel kontrol: lafpos `npm run typecheck && npm test`; lafmaliyet `npx next typegen && npx tsc --noEmit && npm run lint &&
   npm test && TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db`.

## 3. Şu ana kadar main'de olanlar

- laffogato#301: şube satış fiyatı (LF-1).
- lafpos#167 (Faz 2 gövde alanları), #169 (kasa zinciri: devir, açılış farkı nedeni, kasa hareketleri satır satır, gider
  kategorileri), #168 (ModPOS günleri lafmaliyet'ten, kasa Raporlar'da ve Uzaktan'da; "Geçen hafta" 16–21 Kasım sorunu).
- lafmaliyet#124 (Faz 1), #125 (Faz 2 okuyucu), #126 (kasa zinciri okuyucu), #123 (ModPOS dönemi ucu + Satışlar kapsamı şube şube).
- lafpos#170 (LP-C personel bağlantısı): önceki oturum CI yeşil olunca birleştirmeye çalıştı. **Açıksa: CI yeşilse merge commit
  ile birleştir; kırmızıysa kök nedeni düzelt.**

Üst üste kurulu PR'lar squash değil **merge commit** ile birleştirilir (squash üstteki dalları çakıştırır). Tek başına PR'da
deponun alışkanlığı squash (laffogato).

## 4. Yapılacaklar, öncelik sırasıyla

### 4.1 ÖNCELİK: gün sonu tam otomatik (LP-F + LM-6)

Sahibin isteği (24.11.2026, aynen): *"Ayrıca lafposa girilenler de eksiksiz lafmaliyete girsin; lafpos günü kapatırken
POS'tan da gün sonunu oraya giriyor, şuna bak; sadece gün sonu ladmine personel foto atsın."* ve *"Sorularını da sen test
edip gör."*

Bugünkü durum: LafPOS günü kapatınca ladmin'de kasa raporu kendiliğinden yazılıyor ("LafPOS (otomatik)": Z, ödemeler,
ödenmez, indirim, açılış, giren/çıkan, sayılan nakit, yazarkasa Z no, kasa hareketleri). Ama **"Banka POS" (Pavo gün sonu)
ve yazarkasa alanları bilerek boş kalıyor** ("Uydurma değer yok" kuralı; not: "Eksik: Banka POS Z (yazarkasa); panelden
ekleyin"). Personel bunları elle ya da fotoğrafla dolduruyor.

Kararlar (orkestratör, bağlayıcı; yalnız LafPOS günleri, Tuzla/ModPOS değişmez):
- LafPOS gününde Banka POS, LafPOS'un `bankPos`'undan (Pavo'nun kendi gün sonu sonucu, cihaz verisi) dolar; yazarkasa alanları
  LafPOS'un mali cihaz verisinden (cihaz fişleri; Z − yazarkasadan geçmeyen). Eski "boş kalır" kuralı bu günler için kalkar.
- LafPOS'ta cihaz rakamı yoksa (Pavo gün sonu başarısız ya da bilinmiyor) alan boş kalır ve rapor tam olarak neyin eksik
  olduğunu yazar. **Rakam uydurulmaz.**
- Personel LafPOS gününün raporunda rakamları salt okunur görür, **yalnız fotoğraf ekler** (Pavo gün sonu fişi; ayrıysa
  yazarkasa Z), ayrıca "Gönder"e basmaz. Fotoğraf okunur ve LafPOS rakamlarıyla karşılaştırılır; fark **yöneticiye** uyarıdır.
- Kişinin düzelttiği alan sonraki otomatik güncellemeden sonra da kalır (mevcut `mergeAuto` kuralı).
- LafPOS'ta girilip ladmin'e hiç gitmeyen başka veri varsa (bahşiş, cari satış/tahsilat, kasa föyü, yazarkasadan geçmeyen
  kartla bahşiş, gün sonrası fiş iptalinin kart tutarı …) gövdeye yalnız ekleme olarak taşınır; ladmin `.optional().catch(undefined)`
  ile okur. KVKK: gövdeye kişi adı girmez.

Yöntem: `gunsonu.js` iş akışı.
1. **Denetim ajanı** iki sistemi yerelde gerçekten çalıştırır (canlı sisteme dokunmaz): geçici Postgres veritabanında ladmin,
   kendi veri klasörü ve sahte cihazıyla LafPOS (`LAFMALIYET_URL` yerel ladmin, ortak test anahtarı). Gerçekçi bir gün geçirir:
   nakit/kart/yemek kartı/bölünmüş ödeme, bahşiş, indirim, ikram, ödenmez, zayi, hazırlanmış iptal, iade, cari satış ve
   tahsilat, kategorili harcama, teslim, giriş, Pavo gün sonu, sayım, günü kapatma. ladmin'de satırlara ve personel/yönetici
   kasa sayfalarına (Playwright, başsız Chromium kurulu) bakar; LafPOS'taki her girişin ladmin'de nereye düştüğünü ya da
   düşmediğini yazar. Yeniden koşulabilir bir betik bırakır.
2. **LP-F** (lafpos, `/home/user/wt/lafpos-gunsonu`) ve **LM-6** (lafmaliyet, `/home/user/wt/lafmaliyet-gunsonu`) paralel;
   her biri bağımsız inceleme + düzeltme. Bitince denetimin betiği yeniden koşulur ve personel sayfasının yalnız fotoğraf
   istediği gösterilir.
3. LafPOS gövdesi değişirse altın gövde (`LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts`) ve kabul günü yeniden
   üretilir; lafmaliyet'teki kopyalar bayt bayt aynı olmalı (`cmp`). Önce LafPOS (gönderen), sonra ladmin (okuyan) birleşir.

### 4.2 LM-4'ü bitir (lafmaliyet Faz 5)

Dal `claude/personel-sube-kira` (worktree `/home/user/wt/lafmaliyet-faz5`; main 06:40'ta birleştirildi, bc230a7). İçerik:
personel yemek kartı satırı (ayar 330 TL × 26 gün, kişi bayrağı; bayrağı sahip Alper ve Cem için kendisi açar), part-time
günlük model (Aralık 2026'dan; Kasım'da haftalık sabit kalem kalır), `staff.userId` / `staff.personRef` (Vardiya bağı),
kira ev sahibi türü (şahıs: KDV yok, resmi kiraya %20 stopaj, tek kaynak; şirket: %20 KDV, stopaj yok), şube ekranlarında
"İşletme geneli payı (bilgi)" (şube kârına girmez; Tümü'de bir kez).

İnceleme bulguları `LM-4-impl-review.json`'da (3 büyük, 5 küçük). Önceki oturumun son dakikalarında bir ajan bunları
düzeltmeye başladı ve her düzeltmeyi ayrı commit'leyip push'ladı: Bitenler (push'lu): büyük 1 (569711b, Ödemeler'in sabit gider yolları ev sahibi türünü nakit planıyla aynı kuralla sayar)
ve büyük 2 (fe24851, işletme geneli tam ay kalem şube görünümünde işletmenin günüyle). **Kalan: büyük 3 (şube görünümünde Excel
temeli net kâr ve başabaş işletme genelini dışlamalı) ve 5 küçük bulgu**; önce test yazarak düzelt. Sonra tam kontrol → PR (taban main) → CI yeşil → birleştir.

### 4.3 Sonra sırayla (tanımlar `wave3.js`)

- **LP-E** (lafpos, dal `claude/sube-fiyati-kasa`, main'den): şube fiyatını kasada kullan: gövdede `lines[].listPrices`;
  imzalı menüden `nextPriceAt` gelirse gün açıkken o anda bir kez zorunlu menü eşitlemesi; imzalı okuma düşerse bağlı
  ürünlerin fiyatını Tuzla'nın herkese açık fiyatıyla ezme. Site tarafı main'de (laffogato `docs/PANEL-MENU.md` "Şube fiyatı").
- **LM-4b** (lafmaliyet, dal `claude/personel-baglanti`, LM-4'ten sonra main'den): LafPOS personel bağlantısının okuyucusu:
  imzalı `GET /api/panel/pos/personel?sube=` (§3 biçimi; imza vektörü LafPOS `tests/signature.test.ts`'teki
  `b6933a6b…7f31`), `workedStaffRefs` saklama ve 200 yanıtında `staff {counted, unknown, otherBranch}`, yemek kartı günleri
  LafPOS'tan (ayın bütün sayılan LafPOS günleri alanı taşıyorsa).
- **LM-5** (lafmaliyet, dal `claude/sube-fiyati`): şube fiyatı yazma (Fiyatlar'da "Şube" ve "Geçerlilik", varsayılan ertesi
  iş günü 05:00 İstanbul; yalnız site `writes.branchPrice` duyurursa), `lines[].listPrices` saklama, "Eski fiyattan satılanlar"
  raporu (Bekliyor / Uygulandı · gün / Uygulanmadı / Bilinmiyor; ciro ya da adetten çıkarım yok).

## 5. Çalışma yöntemi

- Çok adımlı işi iş akışıyla (Workflow) yap: 4 çekirdek var, **iş akışı başına aynı anda en çok 2 ajan**; ayrı depolar için
  ayrı iş akışları. **İş akışı içindeki ajana SendMessage atma** (ikinci kopya başlar, aynı dosyalara yazar).
- Her paket: uygulama (önce düşen test) → bağımsız inceleme (yalnız değişen yere dokunan testler; tam takımı yeniden koşmaz)
  → düzeltme (tam takım sonda bir kez).
- Tam kontrol: lafpos `npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e`;
  lafmaliyet `npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env
  TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db`
  (lafmaliyet CI veritabanı testlerini koşmaz; birleştirmeden önce yerelde koş).
- Biten her paket: push → PR (taban main, başlık Türkçe; laffogato İngilizce) → `subscribe_pr_activity` → CI yeşil →
  main'e birleştir (sahip "bitenleri maine gönder" dedi). main birleştirince çakışma çıkarsa her iki tarafı koruyarak çöz,
  ilgili testleri koş.
- lafmaliyet'teki "inceleme" CI işi (otomatik Claude incelemesi) kodla ilgisiz olarak 0,5 sn'de düşüyor; asıl CI
  "Tip · Lint · Test · Derleme"dir.
- Sahibin üslubu: **hızlı git, emin olduğun kontrolleri tekrarlama**; mantıksız bir şey görürsen sor; "sorularını da sen
  test edip gör".

## 6. Kurallar

- Canlı veritabanına ve canlı sitelere istek yok; veri düzeltmeleri (Faz 0) sahibin işidir.
- main'e doğrudan push yok; yalnız PR ile birleştir. `data/` ve `.env` asla commit'lenmez.
- Gövde v1: yalnız ekleme; okuyan taraf yeni alanı `.optional().catch(undefined)` ile okur (hiçbir alan günü 400'lemez).
- Şema değişikliği: lafpos ve lafmaliyet `npm run db:generate`; laffogato `db/migrations` + `npm run db:bundle`.
- KVKK: gövdeye kişi adı girmez (yalnız `personKind`, personel kimliği `s:<id>`).
- Commit ve PR ekleri: kendi oturumunun Co-Authored-By / Claude-Session satırları.

## 7. Kullanım limiti

`get_session` / `list_events` (rate_limit_event) ile 5 saatlik ve haftalık kullanımı izle (send_later ile düzenli kontrol).
**%99'a gelince dur:** iş akışlarını durdur, yarım işi her dalda WIP commit'i olarak push'la, `DEVAM.md` §2'yi güncelle,
notlar dalına push'la ve sahibe bir sonraki oturum için aynı ayrıntıda devam promptu ver. Haftalık limit 30 Kasım
~18:20 UTC'de yenilenir (24.11 06:40'ta %81'di).

## 8. Sahibin bekleyen işleri (kod dışı; bitişte hatırlat)

- laffogato `docs/API-MOBILE.md`'yi `RiosenBeq/lafmobil`'e bayt bayt kopyala ve oradaki `RECONCILED` SHA-256'yı güncelle (ayrı PR).
- Faz 0 verisi: Tuzla sabit giderlerinde Şube = Tuzla; Tuzla kirasının resmi tutarı ve brüt/net temeli; Marina kira kalemi
  (Aralık'tan, şirket); haftalık "Part-time çalışan" kalemine bitiş ayı 2026-11; yemek kartı bayrağı Alper ve Cem.
- POS oranları iki şubede %2 (Ayarlar'dan düzenlenebilir).
- lafmaliyet Actions'taki Claude anahtarı/kotası ("inceleme" işi).
- LafPOS'ta her çalışanı Yönetim › Personel'den ladmin'deki doğru kaydına bağla (LM-4b birleştikten sonra liste dolar).
- Marina'ya Tuzla'dan farklı şube fiyatı girmeden önce LP-E ve LM-5 birleşmiş olmalı; uygulamanın masanın şubesini nasıl
  öğreneceği (`table.branch`) sahibin kararı.
- Marina'nın Kasım ModPOS listesi Satışlar kartında "21 Kasım'a kadar" görünmüyorsa listeyi yeniden yükle.
