import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTE_PERMS, ADMIN_SECTIONS } from '../src/components/admin/sections';
import { fold } from '../src/lib/shell';
import { bootDarkFor } from '../src/lib/bootDark';

/** Arayüzün kuralları: Türkçe büyük harf, mobil görüntü alanı, yönetim bölümü ile rota ve e2e taraması eşleşmesi */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(dir, e.name)] : []));
}

describe('sayfa kabuğu', () => {
  const html = read('index.html');
  it('Türkçe: tarayıcı büyük harfte i → İ yapsın', () => {
    expect(html).toMatch(/<html lang="tr"[ >]/);
  });
  it('tarayıcı çeviri önermez (müşteri ekranında Google Translate balonu çıkmasın)', () => {
    expect(html).toMatch(/<html [^>]*translate="no"/);
    expect(html).toMatch(/<meta name="google" content="notranslate" \/>/);
  });
  it('telefonda çentik alanı kullanılır, yakınlaştırma kapatılmaz', () => {
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
  });
  it('dokunmatikte alan yazısı 16 px (iOS odakta yakınlaştırmasın)', () => {
    expect(read('src/index.css')).toMatch(/@media \(pointer: coarse\)[\s\S]*font-size: max\(16px, 1em\)/);
  });
});

describe('kaynak taraması', () => {
  const sources = files('src').map((f) => ({ f, text: read(f) }));
  it('11 px altı yazı yok', () => {
    const bad = sources.filter(({ text }) => /text-\[(?:[0-9]|10)px\]/.test(text)).map(({ f }) => f);
    expect(bad).toEqual([]);
  });
  it('ikon düğmeleri adlandırılmış: IconButton label, ActionMenu label ister', () => {
    const bad = sources.filter(({ text }) => /<(IconButton|ActionMenu)\b(?![^>]*\blabel=)[^>]*>/.test(text)).map(({ f }) => f);
    expect(bad).toEqual([]);
  });

  /**
   * Ham Tailwind ölçekleri (brand-*, warn-*, danger-*, rose-*, success-*) koyu temada değişmez: koyu kartta AA altı
   * metin, okunmayan seçili satır ve pastel leke verir. Metin, rozet, uyarı kutusu ve kenar anlam adlarıyla yazılır
   * (text-danger-ink, bg-warning-soft, border-primary-line, `--admin-*`). Ham ölçek yalnız aşağıdaki bilinçli dolu
   * yüzeylerde kalır: beyaz yazılı dolu düğme ve rozet, gece mürekkebi zeminde ikon. Yeni kullanım test düşürür;
   * gerçekten gerekiyorsa gerekçesiyle buraya eklenir.
   */
  it('ham renk ölçeği yalnız izinli dolu yüzeylerde', () => {
    const ALLOWED: Record<string, { tokens: string[]; why: string }> = {
      'src/components/ui/Button.tsx': {
        tokens: ['bg-danger-600', 'hover:bg-danger-700', 'active:bg-danger-700', 'bg-success-600', 'hover:bg-success-700', 'active:bg-success-700', 'dark:bg-success-700', 'dark:enabled:hover:bg-success-600'],
        why: 'danger ve success dolu düğmeleri, beyaz yazı iki temada AA',
      },
      'src/pages/KitchenPage.tsx': { tokens: ['bg-danger-600'], why: 'bar ekranında alarm süre rozeti ve iptal edilen kalemin adedi, beyaz yazı' },
      'src/pages/FloorPage.tsx': { tokens: ['bg-success-600'], why: 'masa kartında hazır rozeti, beyaz yazı' },
      'src/lib/toast.tsx': {
        tokens: ['[&_.toast-ic]:bg-success-300', '[&_.toast-ic]:bg-danger-300', '[&_.toast-ic]:bg-warn-300'],
        why: 'bildirimin ikon karosu gece mürekkebi zeminde (iki temada koyu), üstünde mürekkep işaret; koyu temada dark: ile belirtece döner',
      },
    };
    const RAW = /(?:^|[\s'"`])((?:[^\s'"`]*:)?(?:text|bg|border|ring|outline|fill|stroke|divide|from|via|to|decoration|accent|caret|shadow|placeholder)-(?:brand|warn|danger|rose|success)-\d{2,3}(?:\/\d{1,3})?)(?=[\s'"`]|$)/gm;
    const bad: string[] = [];
    for (const { f, text } of sources) {
      if (!/\.tsx?$/.test(f)) continue;
      const file = f.split('\\').join('/');
      const allowed = ALLOWED[file]?.tokens ?? [];
      for (const m of text.matchAll(RAW)) if (!allowed.includes(m[1])) bad.push(`${file}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('yönetim paneli bölümleri', () => {
  const adminPage = read('src/pages/admin/AdminPage.tsx');
  const sweep = read('e2e/run.mjs');
  it('her bölümün bir sayfası var', () => {
    for (const s of ADMIN_SECTIONS.filter((x) => x.to.startsWith('/yonetim/'))) {
      expect(adminPage, s.key).toMatch(new RegExp(`['"]?${s.key}['"]?: <`));
    }
  });
  it('her bölüm e2e taramasında (telefon, tablet, bilgisayar, koyu)', () => {
    for (const s of ADMIN_SECTIONS) expect(sweep, s.to).toContain(`'${s.to}'`);
  });
  it('yönetim rotası her bölümün yetkisiyle açılır: patron paneli Denetim kaydına, raporcu Genel bakışa girer', () => {
    // Rota bir bölümün yetkisini geri çevirirse kenar çubuğundaki ve patron panelinin "Dikkat isteyenler"indeki
    // bağlantı kişiyi ana ekranına atar
    for (const s of ADMIN_SECTIONS.filter((x) => x.to.startsWith('/yonetim/'))) for (const p of s.perm) expect(ADMIN_ROUTE_PERMS, `${s.key}: ${p}`).toContain(p);
    expect(ADMIN_ROUTE_PERMS).toEqual(expect.arrayContaining(['patron.panel', 'rapor.gor']));
    expect(read('src/App.tsx')).toMatch(/path="\/yonetim\/\*" element=\{<Guard perm=\{ADMIN_ROUTE_PERMS\}>/);
  });
  it('bölüm anahtarları ve adresleri tekil', () => {
    expect(new Set(ADMIN_SECTIONS.map((s) => s.key)).size).toBe(ADMIN_SECTIONS.length);
    expect(new Set(ADMIN_SECTIONS.map((s) => s.to)).size).toBe(ADMIN_SECTIONS.length);
  });
  it('Innex tarifi ve skill depoda', () => {
    expect(existsSync(join(root, 'docs/ADMIN-INNEX.md'))).toBe(true);
    expect(read('.claude/skills/build-admin-panel/SKILL.md')).toMatch(/docs\/ADMIN-INNEX\.md/);
  });
});

describe('kasa ekranları e2e taramasında', () => {
  it('App.tsx’teki her sabit adres (Sık sorulan sorular dahil) e2e/run.mjs ROUTES’ta', () => {
    const sweep = read('e2e/run.mjs');
    const paths = [...read('src/App.tsx').matchAll(/<Route path="(\/[a-z-]+)(?:\/\*)?"/g)].map((m) => m[1]!);
    expect(paths).toContain('/yardim');
    for (const p of paths) expect(sweep, p).toContain(`'${p}'`);
  });
});

describe('ilk karede koyu açılan ekranlar (beyaz flaş olmasın)', () => {
  it('çağrı ekranı hep, müşteri ekranı ?tema=acik değilse, bar ekranı cihaz tercihi koyuysa', () => {
    expect(bootDarkFor('/cagri', '', 'koyu')).toBe(true);
    expect(bootDarkFor('/cagri/', '', 'acik')).toBe(true);
    expect(bootDarkFor('/musteri-ekrani', '?ekran=kasa', 'koyu')).toBe(true);
    expect(bootDarkFor('/musteri-ekrani', '?ekran=kasa&tema=acik', 'koyu')).toBe(false);
    // Bar ekranı cihazın tercihinde (kaydedilmemişse koyu; theme.ts readKdsTheme)
    expect(bootDarkFor('/mutfak', '', 'koyu')).toBe(true);
    expect(bootDarkFor('/mutfak', '', 'acik')).toBe(false);
    expect(bootDarkFor('/masalar', '', 'koyu')).toBe(false);
    expect(bootDarkFor('/', '', 'koyu')).toBe(false);
  });
});

describe('Türkçe arama (komut paleti, listeler)', () => {
  it('büyük-küçük harf ve aksan fark etmez', () => {
    expect(fold('Çilekli MATCHA')).toBe('cilekli matcha');
    expect(fold('İstasyon')).toBe('istasyon');
    expect(fold('ılık süt')).toBe('ilik sut');
    expect(fold('Şeker')).toBe('seker');
    expect(fold('Öğretmen')).toBe('ogretmen');
  });
});
