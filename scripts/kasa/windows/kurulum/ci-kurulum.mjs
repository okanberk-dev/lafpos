// Gerçek Windows'ta kurulum, otomatik güncelleme ve kasa penceresi denemesi (.github/workflows/windows.yml, yönetici
// olarak). Kafedeki kasanın yolunu baştan sona yürür:
//   A. Önceki sürüm: GitHub'daki son AsilPOS-Kurulum.exe (kafede kurulu olan; iş akışı indirir) sessiz kurulur (/S).
//   B. Kasa penceresi önceki sürümün Başlat menüsündeki "AsilPOS Kasa" kısayoluyla açılır (kısayolun yaptığı gibi).
//      Pencere yerel bir vekilden bağlanır (ci-vekil.mjs, ASILPOS_URL): vekil 27 Kasım öncesinin sunucusunu taklit eder
//      (arayüz dosyaları önbellek başlıksız, eski Last-Modified'la: Chrome sayfayı saklar) ve sayfaya, pencerenin gerçekten
//      gösterdiği derlemeyi bildiren küçük bir betik ekler.
//   C. Otomatik güncelleme: yerel kanaldan bu derleme (Node da değişir): bekçi indirir, gün kapalıyken kurar, dener, 75
//      koduyla çıkar; baslat.cmd node.yeni'yi yerine koyup bekçiyi yeniden açar (app ↔ app.eski).
//   D. İlk açılış yeni sürümle (27 Kasım şikâyeti: "güncellemeden sonra ilk açılışta eski sürüm, yenileyince düzeliyor"):
//      güncellemeden önce açılmış pencere kendiliğinden yeni sürüme geçer; pencere kapanıp (gece) yeni kısayolla açılınca
//      ilk sayfa yeni derlemedir ve sunucudan gelir (önbellekten değil). Program: kısayollar konsolsuz programa döndü,
//      eski bekçi yenisiyle değişti, ikinci tıklama ikinci pencere açmaz ve öne getirir, bekçi kapanan pencereyi açmaz
//      (bakım arasında açmaz), Edge kalıcı profille açılır (InPrivate değil).
//   E. Bozuk derleme: kurulur, açılmaz, eski sürüme dönülür. Sonra gece kapanmış pencere (sayfası eski sunucu gibi
//      saklanmış), yeni arayüz ve yeni kasa betiğiyle güncelleme: bekçi kendini yeniler, sabah ilk açılış yeni sürüm.
//      Bu derlemenin (artık daha eski) kurulum dosyası daha yeni kurulumun üzerine sessiz çalışınca kurmadan çıkar.
//   F. Kaldırma ve iki kurulumun eşitliği: kafedeki kaldırıcı (önceki sürümün Kaldir.exe'si) iz bırakmaz; bu derlemenin
//      kurulum dosyası ve siteden kurulum (AsilPOS-Kur.cmd, yerel kanaldan) aynı dosyaları, kısayolları, görevi, güvenlik
//      duvarını ve Uygulamalar kaydını yazar. Siteden kurulum çalışan kasanın üzerine de tamamlanır (kasa penceresi açık;
//      sunucu görevin dışında çalışırken de), program klasörü başka bir programda açıksa yarıda kalır ve eski sürüm
//      çalışmayı sürdürür (28 Kasım şikâyeti: "Kurulum yarıda kaldı: The process cannot access the file...").
//      Gün açıkken sessiz kurulum dosyası ve sessiz siteden kurulum kurmadan çıkar. Kurulum dosyasının güncelleme isteği
//      (guncelleme\istek.json) bekçiye ulaşır; otomatik güncelleme kapalıyken yok sayılır.
// Ekran görüntüleri dist/ci-ekran'a (iş akışı yükler). Başarısızlıkta sunucu ve bekçi günlüğünün sonu, vekilin son
// kayıtları ve süreçler yazılır.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZip, zipFiles } from './arsiv.mjs';
import { CI_DEPO_ANAHTARI, mainScript, startProxy } from './ci-vekil.mjs';
import { buildInfo, ROOT } from './paket.mjs';
import { NODE_VERSION } from './surumler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// İş akışının adımı pwsh'ta (PowerShell 7) koşar; pwsh PSModulePath'e kendi modül klasörlerini koyar. Buradan açılan
// Windows PowerShell 5.1 (ci-windows.ps1, kurulumların kisayollar.ps1'i, siteden kurulum) önce 7'nin modüllerini bulur ve
// Get-FileHash gibi komutları yükleyemez. Kafede kısayol, görev ve kurulum dosyası 5.1'i temiz ortamla açar: denemede de
// değişken silinir, 5.1 kendi varsayılan yolunu kurar
delete process.env.PSModulePath;
const INSTALL = join(process.env.ProgramFiles || 'C:\\Program Files', 'LafPOS'); // eski-ad: kurulu kasanın klasörü
const HOME = join(process.env.ProgramData || 'C:\\ProgramData', 'LafPOS'); // eski-ad
const ENV_FILE = join(HOME, 'ayarlar.env');
const PORT = 4000;
const KANAL_PORT = 8765;
const VEKIL_PORT = 4100;
const VEKIL = `http://127.0.0.1:${VEKIL_PORT}/`;
const WEB = join(ROOT, 'dist', 'web');
const KANAL = join(WEB, 'guncelleme');
const EKRAN = join(ROOT, 'dist', 'ci-ekran');
/** Kafede kurulu olan: GitHub'daki son sürüm (iş akışı indirir) */
const ONCEKI_EXE = process.env.ASILPOS_CI_ONCEKI || join(ROOT, 'dist', 'onceki', 'AsilPOS-Kurulum.exe');
/** Bu derlemenin kurulum dosyası (npm run kurulum:windows) */
const BU_EXE = join(ROOT, 'dist', 'windows', `AsilPOS-Kurulum-${process.env.ASILPOS_SURUM}.exe`);
const BU_DERLEME = buildInfo().build;
const MENU = join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AsilPOS');
const KASA_KISAYOLU = join(MENU, 'AsilPOS Kasa.lnk');

const step = (s) => console.log(`\n▸ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let vekil = null;
let ekranNo = 0;

function tail(file, n = 60) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '(yok)';
  }
}

/** ci-windows.ps1'in bir işlemi (JSON) */
function ps(islem, args = [], env = {}) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'ci-windows.ps1'), '-Islem', islem, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  const line = out.trim().split(/\r?\n/).at(-1) ?? '';
  return line ? JSON.parse(line) : null;
}

function ekran(ad) {
  mkdirSync(EKRAN, { recursive: true });
  ekranNo += 1;
  try {
    const r = ps('ekran', ['-Dosya', join(EKRAN, `${String(ekranNo).padStart(2, '0')}-${ad}.png`)]);
    if (r !== true) console.log(`  (${r})`);
  } catch (e) {
    console.log(`  (ekran görüntüsü alınamadı: ${e.message})`);
  }
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  const logs = join(HOME, 'logs');
  if (existsSync(logs)) for (const f of readdirSync(logs)) console.error(`\n--- ${f} ---\n${tail(join(logs, f))}`);
  console.error(`\n--- guncelleme/durum.json ---\n${tail(join(HOME, 'guncelleme', 'durum.json'), 40)}`);
  if (vekil) console.error(`\n--- vekil (son 40) ---\n${vekil.log.slice(-40).map((e) => JSON.stringify(e)).join('\n')}`);
  try {
    console.error(`\n--- süreçler ---\n${JSON.stringify(ps('surecler'), null, 2)}`);
  } catch {
    /* süreç listesi alınamadı */
  }
  ekran('hata');
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

async function until(label, fn, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) fail(`${label}: ${Math.round(timeoutMs / 1000)} sn içinde olmadı`);
    await sleep(everyMs);
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const installedBuild = () => readJson(join(INSTALL, 'app', 'package.json'))?.build ?? null;
const status = () => readJson(join(HOME, 'guncelleme', 'durum.json'));
const marker = () => readJson(join(HOME, 'guncelleme', 'kurulum-yenileme.json'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** Kurulu arayüzün ana betiği (hangi derleme) */
const appScript = () => mainScript(readFileSync(join(INSTALL, 'app', 'dist', 'web', 'index.html'), 'utf8'));
const taskExists = () => spawnSync('schtasks', ['/Query', '/TN', 'LafPOS Sunucu'], { stdio: 'ignore' }).status === 0;

/** Kurulum dosyasını sessiz çalıştırır, bitmesini bekler; sonuç çıkış kodu */
function kurKod(exe) {
  if (!existsSync(exe)) fail(`kurulum dosyası yok: ${exe}`);
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', `$p = Start-Process -FilePath '${exe}' -ArgumentList '/S' -Wait -PassThru; exit $p.ExitCode`], { stdio: 'inherit' }).status;
}
/** Kurulum dosyasını sessiz kurar (bitmesini bekler) */
function kur(exe) {
  const kod = kurKod(exe);
  if (kod !== 0) fail(`${exe} ${kod} koduyla bitti`);
}
/** Kurulum dosyasının kurmadan çıkış kodları (asilpos.nsi KOD_GUN_ACIK, KOD_YENISI_KURULU) */
const KOD_GUN_ACIK = 3;
const KOD_YENISI_KURULU = 5;
/** Kurulumun güncelleme isteği (asilpos.nsi, bekci.mjs takeRequest) */
const ISTEK = join(HOME, 'guncelleme', 'istek.json');
const sunucuGunlugu = () => tail(join(HOME, 'logs', 'sunucu.log'), 2000);

/** Kurulu Kaldir.exe'yi sessiz ve yerinde çalıştırır (_?=: kopyalayıp arkada sürmesin, bitmesi beklensin) */
function kaldir() {
  const exe = join(INSTALL, 'Kaldir.exe');
  if (!existsSync(exe)) fail(`Kaldir.exe yok (${readdirSync(INSTALL).join(', ')})`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$p = Start-Process -FilePath '${exe}' -ArgumentList '/S','_?=${INSTALL}' -Wait -PassThru; exit $p.ExitCode`], { stdio: 'inherit' });
  if (r.status !== 0) fail(`Kaldir.exe ${r.status} koduyla bitti`);
}

function setEnv(drop, add = []) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter((l) => !drop.some((k) => l.startsWith(`${k}=`)));
  writeFileSync(ENV_FILE, `${[...kept, ...add].join('\r\n').replace(/(\r\n)+$/, '')}\r\n`);
}

async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '1897' }) });
  if (!r.ok) fail(`patron girişi olmadı (${r.status})`);
  return (await r.json()).token;
}

/**
 * Kasa penceresinin bakım arası (Yönetim › Ağ › Bu bilgisayar › 15 dakika bakım arası). Güncellemeden hemen sonra sunucu
 * bir kez daha yeniden başlar (yeni sürümün deneme açılışı sağlık denetimine yanıt verir, sonra bekçi 75 koduyla yeni
 * sürümle açılır): bağlantı o arada koparsa (ECONNRESET; 27 Kasım koşusu) birkaç saniye sonra yeniden denenir
 */
async function bakim(on) {
  for (let deneme = 1; ; deneme++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/kasa-bakim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await login()}` },
        body: JSON.stringify({ on }),
      });
      if (!r.ok) fail(`bakım arası ${on ? 'açılamadı' : 'bitirilemedi'} (${r.status} ${await r.text()})`);
      return;
    } catch (e) {
      if (deneme >= 30) fail(`bakım arası ${on ? 'açılamadı' : 'bitirilemedi'}: sunucuya ulaşılamadı (${e.cause?.code ?? e.message})`);
      await sleep(2000);
    }
  }
}

/** Kasa kısayolunu (Başlat menüsü) kısayolun yaptığı gibi çalıştırır; pencere vekilden bağlanır */
function kasaAc(env = {}) {
  if (!existsSync(KASA_KISAYOLU)) fail(`kasa kısayolu yok: ${KASA_KISAYOLU}`);
  const r = ps('ac', ['-Kisayol', KASA_KISAYOLU], { ASILPOS_URL: VEKIL, ...env });
  console.log(`  kısayol: ${r.hedef} ${r.arguman}`);
  return r;
}

/** Kasa penceresinin ana tarayıcı süreçleri (profil: chrome ya da edge) */
const kasaSurecleri = (profil = 'chrome') => (ps('surecler').tarayici ?? []).filter((p) => new RegExp(`\\\\LafPOS\\\\${profil}(?![\\w-])`).test(p.komut)); // eski-ad: profil klasörü
const bekciler = () => ps('surecler').bekci ?? [];
/** Vekilin kasa sayfası bildirimleri (müşteri ekranı hariç) */
const sayfalar = (since) => vekil.log.filter((e) => e.tur === 'sayfa' && e.t >= since && !String(e.yol).startsWith('/musteri-ekrani'));
const waitSayfa = (since, pred, label, ms) => until(label, () => sayfalar(since).find(pred) ?? null, ms, 1000);

/** Kasa profilinin yerel deposunun dosyaları (Chromium: Default\Local Storage\leveldb) ve sayfanın anahtarı diskte mi */
function depoDiski(profil) {
  const dir = join(process.env.LOCALAPPDATA ?? '', 'LafPOS', profil, 'Default', 'Local Storage', 'leveldb'); // eski-ad: profil klasörü
  let adlar = [];
  try {
    adlar = readdirSync(dir);
  } catch {
    return { dir, dosyalar: [], anahtar: false };
  }
  const dosyalar = adlar.map((ad) => {
    try {
      // Tarayıcı açıkken de okunur (LevelDB paylaşımlı yazar); kilitli dosya (LOCK) atlanır
      const b = readFileSync(join(dir, ad));
      return { ad, boyut: b.length, anahtar: b.includes(CI_DEPO_ANAHTARI) };
    } catch {
      return { ad, boyut: null, anahtar: false };
    }
  });
  return { dir, dosyalar, anahtar: dosyalar.some((d) => d.anahtar) };
}

/** Edge ve Chrome politikaları (kayıt defteri): InPrivate'ı zorlayan ya da çıkışta veriyi silen bir ayar var mı */
function politikalar() {
  try {
    return JSON.stringify(ps('politika'));
  } catch (e) {
    return `(okunamadı: ${e.message})`;
  }
}

/** dist/web'i (güncelleme kanalı dahil) yalnız bu bilgisayara sunar */
function serveWeb() {
  const types = { '.json': 'application/json', '.zip': 'application/zip', '.cmd': 'application/octet-stream' };
  const server = createServer((req, res) => {
    const path = join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (relative(WEB, path).startsWith('..') || !existsSync(path) || statSync(path).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(KANAL_PORT, '127.0.0.1', () => ok(server)));
}

/** Kanal derlemesi (kanal.mjs). `isaret`: ana betiği derlemeye göre değiştirir (main.tsx VITE_ASILPOS_CI_DERLEME) */
function kanal(build, isaret) {
  const env = { ...process.env, ASILPOS_BUILD: String(build) };
  if (isaret) env.VITE_ASILPOS_CI_DERLEME = String(isaret);
  else delete env.VITE_ASILPOS_CI_DERLEME;
  execFileSync(process.execPath, [join(HERE, 'kanal.mjs')], { cwd: ROOT, stdio: 'inherit', env });
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

/** Bir kanal derlemesinden yeni numarayla değiştirilmiş derleme yayımlar (`mutate(ad, veri)` dosyayı değiştirir) */
function republish(m, build, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'asilpos-yeniden-'));
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
    return { name, data: mutate(name, data) };
  });
  rmSync(dir, { recursive: true, force: true });
  const zip = zipFiles(entries);
  const file = `lafpos-app-${build}.zip`; // eski-ad: güncelleyicinin beklediği ad (shared/eski-adlar.ts UYGULAMA_ZIP_ONEKI)
  writeFileSync(join(KANAL, file), zip);
  writeFileSync(join(KANAL, 'surum.json'), JSON.stringify({ ...m, build, date: new Date(build * 1000).toISOString(), app: { file, sha256: sha(zip), size: zip.length } }, null, 2));
}

/** Kurulu kasanın kısayolları, kaydı, görevi, güvenlik duvarı ve dosyaları (iki kurulumun karşılaştırması) */
function snapshot() {
  return { kisayollar: ps('kisayollar'), kayit: ps('kayit'), gorev: ps('gorev'), duvar: ps('duvar'), agac: ps('agac', ['-Klasor', INSTALL]) };
}

/** Kurulu derlemenin kısayol listesi (iki kurulum ve güncelleme bunu yazar) */
const expectedLinks = () =>
  JSON.parse(execFileSync(join(INSTALL, 'node', 'node.exe'), [join(INSTALL, 'app', 'kurulum-yenile.mjs'), 'kisayollar', '--gruplar', 'masaustu,baslangic', '--yalniz-liste'], { encoding: 'utf8' }));

const low = (s) => String(s ?? '').toLowerCase();
/** Kısayollar listeyle aynı mı (hedef, argüman, simge, pencere, çalışma klasörü; .url'de adres) */
function checkLinks(links, label) {
  const want = expectedLinks();
  const key = (k) => low(`${k.klasor}\\${k.ad ?? k.goreli}`);
  const have = new Map(links.map((k) => [low(`${k.klasor}\\${k.goreli}`), k]));
  for (const w of want) {
    const h = have.get(key(w));
    if (!h) fail(`${label}: kısayol yok: ${w.klasor}\\${w.ad} (olanlar: ${links.map((k) => `${k.klasor}\\${k.goreli}`).join(', ')})`);
    if (w.url) {
      if (h.url !== w.url) fail(`${label}: ${w.ad} adresi ${h.url}`);
      continue;
    }
    for (const [a, b] of [
      ['hedef', 'hedef'],
      ['arguman', 'arguman'],
      ['ikon', 'ikon'],
      ['calismaKlasoru', 'calismaKlasoru'],
    ]) {
      if (low(h[a]) !== low(w[b])) fail(`${label}: ${w.ad} ${a} "${h[a]}", beklenen "${w[b]}"`);
    }
    if (h.pencere !== w.pencere) fail(`${label}: ${w.ad} pencere ${h.pencere}, beklenen ${w.pencere}`);
  }
  return want.length;
}

/** Kurulum dosyasıyla ve siteden kurulumla kurulan program aynı mı (yalnız kaldırıcı ve sürüm satırı farklı) */
function compareInstalls(a, b) {
  const KALDIR = "asilpos\\asilpos'u kaldır.lnk";
  const links = (s) => new Map(s.kisayollar.map((k) => [low(`${k.klasor}\\${k.goreli}`), k]));
  const la = links(a);
  const lb = links(b);
  const names = (m) => [...m.keys()].sort().join(' | ');
  if (names(la) !== names(lb)) fail(`kısayolların adları farklı:\n  exe: ${names(la)}\n  web: ${names(lb)}`);
  for (const [k, x] of la) {
    if (k.endsWith(KALDIR)) continue;
    const y = lb.get(k);
    for (const f of ['hedef', 'arguman', 'ikon', 'calismaKlasoru', 'pencere', 'url']) if (low(x[f]) !== low(y[f])) fail(`kısayol ${k} ${f}: exe "${x[f]}", web "${y[f]}"`);
  }
  for (const f of ['DisplayName', 'Publisher', 'DisplayIcon', 'InstallLocation', 'NoModify', 'NoRepair']) if (low(a.kayit?.[f]) !== low(b.kayit?.[f])) fail(`Uygulamalar kaydı ${f}: exe "${a.kayit?.[f]}", web "${b.kayit?.[f]}"`);
  // Görev okunamadıysa karşılaştırma boş geçmez
  if (!a.gorev || !b.gorev) fail(`görev okunamadı: exe ${a.gorev ? 'var' : 'yok'}, web ${b.gorev ? 'var' : 'yok'}`);
  if (low(a.gorev) !== low(b.gorev)) fail(`görev farklı:\n--- exe ---\n${a.gorev}\n--- web ---\n${b.gorev}`);
  const rules = (t) => low(t).split('\n').map((l) => l.trim()).filter(Boolean).sort().join('\n');
  if (rules(a.duvar) !== rules(b.duvar)) fail(`güvenlik duvarı farklı:\n--- exe ---\n${a.duvar}\n--- web ---\n${b.duvar}`);
  const kok = (s, drop) => s.agac.kok.filter((f) => f.ad !== drop);
  const ka = kok(a, 'Kaldir.exe');
  const kb = kok(b, 'LafPOS-Kaldir.ps1'); // eski-ad: siteden kurulumun kaldırıcısı
  if (JSON.stringify(ka) !== JSON.stringify(kb)) fail(`kök dosyalar farklı:\n  exe: ${JSON.stringify(ka)}\n  web: ${JSON.stringify(kb)}`);
  if (JSON.stringify(a.agac.klasorler) !== JSON.stringify(b.agac.klasorler)) fail(`klasörler farklı: exe ${a.agac.klasorler}, web ${b.agac.klasorler}`);
  // Arayüz dosyalarının adındaki içerik özeti iki derlemede ayrı çıkabilir: yalnız yollar
  const norm = (l) => l.map((p) => p.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '.$1')).join('\n');
  if (norm(a.agac.dosyalar) !== norm(b.agac.dosyalar)) {
    const sa = new Set(a.agac.dosyalar);
    const sb = new Set(b.agac.dosyalar);
    fail(`app\\ ve node\\ farklı: yalnız exe ${a.agac.dosyalar.filter((x) => !sb.has(x)).slice(0, 20)}; yalnız web ${b.agac.dosyalar.filter((x) => !sa.has(x)).slice(0, 20)}`);
  }
}

/** Kaldırmadan sonra iz yok: görev, güvenlik duvarı, kısayollar; veri klasörü yerinde; kurulum klasöründe yalnız Kaldir.exe */
function checkUninstalled(label) {
  if (taskExists()) fail(`${label}: görev kaldı`);
  if (/LafPOS Sunucu/i.test(ps('duvar') ?? '') && !/No rules match|kural yok|eşleşen kural/i.test(ps('duvar'))) fail(`${label}: güvenlik duvarı kuralı kaldı`);
  const links = ps('kisayollar') ?? [];
  if (links.length) fail(`${label}: kısayollar kaldı: ${links.map((k) => k.yol).join(', ')}`);
  if (!existsSync(join(HOME, 'lafpos.db'))) fail(`${label}: veritabanı silindi`); // eski-ad: veritabanının adı
  const left = existsSync(INSTALL) ? readdirSync(INSTALL).filter((f) => f !== 'Kaldir.exe') : [];
  if (left.length) fail(`${label}: kurulum klasöründe kalanlar: ${left.join(', ')}`);
  if (ps('kayit')) fail(`${label}: Uygulamalar kaydı kaldı`);
  rmSync(INSTALL, { recursive: true, force: true });
}

/** Kurulum klasöründeki Node'dan çalışan süreçler (bekçi, sunucu) */
const sunucuSurecleri = () => ps('sunucu', ['-Klasor', INSTALL]) ?? [];
const guncellemeYedekleri = () => (existsSync(join(HOME, 'backups')) ? readdirSync(join(HOME, 'backups')) : []).filter((f) => f.startsWith('lafpos-guncelleme-') && f.endsWith('.db')).length; // eski-ad: yedeğin adı
/** Görev açık ve çalışıyor (Görev Zamanlayıcı'nın durumu 4) olana dek, en çok 60 sn */
async function gorevCalisiyor(label) {
  let g = null;
  for (const bitis = Date.now() + 60_000; Date.now() < bitis; await sleep(2000)) {
    g = ps('gorev-durum');
    if (g?.acik === true && g.durum === 4) return g;
  }
  fail(`${label}: görev açık ve çalışır değil (${JSON.stringify(g)})`);
}

/**
 * Kurulum kurmadan çıktı: kurulu derleme, sunucunun süreçleri ve derlemesi, eski app\ klasöründeki işaret aynı; yan
 * klasör, yeni veritabanı kopyası yok; görev açık ve çalışıyor
 */
async function kurmadi(label, once) {
  if (installedBuild() !== once.build) fail(`${label}: kurulu derleme değişti (${once.build} → ${installedBuild()})`);
  if (!existsSync(once.isaret)) fail(`${label}: app\\ değişti (eski klasördeki işaret yok)`);
  if (existsSync(join(INSTALL, 'kurulum.gecici'))) fail(`${label}: kurulum.gecici kaldı`);
  if (guncellemeYedekleri() !== once.yedek) fail(`${label}: veritabanının kopyası alındı (sunucu durdurulmuş)`);
  const h = await health();
  if (h?.build !== once.build) fail(`${label}: sağlık ${JSON.stringify(h)}, beklenen derleme ${once.build}`);
  const simdi = sunucuSurecleri().map((p) => p.pid).sort((a, b) => a - b);
  if (JSON.stringify(simdi) !== JSON.stringify(once.pids)) fail(`${label}: sunucu yeniden başladı (süreçler ${once.pids} → ${simdi})`);
  await gorevCalisiyor(label);
}
/** Kurmadan çıkış denemesinden önce: app\'e işaret konur, derleme, süreçler ve kopyalar saklanır */
function kurulumOncesi(ad) {
  const isaret = join(INSTALL, 'app', 'ci-kurulmadi.txt');
  writeFileSync(isaret, ad);
  return { isaret, build: installedBuild(), pids: sunucuSurecleri().map((p) => p.pid).sort((a, b) => a - b), yedek: guncellemeYedekleri() };
}

// ─── 0. Ortam ────────────────────────────────────────────────────────────────

step('Ortam');
const ortam = ps('on');
const masaustu = ortam.oturum > 0;
console.log(`  oturum ${ortam.oturum} (${masaustu ? 'masaüstü var: pencere ve öne getirme denenir' : 'etkileşimsiz: öne getirme atlanır'}), bu derleme ${BU_DERLEME}`);
if (!existsSync(ONCEKI_EXE)) fail(`önceki sürümün kurulum dosyası yok: ${ONCEKI_EXE} (iş akışı GitHub'daki son sürümü indirir)`);

// ─── A. Önceki sürüm ────────────────────────────────────────────────────────

step('A. Önceki sürüm (kafede kurulu olan): sessiz kurulum');
// Güncelleme kanalı baştan yerel kanal (C'de açılır, o zamana dek yanıt yok): kurulum dosyası sunucuyu açmadan önce
// güncelleme isteği yazar (asilpos.nsi; 28 Kasım 2026'dan sonraki sürümler), bekçi kanala hemen sorar. Sitenin kanalında
// daha yeni bir derleme varsa (main'de koşu) deneme o sürüme geçerdi. Ayar dosyası kurulumun örneğiyle başlar (kurulum
// yalnız dosya yoksa örneği koyar)
mkdirSync(HOME, { recursive: true });
const ornek = join(ROOT, 'dist', 'windows', 'stage', 'kok', 'ayarlar.env.ornek');
writeFileSync(ENV_FILE, `${existsSync(ornek) ? readFileSync(ornek, 'utf8').replace(/(\r?\n)+$/, '') : ''}\r\nASILPOS_GUNCELLEME_KANAL=http://127.0.0.1:${KANAL_PORT}/guncelleme/surum.json\r\n`);
kur(ONCEKI_EXE);
for (const f of [join(INSTALL, 'node', 'node.exe'), join(INSTALL, 'app', 'bekci.mjs'), join(INSTALL, 'baslat.cmd'), ENV_FILE]) if (!existsSync(f)) fail(`kurulumda yok: ${f}`);
if (!taskExists()) fail('görev yok');
if (!/LafPOS Sunucu/i.test(ps('duvar') ?? '')) fail('güvenlik duvarı kuralı yok');
const bOnceki = installedBuild();
const h0 = await until('sunucu açılmadı', health, 180_000);
if (h0.build !== bOnceki) fail(`sağlık denetimi derlemeyi ${h0.build} dedi, beklenen ${bOnceki}`);
const sOnceki = appScript();
console.log(`  derleme ${bOnceki}, arayüz ${sOnceki}`);

// ─── B. Kasa penceresi (önceki sürüm) ───────────────────────────────────────

vekil = await startProxy({ port: VEKIL_PORT, upstreamPort: PORT });
step('B. Önceki sürümün kasa kısayolu pencereyi açar (sunucu 27 Kasım öncesi gibi önbellek başlıksız)');
const tB = Date.now();
kasaAc();
const sayfaB = await waitSayfa(tB, (s) => s.script === sOnceki, 'kasa penceresi önceki sürümle açılmadı', 180_000);
console.log(`  pencere: ${sayfaB.script} · ${sayfaB.baslik} · ${sayfaB.ekran}`);
if (!vekil.log.some((e) => e.tur === 'istek' && e.t >= tB && e.dest === 'document' && e.cc === null)) fail('vekil eski sunucu başlıklarını vermedi');
const kasaB = kasaSurecleri();
if (kasaB.length !== 1 || !kasaB[0].komut.includes('--kiosk')) fail(`kasa penceresi beklenmedik: ${JSON.stringify(kasaB)}`);
ekran('onceki-surum-kasa');

// ─── C. Otomatik güncelleme ─────────────────────────────────────────────────

const b1 = Math.max(BU_DERLEME, bOnceki + 100);
step(`C. Otomatik güncelleme: yerel kanal, derleme ${b1} (bu derlemenin kodu), Node da değişir`);
kanal(b1, b1);
const node = await otherNode();
const m1 = JSON.parse(readFileSync(join(KANAL, 'surum.json'), 'utf8'));
const m1n = { ...m1, node: { ...m1.node, version: node.version, sha256: node.sha256 } };
writeFileSync(join(KANAL, 'surum.json'), JSON.stringify(m1n, null, 2));
console.log(`  Node ${NODE_VERSION} → ${node.version}`);
const kanalSunucusu = await serveWeb();
mkdirSync(HOME, { recursive: true });
appendFileSync(ENV_FILE, `\r\nASILPOS_GUNCELLEME_KANAL=http://127.0.0.1:${KANAL_PORT}/guncelleme/surum.json\r\n`);
await until(
  `derleme ${b1} açılmadı`,
  async () => {
    const h = await health();
    return h?.build === b1 ? h : null;
  },
  600_000,
  1000,
);
// Yeni sunucu: vekil artık başlıklara dokunmaz (no-store, no-cache, değişmez derleme dosyaları)
const T1 = Date.now();
vekil.mode = 'gercek';
if (installedBuild() !== b1) fail('app klasörü yeni derlemeyi taşımıyor');
if (!existsSync(join(INSTALL, 'app.eski'))) fail('app.eski yok (eski sürüm saklanmadı)');
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
const sYeni = appScript();
if (sYeni === sOnceki) fail(`yeni derlemenin ana betiği öncekiyle aynı (${sYeni}): CI işareti derlemeye girmedi`);
console.log(`  ${s1.mesaj} · kurulu ${JSON.stringify(s1.kurulu)} · Node ${nodeNow} · arayüz ${sYeni}`);

// ─── D. İlk açılış yeni sürümle; program ────────────────────────────────────

/** T'den sonra eski sürümün gösterildiği sayfa: şikâyetin kendisi */
const noStale = (t, label) => {
  const eski = sayfalar(t).filter((s) => s.script === sOnceki);
  if (eski.length) fail(`${label}: güncellemeden sonra eski sürüm gösterildi (${JSON.stringify(eski)})`);
};

step('D1. Güncellemeden önce açılmış kasa penceresi kendiliğinden yeni sürüme geçer');
// Yeni derlemenin betiği güncellemeden önce yoktu: B'den sonraki her bildirim sayılır (sağlık yoklaması geç kalabilir)
const d1 = await waitSayfa(tB, (s) => s.script === sYeni, 'açık kasa penceresi yeni sürüme geçmedi', 240_000);
console.log(`  güncellemeden ${Math.round((d1.t - T1) / 1000)} sn sonra yeni sürüm: ${d1.script}`);
noStale(T1, 'açık pencere');
ekran('acik-pencere-yeni-surum');

step('D2. Güncelleme kısayolları konsolsuz programa çevirdi; kurulum uyarısı yok');
await until('kısayollar yeni derleme için yenilenmedi', () => (marker()?.build === b1 && marker()?.ok === true ? marker() : null), 120_000);
const nLinks = checkLinks(ps('kisayollar'), 'güncellemeden sonra');
if (status()?.kurulumUyari) fail(`kurulum uyarısı: ${status().kurulumUyari}`);
const kasaLnk = ps('kisayollar').find((k) => k.goreli === 'AsilPOS\\AsilPOS Kasa.lnk');
if (!/powershell\.exe$/i.test(kasaLnk.hedef) || !kasaLnk.arguman.endsWith('kasa-yazici.ps1" -Ac') || !kasaLnk.arguman.includes('-WindowStyle Hidden')) fail(`kasa kısayolu programı açmıyor: ${JSON.stringify(kasaLnk)}`);
console.log(`  ${nLinks} kısayol listeyle aynı; kasa kısayolu: ${kasaLnk.hedef} ${kasaLnk.arguman}`);

step('D3. Kapanan pencereyi yeni kasa kısayolu açar: ilk sayfa yeni sürüm ve sunucudan; eski bekçi yenisiyle değişir');
const bekciOnce = bekciler();
console.log(`  çalışan bekçi: ${bekciOnce.map((b) => b.komut.replace(/.*-Bekci/, '-Bekci')).join(', ') || 'yok'}`);
await bakim(true);
const tKapat = Date.now();
ps('kapat');
await sleep(25_000);
if (kasaSurecleri().length) fail('bakım arasında kasa penceresi yeniden açıldı');
kasaAc();
const d3 = await waitSayfa(tKapat, () => true, 'kasa kısayolu pencereyi açmadı', 180_000);
if (d3.script !== sYeni) fail(`kasa penceresi eski sürümle açıldı: ${d3.script} (yeni ${sYeni})`);
if (!vekil.log.some((e) => e.tur === 'istek' && e.t >= tKapat && e.dest === 'document' && e.status === 200)) fail('ilk sayfa sunucudan gelmedi (tarayıcı önbelleğinden açıldı)');
if (!d3.depo || d3.depo === 'yok') fail(`kasa profilinin yerel deposu kalıcı değil (oturum ve sepet kaybolur): "${d3.depo}"`);
if (d3.baslik !== 'AsilPOS') fail(`pencerenin başlığı: ${d3.baslik}`);
noStale(T1, 'yeniden açılış');
const kasaD3 = await until('kasa penceresinin süreci yok', () => (kasaSurecleri().length === 1 ? kasaSurecleri() : null), 30_000);
for (const f of ['--kiosk', '--kiosk-printing', `--app=${VEKIL}`]) if (!kasaD3[0].komut.includes(f)) fail(`kasa penceresinde ${f} yok: ${kasaD3[0].komut}`);
const bekciD3 = await until('yeni bekçi açılmadı', () => {
  const b = bekciler();
  return b.length === 1 && b[0].komut.includes('-BekciSurum 6') ? b : null;
}, 60_000);
console.log(`  ilk sayfa ${d3.script}, başlık ${d3.baslik}; bekçi ${bekciD3[0].pid} (${bekciD3[0].komut.replace(/.*-Bekci/, '-Bekci')})`);
ekran('ilk-acilis-yeni-surum');

step('D4. Tek pencere: kısayola yeniden basınca ikinci pencere açılmaz, açık olan öne gelir');
let notDefteri = null;
if (masaustu) {
  notDefteri = ps('not-defteri').pid;
  const on = ps('on');
  console.log(`  önde: ${on.baslik} (${on.pid})`);
}
kasaAc();
await sleep(12_000);
const kasaD4 = kasaSurecleri();
if (kasaD4.length !== 1 || kasaD4[0].pid !== kasaD3[0].pid) fail(`ikinci kısayol yeni pencere açtı: ${JSON.stringify(kasaD4.map((k) => k.pid))} (önce ${kasaD3[0].pid})`);
if (masaustu) {
  // Windows ön planı kısıtlayabilir (kullanıcı başka yere yazarken): öne gelmemek uyarıdır, ikinci pencere hatadır
  let on = ps('on');
  if (on.pid !== kasaD3[0].pid) {
    kasaAc();
    await sleep(8000);
    on = ps('on');
  }
  if (on.pid === kasaD3[0].pid) console.log(`  önde: ${on.baslik}`);
  else console.log(`::warning title=Kasa penceresi öne gelmedi::önde ${on.baslik} (${on.pid}); kasa ${kasaD3[0].pid}`);
  if (notDefteri) spawnSync('taskkill', ['/PID', String(notDefteri), '/F'], { stdio: 'ignore' });
}
ekran('ikinci-tiklama-one-getirir');

step('D5. Kapanan pencereyi bekçi yeniden açmaz (sahibin isteği, 28 Kas 2026); kısayol açar');
await bakim(false);
ps('kapat');
await sleep(35_000);
if (kasaSurecleri().length) fail('bekçi kullanıcının kapattığı kasa penceresini yeniden açtı');
console.log('  kapanan pencere 35 sn sonra hâlâ kapalı');
const tD5 = Date.now();
kasaAc();
const d5 = await waitSayfa(tD5, () => true, 'kasa kısayolu pencereyi açmadı', 120_000);
if (d5.script !== sYeni) fail(`kısayol pencereyi eski sürümle açtı: ${d5.script}`);
await bakim(true);
ps('kapat');

step('D6. Edge: kalıcı profille tam ekran (InPrivate değil, oturum ve sepet kalır)');
const tE = Date.now();
kasaAc({ ASILPOS_TARAYICI: 'edge' });
const e1 = await waitSayfa(tE, () => true, 'Edge kasa penceresini açmadı', 180_000);
const edge = await until('Edge kasa süreci yok', () => (kasaSurecleri('edge').length === 1 ? kasaSurecleri('edge') : null), 30_000);
if (!/msedge\.exe/i.test(edge[0].ad) || /--kiosk(\s|$)/.test(edge[0].komut) || !edge[0].komut.includes('--start-fullscreen') || !edge[0].komut.includes('--kiosk-printing')) fail(`Edge argümanları: ${edge[0].komut}`);
if (/--inprivate/i.test(edge[0].komut)) fail(`Edge InPrivate açıldı: ${edge[0].komut}`);
if (e1.script !== sYeni) fail(`Edge eski sürümü gösterdi: ${e1.script}`);
if (e1.depo === 'yok') fail('Edge sayfası yerel depoya yazamadı');
// Chromium (Chrome da Edge de) yerel depoyu diske toplu yazar: değişiklikten yaklaşık 5 sn sonra. Süreç zorla kapanınca
// (Stop-Process; elektrik kesintisi gibi) yalnız diske geçmemiş son birkaç saniye kaybolur. İlk koşu (27 Kas 2026) Edge'i
// sayfanın yazımından 2 sn sonra kapatıyordu: iki okuma da boştu, profil kalıcıydı. Kasiyer de pencereyi kapatmadan önce
// sayfada çalışmıştır: sayfanın yazdığı değer profilin diskine geçene dek beklenir (en çok 30 sn), sonra zorla kapatılır
const tYaz = Date.now();
let disk = depoDiski('edge');
while (!disk.anahtar && Date.now() - tYaz < 30_000) {
  await sleep(1000);
  disk = depoDiski('edge');
}
if (disk.anahtar) console.log(`  sayfanın yazımı ${Math.round((Date.now() - e1.t) / 1000)} sn içinde Edge profilinin diskinde`);
else console.log(`::warning title=Edge yerel deposu diskte görülmedi::${JSON.stringify(disk)}`);
ps('kapat', ['-Profil', 'edge']);
await sleep(3000);
const tE2 = Date.now();
kasaAc({ ASILPOS_TARAYICI: 'edge' });
const e2 = await waitSayfa(tE2, () => true, 'Edge yeniden açılmadı', 120_000);
if (!e2.depo || e2.depo === 'yok' || (e1.depo && e2.depo !== e1.depo)) {
  fail(`Edge yerel depoyu tutmadı: ilk "${e1.depo}", sonra "${e2.depo}"; disk ${JSON.stringify(depoDiski('edge'))}; tarayıcı politikaları ${politikalar()}`);
}
console.log(`  Edge yerel deposu kalıcı (${e2.depo}); ${edge[0].komut.slice(0, 160)}…`);
ekran('edge-tam-ekran');
ps('kapat', ['-Profil', 'edge']);
await bakim(false);
const tChrome = Date.now();
kasaAc();
await waitSayfa(tChrome, () => true, 'kasa kısayolu pencereyi Chrome ile açmadı', 120_000);

// ─── E. Bozuk derleme, bekçinin kendini yenilemesi ──────────────────────────

const b2 = b1 + 100;
step(`E1. Bozuk derleme ${b2}: kurulur, açılmaz, ${b1}'e dönülür`);
republish(m1n, b2, (name, data) => (name === 'server/index.mjs' ? Buffer.from("console.error('bozuk derleme (deneme)'); process.exit(1);\n") : data));
appendFileSync(ENV_FILE, `# deneme ${Date.now()}\r\n`);
await until('geri dönülmedi', () => (status()?.durum === 'geri-dondu' ? status() : null), 600_000);
const h2 = await until('eski sürüm yeniden açılmadı', health, 120_000);
if (h2.build !== b1 || installedBuild() !== b1) fail(`geri dönüşten sonra derleme ${h2.build}/${installedBuild()}, beklenen ${b1}`);
if (!(status()?.basarisiz ?? []).includes(b2)) fail('bozuk derleme "bir daha denenmeyecek" listesine girmedi');
console.log(`  ${status().mesaj}`);

const b3 = b1 + 200;
step(`E2. Gece kapanan pencere, güncelleme (derleme ${b3}: yeni arayüz ve yeni kasa betiği), sabah ilk açılış yeni sürümle`);
// Sayfa 27 Kasım öncesinin sunucusundan gelmiş gibi saklanır (vekil eski kipte): şikâyetteki durum. Pencere gece kapanır
// (bakım arası: bekçi yeniden açmasın), güncelleme kurulur; sabah kısayolla açılan ilk sayfa yeni sürüm olmalı
vekil.mode = 'eski';
await bakim(true);
ps('kapat');
const tGece = Date.now();
kasaAc();
await waitSayfa(tGece, (s) => s.script === sYeni, 'kasa penceresi açılmadı', 180_000);
// Tarayıcı sayfayı önbelleğe diske yazsın (kapatma zorla)
await sleep(10_000);
ps('kapat');
const bekciE = bekciler();
if (bekciE.length !== 1) fail(`bir bekçi bekleniyordu: ${JSON.stringify(bekciE)}`);
// Bakım arası 15 dakika: kanal derlemesi ve güncelleme boyunca sürsün
await bakim(true);
kanal(b3, b3);
// Node değişmez (kurulu olan): yalnız uygulama; kasa betiği değişir (bekçi kendini yenilemeli)
const m3 = { ...JSON.parse(readFileSync(join(KANAL, 'surum.json'), 'utf8')), node: m1n.node };
republish(m3, b3, (name, data) => (name === 'kasa-yazici.ps1' ? Buffer.concat([data, Buffer.from(`# ci ${b3}\r\n`)]) : data));
appendFileSync(ENV_FILE, `# deneme ${Date.now()}\r\n`);
await until(
  `derleme ${b3} açılmadı`,
  async () => {
    const h = await health();
    return h?.build === b3 ? h : null;
  },
  600_000,
  1000,
);
const T3 = Date.now();
vekil.mode = 'gercek';
await bakim(true);
const s3 = appScript();
if (s3 === sYeni) fail(`derleme ${b3}'ün ana betiği öncekiyle aynı (${s3})`);
const bekciYeni = await until(
  'bekçi kendini yenilemedi (diskteki yeni betikle)',
  () => {
    const b = bekciler();
    return b.length === 1 && b[0].pid !== bekciE[0].pid && b[0].komut.includes('-BekciSurum 6') ? b : null;
  },
  120_000,
);
console.log(`  bekçi kendini yeniledi: ${bekciE[0].pid} → ${bekciYeni[0].pid}`);
// Sabah: kasa kısayolu (bakım arası beklenmedik biçimde bittiyse pencereyi bekçi açmıştır: o da ilk açılıştır)
if (!kasaSurecleri().length) kasaAc();
else console.log('  pencereyi bekçi açtı');
const sabah = await waitSayfa(T3, () => true, 'sabah kasa kısayolu pencereyi açmadı', 180_000);
if (sabah.script !== s3) fail(`güncellemeden sonraki ilk açılışta eski sürüm göründü: ${sabah.script} (yeni ${s3})`);
if (!vekil.log.some((e) => e.tur === 'istek' && e.t >= T3 && e.dest === 'document' && e.status === 200)) fail('ilk sayfa sunucudan gelmedi (önbellekten açıldı)');
if (sayfalar(T3).some((s) => s.script === sYeni)) fail(`güncellemeden sonra önceki derleme gösterildi: ${JSON.stringify(sayfalar(T3))}`);
console.log(`  sabah ilk sayfa ${sabah.script} (sunucudan)`);
ekran('sabah-ilk-acilis');
await bakim(false);

step(`E3. Daha yeni kurulumun (derleme ${b3}) üzerine eski derlemeli kurulum dosyası (${BU_DERLEME}): kurmadan çıkar`);
// Sürüm geri düşmez (asilpos.nsi .onInit): kurulu sürüm, çalışan sunucu ve görev aynen kalır
const onceE3 = kurulumOncesi('E3');
const kodE3 = kurKod(BU_EXE);
if (kodE3 !== KOD_YENISI_KURULU) fail(`eski derlemeli kurulum dosyası ${kodE3} koduyla bitti, beklenen ${KOD_YENISI_KURULU} (daha yeni sürüm kurulu)`);
await kurmadi('eski derlemeli kurulum dosyası', onceE3);
rmSync(onceE3.isaret, { force: true });
console.log(`  ${kodE3} koduyla çıktı; derleme ${b3}, sunucu ve görev yerinde`);

// ─── F. Kaldırma; kurulum dosyası ve siteden kurulum aynı programı kurar ────

step('F1. Kafedeki kaldırıcı (önceki sürümün Kaldir.exe\'si) iz bırakmaz; veriler kalır');
kaldir();
// Önceki sürümün kaldırıcısı oturumdaki süreçlere dokunmaz (bu sürümünkü kapatır, F2)
ps('kapat');
ps('bekci-kapat');
checkUninstalled('önceki sürümün kaldırıcısı');

step(`F2. Bu derlemenin kurulum dosyası (derleme ${BU_DERLEME})`);
// Kanal ve otomatik güncelleme kapalı: karşılaştırma sürerken başka sürüm kurulmasın
setEnv(['ASILPOS_GUNCELLEME_KANAL', 'ASILPOS_GUNCELLEME'], ['ASILPOS_GUNCELLEME=kapali']);
kur(BU_EXE);
await until(
  `derleme ${BU_DERLEME} açılmadı`,
  async () => {
    const h = await health();
    return h?.build === BU_DERLEME ? h : null;
  },
  180_000,
);
await until('kısayollar yenilenmedi', () => (marker()?.build === BU_DERLEME && marker()?.ok === true ? marker() : null), 120_000);
checkLinks(ps('kisayollar'), 'kurulum dosyası');
if (existsSync(join(INSTALL, 'kurulum.gecici'))) fail('kurulum.gecici kaldı');
// Kurulumun güncelleme isteği bekçiye ulaştı (biçimi ve anı geçerli); otomatik güncelleme kapalı olduğu için yok sayıldı
await until('kurulumun güncelleme isteği bekçiye ulaşmadı', () => (!existsSync(ISTEK) && sunucuGunlugu().includes('kurulumun güncelleme isteği yok sayıldı') ? true : null), 60_000);
console.log('  kurulumun güncelleme isteği bekçiye ulaştı (otomatik güncelleme kapalı: yok sayıldı)');
const exeDurum = snapshot();
step('F2b. Kurulum dosyası çalışan kurulumun üzerine (elle güncelleme): kasa penceresi açıkken, sunucu çalışırken');
const tF2 = Date.now();
kasaAc();
await waitSayfa(tF2, () => true, 'kasa penceresi açılmadı', 180_000);
const pencereF2 = kasaSurecleri();
kur(BU_EXE);
await until(
  'elle güncellemeden sonra sunucu açılmadı',
  async () => {
    const h = await health();
    return h?.build === BU_DERLEME ? h : null;
  },
  180_000,
);
for (const d of ['kurulum.gecici', 'app.eski', 'node.eski']) if (existsSync(join(INSTALL, d))) fail(`elle güncellemeden sonra ${d} kaldı`);
if (!readdirSync(join(HOME, 'backups')).some((f) => f.startsWith('lafpos-guncelleme-'))) fail('elle güncelleme veritabanının kopyasını almadı'); // eski-ad: yedeğin adı
if (kasaSurecleri()[0]?.pid !== pencereF2[0]?.pid) console.log('  (kasa penceresi yeniden açıldı)');
checkLinks(ps('kisayollar'), 'elle güncelleme');
console.log('  yan klasörden yer değiştirdi, veritabanı kopyalandı, sunucu açıldı');
// Bu sürümün kaldırıcısı kasa penceresini ve bekçiyi de kapatır
kaldir();
await sleep(3000);
if (kasaSurecleri().length || bekciler().length) fail(`kaldırıcı kasa penceresini ya da bekçiyi kapatmadı: ${JSON.stringify(ps('surecler'))}`);
checkUninstalled('bu sürümün kaldırıcısı');

step('F3. Siteden kurulum (AsilPOS-Kur.cmd, yerel kanaldan, aynı derleme)');
kanal(BU_DERLEME, null);
const kurucu = join(KANAL, 'AsilPOS-Kur.cmd');
// Kurucu yerel kanaldan indirir: kanal sunucusu bu süreçte çalışır. spawnSync olay döngüsünü durdurur, kanal yanıt
// veremez (27 Kasım koşusu: surum.json 30 sn, uygulama zip'i 15 dk bekleyip düştü); kurucu ayrı süreçte, beklenerek
/** Siteden kurulumu sessiz kipte çalıştırır, bitmesini bekler: `{ status, hata? }` */
function siteden() {
  return new Promise((done) => {
    const child = spawn('cmd.exe', ['/d', '/c', kurucu], {
      stdio: 'inherit',
      env: { ...process.env, ASILPOS_KUR_KANAL: `http://127.0.0.1:${KANAL_PORT}/guncelleme/`, ASILPOS_KUR_SESSIZ: '1' },
    });
    const timer = setTimeout(() => child.kill(), 20 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ status: null, hata: e.message });
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      done({ status });
    });
  });
}
const web = await siteden();
if (web.status !== 0) fail(`siteden kurulum ${web.status} koduyla bitti${web.hata ? ` (${web.hata})` : ''}`);
await until(
  `siteden kurulum: derleme ${BU_DERLEME} açılmadı`,
  async () => {
    const h = await health();
    return h?.build === BU_DERLEME ? h : null;
  },
  180_000,
);
await until('siteden kurulum: kısayollar yenilenmedi', () => (marker()?.build === BU_DERLEME && marker()?.ok === true ? marker() : null), 120_000);
checkLinks(ps('kisayollar'), 'siteden kurulum');
const webDurum = snapshot();
compareInstalls(exeDurum, webDurum);
console.log(`  aynı: ${webDurum.kisayollar.length} kısayol, görev (${webDurum.gorev.length} karakter), güvenlik duvarı, Uygulamalar kaydı, ${webDurum.agac.kok.length} kök dosya, ${webDurum.agac.dosyalar.length} program dosyası`);
ekran('siteden-kurulum');

/** Siteden kurulum tamamlandı: çıkış 0, sunucu bu derlemeyle, artık klasör yok, görev açık ve çalışıyor, app\ yenilendi */
async function sitedenTamam(r, label, isaret) {
  if (r.status !== 0) fail(`${label}: kurucu ${r.status} koduyla bitti${r.hata ? ` (${r.hata})` : ''}`);
  await until(`${label}: derleme ${BU_DERLEME} açılmadı`, async () => ((await health())?.build === BU_DERLEME ? true : null), 180_000);
  for (const d of ['kurulum.gecici', 'app.eski', 'node.eski']) if (existsSync(join(INSTALL, d))) fail(`${label}: ${d} kaldı`);
  await gorevCalisiyor(label);
  // Eski sürümün app\ klasörüne konan işaret: yer değiştirme olduysa yeni klasörde yoktur
  if (existsSync(isaret)) fail(`${label}: app\\ yenilenmedi (eski klasördeki işaret duruyor)`);
}
const isaret = join(INSTALL, 'app', 'ci-eski-surum.txt');

step('F4. Siteden kurulum çalışan kasanın üzerine: kasa penceresi açık, sunucu görevle çalışırken');
const tF4 = Date.now();
kasaAc();
await waitSayfa(tF4, () => true, 'kasa penceresi açılmadı', 180_000);
await gorevCalisiyor('siteden kurulumdan önce');
// Kurucu sunucuyu süreçlerinden de bulur (çalıştırılan dosya kurulumun Node'u): görevin SYSTEM süreçleri yönetici
// oturumundan görünmeli, yoksa görev durdurulamadığında kurucu onları bulamazdı
const f4Once = sunucuSurecleri();
if (!f4Once.length) fail('görevin çalıştırdığı sunucu süreçleri kurulum klasörünün Node\'u olarak görünmüyor (Win32_Process ExecutablePath)');
console.log(`  görevin süreçleri: ${f4Once.map((p) => p.pid).join(', ')}`);
writeFileSync(isaret, 'F4');
const yedekF4 = guncellemeYedekleri();
const f4 = await siteden();
await sitedenTamam(f4, 'çalışan kasanın üzerine siteden kurulum', isaret);
if (guncellemeYedekleri() <= yedekF4) fail('çalışan kasanın üzerine siteden kurulum veritabanının kopyasını almadı');
checkLinks(ps('kisayollar'), 'çalışan kasanın üzerine siteden kurulum');
console.log('  sunucu durdu, veritabanı kopyalandı, yer değiştirdi, görev açık ve çalışıyor');
ekran('siteden-kurulum-calisan-kasa');

step('F4b. Sunucu görevin dışında çalışırken: siteden kurulum sunucuyu süreçlerinden bulup durdurur, tamamlanır');
// Sahibin kasasında (28 Kasım) görev sorgusu yanıldı, sunucu durdurulmadan yer değiştirme denendi: sunucunun çalışma
// klasörü app\ olduğu için Windows taşımayı reddetti. Burada görev kapatılır, bekçi görevin dışından açılır; görevi
// kapatmak ve bitirmek sunucuya dokunmaz, kurucu onu kurulum klasöründeki Node süreçlerinden bulmalı
spawnSync('schtasks', ['/Change', '/TN', 'LafPOS Sunucu', '/DISABLE'], { stdio: 'ignore' });
spawnSync('schtasks', ['/End', '/TN', 'LafPOS Sunucu'], { stdio: 'ignore' });
await sleep(3000);
// Görevin bitişi bekçiyi de kapatmadıysa denemenin kendisi kapatır (bekçi önce)
const gorevSonrasi = sunucuSurecleri();
if (gorevSonrasi.length) console.log(`  görev bittikten sonra açık: ${gorevSonrasi.map((p) => `${p.pid} ${p.komut}`).join(' · ')}`);
for (const p of [...gorevSonrasi].sort((a, b) => Number(/bekci\.mjs/.test(b.komut)) - Number(/bekci\.mjs/.test(a.komut)))) {
  spawnSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore' });
}
await until('görevin sunucusu durmadı', () => (sunucuSurecleri().length === 0 ? true : null), 60_000);
const elle = spawn(join(INSTALL, 'node', 'node.exe'), [join(INSTALL, 'app', 'bekci.mjs')], { cwd: INSTALL, detached: true, stdio: 'ignore', windowsHide: true });
elle.unref();
await until('görevin dışından açılan sunucu yanıt vermedi', async () => ((await health())?.build === BU_DERLEME ? true : null), 120_000);
const elleSurecler = sunucuSurecleri();
if (!elleSurecler.some((p) => /bekci\.mjs/.test(p.komut))) fail(`görevin dışından açılan bekçi görünmüyor: ${JSON.stringify(elleSurecler)}`);
console.log(`  görevin dışında: ${elleSurecler.map((p) => p.pid).join(', ')}`);
writeFileSync(isaret, 'F4b');
const f4b = await siteden();
await sitedenTamam(f4b, 'görevin dışında çalışan sunucuyla siteden kurulum', isaret);
const durmayan = sunucuSurecleri().filter((p) => elleSurecler.some((e) => e.pid === p.pid));
if (durmayan.length) fail(`görevin dışından açılan süreçler durdurulmadı: ${JSON.stringify(durmayan)}`);
console.log('  görevin dışındaki bekçi ve sunucu durduruldu, kurulum tamamlandı, sunucu görevle açıldı');

step('F5. Program klasörü başka bir programda açıkken: kurulum yarıda kalır, eski sürüm çalışmayı sürdürür');
// Kurulumun durdurmadığı bir süreç (çalışma klasörü app\) klasörü tutar: yer değiştirme 10 sn denenir, olmaz; yeni
// klasörler kalkar, eski sürüm yerinde kalır, görev yeniden açılır. Süreç kapanınca kurulum tamamlanır
writeFileSync(isaret, 'F5');
const tutan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { cwd: join(INSTALL, 'app'), stdio: 'ignore', windowsHide: true });
await sleep(2000);
const f5 = await siteden();
if (f5.status === 0) fail('app\\ klasörü başka bir programda açıkken siteden kurulum başarılı bitti');
console.log(`  kurucu ${f5.status} koduyla bitti (beklenen)`);
await until('yarıda kalan kurulumdan sonra eski sürüm yanıt vermedi', async () => ((await health())?.build === BU_DERLEME ? true : null), 120_000);
if (!existsSync(isaret)) fail('yarıda kalan kurulumdan sonra eski app\\ yerinde değil (işaret yok)');
for (const f of [join(INSTALL, 'app', 'bekci.mjs'), join(INSTALL, 'node', 'node.exe')]) if (!existsSync(f)) fail(`yarıda kalan kurulumdan sonra yok: ${f}`);
for (const d of ['kurulum.gecici', 'app.eski', 'node.eski']) if (existsSync(join(INSTALL, d))) fail(`yarıda kalan kurulumdan sonra ${d} kaldı`);
await gorevCalisiyor('yarıda kalan kurulumdan sonra');
tutan.kill();
await sleep(2000);
const f5b = await siteden();
await sitedenTamam(f5b, 'klasörü tutan program kapandıktan sonra siteden kurulum', isaret);
console.log('  yarıda kaldı, eski sürüm ve görev yerinde; program kapanınca kurulum tamamlandı');

step('F6. Gün açıkken sessiz kurulum dosyası ve sessiz siteden kurulum kurmadan çıkar');
// Satış sırasında kurmak sunucuyu bir dakika durdururdu. Gün patron girişiyle açılır (sıfır açılış; kasa zinciri boş)
const gunAc = await fetch(`http://127.0.0.1:${PORT}/api/cash/day/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${await login()}` },
  body: JSON.stringify({ openingCash: 0 }),
});
if (!gunAc.ok) fail(`gün açılamadı (${gunAc.status} ${await gunAc.text()})`);
const gunDurumu = await (await fetch(`http://127.0.0.1:${PORT}/api/kasa/guncelleme-durumu`)).json();
if (gunDurumu.dayOpen !== true) fail(`gün açık görünmüyor: ${JSON.stringify(gunDurumu)}`);
const onceF6 = kurulumOncesi('F6');
const kodF6 = kurKod(BU_EXE);
if (kodF6 !== KOD_GUN_ACIK) fail(`gün açıkken sessiz kurulum dosyası ${kodF6} koduyla bitti, beklenen ${KOD_GUN_ACIK}`);
await kurmadi('gün açıkken kurulum dosyası', onceF6);
console.log(`  kurulum dosyası ${kodF6} koduyla çıktı; sunucu ve görev yerinde`);
const f6 = await siteden();
if (f6.status !== 0) fail(`gün açıkken sessiz siteden kurulum ${f6.status} koduyla bitti${f6.hata ? ` (${f6.hata})` : ''}`);
await kurmadi('gün açıkken siteden kurulum', onceF6);
console.log('  siteden kurulum kurmadan çıktı; sunucu ve görev yerinde');

kanalSunucusu.closeAllConnections?.();
kanalSunucusu.close();
await vekil.close();
console.log('\n✓ Gerçek Windows: önceki sürümden güncelleme, ilk açılış yeni sürümle, kasa programı (tek pencere, bekçi, Edge), geri dönüş, eski kurulum dosyasının kurmaması, kaldırma, iki kurulumun eşitliği, çalışan kasada siteden kurulum ve gün açıkken kurmama tamam');
process.exit(0);
