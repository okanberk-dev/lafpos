import { describe, expect, it } from 'vitest';
import { komutDogrula, komutOzeti } from '@shared/kontrol';

describe('uzaktan ürün görseli (urun.gorsel)', () => {
  const id = '01M7ZRVCTR4ECRT5HR49239MP2';
  it('yalnız laffogato.net adresi ya da null kabul edilir', () => {
    expect(komutDogrula('urun.gorsel', { id, gorsel: 'https://laffogato.net/gorsel/menu/mnu-0005?v=abc123' })).toMatchObject({ ok: true });
    expect(komutDogrula('urun.gorsel', { id, gorsel: null })).toMatchObject({ ok: true });
    for (const gorsel of ['http://laffogato.net/x', 'https://evil.example/x.png', 'https://laffogato.net.evil.com/x', 'javascript:alert(1)', 42]) {
      expect(komutDogrula('urun.gorsel', { id, gorsel })).toMatchObject({ ok: false });
    }
  });
  it('özet ürün adıyla', () => {
    expect(komutOzeti('urun.gorsel', { id, gorsel: 'https://laffogato.net/gorsel/menu/mnu-0005' }, { urun: { [id]: 'AMERICANO' } })).toBe('Görsel ekle: AMERICANO');
  });
});
