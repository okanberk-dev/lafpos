# Devam planı (limit yenilenince, 27 Ekim 04:10 sonrası)

Kullanıcının isteği (26 Ekim gece): denetim bulgularını düzelt, diğer POS'ları en ince ayrıntısına kadar incele,
laffogato ve lafmaliyet bağlantısını kur, main'lere birleştir, Vercel'i çalıştır, yaptıkça GitHub'a gönder.
"Limit bitmesin; limit yenilenince kendini kur ve devam et."

## Durum (durdurulduğunda, 26 Ekim ~23:45)
- main = 9d3820c (#4) + fd0b1a1 (#5, uzaktan kurulum durumu ve scripts/vercel/baglanti-kur.sh). lafpos.vercel.app açılıyor;
  /api/uzaktan/kurulum → secret:false, password:true (kullanıcı ekledi), redis:false. Kalan: kullanıcı betiği çalıştıracak.
- Entegrasyon dalı claude/inceleme-duzeltmeleri = main (worktree ~/Downloads/lafpos-fix).
- Düzeltme dalları claude/fix-<alan> (worktree ~/Downloads/lafpos-wt-<alan>), taban 4d7dbc4. Bazılarında "YARIM: ..."
  commit'i var (kapılar çalışmadı). Hepsi GitHub'da.
- Durdurulan iş akışları:
  - Düzeltme: script `.../workflows/scripts/lafpos-fix-audit-wf_77d63ac3-e0e.js` (YARIM notu eklendi), runId
    wf_77d63ac3-e0e, args = `resume/fix-args.json` (aynen ver).
  - Araştırma: script `.../workflows/scripts/lafpos-pos-research-wf_7dbdc3f9-b7f.js`, runId wf_7dbdc3f9-b7f, args yok.
    Envanter ve sözleşme denetimi (contract:laffogato-lafmaliyet-vercel) bitti, önbellekte.
- Arka planda 10 dk'da bir push döngüsü (scratchpad/periodic-push.sh) ~05:20'de kendiliğinden biter.

## ÖNCE BU (kullanıcı 27 Ekim ~00:00 istedi): lafpos.vercel.app demo modu, şifresiz
Kullanıcının sözü: "ilk etapta demo verilerle yapayım giriş şifresi de koyma göreyim tasarım vs. ne nasıldır ona
göre yap maine push et". Vercel tarafı kurulu (secret, parola, Redis ✓; laffogato ve lafmaliyet 401 = anahtar okunuyor).
- Kural: gerçek kafe verisi her zaman parolalı. Demo kendiliğinden: Redis'te kafeden gelmiş gerçek özet yoksa demo
  özet parolasız sunulur; kafe ilk özeti itince demo biter, parola devreye girer. `LAFPOS_UZAKTAN_DEMO=0` demoyu kapatır.
- Demo özet: `scripts/vercel/demo-ozet.ts` geçici veritabanında seed + API ile gerçekçi bir gün kurar (açık masalar,
  bar kuyruğu, saatlere yayılmış kapalı adisyonlar, kıyas için geçmiş 4 hafta: zaman damgaları SQL ile kaydırılır),
  `buildSnapshot()` ile `api/demo-ozet.json` yazar (commit'lenir). Sunarken zaman damgaları şimdiye kaydırılır.
- api/uzaktan.ts: `/uzaktan/kurulum` `demo: true` döner; demo'da `/uzaktan/giris` parolasız token verir (ayrı demo
  token etiketiyle; gerçek özete erişemez), veri uçları demo özetini döner. Push gelince demo kapanır.
- RemoteLoginPage: demo'da parola alanı yok, "Demoyu aç" (ya da kendiliğinden gir); uygulamada üst şerit "Demo
  verileri: kafe bağlanınca gerçek veriler ve parola gelir".
- Testler (tests/cloud-api.test.ts): demo'da parolasız giriş; gerçek özet varken demo token reddedilir ve parola
  gerekir; LAFPOS_UZAKTAN_DEMO=0. Sonra typecheck, test, build; PR → main (merge commit), lafpos.vercel.app'te
  tarayıcıyla bak (telefon ve masaüstü), kullanıcıya göster.

DEMO TAMAMLANDI (PR #7-#9, 27 Ekim 00:15): lafpos.vercel.app parolasız demo açıyor. Not: kullanıcı kafe satırlarını
lafpos Vercel projesine de eklemiş ve LAFPOS_CLOUD_SECRET değeri değişmiş (kurulum secret:false); kafeyi bağlarken
`baglanti-kur.sh --yenile`.

## YENİ İSTEK (27 Ekim ~00:20): servis modu ve tasarım
Kullanıcının sözü: "seçenekler yap self servis, yarı self servis ve masaya servis gibi işletme ayarlarından
yapılsın ve buna göre sistem değişsin sistemi de sen kodla bunu da limit yenilenince yap ve tasarımı da daha güzel
yap beğenmedim".
- Servis modu (Yönetim › İşletme ayarları, patron): `self` (tezgâhta sipariş + önce ödeme, müşteri çağrı ekranından
  alır; masa ekranı ikinci planda), `yari_self` (tezgâhta sipariş + önce ödeme, masa no/numaratörle masaya
  götürülür), `masa` (garson masada sipariş alır, ödeme sonda; şimdiki akış). Mod; ana ekranı, menüyü, yeni satış
  akışını (önce öde / sonra öde), çağrı ekranını, masa numarası sorusunu, bar fişini, rol varsayılanlarını, raporları
  (servis türüne göre) belirler. Rakip araştırmasından (Toast/Square/Loyverse "dining options") ayrıntı al. Testler +
  e2e her üç modda. Para kuralları değişmez (yalnız akış).
- Tasarım: kullanıcı beğenmedi; cevabı (yön sorusu) bu dosyanın altına eklenecek. Düzeltmeler birleştikten sonra
  bütün kasa ekranları tek seferde (impeccable + frontend-design skill'leri, rakip ekranları), önce/sonra ekran
  görüntüleriyle kullanıcıya göster.

## Adımlar
1. `mcp__ccd_session_mgmt__get_usage`: 5 saatlik limit %25'in altında değilse bekle, yenilenme saatine yeni bir tek
   seferlik CronCreate kur ve dur.
2. İki iş akışını sürdür (resumeFromRunId + scriptPath; düzeltmede args = fix-args.json içeriği).
3. Push döngüsünü yeniden başlat (bittiyse).
4. Düzeltme sonuçları gelince: dalları claude/inceleme-duzeltmeleri'ne sırayla birleştir, çakışmaları çöz,
   typecheck + test + build + e2e. YARIM commit'lerin tamamlandığını doğrula.
5. Araştırma sonucu: buildNow listesinden uygulanacakları seç, alanlara bölüp yeni iş akışıyla yap (worktree başına).
   Sözleşme denetiminin bulduğu uyumsuzlukları LafPOS tarafında düzelt; laffogato/lafmaliyet tarafı gerekiyorsa
   kendi worktree'lerinde dal + PR (diğer oturumların çalıştığını unutma; main'e birleştirmeden önce CI ve inceleme).
6. Para değişikliklerinin bağımsız çekişmeli incelemesi (bellek kuralı), sonra PR → main (merge commit), Vercel
   doğrulaması, `npm run kurulum:windows`, GitHub Release v0.2.0 (.exe), push, hafıza dosyası (lafpos-project.md).
7. Kullanıcıya Türkçe rapor: ne düzeldi, Vercel betiği nasıl çalıştırılır, kafe ayarları, yapılacaklar.

## Tasarım yönü (kullanıcının seçimi, 27 Ekim ~00:22)
"Aydınlık ve sade": Apple tarzı beyaz zemin, az renk, bol boşluk, ince tipografi; her şey tek bakışta okunur.
Varsayılan tema açık olsun (koyu tema ayarda kalır). Innex yapısı (yönetim) korunur ama sadeleşir; kasa ekranları
aynı dilde. Önce/sonra ekran görüntülerini kullanıcıya göster.

## Durum 27 Ekim 04:53 (ikinci duraklatma)
- 04:17'de üç iş akışı birlikte sürdürüldü: düzeltme (wf_77d63ac3-e0e), araştırma (wf_7dbdc3f9-b7f), servis modu
  (wf_0df260f5-145, script `.../workflows/scripts/lafpos-servis-modu-wf_0df260f5-145.js`, worktree
  ~/Downloads/lafpos-wt-servis-modu, dal claude/servis-modu, main'den). 35 dakikada 5 saatlik limit %99 oldu.
- Hepsi durduruldu; commit'lenmemiş iş "YARIM:" commit'iyle kaydedildi ve GitHub'a gönderildi.
- DERS: aynı anda en fazla BİR iş akışı (6 ajana kadar). Sıra: (1) düzeltme iş akışını sürdür, bitince (2) servis
  modu, sonra (3) araştırma. Her sürdürmeden önce get_usage; saatlik kontrol zamanlayıcısı (85a1f0ed) açık.
- Servis modu scripti YARIM commit'ten habersiz: sürdürmeden önce BUILD istemine "dalda önceki denemeden commit'ler
  ve YARIM commit'i olabilir; önce git log origin/main..HEAD ile oku, tamamla, yeni commit'lerle ilerle" ekle.
- 9 Ekim değil 27 Ekim 09:10'da limit yenilenir; devam zamanlayıcısı 09:17.

## 27 Ekim 09:15: kullanıcı "Devam et ve ara ara maine merge et ayrıca sistemi web sitesinden kasa bilgisayar
görüntüsünde nasıl olacak onu da görebileyim ve tüm detaylı şekilde ince işleyerek yap sistemi"
- Düzeltme iş akışı sürdürüldü (wwcizrwh8; senkron tek mercek). Bitince: dalları claude/inceleme-duzeltmeleri'ne
  birleştir (taban 4d7dbc4, main o zamandan beri #4-#10 aldı: api/uzaktan demo, vercel.json git.deploymentEnabled),
  kapılar, PR → main (merge commit). Ara ara main: her büyük parça bitince, ama Vercel Hobby günlük 100 dağıtım
  sınırı var (main birleştirmesi = 1 üretim dağıtımı): günde birkaç birleştirme.
- Sonra servis modu iş akışını sürdür (build ve review önbellekte; follow-up kalan): BUILD/follow istemine YARIM notu.
- YENİ: web sitesinde kasa bilgisayarı görünümü. Plan: lafpos.vercel.app/kasa (ya da demo girişinde "Kasa ekranını
  dene"): gerçek LafPOS sunucusu tarayıcıda çalışır (Hono app.fetch + Drizzle sql.js/WASM SQLite, göçler ve seed
  paketlenir, fetch ve canlı olaylar sayfa içinde); bütün kasa ekranları (masalar, adisyon, ödeme, kasa, bar,
  yönetim) tam etkileşimli, veri tarayıcıda kalır, "Demoyu sıfırla". Node modülleri (crypto, fs, zlib) için tarayıcı
  karşılıkları; better-sqlite3 → sql.js eşdeğeri (senkron, transaction BEGIN/COMMIT). Tek iş akışı, kendi worktree'si.
- Tasarım yenilemesi (aydınlık ve sade) bundan sonra; kullanıcı web demosunda görecek.

## 27 Ekim 09:55: çalışma notları Downloads'a taşındı
Kullanıcı: "bunu tüm dosyalarını githuba push et ve şu anki yazdığım bilgisayarımın downloads klasörüne taşı öyle
devam et". Notlar artık ~/Downloads/lafpos-calisma/calisma/ (git worktree, dal claude/calisma-notlari, GitHub'da).
Bu PLAN.md ve fix-args.json buradan okunur/güncellenir. Çalışan düzeltme iş akışı eski scratchpad yollarını
(audit/group-*.json, finder probları) kullanıyor: o bitene kadar scratchpad kopyaları silinmez.
