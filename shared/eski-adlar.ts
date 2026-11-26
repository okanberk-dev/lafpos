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
 * `ASILPOS_X ?? LAFPOS_X` (shared/pos-env.ts); ayarlar dosyasına yazan, dosyada zaten duran adı korur
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
export const TEL_KAYNAK = 'lafpos';
/** POST /api/pos/gun `bankPos` içindeki kasa kartı alanı */
export const TEL_KART_ALANI = 'lafposCard';
/** ladmin'in kurulum kodu ucu (eski yol; yenisi /api/asilpos/kurulum) */
export const ESKI_KURULUM_YOLU = '/api/lafpos/kurulum';
/** Sitenin gördüğü işlem yapan (masa listesi) ve istemci adı */
export const SITE_AKTOR = 'LafPOS';
export const SITE_ISTEMCI = 'LafPOS/0.1 (+kafe kasasi)';

// ─── Veritabanında duran değerler ────────────────────────────────────────────

/** products.sold_out_by: kasanın kapattığı Tükendi */
export const TUKENDI_KASA = 'lafpos';
/** Pavo gün sonu kıyas tabanı: kasanın bildiği son batch (sync_state) */
export const PAVO_TABAN_KASA = 'lafpos';
/** Açılış beklentisinin kaynağı: kasanın kendi sayımı (denetim kaydında) */
export const ACILIS_KASA = 'lafpos';

// ─── Tarayıcı ────────────────────────────────────────────────────────────────

/** localStorage ve sessionStorage anahtarlarının eski öneki (src/lib/eski-depo.ts yenisine kopyalar, eskisini silmez) */
export const ESKI_DEPO_ONEKI = 'lafpos.';
