# LafPOS

L'Affogato'nun kendi satış noktası sistemi: masa planı, adisyon, bar/mutfak ekranı, ödeme, kasa ve gün
sonu, müşteri/cari, paket, rezervasyon, karaoke odası, raporlar ve patron paneli. Ürünleri
[laffogato](https://github.com/RiosenBeq/laffogato) sitesinden çeker, satış ve Z verisini
[lafmaliyet](https://github.com/RiosenBeq/lafmaliyet) paneline taşır.

- Geliştirilmiş istek ve kabul ölçütleri: [docs/00-GELISTIRILMIS-PROMPT.md](docs/00-GELISTIRILMIS-PROMPT.md)
- Referans POS'lar ve iki repo analizi: [docs/01-ANALIZ.md](docs/01-ANALIZ.md)
- Mimari, veri modeli, dalgalar: [docs/02-PLAN.md](docs/02-PLAN.md)
- Entegrasyon sözleşmesi: [docs/03-ENTEGRASYON.md](docs/03-ENTEGRASYON.md)
- Yazarkasa POS (TokenX Connect): [docs/04-YAZARKASA.md](docs/04-YAZARKASA.md)
- Tasarım sistemi (kasa ekranları, Innex yönetim paneli, telefon ve tablet): [DESIGN.md](DESIGN.md), ürün bağlamı [PRODUCT.md](PRODUCT.md), Innex tarifi [docs/ADMIN-INNEX.md](docs/ADMIN-INNEX.md)
- Claude Code skill'leri: [docs/SKILLS.md](docs/SKILLS.md)

## Çalıştırma

Gereken: Node.js 22.11 ya da üstü (üretimde Node 24 LTS önerilir).

```bash
npm install
npm run dev          # API :4000 + arayüz :5173 (aynı ağdaki tabletler http://<bilgisayar-ip>:5173)
```

İlk açılışta `data/` klasörü, veritabanı ve örnek veri (köşk masa planı, L'Affogato menüsü, personel)
oluşur. Örnek PIN'ler giriş ekranında yazar; canlıya geçmeden önce Yönetim › Personel'den değiştirin.

Kafede tek süreç olarak:

```bash
npm run build && npm start   # http://<bilgisayar-ip>:4000
```

## Ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın. Hepsi isteğe bağlıdır; boş bırakılan entegrasyon kapalı kalır.

| Değişken | Ne işe yarar |
| --- | --- |
| `LAFPOS_PORT` | Sunucu portu (varsayılan 4000) |
| `LAFFOGATO_URL` | Site adresi (varsayılan https://laffogato.net) |
| `LAFFOGATO_SYNC_SECRET` | Sitenin imzalı uçları (Tükendi yazma, online siparişler); sitedeki `LAFPOS_SYNC_SECRET` |
| `LAFMALIYET_URL`, `LAFMALIYET_SYNC_SECRET` | lafmaliyet'e günlük satış/Z itme, maliyet çekme; paneldeki `LAFPOS_SYNC_SECRET` |
| `TOKENX_*` | Yazarkasa POS (Token ÖKC) bağlantısı, bkz. `docs/04-YAZARKASA.md` |
| `LAFPOS_PUBLIC_URL`, `TOKENX_WEBHOOK_SECRET` | Yazarkasa sonucunun webhook ile gelmesi (yoksa LafPOS sorar) |

## Komutlar

| Komut | |
| --- | --- |
| `npm run dev` | geliştirme (API + arayüz, sıcak yenileme) |
| `npm run build` / `npm start` | üretim derlemesi ve tek süreç sunucu |
| `npm test` | birim ve API testleri (Vitest): para, adisyon hesabı, imza, yazarkasa sepeti, uçtan uca API akışı, renk kontrastı, arayüz kuralları, skill'ler |
| `npm run e2e` | gerçek tarayıcı (sistemdeki Chrome): her rol, her ekran telefon, tablet, bilgisayar ve koyu temada; akışlar (telefonda sipariş, tablette ödeme, yönetimde düzenleme, komut paleti). Önce `npm run build`; görüntüler `e2e/out/` |
| `npm run typecheck` | TypeScript denetimi (sunucu + arayüz) |
| `npm run db:generate` | şema değişince SQL göçü üret |
