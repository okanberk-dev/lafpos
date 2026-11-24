import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, type Permission, ROLE_DEFAULTS, ROLES } from '@shared/permissions';
import { answerParts, answerText, FAQ_GROUPS, type FaqContext, faqFor, type FaqItem } from '../src/lib/faq';

/**
 * Sık sorulan sorular (src/lib/faq.ts, /yardim): yanıtlar yalnız arayüzde gerçekten yazan düğme ve menü adlarını
 * söyler, rol gözetilir (maliyet ve kâr, kasa rakamları yalnız görebilene), liste kısa kalır.
 */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}
// Arayüzün metinleri: ekranlar ve ortak etiketler (rol, yetki, ciro dışı türleri); SSS'nin kendisi hariç
const UI = [...files('src'), ...files('shared')]
  .filter((f) => !f.endsWith(join('lib', 'faq.ts')))
  .map(read)
  .join('\n');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Ad arayüzde metin olarak yazıyor mu: tırnak içinde ('Günü aç', "Fiş yazıcısı", `Öde`) ya da JSX yazısı (>Günü aç<) */
const inUi = (label: string) => new RegExp(`(?:['"\`]|>\\s*)${esc(label)}(?:['"\`]|\\s*<)`).test(UI);

const ctx = (perms: Iterable<Permission>, opts: Partial<FaqContext> = {}): FaqContext => {
  const set = new Set(perms);
  return { can: (p) => set.has(p), tips: false, bar: true, ...opts };
};
// Çeşitler: her rolün varsayılanı, tek tek her yetki, her yetkinin eksik olduğu set; bahşiş ve bar açık / kapalı
const CONTEXTS: FaqContext[] = [
  ...ROLES.map((r) => ROLE_DEFAULTS[r]),
  ...ALL_PERMISSIONS.map((p) => [p]),
  ...ALL_PERMISSIONS.map((p) => ALL_PERMISSIONS.filter((x) => x !== p)),
].flatMap((perms) => [ctx(perms), ctx(perms, { tips: true }), ctx(perms, { bar: false })]);
const everyItem = (): FaqItem[] => CONTEXTS.flatMap(faqFor);

describe('Sık sorulan sorular: içerik', () => {
  it('yanıtların andığı her düğme ve menü adı arayüzde yazıyor', () => {
    // Önce bütün çeşitlerin adları toplanır (aynı ad yüzlerce kez geçer), her ad bir kez aranır
    const where = new Map<string, string>();
    for (const item of new Map(everyItem().map((i) => [`${i.id}:${i.answer}`, i])).values()) {
      for (const part of answerParts(item.answer)) if ('label' in part) for (const l of part.label) if (!where.has(l)) where.set(l, item.id);
    }
    const missing = [...where].filter(([l]) => !inUi(l)).map(([l, id]) => `${id}: ${l}`);
    expect(missing).toEqual([]);
  });
  it('soru sayısı 15-30, kimlikler tekil, her grup dolu', () => {
    const all = faqFor(ctx(ALL_PERMISSIONS, { tips: true }));
    const ids = new Set(everyItem().map((i) => i.id));
    expect(ids.size).toBeGreaterThanOrEqual(15);
    expect(ids.size).toBeLessThanOrEqual(30);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    for (const g of FAQ_GROUPS) expect(all.some((i) => i.group === g.key), g.key).toBe(true);
  });
  it('metin Türkçe kurala uyar: soru soru işaretiyle biter, yanıt noktayla; etiket kapanmamış kalmaz', () => {
    for (const item of everyItem()) {
      expect(item.question, item.id).toMatch(/\?$/);
      expect(item.answer.trim(), item.id).toMatch(/[.)]$/);
      expect(answerText(item.answer), item.id).not.toMatch(/\[\[|\]\]/);
    }
  });
  it('her rol kendi işinin sorularını görür (garson, bar, kasiyer, patron)', () => {
    const ids = (r: (typeof ROLES)[number]) => faqFor(ctx(ROLE_DEFAULTS[r])).map((i) => i.id);
    expect(ids('garson')).toEqual(expect.arrayContaining(['bara-gonder', 'iptal', 'indirim', 'internet', 'pin']));
    expect(ids('garson')).not.toContain('gun-sonu');
    expect(ids('mutfak')).toEqual(expect.arrayContaining(['bar-ekrani', 'tukendi']));
    expect(ids('kasiyer')).toEqual(expect.arrayContaining(['gun-ac', 'gun-sonu', 'vardiya', 'kasa-hareketi', 'hesap-bol', 'iade']));
    expect(ids('patron')).toEqual(expect.arrayContaining(['roller', 'maliyet', 'lafmaliyet', 'uzaktan']));
  });
});

describe('Sık sorulan sorular: rol gözetilir', () => {
  const cost = /(?<!laf)maliyet|kâr\b|kârı/i;
  it('maliyet ve kâr yalnız rapor.maliyet olana anlatılır', () => {
    for (const c of CONTEXTS.filter((x) => !x.can('rapor.maliyet'))) {
      for (const item of faqFor(c)) expect(`${item.question} ${answerText(item.answer)}`, item.id).not.toMatch(cost);
    }
    expect(faqFor(ctx(ALL_PERMISSIONS)).some((i) => cost.test(answerText(i.answer)))).toBe(true);
  });
  it('kör kasada kasa rakamları (ara rapor, beklenen nakit) anlatılmaz', () => {
    for (const c of CONTEXTS.filter((x) => !x.can('kasa.rakam'))) {
      for (const item of faqFor(c)) expect(`${item.question} ${answerText(item.answer)}`, item.id).not.toMatch(/beklenen|Ara rapor \(X\)/i);
    }
    const kor = faqFor(ctx(ROLE_DEFAULTS.kasiyer)).find((i) => i.id === 'kasa-rakam');
    expect(kor?.answer).toMatch(/kör kasa/);
  });
  it('yanıtta veri yok: tutar yazılmaz (yalnız sabit eşikler ve süreler)', () => {
    for (const item of everyItem()) expect(answerText(item.answer), item.id).not.toMatch(/₺\s?\d/);
  });
  it('bahşiş ve bar ayarına göre yanıt değişir; kapalı özellik anlatılmaz', () => {
    const tip = (tips: boolean) => faqFor(ctx(ALL_PERMISSIONS, { tips })).find((i) => i.id === 'bahsis')!.answer;
    expect(tip(false)).toMatch(/kapalı/);
    expect(tip(true)).toMatch(/Bahşiş ekle/);
    const bar = faqFor(ctx(ALL_PERMISSIONS, { bar: false }));
    expect(bar.find((i) => i.id === 'bar-ekrani')).toBeUndefined();
    expect(bar.find((i) => i.id === 'bara-gonder')!.answer).toMatch(/\[\[Kaydet\]\]/);
  });
});

describe('Sık sorulan sorular: ekran', () => {
  const page = () => read('src/pages/HelpPage.tsx');
  it('adres /yardim, oturum açan herkese; e2e taramasında', () => {
    expect(read('src/App.tsx')).toMatch(/path="\/yardim" element=\{<HelpPage \/>\}/);
    expect(read('e2e/run.mjs')).toContain("'/yardim'");
  });
  it('Araçlar çekmecesinden ve komut paletinden açılır', () => {
    expect(read('src/components/AppShell.tsx')).toMatch(/to="\/yardim"/);
    expect(read('src/components/CommandPalette.tsx')).toMatch(/go\('\/yardim'\)/);
  });
  it('soru düğmesi açılıp kapanır (aria-expanded), yanıt bölgesi soruyla adlanır; arama kutusu var; marka L’Af', () => {
    expect(page()).toMatch(/aria-expanded=\{open\}/);
    expect(page()).toMatch(/role="region"/);
    expect(page()).toMatch(/aria-labelledby=\{ids\.question\}/);
    expect(page()).toMatch(/<SearchInput /);
    expect(page()).toMatch(/LafTile/);
    // rare-ui'nin rengi ve logosu gelmez: belirteçler
    expect(page()).not.toMatch(/#FC4C01|RareMark|#F4F4F9/i);
    expect(page()).toMatch(/useReducedMotion\(\)/);
  });
});
