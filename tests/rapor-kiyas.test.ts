import { describe, expect, it } from 'vitest';
import { previousShort } from '../src/lib/reportLabels';

/**
 * Raporlar KPI şeridinin kıyas etiketi, kıyas dönemiyle (sunucunun `comparison` aralığı). "Geçen ay" seçiliyken
 * kıyas önceki ayın tamamıysa etiket "Önceki ay" der: Ekim'in tamamı Eylül'ün tamamıyla kıyaslanırken "Önceki ayın
 * ilk 30 günü" yazmak yanlış bir kısmilik söylüyordu. Önceki ayın bir kısmıysa (Eylül'ün 30 günü Ağustos'un ilk 30
 * günüyle) gün sayısı kalır.
 */
const LABEL = 'önceki ayın aynı günleri';

describe('raporlar kıyas etiketi: önceki ayın tamamı', () => {
  it('kıyas dönemi bir takvim ayının tamamıysa "Önceki ay"', () => {
    expect(previousShort(LABEL, { from: '2026-09-01', to: '2026-09-30' })).toBe('Önceki ay');
    // Mart'ın tamamı Şubat'ın tamamıyla (2026 artık yıl değil)
    expect(previousShort(LABEL, { from: '2026-02-01', to: '2026-02-28' })).toBe('Önceki ay');
  });

  it('ayın bir kısmıysa gün sayısıyla: Ocak 1–28 ve Ağustos 1–30', () => {
    expect(previousShort(LABEL, { from: '2026-01-01', to: '2026-01-28' })).toBe('Önceki ayın ilk 28 günü');
    expect(previousShort(LABEL, { from: '2026-08-01', to: '2026-08-30' })).toBe('Önceki ayın ilk 30 günü');
  });

  it('bugünü içeren dönemde "bu saate dek" eki kalır', () => {
    expect(previousShort(`${LABEL}, aynı saate kadar`, { from: '2026-02-01', to: '2026-02-28' })).toBe('Önceki ay, bu saate dek');
  });
});
