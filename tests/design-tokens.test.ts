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
    it(`${name}: birincil (ev yeşili) hem düğmede hem bağlantıda`, () => {
      expect(contrast(get('admin-on-primary'), get('admin-primary')), 'düğme yazısı').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-surface')), 'bağlantı kartta').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-bg')), 'bağlantı porselen zeminde').toBeGreaterThanOrEqual(4.5);
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
    it(`${name}: durum mavisi kartta okunur (dolu masa, "barda"; bağlantı birincil yeşil)`, () => {
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

  const src = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('mürekkep zeminli bildirimde odak halkası krem (yeşil halka mürekkepte 3:1 altında)', () => {
    expect(contrast(adminLight('admin-primary'), adminLight('admin-ink-fill')), 'yeşil halka mürekkepte zayıf').toBeLessThan(3);
    expect(contrast(adminLight('admin-on-ink'), '#211c18'), 'krem halka mürekkepte').toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/--color-night:\s*#211c18;/);
    const toast = src('src/lib/toast.tsx');
    expect(toast).toContain("const NIGHT_FOCUS = '[--focus:var(--admin-on-ink)] dark:[--focus:var(--admin-primary)]'");
    // Bildirim tonlarının kendisi (yalnız sabitin tanımı değil): mürekkep zeminli dört ton da halkayı krem yapar
    for (const tone of ['ok', 'err', 'info', 'warn']) expect(toast, tone).toContain(`${tone}: \`\${NIGHT_FOCUS} bg-night`);
    expect(toast.match(/focus-visible:-outline-offset-2/g)?.length, 'halka düğmenin içinde').toBe(2);
  });

  it('pirinç dolgunun üstündeki yazının kendi adı var (text-on-gold); text-gold-ink altın metindir', () => {
    expect(css).toMatch(/--color-on-gold:\s*var\(--admin-gold-ink\);/);
    expect(css).toMatch(/--color-gold-ink:\s*var\(--admin-gold\);/);
  });

  it('tarayıcı çubuğu ve kurulu uygulama zeminle aynı renkte (theme-color, manifest)', () => {
    const light = adminLight('admin-bg');
    const dark = block('.dark')['admin-bg'];
    expect(src('src/lib/theme.ts')).toContain(`dark ? '${dark}' : '${light}'`);
    expect(src('index.html')).toContain(`<meta name="theme-color" content="${light}" />`);
    const manifest = JSON.parse(src('public/manifest.webmanifest')) as { background_color: string; theme_color: string };
    expect([manifest.background_color, manifest.theme_color]).toEqual([light, light]);
  });

  it('koyu temadaki çizim diskinde yüzdeli dolgu yok (üst öğenin genişliğine göre hesaplanır, çizim sıfıra iner)', () => {
    const ill = src('src/components/Illustration.tsx');
    expect(ill).not.toMatch(/dark:p-\[\d+%\]/);
    expect(ill).toContain('dark:size-[76%]');
  });
});

/**
 * Köşe ve gölge belirteçleri (DESIGN.md §2 "Biçim", §4 "Kurumsal yüzey"): kasa ekranları bugünkü yumuşak değerlerle
 * (:root), yönetim ve raporlar kurumsal kapsamda (.surface-corporate, portal için :root[data-area='admin']). Ortak kit
 * köşeyi belirteçten okur; sayfaların rounded-xl / rounded-2xl'si Tailwind'in köşe değişkeniyle kapsamda küçülür.
 */
describe('köşe ve gölge belirteçleri, kurumsal yüzey', () => {
  const src = (f: string) => readFileSync(join(__dirname, '../src', f), 'utf8');
  const tokens = (() => {
    const at = css.indexOf(':root {\n  --r-card:');
    if (at < 0) throw new Error('index.css: köşe belirteçleri yok');
    const body = css.slice(at, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  })();
  const corporate = block(".surface-corporate,\n:root[data-area='admin']");

  it('kasa ekranlarının değerleri bugünkü gibi: kart 20, alan 14, düğme, çip ve segment kapsül, sütun 4', () => {
    expect(tokens).toMatchObject({ 'r-card': '1.25rem', 'r-control': '0.875rem', 'r-btn': '9999px', 'r-chip': '9999px', 'r-segment': '9999px', 'r-bar': '4px', 'r-track': '9999px' });
    expect(block('@theme')).toMatchObject({ 'radius-xl': '0.875rem', 'radius-2xl': '1.25rem' });
    expect(block('@theme')['shadow-card']).toMatch(/rgb\(59 42 30/);
  });

  it('kurumsal yüzey: kart, tablo, alan, düğme, segment 6; çip ve rozet 4; gölge yok; çubuk köşesiz', () => {
    expect(corporate).toMatchObject({
      'radius-lg': '6px',
      'radius-xl': '6px',
      'radius-2xl': '6px',
      'r-card': '6px',
      'r-control': '6px',
      'r-btn': '6px',
      'r-chip': '4px',
      'r-segment': '6px',
      'r-bar': '0px',
      'r-track': '0px',
      'shadow-card': 'none',
      'shadow-lift': 'none',
      rim: 'none',
      'table-head-bg': 'transparent',
    });
  });

  it('kapsam yönetim kabuğunun kökünde (raporlar da aynı kabukta); kasa ekranlarında yok', () => {
    expect(src('components/admin/AdminShell.tsx')).toMatch(/className="surface-corporate /);
    expect(src('pages/reports/ReportsPage.tsx')).toMatch(/<AdminShell title="Raporlar">/);
    for (const f of ['components/AppShell.tsx', 'pages/order/OrderPage.tsx', 'pages/FloorPage.tsx', 'pages/cash/CashPage.tsx']) expect(src(f), f).not.toContain('surface-corporate');
  });

  it('ortak kit köşeyi belirteçten okur (kapsül sabit değil)', () => {
    const button = src('components/ui/Button.tsx');
    expect(button.match(/rounded-\[var\(--r-btn\)\]/g)?.length).toBe(4);
    expect(button).not.toMatch(/rounded-full/);
    const field = src('components/ui/Field.tsx');
    expect(field).toContain('rounded-[var(--r-chip)] border px-3.5');
    expect(field).toContain("'rounded-[var(--r-segment)]'");
    const misc = src('components/ui/misc.tsx');
    expect(misc).toMatch(/whitespace-nowrap rounded-\[var\(--r-chip\)\] px-2\.5 py-0\.5/);
    const admin = src('components/admin/ui.tsx');
    expect(admin).toContain('justify-center rounded-[var(--r-btn)] ');
    expect(admin).toContain('bg-[var(--table-head-bg)]');
    expect(admin.match(/rounded-\[var\(--r-segment\)\]/g)?.length).toBeGreaterThanOrEqual(2);
    const charts = src('components/charts.tsx');
    expect(charts).toContain("getPropertyValue('--r-bar')");
    expect(charts).toContain('rounded-[var(--r-track)]');
  });

  it('kasa ekranının yönetimdeki birebir önizlemesi kasa köşelerinde (surface-soft = @theme köşeleri ve :root --r-*)', () => {
    const soft = block('.surface-soft');
    const theme = block('@theme');
    for (const k of ['radius-lg', 'radius-xl', 'radius-2xl', 'radius-3xl']) expect(soft[k], k).toBe(theme[k]);
    for (const k of ['r-card', 'r-control', 'r-btn', 'r-chip', 'r-segment', 'r-bar', 'r-track']) expect(soft[k], k).toBe(tokens[k]);
    // Kurumsalın bütün köşe değişkenleri geri alınır (gölgeye dokunulmaz: önizlenen ekranın kendi gölgesi var)
    for (const k of Object.keys(corporate).filter((k) => k.startsWith('radius-') || k.startsWith('r-'))) expect(soft, k).toHaveProperty(k);
    expect(src('components/display/CustomerDisplayView.tsx')).toMatch(/className=\{cn\('surface-soft relative h-full w-full/);
  });

  it('rapor tablosu ve roller matrisi kitin DataTable başlığıyla aynı: zemin --table-head-bg, başlık çizgisi', () => {
    const head = 'border-b border-[var(--admin-border)] bg-[var(--table-head-bg)]';
    expect(src('components/admin/ui.tsx')).toContain(`<tr className="${head}">`);
    expect(src('pages/reports/ReportsPage.tsx')).toContain(`<tr className="${head}">`);
    const roles = src('pages/admin/RolesAdmin.tsx');
    expect(roles).toContain(`<tr className="${head}">`);
    // Yapışkan ilk hücre opak: yatay kayan hücreler altından görünmez
    expect(roles).toContain('sticky left-0 z-[1] h-12 min-w-44 bg-[var(--admin-surface)]');
    expect(src('pages/reports/ReportsPage.tsx')).not.toContain('<tr className="bg-[var(--admin-surface-2)]">');
  });

  it('kenar çubuğu: etkin öğede dolgu kapsül yok, 2 px yeşil sol çizgi ve kalın yazı; gruplar arası ince ayraç', () => {
    const shell = src('components/admin/AdminShell.tsx');
    expect(shell).toContain("'relative font-semibold text-[var(--admin-text)] before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-[var(--admin-primary)]'");
    expect(shell).not.toContain("isActive ? 'bg-[var(--admin-panel)]");
    expect(shell).toContain("!narrow && gi > 0 && 'border-t border-[var(--admin-border)] pt-3'");
  });
});
