// LafPOS Windows kurulum dosyasını derler: dist/windows/LafPOS-Kurulum-<sürüm>.exe
// Sunucu esbuild ile tek dosyaya paketlenir; yanına Windows için Node (LTS), better-sqlite3'ün win32-x64
// ikilisi, derlenmiş arayüz, göçler ve menü anlık görüntüsü konur; makensis lafpos.nsi ile kurulumu üretir.
// Kurulumdan önce aynı paket açılıp denenir (giriş, açılış verisi, arayüz, günlük): Windows'ta pakettekinin aynısı
// (indirilen node.exe ve better-sqlite3'ün Windows ikilisi), macOS ve Linux'ta bu bilgisayarın Node'u ve ikilisiyle.
// Gerekenler: makensis (macOS: brew install makensis, Linux: apt install nsis, Windows: NSIS 3; PATH'te değilse
// Program Files\NSIS'te aranır, MAKENSIS ile de verilir). CI'da .github/workflows/windows.yml, kasaya giden dosyalar
// değişince koşar.
// Kullanım: npm run kurulum:windows            arayüzü derler, dener, kurulumu üretir
//           npm run kurulum:windows -- --hizli arayüzü yeniden derlemez, denemeyi atlar
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { envSample, heapLimitMb } from './ayarlar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
/**
 * Windows'a giden Node: 24 LTS'in son güvenlik sürümü. Değişince üçü birlikte: NODE_ABI nodejs.org/dist/index.json'da
 * "modules" (better-sqlite3'ün indirilen ikilisi buna göre), NODE_SHA256 o sürümün SHASUMS256.txt'sinde win-x64.zip
 */
const NODE_VERSION = '24.22.3';
const NODE_ABI = '137';
const NODE_SHA256 = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f';
const WIN = process.platform === 'win32';
const OUT = join(ROOT, 'dist/windows');
const STAGE = join(OUT, 'stage');
const APP = join(STAGE, 'app');
const CACHE = join(ROOT, 'node_modules/.cache/lafpos-windows');
const fast = process.argv.includes('--hizli');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const step = (s) => console.log(`\n▸ ${s}`);
const run = (cmd, args, env) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env: env && { ...process.env, ...env } });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
/**
 * Arşiv açıcı. Windows'ta System32'deki tar (bsdtar: .tar.gz ve .zip açar); PATH'teki Git tar'ı "C:\…" yolunu uzak
 * makine adresi sanıp düşer
 */
const TAR = WIN ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
/** Windows'ta silinen klasördeki dosyayı kapanmakta olan süreç bir an tutabilir (EBUSY): birkaç kez denenir */
const rmTree = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

async function download(url, file) {
  if (existsSync(file)) return file;
  console.log(`  indiriliyor: ${url}`);
  mkdirSync(dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${file}.part`, file);
  return file;
}

/** Dosya Windows x64 ikilisi mi (MZ + PE başlığı, makine 0x8664) */
function assertWinX64(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', 0, 2) !== 'MZ' || b.toString('latin1', pe, pe + 4) !== 'PE\0\0' || b.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error(`${file} Windows x64 ikilisi değil`);
  }
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function bundleServer() {
  step('Sunucu tek dosyaya paketleniyor');
  await build({
    entryPoints: [join(ROOT, 'server/index.ts')],
    outfile: join(APP, 'server/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(ROOT, 'tsconfig.server.json'),
    external: ['better-sqlite3'],
    // Paketin içindeki CommonJS bağımlılıklar require'ı bulsun
    banner: { js: "import { createRequire as __lafposRequire } from 'node:module'; const require = __lafposRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  // Sunucu ROOT'u paketin bir üstü sayar (server/env.ts): göçler, menü ve arayüz app/ altında
  cpSync(join(ROOT, 'drizzle'), join(APP, 'drizzle'), { recursive: true });
  mkdirSync(join(APP, 'server/db'), { recursive: true });
  cpSync(join(ROOT, 'server/db/menu-snapshot.json'), join(APP, 'server/db/menu-snapshot.json'));
  // Tarayıcı demosu (dist/web/demo) yalnız Vercel'de; kasaya girmez
  cpSync(join(ROOT, 'dist/web'), join(APP, 'dist/web'), { recursive: true, filter: (src) => !src.startsWith(join(ROOT, 'dist/web/demo')) });
  // Bekçi ve onun ayar kuralları (bellek sınırı)
  for (const f of ['bekci.mjs', 'ayarlar.mjs']) cpSync(join(HERE, f), join(APP, f));
  writeFileSync(join(APP, 'package.json'), `${JSON.stringify({ name: 'lafpos', version: pkg.version, private: true, type: 'module' }, null, 2)}\n`);
}

async function nativeSqlite() {
  step('better-sqlite3 (win32-x64, Node ABI ' + NODE_ABI + ')');
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
    const src = join(ROOT, 'node_modules', name);
    cpSync(src, join(APP, 'node_modules', name), { recursive: true, filter: (p) => !/^[\\/](build|deps|src|test)([\\/]|$)/.test(p.slice(src.length)) });
  }
  const { version } = JSON.parse(readFileSync(join(ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8'));
  const name = `better-sqlite3-v${version}-node-v${NODE_ABI}-win32-x64.tar.gz`;
  const tgz = await download(`https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}`, join(CACHE, name));
  const dir = join(APP, 'node_modules/better-sqlite3');
  run(TAR, ['-xzf', tgz, '-C', dir]);
  assertWinX64(join(dir, 'build/Release/better_sqlite3.node'));
}

async function windowsNode() {
  step(`Node ${NODE_VERSION} (win-x64)`);
  const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
  const sums = await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, join(CACHE, `SHASUMS256-v${NODE_VERSION}.txt`));
  const zip = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`, join(CACHE, zipName));
  const want = readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.trim().endsWith(`  ${zipName}`))
    ?.split(/\s+/)[0];
  // Hem nodejs.org'un listesi hem betikteki sabit: sürüm yükseltilirken özet de bilerek değişir
  if (want !== NODE_SHA256 || sha256(zip) !== NODE_SHA256) {
    rmSync(zip, { force: true });
    throw new Error(`${zipName} SHA-256 özeti tutmadı (nodejs.org: ${want ?? 'yok'}, betik: ${NODE_SHA256}); dosya silindi, yeniden deneyin`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'lafpos-node-'));
  const members = [`node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`];
  if (process.platform === 'linux') run('unzip', ['-q', '-o', zip, ...members, '-d', tmp]);
  else run(TAR, ['-xf', zip, '-C', tmp, ...members]);
  mkdirSync(join(STAGE, 'node'), { recursive: true });
  for (const m of members) cpSync(join(tmp, m), join(STAGE, 'node', m.split('/').pop()));
  rmTree(tmp);
  assertWinX64(join(STAGE, 'node/node.exe'));
}

function windowsFiles() {
  step('Kısayollar, yönetim betiği, notlar');
  cpSync(join(ROOT, 'scripts/kasa/windows/LafPOS-Kasa.bat'), join(STAGE, 'LafPOS-Kasa.bat'));
  cpSync(join(HERE, 'lafpos.ico'), join(STAGE, 'lafpos.ico'));
  writeFileSync(join(STAGE, 'yonet.ps1'), crlf(readFileSync(join(HERE, 'yonet.ps1'), 'utf8')));
  // Eski Not Defteri UTF-8'i BOM'la tanır
  writeFileSync(join(STAGE, 'BENIOKU.txt'), `\uFEFF${crlf(readFileSync(join(HERE, 'BENIOKU.txt'), 'utf8'))}`);
  writeFileSync(join(STAGE, 'ayarlar.env.ornek'), `\uFEFF${crlf(envSample(readFileSync(join(ROOT, '.env.example'), 'utf8')))}`);
}

/**
 * Paketi bekçi üzerinden açıp dener. Windows'ta kurulumun taşıyacağı ikili çiftiyle (paketteki node.exe ve
 * better-sqlite3'ün indirilen Windows ikilisi): gerçekten yüklenen, kafeye gidenin aynısıdır. macOS ve Linux'ta
 * Windows ikilisi yüklenemez: bu bilgisayarın Node'u ve kendi sqlite ikilisi konur, gerisi aynı paket
 */
async function smokeTest() {
  step(`Paket deneniyor (bekçi, göçler, ilk kurulum, giriş, arayüz, günlük; ${WIN ? `paketteki Node ${NODE_VERSION}` : `bu bilgisayarın Node'u ${process.versions.node}`})`);
  const tmp = mkdtempSync(join(tmpdir(), 'lafpos-deneme-'));
  const home = join(tmp, 'veri');
  try {
    cpSync(APP, join(tmp, 'app'), { recursive: true });
    if (!WIN) cpSync(join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), join(tmp, 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const node = WIN ? join(STAGE, 'node', 'node.exe') : process.execPath;
    const env = { ...process.env, LAFPOS_HOME: home, LAFPOS_PORT: String(port), LAFPOS_HOST: '127.0.0.1', LAFPOS_NO_JOBS: '1', ...(WIN ? { LAFPOS_BEKCI_STDIN: '1' } : {}) };
    // Bellek sınırı ayar dosyasından gelsin: gerçek ortam değişkeni dosyadakini ezerdi
    delete env.LAFPOS_MAX_HEAP_MB;
    const child = spawn(node, [join(tmp, 'app/bekci.mjs')], {
      cwd: tmp,
      env,
      // Windows'ta sinyal yok (kill süreci sonlandırır, bekçi sunucuyu kapatamaz): durdurma standart girdiden
      stdio: [WIN ? 'pipe' : 'ignore', 'ignore', 'ignore'],
    });
    const fail = (msg) => {
      const log = existsSync(join(home, 'logs/sunucu.log')) ? readFileSync(join(home, 'logs/sunucu.log'), 'utf8') : '(günlük yok)';
      throw new Error(`${msg}\n--- sunucu.log ---\n${log}`);
    };
    try {
      for (let i = 0; ; i++) {
        // İlk açılış göçleri ve kurulum verisini yazar; Windows'ta virüs taraması yeni ikilileri bir süre tutabilir
        if (i > 300) fail('Sunucu 60 sn içinde açılmadı');
        const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const html = await (await fetch(`${base}/`)).text();
      if (!html.includes('id="root"')) fail('Arayüz sayfası gelmedi');
      if (!(await (await fetch(`${base}/yonetim/genel`)).text()).includes('id="root"')) fail('Derin bağlantı arayüze düşmedi');
      const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
      if (!asset || !(await fetch(`${base}${asset}`)).ok) fail('Arayüz dosyaları gelmedi');
      // Arayüzün yedek sayfası API'yi yutmasın: bilinmeyen uç JSON hata döner (girişsiz 401)
      const unknown = await fetch(`${base}/api/olmayan-uc`);
      if (unknown.ok || !unknown.headers.get('content-type')?.includes('json')) fail(`Bilinmeyen API ucu JSON hata vermedi (${unknown.status})`);
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '1897' }) });
      if (!login.ok) fail(`Örnek PIN'le giriş olmadı (${login.status})`);
      const { token } = await login.json();
      const boot = await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } });
      const data = boot.ok ? await boot.json() : null;
      if (!data?.products?.length) fail('Açılış verisinde ürün yok (menü anlık görüntüsü yüklenmedi)');
      console.log(`  tamam: ${data.products.length} ürün, ${data.tables?.length ?? 0} masa`);
      const logText = () => (existsSync(join(home, 'logs/sunucu.log')) ? readFileSync(join(home, 'logs/sunucu.log'), 'utf8') : '');
      // Ayarsız bellek sınırı bilgisayarın belleğinden (dörtte biri, 1024-4096 MB)
      const heapDefault = heapLimitMb(undefined, totalmem());
      if (!logText().includes(`bellek sınırı ${heapDefault} MB`)) fail(`Bekçi varsayılan bellek sınırını (${heapDefault} MB) yazmadı`);

      // ayarlar.env kaydedilince bekçi sunucuyu yeni ayarlarla (bellek sınırı dahil) yeniden başlatır
      writeFileSync(join(home, 'ayarlar.env'), '\uFEFF# deneme\r\nLAFPOS_SESSION_HOURS=13\r\nLAFPOS_MAX_HEAP_MB=768\r\n');
      for (let i = 0; ; i++) {
        // Bekçi ayar dosyasına 5 sn'de bir bakar; sunucu kapanıp yeniden açılır
        if (i > 200) fail('ayarlar.env değişince sunucu 40 sn içinde yeniden başlamadı');
        const restarted = logText().split('LafPOS sunucusu hazır').length > 2;
        if (restarted && (await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!logText().includes('bellek sınırı 768 MB')) fail('ayarlar.env\'deki LAFPOS_MAX_HEAP_MB bekçiye geçmedi');
      console.log(`  tamam: ayar değişince sunucu yeni ayarlarla açıldı (bellek sınırı ${heapDefault} → 768 MB)`);
    } finally {
      await stopWatchdog(child);
    }
    const log = readFileSync(join(home, 'logs/sunucu.log'), 'utf8');
    if (!log.includes('LafPOS sunucusu hazır')) throw new Error(`Günlükte sunucunun açıldığı yazmıyor:\n${log}`);
    for (const f of ['lafpos.db', 'secret.key']) if (!existsSync(join(home, f))) throw new Error(`${f} veri klasöründe yok`);
    // Bekçi durunca sunucu veritabanını düzgün kapatır: WAL ana dosyaya yazılır, -wal dosyası kalmaz
    if (existsSync(join(home, 'lafpos.db-wal'))) throw new Error(`Sunucu kapanırken veritabanını kapatmadı (lafpos.db-wal kaldı):\n${log}`);
    console.log('  tamam: bekçi durunca veritabanı düzgün kapandı');
  } finally {
    rmTree(tmp);
  }
}

/** Bekçiyi düzgün durdurur (sunucu veritabanını kapatır); süresinde kapanmazsa sonlandırır */
async function stopWatchdog(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  if (WIN) {
    child.stdin.on('error', () => {});
    child.stdin.write('kapat\n');
  } else child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

/** makensis: MAKENSIS, PATH, Windows'ta NSIS'in varsayılan klasörleri */
function findMakensis() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS;
  if (WIN) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      const exe = base && join(base, 'NSIS', 'makensis.exe');
      if (exe && existsSync(exe)) return exe;
    }
  }
  return 'makensis';
}

function makeInstaller() {
  step('Kurulum dosyası (makensis)');
  const outfile = join(OUT, `LafPOS-Kurulum-${pkg.version}.exe`);
  const makensis = findMakensis();
  // macOS ve Linux'ta makensis Türkçe harfleri ancak UTF-8 yereliyle okur ("Bad text encoding")
  const utf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
  const locale = process.platform === 'win32' || utf8 ? undefined : { LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' };
  run(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', `-DVERSION=${pkg.version}`, `-DSTAGE=${STAGE}`, `-DOUTFILE=${outfile}`, join(HERE, 'lafpos.nsi')], locale);
  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ ${outfile}\n  ${mb} MB · SHA-256 ${sha256(outfile)}`);
}

if (!fast || !existsSync(join(ROOT, 'dist/web/index.html'))) {
  step('Arayüz derleniyor');
  run(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build']);
}
rmTree(STAGE);
await bundleServer();
await nativeSqlite();
await windowsNode();
windowsFiles();
if (!fast) await smokeTest();
makeInstaller();
