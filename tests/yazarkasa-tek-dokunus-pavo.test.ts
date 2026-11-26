import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { pavoOrderNo, pavoTiming } from '../server/okc/providers/pavo';
import { type FakePavo, startFakePavo } from './fake-pavo';
import { type Harness, startApp } from './harness';

/** Yazarkasa tek dokunuşla, Pavo (sahte cihaz): cihaz reddeder ya da kasiyer vazgeçerse adisyon açık kalır, yeniden deneme yeni tek sepet */

type Receipt = { id: string; status: string };
type Sent = { receipt: Receipt; order: OrderDTO };

describe('Pavo: ret ve ulaşılamayan cihaz', () => {
  let device: FakePavo;
  let h: Harness;
  beforeAll(async () => {
    pavoTiming.sendWaitMs = 300;
    pavoTiming.askEveryMs = 0;
    device = await startFakePavo();
    h = await startApp({ PAVO_URL: device.url, PAVO_SERIAL: device.serial, PAVO_FINGERPRINT: 'AsilPOS-test' });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
    await h.ok('patron', 'POST', '/okc/pair');
  });
  let closed = false;
  afterAll(async () => {
    if (!closed) await device.close();
    h.cleanup();
  });
  const newOrder = async () => {
    const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty: 1 }] });
  };

  it('cihaz hemen reddederse kasiyer nedeni görür, adisyon açık kalır; yeniden deneme yeni sepetle ödenir', async () => {
    const o = await newOrder();
    device.nextSaleReply = { HasError: true, HasAbondon: false, ErrorCode: '5001', Message: 'Kağıt yok', Data: null };
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('Kağıt yok');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    const retry = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    device.pay(pavoOrderNo(retry.receipt.id), [{ type: 2, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000101' });
    await new Promise((res) => setTimeout(res, 50));
    await h.ok('kasa', 'POST', `/okc/receipts/${retry.receipt.id}/refresh`);
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    expect(closed.status).toBe('kapali');
    expect(closed.payments).toHaveLength(1);
  });

  it('paylaşımlı hesap (hiç pay alınmamış) Pavo’ya bütün olarak tek sepetle gider; cihazda iki ödeme, adisyon kapanır', async () => {
    const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty: 2 }] });
    await h.ok('kasa', 'PUT', `/orders/${o.id}/split`, { people: 2 });
    const sent = await h.ok<Sent & { receipt: { amount: number } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(sent.receipt.amount).toBe(o.total);
    const half = o.total / 2;
    device.pay(pavoOrderNo(sent.receipt.id), [{ type: 2, amount: half / 100 }, { type: 2, amount: half / 100 }], { invoiceNo: 'LAF2026000000102' });
    await new Promise((res) => setTimeout(res, 50));
    await h.ok('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/refresh`);
    const closed = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    expect(closed.status).toBe('kapali');
    expect(closed.paid).toBe(o.total);
  });

  it('kasiyer cihazda vazgeçerse sepet kapanır, ödeme yazılmaz', async () => {
    const o = await newOrder();
    const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    device.abandon(pavoOrderNo(sent.receipt.id));
    await new Promise((res) => setTimeout(res, 50));
    await h.ok('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/refresh`);
    const list = await h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${o.id}/receipts`);
    expect(list[0]!.status).not.toMatch(/gonderildi|kilitli|tamamlandi/);
    const still = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(still).toMatchObject({ status: 'acik', paid: 0 });
  });

  it('cihaza ulaşılamazsa kasiyer sade nedeni görür; sepet hataya düşer, adisyon kilitlenmez', async () => {
    const o = await newOrder();
    await device.close();
    closed = true;
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/Yazarkasaya gönderilemedi: Cihaz/);
    const list = await h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${o.id}/receipts`);
    expect(list.map((x) => x.status)).toEqual(['hata']);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
  });
});
