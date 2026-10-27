import { Hono } from 'hono';
import { z } from 'zod';
import { PLATFORMS, type PlatformId } from '@shared/platforms';
import { db, tx } from '../db/client';
import { type AppEnv, actorFrom, can, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, HttpError } from '../lib/http';
import {
  acceptPlatformOrder,
  listPlatformOrders,
  platformCancelled,
  platformSettings,
  rejectPlatformOrder,
  savePlatformSettings,
  sendTestOrder,
} from '../delivery/service';

/** Paket platformları: ayarlar, gelen siparişler, kabul / ret, deneme siparişi (shared/platforms.ts) */
export const platformRoutes = new Hono<AppEnv>();

function write<T>(fn: (t: Parameters<Parameters<typeof tx>[0]>[0], fx: Effects) => T): T {
  const fx = new Effects();
  const result = tx((t) => fn(t, fx));
  fx.flush();
  return result;
}

const platformParam = (raw: string): PlatformId => {
  if (!(PLATFORMS as readonly string[]).includes(raw)) throw new HttpError(404, 'Böyle bir platform yok', 'not_found');
  return raw as PlatformId;
};

platformRoutes.get('/', (c) => {
  const user = c.get('user');
  if (!can(user, 'paket.yonet') && !can(user, 'siparis.al') && !can(user, 'senkron.yonet')) requirePermission(user, 'paket.yonet');
  return c.json({ settings: platformSettings(), orders: listPlatformOrders(db) });
});

platformRoutes.put('/:platform', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'ayar.yonet');
  const platform = platformParam(c.req.param('platform'));
  const input = await body(
    c,
    z.object({ mode: z.enum(['kapali', 'deneme']).optional(), prepMinutes: z.number().int().min(5).max(120).optional(), commissionPct: z.number().min(0).max(60).optional() }),
  );
  const saved = write((t, fx) => savePlatformSettings(t, actorFrom(c), fx, platform, input));
  return c.json(saved);
});

/** Deneme modunda platformdan gelmiş gibi sipariş (simülatör) */
platformRoutes.post('/:platform/test-order', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const platform = platformParam(c.req.param('platform'));
  const input = await body(c, z.object({ courier: z.enum(['platform', 'restoran', 'gelal']).optional() }));
  const row = write((t, fx) => sendTestOrder(t, fx, platform, input));
  return c.json({ id: row.id });
});

platformRoutes.post('/orders/:id/accept', async (c) => {
  const input = await body(c, z.object({ prepMinutes: z.number().int().min(5).max(120).optional() }));
  const res = write((t, fx) => acceptPlatformOrder(t, c.get('user'), fx, c.req.param('id'), input.prepMinutes));
  return c.json({ orderId: res.order.id, prepMinutes: res.prepMinutes });
});

platformRoutes.post('/orders/:id/reject', async (c) => {
  const input = await body(c, z.object({ reason: z.string().max(100) }));
  write((t, fx) => rejectPlatformOrder(t, c.get('user'), fx, c.req.param('id'), input.reason));
  return c.json({ ok: true });
});

/** Platform siparişi iptal etti: denemede elle (gerçek bağlantıda platformdan gelir) */
platformRoutes.post('/orders/:id/platform-cancel', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const input = await body(c, z.object({ reason: z.string().max(100).default('') }));
  write((t, fx) => platformCancelled(t, c.get('user'), fx, c.req.param('id'), input.reason, { manual: true }));
  return c.json({ ok: true });
});
