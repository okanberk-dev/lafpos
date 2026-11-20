import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { SiteKaraokeBooking } from '@shared/karaoke';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Sesli uyarılar (docs/03-ENTEGRASYON.md §2.5; operatör 20 Kas 2026: "sipariş, karaoke gelince LafPOS'ta da ötsün"):
 * var olan çekimlerin listesinden doğar, yeni istek açmaz. Online sipariş "yeni" aşamasındayken cihazlarda çalar
 * (`GET /api/sync/alerts`, yalnız yerel), siteden kalkınca numarasıyla olay; karaokede aynı günün iki listesi
 * kıyaslanır (günün ilki değil), yeni, iptal ve saati değişen rezervasyon olay olur. Ad ve not hiçbir olaya girmez.
 */
const SECRET = 'u'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  await h.ok('patron', 'POST', '/admin/users', { name: 'Bar Tableti', role: 'mutfak', pin: '7171' });
  await h.ok('patron', 'POST', '/admin/users', { name: 'Kurye Ali', role: 'kurye', pin: '6161' });
  await h.login('bar', '7171');
  await h.login('kurye', '6161');
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

/** Fonksiyon süresince yayılan canlı olaylar */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; events: LiveEvent[] }> {
  const { bus } = await import('../server/lib/events');
  const events: LiveEvent[] = [];
  const listen = (e: LiveEvent) => events.push(e);
  bus.on('event', listen);
  try {
    return { result: await fn(), events };
  } finally {
    bus.off('event', listen);
  }
}

const alerts = (who = 'garson') => h.ok<SiteAlertsDTO>(who, 'GET', '/sync/alerts');

describe('online sipariş uyarısı', () => {
  it('çekim yeni siparişte olay yayar; uyarı listesi yeni aşamadakileri verir ve siteye istek atmaz', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    const { events } = await capture(() => orders.syncOnlineOrders());
    const created = events.filter((e) => e.topic === 'orders' && e.kind === 'online.new');
    expect(created).toHaveLength(4);
    const before = site.calls.length;
    const a = await alerts();
    expect(site.calls.length).toBe(before);
    expect(a.configured).toBe(true);
    // ord-0102 sitede "hazırlanıyor": bar başlamış, çalmaz. En eskisi önce
    expect(a.online.map((o) => o.no)).toEqual([10101, 10103, 10104]);
    const s4 = a.online.find((o) => o.no === 10101)!;
    expect(s4).toMatchObject({ label: 'Masa S4', table: true });
    expect(s4.tableId).toBe(h.boot.tables.find((t) => t.name === 'S4')!.id);
    expect(a.online.find((o) => o.no === 10103)).toMatchObject({ label: 'Kurye', table: false, tableId: null });
    // Adı, notu ve kalemleri taşımaz
    expect(JSON.stringify(a)).not.toMatch(/Ayşe|Zeynep|Can|Fındık|Latte/);
  });

  it('yetki: siparişi alan ve bar ekranı görür, kurye göremez', async () => {
    expect((await alerts('bar')).online).toHaveLength(3);
    expect((await alerts('kasa')).online).toHaveLength(3);
    const r = await h.call('kurye', 'GET', '/sync/alerts');
    expect(r.status).toBe(403);
  });

  it('aşaması değişen ve ödemesinden 4 saat geçen sipariş listeden düşer', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    site.orders.orders = site.orders.orders.map((o) => (o.id === 'ord-0104' ? { ...o, stage: 'preparing' } : o));
    const { events } = await capture(() => orders.syncOnlineOrders());
    expect(events.some((e) => e.topic === 'orders' && e.kind === 'online.updated')).toBe(true);
    expect((await alerts()).online.map((o) => o.no)).toEqual([10101, 10103]);
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    db.update(schema.orders)
      .set({ openedAt: Date.now() - 4 * 3600_000 - 60_000 })
      .where(and(eq(schema.orders.source, 'laffogato'), eq(schema.orders.extId, 'ord-0103')))
      .run();
    expect((await alerts()).online.map((o) => o.no)).toEqual([10101]);
  });

  it('siteden kalkan sipariş: olay sipariş numarasıyla, ad yok', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    site.orders.orders = site.orders.orders.filter((o) => o.id !== 'ord-0101');
    const { events } = await capture(() => orders.syncOnlineOrders());
    const gone = events.filter((e) => e.topic === 'orders' && e.kind === 'online.done');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.message).toBe('Online sipariş #10101 siteden kalktı');
    expect((await alerts()).online).toEqual([]);
  });
});

const booking = (b: Partial<SiteKaraokeBooking> & { id: string }): SiteKaraokeBooking => ({
  date: '2026-11-20',
  startHour: 20,
  hours: 2,
  startsAt: '',
  endsAt: '',
  guests: 4,
  status: 'confirmed',
  paymentStatus: 'paid',
  firstName: 'Ayşe',
  note: 'Doğum günü',
  totalMinor: 0,
  channel: 'web',
  ...b,
});

describe('karaoke uyarısı', () => {
  it('saf kural: yeni, iptal, saati ya da süresi değişen; ödeme ve kişi değişikliği çalmaz', async () => {
    const { karaokeChanges } = await import('../server/sync/laffogato-karaoke');
    const prev = [booking({ id: 'a' }), booking({ id: 'b', startHour: 17, hours: 1, guests: 0 }), booking({ id: 'c' }), booking({ id: 'd', status: 'cancelled' }), booking({ id: 'e' })];
    const next = [
      booking({ id: 'a', paymentStatus: 'refunded', guests: 6 }),
      booking({ id: 'b', startHour: 18, hours: 1, guests: 0 }),
      booking({ id: 'c', status: 'cancelled' }),
      booking({ id: 'd', status: 'requested', startHour: 22, hours: 1, guests: 2 }),
      booking({ id: 'f', startHour: 21, hours: 3, guests: 5 }),
      booking({ id: 'g', status: 'cancelled' }),
    ];
    expect(karaokeChanges(prev, next, true)).toEqual([
      { kind: 'moved', id: 'b', message: 'Karaoke 18:00 · 1 sa (önce 17:00 · 1 sa)' },
      { kind: 'cancelled', id: 'c', message: 'Karaoke 20:00 · 2 sa · 4 kişi' },
      { kind: 'new', id: 'd', message: 'Karaoke 22:00 · 1 sa · 2 kişi' },
      { kind: 'new', id: 'f', message: 'Karaoke 21:00 · 3 sa · 5 kişi' },
      // Günün listesinden düştü (panel başka güne taşıdı): yalnız iki liste de tamsa
      { kind: 'moved', id: 'e', message: 'Karaoke 20:00 · 2 sa · 4 kişi (başka güne)' },
    ]);
    expect(karaokeChanges(prev, next, false).map((c) => c.id)).toEqual(['b', 'c', 'd', 'f']);
    expect(karaokeChanges(prev, prev, true)).toEqual([]);
  });

  it('günün ilk listesi çalmaz; sonraki çekimde yeni, iptal ve saati değişen olay olur, ad ve not girmez', async () => {
    const k = await import('../server/sync/laffogato-karaoke');
    const refresh = () => {
      k.resetKaraokeTimer();
      return h.ok('kasa', 'POST', '/sync/karaoke/refresh');
    };
    const kinds = (events: LiveEvent[]) => events.filter((e) => e.topic === 'reservations').map((e) => e.kind);
    const first = await capture(refresh);
    expect(kinds(first.events)).toEqual(['site.karaoke']);

    const base = site.karaoke;
    site.karaoke = [
      ...base.map((r) => (r.id === 'krk-00042' ? { ...r, status: 'cancelled' } : r.id === 'krk-00044' ? { ...r, startHour: 21, hours: 2 } : r)),
      { ...base.find((r) => r.id === 'krk-00045')!, id: 'krk-00046', startHour: 19, hours: 1, guests: 3, status: 'confirmed', paymentStatus: 'paid', firstName: 'Ece', note: 'Sürpriz' },
    ];
    const second = await capture(refresh);
    const alerts = second.events.filter((e) => e.kind.startsWith('site.karaoke.'));
    // Listenin sırasıyla (başlangıç saati)
    expect(alerts.map((e) => [e.kind, e.message])).toEqual([
      ['site.karaoke.cancelled', 'Karaoke 17:00 · 1 sa · 3 kişi'],
      ['site.karaoke.new', 'Karaoke 19:00 · 1 sa · 3 kişi'],
      ['site.karaoke.moved', 'Karaoke 21:00 · 2 sa · 4 kişi (önce 20:00 · 2 sa)'],
    ]);
    expect(JSON.stringify(second.events)).not.toMatch(/Ece|Sürpriz|Mehmet|Ayşe|Doğum|krk-/i);
    // Aynı liste yeniden: olay yok
    const third = await capture(refresh);
    expect(kinds(third.events)).toEqual([]);
    site.karaoke = base;
  });
});
