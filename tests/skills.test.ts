import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Proje skill'leri (.claude/skills): Claude Code bunları ön bilgisinden (name, description) tanır. Dışarıdan
 * alınanların lisansı ve kaynağı yanında durur, her birinin başında "Bu projede" bölümü vardır (docs/SKILLS.md).
 */
const root = join(__dirname, '..');
const dir = join(root, '.claude/skills');
const skills = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(
    m[1]
      .split('\n')
      .map((l) => l.match(/^(\w[\w-]*):\s*(.*)$/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => [x[1], x[2].replace(/^"|"$/g, '')]),
  );
}

describe('proje skill\'leri', () => {
  it('beklenen skill\'ler var', () => {
    expect(skills.sort()).toEqual([
      'asilpos-design',
      'build-admin-panel',
      'impeccable',
      'restaurant-operations',
      'restaurant-pos',
      'validate-data',
      'verification-before-completion',
      'web-interface-guidelines',
      'webapp-testing',
    ]);
  });

  for (const name of skills) {
    const text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    it(`${name}: adı klasörüyle aynı, açıklaması var`, () => {
      expect(fm.name).toBe(name);
      expect((fm.description ?? '').length).toBeGreaterThan(40);
    });
    it(`${name}: kaynağı yazılı ve "Bu projede" bölümü var`, () => {
      expect(text).toMatch(/\*\*Kaynak:\*\*/);
      expect(text).toMatch(/Bu projede|AsilPOS'a uyarlandı/);
    });
  }

  it('dışarıdan alınanların lisansı yanında', () => {
    expect(existsSync(join(dir, 'impeccable/LICENSE'))).toBe(true);
    expect(existsSync(join(dir, 'impeccable/NOTICE.md'))).toBe(true);
    expect(existsSync(join(dir, 'webapp-testing/LICENSE.txt'))).toBe(true);
    expect(existsSync(join(dir, 'verification-before-completion/LICENSE'))).toBe(true);
    expect(existsSync(join(dir, 'validate-data/LICENSE'))).toBe(true);
    expect(existsSync(join(dir, 'web-interface-guidelines/LICENSE'))).toBe(true);
  });

  it('"Bu projede" bölümü alınan metinden önce gelir', () => {
    const upstream: Record<string, string> = {
      'validate-data': '# /validate-data - Validate Analysis Before Sharing',
      'web-interface-guidelines': '# Web Interface Guidelines',
      'verification-before-completion': '# Verification Before Completion',
      'webapp-testing': '# Web Application Testing',
    };
    for (const [name, heading] of Object.entries(upstream)) {
      const text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
      const ours = text.indexOf('## Bu projede');
      expect(ours, name).toBeGreaterThan(0);
      expect(text.indexOf(heading), name).toBeGreaterThan(ours);
    }
  });

  it('impeccable rehberlerinin bağlantıları kırık değil (alınan rehberler)', () => {
    const text = readFileSync(join(dir, 'impeccable/SKILL.md'), 'utf8');
    for (const ref of ['adapt', 'audit', 'polish', 'harden', 'layout', 'operate', 'craft-floor']) {
      expect(text).toContain(`reference/${ref}.md`);
      expect(existsSync(join(dir, `impeccable/reference/${ref}.md`)), ref).toBe(true);
    }
  });

  it('docs/SKILLS.md her skill\'i anlatır', () => {
    const doc = readFileSync(join(root, 'docs/SKILLS.md'), 'utf8');
    for (const name of skills) expect(doc, name).toContain(`\`${name}\``);
  });
});
