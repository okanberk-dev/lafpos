import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Tasarım geçişinin incelemesi (4 Kas 2026): Yönetim › Roller ve yetkiler, Yazarkasa. Sunucunun
 * kuralı süreç içi uygulamayla, ekranın kuralı kaynaktan denetlenir.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
/** İstanbul saatiyle an (UTC+3, yaz saati yok) */
const at = (date: string, hh: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - 3);
};

describe('Yazarkasa: Token denemesi ayar kaydını kilitlemez', () => {
  const page = src('pages/admin/OkcAdmin.tsx');
  const body = (start: string) => {
    const from = page.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    return page.slice(from, page.indexOf('\n  };', from));
  };

  it('deneme ve webhook kendi durumunda: bulut yanıt vermezken bağlantı, ödeme yeri ve eşleme kaydı yutulmaz', () => {
    for (const [start, key] of [
      ['const runTest = async', 'test'],
      ['const registerWebhook = async', 'webhook'],
    ]) {
      const fn = body(start);
      expect(fn).toContain(`setChecking('${key}')`);
      expect(fn).toContain('setChecking(null)');
      expect(fn).not.toMatch(/setSaving/);
    }
    expect(page).not.toMatch(/setBusy\(/);
    // Ayar kaydı yalnız başka bir ayar kaydı sürerken bekler
    expect(body('const saveMap = async')).toMatch(/^const saveMap = async \(\) => \{\s*if \(saving\) return;\s*setSaving\('map'\);/);
    expect(body('const setProvider = async')).toMatch(/if \(v === s\.provider \|\| saving\) return;/);
    expect(body('const setMode = async')).toMatch(/if \(v === s\.mode \|\| saving\) return;/);
  });

  it('ayar kaydedilirken kilit görünür: iki ray soluk ve dokunulmaz, Eşlemeyi kaydet kapalı', () => {
    expect(page).toMatch(/const locked = \(key: 'provider' \| 'mode'\) => \(\{ 'aria-busy': saving === key \|\| undefined, className: cn\('transition-opacity duration-150', saving && 'pointer-events-none opacity-60'\) \}\);/);
    expect(page).toMatch(/loading=\{saving === 'map'\} disabled=\{!!saving \|\| !mapDirty /);
    expect(page).toMatch(/loading=\{checking === 'test'\}/);
    expect(page).toMatch(/loading=\{checking === 'webhook'\}/);
  });
});

describe('Roller ve yetkiler: telefondaki kaydetme şeridi', () => {
  const page = src('pages/admin/RolesAdmin.tsx');

  it('yapışkan şerit eylem şeridi olarak işaretli: telefonda bildirim Vazgeç ve Kaydet’in üstünde durur', () => {
    expect(page).toMatch(/<div data-action-bar="" className="sticky bottom-0 /);
    // Şeridin boyunu yazmayan ekranda 4.5rem + 6rem (10.5rem); adisyon ekranı kendi bloğunu ölçüp --action-bar-h yazar
    // Kapanış hatırlatması varken onun boyu da eklenir (--closing-card-h; yoksa 0)
    expect(src('lib/toast.tsx')).toMatch(/max-md:\[html:has\(\[data-action-bar\]\)_&\]:bottom-\[calc\(4\.5rem\+var\(--closing-card-h,0px\)\+var\(--action-bar-h,6rem\)\+env\(safe-area-inset-bottom\)\)\]/);
  });

  it('başarı bildirimi taslak düştükten sonra: şerit kalkınca bildirim aşağı zıplamaz; hata şerit dururken hemen', () => {
    const save = page.slice(page.indexOf('const save = async'), page.indexOf('const header ='));
    const ok = save.indexOf('toast.ok(');
    expect(ok).toBeGreaterThan(save.indexOf('setDraft('));
    expect(ok).toBeGreaterThan(save.indexOf('setSaving(false)'));
    expect(save.indexOf('toast.err(')).toBeLessThan(save.indexOf('} finally {'));
  });
});
