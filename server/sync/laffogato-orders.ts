import { and, desc, eq, inArray } from 'drizzle-orm';
import { businessDate } from '@shared/time';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { siteKaraokeTick } from './laffogato-karaoke';
import { requireSiteSigned, siteLinked, siteSigned } from './laffogato-link';
import { dropSiteSoldOut, siteOutboxStatus, withSiteMenuLock } from './site-outbox';

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

/**
 * Sitenin açık siparişleri. `orders` dizisi olmayan 200 (bakım sayfası, ağ geçidi, beklenmeyen gövde) başarısız
 * çekme sayılır: boş liste sanılıp sitede ödenmiş açık siparişler kapatılmasın. `complete: false` (site listeyi kesti,
 * en çok 200 sipariş; laffogato `src/app/api/panel/orders/route.ts`) ya da okunamayan kalem varsa liste eksik
 * sayılır, listede olmayan kapatılmaz; alanı göndermeyen eski site bütün liste sayılır.
 */
export async function fetchPanelOrders(): Promise<{ orders: PanelOrder[]; complete: boolean }> {
  requireSiteSigned();
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/panel/orders`));
  if (status !== 200) throw new HttpError(502, `Site siparişleri alınamadı (HTTP ${status})`, 'site_orders');
  const body = json as { orders?: unknown; complete?: unknown } | null;
  if (!body || !Array.isArray(body.orders)) throw new HttpError(502, 'Site siparişleri beklenen biçimde gelmedi', 'site_orders');
  const orders = body.orders.filter(isPanelOrder);
  return { orders, complete: body.complete !== false && orders.length === body.orders.length };
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
 * `requestedAt`: listenin istendiği an. Liste sitenin o anki hâlidir; yanıt ağdayken LafPOS'ta değişen sipariş
 * (kasada "Teslim edildi", aşama yazımı, araya giren daha yeni bir çekme) bu listeyle geri alınmaz: yeniden
 * açılmaz, kapanmaz, aşaması eskiye dönmez. Sonraki çekme geçerlidir. Verilmezse liste en yeni sayılır.
 */
export function upsertOnlineOrders(list: PanelOrder[], complete = true, requestedAt = Number.POSITIVE_INFINITY): { created: number; updated: number; closed: number } {
  const fx = new Effects();
  const result = tx((t) => {
    // Açık gün varsa sipariş onun (kasanın satışları gibi). Gün açık değilken iş günü (05:00 kuralı) ödeme anından:
    // o tarihin günü varsa ona, yoksa geçici olarak son güne yazılır; o tarihin günü açılınca oraya taşınır (openDay)
    const openDay = getOpenDay(t);
    const latest = openDay ?? t.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).get();
    if (!latest) return { created: 0, updated: 0, closed: 0 };
    const dayIdFor = (paidAt: number) =>
      openDay?.id ??
      t.select({ id: schema.businessDays.id }).from(schema.businessDays).where(eq(schema.businessDays.date, businessDate(paidAt))).orderBy(desc(schema.businessDays.zNo)).get()?.id ??
      latest.id;
    const products = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
    const categories = new Map(t.select().from(schema.categories).all().map((c) => [c.id, c]));
    const tables = t.select().from(schema.tables).all();
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
      const table = o.fulfillment === 'table' ? tableForLabel(tables, o.label ?? '') : undefined;
      const status = STAGE_STATUS[o.stage] ?? 'yeni';
      if (existing) {
        if (changedSince(existing)) continue;
        const tableId = table?.id ?? existing.tableId;
        // Sitede hâlâ açık: yerelde kapanmışsa (listeden kalkıp geri geldi, sitede geri alınan iptal gibi; ya da eski
        // sürümün bozuk ya da kesik listesi) yeniden açılır
        const reopen = existing.status === 'kapali';
        if (reopen || existing.extStage !== o.stage || existing.tableId !== tableId) {
          t.update(schema.orders)
            .set({ extStage: o.stage, tableId, ...(reopen ? { status: 'acik' as const, closedAt: null } : {}), updatedAt: now })
            .where(eq(schema.orders.id, existing.id))
            .run();
          t.update(schema.orderItems)
            .set({ status, ...(reopen ? { servedAt: null } : {}) })
            .where(eq(schema.orderItems.orderId, existing.id))
            .run();
          updated++;
          fx.emit({ topic: 'orders', kind: 'online.updated', orderId: existing.id, tableId: tableId ?? undefined });
          fx.emit({ topic: 'kitchen', kind: 'online.updated', orderId: existing.id });
        }
        continue;
      }
      const id = ulid(now);
      const paidAt = Date.parse(o.paidAt) || now;
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
          scheduledFor: o.scheduledFor || null,
          deliveryName: o.firstName || null,
          updatedAt: now,
        })
        .run();
      o.lines.forEach((l, i) => {
        const p = products.find((x) => x.extId === l.menuItemId);
        const cat = p ? categories.get(p.categoryId) : undefined;
        const size = l.size === 'L' ? 'L' : l.size === 'M' ? 'M' : 'TEK';
        t.insert(schema.orderItems)
          .values({
            id: ulid(now + i),
            orderId: id,
            productId: p?.id ?? null,
            name: l.name,
            size,
            optionsText: detailText(l.detail, l.size),
            qty: l.qty,
            unitPrice: 0,
            basePrice: 0,
            kdvRate: p?.kdvRate ?? 10,
            note: l.note || null,
            stationId: p?.stationId ?? cat?.stationId ?? null,
            status,
            batch: 1,
            sentAt: paidAt,
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
        fx.emit({ topic: 'orders', kind: 'online.done', orderId: o.id, tableId: o.tableId ?? undefined });
        fx.emit({ topic: 'kitchen', kind: 'online.done', orderId: o.id });
      }
    }
    return { created, updated, closed };
  });
  fx.emit({ topic: 'tables', kind: 'online.sync' });
  fx.flush();
  setSyncState('laffogato.orders', { ...(getSyncState<Record<string, unknown>>('laffogato.orders') ?? {}), lastSuccessAt: Date.now(), lastError: null, count: list.length, complete });
  return result;
}

export async function syncOnlineOrders() {
  try {
    // İstek gitmeden önceki an: yanıt beklenirken yerelde olan değişiklik listeden yenidir
    const requestedAt = Date.now();
    const { orders, complete } = await fetchPanelOrders();
    return upsertOnlineOrders(orders, complete, requestedAt);
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

export type SiteWrite = 'guncellendi' | 'bagli_degil' | 'anahtar_yok' | 'baglanti_yok';
type ProductRow = typeof schema.products.$inferSelect;

/**
 * Siteye bağlı üründe Satışta bilgisini siteye yazar (site Satışta bilgisinin sahibi). 2xx gelmezse ya da siteye
 * ulaşılamazsa 502 atar: çağıran yerelde de değiştirmez. Bağlı değilse, adres ya da anahtar yoksa istek gitmez,
 * sonuç bunu söyler.
 */
export async function writeSiteAvailability(p: Pick<ProductRow, 'extSource' | 'extId'>, active: boolean, actorName: string): Promise<SiteWrite> {
  if (p.extSource !== 'laffogato' || !p.extId) return 'bagli_degil';
  if (!siteLinked()) return 'baglanti_yok';
  if (!configured()) return 'anahtar_yok';
  const { status } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), { id: p.extId, isActive: active, actor: actorName.slice(0, 80) }).catch(() => {
    throw new HttpError(502, "Siteye ulaşılamadı; LafPOS'ta da değiştirilmedi. İnternet gelince yeniden deneyin", 'site_menu');
  });
  if (status !== 200) throw new HttpError(502, `Site Satışta bilgisini kabul etmedi (HTTP ${status}); LafPOS'ta da değiştirilmedi`, 'site_menu');
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
    const site = await writeSiteAvailability(p, active, actor.name);
    const fx = new Effects();
    tx((t) => {
      t.update(schema.products)
        .set({ active, soldOutBy: active ? null : 'lafpos', portionsLeft: active && p.portionsLeft === 0 ? null : p.portionsLeft, updatedAt: Date.now() })
        .where(eq(schema.products.id, productId))
        .run();
      if (active) dropSiteSoldOut(t, p.extId);
      fx.audit(t, {
        action: active ? 'product.available' : 'product.sold_out',
        entity: 'product',
        entityId: productId,
        message: `${actor.name}: ${p.name} ${active ? 'satışa açıldı' : 'tükendi'}${siteClosed ? ' (sitede kapatılmıştı)' : ''}${site === 'guncellendi' ? ' (site ve uygulama da güncellendi)' : ''}`,
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

let lastVersion: string | null = null;
let versionSupported = true;
let lastFullPull = 0;
let pullFailures = 0;
let retryAt = 0;
let inflight: Promise<void> | null = null;

/** Testler için: zamanlayıcının belleğini sıfırlar */
export function resetOnlineTimer() {
  lastVersion = null;
  versionSupported = true;
  lastFullPull = 0;
  pullFailures = 0;
  retryAt = 0;
}

/** Tam çekim. Sürüm yalnız çekim başarılıysa kaydedilir: başarısız çekim sonraki turda yeniden denenir, sipariş kaybolmaz */
async function pull(now: number, version: string | null) {
  lastFullPull = now;
  try {
    await syncOnlineOrders();
  } catch (e) {
    pullFailures++;
    retryAt = now + Math.min(ORDERS_FALLBACK_PULL_MS, RETRY_FIRST_MS * 2 ** (pullFailures - 1));
    throw e;
  }
  pullFailures = 0;
  retryAt = 0;
  if (version) lastVersion = version;
}

/**
 * 20 sn'de bir çağrılır. Sürüm sinyali varsa değişince çeker (gece de: sinyal veritabanına gitmez), gün açıkken
 * ayrıca 15 dk'da bir güvenlik çekimi yapar; sinyal yoksa en çok 5 dk'da bir çeker.
 */
export function onlineOrdersTick(): Promise<void> {
  if (!configured() || !getSettings().onlineOrdersSync) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    const now = Date.now();
    // Aynı yanıttaki karaoke işareti (laffogato F1; eski sitede yok): sipariş çekimi başarısız olsa da karaokeye gider
    let karaoke: unknown;
    try {
      if (versionSupported) {
        const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/pos/orders/version`));
        const v = (json as { version?: unknown } | null)?.version;
        if (status === 200) karaoke = (json as { karaoke?: unknown } | null)?.karaoke;
        if (status === 404) versionSupported = false;
        else if (status === 200 && typeof v === 'string' && v) {
          const safety = now - lastFullPull >= ORDERS_SAFETY_PULL_MS && !!getOpenDay(db);
          if ((v !== lastVersion || safety) && now >= retryAt) await pull(now, v);
          return;
        }
        // Sinyal okunamadı (5xx, bozuk gövde): 5 dk'lık yedek çekmeye düşer
      }
      if (now - lastFullPull >= ORDERS_FALLBACK_PULL_MS && now >= retryAt) await pull(now, null);
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

/** "Yenile" düğmesi: en sık 30 sn'de bir gerçek çekme */
export async function refreshOnlineOrders() {
  requireSiteSigned();
  const now = Date.now();
  if (now - lastFullPull < 30_000) return { skipped: true };
  lastFullPull = now;
  return syncOnlineOrders();
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
  };
}
