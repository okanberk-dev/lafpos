import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Renk değerlerinin erişilebilirliği (WCAG 2.2): okunan metin zeminde en az 4.5:1, alan kenarı ve odak halkası 3:1.
 * Değerler src/index.css'ten okunur. Kasa ekranları ve yönetim paneli aynı LafPOS Sahne değerlerini kullanır (gnbsite'ın
 * Area Board kiti, L'Affogato kimliğinde; açık `:root`, koyu `.dark`; DESIGN.md); ortak adlar (`--bg`, `--ink`...)
 * `--admin-*`'e bağlanır. Test düşerse değeri düzelt, eşiği gevşetme.
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

describe('kasa ekranları (LafPOS Sahne)', () => {
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

describe('yönetim paneli (LafPOS Sahne)', () => {
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
        // Sahne (gri ve sol sütun) de okunan metnin zemini: durum cümlesi, numaralı menü, büyük sayıların etiketi
        for (const ground of ['admin-bg', 'admin-stage', 'admin-surface', 'admin-surface-2', 'admin-panel']) expect(contrast(get(text), get(ground)), `${text}/${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: ana eylem (mürekkep hap) ve ok halkası seçilir`, () => {
      // Halka mürekkep düğmenin üstünde 3:1 (grafik nesne), halkadaki ok halkanın üstünde 3:1
      expect(contrast(get('ok-ring'), get('admin-ink-fill')), 'halka düğmede').toBeGreaterThanOrEqual(3);
      expect(contrast(get('ok-arrow'), get('ok-ring')), 'ok halkada').toBeGreaterThanOrEqual(3);
      // Zamanı daralan (bordo): yumuşak zemininde ve sahnede okunur
      expect(contrast(get('admin-signal'), get('admin-signal-soft')), 'bordo yumuşak zeminde').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-signal'), get('admin-stage')), 'bordo sahnede').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-signal'), get('admin-surface')), 'bordo yaprakta').toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: birincil (ev yeşili) hem düğmede hem bağlantıda`, () => {
      expect(contrast(get('admin-on-primary'), get('admin-primary')), 'düğme yazısı').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-surface')), 'bağlantı kartta').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-bg')), 'bağlantı porselen zeminde').toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('admin-primary'), get('admin-stage')), 'bağlantı sahnede').toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: her durum tonu ve grup rengi kendi açık zemininde AA`, () => {
      for (const [fg, bg] of tones) expect(contrast(get(`admin-${fg}`), get(`admin-${bg}`)), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: boş alanın kenarı kartta bulunur (3:1)`, () => {
      expect(contrast(get('admin-border-field'), get('admin-surface'))).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: odak halkası (ev yeşili) kartta ve zeminde seçilir (3:1)`, () => {
      for (const ground of ['admin-surface', 'admin-bg', 'admin-stage', 'admin-surface-2', 'admin-panel']) expect(contrast(get('focus'), get(ground)), ground).toBeGreaterThanOrEqual(3);
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

  it('kasa ekranları da pano (20 Kas 2026): tek açık gri zemin, yeşilimsi mürekkep, ev yeşili', () => {
    expect(posLight('bg')).toBe('#f1f4f2');
    expect(posLight('primary')).toBe('#0a6e52');
    expect(posLight('ink')).toBe('#0f1513');
    expect(posDark('primary')).toBe('#34d399');
  });

  it('pano paleti (DESIGN.md §2 tablosu; 20 Kas 2026): tek zemin, beyaz kart, ev yeşili eylem, canlı durum renkleri', () => {
    // Üst çubuk ve sahne tek zeminde (panonun gri zemini, hafif yeşil); kartlar beyaz
    expect(adminLight('admin-bg')).toBe('#f1f4f2');
    expect(adminLight('admin-stage')).toBe(adminLight('admin-bg'));
    expect(adminLight('admin-surface')).toBe('#ffffff');
    expect(adminLight('admin-surface-2')).toBe('#f7f9f8');
    expect(adminLight('admin-panel')).toBe('#edf1ee');
    expect(adminLight('admin-primary')).toBe('#0a6e52');
    expect(adminLight('admin-primary-hover')).toBe('#075a43');
    expect(adminLight('admin-text')).toBe('#0f1513');
    expect(adminLight('admin-text-soft')).toBe('#3f4a45');
    expect(adminLight('admin-text-mute')).toBe('#58635e');
    // Eylem ve seçim dolgusu markanın rengi (panonun mavisinin yerine ev yeşili); halka açık nane
    expect(adminLight('admin-ink-fill')).toBe(adminLight('admin-primary'));
    expect(adminLight('ok-ring')).toBe('#d8f6e8');
    expect(posDark('admin-ink-fill')).toBe('#0a8560');
    // Marka rayı ev yeşilinin degradesi
    expect(css).toMatch(/--rail-bg:\s*linear-gradient\(180deg, #0b6449/);
    // Zamanı daralan: canlı ahududu (kitin magentası)
    expect(adminLight('admin-signal')).toBe('#c8175d');
    // Dolu masa L'Affogato yeşilinin degradesi
    expect(css).toMatch(/--table-busy:\s*linear-gradient\(155deg, #0e7a5a/);
    // Alanın kenarı panoda bir ton yumuşak, kartta yine 3:1'in üstünde (3.3:1)
    expect(adminLight('admin-border-field')).toBe('#868f8a');
    expect(adminLight('admin-blue')).toBe('#2459e0');
    expect(adminLight('admin-gold-fill')).toBe('#f2c94c');
    expect(adminLight('admin-bordo')).toBe('#9d2543');
    // Uygulama ikonunun ve sitenin altbilgisinin yeşili
    expect(css).toMatch(/--brand-tile:\s*radial-gradient\([^;]*#23876a[^;]*#1d6d56[^;]*#0c3b2d/);
  });

  it('yazı: panodaki gibi Inter (değişken ağırlık ve optik boy), pakette; dış kaynaktan yazı yok (operatör, 20 Kas 2026)', () => {
    expect(css).toMatch(/--font-sans:\s*'Inter',/);
    expect(css).toMatch(/--font-headline:\s*'Inter',/);
    expect(css).toContain('@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2');
    // Türkçe harfler (ğ, ş, İ) ve ₺ (U+20BA) latin-ext dosyasında
    const ext = css.slice(css.indexOf('@fontsource-variable/inter/files/inter-latin-ext-opsz-normal.woff2'));
    expect(ext.slice(0, ext.indexOf('}'))).toMatch(/U\+0100-02BA[\s\S]*U\+20AD-20C0/);
    expect(css).toMatch(/h1,\s*h2,\s*h3 \{[^}]*font-family: var\(--font-headline\)/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@fontsource\/poppins|@fontsource-variable\/gabarito/i);
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@fontsource-variable/inter']).toBeTruthy();
    expect(Object.keys(pkg.dependencies).filter((d) => /poppins|gabarito/.test(d))).toEqual([]);
  });

  const src = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('mürekkep zeminli bildirimde odak halkası krem (yeşil halka mürekkepte 3:1 altında)', () => {
    expect(contrast(adminLight('admin-primary'), adminLight('admin-ink-fill')), 'yeşil halka mürekkepte zayıf').toBeLessThan(3);
    expect(contrast(adminLight('admin-on-ink'), '#111816'), 'açık halka mürekkepte').toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/--color-night:\s*#111816;/);
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
 * Köşe ve gölge belirteçleri (DESIGN.md §2 "Biçim"; gnbsite Area Board kitinin yarıçap merdiveni): kasa ve yönetim aynı
 * sahne dilinde (sahne 28, yaprak 24, cam çubuk 22, kart 18, alan 12; düğme, çip, rozet ve segment hap). Ortak kit köşeyi
 * belirteçten okur; sayfaların rounded-xl / rounded-2xl'si Tailwind'in köşe değişkeniyle aynı merdivene uyar. Gölge yalnız
 * açılan ve yüzen parçada (kart çok hafif, sıcak toprak).
 */
describe('köşe ve gölge belirteçleri, sahne', () => {
  const src = (f: string) => readFileSync(join(__dirname, '../src', f), 'utf8');
  const tokens = (() => {
    const at = css.indexOf(':root {\n  --r-card:');
    if (at < 0) throw new Error('index.css: köşe belirteçleri yok');
    const body = css.slice(at, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  })();

  it('panonun merdiveni bir boy sıkı (operatör 20 Kas 2026: "radiusu biraz azalt"): ray 22, yaprak, kart ve cam 18, karo 12, alan ve düğme 10, rozet 6; segment hap, sütun 6', () => {
    expect(tokens).toMatchObject({
      'r-stage': '1.375rem',
      'r-leaf': '1.125rem',
      'r-glass': '1.125rem',
      'r-card': '1.125rem',
      'r-control': '0.625rem',
      'r-btn': '0.625rem',
      'r-chip': '0.375rem',
      'r-segment': '9999px',
      'r-bar': '6px',
      'r-track': '9999px',
      'r-tile': '0.75rem',
    });
    expect(block('@theme')).toMatchObject({ 'radius-lg': '0.5rem', 'radius-xl': '0.625rem', 'radius-2xl': '0.875rem', 'radius-3xl': '1.125rem' });
    // Zeminde yüzen kartın yumuşak gölgesi: ev yeşilinin gecesi
    expect(block('@theme')['shadow-card']).toMatch(/rgb\(15 35 28/);
  });

  it('kurumsal yüzey yok: yönetim ve raporlar kasayla aynı sahnede (Stage), köşeler küçülmez', () => {
    expect(css).not.toContain('.surface-corporate');
    expect(src('components/admin/AdminShell.tsx')).not.toContain('surface-corporate');
    expect(src('components/admin/AdminShell.tsx')).toMatch(/<Stage\b/);
    expect(src('pages/reports/ReportsPage.tsx')).toMatch(/<AdminShell title="Raporlar">/);
    for (const f of ['pages/FloorPage.tsx', 'pages/patron/PatronPage.tsx', 'pages/cash/CashPage.tsx', 'pages/OrdersPage.tsx']) expect(src(f), f).toMatch(/<Stage\b/);
  });

  it('ortak kit köşeyi belirteçten okur (kapsül sabit değil)', () => {
    const button = src('components/ui/Button.tsx');
    expect(button.match(/rounded-\[var\(--r-btn\)\]/g)?.length).toBe(4);
    expect(button).not.toMatch(/rounded-full/);
    const field = src('components/ui/Field.tsx');
    // Seçim çipi düğmeyle aynı köşede (pano: 12)
    expect(field).toContain('rounded-[var(--r-btn)] border px-3.5');
    expect(field).toContain("'rounded-[var(--r-segment)]'");
    const misc = src('components/ui/misc.tsx');
    expect(misc).toMatch(/whitespace-nowrap rounded-\[var\(--r-chip\)\] px-2 py-0\.5/);
    const admin = src('components/admin/ui.tsx');
    expect(admin).toContain('justify-center rounded-[var(--r-btn)] ');
    expect(admin).toContain('bg-[var(--table-head-bg)]');
    expect(admin.match(/rounded-\[var\(--r-segment\)\]/g)?.length).toBeGreaterThanOrEqual(2);
    const charts = src('components/charts.tsx');
    expect(charts).toContain("getPropertyValue('--r-bar')");
    expect(charts).toContain('rounded-[var(--r-track)]');
  });

  it('ana eylem kitin düğmesi: mürekkep hap ve sağında ok halkası (primary ve ink), kare ikon düğmesinde halka yok', () => {
    const button = src('components/ui/Button.tsx');
    expect(button).toMatch(/const RING: ButtonVariant\[\] = \['primary', 'ink'\];/);
    expect(button).toMatch(/primary: INK,\s*ink: INK,/);
    expect(button).toContain('<span aria-hidden="true" className="lp-ring">');
    expect(button).toMatch(/ring=\{false\} className=\{cn\(squares\[size\], className\)\}/);
    expect(css).toMatch(/\.lp-ring \{[^}]*background: var\(--ok-ring\);/);
  });

  it('kasa ekranının yönetimdeki birebir önizlemesi kasa köşelerinde (surface-soft = @theme köşeleri ve :root --r-*)', () => {
    const soft = block('.surface-soft');
    const theme = block('@theme');
    for (const k of ['radius-lg', 'radius-xl', 'radius-2xl', 'radius-3xl']) expect(soft[k], k).toBe(theme[k]);
    for (const k of ['r-card', 'r-control', 'r-btn', 'r-chip', 'r-segment', 'r-bar', 'r-track']) expect(soft[k], k).toBe(tokens[k]);
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

  it('yan menü shadcn düzeninde sade: grup başlığı, ikonlu satır, seçili satır açık nane zeminde; numara yok (operatör, 17-18 Kas 2026)', () => {
    const shell = src('components/admin/AdminShell.tsx');
    expect(shell).toContain('<div className="lp-menu lp-menu-col">');
    expect(shell).toContain('<span className="lp-menu-label">{g.label}</span>');
    expect(shell).toMatch(/\{icon && <sec\.icon aria-hidden="true" \/>\}/);
    // Sol sütun yalnız gezinme; başlık, açıklama ve eylemler yaprağın başında
    expect(shell).toMatch(/<Stage\s+\/\/[^\n]*\n[^<]*headerInLeaf/);
    expect(shell).toMatch(/<div ref=\{strip\} className=\{cn\('lp-menu', RAIL_FADE\)\}>/);
    expect(css).not.toMatch(/counter\(/);
    const selected = css.slice(css.indexOf("  .lp-menu-item:is([aria-current='page']"));
    const rule = selected.slice(0, selected.indexOf('}'));
    expect(rule).toMatch(/background: var\(--menu-active-bg\);\s*color: var\(--menu-active-ink\);\s*font-weight: 600;/);
    expect(rule).not.toMatch(/gradient|box-shadow/);
  });

  it('adisyonun kategorileri yönetimin alt menüsüyle tek bileşen; yerleşim ve ızgara belirteçlerle (operatör, 20 Kas 2026)', () => {
    // "espresso based vs. kısmı da ekteki gibi olabilir, componentleri bir yap farklı olmasın; layoutları gridleri de belirle"
    const panel = src('pages/order/ProductPanel.tsx');
    expect(panel).toContain('<nav aria-label="Menü" className="lp-subnav hidden w-[var(--side-w)] shrink-0 xl:block">');
    expect(panel).toContain('<div className="lp-menu lp-menu-col">');
    expect(panel).toContain('<span className="lp-menu-label">Kategoriler</span>');
    expect(panel).toMatch(/role="tab" aria-selected=\{active\} onClick=\{onClick\} className=\{cn\('lp-menu-item/);
    expect(panel).not.toMatch(/CategoryBadge|CategoryRow|CategoryChip|lp-catalog/);
    // Yönetimin alt menüsü aynı kart; ızgara aynı genişliği okur
    expect(src('components/ui/Stage.tsx')).toContain('<aside className="lp-side lp-subnav max-md:hidden">');
    expect(css).toMatch(/grid-template-columns: var\(--side-w\) minmax\(0, 1fr\);/);
    expect(css).not.toMatch(/\.lp-catalog/);
    for (const token of ['--shell-gap: 12px;', '--grid-gap: 16px;', '--tile-gap: 12px;', '--side-w: 15rem;', '--aside-w: 19.5rem;']) {
      expect(css).toContain(token);
    }
    // Kart ızgaraları sabit: ürün ve masa karo ızgarasında, sipariş kartları kart ızgarasında; hesap ve iskelet belirteçle
    expect(panel).toContain("'lp-enter lp-tiles scroll-thin");
    expect(src('pages/FloorPage.tsx')).toContain('className="lp-enter lp-tiles [--tile-min:9.375rem]"');
    expect(src('pages/OrdersPage.tsx')).toContain('className="lp-cards animate-fade"');
    expect(src('pages/order/OrderPage.tsx')).toContain("editable ? 'w-[var(--cart-w)]'");
    expect(src('components/AppShell.tsx')).toContain('md:gap-[var(--shell-gap)] md:p-[var(--shell-gap)]');
  });

  it('marka rayı (pano, operatör 20 Kas 2026: "menüsüne kadar 1:1"): ev yeşili degrade, ikon üstte kısa ad altta, seçili beyaz karo', () => {
    const shell = src('components/AppShell.tsx');
    expect(shell).toContain('<nav aria-label="Ekranlar" className="lp-rail">');
    expect(shell).toMatch(/className="lp-rail-item">\s*<span aria-hidden="true" className="lp-rail-icon">\s*<n\.icon \/>/);
    expect(shell).toContain('<span className="lp-rail-label">{n.label}</span>');
    // Menüde olmayan ekranın yeri de seçili görünür (adisyonun geldiği ekran, Eğitim cihazında Kasa)
    expect(shell).toContain('data-on={on(n.to, isAt(n.to)) || undefined}');
    const rail = css.slice(css.indexOf('    .lp-rail {\n      display: flex;'));
    expect(rail.slice(0, rail.indexOf('}'))).toMatch(/background: var\(--rail-bg\);/);
    const on = css.slice(css.indexOf(".lp-rail-item:is([aria-current='page'], [data-on]) {"));
    expect(on.slice(0, on.indexOf('}'))).toMatch(/background: var\(--rail-active-bg\);\s*color: var\(--rail-active-ink\);/);
    for (const [name, get] of [
      ['açık', posLight],
      ['koyu', posDark],
    ] as const) {
      // Rayın yazısı degradenin en açık durağında da okunur
      for (const t of ['rail-text', 'rail-soft', 'rail-mute']) expect(contrast(get(t), get('rail')), `${name} ${t}/ray`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('rail-active-ink'), get('rail-active-bg')), `${name} seçili karo`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('menu-active-ink'), get('menu-active-bg')), `${name} seçili sekme`).toBeGreaterThanOrEqual(4.5);
      // Sekme şeridi ve başlık satırı zeminde: soluk yazı ve sayı da okunur
      for (const text of ['admin-text-soft', 'admin-text-mute']) expect(contrast(get(text), get('admin-stage')), `${name} ${text}/zemin`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('üst çubuk (pano): ortada ekranın sekmeleri, sağda durum, arama ve kişi; Araçlar ana eylemle yarışmaz', () => {
    const shell = src('components/AppShell.tsx');
    expect(shell).toContain('<div ref={setTabsSlot} className="lp-topnav');
    expect(shell).toContain('<TopTabsSlot.Provider value={tabsSlot}>');
    expect(src('components/ui/Stage.tsx')).toContain('{menuOnTop ? createPortal(menuNode, topTabs) : menuNode}');
    // Araçlar ve kişinin düğmesi: ana eylemin mürekkebi ve ok halkası yok
    expect(shell).not.toMatch(/<Ring \/>|buttonClass\('primary'/);
    // Telefonun alt sekmesi de açık nane hapta
    expect(shell).toContain("on ? 'bg-[var(--menu-active-bg)] font-semibold text-[var(--menu-active-ink)]'");
    // Sekmenin seçimi açık nane zeminde yeşil, kalın; renk geçişi ve gölge yok
    const selected = css.slice(css.indexOf("  .lp-menu-item:is([aria-current='page']"));
    const rule = selected.slice(0, selected.indexOf('}'));
    expect(rule).toMatch(/background: var\(--menu-active-bg\);\s*color: var\(--menu-active-ink\);\s*font-weight: 600;/);
    expect(rule).not.toMatch(/gradient|box-shadow/);
  });

  it('dev büyük harfli ad yok: ekranın başlığı ölçülü, büyük harf dönüşümü yok (operatör, 17 Kas 2026)', () => {
    const name = css.slice(css.indexOf('  .lp-name {'), css.indexOf('}', css.indexOf('  .lp-name {')));
    expect(name).not.toMatch(/text-transform/);
    expect(name).toMatch(/font: 700 1\.375rem\/1\.1 var\(--font-headline\);/);
    for (const f of ['components/ui/Stage.tsx', 'components/ui/misc.tsx', 'components/admin/ui.tsx', 'components/ToolsDrawer.tsx', 'pages/FloorPage.tsx', 'pages/order/OrderPage.tsx']) expect(src(f), f).not.toMatch(/\buppercase\b/);
  });
});
