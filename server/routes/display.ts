import { Hono } from 'hono';
import { z } from 'zod';
import type { DisplayStateDTO } from '@shared/types';
import { db } from '../db/client';
import { pickupBoard } from '../services/floor';
import { type AppEnv, requirePermission } from '../lib/auth';
import { bus } from '../lib/events';
import { bad, body, kurus } from '../lib/http';

/**
 * Müşteri ekranı: kasa adisyonu ekrana yansıtır, ekran (ikinci monitör ya da müşteriye dönük tablet) okur.
 * Durum yalnız bellekte; sunucu yeniden başlarsa ekran "hoş geldiniz"e döner. Ekran adı ile birden çok kasa.
 */
export const displayRoutes = new Hono<AppEnv>();
/** Ekranın okuması oturumsuz: müşteriye dönük tablet ya da televizyon personel PIN'iyle açık durmasın */
export const displayPublicRoutes = new Hono<AppEnv>();
const MAX_DISPLAYS = 20;

const states = new Map<string, DisplayStateDTO>();
/** Ekran adı: küçük harf, rakam, tire */
function codeOf(raw: string): string {
  if (!/^[a-z0-9-]{1,24}$/.test(raw)) throw bad('Ekran adı geçersiz', 'display_code');
  return raw;
}
const text = (max: number) => z.string().max(max);

const stateShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('order'),
    label: text(60),
    lines: z.array(z.object({ name: text(80), size: text(16).nullable(), qty: z.number().int().min(1).max(999), options: text(160), total: kurus })).max(80),
    discount: kurus,
    // Eski kasa sürümü servis göndermez
    service: kurus.default(0),
    total: kurus,
    paid: kurus,
    due: z.number().int(),
  }),
  // Self servisin çağrı kimliği ("No 34", "Masa 12"); eski kasa sürümü göndermez
  z.object({ kind: z.literal('thanks'), total: kurus, call: text(16).optional() }),
]);

displayPublicRoutes.get('/display/:code', (c) => {
  const k = codeOf(c.req.param('code'));
  return c.json(states.get(k) ?? ({ kind: 'idle', at: 0 } satisfies DisplayStateDTO));
});

displayRoutes.put('/:code', async (c) => {
  // Müşterinin gördüğü tutarı yalnız ödeme alan değiştirir (garson tableti değil)
  const user = c.get('user');
  requirePermission(user, 'odeme.al');
  const k = codeOf(c.req.param('code'));
  if (!states.has(k) && states.size >= MAX_DISPLAYS) throw bad('Çok fazla ekran adı', 'display_limit');
  const state = { ...(await body(c, stateShape)), at: Date.now() } as DisplayStateDTO;
  states.set(k, state);
  bus.publish({ topic: 'orders', kind: 'display.update', message: k, byUserId: user.id });
  return c.json({ ok: true });
});

/** Çağrı ekranı (oturumsuz): numara ve yalnız ad; televizyonda zaten herkes görür */
displayPublicRoutes.get('/board', (c) => c.json(pickupBoard(db)));
