import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Yetkili onayı penceresi (src/lib/approval.tsx) giriş ekranıyla tek PIN düzeninde: onay tuşu tuş takımının son
 * sırasında (⌫ · 0 · Onayla), altında yalnız Vazgeç. e2e akışları (e2e/flows.mjs) "Yetkili onayı" penceresinde rakam
 * tuşlarına ve "Onayla"ya adıyla basar: adlar değişmez. Pencere document.body'ye çizildiği için kaynaktan denetlenir.
 */
const src = readFileSync(join(__dirname, '../src/lib/approval.tsx'), 'utf8');

describe('yetkili onayı: tek PIN düzeni', () => {
  it('onay tuş takımında, dört haneden önce kapalı; klavyenin Enter’ı da ona gider (ayrı onEnter yok)', () => {
    expect(src).toContain("confirm={{ label: 'Onayla', disabled: pin.length < 4, onPress: () => submit() }}");
    expect(src).not.toContain('onEnter=');
  });

  it('tuş takımının dışında ikinci bir Onayla düğmesi yok; Vazgeç tam genişlikte sakin düğme', () => {
    expect(src.match(/>\s*Onayla\s*</g)).toBeNull();
    expect(src).toMatch(/<Button variant="ghost" block onClick=\{cancel\}>\s*Vazgeç\s*<\/Button>/);
  });
});
