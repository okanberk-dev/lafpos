# Kalan işler (devir notu)

Bu dosya, işi başka bir oturumun (ya da başka bir Claude'un) kaldığı yerden sürdürmesi içindir. Önce `AGENTS.md`'yi
oku; kurallar orada. Bitirdiğin maddeyi buradan sil, yarım bıraktığını "Durum" satırıyla güncelle.

Son güncelleme: 27 Kasım 2026.

## Main'de olanlar (bitti)

- **Kasa:** Pavo N86 (satış, iptal, eşleştirme, banka gün sonu; `docs/04-YAZARKASA.md` §8), lafmobil masa çağrıları,
  Windows 10'da düşük kaynak, deneme modu ve "Denemeyi bitir, gerçek kullanıma başla".
- **Kurulum ve güncelleme:** AsilPOS-Kurulum.exe her main push'unda GitHub Release; anahtarsız otomatik güncelleme
  (`/guncelleme/`, gün kapalıyken); Windows CI'da gerçek kurulum, güncelleme (75 kodu, `app.eski`, `node.yeni`) ve
  geri dönüş denemesi (`ci-kurulum.mjs`); Vercel kanalının derleme numarası commit zamanı (doğrulandı).
- **Site:** lafpos.laffogato.net'te e-posta, parola ve davet koduyla üyelik; İndir ve anahtarsız web kurucusu.
- **Merkez** (`/merkez`): dükkânlar, kayıt ve imza, lisans (14 gün deneme, bitişe 14 gün kala uyarı, süresi dolunca
  uyarı, 7 gün sonra satış kapanır; internetsiz kasada satış hiç kapanmaz, yalnız uyarı), şube kodu, seçerek
  güncelleme gönderme ve dükkân bazında "Şimdi güncelle", dükkân bazında uzaktan görünüm ve dükkân seçici.
- **Uzaktan raporlar:** bütün sekmeler ve CSV kasadakiyle birebir (`shared/remote-calc.ts`, `shared/report-csv.ts`),
  gün aşırı ödeme ve bugünkü kategori, "Raporları yeniden gönder".
- **Sağlamlık:** internet kesintisi e2e (`e2e/internet.mjs`), telefonda Yönetim şeridinde internet rozeti; tabletler
  kasaya ulaşamayınca siparişi bekletip kendiliğinden ve tam bir kez gönderir (`SendBatch`).
- **Patrona telefon bildirimi** (Web Push): büyük iptal ve ikram, kasa farkı, internet kesintisi, güncelleme ve Pavo
  sorunları; eşikler Yönetim › Ağ ve uzaktan erişim.
- **Bulut yedeği:** günlük şifreli yedek Vercel Blob'a (özel), buluttan geri yükleme sihirbazı (patron, PIN).
- **Karşılama sihirbazı:** Genel bakış'ta kurulum adımları.
- **Fiyat işareti:** sitede değişen fiyat, online sipariş ve karaoke kapalıyken de gün açıkken hemen eşitlenir.
- **Fiş yazıcısı kendiliğinden** (kablolu/USB): kasa kısayolu yazıcıları bildirir, tek fiş yazıcısını varsayılan yapar;
  Yönetim › Ayarlar ve yedek › Fiş yazıcısı (`docs/05-KASA-BILGISAYARI.md` §3). İndirim nedenleri Öğrenci ve Çalışan,
  dokununca %15. Sekmesiz ekranda üst çubuk yok (`DESIGN.md` Kabuk).
- **Her şey programın içinden:** Pavo'nun adresi ve seri no'su Yönetim › Yazarkasa POS'tan (ağda arama, kaydedince
  hemen eşleştirme; `docs/04-YAZARKASA.md` §8.1); lafmaliyet, Uzaktan, site, Token ve paket platformu anahtarları
  Yönetim › Bağlantı bilgileri'nden (hazır satırları yapıştırma da; `docs/05-KASA-BILGISAYARI.md` §2); "Şimdi
  güncelle" düğmesi (§6).

- **22 Kasım 2026 (#89-#102):** koyu tema "gece" (finans paneli dili) ve patron panelinde Kıyas; kaymalar (sol ray
  sabit); işyeri nüshası kaçmaz; internetsiz Tükendi; X/Z ve Uzaktan'da "Yazarkasadan geçmeyen"; telefonda yüzen alt
  menü ve alttan açılan Daha; **Uzaktan yönetim** (personel, PIN, roller, Tükendi, servis modu, panel erişimi;
  `docs/UZAKTAN-YONETIM.md`); patron panelinde dönem kıyası (hafta, ay, son 7 gün), ödeme dağılımı ve yeni sıra; **kasa
  güncellemesinde seçim** (Şimdi güncelle / Gün sonunda güncelle, kaldığı yerden devam; `docs/05-KASA-BILGISAYARI.md`
  §6); **tasarım sistemi AsilPOS Keel** (`DESIGN.md` §0, `src/styles/keel.css`, `.claude/skills/asilpos-design`).
  Marina Merkez'de otomatik güncellemede.
- **25 Kasım 2026 (#176 ve ardı; lafmaliyet#144):** kapanış saati hatırlatması (Ayarlar › Gün sonu ve Z; 30 dk kala
  sağ altta "Gün sonu al", kabuğun akışında, hiçbir şeyi örtmez), teslimde zorunlu **Kime** (Z, fiş, WhatsApp, gün sonu
  penceresi kişi kişi; lafmaliyet'e `cashMoves[].recipient`, orada satırın "Kime"si), **Ayrıntılı gün sonu** penceresi
  ("Kayda geçecekler", sonuçta özet), oturum kapanınca önbellek boşalır (sonra giren öncekinin verisini görmez).
- **Paket gelen kutusu şubeye ayrıldı:** Yemeksepeti ve Getir kaydı Vercel'de tanımlı restoranın kendi listesine girer
  (Getir'de de `GETIR_<ŞUBE>_RESTAURANT_ID`), kasa imzalı `?restoran=` ile yalnız kendininkini çeker ve siler; ortak
  kutuda başka restoranın siparişini silmez. Komut sayısı aynı (`docs/PAKET-PLATFORMLARI.md`).
- **Silinen deneme günleri Uzaktan'dan da kalkar:** "Denemeyi bitir" ve "Geçişi tamamla"nın sildiği tarihlere en geç
  5 dk'da boş gün raporu gider; gerçek günü ya da ModPOS günü olan tarih boşalmaz (`docs/07-UZAKTAN-ERISIM.md` §4).
- **26 Kasım 2026:** kapanış hatırlatması patronun telefonuna da gider (Web Push, tür `kapanis`; Yönetim › Ağ ve uzaktan
  erişim › Telefon bildirimleri › "Kapanış saati yaklaşınca", varsayılan açık; gün başına bir kez, yeniden açılan günde
  bir kez daha, bayat gitmez) ve kart ilk göründüğünde kasada bir kez kısa ses çalar; sitenin kabul etmediği bildirim
  (400) kuyruğu tıkamaz; kartın "Gün sonu al"ı önbellek tazeyken de pencereyi hemen açar.
- **Gün sonu e-postası Pavo'yu beklerken kaybolmaz (26 Kasım 2026):** 25 Kasım akşamı Marina'nın gün sonu e-postası
  gitmedi (ladmin sonucu taşıyan ikinci gövdeyi bekliyordu, gelmedi; gece bekleme bitmiyordu). AsilPOS Pavo bekleniyorsa
  ilk gövdeyi en çok 150 sn tutar, gün sonu bitince (ya da atlanınca) gün hemen ve tek gövdeyle gider; yeni alan
  `bankPosPending` (`docs/03-ENTEGRASYON.md` §4.10). ladmin tarafı (lafmaliyet aynı adlı dal) beklemeyi aynı istekte
  bitirir; e-postalar orada ortak, ferah ve telefona uygun tasarıma geçti.
- **Gün gitmediyse patron bilir (26 Kasım 2026):** kapanışta lafmaliyet gövdesi kurulamazsa gün kapalı kalır, kapanış
  200 döner, Pavo gün sonu ve kasa farkı bildirimi yine çalışır (otomatik gün sonu süreci düşürmez); lafmaliyet günü
  kalıcı reddederse (400/409/413/422) de sessiz kalmaz. İkisinde denetim kaydına alarm ve patrona bir kez telefon
  bildirimi (tür `lafmaliyet`: gün, neden, "Kasa › Geçmiş günler › Z › Gönder"; `docs/03-ENTEGRASYON.md` §4.11).
- **Banka gün sonu kâğıdının kıyas başlığı yeni adla (27 Kasım 2026):** "PAVO - ASILPOS KARŞILAŞTIRMA"
  (`src/lib/print.tsx` `BANKA_KIYAS_BASLIGI`); eski kasaların bastığı eski başlık `shared/eski-adlar.ts`
  `ESKI_BANKA_KIYAS_BASLIGI`'nde belgeli. ladmin'in kâğıt okuyucusu lafmaliyet#166 ile ikisini de tanır; bu sürüm ondan
  önce kurulursa yalnız yapay zekâ okuması kullanılamadığında kodla okuma kıyas satırlarını banka sayar (düşük güvenli
  tutar, kişi bakar). Bu yüzden lafmaliyet#166 önce birleşir.
- **Şube anahtarı (27 Kasım 2026):** şube başına ayrı AsilPOS Uzaktan anahtarı, isteğe bağlı (`docs/07-UZAKTAN-ERISIM.md`
  §6). Vercel'de `ASILPOS_CLOUD_SECRET_<ŞUBE>`, kasada Bağlantı bilgileri › AsilPOS Uzaktan › Şube anahtarı. O şubenin
  platform anahtarları, restoranının paket gelen kutusu, dükkânının özeti, raporları ve bulut yedeği, uzaktan yönetim
  komutları yalnız bu anahtarla; ortak anahtarı bilen başka şubenin kasası açamaz (`?sube=` ve `?restoran=` artık yetki
  sınırı). Anahtarı olmayan şube ve eski kasa eskisi gibi ortak anahtarla; bulut şube anahtarını tanımıyorsa kasa ortak
  anahtarla yineler (geçişte sıra önemsiz). ladmin'in dağıttığı ortak anahtar satırı ayrı, şube anahtarına dokunmaz.
- **Bağımlılık açıkları (27 Kasım 2026, Dependabot):** hono 4.13.23, @hono/node-server 2.1.11; drizzle-kit'in eski
  esbuild'i ve @vercel/blob altındaki eski zod `overrides` ile güncel sürüme bağlı. `npm audit` (üretim ve geliştirme)
  0. Kodumuz `csrf()`, `validator()`, `mount()`, `css` ve WebSocket kullanmıyor; yetki `/api/*` joker ara katmanında
  (satır sonlu yolda da çalıştığını ve ters eğik çizgili yolun 400 aldığını `tests/bagimlilik-guvenlik.test.ts` denetler).

## 1. Kafede ilk kurulumda bakılacaklar (sahibin ya da kafedeki birinin)

Kod hazır ve denendi; aşağıdakiler yalnız gerçek cihaz ve gerçek internetle görülür.

- **İlk kurulum:** AsilPOS-Kurulum.exe (ya da sitede İndir) ile kurulum; Yönetim › Bağlantı bilgileri › "Hazır
  satırları yapıştır"a bağlantı satırları (aşağıda; "deneme bittikten sonra" notlu satırlar o an atlanır). Genel
  bakış'taki Kurulum kartı adımları sırayla gösterir. İlk gerçek Windows'ta bakılacak: kaydedince bekçinin sunucuyu
  birkaç saniyede yeniden başlattığı ve ekranın "yeni bilgilerle açıldı" dediği.
- **Pavo:** Yönetim › Yazarkasa POS › Pavo › "Cihazı ağda ara" (ya da IP), seri no, Kaydet, Eşleştir; küçük bir
  deneme satışı ve "Cihazın son yanıtları". Ağda aramanın gerçek N86'yı bulduğu ilk kurulumda görülür.
- **Fiş yazıcısı:** yazıcı USB ile takılı ve sürücüsü kurulu; kasa ekranını kapatıp açınca Ayarlar ve yedek › Fiş
  yazıcısı'nda listelenmeli ve "Fiş buradan" yazmalı; "Deneme fişi yazdır" kasa bilgisayarında basılınca kâğıt çıkmalı.
- **Şimdi güncelle:** bu sürümden sonraki ilk yayında Ayarlar ve yedek › Sürüm ve güncelleme › "Şimdi güncelle";
  gün kapalıyken bir dakika içinde kurulup "Yeni sürüm kuruldu · Yenile" demeli.
- **Denemeyi bitir:** gün sonu, sonra Yönetim › Ayarlar ve yedek › Denemeyi bitir; yedeğin
  `C:\ProgramData\LafPOS\backups`'a yazıldığı ve kapanan hesapların Personel'den yeni PIN'le açıldığı görülür.
  Silinen deneme günleri AsilPOS Uzaktan › Raporlar'dan da birkaç dakikada kalkmalı.
- **İnternet:** kafede interneti kesip bir gün sonu; üst çubukta "İnternet yok · 1 kayıt bekliyor", internet gelince
  "Bekleyenler gönderildi" ve lafmaliyet'te gün bir kez.
- **Uzaktan raporlar:** kafe bağlanınca tarama yaklaşık bir saatte 400 günü iter; Raporlar › Ciro "Geçen ay"
  kafedekiyle aynı olmalı. Upstash › Usage'de günlük komut sayısı izlenir: uzaktan ekranın yoklaması koşullu (özet
  değişmediyse 304, tek küçük okuma), tek ekran gün boyu açıkken (12 saat açık gün, 12 saat gece) ekran ve kasanın
  itmesi günde ~5 bin komut (eskiden ~27 bin; `docs/07-UZAKTAN-ERISIM.md` §4 "Upstash bütçesi"). Merkez nabzı ve
  rapor itmesi bunun üstüne; ilk tam günde toplam bu düzeyde kalmalı.
- **Telefon bildirimi:** Uzaktan › Merkez › Telefon bildirimleri › "Bu telefonda aç" (iPhone'da önce Ana Ekrana
  Ekle); Yönetim › Ağ › "Deneme bildirimi gönder".
- **Bulut yedeği:** ilk gün sonundan sonra Ayarlar ve yedek › Bulut yedeği'nde "Son yedek" dolmalı.

Kafedeki bağlantı satırları (Yönetim › Bağlantı bilgileri'ne yapıştırılır). **Anahtarlar 21 Kasım 2026'da yenilendi:**
Vercel kayıtlarında kasanın 20 Kasım'daki istekleri siteden ve lafmaliyet'ten 401 almıştı (kasadaki anahtarlar
Vercel'dekilerle uyuşmuyordu), AsilPOS Uzaktan'a imzalı istek hiç gelmemişti. Üç projede anahtar yeniden üretildi
(laffogato ve lafmaliyet `LAFPOS_SYNC_SECRET`, `lafpos` projesi `LAFPOS_CLOUD_SECRET`; lafmaliyet ve `lafpos` projesinde
ad değişikliğinden önceki adlar, yeni kod ikisini de okur; laffogato'da ad bu; üretim yeniden yayımlandı) ve yeni satırlar sahibe dosya olarak verildi (`lafpos-kasa-ayarlari.env`,
21 Kasım). Mac'teki eski `~/Downloads/lafpos-kasa-ayarlari.env`
**geçersiz**. Dosya kaybolursa anahtarlar yeniden üretilir (`scripts/vercel/baglanti-kur.sh --yenile` ya da Vercel'de
elle) ve kasaya yeniden yapıştırılır; Vercel'deki değerler "sensitive", geri okunamaz. Kasa bağlanınca doğrulama: Yönetim
› Genel bakış › Sistem sağlığı ve Site ve lafmaliyet sayfasındaki durum satırları.

```
LAFMALIYET_URL=https://ladmin.laffogato.net
LAFMALIYET_SYNC_SECRET=...
ASILPOS_CLOUD_URL=https://lafpos.laffogato.net
ASILPOS_CLOUD_SECRET=...
LAFFOGATO_URL=https://laffogato.net        (deneme bittikten sonra)
LAFFOGATO_SYNC_SECRET=...                  (deneme bittikten sonra)
PAVO_URL=https://<cihazın IP adresi>:4567
PAVO_SERIAL=<cihazın seri numarası>
```

- **Gün sonu e-postası (26 Kasım 2026):** bu sürüm Marina'ya kurulduktan sonraki ilk gün sonunda ladmin'in e-postası
  gün sonundan en geç ~3 dakika sonra (Pavo'nun banka gün sonu bitince) tek e-posta olarak gelmeli; Pavo atlanırsa
  hemen. Gelmezse Yönetim › Entegrasyon'da lafmaliyet satırına ve ladmin › Ayarlar › AsilPOS kartına bakılır. ladmin'de
  gün sonu e-postasını yalnız Kasa › Rapor alıcıları alır (25 Kasım'dan beri).
- **Kapanış saati (25 Kasım 2026):** yeni sürüm Marina'ya kurulunca Yönetim › Ayarlar ve yedek › Gün sonu ve Z ›
  "Kapanış saati hatırlatması" açılıp saat girilir (varsayılan kapalı). Saat girilince patronun telefonuna da
  bildirim gider (Yönetim › Ağ ve uzaktan erişim › Telefon bildirimleri › "Kapanış saati yaklaşınca", varsayılan açık). Merkez'de Marina "Ben gönderince"yse yeni sürüm
  için Merkez › Marina › "Güncellemeyi şimdi gönder".

## 2. Sahibin kararını bekleyenler (sormadan yapılmaz)

- **Personel mesaisi:** 4 Kasım 2026'da sahibin kararıyla kaldırıldı (`docs/02-PLAN.md` "Mesai kaldırıldı"). Yeniden
  istenirse eski tasarım ve tablo (`time_entries`) duruyor; yalnız vardiya kasa sayımı kullanılıyor.
- **Marina şubesi (karar verildi, 21 Kasım 2026):** önce Marina AsilPOS'a geçer, Tuzla ModPOS'ta kalır. AsilPOS'un
  varsayılan şubesi `marina`; lafmaliyet'te AsilPOS'un şubesi Marina (`ASILPOS_BRANCH_ID`), başka şubeye ayarlı kasanın
  günü reddedilir. Marina'nın ModPOS'u yedek olarak çekilmeye devam eder (lafmaliyet'te şubenin kasa kaynağı ModPOS
  kalır); geçiş gününden sonra sayılan AsilPOS'un günüdür. Marina'da AsilPOS kurulup denenince lafmaliyet'te geçiş günü
  seçilir. Tuzla da geçecekse lafmaliyet'te AsilPOS'un şubesi listeye döner (ayrı iş).
- **Stok ve reçete düşümü:** lafmaliyet'in tasarımı aylık sayım ve dönemsel FIFO (`docs/STOK-DEGERLEME.md`); satıştan
  anlık düşüm yok. Kritik stok uyarısı isteniyorsa önce lafmaliyet'te anlık stok tasarımı gerekir.
- **Merkez için iki aşamalı giriş:** üye girişi davet kodu, parola ve deneme sınırıyla korunuyor. Telefonda doğrulama
  uygulaması (TOTP) isteğe bağlı eklenebilir; tasarım §4 madde 5'te, sahip isterse yapılır.
- **Kod imzası:** sertifika alınırsa izlenecek yol `docs/05-KASA-BILGISAYARI.md` §2 "Kod imzası"; alınmazsa
  "Yine de çalıştır" anlatımı kalır.
- **Kasa hareketi ladmin'e anında mı (25 Kasım 2026):** harcama ve teslim bugün gün sonu paketiyle (Z'den sonra)
  ladmin'e gider. Sahip "girildiği an gitsin" derse sözleşme değişir: lafmaliyet'te açık günün hareketleri için ayrı
  imzalı uç ve AsilPOS'ta senkron bütçesine (AGENTS.md kural 6) uyan itme gerekir. Sorulmadan yapılmaz.
- **Şube anahtarı kullanılsın mı (27 Kasım 2026):** kod hazır, varsayılan kapalı. Bugün yalnız Marina AsilPOS'ta;
  ikinci şube (Tuzla) AsilPOS'a geçince ya da paket platformları (Trendyol, Yemeksepeti, Getir) şubeye göre açılınca
  her şubeye ayrı anahtar verilmesi önerilir. Adımlar `docs/07-UZAKTAN-ERISIM.md` §6 (Vercel'de bir satır, kasada bir
  alan; birkaç dakika).
- **Vercel planı:** ekip ücretli planda görünüyor (21 Kasım faturası günde ~0,4 $, AsilPOS'un payı çok küçük). Kafe
  bağlanınca bir ay sonra Vercel › Usage ve Upstash › Usage bir kez bakılır.

## 3. Dış bilgi gelince yapılacaklar

- **Pavo bulut kanalı (UniCloud) ve masada ödeme listesi:** Pavo App Token ve belgeleri gelmeden tahmin yürütülmez
  (`docs/04-YAZARKASA.md` §8.4).
- **Yemeksepeti ve Getir canlı denemesi:** platformların verdiği anahtarlar ve test restoranı gerekir
  (`docs/PAKET-PLATFORMLARI.md`); aktarıcılar hazır.

## 4. Sıradaki geliştirmeler (öneri sırası)

1. **baslat.cmd güncellemeyle değişmez (bilerek):** kurulum klasöründe durur, otomatik güncelleme yalnız `app\`'i
   değiştirir. Çalışan toplu dosyayı değiştirmek güvenli değil (cmd.exe dosyayı satır satır okur). 21 Kasım'daki Node
   değişimi yeniden denemesi yeni kurulumlarda var; eski kurulumda değişim ertelenirse bir sonraki açılışta tamamlanır.
   Ad değişikliğinde (26 Kasım 2026) de baytları değişmedi: kurulu kasadakinden farklı olsaydı her açılışta "Kurulumu
   yenileyin" uyarısı çıkardı (`tests/asilpos-adi.test.ts` özeti sabitler).
2. **Ad değişikliğinin kalanları (ladmin ile birlikte):** (a) `docs/hesap-sozlesmesi.md` ladmin'deki kopyasıyla bayt
   bayt aynı kaldığı için eski adla duruyor; iki kopya aynı PR serisinde birlikte yeniden adlandırılır, iki depodaki
   SHA-256 sabiti birlikte değişir (ladmin'in ad değişikliği PR'ı bu dosyayı ya dışarıda bırakır ya da aynı baytlarla
   değiştirir). (b) bitti (Main'de olanlar, 27 Kasım). (c) Ayarlar dosyasına yazım eski adla (`shared/pos-env.ts`
   `yazilacakEnvAdi`); bütün kasalar bu sürümü geçince ve eski sürüme dönüş gerekmeyince yeni ada geçer.
3. **Tasarım turu:** dil AsilPOS Keel'e geçti (`DESIGN.md` §0); yeni ekran ve değişiklikler `asilpos-design` kontrol
   listesine uyar. Sırada ekran ekran ince ayar: adisyon ürün karoları, yönetim formları, raporların grafikleri.
4. **Şube başına ayrı kafe anahtarı:** bitti (Main'de olanlar, 27 Kasım); kullanmak sahibin kararı (§2).
5. **Merkez için iki aşamalı giriş (TOTP), tasarım notu (27 Kasım 2026; yapılmadı):** isteğe bağlı, üye başına, varsayılan
   kapalı. Bulut tarafı küçük ve tek yerde (`api/uzaktan.ts` üye girişi): üye kaydına (`UyeKaydi`) isteğe bağlı `t`
   (TOTP sırrı, `ASILPOS_CLOUD_SECRET`'ten türeyen anahtarla AES-GCM şifreli: Redis tek başına sızarsa sır açılmaz).
   `uzaktan/giris` parola tuttuktan sonra kayıtta `t` varsa `kod` ister: yoksa 401 `totp_required`, yanlışsa
   `bad_totp` (IP başına 15 dakikada 8 deneme aynen); RFC 6238, 30 sn, ±1 adım; kullanılan adım
   `${REDIS_ONEKI}totp:<eposta>` (EX 90) ile ikinci kez geçmez. `t`'siz üyenin girişi bugünkü gibi kalır. Uçlar üyenin
   kendi oturumuyla: `uzaktan/iki-adim/baslat` (parolayla; sır 10 dk bekler, yanıtta `otpauth://` adresi, karekod `uqr`),
   `.../onayla` (ilk kodla açar), `.../kapat` (parola ve kodla). **Neden şimdi yapılmadı:** (1) kurulum ekranı gerekir ve
   bugün her üyenin kendi hesabını yönettiği bir yer yok (Uzaktan yönetim › Erişim yalnız sahibin): yeni "Hesabım" yüzeyi
   (karekod, kod doğrulama, kapatma) ve giriş ekranında ikinci adım, `e2e/run.mjs` `ROUTES` ve tasarım turu ister;
   (2) telefon kaybında kurtarma tasarlanmalı: sahip Erişim'de üyenin iki adımını sıfırlar, sahibin kendisi için ortamdan
   tek seferlik yol (ör. `ASILPOS_UYE_IKI_ADIM_SIFIRLA=<eposta>`); (3) canlı Uzaktan girişini değiştirir: bir hata sahibi
   dışarıda bırakır, ayrı bir bağımsız inceleme ister. Sıra: bulut uçları ve testleri → giriş ekranında ikinci adım →
   Hesabım kartı → Erişim'de rozet ve sıfırlama. Örnek: ladmin'in isteğe bağlı iki adımlı girişi (lafmaliyet#154).
6. **ladmin'de eski günlerin "Kime"si:** lafmaliyet#144 birleşti (25 Kasım 2026). Ondan önce gelmiş alıcılı bir gün
   varsa ladmin "Kime"yi yeniden gönderimde doldurur (`planAsilposRecipientFill`); gerekirse Kasa › Geçmiş günler › Z ›
   "Gönder".

## Çalışma kuralları (kısa)

- Dal `claude/<konu>`; `main`'e doğrudan push yok, PR ile. Sahip main'e göndermeyi istedi: CI yeşilse PR birleştirilir.
- Commit öncesi `npm run typecheck && npm test`; arayüze dokunduysan `npm run build && npm run e2e`
  (`ASILPOS_E2E_CHROME=/opt/pw-browsers/chromium` bulut ortamında).
- Gizli değer hiçbir dosyaya ve commit'e girmez; `data/` ve `.env` asla.
- Sahip yazılımcı değil: arayüz ve belge dili sade Türkçe; ondan teknik adım istenmez.
