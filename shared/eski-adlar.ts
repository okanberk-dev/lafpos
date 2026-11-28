/**
 * Eski adlar. Ürünün adı 26 Kasım 2026'da LafPOS'tan AsilPOS'a döndü; GitHub deposu `lafpos` adıyla kaldı. Buradaki
 * değerler eski adla durur, çünkü kurulu kasada (Windows nesneleri, veri dosyaları, tarayıcı depoları), telde (ladmin ve
 * site), cihazda (Pavo, Token) ya da bulutta (Upstash, Blob, imzalar) yazılıdır: biri değişirse kurulu kasa, eski sürüme
 * dönüş ya da öbür sistemler bozulur. Yeni ad yazılırken eski ad okunmaya devam eder (shared/pos-env.ts, ayarlar
 * dosyası, tarayıcı deposu, kurulum kodu).
 *
 * Kural: eski ad yalnız bu dosyada yazılır, TypeScript dosyaları değeri buradan alır. İçe aktaramayan betikler (.mjs,
 * .ps1, .nsi, .bat, .cmd, .sh, CI) ve belgeler eski adı yalnız `ESKI_AD_METINLERI`'ndeki metinlerle yazar.
 * tests/asilpos-adi.test.ts bunu denetler; ad değişikliği betiği de bu metinleri maskeleyip korur.
 */

/** Ürünün eski görünen adı ("eski adı" açıklamaları için) */
export const ESKI_URUN_ADI = 'LafPOS';

// ─── Ortam değişkenleri ──────────────────────────────────────────────────────

/**
 * Ortam değişkenlerinin eski öneki: kurulu kasanın ayarlar.env'i ve Vercel'deki değişkenler bu adla durur. Okuma
 * `ASILPOS_X ?? LAFPOS_X` (shared/pos-env.ts); ayarlar dosyasına yazan, dosyada yeni ad yoksa eski adı yazar
 */
export const ESKI_ENV_ONEKI = 'LAFPOS_';
/**
 * Eski güncelleyicinin yeni bekçiyi denerken verdiği değişkenler (guncelle.mjs). Kurulu kasadaki eski güncelleyici
 * bunları yazar: yeni bekçi bu adları hep okur
 */
export const ESKI_BEKCI_STDIN_ENV = 'LAFPOS_BEKCI_STDIN';
export const ESKI_GUNCELLEME_DENEME_ENV = 'LAFPOS_GUNCELLEME_DENEME';
/** Sitenin (laffogato) imza anahtarı ve şube listesi: site deposunda eski adla okunur */
export const SITE_ANAHTAR_ENV = 'LAFPOS_SYNC_SECRET';
export const SITE_SUBELER_ENV = 'LAFPOS_BRANCHES';
/** ladmin'in kasaya gönderdiği Uzaktan bağlantısı (`baglanti{}`): telde eski adla gelir (plan A3'e kadar) */
export const TEL_UZAK_ADRES_ENV = 'LAFPOS_CLOUD_URL';
export const TEL_UZAK_ANAHTAR_ENV = 'LAFPOS_CLOUD_SECRET';

// ─── Barındırma ve güncelleme kanalı ─────────────────────────────────────────

/** Uzaktan ve güncelleme kanalının alan adları: kurulu kasaların ayarlarında, eski kurucularda ve platform webhook'larında */
export const ALAN_ADI = 'lafpos.laffogato.net';
export const VERCEL_ALANI = 'lafpos.vercel.app';
/** Vercel projesi ve GitHub deposu adlarını korur */
export const VERCEL_PROJESI = 'lafpos';
export const GITHUB_DEPOSU = 'okanberk-dev/lafpos';
/** Güncelleme yükünün adı: eski güncelleyici `lafpos-app-<build>.zip`'ten başkasını reddeder (kanal.mjs, guncelle.mjs) */
export const UYGULAMA_ZIP_ONEKI = 'lafpos-app-';
/** Siteden kurulumun eski adı: ladmin bu adresten indirip iki boş satırını doldurur (kanal iki adla yayımlar) */
export const ESKI_WEB_KURUCU = 'LafPOS-Kur.cmd';

// ─── Kurulu kasa (Windows, macOS) ────────────────────────────────────────────

/** Klasör adı: Program Files\, ProgramData\ (veri) ve %LocalAppData%\ (tarayıcı profilleri) altında */
export const KURULUM_KLASORU = 'LafPOS';
/** Açılış görevi ve güvenlik duvarı kuralı */
export const SUNUCU_GOREVI = 'LafPOS Sunucu';
/** Veritabanı dosyası (eski güncelleyici ve geri yükleme bu adı arar) */
export const VERITABANI_DOSYASI = 'lafpos.db';
/** Yerel yedeklerin öneki (backups\<önek><gün>.db ve diğerleri) */
export const YEDEK_DOSYA_ONEKI = 'lafpos-';

// ─── İmzalar ve bulut ────────────────────────────────────────────────────────

/** Uzaktan işlem imzası (`<önek>:v<N>:…`) ve anahtar imzası (`<önek>-anahtar:v<N>:…`); Vercel ve kurulu kasalar aynı metni imzalar */
export const KONTROL_IMZA_ONEKI = 'lafpos-kontrol';
/** PIN özetinin öneki: kayıtlı PIN'ler bununla özetlendi */
export const PIN_IMZA_ONEKI = 'lafpos-pin:';
/** Bulut yedeğinin anahtar türetme bilgisi: eski yedekler bununla şifrelendi */
export const YEDEK_SIFRE_BILGISI = 'lafpos-yedek-v1';
/** Vercel Blob deposunun adı (Storage) */
export const BLOB_DEPOSU = 'lafpos-yedek';
/** Upstash Redis anahtarlarının öneki */
export const REDIS_ONEKI = 'lafpos:';

// ─── Cihazlar ────────────────────────────────────────────────────────────────

/** Pavo eşleştirme kimliği: cihaz eşleştirmeyi bununla saklar; kurulumun yeni kimliği `<bu>-XXXXXX` */
export const PAVO_KIMLIGI = 'LafPOS';
/** Pavo satışındaki uygulama adı (RefererApp) */
export const PAVO_UYGULAMA = 'LafPOS';
/** Token kablolu bağlantıda firma adı (IntegrationHub) */
export const TOKEN_FIRMA = 'LafPOS';

// ─── Tel (ladmin ve site) ────────────────────────────────────────────────────

/** POST /api/pos/gun `source` ve devrin (`nextOpening.source`) değeri */
export const TEL_KAYNAK = 'lafpos' as const;
/** POST /api/pos/gun `bankPos` içindeki kasa kartı alanı */
export const TEL_KART_ALANI = 'lafposCard' as const;
/** ladmin'in kurulum kodu ucu (eski yol; yenisi /api/asilpos/kurulum) */
export const ESKI_KURULUM_YOLU = '/api/lafpos/kurulum';
/** Sitenin gördüğü işlem yapan (masa listesi) ve istemci adı */
export const SITE_AKTOR = 'LafPOS';
export const SITE_ISTEMCI = 'LafPOS/0.1 (+kafe kasasi)';
/** Sitenin (laffogato) kasa belgesi: site deposu yeniden adlandırılmadı, belge bu adla durur */
export const SITE_BELGESI = 'docs/LAFPOS.md';
/**
 * Banka gün sonu kâğıdındaki (Pavo) kıyas bölümünün eski başlığı: 27 Kasım 2026'ya kadarki kasalar bunu basar, eski
 * fotoğraflarda da bu var. Yeni kasa yeni adla basar (src/lib/print.tsx `BANKA_KIYAS_BASLIGI`). ladmin kâğıdın
 * fotoğrafını okur: kodla okuyucusu (yapay zekâ kullanılamayınca) banka satırlarını bu başlıkta bitirir; lafmaliyet#166
 * ile iki adı da tanır (`PAVO (ASILPOS|<eski ad>) KARSILASTIRMA`, src/lib/photo-read/pavo-ocr.ts). O birleşmeden önceki
 * panel yeni başlığı tanımaz: kıyas satırlarını banka sayar, tutarlar düşük güvenli olur (yapay zekâ okuması etkilenmez)
 */
export const ESKI_BANKA_KIYAS_BASLIGI = 'PAVO - LAFPOS KARŞILAŞTIRMA';

// ─── Veritabanında duran değerler ────────────────────────────────────────────

/** products.sold_out_by: kasanın kapattığı Tükendi */
export const TUKENDI_KASA = 'lafpos' as const;
/** Pavo gün sonu kıyas tabanı: kasanın bildiği son batch (sync_state) */
export const PAVO_TABAN_KASA = 'lafpos' as const;
/** Açılış beklentisinin kaynağı: kasanın kendi sayımı (denetim kaydında) */
export const ACILIS_KASA = 'lafpos' as const;

// ─── Tarayıcı ────────────────────────────────────────────────────────────────

/** localStorage ve sessionStorage anahtarlarının eski öneki (src/lib/eski-depo.ts yenisine kopyalar, eskisini silmez) */
export const ESKI_DEPO_ONEKI = 'lafpos.';

// ─── macOS (git ile kurulan geliştirici kasası) ──────────────────────────────

/** launchd etiketlerinin kökü: kurulu ajanlar bu adla (kur.sh); kısayol dosyası `<KURULUM_KLASORU>-Kasa.command` */
export const MAC_ETIKETI = 'net.laffogato.lafpos';

// ─── Denetim (tests/asilpos-adi.test.ts) ─────────────────────────────────────

/** Windows yolu: düz metinde tek, JavaScript dizesinde çift ters bölüyle yazılır; ikisi de */
const yol = (...p: string[]) => [p.join('\\'), p.join('\\\\')];
const ESKI_DOSYA_ADI = KURULUM_KLASORU.toLowerCase();

/**
 * TypeScript dışındaki dosyalarda eski adla yazılabilen tam ortam değişkeni adları: yalnız eski adla okunan ya da telde
 * eski adla gelen değişkenler. Başka bir eski adlı değişken (`<eski önek>X`, şablonu da) ancak aynı satırda yeni adıyla
 * (`ASILPOS_X`) birlikte yazılır: "iki ad da okunur" açıklaması ya da iki adı birden okuyan, yazan kod
 */
export const ESKI_ENV_ADLARI: readonly string[] = [
  ESKI_BEKCI_STDIN_ENV,
  ESKI_GUNCELLEME_DENEME_ENV,
  SITE_ANAHTAR_ENV,
  SITE_SUBELER_ENV,
  TEL_UZAK_ADRES_ENV,
  TEL_UZAK_ANAHTAR_ENV,
  `VITE_${ESKI_ENV_ONEKI}UZAKTAN`,
];

/**
 * TypeScript dışındaki dosyalarda (betikler, yapılandırma, belgeler) eski adın geçebildiği metinler. Satırdan bunlar
 * çıkarılınca eski ad kalmamalı. Ortam değişkenleri ayrıca `ESKI_ENV_ADLARI` kuralıyla denetlenir. Betikte bunlara
 * uymayan küçük kopya (ör. `'LafPOS'` klasör adı) satır sonundaki `eski-ad` notuyla işaretlenir; TypeScript dosyası eski
 * adı yalnız bu modülden alır
 */
export const ESKI_AD_METINLERI: readonly string[] = [
  ALAN_ADI,
  VERCEL_ALANI,
  GITHUB_DEPOSU,
  UYGULAMA_ZIP_ONEKI,
  ESKI_WEB_KURUCU,
  SUNUCU_GOREVI,
  VERITABANI_DOSYASI,
  `${YEDEK_DOSYA_ONEKI}guncelleme-`,
  `${YEDEK_DOSYA_ONEKI}geri-yukleme-oncesi-`,
  `${YEDEK_DOSYA_ONEKI}deneme-oncesi-`,
  ...yol('backups', YEDEK_DOSYA_ONEKI),
  `backups/${YEDEK_DOSYA_ONEKI}`,
  ...yol('ProgramData', KURULUM_KLASORU),
  ...yol('Program Files', KURULUM_KLASORU),
  `PROGRAMFILES64\\${KURULUM_KLASORU}`,
  `APPDATA\\${KURULUM_KLASORU}`,
  ...yol('Uninstall', KURULUM_KLASORU),
  `${KURULUM_KLASORU}-Kaldir.ps1`,
  `${KURULUM_KLASORU}-Kasa.bat`,
  `${ESKI_DOSYA_ADI}.ico`,
  `${KURULUM_KLASORU}-KasaBekci`,
  `${KURULUM_KLASORU}-KasaPencere`,
  `${KURULUM_KLASORU}-MusteriPencere`,
  `${KURULUM_KLASORU}-MusteriEkrani`,
  `${KURULUM_KLASORU}-KasaKontrol`,
  `${KURULUM_KLASORU} Musteri Ekrani`,
  `${KURULUM_KLASORU} Kasa Kontrol`,
  ...yol(KURULUM_KLASORU, 'chrome'),
  ...yol(KURULUM_KLASORU, 'edge'),
  ...yol(KURULUM_KLASORU, 'modpos-uyari.txt'),
  // Kasa programının günlüğü (kasa-yazici.ps1; kasa profillerinin klasöründe, 28 Kasım 2026)
  ...yol(KURULUM_KLASORU, 'logs'),
  `${KURULUM_KLASORU}\\\\(chrome|edge)`,
  `${KURULUM_KLASORU}-Kasa.command`,
  `Application Support/${KURULUM_KLASORU}`,
  MAC_ETIKETI,
  KONTROL_IMZA_ONEKI,
  PIN_IMZA_ONEKI,
  YEDEK_SIFRE_BILGISI,
  BLOB_DEPOSU,
  REDIS_ONEKI,
  TEL_KART_ALANI,
  ESKI_KURULUM_YOLU,
  SITE_ISTEMCI.split(' ')[0]!,
];

/**
 * Yalnız belgelerde (.md, .txt): tırnak içinde telde ve veritabanında duran değer, depo adıyla anılan eski PR'lar ve
 * klasörler, sahibe verilmiş eski dosya, ad değişikliği notu
 */
export const BELGE_ALINTILARI: readonly string[] = [
  `\`${TEL_KAYNAK}\``,
  `"${TEL_KAYNAK}"`,
  `\`${ESKI_DEPO_ONEKI}*\``,
  `${VERCEL_PROJESI}#`,
  `RiosenBeq/${VERCEL_PROJESI}`,
  `Downloads/${VERCEL_PROJESI}`,
  `cd ${VERCEL_PROJESI}`,
  `${VERCEL_PROJESI}-kasa-ayarlari.env`,
  `26 Kasım 2026'ya kadar adı ${ESKI_URUN_ADI}`,
  `laffogato \`${SITE_BELGESI}\``,
];

/** Betik satırında küçük kopyanın notu (satır sonundaki yorum) */
export const ESKI_AD_NOTU = 'eski-ad';
