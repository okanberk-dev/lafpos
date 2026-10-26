import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { effectivePermissions, type Permission, type Role } from '@shared/permissions';
import { getSettings } from './settings';
import { db, schema } from '../db/client';
import { env } from '../env';
import { HttpError } from './http';

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  color: string;
  permissions: Set<Permission>;
  maxDiscountPct: number;
  sessionId: string;
}

export type AppEnv = { Variables: { user: AuthUser } };

/** PIN'in anahtarlı özeti. Tekil olduğu için giriş yalnız PIN'le yapılır. */
export function hashPin(pin: string): string {
  return createHmac('sha256', env.secret).update(`lafpos-pin:${pin}`).digest('hex');
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

// ─── Deneme sınırı ───────────────────────────────────────────────────────────

const failures = new Map<string, { count: number; until: number }>();

export function assertNotLocked(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) {
    const sec = Math.ceil((f.until - Date.now()) / 1000);
    throw new HttpError(429, `Çok fazla hatalı PIN. ${sec} saniye sonra tekrar deneyin`, 'rate_limited');
  }
}

export function recordFailure(key: string) {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  // 5 hatadan sonra 15 sn, sonra her hatada ikiye katlanarak en çok 5 dk kilit
  if (f.count >= 5) f.until = Date.now() + Math.min(300_000, 15_000 * 2 ** (f.count - 5));
  failures.set(key, f);
}

export function clearFailures(key: string) {
  failures.delete(key);
}

export function clientKey(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return fwd || incoming?.socket?.remoteAddress || 'yerel';
}

// ─── Oturum ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(userId: string, device: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.insert(schema.sessions)
    .values({
      id: sha256(token),
      userId,
      device: device.slice(0, 120),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + env.sessionHours * 3600_000,
    })
    .run();
  db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, userId)).run();
  return token;
}

export function destroySession(sessionId: string) {
  db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
}

type UserRow = typeof schema.users.$inferSelect;

export function toAuthUser(u: UserRow, sessionId = ''): AuthUser {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    color: u.color,
    permissions: effectivePermissions(u.role, { grant: u.permGrant, revoke: u.permRevoke }, getSettings().rolePermissions),
    maxDiscountPct: u.maxDiscountPct,
    sessionId,
  };
}

export function resolveToken(token: string): AuthUser | null {
  const id = sha256(token);
  const now = Date.now();
  const row = db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)))
    .get();
  if (!row || !row.u.active) return null;
  if (now - row.s.lastSeenAt > 60_000) {
    db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id)).run();
  }
  return toAuthUser(row.u, id);
}

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/users', '/api/health'];

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  if (!path.startsWith('/api/') || PUBLIC_PATHS.includes(path) || path.startsWith('/api/public/')) return next();
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = token ? resolveToken(token) : null;
  if (!user) throw new HttpError(401, 'Oturum kapalı. PIN ile tekrar giriş yapın', 'unauthorized');
  c.set('user', user);
  return next();
};

// ─── Yetki ───────────────────────────────────────────────────────────────────

export function can(user: AuthUser, perm: Permission): boolean {
  return user.permissions.has(perm);
}

export function requirePermission(user: AuthUser, perm: Permission) {
  if (!can(user, perm)) throw new HttpError(403, 'Bu işlem için yetkiniz yok', 'forbidden', { permission: perm });
}

/** İşlemi yapan kişi ve (verildiyse) PIN'i doğrulanmış yetkili. */
export interface Actor {
  user: AuthUser;
  approver: AuthUser | null;
}

/** Yetkili PIN'ini doğrular: kişi etkin olmalı. Yetkinin kendisi `need` ile işlem anında denetlenir. */
export function findApprover(pin: string, key: string): AuthUser {
  assertNotLocked(`onay:${key}`);
  const row = isValidPin(pin) ? db.select().from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get() : undefined;
  if (!row || !row.active) {
    recordFailure(`onay:${key}`);
    throw new HttpError(403, 'Yetkili PIN hatalı', 'approval_invalid');
  }
  clearFailures(`onay:${key}`);
  return toAuthUser(row);
}

export function actorFrom(c: Context<AppEnv>, approverPin?: string | null): Actor {
  const user = c.get('user');
  const approver = approverPin ? findApprover(approverPin, clientKey(c)) : null;
  return { user, approver };
}

/**
 * Kullanıcının yetkisi varsa null döner; yoksa yetkilinin kimliğini döner. İkisi de yoksa 403
 * `approval_required`: istemci PIN penceresini açar ve isteği `approverPin` ile tekrarlar.
 */
export function need(actor: Actor, perm: Permission, reason?: string): string | null {
  if (can(actor.user, perm)) return null;
  if (actor.approver) {
    if (can(actor.approver, perm)) return actor.approver.id;
    throw new HttpError(403, `${actor.approver.name} bu işlemi onaylayamaz`, 'approval_forbidden', { permission: perm });
  }
  throw new HttpError(403, reason ?? 'Bu işlem yetkili onayı gerektirir', 'approval_required', { permission: perm });
}

/** Yetkili onayı istenmeyen, doğrudan yetki gerektiren işlemler */
export function needDirect(actor: Actor, perm: Permission) {
  requirePermission(actor.user, perm);
}
