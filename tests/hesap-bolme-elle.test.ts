import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitEven, tl } from '@shared/money';
import { splitAmountsError, splitState } from '@shared/order-calc';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Hesap bölme: 2-3-4-5-6 hazır sayılar (en çok 30) ve elle paylar. Elle tutarlar siparişte saklanır
 * (`orders.split_amounts`); sunucu doğrular: tam sayı kuruş, her biri > 0, toplam = o anki kalan, adet = ödenmemiş pay.
 * Hesap değişince (kalem, iptal, indirim, ödeme iptali) elle paylar düşer ve kalan yeniden eşit bölünür; bayat tutar
 * hiçbir zaman çekilmez. Pay ödemesi sunucunun hesapladığı pay tutarına göre doğrulanır. Bölüş denetime yazılır.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

type PayResult = { order: OrderDTO; closed: boolean; amount: number; share: { no: number; of: number } | null };
type Audit = { action: string; message: string; orderId: string | null; userName: string | null; amount: number | null; data: Record<string, unknown> | null };

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
async function newOrder(items: { name: string; qty?: number; size?: 'M' | 'L' }[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}
const get = (id: string) => h.ok<OrderDTO>('kasa', 'GET', `/orders/${id}`);
function nextNo(o: OrderDTO) {
  const used = new Set(o.payments.filter((p) => !p.refundedAt && p.shareNo != null).map((p) => p.shareNo));
  let no = 1;
  while (used.has(no)) no++;
  return no;
}
async function payShare(id: string, methodName: string, amount?: number) {
  const o = await get(id);
  return h.call<PayResult & { code?: string; error?: string }>('kasa', 'POST', `/orders/${id}/payments`, { methodId: method(methodName).id, share: true, shareNo: nextNo(o), amount: amount ?? o.split!.shares[0] });
}
const split = (id: string, body: { people: number | null; amounts?: number[] }) => h.call<OrderDTO & { code?: string; error?: string }>('kasa', 'PUT', `/orders/${id}/split`, body);
async function lastSplitAudit(orderId: string) {
  const rows = await h.ok<Audit[]>('patron', 'GET', '/admin/audit?severity=tum&limit=300');
  return rows.find((a) => a.action === 'order.split' && a.orderId === orderId)!;
}

describe('elle payların kuralı (ortak hesap)', () => {
  it('geçerli tutarlar kullanılır, geçersizde eşit bölüşe dönülür', () => {
    expect(splitState(3, 0, 1000, [500, 300, 200])).toEqual({ people: 3, paid: 0, left: 3, shares: [500, 300, 200], manual: true });
    // Toplam kalana eşit değil (hesap değişmiş): bayat tutar kullanılmaz
    expect(splitState(3, 0, 1100, [500, 300, 200])).toEqual({ people: 3, paid: 0, left: 3, shares: splitEven(1100, 3), manual: false });
    // Adet ödenmemiş payla tutmuyor
    expect(splitState(3, 1, 500, [500, 300, 200]).manual).toBe(false);
    expect(splitState(3, 1, 500, [300, 200])).toMatchObject({ shares: [300, 200], manual: true });
    expect(splitState(2, 2, 0, [100]).shares).toEqual([]);
  });

  it('doğrulama: adet, tam kuruş, sıfırdan büyük, toplam kalana eşit', () => {
    expect(splitAmountsError([500, 500], 2, 1000)).toBeNull();
    expect(splitAmountsError([1000], 2, 1000)?.code).toBe('split_amounts_count');
    expect(splitAmountsError([500.5, 499.5], 2, 1000)?.code).toBe('split_amount_kurus');
    expect(splitAmountsError([1000, 0], 2, 1000)?.code).toBe('split_amount_positive');
    expect(splitAmountsError([1100, -100], 2, 1000)?.code).toBe('split_amount_positive');
    expect(splitAmountsError([600, 500], 2, 1000)).toEqual({ code: 'split_amounts_total', message: `Payların toplamı (${tl(1100)}) kalan tutara (${tl(1000)}) eşit olmalı` });
  });
});

describe('hazır kişi sayıları', () => {
  it('2, 3, 4, 5 ve 6 kişiye tek istekte eşit bölünür; 30 en çok, 1 ve 31 olmaz', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 4 }, { name: 'Türk Kahvesi' }]);
    for (const n of [2, 3, 4, 5, 6, 30]) {
      const r = await split(o.id, { people: n });
      expect(r.status, `${n} kişi`).toBe(200);
      expect(r.json.split).toEqual({ people: n, paid: 0, left: n, shares: splitEven(o.total, n), manual: false, reset: false });
    }
    for (const n of [1, 31]) {
      const r = await split(o.id, { people: n });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('split_people');
    }
    const audit = await lastSplitAudit(o.id);
    expect(audit.message).toBe(`#${o.no} hesap 30 kişiye eşit bölündü: ${splitEven(o.total, 30).map(tl).join(' · ')}`);
    expect(audit.data).toMatchObject({ people: 30, mode: 'esit', paidShares: 0 });
  });
});

describe('elle bölüş', () => {
  it('geçerli tutarlar saklanır; paylar sırayla ve sunucunun tutarıyla ödenir; denetimde kim, kaç kişi, elle ve tutarlar', async () => {
    let o = await newOrder([{ name: 'Latte', size: 'M', qty: 3 }, { name: 'Türk Kahvesi' }]);
    const amounts = [o.total - 30000, 20000, 10000];
    const r = await split(o.id, { people: 3, amounts });
    expect(r.status).toBe(200);
    expect(r.json.split).toEqual({ people: 3, paid: 0, left: 3, shares: amounts, manual: true, reset: false });
    const audit = await lastSplitAudit(o.id);
    expect(audit).toMatchObject({ userName: 'Kasa', amount: o.total, message: `#${o.no} hesap 3 kişiye elle bölündü: ${amounts.map(tl).join(' · ')}` });
    expect(audit.data).toEqual({ people: 3, mode: 'elle', shares: amounts, paidShares: 0 });

    // Sıradaki pay sunucunun hesabıdır: başka tutar 409
    const wrong = await payShare(o.id, 'Nakit', amounts[1]);
    expect(wrong.status).toBe(409);
    expect(wrong.json.code).toBe('split_changed');

    const first = await payShare(o.id, 'Nakit');
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ amount: amounts[0], share: { no: 1, of: 3 }, closed: false });
    expect(first.json.order.split).toEqual({ people: 3, paid: 1, left: 2, shares: amounts.slice(1), manual: true, reset: false });

    const second = await payShare(o.id, 'Kredi kartı');
    expect(second.json).toMatchObject({ amount: amounts[1], share: { no: 2, of: 3 } });
    const third = await payShare(o.id, 'Nakit');
    expect(third.json).toMatchObject({ amount: amounts[2], share: { no: 3, of: 3 }, closed: true });
    // Kör kasada kapanmış adisyonun ödeme dökümü kasiyere gizli: müdür okur
    o = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(o.payments.filter((p) => !p.refundedAt).map((p) => [p.shareNo, p.amount])).toEqual([
      [1, amounts[0]],
      [2, amounts[1]],
      [3, amounts[2]],
    ]);
  });

  it('yanlış toplam, sıfır ya da eksi pay, kesirli kuruş ve eksik adet reddedilir; hiçbir şey yazılmaz', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    const cases: [number[], string][] = [
      [[o.total, 100], 'split_amounts_total'],
      [[o.total, 0], 'split_amount_positive'],
      [[o.total + 100, -100], 'split_amount_positive'],
      [[o.total - 50.5, 50.5], 'split_amount_kurus'],
      [[o.total], 'split_amounts_count'],
    ];
    for (const [amounts, code] of cases) {
      const r = await split(o.id, { people: 2, amounts });
      expect(r.status, code).toBe(400);
      expect(r.json.code).toBe(code);
      expect(typeof r.json.error === 'string' && r.json.error.length > 0).toBe(true);
    }
    expect((await split(o.id, { people: null, amounts: [o.total] })).status).toBe(400);
    expect((await get(o.id)).split).toBeNull();
  });

  it('pay ödendikten sonra kalan paylar elle girilir: adet ödenmemiş pay sayısı, toplam kalan', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 4 }]);
    await split(o.id, { people: 4 });
    const first = await payShare(o.id, 'Nakit');
    const left = first.json.order.total - first.json.order.paid;
    expect((await split(o.id, { people: 4, amounts: [left] })).json.code).toBe('split_amounts_count');
    const r = await split(o.id, { people: 4, amounts: [left - 2000, 1000, 1000] });
    expect(r.status).toBe(200);
    expect(r.json.split).toMatchObject({ paid: 1, left: 3, shares: [left - 2000, 1000, 1000], manual: true });
    expect((await lastSplitAudit(o.id)).message).toMatch(/4 kişiye elle bölündü \(1 pay ödendi\): /);
    // Eşit'e dönüş elle payları siler
    const back = await split(o.id, { people: 4 });
    expect(back.json.split).toMatchObject({ shares: splitEven(left, 3), manual: false, reset: false });
  });
});

describe('hesap değişince elle paylar düşer', () => {
  it('kalem eklenince: kalan yeniden eşit, not gösterilir; bayat tutar çekilmez, sıradaki pay notu kaldırır', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    const amounts = [o.total - 1000, 1000];
    await split(o.id, { people: 2, amounts });
    const added = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    expect(added.split).toEqual({ people: 2, paid: 0, left: 2, shares: splitEven(added.total, 2), manual: false, reset: true });
    // Eski ekran eski payı göndermeye çalışırsa 409, para çekilmez
    const stale = await payShare(o.id, 'Kredi kartı', amounts[0]);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('split_changed');
    const paid = await payShare(o.id, 'Kredi kartı');
    expect(paid.status).toBe(200);
    expect(paid.json.amount).toBe(splitEven(added.total, 2)[0]);
    expect(paid.json.order.split).toMatchObject({ manual: false, reset: false });
  });

  it('kalem iptali, indirim ve ödeme iptali de elle payları düşürür', async () => {
    // İptal
    let o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }, { name: 'Türk Kahvesi' }]);
    await split(o.id, { people: 2, amounts: [o.total - 500, 500] });
    const coffee = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${coffee.id}/void`, { reason: 'Yanlış giriş', approverPin: PINS.mudur });
    expect(o.split).toMatchObject({ manual: false, reset: true, shares: splitEven(o.total, 2) });

    // İndirim
    o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    await split(o.id, { people: 2, amounts: [o.total - 500, 500] });
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Sürekli müşteri' });
    expect(o.split).toMatchObject({ manual: false, reset: true, shares: splitEven(o.total, 2) });

    // Ödeme iptali (pay ödemesinin iptali): toplam değişmez ama hesap değişti
    o = await newOrder([{ name: 'Latte', size: 'M', qty: 3 }]);
    await split(o.id, { people: 3, amounts: [o.total - 2000, 1000, 1000] });
    const first = await payShare(o.id, 'Nakit');
    const payment = first.json.order.payments.at(-1)!;
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/payments/${payment.id}/refund`, { reason: 'Yanlış tür' });
    expect(o.split).toEqual({ people: 3, paid: 0, left: 3, shares: splitEven(o.total, 3), manual: false, reset: true });
  });

  it('pay ödemesi hesabı değiştirmez: elle paylar ödeme sonrası da durur (yalnız baştaki düşer)', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 3 }]);
    await split(o.id, { people: 3, amounts: [o.total - 3000, 2000, 1000] });
    const first = await payShare(o.id, 'Nakit');
    expect(first.json.order.split).toMatchObject({ shares: [2000, 1000], manual: true, reset: false });
  });
});
