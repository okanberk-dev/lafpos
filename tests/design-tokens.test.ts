import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Renk değerlerinin erişilebilirliği (WCAG 2.2): okunan metin zeminde en az 4.5:1, alan kenarı 3:1.
 * Değerler src/index.css'ten okunur; kasa (açık, koyu) ve yönetim paneli (Innex açık, LafPOS koyu) ayrı.
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
const adminLight = resolver(block(":root[data-area='admin']"), block(':root'));
const adminDark = resolver(block(":root.dark[data-area='admin']"), block(":root[data-area='admin']"), block(':root'));

describe('kasa ekranları', () => {
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

describe('yönetim paneli (Innex)', () => {
  const tones = [
    ['primary', 'primary-soft'],
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
  }

  it('laffogato paneliyle aynı açık değerler (docs/ADMIN-INNEX.md)', () => {
    expect(adminLight('admin-bg')).toBe('#edeff1');
    expect(adminLight('admin-primary')).toBe('#2f58f7');
    expect(adminLight('admin-border-field')).toBe('#898d94');
    expect(adminLight('admin-text')).toBe('#0c0e1b');
  });
});
