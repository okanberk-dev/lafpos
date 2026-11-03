import { describe, expect, it } from 'vitest';
import { fmtPhone, telHref } from '../src/lib/text';

/**
 * Telefon her ekranda aynı biçimde (müşteriler, rezervasyon, siparişlerde kurye): sunucu müşteri ve rezervasyon
 * telefonunu 10 rakam saklar (`normalizePhone`), kasiyer başka biçimde de yazabilir. Türkiye numarası olmayan değer
 * (dahili, platformun maskeli numarası) yazıldığı gibi kalır ve bağlantıda rakamlarına indirgenmez.
 */
describe('telefon biçimi', () => {
  it('Türkiye numarası her yazılışta "0532 111 22 33" ve "tel:+905321112233"', () => {
    for (const p of ['5321112233', '05321112233', '0532 111 22 33', '+90 532 111 22 33']) {
      expect(fmtPhone(p), p).toBe('0532 111 22 33');
      expect(telHref(p), p).toBe('tel:+905321112233');
    }
  });

  it('maskeli platform numarası ve dahili yazıldığı gibi; bağlantı numaraya dahiliyi yapıştırmaz', () => {
    const getir = '+90 (850) 000-00000 / 123456';
    expect(fmtPhone(getir)).toBe(getir);
    expect(telHref(getir)).toBe('tel:+90 (850) 000-00000 / 123456');
  });

  it('eksik ya da 0 ile başlayan 10 hane Türkiye numarası sayılmaz (çift sıfırlı biçim yazılmaz)', () => {
    expect(fmtPhone('532 111 22')).toBe('532 111 22');
    expect(fmtPhone('0532111223')).toBe('0532111223');
    expect(telHref(' 0532111223 ')).toBe('tel:0532111223');
  });
});
