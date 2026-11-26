import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { cleanRecipientName } from '@shared/teslim';
import { compReasonText } from '@shared/comp';
import { allocate, splitKdv } from '@shared/money';
import { calcOrder, offDeviceTotals } from '@shared/order-calc';
import { PLATFORM_FEE_POS_NAME, posNameKey, posSlotOf, soldPosName } from '@shared/pos-name';
import { addDays, businessDate, fmtDateShort, isCalendarDate } from '@shared/time';
import type { SelectedOption } from '@shared/types';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { money, toCsv } from '../lib/csv';
import { Effects } from '../lib/effects';
import { bus } from '../lib/events';
import { conflict, HttpError, notFound } from '../lib/http';
import { getSettings, getSyncState, setSyncState, trainingDayNow, trainingMode } from '../lib/settings';
import { isNetworkError } from '../lib/internet';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { basketByRate } from '../okc/basket';
import { batchesOf, cardBasis } from '../okc/card-basis';
import type { PavoEodRecord } from '../okc/service';
import type { TokenxBasket } from '../okc/tokenx';
import { closedToday, computeSummary, deviceReceipts, lafmaliyetZ, shiftCountsOf, workedUserIdsOf } from '../services/days';
import { dayPushPending, type DevirState, kurusOf, lastClosedRealDay } from '../services/devir';
import { getOpenDay, REFUND_REWRITE, REFUND_VOID } from '../services/orders';
import { notify } from './bildirim';
import { dropPending, land, takeOff } from './outbox-flight';

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
  /** kuruş: satırın liste değeri, indirim öncesi (mutlu saat birim fiyata işlenmiş); servis satırında servis ücreti */
  gross: number;
  isService: boolean;
  /** Birleşen satırda ek parçası var (EXTRA SHOT, SYRUP, ALTERNATIF SÜT: içeceğin seçeneğinden gelen) */
  isAddon: boolean;
  /**
   * Satılan parçaların dondurulan liste birim fiyatları (kuruş) → adet: ana parçada kalemin `basePrice`'ı (boyun liste
   * fiyatı, seçenek, indirim ve mutlu saat öncesi), ekte seçeneğin fiyatı. Fiyatın değiştiği günde birleşen satır iki
   * fiyat taşır (şube fiyatı; gövdede `lines[].listPrices`). Hizmet satırında boş
   */
  listPrices: Map<number, number>;
}

type ItemRow = typeof schema.orderItems.$inferSelect;
export type AddonKey = 'extraShot' | 'syrup' | 'milk';

/** Seçenek eklerinin lafmaliyet'teki ürün adları (ModPOS'taki adlarla aynı) */
const ADDON_NAMES: Record<AddonKey, string> = { extraShot: 'EXTRA SHOT', syrup: 'SYRUP', milk: 'ALTERNATIF SÜT' };
/** Masa servis ücreti: ürün değil, lafmaliyet'te HİZMET satırı (satırların toplamı Z toplamını tutsun) */
export const SERVICE_POS_NAME = 'SERVİS ÜCRETİ';
/** Eklerin sitedeki sabit kalemleri (laffogato menüsü, `extras` kategorisi; server/db/menu-snapshot.json) */
const ADDON_SITE_IDS: Record<AddonKey, string> = { syrup: 'mnu-0080', extraShot: 'mnu-0081', milk: 'mnu-0082' };

/**
 * Kasanın kendi yazdığı lafmaliyet satırının adı mı (servis ücreti, platform ücreti, ekler): başka ürüne verilirse o
 * ürünün satışı bu satıra karışır (platform ücreti adı hizmet de sayılır). Ek adı yalnız ekin site kalemine, platform
 * ücreti yalnız kendi gizli ürününe uyar (`siteId`, `feeProduct`); null: ad serbest
 */
export function reservedPosName(name: string): { siteId: string | null; feeProduct: boolean } | null {
  const key = posNameKey(name);
  if (key === posNameKey(SERVICE_POS_NAME)) return { siteId: null, feeProduct: false };
  if (key === posNameKey(PLATFORM_FEE_POS_NAME)) return { siteId: null, feeProduct: true };
  const addon = (Object.keys(ADDON_NAMES) as AddonKey[]).find((k) => posNameKey(ADDON_NAMES[k]) === key);
  return addon ? { siteId: ADDON_SITE_IDS[addon], feeProduct: false } : null;
}
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
  /** Ekin parçası (kalemin seçeneğinden ayrılan EXTRA SHOT, SYRUP, ALTERNATIF SÜT) */
  isAddon: boolean;
  /**
   * Parçanın dondurulan liste birim fiyatı (kuruş): ana parçada `basePrice`, ekte seçeneğin fiyatı. Hizmette (servis
   * ücreti, platform ücreti, karaoke odası: menü fiyatı değil, süreden ya da orandan hesaplanır) null
   */
  listPrice: number | null;
}

/** Kalemin değerini ana ürün ve ekleri arasında liste fiyatları oranında böler (satışta ve ikramda aynı oran) */
function itemParts(i: Pick<ItemRow, 'options' | 'unitPrice' | 'basePrice' | 'size' | 'posName' | 'name' | 'isService' | 'extProductId' | 'qty'>, value: number, addonIds: Record<AddonKey, string | null>): Part[] {
  const addons = addonsOf(i.options);
  const weights = [i.unitPrice - addons.reduce((a, op) => a + op.price * op.qty, 0), ...addons.map((op) => op.price * op.qty)];
  const shares = allocate(value, weights);
  const size = i.size === 'L' ? 'L' : i.size === 'M' ? 'M' : 'TEK';
  const posName = soldPosName(i.posName, i.name, size, getSettings().posSizeSuffix);
  // Platform ücreti hizmettir (mal maliyeti yok, KDV hizmet oranıyla); ürünün işareti oda sayacı için bilerek kapalı
  const isService = i.isService || posNameKey(posName) === posNameKey(PLATFORM_FEE_POS_NAME);
  return [
    { posName, siteMenuId: i.extProductId, slot: posSlotOf(i.extProductId, size), qty: i.qty, value: shares[0] ?? value, isService, isAddon: false, listPrice: isService ? null : i.basePrice },
    ...addons.map((op, k) => ({
      posName: ADDON_NAMES[op.key],
      siteMenuId: addonIds[op.key],
      slot: addonIds[op.key] ? ('M' as const) : null,
      qty: i.qty * op.qty,
      value: shares[k + 1] ?? 0,
      isService: false,
      isAddon: true,
      listPrice: op.price,
    })),
  ];
}

const partKey = (p: Pick<Part, 'posName' | 'siteMenuId' | 'slot'>) => `${posNameKey(p.posName)}|${p.siteMenuId ?? ''}|${p.slot ?? ''}`;

/**
 * Satırları `posName|siteMenuId|slot` anahtarıyla toplar ve günde bir ada bir satır kuralını (lafmaliyet
 * `parsePosDay`) sağlar: aynı ad iki farklı kaleme / boya düşerse ikinciye boy eki, yine çakışırsa site kimliği
 * eklenir. Siteye bağlı satır kalemiyle eşleştiği için ad yalnız bağsız üründe önemlidir; bağsız satır adını korur.
 */
function mergeParts(parts: (Part & { gross: number })[]): { lines: SaleLine[]; names: Map<string, string> } {
  const groups = new Map<string, SaleLine>();
  for (const p of parts) {
    const k = partKey(p);
    const cur = groups.get(k);
    const line = cur ?? { posName: p.posName, siteMenuId: p.siteMenuId, slot: p.slot, qty: 0, revenue: 0, gross: 0, isService: p.isService, isAddon: false, listPrices: new Map<number, number>() };
    if (!cur) groups.set(k, line);
    line.qty += p.qty;
    line.revenue += p.value;
    line.gross += p.gross;
    line.isAddon ||= p.isAddon;
    if (p.listPrice != null && Number.isInteger(p.listPrice) && p.listPrice >= 0) line.listPrices.set(p.listPrice, (line.listPrices.get(p.listPrice) ?? 0) + p.qty);
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
  const parts: (Part & { gross: number })[] = [];
  for (const i of items) {
    if (i.voided || i.complimentary) continue;
    // Liste değeri aynı oranla bölünür (indirim öncesi): satırın liste − ciro farkı indirim payıdır
    const gross = itemParts(i, i.qty * i.unitPrice, addonIds);
    parts.push(...itemParts(i, totals.get(i.orderId)?.lineNet[i.id] ?? 0, addonIds).map((p, k) => ({ ...p, gross: gross[k]?.value ?? 0 })));
  }
  // Servis ücreti ayrı hizmet satırı, adedi servis ücretli adisyon sayısı
  for (const t of totals.values()) {
    if (t.service > 0) parts.push({ posName: SERVICE_POS_NAME, siteMenuId: null, slot: null, qty: 1, value: t.service, gross: t.service, isService: true, isAddon: false, listPrice: null });
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

/** Gövdedeki serbest metin (neden) en çok 200 karakter (docs/03-ENTEGRASYON.md §4) */
const cap = (text: string | null | undefined) => (text == null ? null : text.slice(0, 200));
/** `refunds[]` ve `iptal[]` en çok bu kadar satır (gövde büyümesin; lafmaliyet de aynı sınırla okur) */
const LIST_MAX = 2000;
/** `lines[].listPrices` en çok bu kadar fiyat (docs/03-ENTEGRASYON.md §4) */
const LIST_PRICES_MAX = 20;

/**
 * Satırın dondurulan liste fiyatları gövdede (`lines[].listPrices`, şube fiyatı): `[{ price: TL, qty }]`, fiyat sırasıyla.
 * 20'den çok fiyat varsa en çok satılan 20'si (eşitlikte ucuzu) kalır; fiyatsız satırda (hizmet: servis, platform ücreti,
 * oda) alan yok. Ad, kişi yok
 */
function listPricesOf(prices: Map<number, number>): { listPrices?: { price: number; qty: number }[] } {
  if (!prices.size) return {};
  const kept = [...prices.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, LIST_PRICES_MAX);
  return { listPrices: kept.sort((a, b) => a[0] - b[0]).map(([price, qty]) => ({ price: toTL(price), qty })) };
}

/** İkram türü: eski kayıtta boş = ikram */
const compKindOf = (k: string | null): 'ikram' | 'odenmez' | 'zayi' => (k === 'odenmez' || k === 'zayi' ? k : 'ikram');

/**
 * Ödenmezin kişi türü (kişinin kendisi, adı ve kimliği gitmez; KVKK): kayıtlı müşteri `musteri`, personelden patron rolü
 * `patron`, öteki personel `personel`. Kişisiz ödenmez ve ikram, zayi null
 */
function personKindOf(i: Pick<ItemRow, 'compKind' | 'compPersonKind' | 'compPersonId'>, roles: Map<string, string>): 'personel' | 'musteri' | 'patron' | null {
  if (i.compKind !== 'odenmez' || !i.compPersonKind) return null;
  if (i.compPersonKind === 'customer') return 'musteri';
  return i.compPersonId && roles.get(i.compPersonId) === 'patron' ? 'patron' : 'personel';
}

/** Bu günün (aynı tarih) lafmaliyet'ten 200 almış gövdeleri */
const sentDayRows = (date: string) =>
  db
    .select({ createdAt: schema.outbox.createdAt })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.dedupeKey, `gun:${date}`), isNotNull(schema.outbox.sentAt)))
    .all();

/**
 * Gönderim sırası: bu günün lafmaliyet'ten 200 almış kayıt sayısı + 1. Tarihe ya da saate bağlı değil (altın gövde
 * sabit kalır). Gövde kurulurken önizleme için yazılır, gönderilirken yeniden (`sendDue`, gönderimler sırayla): yanıtı
 * beklenen gönderim sürerken kuyruğa giren gövde aynı sırayı almaz
 */
function revisionOf(date: string): number {
  return sentDayRows(date).length + 1;
}

type DayCorrectionState = Pick<typeof schema.businessDays.$inferSelect, 'date' | 'reopenedAt' | 'reopenReason' | 'recountReason' | 'recountedAt'>;

/**
 * Günün son düzeltmesi ve anı: kapandıktan sonra kaydedilmiş sayımı değiştirmek (`recount`) ya da günü yeniden açmak
 * (`reopen`). Yeniden açılış sayım düzeltmesini siler: ikisi de varsa sayım yeniden açılıştan sonradır
 */
function correctionOf(day: DayCorrectionState) {
  if (day.recountReason) return { kind: 'recount' as const, reason: cap(day.recountReason)!, at: day.recountedAt ?? 0 };
  if (day.reopenedAt != null) return { kind: 'reopen' as const, reason: cap(day.reopenReason) ?? '', at: day.reopenedAt };
  return null;
}

/**
 * `builtAt`'te kurulan gövdenin düzeltmesi. Düzeltme yalnız ondan sonra kurulan ve lafmaliyet'in kabul ettiği (200)
 * İLK gövdeyle gider: sonraki gönderim (Pavo'nun gün sonu sonucu, elle "Gönder", geçmiş günler) yeni sıradır ama düzeltme
 * değildir. Düzeltmeden önce kurulan gövde (yoldayken düzeltme geldi) onu taşımaz: verisi düzeltmeden öncedir
 */
function correctionFor(day: DayCorrectionState, builtAt: number): { kind: 'reopen' | 'recount'; reason: string } | null {
  const c = correctionOf(day);
  if (!c || builtAt < c.at) return null;
  // Düzeltmeden sonra kurulmuş bir gövde 200 aldıysa ulaştı (gönderimler sırayla: ilki onu taşıdı)
  const delivered = sentDayRows(day.date).some((r) => r.createdAt >= c.at);
  return delivered ? null : { kind: c.kind, reason: c.reason };
}

/**
 * Günün iadeleri (iptal edilen ödemeler): kalem iadesinde iptal edilip kalanı yeniden yazılan ödemenin yeniden yazılan
 * kısmı düşer, iade raporundaki gibi (reports.ts `refundReport`). Ad ödeme türünün adıdır, kişi değil
 */
function refundsOf(dayId: string) {
  const pays = db.select().from(schema.payments).where(eq(schema.payments.dayId, dayId)).orderBy(asc(schema.payments.createdAt), asc(schema.payments.id)).all();
  const channels = new Map(db.select({ id: schema.paymentMethods.id, channel: schema.paymentMethods.channel }).from(schema.paymentMethods).all().map((m) => [m.id, m.channel]));
  const rewritten = new Map<string, number>();
  for (const p of pays) if (p.note?.startsWith(REFUND_REWRITE)) rewritten.set(p.note.slice(REFUND_REWRITE.length), p.amount);
  return pays
    .filter((p) => p.refundedAt != null && p.amount - (rewritten.get(p.id) ?? 0) > 0)
    .sort((a, b) => a.refundedAt! - b.refundedAt! || a.id.localeCompare(b.id))
    .slice(0, LIST_MAX)
    .map((p) => ({ amount: toTL(p.amount - (rewritten.get(p.id) ?? 0)), zField: p.zField, name: p.methodName, channel: channels.get(p.methodId) ?? null, reason: cap(p.refundReason) }));
}

/**
 * Gün kapanınca Pavo'nun banka gün sonu bekleniyorsa ilk gövde en çok bu kadar tutulur (25 Kasım 2026): gün sonu bitince
 * (alındı, alınamadı ya da atlandı; okc/service.ts saveEod) gün sonucuyla hemen gider ve lafmaliyet tek e-posta gönderir.
 * Bitmezse tutulan gövde bu sürenin sonunda `bankPosPending: true` ile gider; lafmaliyet kısa bekler, e-postayı yine
 * gönderir. 24 Kasım'da gün sonu 58 sn sürdü; cihazın üst sınırı 30 + 180 sn (pavoTiming)
 */
export const EOD_FIRST_PUSH_HOLD_MS = 150_000;

/**
 * lafmaliyet'in gün sonu e-postası Pavo'yu beklesin mi (`bankPosPending`; docs/03-ENTEGRASYON.md §4.9): yalnız Pavo
 * seçiliyken gider. Kapanışta (`atClose`) otomatik gün sonu başlayacaksa true; sonra günün kaydına göre: sürüyorsa true,
 * bittiyse ya da atlandıysa (ya da hiç denenmediyse) false
 */
function bankPosPendingOf(dayId: string, atClose?: boolean): boolean | undefined {
  if (getSettings().okcProvider !== 'pavo') return undefined;
  const eod = getSyncState<Pick<PavoEodRecord, 'status'>>(`pavo.eod.${dayId}`);
  if (eod) return eod.status === 'running';
  return atClose === true;
}

/**
 * Sözleşme §4: bir iş gününün paketi (tutarlar TL). `eodAtClose`: gün şimdi kapandı ve Pavo'nun otomatik gün sonu
 * başlayacak (`bankPosPending` için; verilmezse günün kaydından)
 */
export function buildDayPayload(dayId: string, opts: { eodAtClose?: boolean } = {}) {
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
  // İptaller: günün bütün kasa adisyonlarından (kapanmış, açık, iptal edilmiş; Z'nin iptal toplamı gibi), online hariç
  const posIds = db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.source, 'pos')));
  const voids = db.select().from(schema.orderItems).where(and(inArray(schema.orderItems.orderId, posIds), eq(schema.orderItems.voided, true))).orderBy(asc(schema.orderItems.createdAt), asc(schema.orderItems.id)).all();
  const roles = new Map(db.select({ id: schema.users.id, role: schema.users.role }).from(schema.users).all().map((u) => [u.id, u.role as string]));
  const methods = methodsById();
  const compTotal = (kind: 'ikram' | 'odenmez' | 'zayi') => comps.filter((i) => compKindOf(i.compKind) === kind).reduce((a, i) => a + i.qty * i.unitPrice, 0);
  const ikramTotal = compTotal('ikram');
  const odenmezTotal = compTotal('odenmez');
  // Yazarkasadan geçmeyen: eski Z'de yok, ödemelerden yeniden hesaplanır (kural tek: shared/order-calc.ts)
  const offDevice =
    summary.offDevice ??
    offDeviceTotals(
      db.select().from(schema.payments).where(and(eq(schema.payments.dayId, day.id), isNull(schema.payments.refundedAt))).all(),
      deviceReceipts(db, [day.id]),
    );
  // Yazarkasanın (ÖKC) mali Z'si: günün en son tamamlanan cihaz fişinden; Pavo satış sonucunda Z yok (boş)
  const okc = db
    .select({ zNo: schema.fiscalReceipts.zNo })
    .from(schema.fiscalReceipts)
    .where(
      and(
        inArray(schema.fiscalReceipts.orderId, db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.dayId, day.id))),
        eq(schema.fiscalReceipts.status, 'tamamlandi'),
        isNotNull(schema.fiscalReceipts.zNo),
      ),
    )
    .orderBy(desc(schema.fiscalReceipts.completedAt), desc(schema.fiscalReceipts.id))
    .get();
  const correction = correctionFor(day, Date.now());
  // Banka POS'unun gördüğü ama Z'nin kart alanına girmeyen tutarlar (lafmaliyet kart farkını bunlarla açıklar)
  const cardPays = db
    .select({ orderId: schema.payments.orderId, amount: schema.payments.amount, tip: schema.payments.tip })
    .from(schema.payments)
    .where(and(eq(schema.payments.dayId, day.id), eq(schema.payments.zField, 'card'), isNull(schema.payments.refundedAt)))
    .all();
  // Pavo banka gün sonu ve LafPOS kıyası (gün kapandıktan sonra gelir; gelince gün yeniden gönderilir, okc/service.ts
  // saveEod). Pavo yoksa ya da henüz denenmediyse alan gitmez; eski panel bilmediği alanı yok sayar
  const eod = getSyncState<
    Pick<PavoEodRecord, 'status' | 'batchNo' | 'at' | 'grandTotalKurus' | 'dayCardKurus' | 'message' | 'acquirers'> &
      Partial<Pick<PavoEodRecord, 'errorCode' | 'deviceDateTime' | 'trigger' | 'dayClosed' | 'earlier'>>
  >(`pavo.eod.${day.id}`);
  // 'running' (cihazda gün sonu sürüyor) sözleşmede yok: lafmaliyet bilinmeyen durumu sessizce atardı. Gün sonu bitince
  // gün yeniden gönderilir
  const bankPos =
    eod && eod.status !== 'skipped' && eod.status !== 'running'
      ? {
          status: eod.status,
          batchNo: eod.batchNo,
          at: new Date(eod.at).toISOString(),
          pavoCard: eod.grandTotalKurus != null ? toTL(eod.grandTotalKurus) : null,
          lafposCard: eod.dayCardKurus != null ? toTL(eod.dayCardKurus) : null,
          diff: eod.grandTotalKurus != null && eod.dayCardKurus != null ? toTL(eod.grandTotalKurus - eod.dayCardKurus) : null,
          acquirers: eod.acquirers.map((a) => ({ name: a.name, count: a.count, total: a.totalKurus != null ? toTL(a.totalKurus) : null })),
          message: eod.message,
          // Cihazın hata kodu (alınamayan gün sonu, ör. 5085); alındıysa boş
          errorCode: eod.errorCode ?? null,
          // Günün bütün başarılı banka gün sonları (gün içinde elle alınan dahil), eskiden yeniye: yukarıdaki kıyas yalnız
          // son batch'indir, öncekinin tutarı yalnız burada (§4.9)
          batches: batchesOf({ deviceDateTime: null, trigger: 'otomatik', ...eod } as PavoEodRecord)
            .slice(-BATCH_MAX)
            .map((b) => ({
              batchNo: b.batchNo,
              at: new Date(b.at).toISOString(),
              total: b.grandTotalKurus != null ? toTL(b.grandTotalKurus) : null,
              trigger: b.trigger === 'elle' ? ('elle' as const) : ('otomatik' as const),
              dayClosed: b.dayClosed !== false,
            })),
          // LafPOS'ta günün bankaya giden bütün kartı (Z kartı + kart bahşişi + kartla tahsilat − yazarkasadan geçmeyen,
          // bahşişiyle − cihazda fişi iptal edilen); gün açıkken null
          dayCard: dayCardOf(day.id),
        }
      : null;
  return {
    version: 1,
    source: 'lafpos',
    // Bu günün kaçıncı gönderimi (lafmaliyet sürüm geçmişini tutar) ve varsa düzeltmenin türü ve nedeni
    revision: revisionOf(day.date),
    ...(correction ? { correction } : {}),
    ...(bankPos ? { bankPos } : {}),
    // Pavo'nun sonucu birazdan gelecek mi (Pavo seçiliyken, sonuç henüz gövdede yokken): lafmaliyet gün sonu e-postasını
    // yalnız true'da bekletir; sonuç gövdedeyse alan gitmez (beklenecek bir şey yok)
    ...(() => {
      const pending = bankPos ? undefined : bankPosPendingOf(day.id, opts.eodAtClose);
      return pending === undefined ? {} : { bankPosPending: pending };
    })(),
    // Kasanın şubesi (lafmaliyet docs/SUBE.md): panel yalnız kendi şubesinin (marina) gününü alır, başkasına 409
    // wrong_branch (docs/03-ENTEGRASYON.md §4). Gönderirken güncel ayardan yeniden yazılır (sendDue)
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
      // Hesap sözleşmesi §5 (docs/hesap-sozlesmesi.md): liste değeri = satılan + ikram + ödenmez (servis dahil, zayi
      // hariç); ciro = liste − indirim − ikram − ödenmez; ikram + ödenmez + zayi = offRevenue
      listValue: toTL(lines.reduce((a, l) => a + l.gross, 0) + ikramTotal + odenmezTotal),
      ikramTotal: toTL(ikramTotal),
      odenmezTotal: toTL(odenmezTotal),
      zayiTotal: toTL(compTotal('zayi')),
      // Günün KDV'si LafPOS'un dökümü (adisyon başına yuvarlanmış, oran başına toplam); lafmaliyet yeniden hesaplamaz
      vat: (summary.kdv ?? []).map((k) => ({ rate: k.rate, base: toTL(k.base), vat: toTL(k.kdv) })),
      openedAt: new Date(day.openedAt).toISOString(),
      closedAt: day.closedAt != null ? new Date(day.closedAt).toISOString() : null,
      okcZNo: okc?.zNo != null ? String(okc.zNo) : null,
      // Kasa zinciri (§4.6): açılışta beklenen nakit (önceki gerçek günün devri), fark (açılış − beklenen, işaretli) ve
      // en az ₺1,00 farkta yazılan neden. Beklenen bilinmiyorsa üçü de null
      expectedOpening: day.expectedOpening != null ? toTL(day.expectedOpening) : null,
      openingDiff: day.openingDiff != null ? toTL(day.openingDiff) : null,
      openingReason: cap(day.openingReason),
      // Gün sonu tamlığı (§4.9): nakit satışın bahşişi (cashIn'in içinde kalır), gün sonu ya da föy notu, föyde ödeme
      // türü başına yazılan tutarlar (banka POS slipi, yemek kartı raporu; yazılmadıysa alan yok)
      cashTips: toTL(cashTipsOf(day.id)),
      closeNote: cap(day.note?.trim() || null),
      ...methodCountsOf(day.cashCounts, methods),
    },
    lines: lines.map((l) => ({ posName: l.posName, siteMenuId: l.siteMenuId, slot: l.slot, qty: l.qty, revenue: toTL(l.revenue), gross: toTL(l.gross), isService: l.isService, isAddon: l.isAddon, ...listPricesOf(l.listPrices) })),
    ikram: comps.flatMap((i) =>
      itemParts(i, i.qty * i.unitPrice, addonIds).map((p) => ({
        // Satış satırı yeniden adlandırıldıysa (aynı ad iki kaleme düştü) ikram da aynı adı taşır
        posName: names.get(partKey(p)) ?? p.posName,
        siteMenuId: p.siteMenuId,
        slot: p.slot,
        qty: p.qty,
        menuValue: toTL(p.value),
        // Ödenmez ve zayi nedenin başında da yazılır (`kind`'ı bilmeyen eski lafmaliyet buradan okur); önekiyle en çok
        // 200 karakter (neden 200'e kadar yazılır, "Ödenmez: " onu aşırırdı)
        reason: cap(compReasonText(i.compKind, i.compReason)),
        kind: compKindOf(i.compKind),
        personKind: personKindOf(i, roles),
      })),
    ),
    // `kind` ödeme türünün türü (açık hesap ile havale ikisi de "Diğer"de; lafmaliyet ada bakmadan ayırır)
    payments: summary.payments.map((p) => ({ name: p.name, zField: p.zField, channel: p.channel ?? null, count: p.count, amount: toTL(p.amount), kind: kindOf(methods, p.methodId, p.zField) })),
    // Mali fişi yazarkasada kesilmeyen satış ödemeleri (bahşiş hariç): banka POS'u ve ÖKC kıyasında açıklanır
    // `cardTips`: o kart satışlarının bahşişi (bankanın batch'inde yok; lafmaliyet kart farkını bununla açıklar)
    offDevice: { card: toTL(offDevice.card), cash: toTL(offDevice.cash), cardTips: toTL(offDeviceCardTips(day.id)) },
    refunds: refundsOf(day.id),
    // İptal edilen kalemler ana ürün ve ek parçalarına bölünür (satır anahtarıyla). Hazırlanmış: bar ya da mutfak
    // başlamıştı (`startedAt`) ya da hazırdı (`readyAt`); "bara gönderildi" hazırlandı demek değil. Kalem iadesi
    // (`İade: `) `refunds[]`'ta da görünür
    iptal: voids
      .flatMap((i) =>
        itemParts(i, i.qty * i.unitPrice, addonIds).map((p) => ({
          posName: names.get(partKey(p)) ?? p.posName,
          siteMenuId: p.siteMenuId,
          slot: p.slot,
          qty: p.qty,
          listValue: toTL(p.value),
          prepared: i.startedAt != null || i.readyAt != null,
          reason: cap(i.voidReason),
          refund: !!i.voidReason?.startsWith(REFUND_VOID),
        })),
      )
      .slice(0, LIST_MAX),
    // Kasa hareketleri satır satır (§4.7; lafmaliyet "Kasadan çıkanlar"): hep gider, hareketsiz günde boş dizi (eski
    // LafPOS'tan ayrılsın). Yazan kişi gitmez; teslimde parayı alan (`recipient`, sahibin kararı) gider; harcamanın
    // kategorisi lafmaliyet'in kimliğiyle. Σharcama = cashOut, Σteslim = handedOver, Σgiriş ≤ cashIn (cashIn nakit
    // tahsilatı ve bahşişi de sayar)
    cashMoves: cashMovesOf(day.id),
    // Gün sonu tamlığı (§4.9): yazarkasanın (ÖKC) kendi belgeleri; cihaz yoksa alan yok
    ...okcField(day.id),
    // Siparişsiz ödemeler (açık hesap tahsilatı) ödeme türüne göre, müşterisiz; vardiya sayımları kişisiz; indirimler
    // satır satır nedeniyle (indirimi yapan gitmez). Üçü de hep gider, yoksa boş dizi
    collections: collectionsOf(day.id, methods),
    shiftCounts: shiftCountsOf(db, day.id)
      .slice(0, SHIFT_MAX)
      .map((s) => ({ at: new Date(s.createdAt).toISOString(), counted: toTL(s.counted), expected: toTL(s.expected), diff: toTL(s.diff), confirmed: s.confirmed })),
    discountLines: discountLinesOf(day.id, names, addonIds),
    // O gün çalışanların lafmaliyet personel kimlikleri (§4.8): yalnız en az bir kullanıcı bağlıyken; ad gitmez.
    // Gönderirken güncel bağlantıdan yeniden çözülür (finalBody)
    ...workedStaffField(day),
  };
}

type DayRow = typeof schema.businessDays.$inferSelect;

/** En az bir LafPOS kullanıcısı lafmaliyet personeline bağlı mı (yoksa gövde `workedStaffRefs` taşımaz) */
export function anyStaffLinked(): boolean {
  return !!db.select({ id: schema.users.id }).from(schema.users).where(isNotNull(schema.users.staffRef)).get();
}

/**
 * Gövdenin `workedStaffRefs`'i: çalışanların lafmaliyet personel kimlikleri (`s:<id>`), tekil, sayı sırasıyla. Hiçbir
 * kullanıcı bağlı değilse alan yok (bilinmiyor; eski gövde bayt bayt aynı); bağlı var ama o gün çalışan yoksa boş dizi
 */
function workedStaffField(day: Pick<DayRow, 'id' | 'openedBy' | 'closedBy' | 'workedCorrection'>): { workedStaffRefs?: string[] } {
  const refs = new Map(
    db
      .select({ id: schema.users.id, staffRef: schema.users.staffRef })
      .from(schema.users)
      .where(isNotNull(schema.users.staffRef))
      .all()
      .map((u) => [u.id, u.staffRef!]),
  );
  if (!refs.size) return {};
  const worked = new Set(workedUserIdsOf(db, day).ids.flatMap((id) => refs.get(id) ?? []));
  return { workedStaffRefs: [...worked].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) };
}

/**
 * Günün kasa hareketleri, yazıldığı sırayla (TL; açıklama en çok 200 karakter). Teslimde paranın kime verildiği
 * (`recipient`, sahibin isteği 25 Kasım 2026) satırın sonunda ve yalnız yazılmışsa: alıcısız eski teslimin satırı ve
 * gövde bayt bayt aynı kalır (§4.7)
 */
function cashMovesOf(dayId: string) {
  return db
    .select()
    .from(schema.cashMovements)
    .where(eq(schema.cashMovements.dayId, dayId))
    .orderBy(asc(schema.cashMovements.createdAt), asc(schema.cashMovements.id))
    .all()
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      amount: toTL(m.amount),
      description: cap(m.description) ?? '',
      at: new Date(m.createdAt).toISOString(),
      categoryId: m.kind === 'harcama' ? m.categoryId : null,
      ...(m.kind === 'teslim' && cleanRecipientName(m.recipientName) ? { recipient: cleanRecipientName(m.recipientName) } : {}),
    }));
}

// ─── Gün sonu tamlığı (§4.9, 24 Kasım 2026) ──────────────────────────────────

/** `bankPos.batches` en çok bu kadar (yenileri kalır), `shiftCounts` ve `collections` sınırları */
const BATCH_MAX = 20;
const SHIFT_MAX = 50;
const COLLECTIONS_MAX = 200;

type MethodKind = (typeof schema.paymentMethods.$inferSelect)['kind'];
type MethodRow = { name: string; kind: MethodKind; zField: string; channel: string | null; sort: number };

function methodsById(): Map<string, MethodRow> {
  return new Map(
    db
      .select({ id: schema.paymentMethods.id, name: schema.paymentMethods.name, kind: schema.paymentMethods.kind, zField: schema.paymentMethods.zField, channel: schema.paymentMethods.channel, sort: schema.paymentMethods.sort })
      .from(schema.paymentMethods)
      .all()
      .map(({ id, ...m }) => [id, m]),
  );
}

/** Kaydı silinmiş ödeme türünde tür, ödemenin Z alanından */
const KIND_OF_FIELD: Record<string, MethodKind> = { cash: 'nakit', card: 'kart', meal_card: 'yemek', online: 'online' };
const kindOf = (methods: Map<string, MethodRow>, methodId: string | undefined, zField: string): MethodKind =>
  (methodId ? methods.get(methodId)?.kind : undefined) ?? KIND_OF_FIELD[zField] ?? 'diger';

/** LafPOS'un günün bütün kartıyla kıyas tutarı (okc/card-basis.ts `cardBasis`, önceki batch'siz); gün açıkken null */
function dayCardOf(dayId: string): number | null {
  const k = cardBasis(dayId, []).dayCardKurus;
  return k == null ? null : toTL(k);
}

/** İade edilmemiş satış ödemeleri (açık hesap tahsilatı hariç) */
const liveSales = (dayId: string) =>
  db
    .select({ id: schema.payments.id, zField: schema.payments.zField, amount: schema.payments.amount, tip: schema.payments.tip })
    .from(schema.payments)
    .where(and(eq(schema.payments.dayId, dayId), isNull(schema.payments.refundedAt), isNotNull(schema.payments.orderId)))
    .all();

/** Nakit satışın bahşişi (kuruş): çekmeceye girer, Z'nin `cashIn`'inde kalır */
const cashTipsOf = (dayId: string) => liveSales(dayId).reduce((a, p) => a + (p.zField === 'cash' ? p.tip : 0), 0);

/** Yazarkasadan geçmeyen kart satışlarının bahşişi (kuruş): `offDevice.card` gibi hiçbir cihaz fişinde olmayan ödemeler */
function offDeviceCardTips(dayId: string): number {
  const viaDevice = new Set(deviceReceipts(db, [dayId]).flatMap((r) => r.paymentIds));
  return liveSales(dayId).reduce((a, p) => a + (p.zField === 'card' && !viaDevice.has(p.id) ? p.tip : 0), 0);
}

/** Föyde (gün sonu ya da sonradan) ödeme türü başına yazılan tutarlar (`m:<tür>`); yazılmadıysa alan yok */
function methodCountsOf(counts: Record<string, number> | null, methods: Map<string, MethodRow>): { methodCounts?: { name: string; zField: string; channel: string | null; counted: number }[] } {
  const rows = Object.entries(counts ?? {})
    .filter(([k]) => k.startsWith('m:'))
    .flatMap(([k, v]) => {
      const m = methods.get(k.slice(2));
      return m ? [{ m, v }] : [];
    })
    .sort((a, b) => a.m.sort - b.m.sort || a.m.name.localeCompare(b.m.name, 'tr'));
  return rows.length ? { methodCounts: rows.map(({ m, v }) => ({ name: m.name, zField: m.zField, channel: m.channel ?? null, counted: toTL(v) })) } : {};
}

/** Siparişsiz ödemeler (açık hesap tahsilatı), ödeme türü ve Z alanı başına; müşteri gitmez */
function collectionsOf(dayId: string, methods: Map<string, MethodRow>) {
  const p = schema.payments;
  const rows = db
    .select({ methodId: p.methodId, methodName: p.methodName, zField: p.zField, amount: p.amount })
    .from(p)
    .where(and(eq(p.dayId, dayId), isNull(p.refundedAt), isNull(p.orderId)))
    .orderBy(asc(p.createdAt), asc(p.id))
    .all();
  const groups = new Map<string, { name: string; zField: string; channel: string | null; kind: MethodKind; count: number; amount: number }>();
  for (const r of rows) {
    const key = `${r.methodId}|${r.zField}`;
    const g = groups.get(key) ?? { name: r.methodName, zField: r.zField, channel: methods.get(r.methodId)?.channel ?? null, kind: kindOf(methods, r.methodId, r.zField), count: 0, amount: 0 };
    g.count += 1;
    g.amount += r.amount;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'tr'))
    .slice(0, COLLECTIONS_MAX)
    .map((g) => ({ ...g, amount: toTL(g.amount) }));
}

/**
 * İndirimler satır satır (kapanmış kasa adisyonları; Z'nin `discounts`'uyla aynı kapsam, toplamı ona eşit): adisyon
 * indirimi türüyle (yüzde ya da tutar) ve kalem indirimi (tutar olarak saklanır), nedeniyle. İndirimi yapan gitmez
 */
function discountLinesOf(dayId: string, names: Map<string, string>, addonIds: Record<AddonKey, string | null>) {
  const orders = closedPosOrders([dayId]).sort((a, b) => a.no - b.no || a.id.localeCompare(b.id));
  if (!orders.length) return [];
  const saleIds = db.select({ id: schema.orders.id }).from(schema.orders).where(closedPosWhere([dayId]));
  const discounted = db
    .select()
    .from(schema.orderItems)
    .where(and(inArray(schema.orderItems.orderId, saleIds), gt(schema.orderItems.discount, 0), eq(schema.orderItems.voided, false), eq(schema.orderItems.complimentary, false)))
    .orderBy(asc(schema.orderItems.createdAt), asc(schema.orderItems.id))
    .all();
  const out: { scope: 'order' | 'item'; posName: string | null; type: 'percent' | 'amount'; value: number; amount: number; reason: string | null }[] = [];
  for (const o of orders) {
    const totals = o.totals ?? calcOrder({ lines: [] });
    if (totals.orderDiscount > 0) {
      const percent = o.discountType === 'percent';
      out.push({ scope: 'order', posName: null, type: percent ? 'percent' : 'amount', value: percent ? (o.discountValue ?? 0) : toTL(o.discountValue ?? totals.orderDiscount), amount: toTL(totals.orderDiscount), reason: cap(o.discountReason) });
    }
    for (const i of discounted) {
      if (i.orderId !== o.id) continue;
      const main = itemParts(i, 0, addonIds)[0]!;
      out.push({ scope: 'item', posName: names.get(partKey(main)) ?? main.posName, type: 'amount', value: toTL(i.discount), amount: toTL(Math.min(i.discount, i.qty * i.unitPrice)), reason: cap(i.discountReason) });
    }
  }
  return out.slice(0, LIST_MAX);
}

/**
 * Yazarkasanın (ÖKC) belgeleri (§4.9): günün adisyonlarının cihaz fişleri. Gerçek cihazın (eğitim simülatörü değil)
 * belgesi varsa ya da yazarkasa Pavo veya Token'sa gider; yoksa alan yok. Tutarlar cihazdan geçen iade edilmemiş
 * ödemelerin Z alanına göre toplamı; gün kapandıktan sonra cihazda fişi iptal edilen (`fis_iptal`) ayrı. Böylece
 * `cash = z.cash − offDevice.cash − voided.cash`, `card = z.card − offDevice.card − voided.card`. KDV tamamlanan
 * belgelerin sepetlerinden, belge başına yuvarlanmış (cihaz gibi); sepet okunamazsa null
 */
function okcField(dayId: string) {
  const r = schema.fiscalReceipts;
  const dayOrders = db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.dayId, dayId));
  const paidOrders = db.select({ id: schema.payments.orderId }).from(schema.payments).where(eq(schema.payments.dayId, dayId));
  const receipts = db
    .select({ provider: r.provider, status: r.status, basket: r.basket, paymentIds: r.paymentIds })
    .from(r)
    .where(or(inArray(r.orderId, dayOrders), inArray(r.orderId, paidOrders)))
    .orderBy(asc(r.createdAt), asc(r.id))
    .all();
  const setting = getSettings().okcProvider;
  const real = receipts.filter((x) => x.provider !== 'simulator');
  const provider = (real.at(-1)?.provider as 'pavo' | 'tokenx' | 'tokenkablo' | undefined) ?? (setting === 'pavo' || setting === 'tokenx' || setting === 'tokenkablo' ? setting : null);
  if (!provider) return {};
  const viaDevice = new Set(receipts.flatMap((x) => x.paymentIds));
  const voidedIds = new Set(receipts.filter((x) => x.status === 'fis_iptal').flatMap((x) => x.paymentIds));
  const sums = { cash: 0, card: 0, mealCard: 0, other: 0 };
  const voided = { cash: 0, card: 0 };
  for (const p of liveSales(dayId)) {
    if (!viaDevice.has(p.id)) continue;
    if (voidedIds.has(p.id)) {
      if (p.zField === 'cash' || p.zField === 'card') voided[p.zField] += p.amount;
      continue;
    }
    sums[p.zField === 'cash' ? 'cash' : p.zField === 'card' ? 'card' : p.zField === 'meal_card' ? 'mealCard' : 'other'] += p.amount;
  }
  const completed = receipts.filter((x) => x.status === 'tamamlandi');
  return {
    okc: {
      provider,
      // Token yazarkasası mali Z basar; Pavo (VUK 507, e-Arşiv) basmaz: personelin fotoğrafı yalnız gün sonu fişi
      zReport: provider === 'tokenx' || provider === 'tokenkablo',
      docs: completed.length,
      cash: toTL(sums.cash),
      card: toTL(sums.card),
      mealCard: toTL(sums.mealCard),
      other: toTL(sums.other),
      total: toTL(sums.cash + sums.card + sums.mealCard + sums.other),
      voided: { count: receipts.filter((x) => x.status === 'fis_iptal').length, cash: toTL(voided.cash), card: toTL(voided.card) },
      vat: receiptVat(completed.map((x) => x.basket)),
    },
  };
}

/** Belgelerin KDV dökümü: oran başına KDV dahil toplam ve KDV (belge başına yuvarlanır); okunamayan sepette null */
function receiptVat(baskets: unknown[]): { rate: number; total: number; vat: number }[] | null {
  const rates = new Map<number, { gross: number; vat: number }>();
  for (const b of baskets) {
    if (!b || typeof b !== 'object' || !Array.isArray((b as { items?: unknown }).items)) return null;
    for (const [key, gross] of Object.entries(basketByRate(b as TokenxBasket).byRate)) {
      const rate = Number(key);
      if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(gross)) return null;
      if (gross === 0) continue;
      const row = rates.get(rate) ?? { gross: 0, vat: 0 };
      row.gross += gross;
      row.vat += splitKdv(gross, rate).kdv;
      rates.set(rate, row);
    }
  }
  return [...rates.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) => ({ rate, total: toTL(v.gross), vat: toTL(v.vat) }));
}


const configured = () => !!env.lafmaliyetUrl && env.lafmaliyetToken.length >= MIN_SECRET_LENGTH;
/** lafmaliyet bağlantısı tanımlı mı (LAFMALIYET_URL ve en az 32 karakterlik LAFMALIYET_SYNC_SECRET) */
export const lafmaliyetConfigured = configured;

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
export function enqueueDay(dayId: string, opts: { eodAtClose?: boolean; holdMs?: number } = {}): string | null {
  if (!configured() || trainingDayNow()) return null;
  const day = db.select({ trainingDay: schema.businessDays.trainingDay }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (day && !realDay(day)) return null;
  const payload = buildDayPayload(dayId, { eodAtClose: opts.eodAtClose });
  const key = `gun:${payload.date}`;
  const now = Date.now();
  tx((t) => {
    // Yoldaki (yanıtı beklenen) kayıt silinmez: 200 alırsa gönderilmiş sayılır, sıra ve düzeltme ona göre (sendDue).
    // Tutulan ilk gövde (Pavo bekleniyor) de böyle değişir: gün sonu bitince gelen yeni gövde onun yerine hemen gider
    dropPending(t, 'lafmaliyet', key);
    t.insert(schema.outbox).values({ target: 'lafmaliyet', kind: 'pos.gun', dedupeKey: key, payload, createdAt: now, nextAttemptAt: now + (opts.holdMs ?? 0) }).run();
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
  /**
   * Ertesi günün beklenen açılışı (TL; kasa zinciri §4.6): lafmaliyet'te bu günün kasa raporu varsa sayılan − teslim
   * (`kasa_raporu`), yoksa gövdenin sayımı (`lafpos`); null: gün sayılmadı
   */
  nextOpening?: { amount: number; source: 'kasa_raporu' | 'lafpos' } | null;
  /**
   * Gövdedeki `workedStaffRefs`'in lafmaliyet'teki karşılığı (§4.8): sayılan, lafmaliyet'te bulunmayan ve başka şubenin
   * kaydı olan kimlikler. Yalnız alan gönderildiyse gelir
   */
  staff?: { counted: string[]; unknown: string[]; otherBranch: string[] };
}

/** lafmaliyet'in devir nesnesi (gün sonu yanıtında ve `GET /api/panel/pos/devir`'de aynı) */
const nextOpeningShape = z.object({ amount: z.number().finite().min(0).max(10_000_000), source: z.enum(['kasa_raporu', 'lafpos']) });

const count = z.number().int().min(0).optional().catch(undefined);
/** lafmaliyet personel kimlikleri (`s:<staff.id>`); bozuk liste yanıtın `staff`'ını düşürür, günü değil */
const staffRefs = z.array(z.string().regex(/^s:[1-9]\d{0,8}$/)).max(500);
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
  nextOpening: nextOpeningShape.nullable().optional().catch(undefined),
  staff: z
    .object({ counted: staffRefs, unknown: staffRefs, otherBranch: staffRefs })
    .optional()
    .catch(undefined),
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
export function httpErrorText(status: number, json: unknown): string {
  const detail = errorDetail(json);
  const code = (json as { error?: unknown } | null)?.error;
  if (status === 401) return `HTTP 401${detail}: imza kabul edilmedi. LafPOS'taki LAFMALIYET_SYNC_SECRET paneldeki LAFPOS_SYNC_SECRET ile aynı mı, kasa bilgisayarının saati doğru mu (±5 dk)`;
  // 503 yalnız gövdesi not_configured ise "anahtar yok"; başkası (bakım, barındırma hatası) geçici sayılır
  if (status === 503 && code === 'not_configured') return `HTTP 503${detail}: lafmaliyet'te LAFPOS_SYNC_SECRET tanımlı değil, bağlantı panelde kapalı`;
  if (status === 503 || status === 502 || status === 504) return `HTTP ${status}${detail}: lafmaliyet şu an yanıt vermiyor (bakım ya da sunucu hatası)`;
  if (status === 404 || status === 405) return `HTTP ${status}${detail}: adreste lafmaliyet yok. Yönetim › Bağlantı bilgileri › lafmaliyet adresi https://ladmin.laffogato.net olmalı`;
  return `HTTP ${status}${detail}`;
}

/** Yanıt hiç gelmediyse (internet yok, ad çözülemedi, zaman aşımı) Türkçe neden; değilse hatanın kendi metni */
export function networkErrorText(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'lafmaliyet zamanında yanıt vermedi';
  if (isNetworkError(e)) {
    const code = String((e as { cause?: { code?: unknown } }).cause?.code ?? (e as { code?: unknown }).code ?? '');
    const why = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'adres bulunamadı (internet ya da adres yazımı)' : 'bağlantı kurulamadı (internet)';
    return `lafmaliyet'e ulaşılamadı: ${why}${code ? ` [${code}]` : ''}`;
  }
  const m = e instanceof Error ? e.message : String(e);
  return m === 'fetch failed' ? "lafmaliyet'e ulaşılamadı" : m;
}

/**
 * Gün sonu yanıtına göre kullanıcıya gösterilen hata (giden kutusunun `lastError`'u; Entegrasyon ve Genel bakış da
 * gösterir): neden ve ne yapılacağı. Kalıcı retler kendiliğinden yeniden denenmez, bunu söyler
 */
export function pushErrorText(status: number, json: unknown, payload: unknown): string {
  const detail = errorDetail(json);
  if (status === 409 && (json as { error?: unknown } | null)?.error === 'wrong_branch') {
    const b = json as { sube?: unknown; expected?: unknown };
    return `lafmaliyet bu kasanın gün sonunu almıyor: bu kasa "${String(b.sube)}" şubesine ayarlı, lafmaliyet yalnız "${String(b.expected)}" şubesini alıyor. Yönetim › Ayarlar ve yedek › Şube kimliği alanını "${String(b.expected)}" yapıp ${RESEND} ile yeniden gönderin`;
  }
  if (status === 409) {
    const body = (json && typeof json === 'object' ? json : {}) as { zNo?: unknown };
    const sent = (payload as { z?: { zNo?: unknown } } | null)?.z?.zNo;
    const known = typeof body.zNo === 'number' ? `lafmaliyet'te bu güne Z ${body.zNo} kayıtlı, gönderilen Z ${typeof sent === 'number' ? sent : '?'}. ` : '';
    return `lafmaliyet reddetti: HTTP 409${detail}. ${known}Kendiliğinden yeniden denenmez: lafmaliyet Ayarlar › LafPOS (kasa)'da günün kaydı silinince ${RESEND} ile yeniden gönderin`;
  }
  // 400/413/422: gövde sözleşmeye uymadı ya da çok büyük; LafPOS'un ya da panelin sürüm farkı, kullanıcının düzelteceği bir şey yok
  if (PERMANENT.has(status)) return `lafmaliyet reddetti: HTTP ${status}${detail}. Kendiliğinden yeniden denenmez; LafPOS'u ve lafmaliyet'i güncelleyip ${RESEND} ile yeniden gönderin, sürerse destekle görüşün`;
  return httpErrorText(status, json);
}

// ─── Gün gitmediyse patrona (denetim kaydı ve telefon bildirimi) ───────────

/**
 * Gün sonunun lafmaliyet'e gitmediği iki durum sessiz kalmaz (26 Kasım 2026; 25 Kasım teşhisinde bulundu): kapanışta
 * gövde kurulamadı (`dayPrepFailed`) ve lafmaliyet günü kalıcı reddetti (`parkedAlarm`). İkisinde de denetim kaydına
 * alarm yazılır ve patronun telefonuna bildirim gider (tür `lafmaliyet`; Telefon bildirimleri açıkken her zaman, ayrı
 * anahtarı yok). Aynı olay için bir kez: anahtarlar burada (en yeni 50)
 */
const ALARMS = 'lafmaliyet.alarms';
const ALARMS_MAX = 50;

/** Anahtar ilk kez görülüyorsa saklar ve true döner */
function firstAlarm(key: string): boolean {
  const seen = getSyncState<string[]>(ALARMS) ?? [];
  if (seen.includes(key)) return false;
  setSyncState(ALARMS, [...seen, key].slice(-ALARMS_MAX));
  return true;
}

/** Gün lafmaliyet'e ulaştı: o günün ret anahtarları silinir (sonra aynı nedenle yeniden reddedilirse yine haber verilir) */
function forgetAlarms(prefix: string) {
  try {
    const seen = getSyncState<string[]>(ALARMS) ?? [];
    const kept = seen.filter((k) => !k.startsWith(prefix));
    if (kept.length !== seen.length) setSyncState(ALARMS, kept);
  } catch (e) {
    // Gönderim başarılı sayıldı; anahtar kalırsa yalnız aynı nedenin sonraki bildirimi gitmez
    console.warn('[lafmaliyet] bildirim anahtarları', e instanceof Error ? e.message : e);
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Bildirim gönderimi kasayı hiç bekletmez ve düşürmez */
function alarmNotice(title: string, body: string) {
  void notify({ kind: 'lafmaliyet', title, body }).catch((e) => console.warn('[lafmaliyet] bildirim', e instanceof Error ? e.message : e));
}

/**
 * Kalıcı retin telefon bildirimi: günü, nedenin kısası (`pushErrorText`'in sınıflandırmasıyla) ve yeniden gönderme yolu.
 * Site gövdeyi 240 karakterde keser; `pushErrorText`'in tamamı sığmaz (yol sonda kalırdı), tamamı denetim kaydında
 */
export function pushRejectNotice(status: number, json: unknown, payload: unknown): { title: string; body: string } {
  const date = dateOf(payload);
  const zNo = (payload as { z?: { zNo?: unknown } } | null)?.z?.zNo;
  const day = date ? `${fmtDateShort(date)}: ` : '';
  const title = `lafmaliyet gün sonunu reddetti${typeof zNo === 'number' ? ` (Z ${zNo})` : ''}`;
  const j = (json && typeof json === 'object' ? json : {}) as { error?: unknown; field?: unknown; zNo?: unknown; sube?: unknown; expected?: unknown };
  if (status === 409 && j.error === 'wrong_branch') {
    return { title, body: `${day}kasa "${clip(String(j.sube), 24)}" şubesine ayarlı, lafmaliyet "${clip(String(j.expected), 24)}" bekliyor. Yönetim › Ayarlar ve yedek › Şube kimliğini düzeltip ${RESEND} ile yeniden gönderin` };
  }
  if (status === 409) {
    const known = typeof j.zNo === 'number' ? `Z ${j.zNo}` : 'başka bir Z';
    return { title, body: `${day}lafmaliyet'te bu güne ${known} kayıtlı (HTTP 409). lafmaliyet'te günün kaydı silinince ${RESEND} ile yeniden gönderin` };
  }
  const code = [j.error, j.field].filter((x): x is string => typeof x === 'string' && x.length > 0).join(': ');
  return { title, body: `${day}gövde kabul edilmedi (HTTP ${status}${code ? `, ${clip(code, 48)}` : ''}). LafPOS'u ve lafmaliyet'i güncelleyip ${RESEND} ile yeniden gönderin` };
}

/**
 * lafmaliyet günü kalıcı reddetti, kayıt park edildi (kendiliğinden yeniden denenmez, yalnız `lastError`'da görünürdü):
 * denetim kaydına alarm ve patrona bildirim, aynı gün ve neden (`pushErrorText`) için bir kez. Hata gönderimi bozmaz
 */
function parkedAlarm(payload: unknown, status: number, json: unknown, text: string) {
  try {
    const date = dateOf(payload);
    if (!firstAlarm(`ret:${date}:${text}`)) return;
    const zNo = (payload as { z?: { zNo?: unknown } } | null)?.z?.zNo;
    const day = date ? db.select({ id: schema.businessDays.id }).from(schema.businessDays).where(eq(schema.businessDays.date, date)).orderBy(desc(schema.businessDays.zNo)).get() : undefined;
    const fx = new Effects();
    fx.audit(db, {
      action: 'sync.lafmaliyet_rejected',
      severity: 'alarm',
      entity: 'day',
      entityId: day?.id ?? null,
      message: `${date ? fmtDateShort(date) : 'Gün'}${typeof zNo === 'number' ? ` (Z ${zNo})` : ''} gün sonu lafmaliyet'e gitmedi: ${text}`,
      data: { date, zNo: typeof zNo === 'number' ? zNo : null, status, error: (json as { error?: unknown } | null)?.error ?? null },
    });
    fx.flush();
    const n = pushRejectNotice(status, json, payload);
    alarmNotice(n.title, n.body);
  } catch (e) {
    console.error('[lafmaliyet] kalıcı ret bildirilemedi:', e);
  }
}

/**
 * Gün kapandı ama lafmaliyet gövdesi kurulamadı (`buildDayPayload` attı): gün kapalı kalır, giden kutusuna bir şey
 * girmez, lafmaliyet'in gün sonu e-postası gitmez. Denetim kaydına alarm, patrona bildirim (kapanış başına bir kez).
 * Yeniden deneme elle (Kasa › Geçmiş günler › Z › Gönder; Entegrasyon'daki "Geçmiş günleri gönder" de günü gönderilmemiş
 * sayar). Hata kapanışı bozmaz
 */
function dayPrepFailed(dayId: string, err: unknown) {
  const reason = err instanceof Error ? err.message || err.name : String(err);
  console.error("[lafmaliyet] gün sonu gövdesi kurulamadı, gün lafmaliyet'e gitmedi:", err);
  try {
    const day = db.select({ date: schema.businessDays.date, zNo: schema.businessDays.zNo, closedAt: schema.businessDays.closedAt }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
    if (!firstAlarm(`hazirlik:${dayId}:${day?.closedAt ?? 0}`)) return;
    const label = day ? `${fmtDateShort(day.date)} (Z ${day.zNo})` : 'Gün';
    const fx = new Effects();
    fx.audit(db, {
      action: 'sync.lafmaliyet_failed',
      severity: 'alarm',
      entity: 'day',
      entityId: dayId,
      message: `${label} gün sonu lafmaliyet'e gitmedi: gövde kurulamadı (${clip(reason, 300)}). Gün kapandı; ${RESEND} ile yeniden deneyin, sürerse destekle görüşün`,
      data: { date: day?.date ?? null, zNo: day?.zNo ?? null, error: clip(reason, 500) },
    });
    fx.flush();
    alarmNotice(
      `Gün sonu lafmaliyet'e gitmedi${day ? ` (Z ${day.zNo})` : ''}`,
      `${day ? `${fmtDateShort(day.date)}: ` : ''}gün kapandı ama gövde kurulamadı (${clip(reason, 60)}). ${RESEND} ile yeniden deneyin, sürerse destekle görüşün`,
    );
  } catch (e) {
    console.error('[lafmaliyet] gövde hatası bildirilemedi:', e);
  }
}

interface PushState {
  lastRunAt?: number;
  /** En son başarılı gönderim (Genel bakış › Sistem sağlığı) */
  lastSuccessAt?: number;
  sent?: number;
  failed?: number;
  /** En son gönderilen günün yanıtı */
  lastAnswer?: DayAnswer;
  /** lafmaliyet'in en son kabul ettiği (200) gövdenin şubesi: şube kilidi bunu söyler, şu anki ayarı değil */
  acceptedBranch?: string;
}

const dateOf = (payload: unknown) => {
  const d = (payload as { date?: unknown } | null)?.date;
  return typeof d === 'string' ? d : '';
};

/**
 * Kayıttaki gövdenin gönderilen hâli. Sıra ve düzeltme gönderim anında yeniden yazılır (gönderimler sırayla gider):
 * sıra o ana dek 200 almış gövdeler + 1, düzeltme yalnız ondan sonra kurulan ilk kabul edilen gövdede. Şube kasanın
 * ayarıdır, günün değil: kuyruktaki kayıt şube düzeltilmeden önce hazırlandıysa güncelini taşır
 */
function finalBody(row: typeof schema.outbox.$inferSelect): Record<string, unknown> {
  const date = dateOf(row.payload);
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.date, date)).orderBy(desc(schema.businessDays.zNo)).get();
  const correction = day ? correctionFor(day, row.createdAt) : null;
  const { revision: _revision, correction: _built, ...rest } = row.payload as Record<string, unknown>;
  const body: Record<string, unknown> = { version: rest.version, source: rest.source, revision: revisionOf(date), ...(correction ? { correction } : {}), ...rest };
  body.sube = getSettings().branchId;
  // O gün çalışanlar da gönderim anının bağlantısından (gün kapandıktan sonra kurulan bağlantı ve "Bugün çalışanlar"
  // düzeltmesi sonraki gönderimde gider); alan sonda kalır
  if (day) {
    delete body.workedStaffRefs;
    Object.assign(body, workedStaffField(day));
  }
  return body;
}

/**
 * Gidemeyen kayıt, yanıtı beklenirken yerine yenisi kuyruğa girdiyse ya da gün yeniden açıldıysa atılır: sonra yeniden
 * denenip yeni gövdeyi eskisiyle ezmesin, gün açıkken eski Z gitmesin (outbox-flight.ts)
 */
function dropIfStale(row: typeof schema.outbox.$inferSelect): boolean {
  if (!row.dedupeKey) return false;
  const newer = db
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.dedupeKey, row.dedupeKey), isNull(schema.outbox.sentAt), gt(schema.outbox.id, row.id)))
    .get();
  const reopened = db
    .select({ id: schema.businessDays.id })
    .from(schema.businessDays)
    .where(and(eq(schema.businessDays.date, dateOf(row.payload)), isNull(schema.businessDays.closedAt)))
    .get();
  if (newer || reopened) db.delete(schema.outbox).where(eq(schema.outbox.id, row.id)).run();
  return !!(newer || reopened);
}

async function sendDue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let lastAnswer: DayAnswer | null = null;
  let acceptedBranch: string | null = null;
  const due = db
    .select()
    .from(schema.outbox)
    // Giden kutusunu site de kullanır (Tükendi yazımları, target 'laffogato'): lafmaliyet'e yalnız kendi kayıtları
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), isNull(schema.outbox.sentAt), lte(schema.outbox.nextAttemptAt, Date.now())))
    .orderBy(asc(schema.outbox.id))
    .limit(20)
    .all();
  for (const listed of due) {
    // Liste turun başında alındı: önceki isteğin yanıtı beklenirken kayıt yenisiyle değiştiyse silineni göndermez
    const row = db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.id, listed.id), isNull(schema.outbox.sentAt)))
      .get();
    if (!row) continue;
    const body = finalBody(row);
    takeOff(row.id);
    try {
      const { status, json } = await signedFetch(env.lafmaliyetToken, 'POST', new URL('/api/pos/gun', env.lafmaliyetUrl), body, 15_000);
      // 400/413/422 kalıcıdır (veri hatalı ya da büyük), 409 aynı tarihte başka Z (z_conflict): tekrar denenmez,
      // elle düzeltilip yeniden gönderilir (Kasa › Geçmiş günler › Z › Gönder)
      if (PERMANENT.has(status)) {
        const text = pushErrorText(status, json, row.payload);
        db.update(schema.outbox)
          .set({ attempts: row.attempts + 1, lastError: text, nextAttemptAt: Date.now() + PARKED_MS })
          .where(eq(schema.outbox.id, row.id))
          .run();
        // Park edilen kayıt patrona bildirilir (bir kez); yerine yenisi girdiyse ya da gün yeniden açıldıysa bayattır
        if (!dropIfStale(row)) parkedAlarm(row.payload, status, json, text);
        failed++;
        continue;
      }
      if (status !== 200) throw new Error(pushErrorText(status, json, row.payload));
      const date = dateOf(row.payload);
      // 200 yalnız lafmaliyet'in kendi yanıtıysa gönderildi sayılır (`ok` ve aynı gün): araya giren bir sayfa (giriş,
      // bakım, başka site) günü "gitti" diye işaretletmez
      const reply = (json && typeof json === 'object' ? json : {}) as { ok?: unknown; date?: unknown };
      if (reply.ok !== true || reply.date !== date) throw new Error("Adresten lafmaliyet yanıtı gelmedi (HTTP 200, beklenen gövde yok). Yönetim › Bağlantı bilgileri › lafmaliyet adresi https://ladmin.laffogato.net olmalı");
      const answer = readDayAnswer(json, date);
      const now = Date.now();
      tx((t) => {
        // Kayıt gönderilen hâlini saklar (sıra, düzeltme, şube): sonraki sıra ve düzeltme buna göre
        t.update(schema.outbox).set({ sentAt: now, lastError: null, attempts: row.attempts + 1, response: { ...answer }, payload: body }).where(eq(schema.outbox.id, row.id)).run();
        // Gün gönderildi: paket günün son kapanışından sonra hazırlandıysa (arada yeniden açılmadıysa) işaretlenir.
        // "Geçmiş günleri gönder" bu işareti olmayan kapanmış günleri sayar
        t.update(schema.businessDays)
          .set({ exportedAt: now })
          .where(and(eq(schema.businessDays.date, date), isNotNull(schema.businessDays.closedAt), lte(schema.businessDays.closedAt, row.createdAt)))
          .run();
      });
      forgetAlarms(`ret:${date}:`);
      lastAnswer = answer;
      acceptedBranch = String(body.sube);
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8));
      db.update(schema.outbox)
        .set({ attempts, lastError: networkErrorText(e), nextAttemptAt: Date.now() + wait })
        .where(eq(schema.outbox.id, row.id))
        .run();
      dropIfStale(row);
      failed++;
    } finally {
      land(row.id);
    }
  }
  if (sent || failed) {
    const prev = getSyncState<PushState>('lafmaliyet.push') ?? {};
    // Yanıtta gelmeyen geçiş günü bilinen eskisini silmez (eski ya da kısa yanıt "bilinmiyor" demek, "seçilmedi" değil)
    const kept = lastAnswer && !('switchDay' in lastAnswer) && prev.lastAnswer && 'switchDay' in prev.lastAnswer ? { ...lastAnswer, switchDay: prev.lastAnswer.switchDay } : lastAnswer;
    setSyncState('lafmaliyet.push', {
      ...prev,
      lastRunAt: Date.now(),
      sent,
      failed,
      ...(sent ? { lastSuccessAt: Date.now() } : {}),
      ...(kept ? { lastAnswer: kept } : {}),
      ...(acceptedBranch ? { acceptedBranch } : {}),
    } satisfies PushState);
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

/**
 * Şube kimliği kilitli mi: lafmaliyet bu kasanın bir gününü kabul etti (200). Kimlik bundan sonra değişirse sonraki
 * günler başka şubeye yazılır ya da 409 wrong_branch alır; Yönetim › Ayarlar yalnız patronun ayrıca onayıyla değiştirir
 */
export function branchLocked(): boolean {
  if (getSyncState<PushState>('lafmaliyet.push')?.lastSuccessAt) return true;
  return !!db
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.kind, 'pos.gun'), isNotNull(schema.outbox.sentAt)))
    .get();
}

/**
 * lafmaliyet'in en son kabul ettiği (200) gövdenin şubesi: şube kilidinin metni ve onaysız dönülebilen kimlik. Bu alan
 * tutulmadan önce gönderilmiş günde son gönderilen gövdeden; hiç gün kabul edilmemişse null
 */
export function acceptedBranch(): string | null {
  const known = getSyncState<PushState>('lafmaliyet.push')?.acceptedBranch;
  if (known) return known;
  const last = db
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.kind, 'pos.gun'), isNotNull(schema.outbox.sentAt)))
    .orderBy(desc(schema.outbox.sentAt), desc(schema.outbox.id))
    .get();
  const sube = (last?.payload as { sube?: unknown } | null)?.sube;
  return typeof sube === 'string' && sube ? sube : null;
}

/**
 * Yanıtın kullanıcıya giden hâli: ertesi günün beklenen açılışı (`nextOpening`) yalnız kasa rakamlarını görene (kör
 * kasiyer devri bağlantı durumundan ya da "Gönder"in yanıtından öğrenmesin; docs/03-ENTEGRASYON.md §4.6)
 */
export function answerFor(a: DayAnswer | null, seesCash: boolean, seesStaff = false): DayAnswer | null {
  if (!a) return a;
  // Personel kimlikleri (`staff`) yalnız personel ya da bağlantı yöneticisine (Entegrasyon, Personel)
  const { nextOpening, staff, ...rest } = a;
  return { ...rest, ...(seesCash && 'nextOpening' in a ? { nextOpening } : {}), ...(seesStaff && staff ? { staff } : {}) };
}

/**
 * lafmaliyet'in saymadığı personel kimlikleri, LafPOS'taki adıyla (Entegrasyon; ad yalnız bu kasada, lafmaliyet'e
 * gitmez): bulunmayan (ladmin'de silinmiş kayıt) ve başka şubenin kaydı. Bu kasada bağlı kullanıcı yoksa ad null
 */
function staffIssuesOf(a: DayAnswer | null) {
  if (!a?.staff) return null;
  const names = new Map(
    db
      .select({ name: schema.users.name, staffRef: schema.users.staffRef })
      .from(schema.users)
      .where(isNotNull(schema.users.staffRef))
      .all()
      .map((u) => [u.staffRef!, u.name]),
  );
  const named = (refs: string[]) => refs.map((ref) => ({ ref, name: names.get(ref) ?? null }));
  return { unknown: named(a.staff.unknown), otherBranch: named(a.staff.otherBranch) };
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
    res = await signedFetch(env.lafmaliyetToken, 'GET', new URL('/api/panel/pos/urunler', env.lafmaliyetUrl));
  } catch (e) {
    costsFailed(`Maliyetler alınamadı: ${networkErrorText(e)}`);
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

/**
 * Gün sonu alınınca (kasadan ya da otomatik): gün lafmaliyet'e gider, maliyetler günde bir yenilenir. `eodExpected`:
 * Pavo'nun otomatik banka gün sonu şimdi başlayacak (okc/service.ts autoEodExpected); o zaman gövde gün sonu bitene dek
 * en çok EOD_FIRST_PUSH_HOLD_MS tutulur (sonuçla tek gövde, tek e-posta), sonra yine gider. Atmaz: gövde kurulamazsa
 * denetim kaydına alarm yazılır ve patrona bildirim gider, çağıran kapanışın kalanını (Pavo, kasa farkı) sürdürür
 */
export function afterDayClosed(dayId: string, opts: { eodExpected?: boolean } = {}) {
  // Gün zaten kapandı (işlem bitti): gövde kurulamazsa hata buradan çıkmaz. Çıksaydı kasa 500 alır, ardından gelen
  // Pavo'nun banka gün sonu ve kasa farkı bildirimi hiç çağrılmaz, otomatik gün sonunda süreç düşebilirdi; giden
  // kutusuna da bir şey girmediği için kimse bilmezdi. Denetim kaydı ve patrona bildirim (`dayPrepFailed`)
  try {
    if (opts.eodExpected) enqueueDay(dayId, { eodAtClose: true, holdMs: EOD_FIRST_PUSH_HOLD_MS });
    else if (enqueueDay(dayId)) void flushOutbox();
  } catch (e) {
    dayPrepFailed(dayId, e);
  }
  void pullCostsIfStale();
}

export function costMap(): Record<string, number> {
  return costsState()?.map ?? {};
}

/** Maliyetlerin son başarılı çekimi (yoksa null); yalnız maliyet yetkisi olanlara gider */
export function costsAt(): number | null {
  return costsState()?.at || null;
}

// ─── Kasa zinciri: devir ve gider kategorileri (lafmaliyet → LafPOS) ────────

/**
 * lafmaliyet'e kendiliğinden giden okumaların (devir, gider kategorileri) en kısa arası: istek ancak ekran isteyince
 * gider (tembel), yine de 5 dakikada birden sık değil (AGENTS kural 6'nın ruhu; docs/03-ENTEGRASYON.md §5)
 */
export const LADMIN_LAZY_MIN_MS = 5 * 60_000;

/** Eski lafmaliyet (uç yok) 404 döner: adres yanlış değildir, bu uç henüz yok */
export function lazyErrorText(status: number, json: unknown): string {
  return status === 404 ? "HTTP 404: lafmaliyet bu ucu henüz sunmuyor (eski sürüm)" : httpErrorText(status, json);
}

/** `GET /api/panel/pos/devir?date=` gövdesi (§4.6); bozuksa ya da başka günse önceki değer kalır */
const devirBody = z.object({ version: z.literal(1), date: z.string().refine(isCalendarDate), nextOpening: nextOpeningShape.nullable() });

let devirRunning: Promise<boolean> | null = null;

/**
 * Devri lafmaliyet'ten tembel okur: yalnız bağlantı tanımlıyken, gün kapalıyken (Kasa ekranı "Günü aç"ı gösterirken),
 * son gerçek gün varken, onun gönderilmemiş kaydı yokken (varsa yerel sayım geçer) ve son denemeden 5 dakika geçtiyse.
 * Bugünün günü kapandıysa sorulmaz: yeni gün 05:00'ten önce açılmaz, gece açık kalan Kasa ekranı lafmaliyet'i
 * uyandırmaz (ertesi iş gününde ekran yine sorar). Değer değişince ekranlar yenilenir. Hata öncekini silmez. İstek
 * gittiyse true
 */
export function devirIfStale(now = Date.now()): Promise<boolean> {
  if (!configured() || devirRunning) return Promise.resolve(false);
  if (getOpenDay(db) || closedToday(db)) return Promise.resolve(false);
  const day = lastClosedRealDay(db);
  if (!day || dayPushPending(db, day.date)) return Promise.resolve(false);
  const prev = getSyncState<DevirState>('lafmaliyet.devir');
  if (prev && now - prev.attemptAt < LADMIN_LAZY_MIN_MS) return Promise.resolve(false);
  // Deneme anı istekten önce yazılır (aynı anda gelen ikinci ekran ikinci istek açmaz); başka günün değeri atılır
  setSyncState('lafmaliyet.devir', { ...(prev?.date === day.date ? prev : { okAt: null }), date: day.date, attemptAt: now } satisfies DevirState);
  devirRunning = pullDevir(day.date)
    .catch((e) => console.warn('[lafmaliyet] devir alınamadı:', e instanceof Error ? e.message : e))
    .then(() => true)
    .finally(() => {
      devirRunning = null;
    });
  return devirRunning;
}

async function pullDevir(date: string) {
  const state = () => getSyncState<DevirState>('lafmaliyet.devir')!;
  const fail = (message: string) => setSyncState('lafmaliyet.devir', { ...state(), lastError: message } satisfies DevirState);
  let res: { status: number; json: unknown };
  try {
    const url = new URL('/api/panel/pos/devir', env.lafmaliyetUrl);
    url.searchParams.set('date', date);
    res = await signedFetch(env.lafmaliyetToken, 'GET', url);
  } catch (e) {
    return fail(`Devir alınamadı: ${networkErrorText(e)}`);
  }
  if (res.status !== 200) return fail(`Devir alınamadı (${lazyErrorText(res.status, res.json)})`);
  const parsed = devirBody.safeParse(res.json);
  if (!parsed.success || parsed.data.date !== date) return fail("Devir okunamadı: lafmaliyet'in yanıtı beklenen biçimde değil; önceki değer kaldı");
  const value = parsed.data.nextOpening ? { amount: kurusOf(parsed.data.nextOpening.amount), source: parsed.data.nextOpening.source } : null;
  const before = state();
  setSyncState('lafmaliyet.devir', { ...before, okAt: Date.now(), nextOpening: value, lastError: null } satisfies DevirState);
  if (before.okAt == null || JSON.stringify(before.nextOpening ?? null) !== JSON.stringify(value)) bus.publish({ topic: 'cash', kind: 'devir' });
}

/** lafmaliyet'in personelin seçebildiği gider kategorisi (§4.7) */
export interface ExpenseCategory {
  id: number;
  name: string;
  section: string | null;
}

interface CategoriesState {
  /** Son başarılı çekim; hiç çekilmediyse null */
  at: number | null;
  /** Son deneme (5 dakika bütçesi) */
  attemptAt: number;
  items: ExpenseCategory[];
  lastError?: string | null;
  lastErrorAt?: number | null;
}

/** `GET /api/panel/pos/gider-kategorileri` gövdesi (§4.7); bozuksa son liste kalır */
const categoriesBody = z.object({
  version: z.literal(1),
  items: z.array(z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(120), section: z.string().max(40).nullish() })).max(500),
});

const categoriesState = () => getSyncState<CategoriesState>('lafmaliyet.expenseCategories');

/**
 * Son çekilen harcama kategorileri (internet yokken ya da bağlantı sonradan kaldırılsa da son liste); hiç çekilmediyse
 * boş: harcama kategorisiz kaydedilir
 */
export function expenseCategories(): ExpenseCategory[] {
  return categoriesState()?.items ?? [];
}

let categoriesRunning: Promise<boolean> | null = null;

/**
 * Harcama kategorilerini tembel çeker (harcama penceresi açılınca, gün açıkken; Kasa'nın uç kapısı): yalnız bağlantı
 * tanımlıyken ve son denemeden 5 dakika geçtiyse. İnternet yokken ya da yanıt bozukken son liste kalır, hata saklanır.
 * İstek gittiyse true
 */
export function categoriesIfStale(now = Date.now()): Promise<boolean> {
  if (!configured() || categoriesRunning) return Promise.resolve(false);
  const prev = categoriesState();
  if (prev && now - prev.attemptAt < LADMIN_LAZY_MIN_MS) return Promise.resolve(false);
  setSyncState('lafmaliyet.expenseCategories', { at: prev?.at ?? null, items: prev?.items ?? [], lastError: prev?.lastError ?? null, lastErrorAt: prev?.lastErrorAt ?? null, attemptAt: now } satisfies CategoriesState);
  categoriesRunning = pullExpenseCategories()
    .catch((e) => console.warn('[lafmaliyet] gider kategorileri alınamadı:', e instanceof Error ? e.message : e))
    .then(() => true)
    .finally(() => {
      categoriesRunning = null;
    });
  return categoriesRunning;
}

async function pullExpenseCategories() {
  const fail = (message: string) => setSyncState('lafmaliyet.expenseCategories', { ...categoriesState()!, lastError: message, lastErrorAt: Date.now() } satisfies CategoriesState);
  let res: { status: number; json: unknown };
  try {
    res = await signedFetch(env.lafmaliyetToken, 'GET', new URL('/api/panel/pos/gider-kategorileri', env.lafmaliyetUrl));
  } catch (e) {
    return fail(`Gider kategorileri alınamadı: ${networkErrorText(e)}`);
  }
  if (res.status !== 200) return fail(`Gider kategorileri alınamadı (${lazyErrorText(res.status, res.json)})`);
  const parsed = categoriesBody.safeParse(res.json);
  if (!parsed.success) return fail("Gider kategorileri okunamadı: lafmaliyet'in yanıtı beklenen biçimde değil; son liste kaldı");
  const items = parsed.data.items.map((i) => ({ id: i.id, name: i.name, section: i.section ?? null }));
  const before = categoriesState()!;
  setSyncState('lafmaliyet.expenseCategories', { ...before, at: Date.now(), items, lastError: null, lastErrorAt: null } satisfies CategoriesState);
  if (JSON.stringify(before.items) !== JSON.stringify(items)) bus.publish({ topic: 'cash', kind: 'expense-categories' });
}

/**
 * Entegrasyon ve Genel bakış durumu. Maliyetin tarihi ve hatası yalnız maliyet yetkisine (`withCost`): personel
 * maliyetin varlığını da görmez (Raporlar ve patron paneliyle aynı kapı). Yanıttaki devir yalnız kasa rakamlarını
 * görene (`withCash`)
 */
export function lafmaliyetStatus(withCost = false, withCash = false, withStaff = false) {
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
    answer: answerFor(push?.lastAnswer ?? null, withCash, withStaff),
    ...(withStaff ? { staffIssues: staffIssuesOf(push?.lastAnswer ?? null) } : {}),
    backfill: { ...range, unsent: range.from && range.from <= range.to ? unsentClosedDays(range.from, range.to).length : null },
    ...(withCost ? { costsAt: costs?.at || null, costsError: costs?.lastError ? { message: costs.lastError, at: costs.lastErrorAt ?? null } : null } : {}),
  };
}
