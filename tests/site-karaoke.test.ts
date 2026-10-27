import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockTerms, bookingsAtHand, linkableBooking, linkChoices, type SiteKaraokeBooking } from '@shared/karaoke';
import type { BootstrapDTO, FloorStateDTO, OrderDTO, SiteKaraokeDTO } from '@shared/types';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Karaoke (L4, laffogato F1 #264): kasa sitedeki bugünkü rezervasyonları okur, oda sayacı bir rezervasyona bağlanır,
 * sitede ödenmiş blok kasada yeniden ücretlenmez. Site yanıtları laffogato'nun `toPanelReservation` çıktısından
 * (tests/fixtures/site-panel-karaoke.json): krk-00041 ücretsiz telafi (1 sa), krk-00042 köşkte ödenecek (1 sa,
 * 765 ₺), krk-00043 iptal, krk-00044 sitede ödendi (2 sa), krk-00045 ödemesi sürüyor (1 sa). Kasanın oda ücreti
 * 1.000 ₺/saat, faturalama adımı 15 dk, en az 60 dk (kurulum verisi).
 */
const SECRET = 'r'.repeat(48);
const HOUR = 100000;
let h: Harness;
let site: FakeSite;
let boot: BootstrapDTO;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

const karaokePulls = () => site.count('GET /api/panel/karaoke');

async function karaokeModule() {
  const k = await import('../server/sync/laffogato-karaoke');
  return k;
}

/** Her test kendi odasını açar (tek odada aynı anda tek sayaç) */
let roomNo = 0;
async function roomOrder(): Promise<OrderDTO> {
  const { db, schema } = await import('../server/db/client');
  const { ulid } = await import('../server/lib/ids');
  const like = boot.tables.find((t) => t.kind === 'oda')!;
  const id = ulid();
  db.insert(schema.tables).values({ id, sectionId: like.sectionId, name: `Oda K${++roomNo}`, kind: 'oda', hourlyRate: HOUR }).run();
  return h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: id });
}

/**
 * Çalışan sayacın başlangıcını geri alır: "şimdi" durunca bu kadar dakika geçmiş olur (bir saniye eksik: süre
 * dakikaya yukarı yuvarlandığı için istek süresi bir dakika eklemesin)
 */
async function ranFor(orderId: string, minutes: number) {
  const { db, schema } = await import('../server/db/client');
  const { and, eq, isNull } = await import('drizzle-orm');
  db.update(schema.roomSessions)
    .set({ startedAt: Date.now() - minutes * 60_000 + 1000 })
    .where(and(eq(schema.roomSessions.orderId, orderId), isNull(schema.roomSessions.endedAt)))
    .run();
}

async function sessionsOf(bookingId: string) {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.roomSessions).where(eq(schema.roomSessions.bookingId, bookingId)).all();
}

async function freshList() {
  (await karaokeModule()).resetKaraokeTimer();
  return h.ok<SiteKaraokeDTO>('kasa', 'POST', '/sync/karaoke/refresh');
}

const roomLines = (o: OrderDTO) => o.items.filter((i) => i.name === 'Karaoke odası');

describe('oda ücreti: rezervasyon bloğu (saf kural)', () => {
  it('sitede ödenmiş 2 saat + 2 sa 20 dk oturum: yalnız aşan süre adıma yuvarlanıp ücretlenir', async () => {
    const { roomBill } = await import('../server/services/rooms');
    expect(roomBill(140 * 60_000, HOUR, 15, 60, { terms: 'paid', minutes: 120, charge: 0 })).toEqual({ minutes: 150, coveredMinutes: 120, overMinutes: 30, blockCharge: 0, charge: 50000 });
    // Bloğun içinde kaldı: kasada ücret yok (en az 60 dk kuralı bloğa uygulanmaz)
    expect(roomBill(110 * 60_000, HOUR, 15, 60, { terms: 'paid', minutes: 120, charge: 0 }).charge).toBe(0);
  });

  it('köşkte ödenecek blok satırın tutarıyla, aşan süre saat ücretiyle; telafi bloğu ücretsiz; bağsız oturum bugünkü gibi', async () => {
    const { roomBill } = await import('../server/services/rooms');
    expect(roomBill(80 * 60_000, HOUR, 15, 60, { terms: 'till', minutes: 60, charge: 76500 }).charge).toBe(76500 + 50000);
    expect(roomBill(50 * 60_000, HOUR, 15, 60, { terms: 'till', minutes: 60, charge: 0 }).charge).toBe(0);
    expect(roomBill(140 * 60_000, HOUR, 15, 60, null)).toMatchObject({ minutes: 150, coveredMinutes: 0, charge: 250000 });
    expect(roomBill(10 * 60_000, HOUR, 15, 60, null).charge).toBe(HOUR);
  });

  it('blok koşulu status ile paymentStatus birlikte okunur (sitenin kuralı)', () => {
    const b = (status: string, paymentStatus: string) => ({ status, paymentStatus }) as Pick<SiteKaraokeBooking, 'status' | 'paymentStatus'>;
    expect(blockTerms(b('confirmed', 'paid'))).toBe('paid');
    expect(blockTerms(b('requested', 'none'))).toBe('till');
    expect(blockTerms(b('cancelled', 'paid'))).toBeNull();
    expect(blockTerms(b('requested', 'pending'))).toBeNull();
    expect(blockTerms(b('confirmed', 'refunding'))).toBeNull();
    expect(blockTerms(b('cancelled', 'expired'))).toBeNull();
    expect(linkableBooking(b('requested', 'pending'))).toBe(true);
    expect(linkableBooking(b('confirmed', 'refunding'))).toBe(false);
    expect(linkableBooking(b('cancelled', 'paid'))).toBe(false);
  });

  it('bilinmeyen durum güvenli tarafa okunur; okunamayan satır listeyi düşürmez', async () => {
    const { parseKaraokeBody, toSiteBooking } = await karaokeModule();
    expect(toSiteBooking({ id: 'krk-1', date: '2026-10-27', startHour: 20, hours: 2, status: 'held', paymentStatus: 'authorized', firstName: 'A'.repeat(60), totalMinor: 100 })).toMatchObject({
      status: 'requested',
      paymentStatus: 'none',
      startsAt: '2026-10-27T17:00:00.000Z',
      endsAt: '2026-10-27T19:00:00.000Z',
      firstName: 'A'.repeat(40),
    });
    expect(toSiteBooking({ id: 'krk-2', date: '2026-10-27', startHour: 23, hours: 2 })).toBeNull();
    const parsed = parseKaraokeBody({ reservations: [{ id: 'x', date: '2026-02-30', startHour: 20, hours: 1 }, { id: 'krk-3', date: '2026-10-27', startHour: 20, hours: 1, status: 'confirmed', paymentStatus: 'paid' }] }, '2026-10-27');
    expect(parsed.bookings.map((x) => x.id)).toEqual(['krk-3']);
    expect(parsed.complete).toBe(false);
    expect(() => parseKaraokeBody({ error: 'maintenance' }, '2026-10-27')).toThrow(/beklenen biçimde/);
  });

  it('"Sayacı başlat" o saate düşeni önerir: bağlanabilir, başlangıcına en çok bir saat kalmış, bitmemiş', () => {
    const at = (startHour: number, paymentStatus = 'paid', status = 'confirmed') =>
      ({ id: `krk-${startHour}`, date: '2026-10-27', startHour, hours: 2, startsAt: new Date(Date.UTC(2026, 9, 27, startHour - 3)).toISOString(), endsAt: new Date(Date.UTC(2026, 9, 27, startHour - 1)).toISOString(), status, paymentStatus }) as SiteKaraokeBooking;
    const now = Date.UTC(2026, 9, 27, 16, 30); // 19:30
    expect(bookingsAtHand([at(14), at(18), at(20), at(22), at(20, 'refunded')], now).map((b) => b.id)).toEqual(['krk-20', 'krk-18']);
  });

  it('seçim penceresi bugünün geri kalanını da gösterir (erken gelen grup); başka sayaçtaki ve bitmiş olan yok', () => {
    const at = (startHour: number, active = false) =>
      ({ id: `krk-${startHour}`, date: '2026-10-27', startHour, hours: 2, startsAt: new Date(Date.UTC(2026, 9, 27, startHour - 3)).toISOString(), endsAt: new Date(Date.UTC(2026, 9, 27, startHour - 1)).toISOString(), status: 'confirmed', paymentStatus: 'paid', session: active ? { active: true } : null }) as SiteKaraokeBooking & { session: { active: boolean } | null };
    const now = Date.UTC(2026, 9, 27, 13, 0); // 16:00
    const { atHand, later } = linkChoices([at(12), at(15), at(16, true), at(22), at(19)], now);
    expect(atHand.map((b) => b.id)).toEqual(['krk-15']);
    expect(later.map((b) => b.id)).toEqual(['krk-19', 'krk-22']);
  });
});

describe('sitedeki rezervasyonların okunması', () => {
  it('liste bugünün penceresiyle okunur; oda kutusu ve masa planı görür, iptal masa planında yok', async () => {
    expect(boot.integrations.siteKaraoke).toBe(true);
    const view = await freshList();
    expect(view.state).toBe('hazir');
    expect(view.bookings.map((b) => [b.id, b.status, b.paymentStatus])).toEqual([
      ['krk-00041', 'confirmed', 'none'],
      ['krk-00042', 'requested', 'none'],
      ['krk-00043', 'cancelled', 'refunded'],
      ['krk-00044', 'confirmed', 'paid'],
      ['krk-00045', 'requested', 'pending'],
    ]);
    // KVKK: yalnız ad; soyad gelmez (sitenin beyaz listesi), yerelde de yazılmaz
    expect(view.bookings.find((b) => b.id === 'krk-00044')).toMatchObject({ firstName: 'Ayşe', guests: 4, startHour: 20, hours: 2, note: 'Doğum günü, pasta getirecekler', session: null });
    const floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.siteKaraoke?.map((b) => b.id)).toEqual(['krk-00041', 'krk-00042', 'krk-00044', 'krk-00045']);
  });

  it('sürüm işareti değişince çeker, değişmeyince çekmez; otomatik çekim en sık 5 dakikada bir; gece hiç', async () => {
    const k = await karaokeModule();
    k.resetKaraokeTimer();
    let offset = 0;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const start = karaokePulls();
      // Bellek boş: işaret ilk kez görülüyor, liste o işarete ait değil → bir çekim
      await k.siteKaraokeTick('k1');
      expect(karaokePulls()).toBe(start + 1);
      offset += 20_000;
      await k.siteKaraokeTick('k1');
      expect(karaokePulls()).toBe(start + 1);
      // İşaret değişti ama son otomatik çekim 5 dakikadan yeni: bekler, süre dolunca çeker
      await k.siteKaraokeTick('k2');
      expect(karaokePulls()).toBe(start + 1);
      offset += 5 * 60_000;
      await k.siteKaraokeTick('k2');
      expect(karaokePulls()).toBe(start + 2);
    } finally {
      spy.mockRestore();
    }
  });

  it('sipariş zamanlayıcısı sürüm yanıtındaki karaoke işaretini iletir', async () => {
    const k = await karaokeModule();
    const orders = await import('../server/sync/laffogato-orders');
    k.resetKaraokeTimer();
    orders.resetOnlineTimer();
    const start = karaokePulls();
    site.karaokeMarker = 'k9';
    await orders.onlineOrdersTick();
    expect(karaokePulls()).toBe(start + 1);
    site.karaokeMarker = 'k1';
  });

  it('elle "Yenile" en sık 30 saniyede bir; site karaokeyi açmadıysa (401) "kapalı", eldeki liste kalır', async () => {
    await freshList();
    const n = karaokePulls();
    expect((await h.ok<SiteKaraokeDTO>('kasa', 'POST', '/sync/karaoke/refresh')).state).toBe('hazir');
    expect(karaokePulls()).toBe(n);
    (await karaokeModule()).resetKaraokeTimer();
    site.karaokeStatus.push(401);
    const r = await h.call<{ error: string; code: string }>('kasa', 'POST', '/sync/karaoke/refresh');
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/HTTP 401/);
    const view = await h.ok<SiteKaraokeDTO>('kasa', 'GET', '/sync/karaoke');
    expect(view.state).toBe('kapali');
    expect(view.bookings).toHaveLength(5);
    expect((await freshList()).state).toBe('hazir');
  });

  it('personel olmayan rol okuyamaz', async () => {
    await h.login('mutfakci', await mutfakPin());
    expect((await h.call('mutfakci', 'GET', '/sync/karaoke')).status).toBe(403);
  });
});

/** Mutfak rolünde bir personel (siparis.al ve rezervasyon.yonet yok) */
async function mutfakPin(pin = '7391'): Promise<string> {
  const r = await h.call('patron', 'POST', '/admin/users', { name: `Mutfak Test ${pin}`, role: 'mutfak', pin });
  if (r.status !== 200) throw new Error(`personel eklenemedi: ${JSON.stringify(r.json)}`);
  return pin;
}

describe('oda sayacı rezervasyona bağlanır', () => {
  it('sitede ödenmiş 2 saat + 2 sa 20 dk: yalnız aşan 30 dk ücretlenir, satır notunda rezervasyon kodu', async () => {
    await freshList();
    const o = await roomOrder();
    const started = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00044' });
    expect(started.room).toMatchObject({ bookingId: 'krk-00044', prepaidMinutes: 120 });
    // Bağlı rezervasyon oda kutusunda adisyonuyla görünür
    expect((await h.ok<SiteKaraokeDTO>('kasa', 'GET', '/sync/karaoke')).bookings.find((b) => b.id === 'krk-00044')?.session).toMatchObject({ orderId: o.id, active: true });
    await ranFor(o.id, 140);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(stopped)).toHaveLength(1);
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 50000, note: 'Site rezervasyonu KRK-00044' });
    expect(roomLines(stopped)[0].optionsText).toMatch(/aşan 30 dk \(2 sa sitede ödendi\)/);
    expect(stopped.total).toBe(50000);
    const [s] = await sessionsOf('krk-00044');
    expect(s.prepaidMinutes).toBe(120);
  });

  it('blokta kalan süre: adisyona satır yazılmaz, denetim kaydı "kasada ücret yok" der', async () => {
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00041' });
    await ranFor(o.id, 50);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(stopped.room).toBeNull();
    expect(roomLines(stopped)).toHaveLength(0);
    expect(stopped.total).toBe(0);
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const log = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orderId, o.id), eq(schema.auditLog.action, 'room.stop'))).get();
    expect(log?.message).toMatch(/KRK-00041.*kasada ücret yok/);
  });

  it('köşkte ödenecek rezervasyon: blok satırın tutarıyla (765 ₺), aşan süre saat ücretiyle', async () => {
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00042' });
    await ranFor(o.id, 80);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 76500 + 50000, optionsText: '1 sa rezervasyon + 30 dk' });
  });

  it('bağlanmamış oturum bugünkü gibi tam ücretlenir', async () => {
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`);
    await ranFor(o.id, 140);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 250000, optionsText: '2 sa 30 dk', note: null });
  });

  it('ödemesi süren rezervasyon: sayaç durduğunda ödenmişse blok düşer, ödenmemişse bütün süre ücretlenir', async () => {
    const pending = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${pending.id}/room/start`, { bookingId: 'krk-00045' });
    await ranFor(pending.id, 70);
    const unpaid = await h.ok<OrderDTO>('garson', 'POST', `/orders/${pending.id}/room/stop`);
    expect(roomLines(unpaid)[0]).toMatchObject({ unitPrice: 125000, optionsText: '1 sa 15 dk', note: 'Site rezervasyonu KRK-00045' });

    // Aynı rezervasyon yeniden bağlanır, bu arada sitede ödenir. Sürüm sinyali değişti ama otomatik çekimin sırası
    // gelmedi (5 dk kuralı): sayacı durdurmadan önceki çekim yeni durumu getirir
    const k = await karaokeModule();
    k.resetKaraokeTimer();
    await k.siteKaraokeTick('k1');
    const again = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${again.id}/room/start`, { bookingId: 'krk-00045' });
    site.karaoke = site.karaoke.map((b) => (b.id === 'krk-00045' ? { ...b, status: 'confirmed', paymentStatus: 'paid' } : b));
    site.karaokeMarker = 'k3';
    const before = karaokePulls();
    await k.siteKaraokeTick('k3');
    expect(karaokePulls()).toBe(before);
    await ranFor(again.id, 30);
    const paid = await h.ok<OrderDTO>('garson', 'POST', `/orders/${again.id}/room/stop`);
    expect(karaokePulls()).toBe(before + 1);
    expect(roomLines(paid)).toHaveLength(0);
    site.karaokeMarker = 'k1';
  });

  it('sayaç yeniden başlarsa bloğun kalanı geçer; köşkte ödenen blok tutarı bir kez yazılır', async () => {
    site.karaoke = site.karaoke.map((b) => (b.id === 'krk-00042' ? { ...b, id: 'krk-00052' } : b));
    await freshList();
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00052' });
    await ranFor(o.id, 40);
    expect(roomLines(await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`))[0].unitPrice).toBe(76500);
    const second = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00052' });
    expect(second.room?.prepaidMinutes).toBe(20);
    await ranFor(o.id, 35);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    // 20 dk blokta, aşan 15 dk: yalnız 250 ₺ (blok tutarı ilk oturumda alındı)
    expect(roomLines(stopped).map((i) => i.unitPrice)).toEqual([76500, 25000]);
    site.karaoke = site.karaoke.map((b) => (b.id === 'krk-00052' ? { ...b, id: 'krk-00042' } : b));
    await freshList();
  });

  it('iptal, listede olmayan ya da başka sayaca bağlı rezervasyon bağlanmaz', async () => {
    const a = await roomOrder();
    const b = await roomOrder();
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${a.id}/room/start`, { bookingId: 'krk-00043' })).json.code).toBe('booking_not_linkable');
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${a.id}/room/start`, { bookingId: 'krk-99999' })).json.code).toBe('booking_not_found');
    await h.ok('garson', 'POST', `/orders/${a.id}/room/start`, { bookingId: 'krk-00044' });
    const twice = await h.call<{ code: string; error: string }>('garson', 'POST', `/orders/${b.id}/room/start`, { bookingId: 'krk-00044' });
    expect(twice.status).toBe(409);
    expect(twice.json).toMatchObject({ code: 'booking_running' });
    // Reddedilen bağlama sayacı da başlatmaz
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${b.id}`)).room).toBeNull();
    await h.ok('garson', 'POST', `/orders/${a.id}/room/stop`);
  });

  it('sayaç dururken rezervasyon o günün listesinden düştüyse (başka güne taşındı) blok sayılmaz', async () => {
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00044' });
    // Panel rezervasyonu başka güne taşıdı: bugünün listesinden düştü, blok o güne ait
    site.karaoke = site.karaoke.filter((b) => b.id !== 'krk-00044');
    await freshList();
    await ranFor(o.id, 130);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    // 130 dk → 135 dk adımla, saat ücretiyle
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 225000, optionsText: '2 sa 15 dk', note: 'Site rezervasyonu KRK-00044' });
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const log = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orderId, o.id), eq(schema.auditLog.action, 'room.stop'))).get();
    expect(log?.message).toMatch(/KRK-00044 blok sayılmadı \(sitenin bugünkü listesinde yok\)/);
    site.karaoke = (await import('./fake-site')).siteKaraokeFixture().reservations;
    await freshList();
  });

  it('liste başka güne aitse (iş günü döndü, site ulaşılamadı) bağlanırken saklanan koşul geçer', async () => {
    site.karaoke = site.karaoke.map((b) => (b.id === 'krk-00044' ? { ...b, id: 'krk-00054' } : b));
    await freshList();
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00054' });
    // Gece yarısından sonra 05:00'i geçen sayaç: okunan liste artık ertesi iş gününün, rezervasyon içinde değil
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const state = getSyncState<Record<string, unknown>>('laffogato.karaoke')!;
    setSyncState('laffogato.karaoke', { ...state, date: '2099-01-01', bookings: [] });
    // Durdururken yapılacak çekim de başarısız: site ulaşılamıyor
    site.karaokeStatus.push(500, 500);
    await ranFor(o.id, 130);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    site.karaokeStatus.length = 0;
    // Sitede ödenmiş 2 saat saklanan koşulla düşülür: aşan 10 dk → 15 dk
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 25000, note: 'Site rezervasyonu KRK-00054' });
    site.karaoke = (await import('./fake-site')).siteKaraokeFixture().reservations;
    await freshList();
  });
});

describe('yerel rezervasyon ve saat ücreti', () => {
  it('karaoke odasına yerel rezervasyon reddedilir; masa rezervasyonu olduğu gibi', async () => {
    const room = boot.tables.find((t) => t.kind === 'oda')!;
    const masa = boot.tables.find((t) => t.kind === 'masa')!;
    const refused = await h.call<{ error: string; code: string }>('garson', 'POST', '/reservations', { date: '2026-10-27', time: '20:00', name: 'Ece', tableId: room.id });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'room_reservation' });
    expect(refused.json.error).toMatch(/sitedeki \/karaoke/);
    const ok = await h.ok<{ id: string }>('garson', 'POST', '/reservations', { date: '2026-10-27', time: '20:00', name: 'Ece', tableId: masa.id });
    expect((await h.call('garson', 'PATCH', `/reservations/${ok.id}`, { tableId: room.id })).status).toBe(409);
    // Önceden yazılmış eski oda rezervasyonunun durumu yine değişir
    const { db, schema } = await import('../server/db/client');
    db.insert(schema.reservations).values({ id: 'eski-oda', date: '2026-10-27', time: '21:00', name: 'Eski', tableId: room.id, createdAt: Date.now() }).run();
    await h.ok('garson', 'PATCH', '/reservations/eski-oda', { status: 'iptal' });
  });

  it('Masa planı sitenin saat ücretini okur (herkese açık müsaitlik), ekran başına bir istek', async () => {
    const before = site.count('GET /api/mobile/v1/karaoke/availability');
    expect(await h.ok('patron', 'GET', '/admin/floor/site-karaoke-price')).toEqual({ linked: true, hourlyMinor: 90000, error: null });
    await h.ok('patron', 'GET', '/admin/floor/site-karaoke-price');
    expect(site.count('GET /api/mobile/v1/karaoke/availability')).toBe(before + 1);
    expect((await h.call('garson', 'GET', '/admin/floor/site-karaoke-price')).status).toBe(403);
  });
});

/** Fikstürdeki bir rezervasyonu yeni kimlikle listeye koyar (önceki testlerin oturumları bloğu tüketmesin) */
async function asNew(fromId: string, toId: string) {
  site.karaoke = [...siteKaraokeRows(), { ...siteKaraokeRows().find((b) => b.id === fromId)!, id: toId }];
  await freshList();
}
const siteKaraokeRows = () => site.karaoke.filter((b) => !/^krk-0006\d|^krk-0007\d/.test(b.id));
async function restoreList() {
  site.karaoke = (await import('./fake-site')).siteKaraokeFixture().reservations;
  await freshList();
}

describe('gözden geçirme düzeltmeleri (27 Eki 2026)', () => {
  it('rezervasyonsuz başlamış sayaç sonradan bağlanır: sitede ödenmiş 2 saat yeniden ücretlenmez', async () => {
    await asNew('krk-00044', 'krk-00061');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`);
    await ranFor(o.id, 10);
    const linked = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/link`, { bookingId: 'krk-00061' });
    expect(linked.room).toMatchObject({ bookingId: 'krk-00061', prepaidMinutes: 120 });
    // Bağlı sayaç ikinci kez bağlanmaz; aynı rezervasyon başka sayaca da bağlanmaz
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/room/link`, { bookingId: 'krk-00061' })).json.code).toBe('room_linked');
    const other = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${other.id}/room/start`);
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${other.id}/room/link`, { bookingId: 'krk-00061' })).json.code).toBe('booking_running');
    await h.ok('garson', 'POST', `/orders/${other.id}/room/stop`);
    // Blok sayacın başladığı andan: 140 dk → aşan 20 dk, 30 dk'ya yuvarlanır
    await ranFor(o.id, 140);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(stopped)[0]).toMatchObject({ unitPrice: 50000, note: 'Site rezervasyonu KRK-00061' });
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const log = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orderId, o.id), eq(schema.auditLog.action, 'room.link'))).get();
    expect(log?.message).toMatch(/KRK-00061 ile bağlandı/);
    // Çalışan sayacı olmayan adisyon bağlanmaz
    expect((await h.call('garson', 'POST', `/orders/${o.id}/room/link`, { bookingId: 'krk-00061' })).status).toBe(404);
    await restoreList();
  });

  it('köşkte ödenecek bloğun satırı iptal edilip sayaç yeniden başlarsa blok tutarı yeniden yazılır', async () => {
    await asNew('krk-00042', 'krk-00062');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00062' });
    await ranFor(o.id, 5);
    const first = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(first)[0].unitPrice).toBe(76500);
    await h.ok('patron', 'POST', `/orders/${o.id}/items/${roomLines(first)[0].id}/void`, { reason: 'Yanlışlıkla durduruldu' });
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00062' });
    await ranFor(o.id, 55);
    const second = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    // İlk oturumun 5 dakikası blokta kaldı, 55 dk blokta; tutar iptal edilen satırda kaldığı için yeniden
    expect(second.total).toBe(76500);
    await restoreList();
  });

  it('başka güne taşınıp geri gelen köşkte ödenecek rezervasyon: blok tutarı alınır (ilk oturum saat ücretiyle ödendi)', async () => {
    await asNew('krk-00042', 'krk-00063');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00063' });
    // Panel rezervasyonu başka güne taşıdı: ilk oturum saat ücretiyle, blok sayılmadan durur
    site.karaoke = siteKaraokeRows();
    await freshList();
    await ranFor(o.id, 20);
    const first = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(first)[0].unitPrice).toBe(HOUR);
    const [ended] = await sessionsOf('krk-00063');
    expect(ended).toMatchObject({ booking: null, prepaidMinutes: 0, blockCharge: null });
    // Rezervasyon bugüne geri geldi: bağlanınca bloğu tam, tutarıyla
    await asNew('krk-00042', 'krk-00063');
    const again = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00063' });
    expect(again.room?.prepaidMinutes).toBe(60);
    await ranFor(o.id, 60);
    const second = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(roomLines(second).map((i) => i.unitPrice)).toEqual([HOUR, 76500]);
    await restoreList();
  });

  it('blokta kalan, başka kalemi olmayan adisyon kapanır: oda planda boş, adisyon iptal sayılmaz', async () => {
    await asNew('krk-00044', 'krk-00064');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00064' });
    await ranFor(o.id, 30);
    const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
    expect(stopped).toMatchObject({ status: 'kapali', total: 0, room: null });
    expect(stopped.items).toHaveLength(0);
    const floor = await h.ok<FloorStateDTO>('garson', 'GET', '/floor');
    expect(floor.tables[o.tableId!] ?? []).toHaveLength(0);
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const log = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orderId, o.id), eq(schema.auditLog.action, 'room.stop'))).get();
    expect(log?.message).toMatch(/boş adisyon kapandı/);
    // Kalemi olan adisyon açık kalır (yalnız oda satırı yazılmadı)
    const withDrink = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${withDrink.id}/items`, { items: [{ productId: boot.products.find((p) => p.name === 'Türk Kahvesi')!.id, qty: 1 }] });
    await h.ok('garson', 'POST', `/orders/${withDrink.id}/room/start`, { bookingId: 'krk-00064' });
    await ranFor(withDrink.id, 10);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${withDrink.id}/room/stop`)).status).toBe('acik');
    await restoreList();
  });

  it('Durdur: siteden okuma beklerken geçen süre ücrete eklenmez', async () => {
    await asNew('krk-00044', 'krk-00065');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00065' });
    // Liste eskidi: durdururken bir çekim yapılır, site 2,5 sn'de yanıt verir
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const state = getSyncState<Record<string, unknown>>('laffogato.karaoke')!;
    setSyncState('laffogato.karaoke', { ...state, pulledAt: Date.now() - 10 * 60_000 });
    (await karaokeModule()).resetKaraokeTimer();
    await ranFor(o.id, 120);
    const before = karaokePulls();
    site.karaokeDelayMs = 2500;
    try {
      const stopped = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/room/stop`);
      expect(karaokePulls()).toBe(before + 1);
      // 2 saatlik blok tam kullanıldı, aşım yok
      expect(roomLines(stopped)).toHaveLength(0);
    } finally {
      site.karaokeDelayMs = 0;
    }
    await restoreList();
  });

  it('"Online siparişleri çek" kapalıyken karaoke işareti okunmaya devam eder, sipariş çekilmez', async () => {
    const k = await karaokeModule();
    const orders = await import('../server/sync/laffogato-orders');
    await h.ok('patron', 'PUT', '/sync/settings', { onlineOrdersSync: false });
    try {
      k.resetKaraokeTimer();
      orders.resetOnlineTimer();
      const pulls = karaokePulls();
      const orderPulls = site.count('GET /api/panel/orders');
      site.karaokeMarker = 'k8';
      await orders.onlineOrdersTick();
      expect(karaokePulls()).toBe(pulls + 1);
      expect(site.count('GET /api/panel/orders')).toBe(orderPulls);
      expect((await h.ok<{ karaoke: { on: boolean; count: number; lastError: string | null } }>('patron', 'GET', '/sync/status')).karaoke).toMatchObject({ on: true, count: 5, lastError: null });
    } finally {
      site.karaokeMarker = 'k1';
      await h.ok('patron', 'PUT', '/sync/settings', { onlineOrdersSync: true });
    }
  });

  it('masa planı: sipariş ve rezervasyon yetkisi olmayan rol notu görmez; Uzaktan özetinde ad, not ve kod yok', async () => {
    await freshList();
    expect((await h.ok<FloorStateDTO>('garson', 'GET', '/floor')).siteKaraoke?.find((b) => b.id === 'krk-00044')?.note).toBe('Doğum günü, pasta getirecekler');
    await h.login('mutfakci2', await mutfakPin('7392'));
    const bar = await h.ok<FloorStateDTO>('mutfakci2', 'GET', '/floor');
    expect(bar.siteKaraoke?.find((b) => b.id === 'krk-00044')).toMatchObject({ firstName: 'Ayşe', note: '' });

    await asNew('krk-00044', 'krk-00066');
    const o = await roomOrder();
    await h.ok('garson', 'POST', `/orders/${o.id}/room/start`, { bookingId: 'krk-00066' });
    const { buildSnapshot } = await import('../server/sync/cloud');
    const snap = buildSnapshot();
    const remote = JSON.stringify({ floor: snap.floor, orders: snap.orders });
    // Ad: masa planındaki site rezervasyonunda boş (online siparişin teslim adı ayrı kuralla yalnız ad olarak gider)
    expect(remote).not.toMatch(/Doğum günü|krk-000/i);
    expect(snap.floor.siteKaraoke?.every((b) => b.firstName === '' && b.note === '' && b.id.startsWith('site-'))).toBe(true);
    expect(snap.orders[o.id].room).toMatchObject({ bookingId: 'uzak', prepaidMinutes: 120 });
    await h.ok('garson', 'POST', `/orders/${o.id}/room/stop`);
    await restoreList();
  });
});
