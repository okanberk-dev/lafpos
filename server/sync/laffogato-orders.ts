import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { ONLINE_ALERT_MAX_AGE_MS, type OnlineAlertDTO } from '@shared/site-alerts';
import { normalizeTableCode } from '@shared/table-qr';
import { businessDate } from '@shared/time';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { siteKaraokeOn, siteKaraokeTick } from './laffogato-karaoke';
import { requireSiteSigned, siteLinked, siteSigned, unknownSiteListVersion } from './laffogato-link';
import { dropSiteSoldOut, enqueueSiteAvailability, siteOutboxStatus, siteTablesPushStatus, withSiteMenuLock } from './site-outbox';
import { applyTableCalls, type PanelCall, parsePanelCalls } from './table-calls';

/**
 * laffogato online siparişleri (uygulama, web, masa QR). Sitede ödenmiştir: LafPOS yalnız gösterir (bar ekranı,
 * masa planı) ve hazırlık aşamasını siteye yazar. docs/03-ENTEGRASYON.md §2.3
 */

export interface PanelOrder {
  id: string;
  orderNo: number;
  stage: 'new' | 'preparing' | 'ready';
  fulfillment: 'table' | 'pickup' | 'delivery';
  label: string;
  /** Masa siparişinde masanın QR kodu (sözleşmeye sonradan eklenen alan; eski site göndermez, etiketle eşlenir) */
  tableCode?: string;
  firstName: string;
  scheduledFor: string;
  note: string;
  paidAt: string;
  lines: { menuItemId: string; name: string; size: 'M' | 'L' | 'single'; detail: string; note: string; qty: number }[];
  totalMinor: number;
}

const configured = siteSigned;

const STAGE_STATUS: Record<PanelOrder['stage'], 'yeni' | 'hazirlaniyor' | 'hazir'> = { new: 'yeni', preparing: 'hazirlaniyor', ready: 'hazir' };

const isPanelOrder = (o: unknown): o is PanelOrder => !!o && typeof (o as PanelOrder).id === 'string' && Array.isArray((o as PanelOrder).lines);

/** Hiç iş günü yokken (ilk kurulum) çekimin durumu: sipariş yazılacak gün yok, liste gün açılınca alınır */
export const NO_DAY_ERROR = 'Gün açılmadı; online siparişler gün açılınca alınır';

/** Planlı siparişi (`scheduledFor`) bar bu kadar önceden görür */
export const PLANNED_LEAD_MS = 30 * 60_000;

/**
 * Online siparişin bar ve uyarı ölçüsü (kalemlerin `sentAt`'ı, uyarının `dueAt`'ı): ödeme anı; planlı siparişte en
 * erken planlı saatten 30 dakika önce. Geceden ödenmiş sabah siparişi bar ekranının, çağrı ekranının ve uyarının
 * penceresinde saatinde görünür; erken ödenmiş sipariş ödendiği anda "gecikti" diye kızarmaz. Para ve iş günü ödeme
 * anından kalır (`openedAt`, `dayId`). Okunamayan saat ödeme anı sayılır.
 */
export function onlineDueAt(paidAt: number, scheduledFor: string | null | undefined): number {
  const at = scheduledFor ? Date.parse(scheduledFor) : Number.NaN;
  return Number.isFinite(at) ? Math.max(paidAt, at - PLANNED_LEAD_MS) : paidAt;
}

function noteNoDay() {
  const s = getSyncState<Record<string, unknown>>('laffogato.orders') ?? {};
  if (s.lastError !== NO_DAY_ERROR) setSyncState('laffogato.orders', { ...s, lastError: NO_DAY_ERROR, lastErrorAt: Date.now() });
}

const hasAnyDay = () => !!db.select({ id: schema.businessDays.id }).from(schema.businessDays).limit(1).get();

/**
 * Sitenin açık siparişleri. `orders` dizisi olmayan 200 (bakım sayfası, ağ geçidi, beklenmeyen gövde) başarısız
 * çekme sayılır: boş liste sanılıp sitede ödenmiş açık siparişler kapatılmasın. `complete: false` (site listeyi kesti,
 * en çok 200 sipariş; laffogato `src/app/api/panel/orders/route.ts`) ya da okunamayan kalem varsa liste eksik
 * sayılır, listede olmayan kapatılmaz; alanı göndermeyen eski site bütün liste sayılır. `version` 1 değilse (site
 * biçimi değiştirdi) liste okunmaz, çekim başarısız olur. Yanındaki `calls` masadan çağrılardır (`parsePanelCalls`;
 * alanı göndermeyen eski sitede null).
 */
export async function fetchPanelOrders(): Promise<{ orders: PanelOrder[]; complete: boolean; calls: PanelCall[] | null }> {
  requireSiteSigned();
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/panel/orders`));
  if (status !== 200) throw new HttpError(502, `Site siparişleri alınamadı (HTTP ${status})`, 'site_orders');
  const body = json as { version?: unknown; orders?: unknown; complete?: unknown; calls?: unknown } | null;
  if (!body || !Array.isArray(body.orders)) throw new HttpError(502, 'Site siparişleri beklenen biçimde gelmedi', 'site_orders');
  // Tanınmayan biçim: liste okunmaz, çekim başarısız sayılır, hiçbir sipariş kapanmaz (alanı göndermeyen eski site tanınır)
  const version = unknownSiteListVersion(body);
  if (version !== null) throw new HttpError(502, `Site siparişleri tanınmayan biçimde (sürüm ${version})`, 'site_orders');
  const orders = body.orders.filter(isPanelOrder);
  return { orders, complete: body.complete !== false && orders.length === body.orders.length, calls: parsePanelCalls(body.calls) };
}

const tableKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');

/** Sitenin masa etiketi (laffogato `orderAlertLabel`): ad "masa" diye başlamıyorsa önüne "Masa " gelir ("S4" → "Masa S4") */
export function siteTableLabel(name: string): string {
  return /^masa(?:\s|\d|$)/.test(tableKey(name)) ? name.trim() : `Masa ${name.trim()}`;
}

type TableRow = typeof schema.tables.$inferSelect;

/**
 * Masa siparişinin masası. Önce Yönetim › Masa planı'ndaki "Sitedeki masa adı" (`siteTableCode`); o alanı boş
 * masalarda yedek olarak yerel masa adı, sitenin etiket kuralıyla ("Masa S4" ↔ "S4"). Büyük-küçük harf ve boşluk
 * farkı gözetilmez; ad birden çok masaya uyuyorsa eşlenmez. Bulunamazsa sipariş masasız kalır (bar ekranında
 * etiketiyle görünür). docs/03-ENTEGRASYON.md §2.3
 */
export function tableForLabel(tables: TableRow[], label: string): TableRow | undefined {
  const want = tableKey(label);
  if (!want) return undefined;
  const byCode = tables.find((x) => x.siteTableCode?.trim() && tableKey(x.siteTableCode) === want);
  if (byCode) return byCode;
  const byName = tables.filter((x) => !x.siteTableCode?.trim() && x.active && x.kind === 'masa' && (tableKey(x.name) === want || tableKey(siteTableLabel(x.name)) === want));
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Masa siparişinin masası: önce masanın QR kodu (`tableCode`, LafPOS'un ürettiği `tables.qrCode`; yazım farkları
 * katlanır), site kodu göndermiyorsa ya da kod tanınmıyorsa etiketle (`tableForLabel`).
 */
export function tableForOrder(tables: TableRow[], o: Pick<PanelOrder, 'label' | 'tableCode'>): TableRow | undefined {
  const code = normalizeTableCode(o.tableCode);
  // Yalnız etkin masa (oda değil): plandan kaldırılmış masanın kodu gelirse sipariş masasız kalır, etiketiyle görünür
  const byQr = code ? tables.find((x) => x.qrCode === code && x.active && x.kind === 'masa') : undefined;
  return byQr ?? tableForLabel(tables, o.label ?? '');
}

/** Detay metnindeki boy önekini atar: "M · yulaf · +1 shot" -> "yulaf · +1 shot" */
function detailText(detail: string, size: string): string {
  const parts = detail.split('·').map((s) => s.trim()).filter(Boolean);
  if (parts[0] && (parts[0] === size || parts[0] === 'M' || parts[0] === 'L')) parts.shift();
  return parts.join(' · ');
}

/**
 * Siteden gelen listeyi yerel adisyonlara işler. Tam listede (`complete`) olmayan açık online sipariş "Siteden
 * kalktı" diye kapanır (`extStage: 'gone'`): sitede tamamlandı, iptal edildi ya da süresi geçti; LafPOS hangisi
 * olduğunu bilmez, servis edildi saymaz. Site listeyi kestiyse (`complete: false`) hiçbiri kapatılmaz. Yerelde
 * kapanmış ama sitede hâlâ açık sipariş yeniden açılır.
 *
 * Kalemin bar istasyonu ürünün ya da kategorisinin istasyonu; ürün LafPOS'ta yoksa (menü henüz eşitlenmedi) ya da
 * kategorisinin istasyonu yoksa barın istasyonu (yoksa mutfak; menü eşitlemesinin kuralı): sitede ödenmiş sipariş bar
 * ekranından ve çağrı ekranından düşmesin. Ürünü ya da istasyonu boş kalmış kalem sonraki çekimlerde yeniden bağlanır.
 * Planlı siparişin kalemleri planlı saatine göre damgalanır (`onlineDueAt`), saat sitede değişince yeniden.
 *
 * `requestedAt`: listenin istendiği an. Liste sitenin o anki hâlidir; yanıt ağdayken LafPOS'ta değişen sipariş
 * (kasada "Teslim edildi", aşama yazımı, araya giren daha yeni bir çekme) bu listeyle geri alınmaz: yeniden
 * açılmaz, kapanmaz, aşaması eskiye dönmez. Sonraki çekme geçerlidir. Verilmezse liste en yeni sayılır.
 *
 * `calls`: listenin masa çağrıları (server/sync/table-calls.ts), aynı işlemde. Hiç iş günü yoksa (ilk kurulum) sipariş
 * yazılmaz, çekim başarılı sayılmaz (`waiting`, Entegrasyon'da "Gün açılmadı"): gün açılınca yeniden çekilir.
 */
export function upsertOnlineOrders(
  list: PanelOrder[],
  complete = true,
  requestedAt = Number.POSITIVE_INFINITY,
  calls: PanelCall[] | null = null,
): { created: number; updated: number; closed: number; waiting?: boolean } {
  const fx = new Effects();
  const result = tx((t) => {
    const tables = t.select().from(schema.tables).all();
    applyTableCalls(t, calls, fx, (c) => tableForOrder(tables, c), requestedAt);
    // Açık gün varsa sipariş onun (kasanın satışları gibi). Gün açık değilken iş günü (05:00 kuralı) ödeme anından:
    // o tarihin günü varsa ona, yoksa geçici olarak son güne yazılır; o tarihin günü açılınca oraya taşınır (openDay)
    const openDay = getOpenDay(t);
    const latest = openDay ?? t.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).get();
    if (!latest) return { created: 0, updated: 0, closed: 0, waiting: true };
    const dayIdFor = (paidAt: number) =>
      openDay?.id ??
      t.select({ id: schema.businessDays.id }).from(schema.businessDays).where(eq(schema.businessDays.date, businessDate(paidAt))).orderBy(desc(schema.businessDays.zNo)).get()?.id ??
      latest.id;
    const products = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
    const categories = new Map(t.select().from(schema.categories).all().map((c) => [c.id, c]));
    const stations = t.select().from(schema.stations).where(eq(schema.stations.active, true)).orderBy(asc(schema.stations.sort)).all();
    const fallbackStation = stations.find((s) => s.kind === 'bar')?.id ?? stations.find((s) => s.kind === 'mutfak')?.id ?? null;
    /** Kalemin ürünü, KDV'si ve istasyonu: ürün LafPOS'ta yoksa ya da istasyonsuzsa barın istasyonu */
    const resolve = (menuItemId: string | null, productId: string | null = null) => {
      const p = (productId ? products.find((x) => x.id === productId) : undefined) ?? (menuItemId ? products.find((x) => x.extId === menuItemId) : undefined);
      const cat = p ? categories.get(p.categoryId) : undefined;
      return { product: p, stationId: p?.stationId ?? cat?.stationId ?? fallbackStation };
    };
    /** Önceki çekimde ürünü ya da istasyonu bulunamamış kalemler (menü sonradan eşitlendi, istasyon sonradan açıldı) */
    const relink = (orderId: string): boolean => {
      const loose = t
        .select()
        .from(schema.orderItems)
        .where(and(eq(schema.orderItems.orderId, orderId), or(isNull(schema.orderItems.productId), isNull(schema.orderItems.stationId))))
        .all();
      let changed = false;
      for (const it of loose) {
        const r = resolve(it.extProductId, it.productId);
        const linkProduct = !it.productId && !!r.product;
        const linkStation = !it.stationId && !!r.stationId;
        if (!linkProduct && !linkStation) continue;
        t.update(schema.orderItems)
          .set({ ...(linkProduct ? { productId: r.product!.id, kdvRate: r.product!.kdvRate } : {}), ...(linkStation ? { stationId: r.stationId } : {}) })
          .where(eq(schema.orderItems.id, it.id))
          .run();
        changed = true;
      }
      return changed;
    };
    let created = 0;
    let updated = 0;
    const seen = new Set<string>();
    const now = Date.now();
    // Liste istendikten sonra yerelde yazıldı (updatedAt her yazımda güncellenir): bu liste ondan eski. Saat geri
    // alınmışsa gelecekte görünen kayıt korunmaz, yoksa saat yetişene dek hiç güncellenmezdi
    const changedSince = (o: { updatedAt: number }) => o.updatedAt >= requestedAt && o.updatedAt <= now;
    for (const o of list) {
      seen.add(o.id);
      const existing = t.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.extId, o.id))).get();
      const table = o.fulfillment === 'table' ? tableForOrder(tables, o) : undefined;
      const status = STAGE_STATUS[o.stage] ?? 'yeni';
      const scheduledFor = o.scheduledFor || null;
      if (existing) {
        if (changedSince(existing)) continue;
        const tableId = table?.id ?? existing.tableId;
        // Sitede hâlâ açık: yerelde kapanmışsa (listeden kalkıp geri geldi, sitede geri alınan iptal gibi; ya da eski
        // sürümün bozuk ya da kesik listesi) yeniden açılır
        const reopen = existing.status === 'kapali';
        // Planlı saat sitede değişti: kalemler yeni saate göre yeniden damgalanır (bar ekranı ve uyarı penceresi)
        const replan = (existing.scheduledFor ?? null) !== scheduledFor;
        let changed = false;
        if (reopen || existing.extStage !== o.stage || existing.tableId !== tableId) {
          t.update(schema.orders)
            .set({ extStage: o.stage, tableId, ...(reopen ? { status: 'acik' as const, closedAt: null } : {}), updatedAt: now })
            .where(eq(schema.orders.id, existing.id))
            .run();
          t.update(schema.orderItems)
            .set({ status, ...(reopen ? { servedAt: null } : {}) })
            .where(eq(schema.orderItems.orderId, existing.id))
            .run();
          fx.emit({ topic: 'orders', kind: 'online.updated', orderId: existing.id, tableId: tableId ?? undefined });
          changed = true;
        }
        if (replan) {
          t.update(schema.orders).set({ scheduledFor, updatedAt: now }).where(eq(schema.orders.id, existing.id)).run();
          t.update(schema.orderItems).set({ sentAt: onlineDueAt(existing.openedAt, scheduledFor) }).where(eq(schema.orderItems.orderId, existing.id)).run();
          changed = true;
        }
        if (relink(existing.id)) {
          t.update(schema.orders).set({ updatedAt: now }).where(eq(schema.orders.id, existing.id)).run();
          changed = true;
        }
        if (changed) {
          updated++;
          // Yalnız saati ya da kalemin bağlantısı değişen sipariş `online.updated` yaymaz: o olay cihazın zilini susturur
          // (aşaması değişti sayılır), sipariş hâlâ "yeni"
          fx.emit({ topic: 'orders', kind: 'online.detail', orderId: existing.id, tableId: tableId ?? undefined });
          fx.emit({ topic: 'kitchen', kind: 'online.updated', orderId: existing.id });
        }
        continue;
      }
      const id = ulid(now);
      const paidAt = Date.parse(o.paidAt) || now;
      const dueAt = onlineDueAt(paidAt, scheduledFor);
      t.insert(schema.orders)
        .values({
          id,
          dayId: dayIdFor(paidAt),
          no: o.orderNo,
          type: 'online',
          status: 'acik',
          tableId: table?.id ?? null,
          guests: 1,
          note: o.note || null,
          openedAt: paidAt,
          source: 'laffogato',
          extId: o.id,
          extNo: o.orderNo,
          extStage: o.stage,
          extFulfillment: o.fulfillment,
          extLabel: o.label,
          extPaid: true,
          extTotal: o.totalMinor,
          scheduledFor,
          deliveryName: o.firstName || null,
          updatedAt: now,
        })
        .run();
      o.lines.forEach((l, i) => {
        const r = resolve(l.menuItemId);
        const size = l.size === 'L' ? 'L' : l.size === 'M' ? 'M' : 'TEK';
        t.insert(schema.orderItems)
          .values({
            id: ulid(now + i),
            orderId: id,
            productId: r.product?.id ?? null,
            name: l.name,
            size,
            optionsText: detailText(l.detail, l.size),
            qty: l.qty,
            unitPrice: 0,
            basePrice: 0,
            kdvRate: r.product?.kdvRate ?? 10,
            note: l.note || null,
            stationId: r.stationId,
            status,
            batch: 1,
            sentAt: dueAt,
            extProductId: l.menuItemId,
            createdAt: now,
          })
          .run();
      });
      created++;
      fx.emit({ topic: 'orders', kind: 'online.new', orderId: id, tableId: table?.id, message: `Online sipariş: ${o.label} · ${o.firstName}` });
      fx.emit({ topic: 'kitchen', kind: 'ticket.new', orderId: id, message: 'online' });
    }
    let closed = 0;
    // Kesik listede (complete: false) olmayan sipariş yine açık olabilir: hiçbiri kapatılmaz
    if (complete) {
      const open = t.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.status, 'acik'))).all();
      for (const o of open) {
        // Liste istendikten sonra gelen ya da değişen sipariş eski listede olmayabilir
        if (seen.has(o.extId!) || changedSince(o)) continue;
        t.update(schema.orders).set({ status: 'kapali', extStage: 'gone', closedAt: now, updatedAt: now }).where(eq(schema.orders.id, o.id)).run();
        // Bar ve çağrı ekranından düşer; servis zamanı yazılmaz (servis edildiği bilinmiyor)
        t.update(schema.orderItems)
          .set({ status: 'servis' })
          .where(and(eq(schema.orderItems.orderId, o.id), inArray(schema.orderItems.status, ['yeni', 'hazirlaniyor', 'hazir'])))
          .run();
        fx.audit(t, { action: 'online.gone', orderId: o.id, message: `Online sipariş #${o.extNo ?? o.no} siteden kalktı (sitede tamamlandı, iptal edildi ya da süresi geçti)` });
        closed++;
        // Metin cihazlarda sakin bir ses ve bildirimle görünür (src/components/SiteInbox.tsx): yalnız sipariş numarası
        fx.emit({ topic: 'orders', kind: 'online.done', orderId: o.id, tableId: o.tableId ?? undefined, message: `Online sipariş #${o.extNo ?? o.no} siteden kalktı` });
        fx.emit({ topic: 'kitchen', kind: 'online.done', orderId: o.id });
      }
    }
    return { created, updated, closed };
  });
  fx.emit({ topic: 'tables', kind: 'online.sync' });
  fx.flush();
  if (result.waiting) noteNoDay();
  else setSyncState('laffogato.orders', { ...(getSyncState<Record<string, unknown>>('laffogato.orders') ?? {}), lastSuccessAt: Date.now(), lastError: null, count: list.length, complete });
  return result;
}

export async function syncOnlineOrders() {
  try {
    // İstek gitmeden önceki an: yanıt beklenirken yerelde olan değişiklik listeden yenidir
    const requestedAt = Date.now();
    const { orders, complete, calls } = await fetchPanelOrders();
    return upsertOnlineOrders(orders, complete, requestedAt, calls);
  } catch (e) {
    setSyncState('laffogato.orders', { ...(getSyncState<Record<string, unknown>>('laffogato.orders') ?? {}), lastError: e instanceof Error ? e.message : String(e), lastErrorAt: Date.now() });
    throw e;
  }
}

/** Siteye aşama yazar: preparing (hazırlanıyor), ready (hazır / masaya götürüldü / kuryeye verildi), delivered (gel-al teslim) */
export async function setOnlineStage(orderId: string, action: 'preparing' | 'ready' | 'delivered', actorName: string) {
  requireSiteSigned();
  const o = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!o || o.source !== 'laffogato' || !o.extId) throw notFound('Online sipariş');
  const from = o.extStage === 'done' ? 'ready' : (o.extStage ?? 'new');
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/orders/stage`), {
    id: o.extId,
    action,
    from,
    actor: actorName.slice(0, 80),
  });
  if (status === 409) {
    await syncOnlineOrders().catch(() => undefined);
    throw conflict('Sipariş bu arada sitede değişti; ekran yenilendi', 'stale');
  }
  // Sitede yok ya da artık bar ekranı siparişi değil (iptal, iade): liste yeniden çekilir, sipariş "Siteden kalktı" kapanır
  if (status === 404) {
    await syncOnlineOrders().catch(() => undefined);
    throw new HttpError(404, 'Sipariş sitede bulunamadı; liste yenilendi', 'site_not_found');
  }
  if (status !== 200) throw new HttpError(502, `Site aşamayı kabul etmedi (HTTP ${status})`, 'site_stage');
  const next = (json as { order?: PanelOrder | null })?.order ?? null;
  const fx = new Effects();
  tx((t) => {
    const now = Date.now();
    if (next) {
      t.update(schema.orders).set({ extStage: next.stage, updatedAt: now }).where(eq(schema.orders.id, o.id)).run();
      t.update(schema.orderItems).set({ status: STAGE_STATUS[next.stage] }).where(eq(schema.orderItems.orderId, o.id)).run();
    } else {
      t.update(schema.orders).set({ status: 'kapali', extStage: 'done', closedAt: now, updatedAt: now }).where(eq(schema.orders.id, o.id)).run();
      t.update(schema.orderItems).set({ status: 'servis', servedAt: now }).where(eq(schema.orderItems.orderId, o.id)).run();
    }
    fx.audit(t, { action: 'online.stage', orderId: o.id, message: `${actorName}: online sipariş #${o.extNo} → ${action}` });
  });
  fx.emit({ topic: 'orders', kind: 'online.stage', orderId: o.id, tableId: o.tableId ?? undefined });
  fx.emit({ topic: 'kitchen', kind: 'online.stage', orderId: o.id });
  fx.emit({ topic: 'tables', kind: 'online.stage', tableId: o.tableId ?? undefined });
  fx.flush();
}

/** `kuyrukta`: siteye ulaşılamadı (internet yok, site 5xx/429); yazım giden kutusunda, internet gelince gider */
export type SiteWrite = 'guncellendi' | 'bagli_degil' | 'anahtar_yok' | 'baglanti_yok' | 'kuyrukta';
type ProductRow = typeof schema.products.$inferSelect;

/**
 * Siteye bağlı üründe Satışta bilgisini siteye yazar (site Satışta bilgisinin sahibi). 2xx gelmezse ya da siteye
 * ulaşılamazsa 502 atar: çağıran yerelde de değiştirmez. Bağlı değilse, adres ya da anahtar yoksa istek gitmez,
 * sonuç bunu söyler.
 */
export async function writeSiteAvailability(p: Pick<ProductRow, 'extSource' | 'extId'>, active: boolean, actorName: string, opts: { queueOffline?: boolean } = {}): Promise<SiteWrite> {
  if (p.extSource !== 'laffogato' || !p.extId) return 'bagli_degil';
  if (!siteLinked()) return 'baglanti_yok';
  if (!configured()) return 'anahtar_yok';
  const res = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), { id: p.extId, isActive: active, actor: actorName.slice(0, 80) }).catch(() => null);
  // İnternet yok ya da site geçici olarak yanıt vermiyor: çağıran isterse yazım kuyruğa girer (kalıcı ret girmez)
  const offline = !res || res.status >= 500 || res.status === 429;
  if (offline && opts.queueOffline) return 'kuyrukta';
  if (!res) throw new HttpError(502, "Siteye ulaşılamadı; LafPOS'ta da değiştirilmedi. İnternet gelince yeniden deneyin", 'site_menu');
  if (res.status !== 200) throw new HttpError(502, `Site Satışta bilgisini kabul etmedi (HTTP ${res.status}); LafPOS'ta da değiştirilmedi`, 'site_menu');
  return 'guncellendi';
}

/**
 * Ürünü Tükendi / Satışa açık yapar. Siteye bağlı üründe önce site güncellenir, 2xx gelince yerelde kaydedilir.
 * Anahtar yoksa yalnız LafPOS'ta değişir ve bu bildirilir. Açılan ürünün bekleyen Tükendi yazımı giden kutusundan düşer.
 * Tükendi kilidi: sitenin kapattığı ürünü ("Sitede satışta değil", `soldOutBy = 'site'`) kasiyer açamaz; menü
 * yetkisi olan (`manager`) açar, denetim kaydına "sitede kapatılmıştı" diye düşer.
 */
export function setAvailability(productId: string, active: boolean, actor: { name: string; manager: boolean }): Promise<{ site: SiteWrite }> {
  return withSiteMenuLock(async () => {
    const p = db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
    if (!p) throw notFound('Ürün');
    const siteClosed = active && !p.active && p.soldOutBy === 'site';
    if (siteClosed && !actor.manager) throw new HttpError(403, `${p.name} sitede satışta değil; yalnız menü yetkisi olan biri satışa açabilir`, 'site_closed');
    // İnternet kesikken elle Tükendi / Satışa aç beklemez: yerelde hemen geçerli, siteye giden kutusundan gider
    const site = await writeSiteAvailability(p, active, actor.name, { queueOffline: true });
    const fx = new Effects();
    tx((t) => {
      t.update(schema.products)
        .set({ active, soldOutBy: active ? null : 'lafpos', portionsLeft: active && p.portionsLeft === 0 ? null : p.portionsLeft, updatedAt: Date.now() })
        .where(eq(schema.products.id, productId))
        .run();
      // Kuyruktaki yazım aynı ürünün bekleyen yazımının yerini alır; doğrudan yazıldıysa açılan ürünün bekleyeni düşer
      if (site === 'kuyrukta') enqueueSiteAvailability(t, p, active, actor.name);
      else if (active) dropSiteSoldOut(t, p.extId);
      fx.audit(t, {
        action: active ? 'product.available' : 'product.sold_out',
        entity: 'product',
        entityId: productId,
        message: `${actor.name}: ${p.name} ${active ? 'satışa açıldı' : 'tükendi'}${siteClosed ? ' (sitede kapatılmıştı)' : ''}${site === 'guncellendi' ? ' (site ve uygulama da güncellendi)' : site === 'kuyrukta' ? ' (site: kuyrukta)' : ''}`,
      });
    });
    fx.emit({ topic: 'menu', kind: active ? 'product.available' : 'product.sold_out' });
    if (site === 'guncellendi') fx.emit({ topic: 'sync', kind: 'site.menu.written' });
    fx.flush();
    return { site };
  });
}

/**
 * Porsiyonu doldurulan kapalı ürünü açar: siteye bağlıysa önce site (2xx gelmezse 502, yerelde de değişmez), sonra
 * çağıranın yerel yazımı (`apply`, tek işlem). Yalnız yerelde açılan ürünü sitenin sonraki senkronu yeniden kapatırdı.
 */
export function reopenWithSite<T>(p: ProductRow, actorName: string, apply: (site: SiteWrite) => T): Promise<T> {
  return withSiteMenuLock(async () => {
    const site = await writeSiteAvailability(p, true, actorName);
    const result = apply(site);
    if (site === 'guncellendi') {
      const fx = new Effects();
      fx.emit({ topic: 'sync', kind: 'site.menu.written' });
      fx.flush();
    }
    return result;
  });
}

// ─── Zamanlayıcı ────────────────────────────────────────────────────────────

/**
 * Sürüm sinyali çalışırken de, gün açıkken en geç bu aralıkla tam çekim: sinyali kaçan bir değişiklik ya da süresi
 * dolup listeden sessizce düşen sipariş (sitede yazım olmaz, sinyal değişmez) kalmasın. Gece (açık gün yokken)
 * yalnız sinyal sorulur: sinyal sitenin veritabanına gitmez, güvenlik çekimi giderdi.
 */
export const ORDERS_SAFETY_PULL_MS = 15 * 60_000;
/** Sinyal yokken (eski site) tam çekim aralığı: imzalı uçlara 5 dakikadan sık otomatik istek yok (AGENTS.md kural 6) */
const ORDERS_FALLBACK_PULL_MS = 5 * 60_000;
/** Başarısız çekimden sonra yeniden deneme: ilki bir sonraki turda (20 sn), sonra katlanarak, en çok 5 dk arayla */
const RETRY_FIRST_MS = 20_000;
/**
 * Gece (açık gün yokken) tur en sık bu aralıkla: sinyal 20 sn yerine 3 dakikada bir sorulur (kasa bilgisayarı ve site
 * gece boşuna çalışmasın). Gün açılınca hemen ve yeniden 20 sn'de bir (`onlineOrdersDayOpened`)
 */
export const NIGHT_TICK_MS = 3 * 60_000;

let lastVersion: string | null = null;
/** Sitenin menü işareti (`menu`; laffogato pub:menu): değişince fiyat ya da Satışta sitede değişti, menü hemen eşitlenir */
let lastMenuMarker: string | null = null;
let versionSupported = true;
let lastFullPull = 0;
let pullFailures = 0;
let retryAt = 0;
/** Son turun anı (gece seyrekliği için) */
let lastTick = 0;
/** Gün açıldı: sonraki tur sinyal değişmemiş olsa da bir kez çeker */
let pullSoon = false;
let inflight: Promise<void> | null = null;

/** Testler için: zamanlayıcının belleğini sıfırlar */
export function resetOnlineTimer() {
  lastVersion = null;
  versionSupported = true;
  lastFullPull = 0;
  pullFailures = 0;
  retryAt = 0;
  lastTick = 0;
  pullSoon = false;
}

/**
 * Tam çekim. Sürüm yalnız çekim başarılıysa ve siparişler bir güne yazılabildiyse kaydedilir: başarısız çekim ya da
 * hiç iş günü yokken gelen liste sonraki turda yeniden denenir, sipariş kaybolmaz
 */
async function pull(now: number, version: string | null) {
  lastFullPull = now;
  pullSoon = false;
  let waiting = false;
  try {
    waiting = !!(await syncOnlineOrders()).waiting;
  } catch (e) {
    pullFailures++;
    retryAt = now + Math.min(ORDERS_FALLBACK_PULL_MS, RETRY_FIRST_MS * 2 ** (pullFailures - 1));
    throw e;
  }
  pullFailures = 0;
  retryAt = 0;
  if (version && !waiting) lastVersion = version;
}

/**
 * 20 sn'de bir çağrılır. Sürüm sinyali varsa değişince çeker (gece de: sinyal veritabanına gitmez), gün açıkken
 * ayrıca 15 dk'da bir güvenlik çekimi yapar; sinyal yoksa en çok 5 dk'da bir çeker. Gece (açık gün yokken) tur en sık
 * 3 dakikada bir. Hiç iş günü yokken (ilk kurulum) istek gitmez: sipariş yazılacak gün yok, durum "Gün açılmadı" der,
 * gün açılınca çekilir. Aynı sinyal karaoke işaretini de taşır: "Online siparişleri çek" kapalıyken sipariş çekilmez ama
 * sinyal, sitedeki karaoke rezervasyonları için gün açıkken okunmaya devam eder (§2.4; sinyal sitenin veritabanına
 * gitmez, kural 6'nın istisnası). Menü işareti için de: menü otomatik eşitleniyorsa gün açıkken okunur. Masa çağrıları
 * sipariş listesiyle gelir (`calls`): ayrı istek yok.
 */
export function onlineOrdersTick(): Promise<void> {
  if (!configured()) return Promise.resolve();
  const ordersOn = getSettings().onlineOrdersSync;
  const dayOpen = !!getOpenDay(db);
  // Menü işareti de bu sinyalle gelir: online sipariş ve karaoke kapalı olsa da gün açıkken menü otomatik eşitleniyorsa
  // okunur, sitede değişen fiyat 15 dakikalık yoklamayı beklemez (sinyal sitenin veritabanına gitmez, kural 6 istisnası)
  const menuWatch = getSettings().menuAutoSync && dayOpen;
  if (!ordersOn && !(siteKaraokeOn() && dayOpen) && !menuWatch) return Promise.resolve();
  if (inflight) return inflight;
  const now = Date.now();
  if (!dayOpen && now - lastTick < NIGHT_TICK_MS) return Promise.resolve();
  if (!hasAnyDay()) {
    noteNoDay();
    return Promise.resolve();
  }
  lastTick = now;
  inflight = (async () => {
    // Aynı yanıttaki karaoke işareti (laffogato F1; eski sitede yok): sipariş çekimi başarısız olsa da karaokeye gider
    let karaoke: unknown;
    try {
      if (versionSupported) {
        const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/pos/orders/version`));
        const v = (json as { version?: unknown } | null)?.version;
        if (status === 200) {
          karaoke = (json as { karaoke?: unknown } | null)?.karaoke;
          // Menü işareti (eski sitede yok): sitede ya da panelde fiyat / Satışta değişince 15 dk'lık yoklama beklenmez
          const menu = (json as { menu?: unknown } | null)?.menu;
          if (typeof menu === 'string' && menu) {
            if (lastMenuMarker !== null && menu !== lastMenuMarker) new Effects().emit({ topic: 'sync', kind: 'site.menu.changed' }).flush();
            lastMenuMarker = menu;
          }
        }
        if (status === 404) versionSupported = false;
        else if (status === 200 && typeof v === 'string' && v) {
          const safety = now - lastFullPull >= ORDERS_SAFETY_PULL_MS && dayOpen;
          if (ordersOn && (v !== lastVersion || safety || pullSoon) && now >= retryAt) await pull(now, v);
          return;
        }
        // Sinyal okunamadı (5xx, bozuk gövde): 5 dk'lık yedek çekmeye düşer
      }
      if (ordersOn && (now - lastFullPull >= ORDERS_FALLBACK_PULL_MS || pullSoon) && now >= retryAt) await pull(now, null);
    } catch (e) {
      console.warn('[online] siparişler alınamadı:', e instanceof Error ? e.message : e);
    } finally {
      // Karaoke: işaret değişince ya da iş günü dönünce, en sık 5 dakikada bir (asla atmaz)
      await siteKaraokeTick(karaoke, now);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Gün açıldı ya da yeniden açıldı (server/routes/cash.ts): gecenin seyrek turu biter, bir tur hemen döner ve sinyal
 * değişmemiş olsa da bir kez çeker (gün yokken bekleyen siparişler, gece gelen çağrılar). Kullanıcı eylemiyle tek
 * istek; zamanlayıcı kapalıyken (`LAFPOS_NO_JOBS`, testler) hiçbir şey yapmaz.
 */
export function onlineOrdersDayOpened(): Promise<void> {
  if (process.env.LAFPOS_NO_JOBS === '1' || !configured() || !getSettings().onlineOrdersSync) return Promise.resolve();
  lastTick = 0;
  pullSoon = true;
  return onlineOrdersTick();
}

/** "Yenile" düğmesi: en sık 30 sn'de bir gerçek çekme */
export async function refreshOnlineOrders() {
  requireSiteSigned();
  const now = Date.now();
  if (now - lastFullPull < 30_000) return { skipped: true };
  lastFullPull = now;
  return syncOnlineOrders();
}

/**
 * Cihazların çalacağı online siparişler (`GET /api/sync/alerts`, src/components/SiteInbox.tsx): açık, sitede hâlâ "yeni"
 * aşamada (bar başlamadı) ve ödemesi son 4 saatte; planlı sipariş planlı saatinden 30 dakika öncesinden 4 saat sonrasına
 * dek (`dueAt`, `onlineDueAt`). Yalnız yerel veritabanını okur, siteye istek atmaz; liste var olan sipariş çekiminden
 * gelir (§2.3). Site bağlantısı yoksa boş.
 */
export function onlineAlertsView(now = Date.now()): OnlineAlertDTO[] {
  if (!configured()) return [];
  const since = now - ONLINE_ALERT_MAX_AGE_MS;
  return db
    .select({
      id: schema.orders.id,
      no: schema.orders.no,
      extNo: schema.orders.extNo,
      label: schema.orders.extLabel,
      fulfillment: schema.orders.extFulfillment,
      tableId: schema.orders.tableId,
      openedAt: schema.orders.openedAt,
      scheduledFor: schema.orders.scheduledFor,
    })
    .from(schema.orders)
    .where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.status, 'acik'), eq(schema.orders.extStage, 'new'), or(gte(schema.orders.openedAt, since), isNotNull(schema.orders.scheduledFor))))
    .orderBy(asc(schema.orders.openedAt))
    .all()
    .map((o) => ({ orderId: o.id, no: o.extNo ?? o.no, label: o.label ?? '', table: o.fulfillment === 'table', tableId: o.tableId, openedAt: o.openedAt, dueAt: onlineDueAt(o.openedAt, o.scheduledFor), scheduledFor: o.scheduledFor }))
    .filter((o) => o.dueAt >= since);
}

export function onlineStatus() {
  return {
    configured: configured(),
    enabled: getSettings().onlineOrdersSync,
    versionSignal: versionSupported,
    state: getSyncState<Record<string, unknown>>('laffogato.orders'),
    open: configured()
      ? db.select({ n: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), inArray(schema.orders.status, ['acik']))).all().length
      : 0,
    /** Siteye bildirilemeyen ya da sitenin reddettiği Satışta yazımları (porsiyon sayacı; giden kutusu) */
    soldOutPush: siteOutboxStatus(),
    /** Masa QR kodlarının siteye gidişi (docs/03-ENTEGRASYON.md §2.3 "Masa QR"); anahtar yokken null */
    tablesPush: siteTablesPushStatus(),
  };
}
