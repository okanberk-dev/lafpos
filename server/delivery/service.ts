import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { tl } from '@shared/money';
import type { Permission } from '@shared/permissions';
import {
  ACCEPT_SECONDS,
  PLATFORM_DEFAULTS,
  PLATFORM_LABEL,
  PLATFORM_MODE_LABEL,
  PLATFORMS,
  type PlatformCourier,
  type PlatformId,
  type PlatformOrderDTO,
  type PlatformOrderPayload,
  type PlatformProductDTO,
  type PlatformSettings,
} from '@shared/platforms';
import { deciding } from './locks';
import { adapterFor } from './registry';
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

/**
 * Deneme siparişi gerçek satış gibi ciroya, Z'ye ve lafmaliyet'e girer: deneme modu yalnız kurulum modunda
 * (Ayarlar › kurulum modu; canlıya geçince kapanır) açılır ve sipariş üretir
 */
function assertSetupMode() {
  if (!getSettings().demoMode) throw conflict('Deneme siparişleri ciroya girer: deneme modu yalnız kurulum modunda açılır', 'not_setup_mode');
}

export function savePlatformSettings(t: Tx, actor: Actor, fx: Effects, platform: PlatformId, patch: Partial<PlatformSettings>) {
  if (patch.mode === 'deneme') assertSetupMode();
  if (patch.mode === 'canli') {
    // Canlı mod yalnız bağdaştırıcısı olan ve anahtarı .env'de tanımlı platformda (server/delivery/registry.ts)
    const a = adapterFor(platform);
    if (!a) throw conflict(`${PLATFORM_LABEL[platform]} için canlı bağlantı henüz yok`, 'not_supported');
    if (!a.configured()) throw conflict(`${PLATFORM_LABEL[platform]} anahtarları .env'de tanımlı değil (docs/PAKET-PLATFORMLARI.md)`, 'not_configured');
  }
  const all = platformSettings();
  const next = { ...all[platform], ...patch };
  updateSettings({ platforms: { ...all, [platform]: next } }, t);
  fx.audit(t, {
    userId: actor.user.id,
    action: 'platform.settings',
    severity: next.mode === 'canli' && all[platform].mode !== 'canli' ? 'uyari' : 'info',
    message: `${actor.user.name} ${PLATFORM_LABEL[platform]} ayarını değiştirdi (${PLATFORM_MODE_LABEL[next.mode].toLocaleLowerCase('tr-TR')}, ${next.prepMinutes} dk, %${next.commissionPct} komisyon)`,
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

/**
 * Platform kalemi → LafPOS ürünü: önce Ürün eşleme tablosu (platform ürün kimliği → ürün; Yönetim › Paket platformları),
 * sonra aynı ad (Türkçe büyük-küçük harf duyarsız); boy seçeneklerde yazar
 */
function matchLines(t: Tx | DB, payload: PlatformOrderPayload) {
  // Tükenmiş ürün de eşleşir: kabulde "tükendi" diye durur, gizli satıra dönüp stok denetimini atlamaz. Ada göre
  // yalnız menüdeki ürün; Ürün eşleme ile bağlanan ürün menüden gizlenmiş olsa da o ürün (patronun açık kararı)
  const all = t.select().from(schema.products).all();
  const byName = new Map(all.filter((p) => !p.hidden).map((p) => [norm(p.name), p]));
  const byId = new Map(all.map((p) => [p.id, p]));
  const mapped = new Map(
    t
      .select({ externalId: schema.platformProducts.externalId, productId: schema.platformProducts.productId })
      .from(schema.platformProducts)
      .where(and(eq(schema.platformProducts.platform, payload.platform), isNotNull(schema.platformProducts.productId)))
      .all()
      .map((m) => [m.externalId, m.productId!]),
  );
  const sizeL = norm(getSettings().sizeLabels.L);
  return payload.lines.map((l) => {
    const viaMap = l.externalId ? byId.get(mapped.get(l.externalId) ?? '') : undefined;
    // Platformun ücreti ada göre ürüne düşmez: eşlenmişse o ürün, değilse kabulde "Platform ücreti" hizmet satırı
    if (l.kind === 'fee') return { line: l, product: viaMap ?? null, size: 'TEK' as const };
    const p = viaMap ?? byName.get(norm(l.name)) ?? null;
    const large = l.modifiers.some((m) => norm(m) === sizeL || norm(m) === 'büyük');
    return { line: l, product: p, size: p?.priceL != null ? (large ? ('L' as const) : ('M' as const)) : ('TEK' as const) };
  });
}

/** Platformdan gelen kalemler Ürün eşleme tablosuna düşer (kimliği olanlar); ad ve son görülme güncellenir */
function rememberPlatformProducts(t: Tx, payload: PlatformOrderPayload, now: number) {
  for (const l of payload.lines) {
    if (!l.externalId) continue;
    const existing = t
      .select({ id: schema.platformProducts.id })
      .from(schema.platformProducts)
      .where(and(eq(schema.platformProducts.platform, payload.platform), eq(schema.platformProducts.externalId, l.externalId)))
      .get();
    if (existing) t.update(schema.platformProducts).set({ name: l.name, lastSeenAt: now }).where(eq(schema.platformProducts.id, existing.id)).run();
    else t.insert(schema.platformProducts).values({ id: ulid(now), platform: payload.platform, externalId: l.externalId, name: l.name, productId: null, lastSeenAt: now, createdAt: now }).run();
  }
}

/** Yönetim › Paket platformları › Ürün eşleme: eşleşmeyenler önce, sonra son görülene göre */
export function listPlatformProducts(t: Tx | DB): PlatformProductDTO[] {
  const names = new Map(t.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).all().map((p) => [p.id, p.name]));
  return t
    .select()
    .from(schema.platformProducts)
    .orderBy(desc(schema.platformProducts.lastSeenAt))
    .all()
    .map((r) => ({ id: r.id, platform: r.platform, externalId: r.externalId, name: r.name, productId: r.productId, productName: r.productId ? (names.get(r.productId) ?? null) : null, lastSeenAt: r.lastSeenAt }))
    .sort((a, b) => Number(!!a.productId) - Number(!!b.productId) || b.lastSeenAt - a.lastSeenAt);
}

export function mapPlatformProduct(t: Tx, actor: Actor, fx: Effects, id: string, productId: string | null) {
  const row = t.select().from(schema.platformProducts).where(eq(schema.platformProducts.id, id)).get();
  if (!row) throw notFound('Platform ürünü');
  const product = productId ? t.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).get() : null;
  if (productId && !product) throw notFound('Ürün');
  t.update(schema.platformProducts).set({ productId: product?.id ?? null }).where(eq(schema.platformProducts.id, id)).run();
  fx.audit(t, {
    userId: actor.user.id,
    action: 'platform.product_map',
    message: product ? `${actor.user.name} ${PLATFORM_LABEL[row.platform]} "${row.name}" kalemini ${product.name} ürününe eşledi` : `${actor.user.name} ${PLATFORM_LABEL[row.platform]} "${row.name}" eşlemesini kaldırdı (ada göre eşlenir)`,
  });
  fx.emit({ topic: 'settings', kind: 'platform.products', byUserId: actor.user.id });
}

/** Eşleşmeyen platform kalemi için gizli ürün: satır platformun adı ve fiyatıyla açılır (adı notta) */
function unmatchedProductId(t: Tx): string {
  const existing = t.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.posName, 'PLATFORM ÜRÜNÜ')).get();
  if (existing) return existing.id;
  const cat = t.select({ id: schema.categories.id }).from(schema.categories).orderBy(asc(schema.categories.sort)).get();
  if (!cat) throw conflict('Menüde kategori yok');
  // Bilinmeyen kalem bara düşer: bar hazırlar ya da adisyondan iptal eder
  const bar = t.select({ id: schema.stations.id }).from(schema.stations).where(eq(schema.stations.kind, 'bar')).orderBy(asc(schema.stations.sort)).get();
  const id = ulid();
  t.insert(schema.products).values({ id, categoryId: cat.id, stationId: bar?.id ?? null, name: 'Platform ürünü', description: 'Paket platformundan gelen, kasada karşılığı olmayan kalem', price: 0, kdvRate: 10, hidden: true, posName: 'PLATFORM ÜRÜNÜ', sort: 999 }).run();
  return id;
}

/**
 * Platformun ücreti (teslimat, ambalaj) için gizli ürün: KDV %20 (taşıma hizmeti), istasyonsuz (mutfağa gitmez); adı
 * notta. "Hizmet" işaretlenmez: oda sayacı gizli hizmet ürününü oda ücreti sanmasın. Patron Ürün eşleme'den başka bir
 * ürüne bağlayabilir
 */
function feeProductId(t: Tx): string {
  const existing = t.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.posName, 'PLATFORM ÜCRETİ')).get();
  if (existing) return existing.id;
  const cat = t.select({ id: schema.categories.id }).from(schema.categories).orderBy(asc(schema.categories.sort)).get();
  if (!cat) throw conflict('Menüde kategori yok');
  const id = ulid();
  t.insert(schema.products).values({ id, categoryId: cat.id, stationId: null, name: 'Platform ücreti', description: 'Paket platformunun teslimat ya da ambalaj ücreti', price: 0, kdvRate: 20, hidden: true, posName: 'PLATFORM ÜCRETİ', sort: 999 }).run();
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
export { loadRow as getPlatformOrder };

function toDTO(t: Tx | DB, row: PlatformRow, now: number): PlatformOrderDTO {
  const order = row.orderId ? t.select({ no: schema.orders.no }).from(schema.orders).where(eq(schema.orders.id, row.orderId)).get() : null;
  const by = row.decidedBy ? t.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.decidedBy)).get() : null;
  // Platform kabul etmiş ama adisyon açılamamışsa süre dolmaz: sipariş platformda yaşıyor
  const announced = row.status === 'bekliyor' && row.notifiedStatus === 'picked';
  const expired = row.status === 'bekliyor' && !announced && row.expiresAt != null && row.expiresAt <= now;
  const pending = row.status === 'bekliyor' && !expired;
  const matched = pending ? matchLines(t, row.payload) : [];
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
    unmatched: pending ? matched.filter((m) => !m.product && m.line.kind !== 'fee').map((m) => m.line.name) : [],
    soldOut: pending ? matched.filter((m) => m.product && !m.product.active).map((m) => m.line.name) : [],
    payload: row.payload,
    lastError: row.lastError,
    announced,
    cancelPending: row.status === 'kabul' && row.cancelPendingAt != null,
  };
}

/** Onay bekleyenler ve son 12 saatte karar verilenler */
export function listPlatformOrders(t: Tx | DB, now = Date.now()): PlatformOrderDTO[] {
  const rows = t
    .select()
    .from(schema.platformOrders)
    .where(or(eq(schema.platformOrders.status, 'bekliyor'), isNotNull(schema.platformOrders.cancelPendingAt), gte(schema.platformOrders.receivedAt, now - 12 * 3600_000)))
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
  // Platform kabul süresini verdiyse (Yemeksepeti expiryDate) o (geçmişse sipariş gelir gelmez süresi dolmuştur; geç
  // çekilen sipariş taze süre almaz), yoksa platformun bilinen süresi. Platformda zaten kabul edilmişse süre yok
  const expiresAt = payload.preAccepted ? null : typeof payload.expiresAt === 'number' ? payload.expiresAt : secs ? now + secs * 1000 : null;
  const row: PlatformRow = {
    id: ulid(now),
    platform: payload.platform,
    externalId: payload.externalId,
    status: 'bekliyor',
    payload,
    receivedAt: now,
    expiresAt,
    orderId: null,
    decidedAt: null,
    decidedBy: null,
    reason: null,
    lastError: null,
    notifiedStatus: null,
    cancelPendingAt: null,
    notifyParkedAt: null,
  };
  t.insert(schema.platformOrders).values(row).run();
  rememberPlatformProducts(t, payload, now);
  fx.emit({ topic: 'delivery', kind: 'platform.new', message: `${PLATFORM_LABEL[payload.platform]} siparişi ${payload.code}: ${tl(payload.customerTotal)}` });
  return { row, created: true };
}

export function sendTestOrder(t: Tx, fx: Effects, platform: PlatformId, opts: { courier?: PlatformCourier } = {}, now = Date.now()) {
  if (platformSettings()[platform].mode !== 'deneme') throw conflict(`${PLATFORM_LABEL[platform]} deneme modunda değil`, 'not_test_mode');
  assertSetupMode();
  return ingestPlatformOrder(t, fx, sampleOrder(t, platform, now, Math.random, opts), now).row;
}

/** Kabul süresi geçmiş bekleyenler platformda iptal olmuştur: kayıt da öyle işaretlenir (zamanlayıcı) */
export function expirePlatformOrders(t: Tx, fx: Effects, now = Date.now()): number {
  const stale = t
    .select({ id: schema.platformOrders.id })
    .from(schema.platformOrders)
    // Platforma kabulü gitmiş kayıt (adisyonu açılamamış) süre dolunca iptal sayılmaz: platformda yaşıyor
    .where(and(eq(schema.platformOrders.status, 'bekliyor'), isNull(schema.platformOrders.notifiedStatus), isNotNull(schema.platformOrders.expiresAt), lt(schema.platformOrders.expiresAt, now)))
    .all();
  // Kabul ya da ret o an platforma gidiyor: karar bitince ya kabul edilir ya da sonraki turda dolar
  const ids = stale.map((s) => s.id).filter((id) => !deciding.has(id));
  if (!ids.length) return 0;
  t.update(schema.platformOrders).set({ status: 'suresi_doldu', decidedAt: now }).where(inArray(schema.platformOrders.id, ids)).run();
  fx.emit({ topic: 'delivery', kind: 'platform.expired' });
  return ids.length;
}

export function acceptPlatformOrder(t: Tx, user: AuthUser, fx: Effects, id: string, prepMinutes?: number, opts: { notifiedStatus?: string | null } = {}) {
  if (!user.permissions.has('paket.yonet')) throw new HttpError(403, 'Platform siparişini paket yetkisi olan kabul eder', 'forbidden');
  const row = loadRow(t, id);
  const now = Date.now();
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (row.notifiedStatus !== 'picked' && row.expiresAt != null && row.expiresAt <= now) throw conflict('Kabul süresi doldu; sipariş platformda iptal oldu', 'expired');
  const p = row.payload;
  const label = PLATFORM_LABEL[p.platform];
  if (p.test) throw conflict(`${label} test siparişi: mutfağa düşmesin diye kabul edilmez, yalnız reddedilir`, 'test_order');
  const prep = prepMinutes ?? platformSettings()[p.platform].prepMinutes;
  const actor = platformActor(user);
  const order = orders.createOrder(t, actor, fx, {
    type: p.courier === 'gelal' ? 'gelal' : 'paket',
    deliveryName: p.customer.name,
    deliveryPhone: p.customer.phone,
    deliveryAddress: p.customer.address,
    note: [`${label} ${p.code}`, p.paymentLabel, p.note].filter(Boolean).join(' · '),
    // İleri tarihli sipariş: saat mutfak fişinde ve sipariş şeridinde görünür
    scheduledFor: p.scheduledFor ? new Date(p.scheduledFor).toISOString() : null,
  });
  t.update(schema.orders).set({ platform: p.platform, platformCode: p.code }).where(eq(schema.orders.id, order.id)).run();
  const matched = matchLines(t, p);
  const unknown = matched.some((m) => !m.product && m.line.kind !== 'fee') ? unmatchedProductId(t) : null;
  const fee = matched.some((m) => !m.product && m.line.kind === 'fee') ? feeProductId(t) : null;
  orders.addItems(
    t,
    actor,
    fx,
    order.id,
    matched.map((m) => ({
      productId: m.product?.id ?? (m.line.kind === 'fee' ? fee! : unknown!),
      size: m.product ? m.size : 'TEK',
      qty: m.line.qty,
      priceOverride: m.line.unitPrice,
      note: [m.product ? null : m.line.name, ...m.line.modifiers, m.line.note].filter(Boolean).join(' · ') || null,
    })),
    { platformPrice: true },
  );
  if (p.restaurantDiscount > 0) orders.setOrderDiscount(t, actor, fx, order.id, { type: 'amount', value: p.restaurantDiscount, reason: `${label} kampanyası` });
  t.update(schema.platformOrders).set({ status: 'kabul', orderId: order.id, decidedAt: now, decidedBy: user.id, reason: `${prep} dk`, notifiedStatus: opts.notifiedStatus ?? null, lastError: null }).where(eq(schema.platformOrders.id, id)).run();
  let accepted = orders.recalc(t, order.id);
  // Kapıda tahsilat kasada ama kampanyanın bir kısmını platform karşılıyor: o pay platformun ödemesidir, şimdi
  // platformun online ödeme türüyle yazılır; kasada müşterinin ödediği kalır (fazlası istenmesin)
  if (!p.platformCollects && p.platformDiscount > 0) {
    if (accepted.total - p.platformDiscount === p.customerTotal) {
      orders.addPayment(t, actor, fx, order.id, { methodId: platformMethodId(t, p.platform), amount: p.platformDiscount, note: `${label} ${p.code} kampanya payı` });
      accepted = orders.recalc(t, order.id);
    } else {
      fx.audit(t, {
        userId: user.id,
        action: 'platform.mismatch',
        severity: 'alarm',
        orderId: order.id,
        amount: accepted.total - p.platformDiscount - p.customerTotal,
        message: `${label} ${p.code}: adisyon ${tl(accepted.total)}, platform kampanyası ${tl(p.platformDiscount)}, müşteri ${tl(p.customerTotal)} ödeyecek. Platformun payı kendiliğinden yazılmadı; tahsilatı elle düzeltin`,
      });
    }
  }
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

export function rejectPlatformOrder(t: Tx, user: AuthUser, fx: Effects, id: string, reason: string, opts: { notifiedStatus?: string | null } = {}) {
  if (!user.permissions.has('paket.yonet')) throw new HttpError(403, 'Platform siparişini paket yetkisi olan reddeder', 'forbidden');
  const row = loadRow(t, id);
  if (row.status !== 'bekliyor') throw conflict('Sipariş artık onay beklemiyor', 'not_pending');
  if (!reason.trim()) throw bad('Ret nedeni seçilmeli', 'reason_required');
  t.update(schema.platformOrders).set({ status: 'ret', decidedAt: Date.now(), decidedBy: user.id, reason: reason.trim(), notifiedStatus: opts.notifiedStatus ?? null, lastError: null }).where(eq(schema.platformOrders.id, id)).run();
  fx.audit(t, {
    userId: user.id,
    action: 'platform.reject',
    severity: 'uyari',
    amount: row.payload.customerTotal,
    message: `${user.name} ${PLATFORM_LABEL[row.platform]} siparişini reddetti (${row.payload.code}, ${tl(row.payload.customerTotal)}, ${reason.trim()})`,
  });
  fx.emit({ topic: 'delivery', kind: 'platform.rejected', byUserId: user.id });
}

/** Platformun restorana ödeyeceği: kalemler ve restoranın kampanyası (platformun kampanyasını platform karşılar) */
const platformAmount = (p: PlatformOrderPayload) => p.subtotal - p.restaurantDiscount;

/** Adisyondaki, platformun online ödeme türüyle alınmış (iade edilmemiş) ödemeler */
function platformPayments(t: Tx, orderId: string, platform: PlatformId) {
  return t
    .select({ id: schema.payments.id, amount: schema.payments.amount })
    .from(schema.payments)
    .innerJoin(schema.paymentMethods, eq(schema.paymentMethods.id, schema.payments.methodId))
    .where(and(eq(schema.payments.orderId, orderId), isNull(schema.payments.refundedAt), eq(schema.paymentMethods.kind, 'online'), eq(schema.paymentMethods.channel, platform)))
    .all();
}

/**
 * Teslim aşaması değişti. Tahsilatı platform yapıyorsa platform kuryesine verilince (Yolda) ya da teslimde (kendi
 * kurye, gel-al) platformun ödeyeceği tutar platformun online ödeme türüyle yazılır, adisyon kapanır. Yalnız:
 * - aşamaya ilk geçişte (iade edilmiş ödeme kurye değişince yeniden yazılmaz),
 * - paket yetkisi olan kaydeder (garson "teslim" derse adisyon açık kalır, kasa kapatır),
 * - adisyon tutarı platformun tutarına eşitse. Fark varsa (kalem iptali, indirim, bölünmüş hesap) otomatik ödeme
 *   yazılmaz, denetime alarm düşer: kalan kasada alınır.
 */
export function afterDelivery(t: Tx, user: AuthUser, fx: Effects, orderId: string, before: string | null) {
  const o = t.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!o?.platform || o.status !== 'acik' || o.deliveryStatus === before) return;
  const row = t.select().from(schema.platformOrders).where(eq(schema.platformOrders.orderId, orderId)).get();
  if (!row?.payload.platformCollects) return;
  const handedOver = o.deliveryStatus === 'teslim' || (o.deliveryStatus === 'yolda' && row.payload.courier === 'platform');
  if (!handedOver || !user.permissions.has('paket.yonet')) return;
  const label = `${PLATFORM_LABEL[o.platform]} ${o.platformCode ?? ''}`.trim();
  const fresh = orders.recalc(t, orderId);
  const expected = platformAmount(row.payload);
  const already = platformPayments(t, orderId, o.platform).reduce((a, p) => a + p.amount, 0);
  const amount = expected - already;
  const due = fresh.total - fresh.paid;
  if (fresh.total !== expected || amount <= 0 || amount !== due || orders.splitActive(t, fresh, due)) {
    fx.audit(t, {
      userId: user.id,
      action: 'platform.mismatch',
      severity: 'alarm',
      orderId,
      amount: fresh.total - expected,
      message: `${label}: adisyon ${tl(fresh.total)}, platformun ödeyeceği ${tl(expected)}. Platform ödemesi kendiliğinden yazılmadı; kalanı kasadan alın`,
    });
    return;
  }
  orders.addPayment(t, platformActor(user), fx, orderId, { methodId: platformMethodId(t, o.platform), amount, note: label });
  fx.audit(t, { userId: user.id, action: 'platform.settle', orderId, amount, message: `${label} platform ödemesiyle kapandı (${tl(amount)})` });
}

/**
 * Platform siparişi iptal etti (denemede elle; gerçek bağlantıda platformdan gelir). Kabul edilmemişse kayıt kapanır.
 * Kabul edilmişse yalnız platformun ödemesi geri alınır ve adisyon iptal olur (kapanmışsa önce açılır); kasada
 * alınmış başka ödeme varsa durur: o ödeme normal yoldan (yetkili onayıyla) geri alınır.
 */
export function platformCancelled(t: Tx, user: AuthUser, fx: Effects, id: string, reason: string, opts: { manual?: boolean } = {}) {
  const row = loadRow(t, id);
  const label = PLATFORM_LABEL[row.platform];
  if (opts.manual && (!row.payload.simulated || platformSettings()[row.platform].mode !== 'deneme')) throw conflict('Platform iptali elle yalnız deneme siparişinde yapılır', 'not_test_order');
  if (row.status === 'iptal' || row.status === 'ret' || row.status === 'suresi_doldu') throw conflict('Sipariş zaten kapandı', 'not_open');
  const why = `${label} iptal etti${reason.trim() ? `: ${reason.trim()}` : ''}`;
  if (row.orderId) {
    const o = t.select().from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
    if (o && o.status !== 'iptal') {
      const own = platformPayments(t, o.id, row.platform);
      const others = t
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(and(eq(schema.payments.orderId, o.id), isNull(schema.payments.refundedAt)))
        .all()
        .filter((p) => !own.some((x) => x.id === p.id));
      if (others.length) throw conflict('Adisyonda kasada alınmış ödeme var: önce o ödemeyi yetkili onayıyla geri alın', 'has_payments');
      const actor = platformActor(user);
      for (const pay of own) orders.refundPayment(t, actor, fx, o.id, { paymentId: pay.id, reason: why });
      orders.cancelOrder(t, actor, fx, o.id, why);
    }
  }
  t.update(schema.platformOrders).set({ status: 'iptal', decidedAt: Date.now(), reason: why, cancelPendingAt: null, lastError: null }).where(eq(schema.platformOrders.id, id)).run();
  fx.audit(t, { userId: user.id, action: 'platform.cancel', severity: 'uyari', orderId: row.orderId, amount: row.payload.customerTotal, message: `${why} (${row.payload.code}, ${tl(row.payload.customerTotal)})` });
  fx.emit({ topic: 'delivery', kind: 'platform.cancelled', orderId: row.orderId ?? undefined, byUserId: user.id });
}

/**
 * Platform iptal etti ama adisyon kasada kapatılamıyor (ödeme kapanmış güne ait ya da geri alınmayacak): yetkili kaydı
 * elle kapatır. Para yerinde kalır, denetim kaydına alarm düşer: hesabı patron düzeltir.
 */
export function closeCancelPending(t: Tx, user: AuthUser, fx: Effects, id: string) {
  const row = loadRow(t, id);
  if (row.status !== 'kabul' || row.cancelPendingAt == null) throw conflict('Bu siparişte bekleyen platform iptali yok', 'not_cancel_pending');
  const label = PLATFORM_LABEL[row.platform];
  const o = row.orderId ? t.select({ no: schema.orders.no, status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, row.orderId)).get() : null;
  t.update(schema.platformOrders)
    .set({ status: 'iptal', cancelPendingAt: null, decidedAt: Date.now(), reason: `${label} iptal etti; kasada elle kapatıldı`, lastError: null })
    .where(eq(schema.platformOrders.id, id))
    .run();
  fx.audit(t, {
    userId: user.id,
    action: 'platform.cancel_closed',
    severity: 'alarm',
    orderId: row.orderId,
    amount: row.payload.customerTotal,
    message: `${user.name} ${label} iptalini elle kayda aldı (${row.payload.code}); adisyon${o ? ` #${o.no}` : ''} kasada iptal edilmedi, alınan ödeme yerinde: hesabı elle düzeltin`,
  });
  fx.emit({ topic: 'delivery', kind: 'platform.cancelled', orderId: row.orderId ?? undefined, byUserId: user.id });
}
