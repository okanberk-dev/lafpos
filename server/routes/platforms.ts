import { Hono } from 'hono';
import { z } from 'zod';
import { PLATFORMS, type PlatformId } from '@shared/platforms';
import { db, tx } from '../db/client';
import { type AppEnv, actorFrom, can, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, conflict, HttpError } from '../lib/http';
import { announceAccept, announceReject, liveStatus } from '../delivery/live';
import {
  acceptPlatformOrder,
  getPlatformOrder,
  listPlatformOrders,
  listPlatformProducts,
  mapPlatformProduct,
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
  return c.json({ settings: platformSettings(), orders: listPlatformOrders(db), live: liveStatus() });
});

/** Ürün eşleme: platform ürünü → LafPOS ürünü (menü ya da bağlantı yetkisi; görmek için paket yetkisi yeter) */
platformRoutes.get('/products', (c) => {
  const user = c.get('user');
  if (!can(user, 'paket.yonet') && !can(user, 'menu.yonet')) requirePermission(user, 'senkron.yonet');
  return c.json({ products: listPlatformProducts(db) });
});

platformRoutes.put('/products/:id', async (c) => {
  const user = c.get('user');
  if (!can(user, 'menu.yonet')) requirePermission(user, 'senkron.yonet');
  const input = await body(c, z.object({ productId: z.string().max(40).nullable() }));
  write((t, fx) => mapPlatformProduct(t, actorFrom(c), fx, c.req.param('id'), input.productId));
  return c.json({ ok: true });
});

platformRoutes.put('/:platform', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'ayar.yonet');
  const platform = platformParam(c.req.param('platform'));
  const input = await body(
    c,
    z.object({ mode: z.enum(['kapali', 'deneme', 'canli']).optional(), prepMinutes: z.number().int().min(5).max(120).optional(), commissionPct: z.number().min(0).max(60).optional() }),
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

/**
 * Kabul: canlı bağlantıda önce platforma bildirilir (platform reddederse 502, yerelde kabul edilmez: platform sipariş
 * durumunun sahibidir), sonra yerelde adisyon açılır. Deneme siparişi platforma gitmez.
 */
platformRoutes.post('/orders/:id/accept', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const input = await body(c, z.object({ prepMinutes: z.number().int().min(5).max(120).optional() }));
  const row = getPlatformOrder(db, c.req.param('id'));
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (row.expiresAt != null && row.expiresAt <= Date.now()) throw conflict('Kabul süresi doldu; sipariş platformda iptal oldu', 'expired');
  const prep = input.prepMinutes ?? platformSettings()[row.platform].prepMinutes;
  const notifiedStatus = await announceAccept(row, prep);
  const res = write((t, fx) => acceptPlatformOrder(t, c.get('user'), fx, row.id, prep, { notifiedStatus }));
  return c.json({ orderId: res.order.id, prepMinutes: res.prepMinutes });
});

platformRoutes.post('/orders/:id/reject', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const input = await body(c, z.object({ reason: z.string().max(100) }));
  const row = getPlatformOrder(db, c.req.param('id'));
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (!input.reason.trim()) throw new HttpError(400, 'Ret nedeni seçilmeli', 'reason_required');
  const notifiedStatus = await announceReject(row, input.reason.trim());
  write((t, fx) => rejectPlatformOrder(t, c.get('user'), fx, row.id, input.reason, { notifiedStatus }));
  return c.json({ ok: true });
});

/** Platform siparişi iptal etti: denemede elle (gerçek bağlantıda platformdan gelir) */
platformRoutes.post('/orders/:id/platform-cancel', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const input = await body(c, z.object({ reason: z.string().max(100).default('') }));
  write((t, fx) => platformCancelled(t, c.get('user'), fx, c.req.param('id'), input.reason, { manual: true }));
  return c.json({ ok: true });
});
