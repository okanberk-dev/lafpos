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

## 2. Durum (12:15 TR)

**main'e birleşen (bu oturum):** lafpos#170 (LP-C personel bağlantısı, merge commit, 70562a4).

**GitHub'a push'lu, PR'sız dallar:**
- lafpos `claude/gun-sonu-tam` @ ed47223 — LP-F uygulaması (gün sonu eksiksiz: bütün banka gün sonları, yazarkasa
  belgeleri, kasa kayıtları gövdede). İş akışında bağımsız inceleme sürüyordu, sonra düzeltme + doğrulama.
- lafmaliyet `claude/personel-sube-kira` @ 1c0f5e9e — LM-4: 8 bulgunun hepsi düzeltildi (ed408a30 büyük 3 başabaş/Excel
  temeli; 56023d57, 04b38450, e6e745c2, c50c1d1a, 1c0f5e9e küçükler). İkinci inceleme bulguları düzeltiliyordu (fix2).
- lafmaliyet `claude/animasyonlu-sayac` @ d803447c — arayüz (ladmin): kayan sayaç (3e2b1ca2), Yardım sohbet SSS
  (1be450d8), zil + bildirim kartı + parola kutusu (d803447c). Sırada bağımsız inceleme + düzeltme.

**Yerelde yarım (push'lanmamış, ajan çalışıyordu):**
- lafmaliyet worktree `wt/lafmaliyet-gunsonu` (dal `claude/gun-sonu-tam`): LM-6 uygulaması commit'lenmemiş değişikliklerle.
- lafpos worktree `wt/lafpos-arayuz` (dal `claude/arayuz-hareket`, origin/main'den): arayüz Bölüm 1 (motion bağımlılığı,
  sayaç, YENİ "Sık sorulan sorular") commit'lenmemiş değişikliklerle.
  Limit gelirse yarım iş WIP commit'i olarak push'lanır (bkz. §4).

**İş akışları (bu oturumda resume edilebilir; yeni oturumda yeniden başlatılır):**
- gün sonu `wf_fd5d6657-67d` (`~/laf/scripts/gunsonu.js`): Audit ✓ → LP-F impl ✓, LM-6 impl … → Review → Fix → Verify
  (Verify: altın/kabul gövdeleri `cmp`, alan adları, uçtan uca yeniden koşu, personel sayfası yalnız foto ekran görüntüleri
  `~/laf/scripts/e2e-gunsonu/shots/`).
- LM-4 `wf_e0e767d0-2be` (`~/laf/scripts/lm4-fix.js`): Fix ✓ → Review ✓ → Fix2 …
- arayüz `wf_f136bd88-172` (`yerel/scripts/ui-hareket.js`): ladmin Part1 ✓ Part2 ✓(commit) → Review → Fix; LafPOS Part1 … →
  Part2 → Review → Fix. Ekran görüntüleri `~/laf/scripts/ui-shots/{panel,lafpos}/`.

**Otomatik devam:** sahip "otomatik devam et" dedi; oturum içi tek seferlik tetik 24.11 15:24 (limit 15:20'de yenilenir).

## 3. Sahibin bu oturumdaki kararları ve istekleri

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
