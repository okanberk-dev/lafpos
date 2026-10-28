import { Hono } from 'hono';
import { z } from 'zod';
import { AUTO_ACCEPT_MAX_LIMIT, PLATFORM_MODES, PLATFORMS, type PlatformId, type PlatformSettings } from '@shared/platforms';
import { db, tx } from '../db/client';
import { type AppEnv, actorFrom, can, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, conflict, HttpError, patchOf } from '../lib/http';
import { acceptFlow, announceReject, autoAccept, liveStatus, withDecisionLock } from '../delivery/live';
import {
  autoAcceptors,
  closeCancelPending,
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

/**
 * Gelen kutusu ve ayarlar. Komisyon oranı maliyettir (AGENTS kural 3): yalnız maliyeti gören (`rapor.maliyet`) ya da
 * ayarı yöneten (Yönetim › Paket platformları) alır; garson ve raporcu almaz (oranı ciroyla çarpıp komisyonu bulmasın)
 */
platformRoutes.get('/', (c) => {
  const user = c.get('user');
  if (!can(user, 'paket.yonet') && !can(user, 'siparis.al') && !can(user, 'senkron.yonet')) requirePermission(user, 'paket.yonet');
  const all = platformSettings();
  const withCost = can(user, 'rapor.maliyet') || can(user, 'ayar.yonet') || can(user, 'senkron.yonet');
  const settings = withCost ? all : (Object.fromEntries(PLATFORMS.map((p) => [p, withoutCommission(all[p])])) as Record<PlatformId, Omit<PlatformSettings, 'commissionPct'>>);
  return c.json({ settings, orders: listPlatformOrders(db), live: liveStatus(), acceptors: autoAcceptors(db) });
});

function withoutCommission({ commissionPct: _, ...rest }: PlatformSettings): Omit<PlatformSettings, 'commissionPct'> {
  return rest;
}

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

const settingsShape = patchOf(
  z.object({
    mode: z.enum(PLATFORM_MODES),
    prepMinutes: z.number().int().min(5).max(120),
    commissionPct: z.number().min(0).max(60),
    autoAccept: z.boolean(),
    autoAcceptUserId: z.string().max(40).nullable(),
    autoAcceptMaxKurus: z.number().int().min(100).max(AUTO_ACCEPT_MAX_LIMIT),
  }),
);

platformRoutes.put('/:platform', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'ayar.yonet');
  const platform = platformParam(c.req.param('platform'));
  const input = await body(c, settingsShape);
  const saved = write((t, fx) => savePlatformSettings(t, actorFrom(c), fx, platform, input));
  return c.json(saved);
});

/** Deneme modunda platformdan gelmiş gibi sipariş (simülatör); otomatik kabul açıksa aynı yoldan kabul edilir (platforma gitmez) */
platformRoutes.post('/:platform/test-order', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const platform = platformParam(c.req.param('platform'));
  const input = await body(c, z.object({ courier: z.enum(['platform', 'restoran', 'gelal']).optional() }));
  const row = write((t, fx) => sendTestOrder(t, fx, platform, input));
  const auto = await autoAccept(row.id);
  return c.json({ id: row.id, autoAccepted: auto === 'accepted' });
});

/** Kabul (server/delivery/live.ts `acceptFlow`; otomatik kabulle aynı yol) */
platformRoutes.post('/orders/:id/accept', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'paket.yonet');
  const input = await body(c, z.object({ prepMinutes: z.number().int().min(5).max(120).optional() }));
  const res = await acceptFlow(user, c.req.param('id'), input.prepMinutes);
  return c.json({ orderId: res.order.id, prepMinutes: res.prepMinutes });
});

platformRoutes.post('/orders/:id/reject', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'paket.yonet');
  const input = await body(c, z.object({ reason: z.string().max(100) }));
  if (!input.reason.trim()) throw new HttpError(400, 'Ret nedeni seçilmeli', 'reason_required');
  return withDecisionLock(c.req.param('id'), async () => {
    const row = getPlatformOrder(db, c.req.param('id'));
    if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
    const notifiedStatus = await announceReject(row, input.reason.trim());
    write((t, fx) => rejectPlatformOrder(t, user, fx, row.id, input.reason, { notifiedStatus }));
    return c.json({ ok: true });
  });
});

/**
 * Platformun iptali kasada uygulanamıyor (alınan ödeme geri alınamıyor, ör. kapanmış güne ait): yetkili kaydı elle
 * kapatır, alarm düşer. Para hareketi yok. Kasadaki karar: kilitli, otomatik kabul bu kayda dokunmaz
 */
platformRoutes.post('/orders/:id/cancel-close', (c) => {
  const user = c.get('user');
  requirePermission(user, 'siparis.iptal');
  return withDecisionLock(c.req.param('id'), async () => {
    write((t, fx) => closeCancelPending(t, user, fx, c.req.param('id')));
    return c.json({ ok: true });
  });
});

/** Platform siparişi iptal etti: denemede elle (gerçek bağlantıda platformdan gelir). Kasadaki karar gibi kilitli */
platformRoutes.post('/orders/:id/platform-cancel', async (c) => {
  requirePermission(c.get('user'), 'paket.yonet');
  const input = await body(c, z.object({ reason: z.string().max(100).default('') }));
  return withDecisionLock(c.req.param('id'), async () => {
    write((t, fx) => platformCancelled(t, c.get('user'), fx, c.req.param('id'), input.reason, { manual: true }));
    return c.json({ ok: true });
  });
});
