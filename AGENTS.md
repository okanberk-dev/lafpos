# LafPOS: çalışma kuralları

Bu repoda çalışan her ajan ve geliştirici için.

## Okunacaklar

1. `docs/02-PLAN.md`: mimari, veri modeli, dalgalar.
2. `docs/03-ENTEGRASYON.md`: laffogato ve lafmaliyet ile sözleşme. Burada olmayan alan sistemler arasında gitmez.
3. Arayüze dokunacaksan `DESIGN.md` (kasa ekranları, Innex yönetim paneli, telefon ve tablet) ve `PRODUCT.md`.
   Yönetim paneline alan eklerken `build-admin-panel`, telefona uyarlarken `impeccable` skill'i
   (`docs/SKILLS.md`).

## Kurallar

1. **Para kuruş tam sayıdır.** Hesap yalnız `shared/order-calc.ts` ve `shared/money.ts` ile yapılır; sunucu
   her yazmada toplamları yeniden hesaplar, istemcinin gönderdiği tutara güvenilmez.
2. **Fiyatlar KDV dahildir.** KDV oranı satış anında kaleme dondurulur; ürünün oranı sonradan değişse de
   eski kalem değişmez.
3. **Yetki sunucuda denetlenir.** Her uç `requirePermission` ile korunur; istemcideki gizleme yalnız kolaylık.
   Personel maliyet ve kârı görmez (`rapor.maliyet`). Rol yetki setleri ayarlarda (`rolePermissions`,
   Yönetim › Roller ve yetkiler); patron rolü kilitli. `kasa.rakam` yoksa kasa uçları ara raporu ve beklenen
   nakdi göndermez (kör kasa).
4. **Hassas işlem denetim kaydına yazılır:** iptal, ikram, indirim, ödeme iptali, yeniden açma, kasa
   hareketi, gün sonu, fiyat değişikliği, senkron.
5. **Her yazma işlemi tek veritabanı işlemidir** ve bittikten sonra `bus.publish` ile ilgili konuya olay yayar.
6. **Senkron bütçesi:** laffogato'nun imzalı uçlarına 5 dakikadan sık otomatik istek yok. Herkese açık menü
   ucu ETag ile çekilir.
7. **Online ödenmiş sipariş tahsil edilmez** ve lafmaliyet satış listesine girmez.
8. **Arayüz metinleri Türkçe ve doğal**; başlıklarda sonda nokta yok. Dokunmatik hedefler en az 44 px.
9. Şema değişince `npm run db:generate` ile göç üretilir ve commit'lenir; elle SQL yazılmaz. Düzenleme (PATCH)
   gövdesi `patchOf(şema)` ile doğrulanır, `.partial()` ile değil: Zod 4'te `.partial()` varsayılanları uygular,
   gönderilmeyen alan varsayılanla ezilir (`tests/review-fixes.test.ts` denetler).
10. Commit öncesi: `npm run typecheck && npm test`. Arayüze dokunduysan ayrıca `npm run build && npm run e2e`
    (telefon, tablet, bilgisayar ve koyu temada tarama ve akışlar; 44 px altı hedef ve yatay taşma hata sayılır).
11. Yeni ekran ya da yönetim bölümü `e2e/run.mjs` `ROUTES`'a eklenir (`tests/ui-rules.test.ts` denetler).

## Git

- Dal adı `claude/<konu>`, PR başlığı Türkçe. `main`'e doğrudan push yok (ilk iskelet hariç).
- `data/` ve `.env` asla commit'lenmez.
