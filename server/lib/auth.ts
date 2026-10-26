import { createHash, createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
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

/**
 * Giriş PIN'i, yetkili onayı PIN'i ya da personele PIN verme (yanıtı PIN'in başkasında olup olmadığını söyler);
 * sayaçlar ayrı. Onayda ve PIN vermede sayaç hem cihazın (bağlantı adresi) hem kişinin (oturumdaki personel)
 * üzerinedir: cihaz değiştirmek kilidi aşmaz.
 */
export type PinKind = 'giris' | 'onay' | 'pin';

/**
 * Anahtar (cihaz ya da kişi) başına iki sınır:
 * - Art arda hata: 5 hatadan sonra 15 sn, her yeni hatada ikiye katlanarak en çok 5 dk. Doğru PIN sıfırlar (yazım
 *   hatası kimseyi kilitlemesin); 10 dakika hatasız geçince de sıfırlanır.
 * - Hata puanı: her hata bir puan, puan 5 dakikada bir azalır; 10 puanda kilit, puan 9'a inene kadar sürer. Doğru PIN
 *   puanı silmez, yalnız zaman siler: uzun vadede saatte 12 hatalı deneme (denetim, 26 Eki 2026: araya kendi PIN'ini
 *   sokan personel art arda sayacını her seferinde sıfırlayıp kilide hiç takılmadan bütün PIN'leri deniyor, patronun
 *   PIN'ini buluyordu). Seyrek yazım hatası puanı birikmeden erir.
 * Kilitliyken PIN hiç denenmez: yanıt PIN'e bağlı değildir. Onay ve PIN verme kilidi, giriş kilidi ise araya doğru
 * PIN girse de süren taramada (puan) denetim kaydına alarm yazar; aynı anahtar için saatte bir.
 */
const STREAK_LIMIT = 5;
const SCORE_LIMIT = 10;
const SCORE_DECAY_MS = 5 * 60_000;
const ALARM_EVERY_MS = 60 * 60_000;

interface Counter {
  streak: number;
  last: number;
  score: number;
  scoreAt: number;
  until: number;
  alarmAt: number;
}
const counters = new Map<string, Counter>();
const keysOf = (kind: PinKind, addr: string, userId?: string | null) => [`${kind}:${addr}`, ...(userId ? [`${kind}:@${userId}`] : [])];
const scoreNow = (f: Counter, now: number) => Math.max(0, f.score - (now - f.scoreAt) / SCORE_DECAY_MS);

/**
 * Ağ geneli: 10 dakikalık kayan pencerede 30 hatalı PIN, ağdaki birçok adresten PIN taranıyor demektir. Kilit yalnız
 * son 7 günde bu sunucuya doğru PIN'le girmemiş adresleri durdurur; kafenin kasası, tabletleri ve telefonları çalışır
 * (inceleme, 26 Eki 2026: ortak kilit doğru PIN'leri ve yetkili onaylarını da durduruyordu). Onay PIN'ini oturumu
 * açık cihaz sorar, ağ kilidine takılmaz; cihaz ve kişi başına sınır onda da geçerli. Kilit denetim kaydına alarm yazar.
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

function waitText(ms: number): string {
  return ms < 120_000 ? `${Math.ceil(ms / 1000)} saniye` : `${Math.ceil(ms / 60_000)} dakika`;
}

function locked(kind: PinKind, ms: number): HttpError {
  const what = kind === 'pin' ? 'Çok fazla PIN değişikliği denendi' : 'Çok fazla hatalı PIN';
  return new HttpError(429, `${what}. ${waitText(ms)} sonra tekrar deneyin`, 'rate_limited');
}

export function assertNotLocked(kind: PinKind, addr: string, userId?: string | null) {
  const now = Date.now();
  const until = Math.max(0, ...keysOf(kind, addr, userId).map((k) => counters.get(k)?.until ?? 0));
  if (until > now) throw locked(kind, until - now);
  if (kind === 'giris' && globalUntil > now && !isTrusted(addr, now)) throw locked(kind, globalUntil - now);
}

/**
 * Bir hatayı (PIN vermede bir denemeyi) anahtarların sayacına yazar. Kilidin süresini ve alarm yazılıp yazılmayacağını
 * döner: girişte yalnız puan kilidi (araya doğru PIN girse de süren tarama) alarmdır, yazım hatası dizisi değil.
 */
function penalize(kind: PinKind, addr: string, userId: string | null | undefined, streak: boolean): { ms: number; alarm: boolean } {
  const now = Date.now();
  if (counters.size > 2000) for (const [k, f] of counters) if (f.until <= now && scoreNow(f, now) === 0) counters.delete(k);
  const out = { ms: 0, alarm: false };
  for (const key of keysOf(kind, addr, userId)) {
    const f = counters.get(key) ?? { streak: 0, last: now, score: 0, scoreAt: now, until: 0, alarmAt: 0 };
    if (now - f.last > WINDOW_MS) f.streak = 0;
    if (streak) f.streak += 1;
    f.last = now;
    f.score = scoreNow(f, now) + 1;
    f.scoreAt = now;
    const byStreak = f.streak >= STREAK_LIMIT ? Math.min(300_000, 15_000 * 2 ** (f.streak - STREAK_LIMIT)) : 0;
    const byScore = f.score >= SCORE_LIMIT ? Math.ceil((f.score - (SCORE_LIMIT - 1)) * SCORE_DECAY_MS) : 0;
    const ms = Math.max(byStreak, byScore);
    if (ms > 0) {
      f.until = Math.max(f.until, now + ms);
      if ((kind !== 'giris' || byScore > 0) && now - f.alarmAt > ALARM_EVERY_MS) {
        f.alarmAt = now;
        out.alarm = true;
      }
    }
    out.ms = Math.max(out.ms, ms);
    counters.set(key, f);
  }
  return out;
}

function pinAlarm(kind: PinKind, addr: string, user: { id: string; name: string } | null | undefined, ms: number) {
  const wait = waitText(ms);
  const message =
    kind === 'onay'
      ? `${user?.name ?? 'Bir personel'} çok sayıda hatalı yetkili PIN'i girdi; yetkili onayı ${wait} kilitlendi. PIN taranıyor olabilir`
      : kind === 'pin'
        ? `${user?.name ?? 'Bir personel'} kısa sürede çok sayıda PIN denedi; personele PIN verme ${wait} kilitlendi. Başka birinin PIN'i aranıyor olabilir`
        : `Bir cihazdan (${addr}) araya doğru PIN de girilerek çok sayıda hatalı giriş PIN'i denendi; bu cihaz ${wait} giriş yapamaz. PIN taranıyor olabilir`;
  const fx = new Effects();
  fx.audit(db, { userId: user?.id ?? null, action: 'auth.pin_lock', severity: 'alarm', message, data: { kind, addr } });
  fx.flush();
}

/** Hatalı PIN: cihazın (ve onayda kişinin) sayacına yazılır, ağ geneli sayaca da */
export function recordFailure(kind: PinKind, addr: string, user?: { id: string; name: string } | null) {
  const now = Date.now();
  const lock = penalize(kind, addr, user?.id, true);
  if (lock.alarm) pinAlarm(kind, addr, user, lock.ms);

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

/** Doğru PIN: art arda hata sayacı sıfırlanır (puan zamanla erir); giriş yapan adres ağ kilidinden muaf olur */
export function clearFailures(kind: PinKind, addr: string, userId?: string | null) {
  for (const key of keysOf(kind, addr, userId)) {
    const f = counters.get(key);
    if (f) f.streak = 0;
  }
  if (kind === 'giris') trusted.set(addr, Date.now());
}

/**
 * Personele PIN verme: "Bu PIN kullanılamaz" yanıtı PIN'in başkasında olduğunu söyler, boş PIN'i kabul etmek de
 * olmadığını. Her deneme bir puan yazar (art arda sayacı yok); kişi ve cihaz başına uzun vadede saatte 12 deneme.
 */
export function recordPinChoice(addr: string, user: { id: string; name: string }) {
  const lock = penalize('pin', addr, user.id, false);
  if (lock.alarm) pinAlarm('pin', addr, user, lock.ms);
}

/** Testler için: sayaçları ve güvenilen adresleri sıfırlar */
export function resetFailures() {
  counters.clear();
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
  sessionsChanged();
}

/**
 * Oturumlar ya da yetkiler değişti (çıkış, hesap kapatma, PIN, rol ve kişi yetkisi, rol yetki seti): açık canlı
 * akışlar oturumlarını hemen yeniden okur. Oturum silen ya da yetki değiştiren her yazma bundan sonra çağırır; akış
 * ayrıca her yoklamada yeniden okur (süresi dolan oturum, kaçan bildirim).
 */
const sessionSignal = new EventEmitter();
sessionSignal.setMaxListeners(0);

export function sessionsChanged() {
  sessionSignal.emit('changed');
}

export function onSessionsChanged(fn: () => void): () => void {
  sessionSignal.on('changed', fn);
  return () => {
    sessionSignal.off('changed', fn);
  };
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

/**
 * Oturum kimliğinden (jetonun özeti) güncel kişi ve yetkileri: oturum yoksa, süresi dolduysa ya da kişi kapatıldıysa
 * null. `touch` son görülme zamanını yazar (istek); canlı akışın yoklaması yazmaz.
 */
export function resolveSession(id: string, touch = false): AuthUser | null {
  const now = Date.now();
  const row = db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)))
    .get();
  if (!row || !row.u.active) return null;
  if (touch && now - row.s.lastSeenAt > 60_000) {
    db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id)).run();
  }
  return toAuthUser(row.u, id);
}

export function resolveToken(token: string): AuthUser | null {
  return resolveSession(sha256(token), true);
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

/**
 * Hatalı PIN, kapalı hesabın PIN'i ve yetkisi olmayan kişinin PIN'i aynı yanıtı alır (durum, kod, metin): yanıt
 * PIN'in kimde olduğunu söylemez (denetim, 26 Eki 2026: "Kasa bu işlemi onaylayamaz" PIN'in sahibini adıyla veriyordu).
 */
export function approvalRejected(): HttpError {
  return new HttpError(403, 'Yetkili PIN hatalı ya da bu işlemi onaylayamaz', 'approval_invalid');
}

/**
 * Yetkili PIN'ini doğrular: kişi etkin olmalı. Yetkinin kendisi `need` ile işlem anında denetlenir. Deneme sınırı
 * hem cihazın hem PIN'i soranın (oturumdaki kişi) üzerinedir.
 */
export function findApprover(pin: string, addr: string, requester: AuthUser): AuthUser {
  assertNotLocked('onay', addr, requester.id);
  const row = isValidPin(pin) ? db.select().from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get() : undefined;
  if (!row || !row.active) {
    recordFailure('onay', addr, requester);
    throw approvalRejected();
  }
  clearFailures('onay', addr, requester.id);
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
  const approver = approverPin ? findApprover(approverPin, clientKey(c), user) : null;
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
    throw approvalRejected();
  }
  throw new HttpError(403, reason ?? 'Bu işlem yetkili onayı gerektirir', 'approval_required', { permission: perm });
}

/** Yetkili onayı istenmeyen, doğrudan yetki gerektiren işlemler */
export function needDirect(actor: Actor, perm: Permission) {
  requirePermission(actor.user, perm);
}
