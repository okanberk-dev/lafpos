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

## 2. Durum (devretme anında doldurulur)

Devretme anı: 23.11.2026 18:10 UTC (21:10 TR), 5 saatlik kullanım %95. Bütün ajanlar durduruldu; yarım iş her dalın
ucunda "WIP (devam): …" commit'i olarak push'landı (o commit'i inceleyip düzgün commit'lerle tamamla, WIP'i ayrı bırakma
ya da squash'la).

| Paket | Dal | Durum |
| --- | --- | --- |
| LP-A (LafPOS Faz 2 gönderen) | lafpos `claude/sleepy-knuth-144kr7` | 3 commit (3269249 cardBasis, 7badde9 Faz 2 alanları + hesap sözleşmesi + kabul günü, 13085df şube kilidi). Uygulayıcı son kontrol/raporda durdu: tam kontrolü (typecheck, test, build, e2e) yeniden koş, kapsamı CONTRACT §4 LP-A'ya göre denetle, sonra bağımsız inceleme + düzeltme. |
| LP-D (Faz 4 + Uzaktan, REVİZE) | lafpos `claude/modpos-gecmis` (worktree /home/user/wt/lafpos-modpos) | Uygulama neredeyse bitti (e2e koşarken durdu); her şey WIP commit'inde. Görev listesi: ModPOS alanları, historyReport, Uzaktan etiketleri, ürün bloğu, pullModposDays + Entegrasyon düğmesi + imza vektörü, historyDays + kasa Raporlar + patronStats + buluta itme + liveTag yapıldı; kalan: tam kontrol + e2e + düzgün commit + rapor, sonra inceleme + düzeltme. CONTRACT §9 (föy günü kaynak/indirim null, KDV kuralı) uygulandığını denetle. |
| LM-1 (ladmin Faz 1) | lafmaliyet `claude/hesap-uyumu-faz1` | 2 commit (d6b88de −90, %8, POS komisyonu + şube oranı, hesap sözleşmesi; 7f8f8d9 komisyon şube kapsamı + marka belirsiz). Yarım: madde 6 (sabit gider bitişi + mükerrer gider uyarısı: src/lib/fixed-expense-rules.ts, src/lib/calc/duplicate-expense.ts, test) WIP'te. Kalan: madde 6'yı bitir, tam kontrol (test:db dahil), inceleme + düzeltme. |
| LM-M (ladmin ModPOS günleri ucu) | lafmaliyet `claude/modpos-donemi` (worktree /home/user/wt/lafmaliyet-modpos) | Uygulandı (682fc28), kontroller yeşil (rapor: scratchpad LM-M-impl.json, notlar dalında). İnceleme yarıda kaldı. Kalan: inceleme + düzeltme + CONTRACT §9 eki (föy günleri her zaman, `kaynak`, föy'de `indirim: null`, KDV: rapor dökümü → ModPOS dökümü → %10). |
| LF-1 (site şube fiyatı) | laffogato `claude/branch-prices` | Uygulandı (fcf6969, 0338e2c). İnceleme bitti: 3 küçük bulgu (LF-1-review.json): API-MOBILE.md lafmobil kopyası, CLAUDE.md:641 "fiyatın tek kaynağı" cümlesi, yeniden gönderilen branchPrice ile çakışanın ayrılamaması. Düzeltme ajanı yarıda kaldı (tests/sube/branch-price-routes.test.ts WIP'te). Kalan: düzeltmeyi bitir. |

Henüz başlanmayanlar: LP-B, LP-C, LP-E, LM-2, LM-3, LM-4, LM-5 (CONTRACT §4). PR'lar henüz açılmadı (paket inceleme +
düzeltmeden geçince taslak PR). Sahip kararları CONTRACT §1 ve §9, NOTES.md.

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
