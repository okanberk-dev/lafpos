import { networkInterfaces } from 'node:os';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { runMigrations, sqlite } from './db/client';
import { seedIfEmpty } from './db/seed';
import { upgradeRoleSets, upgradeStoredSettings } from './lib/settings';
import { env } from './env';
import { upgradeOptionProfiles } from './sync/option-profile';
import { startJobs, stopJobs } from './jobs';

runMigrations();
if (seedIfEmpty()) console.log('İlk kurulum: köşk masa planı, site menüsü ve örnek personel yüklendi');
upgradeRoleSets();
upgradeStoredSettings();
upgradeOptionProfiles();

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n!.address}:${info.port}`);
  console.log(`LafPOS sunucusu hazır: http://localhost:${info.port}${lan.length ? `  ·  ağdan: ${lan.join(', ')}` : ''}`);
});

startJobs();

/**
 * Düzgün kapanış: veritabanı kapanınca WAL ana dosyaya yazılır, lafpos.db tek başına da eksiksiz olur. Windows'ta
 * bekçi sinyal gönderemez (süreci sonlandırmak kapanış kodunu çalıştırmaz); ona standart girdiden "kapat" yazar
 * (LAFPOS_STDIN_CONTROL=1).
 */
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  stopJobs();
  server.close();
  try {
    sqlite.close();
  } catch {
    /* zaten kapalı */
  }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, shutdown);
if (process.env.LAFPOS_STDIN_CONTROL === '1') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => String(d).includes('kapat') && shutdown());
}
