import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { calcOrder } from '@shared/order-calc';
import type { OrderDTO } from '@shared/types';
import { buildBasket } from '../server/okc/basket';
import { type Harness, PINS, startApp } from './harness';

/**
 * Bağımsız incelemenin bulguları (26 Eki 2026), her biri bir testle: yazarkasada bekleyen sepet, fazla ödeme,
 * QR siparişine taşıma, çift seçim, damga geri alma, cihazda açık hesap, geç gelen "ödendi", servis ücreti,
 * kör kasada ödeme dökümü, yetki yükseltme, yeniden sayım, bir iş gününe tek Z, lafmaliyet 409 ve PIN sınırı.
 */
let h: Harness;
let lafmaliyet: Server;
let lmStatus = 409;
const lmBodies: { date: string; z: Record<string, number | null> }[] = [];
const MUDUR = PINS.mudur;

beforeAll(async () => {
  // Sahte lafmaliyet: gün sonu itmesini kaydeder, istenen durumla yanıtlar
  lafmaliyet = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lmBodies.push(JSON.parse(raw));
      res.writeHead(lmStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lmStatus === 409 ? { error: 'z_conflict', date: 'x', zNo: 1 } : { ok: true, date: 'x', lines: 0 }));
    });
  });
  await new Promise<void>((r) => lafmaliyet.listen(0, '127.0.0.1', r));
  const port = (lafmaliyet.address() as AddressInfo).port;
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${port}`, LAFMALIYET_SYNC_SECRET: 'x'.repeat(48) });
});

afterAll(() => {
  lafmaliyet.close();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const audit = (severity: 'alarm' | 'uyari') => h.ok<{ action: string; userName: string | null; approverName: string | null }[]>('patron', 'GET', `/admin/audit?severity=${severity}&limit=500`);

async function newOrder(items: { name: string; qty?: number; size?: 'M' | 'L' }[], extra: Record<string, unknown> = {}) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', ...extra });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}
const sendToDevice = (orderId: string) => h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${orderId}/send`, {});
const payOnDevice = (receiptId: string, type: number, amount: number) => h.ok('kasa', 'POST', `/okc/simulator/baskets/${receiptId}/pay`, { payments: [{ type, amount }] });
const customer = (id: string) =>
  h.ok<{ customer: { balance: number; visits: number; stamps: number; totalSpent: number }; ledger: { kind: string; amount: number }[] }>('kasa', 'GET', `/customers/${id}`);

/** Kartla ödenmiş, gün sonundan sonra fiş iptali denenecek sepet */
let paidReceipt: { id: string; orderId: string };

describe('inceleme düzeltmeleri', () => {
  it('gün açılır', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 50000 });
  });

  it('yazarkasada bekleyen sepet: tutar ve ödeme değişmez, kalem eklenebilir', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M' }, { name: 'Türk Kahvesi' }]);
    const sent = await sendToDevice(o.id);
    expect(sent.receipt.amount).toBe(o.total);
    const latte = o.items.find((i) => i.name === 'Latte')!;
    const blocked: [string, unknown][] = [
      [`/orders/${o.id}/items/${latte.id}/void`, { reason: 'Yanlış ürün', approverPin: MUDUR }],
      [`/orders/${o.id}/items/${latte.id}/comp`, { reason: 'İkram', approverPin: MUDUR }],
      [`/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Öğrenci', approverPin: MUDUR }],
      [`/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 1000 }],
      [`/orders/${o.id}/cancel`, { reason: 'Vazgeçti', approverPin: MUDUR }],
    ];
    for (const [path, body] of blocked) {
      const r = await h.call<{ code: string }>('kasa', 'POST', path, body);
      expect(r.status, path).toBe(409);
      expect(r.json.code, path).toBe('okc_pending');
    }
    // Kalem eklemek serbest; cihazdaki sepet aynı kalır, eklenen kalem ödenmeyi bekler
    const more = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    expect(more.total).toBeGreaterThan(o.total);
    await payOnDevice(sent.receipt.id, 3, sent.receipt.amount);
    const after = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(after.status).toBe('acik');
    expect(after.paid).toBe(o.total);
    const last = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: after.total - after.paid });
    expect(last.closed).toBe(true);
    paidReceipt = { id: sent.receipt.id, orderId: o.id };
  });

  it('indirim, ikram ya da iptal ödenmiş tutarın altına indiremez', async () => {
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }]);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: Math.round(o.total * 0.75) });
    const r = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 50, reason: 'Öğrenci', approverPin: MUDUR });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('overpaid');
    // İşlem bütünüyle geri alındı
    const same = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(same.total).toBe(o.total);
    expect(same.totals.orderDiscount).toBe(0);
    const done = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: same.total - same.paid });
    expect(done.closed).toBe(true);
  });

  it('kalem taşıma sitede ödenmiş QR siparişine eklemez, kasa adisyonu açar', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const [from, to] = h.boot.tables.filter((t) => t.kind === 'masa').slice(3, 5);
    const day = (await h.ok<{ day: { id: string } }>('kasa', 'GET', '/cash/day')).day;
    const now = Date.now();
    db.insert(schema.orders)
      .values({ id: 'qr-deneme', dayId: day.id, no: 9001, type: 'masa', tableId: to.id, openedAt: now, updatedAt: now, source: 'laffogato', extId: 'ord-9001', extPaid: true, extTotal: 19500 })
      .run();
    let src = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: from.id });
    src = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${src.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    const moved = await h.ok<{ source: OrderDTO; target: OrderDTO }>('kasa', 'POST', `/orders/${src.id}/transfer`, { items: [{ itemId: src.items[0].id, qty: 1 }], tableId: to.id });
    expect(moved.target.id).not.toBe('qr-deneme');
    expect(moved.target.source).toBe('pos');
    expect(moved.target.extPaid).toBe(false);
    expect(db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, 'qr-deneme')).all()).toHaveLength(0);
    // Toparla: taşınan kalem ödenir, boş kalan kaynak adisyon iptal edilir
    await h.ok('kasa', 'POST', `/orders/${moved.target.id}/payments`, { methodId: method('Nakit').id, amount: moved.target.total });
    const left = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${src.id}`);
    if (left.status === 'acik') await h.ok('mudur', 'POST', `/orders/${src.id}/cancel`, { reason: 'Kalemler taşındı' });
  });

  it('aynı kalem iki kez seçilirse bir kez ücretlenir', async () => {
    const { mergeSelection } = await import('../server/services/orders');
    expect(
      mergeSelection([
        { itemId: 'a', qty: 1 },
        { itemId: 'a', qty: 2 },
        { itemId: 'b', qty: 0 },
      ]),
    ).toEqual([{ itemId: 'a', qty: 3 }]);
    const o = await newOrder([{ name: 'Türk Kahvesi' }, { name: 'Latte', size: 'M' }]);
    const tk = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    const r = await h.ok<{ order: OrderDTO }>('kasa', 'POST', `/orders/${o.id}/payments`, {
      methodId: method('Kredi kartı').id,
      amount: 0,
      items: [
        { itemId: tk.id, qty: 1 },
        { itemId: tk.id, qty: 1 },
      ],
    });
    expect(r.order.paid).toBe(o.totals.lineNet[tk.id]);
    expect(r.order.items.find((i) => i.id === tk.id)?.paidQty).toBe(1);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: r.order.total - r.order.paid });
  });

  it('yeniden açma ve ödeme iptali müşterinin ziyaret, harcama ve damgasını geri alır', async () => {
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Damga Deneme' });
    const o = await newOrder([{ name: 'Latte', size: 'M', qty: 2 }], { customerId: cust.id });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    const first = (await customer(cust.id)).customer;
    expect(first).toMatchObject({ visits: 1, totalSpent: o.total });
    expect(first.stamps).toBeGreaterThan(0);

    expect((await h.call('kasa', 'POST', `/orders/${o.id}/reopen`, { reason: 'Yanlış ödeme türü' })).status).toBe(403);
    await h.ok('kasa', 'POST', `/orders/${o.id}/reopen`, { reason: 'Yanlış ödeme türü', approverPin: MUDUR });
    expect((await customer(cust.id)).customer).toMatchObject({ visits: 0, stamps: 0, totalSpent: 0 });
    // Aç-kapa damga biriktirmez: yeniden kapanınca bir kez yazılır
    await h.ok('kasa', 'POST', `/orders/${o.id}/close`);
    expect((await customer(cust.id)).customer).toMatchObject({ visits: 1, stamps: first.stamps, totalSpent: o.total });

    const closed = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments/${closed.payments[0].id}/refund`, { reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    expect((await customer(cust.id)).customer).toMatchObject({ visits: 0, stamps: 0, totalSpent: 0 });
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Müşteri vazgeçti' });
  });

  it('cihazda açık hesap: müşterisiz adisyon ve sınır aşımı alarm verir; fiş iptali onay ister, cariyi düzeltir', async () => {
    const lone = await newOrder([{ name: 'Türk Kahvesi' }]);
    const s1 = await sendToDevice(lone.id);
    await payOnDevice(s1.receipt.id, 17, s1.receipt.amount);
    expect((await audit('alarm')).some((a) => a.action === 'okc.cari_no_customer')).toBe(true);

    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Cari Deneme', creditLimit: 1000 });
    const o = await newOrder([{ name: 'Latte', size: 'M' }], { customerId: cust.id });
    const s2 = await sendToDevice(o.id);
    await payOnDevice(s2.receipt.id, 17, s2.receipt.amount);
    expect((await audit('alarm')).some((a) => a.action === 'okc.credit_limit')).toBe(true);
    let detail = await customer(cust.id);
    expect(detail.customer.balance).toBe(o.total);
    expect(detail.customer.visits).toBe(1);
    expect(detail.ledger.map((l) => l.kind)).toContain('borc');

    const denied = await h.call<{ code: string }>('kasa', 'POST', `/okc/simulator/baskets/${s2.receipt.id}/cancel`, { voidReceipt: true });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('approval_required');
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${s2.receipt.id}/cancel`, { voidReceipt: true, approverPin: MUDUR });
    detail = await customer(cust.id);
    expect(detail.customer.balance).toBe(0);
    expect(detail.customer.visits).toBe(0);
    expect(detail.ledger.find((l) => l.kind === 'duzeltme')?.amount).toBe(-o.total);
    const voided = (await audit('alarm')).find((a) => a.action === 'okc.void');
    expect(voided).toMatchObject({ userName: 'Kasa', approverName: 'Müdür' });
    const reopened = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(reopened).toMatchObject({ status: 'acik', paid: 0 });
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Fiş iptal edildi' });
  });

  it('iptal sayılan sepete geç gelen "ödendi" adisyonu kapatmaz, alarm verir', async () => {
    const o = await newOrder([{ name: 'Türk Kahvesi' }]);
    const sent = await sendToDevice(o.id);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/cancel`, {});
    const { applySale } = await import('../server/okc/service');
    applySale(sent.receipt.id, { basketID: sent.receipt.id, status: 0, paymentItems: [{ type: 3, amount: sent.receipt.amount }] }, 'webhook');
    expect(await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).toMatchObject({ status: 'acik', paid: 0 });
    expect((await audit('alarm')).some((a) => a.action === 'okc.late_paid')).toBe(true);
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Cihazda vazgeçildi' });
  });

  it('servis ücreti cihaza ayrı satır olarak gider; kalem seçiminde gitmez', () => {
    const line = { id: 'a', qty: 1, unitPrice: 10000, kdvRate: 10, discount: 0, complimentary: false, voided: false };
    const totals = calcOrder({ lines: [line], serviceRate: 10 });
    expect(totals.total).toBe(11000);
    const input = {
      basketId: '00000000-0000-4000-8000-000000000009',
      orderNo: 7,
      title: 'Masa 4',
      sectionMap: { '1': 3, '10': 1, '20': 2 },
      sizeLabels: { M: 'Orta', L: 'Büyük' },
      items: [{ id: 'a', name: 'Latte', size: 'M' as const, qty: 1, paidQty: 0, unitPrice: 10000, kdvRate: 10, voided: false, complimentary: false }],
      totals,
      remainingDue: totals.total,
    };
    const whole = buildBasket(input);
    expect(whole.amount).toBe(totals.total);
    expect(whole.basket.items.at(-1)).toMatchObject({ name: 'Servis ücreti', price: 1000, sectionNo: 1, taxPercent: 1000, quantity: 1000 });
    const picked = buildBasket({ ...input, selection: [{ itemId: 'a', qty: 1 }] });
    expect(picked.amount).toBe(10000);
    expect(picked.basket.items.some((i) => i.name === 'Servis ücreti')).toBe(false);
  });

  it('kör kasa: kasiyer kapanmış adisyonların ödeme dökümünü görmez, müdür görür', async () => {
    const asKasa = await h.ok<OrderDTO[]>('kasa', 'GET', '/orders?status=kapali');
    expect(asKasa.length).toBeGreaterThan(0);
    expect(asKasa.every((o) => o.payments.length === 0)).toBe(true);
    const asMudur = await h.ok<OrderDTO[]>('mudur', 'GET', '/orders?status=kapali');
    expect(asMudur.some((o) => o.payments.length > 0)).toBe(true);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${paidReceipt.orderId}`)).payments).toEqual([]);
    expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${paidReceipt.orderId}`)).payments.length).toBeGreaterThan(0);
  });

  it('yetki yükseltme yok; kimse kendi rolünü ve yetkisini değiştiremez', async () => {
    const created = await h.ok<{ id: string }>('patron', 'POST', '/admin/users', { name: 'Vardiya sorumlusu', role: 'garson', permGrant: ['personel.yonet'], pin: '5555' });
    await h.login('sorumlu', '5555');
    const users = await h.ok<{ id: string; name: string }[]>('patron', 'GET', '/admin/users');
    const garson = users.find((u) => u.name === 'Garson')!;
    const roles = await h.ok<{ roles: { role: string; permissions: string[] }[] }>('patron', 'GET', '/admin/roles');
    const garsonPerms = roles.roles.find((r) => r.role === 'garson')!.permissions;

    const attempts: [string, string, unknown][] = [
      ['PATCH', `/admin/users/${garson.id}`, { permGrant: ['rapor.maliyet'] }],
      ['PUT', '/admin/roles/garson', { permissions: [...garsonPerms, 'rapor.gor'] }],
      ['POST', '/admin/users', { name: 'Yeni müdür', role: 'mudur', pin: '5656' }],
    ];
    for (const [verb, path, body] of attempts) {
      const r = await h.call<{ code: string }>('sorumlu', verb, path, body);
      expect(r.status, path).toBe(403);
      expect(r.json.code, path).toBe('escalation');
    }
    // Kendi yetkisinin altındaki rolü açabilir
    await h.ok('sorumlu', 'POST', '/admin/users', { name: 'Yeni garson', role: 'garson', pin: '5657' });

    for (const body of [{ role: 'kasiyer' }, { maxDiscountPct: 50 }, { permRevoke: ['siparis.al'] }]) {
      const r = await h.call<{ code: string }>('sorumlu', 'PATCH', `/admin/users/${created.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.code).toBe('self_edit');
    }
    await h.ok('sorumlu', 'PATCH', `/admin/users/${created.id}`, { name: 'Vardiya şefi' });
    // Yalnız ad değişti: kişiye özel yetki duruyor
    expect((await h.ok<{ id: string; permGrant: string[] }[]>('patron', 'GET', '/admin/users')).find((u) => u.id === created.id)?.permGrant).toEqual(['personel.yonet']);
    const patron = users.find((u) => u.name === 'Patron')!;
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${patron.id}`, { role: 'mudur' })).json.code).toBe('self_edit');
  });

  it('düzenleme gönderilmeyen alanı varsayılanla ezmez (masa, rezervasyon, ödeme türü)', async () => {
    type Table = { id: string; name: string; kind: string; x: number; y: number; w: number; h: number; seats: number; shape: string };
    const room = h.boot.tables.find((t) => t.kind === 'oda')! as unknown as Table;
    await h.ok('patron', 'PATCH', `/admin/tables/${room.id}`, { name: 'Karaoke' });
    const renamed = (await h.ok<{ tables: Table[] }>('patron', 'GET', '/bootstrap')).tables.find((t) => t.id === room.id)!;
    expect(renamed).toMatchObject({ name: 'Karaoke', kind: 'oda', x: room.x, y: room.y, w: room.w, h: room.h, seats: room.seats, shape: room.shape });
    await h.ok('patron', 'PATCH', `/admin/tables/${room.id}`, { name: room.name });

    const day = (await h.ok<{ day: { date: string } }>('kasa', 'GET', '/cash/day')).day.date;
    const r = await h.ok<{ id: string }>('kasa', 'POST', '/reservations', { date: day, time: '20:30', name: 'Ece', guests: 6, durationMin: 90 });
    await h.ok('kasa', 'PATCH', `/reservations/${r.id}`, { status: 'geldi' });
    const list = await h.ok<{ id: string; status: string; guests: number; durationMin: number }[]>('kasa', 'GET', `/reservations?date=${day}`);
    expect(list.find((x) => x.id === r.id)).toMatchObject({ status: 'geldi', guests: 6, durationMin: 90 });

    const methods = await h.ok<{ id: string; name: string; sort: number; color: string; active: boolean }[]>('patron', 'GET', '/admin/payment-methods');
    const cari = methods.find((m) => m.name === 'Açık hesap')!;
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${cari.id}`, { name: 'Açık hesap (cari)' });
    const after = (await h.ok<typeof methods>('patron', 'GET', '/admin/payment-methods')).find((m) => m.id === cari.id)!;
    expect(after).toMatchObject({ name: 'Açık hesap (cari)', sort: cari.sort, color: cari.color, active: cari.active });
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${cari.id}`, { name: cari.name });

    // Bundan sonra da: düzenleme uçları `.partial()` değil `patchOf` kullanır
    const routes = readdirSync('server/routes').map((f) => readFileSync(`server/routes/${f}`, 'utf8'));
    expect(routes.filter((src) => src.includes('.partial()'))).toEqual([]);
  });

  it('gün sonu: lafmaliyet 409 kalıcı hata, yeniden sayım onay ister, aynı tarihe ikinci Z açılmaz', async () => {
    const { db, schema } = await import('../server/db/client');
    const x = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closed = await h.ok<{ day: { id: string; zNo: number; date: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });

    // lafmaliyet aynı tarihte başka Z gördü (409): giden kutusu bir daha denemez
    await vi.waitFor(() => expect(db.select().from(schema.outbox).all().some((r) => r.lastError?.includes('409'))).toBe(true), { timeout: 5000, interval: 50 });
    const row = db.select().from(schema.outbox).all().find((r) => r.lastError?.includes('409'))!;
    expect(row.sentAt).toBeNull();
    expect(row.nextAttemptAt).toBeGreaterThan(Date.now() + 300 * 86400_000);
    // Gövde kasaya giren nakdi ve beklenen nakdi taşır (lafmaliyet beklenen nakdi bunlarla eşitler)
    const pushed = lmBodies.at(-1)!;
    expect(pushed.date).toBe(closed.day.date);
    expect(pushed.z.zNo).toBe(closed.day.zNo);
    expect(pushed.z.expectedCash).toBeCloseTo(x.summary.expectedCash / 100, 2);
    expect(pushed.z.cashIn).toBe(0);

    // Kaydedilmiş sayımı değiştirmek yetkili onayı ister
    const recount = await h.call<{ code: string }>('kasa', 'POST', `/cash/days/${closed.day.id}/count`, { countedCash: x.summary.expectedCash - 500 });
    expect(recount.status).toBe(403);
    expect(recount.json.code).toBe('approval_required');
    await h.ok('kasa', 'POST', `/cash/days/${closed.day.id}/count`, { countedCash: x.summary.expectedCash - 500, approverPin: MUDUR });
    expect((await audit('alarm')).some((a) => a.action === 'day.recount')).toBe(true);

    // Bir iş gününe tek Z: yeni gün açılmaz, kasa ekranı kapanmış günü gösterir
    const again = await h.call<{ code: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('day_closed_today');
    const state = await h.ok<{ day: null; closedToday: { id: string; zNo: number } | null }>('kasa', 'GET', '/cash/day');
    expect(state.day).toBeNull();
    expect(state.closedToday).toMatchObject({ id: closed.day.id, zNo: closed.day.zNo });

    // Kapanmış güne ait fiş, gün açılmadan iptal edilemez
    const late = await h.call<{ code: string }>('kasa', 'POST', `/okc/simulator/baskets/${paidReceipt.id}/cancel`, { voidReceipt: true, approverPin: MUDUR });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('day_closed');

    // Yeniden açma: yetkili onayı ve neden ister, Z numarası değişmez
    expect((await h.call<{ code: string }>('kasa', 'POST', `/cash/days/${closed.day.id}/reopen`, { reason: 'Geç gelen müşteri' })).json.code).toBe('approval_required');
    expect((await h.call<{ code: string }>('kasa', 'POST', `/cash/days/${closed.day.id}/reopen`, { reason: ' ', approverPin: MUDUR })).json.code).toBe('reason_required');
    const reopened = await h.ok<{ id: string; zNo: number; closedAt: number | null }>('kasa', 'POST', `/cash/days/${closed.day.id}/reopen`, { reason: 'Geç gelen müşteri', approverPin: MUDUR });
    expect(reopened).toMatchObject({ id: closed.day.id, zNo: closed.day.zNo, closedAt: null });
    expect((await audit('alarm')).some((a) => a.action === 'day.reopen')).toBe(true);
    // Gitmemiş eski Z giden kutusundan düştü
    expect(db.select().from(schema.outbox).all().filter((r) => !r.sentAt)).toHaveLength(0);

    // Gün yeniden açıkken aynı günün fişi iptal edilir; adisyon açılır ve iptal edilir
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${paidReceipt.id}/cancel`, { voidReceipt: true, approverPin: MUDUR });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${paidReceipt.orderId}`)).status).toBe('acik');
    const refunded = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${paidReceipt.orderId}`);
    for (const p of refunded.payments.filter((p) => !p.refundedAt)) {
      await h.ok('kasa', 'POST', `/orders/${paidReceipt.orderId}/payments/${p.id}/refund`, { reason: 'Fiş iptal edildi', approverPin: MUDUR });
    }
    await h.ok('mudur', 'POST', `/orders/${paidReceipt.orderId}/cancel`, { reason: 'Fiş iptal edildi' });

    // Yeniden kapanınca lafmaliyet'e aynı tarih ve Z ile gider
    lmStatus = 200;
    const x2 = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closedAgain = await h.ok<{ day: { id: string; zNo: number } }>('kasa', 'POST', '/cash/day/close', { countedCash: x2.summary.expectedCash });
    expect(closedAgain.day).toMatchObject({ id: closed.day.id, zNo: closed.day.zNo });
    await vi.waitFor(() => expect(db.select().from(schema.outbox).all().some((r) => r.sentAt != null)).toBe(true), { timeout: 5000, interval: 50 });
    expect(lmBodies.at(-1)).toMatchObject({ date: closed.day.date, z: { zNo: closed.day.zNo } });
  });

  it('PIN sınırı X-Forwarded-For ile aşılmaz; ağ genelinde de sınır var', async () => {
    const { assertNotLocked, recordFailure, resetFailures } = await import('../server/lib/auth');
    resetFailures();
    for (let i = 0; i < 5; i++) {
      expect((await h.call('', 'POST', '/auth/login', { pin: '9090' }, { 'x-forwarded-for': `10.0.0.${i}` })).status).toBe(401);
    }
    const locked = await h.call<{ code: string }>('', 'POST', '/auth/login', { pin: PINS.kasa }, { 'x-forwarded-for': '10.0.0.99' });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('rate_limited');

    resetFailures();
    for (let i = 0; i < 30; i++) recordFailure('giris', `192.168.1.${i}`);
    expect(() => assertNotLocked('giris', '192.168.1.200')).toThrow(/Çok fazla hatalı PIN/);
    resetFailures();
    expect((await h.call('', 'POST', '/auth/login', { pin: PINS.kasa })).status).toBe(200);
  });
});
