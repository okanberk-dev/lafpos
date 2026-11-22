import { and, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { businessDate } from '@shared/time';
import type { DayRangeDTO, DenemeStatusDTO } from '@shared/types';
import { type DB, db, schema, type Tx, tx } from '../db/client';
import { DEMO_USERS } from '../db/seed';
import { type AuthUser, hashPin } from '../lib/auth';
import { Effects } from '../lib/effects';
import { conflict, HttpError } from '../lib/http';
import { getSettings, trainingMode, updateSettings } from '../lib/settings';
import { getOpenDay } from './orders';

/**
 * Deneme modu ve "Denemeyi bitir, gerçek kullanıma başla" (docs/03-ENTEGRASYON.md §4.3, docs/05-KASA-BILGISAYARI.md).
 *
 * Yeni kurulum deneme modunda açılır (`demoMode` ve eğitim yazarkasası, `trainingMode`): satışlar eğitimdir,
 * lafmaliyet'e gitmez. Kafede denedikten sonra patron bir kez "gerçek kullanıma başla" der: önce veritabanının yedeği
 * alınır, sonra tek işlemde bütün deneme hareketleri (adisyon, ödeme, gün, kasa hareketi, fiş, rezervasyon, platform
 * siparişi, müşteri, denetim kaydı) silinir; kurulum (menü, personel, masalar, ödeme türleri, istasyonlar, yazıcılar,
 * ayarlar) kalır. Örnek PIN'ler kapanır: patron yeni PIN'ini aynı pencerede verir, örnek PIN'iyle kalan öbür hesaplar
 * kapatılır. `liveSince` yazılır; bir daha hiçbir şey silinmez (işlem tekrarlanırsa yalnız "zaten başladı" döner).
 */

/** Örnek PIN'lerin özetleri (anahtar `env.secret`'a bağlı olduğundan çalışma anında hesaplanır) */
let sampleHashes: Set<string> | null = null;
export function isSamplePinHash(pinHash: string): boolean {
  sampleHashes ??= new Set(DEMO_USERS.map((u) => hashPin(u.pin)));
  return sampleHashes.has(pinHash);
}
export const isSamplePin = (pin: string) => isSamplePinHash(hashPin(pin));

/** Silinen deneme kayıtlarının sayısı (onay penceresi ve denetim kaydı) */
function countRows(t: Tx | DB) {
  const n = (table: Parameters<ReturnType<typeof t.select>['from']>[0]) => t.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
  return {
    orders: n(schema.orders),
    payments: n(schema.payments),
    days: n(schema.businessDays),
    cashMovements: n(schema.cashMovements),
    reservations: n(schema.reservations),
    customers: n(schema.customers),
    platformOrders: n(schema.platformOrders),
    fiscalReceipts: n(schema.fiscalReceipts),
    audit: n(schema.auditLog),
  };
}

export type DenemeCounts = ReturnType<typeof countRows>;

function samplePinUsers(t: Tx | DB) {
  return t
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, pinHash: schema.users.pinHash })
    .from(schema.users)
    .where(eq(schema.users.active, true))
    .all()
    .filter((u) => isSamplePinHash(u.pinHash));
}

/** Gerçek gün: deneme modu dışında kapanmış (lafmaliyet'e gidebilen) gün. Varsa deneme verisi silinmez */
function realDayCount(t: Tx | DB) {
  return t.select({ n: sql<number>`count(*)` }).from(schema.businessDays).where(eq(schema.businessDays.trainingDay, false)).get()?.n ?? 0;
}

interface DayRow {
  id: string;
  date: string;
  trainingDay: boolean | null;
}

function closedDays(t: Tx | DB): DayRow[] {
  return t
    .select({ id: schema.businessDays.id, date: schema.businessDays.date, trainingDay: schema.businessDays.trainingDay })
    .from(schema.businessDays)
    .where(isNotNull(schema.businessDays.closedAt))
    .all();
}

/**
 * Geçişi tamamlarken silinecek günler. Deneme günü: eğitimde kapanmış (`trainingDay` true) ya da işaret tutulmadan
 * önce kapanmış (null: LafPOS o zaman canlıda değildi); ikisi de lafmaliyet'e hiç gitmez. Gerçek görünen günler
 * (`trainingDay` false) yalnız hepsi bugünden önceyse ve gerçek kullanım hiç başlamadıysa silinebilir: patron PIN'i
 * değişince deneme sessizce kapanıp sonraki deneme günleri "gerçek" kaydedilmişti (Marina, Kasım 2026)
 */
function finalizeDays(t: Tx | DB, now = Date.now()) {
  const days = closedDays(t);
  const trial = days.filter((d) => d.trainingDay !== false);
  const real = days.filter((d) => d.trainingDay === false);
  const today = businessDate(now);
  const earlyReal = getSettings().liveSince == null && real.length > 0 && real.every((d) => d.date < today) ? real : null;
  return { trial, earlyReal };
}

function rangeOf(days: DayRow[]): DayRangeDTO {
  const dates = days.map((d) => d.date).sort();
  return { days: days.length, from: dates[0] ?? null, to: dates.at(-1) ?? null };
}

export function denemeStatus(user: AuthUser): DenemeStatusDTO {
  const s = getSettings();
  const fd = finalizeDays(db);
  const sample = samplePinUsers(db);
  const me = db.select({ pinHash: schema.users.pinHash }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  return {
    deneme: trainingMode(s),
    liveSince: s.liveSince,
    dayOpen: !!getOpenDay(db),
    realDays: realDayCount(db),
    finalizeOnly: s.liveSince == null && realDayCount(db) > 0,
    trialDays: rangeOf(fd.trial),
    earlyRealDays: fd.earlyReal ? rangeOf(fd.earlyReal) : null,
    counts: countRows(db),
    samplePinUsers: sample.filter((u) => u.id !== user.id).map((u) => ({ id: u.id, name: u.name, role: u.role })),
    mustChangeOwnPin: !!me && isSamplePinHash(me.pinHash),
    okcProvider: s.okcProvider,
  };
}

export interface FinishInput {
  /** Patronun yeni PIN'i: kendi PIN'i hâlâ örnek PIN'se zorunlu */
  newPin?: string;
  /**
   * Geçişi tamamlarken bugünden önceki gerçek görünen günler de denemeydi: onlar da silinir. Yalnız bütün gerçek günler
   * bugünden önceyse ve gerçek kullanım hiç başlamadıysa geçerli
   */
  purgeReal?: boolean;
}

/**
 * Ön koşullar: yalnız patron, açık gün yok. Silmeden önce ve işlemin içinde yeniden denetlenir. Gerçek gün varsa
 * (`finalize`) hiçbir kayıt silinmez: geçiş yarım kalmış demektir (eski sürümde patron PIN'i değişince deneme sessizce
 * kapanıyor, sonraki gün gerçek kaydediliyordu); yalnız başlangıç yazılır ve örnek PIN'li hesaplar kapanır
 */
function assertCanFinish(t: Tx | DB, user: AuthUser): { finalize: boolean } {
  if (user.role !== 'patron') throw new HttpError(403, 'Denemeyi yalnız patron bitirir', 'patron_only');
  if (getOpenDay(t)) throw conflict('Açık bir gün var: önce Kasa’dan gün sonunu alın, sonra denemeyi bitirin', 'day_open');
  return { finalize: realDayCount(t) > 0 };
}

export function checkFinish(user: AuthUser, input: FinishInput) {
  if (getSettings().liveSince != null) return { already: true as const };
  assertCanFinish(db, user);
  const me = db.select({ pinHash: schema.users.pinHash }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  const needPin = !!me && isSamplePinHash(me.pinHash);
  if (needPin && !input.newPin) throw new HttpError(422, 'PIN’iniz hâlâ örnek PIN: gerçek kullanım için yeni PIN’inizi yazın', 'new_pin_required');
  if (input.newPin) {
    if (!/^\d{4,6}$/.test(input.newPin)) throw new HttpError(422, 'Yeni PIN 4-6 haneli rakam olmalı', 'pin_invalid');
    if (isSamplePin(input.newPin)) throw new HttpError(422, 'Bu PIN deneme döneminin örnek PIN’i, herkes biliyor: başka bir PIN seçin', 'pin_sample');
    const other = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.pinHash, hashPin(input.newPin))).get();
    if (other && other.id !== user.id) throw new HttpError(422, 'Bu PIN kullanılamaz: başka bir PIN seçin', 'pin_taken');
  }
  if (input.purgeReal && !finalizeDays(db).earlyReal) throw purgeNotAllowed();
  return { already: false as const };
}

const purgeNotAllowed = () =>
  new HttpError(422, 'Gerçek günler silinemez: bugün ya da sonrası kaydedilmiş gün var. Yalnız deneme günleri silinebilir', 'purge_not_allowed');

export interface FinishResult {
  already: boolean;
  /** Yarım kalmış geçiş tamamlandı: deneme günleri (ve seçildiyse bugünden önceki gerçek görünen günler) silindi */
  finalized?: boolean;
  /** Geçişi tamamlarken silinenler */
  purged?: PurgeCounts;
  backup: string | null;
  deleted: DenemeCounts | null;
  closedUsers: string[];
}

/**
 * Silme ve kapatma (tek işlem). Yedek çağıran tarafından önce alınmış olmalı (`backup`); yedek alınamadıysa buraya
 * gelinmez.
 */
export function finishDeneme(user: AuthUser, input: FinishInput, backup: string): FinishResult {
  const fx = new Effects();
  const result = tx((t): FinishResult => {
    // Yedek alınırken başka bir istek bitirmiş olabilir
    if (getSettings().liveSince != null) return { already: true, backup: null, deleted: null, closedUsers: [] };
    const { finalize } = assertCanFinish(t, user);
    if (finalize) return finalizeLive(t, user, input, backup, fx);
    const deleted = countRows(t);

    // Hareketler: önce bağlı kayıtlar, sonra adisyon ve gün (yabancı anahtar sırası)
    t.delete(schema.fiscalReceipts).run();
    t.delete(schema.platformOrders).run();
    t.delete(schema.roomSessions).run();
    t.delete(schema.payments).run();
    t.delete(schema.orderItems).run();
    t.delete(schema.customerLedger).run();
    t.delete(schema.reservations).run();
    t.delete(schema.orders).run();
    t.delete(schema.customerAddresses).run();
    t.delete(schema.customers).run();
    t.delete(schema.cashMovements).run();
    t.delete(schema.shiftCounts).run();
    t.delete(schema.businessDays).run();
    t.delete(schema.auditLog).run();
    // lafmaliyet'e bekleyen (eğitim) kayıtlar; siteye giden kurulum yazımları (masa kodları, Tükendi) kalır
    t.delete(schema.outbox).where(eq(schema.outbox.target, 'lafmaliyet')).run();
    // Deneme döneminin cihaz ve gönderim durumu: simülatörün fiş sayacı, Pavo gün sonları, lafmaliyet gönderim özeti
    t.delete(schema.syncState)
      .where(or(like(schema.syncState.key, 'okc.%'), like(schema.syncState.key, 'pavo.eod.%'), eq(schema.syncState.key, 'lafmaliyet.push')))
      .run();
    // Porsiyon sayaçları günlüktür; denemede biten ürün yeniden satışa açılmaz (Tükendi kurulumdur, el değmez)

    // PIN'ler: patronun yeni PIN'i; örnek PIN'iyle kalan öbür hesaplar kapanır (Personel'den yeni PIN'le açılır)
    if (input.newPin) {
      t.update(schema.users).set({ pinHash: hashPin(input.newPin) }).where(eq(schema.users.id, user.id)).run();
    }
    const others = samplePinUsers(t).filter((u) => u.id !== user.id);
    if (others.length) {
      const ids = others.map((u) => u.id);
      t.update(schema.users).set({ active: false }).where(inArray(schema.users.id, ids)).run();
      t.delete(schema.sessions).where(inArray(schema.sessions.userId, ids)).run();
    }

    // Ayarlar: deneme kapanır, eğitim yazarkasası kapalıya döner (patron Pavo'yu Yazarkasa POS'tan seçer); paket
    // platformlarının Deneme modu kapanır (deneme siparişi yalnız deneme modunda açılır)
    const s = getSettings();
    const platforms = Object.fromEntries(Object.entries(s.platforms).map(([id, p]) => [id, p.mode === 'deneme' ? { ...p, mode: 'kapali' as const } : p])) as typeof s.platforms;
    updateSettings({ demoMode: false, liveSince: Date.now(), platforms, ...(s.okcProvider === 'simulator' ? { okcProvider: 'kapali' as const } : {}) }, t);

    const closedUsers = others.map((u) => u.name);
    fx.audit(t, {
      userId: user.id,
      action: 'deneme.bitir',
      severity: 'uyari',
      message: `${user.name} denemeyi bitirdi, gerçek kullanım başladı: ${deleted.orders} deneme adisyonu, ${deleted.days} gün, ${deleted.payments} ödeme silindi; yedek ${backup}${closedUsers.length ? `. Örnek PIN'iyle kalan hesaplar kapatıldı: ${closedUsers.join(', ')}` : ''}`,
      data: { deleted, backup, closedUsers, okcProvider: s.okcProvider === 'simulator' ? 'kapali' : s.okcProvider },
    });
    return { already: false, backup, deleted, closedUsers };
  });
  if (!result.already) {
    for (const topic of ['orders', 'tables', 'kitchen', 'cash', 'settings', 'users', 'reservations', 'customers', 'delivery', 'okc', 'sync'] as const) fx.emit({ topic, kind: 'deneme.bitti', byUserId: user.id });
  }
  fx.flush();
  return result;
}

/** Geçişi tamamlarken silinen kayıtlar (denetim kaydı ve pencere) */
export interface PurgeCounts {
  days: number;
  /** Silinen günlerin tarih aralığı */
  from: string | null;
  to: string | null;
  /** Silinen gerçek görünen gün sayısı (seçenek işaretliyse) */
  realDays: number;
  orders: number;
  items: number;
  payments: number;
  cashMovements: number;
  shiftCounts: number;
  fiscalReceipts: number;
  platformOrders: number;
  roomSessions: number;
  customerLedger: number;
  outbox: number;
}

/**
 * Verilen günlerin bütün hareketleri, deneme silmesindeki sırayla (yabancı anahtar sırası): fiş, platform siparişi,
 * oda, ödeme, kalem, açık hesap satırı, adisyon, kasa hareketi, vardiya sayımı, gün. Açık hesap satırı silinince
 * müşterinin bakiyesi o kadar geri alınır. O günlerin lafmaliyet giden kutusu kayıtları (`gun:<tarih>`) da silinir;
 * kalan bir günle aynı tarihi taşıyan kayda dokunulmaz. Başka güne bağlı hiçbir kayda dokunulmaz
 */
function purgeDays(t: Tx, days: DayRow[], realDays: number): PurgeCounts {
  const range = rangeOf(days);
  const zero: PurgeCounts = { ...range, realDays, orders: 0, items: 0, payments: 0, cashMovements: 0, shiftCounts: 0, fiscalReceipts: 0, platformOrders: 0, roomSessions: 0, customerLedger: 0, outbox: 0 };
  if (!days.length) return zero;
  const dayIds = days.map((d) => d.id);
  const O = schema.orders;
  // Alt sorgular: çok adisyonda SQLite değişken sınırına takılmaz
  const orderIds = t.select({ id: O.id }).from(O).where(inArray(O.dayId, dayIds));
  const paymentIds = t
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(or(inArray(schema.payments.dayId, dayIds), inArray(schema.payments.orderId, orderIds)));
  const L = schema.customerLedger;
  const ledgerWhere = or(inArray(L.dayId, dayIds), inArray(L.orderId, orderIds), inArray(L.paymentId, paymentIds));

  // Müşteri bakiyesi açık hesap satırlarının toplamıdır: silinen satırlar bakiyeden düşülür
  const ledger = t.select({ customerId: L.customerId, amount: L.amount }).from(L).where(ledgerWhere).all();
  const byCustomer = new Map<string, number>();
  for (const r of ledger) byCustomer.set(r.customerId, (byCustomer.get(r.customerId) ?? 0) + r.amount);
  for (const [id, amount] of byCustomer) {
    if (amount !== 0) t.update(schema.customers).set({ balance: sql`${schema.customers.balance} - ${amount}` }).where(eq(schema.customers.id, id)).run();
  }

  const c = { ...zero };
  c.fiscalReceipts = t.delete(schema.fiscalReceipts).where(inArray(schema.fiscalReceipts.orderId, orderIds)).run().changes;
  c.platformOrders = t.delete(schema.platformOrders).where(inArray(schema.platformOrders.orderId, orderIds)).run().changes;
  c.roomSessions = t.delete(schema.roomSessions).where(inArray(schema.roomSessions.orderId, orderIds)).run().changes;
  c.customerLedger = t.delete(L).where(ledgerWhere).run().changes;
  c.payments = t.delete(schema.payments).where(inArray(schema.payments.id, paymentIds)).run().changes;
  c.items = t.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds)).run().changes;
  c.orders = t.delete(O).where(inArray(O.dayId, dayIds)).run().changes;
  c.cashMovements = t.delete(schema.cashMovements).where(inArray(schema.cashMovements.dayId, dayIds)).run().changes;
  c.shiftCounts = t.delete(schema.shiftCounts).where(inArray(schema.shiftCounts.dayId, dayIds)).run().changes;
  t.delete(schema.businessDays).where(inArray(schema.businessDays.id, dayIds)).run();

  const kept = new Set(closedDays(t).map((d) => d.date));
  const keys = [...new Set(days.map((d) => d.date))].filter((date) => !kept.has(date)).map((date) => `gun:${date}`);
  if (keys.length) c.outbox = t.delete(schema.outbox).where(and(eq(schema.outbox.target, 'lafmaliyet'), inArray(schema.outbox.dedupeKey, keys))).run().changes;
  return c;
}

const dateTr = (d: string | null) => (d ? d.split('-').reverse().join('.') : '');

/**
 * Yarım kalmış geçişin tamamlanması (deneme kapanmış, gerçek gün var, `liveSince` yok). Deneme günleri ve bütün
 * hareketleri silinir; `purgeReal` işaretliyse bugünden önceki gerçek görünen günler de (o günler lafmaliyet'e hiç
 * gitmez). Gerçek kalan günlere ve onlara bağlı kayıtlara dokunulmaz. Patronun yeni PIN'i, örnek PIN'iyle kalan öbür
 * hesapların kapanması, `liveSince` ve denetim kaydı; deneme ayarları (eğitim yazarkasası, platformların Deneme modu)
 * gerçeğe döner. Yedek çağıran tarafından önce alınmıştır
 */
function finalizeLive(t: Tx, user: AuthUser, input: FinishInput, backup: string, fx: Effects): FinishResult {
  const fd = finalizeDays(t);
  if (input.purgeReal && !fd.earlyReal) throw purgeNotAllowed();
  const realGone = input.purgeReal && fd.earlyReal ? fd.earlyReal : [];
  const purged = purgeDays(t, [...fd.trial, ...realGone], realGone.length);
  if (input.newPin) t.update(schema.users).set({ pinHash: hashPin(input.newPin) }).where(eq(schema.users.id, user.id)).run();
  const others = samplePinUsers(t).filter((u) => u.id !== user.id);
  if (others.length) {
    const ids = others.map((u) => u.id);
    t.update(schema.users).set({ active: false }).where(inArray(schema.users.id, ids)).run();
    t.delete(schema.sessions).where(inArray(schema.sessions.userId, ids)).run();
  }
  const s = getSettings();
  const platforms = Object.fromEntries(Object.entries(s.platforms).map(([id, p]) => [id, p.mode === 'deneme' ? { ...p, mode: 'kapali' as const } : p])) as typeof s.platforms;
  updateSettings({ demoMode: false, liveSince: Date.now(), platforms, ...(s.okcProvider === 'simulator' ? { okcProvider: 'kapali' as const } : {}) }, t);
  const closedUsers = others.map((u) => u.name);
  const days = realDayCount(t);
  const what = purged.days
    ? `${purged.days} gün silindi (${dateTr(purged.from)}–${dateTr(purged.to)}${purged.realDays ? `; ${purged.realDays} tanesi gerçek görünen ama deneme olan gün` : ''}): ${purged.orders} adisyon, ${purged.payments} ödeme, ${purged.cashMovements} kasa hareketi`
    : 'silinecek deneme günü yoktu, hiçbir kayıt silinmedi';
  fx.audit(t, {
    userId: user.id,
    action: 'deneme.bitir',
    severity: 'uyari',
    message: `${user.name} gerçek kullanıma geçişi tamamladı: ${what}; ${days} gerçek gün kaldı, yedek ${backup}${closedUsers.length ? `. Örnek PIN'iyle kalan hesaplar kapatıldı: ${closedUsers.join(', ')}` : ''}`,
    data: { finalize: true, purged, realDaysLeft: days, backup, closedUsers },
  });
  return { already: false, finalized: true, purged, backup, deleted: null, closedUsers };
}
