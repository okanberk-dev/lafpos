import { configFrom } from '../server/env-config';
import type { env as serverEnv } from '../server/env';

/**
 * Tarayıcı demosunda `server/env.ts`: disk ve .env yok. Ortam değişkenleri tarayıcıda boştur (dış sistem
 * bağlanmaz); testte (vitest "sqljs") Node'unkiler okunur. PIN anahtarı sabit: demodaki PIN'ler zaten herkese açık
 * örnek PIN'ler (server/db/seed.ts).
 */
const vars = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Proje kökü: testte gerçek klasör; tarayıcıda yalnız gömülü dosyaların adı için (demo/shims/fs.ts) */
export const ROOT = decodeURIComponent(new URL(/* @vite-ignore */ '..', import.meta.url).pathname);

// Testte (vitest "sqljs") harness'in geçici klasörü: görsel önbelleği gibi disk yazan kod gerçek klasöre yazar
const dataDir = vars.LAFPOS_DATA_DIR || '/veri';

export const env: typeof serverEnv = {
  ...configFrom(vars),
  dataDir,
  dbFile: `${dataDir}/lafpos-demo.db`,
  uploadsDir: `${dataDir}/uploads`,
  webDist: '/dist/web',
  secret: vars.LAFPOS_SECRET || 'lafpos-tarayici-demosu',
};
