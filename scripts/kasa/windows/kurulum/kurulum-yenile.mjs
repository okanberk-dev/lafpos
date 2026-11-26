// Kurulumun app\ dışındaki parçalarını yeniler (Windows kurulumu). Otomatik güncelleme yalnız app\ ve node\'u değiştirir;
// kurulum klasörünün kökündeki dosyalar (kasa kısayolu, yönetim betiği, simge, notlar) ve Başlat menüsü, masaüstü ve
// Başlangıç kısayolları eski kalırdı. Bekçi (SYSTEM) her açılışta bunu çağırır:
//   1. app\kok\ içindeki kök dosyalar (paket.mjs yazar) kurulum klasöründekinden farklıysa yerine konur. baslat.cmd hariç:
//      bekçiyi o açar ve cmd.exe toplu dosyayı çalışırken satır satır okur, üzerine yazmak onu bozar; farklıysa uyarılır.
//   2. Kısayollar (kisayollar.ps1, Windows PowerShell) kurulumdakiyle aynı adla, idempotent olarak yeniden yazılır.
//      SYSTEM ortak klasörlere (Başlat menüsü, Genel masaüstü, ortak Başlangıç) yönetici izni sormadan yazar. Masaüstü ve
//      Başlangıç'taki kasa kısayolu yalnız varsa yenilenir (kurulumda seçilmemişse eklenmez). Kasa bekçisinin Başlangıç
//      kısayolu Başlangıç'ta kasa kısayolu varsa konur: kasa ekranı açılışta açılıyorsa bekçi de açılır.
//   Kısayollar derleme başına bir kez yazılır (guncelleme\kurulum-yenileme.json); hata olursa her açılışta yeniden denenir.
//   Ad değişikliği (26 Kasım 2026): eski adlı kısayollar (masaüstü, Başlangıç) koşulda yeni adla eş sayılır; yenisi
//   yazılınca eskisi silinir, Başlat menüsünün eski klasöründe kalanlar (kaldırma, tarayıcı kısayolu) yeni klasöre taşınır.
// Yapılamayan bir şey kalırsa güncelleme durumuna (durum.json `kurulumUyari`) yazılır; Merkez nabzıyla patron panelinde
// "Kurulumu yenileyin" görünür. Bağımlılıksız; pakete girer (paket.mjs). Testi tests/kurulum-yenile.test.ts.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

/** app\ içinde kök dosyaların klasörü */
export const ROOT_DIR = 'kok';
/** Çalışırken değiştirilemeyen kök dosyalar: farklıysa yalnız uyarılır */
export const LOCKED_ROOT_FILES = ['baslat.cmd'];
/**
 * Yalnız kurulumda zaten varsa yenilenen kök dosyalar: siteden kurulumun kaldırıcısı (Uygulamalar listesi onu çağırır;
 * kurulum dosyasıyla kurulanda Kaldir.exe var, bu dosya yok)
 */
export const IF_PRESENT_ROOT_FILES = ['LafPOS-Kaldir.ps1'];
/** Başlat menüsü klasörü ve kısayolların eski adı (shared/eski-adlar.ts; ad değişikliğinden önceki kurulum) */
export const MENU = { yeni: 'AsilPOS', eski: 'LafPOS' }; // eski-ad
/**
 * Kasa bekçisinin sürümü: kasa-yazici.ps1 eski sürüm bekçiyi bununla tanıyıp yenisiyle değiştirir (betik, asilpos.nsi ve
 * web-kurucu.ps1 ile aynı). 3: müşteri ekranı sunucu cevap verince açılır (inceleme, 23 Kas 2026); kasada çalışan eski
 * bekçi, kasa kısayolunun bir sonraki açılışında yenisiyle değişir. 4: bakım arasında (Yönetim › Ağ) kasa penceresi
 * yeniden açılmaz
 */
export const WATCHER_VERSION = 4;
/** Kasa bekçisinin Başlangıç kısayolu (ASCII ad: kasa-yazici.ps1 de arar) */
export const WATCHER_LINK = 'AsilPOS Kasa Bekcisi.lnk';
const MARKER = 'kurulum-yenileme.json';
const errText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Kurulumun kısayolları (asilpos.nsi ve web-kurucu.ps1 ile aynı adlar). `klasor`: .NET özel klasör adı; `kosul`: aynı
 * klasörde bu dosyalardan hiçbiri yoksa kısayol yazılmaz (yalnız varsa yenilenir); `eski`: kısayol yazılınca aynı
 * klasörden silinen eski adlar
 */
export function shortcutSpec(installDir, systemRoot = 'C:\\Windows') {
  const j = win32.join;
  const ps = j(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psFile = (file, extra = '') => `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${j(installDir, file)}"${extra}`;
  const kasa = j(installDir, 'AsilPOS-Kasa.bat');
  const base = { ikon: `${j(installDir, 'asilpos.ico')},0`, calismaKlasoru: installDir };
  const kasaLink = { ...base, hedef: kasa, arguman: '', aciklama: 'Kasa ekranı (tam ekran)', pencere: 7 };
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
    { ...kasaLink, klasor: 'CommonDesktopDirectory', ad: kasaAdi, kosul: [kasaAdi, eskiKasa], eski: [eskiKasa] },
    { ...kasaLink, klasor: 'CommonStartup', ad: kasaAdi, kosul: [kasaAdi, eskiKasa], eski: [eskiKasa] },
    {
      ...base,
      klasor: 'CommonStartup',
      ad: WATCHER_LINK,
      kosul: [kasaAdi, eskiKasa],
      eski: [`${MENU.eski} Kasa Bekcisi.lnk`],
      hedef: ps,
      arguman: psFile('app\\kasa-yazici.ps1', ` -Bekci -BekciSurum ${WATCHER_VERSION}`),
      aciklama: 'Kasa ve müşteri ekranı açık kalsın (kapanırsa yeniden açar)',
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
  for (const name of readdirSync(src).sort()) {
    const from = join(src, name);
    const to = join(installDir, name);
    try {
      const data = readFileSync(from);
      if (IF_PRESENT_ROOT_FILES.includes(name) && !existsSync(to)) continue;
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

/** Panelde görünen uyarı (yapılamayan bir şey yoksa null) */
export function warningFor({ failed = [], stale = [], shortcuts = null }) {
  const parts = [];
  if (failed.length) parts.push(`kurulum dosyaları yenilenemedi (${failed.map((f) => f.name).join(', ')})`);
  if (stale.length) parts.push(`${stale.join(', ')} eski kaldı (çalışırken değiştirilemez)`);
  if (shortcuts) parts.push(`kısayollar yenilenemedi (${shortcuts})`);
  if (!parts.length) return null;
  return `Kurulumu yenileyin (AsilPOS-Kur.cmd'yi yeniden çalıştırın): ${parts.join('; ')}`.slice(0, 300);
}

/** kisayollar.ps1'i çalıştırır; hata yoksa null, varsa kısa açıklama */
function runShortcutScript({ appDir, listFile, systemRoot }) {
  const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appDir, 'kisayollar.ps1'), '-Liste', listFile, '-EskiMenu', MENU.eski, '-YeniMenu', MENU.yeni],
      { timeout: 60_000, windowsHide: true },
      (err, stdout) => {
        const lines = String(stdout ?? '')
          .split(/\r?\n/)
          .filter((l) => l.startsWith('HATA'));
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
 *   runShortcuts?: (o: { appDir: string, listFile: string, systemRoot: string }) => Promise<string|null> }} deps
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
      shortcuts = await (deps.runShortcuts ?? runShortcutScript)({ appDir: deps.appDir, listFile, systemRoot });
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
