// AsilPOS sunucu bekçisi (Windows kurulumu). Görev Zamanlayıcı bunu açılışta SYSTEM olarak çalıştırır:
// ayarlar.env'yi okur, sunucuyu başlatır, düşerse artan beklemeyle (1 sn → 30 sn) yeniden başlatır ve
// çıktıyı tarihli satırlarla logs/sunucu.log'a yazar. ayarlar.env kaydedilince sunucu yeni ayarlarla yeniden
// başlar. Bekçi kapanınca sunucu da kapanır (Windows iş nesnesi). Sunucunun JavaScript belleği sınırlı
// (ASILPOS_MAX_HEAP_MB; varsayılan bilgisayarın belleğinin dörtte biri, 1024-4096 MB, ayarlar.mjs): sızıntı kasa
// bilgisayarının belleğini bitirmez, sınıra varan sunucu düşer ve bekçi onu yeniden başlatır.
// Otomatik güncelleme (guncelle.mjs) de burada çalışır: yeni sürümü gün kapalıyken kurar, başarıda bekçi 75 koduyla
// çıkar ve görevin başlatıcısı (baslat.cmd) onu yeni sürümle yeniden açar.
// Veri klasörü: ASILPOS_HOME, yoksa C:\ProgramData\LafPOS. Ayrıntı: docs/05-KASA-BILGISAYARI.md
// Ad değişikliği (26 Kasım 2026): değişkenler ASILPOS_*; kurulu kasanın ayarlar.env'i ve eski güncelleyici eski adla
// yazar. Bekçi ikisini de okur ve sunucuya ikisini de verir (eski sürüme dönülürse eski sunucu eski adı okur)
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watchFile } from 'node:fs';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEAP_MAX_MB, HEAP_MIN_MB, heapLimitMb, validHeapSetting } from './ayarlar.mjs';
import { applyPendingRestore, recoverMissingDb } from './geri-yukle.mjs';
import { channelUrls, createUpdater, readInstalled, updateMode } from './guncelle.mjs';
import { refreshInstall } from './kurulum-yenile.mjs';

const APP = dirname(fileURLToPath(import.meta.url));
/** Kurulum klasörü (app\, node\, baslat.cmd). Çalışma klasörü burası: güncelleme app\ klasörünün adını değiştirir,
 * Windows çalışan bir sürecin içinde durduğu klasörü taşıtmaz */
const INSTALL_DIR = dirname(APP);
process.chdir(INSTALL_DIR);
/** Eski adlar (shared/eski-adlar.ts; bu betik TypeScript içe aktaramaz): kurulu kasanın klasörü ve değişken öneki */
const ESKI = { klasor: 'LafPOS', envOneki: 'LAFPOS_' }; // eski-ad
const YENI_ONEK = 'ASILPOS_';
/** `ASILPOS_X`, yoksa eski adla X */
const posEnv = (vars, ad) => vars[YENI_ONEK + ad] ?? vars[ESKI.envOneki + ad];
/**
 * Değişkenleri iki adla da doldurur: yeni ad tanımlıysa eskisi (yoksa) ondan, eski ad tanımlıysa yenisi (yoksa) ondan.
 * Sunucu yeni adı okur; geri dönülen eski sürüm eski adı
 */
function ikiAdla(vars) {
  const out = { ...vars };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    const es = k.startsWith(YENI_ONEK) ? ESKI.envOneki + k.slice(YENI_ONEK.length) : k.startsWith(ESKI.envOneki) ? YENI_ONEK + k.slice(ESKI.envOneki.length) : null;
    if (es && out[es] === undefined) out[es] = v;
  }
  return out;
}
const HOME = posEnv(process.env, 'HOME') || join(process.env.ProgramData || 'C:\\ProgramData', ESKI.klasor);
const ENV_FILE = join(HOME, 'ayarlar.env');
const LOG = join(HOME, 'logs', 'sunucu.log');
const LOG_MAX = 5 * 1024 * 1024;
const LOG_KEEP = 3;
/** Sunucu "kapat"tan sonra bu kadar içinde kapanmazsa sonlandırılır */
const STOP_GRACE_MS = 5000;
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
// Her başlatmada dosya yeniden okunur: ayar değişikliği yeniden başlatmayla geçerli olur. Sunucu dosyanın yerini
// ASILPOS_AYAR_DOSYASI'ndan bilir: Yönetim › Bağlantı bilgileri oraya yazar, bekçi değişikliği görüp yeniden başlatır.
// Bekçinin verdikleri iki adla (eski sürüme dönüş)
const fixedEnv = () => {
  const out = { NODE_ENV: 'production' };
  for (const [ad, v] of [['DATA_DIR', HOME], ['STDIN_CONTROL', '1'], ['AYAR_DOSYASI', ENV_FILE]]) out[YENI_ONEK + ad] = out[ESKI.envOneki + ad] = v;
  return out;
};
const envFor = () => ({ ...ikiAdla({ ...readEnvFile(ENV_FILE), ...process.env }), ...fixedEnv() });

let child = null;
let stopping = false;
/** Ayar değişikliğiyle bilerek durduruldu: beklemeden ve hata sayılmadan yeniden başlar */
let restarting = false;
let delay = 1000;
/** Güncelleme sunucuyu durdurdu: düşünce yeniden başlatılmaz */
let paused = false;
/** Sunucu durunca çağrılır (güncellemenin "durdur"u bekler) */
let onStopped = null;
/** Günlüğe son yazılan bellek sınırı: yalnız değişince yeniden yazılır */
let loggedHeap = null;

function start() {
  const startedAt = Date.now();
  let done = false;
  const onDone = (why) => {
    if (done) return;
    done = true;
    child = null;
    if (onStopped) {
      const cb = onStopped;
      onStopped = null;
      cb();
    }
    if (stopping) process.exit(0);
    if (paused) {
      log('[bekçi] sunucu güncelleme için durduruldu');
      return;
    }
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
  // Buluttan geri yükleme bekliyorsa sunucu açılmadan veritabanı değişir (önce kopyası alınır)
  try {
    const restored = applyPendingRestore(HOME);
    if (restored) log(`[bekçi] ${restored}`);
  } catch (e) {
    log(`[bekçi] geri yükleme uygulanamadı: ${e instanceof Error ? e.message : e}`);
  }
  // Veritabanı yerinde değilken (yarıda kalmış geri yükleme) sunucu boş veritabanıyla açılmaz: önce geri taşınır
  const stuck = recoverMissingDb(HOME);
  if (stuck) {
    log(`[bekçi] ${stuck}`);
    setTimeout(start, 5000);
    return;
  }
  const env = envFor();
  const heapMb = heapLimitMb(env.ASILPOS_MAX_HEAP_MB, totalmem());
  const raw = env.ASILPOS_MAX_HEAP_MB;
  const heapNote = `${heapMb} MB${raw && !validHeapSetting(raw) ? ` (ASILPOS_MAX_HEAP_MB=${raw} ${HEAP_MIN_MB}-${HEAP_MAX_MB} arasında değil, yok sayıldı)` : ''}`;
  if (heapNote !== loggedHeap) log(`[bekçi] sunucunun bellek sınırı ${heapNote}`);
  loggedHeap = heapNote;
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
// Eski güncelleyici eski adla verir (shared/eski-adlar.ts ESKI_BEKCI_STDIN_ENV)
if (posEnv(process.env, 'BEKCI_STDIN') === '1') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => String(d).includes('kapat') && stop());
}

/** Güncellemenin sunucuyu durdurup yeniden açması */
const serverControl = {
  stop: () =>
    new Promise((resolve) => {
      paused = true;
      if (!child) return resolve();
      onStopped = resolve;
      stopChild();
    }),
  start: () => {
    paused = false;
    if (!child && !stopping) start();
  },
};

// Deneme bekçisi (güncellemenin yeni sürümü sınadığı) güncelleme denetlemez
const updater =
  posEnv(process.env, 'GUNCELLEME_DENEME') === '1'
    ? null
    : createUpdater({
        installDir: INSTALL_DIR,
        home: HOME,
        log,
        port: () => Number(envFor().ASILPOS_PORT) || 4000,
        mode: () => updateMode(envFor()),
        manifestUrls: () => channelUrls(envFor()),
        server: serverControl,
        exit: (code) => {
          stopping = true;
          log(`[bekçi] yeni sürümle yeniden açılıyor (kod ${code})`);
          process.exit(code);
        },
      });

// Ayar dosyası kaydedilince (Not Defteri hangi sürüm olursa olsun) sunucu yeni ayarlarla yeniden başlar
watchFile(ENV_FILE, { interval: WATCH_MS }, (cur, prev) => {
  if (cur.mtimeMs === prev.mtimeMs || stopping) return;
  updater?.poke();
  if (!child || paused) return;
  log('[bekçi] ayarlar.env değişti; sunucu yeniden başlatılıyor');
  restarting = true;
  stopChild();
});

/**
 * "Şimdi güncelle" (Yönetim › Ayarlar ve yedek): sunucu guncelleme\istek.json yazar, bekçi 2 sn'de bir bakar, dosyayı
 * siler ve isteği güncelleyiciye iletir. 10 dakikadan eski istek (bekçi kapalıyken yazılmış) yok sayılır.
 * Kurulum dosyası da (asilpos.nsi) sunucuyu açmadan önce aynı biçimde yazar (`by: 'kurulum'`, hep `simdi: false`):
 * kurulum biter bitmez kanaldaki daha yeni sürüm iki dakika beklenmeden istenir, gün kapalıyken kurulur. Kimsenin
 * basmadığı bu istek otomatik güncelleme kapalıyken (ayarlar.env ASILPOS_GUNCELLEME=kapali) yok sayılır; elle istek
 * kapalıyken de çalışır
 */
const REQUEST_FILE = join(HOME, 'guncelleme', 'istek.json');
const KURULUM_ISTEGI = 'kurulum';
function takeRequest() {
  if (!updater || stopping || !existsSync(REQUEST_FILE)) return;
  let req = null;
  try {
    req = JSON.parse(readFileSync(REQUEST_FILE, 'utf8'));
  } catch {
    req = null;
  }
  rmSync(REQUEST_FILE, { force: true });
  const fresh = req && typeof req.at === 'number' && Date.now() - req.at < 10 * 60_000;
  if (!fresh) return;
  if (req.by === KURULUM_ISTEGI) {
    if (updateMode(envFor()) === 'kapali') {
      log('[bekçi] kurulumun güncelleme isteği yok sayıldı: otomatik güncelleme kapalı');
      return;
    }
    log('[bekçi] kurulumun güncelleme isteği: yeni sürüm hemen denetleniyor');
    updater.requestNow({ force: false }).catch((e) => log(`[güncelleme] istek işlenemedi: ${e instanceof Error ? e.message : e}`));
    return;
  }
  log(`[bekçi] elle güncelleme isteği${req.simdi === true ? ' (şimdi kur)' : ''}`);
  updater.requestNow({ force: req.simdi === true }).catch((e) => log(`[güncelleme] istek işlenemedi: ${e instanceof Error ? e.message : e}`));
}
watchFile(REQUEST_FILE, { interval: 2000 }, (cur) => {
  if (cur.mtimeMs) takeRequest();
});


log(`[bekçi] AsilPOS başlıyor (Node ${process.versions.node}, veri: ${HOME})`);
start();
try {
  updater?.start();
} catch (e) {
  log(`[güncelleme] başlatılamadı: ${e instanceof Error ? e.message : e}`);
}
// Güncelleme yalnız app\ ve node\'u değiştirir: kök dosyalar (kasa kısayolu, yönetim betiği...) ve Başlat menüsü,
// masaüstü, Başlangıç kısayolları burada yeni sürümle yenilenir; yapılamayan kalırsa durum.json'a uyarı (panelde
// "Kurulumu yenileyin"). Güncellemenin deneme bekçisinde updater yok, dokunulmaz. Kurulum derlemesinin paket denemesi
// (derle.mjs, ASILPOS_PAKET_DENEME=1) bekçiyi geçici klasörden açar: yenilese, yönetici kabuğunda bu bilgisayardaki
// AsilPOS'un ortak kısayollarını deneme bitince silinen klasöre çevirirdi (inceleme, 23 Kas 2026). Güncelleyici orada
// da çalışır: deneme onun durum dosyasına bakar
if (updater && process.env.ASILPOS_PAKET_DENEME !== '1') {
  refreshInstall({ appDir: APP, installDir: INSTALL_DIR, home: HOME, build: readInstalled(APP).build, log, setWarning: (w) => updater.setInstallWarning(w) }).catch((e) =>
    log(`[kurulum] yenilenemedi: ${e instanceof Error ? e.message : e}`),
  );
}
// Bekçi kapalıyken yazılmış taze istek (ör. kullanıcı bastı, bilgisayar yeniden başladı) açılışta işlenir
takeRequest();
