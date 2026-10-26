import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { env } from './env';
import { type AppEnv, authMiddleware } from './lib/auth';
import { HttpError } from './lib/http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { cashRoutes } from './routes/cash';
import { eventRoutes } from './routes/events';
import { customerRoutes } from './routes/customers';
import { okcPublicRoutes, okcRoutes } from './routes/okc';
import { posRoutes } from './routes/pos';
import { reportRoutes } from './routes/reports';
import { reservationRoutes } from './routes/reservations';
import { syncRoutes } from './routes/sync';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code ?? null, ...(err.extra ?? {}) }, err.status);
    }
    console.error('[hata]', c.req.method, c.req.path, err);
    return c.json({ error: 'Beklenmeyen bir hata oluştu', code: 'internal' }, 500);
  });

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });
  app.use('/api/*', authMiddleware);

  app.get('/api/health', (c) => c.json({ ok: true, time: Date.now() }));
  app.route('/api/auth', authRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/cash', cashRoutes);
  app.route('/api/okc', okcRoutes);
  app.route('/api/public/okc', okcPublicRoutes);
  app.route('/api/customers', customerRoutes);
  app.route('/api/sync', syncRoutes);
  app.route('/api/reports', reportRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/reservations', reservationRoutes);
  app.route('/api', posRoutes);
  app.all('/api/*', (c) => c.json({ error: 'Böyle bir uç yok', code: 'not_found' }, 404));

  // Üretimde derlenmiş arayüz aynı porttan sunulur (tek süreç)
  if (existsSync(env.webDist)) {
    const root = relative(process.cwd(), env.webDist) || '.';
    const indexHtml = readFileSync(resolve(env.webDist, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml));
  }
  return app;
}
