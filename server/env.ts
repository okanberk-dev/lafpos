import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Proje kökü (server/ klasörünün bir üstü) */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const dataDir = resolve(ROOT, process.env.LAFPOS_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });

/**
 * PIN'lerin HMAC anahtarı. .env'de yoksa ilk açılışta data/ altında üretilir ve orada kalır; veritabanı
 * dosyası tek başına sızarsa PIN'ler bu anahtar olmadan çözülemez.
 */
function loadSecret(): string {
  if (process.env.LAFPOS_SECRET) return process.env.LAFPOS_SECRET;
  const file = resolve(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const env = {
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.LAFPOS_PORT ?? 4000),
  host: process.env.LAFPOS_HOST ?? '0.0.0.0',
  dataDir,
  dbFile: resolve(dataDir, process.env.LAFPOS_DB_FILE ?? 'lafpos.db'),
  uploadsDir: resolve(dataDir, 'uploads'),
  webDist: resolve(ROOT, 'dist/web'),
  secret: loadSecret(),
  /** Oturum süresi (saat) */
  sessionHours: Number(process.env.LAFPOS_SESSION_HOURS ?? 14),

  /**
   * laffogato (site + mobil uygulama API'si). Varsayılanı yok: yalnız .env'de açıkça yazılınca dolu, boşken LafPOS
   * siteye hiçbir istek atmaz (menü, görsel, online sipariş, Tükendi; sahibin 26 Ekim kararı, docs/03-ENTEGRASYON.md §2)
   */
  laffogatoUrl: (process.env.LAFFOGATO_URL ?? '').trim().replace(/\/+$/, ''),
  /** Sitenin imzalı uçları: sitedeki LAFPOS_SYNC_SECRET değeri (en az 32 karakter) */
  laffogatoPanelSecret: (process.env.LAFFOGATO_SYNC_SECRET ?? process.env.LAFFOGATO_PANEL_SECRET ?? '').trim(),

  /** lafmaliyet (maliyet / arka ofis paneli) */
  lafmaliyetUrl: (process.env.LAFMALIYET_URL ?? '').replace(/\/$/, ''),
  /** lafmaliyet'in imzalı POS uçları: paneldeki LAFPOS_SYNC_SECRET değeri */
  lafmaliyetToken: (process.env.LAFMALIYET_SYNC_SECRET ?? '').trim(),

  /** LafPOS Uzaktan (Vercel): canlı özetin gittiği adres ve imza anahtarı (Vercel'deki LAFPOS_CLOUD_SECRET) */
  cloudUrl: (process.env.LAFPOS_CLOUD_URL ?? '').replace(/\/$/, ''),
  cloudSecret: (process.env.LAFPOS_CLOUD_SECRET ?? '').trim(),
};

mkdirSync(env.uploadsDir, { recursive: true });
