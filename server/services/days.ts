import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { tl } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { businessDate } from '@shared/time';
import type { BusinessDayDTO } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import type { ZField, ZSummary } from '../db/schema';
import { type Actor, need, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings } from '../lib/settings';
import { getOpenDay, requireOpenDay } from './orders';

type DayRow = typeof schema.businessDays.$inferSelect;

export function dayToDTO(t: Tx | DB, d: DayRow | undefined | null): BusinessDayDTO | null {
  if (!d) return null;
  const opener = d.openedBy ? t.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, d.openedBy)).get() : null;
  return { id: d.id, date: d.date, zNo: d.zNo, openedAt: d.openedAt, openedByName: opener?.name ?? null, openingCash: d.openingCash, closedAt: d.closedAt, reopenedAt: d.reopenedAt };
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
  const last = t.select({ z: sql<number>`coalesce(max(${schema.businessDays.zNo}), 0)` }).from(schema.businessDays).get();
  const day = {
    id: ulid(now),
    date: businessDate(now),
    zNo: (last?.z ?? 0) + 1,
    openedAt: now,
    openedBy: actor.user.id,
    openingCash: Math.max(0, Math.trunc(input.openingCash)),
    lastOrderNo: 0,
  };
  t.insert(schema.businessDays).values(day).run();
  fx.audit(t, { userId: actor.user.id, action: 'day.open', amount: day.openingCash, message: `${actor.user.name} günü açtı (Z ${day.zNo}, açılış ${tl(day.openingCash)})` });
  fx.emit({ topic: 'cash', kind: 'day.opened', byUserId: actor.user.id });
  fx.emit({ topic: 'settings', kind: 'day.opened', byUserId: actor.user.id });
  return t.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!;
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
export function collectCustomerPayment(t: Tx, actor: Actor, fx: Effects, input: { customerId: string; methodId: string; amount: number; note?: string | null }) {
  need(actor, 'cari.yonet');
  const day = requireOpenDay(t);
  const cust = t.select().from(schema.customers).where(eq(schema.customers.id, input.customerId)).get();
  if (!cust) throw notFound('Müşteri');
  const method = t.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, input.methodId)).get();
  if (!method || !method.active || method.kind === 'cari') throw bad('Tahsilat için nakit, kart ya da havale seçin');
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw bad('Tutar sıfırdan büyük olmalı');
  const now = Date.now();
  const paymentId = ulid(now);
  t.insert(schema.payments)
    .values({ id: paymentId, orderId: null, dayId: day.id, methodId: method.id, methodName: method.name, zField: method.zField, amount, customerId: cust.id, note: input.note?.trim() || 'Açık hesap tahsilatı', userId: actor.user.id, createdAt: now })
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
  const cashMethodIds = new Set(methods.filter((m) => m.kind === 'nakit').map((m) => m.id));
  const cashSales = salesPays.filter((p) => cashMethodIds.has(p.methodId)).reduce((a, p) => a + p.amount + p.tip, 0);
  const cashCollections = collections.filter((p) => cashMethodIds.has(p.methodId)).reduce((a, p) => a + p.amount, 0);
  const cashIn = moves.filter((m) => m.kind === 'giris').reduce((a, m) => a + m.amount, 0);
  const cashOut = moves.filter((m) => m.kind === 'harcama').reduce((a, m) => a + m.amount, 0);
  const handedOver = moves.filter((m) => m.kind === 'teslim').reduce((a, m) => a + m.amount, 0);
  const expectedCash = day.openingCash + cashSales + cashCollections + cashIn - cashOut - handedOver;
  const cariSales = salesPays.filter((p) => methods.find((m) => m.id === p.methodId)?.kind === 'cari').reduce((a, p) => a + p.amount, 0);
  const online = orders.filter((o) => o.source === 'laffogato');

  return {
    orders: posOrders.length,
    receipts: closed.filter((o) => o.total > 0).length,
    guests: closed.filter((o) => o.type === 'masa').reduce((a, o) => a + o.guests, 0),
    gross,
    discounts,
    complimentary,
    voided,
    voidAfterSendCount,
    service,
    netSales,
    payments: [...payMap.values()].sort((a, b) => b.amount - a.amount),
    byZField,
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
    .set({ closedAt: null, closedBy: null, countedCash: null, cashCounts: null, expectedCash: null, cashDiff: null, summary: null, exportedAt: null, reopenedAt: Date.now() })
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

export function closeDay(
  t: Tx,
  actor: Actor | null,
  fx: Effects,
  input: { countedCash: number | null; cashCounts?: Record<string, number> | null; note?: string | null },
): DayRow {
  if (actor) needDirect(actor, 'kasa.gun');
  const day = requireOpenDay(t);
  const openPos = t
    .select({ no: schema.orders.no })
    .from(schema.orders)
    .where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos')))
    .all();
  if (openPos.length) {
    throw conflict(`Açık adisyon var: ${openPos.map((o) => `#${o.no}`).join(', ')}. Gün sonundan önce kapatın ya da iptal edin`, 'open_orders');
  }
  // Açık kalan online siparişler sitenin; Z'ye girmezler, gün kapandıktan sonra da aşamaları güncellenebilir
  const counted = input.countedCash == null ? null : Math.max(0, Math.trunc(input.countedCash));
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
      cashCounts: input.cashCounts ?? null,
      expectedCash: summary.expectedCash,
      cashDiff: diff,
      note: input.note?.trim() || null,
      summary,
    })
    .where(eq(schema.businessDays.id, day.id))
    .run();
  const threshold = getSettings().alertCashDiffKurus;
  fx.audit(t, {
    userId: actor?.user.id ?? null,
    action: 'day.close',
    severity: diff == null ? 'info' : Math.abs(diff) >= threshold ? 'alarm' : diff !== 0 ? 'uyari' : 'info',
    amount: summary.netSales,
    message: `${actor ? `${actor.user.name} gün sonu aldı` : 'Otomatik gün sonu alındı'} (Z ${day.zNo}): ciro ${tl(summary.netSales)}, kasa farkı ${diff == null ? 'sayılmadı' : diff === 0 ? 'yok' : tl(diff)}`,
    data: { expectedCash: summary.expectedCash, counted },
  });
  fx.emit({ topic: 'cash', kind: 'day.closed', byUserId: actor?.user.id });
  fx.emit({ topic: 'settings', kind: 'day.closed', byUserId: actor?.user.id });
  return t.select().from(schema.businessDays).where(eq(schema.businessDays.id, day.id)).get()!;
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
  const diff = counted - summary.expectedCash;
  summary.countedCash = counted;
  summary.cashDiff = diff;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.banknotes ?? {})) counts[`b:${k}`] = Math.max(0, Math.trunc(v));
  for (const [k, v] of Object.entries(input.methodCounts ?? {})) counts[`m:${k}`] = Math.max(0, Math.trunc(v));
  t.update(schema.businessDays)
    .set({ countedCash: counted, cashDiff: diff, cashCounts: counts, summary, note: input.note?.trim() || day.note })
    .where(eq(schema.businessDays.id, dayId))
    .run();
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
