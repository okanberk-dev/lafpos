// LafPOS sunucu bekçisi (Windows kurulumu). Görev Zamanlayıcı bunu açılışta SYSTEM olarak çalıştırır:
// ayarlar.env'yi okur, sunucuyu başlatır, düşerse artan beklemeyle (1 sn → 30 sn) yeniden başlatır ve
// çıktıyı tarihli satırlarla logs/sunucu.log'a yazar. Bekçi kapanınca sunucu da kapanır (Windows iş nesnesi).
// Veri klasörü: LAFPOS_HOME, yoksa C:\ProgramData\LafPOS. Ayrıntı: docs/05-KASA-BILGISAYARI.md
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.LAFPOS_HOME || join(process.env.ProgramData || 'C:\\ProgramData', 'LafPOS');
const LOG = join(HOME, 'logs', 'sunucu.log');
const LOG_MAX = 5 * 1024 * 1024;
const LOG_KEEP = 3;
mkdirSync(dirname(LOG), { recursive: true });

/** ayarlar.env: ANAHTAR=değer satırları; # yorum. Sunucunun .env okuyucusuyla aynı kurallar */
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function rotate() {
  try {
    if (!existsSync(LOG) || statSync(LOG).size < LOG_MAX) return;
    rmSync(`${LOG}.${LOG_KEEP}`, { force: true });
    for (let i = LOG_KEEP - 1; i >= 1; i--) if (existsSync(`${LOG}.${i}`)) renameSync(`${LOG}.${i}`, `${LOG}.${i + 1}`);
    renameSync(LOG, `${LOG}.1`);
  } catch {
    /* günlük dönmezse yazmaya devam */
  }
}

function log(line) {
  // sv-SE yerel saati YYYY-AA-GG SS:dd:ss yazar
  const text = `${new Date().toLocaleString('sv-SE')} ${line}\n`;
  if (process.stdout.isTTY) process.stdout.write(text);
  try {
    rotate();
    appendFileSync(LOG, text);
  } catch {
    /* disk dolu ya da kilitli: sunucu çalışmaya devam etsin */
  }
}

function pipe(stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      log(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => buf && log(buf));
}

// Gerçek ortam değişkeni dosyadakini ezer (sunucunun .env kuralı); veri klasörü ve üretim modu sabit
const env = { ...readEnvFile(join(HOME, 'ayarlar.env')), ...process.env, NODE_ENV: 'production', LAFPOS_DATA_DIR: HOME };

let child = null;
let stopping = false;
let delay = 1000;

function start() {
  const startedAt = Date.now();
  let done = false;
  const onDone = (why) => {
    if (done) return;
    done = true;
    child = null;
    if (stopping) process.exit(0);
    if (Date.now() - startedAt > 60_000) delay = 1000;
    log(`[bekçi] sunucu durdu (${why}); ${delay / 1000} sn sonra yeniden başlıyor`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30_000);
  };
  child = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('error', (e) => onDone(`başlatılamadı: ${e.message}`));
  child.on('exit', (code, signal) => onDone(signal ? `sinyal ${signal}` : `kod ${code}`));
}

function stop() {
  stopping = true;
  if (!child) process.exit(0);
  child.kill();
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop);

log(`[bekçi] LafPOS başlıyor (Node ${process.versions.node}, veri: ${HOME})`);
start();
