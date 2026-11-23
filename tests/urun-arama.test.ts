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

  // inceleme, 23 Kas 2026
  it('tekilleştirmede gizlenen site ikizi benzerlerde yeniden çıkmaz', () => {
    expect(searchProducts(menu, 'çilek smoothie')).toEqual({ exact: [menu[0]], similar: [] });
    expect(searchProducts(menu, 'karamel biscoff')).toEqual({ exact: [menu[3]], similar: [] });
    expect(searchProducts(menu, 'latte').similar.map((p) => p.id)).not.toContain('5');
  });

  it('yazarken de ikizden yalnız yerel olan bir kez çıkar: sorgu yalnız site kopyasının yazılışını tutsa da', () => {
    // "kara…" yalnız Karamel'i (site), "cara…" yalnız CARAMEL'i (yerel) tutar; öteki ikiz benzerlerde çıkıyordu
    for (const q of ['cara', 'caram', 'carame', 'kara', 'karam', 'karame']) {
      expect(searchProducts(menu, q)).toEqual({ exact: [menu[3]], similar: [] });
    }
    expect(searchProducts(menu, 'çile').exact.map((p) => p.id)).toEqual(['2', '1']);
    // Yazım hatasında benzerlerde de site kopyası yerine yerel ikizi
    expect(searchProducts(menu, 'çilekk').similar.map((p) => p.id)).toEqual(['2', '1']);
  });

  it('yalnız yerel ve site ikizi birleşir; iki yerel ya da iki site ürünü ayrı kalır', () => {
    const ids = (list: { id: string }[]) => list.map((p) => p.id);
    // Başka kategoride, başka fiyatla ikinci limonata; Türkçe ve İngilizce adlı iki yerel ürün
    expect(ids(dedupe([{ id: 'a', name: 'Limonata' }, { id: 'b', name: 'LİMONATA' }]))).toEqual(['a', 'b']);
    expect(ids(dedupe([{ id: 'a', name: 'Su', site: true }, { id: 'b', name: 'Water', site: true }]))).toEqual(['a', 'b']);
    // Bir yerel bir site ürününü gizler, ikincisini değil
    expect(ids(dedupe([{ id: 'a', name: 'Çay', site: true }, { id: 'b', name: 'TEA' }, { id: 'c', name: 'Tea', site: true }]))).toEqual(['b', 'c']);
    const list = [
      { id: '1', name: 'Çay' },
      { id: '2', name: 'Tea' },
      { id: '3', name: 'Cheesecake (Limon)' },
      { id: '4', name: 'Cheesecake Lemon' },
    ];
    expect(ids(searchProducts(list, 'çay').exact)).toEqual(['1', '2']);
    expect(ids(searchProducts(list, 'cheesecake').exact)).toEqual(['3', '4']);
  });

  it('üç harfli sözcük benzer önermez, baş harfi tutmayan sözcük de; Türkçe yazılış bulur', () => {
    const list = [
      { id: 'kek', name: 'Kek' },
      { id: 'granola', name: 'Çıtır Granola Bar (Kenya)' },
      { id: 'kakao', name: 'Kakao Protein Bar' },
      { id: 'sut', name: 'Süt' },
      { id: 'su', name: 'Su' },
      { id: 'surpriz', name: 'Sürpriz İçecek' },
      { id: 'surup', name: 'Şurup' },
      { id: 'tuzlu', name: 'Tuzlu Karamel Latte' },
      { id: 'buzlu', name: 'Buzlu Americano' },
      { id: 'cappuccino', name: 'Cappuccino' },
      { id: 'mocha', name: 'Mocha' },
      { id: 'macchiato', name: 'Espresso Macchiato' },
      { id: 'cortado', name: 'Cortado' },
      { id: 'latte', name: 'Latte' },
    ];
    const ids = (r: { exact: { id: string }[]; similar: { id: string }[] }) => ({ exact: r.exact.map((p) => p.id), similar: r.similar.map((p) => p.id) });
    expect(ids(searchProducts(list, 'kek'))).toEqual({ exact: ['kek'], similar: [] });
    expect(ids(searchProducts(list, 'süt'))).toEqual({ exact: ['sut'], similar: [] });
    expect(ids(searchProducts(list, 'muzlu'))).toEqual({ exact: [], similar: [] });
    expect(ids(searchProducts(list, 'kapucino')).exact).toEqual(['cappuccino']);
    expect(ids(searchProducts(list, 'kapuçino')).exact).toEqual(['cappuccino']);
    expect(ids(searchProducts(list, 'moka')).exact).toEqual(['mocha']);
    expect(ids(searchProducts(list, 'makyato')).exact).toEqual(['macchiato']);
    // Yazım hatası toleransı sürer: Türkçe k ile yazılan c, dört harften uzun sözcükte bir harf
    expect(ids(searchProducts(list, 'kortado')).similar).toEqual(['cortado']);
    expect(ids(searchProducts(list, 'late')).similar).toEqual(['tuzlu', 'latte']);
    expect(canonicalName('KAPUÇİNO')).toBe(canonicalName('Cappuccino'));
    // Derlenmiş ifadeler çağrılar arasında paylaşılır: aynı ad hep aynı sonucu verir
    expect(canonicalName('Çilek Smoothie')).toBe(canonicalName('Çilek Smoothie'));
  });
});
