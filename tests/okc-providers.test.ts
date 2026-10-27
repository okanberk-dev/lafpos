import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { clampPayments } from '../server/okc/basket';
import { providerFor } from '../server/okc/providers';
import { fromTokenxSale } from '../server/okc/providers/tokenx';
import { type Harness, startApp } from './harness';

/** Yazarkasa sağlayıcı katmanı: markanın cevabı ortak sonuca doğru çevrilir, akış her marka için aynı işler */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;

describe('Token sonucu → ortak sonuç', () => {
  it('ödendi: ödemeler sepet tutarına kırpılır, ikram ve ödemesiz kalem düşer, belge mali fiş', () => {
    const r = fromTokenxSale(
      { basketID: 'b', status: 0, zNo: 12, receiptNo: 34, paymentItems: [{ type: 3, amount: 6000 }, { type: 9, amount: 500 }, { type: 1, amount: 5000 }] },
      10000,
    );
    expect(r).toMatchObject({ status: 'paid', docKind: 'okc_fis', zNo: 12, receiptNo: 34, docId: null });
    expect(r.payments).toEqual([
      { kind: 'kart', amount: 6000, operatorId: null, description: null },
      { kind: 'nakit', amount: 4000, operatorId: null, description: null },
    ]);
  });

  it('yemek kartı bilgi fişi, e-belge kimliği saklanır; 99 fiş iptali, -1 vazgeçme ödemesiz', () => {
    expect(fromTokenxSale({ basketID: 'b', status: 0, paymentItems: [{ type: 7, amount: 100, operatorId: 1005 }] }, 100)).toMatchObject({
      docKind: 'bilgi_fisi',
      payments: [{ kind: 'yemek', operatorId: 1005 }],
    });
    expect(fromTokenxSale({ basketID: 'b', status: 0, invoiceID: 'GIB2026000000001', paymentItems: [{ type: 3, amount: 100 }] }, 100)).toMatchObject({ docId: 'GIB2026000000001' });
    expect(fromTokenxSale({ basketID: 'b', status: 99, paymentItems: [{ type: 3, amount: 100 }] }, 100)).toMatchObject({ status: 'voided', payments: [] });
    expect(fromTokenxSale({ basketID: 'b', status: -1 }, 100)).toMatchObject({ status: 'cancelled', payments: [] });
  });

  it('kırpma: toplamı aşan kısım atılır, sıfır ve eksi kalem düşer', () => {
    expect(clampPayments([{ amount: 700 }, { amount: -5 }, { amount: 0 }, { amount: 500 }, { amount: 100 }], 1000)).toEqual([{ amount: 700 }, { amount: 300 }]);
  });

  it('kayıt: bilinmeyen sağlayıcı yok sayılır; Token ve eğitim cihazının yetenekleri açık', () => {
    expect(providerFor('pavo')).toBeNull();
    expect(providerFor('tokenx')?.capabilities).toMatchObject({ transport: 'push', poll: true, splitPayment: true });
    expect(providerFor('simulator')?.capabilities).toMatchObject({ transport: 'local', poll: false });
  });
});

describe('akış', () => {
  it('e-Arşiv sonucu adisyonu kapatır; ödeme notu ve fişte belge no kalır', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 2 }] });
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    const { applyResult } = await import('../server/okc/service');
    const result = { status: 'paid' as const, docKind: 'e_arsiv' as const, zNo: null, receiptNo: null, docId: 'LAF2026000000042', payments: [{ kind: 'kart' as const, amount: sent.receipt.amount, operatorId: null, description: null }] };
    applyResult(sent.receipt.id, result, 'cihaz');
    applyResult(sent.receipt.id, result, 'cihaz'); // aynı sonuç ikinci kez: işlem tekrarlanmaz
    // Kör kasada kapanmış adisyonun ödemeleri kasiyere gitmez; müdür görür
    const paid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(paid).toMatchObject({ status: 'kapali', paid: o.total });
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]!.note).toBe('Yazarkasa e-Arşiv LAF2026000000042');
    const [receipt] = await h.ok<{ status: string }[]>('kasa', 'GET', `/okc/orders/${o.id}/receipts`);
    expect(receipt).toMatchObject({ status: 'tamamlandi', docKind: 'e_arsiv', docId: 'LAF2026000000042' });
  });

  it('Token seçili ama bilgileri yoksa sepet gitmez, eksik ayarlar adıyla söylenir', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'tokenx' });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'okc_not_configured' });
    expect(r.json.error).toContain('TOKENX_CLIENT_ID');
    const test = await h.call<{ code: string }>('patron', 'POST', '/okc/test', {});
    expect(test.json.code).toBe('okc_not_configured');
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
  });
});
