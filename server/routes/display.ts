import { Hono } from 'hono';
import { z } from 'zod';
import type { DisplayStateDTO } from '@shared/types';
import { type AppEnv, can, requirePermission } from '../lib/auth';
import { bus } from '../lib/events';
import { bad, body, kurus } from '../lib/http';

/**
 * Müşteri ekranı: kasa adisyonu ekrana yansıtır, ekran (ikinci monitör ya da müşteriye dönük tablet) okur.
 * Durum yalnız bellekte; sunucu yeniden başlarsa ekran "hoş geldiniz"e döner. Ekran adı ile birden çok kasa.
 */
export const displayRoutes = new Hono<AppEnv>();

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
    total: kurus,
    paid: kurus,
    due: z.number().int(),
  }),
  z.object({ kind: z.literal('thanks'), total: kurus }),
]);

displayRoutes.get('/:code', (c) => {
  const k = codeOf(c.req.param('code'));
  return c.json(states.get(k) ?? ({ kind: 'idle', at: 0 } satisfies DisplayStateDTO));
});

displayRoutes.put('/:code', async (c) => {
  const user = c.get('user');
  if (!can(user, 'odeme.al')) requirePermission(user, 'siparis.al');
  const k = codeOf(c.req.param('code'));
  const state = { ...(await body(c, stateShape)), at: Date.now() } as DisplayStateDTO;
  states.set(k, state);
  bus.publish({ topic: 'orders', kind: 'display.update', message: k, byUserId: user.id });
  return c.json({ ok: true });
});
