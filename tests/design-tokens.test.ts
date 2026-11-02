import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Renk değerlerinin erişilebilirliği (WCAG 2.2): okunan metin zeminde en az 4.5:1, alan kenarı ve odak halkası 3:1.
 * Değerler src/index.css'ten okunur. Kasa ekranları ve yönetim paneli aynı LafPOS Sade değerlerini kullanır (L'Affogato
 * kimliği, laffogato docs/BRAND.md; açık `:root`, koyu `.dark`; DESIGN.md); ortak adlar (`--bg`, `--ink`...) `--admin-*`'e bağlanır.
 * Test düşerse değeri düzelt, eşiği gevşetme.
 */
const css = readFileSync(join(__dirname, '../src/index.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`index.css'te ${selector} yok`);
  const body = css.slice(start, css.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** var(--x) zincirini aynı blok ya da taban blok içinde çözer */
function resolver(...layers: Record<string, string>[]) {
  const get = (name: string): string => {
    for (const l of layers) {
      const v = l[name];
      if (!v) continue;
      const ref = v.match(/^var\(--([\w-]+)\)$/);
      return ref ? get(ref[1]) : v;
    }
    throw new Error(`--${name} tanımsız`);
  };
  return get;
}

const posLight = resolver(block(':root'));
const posDark = resolver(block('.dark'), block(':root'));
const adminLight = posLight;
const adminDark = posDark;

describe('kasa ekranları (LafPOS Sade)', () => {
  for (const [name, get] of [
    ['açık', posLight],
    ['koyu', posDark],
  ] as const) {
    it(`${name}: metin zeminde ve yüzeyde okunur`, () => {
      for (const text of ['ink', 'ink-2', 'muted']) {
        for (const ground of ['bg', 'surface']) expect(contrast(get(text), get(ground)), `${text}/${ground}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(get('primary-ink'), get('primary')), 'birincil düğme').toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('yönetim paneli (LafPOS Sade)', () => {
  const tones = [
    ['primary', 'primary-soft'],
    ['blue', 'blue-soft'],
    ['success', 'success-soft'],
    ['warning', 'warning-soft'],
    ['danger-ink', 'danger-soft'],
    ['info', 'info-soft'],
    ['accent-ink', 'accent-soft'],
    ['text-soft', 'neutral-soft'],
    ['hue-blue', 'hue-blue-soft'],
    ['hue-amber', 'hue-amber-soft'],
    ['hue-rose', 'hue-rose-soft'],
    ['hue-violet', 'hue-violet-soft'],
    ['hue-green', 'hue-green-soft'],
  ] as const;

  for (const [name, get] of [
    ['açık', adminLight],
    ['koyu', adminDark],
  ] as const) {
    it(`${name}: metin gri zeminde, kartta ve kuyuda okunur`, () => {
      for (const text of ['admin-text', 'admin-text-soft', 'admin-text-mute']) {
        for (const ground of ['admin-bg', 'admin-surface', 'admin-surface-2', 'admin-panel']) expect(contrast(get(text), get(ground)), `${text}/${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: birincil mavi hem düğmede hem bağlantıda`, () => {
      expect(contrast(get('admin-on-primary'), get('admin-primary')), 'düğme yazısı').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-surface')), 'bağlantı kartta').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-bg')), 'bağlantı gri zeminde').toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: her durum tonu ve grup rengi kendi açık zemininde AA`, () => {
      for (const [fg, bg] of tones) expect(contrast(get(`admin-${fg}`), get(`admin-${bg}`)), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: boş alanın kenarı kartta bulunur (3:1)`, () => {
      expect(contrast(get('admin-border-field'), get('admin-surface'))).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: odak halkası (ev yeşili) kartta ve zeminde seçilir (3:1)`, () => {
      for (const ground of ['admin-surface', 'admin-bg', 'admin-surface-2', 'admin-panel']) expect(contrast(get('focus'), get(ground)), ground).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: mürekkep düğme (ödeme) ve pirinç dolgu okunur`, () => {
      expect(contrast(get('admin-on-ink'), get('admin-ink-fill')), 'mürekkep düğme').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-gold-ink'), get('admin-gold-fill')), 'pirinç dolgu').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-gold'), get('admin-bg')), 'altın metin').toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: durum mavisi kartta okunur (bağlantı, "barda")`, () => {
      expect(contrast(get('admin-blue'), get('admin-surface'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-blue'), get('admin-bg'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('kasa ekranları da LafPOS Sade: adlar laffogato.net değerlerine bağlı (porselen zemin, ev yeşili birincil)', () => {
    expect(posLight('bg')).toBe('#f7f3ed');
    expect(posLight('primary')).toBe('#1d6d56');
    expect(posLight('ink')).toBe('#211c18');
    expect(posDark('primary')).toBe('#5cc9a2');
  });

  it('sitenin paleti (laffogato docs/BRAND.md §1; DESIGN.md §2 tablosu)', () => {
    expect(adminLight('admin-bg')).toBe('#f7f3ed');
    expect(adminLight('admin-surface-2')).toBe('#fbf8f4');
    expect(adminLight('admin-panel')).toBe('#f2ece4');
    expect(adminLight('admin-primary')).toBe('#1d6d56');
    expect(adminLight('admin-primary-hover')).toBe('#165543');
    expect(adminLight('admin-text')).toBe('#211c18');
    expect(adminLight('admin-text-soft')).toBe('#564d46');
    expect(adminLight('admin-text-mute')).toBe('#675e56');
    expect(adminLight('admin-border-field')).toBe('#877d74');
    expect(adminLight('admin-blue')).toBe('#3442b8');
    expect(adminLight('admin-gold-fill')).toBe('#e8c877');
    expect(adminLight('admin-bordo')).toBe('#9d2543');
    // Uygulama ikonunun ve sitenin altbilgisinin yeşili
    expect(css).toMatch(/--brand-tile:\s*radial-gradient\([^;]*#23876a[^;]*#1d6d56[^;]*#0c3b2d/);
  });

  it('yazı: sitenin iki sesi pakette (başlık ve rakam Gabarito, metin Poppins); dış kaynaktan yazı yok', () => {
    expect(css).toMatch(/--font-sans:\s*'LafPOS Rakam',\s*'Poppins'/);
    expect(css).toMatch(/--font-headline:\s*'LafPOS Rakam',\s*'Gabarito'/);
    for (const w of [400, 500, 600, 700]) {
      expect(css, `Poppins ${w} latin`).toContain(`@fontsource/poppins/files/poppins-latin-${w}-normal.woff2`);
      expect(css, `Poppins ${w} latin-ext (ğ, ş, ı, İ, ₺)`).toContain(`@fontsource/poppins/files/poppins-latin-ext-${w}-normal.woff2`);
    }
    expect(css).toContain('@fontsource-variable/gabarito/files/gabarito-latin-ext-wght-normal.woff2');
    const digits = css.slice(css.indexOf("font-family: 'LafPOS Rakam'"));
    expect(digits).toMatch(/@fontsource-variable\/gabarito\/files\/gabarito-latin-wght-normal\.woff2/);
    expect(digits.slice(0, digits.indexOf('}'))).toMatch(/unicode-range:\s*U\+0030-0039;/);
    expect(css).toMatch(/h1,\s*h2,\s*h3 \{[^}]*font-family: var\(--font-headline\)/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@fontsource\/inter|outfit/i);
  });
});
