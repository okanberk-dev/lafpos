import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { compReasonText } from '@shared/comp';
import { allocate } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { PLATFORM_FEE_POS_NAME, posNameKey, posSlotOf, soldPosName } from '@shared/pos-name';
import { addDays, businessDate, isCalendarDate } from '@shared/time';
import type { SelectedOption } from '@shared/types';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { money, toCsv } from '../lib/csv';
import { Effects } from '../lib/effects';
import { bus } from '../lib/events';
import { conflict, HttpError, notFound } from '../lib/http';
import { getSettings, getSyncState, setSyncState, trainingDayNow, trainingMode } from '../lib/settings';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { computeSummary, lafmaliyetZ } from '../services/days';

/**
 * LafPOS → lafmaliyet. Gün sonu giden kutusundan imzalı `POST /api/pos/gun` ile gider (lafmaliyet'te canlı); maliyet
 * `GET /api/panel/pos/urunler`'den günde bir gelir. Elle yedek: Satışlar ekranına yüklenen "Ürün;Adet;Tutar" listesi
 * ve Kasa raporu alanları. Bağlantı `.env`'de LAFMALIYET_URL ve LAFMALIYET_SYNC_SECRET yokken kapalı; kurulum
 * modunda kapanan gün (eğitim günü) hiç gönderilmez. docs/03-ENTEGRASYON.md §3-4
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
export type AddonKey = 'extraShot' | 'syrup' | 'milk';

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
export function addonSiteIds(): Record<AddonKey, string | null> {
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

/**
 * Kalemin eklerinin reçete maliyeti (KDV hariç, kuruş; Raporlar › Ürünler ve patron panelinin brüt kârı). Gün sonunun
 * kuralıyla: ekler `addonsOf`, kimlik `addonSiteIds`, maliyet ekin M birim maliyeti × kalem adedi × ek adedi. Maliyeti
 * bilinmeyen ek 0 sayılır, `partial` işaretlenir (lafmaliyet reçetesiz ürüne 0 gönderir, LafPOS saklamaz)
 */
export function addonCostOf(i: { options: SelectedOption[]; qty: number }, costs: Record<string, number>, ids: Record<AddonKey, string | null>): { cost: number; partial: boolean } {
  let cost = 0;
  let partial = false;
  for (const op of addonsOf(i.options)) {
    const id = ids[op.key];
    const unit = id ? costs[`${id}:M`] : undefined;
    if (unit == null) partial = true;
    else cost += unit * i.qty * op.qty;
  }
  return { cost, partial };
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
  const posName = soldPosName(i.posName, i.name, size, getSettings().posSizeSuffix);
  // Platform ücreti hizmettir (mal maliyeti yok, KDV hizmet oranıyla); ürünün işareti oda sayacı için bilerek kapalı
  const isService = i.isService || posNameKey(posName) === posNameKey(PLATFORM_FEE_POS_NAME);
  return [
    { posName, siteMenuId: i.extProductId, slot: posSlotOf(i.extProductId, size), qty: i.qty, value: shares[0] ?? value, isService },
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
  // Pavo banka gün sonu ve LafPOS kıyası (gün kapandıktan sonra gelir; gelince gün yeniden gönderilir, okc/service.ts
  // saveEod). Pavo yoksa ya da henüz denenmediyse alan gitmez; eski panel bilmediği alanı yok sayar
  const eod = getSyncState<{
    status: string;
    batchNo: string | null;
    at: number;
    grandTotalKurus: number | null;
    dayCardKurus: number | null;
    message: string | null;
    acquirers: { name: string; count: number | null; totalKurus: number | null }[];
  }>(`pavo.eod.${day.id}`);
  const bankPos =
    eod && eod.status !== 'skipped'
      ? {
          status: eod.status,
          batchNo: eod.batchNo,
          at: new Date(eod.at).toISOString(),
          pavoCard: eod.grandTotalKurus != null ? toTL(eod.grandTotalKurus) : null,
          lafposCard: eod.dayCardKurus != null ? toTL(eod.dayCardKurus) : null,
          diff: eod.grandTotalKurus != null && eod.dayCardKurus != null ? toTL(eod.grandTotalKurus - eod.dayCardKurus) : null,
          acquirers: eod.acquirers.map((a) => ({ name: a.name, count: a.count, total: a.totalKurus != null ? toTL(a.totalKurus) : null })),
          message: eod.message,
        }
      : null;
  return {
    version: 1,
    source: 'lafpos',
    ...(bankPos ? { bankPos } : {}),
    // Kasanın şubesi (lafmaliyet docs/SUBE.md): panel günü bu şubeye yazar. Eski panel alanı yok sayar ve günü
    // Tuzla'ya yazar (geri uyumlu, docs/03-ENTEGRASYON.md §4)
    sube: getSettings().branchId,
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

export const TRAINING_MESSAGE =
  "Kurulum modunda lafmaliyet'e gün gönderilmez: örnek PIN'ler açık (Yönetim › Ayarlar › Kurulum modu) ya da yazarkasa eğitim simülatöründe (Yönetim › Yazarkasa POS)";

/**
 * lafmaliyet'e yalnız kurulum modu dışında kapanan gün gider. Kurulum modunda kapanan gün (eğitim günü) kurulum modu
 * sonradan kapansa da gitmez: ne gün sonunda, ne yeniden sayımda, ne "Gönder"le, ne geçmiş günlerle. İşaretten önce
 * kapanan gün (`null`) de gitmez: LafPOS o zaman canlıda değildi. docs/03-ENTEGRASYON.md §4.3
 */
export const realDay = (d: { trainingDay: boolean | null }) => d.trainingDay === false;

function trainingDayMessage(d: { trainingDay: boolean | null }) {
  return d.trainingDay
    ? "Bu gün kurulum modunda kapandı (eğitim günü); lafmaliyet'e gönderilmez. Satışlar elle aktarılır (Raporlar › lafmaliyet aktarımı)"
    : "Bu gün eğitim günü işareti tutulmadan önce kapandı (LafPOS o zaman canlıda değildi); lafmaliyet'e gönderilmez";
}

const notConfigured = () => conflict('lafmaliyet bağlantısı tanımlı değil (LAFMALIYET_URL, LAFMALIYET_SYNC_SECRET)', 'not_configured');

/**
 * Günün paketini giden kutusuna koyar (aynı günün bekleyen paketi varsa yerine geçer). Bağlantı yoksa, kurulum
 * modundaysa ya da gün eğitim günüyse hiçbir şey yapmaz ve `null` döner; koyunca günün anahtarını (`gun:<tarih>`).
 */
export function enqueueDay(dayId: string): string | null {
  if (!configured() || trainingDayNow()) return null;
  const day = db.select({ trainingDay: schema.businessDays.trainingDay }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (day && !realDay(day)) return null;
  const payload = buildDayPayload(dayId);
  const key = `gun:${payload.date}`;
  const now = Date.now();
  tx((t) => {
    t.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, key), isNull(schema.outbox.sentAt))).run();
    t.insert(schema.outbox).values({ target: 'lafmaliyet', kind: 'pos.gun', dedupeKey: key, payload, createdAt: now, nextAttemptAt: now }).run();
  });
  return key;
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

/**
 * lafmaliyet'in gün sonu 200 yanıtından okunan alanlar (docs/03-ENTEGRASYON.md §4.2). Eski lafmaliyet bunları
 * göndermez: gelmeyen ya da bozuk alan yazılmaz (`switchDay` yoksa geçiş günü bilinmiyor, `null`sa seçilmedi).
 */
export interface DayAnswer {
  /** Gönderilen iş günü */
  date: string;
  /** Yanıtın geldiği an */
  at: number;
  lines?: number;
  /** Ürüne ya da hizmete bağlanan satır sayısı */
  matched?: number;
  /** lafmaliyet'te ürüne bağlanamayan POS adları (en çok 50) */
  unmatched?: string[];
  /** lafmaliyet bu günü hesaplara sayıyor mu (gün geçiş gününden önce değilse true) */
  counted?: boolean;
  /** lafmaliyet'teki "LafPOS'a geçiş günü"; null: seçilmedi, kasa ModPOS */
  switchDay?: string | null;
}

const count = z.number().int().min(0).optional().catch(undefined);
const answerShape = z.object({
  lines: count,
  matched: count,
  unmatched: z
    .array(z.string())
    .transform((a) => a.slice(0, 50).map((n) => n.slice(0, 120)))
    .optional()
    .catch(undefined),
  counted: z.boolean().optional().catch(undefined),
  switchDay: z.string().refine(isCalendarDate).nullable().optional().catch(undefined),
});

export function readDayAnswer(json: unknown, date: string, at = Date.now()): DayAnswer {
  const parsed = answerShape.safeParse(json && typeof json === 'object' ? json : {});
  const out: DayAnswer = { date, at };
  if (parsed.success) for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) Object.assign(out, { [k]: v });
  return out;
}

/** Hata gövdesinin kısa hâli: "(z_conflict)", "(invalid: lines.3.qty)" */
function errorDetail(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const j = json as { error?: unknown; field?: unknown };
  const parts = [j.error, j.field].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length ? ` (${parts.join(': ')})` : '';
}

/** Kalıcı ret: veri hatalı, çok büyük ya da o tarihte başka Z (z_conflict); kendiliğinden yeniden denenmez */
const PERMANENT = new Set([400, 409, 413, 422]);
/** Kalıcı retteki kaydın bekleme süresi: kendiliğinden yeniden denenmez (elle "Gönder" yerine geçer) */
const PARKED_MS = 365 * 86400_000;
const RESEND = 'Kasa › Geçmiş günler › Z › Gönder';

/** HTTP hatasının kısa açıklaması (gün sonu ve maliyet ortak): 401 ve 503'te neden ve ne yapılacağı */
function httpErrorText(status: number, json: unknown): string {
  const detail = errorDetail(json);
  if (status === 401) return `HTTP 401${detail}: imza kabul edilmedi. LafPOS'taki LAFMALIYET_SYNC_SECRET paneldeki LAFPOS_SYNC_SECRET'la aynı mı, kasa bilgisayarının saati doğru mu (±5 dk)?`;
  if (status === 503) return `HTTP 503${detail}: lafmaliyet'te LAFPOS_SYNC_SECRET tanımlı değil, bağlantı panelde kapalı`;
  return `HTTP ${status}${detail}`;
}

/**
 * Gün sonu yanıtına göre kullanıcıya gösterilen hata (giden kutusunun `lastError`'u; Entegrasyon ve Genel bakış da
 * gösterir): neden ve ne yapılacağı. Kalıcı retler kendiliğinden yeniden denenmez, bunu söyler
 */
export function pushErrorText(status: number, json: unknown, payload: unknown): string {
  const detail = errorDetail(json);
  if (status === 409 && (json as { error?: unknown } | null)?.error === 'wrong_branch') {
    const b = json as { sube?: unknown; expected?: unknown };
    return `lafmaliyet bu kasanın gün sonunu almıyor: kasa "${String(b.sube)}" şubesine ayarlı, LafPOS'un şubesi "${String(b.expected)}". Yönetim › Ayarlar ve yedek › Şube'yi düzeltip ${RESEND} ile yeniden gönderin`;
  }
  if (status === 409) {
    const body = (json && typeof json === 'object' ? json : {}) as { zNo?: unknown };
    const sent = (payload as { z?: { zNo?: unknown } } | null)?.z?.zNo;
    const known = typeof body.zNo === 'number' ? `lafmaliyet'te bu güne Z ${body.zNo} kayıtlı, gönderilen Z ${typeof sent === 'number' ? sent : '?'}. ` : '';
    return `lafmaliyet reddetti: HTTP 409${detail}. ${known}Kendiliğinden yeniden denenmez: lafmaliyet Ayarlar › LafPOS (kasa)'da günün kaydı silinince ${RESEND} ile yeniden gönderin`;
  }
  if (PERMANENT.has(status)) return `lafmaliyet reddetti: HTTP ${status}${detail}. Kendiliğinden yeniden denenmez; düzeltilince ${RESEND} ile yeniden gönderin`;
  return httpErrorText(status, json);
}

interface PushState {
  lastRunAt?: number;
  /** En son başarılı gönderim (Genel bakış › Sistem sağlığı) */
  lastSuccessAt?: number;
  sent?: number;
  failed?: number;
  /** En son gönderilen günün yanıtı */
  lastAnswer?: DayAnswer;
}

const dateOf = (payload: unknown) => {
  const d = (payload as { date?: unknown } | null)?.date;
  return typeof d === 'string' ? d : '';
};

async function sendDue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let lastAnswer: DayAnswer | null = null;
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
      // 400/413/422 kalıcıdır (veri hatalı ya da büyük), 409 aynı tarihte başka Z (z_conflict): tekrar denenmez,
      // elle düzeltilip yeniden gönderilir (Kasa › Geçmiş günler › Z › Gönder)
      if (PERMANENT.has(status)) {
        db.update(schema.outbox)
          .set({ attempts: row.attempts + 1, lastError: pushErrorText(status, json, row.payload), nextAttemptAt: Date.now() + PARKED_MS })
          .where(eq(schema.outbox.id, row.id))
          .run();
        failed++;
        continue;
      }
      if (status !== 200) throw new Error(pushErrorText(status, json, row.payload));
      const date = dateOf(row.payload);
      const answer = readDayAnswer(json, date);
      const now = Date.now();
      tx((t) => {
        t.update(schema.outbox).set({ sentAt: now, lastError: null, attempts: row.attempts + 1, response: { ...answer } }).where(eq(schema.outbox.id, row.id)).run();
        // Gün gönderildi: paket günün son kapanışından sonra hazırlandıysa (arada yeniden açılmadıysa) işaretlenir.
        // "Geçmiş günleri gönder" bu işareti olmayan kapanmış günleri sayar
        t.update(schema.businessDays)
          .set({ exportedAt: now })
          .where(and(eq(schema.businessDays.date, date), isNotNull(schema.businessDays.closedAt), lte(schema.businessDays.closedAt, row.createdAt)))
          .run();
      });
      lastAnswer = answer;
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
  if (sent || failed) {
    const prev = getSyncState<PushState>('lafmaliyet.push') ?? {};
    setSyncState('lafmaliyet.push', { ...prev, lastRunAt: Date.now(), sent, failed, ...(sent ? { lastSuccessAt: Date.now() } : {}), ...(lastAnswer ? { lastAnswer } : {}) } satisfies PushState);
    bus.publish({ topic: 'sync', kind: 'lafmaliyet.push' });
  }
  return { sent, failed };
}

/** Günün giden kutusundaki en yeni kaydı */
function dayRow(key: string) {
  return db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.dedupeKey, key)))
    .orderBy(desc(schema.outbox.id))
    .get();
}

/**
 * Kasa › Geçmiş günler › Z › "Gönder": günü kuyruğa koyup gönderir. Sonuç bu günün kendi kaydından okunur: o
 * gönderilmediyse 502 (aynı turda başka bir günün gitmesi başarı sayılmaz). Kuyrukta önünde bekleyen günler varsa
 * (geçmiş günler, turda en çok 20) sırası gelene kadar gönderim sürer.
 */
export async function pushDayNow(dayId: string) {
  if (!configured()) throw notConfigured();
  if (trainingDayNow()) throw conflict(TRAINING_MESSAGE, 'training_mode');
  const day = db.select({ trainingDay: schema.businessDays.trainingDay }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (!day) throw notFound('Gün');
  if (!realDay(day)) throw conflict(trainingDayMessage(day), 'training_day');
  const key = enqueueDay(dayId);
  if (!key) throw notConfigured();
  const total = { sent: 0, failed: 0 };
  let row = dayRow(key);
  for (let round = 0; round < 20 && row && !row.sentAt && row.attempts === 0; round++) {
    const r = await flushOutbox();
    total.sent += r.sent;
    total.failed += r.failed;
    row = dayRow(key);
    if (!r.sent && !r.failed) break;
  }
  if (!row?.sentAt) {
    // Kalıcı ret (400/409/413/422) yeniden denenmez: metni zaten ne yapılacağını söyler
    const parked = !!row && row.nextAttemptAt - Date.now() > 86400_000;
    throw new HttpError(502, `lafmaliyet'e gönderilemedi: ${row?.lastError ?? 'sırası gelmedi'}${parked ? '' : '. Giden kutusunda bekliyor, sonra tekrar denenecek'}`, 'lafmaliyet_push');
  }
  return { ...total, answer: (row.response as DayAnswer | null) ?? null };
}

/** Son gönderilen günün yanıtı (geçiş günü ve sayılıp sayılmadığı) */
export function lastDayAnswer(): DayAnswer | null {
  return getSyncState<PushState>('lafmaliyet.push')?.lastAnswer ?? null;
}

/** lafmaliyet'in geçiş günü: son yanıtta yoksa (eski lafmaliyet ya da hiç gönderilmedi) `undefined` */
export function knownSwitchDay(): string | null | undefined {
  const a = lastDayAnswer();
  return a && 'switchDay' in a ? (a.switchDay ?? null) : undefined;
}

/** "Geçmiş günleri gönder"in varsayılan aralığı: lafmaliyet'in geçiş gününden düne */
export function backfillDefaults(now = Date.now()) {
  return { from: knownSwitchDay() ?? null, to: addDays(businessDate(now), -1) };
}

/** Aralıktaki, gün sonu alınmış ve lafmaliyet'e henüz gitmemiş (200 almamış) günler, tarih sırasıyla; eğitim günleri
 * (kurulum modunda ya da işaretten önce kapanan) ayrı sayılır, hiç gitmez */
function closedUnexported(from: string, to: string) {
  return db
    .select({ id: schema.businessDays.id, date: schema.businessDays.date, trainingDay: schema.businessDays.trainingDay })
    .from(schema.businessDays)
    .where(and(gte(schema.businessDays.date, from), lte(schema.businessDays.date, to), isNotNull(schema.businessDays.closedAt), isNull(schema.businessDays.exportedAt)))
    .orderBy(asc(schema.businessDays.date))
    .all();
}

export function unsentClosedDays(from: string, to: string) {
  return closedUnexported(from, to).filter(realDay);
}

/** En uzun geçmiş gün aralığı (raporların dönem sınırıyla aynı) */
export const BACKFILL_MAX_DAYS = 400;

/**
 * Yönetim › Entegrasyon › "Geçmiş günleri gönder": bağlantı sonradan kurulduysa ya da günler gidemediyse aralıktaki
 * gönderilmemiş kapanmış günleri kuyruğa koyar (gün başına tek kayıt; bekleyen kaydın yerine geçer) ve gönderimi
 * başlatır. Daha önce 200 almış gün yeniden gitmez: tek günü yeniden göndermek Kasa › Geçmiş günler › Z › Gönder.
 */
export function backfillDays(input: { from: string; to: string }, actor: { id: string | null; name: string }) {
  if (!configured()) throw notConfigured();
  if (trainingDayNow()) throw conflict(TRAINING_MESSAGE, 'training_mode');
  const today = businessDate(Date.now());
  if (input.from > input.to) throw new HttpError(422, 'Başlangıç günü bitiş gününden sonra olamaz', 'range');
  if (input.to > today) throw new HttpError(422, 'Bitiş günü bugünden sonra olamaz', 'range');
  if (input.from < addDays(input.to, -(BACKFILL_MAX_DAYS - 1))) throw new HttpError(422, `En çok ${BACKFILL_MAX_DAYS} gün seçilebilir; daha kısa bir aralık seçin`, 'range_too_long');
  const fx = new Effects();
  const all = closedUnexported(input.from, input.to);
  const training = all.length - all.filter(realDay).length;
  const queued = tx((t) => {
    const days = all.filter(realDay);
    if (!days.length) return [];
    for (const d of days) enqueueDay(d.id);
    fx.audit(t, {
      userId: actor.id,
      action: 'sync.lafmaliyet_backfill',
      message: `lafmaliyet'e geçmiş günler kuyruğa alındı: ${days.length} gün (${input.from} ile ${input.to} arası)`,
      data: { from: input.from, to: input.to, days: days.map((d) => d.date) },
    });
    fx.emit({ topic: 'sync', kind: 'lafmaliyet.backfill' });
    return days.map((d) => d.date);
  });
  fx.flush();
  if (queued.length) void flushOutbox();
  // Aralıktaki eğitim günleri sayılır, gönderilmez (ekran söyler)
  return { queued: queued.length, days: queued, training };
}

// ─── Maliyet (lafmaliyet → LafPOS) ──────────────────────────────────────────

/** `GET /api/panel/pos/urunler` gövdesi (docs/03-ENTEGRASYON.md §4.1); bozuksa önceki maliyetler kalır */
const costsBody = z.object({
  version: z.literal(1),
  items: z
    .array(z.object({ siteMenuId: z.string().min(1).max(64), slot: z.enum(['M', 'L']), costMinor: z.number().finite().min(0) }))
    .max(10_000),
});

interface CostsState {
  /** Son başarılı çekim */
  at: number;
  /** `<siteMenuId>:<M|L>` → birim maliyet (kuruş, KDV hariç); 0 gelen (reçetesiz) yazılmaz: bilinmiyor */
  map: Record<string, number>;
  lastError?: string | null;
  lastErrorAt?: number | null;
}

const costsState = () => getSyncState<CostsState>('lafmaliyet.costs');

function costsFailed(message: string): never {
  const prev = costsState();
  setSyncState('lafmaliyet.costs', { at: prev?.at ?? 0, map: prev?.map ?? {}, lastError: message, lastErrorAt: Date.now() } satisfies CostsState);
  throw new HttpError(502, message, 'lafmaliyet_costs');
}

/**
 * lafmaliyet'ten boy bazında birim maliyet (kuruş, KDV hariç). Yalnız maliyet yetkisi olanlara gösterilir. 0 =
 * bilinmiyor (reçetesiz ürün): saklanmaz, kâr "maliyet yok" görünür. Haritada olmayan site ürününün maliyeti
 * boşalır (eski rakam kalmasın). Gövde okunamazsa önceki maliyetler olduğu gibi kalır, hata Entegrasyon'da görünür.
 */
export async function pullCosts() {
  if (!configured()) throw conflict('lafmaliyet bağlantısı tanımlı değil', 'not_configured');
  let res: { status: number; json: unknown };
  try {
    res = await signedFetch(env.lafmaliyetToken, 'GET', new URL(`${env.lafmaliyetUrl}/api/panel/pos/urunler`));
  } catch (e) {
    costsFailed(`Maliyetler alınamadı: lafmaliyet'e ulaşılamadı (${e instanceof Error ? e.message : e})`);
  }
  if (res.status !== 200) costsFailed(`Maliyetler alınamadı (${httpErrorText(res.status, res.json)})`);
  const parsed = costsBody.safeParse(res.json);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'gövde';
    costsFailed(`Maliyetler okunamadı: lafmaliyet'in yanıtı beklenen biçimde değil (${where}); önceki maliyetler kaldı`);
  }
  const map: Record<string, number> = {};
  for (const i of parsed.data.items) if (i.costMinor > 0) map[`${i.siteMenuId}:${i.slot}`] = Math.round(i.costMinor);
  tx((t) => {
    setSyncState('lafmaliyet.costs', { at: Date.now(), map, lastError: null, lastErrorAt: null } satisfies CostsState);
    // Tek boy ve M maliyeti ürünün kendi alanına da yazılır (menü ekranında gösterim için); `products.cost` önbellektir
    const products = t.select({ id: schema.products.id, extId: schema.products.extId, cost: schema.products.cost }).from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
    for (const p of products) {
      const cost = map[`${p.extId}:M`] ?? null;
      if (cost !== p.cost) t.update(schema.products).set({ cost }).where(eq(schema.products.id, p.id)).run();
    }
  });
  bus.publish({ topic: 'menu', kind: 'costs.pulled' });
  return { count: parsed.data.items.length, known: Object.keys(map).length };
}

/**
 * Gün sonunda: maliyetler bu iş gününde (05:00 kuralı) çekilmediyse bir kez çekilir; her gün sonu yeniler, kapanış
 * saati bir öncekinden erken olsa da. Hata gün sonunu bozmaz, Entegrasyon'da görünür; sonraki gün sonu yeniden dener
 */
export async function pullCostsIfStale(now = Date.now()): Promise<boolean> {
  if (!configured()) return false;
  const at = costsState()?.at;
  if (at && businessDate(at) >= businessDate(now)) return false;
  try {
    await pullCosts();
    return true;
  } catch (e) {
    console.warn('[lafmaliyet] maliyetler alınamadı:', e instanceof Error ? e.message : e);
    return false;
  }
}

/** Gün sonu alınınca (kasadan ya da otomatik): gün lafmaliyet'e gider, maliyetler günde bir yenilenir */
export function afterDayClosed(dayId: string) {
  if (enqueueDay(dayId)) void flushOutbox();
  void pullCostsIfStale();
}

export function costMap(): Record<string, number> {
  return costsState()?.map ?? {};
}

/** Maliyetlerin son başarılı çekimi (yoksa null); yalnız maliyet yetkisi olanlara gider */
export function costsAt(): number | null {
  return costsState()?.at || null;
}

/**
 * Entegrasyon ve Genel bakış durumu. Maliyetin tarihi ve hatası yalnız maliyet yetkisine (`withCost`): personel
 * maliyetin varlığını da görmez (Raporlar ve patron paneliyle aynı kapı)
 */
export function lafmaliyetStatus(withCost = false) {
  const pending = db
    .select({ id: schema.outbox.id, lastError: schema.outbox.lastError, attempts: schema.outbox.attempts, dedupeKey: schema.outbox.dedupeKey })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), isNull(schema.outbox.sentAt)))
    .all();
  const push = getSyncState<PushState>('lafmaliyet.push');
  const costs = costsState();
  const range = backfillDefaults();
  return {
    configured: configured(),
    url: env.lafmaliyetUrl || null,
    training: trainingMode(),
    pending: pending.length,
    /** Denenip gidemeyenler (hata ya da kalıcı ret); yeni kuyruğa girip sırasını bekleyen gün hata değildir */
    failing: pending.filter((p) => p.attempts > 0 || p.lastError).length,
    pendingDays: pending.map((p) => p.dedupeKey),
    lastError: pending.find((p) => p.lastError)?.lastError ?? null,
    push: push ? { lastRunAt: push.lastRunAt, lastSuccessAt: push.lastSuccessAt, sent: push.sent, failed: push.failed } : null,
    answer: push?.lastAnswer ?? null,
    backfill: { ...range, unsent: range.from && range.from <= range.to ? unsentClosedDays(range.from, range.to).length : null },
    ...(withCost ? { costsAt: costs?.at || null, costsError: costs?.lastError ? { message: costs.lastError, at: costs.lastErrorAt ?? null } : null } : {}),
  };
}
