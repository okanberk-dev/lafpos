import { asc, eq, inArray } from 'drizzle-orm';
import { posNameOf } from '@shared/pos-name';
import { hmToMinutes, istanbulParts } from '@shared/time';
import type { SelectedOption, Size } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import { bad, notFound } from '../lib/http';
import { getSettings } from '../lib/settings';

type Product = typeof schema.products.$inferSelect;
type Category = typeof schema.categories.$inferSelect;
type Group = typeof schema.optionGroups.$inferSelect;
type Item = typeof schema.optionItems.$inferSelect;

export interface SaleProduct {
  product: Product;
  category: Category;
  groups: (Group & { items: Item[] })[];
}

export function loadSaleProduct(t: Tx | DB, productId: string): SaleProduct {
  const product = t.select().from(schema.products).where(eq(schema.products.id, productId)).get();
  if (!product) throw notFound('Ürün');
  const category = t.select().from(schema.categories).where(eq(schema.categories.id, product.categoryId)).get();
  if (!category) throw notFound('Kategori');
  const links = t
    .select()
    .from(schema.productOptionGroups)
    .where(eq(schema.productOptionGroups.productId, productId))
    .orderBy(asc(schema.productOptionGroups.sort))
    .all();
  const groupIds = links.map((l) => l.groupId);
  const groups = groupIds.length ? t.select().from(schema.optionGroups).where(inArray(schema.optionGroups.id, groupIds)).all() : [];
  const items = groupIds.length
    ? t.select().from(schema.optionItems).where(inArray(schema.optionItems.groupId, groupIds)).orderBy(asc(schema.optionItems.sort)).all()
    : [];
  const ordered = links
    .map((l) => groups.find((g) => g.id === l.groupId))
    .filter((g): g is Group => !!g && g.active)
    .map((g) => ({ ...g, items: items.filter((i) => i.groupId === g.id && i.active) }));
  return { product, category, groups: ordered };
}

export function sizePrice(product: Product, size: Size): number {
  if (size === 'L') {
    if (product.priceL == null) throw bad(`${product.name} tek boy; L seçilemez`, 'size_invalid');
    return product.priceL;
  }
  if (size === 'M' && product.priceL == null) return product.price;
  return product.price;
}

/** Ürünün geçerli boy etiketi: L fiyatı varsa M/L, yoksa TEK */
export function normalizeSize(product: Product, size: Size | undefined): Size {
  if (product.priceL == null) return 'TEK';
  return size === 'L' ? 'L' : 'M';
}

/**
 * İstemcinin seçtiği seçenekleri veritabanındaki tanımlara göre doğrular ve fiyatlandırır; istemcinin
 * gönderdiği fiyata asla güvenilmez. Seçilmeyen zorunlu tek seçimlik gruplarda varsayılan kullanılır.
 */
export function resolveOptions(sp: SaleProduct, picked: { itemId: string; qty?: number }[]): SelectedOption[] {
  const out: SelectedOption[] = [];
  for (const g of sp.groups) {
    const chosen = picked.filter((p) => g.items.some((i) => i.id === p.itemId));
    if (g.kind === 'single') {
      if (chosen.length > 1) throw bad(`${g.name}: tek seçim yapılabilir`, 'option_invalid');
      const item = chosen[0] ? g.items.find((i) => i.id === chosen[0].itemId) : g.items.find((i) => i.isDefault);
      if (!item) {
        if (g.required) throw bad(`${g.name} seçilmeli`, 'option_required');
        continue;
      }
      out.push(toSelected(g, item, 1));
    } else if (g.kind === 'multi') {
      const unique = [...new Set(chosen.map((c) => c.itemId))];
      if (unique.length > g.maxSelect) throw bad(`${g.name}: en çok ${g.maxSelect} seçim`, 'option_invalid');
      if (g.required && unique.length === 0) throw bad(`${g.name} seçilmeli`, 'option_required');
      for (const id of unique) out.push(toSelected(g, g.items.find((i) => i.id === id)!, 1));
    } else {
      for (const c of chosen) {
        const item = g.items.find((i) => i.id === c.itemId)!;
        const qty = Math.trunc(c.qty ?? 1);
        if (qty < 0 || qty > item.maxQty) throw bad(`${item.name}: en çok ${item.maxQty}`, 'option_invalid');
        if (qty > 0) out.push(toSelected(g, item, qty));
      }
    }
  }
  const known = new Set(sp.groups.flatMap((g) => g.items.map((i) => i.id)));
  const unknown = picked.find((p) => !known.has(p.itemId));
  if (unknown) throw bad('Bu ürüne ait olmayan bir seçenek gönderildi', 'option_invalid');
  return out;
}

function toSelected(g: Group, item: Item, qty: number): SelectedOption {
  return { groupId: g.id, group: g.name, groupKey: g.extKey, itemId: item.id, name: item.name, code: item.code, price: item.price, qty };
}

/**
 * Fişte görünen seçenek metni. İsteğe bağlı gruplarda ücretsiz varsayılan (Normal süt, Yoğun kavrum, Şurup yok)
 * yazılmaz; zorunlu gruplarda (Türk kahvesi şekeri gibi) seçim her zaman yazılır.
 */
export function optionsText(opts: SelectedOption[], groupsDefaults: Map<string, string>, requiredGroups: Set<string> = new Set()): string {
  const parts: string[] = [];
  for (const o of opts) {
    if (groupsDefaults.get(o.groupId) === o.itemId && o.price === 0 && !requiredGroups.has(o.groupId)) continue;
    if (o.groupKey === 'extraShot') parts.push(o.qty > 1 ? `+${o.qty} shot` : '+1 shot');
    else if (o.groupKey === 'sugar') parts.push(`${o.qty} şeker`);
    else if (o.groupKey === 'roast') parts.push(`${o.name} kavrum`);
    else parts.push(o.qty > 1 ? `${o.qty}× ${o.name}` : o.name);
  }
  return parts.join(' · ');
}

export function defaultsOf(sp: SaleProduct): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of sp.groups) {
    const d = g.items.find((i) => i.isDefault);
    if (d) m.set(g.id, d.id);
  }
  return m;
}

export function requiredOf(sp: SaleProduct): Set<string> {
  return new Set(sp.groups.filter((g) => g.required).map((g) => g.id));
}

export function optionsUnitTotal(opts: SelectedOption[]): number {
  return opts.reduce((a, o) => a + o.price * o.qty, 0);
}

/** Şu an geçerli happy hour indirimi (yüzde); gece yarısını aşan aralıklar desteklenir */
export function happyHourPercent(t: Tx | DB, product: Product, nowMs = Date.now()): number {
  const rules = t.select().from(schema.happyHours).where(eq(schema.happyHours.active, true)).all();
  if (!rules.length) return 0;
  const p = istanbulParts(nowMs);
  const minute = p.hour * 60 + p.minute;
  let best = 0;
  for (const r of rules) {
    const start = hmToMinutes(r.start);
    const end = hmToMinutes(r.end);
    const inRange = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
    // Gece yarısını aşan aralıkta gece kısmı önceki günün kuralına aittir
    const day = start > end && minute < end ? (p.weekday === 1 ? 7 : p.weekday - 1) : p.weekday;
    if (!inRange || !r.days.includes(day)) continue;
    const scoped = r.productIds.length || r.categoryIds.length;
    const matches = !scoped || r.productIds.includes(product.id) || r.categoryIds.includes(product.categoryId);
    if (matches) best = Math.max(best, r.percent);
  }
  return best;
}

/**
 * lafmaliyet satış listesindeki ad: tek boylu üründe posName'i, iki boylu üründe posName taban ad + boy eki; posName
 * yoksa "AD BOYEKİ". Kural `shared/pos-name.ts`'te (docs/03-ENTEGRASYON.md §3.1).
 */
export function posNameFor(product: Pick<Product, 'name' | 'posName' | 'priceL'>, size: Size): string {
  return posNameOf(product, size, getSettings().posSizeSuffix);
}

/** Ürünün istasyonu: ürüne özel, yoksa kategorininki */
export function stationFor(product: Product, category: Category): string | null {
  return product.stationId ?? category.stationId ?? null;
}
