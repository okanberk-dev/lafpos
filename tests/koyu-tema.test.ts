import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Koyu tema "bordo gece" (sahibin isteği, 22 Kas 2026: "koyu bordo tonlarda, İtalya renklerine uyumlu"). Değerler
 * src/index.css'in `.dark` bloğundan okunur; kontrast WCAG 2.2 göreli parlaklık formülüyle: okunan metin her yüzeyde
 * en az 4.5:1, kenar, ikon, odak halkası ve eylem dolgusu (arayüz öğesi) 3:1. Test düşerse değeri düzelt, eşiği gevşetme.
 */
const root = join(__dirname, '..');
const css = readFileSync(join(root, 'src/index.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`index.css'te ${selector} yok`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const dark = block('.dark');
const light = block(':root');
const get = (name: string): string => {
  const v = dark[name] ?? light[name];
  if (!v) throw new Error(`--${name} tanımsız`);
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  return ref ? get(ref[1]) : v;
};

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(d, 360 - d);
};

/** Metnin durduğu her yüzey: zemin, sahne, kart, kart içi alan, kuyu, yüzen yüzey, rozet zeminleri değil */
const SURFACES = ['admin-bg', 'admin-stage', 'admin-surface', 'admin-surface-2', 'admin-panel', 'surface-raised'];
/** Yüzeyde okunan metin ve durum yazıları */
const TEXTS = ['admin-text', 'admin-text-soft', 'admin-text-mute', 'admin-primary', 'admin-danger-ink', 'admin-warning', 'admin-success', 'admin-info', 'admin-blue', 'admin-signal', 'admin-gold', 'admin-accent-ink', 'admin-bordo'];
/** Rozet ve etiketler: yazı kendi yumuşak zemininde, yumuşak zemin her yüzeyde */
const BADGES: [string, string][] = [
  ['admin-primary', 'admin-primary-soft'],
  ['admin-success', 'admin-success-soft'],
  ['admin-warning', 'admin-warning-soft'],
  ['admin-danger-ink', 'admin-danger-soft'],
  ['admin-info', 'admin-info-soft'],
  ['admin-blue', 'admin-blue-soft'],
  ['admin-signal', 'admin-signal-soft'],
  ['admin-accent-ink', 'admin-accent-soft'],
  ['admin-bordo', 'admin-bordo-soft'],
  ['admin-text-soft', 'admin-neutral-soft'],
  ['admin-hue-blue', 'admin-hue-blue-soft'],
  ['admin-hue-amber', 'admin-hue-amber-soft'],
  ['admin-hue-rose', 'admin-hue-rose-soft'],
  ['admin-hue-violet', 'admin-hue-violet-soft'],
  ['admin-hue-green', 'admin-hue-green-soft'],
  ['menu-active-ink', 'menu-active-bg'],
];

describe('koyu tema: bordo gece', () => {
  it('zemin siyaha yakın şarap (kırmızıya kaçmaz), yüzeyler katman katman açılır', () => {
    const steps = ['admin-bg', 'admin-surface', 'admin-surface-2', 'admin-panel'].map(get);
    for (const c of steps) {
      const h = hue(c);
      // Bordo: kırmızının mora yakın yanı (330-355°), saf kırmızı (0-15°) değil
      expect(h > 330 && h < 355, `${c} tonu ${h.toFixed(0)}°`).toBe(true);
      const [r, g, b] = channels(c);
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${c} doygunluğu`).toBeLessThan(0.1);
    }
    expect(luminance(get('admin-bg'))).toBeLessThan(0.01);
    // Her basamak bir öncekinden açık: kart gölgesiz, tonla ayrılır
    for (let i = 1; i < steps.length; i++) expect(luminance(steps[i]), `${steps[i]} > ${steps[i - 1]}`).toBeGreaterThan(luminance(steps[i - 1]) * 1.15);
    expect(get('shadow-card')).toBe('none');
  });

  it('metin sıcak krem (saf beyaz değil)', () => {
    const [r, g, b] = channels(get('admin-text'));
    expect(get('admin-text')).not.toBe('#ffffff');
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThanOrEqual(g);
  });

  it('gövde ve durum metni her yüzeyde en az 4.5:1', () => {
    for (const t of TEXTS) for (const s of SURFACES) expect(contrast(get(t), get(s)), `${t} / ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('rozet ve etiket yazısı kendi zemininde 4.5:1; krem metin yumuşak zeminlerde de okunur', () => {
    for (const [fg, bg] of BADGES) expect(contrast(get(fg), get(bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const [, bg] of BADGES) expect(contrast(get('admin-text'), get(bg)), `admin-text / ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('eylem dolguları: yazısı 4.5:1, dolgu yüzeyde 3:1; ok halkası seçilir', () => {
    expect(contrast(get('admin-on-ink'), get('admin-ink-fill')), 'ana eylem yazısı').toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('admin-on-primary'), get('admin-primary')), 'yeşil dolgu yazısı').toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('chart-on-accent'), get('admin-chart-line')), 'grafik değer hapı').toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('admin-gold-ink'), get('admin-gold-fill')), 'pirinç dolgu').toBeGreaterThanOrEqual(4.5);
    for (const s of SURFACES) {
      expect(contrast(get('admin-ink-fill'), get(s)), `ana eylem / ${s}`).toBeGreaterThanOrEqual(3);
      expect(contrast(get('admin-primary'), get(s)), `yeşil dolgu / ${s}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(get('ok-ring'), get('admin-ink-fill')), 'halka düğmede').toBeGreaterThanOrEqual(3);
    expect(contrast(get('ok-arrow'), get('ok-ring')), 'ok halkada').toBeGreaterThanOrEqual(3);
  });

  it('kenar, ikon ve odak halkası (arayüz öğesi) her yüzeyde 3:1', () => {
    for (const s of SURFACES) {
      expect(contrast(get('focus'), get(s)), `odak / ${s}`).toBeGreaterThanOrEqual(3);
      expect(contrast(get('admin-border-field'), get(s)), `alan kenarı / ${s}`).toBeGreaterThanOrEqual(3);
    }
    for (const s of ['admin-surface', 'admin-surface-2']) expect(contrast(get('chart-context'), get(s)), `kıyas çizgisi / ${s}`).toBeGreaterThanOrEqual(3);
    // Odak halkası ana eylemin etrafında da seçilir (2 px boşlukla; yine de dolguya karşı 3:1)
    expect(contrast(get('focus'), get('admin-ink-fill')), 'odak / ana eylem').toBeGreaterThanOrEqual(3);
  });

  it('marka rayı İtalyan yeşili: yazı ve seçili karo okunur', () => {
    for (const t of ['rail-text', 'rail-soft', 'rail-mute']) expect(contrast(get(t), get('rail')), `${t} / ray`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('rail-active-ink'), get('rail-active-bg')), 'seçili karo').toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('rail-active-ink'), get('rail-active-icon')), 'seçili karonun ikonu').toBeGreaterThanOrEqual(3);
    expect(hueGap(get('rail'), '#009246'), 'ray bayrağın yeşili').toBeLessThan(12);
    expect(hueGap(get('admin-ink-fill'), '#009246'), 'ana eylem bayrağın yeşili').toBeLessThan(12);
  });

  it('durum renkleri birbirinden ve bordodan ayrılır: tehlike parlak mercan, başarı eylem yeşilinden ayrı, bilgi soğuk', () => {
    const danger = get('admin-danger-ink');
    // Tehlike zeminden ve bordodan çok daha parlak ve kırmızının turuncuya yakın yanında
    expect(luminance(danger)).toBeGreaterThan(luminance(get('admin-panel')) * 10);
    expect(hue(danger) < 20 || hue(danger) > 355, `tehlike tonu ${hue(danger).toFixed(0)}°`).toBe(true);
    expect(hueGap(danger, get('admin-bg')), 'tehlike ile zemin').toBeGreaterThan(15);
    // Tehlike zemini yüzeyden belirgin (rozet kart içinde kaybolmaz)
    expect(hueGap(get('admin-danger-soft'), get('admin-surface')), 'tehlike zemini ile kart').toBeGreaterThan(10);
    expect(hueGap(get('admin-success'), get('admin-primary')), 'başarı ile eylem yeşili').toBeGreaterThanOrEqual(20);
    const amber = hue(get('admin-warning'));
    expect(amber > 30 && amber < 50, `uyarı kehribar ${amber.toFixed(0)}°`).toBe(true);
    const info = hue(get('admin-info'));
    expect(info > 180 && info < 240, `bilgi soğuk ${info.toFixed(0)}°`).toBe(true);
  });

  it('tarayıcı çubuğu koyu zeminle aynı; müşteri ekranının gece paleti aynı bordo', () => {
    expect(readFileSync(join(root, 'src/lib/theme.ts'), 'utf8')).toContain(`dark ? '${get('admin-bg')}'`);
    const display = readFileSync(join(root, 'src/components/display/CustomerDisplayView.tsx'), 'utf8');
    const gece = display.slice(display.indexOf('  gece: {'), display.indexOf('  porselen: {'));
    for (const [k, t] of [
      ['d-bg', 'admin-bg'],
      ['d-surface', 'admin-surface'],
      ['d-text', 'admin-text'],
      ['d-mute', 'admin-text-mute'],
      ['d-accent', 'admin-primary'],
    ]) expect(gece, k).toContain(`'--${k}': '${get(t)}'`);
  });

  it('açık tema değişmedi (bordo yalnız gecede)', () => {
    expect(light['admin-bg']).toBe('#f1f4f2');
    expect(light['admin-surface']).toBe('#ffffff');
    expect(light['admin-primary']).toBe('#0a6e52');
    expect(light['admin-text']).toBe('#0f1513');
  });
});
