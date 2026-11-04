import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Mutfak olayları istasyon başına: tek yazma bara ve mutfağa kalem gönderince (Latte barda, San Sebastian mutfakta) her
 * istasyon kendi `ticket.new` ya da `ticket.void` olayını alır, bar ekranı kendi istasyonunda sesi çalar
 * (src/pages/KitchenPage.tsx). Yayının tekilleştirme anahtarında (`Effects.flush`) istasyon yoktu: ikinci istasyonun
 * olayı düşüyor, o ekran ses çalmıyordu; listesi her mutfak olayıyla yenilendiği için fark edilmiyordu. v1'den beri.
 */
let h: Harness;
let bar: string;
let mutfak: string;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  bar = h.boot.stations.find((s) => s.kind === 'bar')!.id;
  mutfak = h.boot.stations.find((s) => s.kind === 'mutfak')!.id;
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const table = (i: number) => h.boot.tables.filter((t) => t.kind === 'masa')[i];
const cash = () => h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
/** Tek istekte bara (Latte) ve mutfağa (San Sebastian) giden kalemler */
const mixed = (hold?: true) => ({
  items: [
    { productId: product('Latte').id, size: 'M', qty: 1 },
    { productId: product('San Sebastian').id, qty: 1 },
  ],
  hold,
});

/** İstek sürerken yayılan canlı olaylar */
async function eventsOf<T>(fn: () => Promise<T>): Promise<{ result: T; events: LiveEvent[] }> {
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

/** Adisyonun bu türdeki mutfak olaylarının istasyonları (her istasyon bir kez beklenir) */
const stationsOf = (events: LiveEvent[], kind: string, orderId: string) =>
  events
    .filter((e) => e.topic === 'kitchen' && e.kind === kind && e.orderId === orderId)
    .map((e) => e.stationId)
    .sort();

describe('mutfak olayları istasyon başına', () => {
  it('bara ve mutfağa giden kalem ekleme iki istasyona da ticket.new yayar', async () => {
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table(0).id });
    const { result, events } = await eventsOf(() => h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, mixed()));
    // Kurulum verisi kalemleri gerçekten iki istasyona dağıtıyor
    expect(result.items.map((i) => i.stationId).sort()).toEqual([bar, mutfak].sort());
    expect(stationsOf(events, 'ticket.new', o.id)).toEqual([bar, mutfak].sort());
  });

  it('bara ve mutfağa gitmiş adisyonun iptali iki istasyona da ticket.void yayar', async () => {
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table(1).id });
    await h.ok('garson', 'POST', `/orders/${o.id}/items`, mixed());
    const { result, events } = await eventsOf(() => h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/cancel`, { reason: 'Müşteri vazgeçti' }));
    expect(result.status).toBe('iptal');
    expect(stationsOf(events, 'ticket.void', o.id)).toEqual([bar, mutfak].sort());
  });

  it('tezgâhta ödeme bekleyen kalemler ödeme alınınca iki istasyona da ticket.new yayar', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const added = await eventsOf(() => h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, mixed(true)));
    // Bekleyen kalem bara henüz gitmedi: fiş sesi de yok
    expect(added.result.items.every((i) => i.held)).toBe(true);
    expect(stationsOf(added.events, 'ticket.new', o.id)).toEqual([]);
    const paid = await eventsOf(() => h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: added.result.total }));
    expect(paid.result.closed).toBe(true);
    expect(stationsOf(paid.events, 'ticket.new', o.id)).toEqual([bar, mutfak].sort());
  });

  it('tekilleştirme sürer: aynı olay bir kez, yalnız istasyonu farklı olay ayrı yayılır', async () => {
    const { Effects } = await import('../server/lib/effects');
    const { events } = await eventsOf(async () => {
      const fx = new Effects();
      const ticket = { topic: 'kitchen', kind: 'ticket.new', orderId: 'adisyon-1' } as const;
      fx.emit({ ...ticket, stationId: bar }).emit({ ...ticket, stationId: bar }).emit({ ...ticket, stationId: mutfak });
      fx.emit({ topic: 'orders', kind: 'order.items_added', orderId: 'adisyon-1' }).emit({ topic: 'orders', kind: 'order.items_added', orderId: 'adisyon-1' });
      fx.flush();
    });
    expect(events.map((e) => [e.topic, e.kind, e.stationId])).toEqual([
      ['kitchen', 'ticket.new', bar],
      ['kitchen', 'ticket.new', mutfak],
      ['orders', 'order.items_added', undefined],
    ]);
  });
});
