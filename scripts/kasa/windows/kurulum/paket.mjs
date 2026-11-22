// Kurulumun app\ klasörünü (uygulama yükü) hazırlar: kurulum dosyası (derle.mjs) ve güncelleme kanalı (kanal.mjs) aynı
// yükü bununla kurar. Sunucu esbuild ile tek dosyaya paketlenir; yanına göçler, menü anlık görüntüsü, derlenmiş kasa
// arayüzü, bekçi ve güncelleyici, better-sqlite3'ün JavaScript dosyaları konur. better-sqlite3'ün Windows ikilisi
// (better_sqlite3.node) ve node.exe yüke girmez: kurulum onları ayrıca koyar, güncelleme yalnız değiştiklerinde açık
// kaynaklarından indirir (surumler.mjs).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ROOT_DIR } from './kurulum-yenile.mjs';
import { NODE_ABI, NODE_VERSION } from './surumler.mjs';
import { shellFiles } from './web-kurucu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../../..');
/** Bekçiyle pakete giren betikler: bekçi, ayar kuralları, güncelleyici ve arşiv yardımcıları */
export const KASA_SCRIPTS = ['bekci.mjs', 'ayarlar.mjs', 'guncelle.mjs', 'arsiv.mjs', 'geri-yukle.mjs', 'kurulum-yenile.mjs'];
/** Kasa kısayolunun güncellemeyle gelen parçaları: kaynak (bu klasöre göre) → app\ içindeki adı (CRLF yazılır) */
export const KASA_LAUNCHER = [
  ['kasa-yazici.ps1', 'kasa-yazici.ps1'],
  ['kasa-hazirla.ps1', 'kasa-hazirla.ps1'],
  ['kisayollar.ps1', 'kisayollar.ps1'],
  ['../LafPOS-Kasa.bat', 'LafPOS-Kasa.bat'],
];
/** better-sqlite3 ve yükledikleri: yalnız JavaScript (derleme klasörleri ve kaynak yok) */
const SQLITE_MODULES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
/** Yük içinde Windows ikilisinin yeri (kurulum koyar, güncelleme eskisinden ya da indirilenden taşır) */
export const SQLITE_BINARY = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

/**
 * Derlemenin numarası: HEAD commit'inin unix zamanı (sn). Aynı commit'in GitHub (kurulum dosyası) ve Vercel
 * (güncelleme kanalı) derlemesi aynı numarayı taşır; güncelleyici yalnız daha büyük numarayı kurar. LAFPOS_BUILD
 * verilirse o (git yoksa)
 */
export function buildInfo(root = ROOT) {
  const fromEnv = process.env.LAFPOS_BUILD;
  if (fromEnv) {
    if (!/^\d{9,11}$/.test(fromEnv)) throw new Error(`LAFPOS_BUILD anlaşılmadı: ${fromEnv}`);
    return { build: Number(fromEnv), commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '' };
  }
  let out;
  try {
    out = execFileSync('git', ['log', '-1', '--format=%ct %H'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    // Vercel derlemesinde git geçmişi yoksa derlemenin anı: her kanal derlemesi bir öncekinden büyük kalır (kurulum
    // dosyasıyla aynı commit'te kanal bir kez "yeni" görünür ve aynı kodu yeniden kurar; zararsız)
    if (!process.env.VERCEL) throw e;
    console.warn('git geçmişi yok; derleme numarası derlemenin anından');
    return { build: Math.floor(Date.now() / 1000), commit: process.env.VERCEL_GIT_COMMIT_SHA || '' };
  }
  const [ct, commit] = out.split(' ');
  const build = Number(ct);
  if (!Number.isInteger(build) || build <= 0) throw new Error(`git commit zamanı okunamadı: ${out}`);
  return { build, commit: commit ?? '' };
}

/** better-sqlite3'ün node_modules'taki sürümü (package-lock'tan gelen) */
export const sqliteVersion = (root = ROOT) => JSON.parse(readFileSync(join(root, 'node_modules/better-sqlite3/package.json'), 'utf8')).version;

/**
 * app\ klasörünü kurar. `webDir`: derlenmiş kasa arayüzü (Uzaktan değil); demo ve güncelleme kanalı klasörleri girmez
 * @param {{ appDir: string, webDir: string, build: number, commit: string, root?: string }} opts
 */
export async function stageApp({ appDir, webDir, build: buildNo, commit, root = ROOT }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  await build({
    entryPoints: [join(root, 'server/index.ts')],
    outfile: join(appDir, 'server/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(root, 'tsconfig.server.json'),
    external: ['better-sqlite3'],
    // Paketin içindeki CommonJS bağımlılıklar require'ı bulsun
    banner: { js: "import { createRequire as __lafposRequire } from 'node:module'; const require = __lafposRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  // Sunucu ROOT'u paketin bir üstü sayar (server/env.ts): göçler, menü ve arayüz app/ altında
  cpSync(join(root, 'drizzle'), join(appDir, 'drizzle'), { recursive: true });
  mkdirSync(join(appDir, 'server/db'), { recursive: true });
  cpSync(join(root, 'server/db/menu-snapshot.json'), join(appDir, 'server/db/menu-snapshot.json'));
  // Tarayıcı demosu (demo/) ve güncelleme kanalı (guncelleme/) yalnız Vercel'de; kasaya girmez
  const skip = ['demo', 'guncelleme'].map((d) => join(resolve(webDir), d));
  cpSync(webDir, join(appDir, 'dist/web'), { recursive: true, filter: (src) => !skip.some((d) => src === d || src.startsWith(d + sep)) });
  for (const f of KASA_SCRIPTS) cpSync(join(HERE, f), join(appDir, f));
  // Kasa kısayolunun parçaları güncellemeyle gelsin: yazıcı betiği (kısayol app\'ten çağırır) ve kısayolun kendisi (bekçi
  // açılışta kurulum klasöründekiyle değiştirir; kısayol Chrome'u açıp hemen çıktığı için çalışırken değişmez)
  for (const [from, to] of KASA_LAUNCHER) writeFileSync(join(appDir, to), readFileSync(join(HERE, from), 'utf8').replace(/\r?\n/g, '\r\n'));
  // Kurulum klasörünün kök dosyaları (kurulumdakinin aynısı, web-kurucu.mjs shellFiles): bekçi açılışta farklı olanları
  // yerine koyar (kurulum-yenile.mjs). Kaldırma betiği yalnız siteden kurulumun; güncellemeyle gelmez
  mkdirSync(join(appDir, ROOT_DIR), { recursive: true });
  for (const [name, data] of Object.entries(shellFiles(root))) if (name !== 'LafPOS-Kaldir.ps1') writeFileSync(join(appDir, ROOT_DIR, name), data);
  for (const name of SQLITE_MODULES) {
    const src = join(root, 'node_modules', name);
    cpSync(src, join(appDir, 'node_modules', name), { recursive: true, filter: (p) => !/^[\\/](build|deps|src|test)([\\/]|$)/.test(p.slice(src.length)) });
  }
  // Sunucu sürümü ve derleme numarasını buradan okur (Ayarlar ve yedek, /api/health); güncelleyici de kurulu derlemeyi
  const meta = { name: 'lafpos', version: pkg.version, private: true, type: 'module', build: buildNo, commit, node: NODE_VERSION, nodeAbi: NODE_ABI, sqlite: sqliteVersion(root) };
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}
