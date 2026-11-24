# Yerel ilerleme (24.11.2026, Mac)

- Kurulum tamam: ~/laf, PG16 :5433 (ci/ci; test, laffogato_test, test_gunsonu, test_faz5, test_seq), Node 24, flock.
- Temel kontrol yeşil: lafpos typecheck ✓, test 3461 ✓ (2 dosya yalnız yük altında süre aşımı; tek başına 40/40 ✓);
  lafmaliyet typegen/tsc/lint ✓, test 2906 ✓, test:db 67/67 ✓.
- lafpos#170 merge commit ile birleşti (70562a4).
- 10:5x İş akışları:
  - gün sonu: wf_fd5d6657-67d (görev w42arn8nb), betik ~/laf/scripts/gunsonu.js (Audit → LP-F + LM-6 → Review → Fix → Verify)
  - LM-4 bitirme: wf_e0e767d0-2be (görev wjc9rm7hv), betik ~/laf/scripts/lm4-fix.js (Fix → Review → Fix2)
- Sonra: push + PR + CI + merge (LP-F önce, sonra LM-6; LM-4), sonra LP-E, LM-4b, LM-5 (wave3.js, yollar yerel).

## Sahibin istekleri (sonda yapılacak)
- Bitince haber ver.
- Bitince "son 1 günde neler değişti"yi basit, güzel, yazılım bilgisi olmayan birine anlatır gibi özetle
  (23–24.11 main'e girenler: laffogato#301, lafpos#167 #168 #169 #170, lafmaliyet#123–#126 + bu oturumun PR'ları).

## Sahibin UI istekleri (24.11 ~11:30–12:00)
- Sahip: laffogato'nun tasarımı TAMAM, ona dokunma. UI parçaları yalnız LafPOS ve ladmin için, "uygun olacak şekilde".
  (Site SSS iş akışı wf_b2903ce3-77b durduruldu; laffogato claude/faq-chat dalı yereldi, silindi, hiç push'lanmadı.)
- Kaynaklar: ~/laf/scripts/ui-src/ (faq, notification-bell, toast, password-input; sayaç ladmin'de uyarlandı).
- İş akışı wf_f136bd88-172 (görev weumbjb5e) iki hat:
  - ladmin: dal claude/animasyonlu-sayac (wt lafmaliyet-sayac; sayaç 3e2b1ca2) → Bölüm 1 Yardım sohbet SSS,
    Bölüm 2 zil + bildirim kartı + şifre kutusu → inceleme → düzeltme.
  - LafPOS: dal claude/arayuz-hareket (wt lafpos-arayuz, origin/main 70562a4) → motion bağımlılığı, sayaç, YENİ
    "Sık sorulan sorular", sonra zil + bildirim kartı + şifre kutusu → inceleme → düzeltme.
  - Ekran görüntüleri ~/laf/scripts/ui-shots/{panel,lafpos}/.
- Bitince: iki PR (Türkçe), CI yeşil → merge; ekran görüntülerini sahibe gönder.

## Limit ve otomatik devam
- Sahip (11:45): "otomatik devam et". Tek seferlik CronCreate 005241c3 → 24.11 15:24 (limit 15:20'de yenilenir).
  Oturum içi; uygulama kapanırsa silinir. Her yeni limitte yenisini kur.
- Sahip: oturum High; Extra high gereken adımları iş akışında ajan başına effort:'xhigh' ile ver (hesap incelemeleri).
