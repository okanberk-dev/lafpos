import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Yazarkasa (ÖKC) denetimi, 27 Eki 2026: cihaz sepeti, sonuçlar, fiş iptali ve birleşen adisyon. Her bulgu bir
 * testle. Token'a gerçek istek gitmez: `fetch` sahte (Token sunucusu gibi yanıt verir), çoğu akış eğitim cihazıyla.
 */
const SECRET = 'whsec-0123456789abcdef';
const BASE = 'http://tokenx.test';
const MUDUR = PINS.mudur;

let h: Harness;
/** Sahte Token: anlık sepet isteğinin davranışı ve sepet sorgusunun cevabı */
let instant = 'ok' as 'ok' | 'timeout' | 'reject' | ((basket: TokenBasket) => Promise<void>);
const details = new Map<string, unknown>();
const calls: string[] = [];

type TokenBasket = { basketID: string; items: BasketLine[] };
type BasketLine = { name: string; price: number; quantity: number; taxPercent: number; adjust?: { totalValue?: number } };
type Receipt = { id: string; orderId: string; status: string; amount: number; error: string | null; basket: TokenBasket };

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const verb = init?.method ?? 'GET';
    calls.push(`${verb} ${u.pathname}`);
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/auth/token') return json(200, { status: 0, result: { accessToken: 'tok', expiresIn: 900 } });
    if (u.pathname === '/v1/instant-basket') {
      const b = JSON.parse(init!.body!) as TokenBasket;
      details.set(b.basketID, { basketID: b.basketID, isLocked: false, deletedAt: null, sale: null });
      if (instant === 'reject') {
        details.delete(b.basketID);
        return json(200, { status: 1100, description: 'open basket' });
      }
      if (instant === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (typeof instant === 'function') {
        await instant(b);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return json(200, { status: 0, result: {} });
    }
    const m = u.pathname.match(/^\/v1\/basket\/([^/]+)$/);
    if (m && verb === 'GET') return details.has(m[1]) ? json(200, { status: 0, result: details.get(m[1]) }) : json(200, { status: 1006, description: 'not found' });
    if (m && verb === 'DELETE') {
      details.set(m[1], { basketID: m[1], deletedAt: new Date().toISOString(), sale: null });
      return json(200, { status: 0, result: {} });
    }
    return json(200, { status: 0, result: {} });
  });
  h = await startApp({
    TOKENX_AUTH_URL: BASE,
    TOKENX_BASKET_URL: BASE,
    TOKENX_CLIENT_ID: 'id',
    TOKENX_CLIENT_SECRET: 'secret',
    TOKENX_TERMINAL_ID: 'T1',
    TOKENX_WEBHOOK_SECRET: SECRET,
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const tables = () => h.boot.tables.filter((t) => t.kind === 'masa');
const provider = (p: 'simulator' | 'tokenx') => h.ok('patron', 'PUT', '/okc/settings', { provider: p, mode: 'anlik' });
const getOrder = (id: string) => h.ok<OrderDTO>('mudur', 'GET', `/orders/${id}`);
const receipts = (orderId: string) => h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${orderId}/receipts`);
const send = async (orderId: string, items?: { itemId: string; qty: number }[]) => (await h.ok<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${orderId}/send`, items ? { items } : {})).receipt;
const simPay = (id: string, payments: { type: number; amount: number }[]) => h.ok<Receipt>('kasa', 'POST', `/okc/simulator/baskets/${id}/pay`, { payments });
const simVoid = (id: string) => h.call<{ code?: string }>('kasa', 'POST', `/okc/simulator/baskets/${id}/cancel`, { voidReceipt: true, approverPin: MUDUR });
const webhook = (data: Record<string, unknown>) => h.call('', 'POST', '/public/okc/tokenx/webhook', { operation: 'BASKET_COMPLETED', data }, { authorization: `Bearer ${SECRET}` });
const audits = () => h.ok<{ action: string; severity: string; orderId: string | null; message: string; amount: number | null }[]>('patron', 'GET', '/admin/audit?limit=1000');

async function order(items: { name: string; qty?: number; size?: 'M' | 'L' }[], extra: Record<string, unknown> = { type: 'tezgah' }) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', extra);
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}

/** Cihaz fişlerinin KDV oranına göre brüt toplamı (fiyat x adet - indirim payı) */
function deviceByRate(list: TokenBasket[]) {
  const acc: Record<string, number> = {};
  for (const b of list) {
    for (const it of b.items) {
      const rate = String(it.taxPercent / 100);
      acc[rate] = (acc[rate] ?? 0) + (it.price * it.quantity) / 1000 - (it.adjust?.totalValue ?? 0);
    }
  }
  return acc;
}
const lafposByRate = (o: OrderDTO) => Object.fromEntries(o.totals.kdv.map((k) => [String(k.rate), k.gross]));

describe('yazarkasa denetimi', () => {
  it('gün açılır, eğitim cihazı seçilir', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await provider('simulator');
  });

  it('birleşen adisyonda fiş iptali: ödeme hedef adisyondan düşer, hedef yeniden açılır; fiş hedefe taşınır', async () => {
    const [ta, tb] = tables().slice(0, 2);
    const a = await order([{ name: 'Türk kahvesi' }, { name: 'Latte', size: 'M' }], { type: 'masa', tableId: ta.id });
    const tk = a.items.find((i) => i.name === 'Türk kahvesi')!;
    const r = await send(a.id, [{ itemId: tk.id, qty: 1 }]);
    await simPay(r.id, [{ type: 3, amount: r.amount }]);
    const b = await order([{ name: 'Türk kahvesi' }], { type: 'masa', tableId: tb.id });
    const merged = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/merge`, { sourceOrderId: a.id, approverPin: MUDUR });
    expect(merged.paid).toBe(r.amount);
    expect((await receipts(b.id)).map((x) => x.id)).toContain(r.id);
    await h.ok('kasa', 'POST', `/orders/${b.id}/payments`, { methodId: method('Nakit').id, amount: merged.total - merged.paid });
    expect((await getOrder(b.id)).status).toBe('kapali');

    expect((await simVoid(r.id)).status).toBe(200);
    const after = await getOrder(b.id);
    const live = after.payments.filter((p) => !p.refundedAt).reduce((s, p) => s + p.amount, 0);
    expect(after).toMatchObject({ status: 'acik', total: merged.total, paid: live });
    expect(after.total - after.paid).toBe(r.amount);
    expect(after.items.find((i) => i.id === tk.id)?.paidQty).toBe(0);
    expect((await audits()).find((x) => x.action === 'okc.void')).toMatchObject({ orderId: b.id });
    await h.ok('kasa', 'POST', `/orders/${b.id}/payments`, { methodId: method('Nakit').id, amount: after.total - after.paid });
  });

  it('LafPOS’ta iade edilmiş ödemenin fişi cihazda iptal edilince kapalı adisyon açılmaz', async () => {
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Fiş iptali deneme' });
    const o = await order([{ name: 'Türk kahvesi' }, { name: 'Latte', size: 'M' }], { type: 'tezgah', customerId: cust.id });
    const tk = o.items.find((i) => i.name === 'Türk kahvesi')!;
    const r = await send(o.id, [{ itemId: tk.id, qty: 1 }]);
    await simPay(r.id, [{ type: 3, amount: r.amount }]);
    const paid = await getOrder(o.id);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments/${paid.payments[0].id}/refund`, { reason: 'Kart hatalı', approverPin: MUDUR });
    const closed = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    expect(closed.closed).toBe(true);
    const visits = (await h.ok<{ customer: { visits: number } }>('kasa', 'GET', `/customers/${cust.id}`)).customer.visits;

    expect((await simVoid(r.id)).status).toBe(200);
    expect(await getOrder(o.id)).toMatchObject({ status: 'kapali', paid: o.total });
    expect((await h.ok<{ customer: { visits: number } }>('kasa', 'GET', `/customers/${cust.id}`)).customer.visits).toBe(visits);
    const voided = (await audits()).find((x) => x.action === 'okc.void' && x.orderId === o.id)!;
    expect(voided.message).not.toContain('yeniden açıldı');
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
  });

  // Gün kapanır: bundan sonra test yok
  it('kapanmış güne ait fiş iptali (webhook) Z’yi değiştirmez; ödeme geri alınmaz, yöneticiye alarm düşer', async () => {
    const o = await order([{ name: 'Latte', size: 'L', qty: 2 }]);
    const r = await send(o.id);
    await simPay(r.id, [{ type: 1, amount: r.amount }]);
    expect((await getOrder(o.id)).status).toBe('kapali');
    const x = await h.ok<{ day: { id: string; date: string }; summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closed = await h.ok<{ summary: { netSales: number } }>('mudur', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });

    const res = await webhook({ basketID: r.id, status: 99 });
    expect(res.status).toBe(200);
    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'kapali', paid: o.total });
    expect(after.payments.every((p) => !p.refundedAt)).toBe(true);
    const report = await h.ok<{ netSales: number }>('mudur', 'GET', `/reports/summary?from=${x.day.date}&to=${x.day.date}`);
    expect(report.netSales).toBe(closed.summary.netSales);
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
    const alarm = (await audits()).find((a) => a.action === 'okc.void_closed_day');
    expect(alarm).toMatchObject({ severity: 'alarm', orderId: o.id, amount: r.amount });
    // Aynı sonuç ikinci kez gelirse bir şey değişmez
    await webhook({ basketID: r.id, status: 99 });
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
  });
});
