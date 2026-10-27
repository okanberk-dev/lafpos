import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { requireSiteSigned, siteLinked, siteSigned } from './laffogato-link';

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

export async function fetchPanelOrders(): Promise<PanelOrder[]> {
  requireSiteSigned();
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/panel/orders`));
  if (status !== 200) throw new HttpError(502, `Site siparişleri alınamadı (HTTP ${status})`, 'site_orders');
  return ((json as { orders?: PanelOrder[] })?.orders ?? []).filter((o) => o && typeof o.id === 'string');
}

/** Detay metnindeki boy önekini atar: "M · yulaf · +1 shot" -> "yulaf · +1 shot" */
function detailText(detail: string, size: string): string {
  const parts = detail.split('·').map((s) => s.trim()).filter(Boolean);
  if (parts[0] && (parts[0] === size || parts[0] === 'M' || parts[0] === 'L')) parts.shift();
  return parts.join(' · ');
}

/** Siteden gelen listeyi yerel adisyonlara işler; listede olmayan açık online siparişler tamamlanmış sayılır. */
export function upsertOnlineOrders(list: PanelOrder[]): { created: number; updated: number; closed: number } {
  const fx = new Effects();
  const result = tx((t) => {
    const day = getOpenDay(t) ?? t.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).get();
    if (!day) return { created: 0, updated: 0, closed: 0 };
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
      const table = o.fulfillment === 'table' ? tables.find((x) => x.siteTableCode && x.siteTableCode.trim().toLocaleLowerCase('tr-TR') === o.label.trim().toLocaleLowerCase('tr-TR')) : undefined;
      const status = STAGE_STATUS[o.stage] ?? 'yeni';
      if (existing) {
        if (existing.extStage !== o.stage || existing.tableId !== (table?.id ?? null)) {
          t.update(schema.orders).set({ extStage: o.stage, tableId: table?.id ?? existing.tableId, updatedAt: now }).where(eq(schema.orders.id, existing.id)).run();
          t.update(schema.orderItems).set({ status }).where(eq(schema.orderItems.orderId, existing.id)).run();
          updated++;
          fx.emit({ topic: 'orders', kind: 'online.updated', orderId: existing.id, tableId: table?.id });
          fx.emit({ topic: 'kitchen', kind: 'online.updated', orderId: existing.id });
        }
        continue;
      }
      const id = ulid(now);
      t.insert(schema.orders)
        .values({
          id,
          dayId: day.id,
          no: o.orderNo,
          type: 'online',
          status: 'acik',
          tableId: table?.id ?? null,
          guests: 1,
          note: o.note || null,
          openedAt: Date.parse(o.paidAt) || now,
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
            sentAt: Date.parse(o.paidAt) || now,
            extProductId: l.menuItemId,
            createdAt: now,
          })
          .run();
      });
      created++;
      fx.emit({ topic: 'orders', kind: 'online.new', orderId: id, tableId: table?.id, message: `Online sipariş: ${o.label} · ${o.firstName}` });
      fx.emit({ topic: 'kitchen', kind: 'ticket.new', orderId: id, message: 'online' });
    }
    const open = t.select().from(schema.orders).where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.status, 'acik'))).all();
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
    return upsertOnlineOrders(await fetchPanelOrders());
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

/**
 * Ürünü Tükendi / Satışa açık yapar. Siteye bağlı üründe önce site güncellenir (site Satışta bilgisinin
 * sahibi), 2xx gelince yerelde kaydedilir. Anahtar yoksa yalnız LafPOS'ta değişir ve bu bildirilir.
 */
export async function setAvailability(productId: string, active: boolean, actorName: string): Promise<{ site: 'guncellendi' | 'bagli_degil' | 'anahtar_yok' | 'baglanti_yok' }> {
  const p = db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
  if (!p) throw notFound('Ürün');
  let site: 'guncellendi' | 'bagli_degil' | 'anahtar_yok' | 'baglanti_yok' = 'bagli_degil';
  if (p.extSource === 'laffogato' && p.extId) {
    if (!siteLinked()) site = 'baglanti_yok';
    else if (!configured()) site = 'anahtar_yok';
    else {
      const { status } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), { id: p.extId, isActive: active, actor: actorName.slice(0, 80) });
      if (status !== 200) throw new HttpError(502, `Site Satışta bilgisini kabul etmedi (HTTP ${status}); LafPOS'ta da değiştirilmedi`, 'site_menu');
      site = 'guncellendi';
    }
  }
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

let lastVersion: string | null = null;
let versionSupported = true;
let lastFullPull = 0;
let inflight: Promise<unknown> | null = null;

/** 20 sn'de bir çağrılır. Sürüm sinyali varsa yalnız değişince çeker; yoksa en çok 5 dk'da bir çeker. */
export async function onlineOrdersTick() {
  if (!configured() || !getSettings().onlineOrdersSync || inflight) return;
  const now = Date.now();
  inflight = (async () => {
    try {
      if (versionSupported) {
        const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/pos/orders/version`));
        if (status === 404) versionSupported = false;
        else if (status === 200) {
          const v = (json as { version?: string })?.version ?? null;
          if (v && v !== lastVersion) {
            lastVersion = v;
            await syncOnlineOrders();
            lastFullPull = now;
          }
          return;
        }
      }
      if (now - lastFullPull >= 5 * 60_000) {
        lastFullPull = now;
        await syncOnlineOrders();
      }
    } catch (e) {
      console.warn('[online] siparişler alınamadı:', e instanceof Error ? e.message : e);
    }
  })().finally(() => {
    inflight = null;
  });
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
  };
}
