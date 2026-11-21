// Gerçek Windows'ta kurulum ve otomatik güncelleme denemesi (.github/workflows/windows.yml, yönetici olarak).
// Kurulum dosyası önce sessiz kurulur (/S); bu betik sonra:
//   1. Sunucunun "LafPOS Sunucu" göreviyle açıldığını ve sağlığını (derleme numarası) denetler.
//   2. Yerel bir güncelleme kanalı kurar (bir sonraki derleme, Node'un başka bir 24.x sürümüyle) ve ayarlar.env'e
//      LAFPOS_GUNCELLEME_KANAL yazar: bekçi denetler, indirir, gün kapalıyken kurar, yeni sürümü dener, 75 koduyla
//      çıkar; baslat.cmd node.yeni'yi node'un yerine koyup bekçiyi yeniden açar (app ↔ app.eski, node.yeni).
//   3. Bozuk bir derleme yayımlar (sunucusu açılmaz): kurulur, açılmaz, eski sürüme dönülür ("geri-dondu").
// Başarısızlıkta sunucu ve bekçi günlüğünün sonu yazılır.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { extractZip, zipFiles } from './arsiv.mjs';
import { ROOT } from './paket.mjs';
import { NODE_VERSION } from './surumler.mjs';

const INSTALL = join(process.env.ProgramFiles || 'C:\\Program Files', 'LafPOS');
const HOME = join(process.env.ProgramData || 'C:\\ProgramData', 'LafPOS');
const ENV_FILE = join(HOME, 'ayarlar.env');
const PORT = 4000;
const KANAL_PORT = 8765;
const WEB = join(ROOT, 'dist', 'web');
const KANAL = join(WEB, 'guncelleme');

const step = (s) => console.log(`\n▸ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(file, n = 60) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '(yok)';
  }
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  const logs = join(HOME, 'logs');
  if (existsSync(logs)) for (const f of readdirSync(logs)) console.error(`\n--- ${f} ---\n${tail(join(logs, f))}`);
  console.error(`\n--- guncelleme/durum.json ---\n${tail(join(HOME, 'guncelleme', 'durum.json'), 40)}`);
  process.exit(1);
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function until(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) fail(`${label}: ${Math.round(timeoutMs / 1000)} sn içinde olmadı`);
    await sleep(2000);
  }
}

const installedBuild = () => JSON.parse(readFileSync(join(INSTALL, 'app', 'package.json'), 'utf8')).build;
const status = () => {
  try {
    return JSON.parse(readFileSync(join(HOME, 'guncelleme', 'durum.json'), 'utf8'));
  } catch {
    return null;
  }
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** dist/web'i (güncelleme kanalı dahil) yalnız bu bilgisayara sunar */
function serveWeb() {
  const types = { '.json': 'application/json', '.zip': 'application/zip' };
  const server = createServer((req, res) => {
    const path = join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (relative(WEB, path).startsWith('..') || !existsSync(path) || statSync(path).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(KANAL_PORT, '127.0.0.1', () => ok(server)));
}

/** Node'un başka bir 24.x sürümü (Windows x64 zip'i olan): node.yeni değişimi denensin */
async function otherNode() {
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const major = NODE_VERSION.split('.')[0];
  const v = index.map((r) => r.version.slice(1)).find((x) => x.startsWith(`${major}.`) && x !== NODE_VERSION && index.find((r) => r.version === `v${x}`).files.includes('win-x64-zip'));
  if (!v) fail(`Node ${major}.x'in başka bir sürümü bulunamadı`);
  const sums = await (await fetch(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.endsWith(`node-v${v}-win-x64.zip`));
  return { version: v, sha256: line.split(/\s+/)[0] };
}

/** Kanalın son derlemesinden sunucusu açılmayan bir derleme üretir (geri dönüş denemesi) */
function publishBroken(build) {
  const m = JSON.parse(readFileSync(join(KANAL, 'surum.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'lafpos-bozuk-'));
  extractZip(readFileSync(join(KANAL, m.app.file)), dir);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  const entries = files.map((name) => {
    let data = readFileSync(join(dir, name));
    if (name === 'package.json') data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), build }, null, 2));
    if (name === 'server/index.mjs') data = Buffer.from("console.error('bozuk derleme (deneme)'); process.exit(1);\n");
    return { name, data };
  });
  const zip = zipFiles(entries);
  const file = `lafpos-app-${build}.zip`;
  writeFileSync(join(KANAL, file), zip);
  writeFileSync(join(KANAL, 'surum.json'), JSON.stringify({ ...m, build, date: new Date(build * 1000).toISOString(), app: { file, sha256: sha(zip), size: zip.length } }, null, 2));
}

// ─── 1. Sessiz kurulumdan sonra ─────────────────────────────────────────────

step('Sessiz kurulum: dosyalar, görev, ayar dosyası');
for (const f of [join(INSTALL, 'node', 'node.exe'), join(INSTALL, 'app', 'bekci.mjs'), join(INSTALL, 'baslat.cmd'), ENV_FILE]) if (!existsSync(f)) fail(`kurulumda yok: ${f}`);
const task = execFileSync('schtasks', ['/Query', '/TN', 'LafPOS Sunucu', '/FO', 'LIST'], { encoding: 'utf8' });
console.log(task.split(/\r?\n/).filter((l) => /Görev|TaskName|Status|Durum/i.test(l)).join('\n'));
const fw = execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all'], { encoding: 'utf8' });
if (!/LafPOS/i.test(fw)) fail('güvenlik duvarı kuralı yok');
const b0 = installedBuild();

step(`Sunucu görevle açılıyor (derleme ${b0})`);
const h0 = await until('sunucu açılmadı', health, 180_000);
if (h0.build !== b0) fail(`sağlık denetimi derlemeyi ${h0.build} dedi, beklenen ${b0}`);

// ─── 2. Güncelleme: bir sonraki derleme, Node da değişir ────────────────────

const b1 = b0 + 100;
step(`Yerel kanal: derleme ${b1}`);
execFileSync(process.execPath, [join(ROOT, 'scripts', 'kasa', 'windows', 'kurulum', 'kanal.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, LAFPOS_BUILD: String(b1) } });
const node = await otherNode();
const m1 = JSON.parse(readFileSync(join(KANAL, 'surum.json'), 'utf8'));
writeFileSync(join(KANAL, 'surum.json'), JSON.stringify({ ...m1, node: { ...m1.node, version: node.version, sha256: node.sha256 } }, null, 2));
console.log(`  Node ${NODE_VERSION} → ${node.version}`);
const server = await serveWeb();
mkdirSync(HOME, { recursive: true });
appendFileSync(ENV_FILE, `\r\nLAFPOS_GUNCELLEME_KANAL=http://127.0.0.1:${KANAL_PORT}/guncelleme/surum.json\r\n`);

step('Bekçi indirir, gün kapalıyken kurar, dener, 75 koduyla yeniden açılır (node.yeni değişimi)');
await until(
  `derleme ${b1} açılmadı`,
  async () => {
    const h = await health();
    return h?.build === b1 ? h : null;
  },
  600_000,
);
if (installedBuild() !== b1) fail('app klasörü yeni derlemeyi taşımıyor');
if (!existsSync(join(INSTALL, 'app.eski'))) fail('app.eski yok (eski sürüm saklanmadı)');
// Sağlık denetimi yeni sürümün deneme açılışında da (node.yeni ile) geçer: baslat.cmd'nin Node değişimini bekle
const nodeOf = () => {
  try {
    return execFileSync(join(INSTALL, 'node', 'node.exe'), ['-v'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const nodeNow = await until(`node.exe v${node.version} olmadı (node.yeni yerine geçmedi)`, () => (nodeOf() === `v${node.version}` ? nodeOf() : null), 90_000);
if (existsSync(join(INSTALL, 'node.yeni'))) fail('node.yeni kaldı');
const s1 = await until('durum "Güncellendi" olmadı', () => (status()?.mesaj === 'Güncellendi' ? status() : null), 60_000);
console.log(`  ${s1.mesaj} · kurulu ${JSON.stringify(s1.kurulu)} · Node ${nodeNow}`);

// ─── 3. Bozuk derleme: eski sürüme dönülür ──────────────────────────────────

const b2 = b1 + 100;
step(`Bozuk derleme ${b2}: kurulur, açılmaz, ${b1}'e dönülür`);
publishBroken(b2);
// ayarlar.env değişince bekçi hemen denetler
appendFileSync(ENV_FILE, `# deneme ${Date.now()}\r\n`);
await until('geri dönülmedi', () => (status()?.durum === 'geri-dondu' ? status() : null), 600_000);
const h2 = await until('eski sürüm yeniden açılmadı', health, 120_000);
if (h2.build !== b1 || installedBuild() !== b1) fail(`geri dönüşten sonra derleme ${h2.build}/${installedBuild()}, beklenen ${b1}`);
if (!(status()?.basarisiz ?? []).includes(b2)) fail('bozuk derleme "bir daha denenmeyecek" listesine girmedi');
console.log(`  ${status().mesaj}`);

server.close();
console.log('\n✓ Gerçek Windows kurulumu, güncelleme (app ↔ app.eski, node.yeni, 75 kodu) ve geri dönüş tamam');
process.exit(0);
