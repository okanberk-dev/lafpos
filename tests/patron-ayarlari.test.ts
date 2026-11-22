import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Mali ve defter sonucunu değiştiren ayarlar yalnız patronda (müdürde `ayar.yonet` varsayılan açık): şube kimliği,
 * ilk Z numarası, otomatik gün sonu, kurulum modu, yazarkasa sağlayıcısı ve modu. Her değişiklik eski → yeni değerle
 * önemli denetim kaydına düşer. Gerçek kullanım başladıktan sonra eğitim cihazına geçilmez; ayar zorla çekilse de
 * kapanan gün eğitim günü olmaz (lafmaliyet'e gider)
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

async function lastAudit(action: string) {
  const { db, schema } = await import('../server/db/client');
  return db.select().from(schema.auditLog).all().filter((a) => a.action === action).at(-1);
}

describe('Patron ayarları', () => {
  it('müdür şube kimliğini, ilk Z numarasını, otomatik gün sonunu ve kurulum modunu değiştiremez (403)', async () => {
    const { getSettings } = await import('../server/lib/settings');
    const s = getSettings();
    for (const patch of [{ branchId: 'tuzla' }, { zNoStart: 900 }, { autoDayEnd: !s.autoDayEnd }, { demoMode: !s.demoMode }]) {
      const r = await h.call<{ code: string }>('mudur', 'PUT', '/admin/settings', patch);
      expect(r.status, JSON.stringify(patch)).toBe(403);
      expect(r.json.code).toBe('patron_only');
    }
    expect(getSettings().branchId).toBe(s.branchId);
    // Aynı değeri yeniden göndermek değişiklik değil: bütün formu kaydeden müdür takılmaz
    await h.ok('mudur', 'PUT', '/admin/settings', { branchId: s.branchId, autoDayEnd: s.autoDayEnd, kitchenWarnMinutes: s.kitchenWarnMinutes });
  });

  it('patron değiştirir; eski → yeni değer önemli denetim kaydına düşer', async () => {
    const { getSettings } = await import('../server/lib/settings');
    const from = getSettings().branchId;
    await h.ok('patron', 'PUT', '/admin/settings', { branchId: 'marina-2', autoDayEnd: true });
    const a = await lastAudit('settings.branchId');
    expect(a).toMatchObject({ severity: 'uyari' });
    expect(a!.message).toContain(`${from} → marina-2`);
    expect((await lastAudit('settings.autoDayEnd'))!.message).toContain('kapalı → açık');
    await h.ok('patron', 'PUT', '/admin/settings', { branchId: from });
  });

  it('yazarkasa sağlayıcısı ve modu: müdür 403, patron değiştirir ve kayda düşer', async () => {
    const r = await h.call<{ code: string }>('mudur', 'PUT', '/okc/settings', { provider: 'pavo' });
    expect(r.status).toBe(403);
    // Sağlayıcı dışı ayar (bölüm eşlemesi) müdürde serbest
    await h.ok('mudur', 'PUT', '/okc/settings', { sectionMap: {} });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
    const a = await lastAudit('okc.settings');
    expect(a).toMatchObject({ severity: 'uyari' });
    expect(a!.message).toContain('→ pavo');
  });

  it('gerçek kullanım başladıktan sonra eğitim cihazına geçilmez; zorla çekilse de kapanan gün gerçek gündür', async () => {
    const { updateSettings } = await import('../server/lib/settings');
    const { db, schema } = await import('../server/db/client');
    updateSettings({ demoMode: false, liveSince: Date.now() });
    const r = await h.call<{ code: string }>('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('live');
    // Ayar başka yoldan eğitim cihazına çekilmiş olsa da gün eğitim günü sayılmaz
    updateSettings({ okcProvider: 'simulator' });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    const day = db.select().from(schema.businessDays).all().at(-1)!;
    expect(day.trainingDay).toBe(false);
  });
});
