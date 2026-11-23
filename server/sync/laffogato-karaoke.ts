import { and, eq, inArray } from 'drizzle-orm';
import {
  type SiteKaraokeBooking,
  SITE_KARAOKE_PAYMENTS,
  SITE_KARAOKE_STATUSES,
  type SiteKaraokePayment,
  type SiteKaraokeStatus,
} from '@shared/karaoke';
import { karaokeAlertText } from '@shared/site-alerts';
import { businessDate, isCalendarDate } from '@shared/time';
import type { SiteKaraokeDTO } from '@shared/types';
import { db, schema } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { HttpError } from '../lib/http';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { requireSiteSigned, siteBranch, siteLinked, siteSigned } from './laffogato-link';

/**
 * Sitedeki karaoke rezervasyonları (laffogato `GET /api/panel/karaoke`, F1): oda sitede rezerveyken kasada boş
 * görünmesin, sitede ödenmiş saat kasada yeniden ücretlenmesin. Yalnız okunur; rezervasyonu site yazar, değiştirir,
 * iptal eder. Pencere kasanın iş günüdür (`from = to = iş günü`; rezervasyon gece yarısını aşmaz, sitenin LafPOS
 * anahtarı yalnız dünden yarına okur). docs/03-ENTEGRASYON.md §2.4
 *
 * Ne zaman çekilir (AGENTS.md kural 6: imzalı uca 5 dakikadan sık otomatik istek yok; bu okuma sitenin veritabanına
 * gider):
 * - sipariş sürüm sinyalinin (`/api/pos/orders/version`) `karaoke` değeri değişince ya da iş günü dönünce, gün
 *   açıkken, en sık 5 dakikada bir (`siteKaraokeTick`);
 * - oda kutusu açılınca, yalnız liste bayatsa (`refreshSiteKaraoke`), ve elle "Yenile" ile (en sık 30 sn'de bir).
 * Site bağlantısı (`LAFFOGATO_URL` + anahtar) ya da planda oda türünde masa yoksa hiç istek gitmez.
 */

const STATE_KEY = 'laffogato.karaoke';
/** Otomatik çekimler arası en az süre (kural 6) */
export const KARAOKE_AUTO_MIN_MS = 5 * 60_000;
/** Elle ya da oda kutusundan çekimler arası en az süre */
const KARAOKE_MANUAL_MIN_MS = 30_000;
/** Site LafPOS'a karaokeyi açmamışsa (401, 403, 503 not_configured) otomatik yeniden deneme bu kadar sonra */
const CLOSED_BACKOFF_MS = 30 * 60_000;
/** Sürüm sinyali bu süreden yeniyse "canlı" sayılır: oda kutusu yalnız işaret değişince çeker */
const MARKER_FRESH_MS = 2 * 60_000;
const FIRST_NAME_MAX = 40;
const NOTE_MAX = 300;

interface KaraokeState {
  /** Listenin iş günü (pencere) */
  date: string | null;
  pulledAt: number | null;
  /** Listenin ait olduğu sürüm işareti (sinyal yoksa null) */
  marker: string | null;
  complete: boolean;
  bookings: SiteKaraokeBooking[];
  lastError: string | null;
  lastErrorAt: number | null;
  /** Son başarısız çekimin HTTP durumu (ağ hatasında null) */
  lastStatus: number | null;
  /** Son ret, sitenin karaokeyi LafPOS'a açmadığı anlamında (401, 403, 503 `not_configured`) */
  closed: boolean;
}

const EMPTY: KaraokeState = { date: null, pulledAt: null, marker: null, complete: true, bookings: [], lastError: null, lastErrorAt: null, lastStatus: null, closed: false };

const readState = (): KaraokeState => ({ ...EMPTY, ...(getSyncState<Partial<KaraokeState>>(STATE_KEY) ?? {}) });

/** Planda kullanılan, oda türünde (saatlik) masa var mı: yoksa sitenin karaokesi kasayı ilgilendirmez */
function hasRoomTable(): boolean {
  return !!db
    .select({ id: schema.tables.id })
    .from(schema.tables)
    .where(and(eq(schema.tables.kind, 'oda'), eq(schema.tables.active, true)))
    .get();
}

/** Karaoke okuması açık mı: site bağlantısı ve anahtar `.env`'de, planda oda var */
export const siteKaraokeOn = () => siteSigned() && hasRoomTable();

// ─── Yanıtın okunması ───────────────────────────────────────────────────────

const clip = (s: string, max: number) => {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
};

/** Saat dilimi İstanbul, sabit UTC+3 (sitenin `karaokeStartInstant` kuralı) */
const startInstant = (date: string, hour: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 3)).toISOString();
};

/**
 * Sitenin bir satırı; okunamayan satır `null` (bir bozuk satır listeyi düşürmez). Bilinmeyen durum güvenli tarafa
 * okunur, sitenin kendi kuralıyla: bilinmeyen `status` `requested` (oda tutulu), bilinmeyen `paymentStatus` `none`.
 */
export function toSiteBooking(raw: unknown): SiteKaraokeBooking | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const date = typeof r.date === 'string' ? r.date : '';
  const startHour = Number(r.startHour);
  const hours = Number(r.hours);
  if (!id || id.length > 64 || !isCalendarDate(date) || !Number.isInteger(startHour) || startHour < 0 || startHour > 23) return null;
  if (!Number.isInteger(hours) || hours < 1 || startHour + hours > 24) return null;
  const startsAt = startInstant(date, startHour);
  const endsAt = new Date(Date.parse(startsAt) + hours * 3600_000).toISOString();
  const guests = Number(r.guests);
  const totalMinor = Number(r.totalMinor);
  return {
    id,
    date,
    startHour,
    hours,
    startsAt,
    endsAt,
    guests: Number.isInteger(guests) && guests > 0 ? guests : 0,
    status: (SITE_KARAOKE_STATUSES as readonly string[]).includes(r.status as string) ? (r.status as SiteKaraokeStatus) : 'requested',
    paymentStatus: (SITE_KARAOKE_PAYMENTS as readonly string[]).includes(r.paymentStatus as string) ? (r.paymentStatus as SiteKaraokePayment) : 'none',
    firstName: clip(typeof r.firstName === 'string' ? r.firstName.trim() : '', FIRST_NAME_MAX),
    note: clip(typeof r.note === 'string' ? r.note.trim() : '', NOTE_MAX),
    totalMinor: Number.isInteger(totalMinor) && totalMinor >= 0 ? totalMinor : 0,
    channel: r.channel === 'web' || r.channel === 'app' ? r.channel : '',
  };
}

/** `reservations` dizisi olmayan 200 (bakım sayfası, ağ geçidi) başarısız çekimdir: eldeki liste silinmez */
export function parseKaraokeBody(json: unknown, day: string): { bookings: SiteKaraokeBooking[]; complete: boolean } {
  const body = json as { reservations?: unknown; complete?: unknown } | null;
  if (!body || !Array.isArray(body.reservations)) throw new HttpError(502, 'Site karaoke listesi beklenen biçimde gelmedi', 'site_karaoke');
  const rows = body.reservations.map(toSiteBooking);
  const bookings = rows.filter((b): b is SiteKaraokeBooking => b !== null && b.date === day).sort((a, b) => a.startHour - b.startHour || (a.id < b.id ? -1 : 1));
  return { bookings, complete: body.complete !== false && rows.every((b) => b !== null) };
}

const errorCode = (json: unknown) => (json as { error?: unknown } | null)?.error;

/** Site karaokeyi LafPOS'a açmamış: anahtar ya da sürüm meselesi, kısa aralıkla yeniden denemenin anlamı yok */
const closedAnswer = (status: number, json: unknown) => status === 401 || status === 403 || (status === 503 && errorCode(json) === 'not_configured');

export function failureMessage(status: number, json: unknown): string {
  const code = errorCode(json);
  if (status === 401) return "Site karaoke okumasını kabul etmedi (HTTP 401): site LafPOS'a karaokeyi açmamış, anahtar farklı ya da kasa saati 5 dakikadan fazla kaymış";
  // Şube reddi: sitenin LAFPOS_BRANCHES'ında bu kasanın şubesi yok (gün ya da saat meselesi değil)
  if (status === 403 && (json as { field?: unknown } | null)?.field === 'branch') return `Site karaokeyi bu kasanın şubesine (${siteBranch()}) açmadı (HTTP 403): sitedeki LAFPOS_BRANCHES ile Yönetim › Ayarlar ve yedek › Şube kimliği aynı olmalı`;
  if (status === 403) return 'Site bu günü LafPOS\'a açmadı (HTTP 403): kasa bilgisayarının tarihi ya da saati yanlış olabilir';
  if (status === 503 && code === 'not_configured') return "Sitede LafPOS anahtarı tanımlı değil (HTTP 503)";
  if (status === 503) return 'Site rezervasyonları şu an okuyamıyor (HTTP 503)';
  return `Site karaoke rezervasyonları alınamadı (HTTP ${status})`;
}

// ─── Uyarılar ───────────────────────────────────────────────────────────────

export interface KaraokeChange {
  kind: 'new' | 'cancelled' | 'moved';
  id: string;
  /** "Karaoke 20:00 · 2 sa · 4 kişi"; taşınanda önceki saat ya da "başka güne" parantez içinde. Ad ve not yok */
  message: string;
}

/** Bir çekimde en çok bu kadar uyarı (toplu düzeltmede ekranlar ses yağmuruna dönmesin); liste yine tam yenilenir */
const KARAOKE_ALERTS_MAX = 6;

/**
 * Aynı iş gününün iki listesi arasındaki, cihazlarda sesli uyarı çalan farklar (§2.5): yeni (iptal olmayan) rezervasyon,
 * iptal edilen, saati ya da süresi değişen. İki liste de eksiksizse (`complete`) bugünün listesinden düşen iptal olmayan
 * rezervasyon da "taşındı" sayılır (panel başka güne taşıdı). Ödeme durumu, kişi sayısı ya da not değişikliği çalmaz.
 */
export function karaokeChanges(prev: readonly SiteKaraokeBooking[], next: readonly SiteKaraokeBooking[], bothComplete: boolean): KaraokeChange[] {
  const before = new Map(prev.map((b) => [b.id, b]));
  const out: KaraokeChange[] = [];
  for (const b of next) {
    const p = before.get(b.id);
    const text = karaokeAlertText(b);
    if (b.status === 'cancelled') {
      if (p && p.status !== 'cancelled') out.push({ kind: 'cancelled', id: b.id, message: text });
      continue;
    }
    // Hiç görülmemiş ya da iptalden geri dönen rezervasyon: oda yeniden tutuldu
    if (!p || p.status === 'cancelled') out.push({ kind: 'new', id: b.id, message: text });
    else if (p.startHour !== b.startHour || p.hours !== b.hours) out.push({ kind: 'moved', id: b.id, message: `${text} (önce ${String(p.startHour).padStart(2, '0')}:00 · ${p.hours} sa)` });
  }
  if (bothComplete) {
    const now = new Set(next.map((b) => b.id));
    for (const p of prev) if (!now.has(p.id) && p.status !== 'cancelled') out.push({ kind: 'moved', id: p.id, message: `${karaokeAlertText(p)} (başka güne)` });
  }
  return out.slice(0, KARAOKE_ALERTS_MAX);
}

// ─── Çekim ──────────────────────────────────────────────────────────────────

let seenMarker: string | null = null;
let seenAt = 0;
let lastAuto = 0;
let lastManual = 0;
let retryAt = 0;
let inflight: Promise<SiteKaraokeDTO> | null = null;

/** Testler için: zamanlayıcının belleğini sıfırlar */
export function resetKaraokeTimer() {
  seenMarker = null;
  seenAt = 0;
  lastAuto = 0;
  lastManual = 0;
  retryAt = 0;
  inflight = null;
}

/**
 * Bir çekim. Başarılıysa liste (yalnız iş gününün rezervasyonları) ve çekimin başladığı andaki sürüm işareti yazılır;
 * değiştiyse ekranlara olay gider. Başarısızsa eldeki liste kalır, hata kaydedilir ve atılır.
 */
function pullOnce(now: number): Promise<SiteKaraokeDTO> {
  if (inflight) return inflight;
  inflight = (async () => {
    const day = businessDate(now);
    const marker = seenMarker;
    const url = new URL(`${env.laffogatoUrl}/api/panel/karaoke`);
    url.searchParams.set('from', day);
    url.searchParams.set('to', day);
    // Oda Tuzla'nın: başka şube adına site boş liste verir (§2.3 "Şube")
    url.searchParams.set('branch', siteBranch());
    const before = readState();
    const fail = (status: number | null, message: string, closed = false): never => {
      setSyncState(STATE_KEY, { ...before, lastError: message, lastErrorAt: Date.now(), lastStatus: status, closed } satisfies KaraokeState);
      if (closed) retryAt = now + CLOSED_BACKOFF_MS;
      throw new HttpError(502, message, 'site_karaoke');
    };
    let res: { status: number; json: unknown };
    try {
      res = await signedFetch(env.laffogatoPanelSecret, 'GET', url);
    } catch (e) {
      return fail(null, `Siteye ulaşılamadı: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status !== 200) return fail(res.status, failureMessage(res.status, res.json), closedAnswer(res.status, res.json));
    let parsed: { bookings: SiteKaraokeBooking[]; complete: boolean };
    try {
      parsed = parseKaraokeBody(res.json, day);
    } catch (e) {
      return fail(200, e instanceof Error ? e.message : String(e));
    }
    retryAt = 0;
    const changed = before.date !== day || JSON.stringify(before.bookings) !== JSON.stringify(parsed.bookings);
    // Günün ilk listesi kıyaslanmaz: gün açılınca sabahtan beri alınan her rezervasyon "yeni" diye çalmasın
    const firstOfDay = before.date !== day || before.pulledAt == null;
    const alerts = changed && !firstOfDay ? karaokeChanges(before.bookings, parsed.bookings, before.complete && parsed.complete) : [];
    setSyncState(STATE_KEY, { date: day, pulledAt: Date.now(), marker, complete: parsed.complete, bookings: parsed.bookings, lastError: null, lastErrorAt: null, lastStatus: null, closed: false } satisfies KaraokeState);
    if (changed) {
      const fx = new Effects();
      fx.emit({ topic: 'reservations', kind: 'site.karaoke' });
      for (const a of alerts) fx.emit({ topic: 'reservations', kind: `site.karaoke.${a.kind}`, message: a.message });
      fx.flush();
    }
    return siteKaraokeView(now);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Liste bu iş gününün değil ya da bildiğimiz sürüm işareti listeninkinden farklı */
function behind(s: KaraokeState, now: number): boolean {
  if (s.date !== businessDate(now) || s.pulledAt == null) return true;
  return seenMarker !== null && seenMarker !== s.marker;
}

/**
 * Sürüm sinyalinden sonra (20 sn'de bir, `onlineOrdersTick`) çağrılır; asla atmaz. `marker` sitenin `karaoke`
 * işaretidir (F1 öncesi sitede yok). Gün açıkken liste geride kalmışsa çeker, en sık 5 dakikada bir. Gece (açık gün
 * yokken) çekmez: pencere iş günüdür, gün açılınca ilk turda çeker.
 */
export async function siteKaraokeTick(marker: unknown, now = Date.now()): Promise<void> {
  if (typeof marker === 'string' && marker) {
    seenMarker = marker;
    seenAt = now;
  }
  try {
    if (!siteKaraokeOn() || !getOpenDay(db)) return;
    if (!behind(readState(), now)) return;
    if (now - lastAuto < KARAOKE_AUTO_MIN_MS || now < retryAt) return;
    lastAuto = now;
    await pullOnce(now);
  } catch (e) {
    console.warn('[karaoke] site rezervasyonları alınamadı:', e instanceof Error ? e.message : e);
  }
}

/**
 * Oda kutusu ve "Sayacı başlat" açılınca (`force` yok): liste geride kaldıysa bir çekim; sürüm sinyali canlıysa yalnız
 * işaret değiştiyse, değilse liste 5 dakikadan eskiyse. Çekim başarısız olursa eldeki liste hatasıyla döner.
 * Elle "Yenile" (`force`): en sık 30 sn'de bir gerçek çekim, hata 502 olarak döner. Bağlantı yoksa 409.
 */
export async function refreshSiteKaraoke(opts: { force?: boolean } = {}, now = Date.now()): Promise<SiteKaraokeDTO> {
  requireSiteSigned();
  if (!hasRoomTable()) return siteKaraokeView(now);
  const s = readState();
  const markerLive = seenMarker !== null && now - seenAt < MARKER_FRESH_MS;
  const stale = s.date !== businessDate(now) || s.pulledAt == null || (markerLive ? seenMarker !== s.marker : now - s.pulledAt >= KARAOKE_AUTO_MIN_MS);
  if (now - lastManual < KARAOKE_MANUAL_MIN_MS) return siteKaraokeView(now);
  if (!opts.force && (!stale || now < retryAt)) return siteKaraokeView(now);
  lastManual = now;
  if (opts.force) return pullOnce(now);
  return pullOnce(now).catch(() => siteKaraokeView(now));
}

// ─── Okuma ──────────────────────────────────────────────────────────────────

/** Bu iş gününün listesi (bağlantı kapalıysa ya da liste başka güne aitse boş) */
export function siteBookingsToday(now = Date.now()): SiteKaraokeBooking[] {
  if (!siteSigned()) return [];
  const s = readState();
  return s.date === businessDate(now) ? s.bookings : [];
}

/**
 * Okunan son listedeki rezervasyon (gün bakılmaz: sayaç gece yarısını aşabilir). `gone`: liste rezervasyonun gününe ait
 * ve eksiksiz ama rezervasyon içinde yok; bağlanırken listedeydi, sonraki bir çekimde düştü (panel başka güne taşıdı)
 */
export function findSiteBooking(id: string, date: string): { booking: SiteKaraokeBooking | null; gone: boolean } {
  const s = readState();
  const booking = s.bookings.find((b) => b.id === id) ?? null;
  return { booking, gone: !booking && s.date === date && s.complete };
}

/** Oda kutusunun ve "Sayacı başlat"ın gördüğü: durum, iş gününün rezervasyonları ve hangisinin hangi adisyonda sayaçta olduğu */
export function siteKaraokeView(now = Date.now()): SiteKaraokeDTO {
  const day = businessDate(now);
  if (!siteSigned()) return { state: 'kapali', message: 'Site bağlantısı kurulmadı', date: day, pulledAt: null, complete: true, bookings: [] };
  const s = readState();
  const bookings = s.date === day ? s.bookings : [];
  const sessions = bookings.length
    ? db
        .select({ bookingId: schema.roomSessions.bookingId, endedAt: schema.roomSessions.endedAt, orderId: schema.roomSessions.orderId, no: schema.orders.no, tableName: schema.tables.name })
        .from(schema.roomSessions)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.roomSessions.orderId))
        .innerJoin(schema.tables, eq(schema.tables.id, schema.roomSessions.tableId))
        .where(inArray(schema.roomSessions.bookingId, bookings.map((b) => b.id)))
        .all()
    : [];
  const failedLast = s.lastErrorAt != null && s.lastErrorAt >= (s.pulledAt ?? 0);
  const state: SiteKaraokeDTO['state'] = failedLast && s.closed ? 'kapali' : failedLast ? 'hata' : s.pulledAt == null || s.date !== day ? 'bekliyor' : 'hazir';
  return {
    state,
    message: failedLast ? s.lastError : null,
    date: day,
    pulledAt: s.date === day ? s.pulledAt : null,
    complete: s.complete,
    bookings: bookings.map((b) => {
      const mine = sessions.filter((x) => x.bookingId === b.id);
      const active = mine.find((x) => x.endedAt == null);
      return { ...b, session: active ? { orderId: active.orderId, orderNo: active.no, tableName: active.tableName, active: true } : mine.length ? { orderId: mine[mine.length - 1].orderId, orderNo: mine[mine.length - 1].no, tableName: mine[mine.length - 1].tableName, active: false } : null };
    }),
  };
}

/** Yönetim › Entegrasyon kartı: açık mı, son çekim, rezervasyon sayısı, son hata (yeni bir çekim olduysa düşer) */
export function siteKaraokeStatus() {
  const s = readState();
  const failedLast = s.lastErrorAt != null && s.lastErrorAt >= (s.pulledAt ?? 0);
  return { on: siteKaraokeOn(), date: s.date, pulledAt: s.pulledAt, count: s.bookings.length, lastError: failedLast ? s.lastError : null, lastErrorAt: failedLast ? s.lastErrorAt : null, closed: failedLast && s.closed };
}

// ─── Saat ücreti kıyası (Yönetim › Masa planı) ─────────────────────────────

export interface SiteKaraokePrice {
  /** `LAFFOGATO_URL` var mı (yoksa istek gitmez) */
  linked: boolean;
  /** Sitenin karaoke saat ücreti (kuruş, KDV dahil); okunamadıysa null */
  hourlyMinor: number | null;
  error: string | null;
}

const PRICE_CACHE_MS = 60_000;
let priceCache: { at: number; value: SiteKaraokePrice } | null = null;

/** Testler için */
export function resetKaraokePriceCache() {
  priceCache = null;
}

/**
 * Sitenin karaoke saat ücreti, herkese açık `GET /api/mobile/v1/karaoke/availability`'den (`hourlyMinor`). Yalnız
 * Yönetim › Masa planı açılınca, ekran başına bir okuma (bir dakikalık önbellek); otomatik yoklama yok: uç sitenin
 * veritabanını okur. Kasa aşan süreyi kendi saat ücretiyle aldığı için iki fiyat farklıysa ekran uyarır.
 */
export async function siteKaraokePrice(now = Date.now()): Promise<SiteKaraokePrice> {
  if (!siteLinked()) return { linked: false, hourlyMinor: null, error: null };
  if (!hasRoomTable()) return { linked: true, hourlyMinor: null, error: null };
  if (priceCache && now - priceCache.at < PRICE_CACHE_MS) return priceCache.value;
  let value: SiteKaraokePrice;
  try {
    const res = await fetch(`${env.laffogatoUrl}/api/mobile/v1/karaoke/availability`, {
      headers: { accept: 'application/json', 'user-agent': 'LafPOS/0.1 (+kafe kasasi)' },
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as { hourlyMinor?: unknown } | null;
    const hourly = Number(json?.hourlyMinor);
    value = res.ok && Number.isInteger(hourly) && hourly > 0 ? { linked: true, hourlyMinor: hourly, error: null } : { linked: true, hourlyMinor: null, error: `Sitenin karaoke fiyatı okunamadı (HTTP ${res.status})` };
  } catch (e) {
    value = { linked: true, hourlyMinor: null, error: `Siteye ulaşılamadı: ${e instanceof Error ? e.message : String(e)}` };
  }
  priceCache = { at: now, value };
  return value;
}
