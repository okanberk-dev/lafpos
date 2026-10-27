import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** İşletme bahşiş almaz (27 Eki 2026): ayar varsayılan kapalı, sunucu bahşişi reddeder, ödeme ekranında alan yok */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

describe('bahşiş yok', () => {
  it('varsayılan kapalı: bahşişli ödeme 400 tip_disabled, bahşişsiz ödeme alınır', async () => {
    expect(h.boot.settings.tipsEnabled).toBe(false);
    const card = h.boot.paymentMethods.find((m) => m.name === 'Kredi kartı')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, size: 'M', qty: 1 }] });
    const tipped = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card.id, amount: o.total, tip: 1000 });
    expect([tipped.status, tipped.json.code]).toEqual([400, 'tip_disabled']);
    const paid = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card.id, amount: o.total });
    expect(paid.closed).toBe(true);
    expect(paid.order.payments.every((p) => p.tip === 0)).toBe(true);
  });

  it('ödeme ekranı bahşiş alanını yalnız ayar açıkken gösterir', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/order/PaymentModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('boot.settings.tipsEnabled && (');
  });
});
