import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tlPlain } from '@shared/money';
import { type OffDevicePayment, offDeviceTotals } from '@shared/order-calc';
import { sumOffDevice } from '@shared/remote-calc';
import type { OrderDTO, ZSummary } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * "Yazarkasadan geçmeyen" (docs/04-YAZARKASA.md §4.2): satış ödemelerinden mali fişi yazarkasada kesilmeyenlerin kart ve
 * nakit toplamı, bahşiş hariç. Tanım tek yerde (shared/order-calc.ts `offDeviceTotals`); X, Z, fiş, Raporlar, patron
 * paneli ve AsilPOS Uzaktan aynı rakamı yazar. Karışık ödemeli bir gün: cihazdan geçen kart, nakit ve yemek kartı, AsilPOS'ta
 * bahşişli kart, kısmi nakit (kalanı cihazdan ve AsilPOS'tan), yemek kartı, iptal edilip yeniden alınan ödeme, açık hesap
 * satışı ve tahsilatı. Kör kasaya gitmez; eski kasanın (alanı taşımayan) günü uzakta satır yazmaz, ₺0 göstermez.
 */

const pay = (id: string, zField: string, amount: number, extra: Partial<OffDevicePayment> = {}): OffDevicePayment => ({ id, orderId: 'o1', zField, amount, refundedAt: null, ...extra });

describe('tanım (saf işlev)', () => {
  it('cihaz fişinin ödemeleri düşülür; yalnız kart ve nakit; bahşiş, iptal ve tahsilat girmez', () => {
    const payments = [
      pay('cihaz-kart', 'card', 30000),
      pay('cihaz-nakit', 'cash', 12000),
      // Bahşiş ayrı alandadır (`tip`): yalnız satış tutarı sayılır
      { ...pay('kart', 'card', 25000), tip: 2500 } as OffDevicePayment,
      pay('kismi-nakit', 'cash', 4000),
      pay('yemek', 'meal_card', 9000),
      pay('havale', 'other', 7000),
      pay('iptal', 'cash', 5000, { refundedAt: 1 }),
      pay('tahsilat', 'cash', 8000, { orderId: null }),
    ];
    const receipts = [{ paymentIds: ['cihaz-kart'] }, { paymentIds: ['cihaz-nakit'] }, { paymentIds: [] }];
    expect(offDeviceTotals(payments, receipts)).toEqual({ card: 25000, cash: 4000 });
    // Fişi kesilen ödeme hangi türde olursa olsun dahil değil; fiş yoksa ikisi de sayılır
    expect(offDeviceTotals(payments, [])).toEqual({ card: 55000, cash: 16000 });
    expect(offDeviceTotals([], receipts)).toEqual({ card: 0, cash: 0 });
  });

  it('uzakta dönem toplamı: her iş günü alanı taşırsa toplanır; taşımayan gün (eski kasa) varsa yok', () => {
    const day = (n: number, off?: { card: number; cash: number }) => ({ n, s: off ? { off } : {} });
    expect(sumOffDevice([day(1, { card: 100, cash: 20 }), day(1, { card: 5, cash: 0 })])).toEqual({ card: 105, cash: 20 });
    expect(sumOffDevice([day(1, { card: 100, cash: 20 }), day(1)])).toBeNull();
    // İş günü olmayan (yalnız platform kaydı taşıyan) gün sayılmaz
    expect(sumOffDevice([day(1, { card: 100, cash: 20 }), day(0)])).toEqual({ card: 100, cash: 20 });
    expect(sumOffDevice([])).toEqual({ card: 0, cash: 0 });
  });
});

describe('karışık ödemeli gün (eğitim cihazıyla)', () => {
  let h: Harness;
  type Sent = { receipt: { id: string; amount: number; status: string } };
  type Summary = ZSummary & { offDevice: { card: number; cash: number } };
  const expected = { card: 0, cash: 0 };
  /** Cihazdan geçen kart ve nakit (çapraz denetim: Z'nin alanı = cihazdan geçen + geçmeyen) */
  const device = { card: 0, cash: 0 };
  let today = '';

  beforeAll(async () => {
    h = await startApp();
    await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  }, 60_000);
  afterAll(() => h?.cleanup());

  const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
  const newOrder = async (qty = 2, extra: Record<string, unknown> = {}) => {
    const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null, ...extra });
    return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty }] });
  };
  const payHere = (o: OrderDTO, name: string, amount: number, tip = 0) => h.ok<{ order: OrderDTO }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(name).id, amount, tip });
  const onDevice = async (o: OrderDTO, payments: { type: number; amount: number }[], items: { itemId: string; qty: number }[] | null = null) => {
    const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items });
    const done = await h.ok<{ status: string }>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: payments.map((p) => ({ ...p, amount: p.amount || sent.receipt.amount })) });
    expect(done.status).toBe('tamamlandi');
    return sent.receipt.amount;
  };

  it('gün: cihazdan ve AsilPOS’tan karışık ödemeler', async () => {
    // Cihazda kart: fişi kesildi, sayılmaz
    const a = await newOrder();
    await onDevice(a, [{ type: 3, amount: a.total }]);
    device.card += a.total;
    // Cihazda bölünmüş ödeme (nakit + kart): ikisi de cihazdan
    const b = await newOrder(3);
    const half = Math.floor(b.total / 2);
    await onDevice(b, [
      { type: 1, amount: half },
      { type: 3, amount: b.total - half },
    ]);
    device.cash += half;
    device.card += b.total - half;
    // AsilPOS'ta bahşişli kart: satış tutarı sayılır, bahşiş değil
    const c = await newOrder();
    await payHere(c, 'Kredi kartı', c.total, 500);
    expected.card += c.total;
    // Kısmi: çeyreği AsilPOS'ta nakit, bir kalemi cihazdan kart, kalanı AsilPOS'ta kart
    const d = await newOrder(2);
    const quarter = Math.floor(d.total / 4);
    const part = await payHere(d, 'Nakit', quarter);
    expected.cash += quarter;
    const basket = await onDevice(d, [{ type: 3, amount: 0 }], [{ itemId: part.order.items[0]!.id, qty: 1 }]);
    device.card += basket;
    const rest = d.total - quarter - basket;
    expect(rest).toBeGreaterThan(0);
    const closedD = await payHere(d, 'Kredi kartı', rest);
    expect(closedD.order.status).toBe('kapali');
    expected.card += rest;
    // Yemek kartı (AsilPOS'ta ve cihazda): kart ve nakde girmez
    const e = await newOrder();
    await payHere(e, 'Pluxee', e.total);
    const g = await newOrder();
    await onDevice(g, [{ type: 7, amount: g.total }]);
    // İptal edilen nakit sayılmaz, yerine alınan kart sayılır (adisyon açıkken: kör kasa kapanmış adisyonun ödemesini görmez)
    const f = await newOrder();
    const wrong = await payHere(f, 'Nakit', Math.floor(f.total / 2));
    await h.ok('kasa', 'POST', `/orders/${f.id}/payments/${wrong.order.payments.at(-1)!.id}/refund`, { reason: 'Yanlış tür', approverPin: PINS.mudur });
    await payHere(f, 'Kredi kartı', f.total);
    expected.card += f.total;
    // "AsilPOS'a yaz (fiş ayrıca)": nakit
    const i = await newOrder(1);
    await payHere(i, 'Nakit', i.total);
    expected.cash += i.total;
    // Açık hesap satışı ve nakit tahsilatı: satış ödemesi kart ya da nakit değil, tahsilat satış değil
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Deniz Kaya', phone: '0532 000 22 33' });
    const k = await newOrder(1, { customerId: cust.id });
    await payHere(k, 'Açık hesap', k.total);
    await h.ok('kasa', 'POST', '/cash/collect', { customerId: cust.id, methodId: method('Nakit').id, amount: k.total });
    expect(expected.card).toBeGreaterThan(0);
    expect(expected.cash).toBeGreaterThan(0);
  }, 60_000);

  it('ara rapor (X): kart ve nakit doğru; fişi kesilen dahil değil; Z alanı = cihazdan + cihazsız', async () => {
    const x = await h.ok<{ day: { date: string }; summary: Summary }>('mudur', 'GET', '/cash/day');
    today = x.day.date;
    expect(x.summary.offDevice).toEqual(expected);
    expect(x.summary.byZField.card).toBe(expected.card + device.card);
    expect(x.summary.byZField.cash).toBe(expected.cash + device.cash);
    // Raporlar › Ciro ve patron paneli aynı rakam
    expect((await h.ok<{ offDevice: unknown }>('mudur', 'GET', '/reports/summary')).offDevice).toEqual(expected);
    expect((await h.ok<{ offDevice: unknown }>('patron', 'GET', '/reports/patron')).offDevice).toEqual(expected);
  });

  it('kör kasa: ara rapor gitmez; patron paneli verilse de yazarkasadan geçmeyen gitmez', async () => {
    const blind = await h.ok<{ summary: unknown; blind: boolean }>('kasa', 'GET', '/cash/day');
    expect(blind).toMatchObject({ summary: null, blind: true });
    const { updateSettings } = await import('../server/lib/settings');
    const { ROLE_DEFAULTS } = await import('@shared/permissions');
    updateSettings({ rolePermissions: { kasiyer: [...ROLE_DEFAULTS.kasiyer, 'patron.panel'] } });
    await h.login('kasa', PINS.kasa);
    const panel = await h.ok<Record<string, unknown>>('kasa', 'GET', '/reports/patron');
    expect(panel).toHaveProperty('payments');
    expect(panel).not.toHaveProperty('offDevice');
    updateSettings({ rolePermissions: {} });
    await h.login('kasa', PINS.kasa);
  });

  it('AsilPOS Uzaktan kasayla aynı: canlı özet, günün raporu ve dönem toplamı; eski kasanın gününde satır yok', async () => {
    const { buildSnapshot } = await import('../server/sync/cloud');
    const { buildDayReport } = await import('../server/sync/cloud-reports');
    const { summaryReport } = await import('../server/services/reports');
    const { sumSummary } = await import('../api/uzaktan');
    expect((buildSnapshot().patron as { offDevice?: unknown }).offDevice).toEqual(expected);
    const rep = buildDayReport(today)!;
    expect(rep.s.off).toEqual(expected);
    const range = { from: today, to: today };
    const now = Date.now();
    const till = summaryReport(range, now);
    expect(till.offDevice).toEqual(expected);
    expect(sumSummary(range, [rep], [], now, today).offDevice).toEqual(till.offDevice);
    // Eski kasanın itmesi: alan yok, dönem toplamı da yok (₺0 değil)
    const { off: _off, ...oldS } = rep.s;
    expect(sumSummary(range, [{ ...rep, s: oldS }], [], now, today)).not.toHaveProperty('offDevice');
  });

  it('gün sonu (Z): kör kasaya gitmez; Z, gün sonu kartı ve fiş aynı rakam; eski Z’de satır yok', async () => {
    const closed = await h.ok<{ day: { id: string }; summary: unknown; blind: boolean }>('kasa', 'POST', '/cash/day/close', { countedCash: null });
    expect(closed).toMatchObject({ summary: null, blind: true });
    const z = await h.ok<{ summary: Summary }>('mudur', 'GET', `/cash/days/${closed.day.id}`);
    expect(z.summary.offDevice).toEqual(expected);
    const { lastCloseCard } = await import('../server/sync/cloud');
    expect(lastCloseCard()?.offDevice).toEqual(expected);

    type Props = Record<string, unknown>;
    const PRINT = '../src/lib/print';
    const { ZReceipt } = (await import(/* @vite-ignore */ PRINT)) as { ZReceipt: FC<Props> };
    const html = renderToStaticMarkup(createElement(ZReceipt, { boot: h.boot, date: today, zNo: 1, s: z.summary, closedAt: Date.now() }));
    expect(html).toContain('Yazarkasadan geçmeyen');
    expect(html).toContain(tlPlain(expected.card));
    expect(html).toContain(tlPlain(expected.cash));

    // Bu özellikten önce kapanmış Z: alan yok; ekran, fiş ve gün sonu kartı satır yazmaz
    const { sqlite } = await import('../server/db/client');
    sqlite.prepare("UPDATE business_days SET summary = json_remove(summary, '$.offDevice') WHERE id = ?").run(closed.day.id);
    const old = await h.ok<{ summary: ZSummary }>('mudur', 'GET', `/cash/days/${closed.day.id}`);
    expect(old.summary).not.toHaveProperty('offDevice');
    expect(lastCloseCard()).not.toHaveProperty('offDevice');
    expect(renderToStaticMarkup(createElement(ZReceipt, { boot: h.boot, date: today, zNo: 1, s: old.summary, closedAt: Date.now() }))).not.toContain('Yazarkasadan geçmeyen');
  });
});
