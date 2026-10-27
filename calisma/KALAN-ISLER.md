# LafPOS: kalan işler (27 Ekim 2026, 10:20)

Bu dosya başka bir bilgisayarda devam etmek içindir. Her şey GitHub'da (`RiosenBeq/lafpos`). Ayrıntılı geçmiş:
`calisma/PLAN.md`. Kurallar: depodaki `AGENTS.md` (para kuruş, yetki sunucuda, denetim kaydı, `patchOf`, Türkçe metin,
`data/` ve `.env` asla commit'lenmez, dal `claude/<konu>`, PR başlığı Türkçe, main'e doğrudan push yok).

## Şu an nerede

| Dal | Durum |
|---|---|
| `main` (bdba285) | Yayında. lafpos.vercel.app parolasız demo gösteriyor (PR #4-#9); PR #10 `claude/**` dallarının Vercel önizlemesini kapattı |
| `claude/inceleme-duzeltmeleri` (58856f9) | Entegrasyon dalı = main'in PR #9 hâli (PR #10'u almadı) |
| `claude/fix-adisyon-oda` · `fix-odeme-indirim` · `fix-yazarkasa` · `fix-raporlar` · `fix-senkron` · `fix-yetki-girdi` · `fix-arayuz` | Denetimin 74 bulgusunun düzeltmeleri. **Hepsi bitti**: bulgu yeniden üretildi, kökten düzeltildi, test eklendi, bağımsız gözden geçirildi, gözden geçirme bulguları da düzeltildi (her dalda `tests/audit-<alan>.test.ts`). Taban 4d7dbc4. **main'e birleştirilmedi** |
| `claude/servis-modu` (beb2310, main'den) | Self servis / yarı self servis / masaya servis (Yönetim › İşletme ayarları). Kodlandı, testler ve build geçti, gözden geçirildi; **gözden geçirmenin 6 bulgusu düzeltilmedi** (aşağıda) |
| `claude/calisma-notlari` | Bu notlar: `calisma/` (plan, denetim bulguları, araştırma, iş akışı betikleri) |

Denetim sonuçları: 74 bulgunun 65'i düzeltildi, 8'i önceki commit'lerde zaten düzelmişti, 1'i (money-13) gerçek
değildi. Gözden geçirme 29 yeni sorun buldu, hepsi düzeltildi.

## Sırayla yapılacaklar

### 1. Düzeltme dallarını birleştir ve main'e al
- `claude/inceleme-duzeltmeleri`'ne önce `origin/main`'i, sonra 7 `claude/fix-*` dalını sırayla birleştir.
- Çakışma beklenen yerler:
  - `server/services/orders.ts`: adisyon-oda, odeme-indirim, yazarkasa
  - `api/uzaktan.ts`: senkron dalı ile main'deki demo değişiklikleri (PR #7-#9), demoyu koru
  - `src/pages/order/PaymentModal.tsx`: odeme-indirim, arayuz
  - `docs/*.md`
- Tek migration var: `drizzle/0004_odeme_istegi.sql` (ödeme isteği kimliği, aynı ödemenin iki kez yazılmasını önler).
- Sonra kapılar: `npm run typecheck && npm test && npm run build && npm run e2e`.
  Demo özeti şema yüzünden bozulursa yenile: `LAFPOS_DEMO_OZET=1 npx vitest run tests/demo-ozet.test.ts`.
- Davranış değişiklikleri (istemci de uyumlu olmalı):
  - Adisyon iptali `siparis.al` ister. Oda sayacı çalışırken iptal 409 `room_running` döner.
  - Yazarkasada bekleyen sepet varken oda sayacı başlamaz.
  - Sitede ödenmiş sipariş taşınmaz, kasadan kapanmaz, oda ücreti almaz.
  - Hazırlanmamış kalem iptal edilince porsiyonu geri döner.
  - PIN denemeleri sınırlanır.
  - Rapor tarih aralığı en çok 400 gün; CSV formül enjeksiyonuna kapalı.
  - Yazarkasada kapanmış güne fiş iptali günü yeniden yazmaz.
  - Ayrıntı her dalın commit mesajlarında ve `calisma/is-akislari/` sonuçlarında.
- Para değişiklikleri için birleşik farkın bağımsız ve çekişmeli gözden geçirmesini yap (en az "kır" ve
  "gerileme" gözüyle); bulguları test ve düzeltmeyle kapat, sonra PR → main (merge commit).

### 2. Servis modunu bitir ve main'e al
`claude/servis-modu` dalında gözden geçirmenin bulguları; her biri için önce test, sonra düzeltme:
1. (yüksek) Yarı self: masa no kaydedilirken "Öde" ya da "Gönder"e yeniden basmak kalemleri bara iki kez gönderiyor.
2. Masa no'lu tezgâh satışı masaya taşınınca eski "Masa 12" kalıyor.
3. "Ayrı hesap" ile bölünen kalemlerde masa no düşüyor.
4. Masa no tuş takımı yalnız rakam alıyor; masa adlarında harf var.
5. Self modlarda yönetimdeki "Kasa ekranlarına dön" /masalar'a gidiyor.
6. Kapanmış günün ödenmiş adisyonunda masa no değişebiliyor ve denetime yazılmıyor.

Ardından e2e (yeni self ve yarı self akışları dahil) ve PR → main.

### 3. Web sitesinde tam etkileşimli kasa demosu
Kullanıcı istedi: "sistemi web sitesinden kasa bilgisayar görüntüsünde nasıl olacak onu da görebileyim".
- lafpos.vercel.app'te "Kasa ekranını dene": gerçek LafPOS sunucusu tarayıcıda çalışır. Hono `app.fetch`, Drizzle
  ile sql.js (WASM SQLite), göçler ve seed paketlenir, `fetch` ve canlı olaylar sayfa içinde.
- Bütün kasa ekranları tam etkileşimli: masalar, adisyon, ödeme ve hesap bölme, kasa ve gün sonu, bar, yönetim.
- Veri tarayıcıda kalır; "Demoyu sıfırla" düğmesi olur.
- Node modülleri (crypto, fs, zlib) için tarayıcı karşılıkları gerekir. better-sqlite3 yerine sql.js kullanılır,
  ikisi de senkron; transaction BEGIN/COMMIT ile yapılır.
- Kafe bağlanınca parolalı gerçek görünümle karışmamalı.

### 4. Tasarım yenilemesi (kullanıcının seçimi: "Aydınlık ve sade")
Apple tarzı: beyaz zemin, az renk, bol boşluk, ince tipografi, her şey tek bakışta okunur. Varsayılan tema açık,
koyu tema ayarda kalır. Kasa ekranları ve yönetim tek dilde (Innex yapısı sadeleşerek kalır). Önce/sonra ekran
görüntülerini kullanıcıya göster; 3. maddedeki demoda görünsün. Skill'ler: `impeccable`, `web-interface-guidelines`.

### 5. POS araştırmasını bitir ve eksikleri yap
- Hazır: LafPOS envanteri, Toast/Square, Lightspeed/TouchBistro, Loyverse/Odoo, Simpra/robotPOS, Türk kafe
  POS'ları (`calisma/arastirma/`).
- Kalan:
  - ModPOS incelemesi: kullanıcının Chrome'unda panel.gafdigi.com ve patron.gafdigi.com, yalnız okuma, hiçbir
    şey kaydedilmez.
  - Sentez ve eleştiri: `calisma/is-akislari/lafpos-pos-research-*.js` (sentez istemi orada).
- Çıkan "şimdi yap" listesini alanlara bölüp uygula.

### 6. laffogato ve lafmaliyet ile bağlantı
- `calisma/arastirma/contract-laffogato-lafmaliyet-vercel.md`'deki 12 maddeyi `claude/fix-senkron`'la karşılaştır.
  Örneğin M/L birleşmesi (sync-43) ve servis satırı orada düzeltildi.
- Kalanları uygun repoda dal + PR ile kapat. lafmaliyet'te başka oturumlar çalışıyor; main'e almadan önce CI ve
  inceleme.

### 7. Sürüm v0.2.0 (kafeye giden Windows kurulumu)
- `npm run kurulum:windows`: macOS'ta makensis, betik LC_ALL'u UTF-8 yapar.
- GitHub Release `v0.2.0` ve `.exe`. Kafe bilgisayarına kur.
- Uzaktan erişime veri yalnız 0.2.0 gönderir; 0.1.0 göndermez.

### 8. Vercel ve anahtarlar
- lafpos projesinde `LAFPOS_CLOUD_SECRET` artık okunmuyor (`/api/uzaktan/kurulum` → `secret:false`). Kafeyi
  bağlarken Mac'te `bash scripts/vercel/baglanti-kur.sh --yenile` çalıştır; anahtarları yeniden üretir ve kafe
  satırlarını `~/Downloads/lafpos-kasa-ayarlari.env`'e yazar.
- lafpos projesine yanlışlıkla eklenen kafe değişkenlerini sil: `LAFFOGATO_*`, `LAFMALIYET_*`, `LAFPOS_CLOUD_URL`.
- Üretim yalnız main'den. Upstash kurulumu bir keresinde bir dalı üretime yayınlamıştı.
- Günlük 100 dağıtım sınırı var (Hobby): main'e günde birkaç kez birleştir.

### 9. Operatörün yapacakları
- Token'a TokenX entegratör maili.
- Örnek PIN'leri değiştir, kurulum modunu kapat.
- Gerçek Windows bilgisayarda ve gerçek cihazla bir tur.
- Smart App Control ve kod imzalama kararı.

## Çalışma dersleri
- Claude kullanım limiti: aynı anda üç iş akışı 5 saatlik limiti 35 dakikada doldurdu. Aynı anda tek iş akışı
  (≤ 6 ajan) çalıştır, büyük işten önce kullanımı kontrol et.
- Düzeltme ve inceleme ajanları her alanda kendi git worktree'sinde çalıştı (`node_modules` ana klondan symlink).
- Para ya da durum değiştiren her şey main'den önce bağımsız, çekişmeli gözden geçirmeden geçer.
