import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { type AppEnv, can, requirePermission } from '../lib/auth';
import { body, HttpError } from '../lib/http';
import { getSyncState, updateSettings } from '../lib/settings';
import { okcStatus } from '../okc/service';
import { buildDayPayload, lafmaliyetStatus, pullCosts, pushDayNow, salesCsv } from '../sync/lafmaliyet';
import { requireSiteLinked, siteLinked } from '../sync/laffogato-link';
import { reportRange } from './reports';
import { onlineStatus, refreshOnlineOrders, setAvailability, setOnlineStage } from '../sync/laffogato-orders';
import { runMenuSync } from '../sync/menu-sync';
import { getSettings } from '../lib/settings';
import { eq } from 'drizzle-orm';

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.get('/status', (c) => {
  const s = getSettings();
  return c.json({
    menu: { linked: siteLinked(), auto: s.menuAutoSync, state: getSyncState('laffogato.menu') },
    online: onlineStatus(),
    lafmaliyet: lafmaliyetStatus(),
    okc: okcStatus(),
  });
});

syncRoutes.put('/settings', async (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  const input = await body(c, z.object({ menuAutoSync: z.boolean().optional(), onlineOrdersSync: z.boolean().optional() }));
  updateSettings(input);
  return c.json({ ok: true });
});

syncRoutes.post('/menu/preview', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'menu.yonet');
  requireSiteLinked();
  try {
    return c.json(await runMenuSync({ apply: false, force: true }));
  } catch (e) {
    throw new HttpError(502, `Site menüsü alınamadı: ${e instanceof Error ? e.message : e}`, 'site_menu');
  }
});

syncRoutes.post('/menu/apply', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'menu.yonet');
  requireSiteLinked();
  try {
    return c.json(await runMenuSync({ apply: true, force: true, userId: user.id, userName: user.name }));
  } catch (e) {
    throw new HttpError(502, `Site menüsü uygulanamadı: ${e instanceof Error ? e.message : e}`, 'site_menu');
  }
});

syncRoutes.post('/online/refresh', async (c) => {
  requirePermission(c.get('user'), 'siparis.al');
  return c.json(await refreshOnlineOrders());
});

syncRoutes.post('/online/:orderId/stage', async (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'mutfak.ekran');
  const input = await body(c, z.object({ action: z.enum(['preparing', 'ready', 'delivered']) }));
  await setOnlineStage(c.req.param('orderId'), input.action, user.name);
  return c.json({ ok: true });
});

/**
 * Tükendi / Satışa aç: kasiyer de yapabilir (müşteri beklerken menü yöneticisi aranmasın). Sitenin kapattığını
 * yalnız menü yetkisi olan açar (Tükendi kilidi, `products.soldOutBy`)
 */
syncRoutes.post('/products/:id/availability', async (c) => {
  const user = c.get('user');
  const manager = can(user, 'menu.yonet');
  if (!manager) requirePermission(user, 'urun.tukendi');
  const input = await body(c, z.object({ active: z.boolean() }));
  return c.json(await setAvailability(c.req.param('id'), input.active, { name: user.name, manager }));
});

/** Raporlar › Aktarım: dönem raporlarla aynı denetlenir (gerçek tarih, en çok 400 gün, varsayılan açık iş günü) */
syncRoutes.get('/lafmaliyet/satislar.csv', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const q = reportRange(c);
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-satislar-${q.from}_${q.to}.csv"`);
  return c.body(salesCsv(q.from, q.to));
});

syncRoutes.get('/lafmaliyet/gun/:dayId', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  return c.json(buildDayPayload(c.req.param('dayId')));
});

syncRoutes.post('/lafmaliyet/gun/:dayId/push', async (c) => {
  const user = c.get('user');
  if (!can(user, 'kasa.gun')) requirePermission(user, 'senkron.yonet');
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, c.req.param('dayId'))).get();
  if (!day?.closedAt) throw new HttpError(409, 'Yalnız gün sonu alınmış gün gönderilir', 'day_open');
  return c.json(await pushDayNow(day.id));
});

syncRoutes.post('/lafmaliyet/costs/pull', async (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  return c.json(await pullCosts());
});
