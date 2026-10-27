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

const configured = () => env.laffogatoPanelSecret.length >= 32;

const STAGE_STATUS: Record<PanelOrder['stage'], 'yeni' | 'hazirlaniyor' | 'hazir'> = { new: 'yeni', preparing: 'hazirlaniyor', ready: 'hazir' };

const isPanelOrder = (o: unknown): o is PanelOrder => !!o && typeof (o as PanelOrder).id === 'string' && Array.isArray((o as PanelOrder).lines);

/**
 * Sitenin açık siparişleri. `orders` dizisi olmayan 200 (bakım sayfası, ağ geçidi, beklenmeyen gövde) başarısız
 * çekme sayılır: boş liste sanılıp sitede ödenmiş açık siparişler kapatılmasın. `complete: false` (sitenin
 * sınırını aşan kesik liste) ya da okunamayan kalem varsa liste eksik sayılır, listede olmayan kapatılmaz.
 */
export async function fetchPanelOrders(): Promise<{ orders: PanelOrder[]; complete: boolean }> {
  if (!configured()) throw new HttpError(409, 'Site bağlantı anahtarı tanımlı değil (LAFFOGATO_SYNC_SECRET)', 'not_configured');
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/panel/orders`));
  if (status !== 200) throw new HttpError(502, `Site siparişleri alınamadı (HTTP ${status})`, 'site_orders');
  const body = json as { orders?: unknown; complete?: unknown } | null;
  if (!body || !Array.isArray(body.orders)) throw new HttpError(502, 'Site siparişleri beklenen biçimde gelmedi', 'site_orders');
  const orders = body.orders.filter(isPanelOrder);
  return { orders, complete: body.complete !== false && orders.length === body.orders.length };
}

/** Detay metnindeki boy önekini atar: "M · yulaf · +1 shot" -> "yulaf · +1 shot" */
function detailText(detail: string, size: string): string {
  const parts = detail.split('·').map((s) => s.trim()).filter(Boolean);
  if (parts[0] && (parts[0] === size || parts[0] === 'M' || parts[0] === 'L')) parts.shift();
  return parts.join(' · ');
}

const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');

/**
 * Masa siparişinin masası: önce sitenin masa kodu (`siteTableCode`), yoksa etiketteki masa adı ("S2", "Masa 4"
 * ya da "Masa S2"); ad birden çok masaya uyuyorsa eşlenmez. docs/03-ENTEGRASYON.md §2.3
 */
function tableFor<T extends { name: string; kind: string; active: boolean; siteTableCode: string | null }>(tables: T[], label: string): T | undefined {
  const l = fold(label);
  const byCode = tables.find((x) => x.siteTableCode && fold(x.siteTableCode) === l);
  if (byCode) return byCode;
  const bare = l.replace(/^masa\s*/, '');
  const byName = tables.filter((x) => x.active && x.kind === 'masa' && (fold(x.name) === l || fold(x.name) === bare));
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Siteden gelen listeyi yerel adisyonlara işler; tam listede (`complete`) olmayan açık online siparişler
 * tamamlanmış sayılır. Yerelde kapanmış ama sitede hâlâ açık sipariş yeniden açılır.
 */
export function upsertOnlineOrders(list: PanelOrder[], complete = true): { created: number; updated: number; closed: number } {
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
    for (const o of list) {
      seen.add(o.id);
      const existing = t.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.extId, o.id))).get();
      const table = o.fulfillment === 'table' ? tableFor(tables, o.label ?? '') : undefined;
      const status = STAGE_STATUS[o.stage] ?? 'yeni';
      if (existing) {
        const tableId = table?.id ?? existing.tableId;
        // Sitede hâlâ açık: yerelde kapanmışsa (eski sürümün bozuk ya da kesik listesi) yeniden açılır
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
    // Kesik listede olmayan sipariş bitmiş sayılamaz
    const open = complete ? t.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.status, 'acik'))).all() : [];
    let closed = 0;
    for (const o of open) {
      if (seen.has(o.extId!)) continue;
      t.update(schema.orders).set({ status: 'kapali', extStage: 'done', closedAt: now, updatedAt: now }).where(eq(schema.orders.id, o.id)).run();
      t.update(schema.orderItems).set({ status: 'servis', servedAt: now }).where(eq(schema.orderItems.orderId, o.id)).run();
      closed++;
      fx.emit({ topic: 'orders', kind: 'online.done', orderId: o.id, tableId: o.tableId ?? undefined });
      fx.emit({ topic: 'kitchen', kind: 'online.done', orderId: o.id });
    }
    return { created, updated, closed };
  });
  fx.emit({ topic: 'tables', kind: 'online.sync' });
  fx.flush();
  setSyncState('laffogato.orders', { ...(getSyncState<Record<string, unknown>>('laffogato.orders') ?? {}), lastSuccessAt: Date.now(), lastError: null, count: list.length });
  return result;
}

export async function syncOnlineOrders() {
  try {
    const { orders, complete } = await fetchPanelOrders();
    return upsertOnlineOrders(orders, complete);
  } catch (e) {
    setSyncState('laffogato.orders', { ...(getSyncState<Record<string, unknown>>('laffogato.orders') ?? {}), lastError: e instanceof Error ? e.message : String(e), lastErrorAt: Date.now() });
    throw e;
  }
}

/** Siteye aşama yazar: preparing (hazırlanıyor), ready (hazır / masaya götürüldü / kuryeye verildi), delivered (gel-al teslim) */
export async function setOnlineStage(orderId: string, action: 'preparing' | 'ready' | 'delivered', actorName: string) {
  if (!configured()) throw conflict('Site bağlantı anahtarı tanımlı değil (LAFFOGATO_SYNC_SECRET)', 'not_configured');
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

export type SiteAvailability = 'guncellendi' | 'bagli_degil' | 'anahtar_yok';

/**
 * Siteye bağlı ürünün Satışta bilgisini siteye yazar (site o bilginin sahibi). Site kabul etmezse hata atar:
 * çağıran yerelde de değiştirmez. Anahtar yoksa ya da ürün bağlı değilse istek gitmez, sonucu bildirilir.
 */
export async function writeSiteAvailability(p: { extSource: string | null; extId: string | null }, active: boolean, actorName: string): Promise<SiteAvailability> {
  if (p.extSource !== 'laffogato' || !p.extId) return 'bagli_degil';
  if (!configured()) return 'anahtar_yok';
  const { status } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), { id: p.extId, isActive: active, actor: actorName.slice(0, 80) });
  if (status !== 200) throw new HttpError(502, `Site Satışta bilgisini kabul etmedi (HTTP ${status}); LafPOS'ta da değiştirilmedi`, 'site_menu');
  return 'guncellendi';
}

/**
 * Ürünü Tükendi / Satışa açık yapar. Siteye bağlı üründe önce site güncellenir (site Satışta bilgisinin
 * sahibi), 2xx gelince yerelde kaydedilir. Anahtar yoksa yalnız LafPOS'ta değişir ve bu bildirilir.
 */
export async function setAvailability(productId: string, active: boolean, actorName: string): Promise<{ site: 'guncellendi' | 'bagli_degil' | 'anahtar_yok' }> {
  const p = db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
  if (!p) throw notFound('Ürün');
  const site = await writeSiteAvailability(p, active, actorName);
  const fx = new Effects();
  tx((t) => {
    t.update(schema.products)
      .set({ active, portionsLeft: active && p.portionsLeft === 0 ? null : p.portionsLeft, updatedAt: Date.now() })
      .where(eq(schema.products.id, productId))
      .run();
    fx.audit(t, { action: active ? 'product.available' : 'product.sold_out', entity: 'product', entityId: productId, message: `${actorName}: ${p.name} ${active ? 'satışa açıldı' : 'tükendi'}${site === 'guncellendi' ? ' (site ve uygulama da güncellendi)' : ''}` });
  });
  fx.emit({ topic: 'menu', kind: active ? 'product.available' : 'product.sold_out' });
  fx.flush();
  return { site };
}

/** Porsiyonu biten ürünleri siteye bildirir (adisyon akışından gelen olaylar için) */
export async function pushSoldOut(productIds: string[]) {
  for (const id of productIds) {
    const p = db.select().from(schema.products).where(eq(schema.products.id, id)).get();
    if (!p || p.extSource !== 'laffogato' || !p.extId || !configured()) continue;
    await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), { id: p.extId, isActive: false, actor: 'LafPOS porsiyon' }).catch(() => undefined);
  }
}

// ─── Zamanlayıcı ────────────────────────────────────────────────────────────

/** Son başarılı çekmedeki sürüm sinyali */
let lastVersion: string | null = null;
let versionSupported = true;
/** Son çekme denemesi (başarılı ya da değil) ve başarısız olup olmadığı */
let lastPullAt = 0;
let lastPullFailed = false;
let inflight: Promise<unknown> | null = null;
/** Senkron bütçesi (kural 6): sürüm sinyali dışında siparişler en sık 5 dk'da bir kendiliğinden çekilir */
const PULL_BUDGET_MS = 5 * 60_000;

async function pull(now: number) {
  lastPullAt = now;
  try {
    const r = await syncOnlineOrders();
    lastPullFailed = false;
    return r;
  } catch (e) {
    lastPullFailed = true;
    throw e;
  }
}

/**
 * 20 sn'de bir çağrılır. Sürüm sinyali varsa yalnız değişince çeker; yoksa (ya da okunamazsa) en çok 5 dk'da bir
 * çeker. Sürüm ancak çekme başarılı olunca kaydedilir: başarısız çekme 5 dk dolunca yeniden denenir, her turda değil.
 */
export async function onlineOrdersTick() {
  if (!configured() || !getSettings().onlineOrdersSync || inflight) return;
  const now = Date.now();
  const budgetOk = now - lastPullAt >= PULL_BUDGET_MS;
  const job = (async () => {
    try {
      if (versionSupported) {
        const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/pos/orders/version`));
        const v = (json as { version?: unknown } | null)?.version;
        if (status === 404) versionSupported = false;
        else if (status === 200 && typeof v === 'string' && v) {
          if (v !== lastVersion && (!lastPullFailed || budgetOk)) {
            await pull(now);
            lastVersion = v;
          }
          return;
        }
        // Sinyal okunamadı (5xx, bozuk gövde): 5 dk'lık yedek çekmeye düşer
      }
      if (budgetOk) await pull(now);
    } catch (e) {
      console.warn('[online] siparişler alınamadı:', e instanceof Error ? e.message : e);
    }
  })().finally(() => {
    inflight = null;
  });
  inflight = job;
  await job;
}

/** "Yenile" düğmesi: en sık 30 sn'de bir gerçek çekme */
export async function refreshOnlineOrders() {
  const now = Date.now();
  if (now - lastPullAt < 30_000) return { skipped: true };
  return pull(now);
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
  };
}
