import { connect } from 'node:net';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { env } from '../env';
import { bus } from '../lib/events';
import { internetState, noteReachable, onInternetBack } from '../lib/internet';
import { cloudEnabled, cloudState, pushSnapshot } from './cloud';
import { flushOutbox } from './lafmaliyet';
import { siteSigned } from './laffogato-link';
import { onlineOrdersTick } from './laffogato-orders';
import { flushSiteOutbox } from './site-outbox';

/**
 * İnternet dönüşü (docs/05-KASA-BILGISAYARI.md "İnternet yokken"). İnternetsiz geçen sürede biriken iş kaybolmaz:
 * lafmaliyet gün sonu ve site Satışta yazımları giden kutusunda (`outbox`), Uzaktan özeti bir sonraki itmede, online
 * siparişler bir sonraki çekimde. Giden kutusu başarısız denemeden sonra artan beklemeyle (6 saate kadar) yeniden
 * dener; internet dönünce bu beklemeyi beklemeden bir kez gönderir:
 * - Dönüş, imzalı bir isteğin yanıt almasından ya da internet yokken dakikada bir yapılan TCP denemesinden anlaşılır
 *   (yalnız bağlantı kurulur, HTTP isteği gitmez: sitenin ve Vercel'in istek bütçesine girmez).
 * - Eşitleme en sık 5 dakikada bir (AGENTS.md kural 6: laffogato'nun imzalı uçlarına 5 dakikadan sık otomatik istek
 *   yok); online sipariş çekimi kendi bütçesiyle (sürüm sinyali, yeniden deneme beklemesi) çağrılır.
 * - Tam bir kez: kayıtlar giden kutusunun kendi sırasıyla gider (lafmaliyet ve site gönderimi aynı anda iki kez
 *   çalışmaz, gönderilen satır `sentAt` alır); kalıcı reddedilen kayıt (park) yeniden denenmez.
 * Durum alanı: "İnternet yok · N kayıt bekliyor", sonra "Bekleyenler gönderildi" (`internetStatus`).
 */
export const CATCH_UP_MIN_GAP_MS = 5 * 60_000;
/** İnternet yokken TCP denemesinin aralığı */
export const PROBE_MS = 60_000;
/** "Bekleyenler gönderildi" bu kadar süre görünür */
export const SENT_NOTICE_MS = 30 * 60_000;
/** Artan beklemenin üst sınırından (6 sa) uzun bekleme kalıcı ret sayılır (lafmaliyet 365 gün, site sonsuz) */
const BACKOFF_MAX_MS = 6 * 3600_000;

let lastCatchUpAt = 0;
let catching: Promise<CatchUpResult> | null = null;
let pendingTimer: NodeJS.Timeout | null = null;
let lastSent: { at: number; count: number } | null = null;

export interface CatchUpResult {
  before: number;
  after: number;
}

/** Dışarı gidecek, bekleyen kayıtlar (kalıcı reddedilenler sayılmaz) */
export function pendingCounts(now = Date.now()) {
  const limit = now + BACKOFF_MAX_MS + 60_000;
  const count = (target: 'lafmaliyet' | 'laffogato') =>
    db
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(and(eq(schema.outbox.target, target), isNull(schema.outbox.sentAt), lte(schema.outbox.nextAttemptAt, limit)))
      .all().length;
  const lafmaliyet = env.lafmaliyetUrl ? count('lafmaliyet') : 0;
  const site = siteSigned() ? count('laffogato') : 0;
  const cloud = cloudEnabled() && cloudState().lastError ? 1 : 0;
  return { lafmaliyet, site, cloud, total: lafmaliyet + site + cloud };
}

/**
 * Artan beklemedeki kayıtları "şimdi" yapar: yalnız bir hatadan sonra bekleyenler (`lastError`, beklemesi 6 saatten
 * kısa). Kalıcı ret ve sitenin henüz tanımadığı uç (`lastError` boş, 6 saat) olduğu gibi kalır
 */
function releaseBackoff(now: number) {
  db.update(schema.outbox)
    .set({ nextAttemptAt: now })
    .where(and(isNull(schema.outbox.sentAt), isNotNull(schema.outbox.lastError), lte(schema.outbox.nextAttemptAt, now + BACKOFF_MAX_MS + 60_000)))
    .run();
}

/** Bekleyenleri bir kez gönderir (bütçe: en sık 5 dakikada bir; sürmekte olan eşitleme varsa onu bekler) */
export function catchUp(now = Date.now()): Promise<CatchUpResult> {
  if (catching) return catching;
  lastCatchUpAt = now;
  catching = (async () => {
    const before = pendingCounts(now).total;
    releaseBackoff(now);
    await Promise.allSettled([flushOutbox(), flushSiteOutbox(), cloudEnabled() ? pushSnapshot({ heartbeat: true }) : Promise.resolve(), onlineOrdersTick()]);
    const after = pendingCounts().total;
    if (before > 0 && after === 0) lastSent = { at: Date.now(), count: before };
    if (before || after) console.log(`[internet] bekleyenler gönderildi: ${before - after}/${before}${after ? ` · ${after} hâlâ bekliyor` : ''}`);
    bus.publish({ topic: 'sync', kind: 'internet' });
    return { before, after };
  })().finally(() => {
    catching = null;
  });
  return catching;
}

/** İnternet döndü: eşitleme hemen, son eşitlemenin üstünden 5 dakika geçmediyse o dolunca */
function onBack() {
  bus.publish({ topic: 'sync', kind: 'internet' });
  if (pendingTimer) return;
  const wait = Math.max(0, lastCatchUpAt + CATCH_UP_MIN_GAP_MS - Date.now());
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void catchUp();
  }, wait);
}

/** Yapılandırılmış dış adreslerin hostu (TCP denemesi için): önce Uzaktan ve lafmaliyet, site en son */
function probeHosts(): string[] {
  const hosts: string[] = [];
  for (const url of [env.cloudUrl, env.lafmaliyetUrl, env.laffogatoUrl]) {
    try {
      if (url) hosts.push(new URL(url).hostname);
    } catch {
      /* adres bozuksa denenmez */
    }
  }
  return [...new Set(hosts)];
}

/** Bir hosta 443'ten TCP bağlantısı kurulabiliyor mu (HTTP isteği yok) */
export function tcpReachable(host: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((ok) => {
    try {
      const sock = connect({ host, port: 443, timeout: timeoutMs });
      const done = (v: boolean) => {
        sock.destroy();
        ok(v);
      };
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    } catch {
      ok(false);
    }
  });
}

/** İnternet yokken dakikada bir: bir hosta bağlanılabiliyorsa internet döndü */
export async function probeTick(reach: (host: string) => Promise<boolean> = tcpReachable) {
  if (internetState().state !== 'yok') return;
  for (const host of probeHosts()) {
    if (await reach(host)) {
      noteReachable();
      return;
    }
  }
}

/** Zamanlayıcı (server/jobs.ts) */
export function startCatchUp(): NodeJS.Timeout[] {
  onInternetBack(onBack);
  return [setInterval(() => void probeTick(), PROBE_MS)];
}

/** Durum alanı ve Genel bakış › Sistem sağlığı */
export function internetStatus(now = Date.now()) {
  const net = internetState();
  const pending = pendingCounts(now);
  const configured = probeHosts().length > 0;
  return {
    configured,
    state: net.state,
    since: net.since,
    lastOkAt: net.lastOkAt,
    lastError: net.state === 'yok' ? net.lastError : null,
    pending,
    sent: lastSent && now - lastSent.at < SENT_NOTICE_MS && pending.total === 0 ? lastSent : null,
  };
}

/** Testler için */
export function resetCatchUp() {
  lastCatchUpAt = 0;
  lastSent = null;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}
