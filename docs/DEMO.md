# Tarayıcı demosu (lafpos.vercel.app/demo)

Kasa ekranlarını kurulum yapmadan denemek için: gerçek LafPOS sunucusu (aynı uçlar, yetkiler, hesap ve denetim
kaydı) tarayıcının içinde çalışır. LafPOS Uzaktan'la (salt okunur patron görünümü, kafeden gelen özet) ilgisi
yoktur; ayrı adres, ayrı veri.

## Nasıl çalışır

- `npm run build:demo` (`vite build --mode demo`) arayüzle birlikte sunucuyu da paketler: `dist/web/demo`. Yalnız
  Vercel derler (`vercel.json`, `/demo/*` buraya yönlenir); kasa derlemesine (`npm run build`) ve Windows paketine
  girmez. Oturum jetonu ayrı anahtarda (`lafpos.demo.token`): aynı alan adındaki Uzaktan'ı düşürmez.
- Veritabanı sql.js (WASM SQLite). `demo/db.ts` `server/db/client.ts`'in yerine geçer; göçler (`drizzle/*.sql`)
  ve kurulumdaki menü pakete gömülür. Yazan istek yanıtını veritabanı IndexedDB'ye kaydedildikten sonra alır.
  Kayıt önceki bir iş gününden kaldıysa demo yeni günle açılır (dünden açık gün satışı durdururdu).
- Arayüzün `/api/*` istekleri ağa çıkmaz, sayfadaki `app.fetch`'e gider (`demo/runtime.ts`); canlı olaylar da
  aynı yoldan (SSE). Dış sistemlere (laffogato, lafmaliyet, Uzaktan) istek gitmez; ürün görselleri sitenin
  küçültme ucundan gelir.
- Node modüllerinin karşılıkları `demo/shims/` altında; hangi modülün neye çevrildiği `demo/vite-plugin.ts`'te.
- Birden çok sekme (kasadan açılan müşteri ve çağrı ekranı): sunucuyu biri çalıştırır, diğerleri isteklerini
  ona iletir; o sekme kapanınca sıra diğerine geçer (`demo/tabs.ts`).
- İlk açılışta örnek gün kurulur (`demo/scenario.ts`): gün açık, kapanmış satışlar, açık masalar, mutfakta
  bekleyen kalemler, çalışan karaoke sayacı.
- PIN yok: son seçilen rolle (ilk açılışta Patron) girilir; üstteki şeritten rol değişir. Yetkili onayında PIN
  yerine "Müdür onaylasın" düğmesi. "Sıfırla" bu tarayıcıdaki demo verisini siler.
- Şeritte **servis modu** (masaya servis, yarı self, self) ve **Platform siparişi** (Yemeksepeti, Getir, Trendyol Go
  deneme siparişi; üstteki onay şeridinden kabul edilir). İkisi de patron adına kısa bir oturumla yapılır.
- Kafe bağlanana dek `lafpos.vercel.app` doğrudan demoyu açar; uzaktan görünüm (örnek özet) `?uzaktan=1` ile.

## Denetim

- `npm test`: sunucu testlerinin hepsi bir de sql.js ile koşar (vitest "sqljs" projesi); demonun parçaları
  `tests/demo-runtime.test.ts`, ilk gün `tests/demo-gunu.test.ts`.
- `npm run e2e`: demoyu kendisi derler; tarama ve akışlar (`e2e/demo.mjs`): PIN'siz açılış, ödeme ve yenileme,
  rol ve onay, iki sekme, sıfırlama.
- Yerelde: `npm run dev:demo` → http://localhost:5173/demo/
