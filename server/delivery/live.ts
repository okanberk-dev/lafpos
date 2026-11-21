import { and, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { ALL_PERMISSIONS } from '@shared/permissions';
import { AUTO_ACCEPT_MAX_AGE_MS, AUTO_ACCEPT_MIN_LEFT_MS, AUTO_SKIP_PREFIX, PLATFORM_LABEL, type PlatformId, type PlatformLiveStatus, type PlatformOrderPayload, PLATFORMS } from '@shared/platforms';
import { db, schema, type Tx, tx } from '../db/client';
import type { AuthUser } from '../lib/auth';
import { type AuditEntry, Effects } from '../lib/effects';
import { conflict, HttpError } from '../lib/http';
import { getSettings, getSyncState, setSyncState, trainingMode } from '../lib/settings';
import { requireCurrentDay } from '../services/orders';
import { type PlatformAdapter, PlatformHttpError, type PlatformNotify, type PollResult } from './adapter';
import { deciding, manualDecision } from './locks';
import { adapterFor } from './registry';
import {
  acceptPlatformOrder,
  autoAcceptor,
  expiredMessage,
  getPlatformOrder,
  ingestPlatformOrder,
  lineIssues,
  soldOutOptionsOf,
  PRE_ACCEPTED_TTL_MS,
  platformAmount,
  platformCancelled,
  platformSettings,
} from './service';

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
  /** Art arda "yeni sipariş alınamıyor" turları (`PollResult.blocked`; bekleme süresini uzatmaz) */
  blockedRounds?: number;
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

/**
 * Geçici sayılan hata (ör. Getir 14 "kurye durumu", 15, 4; ağ) bu süreden uzun sürerse patrona bir kez alarm: yeniden
 * deneme sürer ama durum zamanla düzelmiyor olabilir. Kasadaki iptalde daha kısa (platformda sipariş sürüyor)
 */
export const TRANSIENT_ALARM_MS = { notify: 10 * 60_000, cancel: 5 * 60_000 } as const;
/** Kayıt → ilk geçici hatanın anı ve alarmın düşüp düşmediği (süreç başına; yeniden başlayınca yeniden sayılır) */
const transientSince = new Map<string, { at: number; alarmed: boolean }>();

/** Geçici hata sürüyor: süre aşıldıysa ve alarm daha düşmediyse true (bir kez) */
function transientOverdue(key: string, kind: keyof typeof TRANSIENT_ALARM_MS, now: number): number | null {
  const t = transientSince.get(key) ?? { at: now, alarmed: false };
  transientSince.set(key, t);
  if (t.alarmed || now - t.at < TRANSIENT_ALARM_MS[kind]) return null;
  t.alarmed = true;
  return Math.max(1, Math.round((now - t.at) / 60_000));
}

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
  if (!a?.configured()) throw new HttpError(409, `${PLATFORM_LABEL[row.platform]} bağlantısı tanımlı değil (anahtarlar Yönetim › Bağlantı bilgileri'nde yok): bu siparişi platform uygulamasından yönetin`, 'platform_off');
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
 * yapıldığı için işlem kilidi yetmez (iki istek de "onay bekliyor" görür ve ikisi de platforma yazar). Kasadaki karar
 * (`auto` değil) kaydı `manualDecision`'a da koyar: sonucu ne olursa olsun otomatik kabul o kayda dokunmaz. Kilidi
 * otomatik kabul tutuyorsa ve `whileAuto` verildiyse (kasadaki Reddet) onun hatası atılır, "başka bir ekranda" değil.
 */
export async function withDecisionLock<T>(id: string, fn: () => Promise<T>, opts: { auto?: boolean; whileAuto?: () => HttpError } = {}): Promise<T> {
  const holder = deciding.get(id);
  if (holder === 'auto' && opts.whileAuto) throw opts.whileAuto();
  if (holder) throw new HttpError(409, 'Bu sipariş şu an başka bir ekranda işleniyor; birkaç saniye sonra yeniden bakın', 'busy');
  deciding.set(id, opts.auto ? 'auto' : 'manual');
  if (!opts.auto) manualDecision.add(id);
  try {
    return await fn();
  } finally {
    deciding.delete(id);
  }
}

/** Otomatik kabul platform çağrısındayken kasadaki Reddet: ret gitmez, kabul edilirse sipariş adisyondan iptal edilir */
export const AUTO_ACCEPTING_MESSAGE = 'Otomatik kabul ediliyor; kabul edilirse adisyondan iptal edin';

/**
 * Kasadaki Reddet otomatik kabulün kilidine denk geldi: ret platforma gitmez (kabul platformda sürüyor), kişinin ret
 * denemesi denetim kaydına yazılır (bilgi) ve kayıt kasadaki karar sayılır (`manualDecision`: kabul düşerse otomatik kabul
 * yeniden denemez, sipariş elle kalır). 409 `auto_accepting`; şerit iletiyi gösterir.
 */
export function rejectWhileAutoAccepting(user: AuthUser, id: string, reason: string): HttpError {
  manualDecision.add(id);
  const row = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
  const fx = new Effects();
  tx((t) =>
    fx.audit(t, {
      userId: user.id,
      action: 'platform.reject_try',
      amount: row?.payload.customerTotal ?? null,
      message: `${user.name} ${row ? `${PLATFORM_LABEL[row.platform]} ${row.payload.code}` : 'platform'} siparişini reddetmek istedi (${reason}); otomatik kabul o an sürüyordu, ret gitmedi`,
    }),
  );
  fx.flush();
  return new HttpError(409, AUTO_ACCEPTING_MESSAGE, 'auto_accepting');
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

/**
 * Kabulden önce platforma: reddederse 502, yerelde kabul edilmez. Dönen değer kayda yazılacak bildirim durumu.
 * Platform siparişi zaten kabul edilmiş bulursa (`'already'`: Getir panelinden ya da IVR'dan onaylanmış) elle Kabul
 * adisyonu açar (kişi karar verdi); otomatik kabul açmaz: kayıt platformun panelinden kabul edilmiş gibi işaretlenir
 * (`markAcceptedElsewhere`, alarm) ve sipariş elle kalır, Kabul yalnız adisyonu açar (barda çift hazırlık riski)
 */
export async function announceAccept(row: PlatformRow, prepMinutes: number, opts: { auto?: boolean } = {}): Promise<string | null> {
  const a = realAdapter(row);
  if (!a) return null;
  // Önceki denemede platform kabul etmiş, adisyon açılamamıştı: platforma ikinci kez gitmez
  if (row.notifiedStatus === 'picked') return 'picked';
  let result: void | 'already';
  try {
    result = await a.accept(row.payload, prepMinutes);
  } catch (e) {
    const why = `${a.label}: kabul bildirilemedi (${message(e)})`;
    patchRow(row.id, { lastError: why });
    throw new HttpError(502, `${why}. Yeniden deneyin; olmazsa platform uygulamasından kabul edin`, 'platform_unreachable');
  }
  if (result === 'already' && opts.auto) {
    markAcceptedElsewhere(row);
    throw new AcceptedElsewhere();
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

/** Otomatik kabulün koşulu tutmadı: sipariş elle kabul bekler (nedeni şeritte ve denetim kaydında) */
class AutoSkip extends Error {}
/** Otomatik kabulde platform siparişi zaten kabul edilmiş buldu: kayıt işaretlendi (alarm), sipariş elle kalır */
class AcceptedElsewhere extends Error {}

/**
 * Kabul (kasadaki Kabul ve otomatik kabul aynı yoldan): canlı bağlantıda önce adisyonun açılabildiği yerelde denenir
 * (gün açık, ürün tükenmemiş, porsiyon yetiyor; geri alınır), sonra platforma bildirilir (platform reddederse 502,
 * yerelde kabul edilmez: platform sipariş durumunun sahibidir), sonra adisyon açılır. Platform kabul edip adisyon yine
 * de açılamazsa kayıt bunu tutar: süre dolmaz, yeniden Kabul platforma ikinci kez gitmez. Deneme siparişi platforma
 * gitmez. İki ekrandan (ya da ekranla otomatik kabulden) aynı anda karar verilmez. `auto`: koşullar kilidin içinde
 * yeniden okunur (`autoAcceptBlocker`; kasada karar denenmiş kayıt atlanır), deneme siparişi de provadan geçer ve
 * adisyonun tutarı platformun tutarına eşit olmalıdır.
 */
export async function acceptFlow(user: AuthUser, id: string, prepMinutes?: number, opts: { auto?: boolean } = {}) {
  return withDecisionLock(id, async () => {
    const row = getPlatformOrder(db, id);
    if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
    const announced = row.notifiedStatus === 'picked';
    if (!announced && row.expiresAt != null && row.expiresAt <= Date.now()) throw conflict(expiredMessage(row), 'expired');
    if (opts.auto) {
      const why = autoAcceptBlocker(row);
      if (why) throw new AutoSkip(why);
    }
    const prep = prepMinutes ?? platformSettings()[row.platform].prepMinutes;
    if ((opts.auto || !row.payload.simulated) && !announced) {
      rehearse((t) => {
        const { order } = acceptPlatformOrder(t, user, new Effects(), row.id, prep, { notifiedStatus: 'picked' });
        const expected = platformAmount(row.payload);
        if (opts.auto && order.total !== expected) throw new AutoSkip(`adisyon ${tl(order.total)}, platformun tutarı ${tl(expected)}`);
      });
    }
    const notifiedStatus = await announceAccept(row, prep, { auto: opts.auto });
    const fx = new Effects();
    try {
      const res = tx((t) => acceptPlatformOrder(t, user, fx, row.id, prep, { notifiedStatus, auto: opts.auto }));
      fx.flush();
      return res;
    } catch (e) {
      if (notifiedStatus) acceptFailedLocally(getPlatformOrder(db, row.id), e);
      throw e;
    }
  }, { auto: opts.auto });
}

/** Platformun tutarları kendi içinde tutarlı mı: kuruş tam sayı, kalemler toplamı, indirimler ve müşterinin ödediği */
function amountsConsistent(p: PlatformOrderPayload): boolean {
  const kurus = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!p.lines.length || !p.lines.every((l) => kurus(l.unitPrice) && Number.isSafeInteger(l.qty) && l.qty >= 1)) return false;
  if (![p.subtotal, p.restaurantDiscount, p.platformDiscount, p.customerTotal].every(kurus) || p.customerTotal <= 0) return false;
  if (p.lines.reduce((a, l) => a + l.unitPrice * l.qty, 0) !== p.subtotal) return false;
  return p.restaurantDiscount + p.platformDiscount + p.customerTotal === p.subtotal;
}

/**
 * Otomatik kabulün koşulları (docs/PAKET-PLATFORMLARI.md "Otomatik kabul"): biri tutmazsa nedeni, hepsi tutarsa null.
 * Ayarın açık olduğu, kabul eden kişi (`autoAcceptor`), porsiyon ve adisyonun tutarı ayrıca denetlenir. Kasada karar
 * denenmiş kayıt (kabul, ret, platform iptali; başarılı ya da başarısız) hiçbir zaman otomatik kabul edilmez: kayıtta
 * otomatik kabulün kendi notundan başka bir not (ör. "ret bildirilemedi") ya da süreçte kişinin kararı
 * (`manualDecision`) bunu söyler.
 */
export function autoAcceptBlocker(row: PlatformRow, now = Date.now()): string | null {
  const p = row.payload;
  const s = platformSettings()[row.platform];
  if (p.test) return 'platformun test siparişi';
  // Canlı'da yalnız gerçek sipariş ve kasa canlıdayken: kurulum modu da yazarkasanın eğitim simülatörü de olmaz (o
  // günün satışı eğitim günüdür, `trainingMode`). Deneme'de (yalnız kurulum modunda) yalnız deneme siparişi
  if (s.mode === 'canli') {
    if (p.simulated) return 'deneme siparişi';
    if (trainingMode()) return 'kasa kurulum ya da eğitim modunda';
  } else if (s.mode === 'deneme') {
    if (!p.simulated || !getSettings().demoMode) return 'platform Deneme modunda';
  } else return 'platform kapalı';
  if (p.preAccepted) return 'platformun tabletinde kabul edilmiş';
  if (row.notifiedStatus != null) return 'platformda zaten kabul edilmiş';
  if (manualDecision.has(row.id) || (row.lastError && !row.lastError.startsWith(AUTO_SKIP_PREFIX))) return 'kasada karar denendi';
  if (p.scheduledFor != null || p.scheduledUnknown) return 'ileri tarihli sipariş';
  // Bağlantı kopukken birikmiş sipariş (Trendyol Go'da kabul süresi kasaya geliş anından sayılır): taze süre almasın
  const placed = p.scheduledFor ?? p.placedAt;
  if (now - placed > AUTO_ACCEPT_MAX_AGE_MS) return `sipariş eski (${fmtTime(placed)})`;
  if (row.expiresAt != null && row.expiresAt - now < AUTO_ACCEPT_MIN_LEFT_MS) return 'kabul süresi dolmak üzere';
  try {
    requireCurrentDay(db);
  } catch (e) {
    return e instanceof HttpError && e.code === 'stale_day' ? 'önceki günün gün sonu alınmadı' : 'gün açık değil';
  }
  if (!p.platformCollects) return 'ödeme kasada alınacak';
  // Bağdaştırıcının metni neyin doğrulanacağını söyler (tutar farkı, belirsiz ödeme türü)
  if (p.amountReview) return p.amountReview.trim() || 'tutar ya da ödeme platformdan doğrulanmalı';
  if (!amountsConsistent(p)) return 'platformun tutarları birbirini tutmuyor';
  if (p.customerTotal > s.autoAcceptMaxKurus) return `tutar ${tl(s.autoAcceptMaxKurus)} sınırının üstünde`;
  const { unmatched, soldOut } = lineIssues(db, p);
  if (unmatched.length) return `eşleşmeyen kalem (${unmatched.join(', ')})`;
  if (soldOut.length) return `tükenmiş kalem (${soldOut.join(', ')})`;
  const soldOptions = soldOutOptionsOf(db, p);
  if (soldOptions.length) return `seçeneği tükenmiş ürün (${soldOptions.join('; ')})`;
  return null;
}

/** Kabul eden kişinin uyarısı süreç başına bir kez (platform:kişi); sonraki siparişlerde bilgi */
const warnedAcceptor = new Set<string>();

/**
 * Otomatik kabul edilmedi: kayıt elle kabul bekler. Neden şeritte görünür (kayıtta başka bir not, ör. platformun hatası,
 * varsa o ezilmez) ve denetim kaydına bir kez düşer
 */
function autoSkipped(row: PlatformRow, reason: string, severity: 'info' | 'uyari' = 'info') {
  patchRow(
    row.id,
    { lastError: row.lastError ?? `${AUTO_SKIP_PREFIX}: ${reason}` },
    { action: 'platform.auto_skip', severity, amount: row.payload.customerTotal, message: `${PLATFORM_LABEL[row.platform]} ${row.payload.code}: otomatik kabul edilmedi (${reason}); elle kabul bekliyor` },
  );
}

export type AutoAcceptResult = 'off' | 'accepted' | 'skipped' | 'busy' | 'failed' | 'not_pending';

/**
 * Otomatik kabul (ayar açıksa; docs/PAKET-PLATFORMLARI.md "Otomatik kabul"): koşulları tutan sipariş ayarda seçilen
 * kişi adına, kasadaki Kabul'ün yoluyla (`acceptFlow`) kabul edilir. Tutmayan elle kabul bekler. Platform kabulü
 * reddederse kayıt bekler; platform kabul edip adisyon açılamazsa `acceptFailedLocally` (alarm). Yoklama yeni kaydı
 * bir kez verir. Karar o an kasada veriliyorsa (`busy`: kasadaki kabul ya da ret platform çağrısını bekliyor) kayıt
 * elle kalır, yeniden denenmez: ret platforma gidemese de kişinin reddettiği sipariş kabul edilmez. Kilit ve durum
 * denetimi aynı siparişin iki kez kabul edilmesini önler: kabul edilmiş kayıtta `not_pending` döner, platforma gidilmez.
 */
export async function autoAccept(id: string): Promise<AutoAcceptResult> {
  const row = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
  if (!row || row.status !== 'bekliyor') return 'not_pending';
  const s = platformSettings()[row.platform];
  if (!s.autoAccept || s.mode === 'kapali') return 'off';
  const who = autoAcceptor(db, s.autoAcceptUserId);
  if (typeof who === 'string') {
    const key = `${row.platform}:${s.autoAcceptUserId ?? ''}`;
    autoSkipped(row, who, warnedAcceptor.has(key) ? 'info' : 'uyari');
    warnedAcceptor.add(key);
    return 'skipped';
  }
  try {
    await acceptFlow(who, id, s.prepMinutes, { auto: true });
    return 'accepted';
  } catch (e) {
    // Platform siparişi zaten kabul edilmiş buldu: kayıt işaretlendi (platform.accepted_elsewhere), elle kalır
    if (e instanceof AcceptedElsewhere) return 'skipped';
    if (e instanceof HttpError && e.code === 'busy') {
      // Kilit yalnız kasadaki kararda tutulur (otomatik kabul kaydı bir kez dener): karar kişinindir, kayıt elle kalır
      const fresh = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
      if (fresh?.status === 'bekliyor') autoSkipped(fresh, 'kasada karar veriliyor');
      return 'busy';
    }
    const after = db.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
    if (!after || after.status !== 'bekliyor') return 'not_pending';
    // Platform kabul etti, adisyon açılamadı: acceptFailedLocally alarmı düştü, Kabul yalnız adisyonu açar
    if (after.notifiedStatus === 'picked' && row.notifiedStatus == null) return 'failed';
    const code = e instanceof HttpError ? e.code : null;
    if (e instanceof AutoSkip) autoSkipped(after, e.message);
    // Platform kabulü almadı (hata kayıtta): elle kabul edilmeli, süre işliyor
    else if (code === 'platform_unreachable' || code === 'platform_off') autoSkipped(after, 'platform kabulü almadı', 'uyari');
    else if (code === 'expired') autoSkipped(after, 'kabul süresi doldu');
    // Prova düştü (tükendi, porsiyon yetmiyor): platforma gidilmedi
    else autoSkipped(after, `adisyon açılamıyor: ${message(e)}`);
    return 'skipped';
  }
}

/** Yoklamanın yeni kayıtları otomatik kabule (ayar açıksa); her kayıt bir kez */
async function autoAcceptNew(platform: PlatformId, created: string[]) {
  for (const id of created) {
    await autoAccept(id).catch((e) => console.warn(`[platform] ${PLATFORM_LABEL[platform]} otomatik kabul`, message(e)));
  }
}

/** Retten önce platforma (`unsupplied`); reddederse 502, yerelde reddedilmez */
export async function announceReject(row: PlatformRow, reason: string): Promise<string | null> {
  // Platformun tabletinde zaten kabul edilmiş sipariş kasadan reddedilmez
  if (row.payload.preAccepted) throw new HttpError(409, `${PLATFORM_LABEL[row.platform]} siparişi platformun tabletinde kabul edildi: ret ve iptal oradan yapılır`, 'pre_accepted');
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

/**
 * Adisyonun teslim aşamasından platforma yazılması gereken son adım. Platform kuryesinde teslimi platform yazar;
 * kuryeye verilişi de (`handover`: Getir) ancak bağdaştırıcı isterse
 */
export function desiredStep(deliveryStatus: string | null, courier: PlatformOrderPayload['courier'], handover = false): PlatformNotify | null {
  if (!deliveryStatus || deliveryStatus === 'hazirlaniyor') return null;
  if (deliveryStatus === 'hazir') return 'hazir';
  if (courier === 'platform') return handover ? 'yolda' : 'hazir';
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
      if (await announceLocalCancel(a, row, o.cancelReason, now)) sent++;
      else failed++;
      continue;
    }
    // Platform bu siparişin bir aşamasını kalıcı olarak reddetti: aşama bildirimi durur (iptal dalları sürer)
    if (row.notifyParkedAt != null) continue;
    const want = desiredStep(o.deliveryStatus, row.payload.courier, !!a.handover);
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
      // Platform "henüz erken" dedi (aşamalar arasında bekleme ister): hata değil, sonraki turda sürer; gidenler yazıldı
      if (e instanceof PlatformHttpError && e.status === 425) continue;
      failed++;
      const permanent = permanentOf(e);
      const why = `${a.label}: "${STEP_LABEL[step]}" bildirilemedi (${message(e)})`;
      const ref = `${row.payload.code}, ${tl(row.payload.customerTotal)}`;
      const key = `notify:${row.id}`;
      const overdue = permanent ? null : transientOverdue(key, 'notify', now);
      if (permanent) transientSince.delete(key);
      patchRow(
        row.id,
        { notifiedStatus: current, lastError: why, notifyParkedAt: permanent ? Date.now() : null },
        permanent
          ? { action: 'platform.notify_rejected', severity: 'alarm', orderId: row.orderId, message: `${why}; platform kabul etmedi, yeniden denenmeyecek: aşamayı platform uygulamasından işaretleyin (${ref})` }
          : overdue != null
            ? { action: 'platform.notify_failed', severity: 'alarm', orderId: row.orderId, message: `${why}; ${overdue} dakikadır gitmiyor, yeniden denenmeye devam ediliyor: aşamayı platform uygulamasından da işaretleyin (${ref})` }
            : !row.lastError
              ? { action: 'platform.notify_failed', severity: 'uyari', orderId: row.orderId, message: `${why}; yeniden denenecek (${ref})` }
              : undefined,
      );
      continue;
    }
    transientSince.delete(`notify:${row.id}`);
  }
  return { sent, failed };
}

/**
 * Kabul edilmiş sipariş kasada iptal edildi: platforma "tedarik edilemedi" gider ve kayıt kapanır. Platform kalıcı
 * olarak reddederse (ör. kurye yolda) kayıt yine kapanır, hata kayıtta kalır ve patrona alarm: sipariş platform
 * uygulamasından iptal edilir. Geçici hata sonraki turda yeniden denenir.
 */
async function announceLocalCancel(a: PlatformAdapter, row: PlatformRow, cancelReason: string | null, now = Date.now()): Promise<boolean> {
  const reason = cancelReason?.trim() || 'Diğer';
  const ref = `${row.payload.code}, ${tl(row.payload.customerTotal)}`;
  const key = `cancel:${row.id}`;
  try {
    await a.reject(row.payload, reason, { afterAccept: true });
  } catch (e) {
    const permanent = permanentOf(e);
    const why = `${a.label}: kasada iptal edilen sipariş platforma bildirilemedi (${message(e)})`;
    // Geçici hata sürerse (platformda sipariş sürüyor, kasa iptal saydı) bir kez alarm; yeniden deneme sürer
    const overdue = permanent ? null : transientOverdue(key, 'cancel', now);
    if (permanent) transientSince.delete(key);
    patchRow(
      row.id,
      permanent ? { status: 'iptal', decidedAt: Date.now(), lastError: why, reason: `Kasada iptal edildi: ${reason}; platforma bildirilemedi` } : { lastError: why },
      permanent
        ? { action: 'platform.cancel_unsynced', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}: siparişi platform uygulamasından iptal edin (${ref})` }
        : overdue != null
          ? { action: 'platform.cancel_unsynced', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}; ${overdue} dakikadır gitmiyor, platformda sipariş sürüyor: siparişi platform uygulamasından da iptal edin, yeniden denenmeye devam ediliyor (${ref})` }
          : !row.lastError
            ? { action: 'platform.cancel_unsynced', severity: 'uyari', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}; yeniden denenecek (${ref})` }
            : undefined,
    );
    return false;
  }
  transientSince.delete(key);
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

/**
 * Platformun iptal ettiği paketler: bekleyen kayıt kapanır, kabul edilmiş adisyon iptal olur (platform ödemesi geri).
 * `deferred`: kararı o an süren, sonraki yoklamaya kalan iptaller (gelen kutusunda kalmalı)
 */
function applyCancellations(platform: PlatformId, externalIds: string[], deferred: Set<string>) {
  if (!externalIds.length) return 0;
  const rows = db
    .select()
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, platform), inArray(schema.platformOrders.externalId, externalIds), inArray(schema.platformOrders.status, ['bekliyor', 'kabul'])))
    .all();
  let n = 0;
  for (const row of rows) {
    if (row.payload.simulated) continue;
    // Kabul ya da ret o an sürüyor: sonraki yoklama (aynı pencere ya da gelen kutusu) yeniden getirir
    if (deciding.has(row.id)) {
      deferred.add(row.externalId);
      continue;
    }
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

/**
 * Platformun panelinden (kasanın dışında) kabul edilmiş siparişler: kasada onay bekleyen ya da süresi dolmuş kayıt
 * "platformda kabul edildi" olur (süre işlemez, Kabul yalnız adisyonu açar, platforma ikinci kez gitmez); patrona bir
 * kez alarm. Tabletten kabul edilmiş gelen (preAccepted) ve kararı süren kayda dokunulmaz
 */
function applyConfirmed(platform: PlatformId, externalIds: string[] | undefined) {
  if (!externalIds?.length) return;
  const rows = db
    .select()
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, platform), inArray(schema.platformOrders.externalId, externalIds), inArray(schema.platformOrders.status, ['bekliyor', 'suresi_doldu']), isNull(schema.platformOrders.notifiedStatus)))
    .all();
  for (const row of rows) {
    if (row.payload.simulated || row.payload.preAccepted || deciding.has(row.id)) continue;
    markAcceptedElsewhere(row);
  }
}

/**
 * Sipariş kasanın dışında (platformun panelinden, IVR'dan) kabul edilmiş: kayıt onay bekler ama platforma ikinci kez
 * gidilmez (`notifiedStatus` picked; süre işlemez), Kabul yalnız adisyonu açar; patrona alarm
 */
function markAcceptedElsewhere(row: PlatformRow) {
  patchRow(
    row.id,
    { status: 'bekliyor', decidedAt: null, notifiedStatus: 'picked', lastError: 'Platformun panelinden kabul edildi: Kabul yalnız adisyonu açar' },
    { action: 'platform.accepted_elsewhere', severity: 'alarm', amount: row.payload.customerTotal, message: `${PLATFORM_LABEL[row.platform]} ${row.payload.code}: sipariş platformun panelinden kabul edildi ama kasada adisyonu yok; Kabul ile adisyonu açın (${tl(row.payload.customerTotal)})` },
  );
}

/**
 * Kasada kabul edilmiş ama platformun yeniden onay beklediği siparişler (Getir: ileri tarihli sipariş etkinleşince):
 * onay bağdaştırıcıdan gider; gidemezse patrona bir kez alarm, sonraki yoklamada (platform hâlâ bekliyorsa) yeniden.
 * Platformda onaylı ve kasada süren sipariş de sayılır: kasada kabul edilmiş, ya da onay bekleyen ama platformda
 * kabul edilmiş (platformun panelinden, tabletinden; `notifiedStatus` picked ya da `preAccepted`). Adisyonu kasada
 * iptal edilmiş sipariş yeniden onaylanmaz (iptali platforma ayrıca gider). Platform "zaten onaylı" derse denetim
 * kaydı yazılmaz (onay önceden gitmişti)
 */
async function applyReconfirm(a: PlatformAdapter, platform: PlatformId, externalIds: string[] | undefined) {
  if (!a.reconfirm || !externalIds?.length) return;
  const rows = db
    .select()
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, platform), inArray(schema.platformOrders.externalId, externalIds), inArray(schema.platformOrders.status, ['kabul', 'bekliyor'])))
    .all()
    .filter((r) => r.status === 'kabul' || r.notifiedStatus === 'picked' || !!r.payload.preAccepted);
  const prefix = `${a.label}: yeniden onay gönderilemedi`;
  for (const row of rows) {
    if (row.payload.simulated || deciding.has(row.id)) continue;
    if (row.orderId) {
      const o = db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
      if (o?.status === 'iptal') continue;
    }
    const ref = `${row.payload.code}, ${tl(row.payload.customerTotal)}`;
    let result: void | 'already';
    try {
      result = await a.reconfirm(row.payload);
    } catch (e) {
      const why = `${prefix} (${message(e)})`;
      patchRow(
        row.id,
        { lastError: why },
        row.lastError?.startsWith(prefix) ? undefined : { action: 'platform.reconfirm_failed', severity: 'alarm', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why}: platform siparişi yeniden onay bekliyor, platform uygulamasından onaylayın (${ref})` },
      );
      continue;
    }
    if (result === 'already') {
      if (row.lastError?.startsWith(prefix)) patchRow(row.id, { lastError: null });
      continue;
    }
    // Yalnız kendi hatası temizlenir ("platformun panelinden kabul edildi" gibi ipuçları kalır)
    patchRow(row.id, { lastError: row.lastError?.startsWith(prefix) ? null : row.lastError }, { action: 'platform.reconfirm', severity: 'uyari', orderId: row.orderId, message: `${a.label} siparişi platformda yeniden onay bekliyordu (ileri tarihli sipariş etkinleşti); onay gönderildi (${ref})` });
  }
}

/**
 * Onay bekleyen kaydın saati sonradan geldi (Getir: ilk gelişte ileri tarihli siparişin saati okunamadı, yedek liste ya
 * da sonraki tur getirdi): yalnız saat ve not tamamlanır (aynı kaynaktan gelen not; tabletten kabul edilmişin süresi
 * teslim saatinden işler). Başka alana dokunulmaz
 */
function completeSchedule(t: Tx, fx: Effects, row: PlatformRow, payload: PlatformOrderPayload) {
  if (row.status !== 'bekliyor' || row.payload.scheduledFor != null || payload.scheduledFor == null) return;
  if (!!row.payload.preAccepted !== !!payload.preAccepted) return;
  const next: PlatformOrderPayload = { ...row.payload, scheduledFor: payload.scheduledFor, note: payload.note };
  t.update(schema.platformOrders)
    .set({ payload: next, ...(row.payload.preAccepted ? { expiresAt: payload.scheduledFor + PRE_ACCEPTED_TTL_MS } : {}) })
    .where(eq(schema.platformOrders.id, row.id))
    .run();
  fx.emit({ topic: 'delivery', kind: 'platform.sync' });
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
  // Gelen kutusunda kalacaklar: kayda alınmayan (Kapalı), kaydı düşen (sonraki çekimde yeniden denenir), iptali ertelenen.
  // Kapalı'da bozuk kayıt da kalır: Canlı'ya dönünce bildirilir (alarmsız silinmesin)
  const keep = new Set<string>(intake ? [] : (res.invalid ?? []).map((i) => i.externalId));
  // Kapalı'da yalnız kasada kaydı olmayan sipariş kalır: kaydı olan (platformda yaşayan, ör. etkinleşen ileri tarihli
  // siparişin yeniden itmesi) tekilleşir ve silinir, gelen kutusunda her turda yeniden işlenmez
  const known = intake || !res.orders.length
    ? new Set<string>()
    : new Set(
        db
          .select({ externalId: schema.platformOrders.externalId })
          .from(schema.platformOrders)
          .where(and(eq(schema.platformOrders.platform, platform), inArray(schema.platformOrders.externalId, res.orders.map((o) => o.externalId))))
          .all()
          .map((r) => r.externalId),
      );
  let created = 0;
  const fresh: string[] = [];
  for (const payload of res.orders) {
    if (!intake) {
      if (!known.has(payload.externalId)) keep.add(payload.externalId);
      continue;
    }
    const fx = new Effects();
    try {
      const r = tx((t) => {
        const out = ingestPlatformOrder(t, fx, payload, now);
        if (!out.created) completeSchedule(t, fx, out.row, payload);
        return out;
      });
      fx.flush();
      if (r.created) {
        created++;
        fresh.push(r.row.id);
      }
    } catch (e) {
      keep.add(payload.externalId);
      bad.push({ externalId: payload.externalId, error: message(e) });
    }
  }
  reportInvalid(platform, bad);
  applyConfirmed(platform, res.confirmed);
  const n = applyCancellations(platform, res.cancelled, keep);
  await applyReconfirm(a, platform, res.reconfirm);
  // Yerelde işlendi: aktarıcıdaki kayıtlar artık silinebilir (silinemezse yeniden gelir, tekilleştirilir)
  await res.commit?.(keep).catch((e) => console.warn(`[platform] ${a.label} gelen kutusu temizlenemedi`, message(e)));
  // Yeni siparişler kasaya alınamıyor (Getir: giriş yok): ilk turda uyarı, sürerse 15 turda bir (≈5 dk) alarm. Bekleme
  // uygulanmaz (düzelince hemen görülsün); iptaller yukarıda işlendi
  const blockedRounds = res.blocked && intake ? (state.blockedRounds ?? 0) + 1 : 0;
  if (blockedRounds === 1 || (blockedRounds > 0 && blockedRounds % 15 === 0)) {
    const fx = new Effects();
    fx.audit(db, { action: 'platform.poll_failed', severity: blockedRounds >= 15 ? 'alarm' : 'uyari', message: `${a.label}: ${res.blocked} (${blockedRounds}. tur); yeni siparişler kasaya gelmiyor, platform uygulamasından kabul edin` });
    fx.flush();
  }
  // Yoklama başarılı; eksik yol varsa (aktarıcı düştü, yedek yol çalıştı) Yönetim'de görünür, bekleme uygulanmaz
  const notes = [res.blocked, res.warning].filter(Boolean).join('; ');
  writeState(platform, { lastPollAt: now, lastOkAt: now, lastError: notes ? `${a.label}: ${notes}` : null, failures: 0, blockedRounds });
  // Otomatik kabul en son: platformun bu turdaki iptali ve panelden kabulü kayda işlendi
  if (intake) await autoAcceptNew(platform, fresh);
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
