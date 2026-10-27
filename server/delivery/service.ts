import { and, desc, eq, gte, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { tl } from '@shared/money';
import type { Permission } from '@shared/permissions';
import {
  ACCEPT_SECONDS,
  PLATFORM_DEFAULTS,
  PLATFORM_LABEL,
  PLATFORMS,
  type PlatformCourier,
  type PlatformId,
  type PlatformOrderDTO,
  type PlatformOrderPayload,
  type PlatformSettings,
} from '@shared/platforms';
import { type DB, schema, type Tx } from '../db/client';
import type { Actor, AuthUser } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings, updateSettings } from '../lib/settings';
import * as orders from '../services/orders';
import { sampleOrder } from './simulator';

/**
 * Paket platformları (shared/platforms.ts, docs/PAKET-PLATFORMLARI.md). Gelen sipariş `platform_orders`'ta onay
 * bekler; kabulde POS adisyonu açılır (paket ya da gel-al, platformun fiyatıyla). Tahsilatı platform yapıyorsa
 * (online ödenmiş ya da platform kuryesi) kurye aldığında / teslimde platformun online ödeme türüyle kapanır; kendi
 * kuryemiz kapıda alıyorsa ödeme kasada alınır.
 */
type PlatformRow = typeof schema.platformOrders.$inferSelect;

export function platformSettings(): Record<PlatformId, PlatformSettings> {
  const saved = (getSettings().platforms ?? {}) as Partial<Record<PlatformId, Partial<PlatformSettings>>>;
  return Object.fromEntries(PLATFORMS.map((p) => [p, { ...PLATFORM_DEFAULTS[p], ...(saved[p] ?? {}) }])) as Record<PlatformId, PlatformSettings>;
}

export function savePlatformSettings(t: Tx, actor: Actor, fx: Effects, platform: PlatformId, patch: Partial<PlatformSettings>) {
  const all = platformSettings();
  const next = { ...all[platform], ...patch };
  updateSettings({ platforms: { ...all, [platform]: next } }, t);
  fx.audit(t, {
    userId: actor.user.id,
    action: 'platform.settings',
    message: `${actor.user.name} ${PLATFORM_LABEL[platform]} ayarını değiştirdi (${next.mode === 'deneme' ? 'deneme' : 'kapalı'}, ${next.prepMinutes} dk, %${next.commissionPct} komisyon)`,
  });
  fx.emit({ topic: 'settings', kind: 'platform.settings', byUserId: actor.user.id });
  return next;
}

/**
 * Platform siparişinde kabul eden kişi adına çalışılır ama fiyat, indirim ve tahsilat platformundur: kişinin fiyat,
 * indirim ya da ödeme yetkisi aranmaz (karar kabuldür; kabul `paket.yonet` ister).
 */
function platformActor(user: AuthUser): Actor {
  const extra: Permission[] = ['siparis.al', 'paket.yonet', 'siparis.indirim', 'siparis.iptal', 'odeme.al', 'odeme.iade'];
  return { user: { ...user, permissions: new Set([...user.permissions, ...extra]), maxDiscountPct: 100 }, approver: null };
}

const norm = (s: string) => s.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();

/** Platform kalemi → LafPOS ürünü: önce aynı ad (Türkçe büyük-küçük harf duyarsız); boy seçeneklerde yazar */
function matchLines(t: Tx | DB, payload: PlatformOrderPayload) {
  const products = t.select().from(schema.products).where(eq(schema.products.active, true)).all();
  const byName = new Map(products.map((p) => [norm(p.name), p]));
  const sizeL = norm(getSettings().sizeLabels.L);
  return payload.lines.map((l) => {
    const p = byName.get(norm(l.name)) ?? null;
    const large = l.modifiers.some((m) => norm(m) === sizeL || norm(m) === 'büyük');
    return { line: l, product: p, size: p?.priceL != null ? (large ? ('L' as const) : ('M' as const)) : ('TEK' as const) };
  });
}

/** Eşleşmeyen platform kalemi için gizli ürün: satır platformun adı ve fiyatıyla açılır (adı notta) */
function unmatchedProductId(t: Tx): string {
  const existing = t.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.posName, 'PLATFORM ÜRÜNÜ')).get();
  if (existing) return existing.id;
  const cat = t.select({ id: schema.categories.id }).from(schema.categories).orderBy(desc(schema.categories.sort)).get();
  if (!cat) throw conflict('Menüde kategori yok');
  const id = ulid();
  t.insert(schema.products).values({ id, categoryId: cat.id, name: 'Platform ürünü', description: 'Paket platformundan gelen, kasada karşılığı olmayan kalem', price: 0, kdvRate: 10, hidden: true, posName: 'PLATFORM ÜRÜNÜ', sort: 999 }).run();
  return id;
}

/** Platformun online ödeme türü (kanal = platform, Z'de online): yoksa açılır */
function platformMethodId(t: Tx, platform: PlatformId): string {
  const existing = t.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(and(eq(schema.paymentMethods.kind, 'online'), eq(schema.paymentMethods.channel, platform))).get();
  if (existing) return existing.id;
  const id = ulid();
  const sort = t.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).all().length;
  t.insert(schema.paymentMethods).values({ id, name: PLATFORM_LABEL[platform], kind: 'online', zField: 'online', channel: platform, color: '#7a6a5f', sort }).run();
  return id;
}

function loadRow(t: Tx | DB, id: string): PlatformRow {
  const row = t.select().from(schema.platformOrders).where(eq(schema.platformOrders.id, id)).get();
  if (!row) throw notFound('Platform siparişi');
  return row;
}

function toDTO(t: Tx | DB, row: PlatformRow, now: number): PlatformOrderDTO {
  const order = row.orderId ? t.select({ no: schema.orders.no }).from(schema.orders).where(eq(schema.orders.id, row.orderId)).get() : null;
  const by = row.decidedBy ? t.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.decidedBy)).get() : null;
  const expired = row.status === 'bekliyor' && row.expiresAt != null && row.expiresAt <= now;
  return {
    id: row.id,
    platform: row.platform,
    status: expired ? 'suresi_doldu' : row.status,
    receivedAt: row.receivedAt,
    expiresAt: row.expiresAt,
    orderId: row.orderId,
    orderNo: order?.no ?? null,
    decidedBy: by?.name ?? null,
    reason: row.reason,
    unmatched: row.status === 'bekliyor' ? matchLines(t, row.payload).filter((m) => !m.product).map((m) => m.line.name) : [],
    payload: row.payload,
  };
}

/** Onay bekleyenler ve son 12 saatte karar verilenler */
export function listPlatformOrders(t: Tx | DB, now = Date.now()): PlatformOrderDTO[] {
  const rows = t
    .select()
    .from(schema.platformOrders)
    .where(or(eq(schema.platformOrders.status, 'bekliyor'), gte(schema.platformOrders.receivedAt, now - 12 * 3600_000)))
    .orderBy(desc(schema.platformOrders.receivedAt))
    .limit(100)
    .all();
  return rows.map((r) => toDTO(t, r, now));
}

/** Platformdan gelen siparişi alır; aynı kimlik ikinci kez gelirse (platform yeniden denedi) var olanı döner */
export function ingestPlatformOrder(t: Tx, fx: Effects, payload: PlatformOrderPayload, now = Date.now()): { row: PlatformRow; created: boolean } {
  const existing = t
    .select()
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.platform, payload.platform), eq(schema.platformOrders.externalId, payload.externalId)))
    .get();
  if (existing) return { row: existing, created: false };
  if (platformSettings()[payload.platform].mode === 'kapali') throw conflict(`${PLATFORM_LABEL[payload.platform]} kapalı`, 'platform_off');
  const secs = ACCEPT_SECONDS[payload.platform];
  const row: PlatformRow = {
    id: ulid(now),
    platform: payload.platform,
    externalId: payload.externalId,
    status: 'bekliyor',
    payload,
    receivedAt: now,
    expiresAt: secs ? now + secs * 1000 : null,
    orderId: null,
    decidedAt: null,
    decidedBy: null,
    reason: null,
    lastError: null,
  };
  t.insert(schema.platformOrders).values(row).run();
  fx.emit({ topic: 'delivery', kind: 'platform.new', message: `${PLATFORM_LABEL[payload.platform]} siparişi ${payload.code}: ${tl(payload.customerTotal)}` });
  return { row, created: true };
}

export function sendTestOrder(t: Tx, fx: Effects, platform: PlatformId, opts: { courier?: PlatformCourier } = {}, now = Date.now()) {
  if (platformSettings()[platform].mode !== 'deneme') throw conflict(`${PLATFORM_LABEL[platform]} deneme modunda değil`, 'not_test_mode');
  return ingestPlatformOrder(t, fx, sampleOrder(t, platform, now, Math.random, opts), now).row;
}

/** Kabul süresi geçmiş bekleyenler platformda iptal olmuştur: kayıt da öyle işaretlenir (zamanlayıcı) */
export function expirePlatformOrders(t: Tx, fx: Effects, now = Date.now()): number {
  const stale = t
    .select({ id: schema.platformOrders.id })
    .from(schema.platformOrders)
    .where(and(eq(schema.platformOrders.status, 'bekliyor'), isNotNull(schema.platformOrders.expiresAt), lt(schema.platformOrders.expiresAt, now)))
    .all();
  if (!stale.length) return 0;
  t.update(schema.platformOrders).set({ status: 'suresi_doldu', decidedAt: now }).where(inArray(schema.platformOrders.id, stale.map((s) => s.id))).run();
  fx.emit({ topic: 'delivery', kind: 'platform.expired' });
  return stale.length;
}

export function acceptPlatformOrder(t: Tx, user: AuthUser, fx: Effects, id: string, prepMinutes?: number) {
  if (!user.permissions.has('paket.yonet')) throw new HttpError(403, 'Platform siparişini paket yetkisi olan kabul eder', 'forbidden');
  const row = loadRow(t, id);
  const now = Date.now();
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (row.expiresAt != null && row.expiresAt <= now) throw conflict('Kabul süresi doldu; sipariş platformda iptal oldu', 'expired');
  const p = row.payload;
  const label = PLATFORM_LABEL[p.platform];
  const prep = prepMinutes ?? platformSettings()[p.platform].prepMinutes;
  const actor = platformActor(user);
  const order = orders.createOrder(t, actor, fx, {
    type: p.courier === 'gelal' ? 'gelal' : 'paket',
    deliveryName: p.customer.name,
    deliveryPhone: p.customer.phone,
    deliveryAddress: p.customer.address,
    note: [`${label} ${p.code}`, p.paymentLabel, p.note].filter(Boolean).join(' · '),
  });
  t.update(schema.orders).set({ platform: p.platform, platformCode: p.code }).where(eq(schema.orders.id, order.id)).run();
  const matched = matchLines(t, p);
  const unknown = matched.some((m) => !m.product) ? unmatchedProductId(t) : null;
  orders.addItems(
    t,
    actor,
    fx,
    order.id,
    matched.map((m) => ({
      productId: m.product?.id ?? unknown!,
      size: m.product ? m.size : 'TEK',
      qty: m.line.qty,
      priceOverride: m.line.unitPrice,
      note: [m.product ? null : m.line.name, ...m.line.modifiers, m.line.note].filter(Boolean).join(' · ') || null,
    })),
    { platformPrice: true },
  );
  if (p.restaurantDiscount > 0) orders.setOrderDiscount(t, actor, fx, order.id, { type: 'amount', value: p.restaurantDiscount, reason: `${label} kampanyası` });
  t.update(schema.platformOrders).set({ status: 'kabul', orderId: order.id, decidedAt: now, decidedBy: user.id, reason: `${prep} dk` }).where(eq(schema.platformOrders.id, id)).run();
  const accepted = orders.recalc(t, order.id);
  fx.audit(t, {
    userId: user.id,
    action: 'platform.accept',
    orderId: order.id,
    amount: accepted.total,
    message: `${user.name} ${label} siparişini kabul etti (${p.code}, ${tl(accepted.total)}, ${prep} dk)${unknown ? '; eşleşmeyen kalem var' : ''}`,
  });
  fx.emit({ topic: 'delivery', kind: 'platform.accepted', orderId: order.id, byUserId: user.id });
  return { order: accepted, prepMinutes: prep };
}

export function rejectPlatformOrder(t: Tx, user: AuthUser, fx: Effects, id: string, reason: string) {
  if (!user.permissions.has('paket.yonet')) throw new HttpError(403, 'Platform siparişini paket yetkisi olan reddeder', 'forbidden');
  const row = loadRow(t, id);
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (!reason.trim()) throw bad('Ret nedeni seçilmeli', 'reason_required');
  t.update(schema.platformOrders).set({ status: 'ret', decidedAt: Date.now(), decidedBy: user.id, reason: reason.trim() }).where(eq(schema.platformOrders.id, id)).run();
  fx.audit(t, {
    userId: user.id,
    action: 'platform.reject',
    severity: 'uyari',
    amount: row.payload.customerTotal,
    message: `${user.name} ${PLATFORM_LABEL[row.platform]} siparişini reddetti (${row.payload.code}, ${tl(row.payload.customerTotal)}, ${reason.trim()})`,
  });
  fx.emit({ topic: 'delivery', kind: 'platform.rejected', byUserId: user.id });
}

/**
 * Teslim aşaması değişti: tahsilatı platform yapıyorsa platform kuryesine verilince (yolda) ya da teslimde (kendi
 * kurye, gel-al) kalan tutar platformun online ödeme türüyle yazılır, adisyon kapanır.
 */
export function afterDelivery(t: Tx, user: AuthUser, fx: Effects, orderId: string) {
  const o = t.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!o?.platform || o.status !== 'acik') return;
  const row = t.select().from(schema.platformOrders).where(eq(schema.platformOrders.orderId, orderId)).get();
  if (!row?.payload.platformCollects) return;
  const handedOver = o.deliveryStatus === 'teslim' || (o.deliveryStatus === 'yolda' && row.payload.courier === 'platform');
  if (!handedOver) return;
  const fresh = orders.recalc(t, orderId);
  const due = fresh.total - fresh.paid;
  if (due <= 0) return;
  orders.addPayment(t, platformActor(user), fx, orderId, { methodId: platformMethodId(t, o.platform), amount: due, note: `${PLATFORM_LABEL[o.platform]} ${o.platformCode ?? ''}`.trim() });
}

/**
 * Platform siparişi iptal etti (denemede elle; gerçek bağlantıda platformdan gelir). Kabul edilmemişse kayıt kapanır;
 * kabul edilmiş açık adisyonun platform ödemesi geri alınır ve adisyon iptal olur.
 */
export function platformCancelled(t: Tx, user: AuthUser, fx: Effects, id: string, reason: string) {
  const row = loadRow(t, id);
  const label = PLATFORM_LABEL[row.platform];
  if (row.status === 'iptal' || row.status === 'ret' || row.status === 'suresi_doldu') throw conflict('Sipariş zaten kapandı', 'not_open');
  const why = `${label} iptal etti${reason.trim() ? `: ${reason.trim()}` : ''}`;
  if (row.orderId) {
    const o = t.select().from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
    if (o?.status === 'acik') {
      const actor = platformActor(user);
      for (const pay of t.select().from(schema.payments).where(eq(schema.payments.orderId, o.id)).all()) {
        if (!pay.refundedAt) orders.refundPayment(t, actor, fx, o.id, { paymentId: pay.id, reason: why });
      }
      orders.cancelOrder(t, actor, fx, o.id, why);
    }
  }
  t.update(schema.platformOrders).set({ status: 'iptal', decidedAt: Date.now(), reason: why }).where(eq(schema.platformOrders.id, id)).run();
  fx.audit(t, { userId: user.id, action: 'platform.cancel', severity: 'uyari', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why} (${row.payload.code}, ${tl(row.payload.customerTotal)})` });
  fx.emit({ topic: 'delivery', kind: 'platform.cancelled', orderId: row.orderId ?? undefined, byUserId: user.id });
}
