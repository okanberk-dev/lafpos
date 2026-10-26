import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Raporlar asla birbirini tutmazlık etmez: gerçekçi bir gün (nakit, kart, yemek kartı, kalem ve adisyon indirimi,
 * ikram, gönderildikten sonra iptal, servis ücreti, bahşiş, ödeme iptali ve yeniden ödeme, paylaşımlı hesap)
 * sonrasında ciro; özet, ürün, kategori, saatlik, gün, patron paneli ve Z'de aynı; döküm ve KDV kuruşu kuruşuna.
 */
let h: Harness;
const MUDUR = PINS.mudur;

beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 50000 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const add = (o: OrderDTO, items: { name: string; qty?: number; size?: 'M' | 'L' }[]) =>
  h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
const pay = (o: OrderDTO, name: string, amount: number, tip = 0) => h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(name).id, amount, tip });

describe('rapor mutabakatı', () => {
  it('bir günün cirosu her raporda ve Z’de aynı; döküm, KDV ve ödemeler tutar', async () => {
    const tables = h.boot.tables.filter((t) => t.kind !== 'oda');

    // 1) Masa: servis ücreti, kalem indirimi, ikram, gönderildikten sonra iptal; kart + bahşiş
    let a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: tables[0]!.id, guests: 3 });
    a = await add(a, [{ name: 'Latte', size: 'M', qty: 2 }, { name: 'Türk kahvesi', qty: 2 }, { name: 'Espresso', size: 'M' }]);
    const latte = a.items.find((i) => i.name === 'Latte')!;
    const turk = a.items.find((i) => i.name === 'Türk kahvesi')!;
    const esp = a.items.find((i) => i.name === 'Espresso')!;
    await h.ok('kasa', 'POST', `/orders/${a.id}/items/${latte.id}/discount`, { type: 'percent', value: 15, reason: 'Müdavim', approverPin: MUDUR });
    await h.ok('kasa', 'POST', `/orders/${a.id}/items/${turk.id}/comp`, { qty: 1, reason: 'Müdavim', approverPin: MUDUR });
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [esp.id], status: 'hazirlaniyor' }).catch(() => null);
    a = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/items/${esp.id}/void`, { reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    await pay(a, 'Kredi kartı', a.total, 2500);

    // 2) Tezgâh: adisyon indirimi (tutar), nakit; bir ödeme iptal edilip yeniden alınır
    let b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    b = await add(b, [{ name: 'Mocha', size: 'L' }, { name: 'Americano', size: 'M', qty: 3 }]);
    b = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/discount`, { type: 'amount', value: 3333, reason: 'Kampanya', approverPin: MUDUR });
    const half = Math.floor(b.total / 2);
    const first = await pay(b, 'Nakit', half);
    const refunded = first.order.payments.at(-1)!;
    b = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/payments/${refunded.id}/refund`, { reason: 'Yanlış tutar', approverPin: MUDUR });
    await pay(b, 'Nakit', half);
    await pay(b, 'Pluxee', b.total - half);

    // 3) Masa: üç kişiye bölünmüş hesap, kart + nakit + yemek kartı
    let c = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: tables[1]!.id, guests: 2 });
    c = await add(c, [{ name: 'Flat White', size: 'M', qty: 3 }, { name: 'Cortado' }]);
    c = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${c.id}/split`, { people: 3 });
    for (const m of ['Kredi kartı', 'Nakit', 'Multinet']) {
      const cur = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${c.id}`);
      const used = new Set(cur.payments.filter((p) => !p.refundedAt && p.shareNo != null).map((p) => p.shareNo));
      let no = 1;
      while (used.has(no)) no++;
      await h.ok('kasa', 'POST', `/orders/${c.id}/payments`, { methodId: method(m).id, amount: cur.split!.shares[0], shareNo: no, share: true });
    }

    // 4) Tamamı ikram edilen adisyon: ciroya ve adisyon sayısına girmez
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    d = await add(d, [{ name: 'Türk kahvesi' }]);
    d = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${d.id}/items/${d.items[0]!.id}/comp`, { reason: 'Gecikme özrü', approverPin: MUDUR });
    await h.ok('kasa', 'POST', `/orders/${d.id}/close`, {});

    // ─── Raporlar
    const summary = await h.ok<{
      netSales: number;
      receipts: number;
      byDay: { netSales: number }[];
      payments: { amount: number }[];
      waterfall: { list: number; complimentary: number; discounts: number; service: number; revenue: number; kdv: number; netExKdv: number };
      kdv: { gross: number; base: number; kdv: number }[];
      reconciliation: { difference: number; paidClosed: number; paidOpen: number };
      tips: number;
    }>('mudur', 'GET', '/reports/summary');
    const products = await h.ok<{ total: number; service: number; categories: { revenue: number }[] }>('mudur', 'GET', '/reports/products');
    const hourly = await h.ok<{ total: number; hours: { revenue: number }[]; week: { days: number; hours: number[] }[] }>('mudur', 'GET', '/reports/hourly');
    const patron = await h.ok<{ netSales: number; orders: number }>('patron', 'GET', '/reports/patron');

    const N = summary.netSales;
    expect(N).toBeGreaterThan(0);
    // Ürün cirosu servis ücreti hariçtir; servis ayrı satırda, ikisi toplam ciroyu verir
    expect(products.service).toBe(summary.waterfall.service);
    expect(products.total + products.service).toBe(N);
    expect(products.categories.reduce((x, r) => x + r.revenue, 0)).toBe(products.total);
    expect(hourly.total).toBe(N);
    expect(hourly.hours.reduce((x, r) => x + r.revenue, 0)).toBe(N);
    // Tek gün: haftanın günü × saat haritası da aynı ciroyu verir (ortalama bölmesi yok)
    expect(hourly.week.filter((w) => w.days === 1)).toHaveLength(1);
    expect(hourly.week.flatMap((w) => w.hours).reduce((x, v) => x + v, 0)).toBe(N);
    expect(summary.byDay.reduce((x, r) => x + r.netSales, 0)).toBe(N);
    expect(patron.netSales).toBe(N);
    expect(patron.orders).toBe(summary.receipts);
    expect(summary.receipts).toBe(3);

    // Döküm ve KDV
    const w = summary.waterfall;
    expect(w.list - w.complimentary - w.discounts + w.service).toBe(w.revenue);
    expect(w.revenue).toBe(N);
    expect(w.service).toBeGreaterThan(0);
    expect(summary.kdv.reduce((x, k) => x + k.gross, 0)).toBe(N);
    for (const k of summary.kdv) expect(k.base + k.kdv).toBe(k.gross);
    expect(w.netExKdv).toBe(N - summary.kdv.reduce((x, k) => x + k.kdv, 0));

    // Ödemeler: iptal edilen ödeme sayılmaz, bahşiş ayrı; kapanmış adisyonların ödemeleri ciroya eşit
    expect(summary.reconciliation).toMatchObject({ difference: 0, paidOpen: 0, paidClosed: N });
    expect(summary.payments.reduce((x, p) => x + p.amount, 0)).toBe(N);
    expect(summary.tips).toBe(2500);

    // Z aynı rakamı yazar
    const closed = await h.ok<{ day: { id: string }; summary: { netSales: number; kdv: { gross: number }[]; tips: number; payments: { amount: number }[] } }>('mudur', 'POST', '/cash/day/close', { countedCash: null });
    expect(closed.summary.netSales).toBe(N);
    expect(closed.summary.kdv.reduce((x, k) => x + k.gross, 0)).toBe(N);
    expect(closed.summary.payments.reduce((x, p) => x + p.amount, 0)).toBe(N);
    expect(closed.summary.tips).toBe(2500);
  });

  it('kıyas dönemi hizalı: hafta haftayla, ayın başı önceki ayın aynı günleriyle, bugün aynı saate kadar', async () => {
    const { comparison } = await import('../server/services/reports');
    const wed = Date.parse('2026-10-28T12:00:00+03:00');
    expect(comparison({ from: '2026-10-26', to: '2026-10-28' }, wed)).toMatchObject({ range: { from: '2026-10-19', to: '2026-10-21' }, label: 'geçen haftanın aynı günleri, aynı saate kadar' });
    expect(comparison({ from: '2026-10-01', to: '2026-10-26' }, wed).range).toEqual({ from: '2026-09-01', to: '2026-09-26' });
    expect(comparison({ from: '2026-03-01', to: '2026-03-31' }, wed).range).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(comparison({ from: '2026-10-05', to: '2026-10-18' }, wed)).toMatchObject({ range: { from: '2026-09-21', to: '2026-10-04' }, cutoffMs: null });
  });
});
