import { networkInterfaces } from 'node:os';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { runMigrations } from './db/client';
import { seedIfEmpty } from './db/seed';
import { env } from './env';
import { startJobs } from './jobs';

runMigrations();
if (seedIfEmpty()) console.log('İlk kurulum: köşk masa planı, site menüsü ve örnek personel yüklendi');

const app = createApp();

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n!.address}:${info.port}`);
  console.log(`LafPOS sunucusu hazır: http://localhost:${info.port}${lan.length ? `  ·  ağdan: ${lan.join(', ')}` : ''}`);
});

startJobs();
