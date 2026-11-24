# Hesap uyumu: devam belgesi

Bu belge, kullanım limiti dolmadan önce yarım kalan işi sonraki oturuma devreder. Asıl görev metni ilk zamanlanmış
görevde (trig_018sKdewMdDPUWtFmPeiZm7e) ve bu oturumun başındadır; bağlayıcı karar ve sözleşme `CONTRACT.md`'de,
sahip kararları `NOTES.md` ve `CONTRACT.md` §1'de, kod haritaları `maps/`'te. Bu klasör lafpos deposunun
`claude/hesap-uyumu-notlar` dalında `docs/devam/hesap-uyumu/` altındadır (main'e birleşmez, yalnız saklama).

## 1. Ortamı geri kur (yeni kapsayıcıda)

1. Depolar: lafpos zaten `/home/user/lafpos`. `add_repo` ile `okanberk-dev/lafmaliyet` (push) ve
   `okanberk-dev/laffogato` (push); `/home/user/lafmaliyet`, `/home/user/laffogato`'ya klonla, `register_repo_root`.
2. Notlar: `git -C /home/user/lafpos fetch origin claude/hesap-uyumu-notlar` ve `docs/devam/hesap-uyumu/`'yi
   scratchpad'e kopyala (CONTRACT.md, NOTES.md, hesap-sozlesmesi.md, maps/, wave*.js). CONTRACT içindeki
   scratchpad yolunu yeni scratchpad yoluna göre güncelle (sed).
3. Dalları çek (WIP commit'leri dalların ucunda): lafpos `claude/sleepy-knuth-144kr7`, `claude/modpos-gecmis`;
   lafmaliyet `claude/hesap-uyumu-faz1`, `claude/modpos-donemi`; laffogato `claude/branch-prices`. Worktree:
   `/home/user/wt/lafpos-modpos` (claude/modpos-gecmis), `/home/user/wt/lafmaliyet-modpos` (claude/modpos-donemi),
   node_modules symlink'leri.
4. `npm ci` üç depoda. Postgres: `service postgresql start`; `CREATE USER ci WITH PASSWORD 'ci' SUPERUSER;`
   `CREATE DATABASE test OWNER ci;` `CREATE DATABASE laffogato_test OWNER ci;`.
5. Temel kontrol: lafpos `npm run typecheck && npm test`; lafmaliyet `npx next typegen && npx tsc --noEmit && npm run
   lint && npm test && TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test npm run test:db`.

## 2. Durum (24.11.2026 06:25 UTC, devam turu 2 sonu; 5 saatlik %90, haftalık %81; 5 saatlik pencere 07:50 UTC'de yenilenir)

**main'e birleşenler** (kullanıcı 05:47: "Şimdiye kadar bitenleri maine gönder ve devam et"; yığınlar için merge commit,
laffogato squash): laffogato#301 (LF-1); lafpos#167 (LP-A), #169 (LP-B), #168 (LP-D); lafmaliyet#124 (LM-1),
#125 (LM-2), #126 (LM-3), #123 (LM-M). Sahip işi: lafmaliyet "inceleme" (claude-code-action) işi 0,5 sn'de is_error ile
düşüyor (Actions'taki Claude anahtarı/kotası; kodla ilgisiz, #123'e yazıldı).

**Açık PR:** lafpos#170 (LP-C personel bağlantısı, taban main; 06:31'de main birleştirildi, 523a886; CI sürüyordu). Bu
oturum CI yeşil olunca birleştirmeye çalıştı; birleşmediyse sen birleştir (merge commit; LP-E bunun üstüne kurulacak).

**Bu oturum 06:35'te durdu** (kullanıcı: "%98'de dur, kalan işler için başka oturumda devam etsin"). Devam tetikleyicisi
SİLİNDİ; iş yeni oturumda sürer (§6).

**Yarıda kalan:**
- **LM-4 (Faz 5)**: lafmaliyet worktree /home/user/wt/lafmaliyet-faz5, dal claude/personel-sube-kira (2854165'ten; main'i
  birleştirmeli). Uygulama + belgeler commit'li (9af9f0a, 6489cb4); bağımsız inceleme bitti, düzeltme ajanı başlamıştı
  (bulgular: hatırlatıcı yolları ev sahibi türünü kullanmalı; paylaşılan kalemin bilgi satırı; şube görünümünde Excel
  net kâr ve başabaş işletme genelini dışlamalı; küçükler: Excel Personel sayfası, online sütunu, personel bağı tekilliği,
  ev sahibi penceresi, yemek kartı sürümü). Devam: aynı oturumdaysan Workflow({scriptPath:'/home/user/wt/scripts/wave3.js',
  resumeFromRunId:'wf_b17b5d95-acf', args:{ids:['LM-4']}}) (uygulama ve inceleme önbellekten gelir, düzeltme koşar).
  Bulguların tam metni: /root/.claude/projects/-home-user/087a595d-df9f-592b-88ce-6553c15994c5/subagents/workflows/wf_b17b5d95-acf/journal.jsonl.
- **Gün sonu tam otomatik (ÖNCELİK)**, kullanıcı 06:20: "lafposa girilenler eksiksiz lafmaliyete girsin; lafpos günü
  kapatırken POS'tan gün sonunu oraya giriyor; sadece gün sonu ladmine personel foto atsın"; 06:25: "Sorularını da sen
  test edip gör" (denetim iki sistemi yerelde uçtan uca çalıştırır). Betik /home/user/wt/scripts/gunsonu.js (denetim →
  LP-F + LM-6 → inceleme → düzeltme); worktree'ler /home/user/wt/lafpos-gunsonu, /home/user/wt/lafmaliyet-gunsonu, dal
  claude/gun-sonu-tam (origin/main'den, temiz). Denetim ajanı başlamıştı, sonuç yok: yeniden başlat
  (Workflow({scriptPath:'/home/user/wt/scripts/gunsonu.js'})).

**Sıradakiler:** LP-E (claude/sube-fiyati-kasa, LP-C'den), LM-4b (claude/personel-baglanti lafmaliyet, LM-4'ten),
LM-5 (claude/sube-fiyati, LM-4b'den). Tanımlar /home/user/wt/scripts/wave3.js (inceleyici artık tam takımı koşmuyor;
kullanıcı: "hızlı git, gereksiz kontrolleri fazladan yapma"). Biten her paket: push → PR (taban main) → CI yeşil →
main'e birleştir.

## 3. Kalan iş sırası

1. Yarım paketleri bitir (her biri: WIP commit'i incele, kapsamı tamamla, tam kontrol, düzgün commit; sonra
   bağımsız inceleme + düzeltme). Paket kapsamları `CONTRACT.md` §4, §5 (REVİZE), §7, §8.
2. Bitince push + taslak PR (başlık Türkçe; laffogato İngilizce), `subscribe_pr_activity`.
3. Dalga 2: LP-B (kasa zinciri, LP-A'dan) + LM-2 (ladmin Faz 2 okuyucu, LM-1'den; altın gövde ve kabul günü
   LP-A'dan). Dalga 3: LP-C (personel bağlantısı) + LM-3 (kasa zinciri okuyucu). Dalga 4: LP-E (şube fiyatı kasa)
   + LM-4 (personel, şube, kira). Dalga 5: LM-5 (şube fiyatı ladmin; LF-1'den sonra). LP-D'nin kasa tarafı LM-M
   ucuna bağlı.
4. Bitti tanımı: görev metni §7 (Faz 1–4 testleri iki depoda, §6 rakamları, Marina/Tuzla/Tümü, §5 kararları).

## 4. Başka bir Claude hesabında devam

- Gereken tek şey GitHub erişimi: o hesabın GitHub bağlantısı üç depoya yazabilmeli (`okanberk-dev/lafpos`,
  `lafmaliyet`, `laffogato`). Canlı sistem, gizli anahtar ya da bu oturumun dosyaları gerekmez; her şey dallarda.
- Aynı anda tek oturum çalışsın: ilk hesaptaki devam tetikleyicisi silinmediyse o oturum da başlar ve aynı dallara
  yazar. Önce birini durdur.
- `CONTRACT.md`'deki commit eki bu oturumun bağlantısını taşır: yeni oturumda kendi oturumunun eklerini kullan
  (sistemin verdiği Co-Authored-By / Claude-Session satırları).
- `CONTRACT.md`'deki `/tmp/claude-0/...` scratchpad yollarını yeni oturumun scratchpad'ine göre değiştir.

## 5. Dersler

- 4 çekirdek: iş akışı başına aynı anda 2 ajan. Ayrı depolar için ayrı iş akışları başlat.
- İş akışı içindeki ajana SendMessage atma: ikinci bir kopya başlar, ikisi aynı dosyalara yazar.
- e2e için `flock /tmp/lafpos-e2e.lock`, lafmaliyet test:db için `flock /tmp/lafmaliyet-db.lock`.
- Kullanıcı: Geçmiş ciro yükleme ekranı istemiyor; Uzaktan'da Geçen hafta 16–21 hiç görünmüyor; ayrıntılar
  ladmin'den otomatik; kasa Raporlar'da da görünsün.
- Canlı veritabanına ve sitelere istek yok; main'e doğrudan push yok (AGENTS.md).


## 6. Yeni oturumda başlangıç (24.11.2026)

1. §1'deki gibi ortamı kur: üç depo (`add_repo` push: okanberk-dev/lafmaliyet, okanberk-dev/laffogato), `npm ci`, Postgres
   (`service postgresql start`; `ci/ci` süper kullanıcı; `test` ve `laffogato_test` veritabanları).
2. Notları kendi scratchpad'ine kopyala: `git -C <lafpos> fetch origin claude/hesap-uyumu-notlar` ve
   `docs/devam/hesap-uyumu/` → scratchpad. İş akışı betikleri (`cont.js`, `wave2.js`, `wave3.js`, `gunsonu.js`) aynı
   klasörde: çalışma dizininden erişilebilen bir yere (ör. /home/user/wt/scripts) kopyala ve içlerindeki eski scratchpad
   yolunu (`/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad`) kendi scratchpad'inle
   değiştir (sed). Betiklerdeki depo ve worktree yolları /home/user/... altında; farklıysa onları da değiştir.
3. Worktree'ler (dallar uzakta): lafpos `claude/gun-sonu-tam` → /home/user/wt/lafpos-gunsonu; lafmaliyet
   `claude/gun-sonu-tam` → /home/user/wt/lafmaliyet-gunsonu; lafmaliyet `claude/personel-sube-kira` →
   /home/user/wt/lafmaliyet-faz5; her birinde node_modules ana klonun node_modules'üne symlink.
4. Sıra: (a) lafpos#170 açıksa CI yeşilse birleştir. (b) ÖNCELİK gün sonu tam otomatik: `gunsonu.js` (denetim iki
   sistemi yerelde uçtan uca çalıştırır → LP-F + LM-6 → inceleme → düzeltme); bitince push, PR (taban main), CI yeşilse
   birleştir. (c) LM-4: claude/personel-sube-kira'ya origin/main'i birleştir; inceleme bulgularını (§2) düzelten ajanı
   koş (wave3.js `LM-4` girişinin kapsamı + bulgular); push, PR, birleştir. (d) LP-E, LM-4b, LM-5 (wave3.js; tabanlar
   artık main ya da bir önceki paketin dalı).
5. Kullanıcı: "hızlı git, gereksiz emin olduğun kontrolleri fazladan yapma", "bitenleri maine gönder", "sorularını da
   sen test edip gör". Commit/PR ekleri yeni oturumun kendi Co-Authored-By / Claude-Session satırlarıyla.
