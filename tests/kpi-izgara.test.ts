import { describe, expect, it } from 'vitest';
import { kpiCellSpan, kpiGridCols } from '../src/lib/kpiGrid';

/**
 * Dört hücreli KPI şeridi (Mesai çizelgesi, Raporlar › Saatlik, Paket platformları) tablette 2+2: dörde bölünen
 * şeritte hücre başına ~107 px kalıyor, etiket kırılıyor ve rakam 18-19 px'e iniyordu. Geniş ekranda tek satır.
 * İskelet aynı yardımcıyı kullanır (src/components/admin/ui.tsx), veri gelince şerit zıplamaz.
 */
describe('KPI şeridi: dört hücre', () => {
  it('tablette iki sütun, geniş ekranda dört; hücre yayılmaz', () => {
    expect(kpiGridCols(4)).toBe('md:grid-cols-2 xl:grid-cols-4');
    expect([0, 1, 2, 3].map((i) => kpiCellSpan(4, i))).toEqual([null, null, null, null]);
  });
});
