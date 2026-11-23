import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { odenmezByPerson } from '@shared/comp';
import { tl } from '@shared/money';
import { calcOrder, offDeviceTotals } from '@shared/order-calc';
import { addDays, businessDate, businessDayStartMs } from '@shared/time';
import type { BusinessDayDTO, ShiftCountDTO } from '@shared/types';
import { nextZNo } from '@shared/z-no';
import { type DB, schema, type Tx } from '../db/client';
import type { FiscalStatus, ZField, ZSummary } from '../db/schema';
import { type Actor, counterpartFor, need, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings, trainingDayNow } from '../lib/settings';
import { getOpenDay, isEmptyOrder, requireCurrentDay, requireOpenDay } from './orders';

type DayRow = typeof schema.businessDays.$inferSelect;

export function dayToDTO(t: Tx | DB, d: DayRow | undefined | null): BusinessDayDTO | null {
  if (!d) return null;
  const opener = d.openedBy ? t.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, d.openedBy)).get() : null;
  return { id: d.id, date: d.date, zNo: d.zNo, openedAt: d.openedAt, openedByName: opener?.name ?? null, openingCash: d.openingCash, closedAt: d.closedAt, reopenedAt: d.reopenedAt, trainingDay: d.trainingDay };
}

/** Kayıtlı en büyük Z (açık gün ve eğitim günleri dahil); gün yoksa 0 */
export function lastZNo(t: Tx | DB): number {
  return t.select({ z: sql<number>`coalesce(max(${schema.businessDays.zNo}), 0)` }).from(schema.businessDays).get()?.z ?? 0;
}

export function openDay(t: Tx, actor: Actor, fx: Effects, input: { openingCash: number }): DayRow {
  needDirect(actor, 'kasa.gun');
  if (getOpenDay(t)) throw conflict('Açık bir gün zaten var', 'day_open');
  const now = Date.now();
  // Bir iş gününe tek Z: gece gün sonu alındıktan sonra satış gerekirse aynı gün yeniden açılır (lafmaliyet her
  // tarihe tek Z kaydeder; ikinci Z ilkinin yerine geçerdi, inceleme 26 Eki 2026)
  const closedToday = t
    .select({ zNo: schema.businessDays.zNo })
    .from(schema.businessDays)
    .where(and(eq(schema.businessDays.date, businessDate(now)), isNotNull(schema.businessDays.closedAt)))
    .get();
  if (closedToday) throw conflict(`Bugünün gün sonu alındı (Z ${closedToday.zNo}). Satış gerekiyorsa günü yeniden açın; yeni gün 05:00'ten sonra açılır`, 'day_closed_today');
  const day = {
    id: ulid(now),
    date: businessDate(now),
    // Geçişte zincir ModPOS'un son Z'sinden devam eder (Yönetim › Ayarlar › İlk Z numarası); eğitim günleri de zincirde
    zNo: nextZNo(lastZNo(t), getSettings().zNoStart),
    openedAt: now,
    openedBy: actor.user.id,
    openingCash: Math.max(0, Math.trunc(input.openingCash)),
    lastOrderNo: 0,
  };
  t.insert(schema.businessDays).values(day).run();
  claimEarlyOnlineOrders(t, day.id, day.date);
  fx.audit(t, { userId: actor.user.id, action: 'day.open', amount: day.openingCash, message: `${actor.user.name} günü açtı (Z ${day.zNo}, açılış ${tl(day.openingCash)})` });
  fx.emit({ topic: 'cash', kind: 'day.opened', byUserId: actor.user.id });
  fx.emit({ topic: 'settings', kind: 'day.opened', byUserId: actor.user.id });
  return t.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!;
}

/**
 * "Online (sitede ödendi)" toplamına giren online sipariş: sitede iptal ya da iade edildiği (`closed`), kasada
 * ödendiği (`paidAtTill`) ya da başka şubenin olduğu bilinen sipariş girmez; site ve lafmaliyet'in online kanalı onu
 * saymaz. Sonucu bilinmeyen (eski site) ve tamamlanan sayılır. docs/03-ENTEGRASYON.md §2.3 "Kapanış"
 */
export const onlineCounted = (o: { source: string; extOutcome?: string | null }) =>
  o.source === 'laffogato' && (o.extOutcome == null || o.extOutcome === 'completed');

/**
 * Gün açılmadan gelen online siparişler (sitede ödendi) geçici olarak son, kapanmış güne yazılır
 * (`upsertOnlineOrders`). İş günü (ödeme anından, 05:00 kuralı) açılan günün tarihiyse buraya taşınır: raporlar
 * online siparişi kendi tarihinde gösterir. Açık güne yazılmış sipariş (gün kapanmadan ödenmiş) taşınmaz.
 */
function claimEarlyOnlineOrders(t: Tx, dayId: string, date: string) {
  const from = businessDayStartMs(date);
  const to = businessDayStartMs(addDays(date, 1));
  const early = t
    .select({ id: schema.orders.id, openedAt: schema.orders.openedAt, closedAt: schema.businessDays.closedAt })
    .from(schema.orders)
    .innerJoin(schema.businessDays, eq(schema.businessDays.id, schema.orders.dayId))
    .where(and(eq(schema.orders.source, 'laffogato'), gte(schema.orders.openedAt, from), lt(schema.orders.openedAt, to)))
    .all()
    .filter((o) => o.closedAt != null && o.closedAt <= o.openedAt);
  if (early.length) t.update(schema.orders).set({ dayId }).where(inArray(schema.orders.id, early.map((o) => o.id))).run();
}

export function addCashMovement(t: Tx, actor: Actor, fx: Effects, input: { kind: 'harcama' | 'teslim' | 'giris'; amount: number; description: string }) {
  const approverId = need(actor, 'kasa.hareket');
  const day = requireOpenDay(t);
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw bad('Tutar sıfırdan büyük olmalı');
  const description = input.description.trim();
  if (input.kind === 'harcama' && !description) throw bad('Harcamanın açıklaması yazılmalı', 'reason_required');
  const row = { id: ulid(), dayId: day.id, kind: input.kind, amount, description, userId: actor.user.id, createdAt: Date.now() };
  t.insert(schema.cashMovements).values(row).run();
  const label = { harcama: 'kasadan harcama', teslim: 'kasadan teslim', giris: 'kasaya para girişi' }[input.kind];
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: `cash.${input.kind}`,
    severity: input.kind === 'giris' ? 'info' : amount >= 100000 ? 'uyari' : 'info',
    entity: 'cash_movement',
    entityId: row.id,
    amount,
    message: `${actor.user.name}: ${label} ${tl(amount)}${description ? ` (${description})` : ''}`,
  });
  fx.emit({ topic: 'cash', kind: 'movement', byUserId: actor.user.id });
  return row;
}

/** Cari (açık hesap) tahsilatı: satış değildir, Z cirosuna girmez ama nakitse kasaya girer. */
/**
 * Açık hesap tahsilatı: ödeme satırı (adisyonsuz), cari ekstresine tahsilat ve bakiye. Yanıtı kaybolan istek aynı
 * deneme kimliğiyle yeniden gelirse ikinci kez yazılmaz (ödemedeki gibi); yoksa borç iki kez düşüyor, beklenen nakit
 * iki kez artıyordu. Bakiyeden fazlası tahsil edilmez: fazlası müşteriye alacak olarak yazılır, sonraki açık hesap
 * satışında harcanırdı (gözden geçirme, 27 Eki 2026). Kimlik yalnız aynı müşteri, tür ve tutarda ilk sonucu döner.
 */
export function collectCustomerPayment(
  t: Tx,
  actor: Actor,
  fx: Effects,
  input: { customerId: string; methodId: string; amount: number; note?: string | null; requestId?: string | null },
) {
  need(actor, 'cari.yonet');
  const day = requireOpenDay(t);
  const amount = Math.trunc(input.amount);
  if (input.requestId) {
    const prev = t
      .select()
      .from(schema.payments)
      .where(and(isNull(schema.payments.orderId), eq(schema.payments.requestId, input.requestId)))
      .get();
    if (prev) {
      if (prev.customerId !== input.customerId || prev.methodId !== input.methodId || prev.amount !== amount) {
        throw conflict('Tahsilat ekranı değişti; bakiyeye bakıp yeniden alın', 'request_reused');
      }
      return;
    }
  }
  const cust = t.select().from(schema.customers).where(eq(schema.customers.id, input.customerId)).get();
  if (!cust) throw notFound('Müşteri');
  const method = t.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, input.methodId)).get();
  if (!method || !method.active || method.kind === 'cari') throw bad('Tahsilat için nakit, kart ya da havale seçin');
  if (amount <= 0) throw bad('Tutar sıfırdan büyük olmalı');
  if (amount > cust.balance) {
    throw conflict(cust.balance > 0 ? `${cust.name} açık hesabında ${tl(cust.balance)} borç var; en çok bu kadar tahsil edilir` : `${cust.name} açık hesabında borç yok`, 'over_balance');
  }
  const now = Date.now();
  const paymentId = ulid(now);
  t.insert(schema.payments)
    .values({
      id: paymentId,
      orderId: null,
      dayId: day.id,
      methodId: method.id,
      methodName: method.name,
      zField: method.zField,
      amount,
      customerId: cust.id,
      note: input.note?.trim() || 'Açık hesap tahsilatı',
      userId: actor.user.id,
      createdAt: now,
      requestId: input.requestId ?? null,
    })
    .run();
  t.insert(schema.customerLedger)
    .values({ id: ulid(now), customerId: cust.id, kind: 'tahsilat', amount: -amount, paymentId, methodId: method.id, dayId: day.id, note: input.note?.trim() || null, userId: actor.user.id, createdAt: now })
    .run();
  t.update(schema.customers).set({ balance: cust.balance - amount }).where(eq(schema.customers.id, cust.id)).run();
  fx.audit(t, { userId: actor.user.id, action: 'customer.collect', entity: 'customer', entityId: cust.id, amount, message: `${cust.name} açık hesabından ${tl(amount)} ${method.name} tahsil edildi` });
  fx.emit({ topic: 'customers', kind: 'ledger', byUserId: actor.user.id });
  fx.emit({ topic: 'cash', kind: 'collection', byUserId: actor.user.id });
}

const Z_FIELDS: ZField[] = ['cash', 'card', 'meal_card', 'online', 'other'];

/**
 * Günlerin ödemelerine ait yazarkasa fişleri: "yazarkasadan geçmeyen"in girdisi (shared/order-calc.ts
 * `offDeviceTotals`). Yalnız ödemesi LafPOS'a işlenmiş (`paymentIds` dolu) fişler; fiş, ödemesinin adisyonundadır
 * (birleştirmede ikisi birlikte taşınır, gün aşırı ödemede de). Adisyonlar alt sorguyla seçilir: uzun dönemde kimlik
 * listesi SQLite'ın değişken sınırına takılmaz (günler en çok 400)
 */
export function deviceReceipts(t: Tx | DB, dayIds: string[]): { paymentIds: string[]; status: FiscalStatus }[] {
  const orderIds = t.select({ id: schema.payments.orderId }).from(schema.payments).where(inArray(schema.payments.dayId, dayIds));
  return t
    .select({ paymentIds: schema.fiscalReceipts.paymentIds, status: schema.fiscalReceipts.status })
    .from(schema.fiscalReceipts)
    .where(and(inArray(schema.fiscalReceipts.orderId, orderIds), sql`${schema.fiscalReceipts.paymentIds} <> '[]'`))
    .all();
}

/** Günün özeti. Gün açıkken ara rapor (X), kapanışta Z olarak saklanır. */
export function computeSummary(t: Tx | DB, day: DayRow): ZSummary {
  const orders = t.select().from(schema.orders).where(eq(schema.orders.dayId, day.id)).all();
  const orderIds = orders.map((o) => o.id);
  const items = orderIds.length ? t.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds)).all() : [];
  const pays = t.select().from(schema.payments).where(and(eq(schema.payments.dayId, day.id), isNull(schema.payments.refundedAt))).all();
  const moves = t.select().from(schema.cashMovements).where(eq(schema.cashMovements.dayId, day.id)).all();
  const methods = t.select().from(schema.paymentMethods).all();
  const users = new Map(t.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));

  const posOrders = orders.filter((o) => o.source === 'pos');
  const closed = posOrders.filter((o) => o.status === 'kapali');
  const itemsBy = new Map<string, typeof items>();
  for (const i of items) (itemsBy.get(i.orderId) ?? itemsBy.set(i.orderId, []).get(i.orderId)!).push(i);

  let gross = 0;
  let discounts = 0;
  let complimentary = 0;
  let odenmez = 0;
  let zayi = 0;
  const odenmezItems: (typeof items)[number][] = [];
  let service = 0;
  let netSales = 0;
  const kdv = new Map<number, { gross: number; base: number; kdv: number }>();
  const products = new Map<string, { name: string; qty: number; amount: number }>();
  const byUser = new Map<string, { orders: number; amount: number }>();

  for (const o of closed) {
    const its = itemsBy.get(o.id) ?? [];
    const totals = o.totals ?? calcOrder({ lines: [], discount: null });
    gross += totals.gross;
    discounts += totals.lineDiscounts + totals.orderDiscount;
    complimentary += totals.complimentary;
    service += totals.service;
    netSales += totals.total;
    for (const r of totals.kdv) {
      const k = kdv.get(r.rate) ?? { gross: 0, base: 0, kdv: 0 };
      k.gross += r.gross;
      k.base += r.base;
      k.kdv += r.kdv;
      kdv.set(r.rate, k);
    }
    for (const i of its) {
      if (!i.voided && i.complimentary && i.compKind === 'odenmez') {
        odenmez += i.qty * i.unitPrice;
        odenmezItems.push(i);
      }
      if (!i.voided && i.complimentary && i.compKind === 'zayi') zayi += i.qty * i.unitPrice;
      if (i.voided || i.complimentary) continue;
      const key = `${i.name}|${i.size}`;
      const p = products.get(key) ?? { name: i.size === 'TEK' ? i.name : `${i.name} ${i.size}`, qty: 0, amount: 0 };
      p.qty += i.qty;
      p.amount += totals.lineNet[i.id] ?? 0;
      products.set(key, p);
    }
    const w = o.waiterId ?? 'yok';
    const u = byUser.get(w) ?? { orders: 0, amount: 0 };
    u.orders += 1;
    u.amount += totals.total;
    byUser.set(w, u);
  }

  // İptaller bütün adisyonlardan (kapanmış, açık, iptal edilmiş)
  let voided = 0;
  let voidAfterSendCount = 0;
  for (const i of items) {
    const o = orders.find((x) => x.id === i.orderId);
    if (!i.voided || o?.source !== 'pos') continue;
    voided += i.qty * i.unitPrice;
    if (i.voidAfterSend) voidAfterSendCount += 1;
  }

  const salesPays = pays.filter((p) => p.orderId);
  const collections = pays.filter((p) => !p.orderId);
  const byZField = Object.fromEntries(Z_FIELDS.map((f) => [f, 0])) as Record<ZField, number>;
  const payMap = new Map<string, ZSummary['payments'][number]>();
  for (const p of salesPays) {
    byZField[p.zField] += p.amount;
    const m = methods.find((x) => x.id === p.methodId);
    const row = payMap.get(p.methodId) ?? { methodId: p.methodId, name: p.methodName, zField: p.zField, channel: m?.channel ?? null, count: 0, amount: 0, tips: 0 };
    row.count += 1;
    row.amount += p.amount;
    row.tips += p.tip;
    payMap.set(p.methodId, row);
  }
  // Çekmeceye giren nakit, Z'nin nakit alanıyla aynı bilgiden: ödemeye alındığı an dondurulan Z alanı. Ödeme türü
  // sonradan değişse (Nakit → Kart) de Z nakdi ve beklenen nakit aynı ödemeleri sayar; lafmaliyet'in beklenen nakit
  // formülü (açılış + nakit + cash_in − harcama − teslim) LafPOS'unkini verir. Z'de "Diğer"e yazılan ödeme (döviz
  // gibi çekmeceye ayrı giren) TL beklenen nakde girmez; Yönetim Z'de nakdi yalnız Nakit türüne verir
  const cashSales = salesPays.filter((p) => p.zField === 'cash').reduce((a, p) => a + p.amount + p.tip, 0);
  const cashCollections = collections.filter((p) => p.zField === 'cash').reduce((a, p) => a + p.amount, 0);
  const cashIn = moves.filter((m) => m.kind === 'giris').reduce((a, m) => a + m.amount, 0);
  const cashOut = moves.filter((m) => m.kind === 'harcama').reduce((a, m) => a + m.amount, 0);
  const handedOver = moves.filter((m) => m.kind === 'teslim').reduce((a, m) => a + m.amount, 0);
  const expectedCash = day.openingCash + cashSales + cashCollections + cashIn - cashOut - handedOver;
  const cariSales = salesPays.filter((p) => methods.find((m) => m.id === p.methodId)?.kind === 'cari').reduce((a, p) => a + p.amount, 0);
  const online = orders.filter(onlineCounted);
  // Kart ve nakdin mali fişi yazarkasada kesilmeyen kısmı: cihaz fişinden gelen ödemeler düşülür
  const offDevice = offDeviceTotals(salesPays, deviceReceipts(t, [day.id]));

  return {
    orders: posOrders.length,
    receipts: closed.filter((o) => o.total > 0).length,
    guests: closed.filter((o) => o.type === 'masa').reduce((a, o) => a + o.guests, 0),
    gross,
    discounts,
    complimentary,
    odenmez,
    zayi,
    odenmezPeople: odenmezByPerson(odenmezItems),
    voided,
    voidAfterSendCount,
    service,
    netSales,
    payments: [...payMap.values()].sort((a, b) => b.amount - a.amount),
    byZField,
    offDevice,
    kdv: [...kdv.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) => ({ rate, ...v })),
    tips: salesPays.reduce((a, p) => a + p.tip, 0),
    cariSales,
    cariCollections: collections.reduce((a, p) => a + p.amount, 0),
    cashIn,
    cashOut,
    handedOver,
    openingCash: day.openingCash,
    expectedCash,
    countedCash: day.countedCash,
    cashDiff: day.cashDiff,
    onlineOrders: online.length,
    onlineTotal: online.reduce((a, o) => a + (o.extTotal ?? 0), 0),
    topProducts: [...products.values()].sort((a, b) => b.amount - a.amount).slice(0, 15),
    byUser: [...byUser.entries()].map(([userId, v]) => ({ userId, name: users.get(userId) ?? 'Bilinmiyor', ...v })).sort((a, b) => b.amount - a.amount),
    openOrdersAtClose: posOrders.filter((o) => o.status === 'acik').length,
  };
}

/**
 * Bugünün kapanmış gününü yeniden açar (gece Z alındıktan sonra gelen müşteri). Yalnız son gün, yalnız bugünün
 * tarihi ve açık gün yokken; ödeme iptaliyle aynı yetki (yetkili onayı). Z numarası aynı kalır, gün yeniden
 * kapanınca lafmaliyet'e aynı tarih ve Z ile yeniden gider (öncekinin yerine geçer).
 */
export function reopenDay(t: Tx, actor: Actor, fx: Effects, dayId: string, reason: string): DayRow {
  needDirect(actor, 'kasa.gun');
  const approverId = need(actor, 'odeme.iade', 'Kapanmış günü yeniden açmak yetkili onayı gerektirir');
  if (!reason.trim()) throw bad('Neden yazılmalı', 'reason_required');
  if (getOpenDay(t)) throw conflict('Açık bir gün var', 'day_open');
  const day = getDay(t, dayId);
  const last = t.select({ z: sql<number>`max(${schema.businessDays.zNo})` }).from(schema.businessDays).get();
  if (!day.closedAt || day.zNo !== last?.z || day.date !== businessDate(Date.now())) {
    throw conflict('Yalnız bugünün son gün sonu yeniden açılabilir', 'day_not_reopenable');
  }
  t.update(schema.businessDays)
    .set({
      closedAt: null,
      closedBy: null,
      countedCash: null,
      cashCounts: null,
      expectedCash: null,
      cashDiff: null,
      summary: null,
      exportedAt: null,
      trainingDay: null,
      reopenedAt: Date.now(),
      // lafmaliyet'e giden gövdenin düzeltmesi (`correction`): neden saklanır; önceki sayım düzeltmesi yeni kapanışın
      // sayımıyla geçersiz
      reopenReason: reason.trim().slice(0, 200),
      recountReason: null,
    })
    .where(eq(schema.businessDays.id, dayId))
    .run();
  // Henüz gitmemiş eski Z lafmaliyet'e gün açıkken gitmesin; gün yeniden kapanınca güncel Z kuyruğa girer
  t.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, `gun:${day.date}`), isNull(schema.outbox.sentAt))).run();
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: 'day.reopen',
    severity: 'alarm',
    message: `${actor.user.name} Z ${day.zNo} gün sonunu geri aldı ve günü yeniden açtı (${reason.trim()})`,
  });
  fx.emit({ topic: 'cash', kind: 'day.reopened', byUserId: actor.user.id });
  // Masa planı ve tabletler açık günü kurulum verisinden okur (açma ve kapamadaki gibi)
  fx.emit({ topic: 'settings', kind: 'day.reopened', byUserId: actor.user.id });
  return getDay(t, dayId);
}

/** Açık gün yokken bugünün kapanmış günü (kasa ekranındaki "Günü yeniden aç" için) */
export function closedToday(t: Tx | DB): DayRow | null {
  return (
    t
      .select()
      .from(schema.businessDays)
      .where(and(eq(schema.businessDays.date, businessDate(Date.now())), isNotNull(schema.businessDays.closedAt)))
      .orderBy(desc(schema.businessDays.zNo))
      .get() ?? null
  );
}

/**
 * Gün sonu. `actor` null: kasada kişi yok (otomatik ya da uzaktan gün sonu); kapanış ve adisyonun `closedBy`'ı boş kalır
 * (personel tablosuna bağlı). `system`: kişisiz kapanışı kimin istediği ("Uzaktan (e-posta)", `uzaktan`): denetim kaydı
 * onun adıyla yazılır, yoksa "Otomatik gün sonu". Uzaktan gün sonu zamanlanmış kapanışla karışıyordu (inceleme, 23 Kas
 * 2026)
 */
export function closeDay(
  t: Tx,
  actor: Actor | null,
  fx: Effects,
  input: { countedCash: number | null; cashCounts?: Record<string, number> | null; note?: string | null },
  system?: { userId: string; name: string },
): DayRow {
  if (actor) needDirect(actor, 'kasa.gun');
  const by = actor?.user ?? system ?? null;
  const byId = actor?.user.id ?? system?.userId ?? null;
  const day = requireOpenDay(t);
  const counted = input.countedCash == null ? null : Math.max(0, Math.trunc(input.countedCash));
  const cashCounts = closeCounts(input.cashCounts, counted);
  const open = t
    .select({ id: schema.orders.id, no: schema.orders.no })
    .from(schema.orders)
    .where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos')))
    .all();
  // Kalemsiz ve ödemesiz adisyon parasal iz bırakmaz: gün sonunu tutmaz, kendiliğinden kapanır
  const emptyAt = Date.now();
  const openPos = open.filter((o) => {
    if (!isEmptyOrder(t, o.id)) return true;
    t.update(schema.orders).set({ status: 'iptal', cancelReason: 'Boş adisyon (gün sonu)', closedAt: emptyAt, closedBy: actor?.user.id ?? null, updatedAt: emptyAt }).where(eq(schema.orders.id, o.id)).run();
    fx.audit(t, { userId: byId, action: 'order.cancel', severity: 'info', orderId: o.id, amount: 0, message: `#${o.no} boş adisyon gün sonunda kapatıldı` });
    return false;
  });
  if (openPos.length) {
    throw conflict(`Açık adisyon var: ${openPos.map((o) => `#${o.no}`).join(', ')}. Gün sonundan önce kapatın ya da iptal edin`, 'open_orders');
  }
  // Açık kalan online siparişler sitenin; Z'ye girmezler, gün kapandıktan sonra da aşamaları güncellenebilir
  const summary = computeSummary(t, day);
  const diff = counted == null ? null : counted - summary.expectedCash;
  const now = Date.now();
  summary.countedCash = counted;
  summary.cashDiff = diff;
  t.update(schema.businessDays)
    .set({
      closedAt: now,
      closedBy: actor?.user.id ?? null,
      countedCash: counted,
      cashCounts,
      expectedCash: summary.expectedCash,
      cashDiff: diff,
      note: input.note?.trim() || null,
      summary,
      // Kurulum modunda kapanan gün eğitim günüdür: lafmaliyet'e hiç gitmez (kurulum modu sonra kapansa da)
      trainingDay: trainingDayNow(),
    })
    .where(eq(schema.businessDays.id, day.id))
    .run();
  const threshold = getSettings().alertCashDiffKurus;
  fx.audit(t, {
    userId: byId,
    action: 'day.close',
    severity: diff == null ? 'info' : Math.abs(diff) >= threshold ? 'alarm' : diff !== 0 ? 'uyari' : 'info',
    amount: summary.netSales,
    message: `${by ? `${by.name} gün sonu aldı` : 'Otomatik gün sonu alındı'} (Z ${day.zNo}): ciro ${tl(summary.netSales)}, kasa farkı ${diff == null ? 'sayılmadı' : diff === 0 ? 'yok' : tl(diff)}`,
    data: { expectedCash: summary.expectedCash, counted },
  });
  fx.emit({ topic: 'cash', kind: 'day.closed', byUserId: actor?.user.id });
  fx.emit({ topic: 'settings', kind: 'day.closed', byUserId: actor?.user.id });
  return t.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!;
}

/**
 * Banknot dökümü sayılan nakdi tutmalı (vardiya sayımındaki gibi): föy penceresi kaydedilmiş adetlerle açılır, toplamı
 * tutmayan döküm sayılanla çelişen bir gün kaydı bırakırdı. `notes` banknotun kuruş değeri → adet; sıfırlar sayılmaz.
 */
function checkBanknotes(notes: Record<string, number>, counted: number) {
  const positive = Object.entries(notes).filter(([, n]) => n > 0);
  const fromNotes = positive.reduce((a, [k, n]) => a + Number(k) * n, 0);
  if (positive.length && fromNotes !== counted) {
    throw new HttpError(422, `Banknotların toplamı (${tl(fromNotes)}) sayılan tutarla (${tl(counted)}) aynı değil`, 'validation');
  }
}

/**
 * Gün sonunda saklanan sayım (`b:` banknot adedi, `m:` ödeme türünün sayılan tutarı). Sayımsız kapanışta ("sonra
 * gireceğim") banknot adedi saklanmaz: yarım kalan sayım föye taşınıp sayılanla çelişmesin; slip tutarları kalır.
 */
function closeCounts(input: Record<string, number> | null | undefined, counted: number | null): Record<string, number> | null {
  if (!input) return null;
  if (counted == null) return Object.fromEntries(Object.entries(input).filter(([k]) => !k.startsWith('b:')));
  checkBanknotes(Object.fromEntries(Object.entries(input).filter(([k]) => k.startsWith('b:')).map(([k, n]) => [k.slice(2), n])), counted);
  return input;
}

export function listDays(t: Tx | DB, limit = 60) {
  return t.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).limit(limit).all();
}

export function getDay(t: Tx | DB, id: string): DayRow {
  const d = t.select().from(schema.businessDays).where(eq(schema.businessDays.id, id)).get();
  if (!d) throw notFound('Gün');
  return d;
}

const toTL = (k: number) => Math.round(k) / 100;

/** lafmaliyet Kasa raporu alanları, formdaki sırayla (TL, iki ondalık). docs/03-ENTEGRASYON.md §3.2 */
export function lafmaliyetZ(day: DayRow, s: ZSummary) {
  return {
    date: day.date,
    z_no: day.zNo,
    receipts: s.receipts,
    z_total: toTL(Object.values(s.byZField).reduce((a, b) => a + b, 0)),
    cash: toTL(s.byZField.cash),
    card: toTL(s.byZField.card),
    meal_card: toTL(s.byZField.meal_card),
    online: toTL(s.byZField.online),
    other: toTL(s.byZField.other),
    off_revenue: toTL(s.complimentary),
    discounts: toTL(s.discounts),
    opening_cash: toTL(s.openingCash),
    cash_out: toTL(s.cashOut),
    counted_cash: s.countedCash == null ? null : toTL(s.countedCash),
    handed_over: toTL(s.handedOver),
    // Satış dışında çekmeceye giren nakit (giriş, nakit cari tahsilatı, nakit bahşiş): lafmaliyet beklenen nakdi
    // bununla LafPOS'unkine eşitler (açılış + nakit satış + kasaya giren − harcama − teslim)
    cash_in: toTL(Math.max(0, s.expectedCash - s.openingCash - s.byZField.cash + s.cashOut + s.handedOver)),
    expected_cash: toTL(s.expectedCash),
    cash_diff: s.cashDiff == null ? null : toTL(s.cashDiff),
  };
}

type ShiftCountRow = typeof schema.shiftCounts.$inferSelect;

/**
 * Vardiya kasa sayımı (gün içinde kasiyer değişirken): devreden kasayı sayar, o anki beklenen nakit (ara rapor) ve
 * fark saklanır. Kasa hareketi değildir: beklenen nakdi, Z'yi ve gün sonu sayımını değiştirmez; lafmaliyet'e gitmez.
 * Devralan kendi PIN'ini girerse (`approverPin`) devir iki kişilik onaylanır; devralan seçilmediyse PIN'in sahibidir.
 * Fark gün sonu sayımıyla aynı eşikte uyarı ya da alarm yazar.
 */
export function recordShiftCount(
  t: Tx,
  actor: Actor,
  fx: Effects,
  input: { countedCash: number; banknotes?: Record<string, number>; note?: string | null; toUserId?: string | null },
): ShiftCountRow {
  needDirect(actor, 'kasa.gun');
  const day = requireCurrentDay(t);
  const counted = Math.max(0, Math.trunc(input.countedCash));
  const notes = Object.fromEntries(Object.entries(input.banknotes ?? {}).filter(([, n]) => n > 0).map(([k, n]) => [k, Math.trunc(n)]));
  const fromNotes = Object.entries(notes).reduce((a, [k, n]) => a + Number(k) * n, 0);
  if (Object.keys(notes).length && fromNotes !== counted) {
    throw new HttpError(422, `Banknotların toplamı (${tl(fromNotes)}) sayılan tutarla (${tl(counted)}) aynı değil`, 'validation');
  }
  let toUserId = input.toUserId ?? null;
  if (toUserId === actor.user.id) throw bad('Kasa kendinize devredilmez; devralanı seçin ya da boş bırakın', 'self_handover');
  const confirmed = !!actor.approver;
  if (actor.approver) toUserId = counterpartFor(actor, toUserId);
  const to = toUserId ? t.select({ id: schema.users.id, name: schema.users.name, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, toUserId)).get() : null;
  if (toUserId && !to?.active) throw new HttpError(422, 'Devralan personel bulunamadı ya da hesabı kapalı', 'invalid_reference');
  const expected = computeSummary(t, day).expectedCash;
  const diff = counted - expected;
  // Fark günün başından birikir: önceki devirde bulunan eksik sonraki devirde yeniden alarm olmasın, devralana
  // yazılmasın. Uyarı ve mesaj bu vardiyanın kendi farkıyla (önceki sayımdan bu yana); saklanan fark gün toplamı.
  const prevDiff = shiftCountsOf(t, day.id).at(-1)?.diff ?? 0;
  const shiftDiff = diff - prevDiff;
  const now = Date.now();
  const row: ShiftCountRow = {
    id: ulid(now),
    dayId: day.id,
    userId: actor.user.id,
    toUserId,
    confirmed,
    counted,
    expected,
    diff,
    banknotes: Object.keys(notes).length ? notes : null,
    note: input.note?.trim() || null,
    createdAt: now,
  };
  t.insert(schema.shiftCounts).values(row).run();
  const threshold = getSettings().alertCashDiffKurus;
  const who = to ? `${actor.user.name} vardiyayı devretti, kasayı ${to.name} devraldı${confirmed ? ' (PIN ile onayladı)' : ''}` : `${actor.user.name} vardiya sayımı yaptı`;
  fx.audit(t, {
    userId: actor.user.id,
    approverId: confirmed ? toUserId : null,
    action: 'cash.shift_count',
    severity: Math.abs(shiftDiff) >= threshold ? 'alarm' : shiftDiff !== 0 ? 'uyari' : 'info',
    entity: 'shift_count',
    entityId: row.id,
    amount: shiftDiff,
    message: `${who} (Z ${day.zNo}): sayılan ${tl(counted)}, ${shiftDiffText(shiftDiff, diff)}`,
    data: { dayId: day.id, counted, expected, diff, shiftDiff, toUserId },
  });
  fx.emit({ topic: 'cash', kind: 'shift.counted', byUserId: actor.user.id });
  return row;
}

/** "fark yok", "fark -₺150,00"; gün toplamı vardiyanınkinden ayrıysa o da: "bu vardiyada fark yok (gün toplamı -₺150,00)" */
function shiftDiffText(shiftDiff: number, dayDiff: number): string {
  const signed = (k: number) => `${k > 0 ? '+' : ''}${tl(k)}`;
  const own = shiftDiff === 0 ? 'yok' : signed(shiftDiff);
  return dayDiff === shiftDiff ? `fark ${own}` : `bu vardiyada fark ${own} (gün toplamı ${dayDiff === 0 ? 'denk' : signed(dayDiff)})`;
}

/** Günün vardiya sayımları, sırayla */
export function shiftCountsOf(t: Tx | DB, dayId: string): ShiftCountRow[] {
  return t.select().from(schema.shiftCounts).where(eq(schema.shiftCounts.dayId, dayId)).orderBy(asc(schema.shiftCounts.createdAt)).all();
}

/** `prevDiff`: aynı günün bir önceki sayımının farkı (yoksa 0); vardiyanın kendi farkı bundan bulunur */
export function shiftCountToDTO(s: ShiftCountRow, names: Map<string, string>, prevDiff: number): ShiftCountDTO {
  return {
    id: s.id,
    dayId: s.dayId,
    userId: s.userId,
    userName: names.get(s.userId) ?? 'Bilinmiyor',
    toUserId: s.toUserId,
    toUserName: s.toUserId ? (names.get(s.toUserId) ?? 'Bilinmiyor') : null,
    confirmed: s.confirmed,
    counted: s.counted,
    expected: s.expected,
    diff: s.diff,
    shiftDiff: s.diff - prevDiff,
    banknotes: s.banknotes,
    note: s.note,
    createdAt: s.createdAt,
  };
}

/**
 * Kasa föyü: gün kapandıktan sonra (otomatik gün sonu ya da sayımsız kapanış) nakit sayımı ve ödeme türü
 * bazında sayılan tutarlar (banka POS slipi, yemek kartı raporları) girilir; sistemle fark hesaplanır.
 */
export function recordCount(
  t: Tx,
  actor: Actor,
  fx: Effects,
  dayId: string,
  input: { countedCash: number; methodCounts?: Record<string, number>; banknotes?: Record<string, number>; note?: string | null },
): DayRow {
  needDirect(actor, 'kasa.gun');
  const day = getDay(t, dayId);
  if (!day.closedAt) throw conflict('Gün henüz kapanmadı; sayım gün sonunda girilir', 'day_open');
  // İlk sayım kasiyerin işi; kaydedilmiş sayımı değiştirmek (farkı yeniden yazmak) yetkili onayı ister
  const approverId = day.countedCash != null ? need(actor, 'rapor.gor', 'Kaydedilmiş kasa sayımını değiştirmek yetkili onayı gerektirir') : null;
  const summary = day.summary ?? computeSummary(t, day);
  const counted = Math.max(0, Math.trunc(input.countedCash));
  checkBanknotes(input.banknotes ?? {}, counted);
  const diff = counted - summary.expectedCash;
  summary.countedCash = counted;
  summary.cashDiff = diff;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.banknotes ?? {})) counts[`b:${k}`] = Math.max(0, Math.trunc(v));
  for (const [k, v] of Object.entries(input.methodCounts ?? {})) counts[`m:${k}`] = Math.max(0, Math.trunc(v));
  // Not gönderilmezse (ya da null) kalır; gönderilen metin yerine geçer, boş metin notu siler (föy kayıtlı notla açılır)
  const note = input.note == null ? day.note : input.note.trim() || null;
  // Kaydedilmiş sayımın değişmesi lafmaliyet'e giden günün düzeltmesidir (`correction` recount); ilk sayım değil
  const recountReason = day.countedCash != null ? `Kasa sayımı değiştirildi: ${tl(day.countedCash)} → ${tl(counted)}` : day.recountReason;
  t.update(schema.businessDays).set({ countedCash: counted, cashDiff: diff, cashCounts: counts, summary, note, recountReason }).where(eq(schema.businessDays.id, dayId)).run();
  const threshold = getSettings().alertCashDiffKurus;
  fx.audit(t, {
    userId: actor.user.id,
    approverId,
    action: approverId || day.countedCash != null ? 'day.recount' : 'day.count',
    severity: Math.abs(diff) >= threshold || day.countedCash != null ? 'alarm' : diff !== 0 ? 'uyari' : 'info',
    amount: diff,
    message:
      day.countedCash != null
        ? `${actor.user.name} Z ${day.zNo} kasa sayımını değiştirdi: ${tl(day.countedCash)} → ${tl(counted)}, fark ${diff === 0 ? 'yok' : tl(diff)}`
        : `${actor.user.name} Z ${day.zNo} kasa föyünü girdi: sayılan ${tl(counted)}, fark ${diff === 0 ? 'yok' : tl(diff)}`,
  });
  fx.emit({ topic: 'cash', kind: 'day.counted', byUserId: actor.user.id });
  return getDay(t, dayId);
}
