import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { env } from './env';
import { type AppEnv, authMiddleware, clientKey } from './lib/auth';
import { constraintError, HttpError } from './lib/http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { cashRoutes } from './routes/cash';
import { eventRoutes } from './routes/events';
import { customerRoutes } from './routes/customers';
import { displayPublicRoutes, displayRoutes } from './routes/display';
import { okcPublicRoutes, okcRoutes } from './routes/okc';
import { platformRoutes } from './routes/platforms';
import { posRoutes } from './routes/pos';
import { reportRoutes } from './routes/reports';
import { reservationRoutes } from './routes/reservations';
import { syncRoutes } from './routes/sync';
import { productImage, thumbFor } from './services/media';
import { getOpenDay } from './services/orders';
import { merkezTarget } from './sync/merkez';
import { db } from './db/client';
import { installedVersion, isLoopback } from './lib/surum';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code ?? null, ...(err.extra ?? {}) }, err.status);
    }
    const constraint = constraintError(err);
    if (constraint) {
      console.warn('[kısıt]', c.req.method, c.req.path, err.message);
      return c.json({ error: constraint.message, code: constraint.code ?? null }, constraint.status);
    }
    console.error('[hata]', c.req.method, c.req.path, err);
    return c.json({ error: 'Beklenmeyen bir hata oluştu', code: 'internal' }, 500);
  });

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });
  app.use('/api/*', authMiddleware);

  // Derleme numarası: güncelleyici yeni sürümün gerçekten açıldığını buradan anlar (guncelle.mjs)
  app.get('/api/health', (c) => c.json({ ok: true, time: Date.now(), build: installedVersion().build }));
  // Güncelleyicinin (bekçi) sorusu: açık iş günü var mı. Oturumsuz; yalnız bu bilgisayardan (yerel ağdaki ya da
  // Tailscale'deki cihaz 403 alır), yanıtta gün açık mı dışında bir şey yok
  app.get('/api/kasa/guncelleme-durumu', (c) => {
    if (!isLoopback(clientKey(c))) return c.json({ error: 'Yalnız bu bilgisayardan', code: 'forbidden' }, 403);
    // Merkez'in hedefi: güncelleyici yalnız bu derlemeye kadar kurar (Merkez kapalıysa kanalın son sürümü)
    return c.json({ dayOpen: !!getOpenDay(db), merkez: merkezTarget() });
  });

  // Ürün kartındaki görselin küçük kopyası. /api dışında: tarayıcı önbelleğe alır, <img> oturum taşımaz;
  // görseller sitede de herkese açık. Adres değişince arayüz ?v= ile yenisini ister
  app.get('/media/products/:id', async (c) => {
    const thumb = await thumbFor(productImage(c.req.param('id')) ?? '');
    if (!thumb) return c.body(null, 404);
    return c.body(new Uint8Array(thumb.body), 200, { 'content-type': thumb.type, 'cache-control': 'public, max-age=604800' });
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/cash', cashRoutes);
  app.route('/api/okc', okcRoutes);
  app.route('/api/public/okc', okcPublicRoutes);
  app.route('/api/customers', customerRoutes);
  app.route('/api/sync', syncRoutes);
  app.route('/api/display', displayRoutes);
  app.route('/api/public', displayPublicRoutes);
  app.route('/api/reports', reportRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/reservations', reservationRoutes);
  app.route('/api/platforms', platformRoutes);
  app.route('/api', posRoutes);
  app.all('/api/*', (c) => c.json({ error: 'Böyle bir uç yok', code: 'not_found' }, 404));

  // Üretimde derlenmiş arayüz aynı porttan sunulur (tek süreç)
  if (existsSync(env.webDist)) {
    const root = relative(process.cwd(), env.webDist) || '.';
    const indexHtml = readFileSync(resolve(env.webDist, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root }));
    // Olmayan derleme dosyası 404'tür: arayüz sayfası JS yerine dönerse tarayıcı boş ekranda kalır (güncellemeden sonra)
    app.get('/assets/*', (c) => c.text('Bulunamadı', 404));
    app.get('*', (c) => c.html(indexHtml));
  }
  return app;
}
