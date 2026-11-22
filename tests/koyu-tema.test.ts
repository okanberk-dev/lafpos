import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Koyu tema "gece" (sahibin isteği, 22 Kas 2026: bordo yerine nötr, telefonun koyu gruplanmış listesi gibi). Değerler
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

/** Doygunluk: en parlak ve en soluk kanalın farkı (0 gri, 1 saf renk) */
const chroma = (hex: string) => {
  const c = channels(hex);
  return Math.max(...c) - Math.min(...c);
};

describe('koyu tema: gece', () => {
  it('nötr zemin: doygunluk çok düşük, zemin siyah, yüzeyler katman katman açılır', () => {
    const steps = ['admin-bg', 'admin-surface', 'admin-surface-2', 'admin-panel'].map(get);
    // Renksiz gri: kanallar arası fark en çok 3/255 (bordo, yeşil ya da mavi tonu yok)
    for (const n of ['admin-bg', 'admin-stage', 'admin-surface', 'admin-surface-2', 'admin-panel', 'surface-raised', 'admin-border', 'admin-border-strong', 'admin-divider', 'admin-border-field', 'band', 'band-2', 'band-line'])
      expect(chroma(get(n)), `${n} doygunluğu`).toBeLessThanOrEqual(0.012);
    expect(luminance(get('admin-bg'))).toBeLessThan(0.002);
    // Her basamak bir öncekinden açık: kart kenarsız ve gölgesiz, tonla ayrılır
    for (let i = 1; i < steps.length; i++) expect(luminance(steps[i]!), `${steps[i]} > ${steps[i - 1]}`).toBeGreaterThan(luminance(steps[i - 1]!) * 1.15);
    expect(luminance(get('surface-raised'))).toBeGreaterThan(luminance(get('admin-panel')));
    expect(get('shadow-card')).toBe('none');
    // Zemindeki kart (pano, bar ekranı) kenarsız: siyah zeminden yalnız tonla ayrılır
    expect(css).toMatch(/\.dark :is\(\.lp-bare, \.lp-float\) \{\s*--card-line: transparent;/);
    expect(contrast(get('admin-surface'), get('admin-bg')), 'kart zeminde seçilir').toBeGreaterThan(1.15);
  });

  it('metin kırık beyaz ve nötr; ikincil ve soluk gri', () => {
    expect(get('admin-text')).not.toBe('#ffffff');
    expect(luminance(get('admin-text'))).toBeGreaterThan(0.85);
    for (const n of ['admin-text', 'admin-text-soft', 'admin-text-mute', 'band-text', 'band-muted']) expect(chroma(get(n)), `${n} doygunluğu`).toBeLessThanOrEqual(0.03);
    expect(luminance(get('admin-text'))).toBeGreaterThan(luminance(get('admin-text-soft')));
    expect(luminance(get('admin-text-soft'))).toBeGreaterThan(luminance(get('admin-text-mute')));
  });

  it('gövde ve durum metni her yüzeyde en az 4.5:1', () => {
    for (const t of TEXTS) for (const s of SURFACES) expect(contrast(get(t), get(s)), `${t} / ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('rozet ve etiket yazısı kendi zemininde 4.5:1; beyaz metin yumuşak zeminlerde de okunur', () => {
    for (const [fg, bg] of BADGES) expect(contrast(get(fg), get(bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
    // Seçili hap (LafPOS Keel) yumuşak zemin değil dolgudur: üstünde yalnız kendi yazısı (menu-active-ink) durur
    for (const [, bg] of BADGES) if (bg !== 'menu-active-bg') expect(contrast(get('admin-text'), get(bg)), `admin-text / ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('hap zeminleri yumuşak: koyu ve renkli (kartın grisinden ayrılır), yazıyla yarışmaz', () => {
    for (const n of ['admin-success-soft', 'admin-danger-soft', 'admin-warning-soft', 'admin-info-soft', 'admin-primary-soft', 'admin-blue-soft', 'admin-signal-soft', 'admin-accent-soft']) {
      expect(luminance(get(n)), `${n} koyu`).toBeLessThan(0.03);
      expect(chroma(get(n)), `${n} renkli`).toBeGreaterThan(0.06);
    }
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

  it('LafPOS Keel (DESIGN.md §0): ray nötr yüzey, seçili ekran ve ana eylem ters dolgu; bağlantı ve seçim ev yeşili, bordo yok', () => {
    for (const t of ['rail-text', 'rail-soft', 'rail-mute']) expect(contrast(get(t), get('rail')), `${t} / ray`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('rail-active-ink'), get('rail-active-bg')), 'seçili karo').toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('rail-active-ink'), get('rail-active-icon')), 'seçili karonun ikonu').toBeGreaterThanOrEqual(3);
    const house = light['admin-primary']!;
    // Ray kartla aynı nötr yüzey (sade yan menü); ana eylem gecede açık dolgu, üstünde mürekkep
    expect(get('rail')).toBe(get('admin-surface'));
    expect(get('admin-ink-fill')).toBe(get('rail-active-bg'));
    expect(chroma(get('admin-ink-fill')), 'ana eylem nötr').toBeLessThan(0.03);
    expect(hueGap(get('admin-primary'), house), 'bağlantı ve seçim ev yeşili').toBeLessThan(12);
    // Bordo (ton 330-355°, doygun) hiçbir koyu belirteçte yok; ahududu sinyal ve gül (parlak pembe) bordo değildir
    for (const [name, value] of Object.entries(dark)) {
      for (const hex of value.match(/#[0-9a-f]{6}\b/gi) ?? []) {
        const wine = hue(hex) > 330 && hue(hex) < 355 && chroma(hex) > 0.05 && luminance(hex) < 0.08;
        if (wine) expect(['admin-signal-soft', 'admin-hue-rose-soft', 'admin-signal-line', 'admin-rose-line'], `--${name}: ${hex} bordo`).toContain(name);
      }
    }
  });

  it('durum renkleri anlam taşır: artış yeşil, düşüş mercan, uyarı kehribar, bilgi mavi', () => {
    const up = hue(get('admin-success'));
    expect(up > 120 && up < 160, `başarı yeşil ${up.toFixed(0)}°`).toBe(true);
    const danger = hue(get('admin-danger-ink'));
    expect(danger < 15 || danger > 355, `tehlike mercan ${danger.toFixed(0)}°`).toBe(true);
    // Mercan saf kırmızıdan yumuşak: kanalların en soluğu da açık
    expect(Math.min(...channels(get('admin-danger-ink')))).toBeGreaterThan(0.35);
    expect(hueGap(get('admin-danger-soft'), get('admin-success-soft')), 'düşüş ve artış zemini ayrı').toBeGreaterThan(90);
    const amber = hue(get('admin-warning'));
    expect(amber > 30 && amber < 50, `uyarı kehribar ${amber.toFixed(0)}°`).toBe(true);
    const info = hue(get('admin-info'));
    expect(info > 180 && info < 240, `bilgi mavi ${info.toFixed(0)}°`).toBe(true);
  });

  it('tarayıcı çubuğu koyu zeminle aynı; müşteri ekranının gece paleti aynı nötr', () => {
    expect(readFileSync(join(root, 'src/lib/theme.ts'), 'utf8')).toContain(`dark ? '${get('admin-bg')}'`);
    const display = readFileSync(join(root, 'src/components/display/CustomerDisplayView.tsx'), 'utf8');
    const gece = display.slice(display.indexOf('  gece: {'), display.indexOf('  porselen: {'));
    for (const [k, t] of [
      ['d-bg', 'admin-bg'],
      ['d-surface', 'admin-surface'],
      ['d-chip', 'admin-panel'],
      ['d-line', 'admin-border'],
      ['d-text', 'admin-text'],
      ['d-soft', 'admin-text-soft'],
      ['d-mute', 'admin-text-mute'],
      ['d-accent', 'admin-primary'],
    ] as const) expect(gece, k).toContain(`'--${k}': '${get(t)}'`);
  });

  it('bar ekranının "Hepsi hazır"ı gecede ana eylem belirtecinde (ham yeşil ölçek değil)', () => {
    const button = readFileSync(join(root, 'src/components/ui/Button.tsx'), 'utf8');
    const success = button.slice(button.indexOf('  success:'), button.indexOf('  // Pirinç dolgu'));
    expect(success).toContain('dark:bg-[var(--admin-ink-fill)]');
    expect(success).toContain('dark:text-[var(--admin-on-ink)]');
    expect(success).not.toMatch(/dark:[\w:-]*bg-success-\d/);
  });

  it('açık temanın kimliği yerinde (zemin ve mürekkep LafPOS Keel: DESIGN.md §0)', () => {
    expect(light['admin-bg']).toBe('#eceef1');
    expect(light['admin-surface']).toBe('#ffffff');
    expect(light['admin-primary']).toBe('#0a6e52');
    expect(light['admin-text']).toBe('#171a26');
    expect(light['admin-ink-fill']).toBe('#171a26');
    expect(light['rail']).toBe('#ffffff');
  });
});
