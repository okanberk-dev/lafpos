import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERITABANI_DOSYASI } from '@shared/eski-adlar';
import { posEnv, posEnvDolu } from '@shared/pos-env';
import { configFrom } from './env-config';

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

const dataDir = resolve(ROOT, posEnv(process.env, 'DATA_DIR') ?? 'data');
mkdirSync(dataDir, { recursive: true });

/**
 * PIN'lerin HMAC anahtarı. .env'de yoksa ilk açılışta data/ altında üretilir ve orada kalır; veritabanı
 * dosyası tek başına sızarsa PIN'ler bu anahtar olmadan çözülemez.
 */
function loadSecret(): string {
  const fromEnv = posEnvDolu(process.env, 'SECRET');
  if (fromEnv) return fromEnv;
  const file = resolve(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const env = {
  ...configFrom(process.env),
  dataDir,
  dbFile: resolve(dataDir, posEnv(process.env, 'DB_FILE') ?? VERITABANI_DOSYASI),
  uploadsDir: resolve(dataDir, 'uploads'),
  webDist: resolve(ROOT, 'dist/web'),
  secret: loadSecret(),
};

mkdirSync(env.uploadsDir, { recursive: true });
