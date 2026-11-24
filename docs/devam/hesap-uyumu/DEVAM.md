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

## 2. Durum (24.11.2026 00:05 UTC, devam turu 1 sonu; 5 saatlik kullanım %95, haftalık %66)

Bitmiş, taslak PR'ı açık ve izleniyor (birleştirme sahibin işi):
| PR | Paket | Dal | CI |
| --- | --- | --- | --- |
| okanberk-dev/laffogato#301 | LF-1 site şube fiyatı | claude/branch-prices | ✓ |
| okanberk-dev/lafmaliyet#123 | LM-M ModPOS dönemi ucu + LM-M2 Satışlar kapsamı şube şube | claude/modpos-donemi | ✓ |
| okanberk-dev/lafmaliyet#124 | LM-1 Faz 1 | claude/hesap-uyumu-faz1 | ✓ |
| okanberk-dev/lafpos#167 | LP-A Faz 2 gönderen | claude/sleepy-knuth-144kr7 | ✓ |
| okanberk-dev/lafpos#168 | LP-D Faz 4 + Uzaktan | claude/modpos-gecmis | CodeQL düzeltmesi (b094866) sonrası yeniden koşuyordu; denetle |

Yarıda kalan (dalın ucunda "WIP (devam)" commit'i):
- **LP-B** kasa zinciri: lafpos `claude/kasa-zinciri` (LP-A'nın ucu 61aff3b'den). Yapılanlar (ajanın görev listesine göre): açılış önerisi + neden + sütunlar + denetim; nextOpening (giden kutusu yanıtı) + tembel devir GET; gider kategorileri + kasa hareketi kategorisi + cashMoves gövdesi. Kalan: arayüz (Günü aç öneri/neden, harcama kategori çipleri) + e2e akışı; docs/03, imza vektörleri, altın gövde + kabul günü yeniden üretimi, tam kontrol, commit; sonra bağımsız inceleme + düzeltme; taslak PR.
- **LM-2** ladmin Faz 2 okuyucu: lafmaliyet `claude/lafpos-gun-alanlari` (LM-1'in ucu c8559b8'den). Yapılanlar: şemalar (.catch), altın gövde + kabul günü kopyası, saklama sütunları + pos_day_revisions + göç, iptal→zayi, kind/personKind, errorCode, okcZNo, z toplamları, z.vat ile KDV hariç, Satışlar brüt/indirim sonrası + tutarlılık, kasa raporu/gün görünümü. Kalan: kabul DB testi (Marina Kasım), docs/LAFPOS.md, tam kontrol, commit; inceleme + düzeltme; taslak PR. NOT: LP-B'den sonra altın gövde değişecek; LM-2'nin altın kopyası LP-A'nınkiyle (61aff3b) eşleşmeli.

Henüz başlanmayanlar: LP-C, LM-3, LP-E, LM-4, LM-5 (CONTRACT §4). Sıradaki dalgalar: 3 = LP-C + LM-3, 4 = LP-E + LM-4, 5 = LM-5.
Betikler: /home/user/wt/scripts/ (cont.js finish→review→fix; wave2.js impl→review→fix); notlar dalında da kopyaları var.
Haftalık limit %66 (30 Kasım ~18:20 UTC'de yenilenir); bir 5 saatlik pencere ~%15 harcıyor.

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
