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
interface Refund {
  order: OrderDTO;
  refunded: number;
  methods: { name: string; zField: string; amount: number }[];
}
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
    const res = await h.ok<Refund>('kasa', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: item.id, qty: 1 }], reason: 'Soğuk geldi', approverPin: PINS.mudur });
    const after = res.order;
    expect(after.status).toBe('kapali');
    expect(after.total).toBe(withItems.total - unit);
    // Geri verilen tutar ve yolu yanıtta: kör kasada kapanan adisyonun ödemeleri gizlidir
    expect(res.refunded).toBe(unit);
    expect(res.methods.map((m) => [m.name, m.zField, m.amount])).toEqual([['Nakit', 'cash', unit]]);
    const full = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    const live = full.payments.filter((p) => !p.refundedAt);
    expect(live.every((p) => p.methodName === 'Nakit')).toBe(true);
    expect(live.reduce((a, p) => a + p.amount, 0)).toBe(after.total);
    const refunds = await h.ok<{ total: number; rows: { amount: number }[] }>('patron', 'GET', '/reports/refunds');
    expect(refunds.rows.some((r) => r.amount === unit)).toBe(true);
  });

  it('bütün kalemler iade edilirse sipariş iptal olur', async () => {
    const o = await paidOrder('kart');
    const res = await h.ok<Refund>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: o.items.map((i) => ({ itemId: i.id, qty: i.qty })), reason: 'Yanlış sipariş' });
    expect(res.order.status).toBe('iptal');
    expect(res.refunded).toBe(o.total);
    // Tam iadede de özet denetim kaydı yazılır (önceden yalnız "boş adisyon kapatıldı" kalıyordu)
    const log = await h.ok<{ action: string; orderId: string | null; amount: number | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(log.some((r) => r.action === 'order.refund_items' && r.orderId === o.id && r.amount === o.total)).toBe(true);
  });
});

/**
 * İnceleme (23 Kas 2026): iade tutarı ortak hesaptan (indirim düşülmüş), ödeme türü dökümüyle; tekrar eden istek ikinci
 * kez iade etmez; rapor ikinci iadede çift saymaz; paylaşımlı ve ikramlı adisyon
 */
describe('kalem iadesinin hesabı', () => {
  const latte = () => product('Latte');
  async function closed(qty: number, opts: { discount?: { type: 'percent' | 'amount'; value: number }; pay?: (total: number, id: string) => Promise<void> } = {}) {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    let cur = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, qty }] });
    if (opts.discount) cur = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/discount`, { ...opts.discount, reason: 'Kampanya' });
    if (opts.pay) await opts.pay(cur.total, o.id);
    else await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: cur.total });
    return h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
  }
  const refund = (o: OrderDTO, qty: number, extra: Record<string, unknown> = {}) =>
    h.call<Refund & { code?: string }>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: o.items.find((i) => !i.voided)!.id, qty }], reason: 'İade', ...extra });

  it('yüzde indirimli adisyonda müşterinin ödediği geri verilir, liste fiyatı değil', async () => {
    const unit = latte().price;
    const o = await closed(3, { discount: { type: 'percent', value: 20 } });
    expect(o.total).toBe(3 * unit * 0.8);
    const res = await refund(o, 1);
    expect(res.status).toBe(200);
    expect(res.json.refunded).toBe(unit * 0.8);
    expect(res.json.order.total).toBe(2 * unit * 0.8);
  });

  it('tutar indirimi kalan kalemlerle orantılı küçülür: fazla iade yok, tek latte iadesi adisyonu sıfırlamaz', async () => {
    const unit = latte().price;
    // 3 latte, bir latte tutarında indirim: latte başına 2/3 ödendi
    const o = await closed(3, { discount: { type: 'amount', value: unit } });
    expect(o.total).toBe(2 * unit);
    const res = await refund(o, 1);
    expect(res.json.refunded).toBe(Math.round((2 * unit) / 3));
    expect(res.json.order.total).toBe(2 * unit - Math.round((2 * unit) / 3));
    expect(res.json.order.status).toBe('kapali');
    // 2 latte, bir latte tutarında indirim: bir latte iadesi yarısını geri verir, kalan latte adisyonda durur
    const two = await closed(2, { discount: { type: 'amount', value: unit } });
    const half = await refund(two, 1);
    expect(half.json.refunded).toBe(unit / 2);
    expect(half.json.order.status).toBe('kapali');
    expect(half.json.order.items.filter((i) => !i.voided)).toHaveLength(1);
    // Oran korunur: iadenin iptalleri "indirim büyüdü" kaydı yazmaz (yanlış alarm; onaylayanda indirim yetkisi aranmaz)
    const log = await h.ok<{ action: string; orderId: string | null }[]>('patron', 'GET', '/admin/audit?limit=200');
    expect(log.filter((r) => r.action === 'order.discount' && (r.orderId === o.id || r.orderId === two.id))).toHaveLength(2);
  });

  it('karışık ödemede hangi türden ne kadar geri verildiği döner (son alınan ödemeden başlar)', async () => {
    const unit = latte().price;
    const o = await closed(3, {
      pay: async (total, id) => {
        await h.ok('kasa', 'POST', `/orders/${id}/payments`, { methodId: method('kart').id, amount: 2 * unit });
        await h.ok('kasa', 'POST', `/orders/${id}/payments`, { methodId: method('nakit').id, amount: total - 2 * unit });
      },
    });
    const res = await refund(o, 2);
    expect(res.json.refunded).toBe(2 * unit);
    expect(Object.fromEntries(res.json.methods.map((m) => [m.zField, m.amount]))).toEqual({ cash: unit, card: unit });
    const live = (await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`)).payments.filter((p) => !p.refundedAt);
    expect(live.map((p) => [p.zField, p.amount])).toEqual([['card', unit]]);
  });

  it('adet satırı aşamaz; aynı istek yeniden gelirse ikinci kez iade edilmez', async () => {
    const o = await closed(3);
    const over = await refund(o, 9);
    expect(over.status).toBe(409);
    expect(over.json.code).toBe('refund_qty');
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    const first = await refund(o, 1, { expectTotal: o.total });
    expect(first.status).toBe(200);
    // Yanıt kayboldu, kasiyer yeniden bastı: ekranın gördüğü toplam artık tutmuyor
    const again = await refund(o, 1, { expectTotal: o.total });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('order_changed');
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`)).total).toBe(first.json.order.total);
  });

  it('iade raporu ikinci iadede ve ardından gelen iptalde çift saymaz', async () => {
    const unit = latte().price;
    const rowsOf = async (no: number) => (await h.ok<{ rows: { orderNo: number | null; amount: number }[] }>('patron', 'GET', '/reports/refunds')).rows.filter((r) => r.orderNo === no);
    const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + r.amount, 0);
    const o = await closed(3);
    await refund(o, 1);
    await refund(await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`), 1);
    expect(sum(await rowsOf(o.no))).toBe(2 * unit);
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel-closed`, { reason: 'Hepsi iade' });
    expect(sum(await rowsOf(o.no))).toBe(3 * unit);
  });

  it('paylaşımlı hesap iade edilir; kalan payların ödemeleriyle yeniden yazılır', async () => {
    const unit = latte().price;
    const o = await closed(2, {
      pay: async (total, id) => {
        await h.ok('kasa', 'PUT', `/orders/${id}/split`, { people: 2 });
        await h.ok('kasa', 'POST', `/orders/${id}/payments`, { methodId: method('nakit').id, amount: total / 2, share: true, shareNo: 1 });
        await h.ok('kasa', 'POST', `/orders/${id}/payments`, { methodId: method('kart').id, amount: total / 2, share: true, shareNo: 2 });
      },
    });
    expect(o.status).toBe('kapali');
    const res = await refund(o, 1);
    expect(res.status).toBe(200);
    expect(res.json.refunded).toBe(unit);
    expect(res.json.methods.map((m) => m.zField)).toEqual(['card']);
    expect(res.json.order.status).toBe('kapali');
  });

  it('geriye yalnız ikram kalırsa adisyon iptal olmaz, kapanır; ikram kalemi ikram kalır', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const withItems = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, qty: 1 }, { productId: product('Espresso').id, qty: 1 }] });
    const espresso = withItems.items.find((i) => i.name.startsWith('Espresso'))!;
    const comped = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${espresso.id}/comp`, { reason: 'İkram' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: comped.total });
    const paid = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    const res = await h.ok<Refund>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: paid.items.find((i) => !i.complimentary)!.id, qty: 1 }], reason: 'İade' });
    expect(res.order.status).toBe('kapali');
    expect(res.order.total).toBe(0);
    expect(res.order.items.find((i) => i.complimentary && !i.voided)).toBeTruthy();
    // İkram kalem iadeye seçilemez
    const bad = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: res.order.items.find((i) => i.complimentary)!.id, qty: 1 }], reason: 'İade' });
    expect(bad.status).toBe(409);
  });
});

/**
 * Ödemeden sonra iki fiş (müşteri ve işyeri nüshası) bu isteğin ödemesiyle basılır. Kör kasada kapanan adisyonun ödeme
 * dökümü gelmez: ekran yeni ödemeyi dökümde arıyor, varsayılan kasiyerde adisyonu kapatan ödemede fiş hiç çıkmıyordu
 * (inceleme, 23 Kas 2026). Ödeme yanıtı kasiyerin az önce aldığı ödemeyi taşır
 */
describe('ödeme yanıtı fişi basılacak ödemeyi taşır', () => {
  it('kör kasiyer: adisyonu kapatan ödemede döküm boş, ödeme yanıtta; aynı istek yeniden gelince aynı ödeme', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const withItems = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, qty: 1 }] });
    type Paid = { order: OrderDTO; closed: boolean; payment: { id: string; methodName: string; amount: number; tip: number } };
    const body = { methodId: method('nakit').id, amount: withItems.total, requestId: 'fis-deneme-0001' };
    const paid = await h.ok<Paid>('kasa', 'POST', `/orders/${o.id}/payments`, body);
    expect(paid.closed).toBe(true);
    expect(paid.order.payments).toEqual([]);
    expect(paid.payment).toMatchObject({ methodName: 'Nakit', amount: withItems.total, tip: 0 });
    const again = await h.ok<Paid>('kasa', 'POST', `/orders/${o.id}/payments`, body);
    expect(again.payment.id).toBe(paid.payment.id);
    // Dökümü gören (patron) aynı ödemeyi görür
    const full = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    expect(full.payments.map((p) => p.id)).toEqual([paid.payment.id]);
  });
});

/**
 * İade, alınmış ödemenin ve teslim edilmiş kalemin sonradan geri verilmesidir (inceleme, 23 Kas 2026): bara iş olarak
 * dönmez, zil çalmaz; patron panelinde "Hesap yazdırıldıktan sonra iptal" sayılmaz (kendi alarmı var); kalan ödeme asıl
 * ödemenin saatinde ve alan kişisinde, sipariş asıl kapanış anında kalır
 */
describe('iade bar ekranına ve uyarılara karışmaz', () => {
  it('teslim edilmiş kalemin iadesi: zil yok, bar listesinde yok, hesap sonrası iptal sayılmaz; saatler korunur', async () => {
    const { bus } = await import('../server/lib/events');
    const masa = h.boot.tables.filter((t) => t.kind === 'masa')[5]!;
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: masa.id });
    const withItems = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 2 }] });
    const item = withItems.items[0]!;
    expect(item.stationId).toBeTruthy();
    await h.ok('mudur', 'POST', '/kitchen/status', { itemIds: [item.id], status: 'hazir' });
    await h.ok('mudur', 'POST', '/kitchen/status', { itemIds: [item.id], status: 'servis' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/bill`, {});
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('nakit').id, amount: withItems.total });
    const paid = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    expect(paid.status).toBe('kapali');
    const original = paid.payments[0]!;
    const alarmsBefore = (await h.ok<{ anomalies: { title: string; detail: string }[] }>('patron', 'GET', '/reports/patron')).anomalies.find((a) => a.title === 'Hesap yazdırıldıktan sonra iptal');

    const events: { topic: string; kind: string; orderId?: string }[] = [];
    const listen = (e: { topic: string; kind: string; orderId?: string }) => events.push(e);
    bus.on('event', listen);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const res = await h.ok<Refund>('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: item.id, qty: 1 }], reason: 'Soğuk geldi' });
      expect(res.order.status).toBe('kapali');
    } finally {
      bus.off('event', listen);
    }
    expect(events.filter((e) => e.topic === 'kitchen' && e.kind === 'ticket.void' && e.orderId === o.id)).toEqual([]);
    const kitchen = await h.ok<{ tickets?: { orderId: string; items: { id: string; voided?: boolean }[] }[] } | { orderId: string; items: { voided?: boolean }[] }[]>('mudur', 'GET', '/kitchen');
    expect(JSON.stringify(kitchen)).not.toContain(o.id);
    const alarmsAfter = (await h.ok<{ anomalies: { title: string; detail: string }[] }>('patron', 'GET', '/reports/patron')).anomalies.find((a) => a.title === 'Hesap yazdırıldıktan sonra iptal');
    expect(alarmsAfter?.detail ?? null).toBe(alarmsBefore?.detail ?? null);
    const log = await h.ok<{ action: string; orderId: string | null; severity: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    const voidRow = log.find((r) => r.action === 'item.void' && r.orderId === o.id)!;
    expect(voidRow.severity).toBe('uyari');
    expect(voidRow.message).toContain('iade etti');

    const after = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    const live = after.payments.filter((p) => !p.refundedAt);
    expect(live).toHaveLength(1);
    expect(live[0]!.createdAt).toBe(original.createdAt);
    expect(live[0]!.userName).toBe(original.userName);
    expect(after.closedAt).toBe(paid.closedAt);
  });
});
