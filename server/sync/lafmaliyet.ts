import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { allocate } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { db, schema } from '../db/client';
import { env } from '../env';
import { money, toCsv } from '../lib/csv';
import { conflict, HttpError, notFound } from '../lib/http';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { computeSummary, lafmaliyetZ } from '../services/days';

/**
 * LafPOS → lafmaliyet. Bugün: Satışlar ekranına yüklenen "Ürün;Adet;Tutar" listesi ve Kasa raporu alanları.
 * lafmaliyet'te imzalı uç yazılınca: aynı veri giden kutusundan `POST /api/pos/gun` ile gider.
 * docs/03-ENTEGRASYON.md §3-4
 */

export interface SaleLine {
  posName: string;
  siteMenuId: string | null;
  slot: 'M' | 'L' | null;
  qty: number;
  /** kuruş, KDV dahil */
  revenue: number;
  isService: boolean;
}

/** Seçenek eklerinin lafmaliyet'teki ürün adları (ModPOS'taki adlarla aynı) */
const ADDON_NAMES: Record<string, string> = { extraShot: 'EXTRA SHOT', syrup: 'SYRUP', milk: 'ALTERNATIF SÜT' };

function addonSiteIds(): Record<string, string | null> {
  const extras = db
    .select({ name: schema.products.name, extId: schema.products.extId })
    .from(schema.products)
    .innerJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.categories.extKey, 'extras')))
    .all();
  const find = (re: RegExp) => extras.find((e) => re.test(e.name.toLocaleLowerCase('tr-TR')))?.extId ?? null;
  return { extraShot: find(/shot/), syrup: find(/şurup|syrup/), milk: find(/süt/) };
}

/** Kapanmış POS adisyonlarından ürün satış satırları (iptal, ikram ve online siparişler hariç) */
export function salesLines(dayIds: string[]): SaleLine[] {
  if (!dayIds.length) return [];
  const sale = and(inArray(schema.orders.dayId, dayIds), eq(schema.orders.status, 'kapali'), eq(schema.orders.source, 'pos'));
  const orders = db.select().from(schema.orders).where(sale).all();
  if (!orders.length) return [];
  // Kalemler alt sorguyla (adisyon kimlikleri bağlanmaz: SQLite bir sorguda en çok 32.766 değişken alır) ve adisyona
  // göre bir kez gruplanır (adisyon başına bütün listeyi taramak uzun dönemde karesel)
  const saleIds = db.select({ id: schema.orders.id }).from(schema.orders).where(sale);
  const itemsBy = new Map<string, (typeof schema.orderItems.$inferSelect)[]>();
  for (const i of db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, saleIds)).all()) {
    const list = itemsBy.get(i.orderId);
    if (list) list.push(i);
    else itemsBy.set(i.orderId, [i]);
  }
  const addonIds = addonSiteIds();
  const lines = new Map<string, SaleLine>();
  const add = (l: SaleLine) => {
    const cur = lines.get(l.posName);
    if (cur) {
      cur.qty += l.qty;
      cur.revenue += l.revenue;
    } else lines.set(l.posName, { ...l });
  };
  for (const o of orders) {
    const its = itemsBy.get(o.id) ?? [];
    const totals = o.totals ?? calcOrder({ lines: [] });
    for (const i of its) {
      if (i.voided || i.complimentary) continue;
      const net = totals.lineNet[i.id] ?? 0;
      const addons = i.options.filter((op) => op.price > 0 && op.groupKey && ADDON_NAMES[op.groupKey]);
      // Satırın net cirosunu ana ürün ve ekler arasında liste fiyatları oranında böl
      const weights = [i.unitPrice - addons.reduce((a, op) => a + op.price * op.qty, 0), ...addons.map((op) => op.price * op.qty)];
      const shares = allocate(net, weights);
      add({
        posName: i.posName ?? i.name.toLocaleUpperCase('tr-TR'),
        siteMenuId: i.extProductId,
        slot: i.extProductId ? (i.size === 'L' ? 'L' : 'M') : null,
        qty: i.qty,
        revenue: shares[0] ?? net,
        isService: i.isService,
      });
      addons.forEach((op, k) => {
        add({ posName: ADDON_NAMES[op.groupKey!], siteMenuId: addonIds[op.groupKey!] ?? null, slot: addonIds[op.groupKey!] ? 'M' : null, qty: i.qty * op.qty, revenue: shares[k + 1] ?? 0, isService: false });
      });
    }
  }
  return [...lines.values()].sort((a, b) => b.revenue - a.revenue);
}

export function daysInRange(from: string, to: string) {
  return db
    .select()
    .from(schema.businessDays)
    .where(and(gte(schema.businessDays.date, from), lte(schema.businessDays.date, to)))
    .orderBy(asc(schema.businessDays.date))
    .all();
}

/**
 * lafmaliyet Satışlar ekranının okuduğu biçim (noktalı virgül, Türkçe ondalık, KDV dahil tutar). lafmaliyet'in
 * yapıştırma ayrıştırıcısı tırnak bilmez, sekmeyi ayraç sayar: POS adındaki satır sonu ve sekme boşluğa, noktalı
 * virgül virgüle döner (her satır bir ürün, üç hücre). Hücreler server/lib/csv.ts ile yazılır: Excel'de açılınca
 * =, +, -, @ ile başlayan ad formül olarak çalışmaz (başına ' konur, lafmaliyet adın başındaki '’u atar).
 */
export function salesCsv(from: string, to: string): string {
  const lines = salesLines(daysInRange(from, to).map((d) => d.id));
  const name = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/;/g, ',').trim();
  return toCsv([['Ürün', 'Adet', 'Tutar'], ...lines.map((l) => [name(l.posName), l.qty, money(l.revenue)])]);
}

const toTL = (k: number) => Math.round(k) / 100;

/** Sözleşme §4: bir iş gününün paketi (tutarlar TL) */
export function buildDayPayload(dayId: string) {
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (!day) throw notFound('Gün');
  const summary = day.summary ?? computeSummary(db, day);
  const z = lafmaliyetZ(day, summary);
  const lines = salesLines([day.id]);
  const orderIds = db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.source, 'pos'))).all().map((o) => o.id);
  const comps = orderIds.length
    ? db.select().from(schema.orderItems).where(and(inArray(schema.orderItems.orderId, orderIds), eq(schema.orderItems.complimentary, true), eq(schema.orderItems.voided, false))).all()
    : [];
  return {
    version: 1,
    source: 'lafpos',
    date: day.date,
    z: {
      zNo: z.z_no,
      receipts: z.receipts,
      zTotal: z.z_total,
      cash: z.cash,
      card: z.card,
      mealCard: z.meal_card,
      online: z.online,
      other: z.other,
      offRevenue: z.off_revenue,
      discounts: z.discounts,
      openingCash: z.opening_cash,
      cashOut: z.cash_out,
      countedCash: z.counted_cash,
      handedOver: z.handed_over,
      cashDiff: z.cash_diff,
      // lafmaliyet beklenen nakdi bunlarla LafPOS'unkine eşitler (docs/03-ENTEGRASYON.md §4)
      cashIn: z.cash_in,
      expectedCash: z.expected_cash,
    },
    lines: lines.map((l) => ({ posName: l.posName, siteMenuId: l.siteMenuId, slot: l.slot, qty: l.qty, revenue: toTL(l.revenue), isService: l.isService })),
    ikram: comps.map((i) => ({
      posName: i.posName ?? i.name.toLocaleUpperCase('tr-TR'),
      siteMenuId: i.extProductId,
      slot: i.extProductId ? (i.size === 'L' ? 'L' : 'M') : null,
      qty: i.qty,
      menuValue: toTL(i.qty * i.unitPrice),
      reason: i.compReason ?? '',
    })),
    payments: summary.payments.map((p) => ({ name: p.name, zField: p.zField, channel: p.channel, count: p.count, amount: toTL(p.amount) })),
  };
}

const configured = () => !!env.lafmaliyetUrl && env.lafmaliyetToken.length >= MIN_SECRET_LENGTH;

/** Günün paketini giden kutusuna koyar (aynı günün bekleyen paketi varsa yerine geçer) */
export function enqueueDay(dayId: string) {
  if (!configured()) return false;
  const payload = buildDayPayload(dayId);
  const key = `gun:${payload.date}`;
  const now = Date.now();
  db.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, key), isNull(schema.outbox.sentAt))).run();
  db.insert(schema.outbox).values({ target: 'lafmaliyet', kind: 'pos.gun', dedupeKey: key, payload, createdAt: now, nextAttemptAt: now }).run();
  return true;
}

/** Süren gönderim. Bu sırada gelen istek onun bitmesini bekleyip yeniden gönderir: kuyruğa yeni giren gün dakikalık
 * işi beklemez, "Gönder" de gerçekten gönderilmeden "gönderildi" demez (inceleme, 26 Eki 2026). */
let running: Promise<{ sent: number; failed: number }> | null = null;

/** Giden kutusunu gönderir; başarısız olan artan beklemeyle tekrar denenir (internet yokken satış durmaz). */
export function flushOutbox(): Promise<{ sent: number; failed: number }> {
  if (!configured()) return Promise.resolve({ sent: 0, failed: 0 });
  if (running) return running.then(() => flushOutbox());
  running = sendDue()
    // Arka planda çağrılır (`void flushOutbox()`): beklenmeyen hata süreci düşürmesin, sonraki tur yine dener
    .catch((e) => {
      console.warn('[lafmaliyet] giden kutusu gönderilemedi:', e instanceof Error ? e.message : e);
      return { sent: 0, failed: 0 };
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function sendDue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const due = db
    .select()
    .from(schema.outbox)
    .where(and(isNull(schema.outbox.sentAt), lte(schema.outbox.nextAttemptAt, Date.now())))
    .orderBy(asc(schema.outbox.id))
    .limit(20)
    .all();
  for (const row of due) {
    try {
      const { status, json } = await signedFetch(env.lafmaliyetToken, 'POST', new URL(`${env.lafmaliyetUrl}/api/pos/gun`), row.payload, 15_000);
      const detail = json && typeof json === 'object' ? ` (${[(json as { error?: unknown }).error, (json as { field?: unknown }).field].filter(Boolean).join(': ')})` : '';
      // 400/413 kalıcıdır (veri hatalı ya da büyük), 409 aynı tarihte başka Z (z_conflict): tekrar denenmez,
      // elle düzeltilip yeniden gönderilir
      if (status === 400 || status === 409 || status === 413 || status === 422) {
        db.update(schema.outbox)
          .set({ attempts: row.attempts + 1, lastError: `lafmaliyet reddetti: HTTP ${status}${detail}`, nextAttemptAt: Date.now() + 365 * 86400_000 })
          .where(eq(schema.outbox.id, row.id))
          .run();
        failed++;
        continue;
      }
      if (status !== 200) throw new Error(`HTTP ${status}${detail}`);
      db.update(schema.outbox).set({ sentAt: Date.now(), lastError: null, attempts: row.attempts + 1 }).where(eq(schema.outbox.id, row.id)).run();
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8));
      db.update(schema.outbox)
        .set({ attempts, lastError: e instanceof Error ? e.message : String(e), nextAttemptAt: Date.now() + wait })
        .where(eq(schema.outbox.id, row.id))
        .run();
      failed++;
    }
  }
  if (sent || failed) setSyncState('lafmaliyet.push', { lastRunAt: Date.now(), sent, failed });
  return { sent, failed };
}

export async function pushDayNow(dayId: string) {
  if (!configured()) throw conflict('lafmaliyet bağlantısı tanımlı değil (LAFMALIYET_URL, LAFMALIYET_SYNC_SECRET)', 'not_configured');
  enqueueDay(dayId);
  const r = await flushOutbox();
  if (r.failed && !r.sent) {
    const row = db.select().from(schema.outbox).where(eq(schema.outbox.kind, 'pos.gun')).orderBy(asc(schema.outbox.id)).all().pop();
    throw new HttpError(502, `lafmaliyet'e gönderilemedi: ${row?.lastError ?? 'bilinmeyen hata'}. Giden kutusunda bekliyor, sonra tekrar denenecek`, 'lafmaliyet_push');
  }
  return r;
}

/** lafmaliyet'ten boy bazında birim maliyet (kuruş, KDV hariç). Yalnız maliyet yetkisi olanlara gösterilir. */
export async function pullCosts() {
  if (!configured()) throw conflict('lafmaliyet bağlantısı tanımlı değil', 'not_configured');
  const { status, json } = await signedFetch(env.lafmaliyetToken, 'GET', new URL(`${env.lafmaliyetUrl}/api/panel/pos/urunler`));
  if (status !== 200) throw new HttpError(502, `Maliyetler alınamadı (HTTP ${status})`, 'lafmaliyet_costs');
  const items = (json as { items?: { siteMenuId: string; slot: 'M' | 'L'; costMinor: number }[] })?.items ?? [];
  const map: Record<string, number> = {};
  for (const i of items) if (i.siteMenuId && Number.isFinite(i.costMinor)) map[`${i.siteMenuId}:${i.slot}`] = Math.round(i.costMinor);
  setSyncState('lafmaliyet.costs', { at: Date.now(), map });
  // Tek boy ve M maliyeti ürünün kendi alanına da yazılır (menü ekranında gösterim için)
  const products = db.select({ id: schema.products.id, extId: schema.products.extId }).from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
  for (const p of products) {
    const cost = map[`${p.extId}:M`];
    if (cost != null) db.update(schema.products).set({ cost }).where(eq(schema.products.id, p.id)).run();
  }
  return { count: items.length };
}

export function costMap(): Record<string, number> {
  return getSyncState<{ map: Record<string, number> }>('lafmaliyet.costs')?.map ?? {};
}

export function lafmaliyetStatus() {
  const pending = db.select({ id: schema.outbox.id, lastError: schema.outbox.lastError, attempts: schema.outbox.attempts, dedupeKey: schema.outbox.dedupeKey }).from(schema.outbox).where(isNull(schema.outbox.sentAt)).all();
  return {
    configured: configured(),
    url: env.lafmaliyetUrl || null,
    pending: pending.length,
    pendingDays: pending.map((p) => p.dedupeKey),
    lastError: pending.find((p) => p.lastError)?.lastError ?? null,
    push: getSyncState('lafmaliyet.push'),
    costsAt: getSyncState<{ at: number }>('lafmaliyet.costs')?.at ?? null,
    autoPush: getSettings().menuAutoSync,
  };
}
