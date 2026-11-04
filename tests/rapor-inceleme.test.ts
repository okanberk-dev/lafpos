import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Raporların tasarım incelemesi (4 Kas 2026), sunucu tarafı:
 * - İptaller'in kırmızı "Hesaptan sonra" rozeti iptal anına göre: iptal anında hesap yazdırılmışsa (kalemin
 *   `voidAfterBill`'i). Adisyonun `billPrintedAt`'i sonradan da dolar; yanlış girişi iptal edip sonra hesabı yazdıran
 *   garsonun iptali hesaptan sonra sayılıyordu. Adisyon iptali de aynı kuralla.
 * - Saatlik: aktif saatlerin cirosu eşitse en yoğun ilki, en sakin sonuncusu (ikisi aynı saat yalnız tek aktif saatte).
 *
 * Saat sahte (yalnız Date): bütün adisyonlar 2 Kasım 2026 pazartesinin iş gününde.
 */
let h: Harness;
const MUDUR = PINS.mudur;
const DAY = '2026-11-02';

const at = (clock: string) => vi.setSystemTime(new Date(`${DAY}T${clock}+03:00`));
const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const masa = (i: number) => h.boot.tables.filter((t) => t.kind !== 'oda')[i]!;
const open = (i: number) => h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: masa(i).id });
const add = (o: OrderDTO, qty: number) => h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty }] });
const bill = (o: OrderDTO) => h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/bill`);
const voidOne = (o: OrderDTO, approverPin?: string) => h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/void`, { qty: 1, reason: 'Yanlış giriş', ...(approverPin ? { approverPin } : {}) });
const pay = (o: OrderDTO) => h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('08:00:00');
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});

afterAll(() => {
  vi.useRealTimers();
  h.cleanup();
});

describe('raporların tasarım incelemesi', () => {
  it('saatlik: iki saatin cirosu eşitse en yoğun ilk, en sakin son saat (Raporlar "satış yalnız bir saatte" demez)', async () => {
    for (const [i, clock] of [
      [0, '08:10:00'],
      [1, '09:20:00'],
    ] as const) {
      at(clock);
      await pay(await add(await open(i), 1));
    }
    type Hour = { hour: number; orders: number; revenue: number };
    const hourly = await h.ok<{ hours: Hour[]; busiest: Hour | null; quietest: Hour | null }>('mudur', 'GET', `/reports/hourly?from=${DAY}&to=${DAY}`);
    expect(hourly.hours.filter((x) => x.orders > 0).map((x) => x.hour)).toEqual([8, 9]);
    expect(hourly.busiest).toMatchObject({ hour: 8, orders: 1 });
    expect(hourly.quietest).toMatchObject({ hour: 9, orders: 1, revenue: hourly.busiest!.revenue });
  });

  it('"Hesaptan sonra" iptal anındaki hesaba göre: sonradan yazdırılan hesap önceki iptali işaretlemez, yeniden yazdırmak sonrakini silmez', async () => {
    // A: yanlış giriş hemen iptal edilir (onaysız), sonra hesap yazdırılıp ödenir
    at('10:00:00');
    let a = await add(await open(2), 2);
    at('10:00:20');
    a = await voidOne(a);
    at('10:10:00');
    a = await bill(a);
    at('10:11:00');
    await pay(a);

    // B: hesap yazdırılır, sonra iptal edilir (yetkili onayıyla); düzeltilen hesap yeniden yazdırılır
    at('10:20:00');
    let b = await add(await open(3), 2);
    at('10:21:00');
    b = await bill(b);
    at('10:25:00');
    b = await voidOne(b, MUDUR);
    at('10:26:00');
    b = await bill(b);
    await pay(b);

    // C: hesabı yazdırılmış adisyonun tamamı iptal edilir; D: hesabı yazdırılmamış adisyon iptal edilir
    at('10:30:00');
    let c = await add(await open(4), 1);
    at('10:31:00');
    c = await bill(c);
    at('10:35:00');
    await h.ok('kasa', 'POST', `/orders/${c.id}/cancel`, { reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    at('10:40:00');
    const d = await add(await open(5), 1);
    await h.ok('kasa', 'POST', `/orders/${d.id}/cancel`, { reason: 'Yanlış masa' });

    type Row = { orderNo: number; afterSend: boolean; afterBill: boolean };
    const late = async () => {
      const list = await h.ok<{ rows: Row[] }>('mudur', 'GET', `/reports/items?kind=iptal&from=${DAY}&to=${DAY}`);
      return Object.fromEntries(list.rows.map((r) => [r.orderNo, r.afterBill]));
    };
    expect(await late()).toEqual({ [a.no]: false, [b.no]: true, [c.no]: true, [d.no]: false });

    // Bayraktan önceki kayıt: adisyonun son yazdırılması iptalden önceyse hesaptan sonradır (C); iptalden sonraysa
    // bilinmez, sayılmaz (B yeniden yazdırıldı)
    const { db, schema } = await import('../server/db/client');
    db.update(schema.orderItems).set({ voidAfterBill: false }).where(eq(schema.orderItems.voided, true)).run();
    expect(await late()).toEqual({ [a.no]: false, [b.no]: false, [c.no]: true, [d.no]: false });
  });
});
