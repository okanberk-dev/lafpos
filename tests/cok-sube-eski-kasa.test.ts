import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isletmeVeSube, subeAdiOf } from '@shared/sube';
import { type Harness, startApp } from './harness';

/**
 * Çok şubeli kasa (docs/03-ENTEGRASYON.md §4c): eski kasalar `marina` ile sürer (geçmişi olan ama şube satırı olmayan
 * kasa çok şubeli sürümdeki ilk açılışında `marina`'yı kalıcı yazar, veritabanı başına bir kez; yeni kasa deneme gününden ve
 * gerçek kullanımdan sonra da şubesiz kalır), bildirim ve gün sonu başlığı şubenin adını taşır,
 * başka şubenin bulut yedeği şubesi belli kasaya yüklenmez, Merkez kapalıyken ikinci şubenin kasası uyarılır ve ladmin
 * kurulumu şubeyi verince eski şubenin önbellekleri bırakılır.
 */

const CLOUD_SECRET = 'c'.repeat(48);
let h: Harness;

beforeAll(async () => {
  // Uzaktan "kurulu" (bağlantı reddedilen yerel adres: istek hemen düşer), Merkez kapalı
  h = await startApp({ ASILPOS_CLOUD_URL: 'http://127.0.0.1:9', ASILPOS_CLOUD_SECRET: CLOUD_SECRET, ASILPOS_MERKEZ_URL: '0' }, { branch: null });
});
afterAll(() => h.cleanup());

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const sube = await import('../server/lib/sube');
  const branchRow = () => db.select().from(schema.settings).where(eq(schema.settings.key, 'branchId')).get() ?? null;
  return { db, schema, eq, settings, sube, branchRow };
}

describe('eski kasa marina ile sürer, yeni kasa şubesiz', () => {
  /** Çok şubeli sürümden önceki veritabanı: eski kasa denetiminin işareti yok (yükseltilen kasa, geri yüklenen eski yedek) */
  async function eskiSurumVeritabani() {
    const { db, schema, eq, sube } = await mod();
    db.delete(schema.syncState).where(eq(schema.syncState.key, sube.ESKI_KASA_DENETIMI)).run();
  }

  it('geçmişi olmayan yeni kasa şubesiz kalır; denetim işaretlenir', async () => {
    const { sube, branchRow, settings } = await mod();
    expect(sube.eskiKasaSubesiniYaz()).toBe(false);
    expect(branchRow()).toBeNull();
    expect(settings.getSettings().branchId).toBeNull();
    expect(sube.kasaSubesi()).toBeNull();
    expect(sube.subeAdi()).toBeNull();
    expect(settings.getSyncState(sube.ESKI_KASA_DENETIMI)).toMatchObject({ yazildi: false });
  });

  it('gerçek kullanım işareti olan eski kasa marina yazar (bir kez, denetime düşer)', async () => {
    const { sube, branchRow, settings } = await mod();
    await eskiSurumVeritabani();
    settings.updateSettings({ liveSince: Date.now() - 86400_000 });
    expect(sube.eskiKasaSubesiniYaz()).toBe(true);
    expect(branchRow()?.value).toBe('marina');
    expect(settings.getSettings().branchId).toBe('marina');
    expect(settings.getSyncState(sube.ESKI_KASA_DENETIMI)).toMatchObject({ yazildi: true });
    expect(sube.eskiKasaSubesiniYaz()).toBe(false);
    const audit = await h.ok<{ action: string; message: string; data: Record<string, unknown> | null }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=50');
    const row = audit.find((a) => a.action === 'settings.branchId')!;
    expect(row.message).toMatch(/eski varsayılandan kalıcı yazıldı: marina/);
    expect(row.data).toMatchObject({ from: null, to: 'marina' });
    settings.updateSettings({ liveSince: null, branchId: null });
    expect(branchRow()).toBeNull();
  });

  it('lafmaliyet’in kabul ettiği günü olan eski kasa da marina yazar', async () => {
    const { sube, settings, db, schema, eq } = await mod();
    await eskiSurumVeritabani();
    settings.setSyncState('lafmaliyet.push', { acceptedBranch: 'marina', lastSuccessAt: Date.now() });
    expect(sube.eskiKasaSubesiniYaz()).toBe(true);
    settings.updateSettings({ branchId: null });
    db.delete(schema.syncState).where(eq(schema.syncState.key, 'lafmaliyet.push')).run();
    expect(sube.kasaGecmisiVar()).toBe(false);
  });

  it('yeni kasa sonraki açılışlarda marina olmaz: deneme günü ve gerçek kullanım şubeyi vermez', async () => {
    const { sube, branchRow, settings } = await mod();
    // İlk açılış (veritabanı boşken) denetimi yaptı
    expect(settings.getSyncState(sube.ESKI_KASA_DENETIMI)).not.toBeNull();
    expect(sube.kasaGecmisiVar()).toBe(false);
    // Deneme modunda gün açılıp kapandı (eğitim günü), sonra yeniden açılış (bağlantılar yazıldı, güncelleme, elektrik)
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(sube.kasaGecmisiVar()).toBe(true);
    expect(sube.eskiKasaSubesiniYaz()).toBe(false);
    expect(branchRow()).toBeNull();
    // Deneme bitti (gerçek kullanım), yine yeniden açılış
    settings.updateSettings({ liveSince: Date.now() });
    expect(sube.eskiKasaSubesiniYaz()).toBe(false);
    expect(sube.kasaSubesi()).toBeNull();
    settings.updateSettings({ liveSince: null });
  });

  it('iş günü (eğitim günü dahil) olan eski kasa marina yazar', async () => {
    const { sube, branchRow } = await mod();
    await eskiSurumVeritabani();
    expect(sube.kasaGecmisiVar()).toBe(true);
    expect(sube.eskiKasaSubesiniYaz()).toBe(true);
    expect(branchRow()?.value).toBe('marina');
  });

  it('şube satırı olan kasaya dokunulmaz', async () => {
    const { sube, settings } = await mod();
    await eskiSurumVeritabani();
    settings.updateSettings({ branchId: 'tuzla' });
    expect(sube.eskiKasaSubesiniYaz()).toBe(false);
    expect(settings.getSettings().branchId).toBe('tuzla');
    expect(settings.getSyncState(sube.ESKI_KASA_DENETIMI)).toMatchObject({ yazildi: false });
  });

  it('açılışta göçlerden hemen sonra, kurulum verisinden önce çalışır (sunucu ve tarayıcı demosu)', () => {
    const index = readFileSync(join(__dirname, '../server/index.ts'), 'utf8');
    expect(index.indexOf('eskiKasaSubesiniYaz()')).toBeGreaterThan(index.indexOf('runMigrations();'));
    expect(index.indexOf('eskiKasaSubesiniYaz()')).toBeLessThan(index.indexOf('seedIfEmpty()'));
    expect(readFileSync(join(__dirname, '../demo/runtime.ts'), 'utf8')).toMatch(/eskiKasaSubesiniYaz\(\)/);
  });
});

describe('şubenin adı: bildirim ve gün sonu başlığı', () => {
  it('kimlikten okunur ad; işletme adına eklenir, zaten içeriyorsa eklenmez', () => {
    expect(subeAdiOf('marina')).toBe('Marina');
    expect(subeAdiOf('tuzla-2')).toBe('Tuzla 2');
    expect(subeAdiOf(null)).toBeNull();
    expect(isletmeVeSube("L'Affogato", 'Marina')).toBe("L'Affogato Marina");
    expect(isletmeVeSube("L'Affogato Marina", 'marina')).toBe("L'Affogato Marina");
    expect(isletmeVeSube("L'Affogato", null)).toBe("L'Affogato");
    expect(isletmeVeSube('', 'Tuzla')).toBe('Tuzla');
  });

  it('ladmin kurulumunun verdiği ad geçer; bildirim başlığı işletme ve şubeyi taşır', async () => {
    const { sube, settings } = await mod();
    settings.updateSettings({ branchId: 'kadikoy' });
    expect(sube.subeAdi()).toBe('Kadikoy');
    settings.setSyncState('kurulum.sube', { ok: true, sube: { id: 'kadikoy', ad: 'Kadıköy' }, at: Date.now(), hata: null });
    expect(sube.subeAdi()).toBe('Kadıköy');
    const sent: { shop?: unknown }[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    });
    try {
      const { notify } = await import('../server/sync/bildirim');
      await notify({ kind: 'kasa-farki', title: 'Kasa farkı', body: 'deneme' });
    } finally {
      vi.stubGlobal('fetch', prev);
    }
    expect(sent.at(-1)?.shop).toBe("L'Affogato Kadıköy");
    expect((await h.ok<{ branchName?: string | null }>('kasa', 'GET', '/bootstrap')).branchName).toBe('Kadıköy');
  });
});

describe('Merkez kapalıyken ikinci şube uyarılır', () => {
  it('Marina dışındaki şubede uyarı, Marina’da ve şubesiz kasada yok; Bağlantı bilgileri gösterir', async () => {
    const { settings } = await mod();
    const { merkezKapaliUyarisi } = await import('../server/sync/merkez');
    settings.updateSettings({ branchId: 'tuzla' });
    expect(merkezKapaliUyarisi()).toMatch(/ASILPOS_MERKEZ_URL=0/);
    const v = await h.ok<{ kurulum: { merkezUyarisi: string | null; sube: string | null } }>('mudur', 'GET', '/admin/baglanti');
    expect(v.kurulum).toMatchObject({ sube: 'tuzla', merkezUyarisi: expect.stringMatching(/ortak "default" dükkânına/) });
    settings.updateSettings({ branchId: 'marina' });
    expect(merkezKapaliUyarisi()).toBeNull();
    settings.updateSettings({ branchId: null });
    expect(merkezKapaliUyarisi()).toBeNull();
  });
});

describe('başka şubenin bulut yedeği yüklenmez', () => {
  /** Yalnız ayar ve gün tablosu olan küçük bir yedek dosyası (better-sqlite3; sql.js projesi diske bağlanamaz) */
  async function backupFile(rows: { branchId?: string; liveSince?: number; day?: boolean; denetim?: boolean }): Promise<string> {
    const Database = (await import('better-sqlite3')).default;
    const file = join(mkdtempSync(join(tmpdir(), 'asilpos-yedek-')), 'yedek.db');
    const d = new Database(file);
    d.exec('CREATE TABLE settings (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL); CREATE TABLE business_days (id text PRIMARY KEY NOT NULL)');
    // Çok şubeli sürümün veritabanı: açılıştaki eski kasa denetiminin işareti (eski sürümün yedeğinde yok)
    if (rows.denetim) {
      d.exec('CREATE TABLE sync_state (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL)');
      d.prepare('INSERT INTO sync_state VALUES (?, ?, 0)').run('sube.eskiKasaDenetimi', JSON.stringify({ at: 0, yazildi: false }));
    }
    if (rows.branchId) d.prepare('INSERT INTO settings VALUES (?, ?, 0)').run('branchId', JSON.stringify(rows.branchId));
    if (rows.liveSince) d.prepare('INSERT INTO settings VALUES (?, ?, 0)').run('liveSince', JSON.stringify(rows.liveSince));
    if (rows.day) d.prepare('INSERT INTO business_days VALUES (?)').run('g1');
    d.close();
    return file;
  }

  it('yedeğin şubesi: ayar satırı, yoksa eski sürümün geçmişi olan yedeğinde marina, boş yedekte null, okunamazsa bilinmiyor', async (ctx) => {
    if (ctx.task.file.projectName === 'sqljs') ctx.skip();
    const { yedekSubesi } = await import('../server/sync/yedek');
    expect(yedekSubesi(await backupFile({ branchId: 'tuzla' }))).toBe('tuzla');
    expect(yedekSubesi(await backupFile({ branchId: 'tuzla', denetim: true }))).toBe('tuzla');
    expect(yedekSubesi(await backupFile({ day: true }))).toBe('marina');
    expect(yedekSubesi(await backupFile({ liveSince: 1 }))).toBe('marina');
    expect(yedekSubesi(await backupFile({}))).toBeNull();
    // Çok şubeli sürümde şubesiz kalmış yeni kasanın yedeği (deneme günü, gerçek kullanım) Marina'nın sayılmaz
    expect(yedekSubesi(await backupFile({ day: true, liveSince: 1, denetim: true }))).toBeNull();
    const bozuk = join(mkdtempSync(join(tmpdir(), 'asilpos-yedek-')), 'bozuk.db');
    writeFileSync(bozuk, 'bu bir veritabanı değil');
    expect(yedekSubesi(bozuk)).toBeUndefined();
  });

  it('şubesi belli kasa başka şubenin yedeğini reddeder (409 wrong_branch, hazır dosya kalmaz); kendi şubesininki ve şubesiz kasa serbest', async (ctx) => {
    if (ctx.task.file.projectName === 'sqljs') ctx.skip();
    const { settings } = await mod();
    const { sealBackup, stageRestore } = await import('../server/sync/yedek');
    const { env } = await import('../server/env');
    const stage = async (file: string) => {
      const sealed = sealBackup(readFileSync(file), CLOUD_SECRET);
      const prev = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string | URL | Request) =>
        String(url).includes('/api/uzaktan/yedek/indir') ? Response.json({ url: 'http://127.0.0.1:9/blob' }) : new Response(new Uint8Array(sealed)),
      );
      try {
        await stageRestore('dukkan/yedek.db.lpy', 'u1', 'Patron');
      } finally {
        vi.stubGlobal('fetch', prev);
      }
    };
    const ready = join(env.dataDir, 'geri-yukle', 'hazir.db');
    settings.updateSettings({ branchId: 'marina' });
    const err = await stage(await backupFile({ branchId: 'tuzla' })).catch((e: unknown) => e as { status?: number; code?: string; message?: string });
    expect(err).toMatchObject({ status: 409, code: 'wrong_branch' });
    expect(err?.message).toMatch(/"tuzla" şubesinin kasasından, bu kasa "marina"/);
    expect(existsSync(ready)).toBe(false);
    await stage(await backupFile({ day: true }));
    expect(existsSync(ready)).toBe(true);
    settings.updateSettings({ branchId: null });
    await stage(await backupFile({ branchId: 'tuzla' }));
    expect(existsSync(ready)).toBe(true);
  });
});

describe('ladmin kurulumu şubeyi verince', () => {
  it('şube yazılır, eski şubenin devri bırakılır, Bağlantı bilgileri sonucu gösterir', async () => {
    const { settings } = await mod();
    const dir = mkdtempSync(join(tmpdir(), 'asilpos-kurulum-'));
    writeFileSync(join(dir, 'kurulum-kodu.json'), JSON.stringify({ adres: 'https://ladmin.laffogato.net', kod: 'Abc123_-'.repeat(4) }));
    settings.updateSettings({ branchId: null });
    const { db, schema, eq } = await mod();
    db.delete(schema.syncState).where(eq(schema.syncState.key, 'kurulum.sube')).run();
    settings.setSyncState('lafmaliyet.devir', { date: '2026-11-20', attemptAt: 0, okAt: 1, nextOpening: { amount: 1, source: 'kasa_raporu' }, sube: 'marina' });
    const { redeemInstallCode, kurulumGorunumu } = await import('../server/sync/kurulum-kodu');
    expect(kurulumGorunumu(dir)).toMatchObject({ sube: null, subeAdi: null, kodBekliyor: true, durum: null });
    const fetchImpl = (async () => Response.json({ ok: true, sube: { id: 'moda', ad: 'Moda' }, baglanti: {} })) as typeof fetch;
    const out = await redeemInstallCode({ dataDir: dir, fetchImpl });
    expect(out).toMatchObject({ ok: true, sube: { id: 'moda', ad: 'Moda' } });
    expect(settings.getSettings().branchId).toBe('moda');
    expect(settings.getSyncState('lafmaliyet.devir')).toBeNull();
    expect(kurulumGorunumu(dir)).toEqual({ sube: 'moda', subeAdi: 'Moda', kodBekliyor: false, durum: { ok: true, sube: { id: 'moda', ad: 'Moda' }, at: expect.any(Number), hata: null, kalici: false, kilitli: false }, merkezUyarisi: expect.stringMatching(/Merkez kapalı/) });
    // Kalıcı hata ekranda nedeniyle
    writeFileSync(join(dir, 'kurulum-kodu.json'), JSON.stringify({ adres: 'https://ladmin.laffogato.net', kod: 'Abc123_-'.repeat(4) }));
    await redeemInstallCode({ dataDir: dir, fetchImpl: (async () => Response.json({ ok: false, error: 'Bu kurulum bağlantısı kullanılmış' }, { status: 410 })) as typeof fetch });
    expect(kurulumGorunumu(dir).durum).toMatchObject({ ok: false, kalici: true, hata: expect.stringMatching(/kullanılmış/) });
  });
});
