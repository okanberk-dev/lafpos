import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { DEMO_USERS } from '../db/seed';
import {
  type AppEnv,
  approverFor,
  assertNotLocked,
  clearFailures,
  clientKey,
  createSession,
  destroySession,
  findApprover,
  hashPin,
  isValidPin,
  recordFailure,
  toAuthUser,
} from '../lib/auth';
import { body, HttpError } from '../lib/http';
import { getSettings } from '../lib/settings';
import { meDTO } from '../services/bootstrap';
import { PERMISSIONS, type Permission } from '@shared/permissions';

export const authRoutes = new Hono<AppEnv>();

/** Giriş ekranı: etkin personelin adı ve rengi (PIN yok). Kurulum modunda örnek PIN'ler de döner. */
authRoutes.get('/users', (c) => {
  const users = db
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, color: schema.users.color })
    .from(schema.users)
    .where(eq(schema.users.active, true))
    .orderBy(asc(schema.users.name))
    .all();
  const s = getSettings();
  return c.json({
    users,
    businessName: s.businessName,
    demoPins: s.demoMode ? DEMO_USERS.map((u) => ({ name: u.name, pin: u.pin })) : null,
  });
});

authRoutes.post('/login', async (c) => {
  const { pin, device } = await body(c, z.object({ pin: z.string(), device: z.string().max(120).optional() }));
  const addr = clientKey(c);
  assertNotLocked('giris', addr);
  const row = isValidPin(pin) ? db.select().from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get() : undefined;
  if (!row || !row.active) {
    recordFailure('giris', addr);
    throw new HttpError(401, 'PIN hatalı', 'pin_invalid');
  }
  clearFailures('giris', addr);
  const token = createSession(row.id, device ?? c.req.header('user-agent') ?? '');
  return c.json({ token, me: meDTO(toAuthUser(row)) });
});

authRoutes.post('/logout', (c) => {
  destroySession(c.get('user').sessionId);
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => c.json(meDTO(c.get('user'))));

/**
 * Yetkili PIN'ini işlemden önce denetler (arayüzde anında "Onaylandı: Müdür" göstermek için). Hatalı PIN ile yetkisi
 * olmayanın PIN'i aynı yanıtı alır ve sayaca aynı yazılır; deneme sınırı cihaz ve soran kişi başına.
 */
authRoutes.post('/approve', async (c) => {
  const { pin, permission } = await body(c, z.object({ pin: z.string(), permission: z.string() }));
  if (!(permission in PERMISSIONS)) throw new HttpError(422, 'Bilinmeyen yetki');
  const user = c.get('user');
  const addr = clientKey(c);
  const approver = findApprover(pin, addr, user);
  approverFor({ user, approver, approverAddr: addr }, permission as Permission);
  return c.json({ id: approver.id, name: approver.name });
});
