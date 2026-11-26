// AsilPOS'un otomatik güncellemesi (Windows kurulumu). Bekçi (bekci.mjs) bunu SYSTEM olarak çalıştırır; ayar ve anahtar
// gerekmez. Güncelleme kanalı Vercel'deki proje (adı eski adla kaldı) (kanal.mjs her main derlemesinde yazar): sırayla
// MANIFEST_URLS'teki surum.json, yalnız HTTPS, başka hosta yönlendirme reddedilir; açılıştan 2 dk sonra, sonra 3 dk'da
// bir (ETag: değişmeyen kanal gövde göndermez). Yeni derleme (`build`, HEAD commit'inin zamanı) varsa uygulama yükünü
// (lafpos-app-<build>.zip) aynı adresten indirir, boyunu ve SHA-256'sını doğrular; Node ya da better-sqlite3 değiştiyse
// onları açık kaynaklarından (nodejs.org, WiseLibs'in GitHub sürümü) indirip manifestteki özetle doğrular.
// Kurulum yalnız açık iş günü yokken (sunucuya bu bilgisayardan sorulur): yük app.yeni'ye açılır, sunucu düzgün durur,
// veritabanının kopyası alınır, app → app.eski ve app.yeni → app olur, yeni sürüm (yeni bekçi ve sunucu) deneme olarak
// açılır; 60 sn içinde /api/health yeni derlemeyi söylemezse eski klasöre dönülür ve o derleme bir daha denenmez.
// Başarıda bekçi 75 koduyla çıkar: zamanlanmış görevin başlatıcısı (baslat.cmd) varsa yeni node.exe'yi yerine koyup
// bekçiyi yeni sürümle yeniden açar. ASILPOS_GUNCELLEME=kapali (ayarlar.env; kurulu kasada eski adla da) kapatır.
// Ad değişikliği (26 Kasım 2026): kanal adresleri, yükün adı (lafpos-app-<build>.zip), veritabanı ve kopyalarının adı
// eski adla kalır (shared/eski-adlar.ts): eski güncelleyiciler ve eski sürüme dönüş onları arar
// Durum veri klasöründe guncelleme\durum.json; sunucu onu Yönetim › Ayarlar ve yedek'te gösterir.
// Bağımlılıksız; pakete girer (paket.mjs). Saf yardımcıların ve kurulum akışının testi tests/guncelleme.test.ts.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entryData, extractZip, readTarGz, readZip } from './arsiv.mjs';

/** `ASILPOS_X`, yoksa kurulu kasanın ayarlar.env'indeki eski adla X */
const posEnv = (vars, ad) => vars?.[`ASILPOS_${ad}`] ?? vars?.[`LAFPOS_${ad}`];

/** Güncelleme kanalı: önce alan adı, o yoksa Vercel'in kendi adresi */
export const MANIFEST_URLS = ['https://lafpos.laffogato.net/guncelleme/surum.json', 'https://lafpos.vercel.app/guncelleme/surum.json'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Adres izinli mi: HTTPS ya da (yalnız bu bilgisayardaki deneme kanalı için) loopback HTTP */
export const allowedUrl = (u) => u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));

/**
 * Kanalın adresleri: ayarlar.env'de ASILPOS_GUNCELLEME_KANAL (virgülle) varsa onlar (Windows CI'daki gerçek kurulum
 * denemesi yerel kanalı böyle gösterir; .github/workflows/windows.yml), yoksa sitenin kanalı. Geçersiz adres düşer
 */
export function channelUrls(vars) {
  const list = String(posEnv(vars, 'GUNCELLEME_KANAL') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return allowedUrl(new URL(s));
      } catch {
        return false;
      }
    });
  return list.length ? list : MANIFEST_URLS;
}
export const FIRST_CHECK_MS = 2 * 60_000;
/**
 * Kanal denetimi 3 dakikada bir (sahip: güncelleme anlığa yakın gelsin, 22 Kas 2026). surum.json Vercel'in statik
 * dosyası: Redis ya da işlev çağrısı harcamaz; günde ~480 küçük istek. Kurulum yine Merkez'in hedefiyle ve gün
 * kapalıyken (ya da kasada "Şimdi güncelle"yle); nabız 5 dakikada bir kalır (Upstash komut sınırı)
 */
export const CHECK_EVERY_MS = 3 * 60_000;
/** Kurulum hazırken gün açıksa sunucuya (yalnız bu bilgisayardan) bu aralıkla yeniden sorulur */
export const DAY_POLL_MS = 5 * 60_000;
/** Yeni sürümün açılıp /api/health'te yeni derlemeyi söylemesi için süre */
export const HEALTH_TIMEOUT_MS = 60_000;
/** Bekçinin "beni yeni sürümle yeniden aç" çıkış kodu (baslat.cmd döngüsü) */
export const RESTART_EXIT_CODE = 75;
/** İndirmelerin üst sınırı: bundan büyük yanıt indirilmez */
export const MAX_BYTES = { app: 200 * 2 ** 20, node: 150 * 2 ** 20, sqlite: 50 * 2 ** 20, manifest: 64 * 1024 };
/** Açık kaynakların izinli yönlendirmesi: GitHub sürüm dosyası imzalı bir depolama adresine yönlenir */
export const SQLITE_REDIRECT_HOSTS = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
/** Yük içinde better-sqlite3'ün Windows ikilisi (paket.mjs SQLITE_BINARY ile aynı) */
export const SQLITE_BINARY = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
/** Güncellemenin aldığı veritabanı kopyalarından tutulan (kurulum dosyasının kopyaları da aynı adla başlar) */
export const KEEP_UPDATE_BACKUPS = 5;
export const STATES = ['guncel', 'indiriliyor', 'bekliyor', 'kuruluyor', 'geri-dondu', 'hata', 'kapali'];
const SHA_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

// ─── Ayar ve manifest ────────────────────────────────────────────────────────

/** ayarlar.env'deki ASILPOS_GUNCELLEME: "kapali" (kapalı, off, hayir, 0, false) değilse otomatik */
export function updateMode(vars) {
  const raw = String(posEnv(vars, 'GUNCELLEME') ?? '')
    .trim()
    .toLocaleLowerCase('tr');
  return ['kapali', 'kapalı', 'kapat', 'off', 'hayir', 'hayır', 'no', 'false', '0'].includes(raw) ? 'kapali' : 'otomatik';
}

/** Yükün adı: eski güncelleyiciler `lafpos-app-<build>.zip`'ten başkasını reddeder; bu sürüm ileride yeni adı da kabul eder */
export const appZipName = (build) => `lafpos-app-${build}.zip`;
const yeniZipAdi = (build) => `asilpos-app-${build}.zip`;
export const nodeZipUrl = (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`;
export const sqliteTarUrl = (v, abi) => `https://github.com/WiseLibs/better-sqlite3/releases/download/v${v}/better-sqlite3-v${v}-node-v${abi}-win32-x64.tar.gz`;

/**
 * surum.json → doğrulanmış güncelleme. Uygulama yükünün adresi manifestin adresinden kurulur (aynı host); Node ve
 * better-sqlite3'ün adresleri sabit kalıptan (manifest yalnız sürüm ve özet verir). Anlaşılmayan alan hata
 */
export function parseManifest(json, manifestUrl) {
  const m = json && typeof json === 'object' ? json : null;
  if (!m || m.v !== 1) throw new Error('surum.json anlaşılamadı (v)');
  const build = m.build;
  if (!Number.isInteger(build) || build < 1e9 || build > 1e11) throw new Error('surum.json: derleme numarası anlaşılamadı');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) throw new Error('surum.json: sürüm anlaşılamadı');
  const app = m.app ?? {};
  if (app.file !== appZipName(build) && app.file !== yeniZipAdi(build)) throw new Error('surum.json: uygulama yükünün adı beklenmedik');
  if (!SHA_RE.test(String(app.sha256))) throw new Error('surum.json: uygulama yükünün özeti anlaşılamadı');
  if (!Number.isInteger(app.size) || app.size <= 0 || app.size > MAX_BYTES.app) throw new Error('surum.json: uygulama yükünün boyu anlaşılamadı');
  const node = m.node ?? {};
  if (!SEMVER_RE.test(String(node.version)) || !/^\d{2,4}$/.test(String(node.abi)) || !SHA_RE.test(String(node.sha256))) throw new Error('surum.json: Node bilgisi anlaşılamadı');
  const sqlite = m.sqlite ?? {};
  if (!SEMVER_RE.test(String(sqlite.version)) || !SHA_RE.test(String(sqlite.sha256))) throw new Error('surum.json: better-sqlite3 bilgisi anlaşılamadı');
  const base = new URL(manifestUrl);
  const url = new URL(app.file, base);
  if (url.origin !== base.origin) throw new Error('surum.json: uygulama yükü başka adreste');
  return {
    build,
    version: m.version,
    commit: typeof m.commit === 'string' ? m.commit.slice(0, 40) : '',
    app: { file: app.file, url: url.href, sha256: app.sha256, size: app.size },
    node: { version: node.version, abi: String(node.abi), sha256: node.sha256, url: nodeZipUrl(node.version) },
    sqlite: { version: sqlite.version, sha256: sqlite.sha256, url: sqliteTarUrl(sqlite.version, node.abi) },
  };
}

/** Yönlendirmeye izin var mı: yalnız HTTPS; aynı host ya da açıkça izin verilen depolama hostu */
export function redirectAllowed(from, to, extraHosts = []) {
  let a;
  let b;
  try {
    a = new URL(from);
    b = new URL(to, from);
  } catch {
    return false;
  }
  return b.protocol === 'https:' && (b.host === a.host || extraHosts.includes(b.host));
}

/** app\package.json → kurulu sürüm; okunamazsa derleme 0 (her derleme yenidir) */
export function readInstalled(appDir) {
  try {
    const p = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    return {
      version: typeof p.version === 'string' ? p.version : '',
      build: Number.isInteger(p.build) ? p.build : 0,
      sqlite: typeof p.sqlite === 'string' ? p.sqlite : '',
      nodeAbi: p.nodeAbi != null ? String(p.nodeAbi) : '',
    };
  } catch {
    return { version: '', build: 0, sqlite: '', nodeAbi: '' };
  }
}

/**
 * Ne kurulacak (saf): manifestteki derleme kurulandan yeni değilse ya da daha önce denenip geri dönüldüyse hiçbir şey.
 * Node, çalışan Node'dan farklıysa değişir; better-sqlite3 sürümü ya da Node ABI'si değişince yerel modül de
 */
export function planUpdate({ installed, nodeVersion, manifest, failed = [], cap = Infinity }) {
  if (!manifest || manifest.build <= installed.build || failed.includes(manifest.build) || manifest.build > cap) return null;
  return {
    build: manifest.build,
    version: manifest.version,
    node: manifest.node.version !== nodeVersion,
    sqlite: manifest.sqlite.version !== installed.sqlite || manifest.node.abi !== installed.nodeAbi,
  };
}

/**
 * Merkez'in sınırı (saf): kurulacak en yeni derleme. Sunucu Merkez açık derse izin gönderilen derlemeye bağlıdır:
 * kurulu derlemeden yeni hedef gönderildiyse en çok o kurulur (sonradan main'e giren, gönderilmemiş derleme kendiliğinden
 * kurulmaz). Kanal ilerlerse indirilmiş yük tutulur (check); yük yoksa kasa bekler, panel "gönderilmedi" gösterir.
 * Hedef yoksa ya da kurulu derlemeden yeni değilse yerinde kalınır. Merkez kapalıysa sınır yok (kanalın son sürümü).
 * Sunucuya ulaşılamazsa son bilinen karar geçerli. `merkez`: durum.json'a yazılacak son karar
 */
const allowed = (hedef, installedBuild) => (hedef != null && hedef > (installedBuild ?? 0) ? hedef : (installedBuild ?? 0));
export function merkezCap({ server, last, installedBuild }) {
  const m = server?.merkez;
  if (m && typeof m.enabled === 'boolean') {
    const hedef = Number.isInteger(m.hedef) ? m.hedef : null;
    if (!m.enabled) return { cap: Infinity, merkez: { acik: false, hedef: null } };
    return { cap: allowed(hedef, installedBuild), merkez: { acik: true, hedef } };
  }
  if (last?.acik) return { cap: allowed(Number.isInteger(last.hedef) ? last.hedef : null, installedBuild), merkez: last };
  return { cap: Infinity, merkez: last ?? null };
}

/** "Şimdi güncelle"de satış/ödeme bitsin diye bekleme: 5 sn'de bir sorulur, en çok 15 dakika */
export const BUSY_POLL_MS = 5_000;
export const BUSY_WAIT_MAX_MS = 15 * 60_000;

/**
 * Kurulum için an uygun mu (saf): yalnız sunucu "açık gün yok" derse. Gün kapalı ama cihazda banka gün sonu sürüyorsa
 * (`eod`: gün kapanınca arka planda başlar, en çok 3 dk) sonraki soruya kalır: kurulum sunucuyu durdurursa gün sonunun
 * sonucu belirsiz kalır, kâğıdı basılmaz (inceleme, 23 Kas 2026). Gün kapalıyken sunucunun öbür meşguliyeti (`mesgul`)
 * beklenmez: yazarkasada bekleyen sepet gün kapalıyken de kalabilir (gün sonunu yalnız kasanın açık adisyonu tutar,
 * site siparişinin sepeti tutmaz) ve biri çözene dek sürer; bekleme gün sonuyla sınırlı kalır
 */
export function installDecision(dayOpen, eod = false) {
  if (dayOpen === false) return eod === true ? 'gun-sonu' : 'kur';
  return dayOpen === true ? 'gun-acik' : 'bilinmiyor';
}

/** Zip'teki kayıt → app.yeni'deki yeri. Yerel modül yükte olmamalı (eskisinden ya da indirilenden gelir) */
export function appEntry(name) {
  if (name === SQLITE_BINARY) throw new Error('Uygulama yükünde better-sqlite3 ikilisi olmamalı');
  return name;
}

const pad = (n) => String(n).padStart(2, '0');
/** Güncellemenin aldığı veritabanı kopyasının adı (yerel saat; kurulum dosyasının kopyalarıyla aynı önek) */
export function backupName(build, at) {
  const d = new Date(at);
  return `lafpos-guncelleme-${build}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
}

/** Tutulacak sayıdan fazla güncelleme kopyası: en eskiler (ada göre değil, verilen zamana göre) */
export function oldUpdateBackups(files, keep = KEEP_UPDATE_BACKUPS) {
  const dbs = files.filter((f) => /^lafpos-guncelleme-.*\.db$/.test(f.name)).sort((a, b) => b.at - a.at);
  return dbs.slice(keep).flatMap((f) => [f.name, `${f.name}-wal`]);
}

/** İndirme klasöründe artık gerekmeyenler: yarım indirmeler ve kurulmuş ya da eskimiş derlemelerin yükü */
export function staleDownloads(names, keepBuild) {
  return names.filter((n) => {
    if (n.endsWith('.part')) return true;
    const m = /^(?:lafpos-app-|asilpos-app-)(\d+)\.zip$/.exec(n);
    return !!m && Number(m[1]) !== keepBuild;
  });
}

// ─── Durum ───────────────────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();
const BASE = { durum: 'guncel', mesaj: '', kurulu: null, yeni: null, sonKontrol: null, sonBasariliKontrol: null, sonHata: null, sonKurulum: null, sonIstek: null, basarisiz: [], merkez: null, kurulumUyari: null };
const label = (x) => (x ? `${x.surum} (${x.build})` : '');

/**
 * durum.json'un bir sonraki hâli (saf). Olaylar: acilis {kurulu, mode, now} · kontrol {plan, manifest, now} ·
 * kontrol-hata {mesaj, now} · indiriliyor {yeni} · hazir {yeni} · gun-acik · kuruluyor {yeni, now} ·
 * kuruldu {kurulu, now} · geri-dondu {yeni, neden, now} · hata {mesaj, now} · mod {mode} · istek {simdi, now} ·
 * kurulum {uyari} (kök dosyalar ya da kısayollar yenilenemedi: kurulum-yenile.mjs; null: sorun yok)
 */
export function nextStatus(prev, ev) {
  const p = { ...BASE, ...(prev && typeof prev === 'object' ? prev : {}) };
  if (!Array.isArray(p.basarisiz)) p.basarisiz = [];
  switch (ev.type) {
    case 'acilis': {
      const base = { ...p, kurulu: ev.kurulu, sonHata: null };
      if (p.durum === 'kuruluyor' && p.yeni) {
        if (ev.kurulu?.build === p.yeni.build) return { ...base, durum: 'guncel', yeni: null, sonKurulum: iso(ev.now), mesaj: 'Güncellendi' };
        return { ...base, durum: 'hata', yeni: null, mesaj: 'Kurulum yarıda kaldı (bilgisayar kapanmış olabilir); eski sürüm çalışıyor, yeniden denenecek' };
      }
      if (ev.mode === 'kapali') return { ...base, durum: 'kapali', mesaj: 'Otomatik güncelleme kapalı (ayarlar.env: ASILPOS_GUNCELLEME=kapali)' };
      // Elle (kurulum dosyasıyla) daha yeni bir sürüm kurulduysa bekleyen yeni sürüm artık eskidir
      if (p.yeni && ev.kurulu && p.yeni.build <= ev.kurulu.build) return { ...base, durum: 'guncel', yeni: null, mesaj: 'Güncel' };
      if (p.durum === 'kapali' || p.durum === 'indiriliyor' || p.durum === 'kuruluyor' || !prev) return { ...base, durum: 'guncel', yeni: null, mesaj: 'Yeni sürüm birkaç dakika içinde denetlenecek' };
      return base;
    }
    case 'mesgul':
      // "Şimdi güncelle" istendi ama kasada satış ya da ödeme sürüyor: bitince kurulur
      return p.yeni ? { ...p, durum: 'bekliyor', mesaj: `${p.yeni.surum} hazır; satış ya da ödeme bitince hemen kurulacak` } : p;
    case 'istek':
      // Yönetim › Ayarlar ve yedek › "Şimdi güncelle": güncelleyici isteği aldı, kanala bakıyor
      return { ...p, sonIstek: iso(ev.now), mesaj: ev.simdi ? 'Yeni sürüm denetleniyor; varsa hemen kurulacak' : 'Yeni sürüm denetleniyor' };
    case 'mod':
      if (ev.mode === 'kapali') return { ...p, durum: 'kapali', mesaj: 'Otomatik güncelleme kapalı (ayarlar.env: ASILPOS_GUNCELLEME=kapali)' };
      return p.durum === 'kapali' ? { ...p, durum: 'guncel', mesaj: 'Otomatik güncelleme açıldı; yeni sürüm birkaç dakika içinde denetlenecek' } : p;
    case 'kontrol': {
      const base = { ...p, sonKontrol: iso(ev.now), sonBasariliKontrol: iso(ev.now), sonHata: null, merkez: ev.merkez ?? p.merkez };
      if (ev.plan) return base;
      // Kanalda yeni sürüm var ama Merkez bu dükkâna henüz göndermedi
      if (ev.held && ev.manifest && ev.kanalIlerledi) {
        return { ...base, durum: 'guncel', yeni: null, mesaj: `Gönderilen derleme (${ev.gonderilen}) kanalda yok, kanal ${label({ surum: ev.manifest.version, build: ev.manifest.build })} sürümüne ilerledi; Merkez'den yeniden gönderin` };
      }
      if (ev.held && ev.manifest) return { ...base, durum: 'guncel', yeni: null, mesaj: `Yeni sürüm ${label({ surum: ev.manifest.version, build: ev.manifest.build })} hazır; Merkez'den gönderilince kurulacak` };
      if (ev.manifest && p.basarisiz.includes(ev.manifest.build) && ev.manifest.build > (p.kurulu?.build ?? 0)) {
        return { ...base, durum: 'geri-dondu', yeni: null, mesaj: `${label({ surum: ev.manifest.version, build: ev.manifest.build })} kurulunca sorun çıkmıştı; eski sürüm çalışıyor. Bu sürüm bir daha denenmeyecek, sonraki sürüm beklenecek` };
      }
      return { ...base, durum: 'guncel', yeni: null, mesaj: 'Güncel' };
    }
    case 'kontrol-hata':
      return { ...p, sonKontrol: iso(ev.now), sonHata: { mesaj: String(ev.mesaj ?? '').slice(0, 300), at: iso(ev.now) } };
    case 'indiriliyor':
      return { ...p, durum: 'indiriliyor', yeni: ev.yeni, mesaj: 'Yeni sürüm indiriliyor' };
    case 'hazir':
      return { ...p, durum: 'bekliyor', yeni: ev.yeni, mesaj: 'Yeni sürüm indirildi; gün kapalıyken kurulacak' };
    case 'gun-acik':
      return { ...p, durum: 'bekliyor', mesaj: 'Yeni sürüm hazır; gün sonundan sonra kendiliğinden kurulacak' };
    case 'kuruluyor':
      return { ...p, durum: 'kuruluyor', yeni: ev.yeni, mesaj: 'Yeni sürüm kuruluyor; sunucu bir dakika kadar kapalı kalır' };
    case 'kuruldu':
      return { ...p, durum: 'guncel', kurulu: ev.kurulu, yeni: null, sonKurulum: iso(ev.now), sonHata: null, mesaj: 'Güncellendi' };
    case 'geri-dondu':
      return {
        ...p,
        durum: 'geri-dondu',
        yeni: null,
        basarisiz: [...p.basarisiz.filter((b) => b !== ev.yeni.build), ev.yeni.build].slice(-20),
        sonHata: { mesaj: String(ev.neden ?? '').slice(0, 300), at: iso(ev.now) },
        mesaj: `${label(ev.yeni)} kurulunca sorun çıktı; eski sürüme dönüldü. Bu sürüm bir daha denenmeyecek, sonraki sürüm beklenecek`,
      };
    case 'kurulum':
      return { ...p, kurulumUyari: typeof ev.uyari === 'string' && ev.uyari ? ev.uyari.slice(0, 300) : null };
    case 'hata':
      return { ...p, durum: 'hata', sonHata: { mesaj: String(ev.mesaj ?? '').slice(0, 300), at: iso(ev.now) }, mesaj: String(ev.mesaj ?? 'Bilinmeyen hata').slice(0, 300) };
    default:
      return p;
  }
}

// ─── Çalıştırıcı ─────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const errText = (e) => (e instanceof Error ? e.message : String(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dosya Windows x64 ikilisi mi (MZ + PE başlığı, makine 0x8664) */
export function assertWinX64(file) {
  const b = readFileSync(file);
  const pe = b.length > 0x40 ? b.readUInt32LE(0x3c) : 0;
  if (b.toString('latin1', 0, 2) !== 'MZ' || pe + 6 > b.length || b.toString('latin1', pe, pe + 4) !== 'PE\0\0' || b.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error(`${file} Windows x64 ikilisi değil`);
  }
}

/** Windows'ta süreç ağacını sonlandırır (deneme bekçisi ve onun sunucusu); başka sistemde SIGKILL */
function killTree(child) {
  return new Promise((ok) => {
    if (child.exitCode != null || child.signalCode != null) return ok();
    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return ok();
    }
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 }, () => ok());
  });
}

/** Windows'ta yeni silinen ya da adı değişen klasördeki dosyayı virüs taraması bir an tutabilir: birkaç kez denenir */
async function retry(fn, tries = 10) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(300 * (i + 1));
    }
  }
}
const rmDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/**
 * Bekçinin güncelleyicisi.
 * @param {{
 *   installDir: string,          // Program Files\LafPOS (app\, node\ ve baslat.cmd burada)
 *   home: string,                // veri klasörü (C:\ProgramData\LafPOS)
 *   log: (line: string) => void,
 *   port: () => number,
 *   mode: () => 'otomatik' | 'kapali',
 *   server: { stop: () => Promise<void>, start: () => void },
 *   exit: (code: number) => void,
 *   manifestUrls?: string[],
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   platform?: string,
 *   nodeVersion?: string,
 *   execPath?: string,
 *   healthTimeoutMs?: number,
 *   verifyBinary?: (file: string) => void,
 *   spawnTrial?: (nodeExe: string, appDir: string) => import('node:child_process').ChildProcess,
 * }} deps
 */
export function createUpdater(deps) {
  const dir = join(deps.home, 'guncelleme');
  const downloads = join(dir, 'indirilen');
  const statusFile = join(dir, 'durum.json');
  const app = join(deps.installDir, 'app');
  const appNew = join(deps.installDir, 'app.yeni');
  const appOld = join(deps.installDir, 'app.eski');
  const nodeNew = join(deps.installDir, 'node.yeni');
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const platform = deps.platform ?? process.platform;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const execPath = deps.execPath ?? process.execPath;
  // Adresler her denetimde okunur (ayarlar.env değişince yenisi geçerli)
  const urls = () => (typeof deps.manifestUrls === 'function' ? deps.manifestUrls() : (deps.manifestUrls ?? MANIFEST_URLS));
  const healthTimeout = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const verifyBinary = deps.verifyBinary ?? (platform === 'win32' ? assertWinX64 : () => {});
  const spawnTrial =
    deps.spawnTrial ??
    ((nodeExe, appDir) =>
      spawn(nodeExe, [join(appDir, 'bekci.mjs')], {
        cwd: deps.installDir,
        // Deneme bekçisi güncelleme denetlemez; durdurma standart girdiden ("kapat"), Windows'ta sinyal yok. İki adla:
        // eski adı eski güncelleyiciler de verir (yeni bekçi ikisini okur)
        env: { ...process.env, ASILPOS_BEKCI_STDIN: '1', ASILPOS_GUNCELLEME_DENEME: '1', LAFPOS_BEKCI_STDIN: '1', LAFPOS_GUNCELLEME_DENEME: '1' },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      }));

  let status = null;
  let busy = false;
  /** İndirilip doğrulanmış, kurulmayı bekleyen güncelleme */
  let ready = null;
  const etags = new Map();
  const cached = new Map();
  const handles = { check: null, install: null };
  /**
   * Elle istek ("Şimdi güncelle"): otomatik güncelleme kapalıyken de denetler ve kurar; `force` gün açıkken de kurar
   * (patron onayladı). İstek kurulumla, kurulacak sürüm yoksa ya da kurulum hatayla bitince düşer
   */
  let manual = null;
  const off = () => deps.mode() === 'kapali' && !manual;

  const say = (line) => deps.log(`[güncelleme] ${line}`);
  const installed = () => {
    const i = readInstalled(app);
    return { ...i, label: { surum: i.version, build: i.build } };
  };

  function readStatus() {
    try {
      const s = JSON.parse(readFileSync(statusFile, 'utf8'));
      return s && typeof s === 'object' && STATES.includes(s.durum) ? s : null;
    } catch {
      return null;
    }
  }

  function set(ev) {
    const before = status;
    status = { ...nextStatus(status, ev), guncellendi: iso(now()) };
    try {
      mkdirSync(dir, { recursive: true });
      // Önce geçici dosya: sunucu yarım yazılmış durumu okumasın
      writeFileSync(`${statusFile}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
      renameSync(`${statusFile}.tmp`, statusFile);
    } catch (e) {
      say(`durum dosyası yazılamadı: ${errText(e)}`);
    }
    if (!before || before.durum !== status.durum || before.mesaj !== status.mesaj) say(status.mesaj);
    else if (ev.type === 'kontrol-hata') say(`denetlenemedi: ${ev.mesaj}`);
  }

  function schedule(key, ms, fn) {
    if (handles[key]) timers.clearTimeout(handles[key]);
    handles[key] = timers.setTimeout(() => {
      handles[key] = null;
      void fn();
    }, ms);
  }

  /**
   * HTTPS isteği, yönlendirmeyi kendisi izler (yalnız aynı host ya da `extraHosts`); gövde `maxBytes`'ı aşarsa bırakır.
   * 304'te `null`
   */
  async function get(url, { maxBytes, extraHosts = [], timeoutMs = 60_000, etag } = {}) {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      if (!allowedUrl(new URL(target))) throw new Error(`Güvensiz adres: ${target}`);
      const headers = { 'user-agent': 'AsilPOS-guncelleme', ...(etag && hop === 0 ? { 'if-none-match': etag } : {}) };
      const res = await fetchImpl(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel?.().catch(() => {});
        if (!loc || !redirectAllowed(target, loc, extraHosts)) throw new Error(`İzin verilmeyen yönlendirme (${res.status}): ${loc ? new URL(loc, target).host : 'adres yok'}`);
        target = new URL(loc, target).href;
        continue;
      }
      if (res.status === 304) return { status: 304, body: null, etag: res.headers.get('etag') };
      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        throw new Error(`${new URL(target).host} yanıt vermedi (${res.status})`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${new URL(url).pathname.split('/').pop()} beklenenden büyük`);
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error(`${new URL(url).pathname.split('/').pop()} beklenenden büyük; indirme bırakıldı`);
        chunks.push(Buffer.from(chunk));
      }
      return { status: res.status, body: Buffer.concat(chunks), etag: res.headers.get('etag') };
    }
    throw new Error('Çok fazla yönlendirme');
  }

  /** Kanalın manifesti: adresler sırayla; ETag'li (değişmeyen manifest 304) */
  async function fetchManifest() {
    const errors = [];
    for (const url of urls()) {
      try {
        const res = await get(url, { maxBytes: MAX_BYTES.manifest, timeoutMs: 30_000, etag: etags.get(url) });
        if (res.status === 304 && cached.has(url)) return cached.get(url);
        const json = JSON.parse(res.body.toString('utf8'));
        const manifest = parseManifest(json, url);
        if (res.etag) etags.set(url, res.etag);
        cached.set(url, manifest);
        return manifest;
      } catch (e) {
        errors.push(`${new URL(url).host}: ${errText(e)}`);
      }
    }
    throw new Error(`Güncelleme kanalına ulaşılamadı (internet yok olabilir) · ${errors.join(' · ')}`);
  }

  /** Dosya indirilmiş ve özeti tutuyorsa onu, yoksa indirip doğrular; doğrulanmış dosyanın yolu */
  async function fetchVerified(url, file, want, { maxBytes, size, extraHosts }) {
    const path = join(downloads, file);
    if (existsSync(path) && sha256(readFileSync(path)) === want) return path;
    mkdirSync(downloads, { recursive: true });
    const res = await get(url, { maxBytes, extraHosts, timeoutMs: 20 * 60_000 });
    const got = sha256(res.body);
    if (got !== want || (size != null && res.body.length !== size)) {
      throw new Error(`${file} doğrulanamadı (SHA-256 ya da boy tutmadı: beklenen ${want.slice(0, 12)}…, gelen ${got.slice(0, 12)}…); silindi, sonraki denetimde yeniden indirilecek`);
    }
    writeFileSync(`${path}.part`, res.body);
    renameSync(`${path}.part`, path);
    return path;
  }

  async function download(m, plan) {
    const files = {
      app: await fetchVerified(m.app.url, m.app.file, m.app.sha256, { maxBytes: MAX_BYTES.app, size: m.app.size }),
    };
    if (plan.node) files.node = await fetchVerified(m.node.url, `node-v${m.node.version}-win-x64.zip`, m.node.sha256, { maxBytes: MAX_BYTES.node });
    if (plan.sqlite) {
      files.sqlite = await fetchVerified(m.sqlite.url, `better-sqlite3-v${m.sqlite.version}-node-v${m.node.abi}-win32-x64.tar.gz`, m.sqlite.sha256, {
        maxBytes: MAX_BYTES.sqlite,
        extraHosts: SQLITE_REDIRECT_HOSTS,
      });
    }
    return files;
  }

  function cleanDownloads(keepBuild) {
    try {
      const names = readdirSync(downloads);
      const keepNode = ready?.plan.node ? `node-v${ready.manifest.node.version}-win-x64.zip` : null;
      const keepSqlite = ready?.plan.sqlite ? ready.files.sqlite?.split(/[\\/]/).pop() : null;
      for (const n of names) {
        const stale = staleDownloads([n], keepBuild).length > 0 || ((n.startsWith('node-v') || n.startsWith('better-sqlite3-')) && n !== keepNode && n !== keepSqlite);
        if (stale) rmSync(join(downloads, n), { force: true });
      }
    } catch {
      /* klasör yok */
    }
  }

  /**
   * Sunucuya (yalnız bu bilgisayardan) sorar: açık gün var mı ve Merkez'in hedefi (Merkez'le imzalı konuşan sunucudur,
   * server/sync/merkez.ts). Sorulamazsa null
   */
  async function askServer() {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${deps.port()}/api/kasa/guncelleme-durumu`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = await res.json();
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
    }
  }

  /** Açık gün var mı: true / false; sorulamazsa null */
  async function askDayOpen() {
    const body = await askServer();
    return typeof body?.dayOpen === 'boolean' ? body.dayOpen : null;
  }

  async function check() {
    if (busy) return;
    if (off()) {
      set({ type: 'mod', mode: 'kapali' });
      return;
    }
    busy = true;
    try {
      const manifest = await fetchManifest();
      const inst = installed();
      // Sunucuya yalnız kanalda daha yeni ve denenmemiş derleme varsa sorulur (Merkez'in hedefi o zaman gerekir)
      const failed = status?.basarisiz ?? [];
      const newer = manifest.build > (inst.build ?? 0) && !failed.includes(manifest.build);
      // Elle istek (kafede patron "Şimdi güncelle"ye bastı) Merkez'in tutmasını aşar: kanalın son sürümü kurulur
      const { cap, merkez } =
        newer && !manual ? merkezCap({ server: await askServer(), last: status?.merkez, installedBuild: inst.build }) : { cap: Infinity, merkez: status?.merkez ?? null };
      const fresh = planUpdate({ installed: inst, nodeVersion, manifest, failed: status?.basarisiz ?? [], cap });
      // Gönderilen derlemenin yükü hazır ama kanal ilerledi: gönderilen kurulur (yeniden indirilmez, silinmez)
      const sent = merkez?.acik && Number.isInteger(merkez.hedef) && merkez.hedef > (inst.build ?? 0) ? merkez.hedef : null;
      const plan = fresh ?? (!manual && sent != null && ready?.plan.build === sent ? ready.plan : null);
      const held = !plan && manifest.build > (inst.build ?? 0) && manifest.build > cap && !(status?.basarisiz ?? []).includes(manifest.build);
      const kanalIlerledi = held && sent != null && manifest.build > sent;
      set({ type: 'kontrol', plan, manifest, now: now(), merkez, held, kanalIlerledi, gonderilen: sent });
      if (!plan) {
        ready = null;
        manual = null;
        cleanDownloads(null);
      } else if (!ready || ready.plan.build !== plan.build) {
        const yeni = { surum: plan.version, build: plan.build };
        set({ type: 'indiriliyor', yeni });
        const files = await download(manifest, plan);
        ready = { manifest, plan, files, yeni };
        cleanDownloads(plan.build);
        set({ type: 'hazir', yeni });
      }
    } catch (e) {
      const msg = errText(e);
      manual = null;
      // Kanala ulaşılamaması hata değildir (internetsiz kasa çalışır): durum korunur, son denetimin sonucu yazılır
      if (status?.durum === 'indiriliyor') set({ type: 'hata', mesaj: `Yeni sürüm indirilemedi: ${msg}`, now: now() });
      else set({ type: 'kontrol-hata', mesaj: msg, now: now() });
    } finally {
      busy = false;
      // Otomatik güncelleme kapalıyken elle denetim sonraki denetimi kurmaz
      if (deps.mode() !== 'kapali') schedule('check', CHECK_EVERY_MS, check);
    }
    if (ready) await tryInstall();
  }

  async function tryInstall() {
    if (!ready || busy) return;
    if (off()) return;
    if (platform !== 'win32') {
      set({ type: 'hata', mesaj: 'Otomatik kurulum yalnız Windows kurulumunda yapılır', now: now() });
      return;
    }
    const asked = await askServer();
    // "Şimdi güncelle" gün açıkken de kurar ama satış ya da ödeme sürerken asla: kasa boşalana dek 5 sn'de bir yeniden
    // sorulur (en çok 15 dk; sonra istek düşer, sürüm gün sonunda kurulur). Sunucu yanıt vermiyorsa beklenmez
    if (manual?.force && asked?.mesgul === true) {
      manual.waitedMs = (manual.waitedMs ?? 0) + BUSY_POLL_MS;
      if (manual.waitedMs > BUSY_WAIT_MAX_MS) {
        manual = null;
        set({ type: 'gun-acik' });
        schedule('install', DAY_POLL_MS, tryInstall);
        return;
      }
      set({ type: 'mesgul' });
      schedule('install', BUSY_POLL_MS, tryInstall);
      return;
    }
    const decision = manual?.force ? 'kur' : installDecision(typeof asked?.dayOpen === 'boolean' ? asked.dayOpen : null, asked?.eod === true);
    if (decision !== 'kur') {
      if (decision === 'gun-acik') set({ type: 'gun-acik' });
      schedule('install', DAY_POLL_MS, tryInstall);
      return;
    }
    busy = true;
    try {
      await install(ready);
    } finally {
      busy = false;
    }
  }

  /** Yükü app.yeni'ye (ve gerekirse node.exe'yi node.yeni'ye) açar; sunucu bu sırada çalışmaya devam eder */
  function prepare({ manifest, plan, files }) {
    rmDir(appNew);
    rmDir(nodeNew);
    const zip = readFileSync(files.app);
    if (sha256(zip) !== manifest.app.sha256) throw new Error('Uygulama yükü indirildikten sonra değişmiş; silindi');
    extractZip(zip, appNew, appEntry);
    const bin = join(appNew, ...SQLITE_BINARY.split('/'));
    mkdirSync(join(bin, '..'), { recursive: true });
    if (plan.sqlite) {
      const entry = readTarGz(readFileSync(files.sqlite)).find((e) => e.name === 'build/Release/better_sqlite3.node');
      if (!entry) throw new Error('better-sqlite3 arşivinde ikili yok');
      writeFileSync(bin, entry.data);
    } else {
      copyFileSync(join(app, ...SQLITE_BINARY.split('/')), bin);
    }
    verifyBinary(bin);
    if (plan.node) {
      const buf = readFileSync(files.node);
      const prefix = `node-v${manifest.node.version}-win-x64/`;
      mkdirSync(nodeNew, { recursive: true });
      for (const e of readZip(buf)) {
        if (e.name === `${prefix}node.exe` || e.name === `${prefix}LICENSE`) writeFileSync(join(nodeNew, e.name.slice(prefix.length)), entryData(buf, e));
      }
      if (!existsSync(join(nodeNew, 'node.exe'))) throw new Error('Node arşivinde node.exe yok');
      verifyBinary(join(nodeNew, 'node.exe'));
    }
    const staged = readInstalled(appNew);
    if (staged.build !== plan.build || !existsSync(join(appNew, 'bekci.mjs')) || !existsSync(join(appNew, 'server', 'index.mjs'))) throw new Error('Uygulama yükü eksik');
  }

  /** Veritabanının kopyası (sunucu durduktan sonra: tek dosya, tutarlı); eski güncelleme kopyaları seyreltilir */
  function backupDb(build) {
    const db = join(deps.home, 'lafpos.db');
    if (!existsSync(db)) return null;
    const backups = join(deps.home, 'backups');
    mkdirSync(backups, { recursive: true });
    const target = join(backups, backupName(build, now()));
    copyFileSync(db, target);
    if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${target}-wal`);
    try {
      const files = readdirSync(backups).map((name) => ({ name, at: statSync(join(backups, name)).mtimeMs }));
      for (const name of oldUpdateBackups(files)) rmSync(join(backups, name), { force: true });
    } catch {
      /* seyreltme olmazsa kopyalar kalır */
    }
    return target;
  }

  /** Yeni sürüm (bekçi ve sunucu) deneme olarak açılır; /api/health yeni derlemeyi söyleyince tamam */
  async function trial(nodeExe, build) {
    const child = spawnTrial(nodeExe, app);
    let exited = false;
    child.on('exit', () => {
      exited = true;
    });
    child.on('error', () => {
      exited = true;
    });
    child.stdin?.on('error', () => {});
    let ok = false;
    const deadline = now() + healthTimeout;
    while (!exited && now() < deadline) {
      try {
        const res = await fetchImpl(`http://127.0.0.1:${deps.port()}/api/health`, { signal: AbortSignal.timeout(3000) });
        const body = res.ok ? await res.json() : null;
        if (body?.build === build) {
          ok = true;
          break;
        }
      } catch {
        /* henüz açılmadı */
      }
      await sleep(1000);
    }
    // Deneme düzgün kapanır (sunucu veritabanını kapatır); kapanmazsa ağacıyla sonlandırılır
    if (!exited) {
      const done = new Promise((r) => child.once('exit', r));
      try {
        child.stdin?.write('kapat\n');
      } catch {
        /* kapanmış */
      }
      const timedOut = await Promise.race([done.then(() => false), sleep(15_000).then(() => true)]);
      if (timedOut) await killTree(child);
    }
    return ok;
  }

  /**
   * Hata ve geri dönüş yollarındaki temizlik: silinemeyen klasör (Windows'ta kısa süre kilitli node.exe) günlüğe yazılır,
   * fırlatmaz. Fırlatsaydı sunucu yeniden açılmaz, durum yazılmaz ve yakalanmayan ret bekçiyi kapatırdı
   */
  const rmDirSafe = (dir) => {
    try {
      rmDir(dir);
    } catch (e) {
      say(`temizlenemedi: ${dir}: ${errText(e)}`);
    }
  };

  async function install(job) {
    const { plan } = job;
    const yeni = job.yeni;
    try {
      prepare(job);
    } catch (e) {
      rmDirSafe(appNew);
      rmDirSafe(nodeNew);
      ready = null;
      manual = null;
      set({ type: 'hata', mesaj: `Yeni sürüm hazırlanamadı: ${errText(e)}`, now: now() });
      return;
    }
    // Hazırlık sürerken gün açılmış olabilir (elle "şimdi kur" isteği gün açıkken de kurar)
    if (!manual?.force && (await askDayOpen()) !== false) {
      rmDirSafe(appNew);
      rmDirSafe(nodeNew);
      set({ type: 'gun-acik' });
      schedule('install', DAY_POLL_MS, tryInstall);
      return;
    }
    set({ type: 'kuruluyor', yeni, now: now() });
    await deps.server.stop();
    let backup;
    try {
      backup = backupDb(plan.build);
      if (backup) say(`veritabanının kopyası: ${backup}`);
    } catch (e) {
      rmDirSafe(appNew);
      rmDirSafe(nodeNew);
      deps.server.start();
      manual = null;
      set({ type: 'hata', mesaj: `Veritabanının kopyası alınamadı, güncelleme bırakıldı: ${errText(e)}`, now: now() });
      return;
    }
    try {
      rmDirSafe(appOld);
      await retry(() => renameSync(app, appOld));
      try {
        await retry(() => renameSync(appNew, app));
      } catch (e) {
        await retry(() => renameSync(appOld, app));
        throw e;
      }
    } catch (e) {
      rmDirSafe(appNew);
      rmDirSafe(nodeNew);
      deps.server.start();
      manual = null;
      set({ type: 'hata', mesaj: `Dosyalar değiştirilemedi, eski sürüm çalışıyor: ${errText(e)}`, now: now() });
      return;
    }
    const nodeExe = plan.node ? join(nodeNew, 'node.exe') : execPath;
    let ok = false;
    try {
      ok = await trial(nodeExe, plan.build);
    } catch (e) {
      say(`deneme açılamadı: ${errText(e)}`);
    }
    if (ok) {
      ready = null;
      set({ type: 'kuruldu', kurulu: yeni, now: now() });
      say(`${yeni.surum} (${yeni.build}) kuruldu; bekçi yeni sürümle yeniden açılıyor`);
      deps.exit(RESTART_EXIT_CODE);
      return;
    }
    // Geri dönüş: yeni klasör kenara, eskisi yerine; yeni Node silinir
    try {
      rmDirSafe(`${app}.bozuk`);
      await retry(() => renameSync(app, `${app}.bozuk`));
      await retry(() => renameSync(appOld, app));
      rmDirSafe(`${app}.bozuk`);
    } catch (e) {
      say(`geri dönüş sırasında hata: ${errText(e)}`);
    }
    rmDirSafe(nodeNew);
    ready = null;
    manual = null;
    set({ type: 'geri-dondu', yeni, neden: `Yeni sürüm ${Math.round(healthTimeout / 1000)} sn içinde açılmadı`, now: now() });
    deps.server.start();
  }

  return {
    /** Bekçi açılınca: durum dosyası hemen yazılır, ilk denetim 2 dakika sonra */
    start() {
      status = readStatus();
      set({ type: 'acilis', kurulu: installed().label, mode: deps.mode(), now: now() });
      cleanDownloads(null);
      // Kurulumdan sonra kalan yarım klasörler (başarıda app.eski elle geri dönüş için bir sonraki güncellemeye kadar durur)
      rmDirSafe(appNew);
      if (deps.mode() !== 'kapali') schedule('check', FIRST_CHECK_MS, check);
    },
    /**
     * Elle istek (Yönetim › Ayarlar ve yedek › "Şimdi güncelle"; sunucu guncelleme\istek.json yazar, bekçi buraya iletir):
     * hemen denetler, yeni sürüm varsa indirir ve kurar. Otomatik güncelleme kapalıyken de çalışır. `force`: gün açıkken
     * de kurar; değilse gün kapanınca. Kafedeki elle istek Merkez'in tutmasını aşar (kanalın son sürümü); sorun çıkmış (bir
     * daha denenmeyecek) sürümler geçerli kalır
     */
    async requestNow({ force = false } = {}) {
      manual = { force: !!force };
      set({ type: 'istek', simdi: !!force, now: now() });
      if (handles.check) timers.clearTimeout(handles.check);
      handles.check = null;
      if (busy) return;
      // Sürüm zaten indirilmiş ve bekliyorsa kanala yeniden sormadan kurulur
      if (ready) return tryInstall();
      await check();
    },
    /** ayarlar.env değişti: kapatma hemen yazılır; açılınca bir dakika içinde denetlenir */
    poke() {
      const mode = deps.mode();
      set({ type: 'mod', mode });
      if (mode === 'kapali') {
        for (const key of Object.keys(handles)) if (handles[key]) timers.clearTimeout(handles[key]);
        handles.check = handles.install = null;
      } else if (!handles.check && !busy) schedule('check', 60_000, check);
    },
    /** Kurulumun kök dosyaları ya da kısayolları yenilenemedi (kurulum-yenile.mjs): panelde "Kurulumu yenileyin" */
    setInstallWarning(uyari) {
      if ((status?.kurulumUyari ?? null) === (uyari ?? null)) return;
      set({ type: 'kurulum', uyari });
    },
    stop() {
      for (const key of Object.keys(handles)) if (handles[key]) timers.clearTimeout(handles[key]);
    },
    check,
    tryInstall,
    status: () => status,
  };
}
