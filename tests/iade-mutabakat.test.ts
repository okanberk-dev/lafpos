import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * İadeli bir günde raporlar birbirini tutar (inceleme, 23 Kas 2026): kalem iadesi (indirimli adisyonda, karışık ödemede,
 * paylaşımlı hesapta, aynı adisyonda iki kez ve ardından kapanmış siparişin iptali) sonrasında ciro; özet, ürün,
 * saatlik, patron, personel, adisyon listesi ve Z'de aynı; ödemeler ciroya, KDV dökümü ciroya eşit; iade raporu geri
 * verilen tutarların toplamı (çift sayım yok); Z'nin nakit ve kart alanı canlı ödemelerin toplamı; beklenen nakit açılış
 * artı nakit tahsilat (bahşiş dahil); lafmaliyet paketinin satırları Z toplamını verir.
 */
let h: Harness;
const MUDUR = PINS.mudur;
type Refund = { order: OrderDTO; refunded: number; methods: { name: string; zField: string; amount: number }[] };

beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 50000 });
}, 60_000);
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const add = (o: OrderDTO, items: { name: string; qty?: number; size?: 'M' | 'L' }[]) =>
  h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
const pay = (o: OrderDTO, name: string, amount: number, tip = 0) => h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(name).id, amount, tip });
const full = (o: OrderDTO) => h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
const refund = (o: OrderDTO, items: { itemId: string; qty: number }[]) =>
  h.ok<Refund>('kasa', 'POST', `/orders/${o.id}/refund-items`, { items, reason: 'Müşteri iade etti', expectTotal: o.total, approverPin: MUDUR });

describe('iadeli günün mutabakatı', () => {
  it('ciro, ödemeler, KDV, iade raporu, Z ve lafmaliyet paketi birbirini tutar', async () => {
    const refunded: number[] = [];

    // 1) Yüzde indirimli adisyon, kart: bir latte iade
    let a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    a = await add(a, [{ name: 'Latte', size: 'M', qty: 3 }]);
    a = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/discount`, { type: 'percent', value: 20, reason: 'Kampanya', approverPin: MUDUR });
    await pay(a, 'Kredi kartı', a.total);
    a = await full(a);
    const ra = await refund(a, [{ itemId: a.items[0]!.id, qty: 1 }]);
    refunded.push(ra.refunded);
    expect(ra.order.status).toBe('kapali');

    // 2) Tutar indirimli adisyon, yarı nakit yarı kart: bir mocha iade (son alınan ödemeden başlar)
    let b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    b = await add(b, [{ name: 'Mocha', size: 'L', qty: 2 }, { name: 'Americano', size: 'M' }]);
    b = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/discount`, { type: 'amount', value: 3333, reason: 'Kampanya', approverPin: MUDUR });
    const half = Math.floor(b.total / 2);
    await pay(b, 'Nakit', half);
    await pay(b, 'Kredi kartı', b.total - half);
    b = await full(b);
    const mocha = b.items.find((i) => i.name === 'Mocha')!;
    const rb = await refund(b, [{ itemId: mocha.id, qty: 1 }]);
    refunded.push(rb.refunded);
    expect(rb.methods.reduce((x, m) => x + m.amount, 0)).toBe(rb.refunded);

    // 3) Nakit ve bahşiş: iki ayrı iade, ardından kapanmış siparişin iptali
    let c = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    c = await add(c, [{ name: 'Espresso', size: 'M', qty: 3 }]);
    await pay(c, 'Nakit', c.total, 1500);
    c = await full(c);
    const rc1 = await refund(c, [{ itemId: c.items[0]!.id, qty: 1 }]);
    refunded.push(rc1.refunded);
    c = await full(c);
    const rc2 = await refund(c, [{ itemId: c.items.find((i) => !i.voided)!.id, qty: 1 }]);
    refunded.push(rc2.refunded);
    c = await full(c);
    const before = c.total;
    const cancelled = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${c.id}/cancel-closed`, { reason: 'Hepsi iade', approverPin: MUDUR });
    expect(cancelled.status).toBe('iptal');
    refunded.push(before);

    // 4) İki kişiye bölünmüş hesap (nakit + kart): bir kalem iade
    const masa = h.boot.tables.filter((t) => t.kind === 'masa')[2]!;
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: masa.id, guests: 2 });
    d = await add(d, [{ name: 'Flat White', size: 'M', qty: 2 }, { name: 'Cortado' }]);
    d = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${d.id}/split`, { people: 2 });
    for (const [m, no] of [['Nakit', 1], ['Kredi kartı', 2]] as const) {
      const cur = await full(d);
      await h.ok('kasa', 'POST', `/orders/${d.id}/payments`, { methodId: method(m).id, amount: cur.split!.shares[0], shareNo: no, share: true });
    }
    d = await full(d);
    expect(d.status).toBe('kapali');
    const rd = await refund(d, [{ itemId: d.items.find((i) => i.name === 'Cortado')!.id, qty: 1 }]);
    refunded.push(rd.refunded);

    // 5) Karşılaştırma için iadesiz kart satışı
    let e = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    e = await add(e, [{ name: 'Americano', size: 'L' }]);
    await pay(e, 'Kredi kartı', e.total);

    // ─── Raporlar
    const summary = await h.ok<{
      netSales: number;
      receipts: number;
      payments: { amount: number }[];
      kdv: { gross: number; base: number; kdv: number }[];
      reconciliation: { difference: number; paidClosed: number; paidOpen: number };
      tips: number;
    }>('mudur', 'GET', '/reports/summary');
    const products = await h.ok<{ total: number; service: number }>('mudur', 'GET', '/reports/products');
    const hourly = await h.ok<{ total: number }>('mudur', 'GET', '/reports/hourly');
    const patron = await h.ok<{ netSales: number; orders: number }>('patron', 'GET', '/reports/patron');
    const staff = await h.ok<{ staff: { revenue: number }[] }>('patron', 'GET', '/reports/staff');
    const checks = await h.ok<{ rows: { status: string; total: number }[] }>('mudur', 'GET', '/reports/checks');
    const refunds = await h.ok<{ total: number; rows: { amount: number }[] }>('patron', 'GET', '/reports/refunds');

    const orders = await Promise.all([a, b, c, d, e].map(full));
    const N = orders.filter((o) => o.status === 'kapali').reduce((x, o) => x + o.total, 0);
    expect(N).toBeGreaterThan(0);
    expect(summary.netSales).toBe(N);
    expect(products.total + products.service).toBe(N);
    expect(hourly.total).toBe(N);
    expect(patron.netSales).toBe(N);
    expect(staff.staff.reduce((x, r) => x + r.revenue, 0)).toBe(N);
    expect(checks.rows.filter((r) => r.status === 'kapali').reduce((x, r) => x + r.total, 0)).toBe(N);
    expect(summary.receipts).toBe(4);
    expect(patron.orders).toBe(summary.receipts);
    expect(summary.reconciliation).toMatchObject({ difference: 0, paidOpen: 0, paidClosed: N });
    expect(summary.payments.reduce((x, p) => x + p.amount, 0)).toBe(N);
    expect(summary.kdv.reduce((x, k) => x + k.gross, 0)).toBe(N);
    for (const k of summary.kdv) expect(k.base + k.kdv).toBe(k.gross);
    // Bahşiş iadeden sonra da kalan ödemede durur; iptal edilen siparişin bahşişi düşer
    expect(summary.tips).toBe(0);
    // İade raporu: geri verilen tutarların toplamı, çift sayım yok
    expect(refunds.total).toBe(refunded.reduce((x, v) => x + v, 0));

    // Canlı ödemeler Z alanlarını verir; beklenen nakit = açılış + nakit tahsilat (bahşiş dahil)
    const live = orders.flatMap((o) => o.payments.filter((p) => !p.refundedAt));
    const sum = (field: string) => live.filter((p) => p.zField === field).reduce((x, p) => x + p.amount, 0);
    const cashTips = live.filter((p) => p.zField === 'cash').reduce((x, p) => x + p.tip, 0);
    const x = await h.ok<{ summary: { expectedCash: number; byZField: Record<string, number> } }>('mudur', 'GET', '/cash/day');
    expect(x.summary.byZField.cash).toBe(sum('cash'));
    expect(x.summary.byZField.card).toBe(sum('card'));
    expect(x.summary.expectedCash).toBe(50000 + sum('cash') + cashTips);

    // Z ve lafmaliyet paketi
    const closed = await h.ok<{ day: { id: string }; summary: { netSales: number; payments: { amount: number }[] } }>('mudur', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
    expect(closed.summary.netSales).toBe(N);
    expect(closed.summary.payments.reduce((x2, p) => x2 + p.amount, 0)).toBe(N);
    const payload = await h.ok<{ z: { zTotal: number | null; cash: number; card: number }; lines: { revenue: number }[] }>('patron', 'GET', `/sync/lafmaliyet/gun/${closed.day.id}`);
    expect(payload.z.zTotal).toBeCloseTo(N / 100, 2);
    expect(payload.lines.reduce((x2, l) => x2 + l.revenue, 0)).toBeCloseTo(N / 100, 2);
    expect(payload.z.cash).toBeCloseTo(sum('cash') / 100, 2);
    expect(payload.z.card).toBeCloseTo(sum('card') / 100, 2);
  });
});
