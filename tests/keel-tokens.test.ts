import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AsilPOS Keel belirteçleri (src/styles/keel.css, DESIGN.md §0): iki temada aynı adlar tanımlı, metin ve arayüz öğesi
 * kontrastı eşiğin üstünde, belge ve belirteç dosyası aynı değerleri söyler. Test düşerse değeri düzelt, eşiği gevşetme
 */
const css = readFileSync(new URL('../src/styles/keel.css', import.meta.url), 'utf8');
const block = (start: string) => {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf('\n}', from));
};
const vars = (b: string) => Object.fromEntries([...b.matchAll(/--(k-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const light = vars(block(':root {'));
const dark = { ...light, ...vars(block('.dark {')) };

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('AsilPOS Keel belirteçleri', () => {
  it('gece teması açık temanın bütün renk belirteçlerini yeniden tanımlar', () => {
    const colors = Object.keys(light).filter((k) => /^#[0-9a-f]{6}$/i.test(light[k]!));
    const darkOwn = vars(block('.dark {'));
    expect(colors.filter((k) => !(k in darkOwn))).toEqual([]);
  });

  for (const [name, t] of [
    ['açık', light],
    ['gece', dark],
  ] as const) {
    it(`${name}: metin kartta, kuyuda ve zeminde okunur (≥ 4.5:1)`, () => {
      for (const bg of ['k-surface', 'k-well', 'k-canvas']) {
        for (const fg of ['k-ink', 'k-ink-2', 'k-mute']) expect(ratio(t[fg]!, t[bg]!), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(t['k-on-select']!, t['k-select']!), 'seçili hap').toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: hap yazısı kendi zemininde okunur (≥ 4.5:1)`, () => {
      for (const p of ['mint', 'neg', 'warn', 'info']) expect(ratio(t[`k-${p}-ink`]!, t[`k-${p}-soft`]!), p).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: grafik öğeleri ve seçili durum kartta seçilir (≥ 3:1)`, () => {
      expect(ratio(t['k-chart-hi']!, t['k-surface']!), 'grafik vurgusu').toBeGreaterThanOrEqual(3);
      expect(ratio(t['k-select']!, t['k-surface']!), 'seçili').toBeGreaterThanOrEqual(3);
      expect(ratio(t['k-line-strong']!, t['k-surface']!), 'alan kenarı').toBeGreaterThanOrEqual(1.4);
    });
  }

  // Segment (sahibin örnekleri, 26 Kas 2026): saydam ray kartın ve zeminin üstüne biner; seçilmeyen yazı ikisinde de
  // okunur, seçili yazı başparmakta okunur, sekme hapının yazısı hapta okunur
  const over = (rgba: string, bg: string) => {
    const m = rgba.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
    if (!m) throw new Error(`saydam renk değil: ${rgba}`);
    const a = Number(m[4]);
    const ch = (i: number) => Math.round(Number(m[i + 1]) * a + parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a));
    return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
  };
  for (const [name, t] of [
    ['açık', light],
    ['gece', dark],
  ] as const) {
    it(`${name}: segment ve sekme yazısı kendi zemininde okunur (≥ 4.5:1)`, () => {
      for (const bg of ['k-surface', 'k-canvas', 'k-well']) {
        const track = over(t['k-seg-track']!, t[bg]!);
        expect(ratio(t['k-seg-ink']!, track), `seçilmeyen / ray (${bg})`).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(t['k-ink']!, t['k-seg-thumb']!), 'seçili / başparmak').toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['k-ink-2']!, t['k-tab-bg']!), 'sekme yazısı / hap').toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['k-ink-2']!, t['k-pop']!), 'liste satırı / açılır liste').toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['k-ink']!, t['k-pop-hover']!), 'üstündeki satır').toBeGreaterThanOrEqual(4.5);
    });
  }

  it('belge (DESIGN.md §0) belirteç dosyasıyla aynı değerleri söyler', () => {
    const doc = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('## 0. AsilPOS Keel'), doc.indexOf('## 1. İlkeler'));
    for (const k of ['k-canvas', 'k-surface', 'k-ink', 'k-mute', 'k-select', 'k-mint']) {
      expect(section, `${k} açık`).toContain(light[k]!);
      expect(section, `${k} gece`).toContain(dark[k]!);
    }
  });

  it('ortak dosya kabuk stillerinden önce yüklenir', () => {
    const index = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(index.indexOf("@import './styles/keel.css';")).toBeGreaterThan(-1);
    expect(index.indexOf("@import './styles/keel.css';")).toBeLessThan(index.indexOf('@font-face'));
  });
});
