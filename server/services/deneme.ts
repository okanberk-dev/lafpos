import { eq, inArray, like, or, sql } from 'drizzle-orm';
import type { DenemeStatusDTO } from '@shared/types';
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

export function denemeStatus(user: AuthUser): DenemeStatusDTO {
  const s = getSettings();
  const sample = samplePinUsers(db);
  const me = db.select({ pinHash: schema.users.pinHash }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  return {
    deneme: trainingMode(s),
    liveSince: s.liveSince,
    dayOpen: !!getOpenDay(db),
    realDays: realDayCount(db),
    counts: countRows(db),
    samplePinUsers: sample.filter((u) => u.id !== user.id).map((u) => ({ id: u.id, name: u.name, role: u.role })),
    mustChangeOwnPin: !!me && isSamplePinHash(me.pinHash),
    okcProvider: s.okcProvider,
  };
}

export interface FinishInput {
  /** Patronun yeni PIN'i: kendi PIN'i hâlâ örnek PIN'se zorunlu */
  newPin?: string;
}

/** Ön koşullar: yalnız patron, açık gün yok, gerçek gün yok. Silmeden önce ve işlemin içinde yeniden denetlenir */
function assertCanFinish(t: Tx | DB, user: AuthUser) {
  if (user.role !== 'patron') throw new HttpError(403, 'Denemeyi yalnız patron bitirir', 'patron_only');
  if (getOpenDay(t)) throw conflict('Açık bir gün var: önce Kasa’dan gün sonunu alın, sonra denemeyi bitirin', 'day_open');
  if (realDayCount(t) > 0) throw conflict('Deneme modu dışında kapanmış (gerçek) gün var; kayıtlar silinmez', 'real_days');
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
  return { already: false as const };
}

export interface FinishResult {
  already: boolean;
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
    assertCanFinish(t, user);
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
