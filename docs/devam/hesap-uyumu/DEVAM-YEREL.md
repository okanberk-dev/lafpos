# Hesap uyumu + arayüz: yerel (Mac) devam belgesi — 24.11.2026 12:15 TR

Bu oturum sahibin Mac'inde çalışıyor (önceki oturumlar bulut kapsayıcısındaydı). Asıl görev ve kurallar `DEVAM-PROMPT.md`'de
(özellikle §2b yerel kurulum, §4 iş sırası, §6 kurallar), bağlayıcı sözleşme `CONTRACT.md`. Bu belge yalnız bu yerel
oturumun durumunu ve yeni oturumun nereden başlayacağını yazar. Ayrıntılı günlük: `yerel/PROGRESS.md`.

## 1. Yerel ortam (Mac, `LAF=~/laf`)

- Depolar `~/laf/{lafpos,lafmaliyet,laffogato}`; worktree'ler `~/laf/wt/` (node_modules ana klona symlink; `next build`
  symlink'le çalışmaz, CI derler).
- **Postgres 16 kendi kümesi: port 5433** (5432 sahibin kendi Postgres 14'ü, dokunma). Başlatma:
  `LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D ~/laf/pgdata -o "-p 5433 -k /tmp" -l ~/laf/pgdata.log start`.
  Kullanıcı ci/ci; veritabanları `test`, `laffogato_test`, hat başına `test_gunsonu`, `test_faz5`, `test_seq`.
- Node 24: `export PATH=$HOME/.local/node/node-v24.22.2-darwin-arm64/bin:$PATH` (varsayılan 22.11). flock brew ile kurulu.
- 8 GB RAM: ağır komutlar `flock /tmp/laf-heavy.lock …`.
- Uyarlanmış iş akışı betikleri `yerel/scripts/` (yollar `~/laf`, port 5433, LOCAL ortam bloğu, commit eki yalnız
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`); bunları `~/laf/scripts/`'e kopyala.
- Gün sonu uçtan uca betiği `yerel/e2e-gunsonu/run.mjs` (+ `fake-pavo-server.mjs`) → `~/laf/scripts/e2e-gunsonu/`.
  Kullanım dosyanın başında (yalnız yerel; kendi DB'sini açar ve siler).
- Temel kontrol (24.11 sabah, main): lafpos typecheck ✓, test 3461 ✓ (audit-raporlar ve lafmaliyet-gecis yalnız yük
  altında süre aşımı; tek başına geçer); lafmaliyet tsc/lint ✓, test 2906 ✓, test:db 67/67 ✓.

## 2. Durum (25.11.2026 ~02:00 TR): İŞ TAMAM

**main'e birleşenler (bu yerel oturum, 24–25.11):**
- LafPOS: #170 personel bağlantısı (LP-C), #171 gün sonu eksiksiz (LP-F), #172 arayüz (sayaç, Sık sorulan sorular, zil,
  bildirim kartı, şifre kutusu), #173 şube fiyatı kasada (LP-E), #174 Pavo ayrıntılı Z belgesi, #175 son denetim belgeleri.
- lafmaliyet: #127 Faz 5 (LM-4), #131 arayüz, #132 gün sonu tam (LM-6), #134 personel bağlantısı okuyucu (LM-4b),
  #135 gün sonu fotoğraf okuma (LM-6b: ucuz model → güçlü model, OCR yedeği, yönetici e-postası), #137 şube fiyatı (LM-5),
  #140 LafPOS günü personel yalnız fotoğraf + son denetim düzeltmeleri, #138 metin temizliği.
- Son denetim (wf_eccd3678-c8f): sözleşme §1–§9 ve kabul rakamları iki depoda tamam; uçtan uca veri yolu eksiksiz.
- Öbür oturum lafmaliyet'te ai/* işleri yapıyor (#128–#130, #133, #136, #139): migration çakışması (0076) LM-5'te 0077
  olarak çözüldü; asistan bilgi bankası (`npm run asistan:bilgi`) belge değişince yeniden üretilmeli.

**Açık kod işi yok.** Sahibin kod dışı işleri §3'te.

## 3. Sahibin işleri (kod dışı) ve bu oturumdaki kararlar

Bekleyen sahip işleri: Maaşlar'da Alper ve Cem'e yemek kartı; haftalık "Part-time çalışan" kalemine bitiş 2026-11; kira
ev sahibi türü (Tuzla şahıs, resmi 100.000 brüt, şube Tuzla; Marina şirket, Aralık'tan); LafPOS'ta her çalışanı Yönetim ›
Personel'den ladmin kaydına bağlama; part-time günlük ücretin SGK'sız tam maliyet olduğunu onaylama; kasada
LAFFOGATO_SYNC_SECRET; canlıda bir kez yapay zekâsız fotoğraf okumasını (OCR) deneme; lafmobil API-MOBILE kopyası;
lafmaliyet Actions'taki "inceleme" anahtarı; Marina'nın Kasım ModPOS listesi.

Kararlar:

- "Ne gerekiyorsa kur, yazılım bilgim yok, önerdiğin en iyi şekilde ilerle."
- Arayüz parçaları (rare-ui: kayan sayaç, sohbet SSS, zil, bildirim kartı, parola kutusu; kaynaklar `yerel/ui-src/`)
  **yalnız LafPOS ve ladmin** için, "uygun olacak şekilde". **laffogato'nun tasarımı tamam: siteye dokunma.**
  LafPOS'ta SSS yoktu → yeni "Sık sorulan sorular" bölümü (cevaplar yalnız kodun/belgelerin gerçekten yaptığından).
  Güvenlik uyarlaması: parola gizliyken gerçek karakterler DOM'a yazılmaz.
- Oturum High; hesap incelemeleri iş akışında ajan başına `effort:'xhigh'`.
- Bitince: haber ver; ekran görüntülerini gönder; "son 1 günde neler değişti"yi yazılım bilmeyen birine basitçe anlat
  (laffogato#301, lafpos#167–#170, lafmaliyet#123–#126 + bu oturumun PR'ları).

## 4. Yeni oturumda başlangıç (yerel Mac)

1. `git -C ~/laf/lafpos fetch origin claude/hesap-uyumu-notlar` ve notlar worktree'sini güncelle; bu belgeyi,
   `DEVAM-PROMPT.md` §4/§6'yı, `CONTRACT.md`'yi oku. Postgres 5433'ü başlat (§1).
2. `yerel/scripts/*` → `~/laf/scripts/`; `yerel/e2e-gunsonu/*` → `~/laf/scripts/e2e-gunsonu/`.
3. Dalları getir ve worktree'leri kur (yoksa): lafpos `claude/gun-sonu-tam` → `wt/lafpos-gunsonu`, `claude/arayuz-hareket`
   → `wt/lafpos-arayuz`; lafmaliyet `claude/gun-sonu-tam` → `wt/lafmaliyet-gunsonu`, `claude/personel-sube-kira` →
   `wt/lafmaliyet-faz5`, `claude/animasyonlu-sayac` → `wt/lafmaliyet-sayac`. Uçlarda WIP commit'i varsa önce onu incele
   ve tamamla.
4. Sıra: (a) gün sonu LP-F + LM-6: inceleme → düzeltme → doğrulama (uçtan uca + personel yalnız foto ekran görüntüsü) →
   PR (önce LafPOS, sonra ladmin) → CI yeşil → merge commit; altın/kabul gövdeleri iki depoda bayt bayt aynı.
   (b) LM-4: kontrol (test:db `test_faz5`) → PR → merge. (c) Arayüz: ladmin ve LafPOS dalları inceleme → düzeltme → PR →
   merge; ekran görüntülerini sahibe gönder. (d) LP-E, LM-4b, LM-5 (`yerel/scripts/wave3.js` tanımları; tabanlar main).
   (e) Sahibe "son 1 gün" özeti.
5. Her paket: test önce → bağımsız inceleme → düzeltme → tam kontrol → push → PR (taban main, Türkçe; laffogato İngilizce)
   → CI yeşil → merge. lafmaliyet test:db birleştirmeden önce yerelde. Canlı sisteme istek yok; main'e doğrudan push yok.
