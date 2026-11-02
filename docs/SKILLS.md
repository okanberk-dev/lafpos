# Proje skill'leri (`.claude/skills/`)

Claude Code bu klasördeki her skill'i oturum başında tanır ve konusu gelince yükler. Dışarıdan alınanlar
lisanslarıyla birlikte kopyalandı; her birinin başında **"Bu projede"** bölümü var ve o bölüm skill'in geri
kalanından önce gelir. `tests/skills.test.ts` ön bilgiyi, kaynağı, lisansları ve bu listeyi denetler.

| Skill | Ne için | Kaynak | Lisans |
|---|---|---|---|
| `build-admin-panel` | Yönetim paneline alan eklemek: oku, kapsamı sor, kur, gerçek tarayıcıda doğrula. Yerleşim Innex, görünüm LafPOS Sade | `RiosenBeq/laffogato` @ `ab5c0ae` (operatörün kendi skill'i), LafPOS'a uyarlandı | depo içi |
| `impeccable` | Telefon ve tablet uyarlaması (`adapt`), teslim öncesi `audit` ve `polish`, kenar durumları (`harden`) | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) @ `3671d50` | Apache-2.0 |
| `webapp-testing` | Yerel uygulamayı gerçek tarayıcıyla sınamak (sunucu yaşam döngüsü, önce gözle sonra eylem) | [anthropics/skills](https://github.com/anthropics/skills) @ `b9e19e6` | Apache-2.0 |
| `verification-before-completion` | "Bitti" demeden önce kanıt: typecheck, test, build, e2e çıktısı | [obra/superpowers](https://github.com/obra/superpowers) @ `3be5aad` | MIT |
| `validate-data` | Rapor ve KPI asla yanlış değil: tanımlar, kıyas dönemi, mutabakat değişmezleri, hata ₺0 gösterilmez | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `data/skills/validate-data` @ `33d3dea` | Apache-2.0 |
| `web-interface-guidelines` | Arayüzü sade ve hatasız tutmak: erişilebilirlik, odak, form, dokunma, taşma, metin denetimi | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `command.md` @ `434b7f9` | MIT |

## Kararlar (26 Ekim 2026, operatör)

1. _"Admin panel görünümü için en güncel skills md dosyasını bul ve uyarla, mobil için de skills bul ve
   yap"_: en güncel admin paneli skill'i laffogato'daki `build-admin-panel` (23 Eki) ve onun görünüm
   kaynağı `docs/ADMIN-INNEX.md` (22-23 Eki) çıktı. Kaynağı olan Owais232/Admin-Panel-Skill-LLM-Models
   Temmuz'da, frontend-design-principles'ın kaynağı Temmuz'da kalmıştı.
2. _"Başka skills bul, aynı yapma"_: dışarıdan güncel skill'ler arandı. Panel için
   nextlevelbuilder/ui-ux-pro-max (MIT) denendi, mobil için impeccable (`adapt`), test için
   anthropics `webapp-testing`, doğrulama için superpowers `verification-before-completion` seçildi.
3. _"En iyisi laffogato admindeki Innex admin skills md'yi çek, ona göre yap panel tasarımını ve biraz
   daha geliştir"_: panel görünümü Innex'e döndü; ui-ux-pro-max'in önerdiği "Swiss + Fira" yönü ve skill'in
   kendisi kaldırıldı. Mobil, test ve doğrulama skill'leri kaldı. Geliştirmeler `DESIGN.md`
   "Yönetim paneli"nde.
4. _"yurt dışındaki sistemleri de araştır ve bunlara göre skills md dosyası varsa internette bak"_ (26 Ekim
   2026): raporların hiç yanlış olmaması için Anthropic'in veri eklentisinden `validate-data`, arayüzün sade
   kalması için Vercel'in Web Interface Guidelines'ı (`web-interface-guidelines`) alındı. İkisinin de "Bu
   projede" bölümü LafPOS kurallarına bağlar; Vercel kurallarından Title Case, `&`, `overflow-x-hidden`,
   `…` ile biten yer tutucu ve doğrudan `Intl` LafPOS kurallarıyla çakışır, LafPOS'unki geçerli.

5. _"tüm sistemdeki her parçası için sistem mantığı anlayışına uygun claude design ile tasarımlar yap ve yerleştir yazı
   tipi poppins ve benzeri kullan minimalist basit ve UI UX olarak üst düzey olsun her özelliği düşün ve tasarımı yap eğer
   özellik bende yoksa onu da kurgulayarak yap"_ (2 Kasım 2026): tasarımlar Claude Design tuvalinde yapıldı (tasarım sistemi,
   giriş, masalar, adisyon, bar ekranı, patron telefonda, mesai ve vardiya devri) ve kodda **LafPOS Sade** olarak yerleşti
   (`DESIGN.md`): Poppins harfler, Outfit rakamlar (Poppins'te tablo rakamı yok), sıcak kırık beyaz zemin, mürekkep birincil,
   durum mavisi ayrı, marka yeşili logo karosunda. Innex'in yerleşimi kaldı, renkleri ve Inter bıraktı;
   `tests/design-tokens.test.ts` yeni değerleri ve yazı dosyalarını sabitler. Eksik özellik olarak personel mesaisi
   (PIN'le giriş-çıkış, mesai çizelgesi) ve vardiya devri sayımı eklendi (`docs/02-PLAN.md`).

## Nasıl kullanılır

- Yeni yönetim ekranı: `build-admin-panel` (yöntem) + `docs/ADMIN-INNEX.md` (ölçüler) + `DESIGN.md`.
- Telefona ya da tablete uyarlama: `impeccable` `adapt`; bağlam `PRODUCT.md` ve `DESIGN.md`'de
  (impeccable'ın başlatıcısı depoda yok, "Launcher unavailable" yolu izlenir).
- Arayüz değişikliğini doğrulamak: `npm run build && npm run e2e` (`webapp-testing`), sonra
  `verification-before-completion` tablosundaki komutlar.
- Ekranı sadeleştirmek ya da gözden geçirmek: `web-interface-guidelines` (çakışan kurallar skill'in başında).
- Rapor ya da KPI eklemek, değiştirmek: `validate-data`; değişmez `tests/report-reconciliation.test.ts`'e eklenir.
