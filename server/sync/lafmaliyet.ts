import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { compReasonText } from '@shared/comp';
import { allocate } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { posNameKey, posSlotOf, soldPosName } from '@shared/pos-name';
import type { SelectedOption } from '@shared/types';
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

type ItemRow = typeof schema.orderItems.$inferSelect;
type AddonKey = 'extraShot' | 'syrup' | 'milk';

/** Seçenek eklerinin lafmaliyet'teki ürün adları (ModPOS'taki adlarla aynı) */
const ADDON_NAMES: Record<AddonKey, string> = { extraShot: 'EXTRA SHOT', syrup: 'SYRUP', milk: 'ALTERNATIF SÜT' };
/** Masa servis ücreti: ürün değil, lafmaliyet'te HİZMET satırı (satırların toplamı Z toplamını tutsun) */
export const SERVICE_POS_NAME = 'SERVİS ÜCRETİ';
/** Eklerin sitedeki sabit kalemleri (laffogato menüsü, `extras` kategorisi; server/db/menu-snapshot.json) */
const ADDON_SITE_IDS: Record<AddonKey, string> = { syrup: 'mnu-0080', extraShot: 'mnu-0081', milk: 'mnu-0082' };
/** Ek sayılmayan varsayılan seçenek kodları (sitenin `customization` kimlikleri) */
const ADDON_NONE: Partial<Record<AddonKey, string>> = { milk: 'normal', syrup: 'none' };
const isAddonKey = (k: string | null): k is AddonKey => k === 'extraShot' || k === 'syrup' || k === 'milk';

/**
 * Kalemin lafmaliyet'e ayrı satır giden ekleri. Seçim fiyata göre değil koda göre: laktozsuz süt 0 TL'dir ama
 * alternatif süttür (reçete tüketimi); "Normal" süt ve "Şurup yok" ek değildir; ekstra shot adediyle.
 */
export function addonsOf(options: SelectedOption[]): { key: AddonKey; qty: number; price: number }[] {
  const out: { key: AddonKey; qty: number; price: number }[] = [];
  for (const op of options) {
    if (!isAddonKey(op.groupKey) || op.qty <= 0) continue;
    const none = ADDON_NONE[op.groupKey];
    // Kodsuz (eski) seçenekte yalnız ücretli olan ek sayılır
    if (none && (op.code ? op.code === none : op.price <= 0)) continue;
    out.push({ key: op.groupKey, qty: op.qty, price: op.price });
  }
  return out;
}

/** Eklerin site kimlikleri: önce sabit kimlik (yerelde varsa), yoksa `extras` kategorisinde ada göre */
function addonSiteIds(): Record<AddonKey, string | null> {
  const linked = db
    .select({ name: schema.products.name, extId: schema.products.extId, categoryKey: schema.categories.extKey })
    .from(schema.products)
    .innerJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(eq(schema.products.extSource, 'laffogato'))
    .all();
  const ids = new Set(linked.map((p) => p.extId));
  const extras = linked.filter((p) => p.categoryKey === 'extras');
  const find = (key: AddonKey, re: RegExp) => (ids.has(ADDON_SITE_IDS[key]) ? ADDON_SITE_IDS[key] : (extras.find((e) => re.test(e.name.toLocaleLowerCase('tr-TR')))?.extId ?? null));
  return { extraShot: find('extraShot', /shot/), syrup: find('syrup', /şurup|syrup/), milk: find('milk', /süt/) };
}

interface Part {
  posName: string;
  siteMenuId: string | null;
  slot: 'M' | 'L' | null;
  qty: number;
  /** kuruş: satışta net ciro, ikramda menü değeri */
  value: number;
  isService: boolean;
}

/** Kalemin değerini ana ürün ve ekleri arasında liste fiyatları oranında böler (satışta ve ikramda aynı oran) */
function itemParts(i: ItemRow, value: number, addonIds: Record<AddonKey, string | null>): Part[] {
  const addons = addonsOf(i.options);
  const weights = [i.unitPrice - addons.reduce((a, op) => a + op.price * op.qty, 0), ...addons.map((op) => op.price * op.qty)];
  const shares = allocate(value, weights);
  const size = i.size === 'L' ? 'L' : i.size === 'M' ? 'M' : 'TEK';
  return [
    { posName: soldPosName(i.posName, i.name, size, getSettings().posSizeSuffix), siteMenuId: i.extProductId, slot: posSlotOf(i.extProductId, size), qty: i.qty, value: shares[0] ?? value, isService: i.isService },
    ...addons.map((op, k) => ({
      posName: ADDON_NAMES[op.key],
      siteMenuId: addonIds[op.key],
      slot: addonIds[op.key] ? ('M' as const) : null,
      qty: i.qty * op.qty,
      value: shares[k + 1] ?? 0,
      isService: false,
    })),
  ];
}

const partKey = (p: Pick<Part, 'posName' | 'siteMenuId' | 'slot'>) => `${posNameKey(p.posName)}|${p.siteMenuId ?? ''}|${p.slot ?? ''}`;

/**
 * Satırları `posName|siteMenuId|slot` anahtarıyla toplar ve günde bir ada bir satır kuralını (lafmaliyet
 * `parsePosDay`) sağlar: aynı ad iki farklı kaleme / boya düşerse ikinciye boy eki, yine çakışırsa site kimliği
 * eklenir. Siteye bağlı satır kalemiyle eşleştiği için ad yalnız bağsız üründe önemlidir; bağsız satır adını korur.
 */
function mergeParts(parts: Part[]): { lines: SaleLine[]; names: Map<string, string> } {
  const groups = new Map<string, SaleLine>();
  for (const p of parts) {
    const k = partKey(p);
    const cur = groups.get(k);
    if (cur) {
      cur.qty += p.qty;
      cur.revenue += p.value;
    } else groups.set(k, { posName: p.posName, siteMenuId: p.siteMenuId, slot: p.slot, qty: p.qty, revenue: p.value, isService: p.isService });
  }
  const suffix = getSettings().posSizeSuffix;
  const rank = (l: SaleLine) => (l.siteMenuId ? 1 : 0);
  const ordered = [...groups.entries()].sort(
    ([, a], [, b]) => rank(a) - rank(b) || (a.siteMenuId ?? '').localeCompare(b.siteMenuId ?? '') || (a.slot === b.slot ? 0 : a.slot === 'M' ? -1 : 1),
  );
  const reserved = new Set(ordered.map(([, l]) => posNameKey(l.posName)));
  const used = new Set<string>();
  const free = (name: string) => !used.has(posNameKey(name)) && !reserved.has(posNameKey(name));
  const names = new Map<string, string>();
  for (const [k, l] of ordered) {
    if (used.has(posNameKey(l.posName))) {
      const sizeTail = l.slot ? suffix[l.slot].trim() : '';
      const sized = sizeTail && !posNameKey(l.posName).endsWith(` ${posNameKey(sizeTail)}`) ? `${l.posName} ${sizeTail}` : null;
      let name = [sized, `${sized ?? l.posName} (${l.siteMenuId ?? 'yerel'})`].find((c): c is string => !!c && free(c));
      for (let n = 2; !name; n++) if (free(`${l.posName} (${n})`)) name = `${l.posName} (${n})`;
      l.posName = name;
    }
    used.add(posNameKey(l.posName));
    names.set(k, l.posName);
  }
  return { lines: [...groups.values()].sort((a, b) => b.revenue - a.revenue || a.posName.localeCompare(b.posName, 'tr')), names };
}

/** Kapanmış POS adisyonlarının koşulu (online siparişler hariç: tahsil edilmez, sitenin cirosudur) */
const closedPosWhere = (dayIds: string[]) =>
  and(inArray(schema.orders.dayId, dayIds), eq(schema.orders.status, 'kapali'), eq(schema.orders.source, 'pos'));

function closedPosOrders(dayIds: string[]) {
  if (!dayIds.length) return [];
  return db.select().from(schema.orders).where(closedPosWhere(dayIds)).all();
}

function salesOf(dayIds: string[], addonIds = addonSiteIds()) {
  const orders = closedPosOrders(dayIds);
  if (!orders.length) return { lines: [], names: new Map<string, string>() };
  // Kalemler alt sorguyla: adisyon kimlikleri bağlanmaz (SQLite bir sorguda en çok 32.766 değişken alır)
  const saleIds = db.select({ id: schema.orders.id }).from(schema.orders).where(closedPosWhere(dayIds));
  const items = db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, saleIds)).all();
  const totals = new Map(orders.map((o) => [o.id, o.totals ?? calcOrder({ lines: [] })]));
  const parts: Part[] = [];
  for (const i of items) {
    if (i.voided || i.complimentary) continue;
    parts.push(...itemParts(i, totals.get(i.orderId)?.lineNet[i.id] ?? 0, addonIds));
  }
  // Servis ücreti ayrı hizmet satırı, adedi servis ücretli adisyon sayısı
  for (const t of totals.values()) {
    if (t.service > 0) parts.push({ posName: SERVICE_POS_NAME, siteMenuId: null, slot: null, qty: 1, value: t.service, isService: true });
  }
  return mergeParts(parts);
}

/** Kapanmış POS adisyonlarından ürün satış satırları (iptal, ikram ve online siparişler hariç); servis ücreti
 * varsa ayrı hizmet satırı. Satırların toplamı adisyonların toplamına (Z toplamına) eşittir. */
export function salesLines(dayIds: string[]): SaleLine[] {
  return salesOf(dayIds).lines;
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
  const addonIds = addonSiteIds();
  const { lines, names } = salesOf([day.id], addonIds);
  // İkram: Z'nin `offRevenue`'u gibi yalnız kapanmış adisyonlardan (iptal edilen adisyonun ikramı tüketim değil);
  // içeceğin ekleri ayrı kayıt, menü değeri satıştaki oranla bölünür
  const closedIds = closedPosOrders([day.id]).map((o) => o.id);
  const comps = closedIds.length
    ? db.select().from(schema.orderItems).where(and(inArray(schema.orderItems.orderId, closedIds), eq(schema.orderItems.complimentary, true), eq(schema.orderItems.voided, false))).orderBy(asc(schema.orderItems.createdAt), asc(schema.orderItems.id)).all()
    : [];
  // Banka POS'unun gördüğü ama Z'nin kart alanına girmeyen tutarlar (lafmaliyet kart farkını bunlarla açıklar)
  const cardPays = db
    .select({ orderId: schema.payments.orderId, amount: schema.payments.amount, tip: schema.payments.tip })
    .from(schema.payments)
    .where(and(eq(schema.payments.dayId, day.id), eq(schema.payments.zField, 'card'), isNull(schema.payments.refundedAt)))
    .all();
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
      // Kartla bahşiş ve kartla cari tahsilatı: banka POS'unda var, Z'nin `card` alanında yok (isteğe bağlı alanlar)
      cardTips: toTL(cardPays.reduce((a, p) => a + (p.orderId ? p.tip : 0), 0)),
      cardCollections: toTL(cardPays.reduce((a, p) => a + (p.orderId ? 0 : p.amount), 0)),
    },
    lines: lines.map((l) => ({ posName: l.posName, siteMenuId: l.siteMenuId, slot: l.slot, qty: l.qty, revenue: toTL(l.revenue), isService: l.isService })),
    ikram: comps.flatMap((i) =>
      itemParts(i, i.qty * i.unitPrice, addonIds).map((p) => ({
        // Satış satırı yeniden adlandırıldıysa (aynı ad iki kaleme düştü) ikram da aynı adı taşır
        posName: names.get(partKey(p)) ?? p.posName,
        siteMenuId: p.siteMenuId,
        slot: p.slot,
        qty: p.qty,
        menuValue: toTL(p.value),
        // Sözleşmede tür alanı yok (docs/03-ENTEGRASYON.md): ödenmez ve zayi nedenin başında yazılır
        reason: compReasonText(i.compKind, i.compReason),
      })),
    ),
    payments: summary.payments.map((p) => ({ name: p.name, zField: p.zField, channel: p.channel ?? null, count: p.count, amount: toTL(p.amount) })),
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
    // Giden kutusunu site de kullanır (Tükendi yazımları, target 'laffogato'): lafmaliyet'e yalnız kendi kayıtları
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), isNull(schema.outbox.sentAt), lte(schema.outbox.nextAttemptAt, Date.now())))
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
  const pending = db
    .select({ id: schema.outbox.id, lastError: schema.outbox.lastError, attempts: schema.outbox.attempts, dedupeKey: schema.outbox.dedupeKey })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), isNull(schema.outbox.sentAt)))
    .all();
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
