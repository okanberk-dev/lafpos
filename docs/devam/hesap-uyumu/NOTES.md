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
