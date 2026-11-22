import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Kapanmış siparişi iptal (sahibin isteği, 22 Kas 2026): Siparişler › kapananlarda uzun basış ya da dökümdeki düğme.
 * Ödemeler ve adisyon tek işlemde iptal edilir; yetkili onayı ister; yalnız bugünün kasa siparişi.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (kind: string) => h.boot.paymentMethods.find((m) => m.kind === kind)!;
async function paidOrder(kind: 'kart' | 'nakit') {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  const withItems = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, qty: 2 }] });
  await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(kind).id, amount: withItems.total });
  return h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
}

describe('kapanmış siparişi iptal', () => {
  it('yetkili onayı ister; onayla ödeme ve kalemler iptal, sipariş iptal durumunda, ciroya girmez', async () => {
    const o = await paidOrder('kart');
    expect(o.status).toBe('kapali');
    // Kasiyerin kendi yetkisi yok: onay istenir, hiçbir şey değişmez
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/cancel-closed`, { reason: 'Müşteri vazgeçti' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('approval_required');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    // Neden boşsa ret
    expect((await h.call('kasa', 'POST', `/orders/${o.id}/cancel-closed`, { reason: ' ', approverPin: PINS.mudur })).status).toBe(400);
    const after = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/cancel-closed`, { reason: 'Müşteri vazgeçti', approverPin: PINS.mudur });
    expect(after.status).toBe('iptal');
    expect(after.payments.every((p) => p.refundedAt)).toBe(true);
    expect(after.items.every((i) => i.voided)).toBe(true);
    const summary = await h.ok<{ netSales: number }>('patron', 'GET', '/reports/summary');
    expect(summary.netSales).toBe(0);
    // İkinci kez iptal edilmez
    expect((await h.call('kasa', 'POST', `/orders/${o.id}/cancel-closed`, { reason: 'Tekrar', approverPin: PINS.mudur })).status).toBe(409);
  });

  it('müdür kendi yetkisiyle onaysız iptal eder; açık sipariş bu yolla iptal edilmez', async () => {
    const o = await paidOrder('nakit');
    const after = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/cancel-closed`, { reason: 'Yanlış sipariş' });
    expect(after.status).toBe('iptal');
    const open = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect((await h.call('mudur', 'POST', `/orders/${open.id}/cancel-closed`, { reason: 'X' })).status).toBe(409);
  });
});

describe('kalem kalem iade', () => {
  it('seçilen adet iade edilir; kalan aynı ödeme türüyle yeniden yazılır, sipariş kapalı kalır; rapor net iadeyi gösterir', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const withItems = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, qty: 3 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: withItems.total });
    const item = withItems.items[0]!;
    const unit = item.unitPrice;
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: item.id, qty: 1 }], reason: 'Soğuk geldi' });
    expect(denied.json.code).toBe('approval_required');
    const after = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: item.id, qty: 1 }], reason: 'Soğuk geldi', approverPin: PINS.mudur });
    expect(after.status).toBe('kapali');
    expect(after.total).toBe(withItems.total - unit);
    const full = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    const live = full.payments.filter((p) => !p.refundedAt);
    expect(live.every((p) => p.methodName === 'Nakit')).toBe(true);
    expect(live.reduce((a, p) => a + p.amount, 0)).toBe(after.total);
    const refunds = await h.ok<{ total: number; rows: { amount: number }[] }>('patron', 'GET', '/reports/refunds');
    expect(refunds.rows.some((r) => r.amount === unit)).toBe(true);
  });

  it('bütün kalemler iade edilirse sipariş iptal olur', async () => {
    const o = await paidOrder('kart');
    const after = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: o.items.map((i) => ({ itemId: i.id, qty: i.qty })), reason: 'Yanlış sipariş' });
    expect(after.status).toBe('iptal');
  });
});
