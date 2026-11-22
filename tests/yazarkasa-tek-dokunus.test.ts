import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterPaymentPrints, deviceResult, deviceRoute, type DeviceRouteInput, isKasaHost, offDeviceLabel, okcPanelAuto, printOnce } from '@shared/odeme-fisi';
import type { LiveEvent } from '@shared/events';
import { deviceCopyListener, markDeviceSent, resetDeviceSent, unmarkDeviceSent } from '../src/lib/device-copies';
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

  it('bahşişli nakit ya da kart sessizce LafPOS’a yazılmaz: düğme kapanır, hesap bahşişsiz cihazdan alınır', () => {
    for (const methodKind of ['nakit', 'kart'] as const) {
      expect(deviceRoute({ ...base, provider: 'pavo', methodKind, tip: 500 })).toMatchObject({ on: true, send: false, block: true, reason: expect.stringMatching(/Bahşişi ayrı alın/) });
    }
  });

  it('cihaza gitmeyen kart düğmede söylenir ve onay ister; nakitte "LafPOS’a yaz"; havale ve gönderim kapalıyken değişmez', () => {
    const kart = { kind: 'kart', name: 'Kart' };
    expect(offDeviceLabel({ on: true, send: false }, kart, 25000)).toEqual({ label: '₺250,00 Kart: cihazsız kaydet', confirm: true });
    expect(offDeviceLabel({ on: true, send: false }, { kind: 'nakit', name: 'Nakit' }, 25000)).toMatchObject({ confirm: false, label: expect.stringMatching(/LafPOS’a yaz/) });
    expect(offDeviceLabel({ on: true, send: true }, kart, 25000)).toBeNull();
    expect(offDeviceLabel({ on: false, send: false }, kart, 25000)).toBeNull();
    expect(offDeviceLabel({ on: true, send: false }, { kind: 'havale', name: 'Havale' }, 25000)).toBeNull();
  });
});

describe('otomatik gönderimin ret yolları', () => {
  it('(a) paylaşımlı hesap, hiç pay alınmamış: Yazarkasa bölümü elle gönderir, neden "LafPOS’a yazılır" demez', () => {
    const split = { shares: [20000, 20000] };
    expect(okcPanelAuto(true, split, 0)).toBe(false);
    expect(okcPanelAuto(true, split, 20000)).toBe(true);
    expect(okcPanelAuto(true, null, 0)).toBe(true);
    expect(okcPanelAuto(false, split, 0)).toBe(false);
    const r = deviceRoute({ ...base, provider: 'pavo', payMode: 'paylas', splitActive: true, amount: 20000, remaining: 40000, nothingPaid: true });
    expect(r).toMatchObject({ on: true, send: false });
    expect(r.reason).toMatch(/Yazarkasa bölümünden bütün hesabı/);
    expect(r.reason).not.toMatch(/LafPOS’a yazılır/);
  });

  it('(b) cihaz sonucu para üstünü belirler: Nakit 500 seçilip kartla ödenirse para üstü 0, bölünmüşte de 0', () => {
    const sent = { amount: 32000, given: 50000, methodName: 'Nakit' };
    expect(deviceResult(sent, [{ kind: 'kart', name: 'Kart', amount: 32000 }])).toEqual({ change: 0, method: 'Kart' });
    expect(deviceResult(sent, [{ kind: 'nakit', name: 'Nakit', amount: 20000 }, { kind: 'kart', name: 'Kart', amount: 12000 }])).toEqual({ change: 0, method: '₺200,00 Nakit + ₺120,00 Kart' });
    expect(deviceResult(sent, [{ kind: 'nakit', name: 'Nakit', amount: 32000 }])).toEqual({ change: 18000, method: 'Nakit' });
    // Cihazın ödemeleri bilinmiyorsa (eski sunucu) para üstü yazılmaz
    expect(deviceResult(sent, undefined).change).toBeNull();
    expect(deviceResult({ ...sent, given: null, methodName: 'Kart' }, undefined).change).toBe(0);
  });

  it('(c) cihaz ödeyince nüsha bir kez basılır: pencere kapalı ya da başka adisyona geçilmiş olsa da', () => {
    resetDeviceSent();
    const printed: string[] = [];
    const listen = deviceCopyListener((id) => printed.push(id));
    const paid = (orderId: string): Pick<LiveEvent, 'topic' | 'kind' | 'orderId'> => ({ topic: 'okc', kind: 'okc.paid', orderId });
    markDeviceSent('o1');
    // Kasiyer başka adisyona geçti: dinleyici uygulama düzeyinde, adisyondan bağımsız
    listen(paid('o2'));
    listen(paid('o1'));
    listen(paid('o1'));
    expect(printed).toEqual(['o1']);
    // Cihazda iptal edilen sepetin kaydı düşer; gönderim hatası da düşürür
    markDeviceSent('o3');
    listen({ topic: 'okc', kind: 'okc.cancelled', orderId: 'o3' });
    listen(paid('o3'));
    markDeviceSent('o4');
    unmarkDeviceSent('o4');
    listen(paid('o4'));
    // Süresi geçmiş kayıt basılmaz
    markDeviceSent('o5', Date.now() - 11 * 60_000);
    listen(paid('o5'));
    expect(printed).toEqual(['o1']);
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

  it('ayar gerçek cihazda varsayılan açık, eğitim cihazında kapalı; elle seçilen değer kalır, açılış verisi de söyler', async () => {
    const auto = async () => (await h.ok<{ auto: boolean }>('patron', 'GET', '/okc/status')).auto;
    expect(await auto()).toBe(false);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.okc).toMatchObject({ provider: 'simulator', mode: 'anlik', auto: false });
    expect((await h.ok<{ auto: boolean }>('patron', 'PUT', '/okc/settings', { provider: 'tokenx' })).auto).toBe(true);
    expect((await h.ok<{ auto: boolean }>('patron', 'PUT', '/okc/settings', { provider: 'pavo' })).auto).toBe(true);
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
    expect((await h.call('kasa', 'PUT', '/okc/settings', { auto: true })).status).toBe(403);
    expect((await h.ok<{ auto: boolean }>('patron', 'PUT', '/okc/settings', { auto: true })).auto).toBe(true);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.okc.auto).toBe(true);
    // Elle kapatılan gerçek cihazda da kapalı kalır
    await h.ok('patron', 'PUT', '/okc/settings', { auto: false, provider: 'pavo' });
    expect(await auto()).toBe(false);
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik', auto: true });
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

  it('paylaşımlı hesap (hiç pay alınmamış) bütün olarak tek sepetle gider; cihazın ödemeleri okc.paid olayıyla gelir', async () => {
    const { bus } = await import('../server/lib/events');
    const events: LiveEvent[] = [];
    const on = (e: LiveEvent) => events.push(e);
    bus.on('event', on);
    const o = await newOrder(4);
    await h.ok('kasa', 'PUT', `/orders/${o.id}/split`, { people: 2 });
    const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: null });
    expect(sent.receipt.amount).toBe(o.total);
    const half = Math.floor(o.total / 2);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 1, amount: half }, { type: 3, amount: o.total - half }] });
    bus.off('event', on);
    expect((await h.ok<OrderDTO>('patron', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    const paid = events.find((e) => e.kind === 'okc.paid' && e.orderId === o.id)!;
    expect(paid.paid?.map((p) => [p.kind, p.amount])).toEqual([
      ['nakit', half],
      ['kart', o.total - half],
    ]);
    // Kasiyer LafPOS'ta Nakit 500 seçmişti: cihazda bölünmüş ödemede para üstü yok
    expect(deviceResult({ amount: o.total, given: o.total + 50000, methodName: 'Nakit' }, paid.paid).change).toBe(0);
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
