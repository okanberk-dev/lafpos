import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterPaymentPrints, deviceRoute, type DeviceRouteInput, isKasaHost, printOnce } from '@shared/odeme-fisi';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Yazarkasa tek dokunuşla (docs/04-YAZARKASA.md §4.1): "Ödemeyi al" sepeti kendiliğinden cihaza yollar; cihaz
 * ödeyince ödeme mevcut sonuç yoluyla yazılır. Ret, iptal ve ulaşılamayan cihazda adisyon açık kalır, yeniden deneme
 * tek sepettir. Ödemeden sonra kısa işyeri nüshası her ödeme için bir kez
 */

type Receipt = { id: string; status: string; amount: number; receiptNo: number | null; zNo: number | null; paymentIds?: string[] };
type Sent = { receipt: Receipt; order: OrderDTO };

const base: DeviceRouteInput = {
  provider: 'simulator',
  mode: 'anlik',
  auto: true,
  canSend: true,
  methodKind: 'kart',
  tip: 0,
  payMode: 'tutar',
  splitActive: false,
  amount: 10000,
  remaining: 10000,
  pickedCount: 0,
  amountPaidHere: false,
};

describe('ödeme cihaza gider mi (deviceRoute)', () => {
  it('mutlu yol: tamamı nakit ya da kartla, ayar açık, kasada ödeme', () => {
    expect(deviceRoute(base)).toEqual({ on: true, send: true, reason: null });
    expect(deviceRoute({ ...base, methodKind: 'nakit', provider: 'pavo' })).toMatchObject({ send: true });
    expect(deviceRoute({ ...base, payMode: 'kalem', pickedCount: 2, amount: 4000 })).toMatchObject({ send: true });
  });

  it('ayar kapalı, masada ödeme, yazarkasa kapalı ya da yetki yoksa bugünkü akış (gönderim yok, uyarı yok)', () => {
    for (const x of [{ auto: false }, { mode: 'liste' as const }, { provider: 'kapali' as const }, { canSend: false }]) {
      expect(deviceRoute({ ...base, ...x })).toEqual({ on: false, send: false, reason: null });
    }
  });

  it('kısmi tutar, bahşiş, paylaşım, açık hesap ve LafPOS’ta alınmış ödeme LafPOS’a yazılır; nedeni söylenir', () => {
    const cases: Partial<DeviceRouteInput>[] = [
      { amount: 5000 },
      { tip: 500 },
      { payMode: 'paylas' },
      { splitActive: true },
      { methodKind: 'cari' },
      { methodKind: 'havale' },
      { amountPaidHere: true, amount: 5000, remaining: 5000 },
      // Pavo'nun belgelediği tipler nakit ve kart: yemek kartı cihaza gitmez
      { provider: 'pavo', methodKind: 'yemek' },
    ];
    for (const c of cases) {
      const r = deviceRoute({ ...base, ...c });
      expect(r.on).toBe(true);
      expect(r.send).toBe(false);
      expect(r.reason).toMatch(/LafPOS’a yazılır/);
    }
    // Token ve simülatörde yemek kartı cihazda alınır
    expect(deviceRoute({ ...base, methodKind: 'yemek' }).send).toBe(true);
  });
});

describe('ödeme sonrası fişler', () => {
  const settings = { receiptStoreCopy: true, receiptInfoSlip: false };
  it('yalnız kasa ekranında ve yazıcı varken; bilgi fişi yalnız yazarkasasız kurulumda ve ayar açıkken', () => {
    expect(afterPaymentPrints({ settings, printer: true, kasaScreen: true, provider: 'pavo', viaDevice: true })).toEqual({ storeCopy: true, infoSlip: false });
    expect(afterPaymentPrints({ settings, printer: false, kasaScreen: true, provider: 'pavo', viaDevice: true })).toEqual({ storeCopy: false, infoSlip: false });
    expect(afterPaymentPrints({ settings, printer: true, kasaScreen: false, provider: 'pavo', viaDevice: true })).toEqual({ storeCopy: false, infoSlip: false });
    expect(afterPaymentPrints({ settings: { receiptStoreCopy: false, receiptInfoSlip: false }, printer: true, kasaScreen: true, provider: 'kapali', viaDevice: false })).toEqual({ storeCopy: false, infoSlip: false });
    const info = { receiptStoreCopy: true, receiptInfoSlip: true };
    expect(afterPaymentPrints({ settings: info, printer: true, kasaScreen: true, provider: 'kapali', viaDevice: false })).toEqual({ storeCopy: true, infoSlip: true });
    expect(afterPaymentPrints({ settings: info, printer: true, kasaScreen: true, provider: 'simulator', viaDevice: false })).toEqual({ storeCopy: true, infoSlip: false });
    expect(isKasaHost('localhost') && isKasaHost('127.0.0.1')).toBe(true);
    expect(isKasaHost('192.168.1.20')).toBe(false);
  });

  it('her ödeme tam bir kez basılır (aynı cihaz fişi ya da ödeme ikinci kez basılmaz)', () => {
    const once = printOnce();
    expect(once('okc:a')).toBe(true);
    expect(once('okc:a')).toBe(false);
    expect(once('odeme:p1')).toBe(true);
    expect(once('okc:b')).toBe(true);
  });
});

describe('sunucu akışı (eğitim cihazı)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startApp();
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
  });
  afterAll(() => h.cleanup());

  const newOrder = async (qty = 2) => {
    const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty }] });
  };
  const receipts = (id: string) => h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${id}/receipts`);

  it('ayar varsayılan açık; kapatılınca açılış verisi de kapalı söyler', async () => {
    expect((await h.ok<{ auto: boolean }>('patron', 'GET', '/okc/status')).auto).toBe(true);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.okc).toMatchObject({ provider: 'simulator', mode: 'anlik', auto: true });
    expect((await h.call('kasa', 'PUT', '/okc/settings', { auto: false })).status).toBe(403);
    expect((await h.ok<{ auto: boolean }>('patron', 'PUT', '/okc/settings', { auto: false })).auto).toBe(false);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.okc.auto).toBe(false);
    await h.ok('patron', 'PUT', '/okc/settings', { auto: true });
  });

  it('mutlu yol: tek dokunuş sepeti cihaza yollar, cihaz ödeyince ödeme bir kez yazılır ve adisyon kapanır', async () => {
    const o = await newOrder();
    const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(sent.receipt).toMatchObject({ status: 'gonderildi', amount: o.total });
    const done = await h.ok<Receipt>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: o.total }] });
    expect(done.status).toBe('tamamlandi');
    expect(done.receiptNo).not.toBeNull();
    // Kör kasa kapanan adisyonun dökümünü görmez: ödemeler patronla okunur
    const after = await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`);
    expect(after.status).toBe('kapali');
    expect(after.payments.filter((p) => !p.refundedAt)).toHaveLength(1);
    expect((await receipts(o.id))[0]!.paymentIds).toEqual([after.payments[0]!.id]);
  });

  it('çift dokunuş ve yeniden deneme tek sepettir: ikinci gönderim okc_pending, cihazda tek sepet', async () => {
    const o = await newOrder();
    const [a, b] = await Promise.all([h.call<Sent & { code?: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null }), h.call<Sent & { code?: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.code).toBe('okc_pending');
    const again = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(again.json.code).toBe('okc_pending');
    const list = await receipts(o.id);
    expect(list.filter((r) => r.status === 'gonderildi')).toHaveLength(1);
    const sims = await h.ok<{ id: string }[]>('kasa', 'GET', '/okc/simulator/baskets');
    expect(sims.filter((x) => list.some((r) => r.id === x.id))).toHaveLength(1);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${list[0]!.id}/pay`, { payments: [{ type: 1, amount: o.total }] });
  });

  it('cihazda iptal: adisyon açık kalır, ödeme yazılmaz; yeniden deneme yeni tek sepet, ödenince kapanır', async () => {
    const o = await newOrder();
    const first = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${first.receipt.id}/cancel`, {});
    const open = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(open.status).toBe('acik');
    expect(open.payments).toHaveLength(0);
    const retry = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(retry.receipt.id).not.toBe(first.receipt.id);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${retry.receipt.id}/pay`, { payments: [{ type: 3, amount: o.total }] });
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    expect((await receipts(o.id)).map((r) => r.status).sort()).toEqual(['iptal', 'tamamlandi']);
  });

  it('kısmi ödeme: LafPOS’ta tutar alınmışsa hesabın bütünü cihaza gitmez; kalem seçilerek gider', async () => {
    const o = await newOrder(2);
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    const half = await h.ok<{ order: OrderDTO }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: Math.floor(o.total / 4), tip: 0, given: null, items: null, requestId: `kismi-${o.id}` });
    expect(half.order.status).toBe('acik');
    const whole = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(whole.json.code).toBe('okc_partial');
    expect(await receipts(o.id)).toHaveLength(0);
    const item = half.order.items[0]!;
    const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: item.id, qty: 1 }] });
    expect(sent.receipt.amount).toBeGreaterThan(0);
    expect(sent.receipt.amount).toBeLessThanOrEqual(o.total - half.order.paid);
  });

  it('online ödenmiş sipariş cihaza gitmez (tahsil edilmez)', async () => {
    const o = await newOrder(1);
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.orders).set({ source: 'laffogato', extPaid: true }).where(eq(schema.orders.id, o.id)).run();
    const r = await h.call<{ error: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('sitede ödendi');
  });
});

describe('işyeri nüshası çıktısı', () => {
  type Props = Record<string, unknown>;
  const PRINT = '../src/lib/print';
  it('kalem dökümü yok; adisyon no, toplam, ödeme türü, yazarkasa fiş ve Z no, kasiyer', async () => {
    const { StoreCopyReceipt } = (await import(/* @vite-ignore */ PRINT)) as { StoreCopyReceipt: FC<Props> };
    const boot = { settings: { businessName: "L'Affogato" }, branch: null } as unknown as BootstrapDTO;
    const order = { no: 42, tableName: 'Masa 3', numarator: null, type: 'masa', total: 25000, paid: 25000, items: [{ name: 'Türk Kahvesi' }], payments: [] } as unknown as OrderDTO;
    const html = renderToStaticMarkup(
      createElement(StoreCopyReceipt, { order, boot, payments: [{ id: 'p1', methodName: 'Kredi kartı', amount: 25000, tip: 0 }], device: { receiptNo: 17, zNo: 5, docId: null, docLabel: 'fiş' }, cashier: 'Ayşe', at: 0 }),
    );
    expect(html).toContain('İŞYERİ NÜSHASI');
    expect(html).toContain('No 42');
    expect(html).toContain('Masa 3');
    expect(html).toContain('Kredi kartı');
    expect(html).toContain('250,00');
    expect(html).toContain('Yazarkasa fiş no');
    expect(html).toContain('>17<');
    expect(html).toContain('Z no');
    expect(html).toContain('Kasiyer Ayşe');
    expect(html).not.toContain('Türk Kahvesi');
  });
});
