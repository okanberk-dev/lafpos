import { describe, expect, it } from 'vitest';
import { withPanelPrices } from '../server/sync/laffogato-menu';

// Fiyatın taze kaynağı imzalı panel: CDN'deki herkese açık menü 5 dk'ya kadar bayat kalabilir
describe('withPanelPrices', () => {
  const items = [
    { id: 'mnu-1', priceMinor: 10000, priceLargeMinor: 12000 },
    { id: 'mnu-2', priceMinor: 5000, priceLargeMinor: null },
  ];
  it('panel yoksa herkese açık menünün fiyatı', () => {
    expect(withPanelPrices(items, null)).toEqual(items);
  });
  it('panel varsa M ve L fiyatı panelden; 0 L tek boy', () => {
    const panel = new Map([
      ['mnu-1', { isActive: true, priceMinor: 11000, priceMinorL: 0 }],
      ['mnu-2', { isActive: true, priceMinor: 5500, priceMinorL: 6500 }],
    ]);
    expect(withPanelPrices(items, panel)).toEqual([
      { id: 'mnu-1', priceMinor: 11000, priceLargeMinor: null },
      { id: 'mnu-2', priceMinor: 5500, priceLargeMinor: 6500 },
    ]);
  });
  it('panelde olmayan ya da geçersiz fiyatlı kalem değişmez', () => {
    const panel = new Map([['mnu-1', { isActive: true, priceMinor: 0, priceMinorL: 0 }]]);
    expect(withPanelPrices(items, panel)).toEqual(items);
  });
});
