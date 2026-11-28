import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AppTheme, bootThemeFor, DISPLAY_CONFIG_KEY, KDS_THEME_PREF, resolveDark } from '../src/lib/bootDark';

/**
 * Açılış ekranı (28 Kasım 2026, sahibin isteği: "estetikleştir, hızlandır"): arayüzün betiği yüklenene dek index.html'in
 * #root'unda markalı ekran (zemin, AsilPOS simgesi, ad). Dış kaynak yok; React ilk çizimde yerini alır. Koyu temada ve
 * kendi temasında açılan ekranlarda (bar, çağrı, müşteri ekranı) uygulamanın ilk karesiyle aynı renkte: göz almaz.
 * Kasa programının Windows'taki açılış penceresi tests/masaustu-programi.test.ts'te
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  expect(i, a).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(b, i + a.length);
  expect(j, b).toBeGreaterThan(i);
  return s.slice(i, j);
};

describe('index.html açılış ekranı', () => {
  it('#root içinde markalı ekran: uygulama ikonu satır içi SVG ve AsilPOS; dış kaynak yok', () => {
    const root = between(html, '<div id="root">', '<script type="module"');
    expect(root).toContain('<div id="acilis" role="status" aria-label="AsilPOS açılıyor">');
    expect(root).toContain('<span>AsilPOS</span>');
    expect(root).toMatch(/<svg viewBox="0 0 512 512"[^>]* aria-hidden="true"/);
    // Simge uygulama ikonunun kendisi (public/favicon.svg): aynı yollar ve renkler
    const ikon = read('public/favicon.svg');
    const yollar = ikon.match(/ d="[^"]+"/g) ?? [];
    expect(yollar).toHaveLength(2);
    for (const d of yollar) expect(root).toContain(d);
    for (const c of ['#25896b', '#1c6a53', '#0d3f30', '#fbf6f1', '#e8c877']) expect(root).toContain(c);
    // Hiçbir şey dışarıdan yüklenmez: kaynak bağlantısı, yazı tipi ya da görsel yok
    expect(root).not.toMatch(/\s(src|href|xlink:href)=/);
    const style = between(html, '<style>', '</style>');
    expect(style).not.toMatch(/url\(|@import|@font-face/);
    const script = between(html, '<script>', '</script>');
    expect(script).not.toMatch(/fetch|import|src|XMLHttpRequest/);
    // Sayfanın ana betiği hâlâ tek modül betiği (sayfa denetimi ve Windows CI onu okur)
    const etiketler = html.toLowerCase().split('<script').slice(1).map((t) => t.slice(0, t.indexOf('>') + 1));
    expect(etiketler).toEqual(['>', ' type="module" src="/src/main.tsx">']);
  });

  it('zemin uygulamanın zemini (iki tema); simge ve ad kısa gecikmeyle belirir (hızlı açılışta titreme yok)', () => {
    const style = between(html, '<style>', '</style>');
    const keel = read('src/styles/keel.css');
    const canvas = [...keel.matchAll(/--k-canvas: (#\w+);/g)].map((m) => m[1]);
    expect(canvas).toEqual(['#eceef1', '#050302']);
    expect(between(style, '#acilis {', '}')).toContain(`background: ${canvas[0]};`);
    expect(between(style, "html[data-acilis='koyu'] #acilis {", '}')).toContain(`background: ${canvas[1]};`);
    // Betik karar veremezse cihazın teması
    expect(between(style, '@media (prefers-color-scheme: dark) {', '@media (prefers-reduced-motion')).toContain("html:not([data-acilis]) #acilis {");
    // Zemin hemen (koyu temada açık zemin parlamaz), içerik 150 ms sonra; hareket azaltmada süzülme yok
    expect(between(style, '#acilis > * {', '}')).toContain('animation: acilis-gel 0.24s ease-out 0.15s both;');
    expect(between(style, '#acilis {', '}')).not.toContain('animation');
    expect(between(style, '@media (prefers-reduced-motion: reduce) {', '@keyframes')).toContain('animation-duration: 1ms;');
    // Uzun tire yok (arayüz metni kuralı)
    expect(html).not.toMatch(/[–—]/);
  });

  it('React ilk çizimde yerini alır: createRoot kabın içini siler (hydrate değil); demo ve Uzaktan da önce çizer', () => {
    const main = read('src/main.tsx');
    expect(main).toContain("const root = createRoot(document.getElementById('root')!);");
    expect(main).not.toMatch(/hydrateRoot/);
    // Demo ve Uzaktan beklerken kendi yükleme ekranını çizer (açılış ekranı orada kalmaz)
    expect(main).toContain("root.render(<PageLoading label=\"AsilPOS demosu hazırlanıyor…\" delay={0} />);");
    expect(main).toContain('root.render(<PageLoading label="AsilPOS açılıyor…" />);');
  });

  it('koyu tema: açılış ekranının rengi uygulamanın ilk karesiyle aynı karar (theme.ts, bootDark.ts)', () => {
    const code = between(html, '<script>', '</script>').slice('<script>'.length);
    const run = (o: { path: string; search?: string; store?: Record<string, string>; sys?: boolean; storageFails?: boolean }) => {
      const attrs: Record<string, string> = {};
      const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
      const ls = {
        getItem: (k: string) => {
          if (o.storageFails) throw new Error('SecurityError');
          return o.store?.[k] ?? null;
        },
      };
      new Function('document', 'location', 'localStorage', 'matchMedia', code)(doc, { pathname: o.path, search: o.search ?? '' }, ls, () => ({ matches: !!o.sys }));
      return attrs['data-acilis'];
    };
    let n = 0;
    const paths = ['/', '/giris', '/masalar', '/kasa/', '/mutfak', '/mutfak/', '/cagri', '/musteri-ekrani', '/demo/', '/demo/musteri-ekrani', '/demo/mutfak', '/yonetim/musteri-ekrani'];
    for (const path of paths) {
      for (const search of ['', '?tema=acik', '?ekran=kasa&tema=acik', '?ekran=kasa']) {
        for (const theme of [null, 'acik', 'koyu', 'sistem', 'bozuk']) {
          for (const sys of [false, true]) {
            for (const kds of [null, 'acik', 'koyu']) {
              for (const display of [null, 'porselen', 'gece']) {
                const store: Record<string, string> = {};
                if (theme) store['asilpos.theme'] = theme;
                if (kds) store[`asilpos.pref.${KDS_THEME_PREF}`] = JSON.stringify(kds);
                if (display) store[DISPLAY_CONFIG_KEY] = JSON.stringify({ theme: display });
                // Uygulamanın kararı (main.tsx initTheme: yol demo öneki atılmış, theme.ts read, readKdsTheme, readDisplayTheme)
                const appPath = path.replace(/^\/demo(?=\/|$)/, '') || '/';
                const appTheme: AppTheme = theme === 'acik' || theme === 'koyu' || theme === 'sistem' ? theme : 'sistem';
                const force = bootThemeFor(appPath, search, kds === 'acik' ? 'acik' : 'koyu', display);
                const want = resolveDark(appTheme, force, sys) ? 'koyu' : 'acik';
                expect(run({ path, search, store, sys }), JSON.stringify({ path, search, theme, sys, kds, display })).toBe(want);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(2000);
    // Depolama açılmazsa (gizli pencere, engelli site verisi) karar cihazın temasıyla verilir, hata atılmaz
    expect(run({ path: '/', storageFails: true, sys: true })).toBe('koyu');
    expect(run({ path: '/', storageFails: true, sys: false })).toBe('acik');
    expect(run({ path: '/musteri-ekrani', storageFails: true })).toBe('koyu');
  });
});
