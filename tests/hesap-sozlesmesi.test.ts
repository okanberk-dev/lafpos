import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Hesap sözleşmesi (docs/hesap-sozlesmesi.md): LafPOS ile ladmin'in (lafmaliyet) ortak hesap belgesi iki depoda bayt
 * bayt aynıdır. Bu test belgenin SHA-256 özetini sabitler; lafmaliyet'teki tests/hesap-sozlesmesi.test.ts aynı sabiti
 * taşır. Belge değişince iki kopya ve iki test aynı PR serisinde güncellenir.
 */

/** docs/hesap-sozlesmesi.md'nin SHA-256 özeti (lafmaliyet ile aynı) */
const HESAP_SOZLESMESI_SHA256 = 'd0f28629536fdb7e77a42ce37f30e45989f849071dd926d41e64a48525ed41d1';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

describe('hesap sözleşmesi', () => {
  it("belge lafmaliyet'teki kopyayla bayt bayt aynı (SHA-256 sabit)", () => {
    expect(createHash('sha256').update(read('docs/hesap-sozlesmesi.md')).digest('hex')).toBe(HESAP_SOZLESMESI_SHA256);
  });

  it('entegrasyon sözleşmesinin gün sonu bölümünden (§4) bağlantılı', () => {
    const doc = read('docs/03-ENTEGRASYON.md').toString('utf8');
    const section4 = doc.slice(doc.indexOf('## 4. '), doc.indexOf('## 5. '));
    expect(section4).toMatch(/\]\((\.\/)?hesap-sozlesmesi\.md\)/);
  });
});
