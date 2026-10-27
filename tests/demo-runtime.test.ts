import * as nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import * as crypto from '../demo/shims/crypto';
import { EventEmitter } from '../demo/shims/events';
import * as fs from '../demo/shims/fs';
import * as path from '../demo/shims/path';

/** Tarayıcı demosunun Node karşılıkları ve sql.js istemcisi: sunucu kodu demoda kasadakiyle aynı sonucu vermeli */
const root = join(__dirname, '..');

describe('demo: node:crypto karşılığı', () => {
  it('özet ve HMAC Node ile aynı', () => {
    for (const algo of ['sha256', 'sha1']) {
      for (const input of ['', 'lafpos', 'Türk kahvesi ☕ şekerli']) {
        expect(crypto.createHash(algo).update(input).digest('hex')).toBe(nodeCrypto.createHash(algo).update(input).digest('hex'));
      }
    }
    expect(crypto.createHash('sha256').update('a').update('b').digest('hex')).toBe(nodeCrypto.createHash('sha256').update('ab').digest('hex'));
    expect(crypto.createHmac('sha256', 'gizli').update('lafpos-pin:1897').digest('hex')).toBe(nodeCrypto.createHmac('sha256', 'gizli').update('lafpos-pin:1897').digest('hex'));
  });
  it('rastgele baytlar Buffer gibi kodlanır', () => {
    const token = crypto.randomBytes(32).toString('base64url');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = crypto.randomBytes(16);
    expect(bytes).toHaveLength(16);
    expect(bytes.toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('bilinmeyen özet açık hata verir', () => {
    expect(() => crypto.createHash('md5')).toThrow(/desteklenmeyen/);
  });
});

describe('demo: node:path, node:fs, node:events karşılıkları', () => {
  it('yollar POSIX gibi', () => {
    for (const parts of [['/a', 'b', '../c'], ['/demo/', 'server/db/menu-snapshot.json'], ['/x', '/y', 'z']]) {
      expect(path.resolve(...parts)).toBe(nodePath.posix.resolve(...parts));
    }
    expect(path.join('/veri', 'cache', 'urun')).toBe('/veri/cache/urun');
    expect(path.dirname('/a/b/c.ts')).toBe('/a/b');
    expect(path.relative('/a/b', '/a/c/d')).toBe(nodePath.posix.relative('/a/b', '/a/c/d'));
  });
  it('yalnız gömülü menü okunur; disk yok', () => {
    const menu = JSON.parse(fs.readFileSync('/demo/server/db/menu-snapshot.json', 'utf8'));
    expect(menu).toEqual(JSON.parse(readFileSync(join(root, 'server/db/menu-snapshot.json'), 'utf8')));
    expect(fs.existsSync('/veri/secret.key')).toBe(false);
    expect(() => fs.readFileSync('/veri/secret.key')).toThrow(/Demoda dosya yok/);
    expect(fs.readdirSync('/veri/yedekler')).toEqual([]);
  });
  it('olay yayıcı', () => {
    const e = new EventEmitter();
    const got: number[] = [];
    const fn = (n: number) => got.push(n);
    e.on('x', fn);
    e.once('x', (n: number) => got.push(n * 10));
    e.emit('x', 1);
    e.emit('x', 2);
    e.off('x', fn);
    e.emit('x', 3);
    expect(got).toEqual([1, 10, 2]);
  });
});

describe('demo: sql.js istemcisi', () => {
  let demo: typeof import('../demo/db');
  beforeAll(async () => {
    const sqljs = await import('../demo/sqljs');
    sqljs.setSqlJs(await initSqlJs());
    sqljs.openDatabase();
    demo = await import('../demo/db');
    demo.runMigrations();
  });

  it('göçlerin hepsi pakette, özetleri drizzle-kit ile aynı', async () => {
    const { bundledMigrations } = await import('../demo/migrations');
    const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const list = bundledMigrations();
    expect(list.map((m) => m.folderMillis)).toEqual([...list.map((m) => m.folderMillis)].sort((a, b) => a - b));
    expect(list).toHaveLength(journal.entries.length);
    for (const [i, e] of journal.entries.entries()) {
      expect(list[i].hash).toBe(nodeCrypto.createHash('sha256').update(readFileSync(join(root, `drizzle/${e.tag}.sql`), 'utf8')).digest('hex'));
    }
  });

  it('iç içe işlem kayıt noktasıdır; içteki geri alınınca dıştaki kalır', () => {
    const { db, schema, sqlite, tx } = demo;
    expect(sqlite.inTransaction).toBe(false);
    tx((t) => {
      expect(sqlite.inTransaction).toBe(true);
      t.insert(schema.settings).values({ key: 'dis', value: 1, updatedAt: 1 }).run();
      expect(() =>
        tx((inner) => {
          inner.insert(schema.settings).values({ key: 'ic', value: 2, updatedAt: 1 }).run();
          throw new Error('geri al');
        }),
      ).toThrow('geri al');
      expect(sqlite.inTransaction).toBe(true);
    });
    expect(sqlite.inTransaction).toBe(false);
    const keys = db.select().from(schema.settings).all().map((r) => r.key);
    expect(keys).toContain('dis');
    expect(keys).not.toContain('ic');
  });

  it('run() değişen satır sayısını, kısıt hatası better-sqlite3 kodunu verir', () => {
    const { db, schema } = demo;
    const r = db.update(schema.settings).set({ value: 3 }).run() as unknown as { changes: number };
    expect(r.changes).toBe(1);
    let code: unknown = null;
    try {
      db.insert(schema.settings).values({ key: 'dis', value: 1, updatedAt: 1 }).run();
    } catch (e) {
      for (let x: unknown = e; x && !code; x = (x as { cause?: unknown }).cause) code = (x as { code?: unknown }).code;
    }
    expect(code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });
});

describe('demo: yayın ayarları', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { buildCommand: string; rewrites: { source: string; destination: string }[] };
  it('/demo kasa sayfasından önce kendi sayfasına gider', () => {
    const demo = vercel.rewrites.findIndex((r) => r.source === '/demo/((?!assets/).*)' && r.destination === '/demo/index.html');
    const all = vercel.rewrites.findIndex((r) => r.destination === '/index.html');
    expect(demo).toBeGreaterThanOrEqual(0);
    expect(demo).toBeLessThan(all);
  });
  it('derleme dosyaları (adında içerik özeti) bir yıl önbellekte kalır', () => {
    const headers = (JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }).headers;
    for (const source of ['/assets/(.*)', '/demo/assets/(.*)']) {
      expect(headers.find((h) => h.source === source)?.headers).toContainEqual({ key: 'cache-control', value: 'public, max-age=31536000, immutable' });
    }
  });
  it('demo yalnız Vercel derlemesinde; kasa derlemesine ve Windows paketine girmez', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(vercel.buildCommand).toMatch(/npm run build && npm run build:demo$/);
    expect(pkg.scripts.build).not.toContain('demo');
    expect(pkg.scripts['build:demo']).toBe('vite build --mode demo');
    expect(readFileSync(join(root, 'scripts/kasa/windows/kurulum/derle.mjs'), 'utf8')).toMatch(/filter: \(src\) => !src\.startsWith\(join\(ROOT, 'dist\/web\/demo'\)\)/);
  });
});
