import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Kalem iadesinde ödeme iptal edilip kalanı yeniden yazılır (orders.refundItems). Yeniden yazılan ödeme öncekinin
 * devamıdır (inceleme, 23 Kas 2026): yazarkasadan geçmiş satışın kalanı "Yazarkasadan geçmeyen"e düşmez, bahşiş
 * kalan ödemede durur.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
}, 60_000);
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (kind: string) => h.boot.paymentMethods.find((m) => m.kind === kind)!;
type Day = { summary: { offDevice: { card: number; cash: number }; tips: number; byZField: Record<string, number> } };
const day = async () => (await h.ok<Day>('patron', 'GET', '/cash/day')).summary;

describe('kalem iadesi: yeniden yazılan ödeme öncekinin devamıdır', () => {
  it('yazarkasadan geçen satışın kalanı yazarkasadan geçmiş sayılır', async () => {
    const o0 = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    const o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o0.id}/items`, { items: [{ productId: product('Latte').id, qty: 3 }] });
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    const before = await day();
    expect(before.offDevice.card).toBe(0);
    const res = await h.ok<{ order: OrderDTO; refunded: number }>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: o.items[0]!.id, qty: 1 }], reason: 'Soğuk geldi' });
    expect(res.order.status).toBe('kapali');
    expect(res.refunded).toBe(product('Latte').price);
    const after = await day();
    expect(after.byZField.card).toBe(before.byZField.card! - res.refunded);
    // Kalan iki latte cihazda kesilen fişin parçası: "Yazarkasadan geçmeyen"e düşmez
    expect(after.offDevice).toEqual(before.offDevice);
  });

  it('bahşiş kalan ödemede durur; günün bahşişi ve beklenen nakit bahşişi kaybetmez', async () => {
    const o0 = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    const o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o0.id}/items`, { items: [{ productId: product('Latte').id, qty: 3 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: o.total, tip: 2000 });
    const before = await day();
    expect(before.tips).toBe(2000);
    await h.ok('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: o.items[0]!.id, qty: 1 }], reason: 'Soğuk geldi' });
    const live = (await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`)).payments.filter((p) => !p.refundedAt);
    expect(live.map((p) => [p.amount, p.tip])).toEqual([[2 * product('Latte').price, 2000]]);
    expect((await day()).tips).toBe(before.tips);
  });

  it('ödeme hiç kalmıyorsa bahşişi de geri verilir ve geri verilenin içinde yazılır: kasadan çıkan beklenen nakdin düştüğü kadar', async () => {
    const latte = product('Latte');
    // Kart ₺195, sonra nakit ₺195 + ₺20 bahşiş; bir latte iadesi son alınan (nakit) ödemeyi bütünüyle geri verir
    const o0 = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    const o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o0.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('kart').id, amount: latte.price });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: latte.price, tip: 2000 });
    const cashBefore = (await h.ok<{ summary: { expectedCash: number } }>('patron', 'GET', '/cash/day')).summary.expectedCash;
    const res = await h.ok<{ refunded: number; methods: { zField: string; amount: number }[] }>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: o.items[0]!.id, qty: 1 }], reason: 'İade' });
    expect(res.refunded).toBe(latte.price);
    expect(res.methods).toEqual([expect.objectContaining({ zField: 'cash', amount: latte.price + 2000 })]);
    const cashAfter = (await h.ok<{ summary: { expectedCash: number } }>('patron', 'GET', '/cash/day')).summary.expectedCash;
    expect(cashBefore - cashAfter).toBe(latte.price + 2000);
  });

  it('cihazda ödenen satışın bekleyen işyeri nüshası iadeden sonra iade edilen ödemeyi yazmaz', async () => {
    const o0 = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
    const o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o0.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 3 }] });
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null, storeCopy: true });
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    const after = await h.ok<{ order: OrderDTO }>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: o.items[0]!.id, qty: 1 }], reason: 'İade' });
    const copy = (await h.ok<{ id: string; orderId: string }[]>('kasa', 'GET', '/okc/store-copies')).find((c) => c.orderId === o.id);
    expect(copy).toBeTruthy();
    const claimed = await h.ok<{ payments: { amount: number }[] }>('kasa', 'POST', `/okc/store-copies/${copy!.id}/claim`);
    expect(claimed.payments.reduce((x, p) => x + p.amount, 0)).toBe(after.order.total);
  });
});

