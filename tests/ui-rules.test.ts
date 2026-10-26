import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from '../src/components/admin/sections';
import { fold } from '../src/lib/shell';

/** Arayüzün kuralları: Türkçe büyük harf, mobil görüntü alanı, yönetim bölümü ile rota ve e2e taraması eşleşmesi */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(dir, e.name)] : []));
}

describe('sayfa kabuğu', () => {
  const html = read('index.html');
  it('Türkçe: tarayıcı büyük harfte i → İ yapsın', () => {
    expect(html).toMatch(/<html lang="tr">/);
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
  it('bölüm anahtarları ve adresleri tekil', () => {
    expect(new Set(ADMIN_SECTIONS.map((s) => s.key)).size).toBe(ADMIN_SECTIONS.length);
    expect(new Set(ADMIN_SECTIONS.map((s) => s.to)).size).toBe(ADMIN_SECTIONS.length);
  });
  it('Innex tarifi ve skill depoda', () => {
    expect(existsSync(join(root, 'docs/ADMIN-INNEX.md'))).toBe(true);
    expect(read('.claude/skills/build-admin-panel/SKILL.md')).toMatch(/docs\/ADMIN-INNEX\.md/);
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
