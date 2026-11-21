import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { tl } from '@shared/money';
import { posNameKey, posNamesOf, posSlotOf } from '@shared/pos-name';
import { PAYMENT_CHANNELS } from '@shared/labels';
import { ALL_PERMISSIONS, effectivePermissions, isPermission, LOCKED_ROLES, type Permission, PERMISSION_GROUPS, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, rolePermissions, ROLES } from '@shared/permissions';
import { type DB, db, schema, type Tx, tx } from '../db/client';
import { backupNow } from '../jobs';
import { type AppEnv, assertNotLocked, type AuthUser, can, clientKey, hashPin, isValidPin, recordPinChoice, requirePermission, sessionsChanged } from '../lib/auth';
import { installedVersion, readUpdateStatus } from '../lib/surum';
import { Effects } from '../lib/effects';
import { bad, body, clockTime, conflict, HttpError, kurus, notFound, patchFields, patchOf, query } from '../lib/http';
import { ulid } from '../lib/ids';
import { networkInfo } from '../lib/network';
import { auditForViewer, seesCommission } from '../delivery/commission';
import { cloudState } from '../sync/cloud';
import { siteKaraokePrice } from '../sync/laffogato-karaoke';
import { reopenWithSite, type SiteWrite } from '../sync/laffogato-orders';
import { dropSiteSoldOut, enqueueSiteTables, flushSiteOutbox, retireTableCode } from '../sync/site-outbox';
import { generateTableCode, tableQrUrl } from '@shared/table-qr';
import { getSettings, PRIVATE_DEFAULTS, PUBLIC_DEFAULTS, updateSettings } from '../lib/settings';
import { CUSTOMER_DISPLAY_THEMES } from '@shared/types';
import { SERVICE_MODE_LABEL, SERVICE_MODES, serviceModeOf } from '@shared/service-mode';
import { settingLabel } from '@shared/settings-labels';
import { menuOptionGroups, menuProducts } from '../services/bootstrap';
import { lastZNo } from '../services/days';
import { nextZNo, Z_NO_MAX } from '@shared/z-no';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../env';

export const adminRoutes = new Hono<AppEnv>();

function changed(topic: 'menu' | 'settings' | 'users' | 'tables', kind: string, userId: string, audit?: { action: string; message: string }) {
  const fx = new Effects();
  if (audit) fx.audit(db, { userId, action: audit.action, message: audit.message });
  fx.emit({ topic, kind, byUserId: userId });
  if (topic === 'tables') fx.emit({ topic: 'settings', kind, byUserId: userId });
  fx.flush();
}

// ─── Menü ───────────────────────────────────────────────────────────────────

adminRoutes.get('/menu', (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  return c.json({
    categories: db.select().from(schema.categories).orderBy(asc(schema.categories.sort)).all(),
    products: menuProducts(db, can(user, 'rapor.maliyet')),
    optionGroups: db.select().from(schema.optionGroups).orderBy(asc(schema.optionGroups.sort)).all(),
    optionItems: db.select().from(schema.optionItems).orderBy(asc(schema.optionItems.sort)).all(),
    groupsForSale: menuOptionGroups(db),
  });
});

const categoryShape = z.object({
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  stationId: z.string().nullish(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
  customizable: z.boolean().optional(),
});

adminRoutes.post('/categories', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, categoryShape);
  const id = ulid();
  db.insert(schema.categories).values({ id, name: input.name, color: input.color ?? '#245c43', stationId: input.stationId ?? null, sort: input.sort ?? 50, active: input.active ?? true, customizable: input.customizable ?? false }).run();
  changed('menu', 'category.created', user.id, { action: 'menu.category', message: `${user.name} "${input.name}" kategorisini ekledi` });
  return c.json({ id });
});

adminRoutes.patch('/categories/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, patchOf(categoryShape));
  const cat = db.select().from(schema.categories).where(eq(schema.categories.id, c.req.param('id'))).get();
  if (!cat) throw notFound('Kategori');
  // Siteden gelen kategoride ad ve sıra sitenin; LafPOS'ta yalnız renk, istasyon ve görünürlük değişir
  const patch = cat.extSource ? { color: input.color, stationId: input.stationId, active: input.active } : input;
  db.update(schema.categories).set(patchFields(patch)).where(eq(schema.categories.id, cat.id)).run();
  changed('menu', 'category.updated', user.id);
  return c.json({ ok: true });
});

const productLocal = z.object({
  categoryId: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullish(),
  price: kurus,
  priceL: kurus.nullish(),
  // %1 kullanılmaz: köşkün sattığı bütün gıda %10 (laffogato CLAUDE.md "KDV": %1 hiçbir üründe kullanılmaz)
  kdvRate: z.number().int().refine((v) => [0, 10, 20].includes(v), 'KDV 0, 10 ya da 20 olmalı'),
  isService: z.boolean().optional(),
});
const productPos = z.object({
  shortName: z.string().max(30).nullish(),
  stationId: z.string().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  hidden: z.boolean().optional(),
  favorite: z.boolean().optional(),
  posName: z.string().max(60).nullish(),
  portionsLeft: z.number().int().min(0).max(9999).nullish(),
  barcode: z.string().max(40).nullish(),
  sort: z.number().int().optional(),
});

type ProductRow = typeof schema.products.$inferSelect;

/**
 * lafmaliyet adı başka bir ürünün ya da boyun adıyla çakışmasın: lafmaliyet bir günde bir ada bir satır ister ve adı
 * büyük / küçük harf farkı gözetmeden eşleştirir. Aynı adı taşıyan iki yerel ürün tek satırda toplanır (ModPOS'taki
 * gibi), çakışma sayılmaz; siteye bağlı bir kalemin ya da boyun adını almak sayılır.
 */
function assertPosNameFree(self: Pick<ProductRow, 'name' | 'posName' | 'priceL' | 'extSource' | 'extId'> & { id: string | null }) {
  if (!self.posName?.trim()) return;
  const suffix = getSettings().posSizeSuffix;
  const extOf = (p: Pick<ProductRow, 'extSource' | 'extId'>) => (p.extSource === 'laffogato' ? p.extId : null);
  const rowKey = (p: Pick<ProductRow, 'extSource' | 'extId'>, size: 'M' | 'L' | 'TEK') => `${extOf(p) ?? ''}|${posSlotOf(extOf(p), size) ?? ''}`;
  const mine = posNamesOf(self, suffix).map((n) => ({ ...n, key: posNameKey(n.name), row: rowKey(self, n.size) }));
  const others = db.select().from(schema.products).all().filter((p) => p.id !== self.id);
  for (const o of others) {
    for (const n of posNamesOf(o, suffix)) {
      const hit = mine.find((m) => m.key === posNameKey(n.name) && m.row !== rowKey(o, n.size));
      if (hit) throw conflict(`"${hit.name}" lafmaliyet adı ${o.name}${n.size === 'TEK' ? '' : ` (${n.size})`} ürününde kullanılıyor; başka bir ad yazın`, 'pos_name_taken');
    }
  }
}

// ─── Seçenek grubu ↔ ürün bağı ──────────────────────────────────────────────

/** Bir ürüne bağlanabilecek en çok grup (çekmecedeki çipler; gruptan bağlarken de aşılmaz) */
const MAX_PRODUCT_GROUPS = 12;
const groupIdsShape = z.array(z.string()).max(MAX_PRODUCT_GROUPS);

/** Bağ değişikliğinin denetim metninde en çok bu kadar ad yazılır; tam liste `data`da */
const nameList = (names: string[], max = 10) => (names.length > max ? `${names.slice(0, max).join(', ')} ve ${names.length - max} tane daha` : names.join(', '));

function linkSummary(added: string[], removed: string[]) {
  return [added.length ? `eklenen ${nameList(added)}` : '', removed.length ? `çıkarılan ${nameList(removed)}` : ''].filter(Boolean).join('; ');
}

/**
 * Gönderilen kimlikler yazmadan önce denetlenir (sitedeki Satışta isteğinden de önce): aynısı iki kez 409, olmayanı
 * 422. Veritabanı kısıtına bırakılmaz; kayıtların adı denetim metni için döner.
 */
function knownIds(table: typeof schema.optionGroups | typeof schema.products, ids: string[], what: string) {
  if (new Set(ids).size !== ids.length) throw conflict(`Aynı ${what} iki kez gönderildi`, 'duplicate');
  const names = new Map(db.select({ id: table.id, name: table.name }).from(table).all().map((r) => [r.id, r.name]));
  if (ids.some((id) => !names.has(id))) throw new HttpError(422, `Gönderilen ${what} bulunamadı (silinmiş olabilir); ekranı yenileyip yeniden deneyin`, 'invalid_reference');
  return names;
}

/** Ürünün grupları gönderilen sırayla yazılır; üyelik değiştiyse denetim kaydı (aynı işlemde) */
function writeProductGroups(t: Tx, fx: Effects, user: AuthUser, product: { id: string; name: string }, groupIds: string[], names: Map<string, string>) {
  const before = t.select({ groupId: schema.productOptionGroups.groupId }).from(schema.productOptionGroups).where(eq(schema.productOptionGroups.productId, product.id)).orderBy(asc(schema.productOptionGroups.sort)).all().map((l) => l.groupId);
  if (before.join('|') === groupIds.join('|')) return;
  t.delete(schema.productOptionGroups).where(eq(schema.productOptionGroups.productId, product.id)).run();
  groupIds.forEach((groupId, i) => t.insert(schema.productOptionGroups).values({ productId: product.id, groupId, sort: i }).run());
  const added = groupIds.filter((g) => !before.includes(g)).map((g) => names.get(g) ?? g);
  const removed = before.filter((g) => !groupIds.includes(g)).map((g) => names.get(g) ?? g);
  if (!added.length && !removed.length) return; // yalnız sıra değişti
  fx.audit(t, { userId: user.id, action: 'menu.product_groups', entity: 'product', entityId: product.id, message: `${user.name} ${product.name} ürününün seçenek grupları: ${linkSummary(added, removed)}`, data: { added, removed } });
}

/**
 * Grubun bağlı olduğu ürünler: listede olmayanın bağı kalkar, yeni bağ ürünün öteki gruplarının sonuna eklenir,
 * kalanların sırası değişmez. Üyelik değiştiyse denetim kaydı (aynı işlemde)
 */
function writeGroupProducts(t: Tx, fx: Effects, user: AuthUser, group: { id: string; name: string }, productIds: string[], names: Map<string, string>) {
  const links = t.select().from(schema.productOptionGroups).all();
  const before = links.filter((l) => l.groupId === group.id).map((l) => l.productId);
  const added = productIds.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !productIds.includes(p));
  if (!added.length && !removed.length) return;
  for (const productId of removed) t.delete(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, productId), eq(schema.productOptionGroups.groupId, group.id))).run();
  for (const productId of added) {
    const own = links.filter((l) => l.productId === productId);
    if (own.length >= MAX_PRODUCT_GROUPS) throw conflict(`${names.get(productId)} ürününde en çok ${MAX_PRODUCT_GROUPS} seçenek grubu olabilir`, 'too_many_groups');
    t.insert(schema.productOptionGroups).values({ productId, groupId: group.id, sort: Math.max(-1, ...own.map((l) => l.sort)) + 1 }).run();
  }
  const addedNames = added.map((p) => names.get(p) ?? p);
  const removedNames = removed.map((p) => names.get(p) ?? p);
  fx.audit(t, { userId: user.id, action: 'menu.product_groups', entity: 'option_group', entityId: group.id, message: `${user.name} ${group.name} grubunun ürünleri: ${linkSummary(addedNames, removedNames)}`, data: { added: addedNames, removed: removedNames } });
}

adminRoutes.post('/products', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  // Seçenek grupları ürünle aynı istekte ve aynı işlemde: ikinci istek düşüp ürün grupsuz kalmasın
  const { groupIds, ...input } = await body(c, productLocal.merge(productPos).extend({ groupIds: groupIdsShape.optional() }));
  if (!db.select().from(schema.categories).where(eq(schema.categories.id, input.categoryId)).get()) throw notFound('Kategori');
  assertPosNameFree({ id: null, name: input.name, posName: input.posName ?? null, priceL: input.priceL ?? null, extSource: null, extId: null });
  const groupNames = groupIds ? knownIds(schema.optionGroups, groupIds, 'seçenek grubu') : null;
  const id = ulid();
  const fx = new Effects();
  tx((t) => {
    t.insert(schema.products)
      .values({ id, ...input, priceL: input.priceL ?? null, isService: input.isService ?? false, active: true })
      .run();
    fx.audit(t, { userId: user.id, action: 'menu.product', entity: 'product', entityId: id, message: `${user.name} yerel ürün ekledi: ${input.name}` });
    if (groupIds && groupNames) writeProductGroups(t, fx, user, { id, name: input.name }, groupIds, groupNames);
  });
  fx.emit({ topic: 'menu', kind: 'product.created', byUserId: user.id }).flush();
  return c.json({ id });
});

adminRoutes.patch('/products/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const p = db.select().from(schema.products).where(eq(schema.products.id, c.req.param('id'))).get();
  if (!p) throw notFound('Ürün');
  // groupIds gönderilmezse bağlar değişmez; gönderilirse ürün alanlarıyla aynı işlemde yazılır
  const { groupIds, ...input } = await body(c, patchOf(productLocal).merge(patchOf(productPos)).extend({ groupIds: groupIdsShape.optional() }));
  const groupNames = groupIds ? knownIds(schema.optionGroups, groupIds, 'seçenek grubu') : null;
  const synced = p.extSource === 'laffogato';
  if (synced && (input.name !== undefined || input.price !== undefined || input.priceL !== undefined || input.kdvRate !== undefined || input.categoryId !== undefined)) {
    throw conflict('Bu ürün siteden geliyor: ad, fiyat, boy, KDV ve kategori sitede değişir (laffogato yönetim paneli). LafPOS\'ta yalnız kasa alanları düzenlenir', 'synced_field');
  }
  // Yalnız lafmaliyet adı değişiyorsa denetlenir: eski bir çakışma istasyon ya da renk kaydını engellemesin
  const next = { ...p, name: input.name ?? p.name, priceL: input.priceL !== undefined ? input.priceL : p.priceL, posName: input.posName !== undefined ? input.posName : p.posName };
  const suffix = getSettings().posSizeSuffix;
  const namesOf = (x: typeof next) => posNamesOf(x, suffix).map((n) => `${n.size}:${posNameKey(n.name)}`).join('|');
  if (namesOf(next) !== namesOf(p)) assertPosNameFree(next);
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  // Porsiyon doldurulunca (sayaç 0'dan yukarı) ürün satışa açılır. Kapalı ve siteye bağlıysa önce sitede (yalnız
  // yerelde açılan ürünü sitenin sonraki senkronu yeniden kapatırdı); site kabul etmezse 502 ve hiçbir alan kaydedilmez.
  // Sayaç bitmemişken yapılan kayıt (istasyon, renk, aynı sayaç) Satışta bilgisine dokunmaz: sitenin ya da kasiyerin
  // Tükendi'si yerinde kalır, siteye istek gitmez
  const refill = p.portionsLeft === 0 && input.portionsLeft != null && input.portionsLeft > 0;
  if (refill) Object.assign(patch, { active: true, soldOutBy: null });
  const save = (site: SiteWrite | null) => {
    const fx = new Effects();
    tx((t) => {
      t.update(schema.products).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.products.id, p.id)).run();
      if (groupIds && groupNames) writeProductGroups(t, fx, user, { id: p.id, name: input.name ?? p.name }, groupIds, groupNames);
      if (site) {
        dropSiteSoldOut(t, p.extId);
        fx.audit(t, {
          userId: user.id,
          action: 'product.available',
          entity: 'product',
          entityId: p.id,
          message: `${user.name}: ${p.name} porsiyonu dolduruldu (${input.portionsLeft}), satışa açıldı${site === 'guncellendi' ? ' (site ve uygulama da güncellendi)' : ''}`,
        });
      }
    });
    fx.flush();
    return site;
  };
  const site = refill && !p.active ? await reopenWithSite(p, user.name, save) : save(null);
  if (input.price !== undefined && input.price !== p.price) {
    changed('menu', 'product.updated', user.id, { action: 'menu.price', message: `${user.name} ${p.name} fiyatını değiştirdi` });
  } else changed('menu', site ? 'product.available' : 'product.updated', user.id);
  return c.json({ ok: true, ...(site ? { site } : {}) });
});

/** Yerel ürünü kaldırır: hiç satılmadıysa siler, satıldıysa gizler (geçmiş raporlar bozulmasın) */
adminRoutes.delete('/products/:id', (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const p = db.select().from(schema.products).where(eq(schema.products.id, c.req.param('id'))).get();
  if (!p) throw notFound('Ürün');
  if (p.extSource) throw conflict('Siteden gelen ürün sitede kaldırılır; LafPOS\'ta "Gizle" kullanın');
  const sold = db.select({ n: sql<number>`count(*)` }).from(schema.orderItems).where(eq(schema.orderItems.productId, p.id)).get();
  if ((sold?.n ?? 0) > 0) db.update(schema.products).set({ hidden: true, active: false }).where(eq(schema.products.id, p.id)).run();
  else db.delete(schema.products).where(eq(schema.products.id, p.id)).run();
  changed('menu', 'product.deleted', user.id, { action: 'menu.product_delete', message: `${user.name} ${p.name} ürününü kaldırdı` });
  return c.json({ ok: true });
});

adminRoutes.put('/products/:id/groups', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  // Geriye uyum: yeni istemci groupIds'i ürünün POST / PATCH gövdesinde gönderir (tek işlem)
  const { groupIds } = await body(c, z.object({ groupIds: groupIdsShape }));
  const p = db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, c.req.param('id'))).get();
  if (!p) throw new HttpError(422, 'Ürün bulunamadı (silinmiş olabilir); ekranı yenileyip yeniden deneyin', 'invalid_reference');
  const names = knownIds(schema.optionGroups, groupIds, 'seçenek grubu');
  const fx = new Effects();
  tx((t) => writeProductGroups(t, fx, user, p, groupIds, names));
  fx.emit({ topic: 'menu', kind: 'product.groups', byUserId: user.id }).flush();
  return c.json({ ok: true });
});

const groupShape = z.object({ name: z.string().min(1).max(40), kind: z.enum(['single', 'multi', 'counter']), required: z.boolean().default(false), maxSelect: z.number().int().min(1).max(10).default(1), sort: z.number().int().default(50), active: z.boolean().default(true) });
const itemShape = z.object({ name: z.string().min(1).max(40), price: kurus.default(0), isDefault: z.boolean().default(false), maxQty: z.number().int().min(1).max(9).default(1), sort: z.number().int().default(0), active: z.boolean().default(true) });
/** Gruba bağlı ürünler (Seçenekler'deki düzenleyici); gönderilmezse bağlar değişmez */
const productIdsShape = z.array(z.string()).max(500);

type PricedItem = { id: string; name: string; price: number; active: boolean; isDefault: boolean };
type GroupKind = 'single' | 'multi' | 'counter';

/** Tek seçimlik grubun etkin varsayılanı: kasa satışında seçeneksiz gelen gruba sunucu bunu yazar (`resolveOptions`) */
const effectiveDefault = (kind: GroupKind, items: PricedItem[]) => (kind === 'single' ? (items.find((i) => i.isDefault) ?? null) : null);

/**
 * Seçenek ek fiyatı denetim kaydına yazılır (AGENTS kural 4): eski → yeni fiyat, eklenen ve kaldırılan seçenek, ve
 * tek seçimlik grubun etkin varsayılanı ücretli bir seçenekten ya da ücretli bir seçeneğe geçtiyse (seçeneksiz kasa
 * satışının tutarı değişir: "varsayılan Cam → Karton +₺5,00"). Etkin varsayılan grubun açıklığına bağlıdır: kapalı
 * grup kasada yoktur, varsayılanı yazılmaz. Ücretli varsayılanlı grubu kapatmak "grup kapatıldı; varsayılan Karton
 * +₺5,00 → yok", açmak tersini yazar. Yalnız ad, adet sınırı, ücretsizden ücretsize varsayılan ya da ücretsiz
 * varsayılanlı grubun açılıp kapanması kayıt yazmaz.
 */
function auditOptionPrices(
  t: Tx,
  fx: Effects,
  user: AuthUser,
  group: { id: string; name: string },
  before: PricedItem[],
  after: PricedItem[],
  { created = false, kinds, active }: { created?: boolean; kinds?: { from: GroupKind; to: GroupKind }; active?: { from: boolean; to: boolean } } = {},
) {
  const was = before.filter((i) => i.active);
  const now = after.filter((i) => i.active);
  const changes = now.flatMap((a) => {
    const b = was.find((x) => x.id === a.id);
    return b && b.price !== a.price ? [{ id: a.id, name: a.name, from: b.price, to: a.price }] : [];
  });
  const added = now.filter((a) => !was.some((b) => b.id === a.id)).map(({ id, name, price }) => ({ id, name, price }));
  const removed = was.filter((b) => !now.some((a) => a.id === b.id)).map(({ id, name, price }) => ({ id, name, price }));
  const d0 = kinds && (active?.from ?? true) ? effectiveDefault(kinds.from, was) : null;
  const d1 = kinds && (active?.to ?? true) ? effectiveDefault(kinds.to, now) : null;
  const toggled = active && active.from !== active.to ? active.to : null;
  const defaultChange =
    d0?.id !== d1?.id && ((d0?.price ?? 0) > 0 || (d1?.price ?? 0) > 0)
      ? { from: d0 && { name: d0.name, price: d0.price }, to: d1 && { name: d1.name, price: d1.price } }
      : null;
  if (!changes.length && !added.length && !removed.length && !defaultChange) return;
  const priced = (i: { name: string; price: number }) => (i.price ? `${i.name} +${tl(i.price)}` : i.name);
  const parts = [
    toggled === null ? '' : toggled ? 'grup açıldı' : 'grup kapatıldı',
    ...changes.map((ch) => `${ch.name} ${tl(ch.from)} → ${tl(ch.to)}`),
    added.length ? `eklenen ${added.map(priced).join(', ')}` : '',
    removed.length ? `kaldırılan ${removed.map((i) => i.name).join(', ')}` : '',
    defaultChange ? `varsayılan ${defaultChange.from ? priced(defaultChange.from) : 'yok'} → ${defaultChange.to ? priced(defaultChange.to) : 'yok'}` : '',
  ].filter(Boolean);
  fx.audit(t, {
    userId: user.id,
    action: 'menu.option_price',
    entity: 'option_group',
    entityId: group.id,
    message: created ? `${user.name} "${group.name}" seçenek grubunu ekledi: ${parts.join('; ')}` : `${user.name} ${group.name} seçeneklerini değiştirdi: ${parts.join('; ')}`,
    data: { changes, added, removed, ...(defaultChange ? { defaultChange } : {}), ...(toggled === null ? {} : { groupActive: toggled }) },
  });
}

adminRoutes.post('/option-groups', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, groupShape.extend({ items: z.array(itemShape).max(30).default([]), productIds: productIdsShape.optional() }));
  const productNames = input.productIds ? knownIds(schema.products, input.productIds, 'ürün') : null;
  const id = ulid();
  const fx = new Effects();
  tx((t) => {
    t.insert(schema.optionGroups).values({ id, name: input.name, kind: input.kind, required: input.required, maxSelect: input.maxSelect, sort: input.sort, active: input.active }).run();
    const after = input.items.map((it, i) => {
      const row = { id: ulid(), groupId: id, ...it, sort: it.sort || i };
      t.insert(schema.optionItems).values(row).run();
      return row;
    });
    auditOptionPrices(t, fx, user, { id, name: input.name }, [], after, { created: true });
    if (input.productIds && productNames) writeGroupProducts(t, fx, user, { id, name: input.name }, input.productIds, productNames);
  });
  fx.emit({ topic: 'menu', kind: 'group.created', byUserId: user.id }).flush();
  return c.json({ id });
});

adminRoutes.put('/option-groups/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const g = db.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, c.req.param('id'))).get();
  if (!g) throw notFound('Seçenek grubu');
  if (g.extSource) throw conflict('Süt, şurup ve shot sitenin sabit listesinden gelir, site koduyla değişir; kasaya özel seçenek için yerel grup ekleyin', 'site_group');
  const input = await body(c, groupShape.extend({ items: z.array(itemShape.extend({ id: z.string().optional() })).max(30), productIds: productIdsShape.optional() }));
  const productNames = input.productIds ? knownIds(schema.products, input.productIds, 'ürün') : null;
  const fx = new Effects();
  tx((t) => {
    t.update(schema.optionGroups).set({ name: input.name, kind: input.kind, required: input.required, maxSelect: input.maxSelect, sort: input.sort, active: input.active }).where(eq(schema.optionGroups.id, g.id)).run();
    const existing = t.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).orderBy(asc(schema.optionItems.sort)).all();
    const keep = new Set<string>();
    const after: PricedItem[] = [];
    input.items.forEach((it, i) => {
      const { id, ...rest } = it;
      if (id && existing.some((e) => e.id === id)) {
        keep.add(id);
        t.update(schema.optionItems).set({ ...rest, sort: i }).where(eq(schema.optionItems.id, id)).run();
        after.push({ id, ...rest });
      } else {
        const row = { id: ulid(), groupId: g.id, ...rest, sort: i };
        t.insert(schema.optionItems).values(row).run();
        after.push(row);
      }
    });
    for (const e of existing) if (!keep.has(e.id)) t.update(schema.optionItems).set({ active: false }).where(eq(schema.optionItems.id, e.id)).run();
    auditOptionPrices(t, fx, user, { id: g.id, name: input.name }, existing, after, { kinds: { from: g.kind, to: input.kind }, active: { from: g.active, to: input.active } });
    if (input.productIds && productNames) writeGroupProducts(t, fx, user, { id: g.id, name: input.name }, input.productIds, productNames);
  });
  fx.emit({ topic: 'menu', kind: 'group.updated', byUserId: user.id }).flush();
  return c.json({ ok: true });
});

/** Gruptan ürünlere bağlama: yalnız bağlar değişir (site grubunda da; grubun kendisi sitenin) */
adminRoutes.put('/option-groups/:id/products', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const g = db.select({ id: schema.optionGroups.id, name: schema.optionGroups.name }).from(schema.optionGroups).where(eq(schema.optionGroups.id, c.req.param('id'))).get();
  if (!g) throw notFound('Seçenek grubu');
  const { productIds } = await body(c, z.object({ productIds: productIdsShape }));
  const names = knownIds(schema.products, productIds, 'ürün');
  const fx = new Effects();
  tx((t) => writeGroupProducts(t, fx, user, g, productIds, names));
  fx.emit({ topic: 'menu', kind: 'group.products', byUserId: user.id }).flush();
  return c.json({ ok: true });
});

const happyShape = z.object({
  name: z.string().min(1).max(60),
  // Haftanın günleri (1 pazartesi … 7 pazar), tekrarsız ve sıralı
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  start: clockTime,
  end: clockTime,
  percent: z.number().int().min(1).max(100),
  categoryIds: z.array(z.string()).default([]),
  productIds: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});

adminRoutes.get('/happy-hours', (c) => {
  requirePermission(c.get('user'), 'menu.yonet');
  return c.json(db.select().from(schema.happyHours).all());
});
adminRoutes.post('/happy-hours', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, happyShape);
  const id = ulid();
  db.insert(schema.happyHours).values({ id, ...input }).run();
  changed('menu', 'happy.created', user.id, { action: 'menu.happy', message: `${user.name} happy hour ekledi: ${input.name} %${input.percent}` });
  return c.json({ id });
});
adminRoutes.put('/happy-hours/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, happyShape);
  db.update(schema.happyHours).set(input).where(eq(schema.happyHours.id, c.req.param('id'))).run();
  changed('menu', 'happy.updated', user.id);
  return c.json({ ok: true });
});
adminRoutes.delete('/happy-hours/:id', (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  db.delete(schema.happyHours).where(eq(schema.happyHours.id, c.req.param('id'))).run();
  changed('menu', 'happy.deleted', user.id);
  return c.json({ ok: true });
});

// ─── Masa planı ─────────────────────────────────────────────────────────────

/** Karaoke odasının saat ücreti sitedekiyle aynı mı: sitenin fiyatı (ekran başına bir okuma; docs/03-ENTEGRASYON.md §2.4) */
adminRoutes.get('/floor/site-karaoke-price', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(await siteKaraokePrice());
});

adminRoutes.get('/floor', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json({ sections: db.select().from(schema.sections).orderBy(asc(schema.sections.sort)).all(), tables: db.select().from(schema.tables).orderBy(asc(schema.tables.sort)).all() });
});

adminRoutes.post('/sections', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, z.object({ name: z.string().min(1).max(40) }));
  const id = ulid();
  const max = db.select({ m: sql<number>`coalesce(max(${schema.sections.sort}), 0)` }).from(schema.sections).get();
  db.insert(schema.sections).values({ id, name: input.name, sort: (max?.m ?? 0) + 1 }).run();
  changed('tables', 'section.created', user.id);
  return c.json({ id });
});

adminRoutes.patch('/sections/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, z.object({ name: z.string().min(1).max(40).optional(), active: z.boolean().optional(), sort: z.number().int().optional() }));
  const section = db.select({ id: schema.sections.id }).from(schema.sections).where(eq(schema.sections.id, c.req.param('id'))).get();
  if (!section) throw notFound('Bölüm');
  db.update(schema.sections).set(patchFields(input)).where(eq(schema.sections.id, section.id)).run();
  changed('tables', 'section.updated', user.id);
  return c.json({ ok: true });
});

const tableShape = z.object({
  sectionId: z.string(),
  name: z.string().min(1).max(30),
  seats: z.number().int().min(1).max(40).default(2),
  shape: z.enum(['square', 'rect', 'round', 'bar']).default('square'),
  x: z.number().min(0).max(100).default(5),
  y: z.number().min(0).max(100).default(5),
  w: z.number().min(3).max(100).default(12),
  h: z.number().min(3).max(100).default(16),
  kind: z.enum(['masa', 'oda']).default('masa'),
  hourlyRate: kurus.nullish(),
  siteTableCode: z.string().max(40).nullish(),
  active: z.boolean().default(true),
});

adminRoutes.post('/tables', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, tableShape);
  const id = ulid();
  const max = db.select({ m: sql<number>`coalesce(max(${schema.tables.sort}), 0)` }).from(schema.tables).get();
  db.insert(schema.tables).values({ id, ...input, hourlyRate: input.hourlyRate ?? null, siteTableCode: input.siteTableCode ?? null, sort: (max?.m ?? 0) + 1 }).run();
  changed('tables', 'table.created', user.id);
  return c.json({ id });
});

adminRoutes.patch('/tables/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, patchOf(tableShape));
  const table = db.select({ id: schema.tables.id }).from(schema.tables).where(eq(schema.tables.id, c.req.param('id'))).get();
  if (!table) throw notFound('Masa');
  const id = table.id;
  const fields = patchFields(input);
  if (input.active === false) {
    const open = db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tableId, id), eq(schema.orders.status, 'acik'))).get();
    if (open) throw conflict('Açık adisyonu olan masa kaldırılamaz');
  }
  tx((t) => {
    t.update(schema.tables).set(fields).where(eq(schema.tables.id, id)).run();
    // QR'lı masanın adı ya da etkinliği değişti: sitenin masa listesi yenilenir (kodu olmayan masa siteye gitmez)
    const row = t.select({ qrCode: schema.tables.qrCode }).from(schema.tables).where(eq(schema.tables.id, id)).get();
    if (row?.qrCode && (input.name !== undefined || input.active !== undefined)) enqueueSiteTables(t);
  });
  changed('tables', 'table.updated', user.id);
  return c.json({ ok: true });
});

/** Masaya benzersiz QR kodu yazar; çakışma (2^50'de bir) yeniden çekilir */
function assignTableCode(t: Tx | DB, id: string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateTableCode();
    if (t.select({ id: schema.tables.id }).from(schema.tables).where(eq(schema.tables.qrCode, code)).get()) continue;
    t.update(schema.tables).set({ qrCode: code }).where(eq(schema.tables.id, id)).run();
    return code;
  }
  throw new HttpError(500, 'Benzersiz masa kodu üretilemedi', 'qr_code');
}

/**
 * Kodu olmayan bütün etkin masalara (oda değil) QR üretir. Kod sunucunundur: elle yazılmaz, PATCH ile değişmez
 * (`tableShape`'te yok). Sitenin de tanıması için liste giden kutusundan siteye gider (docs/03-ENTEGRASYON.md §2.3)
 */
adminRoutes.post('/tables/qr', (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const rows = db
    .select({ id: schema.tables.id })
    .from(schema.tables)
    .where(and(eq(schema.tables.active, true), eq(schema.tables.kind, 'masa'), isNull(schema.tables.qrCode)))
    .orderBy(asc(schema.tables.sort))
    .all();
  tx((t) => {
    for (const r of rows) assignTableCode(t, r.id);
    if (rows.length) enqueueSiteTables(t);
  });
  if (rows.length) {
    changed('tables', 'table.qr', user.id, { action: 'table.qr_created', message: `${user.name} ${rows.length} masaya QR kodu üretti` });
    void flushSiteOutbox();
  }
  return c.json({ created: rows.length });
});

/** Masanın QR kodu: yoksa üretir; `rotate` ile yeniler (basılı eski kart o anda geçersiz olur, denetime yazılır) */
adminRoutes.post('/tables/:id/qr', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, z.object({ rotate: z.boolean().optional() }));
  const table = db.select().from(schema.tables).where(eq(schema.tables.id, c.req.param('id'))).get();
  if (!table) throw notFound('Masa');
  // Oda (karaoke) sitede masa değildir: QR yalnız masaya (toplu üretim ve kart sayfasıyla aynı kural)
  if (table.kind !== 'masa') throw bad('QR yalnız masaya üretilir; odaya değil', 'not_table');
  if (table.qrCode && !input.rotate) return c.json({ qrCode: table.qrCode, url: tableQrUrl(table.qrCode), changed: false });
  const code = tx((t) => {
    // Eski kod sitede de kapansın: pasif olarak listeye girer
    if (table.qrCode) retireTableCode(table.qrCode);
    const next = assignTableCode(t, table.id);
    enqueueSiteTables(t);
    return next;
  });
  changed('tables', 'table.qr', user.id, {
    action: table.qrCode ? 'table.qr_rotated' : 'table.qr_created',
    message: table.qrCode ? `${user.name} ${table.name} masasının QR kodunu yeniledi; eski kod siteye pasif olarak bildirilir` : `${user.name} ${table.name} masasına QR kodu üretti`,
  });
  void flushSiteOutbox();
  return c.json({ qrCode: code, url: tableQrUrl(code), changed: true });
});

/** Yönetim › Entegrasyon: masa kodlarını siteye yeniden gönder (site ucu sonradan açıldıysa beklemeden) */
adminRoutes.post('/tables/qr/sync', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const queued = enqueueSiteTables(db);
  if (!queued) throw conflict('Site bağlantı anahtarı tanımlı değil (LAFFOGATO_SYNC_SECRET)', 'not_configured');
  const r = await flushSiteOutbox();
  return c.json({ ok: true, sent: r.sent, failed: r.failed });
});

/** Plan düzenleyiciden toplu konum kaydı */
adminRoutes.put('/tables/layout', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const { tables } = await body(c, z.object({ tables: z.array(z.object({ id: z.string(), x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(3).max(100), h: z.number().min(3).max(100) })).max(300) }));
  tx((t) => {
    for (const tb of tables) t.update(schema.tables).set({ x: tb.x, y: tb.y, w: tb.w, h: tb.h }).where(eq(schema.tables.id, tb.id)).run();
  });
  changed('tables', 'layout', user.id, { action: 'floor.layout', message: `${user.name} masa planını düzenledi` });
  return c.json({ ok: true });
});

// ─── İstasyon ve yazıcı ─────────────────────────────────────────────────────

adminRoutes.get('/stations', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json({ stations: db.select().from(schema.stations).orderBy(asc(schema.stations.sort)).all(), printers: db.select().from(schema.printers).all() });
});
adminRoutes.post('/stations', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, z.object({ name: z.string().min(1).max(30), kind: z.enum(['bar', 'mutfak', 'diger']), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#245c43') }));
  const id = ulid();
  db.insert(schema.stations).values({ id, ...input, sort: 9 }).run();
  changed('menu', 'station.created', user.id);
  return c.json({ id });
});
adminRoutes.patch('/stations/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, z.object({ name: z.string().min(1).max(30).optional(), active: z.boolean().optional(), color: z.string().optional(), printerId: z.string().nullish() }));
  const station = db.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.id, c.req.param('id'))).get();
  if (!station) throw notFound('İstasyon');
  db.update(schema.stations).set(patchFields(input)).where(eq(schema.stations.id, station.id)).run();
  changed('menu', 'station.updated', user.id);
  return c.json({ ok: true });
});

// ─── Personel ───────────────────────────────────────────────────────────────

adminRoutes.get('/users', (c) => {
  requirePermission(c.get('user'), 'personel.yonet');
  // Kaldırılmış yetkinin anahtarı listede gelmez: ekran onu geri gönderse "Bilinmeyen yetki" diye düzenleme düşerdi
  return c.json(
    db
      .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, color: schema.users.color, active: schema.users.active, permGrant: schema.users.permGrant, permRevoke: schema.users.permRevoke, maxDiscountPct: schema.users.maxDiscountPct, lastLoginAt: schema.users.lastLoginAt })
      .from(schema.users)
      .orderBy(asc(schema.users.name))
      .all()
      .map((u) => ({ ...u, permGrant: u.permGrant.filter(isPermission), permRevoke: u.permRevoke.filter(isPermission) })),
  );
});

const permList = z.array(z.string().refine((p) => (ALL_PERMISSIONS as string[]).includes(p), 'Bilinmeyen yetki'));
const userShape = z.object({
  name: z.string().min(1).max(40),
  role: z.enum(ROLES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#245c43'),
  maxDiscountPct: z.number().int().min(0).max(100).default(10),
  permGrant: permList.default([]),
  permRevoke: permList.default([]),
});


// ─── Roller (ModPOS "Pozisyonlar" gibi) ───────────────────────────────────────

adminRoutes.get('/roles', (c) => {
  requirePermission(c.get('user'), 'personel.yonet');
  const matrix = getSettings().rolePermissions;
  const counts = db
    .select({ role: schema.users.role, n: sql<number>`count(*)` })
    .from(schema.users)
    .where(eq(schema.users.active, true))
    .groupBy(schema.users.role)
    .all();
  return c.json({
    groups: PERMISSION_GROUPS,
    roles: ROLES.map((role) => ({
      role,
      label: ROLE_LABELS[role],
      locked: LOCKED_ROLES.includes(role),
      permissions: rolePermissions(role, matrix),
      defaults: ROLE_DEFAULTS[role],
      custom: !!matrix[role],
      users: counts.find((x) => x.role === role)?.n ?? 0,
    })),
  });
});

/** Rolün yetki setini yazar; varsayılanla aynıysa özel kaydı siler. Patron rolü kilitli. */
adminRoutes.put('/roles/:role', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'personel.yonet');
  const role = ROLES.find((r) => r === c.req.param('role'));
  if (!role) throw notFound('Rol bulunamadı');
  if (LOCKED_ROLES.includes(role)) throw bad('Patron rolü her yetkiye sahiptir, değiştirilemez', 'role_locked');
  const input = await body(c, z.object({ permissions: permList }));
  const next = ALL_PERMISSIONS.filter((p) => (input.permissions as string[]).includes(p));
  const matrix = { ...getSettings().rolePermissions };
  const before = rolePermissions(role, matrix);
  const defaults = ROLE_DEFAULTS[role];
  assertCanManage(user, before, undefined, 'rolü');
  assertCanGrant(user, next.filter((p) => !before.includes(p)));
  if (next.length === defaults.length && next.every((p) => defaults.includes(p))) delete matrix[role];
  else matrix[role] = next;
  updateSettings({ rolePermissions: matrix });
  // Açık canlı akışlar yeni yetkiyle süzülsün (patron paneli alınanın uyarıları kesilir)
  sessionsChanged();
  const added = next.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !next.includes(p));
  if (added.length || removed.length) {
    const parts = [added.length && `eklenen: ${added.map((p) => PERMISSIONS[p]).join(', ')}`, removed.length && `kaldırılan: ${removed.map((p) => PERMISSIONS[p]).join(', ')}`].filter(Boolean);
    const fx = new Effects();
    fx.audit(db, { userId: user.id, action: 'role.permissions', severity: 'uyari', message: `${ROLE_LABELS[role]} rolünün yetkileri değişti (${parts.join('; ')})` });
    fx.emit({ topic: 'users', kind: 'roles', byUserId: user.id });
    fx.flush();
  }
  return c.json({ role, permissions: rolePermissions(role, matrix), custom: !!matrix[role] });
});

/**
 * Yetki yükseltme yok: kimse sahip olmadığı yetkiyi bir role ya da kişiye veremez (inceleme, 26 Eki 2026).
 * Patron her yetkiye sahip olduğu için onu kısıtlamaz.
 */
function assertCanGrant(actor: AuthUser, gained: Permission[]) {
  const missing = gained.filter((p) => !actor.permissions.has(p));
  if (missing.length) throw new HttpError(403, `Sahip olmadığınız yetkiyi veremezsiniz: ${missing.map((p) => PERMISSIONS[p]).join(', ')}`, 'escalation');
}

/**
 * Üstündekine dokunulmaz (inceleme, 26 Eki 2026): patron olmayan yetkili yalnız yetkileri kendi yetkilerinin içinde
 * kalan kişiyi ve rolü değiştirebilir. Yoksa üstündekinin PIN'ini değiştirip onun hesabıyla girer, onu kapatır ya da
 * rolünü boşaltırdı. İndirim sınırı da kendi sınırını aşamaz (kukla hesapla sınırsız indirim olmasın).
 */
function assertCanManage(actor: AuthUser, targetPerms: Iterable<Permission>, targetDiscountPct?: number, what = 'kişiyi') {
  if (actor.role === 'patron') return;
  const missing = [...targetPerms].filter((p) => !actor.permissions.has(p));
  if (missing.length) throw new HttpError(403, `Sizden fazla yetkisi olan ${what} değiştiremezsiniz (${missing.map((p) => PERMISSIONS[p]).join(', ')})`, 'escalation');
  assertDiscountCap(actor, targetDiscountPct);
}

function assertDiscountCap(actor: AuthUser, pct: number | undefined) {
  if (actor.role !== 'patron' && pct !== undefined && pct > actor.maxDiscountPct) {
    throw new HttpError(403, `İndirim sınırı sizinkini (%${actor.maxDiscountPct}) aşamaz`, 'escalation');
  }
}

/** Kişinin kayıt sonrası etkin yetkileri (rol seti + kişiye özel) */
function userPermissions(u: { role: Role; permGrant: Permission[]; permRevoke: Permission[] }): Set<Permission> {
  return effectivePermissions(u.role, { grant: u.permGrant, revoke: u.permRevoke }, getSettings().rolePermissions);
}

/** En az bir etkin patron, personel yönetimiyle kalmalı: panel kimseye kilitlenmesin */
function assertPatronRemains(t: Tx | DB, changedId: string, next: { role: Role; active: boolean; permGrant: Permission[]; permRevoke: Permission[] }) {
  const others = t
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.role, 'patron'), eq(schema.users.active, true)))
    .all()
    .filter((u) => u.id !== changedId && userPermissions(u).has('personel.yonet'));
  const stays = next.role === 'patron' && next.active && userPermissions(next).has('personel.yonet');
  if (!stays && !others.length) throw conflict('Personel yönetimi olan son etkin patron hesabı kapatılamaz, rolü değiştirilemez', 'last_patron');
}

/**
 * PIN tekil olmalı (giriş yalnız PIN'le), bu yüzden "kullanılamaz" yanıtı PIN'in başka birinde olduğunu söyler.
 * Personel yöneticisi kukla hesaba PIN verip tarayarak patronun PIN'ini bulamasın (denetim, 26 Eki 2026): patron
 * olmayanın her PIN verme denemesi kişi ve cihaz başına sayılır (uzun vadede saatte 12, kilit denetim kaydına
 * alarm yazar), yanıt PIN'in kimde olduğunu söylemez, çakışma denetim kaydına düşer. Patron her hesabı zaten
 * yönetir (PIN'ini değiştirip girebilir); kurulumda bütün ekibe art arda PIN verir, sınır ona uygulanmaz.
 */
function pinFree(c: Context<AppEnv>, pin: string, target: { id?: string; name: string }) {
  const actor = c.get('user');
  if (!isValidPin(pin)) throw bad('PIN 4-6 haneli rakam olmalı', 'pin_invalid');
  if (actor.role !== 'patron') {
    const addr = clientKey(c);
    assertNotLocked('pin', addr, actor.id);
    recordPinChoice(addr, actor);
  }
  const other = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get();
  if (other && other.id !== target.id) {
    // Kaydı okuyan yönetici de PIN'in kimde olduğunu metinden öğrenmesin; kayıt PIN sahibine bağlı (entityId)
    const fx = new Effects();
    fx.audit(db, {
      userId: actor.id,
      action: 'user.pin_conflict',
      severity: actor.role === 'patron' ? 'info' : 'uyari',
      entity: 'user',
      entityId: other.id,
      message: `${actor.name}, ${target.name} için başka bir personelin kullandığı PIN'i seçti; PIN verilmedi. O personelin PIN'i değiştirilmeli`,
    });
    fx.flush();
    throw conflict('Bu PIN kullanılamaz; farklı bir PIN seçin', 'pin_taken');
  }
}

adminRoutes.post('/users', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'personel.yonet');
  const input = await body(c, userShape.extend({ pin: z.string() }));
  if (input.role === 'patron' && user.role !== 'patron') throw conflict('Patron hesabını yalnız patron açabilir');
  assertCanGrant(user, [...userPermissions({ role: input.role, permGrant: input.permGrant as Permission[], permRevoke: input.permRevoke as Permission[] })]);
  assertDiscountCap(user, input.maxDiscountPct);
  pinFree(c, input.pin, { name: input.name });
  const id = ulid();
  db.insert(schema.users).values({ id, name: input.name, role: input.role, color: input.color, maxDiscountPct: input.maxDiscountPct, permGrant: input.permGrant as Permission[], permRevoke: input.permRevoke as Permission[], pinHash: hashPin(input.pin) }).run();
  changed('users', 'user.created', user.id, { action: 'user.create', message: `${user.name} personel ekledi: ${input.name} (${input.role})` });
  return c.json({ id });
});

adminRoutes.patch('/users/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'personel.yonet');
  const input = await body(c, patchOf(userShape).extend({ pin: z.string().optional(), active: z.boolean().optional() }));
  const target = db.select().from(schema.users).where(eq(schema.users.id, c.req.param('id'))).get();
  if (!target) throw notFound('Personel');
  if ((target.role === 'patron' || input.role === 'patron') && user.role !== 'patron') throw conflict('Patron hesabını yalnız patron değiştirebilir');
  if (input.active === false && target.id === user.id) throw conflict('Kendi hesabınızı kapatamazsınız');
  const next = {
    role: input.role ?? target.role,
    active: input.active ?? target.active,
    permGrant: (input.permGrant as Permission[] | undefined) ?? target.permGrant,
    permRevoke: (input.permRevoke as Permission[] | undefined) ?? target.permRevoke,
  };
  const before = userPermissions(target);
  const after = userPermissions(next);
  const permsChange = next.role !== target.role || [...before].some((p) => !after.has(p)) || [...after].some((p) => !before.has(p)) || (input.maxDiscountPct !== undefined && input.maxDiscountPct !== target.maxDiscountPct);
  if (target.id === user.id && permsChange) throw new HttpError(403, 'Kendi rolünüzü, yetkilerinizi ve indirim sınırınızı değiştiremezsiniz; başka bir yetkili değiştirsin', 'self_edit');
  if (target.id !== user.id) assertCanManage(user, before, target.maxDiscountPct);
  assertDiscountCap(user, input.maxDiscountPct);
  assertCanGrant(user, [...after].filter((p) => !before.has(p)));
  if (target.role === 'patron') assertPatronRemains(db, target.id, next);
  const patch: Partial<typeof schema.users.$inferInsert> = {};
  for (const k of ['name', 'role', 'color', 'maxDiscountPct', 'active'] as const) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
  if (input.permGrant) patch.permGrant = input.permGrant as Permission[];
  if (input.permRevoke) patch.permRevoke = input.permRevoke as Permission[];
  if (input.pin) {
    pinFree(c, input.pin, target);
    patch.pinHash = hashPin(input.pin);
  }
  const fields = patchFields(patch);
  tx((t) => {
    t.update(schema.users).set(fields).where(eq(schema.users.id, target.id)).run();
    // Yetki ya da PIN değişince açık oturumlar kapanır
    if (input.pin || input.role || input.permGrant || input.permRevoke || input.active === false) t.delete(schema.sessions).where(eq(schema.sessions.userId, target.id)).run();
  });
  // Oturumu kapanan ya da yetkisi değişen kişinin açık canlı akışı hemen kapanır ya da yeni yetkiyle süzülür
  sessionsChanged();
  // Patron PIN'ini değiştirince kurulum modu kapanır (örnek PIN'ler giriş ekranından kalkar)
  if (input.pin && target.role === 'patron' && getSettings().demoMode) updateSettings({ demoMode: false });
  changed('users', 'user.updated', user.id, { action: 'user.update', message: `${user.name} ${target.name} hesabını güncelledi${input.pin ? ' (PIN değişti)' : ''}` });
  return c.json({ ok: true });
});

// ─── Ödeme türleri ──────────────────────────────────────────────────────────

const methodShape = z.object({
  name: z.string().min(1).max(30),
  kind: z.enum(['nakit', 'kart', 'yemek', 'havale', 'cari', 'online', 'diger']),
  zField: z.enum(['cash', 'card', 'meal_card', 'online', 'other']),
  // lafmaliyet'in komisyon anahtarı: serbest metin değil, seçim (lafmaliyet src/lib/commission/channels.ts)
  channel: z.enum(PAYMENT_CHANNELS).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#245c43'),
  sort: z.number().int().default(20),
  active: z.boolean().default(true),
});
/**
 * Nakit türü (`kind = 'nakit'`; para üstü, çekmece) yalnız Z'nin Nakit alanına gider, Nakit alanına da yalnız nakit
 * türü. Beklenen nakit ve Z nakdi ikisi de ödemeye dondurulan `zField`'dan sayılır (services/days.ts); eşleşme,
 * kasada nakit alınan paranın beklenen nakde de girmesini sağlar.
 */
function assertCashPair(kind: string, zField: string) {
  if ((kind === 'nakit') !== (zField === 'cash')) throw bad('Nakit türü yalnız lafmaliyet\'in Nakit alanına bağlanır; Nakit alanına da yalnız nakit türü', 'cash_pair');
}

adminRoutes.get('/payment-methods', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(db.select().from(schema.paymentMethods).orderBy(asc(schema.paymentMethods.sort)).all());
});
adminRoutes.post('/payment-methods', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, methodShape);
  assertCashPair(input.kind, input.zField);
  const id = ulid();
  db.insert(schema.paymentMethods).values({ id, ...input, channel: input.channel ?? null }).run();
  changed('settings', 'method.created', user.id);
  return c.json({ id });
});
adminRoutes.patch('/payment-methods/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, patchOf(methodShape));
  const m = db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, c.req.param('id'))).get();
  if (!m) throw notFound('Ödeme türü');
  // Yalnız tür ya da alan değişiyorsa: eski bir uyumsuz kayıt kapatılabilsin ("Kapat" yalnız `active` gönderir)
  if (input.kind !== undefined || input.zField !== undefined) assertCashPair(input.kind ?? m.kind, input.zField ?? m.zField);
  db.update(schema.paymentMethods).set(patchFields(input)).where(eq(schema.paymentMethods.id, m.id)).run();
  changed('settings', 'method.updated', user.id);
  return c.json({ ok: true });
});

// ─── Ayarlar ────────────────────────────────────────────────────────────────

adminRoutes.get('/settings', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(getSettings());
});

/** Z zinciri (Ayarlar › İlk Z numarası'nın altındaki bilgi): kayıtlı en büyük Z ve açılacak günün Z'si */
adminRoutes.get('/settings/z', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const lastZ = lastZNo(db);
  return c.json({ lastZ: lastZ || null, nextZ: nextZNo(lastZ, getSettings().zNoStart) });
});

const settingsShape = patchOf(
  z.object({
    businessName: z.string().max(60),
    businessAddress: z.string().max(200),
    businessPhone: z.string().max(30),
    receiptHeader: z.string().max(300),
    receiptFooter: z.string().max(300),
    serviceRate: z.number().int().min(0).max(30),
    autoLockMinutes: z.number().int().min(0).max(120),
    keepAwake: z.boolean(),
    productImages: z.boolean(),
    askOptions: z.enum(['zorunlu', 'hep']),
    voidReasons: z.array(z.string().max(40)).max(12),
    compReasons: z.array(z.string().max(40)).max(12),
    odenmezReasons: z.array(z.string().max(40)).max(12),
    zayiReasons: z.array(z.string().max(40)).max(12),
    discountReasons: z.array(z.string().max(40)).max(12),
    quickCash: z.array(kurus).max(8),
    sizeLabels: z.object({ M: z.string().max(12), L: z.string().max(12) }),
    requireDayOpen: z.boolean(),
    kitchenWarnMinutes: z.number().int().min(1).max(120),
    kitchenAlarmMinutes: z.number().int().min(1).max(240),
    roomBillingStepMinutes: z.number().int().min(1).max(120),
    roomMinimumMinutes: z.number().int().min(0).max(600),
    stampGoal: z.number().int().min(1).max(50),
    stampCategoryKeys: z.array(z.string().max(30)).max(20),
    demoMode: z.boolean(),
    menuAutoSync: z.boolean(),
    onlineOrdersSync: z.boolean(),
    posSizeSuffix: z.object({ M: z.string().max(12), L: z.string().max(12), TEK: z.string().max(12) }),
    alertDiscountPct: z.number().int().min(1).max(100),
    alertCashDiffKurus: kurus,
    backupKeep: z.number().int().min(1).max(365),
    // Şube kimliği lafmaliyet'teki kuralla aynı olmalı (docs/SUBE.md): harfle başlar,
    // küçük harf / rakam / tire, 2-24 karakter. Yanlış yazılırsa gün yanlış şubeye gider
    branchId: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/, 'Şube kimliği harfle başlamalı; küçük harf, rakam ve tire'),
    autoDayEnd: z.boolean(),
    autoDayEndHour: z.number().int().min(0).max(23),
    serviceMode: z.enum(SERVICE_MODES),
    tipsEnabled: z.boolean(),
    barEnabled: z.boolean(),
    zNoStart: z.number().int().min(1).max(Z_NO_MAX).nullable(),
    // Müşteri ekranı bütün olarak gelir (Yönetim › Müşteri ekranı formu); adres yalnız http(s), boşsa karekod yok
    customerDisplay: z.object({
      theme: z.enum(CUSTOMER_DISPLAY_THEMES),
      welcomeTitle: z.string().trim().max(60),
      welcomeSubtitle: z.string().trim().max(90),
      thanksTitle: z.string().trim().max(60),
      messages: z.array(z.string().trim().min(1).max(90)).max(6),
      qrUrl: z.union([z.literal(''), z.string().trim().max(300).regex(/^https?:\/\/\S+$/, 'Adres http:// ya da https:// ile başlamalı')]),
      qrLabel: z.string().trim().max(60),
      showClock: z.boolean(),
      showOptions: z.boolean(),
    }),
  }),
);

/**
 * Ayarın değeri aynı mı: nesneler anahtar sırası gözetmeden (aynı müşteri ekranı ya da boy adları başka sırayla da
 * gelebilir), diziler sırasıyla karşılaştırılır
 */
function sameSetting(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown) =>
    JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x));
  return canonical(a) === canonical(b);
}

adminRoutes.put('/settings', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, settingsShape);
  if (input.menuAutoSync !== undefined || input.onlineOrdersSync !== undefined) requirePermission(user, 'senkron.yonet');
  const prev = getSettings();
  // Bar fişi alarmı uyarıdan uzun olmalı: bar ekranı önce alarma bakar, kısa ya da eşit alarmda fiş amberi hiç
  // göstermez. Yalnız çift değişiyorsa denetlenir (bütün formu yeniden gönderen kayıt eski bir çifte takılmasın)
  const warn = input.kitchenWarnMinutes ?? prev.kitchenWarnMinutes;
  const alarm = input.kitchenAlarmMinutes ?? prev.kitchenAlarmMinutes;
  if ((warn !== prev.kitchenWarnMinutes || alarm !== prev.kitchenAlarmMinutes) && alarm <= warn) throw new HttpError(422, 'Bar fişi alarmı uyarıdan uzun olmalı', 'kitchen_alarm');
  const before = serviceModeOf(prev);
  const zFrom = prev.zNoStart;
  // İlk Z numarası yalnız değiştiyse denetlenir ve kayda düşer (aynı değeri yeniden göndermek değişiklik değil)
  const zChanged = input.zNoStart !== undefined && input.zNoStart !== zFrom;
  const fx = new Effects();
  tx((t) => {
    // Z zinciri geri alınmaz: ilk Z numarası kayıtlı en büyük Z'den büyük olmalı (boşaltmak serbest, zinciri değiştirmez)
    if (zChanged && input.zNoStart != null) {
      const last = lastZNo(t);
      if (input.zNoStart <= last) throw new HttpError(422, `Z numarası geri alınamaz; son Z ${last}`, 'z_start_low');
    }
    updateSettings(input, t);
    // Denetime yalnız gerçekten değişen ayarlar, Türkçe adlarıyla (Denetim kaydı ", " ile böler); hiçbiri değişmediyse
    // kayıt yok. Servis modu ve ilk Z numarası aşağıdaki kendi okunur kayıtlarına düşer, burada ikinci kez yazılmaz
    const was = prev as unknown as Record<string, unknown>;
    const sent = input as Record<string, unknown>;
    const changedKeys = Object.keys(sent).filter((k) => k !== 'serviceMode' && k !== 'zNoStart' && sent[k] !== undefined && !sameSetting(sent[k], was[k]));
    if (changedKeys.length) fx.audit(t, { userId: user.id, action: 'settings.update', message: `${user.name} ayarları değiştirdi: ${changedKeys.map(settingLabel).join(', ')}` });
    // Servis modu bütün sistemin akışını değiştirir (açılış ekranı, menü, tezgâh satışı): ayrı ve okunur kayıt
    if (input.serviceMode && input.serviceMode !== before) {
      fx.audit(t, {
        userId: user.id,
        action: 'settings.servis_modu',
        entity: 'settings',
        entityId: 'serviceMode',
        message: `${user.name} servis modunu değiştirdi: ${SERVICE_MODE_LABEL[before]} → ${SERVICE_MODE_LABEL[input.serviceMode]}`,
        data: { from: before, to: input.serviceMode },
      });
    }
    if (zChanged) {
      const show = (n: number | null | undefined) => (n == null ? 'boş' : String(n));
      fx.audit(t, {
        userId: user.id,
        action: 'settings.z_start',
        severity: 'uyari',
        entity: 'settings',
        entityId: 'zNoStart',
        message: `${user.name} ilk Z numarasını değiştirdi: ${show(zFrom)} → ${show(input.zNoStart)}`,
        data: { from: zFrom, to: input.zNoStart },
      });
    }
  });
  fx.emit({ topic: 'settings', kind: 'settings.updated', byUserId: user.id });
  fx.flush();
  return c.json(getSettings());
});

adminRoutes.get('/settings/defaults', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json({ ...PUBLIC_DEFAULTS, ...PRIVATE_DEFAULTS });
});

// ─── Denetim kaydı ve yedek ─────────────────────────────────────────────────

adminRoutes.get('/audit', (c) => {
  const user = c.get('user');
  if (!can(user, 'patron.panel')) requirePermission(user, 'ayar.yonet');
  const q = query(
    c,
    z.object({
      from: z.coerce.number().optional(),
      to: z.coerce.number().optional(),
      severity: z.enum(['info', 'uyari', 'alarm', 'tum']).default('tum'),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
  );
  const conds = [];
  if (q.from) conds.push(gte(schema.auditLog.at, q.from));
  if (q.to) conds.push(lte(schema.auditLog.at, q.to));
  if (q.severity !== 'tum') conds.push(eq(schema.auditLog.severity, q.severity));
  const names = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  const rows = db
    .select()
    .from(schema.auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.auditLog.at))
    .limit(q.limit)
    .all()
    .map((a) => ({ ...a, userName: a.userId ? (names.get(a.userId) ?? null) : null, approverName: a.approverId ? (names.get(a.approverId) ?? null) : null }));
  // Patron paneli yetkilisi maliyeti görmeyebilir: platform ayarının komisyon oranı ona maskelenir
  const sees = seesCommission(user);
  return c.json(rows.map((a) => auditForViewer(a, sees)));
});

/** Tablet ve telefonların bağlanacağı adresler (Yönetim › Ağ ve uzaktan erişim); patron uzaktan da açar */
adminRoutes.get('/network', (c) => {
  const user = c.get('user');
  if (!can(user, 'ayar.yonet')) requirePermission(user, 'patron.panel');
  const { lastSize: _size, ...cloud } = cloudState();
  return c.json({ ...networkInfo(), cloud });
});

/** Sürüm ve otomatik güncelleme (Ayarlar ve yedek kartı; salt okunur) */
adminRoutes.get('/guncelleme', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json({ installed: installedVersion(), status: readUpdateStatus() });
});

adminRoutes.get('/backups', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const dir = resolve(env.dataDir, 'backups');
  let files: { name: string; size: number; at: number }[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = statSync(resolve(dir, f));
        return { name: f, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    files = [];
  }
  return c.json({ dir, files });
});

adminRoutes.post('/backups', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const file = await backupNow();
  return c.json({ file });
});

