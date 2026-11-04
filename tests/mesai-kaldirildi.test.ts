import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from '../src/components/admin/sections';
import { ALL_PERMISSIONS, effectivePermissions, isPermission, rolePermissions } from '@shared/permissions';
import { type Harness, startApp } from './harness';

/**
 * Mesai kaldırıldı (4 Kasım 2026, operatör kararı): kilit ekranında Mesai sekmesi, kullanıcı menüsünde mesai satırı,
 * Yönetim › Mesai çizelgesi, patron panelindeki "Şu an mesaide" karosu ve `/api/time` uçları yok. Vardiya devri (kasa
 * sayımı) kalır. `time_entries` tablosu ve eski kayıtları silinmez (şemada not; göç üretilmez), eski denetim kayıtları
 * okunur kalır, kayıtlı rol ayarlarında ve kişinin yetkilerinde kalan `mesai.yonet` anahtarı yüklemeyi bozmaz.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const root = join(__dirname, '..');
function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx|mjs)$/.test(name) ? [rel] : [];
  });
}

describe('mesai kaldırıldı', () => {
  it('patron panelinin iskeleti dört karo ve sayfayla aynı ızgara kuralı: mesai karosu gitti, yüklenince kaymaz', () => {
    const page = readFileSync(join(root, 'src/pages/patron/PatronPage.tsx'), 'utf8');
    const skeleton = page.slice(page.indexOf('if (data.isPending)'), page.indexOf('// Rakamlar alınamadıysa'));
    expect(skeleton).toContain('<div className={topGrid(false)}>');
    expect(skeleton).toContain('<div className={tileGrid(false)}>');
    expect(skeleton).toContain('{[0, 1, 2, 3].map((i) => (');
    expect(skeleton).not.toContain('xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]');
    expect(page).toContain('<div className={topGrid(wideTiles)}>');
    expect(page).toContain('<div className={tileGrid(wideTiles)}>{tiles}</div>');
  });

  it('uçlar yok: oturumsuz basış oturum ister, oturumla çizelge ve giriş-çıkış 404', async () => {
    expect((await h.call('', 'POST', '/time/punch', { pin: '2222' })).status).toBe(401);
    for (const [method, path] of [
      ['GET', '/time'],
      ['GET', '/time/me'],
      ['POST', '/time/clock-in'],
      ['POST', '/time/clock-out'],
    ] as const) {
      expect((await h.call('patron', method, path)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('yetki, yönetim bölümü ve dosyalar yok', () => {
    expect(ALL_PERMISSIONS as string[]).not.toContain('mesai.yonet');
    expect(ADMIN_SECTIONS.map((s) => s.key)).not.toContain('mesai');
    for (const f of ['server/routes/time.ts', 'server/services/time.ts', 'src/pages/admin/TimeAdmin.tsx', 'src/components/MesaiRow.tsx', 'src/lib/mesai.ts', 'src/lib/mesaiDraft.ts']) {
      expect(existsSync(join(root, f)), f).toBe(false);
    }
  });

  it('kod tabloyu okumaz ya da yazmaz; tablo şemada not düşülerek durur (göç üretilmez)', () => {
    const users = [...walk('server'), ...walk('src'), ...walk('shared'), ...walk('demo')].filter((f) => f !== 'server/db/schema.ts' && /\btimeEntries\b|time_entries/.test(readFileSync(join(root, f), 'utf8')));
    expect(users).toEqual([]);
    const schema = readFileSync(join(root, 'server/db/schema.ts'), 'utf8');
    expect(schema).toMatch(/Mesai özelliği 4 Kasım 2026'da kaldırıldı/);
    expect(schema).toMatch(/export const timeEntries = sqliteTable\(\s*'time_entries'/);
  });

  it('eski mesai kayıtları veritabanında silinmeden kalır', async () => {
    const { db, schema } = await import('../server/db/client');
    const garson = h.boot.users.find((u) => u.name === 'Garson')!.id;
    db.insert(schema.timeEntries).values({ id: 'eski-mesai', userId: garson, clockIn: 1, clockOut: 2, businessDate: '2026-11-01', note: null, source: 'pin', editedBy: null, createdAt: 1 }).run();
    expect(db.select().from(schema.timeEntries).all().map((e) => e.id)).toContain('eski-mesai');
  });

  it('kayıtlı rol setinde kalan mesai.yonet düşer: roller listesi ve kişinin yetkileri bozulmaz', async () => {
    const { updateSettings } = await import('../server/lib/settings');
    updateSettings({ rolePermissions: { kasiyer: ['siparis.al', 'mesai.yonet' as never, 'odeme.al'] } });
    const roles = await h.ok<{ roles: { role: string; permissions: string[]; custom: boolean }[] }>('patron', 'GET', '/admin/roles');
    const kasiyer = roles.roles.find((r) => r.role === 'kasiyer')!;
    expect(kasiyer).toMatchObject({ custom: true, permissions: ['siparis.al', 'odeme.al'] });
    // Ekranın geri gönderdiği set kaydedilir
    await h.ok('patron', 'PUT', '/admin/roles/kasiyer', { permissions: kasiyer.permissions });
    // Kasiyer girer ve yetkileri hesaplanır
    await h.login('kasa', '1111');
    expect((await h.call('kasa', 'GET', '/bootstrap')).status).toBe(200);
    expect(rolePermissions('kasiyer', { kasiyer: ['mesai.yonet' as never, 'kasa.gun'] })).toEqual(['kasa.gun']);
    expect([...effectivePermissions('garson', { grant: ['mesai.yonet' as never], revoke: ['mesai.yonet' as never] })]).not.toContain('mesai.yonet');
    expect(isPermission('mesai.yonet')).toBe(false);
    expect(isPermission('toString')).toBe(false);
  });

  it('kişiye verilmiş mesai.yonet personel listesinde gelmez, kişi düzenlenir', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const garson = h.boot.users.find((u) => u.name === 'Garson')!.id;
    db.update(schema.users).set({ permGrant: ['mesai.yonet' as never, 'siparis.ikram'], permRevoke: ['mesai.yonet' as never] }).where(eq(schema.users.id, garson)).run();
    const list = await h.ok<{ id: string; permGrant: string[]; permRevoke: string[] }[]>('patron', 'GET', '/admin/users');
    const row = list.find((u) => u.id === garson)!;
    expect(row).toMatchObject({ permGrant: ['siparis.ikram'], permRevoke: [] });
    await h.ok('patron', 'PATCH', `/admin/users/${garson}`, { name: 'Garson', permGrant: row.permGrant, permRevoke: row.permRevoke });
    await h.login('garson', '2222');
    expect((await h.call('garson', 'GET', '/bootstrap')).status).toBe(200);
  });

  it('eski mesai denetim kayıtları listede okunur', async () => {
    const { db, schema } = await import('../server/db/client');
    const patron = h.boot.users.find((u) => u.name === 'Patron')!.id;
    db.insert(schema.auditLog).values({ at: Date.now(), userId: patron, action: 'time.edit', severity: 'uyari', message: 'Garson mesaisi düzeltildi', entity: 'time', entityId: 'eski-mesai' }).run();
    const audits = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=300');
    expect(audits.find((a) => a.action === 'time.edit')).toMatchObject({ message: 'Garson mesaisi düzeltildi' });
    const page = readFileSync(join(root, 'src/pages/admin/AuditAdmin.tsx'), 'utf8');
    expect(page).toMatch(/time: 'Mesai'/);
  });

  it('arayüzde mesai izi yok: kilit ekranı, kabuk, patron paneli, e2e', () => {
    for (const f of ['src/pages/LoginPage.tsx', 'src/components/AppShell.tsx', 'src/pages/patron/PatronPage.tsx', 'src/lib/live.ts', 'src/lib/nav.ts', 'e2e/run.mjs']) {
      expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/mesai|['"`]\/time\b|clockedIn|shiftForgotten/i);
    }
  });
});
