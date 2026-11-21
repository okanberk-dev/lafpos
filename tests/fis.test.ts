import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, OrderDTO, ZSummary } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Hesap fişi (src/lib/print.tsx): fişte müşteri adı ayarı (varsayılan kapalı; açıkken bağlı müşterinin adı), şube satırı,
 * X ve Z başlığı. Fiş sunucunun DTO'suyla çizilir; tutarlar sunucudan gelir
 */
let h: Harness;
let order: OrderDTO;

// Fiş arayüz kodudur (tsconfig.app.json, DOM ve JSX): sunucu tsconfig'i onu türlemesin diye yol değişkenle
type Props = Record<string, unknown>;
const PRINT = '../src/lib/print';
const print = () => import(/* @vite-ignore */ PRINT) as Promise<{ BillReceipt: FC<Props>; ZReceipt: FC<Props>; TestReceipt: FC<Props> }>;
const sizeLabel = (s: string) => s;

async function bill(boot: BootstrapDTO, o: OrderDTO = order): Promise<string> {
  const { BillReceipt } = await print();
  return renderToStaticMarkup(createElement(BillReceipt, { order: o, boot, sizeLabel }));
}

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Ayşe Yılmaz', phone: '0530 000 11 22' });
  const latte = h.boot.products.find((p) => p.name === 'Latte')!;
  order = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', customerId: cust.id });
  order = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${order.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }] });
});
afterAll(() => h.cleanup());

describe('fişte müşteri adı', () => {
  it('varsayılan kapalı: müşteri bağlı olsa da fişte adı yok', async () => {
    expect((await h.ok<{ receiptCustomerName: boolean }>('patron', 'GET', '/admin/settings')).receiptCustomerName).toBe(false);
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.settings.receiptCustomerName).toBe(false);
    expect(order.customer?.name).toBe('Ayşe Yılmaz');
    const html = await bill(boot);
    expect(html).not.toContain('Ayşe');
    expect(html).toContain('ADİSYON');
    expect(html).toContain('TOPLAM');
  });

  it('açılınca bağlı müşterinin adı yazılır; müşterisiz adisyonda satır yok', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { receiptCustomerName: true });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.settings.receiptCustomerName).toBe(true);
    expect(await bill(boot)).toContain('Müşteri Ayşe Yılmaz');
    const plain = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(await bill(boot, plain)).not.toContain('Müşteri');
    // Ayar denetim kaydına Türkçe adıyla yazılır; yalnız ayar yetkisi değiştirir
    const audit = await h.ok<{ message: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.some((a) => a.message.includes('Fişte müşteri adı'))).toBe(true);
    expect((await h.call('kasa', 'PUT', '/admin/settings', { receiptCustomerName: false })).status).toBe(403);
    // Düzenleme yalnız gönderilen alanı değiştirir (patchOf): başka ayar kaydı bunu kapatmaz
    await h.ok('patron', 'PUT', '/admin/settings', { receiptFooter: 'Afiyet olsun' });
    expect((await h.ok<{ receiptCustomerName: boolean }>('patron', 'GET', '/admin/settings')).receiptCustomerName).toBe(true);
    await h.ok('patron', 'PUT', '/admin/settings', { receiptCustomerName: false });
  });

  it('tutarlar sunucunun DTO sundan: toplam ve KDV fişte aynen', async () => {
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const html = await bill(boot);
    const { tlPlain } = await import('@shared/money');
    expect(html).toContain(`${tlPlain(order.totals.total)} TL`);
    for (const k of order.totals.kdv) expect(html).toContain(tlPlain(k.kdv));
    expect(html).toContain('2x');
  });
});

describe('fiş başlığı ve X/Z', () => {
  it('Merkez şubesi varsa başlıkta; yoksa satır yok', async () => {
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.branch ?? null).toBeNull();
    expect(await bill(boot)).not.toContain('Şube');
    expect(await bill({ ...boot, branch: { name: 'Marina', code: 'MRN' } })).toContain('Şube Marina · MRN');
  });

  it('gün açıkken ara rapor (X), kapanmışsa gün sonu (Z) başlığı', async () => {
    const { ZReceipt, TestReceipt } = await print();
    const s = { gross: 0, discounts: 0, service: 0, netSales: 0, receipts: 0, guests: 0, payments: [], tips: 0, kdv: [], complimentary: 0, voided: 0, voidAfterSendCount: 0, openingCash: 0, cashIn: 0, cashOut: 0, handedOver: 0, cariCollections: 0, expectedCash: 0, countedCash: null, cashDiff: null, onlineOrders: 0, onlineTotal: 0 } as unknown as ZSummary;
    const x = renderToStaticMarkup(createElement(ZReceipt, { boot: h.boot, date: '2026-11-21', zNo: 7, s, closedAt: null }));
    expect(x).toContain('ARA RAPOR (X)');
    const z = renderToStaticMarkup(createElement(ZReceipt, { boot: h.boot, date: '2026-11-21', zNo: 7, s, closedAt: Date.now() }));
    expect(z).toContain('GÜN SONU · Z 7');
    expect(renderToStaticMarkup(createElement(TestReceipt, { boot: h.boot, printer: 'XP-80C' }))).toContain('DENEME FİŞİ');
  });
});
