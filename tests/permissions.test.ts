import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, effectivePermissions, LOCKED_ROLES, PERMISSION_GROUPS, ROLE_DEFAULTS, rolePermissions, ROLES } from '../shared/permissions';

/** Rol ve yetki modeli: gruplar eksiksiz, patron kilitli, rol matrisi ve kişiye özel yetki birlikte çalışır */
describe('yetki modeli', () => {
  it('her yetki tam bir grupta (rol ve personel ekranları eksiksiz)', () => {
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('patron rolü kilitli: matris ne derse desin her yetki', () => {
    expect(LOCKED_ROLES).toContain('patron');
    expect(rolePermissions('patron', { patron: [] })).toEqual(ALL_PERMISSIONS);
  });

  it('kasiyer kör sayar, kasadan tükendi işaretler; garson ödeme alamaz', () => {
    expect(ROLE_DEFAULTS.kasiyer).not.toContain('kasa.rakam');
    expect(ROLE_DEFAULTS.kasiyer).toEqual(expect.arrayContaining(['odeme.al', 'kasa.gun', 'urun.tukendi']));
    expect(ROLE_DEFAULTS.mutfak).toContain('urun.tukendi');
    expect(ROLE_DEFAULTS.garson).not.toContain('odeme.al');
    for (const role of ROLES.filter((r) => r !== 'patron' && r !== 'mudur')) expect(ROLE_DEFAULTS[role], role).not.toContain('rapor.maliyet');
  });

  it('rol matrisi varsayılanın yerine geçer; kişiye ek ve kaldırılan yetki üstüne uygulanır', () => {
    const matrix = { kasiyer: ['siparis.al', 'odeme.al', 'kasa.rakam'] as const };
    const set = effectivePermissions('kasiyer', { grant: ['rapor.gor'], revoke: ['odeme.al'] }, { kasiyer: [...matrix.kasiyer] });
    expect([...set].sort()).toEqual(['kasa.rakam', 'rapor.gor', 'siparis.al']);
    // Matriste olmayan rol varsayılanını kullanır; bilinmeyen yetki yok sayılır
    expect(effectivePermissions('garson', null, { kasiyer: [] })).toEqual(new Set(ROLE_DEFAULTS.garson));
    expect(rolePermissions('kasiyer', { kasiyer: ['siparis.al', 'yok.boyle' as never] })).toEqual(['siparis.al']);
  });
});
