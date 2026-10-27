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
let instant = 'ok' as 'ok' | 'timeout' | 'reject' | 'truncated' | 'garbled' | ((basket: TokenBasket) => Promise<void>);
/** Sepet silme isteği: Token'a ulaşılamıyor mu */
let del = 'ok' as 'ok' | 'unreachable';
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
      if (instant === 'truncated') {
        // Token sepeti aldı, 200 başlıkları geldi; gövde okunurken bağlantı koptu (ya da 15 sn zaman aşımı doldu)
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"status":0,'));
            c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (instant === 'garbled') return new Response('<html>Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (typeof instant === 'function') {
        await instant(b);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return json(200, { status: 0, result: {} });
    }
    const m = u.pathname.match(/^\/v1\/basket\/([^/]+)$/);
    if (m && verb === 'GET') return details.has(m[1]) ? json(200, { status: 0, result: details.get(m[1]) }) : json(200, { status: 1006, description: 'not found' });
    if (m && verb === 'DELETE') {
      if (del === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
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
    // Türk Kahvesi sitenin kalemi (130 TL); beklenen tutarlar 140 TL'ye göre yazıldı, site fiyatı değişse de bozulmasın
    await h.pinPrice('Türk Kahvesi', 14000);
    await provider('simulator');
  });

  it('sunucu yeniden başlayınca bekleyen Token sepeti sorgulanır (webhook yokken)', async () => {
    const o = await order([{ name: 'Türk Kahvesi' }]);
    // Önceki süreçten kalan, sonucu beklenen sepet
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const kasa = db.select().from(schema.users).where(eq(schema.users.name, 'Kasa')).get()!;
    const id = 'onceki-surecten-sepet';
    const now = Date.now();
    db.insert(schema.fiscalReceipts)
      .values({ id, orderId: o.id, provider: 'tokenx', mode: 'anlik', terminalId: 'T1', status: 'gonderildi', amount: o.total, items: [{ itemId: o.items[0].id, qty: 1 }], basket: { basketID: id, items: [] }, sentBy: kasa.id, createdAt: now, updatedAt: now })
      .run();
    details.set(id, { basketID: id, sale: { basketID: id, status: 0, zNo: 1, receiptNo: 9, paymentItems: [{ type: 3, amount: o.total }] } });
    const { resumePolling } = await import('../server/okc/service');
    resumePolling();
    await vi.waitFor(async () => expect((await getOrder(o.id)).status).toBe('kapali'), { timeout: 6000, interval: 200 });
    expect(calls).toContain(`GET /v1/basket/${id}`);
  });

  it('birleşen adisyonda fiş iptali: ödeme hedef adisyondan düşer, hedef yeniden açılır; fiş hedefe taşınır', async () => {
    const [ta, tb] = tables().slice(0, 2);
    const a = await order([{ name: 'Türk Kahvesi' }, { name: 'Latte', size: 'M' }], { type: 'masa', tableId: ta.id });
    const tk = a.items.find((i) => i.name === 'Türk Kahvesi')!;
    const r = await send(a.id, [{ itemId: tk.id, qty: 1 }]);
    await simPay(r.id, [{ type: 3, amount: r.amount }]);
    const b = await order([{ name: 'Türk Kahvesi' }], { type: 'masa', tableId: tb.id });
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
    const o = await order([{ name: 'Türk Kahvesi' }, { name: 'Latte', size: 'M' }], { type: 'tezgah', customerId: cust.id });
    const tk = o.items.find((i) => i.name === 'Türk Kahvesi')!;
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

  it('gönderim isteği sürerken gelen "ödendi" hata ile ezilmez; sonraki fiş iptali ödemeyi geri alır', async () => {
    await provider('tokenx');
    const o = await order([{ name: 'Türk Kahvesi' }]);
    instant = async (b) => {
      const amount = b.items.reduce((a, i) => a + (i.price * i.quantity) / 1000, 0);
      expect((await webhook({ basketID: b.basketID, status: 0, zNo: 3, receiptNo: 11, paymentItems: [{ type: 1, amount }] })).status).toBe(200);
    };
    const sent = await h.call<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    instant = 'ok';
    expect(sent.status).toBe(200);
    expect(sent.json.receipt.status).toBe('tamamlandi');
    expect(await getOrder(o.id)).toMatchObject({ status: 'kapali', paid: o.total });

    await webhook({ basketID: sent.json.receipt.id, status: 99 });
    expect(await getOrder(o.id)).toMatchObject({ status: 'acik', paid: 0 });
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Fiş iptal edildi' });
  });

  it('yanıtı alınamayan gönderim bekleyen kalır ve sorgulanır; ödendiyse işlenir, cihaza ulaşmadıysa kilit açılır', async () => {
    const o = await order([{ name: 'Türk Kahvesi' }]);
    instant = 'timeout';
    const r = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    instant = 'ok';
    expect(r.status).toBe(502);
    expect(r.json.code).toBe('okc_unknown');
    const [rec] = await receipts(o.id);
    expect(rec.status).toBe('gonderildi');
    // Sepet cihazda olabilir: LafPOS'ta ikinci kez tahsil edilmez
    const pay = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    expect(pay.json.code).toBe('okc_pending');
    // Kasiyer cihazda ödemeyi aldı; sorgu sonucu işler
    details.set(rec.id, { basketID: rec.id, sale: { basketID: rec.id, status: 0, zNo: 7, receiptNo: 42, paymentItems: [{ type: 3, amount: rec.amount }] } });
    const refreshed = await h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${rec.id}/refresh`);
    expect(refreshed.status).toBe('tamamlandi');
    expect(await getOrder(o.id)).toMatchObject({ status: 'kapali', paid: o.total });

    // Token sepeti hiç görmediyse (1006) sepet hata olur, adisyon kasadan alınır
    const o2 = await order([{ name: 'Türk Kahvesi' }]);
    instant = 'timeout';
    await h.call('kasa', 'POST', `/okc/orders/${o2.id}/send`, {});
    instant = 'ok';
    const [rec2] = await receipts(o2.id);
    details.delete(rec2.id);
    expect((await h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${rec2.id}/refresh`)).status).toBe('hata');
    expect((await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o2.id}/payments`, { methodId: method('Nakit').id, amount: o2.total })).closed).toBe(true);

    // Token kodla reddettiyse sepet hemen hata olur
    const o3 = await order([{ name: 'Türk Kahvesi' }]);
    instant = 'reject';
    const rej = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o3.id}/send`, {});
    instant = 'ok';
    expect(rej.status).toBe(502);
    expect(rej.json.code).toBe('tokenx_1100');
    expect((await receipts(o3.id))[0].status).toBe('hata');
    expect((await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o3.id}/payments`, { methodId: method('Nakit').id, amount: o3.total })).closed).toBe(true);
    await provider('simulator');
  });

  it('cihaz ödemesi sepeti karşılamıyorsa (ikram, ödemesiz) kalemler ödenmiş sayılmaz, alarm düşer, yeniden gönderilmez', async () => {
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }]);
    const r = await send(o.id);
    await simPay(r.id, [{ type: 9, amount: 14000 }, { type: 3, amount: r.amount - 14000 }]);
    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'acik', paid: r.amount - 14000 });
    expect(after.items.map((i) => i.paidQty)).toEqual([0]);
    expect(after.payments.map((p) => [p.methodName, p.amount, p.items ?? null])).toEqual([['Kredi kartı', r.amount - 14000, null]]);
    expect((await receipts(o.id))[0].status).toBe('hata');
    expect((await audits()).find((a) => a.action === 'okc.underpaid' && a.orderId === o.id)).toMatchObject({ severity: 'alarm', amount: 14000 });
    const again = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: o.items[0].id, qty: 1 }] });
    expect(again.json.code).toBe('okc_unresolved');
    // Aynı sonuç ikinci kez gelirse ödeme ikinci kez yazılmaz
    const { applySale } = await import('../server/okc/service');
    applySale(r.id, { basketID: r.id, status: 0, paymentItems: [{ type: 9, amount: 14000 }, { type: 3, amount: r.amount - 14000 }] }, 'webhook');
    expect((await getOrder(o.id)).paid).toBe(r.amount - 14000);
    expect((await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 14000 })).closed).toBe(true);

    // Tamamı ikram: ödeme yok, kalem işaretlenmez; fiş iptali sepeti kapatır, adisyon yeniden gönderilebilir
    const o2 = await order([{ name: 'Türk Kahvesi' }]);
    const r2 = await send(o2.id);
    await simPay(r2.id, [{ type: 9, amount: r2.amount }]);
    expect(await getOrder(o2.id)).toMatchObject({ status: 'acik', paid: 0 });
    expect((await getOrder(o2.id)).items[0].paidQty).toBe(0);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o2.id}/send`, {})).json.code).toBe('okc_unresolved');
    expect((await simVoid(r2.id)).status).toBe(200);
    expect((await receipts(o2.id))[0].status).toBe('fis_iptal');
    const r3 = await send(o2.id);
    await simPay(r3.id, [{ type: 3, amount: r3.amount }]);
    expect(await getOrder(o2.id)).toMatchObject({ status: 'kapali', paid: o2.total });
  });

  it('servis ücreti: kalem kalem ödenen masada kalan servis cihaza tek satır olarak gider', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
    const o = await order([{ name: 'Türk Kahvesi' }, { name: 'Türk Kahvesi' }], { type: 'masa', tableId: tables()[2].id });
    expect(o.totals.service).toBe(2800);
    const sent: TokenBasket[] = [];
    for (const it of o.items) {
      const r = await send(o.id, [{ itemId: it.id, qty: 1 }]);
      expect(r.basket.items.some((i) => i.name === 'Servis ücreti')).toBe(false);
      await simPay(r.id, [{ type: 3, amount: r.amount }]);
      sent.push(r.basket);
    }
    const rest = await send(o.id);
    expect(rest.amount).toBe(2800);
    expect(rest.basket.items).toEqual([expect.objectContaining({ name: 'Servis ücreti', price: 2800, taxPercent: 1000, quantity: 1000 })]);
    await simPay(rest.id, [{ type: 1, amount: rest.amount }]);
    const fin = await getOrder(o.id);
    expect(fin).toMatchObject({ status: 'kapali', paid: o.total });
    expect(deviceByRate([...sent, rest.basket])).toEqual(lafposByRate(fin));
  });

  it('servis ücreti: sepet beklerken kalem eklenirse ikinci sepet yalnız servisin kalanını taşır, sahte indirim yok', async () => {
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }], { type: 'masa', tableId: tables()[3].id });
    const r1 = await send(o.id);
    const more = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Karaoke kişi başı').id, qty: 1 }] });
    await simPay(r1.id, [{ type: 3, amount: r1.amount }]);
    const r2 = await send(o.id);
    const karaoke = r2.basket.items.find((i) => i.name.startsWith('Karaoke'))!;
    expect(karaoke.adjust).toBeUndefined();
    const serviceOnDevice = [...r1.basket.items, ...r2.basket.items].filter((i) => i.name === 'Servis ücreti').reduce((a, i) => a + i.price, 0);
    expect(serviceOnDevice).toBe(more.totals.service);
    await simPay(r2.id, [{ type: 3, amount: r2.amount }]);
    const fin = await getOrder(o.id);
    expect(fin).toMatchObject({ status: 'kapali', paid: fin.total });
    expect(deviceByRate([r1.basket, r2.basket])).toEqual(lafposByRate(fin));

    // Yeni kalem önceki servis satırından ucuzsa da kalan cihaza gider
    const o2 = await order([{ name: 'Etkinlik ücreti', qty: 4 }], { type: 'masa', tableId: tables()[4].id });
    const s1 = await send(o2.id);
    await h.ok('kasa', 'POST', `/orders/${o2.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    await simPay(s1.id, [{ type: 3, amount: s1.amount }]);
    const s2 = await send(o2.id);
    await simPay(s2.id, [{ type: 1, amount: s2.amount }]);
    const fin2 = await getOrder(o2.id);
    expect(fin2.status).toBe('kapali');
    expect(deviceByRate([s1.basket, s2.basket])).toEqual(lafposByRate(fin2));
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 0 });
  });

  it('KDV dökümü: kalem bazlı ödemeden sonra indirim yeniden dağılınca fark aynı oranda kalır', async () => {
    let o = await order([{ name: 'Türk Kahvesi' }, { name: 'Karaoke kişi başı' }]);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 5000, reason: 'Kampanya', approverPin: MUDUR });
    const coffee = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    const r1 = await send(o.id, [{ itemId: coffee.id, qty: 1 }]);
    await simPay(r1.id, [{ type: 3, amount: r1.amount }]);
    await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Karaoke kişi başı').id, qty: 1 }] });
    const r2 = await send(o.id);
    await simPay(r2.id, [{ type: 3, amount: r2.amount }]);
    const fin = await getOrder(o.id);
    expect(fin.status).toBe('kapali');
    expect(deviceByRate([r1.basket, r2.basket])).toEqual(lafposByRate(fin));

    // Yüzde indirimde de: kahve kalem kalem LafPOS'ta, kalanı cihazda; döküm kuruşu kuruşuna aynı
    let p = await order([{ name: 'Türk Kahvesi', qty: 3 }, { name: 'Latte', size: 'M' }]);
    p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/discount`, { type: 'percent', value: 15, reason: 'Öğrenci', approverPin: MUDUR });
    const latte = p.items.find((i) => i.name === 'Latte')!;
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: method('Kredi kartı').id, amount: p.totals.lineNet[latte.id], items: [{ itemId: latte.id, qty: 1 }] });
    const q1 = await send(p.id, [{ itemId: p.items.find((i) => i.name === 'Türk Kahvesi')!.id, qty: 1 }]);
    await simPay(q1.id, [{ type: 3, amount: q1.amount }]);
    await h.ok('kasa', 'POST', `/orders/${p.id}/items`, { items: [{ productId: product('Karaoke kişi başı').id, qty: 2 }] });
    const q2 = await send(p.id);
    await simPay(q2.id, [{ type: 1, amount: q2.amount }]);
    const pf = await getOrder(p.id);
    expect(pf.status).toBe('kapali');
    // Latte LafPOS'ta alındı (fişi ayrıca kesilir); cihaz fişleri ile o ödeme birlikte LafPOS dökümünü verir
    const lattePaid = pf.payments.find((x) => x.items?.some((i) => i.itemId === latte.id))!.amount;
    const all = lafposByRate(pf);
    expect(deviceByRate([q1.basket, q2.basket])).toEqual({ '10': all['10'] - lattePaid, '20': all['20'] });

    // Kuruşluk yuvarlama oranlar arasında dengelenir, fişe "İndirim farkı" satırı yazılmaz
    const { buildBasket } = await import('../server/okc/basket');
    const line = (id: string, kdvRate: number, unitPrice: number, paidQty: number) => ({ id, name: id, size: 'TEK' as const, qty: 1, paidQty, unitPrice, kdvRate, voided: false, complimentary: false });
    const built = buildBasket({
      basketId: 'b',
      orderNo: 1,
      title: 'T',
      sectionMap: { '10': 1, '20': 2 },
      sizeLabels: { M: 'Orta', L: 'Büyük' },
      items: [line('a', 10, 1100, 1), line('b', 20, 1100, 0)],
      totals: { lineNet: { a: 1001, b: 999 }, service: 0, kdv: [{ rate: 10, gross: 1001, base: 910, kdv: 91 }, { rate: 20, gross: 999, base: 833, kdv: 166 }] },
      remainingDue: 1000,
      prior: { byRate: { '10': 1000 }, service: 0 },
    });
    expect(built.amount).toBe(1000);
    expect(built.basket.items.map((i) => i.name)).toEqual(['b']);
    // Ödenmiş orana düşen eksi fark servis satırına yazılmaz: servis LafPOS'unkiyle aynı, fark diğer oranın indirimine
    const withService = buildBasket({
      basketId: 'c',
      orderNo: 1,
      title: 'T',
      sectionMap: { '10': 1, '20': 2 },
      sizeLabels: { M: 'Orta', L: 'Büyük' },
      items: [line('a', 10, 1100, 1), line('b', 20, 2000, 0)],
      totals: { lineNet: { a: 900, b: 1900 }, service: 100, kdv: [{ rate: 10, gross: 1000, base: 909, kdv: 91 }, { rate: 20, gross: 1900, base: 1583, kdv: 317 }] },
      remainingDue: 1800,
      prior: { byRate: { '10': 1100 }, service: 0 },
    });
    expect(withService.amount).toBe(1800);
    expect(withService.basket.items.map((i) => [i.name, i.price, i.adjust?.totalValue ?? 0])).toEqual([
      ['b', 2000, 300],
      ['Servis ücreti', 100, 0],
    ]);
    // Sepette indirimi taşıyacak kalem kalmadıysa (yalnız servis) fark son çare servis satırına yazılır; sıfırlanan
    // satır gitmez
    const onlyService = (due: number) =>
      buildBasket({
        basketId: 'd',
        orderNo: 1,
        title: 'T',
        sectionMap: { '10': 1, '20': 2 },
        sizeLabels: { M: 'Orta', L: 'Büyük' },
        items: [line('a', 10, 1100, 1)],
        totals: { lineNet: { a: 900 }, service: 300, kdv: [{ rate: 10, gross: 1200, base: 1091, kdv: 109 }] },
        remainingDue: due,
        prior: { byRate: { '10': 1100 }, service: 0 },
      });
    expect(onlyService(100).basket.items.map((i) => [i.name, i.price])).toEqual([['Servis ücreti', 100]]);
    expect(() => onlyService(0)).toThrow(/ücretli kalem yok/);
  });

  it('her cihaz sonucu denetim kaydına yazılır: cihazda vazgeçme ve LafPOS’tan sepet iptali', async () => {
    const o = await order([{ name: 'Türk Kahvesi' }]);
    const r1 = await send(o.id);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${r1.id}/cancel`, {});
    const r2 = await send(o.id);
    await h.ok('kasa', 'POST', `/okc/receipts/${r2.id}/cancel`, {});
    const mine = (await audits()).filter((a) => a.orderId === o.id).map((a) => a.action);
    expect(mine).toEqual(expect.arrayContaining(['okc.send', 'okc.cancelled', 'okc.delete']));
    // Aynı vazgeçme ikinci kez gelirse kayıt ve durum değişmez
    const { applySale } = await import('../server/okc/service');
    applySale(r1.id, { basketID: r1.id, status: -1 }, 'webhook');
    expect((await audits()).filter((a) => a.orderId === o.id && a.action === 'okc.cancelled')).toHaveLength(1);
    expect((await receipts(o.id)).map((x) => x.status)).toEqual(['silindi', 'iptal']);
    await h.ok('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Vazgeçti', approverPin: MUDUR });
  });

  // ─── İkinci tur (bağımsız inceleme, 27 Eki 2026) ───────────────────────────

  it('belgesi kesilmiş eksik ödemeli (hata) sepet LafPOS’ta iptal sayılmaz; cihazda fiş iptali alınan ödemeyi geri alır', async () => {
    await provider('tokenx');
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }]);
    const unit = o.total / 2;
    const r = await send(o.id);
    // Kasiyer "İptal"e basar; Token'a ulaşılamıyor, arayüz yetkili onayıyla zorla iptal sorar
    del = 'unreachable';
    const first = await h.call<{ code: string }>('kasa', 'POST', `/okc/receipts/${r.id}/cancel`, {});
    expect(first.json.code).toBe('okc_delete');
    // Onay penceresi açıkken cihazda fiş kesildi: bir kahve ikram, biri kartla
    expect((await webhook({ basketID: r.id, status: 0, zNo: 5, receiptNo: 77, paymentItems: [{ type: 9, amount: unit }, { type: 3, amount: unit }] })).status).toBe(200);
    expect((await receipts(o.id))[0].status).toBe('hata');
    const forced = await h.call<{ code: string }>('kasa', 'POST', `/okc/receipts/${r.id}/cancel`, { force: true, approverPin: MUDUR });
    del = 'ok';
    expect(forced.status).toBe(409);
    expect(forced.json.code).toBe('okc_unresolved');
    // Onaysız iptal ucu da (kasiyer, API'den) belgeli sepeti silemez
    const plain = await h.call<{ code: string }>('kasa', 'POST', `/okc/receipts/${r.id}/cancel`, {});
    expect(plain.status).toBe(409);
    expect(plain.json.code).toBe('okc_unresolved');
    expect((await receipts(o.id))[0].status).toBe('hata');
    expect((await audits()).filter((a) => a.orderId === o.id && (a.action === 'okc.delete' || a.action === 'okc.force_cancel'))).toEqual([]);
    // Aynı kahve ikinci fişe gitmez
    const again = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: o.items[0].id, qty: 1 }] });
    expect(again.json.code).toBe('okc_unresolved');
    // Cihazda fiş iptal edilir: kartla alınan ödeme LafPOS'ta geri alınır
    await webhook({ basketID: r.id, status: 99 });
    const fin = await getOrder(o.id);
    expect(fin.payments.map((p) => [p.methodName, !!p.refundedAt])).toEqual([['Kredi kartı', true]]);
    expect(fin.paid).toBe(0);
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
    expect((await audits()).find((a) => a.orderId === o.id && a.action === 'okc.void')).toMatchObject({ severity: 'alarm' });
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Fiş iptal edildi' });
    await provider('simulator');
  });

  it('eski kayıt: belgeli sepet "silindi" olmuşsa da fiş iptali alınan ödemeyi geri alır', async () => {
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }]);
    const r = await send(o.id);
    await simPay(r.id, [{ type: 9, amount: 14000 }, { type: 3, amount: r.amount - 14000 }]);
    // Bu düzeltmeden önce iptal ucu belgeli sepeti "silindi" yapabiliyordu
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.fiscalReceipts).set({ status: 'silindi' }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    expect((await simVoid(r.id)).status).toBe(200);
    const fin = await getOrder(o.id);
    expect(fin.payments.filter((p) => !p.refundedAt)).toEqual([]);
    expect(fin.paid).toBe(0);
    expect((await receipts(o.id))[0].status).toBe('fis_iptal');
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Fiş iptal edildi' });
  });

  it('200 yanıtının gövdesi okunamazsa (bağlantı koptu, zaman aşımı) sepet bekleyen kalır; adisyon ikinci kez tahsil edilmez', async () => {
    await provider('tokenx');
    const o = await order([{ name: 'Türk Kahvesi' }]);
    instant = 'truncated';
    const res = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    instant = 'ok';
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('okc_unknown');
    const [rec] = await receipts(o.id);
    expect(rec.status).toBe('gonderildi');
    const pay = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    expect(pay.json.code).toBe('okc_pending');
    // Müşteri cihazda kartla ödedi: sonuç işlenir, adisyon kapanır
    await webhook({ basketID: rec.id, status: 0, zNo: 6, receiptNo: 80, paymentItems: [{ type: 3, amount: rec.amount }] });
    expect(await getOrder(o.id)).toMatchObject({ status: 'kapali', paid: o.total });
    expect((await receipts(o.id))[0].status).toBe('tamamlandi');

    // 2xx ama JSON olmayan gövde (ağ geçidi sayfası): istek kabul edilmiş olabilir, kesin ret sayılmaz
    const { TokenxClient, TokenxError } = await import('../server/okc/tokenx');
    const c = new TokenxClient({ authUrl: BASE, basketUrl: BASE, settingsUrl: BASE, clientId: 'id', clientSecret: 'secret', terminalId: 'T1', branchId: '', appResource: '' });
    instant = 'garbled';
    const err = await c.sendInstantBasket({ basketID: 'garbled-1', items: [] }).catch((e: unknown) => e);
    instant = 'ok';
    expect(err).toBeInstanceOf(TokenxError);
    expect(err).toMatchObject({ uncertain: true });
    // Token'ın kodla verdiği ret kesin kalır
    instant = 'reject';
    expect(await c.sendInstantBasket({ basketID: 'reject-1', items: [] }).catch((e: unknown) => e)).toMatchObject({ code: '1100', uncertain: false });
    instant = 'ok';
    await provider('simulator');
  });

  it('aynı 99 ikinci kez gelince kayıt tekrarlanmaz; LafPOS’ta silinen sepet "silindi" kalır', async () => {
    const { applySale } = await import('../server/okc/service');
    const o = await order([{ name: 'Türk Kahvesi' }]);
    const r1 = await send(o.id);
    applySale(r1.id, { basketID: r1.id, status: 99 }, 'webhook');
    applySale(r1.id, { basketID: r1.id, status: 99 }, 'webhook');
    const r2 = await send(o.id);
    await h.ok('kasa', 'POST', `/okc/receipts/${r2.id}/cancel`, {});
    applySale(r2.id, { basketID: r2.id, status: 99 }, 'webhook');
    applySale(r2.id, { basketID: r2.id, status: 99 }, 'webhook');
    const mine = (await audits()).filter((a) => a.orderId === o.id);
    expect(mine.filter((a) => a.action === 'okc.cancelled')).toHaveLength(1);
    // Silinen sepete gelen 99 yalnız bir kez not düşer; "fiş kesilmemişti" demez
    const notes = mine.filter((a) => a.action === 'okc.void');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).not.toContain('fiş kesilmemişti');
    const st = Object.fromEntries((await receipts(o.id)).map((x) => [x.id === r1.id ? 'r1' : 'r2', x.status]));
    expect(st).toEqual({ r1: 'iptal', r2: 'silindi' });

    // Zorla iptal sonrası geç gelen "ödendi" tek alarm verir; ardından gelen 99 fişin kesilip iptal edildiğini yazar
    const r3 = await send(o.id);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${r3.id}/cancel`, {});
    const paid = { basketID: r3.id, status: 0, zNo: 9, receiptNo: 5, paymentItems: [{ type: 3, amount: r3.amount }] };
    applySale(r3.id, paid, 'webhook');
    applySale(r3.id, paid, 'webhook');
    expect((await audits()).filter((a) => a.orderId === o.id && a.action === 'okc.late_paid')).toHaveLength(1);
    expect(await getOrder(o.id)).toMatchObject({ status: 'acik', paid: 0 });
    applySale(r3.id, { basketID: r3.id, status: 99 }, 'webhook');
    applySale(r3.id, { basketID: r3.id, status: 99 }, 'webhook');
    const voids = (await audits()).filter((a) => a.orderId === o.id && a.action === 'okc.void' && a.severity === 'alarm');
    expect(voids).toHaveLength(1);
    expect(voids[0].message).toContain('fişi');
    expect((await receipts(o.id)).find((x) => x.id === r3.id)?.status).toBe('fis_iptal');
    expect(await getOrder(o.id)).toMatchObject({ status: 'acik', paid: 0 });
    await h.ok('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'deneme', approverPin: MUDUR });
  });

  it('kalem ödemesinden sonra kalem iptali indirimi yeniden dağıtsa da cihazdaki servis LafPOS servisine eşit', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
    let o = await order(
      [
        { name: 'Karaoke kişi başı', qty: 2 },
        { name: 'Yenilebilir bardak', qty: 2 },
        { name: 'Etkinlik ücreti', qty: 1 },
      ],
      { type: 'masa', tableId: tables()[8].id },
    );
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 8682, reason: 'Kampanya', approverPin: MUDUR });
    const cup = o.items.find((i) => i.name === 'Yenilebilir bardak')!;
    const r1 = await send(o.id, [{ itemId: cup.id, qty: 2 }]);
    await simPay(r1.id, [{ type: 3, amount: r1.amount }]);
    const ev = o.items.find((i) => i.name === 'Etkinlik ücreti')!;
    await h.ok('mudur', 'POST', `/orders/${o.id}/items/${ev.id}/void`, { reason: 'Vazgeçti' });
    const r2 = await send(o.id);
    await simPay(r2.id, [{ type: 3, amount: r2.amount }]);
    const fin = await getOrder(o.id);
    const onDevice = [...r1.basket.items, ...r2.basket.items].filter((i) => i.name === 'Servis ücreti').reduce((a, i) => a + i.price, 0);
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 0 });
    expect(fin.status).toBe('kapali');
    expect(onDevice).toBe(fin.totals.service);
    // Ödenmiş orana (%10) düşen eksi fark diğer oranın (Karaoke, %20) indirimine yazıldı
    expect(r2.basket.items.find((i) => i.name.startsWith('Karaoke'))?.adjust?.totalValue).toBeGreaterThan(0);
  });

  it('ödemesiz kalan fişin açığı kasadan alınınca masanın fişe girmemiş kalemleri cihaza gider; fişteki kalem gitmez', async () => {
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }, { name: 'Latte', size: 'M' }], { type: 'masa', tableId: tables()[5].id });
    const coffee = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    const latte = o.items.find((i) => i.name === 'Latte')!;
    const r = await send(o.id, [{ itemId: coffee.id, qty: 2 }]);
    await simPay(r.id, [{ type: 9, amount: 14000 }, { type: 3, amount: r.amount - 14000 }]);
    expect((await receipts(o.id))[0].status).toBe('hata');
    // Açık (ikram edilen 140 TL) kasadan alınır
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 14000 });
    // Fişteki kahve yine gitmez; bütün adisyon da gitmez (kahve içinde)
    const coffeeAgain = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: coffee.id, qty: 1 }] });
    expect(coffeeAgain.json.code).toBe('okc_unresolved');
    // Hiçbir fişte olmayan Latte gider; ödenince adisyon kapanır
    const res = await h.call<{ receipt: Receipt; code?: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: latte.id, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.json.receipt.basket.items.map((i) => i.name.startsWith('Latte'))).toEqual([true]);
    await simPay(res.json.receipt.id, [{ type: 3, amount: res.json.receipt.amount }]);
    expect(await getOrder(o.id)).toMatchObject({ status: 'kapali' });
  });

  it('ödemesiz kalan fişin kalemi başka masaya taşınamaz; fişe girmemiş kalem taşınır', async () => {
    const [ta, tb] = [tables()[6], tables()[7]];
    const o = await order([{ name: 'Türk Kahvesi', qty: 2 }, { name: 'Latte', size: 'M' }], { type: 'masa', tableId: ta.id });
    const coffee = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    const latte = o.items.find((i) => i.name === 'Latte')!;
    const r = await send(o.id, [{ itemId: coffee.id, qty: 2 }]);
    await simPay(r.id, [{ type: 9, amount: 14000 }, { type: 3, amount: r.amount - 14000 }]);
    const moved = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: coffee.id, qty: 1 }], tableId: tb.id, approverPin: MUDUR });
    expect(moved.status).toBe(409);
    expect(moved.json.code).toBe('okc_unresolved');
    expect((await getOrder(o.id)).items.find((i) => i.id === coffee.id)?.qty).toBe(2);
    const ok = await h.call<{ target: OrderDTO }>('kasa', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: latte.id, qty: 1 }], tableId: tb.id, approverPin: MUDUR });
    expect(ok.status).toBe(200);
    expect(ok.json.target.items.map((i) => i.name)).toEqual(['Latte']);
    await h.ok('kasa', 'POST', `/orders/${ok.json.target.id}/cancel`, { reason: 'deneme', approverPin: MUDUR });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 14000 });
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
