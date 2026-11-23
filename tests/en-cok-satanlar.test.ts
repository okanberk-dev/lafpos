import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import type { BootstrapDTO, OptionGroupDTO, OrderDTO, ProductDTO } from '@shared/types';
import { productTap } from '../src/pages/order/productTap';
import { type Harness, startApp } from './harness';

/**
 * Satış ekranının "En çok satanlar" şeridi (inceleme, 23 Kas 2026): şerit kartla aynı kuralla ekler (productTap); sunucu
 * listeyi dönem ve iş günü başına 5 dakika saklar (her kasa ve tablet 5 dakikada bir soruyordu, her soru dönemin ürün
 * raporunu baştan çalıştırıyordu).
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => {
  vi.restoreAllMocks();
  h.cleanup();
});

describe('şeride dokunmak karta dokunmakla aynı', () => {
  const milk = { id: 'sut', name: 'Süt', kind: 'single', required: false, items: [{ id: 'normal', name: 'Normal süt', price: 0, isDefault: true, soldOut: false }] };
  const bootOf = (groups: object[], askOptions: 'zorunlu' | 'hep' = 'zorunlu') => ({ optionGroups: groups as OptionGroupDTO[], settings: { askOptions } }) as unknown as BootstrapDTO;
  const product = (over: Partial<ProductDTO>) => ({ id: 'p', name: 'Matcha Latte', price: 21_500, priceL: null, optionGroupIds: [], ...over }) as ProductDTO;

  it('tek boylu ürün TEK boyla eklenir; yalnız isteğe bağlı seçenek sormaz, zorunlu seçim ve açık fiyat sorar', () => {
    // Şerit eskiden tek boylu ürünü orta boyla ekliyordu (karttan eklenenle iki ayrı satır) ve seçenek grubu olan her
    // ürünü pencereyle açıyordu
    expect(productTap(bootOf([milk]), product({ optionGroupIds: ['sut'] }))).toEqual({ twoSizes: false, ask: false, size: 'TEK' });
    expect(productTap(bootOf([milk]), product({ priceL: 26_000, optionGroupIds: ['sut'] }))).toEqual({ twoSizes: true, ask: false, size: 'M' });
    expect(productTap(bootOf([{ ...milk, required: true }]), product({ optionGroupIds: ['sut'] })).ask).toBe(true);
    expect(productTap(bootOf([milk], 'hep'), product({ optionGroupIds: ['sut'] })).ask).toBe(true);
    // Fiyatı 0 olan açık ürün (etkinlik ücreti, özel pasta): fiyat girilsin diye pencere; şerit eskiden ₺0 ekliyordu
    expect(productTap(bootOf([]), product({ price: 0 }))).toEqual({ twoSizes: false, ask: true, size: 'TEK' });
  });

  it('kart, seçenek düğmesi ve şerit aynı kuralı kullanır', () => {
    const panel = readFileSync(new URL('../src/pages/order/ProductPanel.tsx', import.meta.url), 'utf8');
    expect(panel.match(/productTap\(boot, p\)/g)).toHaveLength(2);
    expect(panel).not.toMatch(/optionGroupIds|\(p, 'M'\)|'TEK'/);
  });
});

describe('en çok satanlar listesi', () => {
  const top = async (days = 7) => (await h.ok<{ days: number; ids: string[] }>('kasa', 'GET', `/top-products?days=${days}`)).ids;
  const productId = (name: string) => h.boot.products.find((p) => p.name === name)!.id;
  async function sell(name: string, qty: number) {
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const withItems = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: productId(name), qty }] });
    const paid = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: withItems.total });
    expect(paid.closed).toBe(true);
  }

  it('dönem ve iş günü başına 5 dakika saklanır; süre dolunca ya da gün değişince yeniden hesaplanır', async () => {
    const latte = productId('Latte');
    const mocha = productId('Mocha');
    expect(await top()).toEqual([]);
    await sell('Latte', 1);
    // Aynı dönem, aynı gün, 5 dakika dolmadı: rapor yeniden çalışmaz
    expect(await top()).toEqual([]);
    // Öteki dönemin kendi kaydı var
    expect(await top(30)).toEqual([latte]);

    // İş günü değişti (gün sonu, yeni gün): beklemeden yeniden hesaplanır
    const { db, schema } = await import('../server/db/client');
    const { isNull } = await import('drizzle-orm');
    db.update(schema.businessDays).set({ date: addDays(businessDate(Date.now()), 1) }).where(isNull(schema.businessDays.closedAt)).run();
    expect(await top()).toEqual([latte]);

    await sell('Mocha', 2);
    expect(await top()).toEqual([latte]);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 5 * 60_000 + 1_000);
    expect(await top()).toEqual([mocha, latte]);
  });
});
