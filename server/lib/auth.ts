import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { effectivePermissions, type Permission, type Role } from '@shared/permissions';
import type { OrderDTO } from '@shared/types';
import { Effects } from './effects';
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

/** Giriş PIN'i ya da yetkili onayı PIN'i; sayaçlar ayrı */
export type PinKind = 'giris' | 'onay';

/** Cihaz (bağlantı adresi) başına: 5 hatadan sonra 15 sn, her yeni hatada ikiye katlanarak en çok 5 dk; doğru PIN sıfırlar */
const failures = new Map<string, { count: number; until: number; last: number }>();
const keyOf = (kind: PinKind, addr: string) => `${kind}:${addr}`;

/**
 * Ağ geneli: 10 dakikalık kayan pencerede 30 hatalı PIN, ağdaki birçok adresten PIN taranıyor demektir. Kilit yalnız
 * son 7 günde bu sunucuya doğru PIN'le girmemiş adresleri durdurur; kafenin kasası, tabletleri ve telefonları çalışır
 * (inceleme, 26 Eki 2026: ortak kilit doğru PIN'leri ve yetkili onaylarını da durduruyordu). Onay PIN'ini oturumu
 * açık cihaz sorar, ağ kilidine takılmaz; cihaz başına sınır onda da geçerli. Kilit denetim kaydına alarm yazar.
 */
const GLOBAL_LIMIT = 30;
const WINDOW_MS = 10 * 60_000;
const TRUST_MS = 7 * 86400_000;
const globalFails: number[] = [];
let globalUntil = 0;
let globalTrips = 0;
let lastTripAt = 0;
const trusted = new Map<string, number>();

const isTrusted = (addr: string, now: number) => (trusted.get(addr) ?? 0) > now - TRUST_MS;

function locked(ms: number): HttpError {
  return new HttpError(429, `Çok fazla hatalı PIN. ${Math.ceil(ms / 1000)} saniye sonra tekrar deneyin`, 'rate_limited');
}

export function assertNotLocked(kind: PinKind, addr: string) {
  const now = Date.now();
  const f = failures.get(keyOf(kind, addr));
  if (f && f.until > now) throw locked(f.until - now);
  if (kind === 'giris' && globalUntil > now && !isTrusted(addr, now)) throw locked(globalUntil - now);
}

export function recordFailure(kind: PinKind, addr: string) {
  const now = Date.now();
  const key = keyOf(kind, addr);
  const f = failures.get(key) ?? { count: 0, until: 0, last: now };
  if (now - f.last > WINDOW_MS) f.count = 0;
  f.count += 1;
  f.last = now;
  if (f.count >= 5) f.until = now + Math.min(300_000, 15_000 * 2 ** (f.count - 5));
  failures.set(key, f);

  globalFails.push(now);
  while (globalFails.length && now - globalFails[0] > WINDOW_MS) globalFails.shift();
  if (globalFails.length >= GLOBAL_LIMIT && globalUntil <= now) {
    // Bir saat içinde yeniden dolarsa kilit ikiye katlanır (1, 2, 4, 8, en çok 10 dk)
    globalTrips = now - lastTripAt > 60 * 60_000 ? 1 : globalTrips + 1;
    lastTripAt = now;
    const ms = Math.min(600_000, 60_000 * 2 ** (globalTrips - 1));
    globalUntil = now + ms;
    globalFails.length = 0;
    const fx = new Effects();
    fx.audit(db, {
      action: 'auth.global_lock',
      severity: 'alarm',
      message: `10 dakikada ${GLOBAL_LIMIT} hatalı PIN denemesi: bu sunucuya son 7 günde girmemiş cihazlar ${Math.round(ms / 60_000)} dakika giriş yapamaz. Kafedeki cihazlar etkilenmez; ağa bilinmeyen bir cihaz bağlı olabilir`,
    });
    fx.flush();
  }
}

/** Doğru PIN: cihazın sayacı sıfırlanır; giriş yapan adres ağ kilidinden muaf olur */
export function clearFailures(kind: PinKind, addr: string) {
  failures.delete(keyOf(kind, addr));
  if (kind === 'giris') trusted.set(addr, Date.now());
}

/** Testler için: sayaçları ve güvenilen adresleri sıfırlar */
export function resetFailures() {
  failures.clear();
  globalFails.length = 0;
  globalUntil = 0;
  globalTrips = 0;
  lastTripAt = 0;
  trusted.clear();
}

/**
 * Deneme sayacının anahtarı: bağlantının gerçek adresi. `X-Forwarded-For` istemcinin kendi yazdığı başlıktır ve
 * LafPOS'un önünde vekil sunucu yoktur; ona güvenilirse her denemede başlığı değiştirerek kilit aşılır.
 */
export function clientKey(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress || 'yerel';
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
export function findApprover(pin: string, addr: string): AuthUser {
  assertNotLocked('onay', addr);
  const row = isValidPin(pin) ? db.select().from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get() : undefined;
  if (!row || !row.active) {
    recordFailure('onay', addr);
    throw new HttpError(403, 'Yetkili PIN hatalı', 'approval_invalid');
  }
  clearFailures('onay', addr);
  return toAuthUser(row);
}

/**
 * Kör kasa: `kasa.rakam` ya da `rapor.gor` yetkisi olmayan kullanıcı ara raporu, beklenen nakdi, kasa farkını ve
 * kapanmış adisyonların ödeme dökümünü görmez (toplayıp beklenen nakdi bulamasın).
 */
export function seesCashNumbers(user: AuthUser): boolean {
  return user.permissions.has('kasa.rakam') || user.permissions.has('rapor.gor');
}

/**
 * Kör kasa: kapanmış adisyonun ödeme dökümü kasa rakamlarını görmeyene gitmez. Adisyon döndüren her uç bundan
 * geçer (okuma, hesap yazdırma, teslimat, ödeme...); yalnız okuma uçlarını süzmek yetmedi (inceleme, 26 Eki 2026).
 */
export function blindOrder(user: AuthUser, dto: OrderDTO): OrderDTO {
  return dto.status !== 'acik' && !seesCashNumbers(user) ? { ...dto, payments: [] } : dto;
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
