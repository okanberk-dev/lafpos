// LafPOS sunucu bekçisi (Windows kurulumu). Görev Zamanlayıcı bunu açılışta SYSTEM olarak çalıştırır:
// ayarlar.env'yi okur, sunucuyu başlatır, düşerse artan beklemeyle (1 sn → 30 sn) yeniden başlatır ve
// çıktıyı tarihli satırlarla logs/sunucu.log'a yazar. ayarlar.env kaydedilince sunucu yeni ayarlarla yeniden
// başlar. Bekçi kapanınca sunucu da kapanır (Windows iş nesnesi). Sunucunun JavaScript belleği sınırlı
// (LAFPOS_MAX_HEAP_MB, varsayılan 512): sızıntı kasa bilgisayarının belleğini bitirmez, sınıra varan sunucu düşer
// ve bekçi onu yeniden başlatır.
// Veri klasörü: LAFPOS_HOME, yoksa C:\ProgramData\LafPOS. Ayrıntı: docs/05-KASA-BILGISAYARI.md
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.LAFPOS_HOME || join(process.env.ProgramData || 'C:\\ProgramData', 'LafPOS');
const ENV_FILE = join(HOME, 'ayarlar.env');
const LOG = join(HOME, 'logs', 'sunucu.log');
const LOG_MAX = 5 * 1024 * 1024;
const LOG_KEEP = 3;
/** Sunucu "kapat"tan sonra bu kadar içinde kapanmazsa sonlandırılır */
const STOP_GRACE_MS = 5000;
/** Sunucunun V8 yığın sınırı (MB); ayarlar.env'de LAFPOS_MAX_HEAP_MB ile 256-4096 arası değişir */
const HEAP_MB = 512;
/** ayarlar.env'nin denetlenme aralığı: kaydettikten birkaç saniye sonra yeniden başlar, boşta disk yoklanmaz */
const WATCH_MS = 5000;
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

// Gerçek ortam değişkeni dosyadakini ezer (sunucunun .env kuralı); veri klasörü ve üretim modu sabit.
// Her başlatmada dosya yeniden okunur: ayar değişikliği yeniden başlatmayla geçerli olur
const envFor = () => ({ ...readEnvFile(ENV_FILE), ...process.env, NODE_ENV: 'production', LAFPOS_DATA_DIR: HOME, LAFPOS_STDIN_CONTROL: '1' });

let child = null;
let stopping = false;
/** Ayar değişikliğiyle bilerek durduruldu: beklemeden ve hata sayılmadan yeniden başlar */
let restarting = false;
let delay = 1000;

function start() {
  const startedAt = Date.now();
  let done = false;
  const onDone = (why) => {
    if (done) return;
    done = true;
    child = null;
    if (stopping) process.exit(0);
    if (restarting) {
      restarting = false;
      log('[bekçi] sunucu yeni ayarlarla başlıyor');
      setTimeout(start, 300);
      return;
    }
    if (Date.now() - startedAt > 60_000) delay = 1000;
    log(`[bekçi] sunucu durdu (${why}); ${delay / 1000} sn sonra yeniden başlıyor`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30_000);
  };
  const env = envFor();
  const heap = Number(env.LAFPOS_MAX_HEAP_MB);
  const heapMb = Number.isInteger(heap) && heap >= 256 && heap <= 4096 ? heap : HEAP_MB;
  child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, join(APP, 'server', 'index.mjs')], { cwd: APP, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => {
    /* sunucu kapanırken yazılamayan "kapat" */
  });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('error', (e) => onDone(`başlatılamadı: ${e.message}`));
  child.on('exit', (code, signal) => onDone(signal ? `sinyal ${signal}` : `kod ${code}`));
}

/** Sunucuya "kapat" yazar (veritabanını kapatıp çıkar); süresinde kapanmazsa sonlandırır */
function stopChild() {
  const c = child;
  if (!c) return;
  try {
    c.stdin.write('kapat\n');
  } catch {
    c.kill();
  }
  setTimeout(() => c.exitCode == null && c.signalCode == null && c.kill(), STOP_GRACE_MS).unref();
}

function stop() {
  stopping = true;
  if (!child) process.exit(0);
  stopChild();
  setTimeout(() => process.exit(0), STOP_GRACE_MS + 1000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop);
// Kurulum derlemesinin denemesi (derle.mjs) Windows'ta sinyal gönderemez (süreci sonlandırmak kapanış kodunu
// çalıştırmaz): standart girdiden "kapat" bekçiyi düzgün durdurur. Görev Zamanlayıcı'da tanımsız
if (process.env.LAFPOS_BEKCI_STDIN === '1') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => String(d).includes('kapat') && stop());
}

// Ayar dosyası kaydedilince (Not Defteri hangi sürüm olursa olsun) sunucu yeni ayarlarla yeniden başlar
watchFile(ENV_FILE, { interval: WATCH_MS }, (cur, prev) => {
  if (cur.mtimeMs === prev.mtimeMs || stopping || !child) return;
  log('[bekçi] ayarlar.env değişti; sunucu yeniden başlatılıyor');
  restarting = true;
  stopChild();
});

log(`[bekçi] LafPOS başlıyor (Node ${process.versions.node}, veri: ${HOME})`);
start();
