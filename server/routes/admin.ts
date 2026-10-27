import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { posNameKey, posNamesOf, posSlotOf } from '@shared/pos-name';
import { PAYMENT_CHANNELS } from '@shared/labels';
import { ALL_PERMISSIONS, effectivePermissions, LOCKED_ROLES, type Permission, PERMISSION_GROUPS, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, rolePermissions, ROLES } from '@shared/permissions';
import { type DB, db, schema, type Tx, tx } from '../db/client';
import { backupNow } from '../jobs';
import { type AppEnv, type AuthUser, can, hashPin, isValidPin, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { bad, body, conflict, HttpError, kurus, notFound, patchOf, query } from '../lib/http';
import { ulid } from '../lib/ids';
import { networkInfo } from '../lib/network';
import { cloudState } from '../sync/cloud';
import { getSettings, PRIVATE_DEFAULTS, PUBLIC_DEFAULTS, updateSettings } from '../lib/settings';
import { menuOptionGroups, menuProducts } from '../services/bootstrap';
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
  db.update(schema.categories).set(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))).where(eq(schema.categories.id, cat.id)).run();
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

adminRoutes.post('/products', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, productLocal.merge(productPos));
  if (!db.select().from(schema.categories).where(eq(schema.categories.id, input.categoryId)).get()) throw notFound('Kategori');
  assertPosNameFree({ id: null, name: input.name, posName: input.posName ?? null, priceL: input.priceL ?? null, extSource: null, extId: null });
  const id = ulid();
  db.insert(schema.products)
    .values({ id, ...input, priceL: input.priceL ?? null, isService: input.isService ?? false, active: true })
    .run();
  changed('menu', 'product.created', user.id, { action: 'menu.product', message: `${user.name} yerel ürün ekledi: ${input.name}` });
  return c.json({ id });
});

adminRoutes.patch('/products/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const p = db.select().from(schema.products).where(eq(schema.products.id, c.req.param('id'))).get();
  if (!p) throw notFound('Ürün');
  const input = await body(c, patchOf(productLocal).merge(patchOf(productPos)));
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
  if (patch.portionsLeft !== undefined && patch.portionsLeft !== null && (patch.portionsLeft as number) > 0) (patch as Record<string, unknown>).active = true;
  db.update(schema.products).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.products.id, p.id)).run();
  if (input.price !== undefined && input.price !== p.price) {
    changed('menu', 'product.updated', user.id, { action: 'menu.price', message: `${user.name} ${p.name} fiyatını değiştirdi` });
  } else changed('menu', 'product.updated', user.id);
  return c.json({ ok: true });
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
  const { groupIds } = await body(c, z.object({ groupIds: z.array(z.string()).max(12) }));
  const id = c.req.param('id');
  tx((t) => {
    t.delete(schema.productOptionGroups).where(eq(schema.productOptionGroups.productId, id)).run();
    groupIds.forEach((groupId, i) => t.insert(schema.productOptionGroups).values({ productId: id, groupId, sort: i }).run());
  });
  changed('menu', 'product.groups', user.id);
  return c.json({ ok: true });
});

const groupShape = z.object({ name: z.string().min(1).max(40), kind: z.enum(['single', 'multi', 'counter']), required: z.boolean().default(false), maxSelect: z.number().int().min(1).max(10).default(1), sort: z.number().int().default(50), active: z.boolean().default(true) });
const itemShape = z.object({ name: z.string().min(1).max(40), price: kurus.default(0), isDefault: z.boolean().default(false), maxQty: z.number().int().min(1).max(9).default(1), sort: z.number().int().default(0), active: z.boolean().default(true) });

adminRoutes.post('/option-groups', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const input = await body(c, groupShape.extend({ items: z.array(itemShape).max(30).default([]) }));
  const id = ulid();
  tx((t) => {
    t.insert(schema.optionGroups).values({ id, name: input.name, kind: input.kind, required: input.required, maxSelect: input.maxSelect, sort: input.sort, active: input.active }).run();
    input.items.forEach((it, i) => t.insert(schema.optionItems).values({ id: ulid(), groupId: id, ...it, sort: it.sort || i }).run());
  });
  changed('menu', 'group.created', user.id);
  return c.json({ id });
});

adminRoutes.put('/option-groups/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'menu.yonet');
  const g = db.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, c.req.param('id'))).get();
  if (!g) throw notFound('Seçenek grubu');
  if (g.extSource) throw conflict('Bu grup siteden geliyor (süt, şurup…); fiyatları sitede değişir');
  const input = await body(c, groupShape.extend({ items: z.array(itemShape.extend({ id: z.string().optional() })).max(30) }));
  tx((t) => {
    t.update(schema.optionGroups).set({ name: input.name, kind: input.kind, required: input.required, maxSelect: input.maxSelect, sort: input.sort, active: input.active }).where(eq(schema.optionGroups.id, g.id)).run();
    const existing = t.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).all();
    const keep = new Set<string>();
    input.items.forEach((it, i) => {
      const { id, ...rest } = it;
      if (id && existing.some((e) => e.id === id)) {
        keep.add(id);
        t.update(schema.optionItems).set({ ...rest, sort: i }).where(eq(schema.optionItems.id, id)).run();
      } else t.insert(schema.optionItems).values({ id: ulid(), groupId: g.id, ...rest, sort: i }).run();
    });
    for (const e of existing) if (!keep.has(e.id)) t.update(schema.optionItems).set({ active: false }).where(eq(schema.optionItems.id, e.id)).run();
  });
  changed('menu', 'group.updated', user.id);
  return c.json({ ok: true });
});

const happyShape = z.object({
  name: z.string().min(1).max(60),
  days: z.array(z.number().int().min(1).max(7)).min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
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
  db.update(schema.sections).set(input).where(eq(schema.sections.id, c.req.param('id'))).run();
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
  const id = c.req.param('id');
  if (input.active === false) {
    const open = db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tableId, id), eq(schema.orders.status, 'acik'))).get();
    if (open) throw conflict('Açık adisyonu olan masa kaldırılamaz');
  }
  db.update(schema.tables).set(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))).where(eq(schema.tables.id, id)).run();
  changed('tables', 'table.updated', user.id);
  return c.json({ ok: true });
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
  db.update(schema.stations).set(input).where(eq(schema.stations.id, c.req.param('id'))).run();
  changed('menu', 'station.updated', user.id);
  return c.json({ ok: true });
});

// ─── Personel ───────────────────────────────────────────────────────────────

adminRoutes.get('/users', (c) => {
  requirePermission(c.get('user'), 'personel.yonet');
  return c.json(
    db
      .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, color: schema.users.color, active: schema.users.active, permGrant: schema.users.permGrant, permRevoke: schema.users.permRevoke, maxDiscountPct: schema.users.maxDiscountPct, lastLoginAt: schema.users.lastLoginAt })
      .from(schema.users)
      .orderBy(asc(schema.users.name))
      .all(),
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

function pinFree(pin: string, exceptUserId?: string) {
  if (!isValidPin(pin)) throw bad('PIN 4-6 haneli rakam olmalı', 'pin_invalid');
  const other = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.pinHash, hashPin(pin))).get();
  if (other && other.id !== exceptUserId) throw conflict('Bu PIN başka bir personelde; farklı bir PIN seçin', 'pin_taken');
}

adminRoutes.post('/users', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'personel.yonet');
  const input = await body(c, userShape.extend({ pin: z.string() }));
  if (input.role === 'patron' && user.role !== 'patron') throw conflict('Patron hesabını yalnız patron açabilir');
  assertCanGrant(user, [...userPermissions({ role: input.role, permGrant: input.permGrant as Permission[], permRevoke: input.permRevoke as Permission[] })]);
  assertDiscountCap(user, input.maxDiscountPct);
  pinFree(input.pin);
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
    pinFree(input.pin, target.id);
    patch.pinHash = hashPin(input.pin);
  }
  tx((t) => {
    t.update(schema.users).set(patch).where(eq(schema.users.id, target.id)).run();
    // Yetki ya da PIN değişince açık oturumlar kapanır
    if (input.pin || input.role || input.permGrant || input.permRevoke || input.active === false) t.delete(schema.sessions).where(eq(schema.sessions.userId, target.id)).run();
  });
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
  db.update(schema.paymentMethods).set(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))).where(eq(schema.paymentMethods.id, c.req.param('id'))).run();
  changed('settings', 'method.updated', user.id);
  return c.json({ ok: true });
});

// ─── Ayarlar ────────────────────────────────────────────────────────────────

adminRoutes.get('/settings', (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(getSettings());
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
    voidReasons: z.array(z.string().max(40)).max(12),
    compReasons: z.array(z.string().max(40)).max(12),
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
    autoDayEnd: z.boolean(),
    autoDayEndHour: z.number().int().min(0).max(23),
  }),
);

adminRoutes.put('/settings', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'ayar.yonet');
  const input = await body(c, settingsShape);
  if (input.menuAutoSync !== undefined || input.onlineOrdersSync !== undefined) requirePermission(user, 'senkron.yonet');
  updateSettings(input);
  changed('settings', 'settings.updated', user.id, { action: 'settings.update', message: `${user.name} ayarları değiştirdi: ${Object.keys(input).join(', ')}` });
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
  return c.json(rows);
});

/** Tablet ve telefonların bağlanacağı adresler (Yönetim › Ağ ve uzaktan erişim); patron uzaktan da açar */
adminRoutes.get('/network', (c) => {
  const user = c.get('user');
  if (!can(user, 'ayar.yonet')) requirePermission(user, 'patron.panel');
  const { lastSize: _size, ...cloud } = cloudState();
  return c.json({ ...networkInfo(), cloud });
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

