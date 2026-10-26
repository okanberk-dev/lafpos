import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitEven } from '@shared/money';
import { splitState } from '@shared/order-calc';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Paylaşımlı hesap: kalan tutar kişilere kuruşu kuruşuna eşit bölünür, her pay ayrı ödenir. Bölündükten sonra eklenen
 * kalem ya da iptal edilen pay kalanlara dağılır. Pay tutarını sunucu hesaplar; istemci ekranda gördüğü payı ve
 * numarasını gönderir, tutmazsa (başka cihazda değişiklik, yeniden gönderilen istek) 409 split_changed.
 */
let h: Harness;
const MUDUR = PINS.mudur;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

type PayResult = { order: OrderDTO; closed: boolean; change: number; amount: number; share: { no: number; of: number } | null };

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
async function newOrder(items: { name: string; qty?: number; size?: 'M' | 'L' }[], type: 'tezgah' | 'masa' = 'tezgah', tableId?: string) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type, ...(tableId ? { tableId } : {}) });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}
/** Ödeme penceresinin gördüğü sıradaki pay: tutar sunucunun hesabından, numara ilk boş pay */
function nextShare(o: OrderDTO) {
  const used = new Set(o.payments.filter((p) => !p.refundedAt && p.shareNo != null).map((p) => p.shareNo));
  let no = 1;
  while (used.has(no)) no++;
  return { amount: o.split!.shares[0]!, shareNo: no };
}
async function payShare(orderId: string, methodName: string) {
  const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
  return h.ok<PayResult>('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: method(methodName).id, share: true, ...nextShare(o) });
}

describe('paylaşımlı hesap', () => {
  it('pay hesabı: kalan tutar ödenmemiş paylara eşit, kuruş artığı baştakilere', () => {
    expect(splitState(3, 0, 10001)).toEqual({ people: 3, paid: 0, left: 3, shares: [3334, 3334, 3333] });
    expect(splitState(3, 1, 1001)).toEqual({ people: 3, paid: 1, left: 2, shares: [501, 500] });
    expect(splitState(2, 2, 500).shares).toEqual([]);
    expect(splitState(4, 1, 0).shares).toEqual([]);
  });

  it('hesap üç kişiye bölünür; paylar ayrı yöntemlerle ödenir, sonradan eklenen kalem kalanlara dağılır', async () => {
    let o = await newOrder([{ name: 'Latte', size: 'M', qty: 3 }, { name: 'Türk kahvesi' }]);
    o = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 3 });
    expect(o.split).toEqual({ people: 3, paid: 0, left: 3, shares: splitEven(o.total, 3) });

    const first = await payShare(o.id, 'Nakit');
    expect(first.closed).toBe(false);
    // Yanıt kaydedilen tutarı ve payı da taşır (kör kasada kapanan adisyonun dökümü gizlidir)
    expect(first).toMatchObject({ amount: splitEven(o.total, 3)[0], share: { no: 1, of: 3 } });
    expect(first.order.payments.at(-1)).toMatchObject({ amount: splitEven(o.total, 3)[0], shareNo: 1, shareOf: 3 });
    expect(first.order.split).toMatchObject({ paid: 1, left: 2 });

    // Bölündükten sonra bir kalem daha: kalan iki paya dağılır
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    expect(o.split!.shares).toEqual(splitEven(o.total - o.paid, 2));

    const second = await payShare(o.id, 'Kredi kartı');
    expect(second.order.payments.at(-1)).toMatchObject({ methodName: 'Kredi kartı', shareNo: 2, shareOf: 3 });

    // İkinci payın ödemesi iptal: pay yeniden açılır, numarası boşa çıkar ve yeniden kullanılır
    const p2 = second.order.payments.at(-1)!;
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/payments/${p2.id}/refund`, { reason: 'Yanlış kart', approverPin: MUDUR });
    expect(o.split).toMatchObject({ paid: 1, left: 2 });
    const again = await payShare(o.id, 'Kredi kartı');
    expect(again.order.payments.filter((p) => !p.refundedAt).map((p) => p.shareNo)).toEqual([1, 2]);

    const last = await payShare(o.id, 'Nakit');
    expect(last.closed).toBe(true);
    expect(last.share).toEqual({ no: 3, of: 3 });
    const closed = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    const live = closed.payments.filter((p) => !p.refundedAt);
    expect(live.map((p) => `${p.shareNo}/${p.shareOf}`)).toEqual(['1/3', '2/3', '3/3']);
    expect(live.reduce((a, p) => a + p.amount, 0)).toBe(closed.total);
  });

  it('ekrandaki pay tutmazsa 409: başka cihazda eklenen kalem, değişen kişi sayısı, yeniden gönderilen istek', async () => {
    let o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    o = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 2 });
    const seen = nextShare(o);

    // Başka cihaz kalem ekler: ekrandaki eski tutarla pay alınmaz (kart terminaline yanlış tutar girilmesin)
    await h.ok('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const stale = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, share: true, ...seen });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('split_changed');

    // Kişi sayısı başka cihazda değişti
    const fresh = nextShare(await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`));
    await h.ok('kasa', 'PUT', `/orders/${o.id}/split`, { people: 3 });
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, share: true, ...fresh })).json.code).toBe('split_changed');

    // Yanıtı kaybolan istek yeniden gelir: ikinci kez pay alınmaz
    const now = nextShare(await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`));
    const body = { methodId: method('Kredi kartı').id, share: true, ...now };
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, body);
    const replay = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, body);
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe('split_changed');
    const after = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(after.payments.filter((p) => !p.refundedAt)).toHaveLength(1);

    // Kalanlar güncel ekranla alınır
    await payShare(o.id, 'Nakit');
    expect((await payShare(o.id, 'Nakit')).closed).toBe(true);
  });

  it('bölünmüş hesapta pay dışı ödeme ve cihaza kalem gönderme yok; paylar bitince kalan Tutar ile alınır', async () => {
    let o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    o = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 2 });
    // Tutar ile alınan ödeme payları düşürmezdi: masa paylarını ödeyip kalkar, kalan kimseye kalmazdı
    const plain = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.split!.shares[0] });
    expect(plain.status).toBe(409);
    expect(plain.json.code).toBe('split_active');
    const latte = o.items[0]!;
    const device = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: latte.id, qty: 1 }] });
    expect(device.status).toBe(409);
    expect(device.json.code).toBe('split_active');

    await payShare(o.id, 'Nakit');
    await payShare(o.id, 'Kredi kartı');
    // Paylar bitti, adisyon kapandı; yeniden açılıp kalem eklenince kalan "Tutar" ile alınır
    await h.ok('kasa', 'POST', `/orders/${o.id}/reopen`, { reason: 'Ürün eklenecek', approverPin: MUDUR });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    expect(o.split).toMatchObject({ left: 0, shares: [] });
    const rest = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total - o.paid });
    expect(rest.closed).toBe(true);
  });

  it('birleştirmede paylaşım kalkar: iki hesabın pay numaraları karışmaz', async () => {
    const tables = h.boot.tables.filter((t) => t.kind !== 'oda');
    const a = await newOrder([{ name: 'Latte', size: 'M' }], 'masa', tables[0]!.id);
    const b = await newOrder([{ name: 'Türk kahvesi' }], 'masa', tables[1]!.id);
    await h.ok('kasa', 'PUT', `/orders/${a.id}/split`, { people: 2 });
    await h.ok('kasa', 'PUT', `/orders/${b.id}/split`, { people: 3 });
    await payShare(b.id, 'Nakit');
    const merged = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/merge`, { sourceOrderId: b.id, approverPin: MUDUR });
    expect(merged.split).toBeNull();
    // Kalan tutar normal ödemeyle alınır
    expect((await h.ok<PayResult>('kasa', 'POST', `/orders/${a.id}/payments`, { methodId: method('Kredi kartı').id, amount: merged.total - merged.paid })).closed).toBe(true);
  });

  it('kurallar: kişi sayısı sınırı, ödenmiş paydan aza indirme, bölmeden pay, payda kalem seçimi, paylar bitince', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    expect((await h.call<{ code: string }>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 1 })).json.code).toBe('split_people');
    expect((await h.call<{ code: string }>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 31 })).json.code).toBe('split_people');
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 100, share: true })).json.code).toBe('split_off');

    await h.ok('kasa', 'PUT', `/orders/${o.id}/split`, { people: 2 });
    const latte = o.items[0]!;
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 100, share: true, items: [{ itemId: latte.id, qty: 1 }] })).json.code).toBe(
      'split_items',
    );
    await payShare(o.id, 'Nakit');
    expect((await h.call<{ code: string }>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 1 })).json.code).toBe('split_people');
    // Garson ödeme alamaz, hesabı da bölemez
    expect((await h.call('garson', 'PUT', `/orders/${o.id}/split`, { people: 3 })).status).toBe(403);

    const done = await payShare(o.id, 'Kredi kartı');
    expect(done.closed).toBe(true);
    // Yeniden açılıp kalem eklenirse paylar bitmiştir: kalan "Tutar" ile alınır ya da kişi eklenir
    await h.ok('kasa', 'POST', `/orders/${o.id}/reopen`, { reason: 'Ürün eklenecek', approverPin: MUDUR });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 100, share: true })).json.code).toBe('split_done');
    const more = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 3 });
    expect(more.split).toMatchObject({ people: 3, paid: 2, left: 1, shares: [more.total - more.paid] });
    expect((await payShare(o.id, 'Nakit')).closed).toBe(true);

    // Paylaşımı kaldırmak: pay hesabı düşer, ödenmiş payların etiketi kalır
    const p = await newOrder([{ name: 'Türk kahvesi' }]);
    await h.ok('kasa', 'PUT', `/orders/${p.id}/split`, { people: 2 });
    expect((await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${p.id}/split`, { people: null })).split).toBeNull();
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: method('Nakit').id, amount: p.total });
  });
});
