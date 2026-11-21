import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { and, gte, lte } from 'drizzle-orm';
import { REMOTE_REPORT_DAYS, REMOTE_SHOP, type RemoteDayReport, type RemoteReportPush } from '@shared/remote-reports';
import { addDays } from '@shared/time';
import { db, schema } from '../db/client';
import { env } from '../env';
import { bus } from '../lib/events';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { closingMinutes, hourlyReport, productReport, reportToday, staffReport, summaryReport } from '../services/reports';
import { cloudEnabled } from './cloud';

/**
 * LafPOS Uzaktan raporları (docs/07-UZAKTAN-ERISIM.md §4 "Raporlar"). Kasa her iş gününün rapor özetini buluta iter:
 * kapanan günler ve gün boyu bugün. Rakamlar Raporlar'ın kendi servislerinden (server/services/reports.ts) gelir,
 * uzaktaki sayfa günleri toplayınca kasadakiyle aynı rakamı verir (tests/uzaktan-raporlar.test.ts).
 *
 * Ritim (Upstash ve kasanın işlemcisi için):
 * - Bugün ve dün (geç kapanan adisyon, gün sonu): değişiklikte en sık 5 dk'da bir; değişmeyen gün gitmez (içerik özeti).
 * - Geçmiş: ilk açılışta son 400 gün dakikada 7 günlük paketlerle (yaklaşık bir saat); sonra günde bir kez, gün
 *   kapalıyken aynı tarama yalnız değişen günü (sonradan yapılan ödeme iptali gibi) yeniden iter.
 * - İnternet yokken gidemeyen günler kuyrukta (`queue`) bekler; internet dönünce catch-up (server/sync/catch-up.ts)
 *   onları bir kez gönderir. Gönderilen günün içerik özeti saklanır: aynı gün iki kez gitmez.
 * Gitmeyen: maliyet ve kâr (ürün raporu maliyetsiz kurulur), PIN, müşteri adı ve telefonu (raporlarda yok).
 */
export const LIVE_MIN_MS = 5 * 60_000;
export const BACKFILL_MS = 60_000;
export const BACKFILL_BATCH = 7;
/** Tam taramanın (değişen eski gün) aralığı */
export const SWEEP_EVERY_MS = 24 * 3600_000;
/** Gün açık kalsa da tarama en geç bu kadarda bir */
const SWEEP_FORCE_MS = 3 * SWEEP_EVERY_MS;
const STATE_KEY = 'cloud.reports';

interface State {
  /** Gönderilmiş günlerin içerik özeti (tarih → sha256'nın ilk 16'sı) */
  sent: Record<string, string>;
  /** Gönderilemeyen günler (internet yok, bulut hata verdi) */
  queue: string[];
  /** Taramanın sıradaki günü (geriye doğru); null: tarama bitti */
  cursor: string | null;
  /** Son tam taramanın bittiği an (0: hiç bitmedi) */
  sweptAt: number;
}

const emptyState = (): State => ({ sent: {}, queue: [], cursor: null, sweptAt: 0 });

function loadState(): State {
  const s = getSyncState<Partial<State>>(STATE_KEY);
  return { ...emptyState(), ...(s ?? {}), sent: { ...(s?.sent ?? {}) }, queue: [...(s?.queue ?? [])] };
}

/** O tarihte iş günü var mı ve hepsi kapandı mı, Z numaraları */
function daysOn(date: string) {
  const rows = db.select().from(schema.businessDays).where(and(gte(schema.businessDays.date, date), lte(schema.businessDays.date, date))).all();
  return { count: rows.length, closed: rows.length > 0 && rows.every((d) => d.closedAt != null), z: rows.map((d) => d.zNo).sort((a, b) => a - b) };
}

/**
 * Bir iş gününün özeti; o tarihte iş günü yoksa null. Raporlar'ın servisleri tek günlük dönemle çağrılır: Ciro
 * (`summaryReport`), Ürünler maliyetsiz (`productReport(…, false)`), Saatlik (`hourlyReport`, haftalık ısı haritası
 * ortalamasız), Personel (`staffReport`). Yalnız rakamlar ve adlar alınır; kıyas dönemi, pay ve ortalama uzakta
 * toplamdan yeniden hesaplanır
 */
export function buildDayReport(date: string, now = Date.now()): RemoteDayReport | null {
  const days = daysOn(date);
  if (!days.count) return null;
  const range = { from: date, to: date };
  const s = summaryReport(range, now);
  const p = productReport(range, false);
  const h = hourlyReport(range, { rawWeek: true });
  const st = staffReport(range);
  const weekday = h.week.find((w) => w.days > 0);
  return {
    v: 1,
    date,
    at: now,
    n: s.days,
    closed: days.closed,
    z: days.z,
    s: {
      list: s.waterfall.list,
      gross: s.gross,
      comp: s.complimentary,
      disc: s.discounts,
      svc: s.waterfall.service,
      rev: s.netSales,
      odenmez: s.odenmez,
      zayi: s.zayi,
      voided: s.voided,
      receipts: s.receipts,
      items: s.itemsSold,
      tips: s.tips,
      guests: s.guests,
      tableSales: s.tableSales,
      paidClosed: s.reconciliation.paidClosed,
      paidOpen: s.reconciliation.paidOpen,
      onlineOrders: s.online.orders,
      onlineAmount: s.online.amount,
    },
    pay: s.payments.map((x) => [x.name, x.zField, x.amount, x.count]),
    types: s.types.map((t) => [t.type, t.orders, t.amount]),
    kdv: s.kdv.map((k) => [k.rate, k.gross, k.base, k.kdv]),
    closes: closingMinutes(date),
    prod: p.products.map((x) => [x.key, x.name, x.size, x.category, x.qty, x.revenue, x.complimentary, x.voided]),
    // Dolu saatler; gün 24 saati aştıysa ertesi günün satırları boş da olsa (saat dizisinin uzunluğu)
    hours: h.hours.filter((x) => x.revenue !== 0 || x.orders !== 0 || x.nextDay).map((x) => [x.offset, x.revenue, x.orders]),
    clock: weekday ? weekday.hours.flatMap((v, hour) => (v !== 0 ? [[hour, v] as [number, number]] : [])) : [],
    staff: st.staff.map((x) => [x.userId, x.name, x.orders, x.revenue, x.voids, x.voidValue, x.comps, x.compValue, x.discounts, x.odenmez, x.odenmezValue]),
  };
}

/** Günün içerik özeti: kuruluş anı (`at`) değişiklik sayılmaz */
export function dayHash(r: RemoteDayReport): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...r, at: 0 }))
    .digest('hex')
    .slice(0, 16);
}

const gzipAsync = (text: string) => new Promise<Buffer>((ok, fail) => gzip(text, (err, out) => (err ? fail(err) : ok(out))));

let busy = false;
let lastLiveAt = 0;
let liveTimer: NodeJS.Timeout | null = null;
let state: { lastSuccessAt?: number; lastError?: string | null; sentDays?: number } = {};

export const reportSyncState = () => {
  const s = loadState();
  return { ...state, queued: s.queue.length, backfilling: s.cursor != null && !s.sweptAt, known: Object.keys(s.sent).length };
};

/** Bekleyen (gönderilemeyen) gün sayısı: internet rozeti ve Genel bakış */
export const pendingReportDays = () => (cloudEnabled() ? loadState().queue.length : 0);

/** Test için */
export function resetReportSync() {
  busy = false;
  lastLiveAt = 0;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
  state = {};
  setSyncState(STATE_KEY, emptyState());
}

async function pushDays(today: string, days: RemoteDayReport[]): Promise<void> {
  const body: RemoteReportPush = { v: 1, shop: REMOTE_SHOP, today, at: Date.now(), days };
  const gz = (await gzipAsync(JSON.stringify(body))).toString('base64');
  const { status } = await signedFetch(env.cloudSecret, 'POST', new URL(`${env.cloudUrl}/api/uzaktan/rapor`), { gz }, 20_000);
  if (status !== 200) throw new Error(`HTTP ${status}`);
}

export type ReportTickResult = { sent: number; queued: number } | 'off' | 'busy';

/**
 * Bir tur. Canlı bakış (bugün, dün ve kuyruktaki günler) en sık 5 dk'da bir: olayla, catch-up'la ya da taramanın
 * dakikalık turunda süresi dolunca. `backfill`: taramanın sıradaki paketi (7 gün, geriye doğru). Değişen günler 7'şerli
 * paketlerle gider; bir paket gidemezse o ve sonrakiler gönderilmez: canlı günler kuyruğa girer, taramanın paketi
 * bir sonraki turda yeniden denenir (tarama ilerlemez)
 */
export async function reportTick(opts: { backfill?: boolean; now?: number } = {}): Promise<ReportTickResult> {
  if (!cloudEnabled()) return 'off';
  if (busy) return 'busy';
  busy = true;
  try {
    const now = opts.now ?? Date.now();
    const st = loadState();
    const today = reportToday(now);
    const oldest = addDays(today, -(REMOTE_REPORT_DAYS - 1));
    const live = !opts.backfill || now - lastLiveAt >= LIVE_MIN_MS - 5_000;
    const batch: string[] = [];
    const sweptBefore = st.sweptAt;
    if (opts.backfill) {
      const sweepDue = !st.sweptAt || (now - st.sweptAt >= SWEEP_EVERY_MS && (!getOpenDay(db) || now - st.sweptAt >= SWEEP_FORCE_MS));
      if (st.cursor == null && sweepDue) st.cursor = addDays(today, -2);
      while (st.cursor != null && batch.length < BACKFILL_BATCH) {
        if (st.cursor < oldest) {
          st.cursor = null;
          st.sweptAt = now;
          break;
        }
        batch.push(st.cursor);
        st.cursor = addDays(st.cursor, -1);
      }
    }
    const liveDates = live ? [today, addDays(today, -1), ...st.queue] : [];
    if (live) lastLiveAt = now;
    const dates = [...new Set([...liveDates, ...batch])].filter((d) => d >= oldest && d <= today);
    const changed: { date: string; hash: string; report: RemoteDayReport }[] = [];
    for (const date of dates) {
      const report = buildDayReport(date, now);
      if (!report) continue;
      const hash = dayHash(report);
      if (st.sent[date] !== hash) changed.push({ date, hash, report });
    }
    const failed = new Set<string>();
    let sent = 0;
    for (let i = 0; i < changed.length; i += BACKFILL_BATCH) {
      const chunk = changed.slice(i, i + BACKFILL_BATCH);
      if (!failed.size) {
        try {
          await pushDays(today, chunk.map((c) => c.report));
          for (const c of chunk) st.sent[c.date] = c.hash;
          sent += chunk.length;
          state = { lastSuccessAt: Date.now(), lastError: null, sentDays: (state.sentDays ?? 0) + chunk.length };
          continue;
        } catch (e) {
          state = { ...state, lastError: e instanceof Error ? e.message : String(e) };
        }
      }
      for (const c of chunk) failed.add(c.date);
    }
    if (batch.some((d) => failed.has(d))) {
      st.cursor = batch[0]!;
      st.sweptAt = sweptBefore;
    }
    if (live) st.queue = liveDates.filter((d, i) => failed.has(d) && liveDates.indexOf(d) === i);
    else st.queue = [...new Set([...st.queue, ...[...failed].filter((d) => !batch.includes(d))])];
    for (const d of Object.keys(st.sent)) if (d < oldest) delete st.sent[d];
    setSyncState(STATE_KEY, st);
    return { sent, queued: st.queue.length };
  } finally {
    busy = false;
  }
}

/** Değişiklik olunca bugünün özeti sıraya girer: en sık 5 dk'da bir */
function scheduleLive() {
  if (liveTimer) return;
  const wait = Math.max(1000, LIVE_MIN_MS - (Date.now() - lastLiveAt));
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void reportTick();
  }, wait);
}

/** Zamanlayıcı (server/sync/cloud.ts startCloudSync) */
export function startReportSync(): NodeJS.Timeout[] {
  if (!cloudEnabled()) return [];
  bus.on('event', (e: { topic: string }) => {
    if (e.topic === 'orders' || e.topic === 'payments' || e.topic === 'cash' || e.topic === 'settings') scheduleLive();
  });
  // Tarama dakikada bir paket (bitince yalnız günde bir kez yeniden başlar); her turda bugün ve dün de bakılır
  return [setTimeout(() => void reportTick({ backfill: true }), 20_000), setInterval(() => void reportTick({ backfill: true }), BACKFILL_MS)];
}
