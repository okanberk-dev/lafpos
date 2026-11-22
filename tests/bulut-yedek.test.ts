import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import { type Harness, PINS, startApp } from './harness';

/**
 * Bulut yedeği: kasa yedeği şifreler (anahtar buluta gitmez), LafPOS Uzaktan imzalı adres verir, geri yüklemede bekçi
 * mevcut veritabanının kopyasını alıp yedeği yerine koyar. Vercel Blob bellekte sahte.
 */
const CLOUD = 'https://yedek.test';
const SECRET = 'y'.repeat(40);
const blobs = new Map<string, Buffer>();
vi.mock('@vercel/blob', () => ({
  issueSignedToken: async (o: { pathname: string }) => ({ delegationToken: `d:${o.pathname}`, clientSigningToken: 'c' }),
  presignUrl: async (_t: unknown, o: { operation: string; pathname: string }) => ({ presignedUrl: `https://blob.test/${o.operation}/${o.pathname}` }),
  list: async (o: { prefix: string; mode?: string }) => {
    const keys = [...blobs.keys()].filter((k) => k.startsWith(o.prefix));
    if (o.mode === 'folded') return { blobs: [], folders: [...new Set(keys.map((k) => `${k.split('/').slice(0, 2).join('/')}/`))], hasMore: false };
    return { blobs: keys.map((k) => ({ pathname: k, size: blobs.get(k)!.length, uploadedAt: new Date(Number(k.match(/(\d{8})-(\d{6})/) ? Date.parse(`${k.slice(-19, -15)}-${k.slice(-15, -13)}-${k.slice(-13, -11)}T${k.slice(-10, -8)}:${k.slice(-8, -6)}:${k.slice(-6, -4)}Z`) : 0)) })), hasMore: false };
  },
  del: async (keys: string[]) => keys.forEach((k) => blobs.delete(k)),
}));

let h: Harness;
beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, BLOB_READ_WRITE_TOKEN: 'rw', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') return new Response(JSON.stringify({ result: null }));
    if (url.startsWith('https://blob.test/put/')) {
      blobs.set(url.slice('https://blob.test/put/'.length), Buffer.from(init!.body as Uint8Array));
      return new Response('{}', { status: 200 });
    }
    if (url.startsWith('https://blob.test/get/')) {
      const b = blobs.get(url.slice('https://blob.test/get/'.length));
      return b ? new Response(new Uint8Array(b)) : new Response('yok', { status: 404 });
    }
    if (url.startsWith(CLOUD)) {
      const { POST } = await import('../api/uzaktan');
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: init!.body as string, headers: init!.headers as Record<string, string> }));
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

describe('bulut yedeği', () => {
  it('şifreleme: gidiş dönüş aynı; yanlış anahtar ve bozuk dosya Türkçe hata; içerik açık değil', async () => {
    const { sealBackup, openBackup } = await import('../server/sync/yedek');
    const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('gizli satış verisi '.repeat(200))]);
    const sealed = sealBackup(db, SECRET);
    expect(sealed.includes(Buffer.from('gizli satış'))).toBe(false);
    expect(openBackup(sealed, SECRET).equals(db)).toBe(true);
    expect(() => openBackup(sealed, 'z'.repeat(40))).toThrow(/şifresi çözülemedi/);
    expect(() => openBackup(Buffer.from('rastgele'), SECRET)).toThrow(/tanınmadı/);
    expect(() => openBackup(sealBackup(Buffer.from('SQLite değil'), SECRET), SECRET)).toThrow(/veritabanı çıkmadı/);
  });

  it('yüklemenin şifrelemesi olay döngüsünü kilitlemeden sıkıştırır; aynı biçimde açılır (bulgu 26)', async () => {
    const { sealBackupAsync, openBackup } = await import('../server/sync/yedek');
    const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 1)]);
    let ticks = 0;
    const tick = setInterval(() => ticks++, 0);
    const sealed = await sealBackupAsync(db, SECRET);
    clearInterval(tick);
    expect(openBackup(sealed, SECRET).equals(db)).toBe(true);
  });

  it('bulut uçları yalnız imzalı; ad dükkânın klasöründe; başka klasörden indirilemez', async () => {
    const { POST } = await import('../api/uzaktan');
    const call = (path: string, body: object, signed = true, shop = 'abc123') => {
      const raw = JSON.stringify(body);
      const headers = { 'x-laf-dukkan': shop, ...(signed ? signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/${path}`), raw) : {}) };
      return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: raw, headers }));
    };
    expect((await call('uzaktan/yedek/yukle', { boyut: 10 }, false)).status).toBe(401);
    const ok = (await (await call('uzaktan/yedek/yukle', { boyut: 10 })).json()) as { pathname: string };
    expect(ok.pathname).toMatch(/^yedek\/abc123\/\d{8}-\d{6}\.lpy$/);
    expect((await call('uzaktan/yedek/yukle', { boyut: 0 })).status).toBe(400);
    expect((await call('uzaktan/yedek/indir', { pathname: '../lafpos.db' })).status).toBe(400);
    expect((await call('uzaktan/yedek/indir', { pathname: 'raporlar/x.lpy' })).status).toBe(400);
  });

  it('şimdi yedekle: kasa yedeği şifreli yükler; liste görünür', async () => {
    const r = await h.ok<{ name: string; size: number }>('patron', 'POST', '/admin/bulut-yedek');
    expect(r.name).toMatch(/^yedek\/default\/\d{8}-\d{6}\.lpy$/);
    const stored = blobs.get(r.name)!;
    expect(stored.subarray(0, 4).toString()).toBe('LPY1');
    expect(stored.includes(Buffer.from('SQLite format 3'))).toBe(false);
    const st = await h.ok<{ ready: boolean; state: { lastName: string } }>('patron', 'GET', '/admin/bulut-yedek');
    expect(st.state.lastName).toBe(r.name);
    const list = await h.ok<{ yedekler: { pathname: string }[]; dukkanlar: string[] }>('patron', 'POST', '/admin/bulut-yedek/liste-dukkan', {});
    expect(list.yedekler.map((y) => y.pathname)).toContain(r.name);
    expect(list.dukkanlar).toContain('default');
  });

  it('geri yükleme: yalnız patron, kendi PIN’i, gün kapalıyken ve Windows kurulumunda; yedek indirilip hazır bırakılır', async () => {
    const list = await h.ok<{ yedekler: { pathname: string }[] }>('patron', 'POST', '/admin/bulut-yedek/liste-dukkan', {});
    const pathname = list.yedekler[0]!.pathname;
    // Bekçisiz (git ile çalışan) sunucuda yapılmaz
    expect((await h.call('patron', 'POST', '/admin/bulut-yedek/geri-yukle', { pathname, pin: PINS.patron })).status).toBe(409);
    process.env.LAFPOS_STDIN_CONTROL = '1';
    const { setRestartHook } = await import('../server/sync/yedek');
    const emit = vi.fn();
    setRestartHook(emit);
    try {
      expect((await h.call('mudur', 'POST', '/admin/bulut-yedek/geri-yukle', { pathname, pin: PINS.mudur })).status).toBe(403);
      expect((await h.call('patron', 'POST', '/admin/bulut-yedek/geri-yukle', { pathname, pin: '0000' })).status).toBe(403);
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      expect(((await h.call<{ code: string }>('patron', 'POST', '/admin/bulut-yedek/geri-yukle', { pathname, pin: PINS.patron })).json).code).toBe('day_open');
      await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
      await h.ok('patron', 'POST', '/admin/bulut-yedek/geri-yukle', { pathname, pin: PINS.patron });
      const { env } = await import('../server/env');
      const ready = join(env.dataDir, 'geri-yukle', 'hazir.db');
      expect(readFileSync(ready).subarray(0, 15).toString()).toBe('SQLite format 3');
      // İstek (kim, hangi yedek, adıyla) hazır yedekten önce yazılır: bekçi yalnız taze istekle yerine koyar
      const istek = JSON.parse(readFileSync(join(env.dataDir, 'geri-yukle', 'istek.json'), 'utf8')) as { pathname: string; by: string; byName: string; at: number };
      expect(istek).toMatchObject({ pathname, by: expect.any(String), byName: expect.any(String) });
      await new Promise((r) => setTimeout(r, 700));
      expect(emit).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.LAFPOS_STDIN_CONTROL;
    }
  });

  it('bekçi: önce mevcut veritabanının kopyası, sonra yedek yerine; -wal silinir; bekleyen yoksa dokunmaz', async () => {
    const file = '../scripts/kasa/windows/kurulum/geri-yukle.mjs';
    const { applyPendingRestore } = (await import(file)) as { applyPendingRestore: (home: string, now?: Date) => string | null };
    const home = mkdtempSync(join(tmpdir(), 'lafpos-geri-'));
    try {
      expect(applyPendingRestore(home)).toBeNull();
      writeFileSync(join(home, 'lafpos.db'), 'eski');
      writeFileSync(join(home, 'lafpos.db-wal'), 'eski-wal');
      mkdirSync(join(home, 'geri-yukle'));
      writeFileSync(join(home, 'geri-yukle', 'hazir.db'), 'yeni');
      const when = new Date(2026, 10, 21, 14, 5, 9);
      writeFileSync(join(home, 'geri-yukle', 'istek.json'), JSON.stringify({ pathname: 'yedek/a.db.gz', by: 'u1', byName: 'Patron', at: when.getTime() - 2000 }));
      expect(applyPendingRestore(home, when)).toMatch(/geri yüklendi/);
      expect(readFileSync(join(home, 'lafpos.db'), 'utf8')).toBe('yeni');
      expect(existsSync(join(home, 'lafpos.db-wal'))).toBe(false);
      expect(readFileSync(join(home, 'backups', 'lafpos-geri-yukleme-oncesi-20261121-140509.db'), 'utf8')).toBe('eski');
      expect(readFileSync(join(home, 'backups', 'lafpos-geri-yukleme-oncesi-20261121-140509.db-wal'), 'utf8')).toBe('eski-wal');
      expect(readdirSync(join(home, 'geri-yukle'))).toEqual(['son.json']);
      // Kim, hangi yedek: sunucu açılışta denetim kaydına yazar (eski veritabanına yazılan satır yerine konunca gider)
      expect(JSON.parse(readFileSync(join(home, 'geri-yukle', 'son.json'), 'utf8'))).toMatchObject({ pathname: 'yedek/a.db.gz', by: 'u1', byName: 'Patron' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bekçi: kilit geçiciyse yeniden dener; geri alma da düşerse hazır yedek kalır ve sunucu boş veritabanıyla açılmaz', async () => {
    const file = '../scripts/kasa/windows/kurulum/geri-yukle.mjs';
    type Opts = { rename?: (a: string, b: string) => void; tries?: number; waitMs?: number };
    const { applyPendingRestore, recoverMissingDb } = (await import(file)) as {
      applyPendingRestore: (home: string, now?: Date, opts?: Opts) => string | null;
      recoverMissingDb: (home: string, now?: Date) => string | null;
    };
    const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    const prepare = (home: string, when: Date) => {
      writeFileSync(join(home, 'lafpos.db'), 'eski');
      writeFileSync(join(home, 'lafpos.db-wal'), 'eski-wal');
      mkdirSync(join(home, 'geri-yukle'), { recursive: true });
      writeFileSync(join(home, 'geri-yukle', 'hazir.db'), 'yeni');
      writeFileSync(join(home, 'geri-yukle', 'istek.json'), JSON.stringify({ pathname: 'yedek/a.db.gz', by: 'u1', at: when.getTime() - 2000 }));
    };
    const when = new Date(2026, 10, 21, 14, 5, 9);
    // Geçici kilit: iki deneme düşer, üçüncüsü geçer
    const a = mkdtempSync(join(tmpdir(), 'lafpos-geri-'));
    try {
      prepare(a, when);
      let fails = 2;
      const flaky = (from: string, to: string) => {
        if (from.endsWith('hazir.db') && fails-- > 0) throw busy();
        renameSync(from, to);
      };
      expect(applyPendingRestore(a, when, { rename: flaky, waitMs: 1 })).toMatch(/geri yüklendi/);
      expect(readFileSync(join(a, 'lafpos.db'), 'utf8')).toBe('yeni');
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
    // Kalıcı kilit: yedek yerine konamaz, geri alma da düşer
    const b = mkdtempSync(join(tmpdir(), 'lafpos-geri-'));
    try {
      prepare(b, when);
      let calls = 0;
      const locked = (from: string, to: string) => {
        if (++calls > 2) throw busy();
        renameSync(from, to);
      };
      let err: (Error & { code?: string }) | null = null;
      try {
        applyPendingRestore(b, when, { rename: locked, tries: 2, waitMs: 1 });
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err?.code).toBe('RESTORE_STUCK');
      expect(existsSync(join(b, 'lafpos.db'))).toBe(false);
      expect(existsSync(join(b, 'geri-yukle', 'hazir.db'))).toBe(true);
      expect(existsSync(join(b, 'geri-yukle', 'istek.json'))).toBe(true);
      // Bekçi sunucuyu açmadan önce kenara alınan veritabanını -wal ile yerine taşır
      expect(recoverMissingDb(b, new Date(when.getTime() + 1000))).toBeNull();
      expect(readFileSync(join(b, 'lafpos.db'), 'utf8')).toBe('eski');
      expect(readFileSync(join(b, 'lafpos.db-wal'), 'utf8')).toBe('eski-wal');
      // Veritabanı yok, hazır yedek duruyor ve geri taşınacak kopya yok: açılmaz
      rmSync(join(b, 'lafpos.db'));
      rmSync(join(b, 'lafpos.db-wal'));
      expect(recoverMissingDb(b, new Date(when.getTime() + 1000))).toMatch(/açılmıyor/);
      // Yeni kurulum (veritabanı, yedek, kopya yok): açılır
      rmSync(join(b, 'geri-yukle'), { recursive: true });
      expect(recoverMissingDb(b, when)).toBeNull();
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('bekçi: isteği eski ya da yok olan hazır yedek günler sonra yerine konmaz, iptal edilir (bulgu 14)', async () => {
    const file = '../scripts/kasa/windows/kurulum/geri-yukle.mjs';
    const { applyPendingRestore } = (await import(file)) as { applyPendingRestore: (home: string, now?: Date) => string | null };
    const home = mkdtempSync(join(tmpdir(), 'lafpos-geri-'));
    try {
      const now = new Date(2026, 10, 24, 9, 0, 0);
      for (const istek of [null, JSON.stringify({ pathname: 'yedek/a.db.gz', by: 'u1', at: now.getTime() - 3 * 86400_000 }), '{bozuk']) {
        writeFileSync(join(home, 'lafpos.db'), 'canli');
        mkdirSync(join(home, 'geri-yukle'), { recursive: true });
        writeFileSync(join(home, 'geri-yukle', 'hazir.db'), 'eski-yedek');
        if (istek) writeFileSync(join(home, 'geri-yukle', 'istek.json'), istek);
        expect(applyPendingRestore(home, now)).toMatch(/iptal/);
        expect(readFileSync(join(home, 'lafpos.db'), 'utf8')).toBe('canli');
        expect(existsSync(join(home, 'geri-yukle', 'hazir.db'))).toBe(false);
        expect(JSON.parse(readFileSync(join(home, 'geri-yukle', 'son.json'), 'utf8'))).toMatchObject({ hata: expect.any(String) });
        // Bir sonraki açılışta yapacak bir şey yok
        expect(applyPendingRestore(home, now)).toBeNull();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('sunucu açılışta geri yüklemeyi denetim kaydına bir kez yazar; kalan hazır yedeği siler (bulgu 6/21)', async () => {
    const { env } = await import('../server/env');
    const { recordRestoreResult } = await import('../server/sync/yedek');
    const { db, schema } = await import('../server/db/client');
    const { desc } = await import('drizzle-orm');
    const dir = join(env.dataDir, 'geri-yukle');
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'hazir.db'), { force: true });
    rmSync(join(dir, 'istek.json'), { force: true });
    writeFileSync(join(dir, 'son.json'), JSON.stringify({ at: 1, copy: 'backups/x.db', pathname: 'yedek/a.db.gz', by: 'u-yok', byName: 'Ayşe', requestedAt: 0 }));
    const last = () => db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(1).get();
    recordRestoreResult();
    const row = last()!;
    expect(row).toMatchObject({ action: 'yedek', severity: 'uyari', userId: 'u-yok' });
    expect(row.message).toMatch(/yedek\/a\.db\.gz/);
    expect(row.message).toMatch(/Ayşe/);
    const count = () => db.select().from(schema.auditLog).all().filter((r) => r.action === 'yedek').length;
    const n = count();
    recordRestoreResult();
    expect(count()).toBe(n);
    // Bekçi uygulamadıysa (bekçisiz açılış ya da ertelendi) hazır yedek kalmaz: günler sonra yerine konamaz
    writeFileSync(join(dir, 'hazir.db'), 'eski');
    recordRestoreResult();
    expect(existsSync(join(dir, 'hazir.db'))).toBe(false);
    expect(last()!.message).toMatch(/yapılmadı/);
  });
});
