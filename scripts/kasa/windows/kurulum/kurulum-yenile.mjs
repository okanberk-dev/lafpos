// Kurulumun app\ dışındaki parçalarını yeniler (Windows kurulumu). Otomatik güncelleme yalnız app\ ve node\'u değiştirir;
// kurulum klasörünün kökündeki dosyalar (kasa kısayolu, yönetim betiği, simge, notlar) ve Başlat menüsü, masaüstü ve
// Başlangıç kısayolları eski kalırdı. Bekçi (SYSTEM) her açılışta bunu çağırır:
//   1. app\kok\ içindeki kök dosyalar (paket.mjs yazar) kurulum klasöründekinden farklıysa yerine konur. baslat.cmd hariç:
//      bekçiyi o açar ve cmd.exe toplu dosyayı çalışırken satır satır okur, üzerine yazmak onu bozar; farklıysa uyarılır
//      (bu yüzden baslat.cmd'nin baytları ad değişikliğinde de değişmedi, tests/asilpos-adi.test.ts). Eski kısayolların
//      yönlendiricisi (LafPOS-Kasa.bat) yalnız yönlendirdiği AsilPOS-Kasa.bat kurulumdaysa konur.
//   2. Kısayollar (kisayollar.ps1, Windows PowerShell) kurulumdakiyle aynı adla, idempotent olarak yeniden yazılır.
//      SYSTEM ortak klasörlere (Başlat menüsü, Genel masaüstü, ortak Başlangıç) yönetici izni sormadan yazar. Masaüstü ve
//      Başlangıç'taki kasa kısayolu yalnız varsa yenilenir (kurulumda seçilmemişse eklenmez). Kasa bekçisinin Başlangıç
//      kısayolu Başlangıç'ta kasa kısayolu varsa konur: kasa ekranı açılışta açılıyorsa bekçi de açılır.
//   Kısayollar derleme başına bir kez yazılır (guncelleme\kurulum-yenileme.json); hata olursa her açılışta yeniden denenir.
//   Ad değişikliği (26 Kasım 2026): eski adlı kısayollar (masaüstü, Başlangıç) koşulda yeni adla eş sayılır; yenisi
//   yazılınca eskisi silinir, Başlat menüsünün eski klasöründe kalanlar (kaldırma, tarayıcı kısayolu) yeni klasöre taşınır.
//   Kısayollardan önce Uygulamalar kaydı: kurulum dosyasının eski kaldırıcısı (Kaldir.exe) yeni adları bilmez, kaldırma
//   siteden kurulumun kaldırıcısına (iki adı da siler) geçer; kayıtta görünen ad AsilPOS olur (kisayollar.ps1).
//   Kısayollarla birlikte Uygulamalar kaydındaki sürüm, boyut ve tarih de yenilenir (28 Kasım 2026; displayVersion).
// Yapılamayan bir şey kalırsa güncelleme durumuna (durum.json `kurulumUyari`) yazılır; Merkez nabzıyla patron panelinde
// "Kurulumu yenileyin" görünür. Bağımlılıksız; pakete girer (paket.mjs). Testi tests/kurulum-yenile.test.ts.
//
// Tek liste (27 Kasım 2026, "exe ve siteden aynı program"): kurulum dosyası (asilpos.nsi) ve siteden kurulum
// (web-kurucu.ps1) kısayolları elle yazmaz; kurulan app\ içindeki bu dosyayı çalıştırır:
//   node app\kurulum-yenile.mjs kisayollar --gruplar masaustu,baslangic
// Aynı shortcutSpec, aynı kisayollar.ps1 (-Kur: seçilen isteğe bağlı gruplar koşulsuz yazılır). Böylece iki kurulum ve
// güncelleme aynı kısayolları yazar; liste tek yerde değişir. `--yalniz-liste` yalnız listeyi yazar (paket denemesi, CI).
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** app\ içinde kök dosyaların klasörü */
export const ROOT_DIR = 'kok';
/**
 * Çalışırken değiştirilemeyen kök dosyalar: farklıysa yalnız uyarılır. AsilPOS-Kasa.bat değiştirilir: 27 Kasım
 * öncesinin hâli (90 sn'ye kadar çalışır) o an açıksa cmd kaldığı bayttan yenisini okur; yenisinde o baytlar boş etiket,
 * oradan programı açar (tests/masaustu-programi.test.ts). Yenisi anında kapanır
 */
export const LOCKED_ROOT_FILES = ['baslat.cmd'];
/**
 * Yalnız kurulumda zaten varsa yenilenen kök dosyalar: siteden kurulumun kaldırıcısı (Uygulamalar listesi onu çağırır;
 * kurulum dosyasıyla kurulanda Kaldir.exe var, bu dosya yok)
 */
export const IF_PRESENT_ROOT_FILES = ['LafPOS-Kaldir.ps1'];
/**
 * Yalnız bağlı olduğu dosya kurulumdaysa konan kök dosyalar: eski kısayolların yönlendiricisi yenisini çağırır; yenisi
 * konamadıysa eski kasa kısayolunun tam hâli yerinde kalır
 */
export const ROOT_FILE_NEEDS = { 'LafPOS-Kasa.bat': 'AsilPOS-Kasa.bat' };
/** Uygulamalar listesindeki kayıt (kurulum dosyası 32 bit: WOW6432Node; siteden kurulum da aynı anahtara yazar) */
export const UNINSTALL_KEY = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LafPOS';
/** Başlat menüsü klasörü ve kısayolların eski adı (shared/eski-adlar.ts; ad değişikliğinden önceki kurulum) */
export const MENU = { yeni: 'AsilPOS', eski: 'LafPOS' }; // eski-ad
/**
 * Kasa bekçisinin sürümü: kasa-yazici.ps1 eski sürüm bekçiyi bununla tanıyıp yenisiyle değiştirir (betiğin
 * `$BekciSurumu`'yla aynı; kurulumlar bekçi kısayolunu bu listeden yazar). 3: müşteri ekranı sunucu cevap verince açılır
 * (inceleme, 23 Kas 2026); kasada çalışan eski bekçi, kasa kısayolunun bir sonraki açılışında yenisiyle değişir. 4: bakım
 * arasında (Yönetim › Ağ) kasa penceresi yeniden açılmaz. 5: program (27 Kas 2026): Edge InPrivate olmayan tam ekran
 * pencerede; bekçi diskteki betik değişince (güncelleme) yenisiyle yeniden başlar, sonraki sürümler oturum kapanmayı beklemez
 * 6 (28 Kas 2026): bekçi kapanan kasa penceresini yeniden açmaz, yalnız kasa kısayolunun isteğiyle açar; kasa penceresi
 * kapanınca müşteri ekranını da kapatır (sahibin isteği: "kapatınca kapansın, ben açınca açılsın"). 7 (28 Kas 2026):
 * çöken kasa penceresini yeniden açar, kullanıcının kapattığını açmaz (profilin exit_type'ı ve sürecin çıkış kodu);
 * kararlarını kasa programının günlüğüne yazar
 */
export const WATCHER_VERSION = 7;
/** Kurulumların isteğe bağlı kısayol grupları: masaüstündeki kasa ve oturum açılınca kasa (bekçisiyle) */
export const INSTALL_GROUPS = ['masaustu', 'baslangic'];
/** Kasa kısayollarının açtığı program kipi (kasa-yazici.ps1) */
export const KASA_MODE = '-Ac';
/** Kasa bekçisinin Başlangıç kısayolu (ASCII ad: kasa-yazici.ps1 de arar) */
export const WATCHER_LINK = 'AsilPOS Kasa Bekcisi.lnk';
const MARKER = 'kurulum-yenileme.json';
const errText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Kurulumun kısayolları: iki kurulum ve güncelleme bunu yazar (kisayollar.ps1). `klasor`: .NET özel klasör adı; `grup`:
 * isteğe bağlı grup (kurulumda seçilirse yazılır); `kosul`: güncellemede aynı klasörde bu dosyalardan hiçbiri yoksa kısayol
 * yazılmaz (yalnız varsa yenilenir); `eski`: kısayol yazılınca aynı klasörden silinen eski adlar; `dosya`: kısayolun
 * çalıştırdığı dosya (yoksa kısayol yazılmaz, eskisi kalır); `url`: .url (İnternet kısayolu).
 *
 * Kasa kısayolları (27 Kasım 2026, program): konsolsuz PowerShell kasa-yazici.ps1 -Ac'yi açar (sunucuyu bekler, pencereyi
 * açar ya da öne getirir). Eskiden AsilPOS-Kasa.bat'ı açardı: görev çubuğunda 90 sn'ye kadar küçültülmüş bir konsol
 * dururdu. Adlar değişmedi: kurulum dosyasının kurulu kaldırıcısı (Kaldir.exe) sabit adları siler
 */
export function shortcutSpec(installDir, systemRoot = 'C:\\Windows') {
  const j = win32.join;
  const ps = j(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psFile = (file, extra = '') => `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${j(installDir, file)}"${extra}`;
  const launcher = 'app\\kasa-yazici.ps1';
  const base = { ikon: `${j(installDir, 'asilpos.ico')},0`, calismaKlasoru: installDir };
  const kasaLink = { ...base, hedef: ps, dosya: j(installDir, launcher), arguman: psFile(launcher, ` ${KASA_MODE}`), aciklama: 'Kasa ekranı (tam ekran)', pencere: 7 };
  // Masaüstü ve Başlangıç'taki kasa kısayolu eski adla da olabilir: koşulda ikisi, yenisi yazılınca eskisi silinir
  const kasaAdi = `${MENU.yeni} Kasa.lnk`;
  const eskiKasa = `${MENU.eski} Kasa.lnk`;
  return [
    { ...kasaLink, klasor: 'CommonPrograms', ad: 'AsilPOS\\AsilPOS Kasa.lnk' },
    { ...base, klasor: 'CommonPrograms', ad: 'AsilPOS\\AsilPOS ayarları.lnk', hedef: ps, arguman: psFile('yonet.ps1', ' ayarlar'), aciklama: 'Site, lafmaliyet ve yazarkasa ayarları', pencere: 7 },
    { ...base, klasor: 'CommonPrograms', ad: 'AsilPOS\\Sunucuyu yeniden başlat.lnk', hedef: ps, arguman: psFile('yonet.ps1', ' yeniden-baslat'), aciklama: '', pencere: 7 },
    { ...base, klasor: 'CommonPrograms', ad: 'AsilPOS\\Sunucu günlüğü.lnk', hedef: ps, arguman: psFile('yonet.ps1', ' gunluk'), aciklama: '', pencere: 7 },
    { ...base, klasor: 'CommonPrograms', ad: 'AsilPOS\\Kasa hazırlığı.lnk', hedef: ps, arguman: psFile('app\\kasa-hazirla.ps1'), aciklama: 'Ekran, Windows Update, ağ kartı, otomatik oturum', pencere: 7 },
    { ...base, klasor: 'CommonPrograms', ad: 'AsilPOS\\Kurulum notları.lnk', hedef: j(installDir, 'BENIOKU.txt'), arguman: '', aciklama: '', pencere: 1 },
    // AsilPOS'u bu bilgisayarın kendi tarayıcısında (sekmede) açar; kasa penceresi değil
    { klasor: 'CommonPrograms', ad: 'AsilPOS\\AsilPOS (tarayıcıda).url', url: 'http://localhost:4000/', ikonDosyasi: j(installDir, 'asilpos.ico') },
    { ...kasaLink, klasor: 'CommonDesktopDirectory', ad: kasaAdi, grup: 'masaustu', kosul: [kasaAdi, eskiKasa], eski: [eskiKasa] },
    { ...kasaLink, klasor: 'CommonStartup', ad: kasaAdi, grup: 'baslangic', kosul: [kasaAdi, eskiKasa], eski: [eskiKasa] },
    {
      ...base,
      klasor: 'CommonStartup',
      ad: WATCHER_LINK,
      grup: 'baslangic',
      kosul: [kasaAdi, eskiKasa],
      eski: [`${MENU.eski} Kasa Bekcisi.lnk`],
      hedef: ps,
      dosya: j(installDir, launcher),
      arguman: psFile(launcher, ` -Bekci -BekciSurum ${WATCHER_VERSION}`),
      aciklama: 'Kasa kısayolunun istediği pencereyi sunucu gelince açar; müşteri ekranını kasa açıkken tutar',
      pencere: 7,
    },
  ];
}

/**
 * app\kok\'teki dosyaları kurulum klasörüne koyar (yalnız farklıysa). Dönen: konanlar, konamayanlar ve çalışırken
 * değiştirilemeyip eski kalanlar
 */
export function syncRootFiles({ appDir, installDir }) {
  const out = { copied: [], failed: [], stale: [] };
  const src = join(appDir, ROOT_DIR);
  if (!existsSync(src)) return out;
  // Bağlı dosyalar en sonda: bağlandıkları dosya önce konur
  const names = readdirSync(src).sort();
  const ordered = [...names.filter((n) => !ROOT_FILE_NEEDS[n]), ...names.filter((n) => ROOT_FILE_NEEDS[n])];
  for (const name of ordered) {
    const from = join(src, name);
    const to = join(installDir, name);
    try {
      const data = readFileSync(from);
      if (IF_PRESENT_ROOT_FILES.includes(name) && !existsSync(to)) continue;
      if (ROOT_FILE_NEEDS[name] && !existsSync(join(installDir, ROOT_FILE_NEEDS[name]))) continue;
      if (existsSync(to) && readFileSync(to).equals(data)) continue;
      if (LOCKED_ROOT_FILES.includes(name)) {
        out.stale.push(name);
        continue;
      }
      copyFileSync(from, to);
      out.copied.push(name);
    } catch (e) {
      out.failed.push({ name, error: errText(e) });
    }
  }
  return out;
}

/**
 * Uygulamalar listesinde görünen sürüm (DisplayVersion; 28 Kasım 2026): kurulu sürüm ve derlemenin tarihi, Yönetim ›
 * Ayarlar ve yedek › Güncelleme kartındaki gibi ("0.3.0 (28.11.2026 14:05)", bilgisayarın saatiyle). Otomatik güncelleme
 * yalnız app\ ve node\'u değiştirir: kayıt kurulumdaki sürümde kalıyordu. Sürüm ya da derleme yoksa null (kayıt değişmez)
 */
export function displayVersion(version, build) {
  if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version) || !Number.isInteger(build) || build <= 0) return null;
  const d = new Date(build * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${version} (${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())})`;
}

/** Kurulu app\package.json'un sürümü (okunamazsa boş) */
function installedVersion(appDir) {
  try {
    const v = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** Panelde görünen uyarı (yapılamayan bir şey yoksa null) */
export function warningFor({ failed = [], stale = [], shortcuts = null }) {
  const parts = [];
  if (failed.length) parts.push(`kurulum dosyaları yenilenemedi (${failed.map((f) => f.name).join(', ')})`);
  if (stale.length) parts.push(`${stale.join(', ')} eski kaldı (çalışırken değiştirilemez)`);
  if (shortcuts) parts.push(`kısayollar yenilenemedi (${shortcuts})`);
  if (!parts.length) return null;
  return `Kurulumu yenileyin (AsilPOS-Kur.cmd'yi yeniden çalıştırın): ${parts.join('; ')}`.slice(0, 300);
}

/** kisayollar.ps1'in argümanları (liste, Başlat menüsü adları, Uygulamalar kaydı ve kaldırıcı; varsa kayıttaki sürüm) */
export function shortcutArgs({ appDir, installDir, listFile, surum = null }) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(appDir, 'kisayollar.ps1'),
    '-Liste',
    listFile,
    '-EskiMenu',
    MENU.eski,
    '-YeniMenu',
    MENU.yeni,
    '-Kurulum',
    installDir,
    '-Kayit',
    UNINSTALL_KEY,
    '-Kaldirici',
    join(appDir, ROOT_DIR, IF_PRESENT_ROOT_FILES[0]),
  ];
  if (surum) args.push('-Surum', surum);
  return args;
}

/** kisayollar.ps1'i çalıştırır; hata yoksa null, varsa kısa açıklama. UYARI satırları (kayıttaki sürüm) günlüğe */
function runShortcutScript({ appDir, installDir, listFile, systemRoot, surum = null, log = () => {} }) {
  const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(
      ps,
      shortcutArgs({ appDir, installDir, listFile, surum }),
      { timeout: 60_000, windowsHide: true },
      (err, stdout) => {
        const all = String(stdout ?? '').split(/\r?\n/);
        for (const l of all.filter((x) => x.startsWith('UYARI'))) log(l.slice(0, 200));
        const lines = all.filter((l) => l.startsWith('HATA'));
        if (!err && !lines.length) return resolve(null);
        resolve(lines.length ? lines.join(' | ').slice(0, 200) : errText(err).slice(0, 200));
      },
    );
  });
}

/**
 * Kök dosyaları ve kısayolları yeniler, sonucu `setWarning`'e verir (null: sorun yok). Fırlatmaz
 * @param {{ appDir: string, installDir: string, home: string, build: number|null, log: (s: string) => void,
 *   setWarning: (w: string|null) => void, platform?: string, systemRoot?: string,
 *   runShortcuts?: (o: { appDir: string, installDir: string, listFile: string, systemRoot: string }) => Promise<string|null> }} deps
 */
export async function refreshInstall(deps) {
  const platform = deps.platform ?? process.platform;
  const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const say = (s) => deps.log(`[kurulum] ${s}`);
  let files = { copied: [], failed: [], stale: [] };
  let shortcuts = null;
  try {
    files = syncRootFiles(deps);
    if (files.copied.length) say(`kök dosyalar yenilendi: ${files.copied.join(', ')}`);
    for (const f of files.failed) say(`${f.name} yenilenemedi: ${f.error}`);
    if (files.stale.length) say(`${files.stale.join(', ')} yeni sürümden farklı; çalışırken değiştirilemez, kurulumu yenileyin`);
    const dir = join(deps.home, 'guncelleme');
    const marker = join(dir, MARKER);
    let last = null;
    try {
      last = JSON.parse(readFileSync(marker, 'utf8'));
    } catch {
      last = null;
    }
    const due = platform === 'win32' && existsSync(join(deps.appDir, 'kisayollar.ps1')) && !(last && last.build === deps.build && last.ok === true);
    if (due) {
      mkdirSync(dir, { recursive: true });
      const listFile = join(dir, 'kisayollar.json');
      writeFileSync(listFile, JSON.stringify(shortcutSpec(deps.installDir, systemRoot), null, 2));
      const surum = displayVersion(installedVersion(deps.appDir), deps.build);
      shortcuts = await (deps.runShortcuts ?? runShortcutScript)({ appDir: deps.appDir, installDir: deps.installDir, listFile, systemRoot, surum, log: say });
      writeFileSync(marker, JSON.stringify({ build: deps.build, ok: !shortcuts, at: new Date().toISOString() }));
      say(shortcuts ? `kısayollar yenilenemedi: ${shortcuts}` : 'kısayollar yenilendi');
    }
  } catch (e) {
    shortcuts = shortcuts ?? errText(e).slice(0, 200);
    say(`yenilenemedi: ${errText(e)}`);
  }
  try {
    deps.setWarning(warningFor({ failed: files.failed, stale: files.stale, shortcuts }));
  } catch {
    /* durum yazılamadı: günlükte var */
  }
}

/** Kurulumun kısayol adımının kisayollar.ps1 argümanları: Uygulamalar kaydına ve eski menüye dokunmaz (kurulum kendisi yazar) */
export function installArgs({ appDir, listFile, groups }) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appDir, 'kisayollar.ps1'), '-Liste', listFile, '-Kur', '-Gruplar', groups.join(',')];
}

/** `--gruplar masaustu,baslangic` (boş da olabilir: yalnız Başlat menüsü); bilinmeyen grup hatadır */
export function parseGroups(text) {
  const groups = [...new Set(String(text ?? '').split(',').map((g) => g.trim()).filter(Boolean))];
  const bad = groups.filter((g) => !INSTALL_GROUPS.includes(g));
  if (bad.length) throw new Error(`bilinmeyen kısayol grubu: ${bad.join(', ')}`);
  return groups;
}

/**
 * Kurulumların kısayol adımı (asilpos.nsi ve web-kurucu.ps1 aynı komutu çalıştırır). Fırlatmaz; hata yoksa null
 * @param {{ appDir: string, installDir: string, groups: string[], systemRoot?: string,
 *   run?: (exe: string, args: string[]) => Promise<{ code: number, out: string }> }} o
 */
export async function installShortcuts(o) {
  const systemRoot = o.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const listFile = join(tmpdir(), `asilpos-kisayollar-${process.pid}.json`);
  try {
    writeFileSync(listFile, JSON.stringify(shortcutSpec(o.installDir, systemRoot), null, 2));
    const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const run =
      o.run ??
      ((exe, args) =>
        new Promise((done) => execFile(exe, args, { timeout: 60_000, windowsHide: true }, (err, stdout) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? '') }))));
    const r = await run(ps, installArgs({ appDir: o.appDir, listFile, groups: o.groups }));
    const lines = r.out.split(/\r?\n/).filter((l) => l.startsWith('HATA'));
    if (r.code === 0 && !lines.length) return null;
    return (lines.length ? lines.join(' | ') : `kod ${r.code}`).slice(0, 300);
  } catch (e) {
    return errText(e).slice(0, 300);
  } finally {
    rmSync(listFile, { force: true });
  }
}

/** Komut satırı: `node app\\kurulum-yenile.mjs kisayollar --gruplar masaustu,baslangic [--yalniz-liste] [--kurulum <klasör>]` */
async function cli(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const appDir = dirname(fileURLToPath(import.meta.url));
  const installDir = opt('--kurulum') ?? dirname(appDir);
  let groups;
  try {
    groups = parseGroups(opt('--gruplar'));
  } catch (e) {
    console.error(errText(e));
    return 2;
  }
  const spec = shortcutSpec(installDir, process.env.SystemRoot ?? 'C:\\Windows');
  if (argv.includes('--yalniz-liste')) {
    console.log(JSON.stringify(spec.filter((k) => !k.grup || groups.includes(k.grup)), null, 2));
    return 0;
  }
  const err = await installShortcuts({ appDir, installDir, groups });
  console.log(err ? `Kısayollar yazılamadı: ${err}` : 'Kısayollar yazıldı');
  return err ? 1 : 0;
}

/** Bu dosya doğrudan mı çalıştırıldı (bekçi ve testler içe aktarır): Node ana modülün gerçek yolunu verir */
function isMain() {
  try {
    const a = realpathSync(resolve(process.argv[1] ?? ''));
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
if (process.argv[2] === 'kisayollar' && isMain()) process.exitCode = await cli(process.argv.slice(3));
