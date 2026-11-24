# Hesap uyumu görevi: çalışma notları

Görev: zamanlanmış görev trig_018sKdewMdDPUWtFmPeiZm7e (23.11.2026 16:55 UTC) ile başladı; metin konuşmada.

Depolar:
- /home/user/lafpos (dal claude/sleepy-knuth-144kr7, ilk lafpos PR'ı bu dalda)
- /home/user/lafmaliyet (push erişimi var; shallow clone; push: `git -c push.negotiate=true push -u origin BR`)
- /home/user/okanberk-dev/laffogato (yalnız okuma; şube fiyatı için push gerekirse add_repo push → /home/user/laffogato)

## §5 sahip kararları (23.11.2026 ~20:00 TR, AskUserQuestion)
1. Şube fiyatı: **Evet, gerekli** → önce laffogato (şube fiyat tablosu, geçerlilik anı, ?branch=), sonra ladmin ("eski fiyattan satış" raporu, "uygulandı" onayı gün sonu satırı birim fiyatından).
2. Personel kimliği: **Bağla**, kullanıcı notu: "zaten ladmin'de de hesapları var, doğru hesabı bağladığından emin ol" → users.staffRef + workedStaffRefs[] (ad yok); eşleşme doğrulanmalı (yanlış kişiye bağlanmasın).
3. Kasa hareketleri: **Evet, satır satır** → cashMoves[] ULID, ladmin lafpos_id tekil, elle eklenenle çift sayılmaz.
4. İşletme geneli giderler: **Bilgi satırı** → şube ekranında etiketli "işletme geneli payı (bilgi)", şube kârına karışmaz; Tümü'de bir kez.
5. Alış faturaları: **Bugünkü gibi** (bölünmez; transfer/şube stoku yok).
6. Çok şubeli LafPOS (ladmin): **Tuzla geçişine yakın** → bu turda ertelendi.
7. "Deneme" ödenmezi: **Ürün denemesi** → tüketim, raporda kalır.
8. 22.11 iptalleri: **Kural karar versin** (startedAt/readyAt → prepared).

## Kullanıcının ek isteği (görev sırasında)
- "LafPOS'a uzaktan siteden bakınca ModPOS'tan aldığımız/girdiğimiz veriler Marina için görünmüyor, onu da çöz"
  → LafPOS Uzaktan'da Marina'nın ModPOS geçmiş günleri (13–21.11) görünmeli. Faz 4'le birlikte (teşhis ajanı çalışıyor).

## İlerleme
- [ ] Anlama iş akışı (wf_ab1933f4-275), ikinci (wf_ef0d7080-7e3: şube fiyatı, personel, kasa hareketi)
- [x] Temel: lafpos typecheck ✓, test 3250 ✓; lafmaliyet tsc ✓ lint ✓ test 2815 ✓ test:db 62 dosya ✓
  (Postgres: `service postgresql start`; TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db)

## Ek sahip kararları (2. tur)
- POS oranı: iki şube %2, ayarlardan düzenlenebilir (branches.pos_rate NOT NULL DEFAULT 0.02).
- Personel yemek kartı: yalnız Marina (Alper, Cem); kişi başı bayrak.
- Part-time: haftalık sabit kalem Kasım'da kalsın, Aralık'tan günlük model (sahip günlük ücret, yemek, ek ücreti kendisi girer). Veri: kaleme endMonth 2026-11 (sahip).
- Dalga 1 ilk deneme durduruldu (4 CPU → iş akışı başına 2 ajan); ikiye bölünerek yeniden başlatıldı.
- Dalga 1: wf_2e107629-18d (LP-A, LP-D; görev www5xv2t1), wf_61c0f99a-841 (LM-1, LF-1; görev wtflsbl6a). Betik: workflows/scripts/wave.js (args.ids).
- Sonraki dalgalar: 2 = LP-B + LM-2; 3 = LP-C + LM-3; 4 = LP-E + LM-4; 5 = LM-5. wave.js'ye bu paketler eklenecek.

## Uzaktan (3. tur cevapları)
- Geçen hafta'da 16–21 HİÇ yok; veri hem LafPOS'a hem ladmin'e girilmiş ("sen kontrol et"); ayrıntılar ladmin'den otomatik; kasa Raporlar'da da görünsün. Yükleme UI'si YOK.
- Tasarım: ladmin GET /api/panel/pos/modpos-gunler (LM-M, worktree /home/user/wt/lafmaliyet-modpos) → kasa çeker → kasa raporları + Uzaktan'a kendi dükkân kimliğiyle gün raporu olarak iter. CONTRACT §5 yeniden yazıldı.
- 490 farkı: büyük olasılıkla "Bu ay"daki 23.11 açık günün satışı (hata değil).

## Ders: iş akışı ajanına SendMessage ATMA
- SendMessage bir iş akışı ajanına yeni (ikinci) bir kopya başlatır; iş akışındaki kopya mesajı görmez. LP-D'de iki yazar çakıştı.
- www5xv2t1 durduruldu. LP-D artık bağımsız ajan aa77d7a44f045fc9c (revize kapsam, worktree sahibi); bitince ayrı inceleme+düzeltme çalıştır.
- LP-A devamı: wf_84b1a65e-300 (görev wtpsqo9ts), betik wave-lpa.js (yarım iş diskte, devam ediyor).
- LM-M: wf_607bdc57-6d6 (görev woyeugot8), worktree /home/user/wt/lafmaliyet-modpos.
- LM-1 + LF-1: wf_61c0f99a-841 (görev wtflsbl6a).
- LM-M uygulandı (682fc28, push'landı). Sahip: ladmin'e nasıl girildiğinden emin değil; föy günleri → "sence" → HER ZAMAN gönder (kaynak foy, indirim null); KDV: yalnız karaoke %20. CONTRACT §9. LM-M inceleme/düzeltme bitince bu ek iş ayrı yapılmalı (iş akışındaki ajanlara mesaj atılmaz).
- LF-1 uygulandı (fcf6969, 0338e2c; push'landı), inceleme sürüyor.
- Sahip: Marina'da ModPOS bundan sonra HİÇ kullanılmayacak (ModPOS dönemi yalnız 13–21.11). CONTRACT §9.
- Sahip: devretme eşiği %95 (kontrol mesajlarındaki 0.92 yerine 0.95 uygula).

## Devam turu 1 (23.11 21:55 UTC, limit yenilendi)
- Ortam yerinde (aynı kapsayıcı); Postgres yeniden başlatıldı (yeniden başlatmalarda kapanıyor: `service postgresql start`).
- Betik: /root/.claude/projects/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/workflows/scripts/cont.js (finish → review → fix; LF-1 fixOnly).
- İş akışları (yeni transcript kökü /root/.claude/projects/-home-user/087a595d-df9f-592b-88ce-6553c15994c5/subagents/workflows): wf_f03d1753-489 (LP-A, LP-D; görev wl71dutnj), wf_2411716b-e05 (LM-1, LM-M; wqja3gba7), wf_365f15d7-8ae (LF-1; wabchxz47).
- 5 saatlik pencere 02:50 UTC'de yenilenir. Kullanım kontrolü send_later ile.
- LF-1 bitti: CLAUDE.md güncellendi (f260360), PR https://github.com/okanberk-dev/laffogato/pull/301 (taslak, izleniyor). Sahip işi: API-MOBILE.md'yi lafmobil'e kopyala.
- LM-M bitti → PR https://github.com/okanberk-dev/lafmaliyet/pull/123 (taslak, izleniyor). Ek iş LM-M2 (paylaşılan sales.coverage → Marina'nın LafPOS başlangıcı kayıyordu; şube kaydı okunacak): wf_236424c1-f3f (görev wsm1n1dke), aynı dal.
- Betikler artık /home/user/wt/scripts/ altında (çalışma dizini /home/user; eski yol Workflow'a kapalı).
- LP-A finish bitti (f7e8eb5, 9667895 push'landı), inceleme sürüyor. LP-D finish bitti (0594229, b872d20, 1736bea push'landı), inceleme sürüyor. LM-1 finish bitti (a295035, d9ee97d), düzeltme sürüyor (4 bulgu: Tuzla kapsamında komisyon yığılması [major], açılış ayı, liste dönemi komisyon metni, stopaj hücre kilidi).
- LM-1 bitti → PR https://github.com/okanberk-dev/lafmaliyet/pull/124 (taslak, izleniyor). Dalga 2 (LP-B + LM-2) LP-A düzeltmesi bitince başlayacak (betik /home/user/wt/scripts/wave2.js; LM-2 tabanı claude/hesap-uyumu-faz1, LP-B tabanı claude/sleepy-knuth-144kr7).
- LP-A bitti (61aff3b) → PR https://github.com/okanberk-dev/lafpos/pull/167 (taslak, izleniyor).
- LM-M2 bitti (4251ed7, c848aed) → PR #123 başlığı/gövdesi güncellendi.
- Dalga 2 başladı: wf_e7b5f94e-50f (görev w724suuun), LP-B (lafpos claude/kasa-zinciri, taban claude/sleepy-knuth-144kr7 @61aff3b) + LM-2 (lafmaliyet claude/lafpos-gun-alanlari, taban claude/hesap-uyumu-faz1 @c8559b8). Betik /home/user/wt/scripts/wave2.js.
- Açık PR'lar: laffogato#301 (LF-1), lafmaliyet#123 (LM-M+LM-M2), lafmaliyet#124 (LM-1), lafpos#167 (LP-A). LP-D son kontrolde (wl71dutnj).
- LP-D bitti → PR https://github.com/okanberk-dev/lafpos/pull/168 (taslak, izleniyor). İlk turun 5 paketi de PR'da: laffogato#301, lafmaliyet#123, #124, lafpos#167, #168.
