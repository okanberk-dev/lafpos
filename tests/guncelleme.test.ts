import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Kasanın otomatik güncellemesi (scripts/kasa/windows/kurulum/guncelle.mjs, kanal.mjs, arsiv.mjs): manifestin
 * doğrulanması, ne zaman ve neyin kurulacağı, durum dosyası ve kurulum akışı (yedek, klasör değişimi, deneme, geri
 * dönüş). Akış gerçek dosyalarla geçici klasörde, ağ ve deneme süreci taklitle koşar.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href) as Promise<Mod>;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BUILD_OLD = 1_795_000_000;
const BUILD_NEW = 1_795_100_000;
const SHA0 = 'a'.repeat(64);

function manifest(over: Record<string, any> = {}) {
  return {
    v: 1,
    build: BUILD_NEW,
    version: '0.2.0',
    commit: 'abc',
    app: { file: `lafpos-app-${BUILD_NEW}.zip`, sha256: SHA0, size: 1000 },
    node: { version: '24.22.3', abi: '137', sha256: SHA0 },
    sqlite: { version: '12.11.1', sha256: SHA0 },
    ...over,
  };
}

describe('güncelleme: saf kurallar', () => {
  it('LAFPOS_GUNCELLEME yalnız açıkça kapatılınca kapalı', async () => {
    const { updateMode } = await load('guncelle.mjs');
    expect(updateMode({})).toBe('otomatik');
    expect(updateMode({ LAFPOS_GUNCELLEME: 'otomatik' })).toBe('otomatik');
    for (const v of ['kapali', 'KAPALI', ' kapalı ', 'off', 'hayır', '0', 'false']) expect(updateMode({ LAFPOS_GUNCELLEME: v })).toBe('kapali');
  });

  it('manifest: yük aynı hosttan, Node ve better-sqlite3 sabit kalıptan; bozuk alan reddedilir', async () => {
    const { parseManifest } = await load('guncelle.mjs');
    const m = parseManifest(manifest(), 'https://lafpos.laffogato.net/guncelleme/surum.json');
    expect(m.app.url).toBe(`https://lafpos.laffogato.net/guncelleme/lafpos-app-${BUILD_NEW}.zip`);
    expect(m.node.url).toBe('https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip');
    expect(m.sqlite.url).toBe('https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz');
    const bad = [
      { v: 2 },
      { build: 12 },
      { build: 1.5e9 + 0.5 },
      { version: '1.2' },
      { app: { file: 'https://evil.example/x.zip', sha256: SHA0, size: 10 } },
      { app: { file: '../lafpos-app-1.zip', sha256: SHA0, size: 10 } },
      { app: { file: `lafpos-app-${BUILD_NEW}.zip`, sha256: 'xyz', size: 10 } },
      { app: { file: `lafpos-app-${BUILD_NEW}.zip`, sha256: SHA0, size: 0 } },
      { node: { version: '24', abi: '137', sha256: SHA0 } },
      { sqlite: { version: '12.11.1', sha256: 'kısa' } },
    ];
    for (const over of bad) expect(() => parseManifest(manifest(over), 'https://lafpos.laffogato.net/guncelleme/surum.json')).toThrow();
    expect(() => parseManifest(null, 'https://x.test/a')).toThrow();
  });

  it('yönlendirme: yalnız HTTPS ve aynı host (GitHub dosyası için izinli depolama hostu)', async () => {
    const { redirectAllowed, SQLITE_REDIRECT_HOSTS } = await load('guncelle.mjs');
    const from = 'https://lafpos.laffogato.net/guncelleme/surum.json';
    expect(redirectAllowed(from, '/guncelleme/surum2.json')).toBe(true);
    expect(redirectAllowed(from, 'https://lafpos.laffogato.net/x')).toBe(true);
    expect(redirectAllowed(from, 'https://evil.example/surum.json')).toBe(false);
    expect(redirectAllowed(from, 'http://lafpos.laffogato.net/x')).toBe(false);
    const gh = 'https://github.com/WiseLibs/better-sqlite3/releases/download/v1/x.tar.gz';
    expect(redirectAllowed(gh, 'https://release-assets.githubusercontent.com/a', SQLITE_REDIRECT_HOSTS)).toBe(true);
    expect(redirectAllowed(gh, 'https://evil.example/a', SQLITE_REDIRECT_HOSTS)).toBe(false);
  });

  it('ne kurulur: yalnız daha yeni derleme, geri dönülen derleme bir daha değil; Node ve yerel modül değişince', async () => {
    const { planUpdate, parseManifest } = await load('guncelle.mjs');
    const m = parseManifest(manifest(), 'https://a.test/guncelleme/surum.json');
    const installed = { build: BUILD_OLD, sqlite: '12.11.1', nodeAbi: '137' };
    expect(planUpdate({ installed, nodeVersion: '24.22.3', manifest: m })).toEqual({ build: BUILD_NEW, version: '0.2.0', node: false, sqlite: false });
    expect(planUpdate({ installed: { ...installed, build: BUILD_NEW }, nodeVersion: '24.22.3', manifest: m })).toBeNull();
    expect(planUpdate({ installed: { ...installed, build: BUILD_NEW + 1 }, nodeVersion: '24.22.3', manifest: m })).toBeNull();
    expect(planUpdate({ installed, nodeVersion: '24.22.3', manifest: m, failed: [BUILD_NEW] })).toBeNull();
    expect(planUpdate({ installed, nodeVersion: '24.20.0', manifest: m })?.node).toBe(true);
    expect(planUpdate({ installed: { ...installed, sqlite: '12.10.0' }, nodeVersion: '24.22.3', manifest: m })?.sqlite).toBe(true);
    expect(planUpdate({ installed: { ...installed, nodeAbi: '127' }, nodeVersion: '24.22.3', manifest: m })?.sqlite).toBe(true);
  });

  it('kurulum yalnız sunucu "açık gün yok" deyince', async () => {
    const { installDecision } = await load('guncelle.mjs');
    expect(installDecision(false)).toBe('kur');
    expect(installDecision(true)).toBe('gun-acik');
    expect(installDecision(null)).toBe('bilinmiyor');
  });

  it('durum dosyası: kurulum sonrası açılış, geri dönüş ve geri dönülen sürümün yeniden görülmesi', async () => {
    const { nextStatus } = await load('guncelle.mjs');
    const now = Date.UTC(2026, 10, 21, 3);
    const yeni = { surum: '0.2.0', build: BUILD_NEW };
    let s = nextStatus(null, { type: 'acilis', kurulu: { surum: '0.2.0', build: BUILD_OLD }, mode: 'otomatik', now });
    expect(s.durum).toBe('guncel');
    s = nextStatus(s, { type: 'kuruluyor', yeni, now });
    expect(nextStatus(s, { type: 'acilis', kurulu: yeni, mode: 'otomatik', now })).toMatchObject({ durum: 'guncel', yeni: null, mesaj: 'Güncellendi' });
    expect(nextStatus(s, { type: 'acilis', kurulu: { surum: '0.2.0', build: BUILD_OLD }, mode: 'otomatik', now }).durum).toBe('hata');
    const back = nextStatus(s, { type: 'geri-dondu', yeni, neden: 'açılmadı', now });
    expect(back).toMatchObject({ durum: 'geri-dondu', basarisiz: [BUILD_NEW] });
    // Kanal hâlâ aynı derlemeyi gösteriyor: durum geri dönüşü söylemeye devam eder
    expect(nextStatus(back, { type: 'kontrol', plan: null, manifest: { build: BUILD_NEW, version: '0.2.0' }, now }).durum).toBe('geri-dondu');
    // İnternet yok: hata değil, son denetimin sonucu
    const off = nextStatus(back, { type: 'kontrol-hata', mesaj: 'internet yok', now });
    expect(off.durum).toBe('geri-dondu');
    expect(off.sonHata.mesaj).toBe('internet yok');
    expect(nextStatus(s, { type: 'mod', mode: 'kapali' }).durum).toBe('kapali');
  });

  it('indirme klasörü ve güncelleme kopyaları seyreltilir', async () => {
    const { staleDownloads, oldUpdateBackups, backupName } = await load('guncelle.mjs');
    expect(staleDownloads(['lafpos-app-1.zip', 'lafpos-app-2.zip', 'x.part', 'node-v1-win-x64.zip'], 2)).toEqual(['lafpos-app-1.zip', 'x.part']);
    const files = Array.from({ length: 7 }, (_, i) => ({ name: `lafpos-guncelleme-${i}.db`, at: i }));
    expect(oldUpdateBackups([...files, { name: 'lafpos-2026-11-20.db', at: 0 }], 5)).toEqual(['lafpos-guncelleme-1.db', 'lafpos-guncelleme-1.db-wal', 'lafpos-guncelleme-0.db', 'lafpos-guncelleme-0.db-wal']);
    expect(backupName(BUILD_NEW, new Date(2026, 10, 21, 3, 4, 5).getTime())).toBe(`lafpos-guncelleme-${BUILD_NEW}-2026-11-21-030405.db`);
  });
});

describe('güncelleme: arşiv ve kanal', () => {
  it('zip yazılıp okunur; klasör dışına çıkan ad reddedilir', async () => {
    const { zipFiles, extractZip, readZip } = await load('arsiv.mjs');
    const zip = zipFiles([
      { name: 'a.txt', data: Buffer.from('merhaba') },
      { name: 'alt/b.bin', data: Buffer.alloc(5000, 7) },
    ]);
    expect(readZip(zip).map((e: any) => e.name)).toEqual(['a.txt', 'alt/b.bin']);
    const dir = mkdtempSync(join(tmpdir(), 'lafpos-zip-'));
    try {
      expect(extractZip(zip, dir)).toEqual(['a.txt', 'alt/b.bin']);
      expect(readFileSync(join(dir, 'alt/b.bin')).equals(Buffer.alloc(5000, 7))).toBe(true);
      expect(() => zipFiles([{ name: '../x', data: Buffer.from('') }])).toThrow();
      expect(() => extractZip(zip, dir, () => '../dışarı')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.tar.gz okunur (better-sqlite3 arşivi biçimi)', async () => {
    const { readTarGz } = await load('arsiv.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'lafpos-tar-'));
    try {
      mkdirSync(join(dir, 'build/Release'), { recursive: true });
      writeFileSync(join(dir, 'build/Release/better_sqlite3.node'), Buffer.from('MZikili'));
      // macOS'un tar'ı genişletilmiş öznitelikleri ayrı "._" girdisi yazar; gerçek arşiv Linux'ta üretilir
      execFileSync('tar', ['-czf', join(dir, 'x.tgz'), '-C', dir, 'build/Release/better_sqlite3.node'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const entries = readTarGz(readFileSync(join(dir, 'x.tgz')));
      expect(entries.map((e: any) => e.name)).toEqual(['build/Release/better_sqlite3.node']);
      expect(entries[0].data.toString()).toBe('MZikili');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kanalın manifesti güncelleyicinin okuduğu biçimde; sürüm sabitleri derlemeyle aynı', async () => {
    const { manifestFor } = await load('kanal.mjs');
    const { parseManifest } = await load('guncelle.mjs');
    const { NODE_VERSION, NODE_SHA256, sqliteSha256 } = await load('surumler.mjs');
    const zip = Buffer.from('zip');
    const m = manifestFor({ build: BUILD_NEW, commit: 'abc', version: '0.2.0', zip, sqlite: '12.11.1' });
    const p = parseManifest(m, 'https://lafpos.vercel.app/guncelleme/surum.json');
    expect(p).toMatchObject({ build: BUILD_NEW, app: { sha256: sha(zip), size: 3 }, node: { version: NODE_VERSION, sha256: NODE_SHA256 }, sqlite: { sha256: sqliteSha256('12.11.1') } });
    expect(() => sqliteSha256('0.0.1')).toThrow(/SQLITE_SHA256/);
    // Kurulu better-sqlite3'ün özeti tabloda olmalı: yoksa kurulum ve kanal derlenmez
    const installed = JSON.parse(readFileSync(new URL('node_modules/better-sqlite3/package.json', root), 'utf8')).version;
    expect(sqliteSha256(installed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('kanal sabit adreslerde; Vercel /guncelleme/ altını sayfaya çevirmez', async () => {
    const { MANIFEST_URLS } = await load('guncelle.mjs');
    expect(MANIFEST_URLS).toEqual(['https://lafpos.laffogato.net/guncelleme/surum.json', 'https://lafpos.vercel.app/guncelleme/surum.json']);
    const vercel = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));
    expect(vercel.buildCommand).toMatch(/npm run kanal$/);
    const spa = vercel.rewrites.find((r: any) => r.destination === '/index.html');
    const re = new RegExp(`^${spa.source}$`);
    expect(re.test('/guncelleme/surum.json')).toBe(false);
    expect(re.test('/yonetim/ayarlar')).toBe(true);
  });
});

// ─── Kurulum akışı ───────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(opts: { dayOpen?: boolean; healthy?: boolean; zipSha?: string; redirect?: string } = {}) {
  const { zipFiles } = await load('arsiv.mjs');
  const { createUpdater } = await load('guncelle.mjs');
  const base = mkdtempSync(join(tmpdir(), 'lafpos-guncelleme-'));
  dirs.push(base);
  const installDir = join(base, 'Program Files', 'LafPOS');
  const home = join(base, 'ProgramData', 'LafPOS');
  const app = join(installDir, 'app');
  const pkg = (build: number) => JSON.stringify({ name: 'lafpos', version: '0.2.0', build, node: '24.22.3', nodeAbi: '137', sqlite: '12.11.1' });
  mkdirSync(join(app, 'server'), { recursive: true });
  mkdirSync(join(app, 'node_modules/better-sqlite3/build/Release'), { recursive: true });
  writeFileSync(join(app, 'package.json'), pkg(BUILD_OLD));
  writeFileSync(join(app, 'bekci.mjs'), '// eski');
  writeFileSync(join(app, 'server/index.mjs'), '// eski');
  writeFileSync(join(app, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'ikili');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'lafpos.db'), 'veritabanı');

  const zip = zipFiles([
    { name: 'package.json', data: Buffer.from(pkg(BUILD_NEW)) },
    { name: 'bekci.mjs', data: Buffer.from('// yeni') },
    { name: 'server/index.mjs', data: Buffer.from('// yeni') },
  ]);
  const surum = manifest({ app: { file: `lafpos-app-${BUILD_NEW}.zip`, sha256: opts.zipSha ?? sha(zip), size: zip.length } });
  const requests: string[] = [];
  let trialRunning = false;
  const fetchImpl = async (url: string) => {
    requests.push(url);
    if (url.endsWith('/api/kasa/guncelleme-durumu')) return Response.json({ dayOpen: opts.dayOpen ?? false });
    if (url.endsWith('/api/health')) {
      if (!trialRunning) throw new Error('ECONNREFUSED');
      return Response.json({ ok: true, build: opts.healthy === false ? BUILD_OLD : BUILD_NEW });
    }
    if (url === 'https://kanal.test/guncelleme/surum.json') {
      if (opts.redirect) return new Response(null, { status: 302, headers: { location: opts.redirect } });
      return Response.json(surum, { headers: { etag: '"1"' } });
    }
    if (url === `https://kanal.test/guncelleme/lafpos-app-${BUILD_NEW}.zip`) return new Response(new Uint8Array(zip));
    return new Response('yok', { status: 404 });
  };
  const log: string[] = [];
  const events: string[] = [];
  const exits: number[] = [];
  const spawnTrial = () => {
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    trialRunning = true;
    events.push('deneme');
    child.stdin = Object.assign(new EventEmitter(), {
      write: () => {
        trialRunning = false;
        child.exitCode = 0;
        setTimeout(() => child.emit('exit', 0), 10);
        return true;
      },
    });
    return child;
  };
  const updater = createUpdater({
    installDir,
    home,
    log: (l: string) => log.push(l),
    port: () => 4000,
    mode: () => 'otomatik',
    server: {
      stop: async () => {
        events.push('durdur');
      },
      start: () => {
        events.push('başlat');
      },
    },
    exit: (code: number) => exits.push(code),
    manifestUrls: ['https://kanal.test/guncelleme/surum.json'],
    fetch: fetchImpl,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    platform: 'win32',
    nodeVersion: '24.22.3',
    execPath: process.execPath,
    healthTimeoutMs: 1500,
    verifyBinary: () => undefined,
    spawnTrial,
  });
  const status = () => JSON.parse(readFileSync(join(home, 'guncelleme/durum.json'), 'utf8'));
  return { updater, installDir, home, app, log, events, exits, requests, status };
}

describe('güncelleme: kurulum akışı', () => {
  it('gün kapalıyken: yedek, klasör değişimi, deneme; başarıda bekçi 75 koduyla yeniden açılır', async () => {
    const t = await setup();
    t.updater.start();
    expect(t.status()).toMatchObject({ durum: 'guncel', kurulu: { build: BUILD_OLD } });
    await t.updater.check();
    expect(JSON.parse(readFileSync(join(t.app, 'package.json'), 'utf8')).build).toBe(BUILD_NEW);
    expect(readFileSync(join(t.app, 'bekci.mjs'), 'utf8')).toBe('// yeni');
    // Yerel modül eskisinden taşındı (Node ve better-sqlite3 değişmedi: açık kaynaklara istek yok)
    expect(readFileSync(join(t.app, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'utf8')).toBe('ikili');
    expect(t.requests.some((u) => u.includes('nodejs.org') || u.includes('github.com'))).toBe(false);
    expect(readFileSync(join(t.installDir, 'app.eski/bekci.mjs'), 'utf8')).toBe('// eski');
    const backups = readdirSync(join(t.home, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(new RegExp(`^lafpos-guncelleme-${BUILD_NEW}-.*\\.db$`));
    expect(t.events).toEqual(['durdur', 'deneme']);
    expect(t.exits).toEqual([75]);
    expect(t.status()).toMatchObject({ durum: 'guncel', mesaj: 'Güncellendi', kurulu: { build: BUILD_NEW } });
  });

  it('yeni sürüm açılmazsa eski klasöre dönülür, sunucu yeniden açılır, o derleme bir daha denenmez', async () => {
    const t = await setup({ healthy: false });
    t.updater.start();
    await t.updater.check();
    expect(JSON.parse(readFileSync(join(t.app, 'package.json'), 'utf8')).build).toBe(BUILD_OLD);
    expect(readFileSync(join(t.app, 'bekci.mjs'), 'utf8')).toBe('// eski');
    expect(existsSync(join(t.installDir, 'app.eski'))).toBe(false);
    expect(t.events).toEqual(['durdur', 'deneme', 'başlat']);
    expect(t.exits).toEqual([]);
    expect(t.status()).toMatchObject({ durum: 'geri-dondu', basarisiz: [BUILD_NEW] });
    // Sonraki denetim aynı derlemeyi indirip kurmaya çalışmaz
    const before = t.requests.length;
    await t.updater.check();
    expect(t.requests.slice(before).filter((u) => u.endsWith('.zip') || u.includes('guncelleme-durumu'))).toEqual([]);
    expect(t.status().durum).toBe('geri-dondu');
  });

  it('gün açıkken kurulmaz: indirilir ve "gün kapanınca" bekler', async () => {
    const t = await setup({ dayOpen: true });
    t.updater.start();
    await t.updater.check();
    expect(t.events).toEqual([]);
    expect(JSON.parse(readFileSync(join(t.app, 'package.json'), 'utf8')).build).toBe(BUILD_OLD);
    expect(t.status()).toMatchObject({ durum: 'bekliyor', yeni: { build: BUILD_NEW } });
    expect(existsSync(join(t.home, `guncelleme/indirilen/lafpos-app-${BUILD_NEW}.zip`))).toBe(true);
  });

  it('özet tutmazsa kurulmaz ve dosya saklanmaz', async () => {
    const t = await setup({ zipSha: 'b'.repeat(64) });
    t.updater.start();
    await t.updater.check();
    expect(t.events).toEqual([]);
    expect(t.status().durum).toBe('hata');
    expect(existsSync(join(t.home, `guncelleme/indirilen/lafpos-app-${BUILD_NEW}.zip`))).toBe(false);
  });

  it('başka hosta yönlendirme reddedilir; kanala ulaşılamaması kasayı durdurmaz', async () => {
    const t = await setup({ redirect: 'https://evil.example/surum.json' });
    t.updater.start();
    await t.updater.check();
    expect(t.requests).not.toContain('https://evil.example/surum.json');
    expect(t.status()).toMatchObject({ durum: 'guncel' });
    expect(t.status().sonHata.mesaj).toMatch(/yönlendirme/);
    expect(t.events).toEqual([]);
  });
});
