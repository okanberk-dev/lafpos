import { describe, expect, it } from 'vitest';
import { canonicalName, dedupe, distance, searchProducts } from '@shared/urun-arama';

const menu = [
  { id: '1', name: 'STRAWBERRY SMOOTHIE' },
  { id: '2', name: 'Çilek', site: true },
  { id: '3', name: 'Çilek Smoothie', site: true },
  { id: '4', name: 'CARAMEL BISCOFF LATTE' },
  { id: '5', name: 'Karamel Biscoff Latte', site: true },
  { id: '6', name: 'TÜRK KAHVESİ', shortName: 'Türk' },
  { id: '7', name: 'LATTE' },
];

describe('ürün arama', () => {
  it('Türkçe karakter ve harf boyutu duyarsız; kısa ad ve barkod aranır', () => {
    expect(searchProducts(menu, 'turk kahvesi').exact.map((p) => p.id)).toEqual(['6']);
    expect(searchProducts(menu, 'TÜRK').exact.map((p) => p.id)).toEqual(['6']);
  });
  it('Türkçe karşılıkla İngilizce adı bulur ve ikizler tek sonuç olur (yerel kalır)', () => {
    const r = searchProducts(menu, 'çilek').exact.map((p) => p.id);
    expect(r).toContain('1');
    expect(searchProducts(menu, 'karamel').exact.map((p) => p.id)).toEqual(['4']);
  });
  it('yazım hatasında benzer ürün önerir', () => {
    expect(searchProducts(menu, 'latte').exact.map((p) => p.id)).toEqual(['4', '7']);
    expect(searchProducts(menu, 'lattee').similar.map((p) => p.id)).toContain('7');
    expect(searchProducts(menu, 'karamell').similar.length).toBeGreaterThan(0);
    expect(searchProducts(menu, '  ')).toEqual({ exact: [], similar: [] });
  });
  it('kanonik ad ve düzenleme uzaklığı', () => {
    expect(canonicalName('Çilek Smoothie')).toBe(canonicalName('STRAWBERRY SMOOTHIE'));
    expect(distance('latte', 'lattee')).toBe(1);
    expect(distance('abc', 'xyzxyz')).toBeGreaterThan(2);
    expect(dedupe([{ id: 'a', name: 'Çilek Smoothie', site: true }, { id: 'b', name: 'STRAWBERRY SMOOTHIE' }]).map((p) => p.id)).toEqual(['b']);
  });
});
