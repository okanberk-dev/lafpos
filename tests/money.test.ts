import { describe, expect, it } from 'vitest';
import { allocate, changeDue, parseTL, percentOf, roundHalfUp, splitEven, splitKdv, suggestCash, tl } from '@shared/money';

describe('para', () => {
  it('tl biçimi Türkçe', () => {
    expect(tl(123450)).toBe('₺1.234,50');
    expect(tl(0)).toBe('₺0,00');
  });

  it('parseTL farklı yazımları kuruşa çevirir', () => {
    expect(parseTL('12')).toBe(1200);
    expect(parseTL('12,5')).toBe(1250);
    expect(parseTL('12.50')).toBe(1250);
    expect(parseTL('1.234,56')).toBe(123456);
    expect(parseTL('1,234.56')).toBe(123456);
    expect(parseTL('₺ 85')).toBe(8500);
    expect(parseTL('1.250')).toBe(125000);
    expect(parseTL('0.250')).toBe(25);
    expect(parseTL('abc')).toBeNull();
    expect(parseTL('')).toBeNull();
    expect(parseTL('-5')).toBe(-500);
  });

  it('yarım-yukarı yuvarlama', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(2.675 * 100)).toBe(268);
    expect(percentOf(12345, 10)).toBe(1235);
  });

  it('KDV ayrıştırma toplamı korur', () => {
    expect(splitKdv(11000, 10)).toEqual({ net: 10000, kdv: 1000 });
    expect(splitKdv(12000, 20)).toEqual({ net: 10000, kdv: 2000 });
    for (const g of [1, 99, 8500, 12345, 99999]) {
      for (const r of [0, 1, 10, 20]) {
        const { net, kdv } = splitKdv(g, r);
        expect(net + kdv).toBe(g);
      }
    }
  });

  it('allocate kuruşu kaybetmez', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(100, [0, 0])).toEqual([50, 50]);
    expect(allocate(-100, [1, 3])).toEqual([-25, -75]);
    const parts = allocate(9999, [3, 7, 11, 13]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9999);
    expect(splitEven(1000, 3)).toEqual([334, 333, 333]);
  });

  it('para üstü', () => {
    expect(changeDue(8500, 10000)).toBe(1500);
    expect(changeDue(8500, 5000)).toBe(0);
  });

  it('nakit önerisi banknota yuvarlar, tam tutarı ve küçüğünü önermez', () => {
    const fixed = [10000, 20000, 50000, 100000, 200000];
    expect(suggestCash(18750, fixed)).toEqual([19000, 20000, 50000, 100000]);
    expect(suggestCash(4500, fixed)).toEqual([5000, 6000, 10000, 20000]);
    expect(suggestCash(20000, fixed)).toEqual([50000, 100000, 200000]);
    expect(suggestCash(0, fixed)).toEqual([]);
  });
});
