import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { tl } from '@shared/money';
import { type DB, schema, type Tx } from '../db/client';
import { env } from '../env';
import { ulid } from '../lib/ids';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';

/**
 * laffogato menüsünü LafPOS'a çeker. Kaynak: herkese açık, CDN önbellekli `GET /api/mobile/v1/menu` (ETag).
 * Site fiyatın, Satışta bilgisinin ve KDV'nin sahibidir; LafPOS'a özel alanlar (istasyon, kısa ad, renk,
 * gizli, sık kullanılan, porsiyon sayacı, posName) senkronda korunur. docs/03-ENTEGRASYON.md §2
 */

export interface SiteMenuItem {
  id: string;
  categoryKey: string;
  name: string;
  description?: string;
  priceMinor: number;
  priceLargeMinor: number | null;
  tags?: string[];
  image?: string | null;
  taxRatePct?: number;
  allergens?: string[];
}

export interface SiteMenu {
  categories: { key: string; title: string; subtitle?: string; items: SiteMenuItem[] }[];
  customization: {
    milks: { id: string; label: string; priceMinor: number; allergens?: string[] }[];
    roasts: { id: string; label: string }[];
    syrups: { id: string; label: string; priceMinor: number; allergens?: string[] }[];
    extraShotMinor: number;
    sugarMax: number;
  };
  updatedAt?: string;
}

/** Sitenin seçenek almayan kategorileri (laffogato NON_CUSTOMIZABLE_CATEGORIES) */
export const NON_CUSTOMIZABLE = ['dessert', 'snack', 'extras'];
/** Kategori ilk kez oluşturulurken istasyonu: yiyecekler mutfağa, diğerleri bara */
const KITCHEN_CATEGORIES = ['dessert', 'snack'];

export interface MenuChange {
  kind: 'yeni' | 'fiyat' | 'ad' | 'kdv' | 'boy' | 'kalkti' | 'geri' | 'diger';
  productId: string | null;
  extId: string;
  name: string;
  detail: string;
}

export interface MenuPreview {
  changes: MenuChange[];
  newCategories: string[];
  itemCount: number;
  siteUpdatedAt: string | null;
}

const hashItem = (i: SiteMenuItem) =>
  createHash('sha1')
    .update(JSON.stringify([i.name, i.description ?? '', i.priceMinor, i.priceLargeMinor, i.taxRatePct ?? 10, i.image ?? '', i.allergens ?? null, i.tags ?? [], i.categoryKey]))
    .digest('hex')
    .slice(0, 16);

export async function fetchPublicMenu(force = false): Promise<{ status: 'degismedi' } | { status: 'yeni'; menu: SiteMenu; etag: string | null }> {
  const prev = getSyncState<{ etag?: string }>('laffogato.menu');
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'LafPOS/0.1 (+kafe kasasi)' };
  if (prev?.etag && !force) headers['if-none-match'] = prev.etag;
  const res = await fetch(`${env.laffogatoUrl}/api/mobile/v1/menu`, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 304) return { status: 'degismedi' };
  if (!res.ok) throw new Error(`Site menüsü alınamadı (HTTP ${res.status})`);
  const menu = (await res.json()) as SiteMenu;
  if (!Array.isArray(menu?.categories)) throw new Error('Site menüsü beklenen biçimde değil');
  return { status: 'yeni', menu, etag: res.headers.get('etag') };
}

/** İmzalı panelin kalemleri: Tükendi olanlar dahil, CDN önbelleği yok (sitenin Satışta bilgisinin güncel hali) */
export type PanelMenu = Map<string, { isActive: boolean; priceMinor: number; priceMinorL: number }>;

/** İmzalı panel ucundan Tükendi kalemler dahil liste (anahtar varsa). */
export async function fetchPanelMenu(): Promise<PanelMenu | null> {
  if (env.laffogatoPanelSecret.length < 32) return null;
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', new URL(`${env.laffogatoUrl}/api/panel/menu`));
  if (status !== 200) throw new Error(`Panel menüsü alınamadı (HTTP ${status})`);
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error('Panel menüsü beklenen biçimde değil');
  return new Map(
    (items as { id?: unknown; isActive?: unknown; priceMinor: number; priceMinorL: number }[])
      .filter((i) => typeof i?.id === 'string' && typeof i.isActive === 'boolean')
      .map((i) => [i.id as string, i as { isActive: boolean; priceMinor: number; priceMinorL: number }]),
  );
}

type LocalProduct = typeof schema.products.$inferSelect;

/** Son eşitlemenin anı: listelenen her bağlı ürünün `syncedAt`'i o eşitlemede yazılır */
function lastSyncAt(local: LocalProduct[]): number {
  return local.reduce((a, p) => Math.max(a, p.syncedAt ?? 0), 0);
}

/**
 * Bağlı ürün LafPOS'ta satışta mı olmalı. Porsiyon sayacı biten ürünü site açamaz (sayaç LafPOS'un). Anahtar
 * varsa imzalı panelin Satışta bilgisi geçerlidir: herkese açık menü CDN'den birkaç dakika eski gelebilir.
 * Panel yoksa herkese açık menüde listelenen satışta sayılır; yalnız son eşitlemede de listelenmiş ve o
 * zamandan beri LafPOS'ta (anahtarsız) Tükendi yapılmış ürün, site değişmedikçe kapalı kalır.
 */
function shouldBeActive(p: LocalProduct, listed: boolean, panel: PanelMenu | null, lastSync: number): boolean {
  if (p.portionsLeft === 0) return false;
  const onPanel = panel?.get(p.extId!);
  if (onPanel) return onPanel.isActive;
  if (!listed) return false;
  return p.active || (p.syncedAt ?? 0) < lastSync;
}

function siteItems(menu: SiteMenu): SiteMenuItem[] {
  return menu.categories.flatMap((c) => c.items.map((i) => ({ ...i, categoryKey: i.categoryKey ?? c.key })));
}

export function previewMenu(t: Tx | DB, menu: SiteMenu, panel: PanelMenu | null = null): MenuPreview {
  const local = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
  const lastSync = lastSyncAt(local);
  const byExt = new Map(local.map((p) => [p.extId!, p]));
  const cats = new Set(t.select({ k: schema.categories.extKey }).from(schema.categories).where(eq(schema.categories.extSource, 'laffogato')).all().map((c) => c.k));
  const changes: MenuChange[] = [];
  const items = siteItems(menu);
  const seen = new Set<string>();
  for (const i of items) {
    seen.add(i.id);
    const p = byExt.get(i.id);
    if (!p) {
      changes.push({ kind: 'yeni', productId: null, extId: i.id, name: i.name, detail: `${tl(i.priceMinor)}${i.priceLargeMinor ? ` / ${tl(i.priceLargeMinor)}` : ''}` });
      continue;
    }
    const active = shouldBeActive(p, true, panel, lastSync);
    if (!p.active && active) changes.push({ kind: 'geri', productId: p.id, extId: i.id, name: i.name, detail: 'Sitede yeniden satışta' });
    if (p.active && !active) changes.push({ kind: 'kalkti', productId: p.id, extId: i.id, name: i.name, detail: 'Sitede Tükendi' });
    if (p.price !== i.priceMinor) changes.push({ kind: 'fiyat', productId: p.id, extId: i.id, name: i.name, detail: `${tl(p.price)} → ${tl(i.priceMinor)}` });
    if ((p.priceL ?? null) !== (i.priceLargeMinor ?? null)) {
      changes.push({ kind: 'boy', productId: p.id, extId: i.id, name: i.name, detail: `L: ${p.priceL ? tl(p.priceL) : 'yok'} → ${i.priceLargeMinor ? tl(i.priceLargeMinor) : 'yok'}` });
    }
    if (p.name !== i.name) changes.push({ kind: 'ad', productId: p.id, extId: i.id, name: i.name, detail: `"${p.name}" → "${i.name}"` });
    if (p.kdvRate !== (i.taxRatePct ?? 10)) changes.push({ kind: 'kdv', productId: p.id, extId: i.id, name: i.name, detail: `%${p.kdvRate} → %${i.taxRatePct ?? 10}` });
    else if (p.extHash && p.extHash !== hashItem(i) && !changes.some((c) => c.extId === i.id)) {
      changes.push({ kind: 'diger', productId: p.id, extId: i.id, name: i.name, detail: 'Açıklama, görsel ya da alerjen değişti' });
    }
  }
  for (const p of local) {
    if (seen.has(p.extId!)) continue;
    const active = shouldBeActive(p, false, panel, lastSync);
    if (!p.active && active) changes.push({ kind: 'geri', productId: p.id, extId: p.extId!, name: p.name, detail: 'Sitede yeniden satışta' });
    if (p.active && !active) changes.push({ kind: 'kalkti', productId: p.id, extId: p.extId!, name: p.name, detail: panel?.get(p.extId!) ? 'Sitede Tükendi' : 'Sitede satışta değil' });
  }
  return {
    changes,
    newCategories: menu.categories.filter((c) => !cats.has(c.key)).map((c) => c.title),
    itemCount: items.length,
    siteUpdatedAt: menu.updatedAt ?? null,
  };
}

function upsertOptionGroups(t: Tx | DB, menu: SiteMenu): string[] {
  const c = menu.customization;
  const defs: {
    key: string;
    name: string;
    kind: 'single' | 'counter';
    items: { code: string; name: string; price: number; isDefault: boolean; maxQty: number; allergens: string[] }[];
  }[] = [
    { key: 'milk', name: 'Süt', kind: 'single', items: c.milks.map((m, i) => ({ code: m.id, name: m.label, price: m.priceMinor, isDefault: i === 0, maxQty: 1, allergens: m.allergens ?? [] })) },
    { key: 'roast', name: 'Kavrum', kind: 'single', items: c.roasts.map((r, i) => ({ code: r.id, name: r.label, price: 0, isDefault: i === 0, maxQty: 1, allergens: [] })) },
    { key: 'syrup', name: 'Şurup', kind: 'single', items: c.syrups.map((s, i) => ({ code: s.id, name: s.label, price: s.priceMinor, isDefault: i === 0, maxQty: 1, allergens: s.allergens ?? [] })) },
    { key: 'extraShot', name: 'Ekstra shot', kind: 'counter', items: [{ code: 'extraShot', name: 'Ekstra shot', price: c.extraShotMinor, isDefault: false, maxQty: 1, allergens: [] }] },
    { key: 'sugar', name: 'Şeker', kind: 'counter', items: [{ code: 'sugar', name: 'Şeker', price: 0, isDefault: false, maxQty: c.sugarMax, allergens: [] }] },
  ];
  const ids: string[] = [];
  defs.forEach((d, gi) => {
    let g = t.select().from(schema.optionGroups).where(and(eq(schema.optionGroups.extSource, 'laffogato'), eq(schema.optionGroups.extKey, d.key))).get();
    if (!g) {
      const id = ulid();
      t.insert(schema.optionGroups).values({ id, name: d.name, kind: d.kind, required: false, maxSelect: 1, sort: gi, extSource: 'laffogato', extKey: d.key }).run();
      g = t.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, id)).get()!;
    }
    ids.push(g.id);
    const existing = t.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).all();
    d.items.forEach((it, ii) => {
      const e = existing.find((x) => x.code === it.code);
      if (e) t.update(schema.optionItems).set({ name: it.name, price: it.price, isDefault: it.isDefault, maxQty: it.maxQty, allergens: it.allergens, sort: ii, active: true }).where(eq(schema.optionItems.id, e.id)).run();
      else t.insert(schema.optionItems).values({ id: ulid(), groupId: g!.id, name: it.name, code: it.code, price: it.price, isDefault: it.isDefault, maxQty: it.maxQty, allergens: it.allergens, sort: ii }).run();
    });
    for (const e of existing) if (!d.items.some((x) => x.code === e.code)) t.update(schema.optionItems).set({ active: false }).where(eq(schema.optionItems.id, e.id)).run();
  });
  return ids;
}

/**
 * Menüyü uygular (tek işlem). Fiyat, ad, KDV, açıklama, görsel siteden gelir; POS alanları (sıra dahil) korunur.
 * Satışta bilgisi `shouldBeActive` kuralıyla: listede olmayan bağlı ürün Tükendi yapılır (silinmez, geçmiş
 * satışlar bozulmasın), imzalı panel verildiyse onun Satışta bilgisi geçerlidir.
 */
export function applyMenu(
  t: Tx,
  menu: SiteMenu,
  opts: { barStationId?: string | null; kitchenStationId?: string | null; panel?: PanelMenu | null } = {},
): { created: number; updated: number; deactivated: number } {
  const now = Date.now();
  const panel = opts.panel ?? null;
  const lastSync = lastSyncAt(t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all());
  const groupIds = upsertOptionGroups(t, menu);
  const catIdByKey = new Map<string, string>();
  menu.categories.forEach((c, ci) => {
    const existing = t.select().from(schema.categories).where(and(eq(schema.categories.extSource, 'laffogato'), eq(schema.categories.extKey, c.key))).get();
    if (existing) {
      t.update(schema.categories)
        .set({ name: c.title, subtitle: c.subtitle || null, sort: ci, customizable: !NON_CUSTOMIZABLE.includes(c.key) })
        .where(eq(schema.categories.id, existing.id))
        .run();
      catIdByKey.set(c.key, existing.id);
    } else {
      const id = ulid();
      t.insert(schema.categories)
        .values({
          id,
          name: c.title,
          subtitle: c.subtitle || null,
          sort: ci,
          color: CATEGORY_COLORS[c.key] ?? '#245c43',
          stationId: KITCHEN_CATEGORIES.includes(c.key) ? (opts.kitchenStationId ?? opts.barStationId ?? null) : (opts.barStationId ?? null),
          customizable: !NON_CUSTOMIZABLE.includes(c.key),
          extSource: 'laffogato',
          extKey: c.key,
        })
        .run();
      catIdByKey.set(c.key, id);
    }
  });

  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  const items = siteItems(menu);
  items.forEach((i, idx) => {
    seen.add(i.id);
    const categoryId = catIdByKey.get(i.categoryKey);
    if (!categoryId) return;
    const values = {
      categoryId,
      name: i.name,
      description: i.description || null,
      price: i.priceMinor,
      priceL: i.priceLargeMinor ?? null,
      kdvRate: i.taxRatePct ?? 10,
      image: i.image ?? null,
      tags: i.tags ?? [],
      allergens: i.allergens ?? null,
      extHash: hashItem(i),
      syncedAt: now,
      updatedAt: now,
    };
    const existing = t.select().from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, i.id))).get();
    let productId: string;
    if (existing) {
      const active = shouldBeActive(existing, true, panel, lastSync);
      t.update(schema.products).set({ ...values, active }).where(eq(schema.products.id, existing.id)).run();
      productId = existing.id;
      updated++;
    } else {
      productId = ulid();
      // POS sırası LafPOS'un (docs/03 §1): yalnız ürün ilk gelirken sitenin sırası verilir
      const active = panel?.get(i.id)?.isActive ?? true;
      t.insert(schema.products).values({ id: productId, ...values, sort: idx, active, extSource: 'laffogato', extId: i.id, createdAt: now }).run();
      created++;
    }
    // Site seçenekleri (süt, şurup…) yalnız ürün ilk kez gelirken bağlanır; sonra yöneticinin seçimi korunur
    if (!existing && !NON_CUSTOMIZABLE.includes(i.categoryKey)) {
      groupIds.forEach((g, gi) => t.insert(schema.productOptionGroups).values({ productId, groupId: g, sort: gi }).onConflictDoNothing().run());
    }
  });

  let deactivated = 0;
  const local = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
  for (const p of local) {
    if (seen.has(p.extId!)) continue;
    const active = shouldBeActive(p, false, panel, lastSync);
    if (active === p.active) continue;
    t.update(schema.products).set({ active, updatedAt: now }).where(eq(schema.products.id, p.id)).run();
    if (!active) deactivated++;
  }
  return { created, updated, deactivated };
}

const CATEGORY_COLORS: Record<string, string> = {
  matcha: '#5e8f45',
  espresso: '#6b4226',
  'ice-coffee': '#3f6b8a',
  cold: '#2f7d7a',
  hot: '#9a3b2f',
  frappe: '#8a5a2b',
  smoothie: '#a23e6b',
  frozen: '#c2577e',
  'ice-tea': '#b07a1f',
  dessert: '#6b1a2b',
  snack: '#a87c2e',
  extras: '#7a6a5f',
};

export function recordMenuSync(result: { etag?: string | null; changes?: number; error?: string | null }) {
  const prev = getSyncState<Record<string, unknown>>('laffogato.menu') ?? {};
  setSyncState('laffogato.menu', {
    ...prev,
    ...(result.etag !== undefined ? { etag: result.etag } : {}),
    lastCheckAt: Date.now(),
    ...(result.error ? { lastError: result.error, lastErrorAt: Date.now() } : { lastError: null, lastSuccessAt: Date.now() }),
    ...(result.changes !== undefined ? { lastChanges: result.changes } : {}),
  });
}
