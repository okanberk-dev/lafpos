import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentOf } from '@shared/money';
import { happyHourPercentAt, happyHourUnit, unpaidLineAmount } from '@shared/order-calc';
import { istanbulParts } from '@shared/time';
import type { BootstrapDTO, DisplayStateDTO, OrderDTO, ZSummary } from '@shared/types';
import { estimateUnit, menuUnit } from '../src/lib/boot';
import type { PendingLine } from '../src/lib/cart';
import { slipDiff, slipRows } from '../src/lib/cashCount';
import { type DisplayOrder, displayOrder, previewTotals } from '../src/lib/estimate';
import { type Harness, PINS, startApp } from './harness';

/**
 * Kasa arayüzünün tahminleri sunucuyla aynı hesabı yapar: gönderilmemiş kalemin fiyatı (happy hour dahil),
 * müşteri ekranının dökümü, gün sonu föyündeki slip karşılaştırması ve "Kalem seç"teki kalan tutar.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (boot: BootstrapDTO, name: string) => boot.products.find((p) => p.name === name)!;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

describe('happy hour: istemci tahmini sunucunun fiyatı', () => {
  it('etkin happy hour gönderilmemiş kalemin tahminine de uygulanır; kapsam ve en yüksek oran sunucuyla aynı', async () => {
    // Şu anı ortalayan aralık (saat kaç olursa olsun etkin; gece yarısını aşabilir)
    const p = istanbulParts(Date.now());
    const minute = p.hour * 60 + p.minute;
    const start = hm((minute - 120 + 1440) % 1440);
    const end = hm((minute + 120) % 1440);
    const days = [1, 2, 3, 4, 5, 6, 7];
    const tk0 = product(h.boot, 'Türk kahvesi');
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Hepsi', days, start, end, percent: 20 });
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Türk kahvesi', days, start, end, percent: 30, categoryIds: [tk0.categoryId] });
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Kapalı', days, start, end, percent: 50, active: false });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');

    for (const name of ['Türk kahvesi', 'Latte']) {
      const pr = product(boot, name);
      const size = pr.priceL != null ? ('M' as const) : ('TEK' as const);
      const pending: PendingLine[] = [{ key: 'k1', productId: pr.id, size, qty: 2, options: [], note: '' }];
      const order = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
      // "Öde · ₺X", adisyon toplamı, "Ekle · ₺X" ve müşteri ekranı bu tahminden
      const estimate = estimateUnit(boot, pr, size, []);
      const preview = previewTotals(boot, order, pending)!;
      const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${order.id}/items`, { items: pending.map(({ key: _k, ...l }) => l) });
      expect(sent.items[0].happyHour).toBe(true);
      expect(estimate).toBe(sent.items[0].unitPrice);
      expect(preview.total).toBe(sent.total);
      // Elle fiyatın karşılaştırıldığı menü fiyatı happy hour öncesi
      expect(menuUnit(boot, pr, size, [])).toBe(sent.items[0].basePrice);
    }
    // Sonraki testler happy hour'suz fiyatla
    for (const r of await h.ok<{ id: string }[]>('patron', 'GET', '/admin/happy-hours')) await h.ok('patron', 'DELETE', `/admin/happy-hours/${r.id}`);
  });

  it('kural eşleşmesi: gece yarısını aşan aralık önceki güne ait, kapsam ve kapalı kural', () => {
    // 2026-10-30 Cuma, 2026-10-31 Cumartesi (İstanbul UTC+3)
    const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);
    const rule = { days: [5], start: '22:00', end: '02:00', percent: 20, categoryIds: [], productIds: [], active: true };
    const prod = { id: 'p1', categoryId: 'c1' };
    expect(happyHourPercentAt([rule], prod, at('2026-10-30', '23:30'))).toBe(20);
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '01:59'))).toBe(20); // Cumartesi 01:59 Cuma gecesinin devamı
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '02:00'))).toBe(0);
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '23:30'))).toBe(0); // Cumartesi kuralda yok
    expect(happyHourPercentAt([rule], prod, at('2026-10-30', '01:00'))).toBe(0); // Perşembe gecesi
    expect(happyHourPercentAt([{ ...rule, active: false }], prod, at('2026-10-30', '23:30'))).toBe(0);
    expect(happyHourPercentAt([{ ...rule, categoryIds: ['c2'] }], prod, at('2026-10-30', '23:30'))).toBe(0);
    expect(happyHourPercentAt([{ ...rule, productIds: ['p1'] }, { ...rule, percent: 35, categoryIds: ['c1'] }], prod, at('2026-10-30', '23:30'))).toBe(35);
    expect(happyHourUnit(14000, 20)).toBe(11200);
    expect(happyHourUnit(14500, 15)).toBe(14500 - percentOf(14500, 15));
    expect(happyHourUnit(14000, 0)).toBe(14000);
  });
});

describe('müşteri ekranı dökümü', () => {
  const sum = (d: DisplayOrder) => d.lines.reduce((a, l) => a + l.total, 0);
  /** Ekrandaki satırlar: kalemler − İndirim + Servis = Toplam */
  const addsUp = (d: DisplayOrder) => sum(d) - d.discount + d.service;

  it('indirim bir kez düşülür: kalemler − indirim (+ servis) = toplam, gönderilmemişler dahil', async () => {
    const boot = h.boot;
    const tk = product(boot, 'Türk kahvesi');
    const latte = product(boot, 'Latte');
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: tk.id, qty: 2 }, { productId: latte.id, size: 'M', qty: 1 }] });
    const latteLine = o.items.find((i) => i.productId === latte.id)!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${latteLine.id}/discount`, { type: 'percent', value: 15, reason: 'Müdavim', approverPin: PINS.mudur });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Müdavim', approverPin: PINS.mudur });
    expect(o.totals.orderDiscount).toBeGreaterThan(0);

    const shown = displayOrder(boot, o, [], 'Gel al')!;
    expect(shown.total).toBe(o.total);
    expect(addsUp(shown)).toBe(shown.total);
    // Kalem müşterinin menüde gördüğü fiyatla: 2 × Türk kahvesi
    expect(shown.lines.find((l) => l.name === o.items[0].name)!.total).toBe(2 * o.items[0].unitPrice);

    // Gönderilmemiş kalem: indirim onu da kapsar, ekran yine tutarlı; gönderince sunucunun toplamı
    const pending: PendingLine[] = [{ key: 'k1', productId: tk.id, size: 'TEK', qty: 1, options: [], note: '' }];
    const withPending = displayOrder(boot, o, pending, 'Gel al')!;
    expect(addsUp(withPending)).toBe(withPending.total);
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: pending.map(({ key: _k, ...l }) => l) });
    expect(withPending.total).toBe(sent.total);
    expect(withPending.discount).toBe(sent.totals.lineDiscounts + sent.totals.orderDiscount);
  });

  it('servis ücreti ve ikram: ekranın satırları yine toplamı verir', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
    const table = h.boot.tables.find((t) => t.kind !== 'oda')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 2 });
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 0 });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product(h.boot, 'Türk kahvesi').id, qty: 3 }] });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/comp`, { qty: 1, reason: 'Müdavim', approverPin: PINS.mudur });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 2000, reason: 'Müdavim', approverPin: PINS.mudur });
    expect(o.totals.service).toBeGreaterThan(0);
    const shown = displayOrder(h.boot, o, [], table.name)!;
    expect(shown.total).toBe(o.total);
    expect(addsUp(shown)).toBe(o.total);
    // Ekran servis satırını alır; servis göndermeyen eski kasa sürümü de kabul edilir
    await h.ok('kasa', 'PUT', '/display/audit', shown);
    expect(await h.ok<DisplayStateDTO>('', 'GET', '/public/display/audit')).toMatchObject({ kind: 'order', service: o.totals.service, total: o.total });
    const { service: _s, ...old } = shown;
    await h.ok('kasa', 'PUT', '/display/audit', old);
    expect(await h.ok<DisplayStateDTO>('', 'GET', '/public/display/audit')).toMatchObject({ kind: 'order', service: 0 });
  });
});

describe('gün sonu kasa föyü: slip karşılaştırması', () => {
  it('kartla alınan bahşiş slipte tutarla birlikte görünür; fark sayılmaz', async () => {
    const tk = product(h.boot, 'Türk kahvesi');
    const card = h.boot.paymentMethods.find((m) => m.name === 'Kredi kartı')!;
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    const before = (await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day')).summary.payments.find((p) => p.methodId === card.id);
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: tk.id, qty: 1 }] });
    // Müşteri ₺140'ı kartla öder, ₺20 bahşişi de karta ekletir: banka POS'u ₺160 çeker
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card.id, amount: o.total, tip: 2000 });
    const summary = (await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day')).summary;
    const rows = slipRows(summary, h.boot.paymentMethods);
    const row = rows.find((r) => r.methodId === card.id)!;
    const slip = (before ? before.amount + before.tips : 0) + o.total + 2000;
    expect(row.expected).toBe(slip);
    expect(slipDiff(row, slip)).toBe(0);
    expect(slipDiff(row, slip - 2000)).toBe(-2000);
    // Nakit föyde ayrı sayılır (bahşiş beklenen nakitte); kör sayımda beklenen yok
    expect(rows.some((r) => r.methodId === cash.id)).toBe(false);
    const blind = slipRows(null, h.boot.paymentMethods);
    expect(blind.find((r) => r.methodId === card.id)).toMatchObject({ expected: null });
    expect(slipDiff(blind[0]!, 1000)).toBeNull();
  });

  it('açık hesaba alınan bahşiş cariye yazılmaz: Açık hesap satırı müşterilere yazılan borçla karşılaştırılır', async () => {
    const tk = product(h.boot, 'Türk kahvesi');
    const cari = h.boot.paymentMethods.find((m) => m.kind === 'cari')!;
    const before = (await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day')).summary.payments.find((p) => p.methodId === cari.id);
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Föy Cari' });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: tk.id, qty: 1 }] });
    // ₺140 açık hesaba, ₺20 bahşişle: müşterinin borcu ₺140 (bahşiş kimsenin cari hesabına yazılmaz)
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cari.id, amount: o.total, tip: 2000, customerId: cust.id });
    const debt = (await h.ok<{ customer: { balance: number } }>('kasa', 'GET', `/customers/${cust.id}`)).customer.balance;
    expect(debt).toBe(o.total);
    const summary = (await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day')).summary;
    expect(summary.payments.find((p) => p.methodId === cari.id)!.tips).toBeGreaterThanOrEqual(2000);
    const row = slipRows(summary, h.boot.paymentMethods).find((r) => r.methodId === cari.id)!;
    const booked = (before?.amount ?? 0) + debt;
    expect(row.expected).toBe(booked);
    expect(row.tips).toBe(0);
    expect(slipDiff(row, booked)).toBe(0);
    // Kartta bahşiş yine slipe dahil
    const card = h.boot.paymentMethods.find((m) => m.name === 'Kredi kartı')!;
    const cardRow = slipRows(summary, h.boot.paymentMethods).find((r) => r.methodId === card.id)!;
    const cardSum = summary.payments.find((p) => p.methodId === card.id)!;
    expect(cardRow.expected).toBe(cardSum.amount + cardSum.tips);
  });
});

describe('ödeme penceresi: Kalem seç', () => {
  it('kısmen ödenmiş kalemin satırı kalan adetlerin tutarını gösterir', async () => {
    const tk = product(h.boot, 'Türk kahvesi');
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: tk.id, qty: 3 }] });
    const unit = o.items[0].unitPrice;
    // İlk misafir bir kahveyi "Kalem seç"le öder
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: unit, items: [{ itemId: o.items[0].id, qty: 1 }] });
    o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    const line = o.items[0];
    expect(line.paidQty).toBe(1);
    // "2 adet · ₺280": satırın tamamı (₺420) değil
    expect(unpaidLineAmount(o.totals, line, o.total - o.paid)).toBe(2 * unit);
    expect(unpaidLineAmount(o.totals, line, o.total - o.paid)).toBe(o.total - o.paid);

    // Adisyon indirimiyle kuruş artığı: kalan adetlerin payı sunucunun "kalanı seç" tutarıyla aynı
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    d = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${d.id}/items`, { items: [{ productId: tk.id, qty: 3 }] });
    d = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${d.id}/discount`, { type: 'amount', value: 1001, reason: 'Müdavim', approverPin: PINS.mudur });
    const first = await h.ok<{ order: OrderDTO; amount: number }>('kasa', 'POST', `/orders/${d.id}/payments`, { methodId: cash.id, amount: 1, items: [{ itemId: d.items[0].id, qty: 1 }] });
    const rest = unpaidLineAmount(first.order.totals, first.order.items[0], first.order.total - first.order.paid);
    expect(rest).toBe(first.order.total - first.order.paid);
    const last = await h.ok<{ order: OrderDTO; amount: number; closed: boolean }>('kasa', 'POST', `/orders/${d.id}/payments`, { methodId: cash.id, amount: 1, items: [{ itemId: d.items[0].id, qty: 2 }] });
    expect(last.amount).toBe(rest);
    expect(last.closed).toBe(true);
  });

  it('kısmi ödemeden sonra adisyon indirimi: satır ve Seçilen sunucunun aldığı kalanı aşmaz', async () => {
    const tk = product(h.boot, 'Türk kahvesi');
    const latte = product(h.boot, 'Latte');
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: tk.id, qty: 3 }] });
    const unit = o.items[0].unitPrice;
    // Bir kahve ₺140'tan ödenir, sonra %10 adisyon indirimi: kalan adetlerin payı ₺252, ödenecek kalan ₺238
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: unit, items: [{ itemId: o.items[0].id, qty: 1 }] });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Müdavim', approverPin: PINS.mudur });
    const due = o.total - o.paid;
    const row = unpaidLineAmount(o.totals, o.items[0], due);
    expect(row).toBe(due);
    const last = await h.ok<{ order: OrderDTO; amount: number; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, {
      methodId: cash.id,
      amount: 1,
      items: [{ itemId: o.items[0].id, qty: o.items[0].qty - o.items[0].paidQty }],
    });
    expect(last.amount).toBe(row);
    expect(last.closed).toBe(true);

    // İki kalem: tek başına seçilen satırın tutarı sunucunun o satır için aldığıyla aynı (kalan yetiyorsa payın tamamı)
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
    d = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${d.id}/items`, { items: [{ productId: tk.id, qty: 3 }, { productId: latte.id, size: 'M', qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${d.id}/payments`, { methodId: cash.id, amount: 1, items: [{ itemId: d.items[0].id, qty: 1 }] });
    d = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${d.id}/discount`, { type: 'percent', value: 10, reason: 'Müdavim', approverPin: PINS.mudur });
    for (const line of [d.items[0], d.items[1]]) {
      const cur = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${d.id}`);
      const l = cur.items.find((i) => i.id === line.id)!;
      const shown = unpaidLineAmount(cur.totals, l, cur.total - cur.paid);
      const paid = await h.ok<{ amount: number }>('kasa', 'POST', `/orders/${d.id}/payments`, { methodId: cash.id, amount: 1, items: [{ itemId: l.id, qty: l.qty - l.paidQty }] });
      expect(paid.amount).toBe(shown);
    }
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${d.id}`)).status).not.toBe('open');
  });
});
