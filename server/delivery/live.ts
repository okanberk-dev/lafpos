import { and, eq, inArray } from 'drizzle-orm';
import { tl } from '@shared/money';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { PLATFORM_LABEL, type PlatformId, type PlatformLiveStatus, type PlatformOrderPayload, PLATFORMS } from '@shared/platforms';
import { db, schema, tx } from '../db/client';
import type { AuthUser } from '../lib/auth';
import { Effects } from '../lib/effects';
import { HttpError } from '../lib/http';
import { getSyncState, setSyncState } from '../lib/settings';
import type { PlatformAdapter, PlatformNotify } from './adapter';
import { adapterFor } from './registry';
import { ingestPlatformOrder, platformCancelled, platformSettings } from './service';

/**
 * Canlı platform bağlantısı (docs/PAKET-PLATFORMLARI.md "Canlı"): yoklama (yeni sipariş, platformun iptali), kabul
 * ve ret platforma önce bildirilir (platform reddederse yerelde yapılmaz), teslim aşamaları (hazır, yolda, teslim)
 * sırayla platforma yazılır ve yazılamayan yeniden denenir (`platform_orders.notifiedStatus`, `lastError`). Deneme
 * siparişleri (`simulated`) platforma hiç gitmez.
 */
type PlatformRow = typeof schema.platformOrders.$inferSelect;

export interface LiveState {
  lastPollAt?: number;
  lastOkAt?: number;
  lastError?: string | null;
  failures?: number;
}

const stateKey = (p: PlatformId) => `platform.${p}.live`;
const readState = (p: PlatformId): LiveState => getSyncState<LiveState>(stateKey(p)) ?? {};
const writeState = (p: PlatformId, s: LiveState) => setSyncState(stateKey(p), s);

/** Yoklama aralığı ve art arda hatada bekleme (en çok 5 dk) */
export const POLL_INTERVAL_MS = 20_000;
const backoff = (failures: number) => Math.min(5 * 60_000, POLL_INTERVAL_MS * 2 ** Math.min(failures, 4));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Platformun canlı bağlantısı açık ve anahtarı tanımlı mı */
export function liveAdapter(platform: PlatformId): PlatformAdapter | null {
  const a = adapterFor(platform);
  return a && a.configured() && platformSettings()[platform].mode === 'canli' ? a : null;
}

/** Sipariş platforma bildirilecek mi: canlı modda, gerçek (deneme değil) sipariş */
function liveFor(row: Pick<PlatformRow, 'platform' | 'payload'>): PlatformAdapter | null {
  return row.payload.simulated ? null : liveAdapter(row.platform);
}

/** Yönetim › Paket platformları: her platformun canlı bağlantı durumu */
export function liveStatus(): Record<PlatformId, PlatformLiveStatus> {
  const out = {} as Record<PlatformId, PlatformLiveStatus>;
  for (const p of PLATFORMS) {
    const a = adapterFor(p);
    const s = readState(p);
    const pending = a
      ? db
          .select({ id: schema.platformOrders.id })
          .from(schema.platformOrders)
          .where(and(eq(schema.platformOrders.platform, p), eq(schema.platformOrders.status, 'kabul')))
          .all().length
      : 0;
    out[p] = { supported: !!a, configured: !!a?.configured(), lastPollAt: s.lastOkAt ?? null, lastError: s.lastError ?? null, openOrders: pending };
  }
  return out;
}

/**
 * Platformun işlemi (iptal) kasa personeli adına değil platform adına yazılır: denetim kaydında platformun adı, yetkisi
 * tam (karar platformun). Kullanıcı tablosunda satırı yoktur: yalnız kullanıcıya bağlı olmayan alanlara (denetim
 * kaydı, platform_orders) yazılabilir.
 */
export function platformUser(platform: PlatformId): AuthUser {
  return { id: `platform:${platform}`, name: PLATFORM_LABEL[platform], role: 'patron', color: '#616367', permissions: new Set(ALL_PERMISSIONS), maxDiscountPct: 100, sessionId: '' };
}

/**
 * Kabul edilmiş siparişin iptali adisyona yazar (iptal eden kişi kullanıcı tablosuna bağlı): siparişi kabul eden
 * kişi adına, platformun yetkisiyle. Kabul edilmemiş kayıtta kullanıcı gerekmez.
 */
function actingUser(row: PlatformRow): AuthUser {
  const base = platformUser(row.platform);
  if (!row.decidedBy) return base;
  const u = db.select().from(schema.users).where(eq(schema.users.id, row.decidedBy)).get();
  return u ? { ...base, id: u.id, name: `${u.name} (${base.name})` } : base;
}

function setError(id: string, lastError: string | null) {
  db.update(schema.platformOrders).set({ lastError }).where(eq(schema.platformOrders.id, id)).run();
}

/** Kabulden önce platforma: reddederse 502, yerelde kabul edilmez. Dönen değer kayda yazılacak bildirim durumu */
export async function announceAccept(row: PlatformRow, prepMinutes: number): Promise<string | null> {
  const a = liveFor(row);
  if (!a) return null;
  try {
    await a.accept(row.payload, prepMinutes);
    return 'picked';
  } catch (e) {
    const why = `${a.label}'a kabul bildirilemedi: ${message(e)}`;
    setError(row.id, why);
    throw new HttpError(502, `${why}. Yeniden deneyin; olmazsa platform uygulamasından kabul edin`, 'platform_unreachable');
  }
}

/** Retten önce platforma (`unsupplied`); reddederse 502, yerelde reddedilmez */
export async function announceReject(row: PlatformRow, reason: string): Promise<string | null> {
  const a = liveFor(row);
  if (!a) return null;
  try {
    await a.reject(row.payload, reason);
    return 'unsupplied';
  } catch (e) {
    const why = `${a.label}'a ret bildirilemedi: ${message(e)}`;
    setError(row.id, why);
    throw new HttpError(502, `${why}. Yeniden deneyin; olmazsa platform uygulamasından reddedin`, 'platform_unreachable');
  }
}

/** Platforma yazılan aşamaların sırası: platform sıralı ister (hazır olmadan yolda yazılmaz) */
const STEPS: readonly (PlatformNotify | 'picked')[] = ['picked', 'hazir', 'yolda', 'teslim'];

/** Adisyonun teslim aşamasından platforma yazılması gereken son adım; platform kuryesinde yolda ve teslimi platform yazar */
export function desiredStep(deliveryStatus: string | null, courier: PlatformOrderPayload['courier']): PlatformNotify | null {
  if (!deliveryStatus || deliveryStatus === 'hazirlaniyor') return null;
  if (courier === 'platform' || deliveryStatus === 'hazir') return 'hazir';
  return deliveryStatus === 'yolda' ? 'yolda' : 'teslim';
}

/**
 * Kabul edilmiş canlı siparişlerin teslim aşamalarını platforma yazar: kaydın `notifiedStatus`'u ile adisyonun
 * aşaması arasındaki adımlar sırayla gider; gidemeyen `lastError` ile kalır, sonraki turda yeniden denenir.
 */
export async function reconcileNotifications(now = Date.now()): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const rows = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.status, 'kabul')).all();
  for (const row of rows) {
    const a = liveFor(row);
    if (!a || !row.orderId) continue;
    const o = db.select({ deliveryStatus: schema.orders.deliveryStatus, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
    if (!o || o.status === 'iptal') continue;
    const want = desiredStep(o.deliveryStatus, row.payload.courier);
    if (!want) continue;
    const have = STEPS.indexOf((row.notifiedStatus as PlatformNotify | 'picked' | null) ?? 'picked');
    const target = STEPS.indexOf(want);
    if (target <= have) continue;
    let current = row.notifiedStatus;
    try {
      for (let i = have + 1; i <= target; i++) {
        const step = STEPS[i] as PlatformNotify;
        await a.notify(row.payload, step, row.payload.courier);
        current = step;
        db.update(schema.platformOrders).set({ notifiedStatus: step, lastError: null }).where(eq(schema.platformOrders.id, row.id)).run();
      }
      sent++;
    } catch (e) {
      failed++;
      const why = `${a.label}'a aşama bildirilemedi (${want}): ${message(e)}`;
      db.update(schema.platformOrders).set({ notifiedStatus: current, lastError: why }).where(eq(schema.platformOrders.id, row.id)).run();
      if (!row.lastError) {
        const fx = new Effects();
        fx.audit(db, { action: 'platform.notify_failed', severity: 'uyari', orderId: row.orderId, message: `${why}; yeniden denenecek (${row.payload.code}, ${tl(row.payload.customerTotal)})` });
        fx.flush();
      }
    }
  }
  return { sent, failed };
}

/** Platformun iptal ettiği paketler: bekleyen kayıt kapanır, kabul edilmiş adisyon iptal olur (platform ödemesi geri) */
function applyCancellations(platform: PlatformId, externalIds: string[]) {
  if (!externalIds.length) return 0;
  const rows = db
    .select()
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, platform), inArray(schema.platformOrders.externalId, externalIds), inArray(schema.platformOrders.status, ['bekliyor', 'kabul'])))
    .all();
  let n = 0;
  for (const row of rows) {
    if (row.payload.simulated) continue;
    const fx = new Effects();
    try {
      tx((t) => platformCancelled(t, actingUser(row), fx, row.id, ''));
      n++;
    } catch (e) {
      // Kasada alınmış ödeme var: kasiyer o ödemeyi yetkili onayıyla geri alıp siparişi iptal eder
      const why = `${PLATFORM_LABEL[platform]} iptal etti ama adisyon kapatılamadı: ${message(e)}`;
      setError(row.id, why);
      fx.audit(db, { action: 'platform.cancel_blocked', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why} (${row.payload.code})` });
    }
    fx.flush();
  }
  return n;
}

/** Bir platformu yoklar: yeni siparişler kayda girer (tekilleştirilir), iptaller uygulanır; durum sync_state'te */
export async function pollPlatform(platform: PlatformId, now = Date.now()): Promise<{ created: number; cancelled: number } | null> {
  const a = liveAdapter(platform);
  if (!a) return null;
  const state = readState(platform);
  const since = state.lastOkAt ?? now - 2 * 3600_000;
  try {
    const { orders, cancelled } = await a.poll(since, now);
    let created = 0;
    for (const payload of orders) {
      const fx = new Effects();
      const res = tx((t) => ingestPlatformOrder(t, fx, payload, now));
      fx.flush();
      if (res.created) created++;
    }
    const n = applyCancellations(platform, cancelled);
    writeState(platform, { lastPollAt: now, lastOkAt: now, lastError: null, failures: 0 });
    return { created, cancelled: n };
  } catch (e) {
    const failures = (state.failures ?? 0) + 1;
    const lastError = `${a.label} yoklanamadı: ${message(e)}`;
    writeState(platform, { ...state, lastPollAt: now, lastError, failures });
    if (failures === 1 || failures % 15 === 0) {
      const fx = new Effects();
      fx.audit(db, { action: 'platform.poll_failed', severity: failures >= 15 ? 'alarm' : 'uyari', message: `${lastError} (${failures}. deneme); siparişler platform uygulamasında birikiyor olabilir` });
      fx.flush();
    }
    throw e;
  }
}

/** Yoklama sırası geldi mi (art arda hatada bekleme) */
export function pollDue(platform: PlatformId, now = Date.now()): boolean {
  const s = readState(platform);
  if (!s.lastPollAt) return true;
  const wait = s.failures ? backoff(s.failures) : POLL_INTERVAL_MS;
  return now - s.lastPollAt >= wait - 500;
}

let running = false;

/** Zamanlayıcı turu (20 sn): canlı platformları yoklar, sonra bekleyen aşama bildirimlerini gönderir */
export async function liveTick(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const p of PLATFORMS) {
      if (!liveAdapter(p) || !pollDue(p, now)) continue;
      await pollPlatform(p, now).catch(() => undefined);
    }
    await reconcileNotifications(now).catch((e) => console.warn('[platform] aşama bildirimi', message(e)));
  } finally {
    running = false;
  }
}
