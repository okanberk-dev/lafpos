AsilPOS (26 Kasım 2026'ya kadar adı LafPOS)

# AsilPOS

L'Affogato'nun kendi satış noktası sistemi: masa planı, adisyon, bar/mutfak ekranı, ödeme, kasa ve gün
sonu, müşteri/cari, paket, rezervasyon, karaoke odası, raporlar ve patron paneli. Ürünleri
[laffogato](https://github.com/RiosenBeq/laffogato) sitesinden çeker, satış ve Z verisini
[lafmaliyet](https://github.com/RiosenBeq/lafmaliyet) paneline taşır.

- Geliştirilmiş istek ve kabul ölçütleri: [docs/00-GELISTIRILMIS-PROMPT.md](docs/00-GELISTIRILMIS-PROMPT.md)
- Referans POS'lar ve iki repo analizi: [docs/01-ANALIZ.md](docs/01-ANALIZ.md)
- Mimari, veri modeli, dalgalar: [docs/02-PLAN.md](docs/02-PLAN.md)
- Entegrasyon sözleşmesi: [docs/03-ENTEGRASYON.md](docs/03-ENTEGRASYON.md)
- Yazarkasa POS (TokenX Connect): [docs/04-YAZARKASA.md](docs/04-YAZARKASA.md)
- Kasa bilgisayarı (Windows kurulum dosyası, Chrome kiosk, sessiz fiş yazdırma, otomatik başlatma): [docs/05-KASA-BILGISAYARI.md](docs/05-KASA-BILGISAYARI.md)
- Uzaktan canlı erişim (Tailscale; Vercel'de salt okunur AsilPOS Uzaktan): [docs/07-UZAKTAN-ERISIM.md](docs/07-UZAKTAN-ERISIM.md)
- Karar: tek sistem, iki yüz (ürünler laffogato panelinde): [docs/06-TEK-SISTEM.md](docs/06-TEK-SISTEM.md)
- Tasarım sistemi (kasa ekranları, Innex yönetim paneli, telefon ve tablet): [DESIGN.md](DESIGN.md), ürün bağlamı [PRODUCT.md](PRODUCT.md), Innex tarifi [docs/ADMIN-INNEX.md](docs/ADMIN-INNEX.md)
- Claude Code skill'leri: [docs/SKILLS.md](docs/SKILLS.md)

## Çalıştırma

Gereken: Node.js 22.11 ile 24 arası (üretimde Node 24 LTS önerilir). `package.json` `engines.node` üst sınırı
(`<25`) Vercel'in sessizce yeni ana sürüme geçmesini önler; Node 25 ya da üstüne geçiş ayrı bir iştir.

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

Windows kasa bilgisayarı için tek dosyalık kurulum (sahibin adımları aşağıda, "Windows'a kurulum"): `npm run kurulum:windows` →
`dist/windows/AsilPOS-Kurulum-<sürüm>.exe` (Node gerekmez; sunucu açılışta SYSTEM olarak başlar, veri
`C:\ProgramData\LafPOS`). Kafeye bu kurulur; kasaya giden dosyalar değişince CI onu Windows'ta derleyip dener
(`.github/workflows/windows.yml`). Git ile otomatik başlatma (`scripts/kasa/windows/kur.ps1`,
`scripts/kasa/mac/kur.sh`) yalnız geliştirici içindir: `docs/05-KASA-BILGISAYARI.md`.

## Windows'a kurulum

Kafedeki bilgisayara AsilPOS bir kez kurulur; sonraki sürümler kendiliğinden gelir. Komut yazmak, anahtar (token)
oluşturmak gerekmez. İki yol var: siteden kurulum (en kolayı, GitHub hesabı gerekmez) ya da GitHub'daki kurulum
dosyası. **İkisi de aynı programı kurar:** masaüstünde ve Başlat menüsünde **AsilPOS Kasa**, Windows açılınca
kendiliğinden açılan tam ekran kasa (adres çubuğu yok), aynı otomatik güncellemeler. Kasa ekranı açıkken AsilPOS Kasa'ya
yeniden basmak aynı pencereyi öne getirir; kapatınca kapanır (müşteri ekranı da), AsilPOS Kasa'yla yeniden açılır.
Biriyle kurulanı öbürüyle onarabilir ya da güncelleyebilirsiniz. Ayrıntı
[docs/05-KASA-BILGISAYARI.md](docs/05-KASA-BILGISAYARI.md) §3 ve §9.

### Siteden kurulum

**1. Girin.** Kafedeki bilgisayarda [lafpos.laffogato.net](https://lafpos.laffogato.net)'i açın. **Üye girişi**
e-posta ve parola sorar. İlk girişte ekranın adı **Üyeliği oluştur**'dur: e-postanızı ve size verilen **davet
kodunu** yazın, bir parola belirleyin (en az 10 karakter, iki kez). Sonraki girişlerde yalnız e-posta ve parola
sorulur; oturum 30 gün açık kalır.

**2. İndirin.** Kafe henüz bağlanmadıysa girişten sonra doğrudan indirme sayfası açılır; bağlandıysa menüde
**İndir**'e basın. Sonra **AsilPOS'u indir**. **AsilPOS-Kur.cmd** İndirilenler'e iner. Tarayıcı "sık indirilmiyor"
derse **Sakla**'ya basın.

**3. Çalıştırın.** Dosyaya çift tıklayın. Windows "Bilgisayarınız korundu" derse **Ek bilgi**'ye, sonra **Yine de
çalıştır**'a basın. "Değişiklik yapmasına izin verilsin mi?" sorusuna **Evet** deyin.

**4. Bekleyin.** Siyah bir pencere açılır; program internetten indirilir, doğrulanır ve kurulur (birkaç dakika).
Bitince kasa ekranı açılır; pencereyi Enter'la kapatın. Sonra aşağıdaki **4. Ayarlar** adımı.

Dosyayı yeniden çalıştırmak AsilPOS'u onarır ya da son sürüme günceller; verileriniz ve ayarlarınız kalır. Gün
açıkken çalıştırırsanız önce sorar.

### Kurulum dosyasıyla (GitHub)

**1. İndirin.** GitHub'a kendi hesabınızla girin, şu sayfayı açın:
[github.com/okanberk-dev/lafpos/releases/latest](https://github.com/okanberk-dev/lafpos/releases/latest).
"Assets" altındaki **AsilPOS-Kurulum.exe**'ye basın; dosya İndirilenler'e iner.

**2. Çalıştırın.** Dosyaya çift tıklayın. Windows "Bilgisayarınız korundu" derse **Ek bilgi**'ye, sonra
**Yine de çalıştır**'a basın (dosya imzasız olduğu için böyle der). "Bu uygulamanın değişiklik yapmasına izin
verilsin mi?" sorusuna **Evet** deyin.

**3. Kurun.** Başka bir şey sorulmaz: kurulum kendiliğinden biter, kasa ekranı açılır ve pencere kapanır (gün
açıksa yalnız "yine de şimdi kurulsun mu" diye sorar). Yeni bir sürüm çıkmışsa AsilPOS onu da hemen indirir, gün
kapalıyken kurar. AsilPOS arka planda çalışmaya başlar ve bilgisayar her açıldığında kendiliğinden
açılır. Kasa ekranı masaüstündeki **AsilPOS Kasa** kısayoluyla açılır. Tabletler ve telefonlar için adres ve
karekod: Yönetim › Ağ ve uzaktan erişim; kurulum gerekmez. iPad ve iPhone'da Safari › Paylaş › **Ana Ekrana Ekle** ile
uygulama gibi açılır; Android'de kafenin ağında yalnız kısayol eklenir (adres çubuğuyla açılır, tam uygulama için https:
[docs/05-KASA-BILGISAYARI.md](docs/05-KASA-BILGISAYARI.md) §5).

**4. Bilgileri girin (programın içinden).** Kasa ekranında patron PIN'inizle girin, **Yönetim › Bağlantı
bilgileri**'ni açın. Size verilen satırları "Hazır satırları yapıştır" kutusuna yapıştırıp **Satırları kaydet**'e
basın (ya da her bağlantının kartını tek tek doldurun). AsilPOS birkaç saniye içinde yeni bilgilerle kendiliğinden
yeniden başlar. Pavo yazarkasa: **Yönetim › Yazarkasa POS** › Pavo'yu seçin, **Cihazı ağda ara**'ya basın (ya da
cihazın IP adresini yazın), seri numarasını yazıp **Kaydet**, sonra **Eşleştir** ve cihazdaki onay ekranını onaylayın.
Dosya açmanız gerekmez; isterseniz Başlat › AsilPOS › AsilPOS ayarları aynı dosyayı Not Defteri'nde açar.

**5. Deneyin, sonra gerçek kullanıma başlayın.** AsilPOS ilk açılışta **deneme modundadır**: sahte satış ya da
müşteri yoktur, giriş ekranında örnek PIN'ler durur, her ekranın üstünde "Deneme modu: yapılan satışlar gerçek
sayılmaz" yazar; deneme satışları hiçbir yere gitmez. Kafede her şeyi deneyin. Bitince gün sonunu alın ve ekranın üstündeki deneme şeridinde
**Denemeyi bitir**'e basın (ya da Yönetim › Ayarlar ve yedek › Denemeyi bitir, gerçek kullanıma başla; yalnız patron): önce yedek alınır, deneme
kayıtları silinir, menü, personel, masalar ve ayarlar kalır; patron PIN'inizi değiştirirsiniz. Ayrıntı
[docs/05-KASA-BILGISAYARI.md](docs/05-KASA-BILGISAYARI.md) §2 "İlk açılış".

**Güncellemeler kendiliğinden gelir.** AsilPOS 3 dakikada bir yeni sürüm var mı diye bakar. Yeni sürümü indirir,
ama **yalnız gün kapalıyken** (gün sonundan sonra) kurar; satış sırasında hiçbir şey değişmez. Kurmadan önce
verilerin bir kopyasını alır. Yeni sürüm açılmazsa kendiliğinden eski sürüme döner. Durum Yönetim › Ayarlar ve
yedek › **Sürüm ve güncelleme** kartında yazar.

**Şimdi güncelle.** Beklemek istemezseniz Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme › **Şimdi güncelle**.
AsilPOS yeni sürüm var mı hemen bakar; varsa indirip kurar. Gün kapalıysa hemen kurulur; gün açıkken size sorar
(kurulum sırasında AsilPOS bir dakika kadar kapanır, tabletler bekler, açık adisyonlar kaybolmaz). Kurulum bitince kart
"Yeni sürüm kuruldu · Yenile" der. Kurulum dosyasıyla elle güncelleme de çalışır: yukarıdaki sayfadan son
AsilPOS-Kurulum.exe'yi indirip çalıştırın. Verileriniz ve ayarlarınız kalır.

**Otomatik güncellemeyi kapatmak.** AsilPOS ayarları'nda bir satır ekleyin: `ASILPOS_GUNCELLEME=kapali`. Açmak için
satırı silin. Kapalıyken de "Şimdi güncelle" çalışır.

**İnternet yokken.** Kasa, masalar, ödeme ve yazarkasa internetsiz çalışır. Bu sırada lafmaliyet'e, siteye ve
AsilPOS Uzaktan'a gidecek kayıtlar bekler; ekranın üstünde "İnternet yok · 3 kayıt bekliyor" yazar. İnternet
gelince hepsi bir kez gönderilir ve "Bekleyenler gönderildi" yazar. Her sistemin son gönderim saati Yönetim ›
Genel bakış › Sistem sağlığı'nda.

**Sorun olursa.**

- Kasa ekranı açılmıyor: "AsilPOS açılıyor" penceresi bir buçuk dakika bekler; açılmazsa Başlat › AsilPOS ›
  **Sunucuyu yeniden başlat**, bir dakika bekleyin (sunucu gelince kasa ekranı kendiliğinden açılır).
- Hâlâ açılmıyor: bilgisayarı yeniden başlatın.
- "Sorun var" ya da "Eski sürüme dönüldü" yazıyor: satış etkilenmez; sonraki sürüm gelince yeniden denenir.
  İsterseniz elle güncelleyin.
- Ne olduğunu görmek için: Başlat › AsilPOS › **Sunucu günlüğü**.
- Kaldırmak: Ayarlar › Uygulamalar › AsilPOS › Kaldır. Veriler ve yedekler silinmez
  (`C:\ProgramData\LafPOS`).

**Geliştirici notu.** `main`'e her push'ta GitHub Actions kurulum dosyasını Windows'ta derler, kafedeki sürümden bu
sürüme güncellemeyi ve kasa penceresini gerçek Windows'ta dener, sonra GitHub Release olarak yayımlar
(`.github/workflows/windows.yml`, `scripts/kasa/windows/kurulum/ci-kurulum.mjs`). Güncelleme kanalını Vercel'deki `lafpos` projesi (adı değişmedi) her derlemede
yazar (`npm run kanal` → `https://lafpos.laffogato.net/guncelleme/surum.json` ve uygulama zip'i; gizli anahtar
yok). Kasadaki güncelleyici `scripts/kasa/windows/kurulum/guncelle.mjs`; ayrıntı
[docs/05-KASA-BILGISAYARI.md](docs/05-KASA-BILGISAYARI.md) §6.

## Ortam değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayın. Hepsi isteğe bağlıdır; boş bırakılan entegrasyon kapalı kalır.
Açma sırası (anahtarlar → deneme gönderimi → geçiş günü): `docs/03-ENTEGRASYON.md` §8.
Kasanın değişkenleri `ASILPOS_*`; ad değişikliğinden önce yazılmış `LAFPOS_*` adları da okunur (aynı ayar iki adla
yazılırsa `ASILPOS_*` geçer), kurulu kasanın `ayarlar.env`'i yeniden yazılmaz (`docs/05-KASA-BILGISAYARI.md` §8).

**İki ayrı imza anahtarı:** sitede (laffogato) `LAFPOS_SYNC_SECRET`, panelde (lafmaliyet) `ASILPOS_SYNC_SECRET` (eski adıyla `LAFPOS_SYNC_SECRET`); değerleri
**ayrıdır** (`scripts/vercel/baglanti-kur.sh` ikisini ayrı üretir, iki adla yazar). AsilPOS'ta sitenin değeri `LAFFOGATO_SYNC_SECRET`'a,
panelinki `LAFMALIYET_SYNC_SECRET`'a yazılır; ikisi de sitenin `KARAOKE_SYNC_SECRET`'ından ayrıdır.

| Değişken | Ne işe yarar |
| --- | --- |
| `ASILPOS_PORT` | Sunucu portu (varsayılan 4000) |
| `LAFFOGATO_URL` | Site adresi (`https://laffogato.net`). Varsayılanı yok: boşken AsilPOS siteye hiç bağlanmaz (menü, görsel, online sipariş, Tükendi) |
| `LAFFOGATO_SYNC_SECRET` | Sitenin imzalı uçları (Tükendi yazma, online siparişler); sitedeki `LAFPOS_SYNC_SECRET` |
| `LAFMALIYET_URL`, `LAFMALIYET_SYNC_SECRET` | lafmaliyet'e günlük satış/Z itme, maliyet çekme (`https://ladmin.laffogato.net`); paneldeki `ASILPOS_SYNC_SECRET` (eski adıyla `LAFPOS_SYNC_SECRET`). Boşken gün sonu gitmez (elle aktarım); kurulum modunda kapanan gün (eğitim günü) hiç gitmez |
| `ASILPOS_CLOUD_URL`, `ASILPOS_CLOUD_SECRET` | AsilPOS Uzaktan (Vercel, salt okunur canlı özet; `docs/07-UZAKTAN-ERISIM.md` §4); Vercel'deki `ASILPOS_CLOUD_SECRET` |
| Platform anahtarları (Vercel'de) | Kasada değil, Vercel'deki `lafpos` projesinde şube adıyla: `<PLATFORM>_<ŞUBE>_<ALAN>`. ŞUBE kasanın Şube kimliğinden gelir (Yönetim › Ayarlar ve yedek; büyük harf, Türkçe harfsiz, harf ve rakam dışı atılır: `tuzla-2` → `TUZLA2`), Merkez'deki şube kodundan (`TZL`) değil. Tuzla'da önce kasada Şube kimliği = `tuzla` (yalnız patron), sonra Vercel'e `TRENDYOL_TUZLA_SUPPLIER_ID` (satıcı no), `TRENDYOL_TUZLA_API_KEY`, `TRENDYOL_TUZLA_API_SECRET`, `TRENDYOL_TUZLA_EXECUTOR_EMAIL`; kendiliğinden gelir. Marina'da Trendyol yok. Öneksiz eski adlar (`TRENDYOL_API_KEY` gibi) hiçbir kasaya gitmez: şube adıyla yeniden girin, eskileri silin (`docs/PAKET-PLATFORMLARI.md` › Anahtarlar buluttan) |
| `TOKENX_*` | Yazarkasa POS (Token ÖKC) bağlantısı, bkz. `docs/04-YAZARKASA.md` |
| `PAVO_URL`, `PAVO_SERIAL`, `PAVO_FINGERPRINT` | Yazarkasa POS (Pavo N86, kafenin ağında); adres ve seri no artık Yönetim › Yazarkasa POS'tan girilir, bu satırlar eski kurulumlar için. Bkz. `docs/04-YAZARKASA.md` §8 |
| `ASILPOS_PUBLIC_URL`, `TOKENX_WEBHOOK_SECRET` | Yazarkasa sonucunun webhook ile gelmesi (yoksa AsilPOS sorar) |

## Komutlar

| Komut | |
| --- | --- |
| `npm run dev` | geliştirme (API + arayüz, sıcak yenileme) |
| `npm run build` / `npm start` | üretim derlemesi ve tek süreç sunucu |
| `npm test` | birim ve API testleri (Vitest): para, adisyon hesabı, imza, yazarkasa sepeti, uçtan uca API akışı, renk kontrastı, arayüz kuralları, skill'ler |
| `npm run e2e` | gerçek tarayıcı (sistemdeki Chrome): her rol, her ekran telefon, tablet, bilgisayar ve koyu temada; akışlar (telefonda sipariş, tablette ödeme, yönetimde düzenleme, komut paleti). Önce `npm run build`; görüntüler `e2e/out/` |
| `npm run typecheck` | TypeScript denetimi (sunucu + arayüz) |
| `npm run kurulum:windows` | Windows kurulum dosyası (`dist/windows/`); NSIS gerekir (`brew install makensis`, `apt install nsis`; Windows'ta NSIS 3) |
| `npm run db:generate` | şema değişince SQL göçü üret |
