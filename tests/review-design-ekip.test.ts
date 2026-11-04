import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import type { TimeEntryDTO, TimeSheetDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Tasarım geçişinin incelemesi (4 Kas 2026): Yönetim › Mesai çizelgesi, Roller ve yetkiler, Yazarkasa. Sunucunun
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

describe('Mesai çizelgesi: Not sütunundaki yönetici', () => {
  it('sunucu kayda son dokunan yöneticiyi tutar: elle kaydı ikinci yönetici düzeltince kaydı girenin adı kalmaz', async () => {
    const day = addDays(businessDate(Date.now()), -3);
    const garson = h.boot.users.find((u) => u.name === 'Garson')!.id;
    const made = await h.ok<TimeEntryDTO>('mudur', 'POST', '/time/entries', { userId: garson, clockIn: at(day, 10), clockOut: at(day, 18) });
    expect(made).toMatchObject({ source: 'yonetim', editedByName: 'Müdür' });
    await h.ok('patron', 'PATCH', `/time/entries/${made.id}`, { note: 'Kamerayla doğrulandı' });
    const row = (await h.ok<TimeSheetDTO>('patron', 'GET', `/time?from=${day}&to=${day}`)).entries.find((e) => e.id === made.id);
    expect(row).toMatchObject({ source: 'yonetim', editedByName: 'Patron', note: 'Kamerayla doğrulandı' });
    // Kaydı Müdür girdi, Patron yalnız not ekledi: bunu denetim kaydı bilir, çizelgenin satırı bilmez
    const audits = await h.ok<{ action: string; userName: string | null; entityId: string | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    const mine = audits.filter((a) => a.entityId === made.id).map((a) => [a.action, a.userName]);
    expect(mine).toEqual(expect.arrayContaining([['time.create', 'Müdür'], ['time.edit', 'Patron']]));
  });

  it('ekran bu yüzden elle kayıtta da kaydı gireni adlandırmaz: her kaynakta "düzelten" (CSV’deki Düzelten sütunu gibi)', () => {
    const page = src('pages/admin/TimeAdmin.tsx');
    expect(page).not.toMatch(/kaydeden \$\{/);
    expect(page).toMatch(/const editorNote = \(e: TimeEntryDTO\) => e\.editedByName && `düzelten \$\{e\.editedByName\}`;/);
  });
});

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
    expect(src('lib/toast.tsx')).toMatch(/max-md:\[html:has\(\[data-action-bar\]\)_&\]:bottom-\[calc\(10\.5rem/);
  });

  it('başarı bildirimi taslak düştükten sonra: şerit kalkınca bildirim aşağı zıplamaz; hata şerit dururken hemen', () => {
    const save = page.slice(page.indexOf('const save = async'), page.indexOf('const header ='));
    const ok = save.indexOf('toast.ok(');
    expect(ok).toBeGreaterThan(save.indexOf('setDraft('));
    expect(ok).toBeGreaterThan(save.indexOf('setSaving(false)'));
    expect(save.indexOf('toast.err(')).toBeLessThan(save.indexOf('} finally {'));
  });
});
