import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Bar ekranı (4 Kasım 2026, operatör: "daha güzel ve daha grid dayalı düzenli bir tasarım"): fişler kabın genişliğine göre
 * 1-5 sütunlu ızgarada, aynı satırdakiler eşit boyda ve düğmeleri dipte hizalı; üstte sayaç şeridi (bekliyor,
 * hazırlanıyor, teslim bekliyor, geciken); fişin üstünde durum çizgisi, künye ikinci satırda, ödemesi alınmış siparişte
 * "Ödendi". Davranış, istekler ve e2e'nin seçtiği adlar aynı.
 */
const page = readFileSync(new URL('../src/pages/KitchenPage.tsx', import.meta.url), 'utf8');

describe('bar ekranı: ızgara ve düzen', () => {
  it('fişler kabın genişliğine göre sütunlu ızgarada (container query), serbest auto-fill ve items-start yok', () => {
    expect(page).toContain("const GRID = 'grid grid-cols-1 gap-3 @[38rem]:grid-cols-2 @[58rem]:grid-cols-3 @[80rem]:grid-cols-4 @[104rem]:grid-cols-5';");
    expect(page).toContain('<div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">');
    expect(page).not.toContain('repeat(auto-fill');
    // Izgara satırları esner (items-start yok): aynı satırdaki fişler eşit boy
    expect(page.match(/const GRID = '[^']*'/)?.[0]).not.toContain('items-start');
    // Yükleme iskeleti, Toplam ve fişler aynı ızgarada
    expect(page.match(/className=\{GRID\}/g)?.length).toBe(2);
    expect(page).toContain("className={cn(GRID, showTotals && 'hidden')}");
  });

  it('aynı satırdaki fişler eşit boyda: kart sütun düzeni, kalemler esner, düğmeler dipte', () => {
    expect(page).toContain("'flex flex-col overflow-hidden rounded-2xl border bg-surface'");
    expect(page).toContain('<ul className="flex-1 divide-y divide-[var(--admin-divider)]">');
    expect(page).toContain("'mt-auto flex gap-2 border-t border-[var(--admin-divider)] p-2'");
  });

  it('fişin üstünde durum çizgisi; künye ikinci satırda; ödemesi alınmış siparişte "Ödendi"', () => {
    expect(page).toContain("<span aria-hidden=\"true\" className={cn('h-1 shrink-0', accent)} />");
    expect(page).toMatch(/: making\s*\? 'bg-\[var\(--admin-blue\)\]'/);
    expect(page).toContain('{t.paid && !online && !history && (');
    expect(page).toMatch(/<CircleCheck aria-hidden="true" className="size-3.5" \/>\s*Ödendi/);
  });

  it('sayaç şeridi: bekliyor, hazırlanıyor, teslim bekliyor, geciken; telefonda başlıktaki hap sayaçlar', () => {
    for (const label of ['label="Bekliyor"', 'label="Hazırlanıyor"', 'label="Teslim bekliyor"', 'label="Geciken"']) expect(page).toContain(label);
    expect(page).toContain('<dl className="grid shrink-0 grid-cols-4 overflow-hidden rounded-2xl border border-line bg-surface max-sm:hidden">');
    expect(page).toContain("max-sm:order-first sm:hidden");
    // Bağlantı kopunca eski fişler ekranda kalır: şerit de durumla değil veriyle görünür
    expect(page).toContain("{view === 'aktif' && !!tickets.data && (");
    expect(page).not.toContain('tickets.isSuccess && (');
  });

  it('sayaç hücresi geçerli tanım listesi; tablet dikeyde etiket sığar (ikon yalnız geniş ekranda)', () => {
    const count = page.slice(page.indexOf('function Count('));
    // dt ve dd hücrenin doğrudan çocukları: araya sarmalayıcı div yok
    expect(count).toMatch(/<div className="relative min-w-0 border-l[^"]*">\s*<dt /);
    expect(count).not.toContain('<div className="min-w-0">');
    expect(count).toMatch(/<\/dt>\s*<dd /);
    // İkon dt'nin içinde, ekran okuyucudan gizli, lg altında gizli; dar hücrede yatay boşluk az
    expect(count).toMatch(/<dt [^>]*>\s*<span aria-hidden="true" className=\{cn\('absolute [^']*hidden[^']*lg:grid/);
    expect(count).toContain('px-3 py-3 first:border-l-0 lg:pl-16 lg:pr-4');
  });

  it("e2e'nin ve barın alıştığı adlar aynı", () => {
    for (const name of ['Hepsi hazır', 'Başla', 'Teslim edildi', 'Geri al', 'Toplam', 'Tükendi', 'Çağrı ekranı']) expect(page, name).toContain(name);
    expect(page).toContain('label="Diğer"');
    expect(page).toContain('title="Bar ekranı"');
    expect(page).toContain("{ value: 'hazir', label: 'Hazır', count: ready.data?.length }");
    expect(page).toContain("{ value: 'gecmis', label: 'Geçmiş' }");
  });
});
