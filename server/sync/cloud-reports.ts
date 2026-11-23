import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { and, gte, isNull, lt, lte } from 'drizzle-orm';
import { historyReport } from '@shared/gecmis';
import type { ItemListRow } from '@shared/remote-calc';
import { REMOTE_REPORT_DAYS, REMOTE_SHOP, type RemoteDayExtra, type RemoteDayReport, type RemoteReportPush } from '@shared/remote-reports';
import { addDays, businessDayStartMs } from '@shared/time';
import { db, schema } from '../db/client';
import { env } from '../env';
import { bus } from '../lib/events';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { remoteShop } from './merkez';
import { getOpenDay } from '../services/orders';
import { historyFor } from '../services/gecmis';
import { checksReport, closingMinutes, crossDayPayments, hourlyReport, itemListReport, platformReport, prepRaw, productReport, refundReport, reportToday, staffReport, summaryReport } from '../services/reports';
import { cloudEnabled, patronSeesCash } from './cloud';

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
 *
 * Geçmiş ciro (LafPOS öncesi, ModPOS; server/services/gecmis.ts `historyFor`): LafPOS'ta gerçek iş günü olmayan
 * tarihlerin geçmiş günü de gün raporu olarak gider (`historyReport`: kaynak adı, ModPOS Z'si, indirim, ciro dışı, KDV).
 * Böylece Uzaktan, geçmiş bulutta başka bir dükkânın anahtarında dursa ya da hiç yüklenmemiş olsa da o günleri bu
 * kasanın dükkânında gösterir; "Denemeyi bitir"den önce itilmiş eski deneme raporunun yerine geçer (yeni an). Kayıt
 * değişince (`historyAt`) bütün geçmiş günlerine bir kez bakılır, yalnız içeriği değişen gün gider.
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
  /** Gönderimin dükkân kimliği; değişince (kasa Merkez'e bağlandı) geçmiş yeni kimlikle baştan gider */
  shop: string;
  /** Uzaktan'a son bakılan geçmiş ciro kaydının anı (server/services/gecmis.ts); değişince geçmiş günlerine yeniden bakılır */
  historyAt?: number;
}

const emptyState = (): State => ({ sent: {}, queue: [], cursor: null, sweptAt: 0, shop: remoteShop() });

function loadState(): State {
  const s = getSyncState<Partial<State>>(STATE_KEY);
  // Eski durum (alan yok) `default` dükkânındır; Merkez'e bağlanan kasa geçmişi kendi kimliğiyle yeniden iter
  if ((s?.shop ?? REMOTE_SHOP) !== remoteShop()) return emptyState();
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
  if (!days.count) return platformOnlyDay(date, now);
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
      // Kasa rakamı: patron rolü kasa rakamlarını görmüyorsa (kör kasa) buluta gitmez
      ...(patronSeesCash() ? { off: s.offDevice } : {}),
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
    xpay: crossDayPayments(range),
    x: dayExtra(range, now),
  };
}

/**
 * İş günü açılmamış tarihte gelen ve kabul edilmeden kapanan platform siparişleri (ret, süresi dolan, bekleyen):
 * kasadaki Paket platformları raporu onları geldiği ana göre sayar, uzakta da görünsün. Satışı olmayan boş gün
 * (`n: 0`), yalnız platform verisiyle; yoksa null
 */
function platformOnlyDay(date: string, now: number): RemoteDayReport | null {
  const loose = db
    .select({ payload: schema.platformOrders.payload })
    .from(schema.platformOrders)
    .where(and(isNull(schema.platformOrders.orderId), gte(schema.platformOrders.receivedAt, businessDayStartMs(date)), lt(schema.platformOrders.receivedAt, businessDayStartMs(addDays(date, 1)))))
    .all();
  if (!loose.some((r) => !r.payload.test)) return null;
  const plat = platformReport({ from: date, to: date }, false, now);
  const zero = { list: 0, gross: 0, comp: 0, disc: 0, svc: 0, rev: 0, odenmez: 0, zayi: 0, voided: 0, receipts: 0, items: 0, tips: 0, guests: 0, tableSales: 0, paidClosed: 0, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 };
  return {
    v: 1,
    date,
    at: now,
    n: 0,
    closed: true,
    z: [],
    s: zero,
    pay: [],
    types: [],
    kdv: [],
    closes: [],
    prod: [],
    hours: [],
    clock: [],
    staff: [],
    xpay: [],
    x: {
      prep: { done: [], hand: [] },
      checks: [],
      lists: { iptal: [], ikram: [], indirim: [], happy: [] },
      odenmez: [],
      refunds: [],
      plat: { rows: plat.platforms.map(({ avgBasket: _a, share: _s, ...r }) => r), pending: plat.pending },
    },
  };
}

/**
 * Günün ek verisinin buluttaki sınırı (Upstash değer sınırı; bulut 900 KB'ı geçeni saklamaz). Aşan günün en uzun
 * listeleri kısaltılır (önce happy hour, sonra indirim, adisyonlar, ikram, iptal: en eski satırlar düşer); düşen
 * satırların sayısı ve tutarı `cut`'ta kalır, uzaktaki toplamlar kasadakiyle aynı çıkar, liste "kısaltıldı" der
 */
export const EXTRA_LIMIT_BYTES = 850 * 1024;
export function fitExtra(x: RemoteDayExtra, limit = EXTRA_LIMIT_BYTES): RemoteDayExtra {
  let size = JSON.stringify(x).length;
  if (size <= limit) return x;
  const out: RemoteDayExtra = { ...x, lists: { ...x.lists }, checks: [...x.checks], cut: {} };
  const cut = out.cut!;
  for (const kind of ['happy', 'indirim', 'checks', 'ikram', 'iptal'] as const) {
    while (size > limit) {
      const list = (kind === 'checks' ? out.checks : out.lists[kind]) as unknown as { at?: number; value?: number }[];
      if (!list.length) break;
      const avg = JSON.stringify(list).length / list.length;
      const drop = Math.min(list.length, Math.ceil((size - limit) / Math.max(1, avg)) + 1);
      const kept = list.slice(0, list.length - drop);
      const gone = list.slice(list.length - drop);
      if (kind === 'checks') {
        out.checks = kept as RemoteDayExtra['checks'];
        cut.checks = (cut.checks ?? 0) + gone.length;
      } else {
        out.lists[kind] = kept as ItemListRow[];
        const c = cut[kind] ?? { count: 0, value: 0 };
        cut[kind] = { count: c.count + gone.length, value: c.value + gone.reduce((a, r) => a + (r.value ?? 0), 0) };
      }
      size = JSON.stringify(out).length;
    }
    if (size <= limit) break;
  }
  return out;
}

/** Kalem listesinin buluta giden hali: neden yok; ödenmezin müşteri kişisi yalnız "Müşteri" */
const privateRow = (r: ItemListRow): ItemListRow => ({ ...r, reason: null, person: r.person ? (r.person.kind === 'customer' ? { kind: 'customer', name: 'Müşteri' } : r.person) : null });

/** Günün ek sekmeleri: Raporlar'ın kendi servisleri tek günle, maliyetsiz */
function dayExtra(range: { from: string; to: string }, now: number): RemoteDayExtra {
  const prep = prepRaw(range);
  const list = (kind: 'iptal' | 'ikram' | 'indirim' | 'happy') => itemListReport(range, kind);
  const ikram = list('ikram');
  const plat = platformReport(range, false, now);
  return fitExtra({
    prep: { done: prep.done, hand: prep.handoffs },
    checks: checksReport(range, null).rows,
    lists: { iptal: list('iptal').rows.map(privateRow), ikram: ikram.rows.map(privateRow), indirim: list('indirim').rows.map(privateRow), happy: list('happy').rows.map(privateRow) },
    // Müşterilerin ödenmezi tek "Müşteri" satırında
    odenmez: ikram.odenmezPeople.map((p) => (p.kind === 'customer' ? { kind: 'customer', id: null, name: 'Müşteri', qty: p.qty, amount: p.amount } : p)),
    refunds: refundReport(range).rows.map((r) => ({ ...r, reason: null })),
    plat: {
      rows: plat.platforms.map(({ avgBasket: _a, share: _s, ...r }) => r),
      pending: plat.pending,
    },
  });
}

/** Ürünlerin bugünkü kategorisi: uzaktaki dönem raporunda kategori kasadaki gibi bugünküdür */
function categoryMap(): Record<string, string> {
  const cats = new Map(db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).all().map((c) => [c.id, c.name]));
  return Object.fromEntries(db.select({ id: schema.products.id, categoryId: schema.products.categoryId }).from(schema.products).all().map((p) => [p.id, cats.get(p.categoryId) ?? '']));
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
/** Durumun kuşağı: "yeniden gönder" sıfırlayınca artar; ağ beklerken sıfırlanan tur eski durumu yazmaz */
let generation = 0;
let lastLiveAt = 0;
let liveTimer: NodeJS.Timeout | null = null;
let state: { lastSuccessAt?: number; lastError?: string | null; sentDays?: number } = {};

export const reportSyncState = () => {
  const s = loadState();
  return { ...state, queued: s.queue.length, backfilling: s.cursor != null && !s.sweptAt, known: Object.keys(s.sent).length };
};

/** Bekleyen (gönderilemeyen) gün sayısı: internet rozeti ve Genel bakış */
export const pendingReportDays = () => (cloudEnabled() ? loadState().queue.length : 0);

/**
 * Uzaktan raporları baştan gönder (Yönetim › Ağ ve uzaktan erişim): bulutta Redis silinmiş ya da eksikse. Gönderim
 * geçmişi sıfırlanır; tarama 400 günü dakikada 7 günlük paketlerle yeniden iter (yaklaşık bir saat)
 */
export function resendReports() {
  // Süren tur bitince eski durumu geri yazmasın: kuşak değişir, o tur yazmadan çıkar
  generation += 1;
  setSyncState(STATE_KEY, emptyState());
  void reportTick({ backfill: true });
}

/** Test için */
export function resetReportSync() {
  generation += 1;
  busy = false;
  lastLiveAt = 0;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
  state = {};
  setSyncState(STATE_KEY, emptyState());
}

/** Gönderim; bulutun saklamadığı günler (sınırı aştı) döner */
async function pushDays(today: string, days: RemoteDayReport[], at: number): Promise<{ date: string; why: string }[]> {
  const body: RemoteReportPush = { v: 1, shop: remoteShop(), today, at, days, cat: categoryMap() };
  const gz = (await gzipAsync(JSON.stringify(body))).toString('base64');
  const { status, json } = await signedFetch(env.cloudSecret, 'POST', new URL(`${env.cloudUrl}/api/uzaktan/rapor`), { gz }, 20_000);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const skipped = (json as { skippedDates?: unknown } | null)?.skippedDates;
  return Array.isArray(skipped) ? skipped.filter((x): x is { date: string; why: string } => !!x && typeof (x as { date?: unknown }).date === 'string') : [];
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
    const myGen = generation;
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
    // Geçmiş ciro günleri (ModPOS): LafPOS'ta gerçek iş günü olmayan tarihte gün raporu onlardan kurulur
    const hist = historyFor({ from: oldest, to: addDays(today, -1) }, today);
    const histByDate = new Map((hist?.days ?? []).map((d) => [d.date, d]));
    const histDue = hist && st.historyAt !== hist.at ? [...histByDate.keys()] : [];
    const dates = [...new Set([...liveDates, ...batch, ...histDue])].filter((d) => d >= oldest && d <= today);
    // Boş tur (canlı bakışın sırası gelmedi, tarama bitti): veritabanına yazılmaz
    if (!dates.length && st.sweptAt === sweptBefore) return { sent: 0, queued: st.queue.length };
    const changed: { date: string; hash: string; report: RemoteDayReport }[] = [];
    for (const date of dates) {
      const h = histByDate.get(date);
      const report = h ? { ...historyReport(h, hist!.kaynak), at: now } : buildDayReport(date, now);
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
          const skipped = await pushDays(today, chunk.map((c) => c.report), now);
          if (myGen !== generation) return { sent, queued: st.queue.length };
          // Bulutun saklamadığı gün de gönderildi sayılır (her 5 dk'da aynı büyük gün yeniden gitmesin); ekranda yazar
          for (const c of chunk) st.sent[c.date] = c.hash;
          sent += chunk.length;
          state = { lastSuccessAt: Date.now(), lastError: skipped.length ? `Gün çok büyük, bulut saklamadı: ${skipped.map((x) => x.date).join(', ')}` : null, sentDays: (state.sentDays ?? 0) + chunk.length };
          continue;
        } catch (e) {
          if (myGen !== generation) return { sent, queued: st.queue.length };
          state = { ...state, lastError: e instanceof Error ? e.message : String(e) };
        }
      }
      for (const c of chunk) failed.add(c.date);
    }
    if (batch.some((d) => failed.has(d))) {
      st.cursor = batch[0]!;
      st.sweptAt = sweptBefore;
    }
    // Geçmiş günlerinden biri gidemediyse kayıt yeniden bakılmak üzere bekler (gitmiş olanın özeti aynı, yeniden gitmez)
    if (hist && histDue.length && !histDue.some((d) => failed.has(d))) st.historyAt = hist.at;
    if (live) st.queue = liveDates.filter((d, i) => failed.has(d) && liveDates.indexOf(d) === i);
    else st.queue = [...new Set([...st.queue, ...[...failed].filter((d) => !batch.includes(d))])];
    for (const d of Object.keys(st.sent)) if (d < oldest) delete st.sent[d];
    // Bu sırada durum sıfırlandıysa ("Yeniden gönder") eski durum yazılmaz; sıfır durumla tarama baştan başlar
    if (myGen !== generation) return { sent, queued: st.queue.length };
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
    if (e.topic === 'orders' || e.topic === 'payments' || e.topic === 'cash' || e.topic === 'settings' || e.topic === 'delivery') scheduleLive();
  });
  // Tarama dakikada bir paket (bitince yalnız günde bir kez yeniden başlar); her turda bugün ve dün de bakılır
  return [setTimeout(() => void reportTick({ backfill: true }), 20_000), setInterval(() => void reportTick({ backfill: true }), BACKFILL_MS)];
}
