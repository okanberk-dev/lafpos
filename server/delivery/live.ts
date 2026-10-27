import { and, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import { tl } from '@shared/money';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { PLATFORM_LABEL, type PlatformId, type PlatformLiveStatus, type PlatformOrderPayload, PLATFORMS } from '@shared/platforms';
import { db, schema, type Tx, tx } from '../db/client';
import type { AuthUser } from '../lib/auth';
import { type AuditEntry, Effects } from '../lib/effects';
import { HttpError } from '../lib/http';
import { getSyncState, setSyncState } from '../lib/settings';
import { type PlatformAdapter, PlatformHttpError, type PlatformNotify, type PollResult } from './adapter';
import { deciding } from './locks';
import { adapterFor } from './registry';
import { ingestPlatformOrder, platformCancelled, platformSettings } from './service';

/**
 * Canlı platform bağlantısı (docs/PAKET-PLATFORMLARI.md "Canlı"): yoklama (yeni sipariş, platformun iptali), kabul
 * ve ret platforma önce bildirilir (platform reddederse yerelde yapılmaz), teslim aşamaları (hazır, yolda, teslim)
 * sırayla platforma yazılır ve yazılamayan yeniden denenir (`platform_orders.notifiedStatus`, `lastError`). Kasada
 * iptal edilen kabul edilmiş sipariş platforma da bildirilir. Deneme siparişleri (`simulated`) platforma hiç gitmez.
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

function emit(kind: string) {
  const fx = new Effects();
  fx.emit({ topic: 'delivery', kind });
  fx.flush();
}

/** Yoklama durumu; hata değişince Yönetim › Paket platformları yenilensin (her turda olay yayılmaz) */
function writeState(p: PlatformId, s: LiveState) {
  const before = readState(p).lastError ?? null;
  setSyncState(stateKey(p), s);
  if (before !== (s.lastError ?? null)) emit('platform.live');
}

/** Yoklama aralığı ve art arda hatada bekleme (en çok 5 dk) */
export const POLL_INTERVAL_MS = 20_000;
const backoff = (failures: number) => Math.min(5 * 60_000, POLL_INTERVAL_MS * 2 ** Math.min(failures, 4));

/** Aşama bildirimi ve platform iptalinin yeniden denenmesi yalnız son 48 saatte kabul edilenlerde (eskisi platformda kapanmıştır) */
export const RECONCILE_WINDOW_MS = 48 * 3600_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const permanentOf = (e: unknown) => e instanceof PlatformHttpError && e.permanent;

const STEP_LABEL: Record<PlatformNotify, string> = { hazir: 'Hazır', yolda: 'Yolda', teslim: 'Teslim edildi' };

/** Yeni sipariş yoklaması: platformun canlı bağlantısı açık ve anahtarı tanımlı mı */
export function liveAdapter(platform: PlatformId): PlatformAdapter | null {
  const a = adapterFor(platform);
  return a && a.configured() && platformSettings()[platform].mode === 'canli' ? a : null;
}

/** Platformda süren gerçek sipariş var mı: onay bekleyen ya da adisyonu açık kabul edilmiş (deneme siparişi sayılmaz) */
function hasOpenReal(platform: PlatformId): boolean {
  const pending = db
    .select({ payload: schema.platformOrders.payload })
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, platform), eq(schema.platformOrders.status, 'bekliyor')))
    .all();
  if (pending.some((r) => !r.payload.simulated)) return true;
  return db
    .select({ payload: schema.platformOrders.payload })
    .from(schema.platformOrders)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.platformOrders.orderId))
    .where(and(eq(schema.platformOrders.platform, platform), eq(schema.platformOrders.status, 'kabul'), eq(schema.orders.status, 'acik')))
    .all()
    .some((r) => !r.payload.simulated);
}

/**
 * Yoklanacak mı ve yeni sipariş kayda girecek mi: Canlı'da ikisi de. Kapalı ya da Deneme'de yalnız platformda süren
 * gerçek sipariş varken yoklanır (platformun iptali kasaya ulaşsın), yeni sipariş kayda girmez.
 */
function pollTarget(platform: PlatformId): { a: PlatformAdapter; intake: boolean } | null {
  const a = adapterFor(platform);
  if (!a?.configured()) return null;
  if (platformSettings()[platform].mode === 'canli') return { a, intake: true };
  return hasOpenReal(platform) ? { a, intake: false } : null;
}

/**
 * Gerçek (platformdan gelmiş) siparişin bağdaştırıcısı, modu ne olursa olsun: "Kapalı" yalnız yeni siparişi durdurur,
 * platformda yaşayan sipariş platformla konuşmaya devam eder. Deneme siparişinde null. Anahtar yoksa (kaldırılmış)
 * yerel karar verilmez: platform onu bilmeden kabul ya da ret olmasın.
 */
function realAdapter(row: Pick<PlatformRow, 'platform' | 'payload'>): PlatformAdapter | null {
  if (row.payload.simulated) return null;
  const a = adapterFor(row.platform);
  if (!a?.configured()) throw new HttpError(409, `${PLATFORM_LABEL[row.platform]} bağlantısı tanımlı değil (anahtarlar .env'de yok): bu siparişi platform uygulamasından yönetin`, 'platform_off');
  return a;
}

/** Yönetim › Paket platformları: her platformun canlı bağlantı durumu; açık sipariş = adisyonu açık kabul edilmişler */
export function liveStatus(): Record<PlatformId, PlatformLiveStatus> {
  const out = {} as Record<PlatformId, PlatformLiveStatus>;
  for (const p of PLATFORMS) {
    const a = adapterFor(p);
    const s = readState(p);
    const open = a
      ? db
          .select({ id: schema.platformOrders.id })
          .from(schema.platformOrders)
          .innerJoin(schema.orders, eq(schema.orders.id, schema.platformOrders.orderId))
          .where(and(eq(schema.platformOrders.platform, p), eq(schema.platformOrders.status, 'kabul'), eq(schema.orders.status, 'acik')))
          .all().length
      : 0;
    out[p] = { supported: !!a, configured: !!a?.configured(), lastPollAt: s.lastOkAt ?? null, lastError: s.lastError ?? null, openOrders: open };
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

/** Kaydın platform alanları tek işlemde (gerekirse denetim kaydıyla) yazılır; şerit ve yönetim ekranı yenilenir */
function patchRow(id: string, set: Partial<PlatformRow>, audit?: AuditEntry) {
  const fx = new Effects();
  tx((t) => {
    t.update(schema.platformOrders).set(set).where(eq(schema.platformOrders.id, id)).run();
    if (audit) fx.audit(t, audit);
  });
  fx.emit({ topic: 'delivery', kind: 'platform.sync' });
  fx.flush();
}

/**
 * Aynı platform siparişine iki ekrandan aynı anda kabul ya da ret gitmesin: platform çağrısı yerel karardan önce
 * yapıldığı için işlem kilidi yetmez (iki istek de "onay bekliyor" görür ve ikisi de platforma yazar)
 */
export async function withDecisionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (deciding.has(id)) throw new HttpError(409, 'Bu sipariş şu an başka bir ekranda işleniyor; birkaç saniye sonra yeniden bakın', 'busy');
  deciding.add(id);
  try {
    return await fn();
  } finally {
    deciding.delete(id);
  }
}

class Rehearsal extends Error {}

/**
 * Yazımı dener ve geri alır: platforma "kabul" denmeden önce adisyonun açılabildiği (gün açık, ürün tükenmemiş,
 * porsiyon yetiyor) görülür. Atılan hata olduğu gibi döner; olaylar yayılmaz.
 */
export function rehearse(fn: (t: Tx) => unknown) {
  try {
    tx((t) => {
      fn(t);
      throw new Rehearsal();
    });
  } catch (e) {
    if (!(e instanceof Rehearsal)) throw e;
  }
}

/** Kabulden önce platforma: reddederse 502, yerelde kabul edilmez. Dönen değer kayda yazılacak bildirim durumu */
export async function announceAccept(row: PlatformRow, prepMinutes: number): Promise<string | null> {
  const a = realAdapter(row);
  if (!a) return null;
  // Önceki denemede platform kabul etmiş, adisyon açılamamıştı: platforma ikinci kez gitmez
  if (row.notifiedStatus === 'picked') return 'picked';
  try {
    await a.accept(row.payload, prepMinutes);
  } catch (e) {
    const why = `${a.label}: kabul bildirilemedi (${message(e)})`;
    patchRow(row.id, { lastError: why });
    throw new HttpError(502, `${why}. Yeniden deneyin; olmazsa platform uygulamasından kabul edin`, 'platform_unreachable');
  }
  // Platform kabul etti: adisyon açılamasa da bu bilgi kalır (süre dolunca iptal sayılmaz, yeniden denemede tekrar gitmez)
  patchRow(row.id, { notifiedStatus: 'picked', lastError: null });
  return 'picked';
}

/** Platform kabul etti ama adisyon açılamadı: şeritte görünür, patrona bir kez alarm; Kabul yalnız yerelde yeniden dener */
export function acceptFailedLocally(row: PlatformRow, e: unknown) {
  const why = `Platformda kabul edildi ama adisyon açılamadı: ${message(e)}. Sorunu giderip yeniden deneyin`;
  const first = !row.lastError?.startsWith('Platformda kabul edildi');
  patchRow(
    row.id,
    { lastError: why },
    first ? { action: 'platform.accept_failed', severity: 'alarm', amount: row.payload.customerTotal, message: `${PLATFORM_LABEL[row.platform]} ${row.payload.code}: ${why}` } : undefined,
  );
}

/** Retten önce platforma (`unsupplied`); reddederse 502, yerelde reddedilmez */
export async function announceReject(row: PlatformRow, reason: string): Promise<string | null> {
  const a = realAdapter(row);
  if (!a) return null;
  if (row.notifiedStatus === 'unsupplied') return 'unsupplied';
  try {
    await a.reject(row.payload, reason);
  } catch (e) {
    const why = `${a.label}: ret bildirilemedi (${message(e)})`;
    patchRow(row.id, { lastError: why });
    throw new HttpError(502, `${why}. Yeniden deneyin; olmazsa platform uygulamasından reddedin`, 'platform_unreachable');
  }
  patchRow(row.id, { notifiedStatus: 'unsupplied', lastError: null });
  return 'unsupplied';
}

/** Platforma yazılan aşamaların sırası: platform sıralı ister (hazır olmadan yolda yazılmaz) */
const STEPS: readonly (PlatformNotify | 'picked')[] = ['picked', 'hazir', 'yolda', 'teslim'];

/** Adisyonun teslim aşamasından platforma yazılması gereken son adım; platform kuryesinde yolda ve teslimi platform yazar */
export function desiredStep(deliveryStatus: string | null, courier: PlatformOrderPayload['courier']): PlatformNotify | null {
  if (!deliveryStatus || deliveryStatus === 'hazirlaniyor') return null;
  if (courier === 'platform' || deliveryStatus === 'hazir') return 'hazir';
  return deliveryStatus === 'yolda' ? 'yolda' : 'teslim';
}

let reconciling: Promise<{ sent: number; failed: number }> | null = null;
let again = false;

/**
 * Kabul edilmiş canlı siparişlerin platformla eşitlenmesi: teslim aşamaları sırayla gider, kasada iptal edilen
 * sipariş platforma da bildirilir, platformun kasada uygulanamamış iptali yeniden denenir. Tek koşu: zamanlayıcı ve
 * teslim olayı aynı anda isterse ikincisi ilki bitince bir kez daha koşar (aynı aşama iki kez gitmez, kayıt geriye
 * sarmaz).
 */
export function reconcileNotifications(now?: number): Promise<{ sent: number; failed: number }> {
  if (reconciling) {
    again = true;
    return reconciling;
  }
  const run = (async () => {
    const total = { sent: 0, failed: 0 };
    try {
      let at = now;
      do {
        again = false;
        const r = await reconcileOnce(at ?? Date.now());
        total.sent += r.sent;
        total.failed += r.failed;
        at = undefined;
      } while (again);
      return total;
    } finally {
      reconciling = null;
    }
  })();
  reconciling = run;
  return run;
}

async function reconcileOnce(now: number): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  // Son 48 saatte kabul edilenler; platform iptali kasada bekleyenler yaşından bağımsız
  const ids = db
    .select({ id: schema.platformOrders.id })
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.status, 'kabul'), or(isNotNull(schema.platformOrders.cancelPendingAt), gte(schema.platformOrders.decidedAt, now - RECONCILE_WINDOW_MS))))
    .all();
  for (const { id } of ids) {
    // Tur ağ beklerken yoklama kaydı değiştirmiş olabilir (platform iptali): her kayıt işlemden hemen önce okunur
    const row = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
    if (!row || row.status !== 'kabul' || row.payload.simulated || !row.orderId) continue;
    // Platform iptal etmişti, kasada ödeme vardı: ödeme geri alındıysa şimdi kapanır
    if (row.cancelPendingAt != null) {
      retryCancellation(row);
      continue;
    }
    let a: PlatformAdapter | null;
    try {
      a = realAdapter(row);
    } catch {
      continue;
    }
    if (!a) continue;
    const o = db
      .select({ deliveryStatus: schema.orders.deliveryStatus, status: schema.orders.status, cancelReason: schema.orders.cancelReason })
      .from(schema.orders)
      .where(eq(schema.orders.id, row.orderId))
      .get();
    if (!o) continue;
    if (o.status === 'iptal') {
      if (await announceLocalCancel(a, row, o.cancelReason)) sent++;
      else failed++;
      continue;
    }
    // Platform bu siparişin bir aşamasını kalıcı olarak reddetti: aşama bildirimi durur (iptal dalları sürer)
    if (row.notifyParkedAt != null) continue;
    const want = desiredStep(o.deliveryStatus, row.payload.courier);
    if (!want) continue;
    const have = STEPS.indexOf((row.notifiedStatus as PlatformNotify | 'picked' | null) ?? 'picked');
    const target = STEPS.indexOf(want);
    if (target <= have) continue;
    let current = row.notifiedStatus;
    let step: PlatformNotify = want;
    try {
      for (let i = have + 1; i <= target; i++) {
        step = STEPS[i] as PlatformNotify;
        await a.notify(row.payload, step, row.payload.courier);
        current = step;
        patchRow(row.id, { notifiedStatus: step, lastError: null });
      }
      sent++;
    } catch (e) {
      failed++;
      const permanent = permanentOf(e);
      const why = `${a.label}: "${STEP_LABEL[step]}" bildirilemedi (${message(e)})`;
      const ref = `${row.payload.code}, ${tl(row.payload.customerTotal)}`;
      patchRow(
        row.id,
        { notifiedStatus: current, lastError: why, notifyParkedAt: permanent ? Date.now() : null },
        permanent
          ? { action: 'platform.notify_rejected', severity: 'alarm', orderId: row.orderId, message: `${why}; platform kabul etmedi, yeniden denenmeyecek: aşamayı platform uygulamasından işaretleyin (${ref})` }
          : !row.lastError
            ? { action: 'platform.notify_failed', severity: 'uyari', orderId: row.orderId, message: `${why}; yeniden denenecek (${ref})` }
            : undefined,
      );
    }
  }
  return { sent, failed };
}

/**
 * Kabul edilmiş sipariş kasada iptal edildi: platforma "tedarik edilemedi" gider ve kayıt kapanır. Platform kalıcı
 * olarak reddederse (ör. kurye yolda) kayıt yine kapanır, hata kayıtta kalır ve patrona alarm: sipariş platform
 * uygulamasından iptal edilir. Geçici hata sonraki turda yeniden denenir.
 */
async function announceLocalCancel(a: PlatformAdapter, row: PlatformRow, cancelReason: string | null): Promise<boolean> {
  const reason = cancelReason?.trim() || 'Diğer';
  const ref = `${row.payload.code}, ${tl(row.payload.customerTotal)}`;
  try {
    await a.reject(row.payload, reason);
  } catch (e) {
    const permanent = permanentOf(e);
    const why = `${a.label}: kasada iptal edilen sipariş platforma bildirilemedi (${message(e)})`;
    patchRow(
      row.id,
      permanent ? { status: 'iptal', decidedAt: Date.now(), lastError: why, reason: `Kasada iptal edildi: ${reason}; platforma bildirilemedi` } : { lastError: why },
      permanent
        ? { action: 'platform.cancel_unsynced', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}: siparişi platform uygulamasından iptal edin (${ref})` }
        : !row.lastError
          ? { action: 'platform.cancel_unsynced', severity: 'uyari', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}; yeniden denenecek (${ref})` }
          : undefined,
    );
    return false;
  }
  patchRow(
    row.id,
    { status: 'iptal', notifiedStatus: 'unsupplied', lastError: null, reason: `Kasada iptal edildi: ${reason}` },
    { action: 'platform.cancel_sent', severity: 'uyari', orderId: row.orderId, amount: row.payload.customerTotal, message: `Kasada iptal edilen ${a.label} siparişi platforma bildirildi (${ref}, ${reason})` },
  );
  return true;
}

/** Platformun iptali kasada ödeme yüzünden uygulanamamıştı: her turda sessizce yeniden denenir (alarm ilk seferde düştü) */
function retryCancellation(row: PlatformRow) {
  const fx = new Effects();
  try {
    tx((t) => platformCancelled(t, actingUser(row), fx, row.id, ''));
  } catch {
    return;
  }
  fx.flush();
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
    // Kabul ya da ret o an sürüyor: sonraki yoklama (aynı pencere) yeniden getirir
    if (deciding.has(row.id)) continue;
    // Zaten bekliyor: aşama turu yeniden dener, alarm yinelenmez
    if (row.cancelPendingAt != null) continue;
    const fx = new Effects();
    try {
      tx((t) => platformCancelled(t, actingUser(row), fx, row.id, ''));
      fx.flush();
      n++;
    } catch (e) {
      // Kasada alınmış ödeme var: kasiyer o ödemeyi yetkili onayıyla geri alınca kendiliğinden kapanır. Geri alınan
      // işlemin olayları (iade) yayılmaz: yeni bir Effects ile yalnız alarm
      const why = `${PLATFORM_LABEL[platform]} iptal etti ama adisyon kapatılamadı: ${message(e)}`;
      patchRow(
        row.id,
        { cancelPendingAt: row.orderId ? Date.now() : null, lastError: why },
        { action: 'platform.cancel_blocked', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why} (${row.payload.code})` },
      );
    }
  }
  return n;
}

/** Çevrilemeyen ya da kayda girmeyen paketler süreç başına bir kez denetim kaydına düşer (her turda yinelenmesin) */
const reportedInvalid = new Set<string>();

function reportInvalid(platform: PlatformId, bad: { externalId: string; error: string }[]) {
  for (const b of bad) {
    const key = `${platform}:${b.externalId}`;
    if (reportedInvalid.has(key)) continue;
    reportedInvalid.add(key);
    const fx = new Effects();
    fx.audit(db, { action: 'platform.package_invalid', severity: 'alarm', message: `${PLATFORM_LABEL[platform]} paketi ${b.externalId} okunamadı ve atlandı (${b.error}): siparişi platform uygulamasından yönetin` });
    fx.flush();
  }
}

/**
 * Bir platformu yoklar: yeni siparişler kayda girer (tekilleştirilir; Kapalı'da girmez), iptaller uygulanır; durum
 * sync_state'te
 */
export async function pollPlatform(platform: PlatformId, now = Date.now()): Promise<{ created: number; cancelled: number } | null> {
  const target = pollTarget(platform);
  if (!target) return null;
  const { a, intake } = target;
  const state = readState(platform);
  const since = state.lastOkAt ?? now - 2 * 3600_000;
  let res: PollResult;
  try {
    res = await a.poll(since, now);
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
  // Tek paketin kaydı düşerse ötekiler durmaz. Kapalı'da yeni sipariş kayda girmez (siparişi iten platformda
  // aktarıcının gelen kutusunda kalır), bozuk paket de bildirilmez
  const bad = intake ? [...(res.invalid ?? [])] : [];
  const skipped = new Set<string>();
  let created = 0;
  for (const payload of res.orders) {
    if (!intake) {
      skipped.add(payload.externalId);
      continue;
    }
    const fx = new Effects();
    try {
      const r = tx((t) => ingestPlatformOrder(t, fx, payload, now));
      fx.flush();
      if (r.created) created++;
    } catch (e) {
      bad.push({ externalId: payload.externalId, error: message(e) });
    }
  }
  reportInvalid(platform, bad);
  const n = applyCancellations(platform, res.cancelled);
  // Yerelde işlendi: aktarıcıdaki kayıtlar artık silinebilir (silinemezse yeniden gelir, tekilleştirilir)
  await res.commit?.(skipped).catch((e) => console.warn(`[platform] ${a.label} gelen kutusu temizlenemedi`, message(e)));
  writeState(platform, { lastPollAt: now, lastOkAt: now, lastError: null, failures: 0 });
  return { created, cancelled: n };
}

/** Yoklama sırası geldi mi (art arda hatada bekleme) */
export function pollDue(platform: PlatformId, now = Date.now()): boolean {
  const s = readState(platform);
  if (!s.lastPollAt) return true;
  const wait = s.failures ? backoff(s.failures) : POLL_INTERVAL_MS;
  return now - s.lastPollAt >= wait - 500;
}

let running = false;

/** Zamanlayıcı turu (20 sn): canlı platformları yoklar, sonra kabul edilmiş siparişleri platformla eşitler */
export async function liveTick(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const p of PLATFORMS) {
      if (!pollTarget(p) || !pollDue(p, now)) continue;
      await pollPlatform(p, now).catch(() => undefined);
    }
    await reconcileNotifications(now).catch((e) => console.warn('[platform] aşama bildirimi', message(e)));
  } finally {
    running = false;
  }
}
