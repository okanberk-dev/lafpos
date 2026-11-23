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

describe('işyeri nüshasında ikram edilen kalem', () => {
  it('tutar yerine türü yazar (adisyondaki gibi): kalemler adisyon toplamını tutar', async () => {
    const { StoreCopyReceipt, BillReceipt } = (await import(/* @vite-ignore */ PRINT)) as { StoreCopyReceipt: FC<Props>; BillReceipt: FC<Props> };
    const { tlPlain } = await import('@shared/money');
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const kahve = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }, { productId: kahve.id, qty: 1 }] });
    const comped = o.items.find((i) => i.name === 'Türk Kahvesi')!;
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${comped.id}/comp`, { reason: 'Müdavim' });
    const paid = o.items.find((i) => i.name === 'Latte')!;
    // Toplam ikramı saymaz: yalnız Latte'ler
    expect(o.total).toBe(paid.qty * paid.unitPrice);
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const html = renderToStaticMarkup(createElement(StoreCopyReceipt, { order: o, boot, payments: [], cashier: 'Ayşe', at: 0 }));
    // Eskiden ikram edilen kalem liste fiyatıyla basılıyordu: kalemler toplamın üstünde kalıyordu
    const compLine = /Türk Kahvesi[^<]*<\/span><span class="rc-r">İKRAM<\/span>/;
    expect(html).toMatch(compLine);
    expect(html).toContain(`Latte Orta</span><span class="rc-r">${tlPlain(o.total)}</span>`);
    expect(html).toContain(`Adisyon toplamı</span><span class="rc-r">${tlPlain(o.total)}</span>`);
    // Adisyondaki (müşteri nüshası) satırla aynı
    expect(renderToStaticMarkup(createElement(BillReceipt, { order: o, boot, sizeLabel: (s: string) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s, copy: true }))).toMatch(compLine);
  });
});

describe('işyeri nüshasında indirim ve servis', () => {
  it('kalemden adisyon toplamına adisyondaki gibi: kalem indirimi, ara toplam, indirim, servis', async () => {
    const { StoreCopyReceipt } = (await import(/* @vite-ignore */ PRINT)) as { StoreCopyReceipt: FC<Props> };
    const { tlPlain } = await import('@shared/money');
    await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 10 });
    try {
      const latte = h.boot.products.find((p) => p.name === 'Latte')!;
      const table = h.boot.tables[0]!;
      let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 2 });
      o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }] });
      o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/discount`, { type: 'percent', value: 50, reason: 'Müdavim' });
      const t = o.totals;
      const line = o.items[0]!;
      expect(line.discount).toBeGreaterThan(0);
      expect(t.service).toBeGreaterThan(0);
      const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
      const html = renderToStaticMarkup(createElement(StoreCopyReceipt, { order: o, boot, payments: [], cashier: 'Ayşe', at: 0 }));
      // Eskiden kalem liste fiyatıyla basılıyor, indirim ve servis yazılmıyordu: kalemler toplamı tutmuyordu
      expect(html).toContain(`İndirim (Müdavim)</span><span class="rc-r">-${tlPlain(line.discount)}</span>`);
      expect(html).toContain(`Ara toplam</span><span class="rc-r">${tlPlain(t.gross)}</span>`);
      expect(html).toContain(`İndirim</span><span class="rc-r">-${tlPlain(t.lineDiscounts + t.orderDiscount)}</span>`);
      expect(html).toContain(`Servis %10</span><span class="rc-r">${tlPlain(t.service)}</span>`);
      expect(html).toContain(`Adisyon toplamı</span><span class="rc-r">${tlPlain(o.total)}</span>`);
      // Kâğıttaki rakamlar adisyon toplamını tutar
      expect(t.gross - t.lineDiscounts - t.orderDiscount + t.service).toBe(o.total);
    } finally {
      await h.ok('patron', 'PUT', '/admin/settings', { serviceRate: 0 });
    }
  });
});
