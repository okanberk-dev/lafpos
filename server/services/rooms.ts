import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { type BlockTerms, blockTerms, bookingCode, bookingHours, linkableBooking, type RoomBookingSnapshot, snapshotOf } from '@shared/karaoke';
import { tl } from '@shared/money';
import { businessDate } from '@shared/time';
import { schema, type Tx } from '../db/client';
import { type Actor, needDirect } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, notFound } from '../lib/http';
import { ulid } from '../lib/ids';
import { getSettings } from '../lib/settings';
import { posNameFor } from './menu';
import { findSiteBooking, siteBookingsToday, siteKaraokeOn } from '../sync/laffogato-karaoke';
import { activeRoom, assertNoPendingDevice, assertPosOrder, loadOrder, recalc, requireCurrentDay } from './orders';

/**
 * Karaoke odası gibi süreli alanlar: sayaç başlar, durunca süre faturalama adımına yukarı yuvarlanır
 * (en az "minimum dakika"), saatlik ücretle adisyona HİZMET satırı (KDV %20) olarak eklenir.
 */
export function billableMinutes(elapsedMs: number, stepMin: number, minimumMin: number): number {
  const minutes = Math.max(0, Math.ceil(elapsedMs / 60_000));
  const stepped = Math.ceil(minutes / Math.max(1, stepMin)) * Math.max(1, stepMin);
  return Math.max(minimumMin, stepped);
}

export function roomCharge(hourlyRate: number, minutes: number): number {
  return Math.round((hourlyRate * minutes) / 60);
}

/**
 * Sayaca bağlı site rezervasyonunun bu oturumdaki bloğu (docs/03-ENTEGRASYON.md §2.4): `paid` sitede ödendi, kasada
 * ücretsiz; `till` köşkte ödenecek, blok rezervasyonun tutarıyla (`charge`; ücretsiz telafi saatinde 0). `minutes`:
 * bloğun bu oturuma düşen kalanı.
 */
export interface RoomBlock {
  terms: Exclude<BlockTerms, null>;
  minutes: number;
  charge: number;
}

export interface RoomBill {
  /** Ücretlenen ve blokta kalan dakikalar toplamı (satır metni) */
  minutes: number;
  /** Bloğun karşıladığı dakika */
  coveredMinutes: number;
  /** Saat ücretiyle ücretlenen dakika */
  overMinutes: number;
  blockCharge: number;
  charge: number;
}

/**
 * Oda ücreti. Bağlı blok yoksa bugünkü kural: süre faturalama adımına yukarı yuvarlanır, en az "minimum dakika".
 * Blok varsa blok kendi koşuluyla ödenir ve yalnız bloğu aşan süre adıma yuvarlanıp saat ücretiyle eklenir (minimum
 * yok: oda zaten blok kadar kullanıldı). Blok süreyle ölçülür, saatle değil: geç gelen grup bloğunu yine tam kullanır.
 */
export function roomBill(elapsedMs: number, hourlyRate: number, stepMin: number, minimumMin: number, block: RoomBlock | null): RoomBill {
  if (!block) {
    const minutes = billableMinutes(elapsedMs, stepMin, minimumMin);
    return { minutes, coveredMinutes: 0, overMinutes: minutes, blockCharge: 0, charge: roomCharge(hourlyRate, minutes) };
  }
  // Aşan süre bugünkü kuralla dakikaya yukarı, sonra adıma; bloğun karşıladığı süre en yakın dakika (sayaç yeniden
  // başlarsa kalan blok buradan hesaplanır)
  const blockMinutes = Math.max(0, block.minutes);
  const elapsed = Math.max(0, Math.ceil(elapsedMs / 60_000));
  const covered = Math.min(blockMinutes, Math.max(0, Math.round(elapsedMs / 60_000)));
  const step = Math.max(1, stepMin);
  const over = elapsed > blockMinutes ? Math.ceil((elapsed - blockMinutes) / step) * step : 0;
  const blockCharge = block.terms === 'till' ? block.charge : 0;
  return { minutes: covered + over, coveredMinutes: covered, overMinutes: over, blockCharge, charge: blockCharge + roomCharge(hourlyRate, over) };
}

const fmtMinutes = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h} sa ` : ''}${m ? `${m} dk` : ''}`.trim() || '0 dk';
};

type SessionRow = typeof schema.roomSessions.$inferSelect;

/** Aynı rezervasyona bağlı, durmuş önceki oturumlar (sayaç durdurulup yeniden başlatıldıysa) */
function earlierSessions(t: Tx, bookingId: string, exceptId?: string): SessionRow[] {
  return t
    .select()
    .from(schema.roomSessions)
    .where(and(eq(schema.roomSessions.bookingId, bookingId), isNotNull(schema.roomSessions.endedAt), exceptId ? ne(schema.roomSessions.id, exceptId) : undefined))
    .all();
}

/**
 * Bağlı oturumun bloğu, sayaç durduğu andaki rezervasyona göre: okunan son listede varsa onun durumu (ödemesi
 * bağlanırken süren rezervasyon bu arada ödenmiş olabilir; iptal edilen blok düşer). Listede yoksa: liste onun gününe
 * aitse rezervasyon o günden çıkmıştır (panel başka güne taşıdı; blok o güne aittir, burada sayılmaz), değilse (iş
 * günü döndü, site ulaşılamadı) bağlanırken saklanan koşul geçer. Önceki oturumların karşıladığı dakika bloktan
 * düşülür; köşkte ödenen blok tutarı bir kez yazılır (blok koşuluyla duran ilk oturumda).
 */
function blockOf(t: Tx, session: SessionRow): { block: RoomBlock | null; booking: RoomBookingSnapshot | null; gone: boolean } {
  if (!session.bookingId) return { block: null, booking: null, gone: false };
  const saved = session.booking ?? null;
  const found = findSiteBooking(session.bookingId, saved?.date ?? '');
  if (found.gone) return { block: null, booking: saved, gone: true };
  const booking = found.booking ? snapshotOf(found.booking) : saved;
  const terms = blockTerms(booking);
  if (!booking || !terms) return { block: null, booking, gone: false };
  const earlier = earlierSessions(t, session.bookingId, session.id);
  const used = earlier.reduce((a, x) => a + (x.prepaidMinutes ?? 0), 0);
  const tillCharged = earlier.some((x) => blockTerms(x.booking) === 'till');
  return { block: { terms, minutes: Math.max(0, booking.hours * 60 - used), charge: terms === 'till' && !tillCharged ? booking.totalMinor : 0 }, booking, gone: false };
}

/**
 * Oda sayacını başlatır. `bookingId` verilirse sayaç sitedeki o karaoke rezervasyonuna bağlanır (oda kutusunun
 * önerdiği): rezervasyon okunan bugünkü listede, odayı tutuyor ve ödemesi sitede alınmış, köşkte alınacak ya da sürüyor
 * olmalı; aynı rezervasyon aynı anda iki sayaca bağlanmaz.
 */
export function startRoom(t: Tx, actor: Actor, fx: Effects, orderId: string, opts: { bookingId?: string | null } = {}) {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik') throw conflict('Adisyon kapalı');
  // Sitede ödenmiş siparişe oda ücreti yazılmaz: tahsil edilemez (kural 7)
  assertPosOrder(o);
  if (!o.tableId) throw bad('Oda sayacı yalnız oda/masa adisyonunda çalışır');
  const table = t.select().from(schema.tables).where(eq(schema.tables.id, o.tableId)).get();
  if (!table || table.kind !== 'oda' || !table.hourlyRate) throw bad('Bu masa saatlik oda değil');
  // Sepet cihazda beklerken sayaç başlamaz: cihaz ödemesi adisyonu kapatır, oda ücreti kapanmış adisyona yazılamazdı
  assertNoPendingDevice(t, orderId);
  if (activeRoom(t, orderId)) throw conflict('Oda sayacı zaten çalışıyor', 'room_running');
  // Bir odada aynı anda tek sayaç: odanın başka hesabında ("Yeni hesap", aynı odada ayrı hesaba taşıma) sayaç
  // çalışırken ikincisi başlarsa oda iki kez faturalanır (inceleme, 27 Eki 2026). Kapanmış adisyonda kalmış eski sayaç
  // odayı tutmaz: ücret yazılamaz, durdurulamaz
  const holder = t
    .select({ no: schema.orders.no })
    .from(schema.roomSessions)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.roomSessions.orderId))
    .where(and(eq(schema.roomSessions.tableId, table.id), isNull(schema.roomSessions.endedAt), eq(schema.orders.status, 'acik')))
    .get();
  if (holder) throw conflict(`${table.name} sayacı #${holder.no} adisyonda çalışıyor; oda ücreti o hesaba yazılır`, 'room_running');
  requireCurrentDay(t);
  const link = opts.bookingId ? bookingToLink(t, opts.bookingId) : null;
  t.insert(schema.roomSessions)
    .values({
      id: ulid(),
      orderId,
      tableId: table.id,
      hourlyRate: table.hourlyRate,
      startedAt: Date.now(),
      startedBy: actor.user.id,
      bookingId: link?.booking.id ?? null,
      booking: link?.booking ?? null,
      prepaidMinutes: link ? link.remaining : null,
    })
    .run();
  const linked = link ? ` · site rezervasyonu ${bookingCode(link.booking.id)} (${bookingHours(link.booking)}, ${link.label})` : '';
  fx.audit(t, { userId: actor.user.id, action: 'room.start', orderId, message: `${table.name} sayacı başladı (saatlik ${tl(table.hourlyRate)})${linked}` });
  fx.emit({ topic: 'orders', kind: 'room.started', orderId, tableId: table.id, byUserId: actor.user.id });
  fx.emit({ topic: 'tables', kind: 'room.started', tableId: table.id, byUserId: actor.user.id });
}

/** Sayaca bağlanacak rezervasyon: okunan bugünkü listede, odayı tutuyor, başka çalışan sayaca bağlı değil */
function bookingToLink(t: Tx, bookingId: string): { booking: RoomBookingSnapshot; remaining: number; label: string } {
  if (!siteKaraokeOn()) throw conflict('Sitedeki karaoke rezervasyonları okunmuyor (site bağlantısı kurulmadı)', 'not_configured');
  const b = siteBookingsToday().find((x) => x.id === bookingId);
  if (!b || b.date !== businessDate(Date.now())) throw conflict('Rezervasyon sitenin bugünkü listesinde yok; listeyi yenileyip yeniden seçin', 'booking_not_found');
  if (!linkableBooking(b)) throw conflict(`${bookingCode(b.id)} odayı tutmuyor (iptal, iade ya da süresi dolmuş); sayaç rezervasyonsuz başlatılabilir`, 'booking_not_linkable');
  const running = t
    .select({ no: schema.orders.no })
    .from(schema.roomSessions)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.roomSessions.orderId))
    .where(and(eq(schema.roomSessions.bookingId, b.id), isNull(schema.roomSessions.endedAt)))
    .get();
  if (running) throw conflict(`${bookingCode(b.id)} #${running.no} adisyonda sayaca bağlı`, 'booking_running');
  const used = earlierSessions(t, b.id).reduce((a, x) => a + (x.prepaidMinutes ?? 0), 0);
  const terms = blockTerms(b);
  const label = terms === 'paid' ? 'sitede ödendi' : terms === 'till' ? (b.totalMinor ? `köşkte ödenecek ${tl(b.totalMinor)}` : 'ücretsiz telafi') : 'ödemesi sürüyor';
  return { booking: snapshotOf(b), remaining: Math.max(0, b.hours * 60 - used), label };
}

export function stopRoom(t: Tx, actor: Actor, fx: Effects, orderId: string) {
  needDirect(actor, 'siparis.al');
  const o = loadOrder(t, orderId);
  if (o.status !== 'acik') throw conflict('Adisyon kapalı; oda ücretini yazmak için önce adisyonu yeniden açın', 'order_closed');
  assertPosOrder(o);
  const session = activeRoom(t, orderId);
  if (!session) throw notFound('Çalışan oda sayacı');
  // Oda ücreti ürünü: POS'ta gizli hizmet ürünü ("Karaoke odası"); kişi başı karaoke gibi görünür hizmetler değil
  const services = t.select().from(schema.products).where(and(eq(schema.products.isService, true), eq(schema.products.active, true))).all();
  const product = services.find((p) => p.posName === 'KARAOKE ODASI') ?? services.find((p) => p.hidden) ?? services[0];
  if (!product) throw conflict('Saatlik oda ürünü tanımlı değil (Yönetim › Menü, gizli "hizmet" ürünü)');
  const s = getSettings();
  const now = Date.now();
  const { block, booking, gone } = blockOf(t, session);
  const bill = roomBill(now - session.startedAt, session.hourlyRate, s.roomBillingStepMinutes, s.roomMinimumMinutes, block);
  const charge = bill.charge;
  const code = booking ? bookingCode(booking.id) : null;
  // Satır metni: süre ve bağlı bloğun koşulu; satır notunda rezervasyon kodu
  const text = !block
    ? fmtMinutes(bill.minutes)
    : block.terms === 'paid'
      ? `${bill.overMinutes ? `aşan ${fmtMinutes(bill.overMinutes)}` : 'aşım yok'} (${booking!.hours} sa sitede ödendi)`
      : `${booking!.hours} sa rezervasyon${bill.overMinutes ? ` + ${fmtMinutes(bill.overMinutes)}` : ''}`;
  // Oturum, ücretin dayandığı rezervasyon durumunu saklar: sayaç yeniden başlarsa kalan blok ve köşkte ödenen blok
  // tutarının alınıp alınmadığı buradan okunur
  const finish = (itemId: string | null) =>
    t.update(schema.roomSessions)
      .set({ endedAt: now, itemId, booking: booking ?? session.booking, prepaidMinutes: block ? bill.coveredMinutes : session.bookingId ? 0 : null })
      .where(eq(schema.roomSessions.id, session.id))
      .run();
  const ended = Math.max(0, Math.ceil((now - session.startedAt) / 60_000));
  const why = !code
    ? null
    : block
      ? `rezervasyon ${code} ${block.terms === 'paid' ? 'sitede ödendi' : 'köşkte'}`
      : `rezervasyon ${code} blok sayılmadı (${gone ? 'sitenin bugünkü listesinde yok' : 'iptal ya da ödenmemiş'})`;
  if (charge <= 0) {
    // Süre sitede ödenen (ya da ücretsiz telafi) blokta kaldı: adisyona 0 TL satır yazılmaz
    finish(null);
    fx.audit(t, { userId: actor.user.id, action: 'room.stop', orderId, amount: 0, message: `Oda sayacı durdu: ${fmtMinutes(ended)}, ${why ?? 'ücret yok'}; kasada ücret yok (#${o.no})` });
    fx.emit({ topic: 'orders', kind: 'room.stopped', orderId, tableId: session.tableId, byUserId: actor.user.id });
    fx.emit({ topic: 'tables', kind: 'room.stopped', tableId: session.tableId, byUserId: actor.user.id });
    if (code) fx.emit({ topic: 'reservations', kind: 'room.stopped' });
    return;
  }
  const itemId = ulid(now);
  t.insert(schema.orderItems)
    .values({
      id: itemId,
      orderId,
      productId: product.id,
      name: product.shortName?.trim() || product.name,
      size: 'TEK',
      options: [],
      optionsText: text,
      note: code ? `Site rezervasyonu ${code}` : null,
      qty: 1,
      unitPrice: charge,
      basePrice: charge,
      kdvRate: product.kdvRate,
      status: 'servis',
      batch: 0,
      sentAt: now,
      servedAt: now,
      isService: true,
      // Boş ya da boşluklu posName de lafmaliyet'in okuyacağı bir ada döner (yönetimde boş bırakılan oda ürünü)
      posName: posNameFor(product, 'TEK'),
      createdBy: actor.user.id,
      createdAt: now,
    })
    .run();
  finish(itemId);
  recalc(t, orderId);
  fx.audit(t, { userId: actor.user.id, action: 'room.stop', orderId, amount: charge, message: `Oda sayacı durdu: ${bill.minutes} dk, ${tl(charge)} adisyona eklendi${why ? ` (${why})` : ''} (#${o.no})` });
  fx.emit({ topic: 'orders', kind: 'room.stopped', orderId, tableId: session.tableId, byUserId: actor.user.id });
  fx.emit({ topic: 'tables', kind: 'room.stopped', tableId: session.tableId, byUserId: actor.user.id });
  if (code) fx.emit({ topic: 'reservations', kind: 'room.stopped' });
}
