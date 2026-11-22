import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Güncellemenin kurulumu da yenilemesi (scripts/kasa/windows/kurulum/kurulum-yenile.mjs): kök dosyalar (baslat.cmd
 * hariç), kısayollar (kurulumdakiyle aynı adlar, derleme başına bir kez), yapılamayanın uyarısı (durum.json
 * `kurulumUyari`) ve kasa ekranı bekçisi (kasa-yazici.ps1 -Bekci): kasa penceresini açık tutar, tek çalışır, geçici
 * denetçiyi kaldırır.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href) as Promise<Mod>;
const read = (p: string, enc: BufferEncoding = 'utf8') => readFileSync(new URL(p, root), enc);
const ASCII = /^[\x00-\x7f]*$/;

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'lafpos-kurulum-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Kurulum klasörü: app\kok\ yeni sürümün kök dosyaları, kökte eskileri */
function install() {
  const dir = tmp();
  const app = join(dir, 'app');
  mkdirSync(join(app, 'kok'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ build: 1_795_100_000 }));
  for (const [n, v] of Object.entries({ 'LafPOS-Kasa.bat': 'yeni bat', 'yonet.ps1': 'ayni', 'baslat.cmd': 'yeni baslat', 'BENIOKU.txt': 'yeni not' })) writeFileSync(join(app, 'kok', n), v);
  for (const [n, v] of Object.entries({ 'LafPOS-Kasa.bat': 'eski bat', 'yonet.ps1': 'ayni', 'baslat.cmd': 'eski baslat' })) writeFileSync(join(dir, n), v);
  return { dir, app, home: join(dir, 'veri') };
}

describe('kurulumun kök dosyaları ve kısayolları', () => {
  it('kök dosyalar yalnız farklıysa konur; baslat.cmd çalışırken değişmez, eski kaldığı söylenir', async () => {
    const { syncRootFiles } = await load('kurulum-yenile.mjs');
    const { dir, app } = install();
    const r = syncRootFiles({ appDir: app, installDir: dir });
    expect(r.copied).toEqual(['BENIOKU.txt', 'LafPOS-Kasa.bat']);
    expect(r.stale).toEqual(['baslat.cmd']);
    expect(r.failed).toEqual([]);
    expect(readFileSync(join(dir, 'LafPOS-Kasa.bat'), 'utf8')).toBe('yeni bat');
    expect(readFileSync(join(dir, 'baslat.cmd'), 'utf8')).toBe('eski baslat');
    // İkinci kez: konacak bir şey kalmaz
    expect(syncRootFiles({ appDir: app, installDir: dir }).copied).toEqual([]);
  });

  it('kısayollar kurulumdakiyle aynı adda; masaüstü ve Başlangıç yalnız varsa; bekçi Başlangıç\'ta kasa varsa', async () => {
    const { shortcutSpec, WATCHER_LINK, WATCHER_VERSION } = await load('kurulum-yenile.mjs');
    const spec = shortcutSpec('C:\\Program Files\\LafPOS', 'C:\\Windows');
    const nsi = read('scripts/kasa/windows/kurulum/lafpos.nsi');
    const web = read('scripts/kasa/windows/kurulum/web-kurucu.ps1');
    for (const k of spec) {
      const name = k.ad.split('\\').pop();
      expect(nsi, name).toContain(name);
      expect(web, name).toContain(name);
    }
    expect(spec.filter((k: any) => k.klasor !== 'CommonPrograms').every((k: any) => k.kosul === 'LafPOS Kasa.lnk')).toBe(true);
    const watcher = spec.find((k: any) => k.ad === WATCHER_LINK);
    expect(watcher).toMatchObject({ klasor: 'CommonStartup', hedef: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', calismaKlasoru: 'C:\\Program Files\\LafPOS' });
    expect(watcher.arguman).toBe(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Program Files\\LafPOS\\app\\kasa-yazici.ps1" -Bekci -BekciSurum ${WATCHER_VERSION}`);
    // Kurulum dosyası ve siteden kurulum bekçiyi aynı argümanla koyar; betik aynı sürümü tanır
    expect(nsi).toContain(`kasa-yazici.ps1" -Bekci -BekciSurum ${WATCHER_VERSION}'`);
    expect(web).toContain(`" -Bekci -BekciSurum ${WATCHER_VERSION}'`);
    const ps1 = read('scripts/kasa/windows/kurulum/kasa-yazici.ps1');
    expect(ps1).toContain(`$BekciSurumu = ${WATCHER_VERSION}`);
    expect(ps1).toContain(`'${WATCHER_LINK}'`);
  });

  it('Windows\'ta kısayollar derleme başına bir kez yazılır; başarısızsa uyarı kalır ve her açılışta yeniden denenir', async () => {
    const { refreshInstall } = await load('kurulum-yenile.mjs');
    const { dir, app, home } = install();
    writeFileSync(join(app, 'kisayollar.ps1'), '# deneme');
    const calls: any[] = [];
    let fail: string | null = 'HATA 3: Erişim engellendi';
    const warnings: (string | null)[] = [];
    const deps = {
      appDir: app,
      installDir: dir,
      home,
      build: 1_795_100_000,
      log: () => {},
      platform: 'win32',
      setWarning: (w: string | null) => warnings.push(w),
      runShortcuts: async (o: any) => {
        calls.push(JSON.parse(readFileSync(o.listFile, 'utf8')));
        return fail;
      },
    };
    await refreshInstall(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ klasor: 'CommonPrograms', ad: 'LafPOS\\LafPOS Kasa.lnk' });
    expect(warnings.at(-1)).toMatch(/^Kurulumu yenileyin/);
    expect(warnings.at(-1)).toContain('baslat.cmd eski kaldı');
    expect(warnings.at(-1)).toContain('kısayollar yenilenemedi (HATA 3: Erişim engellendi)');
    fail = null;
    writeFileSync(join(dir, 'baslat.cmd'), 'yeni baslat');
    await refreshInstall(deps);
    expect(calls).toHaveLength(2);
    expect(warnings.at(-1)).toBeNull();
    // Aynı derlemede başarıyla yazıldı: yeniden yazılmaz
    await refreshInstall(deps);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(home, 'guncelleme', 'kurulum-yenileme.json'), 'utf8'))).toMatchObject({ build: 1_795_100_000, ok: true });
    // Yeni derleme: yeniden
    await refreshInstall({ ...deps, build: 1_795_200_000 });
    expect(calls).toHaveLength(3);
  });

  it('Windows dışında kısayola dokunulmaz; kök dosyalar yine yenilenir', async () => {
    const { refreshInstall } = await load('kurulum-yenile.mjs');
    const { dir, app, home } = install();
    writeFileSync(join(dir, 'baslat.cmd'), 'yeni baslat');
    const warnings: (string | null)[] = [];
    let called = false;
    await refreshInstall({ appDir: app, installDir: dir, home, build: 1, log: () => {}, platform: 'linux', setWarning: (w: string | null) => warnings.push(w), runShortcuts: async () => ((called = true), null) });
    expect(called).toBe(false);
    expect(warnings).toEqual([null]);
    expect(readFileSync(join(dir, 'BENIOKU.txt'), 'utf8')).toBe('yeni not');
    expect(existsSync(join(home, 'guncelleme', 'kurulum-yenileme.json'))).toBe(false);
  });

  it('uyarı durum.json\'da kalır: açılış ve denetim silmez, yalnız yeni sonuç değiştirir', async () => {
    const { nextStatus } = await load('guncelle.mjs');
    let s = nextStatus(null, { type: 'kurulum', uyari: 'Kurulumu yenileyin: x' });
    expect(s.kurulumUyari).toBe('Kurulumu yenileyin: x');
    s = nextStatus(s, { type: 'acilis', kurulu: { surum: '0.3.0', build: 1 }, mode: 'otomatik', now: Date.now() });
    expect(s.kurulumUyari).toBe('Kurulumu yenileyin: x');
    s = nextStatus(s, { type: 'kurulum', uyari: null });
    expect(s.kurulumUyari).toBeNull();
  });

  it('pakete girer: yenileyici bekçiyle, kısayol betiği CRLF ve ASCII, kök dosyalar app\\kok\\', async () => {
    const paket = read('scripts/kasa/windows/kurulum/paket.mjs');
    expect(paket).toMatch(/KASA_SCRIPTS = \[[^\]]*'kurulum-yenile\.mjs'/);
    expect(paket).toContain("['kisayollar.ps1', 'kisayollar.ps1']");
    expect(paket).toContain('shellFiles(root)');
    for (const f of ['kisayollar.ps1', 'kasa-yazici.ps1']) expect(ASCII.test(read(`scripts/kasa/windows/kurulum/${f}`, 'latin1')), f).toBe(true);
    const bekci = read('scripts/kasa/windows/kurulum/bekci.mjs');
    expect(bekci).toContain('refreshInstall(');
    expect(bekci).toContain('setInstallWarning');
  });
});

describe('kasa ekranı bekçisi (kasa-yazici.ps1)', () => {
  const ps1 = read('scripts/kasa/windows/kurulum/kasa-yazici.ps1');
  const bat = read('scripts/kasa/windows/LafPOS-Kasa.bat');

  it('bekçi kasa penceresini de açık tutar; tek bekçi; kasa penceresi kilit altında açılır (iki pencere olmaz)', () => {
    const loop = ps1.slice(ps1.indexOf('if ($Bekci) {'));
    expect(loop).toContain("Mutex($false, 'Local\\LafPOS-KasaBekci')");
    expect(loop).toContain('Open-KasaWindow $true');
    expect(loop).toContain('Start-Sleep -Seconds 15');
    expect(ps1).toContain("Mutex($false, 'Local\\LafPOS-KasaPencere')");
    // Kasa profili; müşteri ekranının profili (chrome-musteri) ve alt süreçler sayılmaz
    expect(ps1).toContain("'\\\\LafPOS\\\\(chrome|edge)(?![\\w-])'");
    expect(ps1).toContain("-notmatch '--type='");
    const re = /\\LafPOS\\(chrome|edge)(?![\w-])/;
    expect(re.test('--user-data-dir="C:\\Users\\k\\AppData\\Local\\LafPOS\\chrome" --app=http://localhost:4000/')).toBe(true);
    expect(re.test('--user-data-dir="C:\\Users\\k\\AppData\\Local\\LafPOS\\edge" --kiosk')).toBe(true);
    expect(re.test('--user-data-dir="C:\\Users\\k\\AppData\\Local\\LafPOS\\chrome-musteri" --kiosk')).toBe(false);
  });

  it('kasa penceresi bat\'in argümanlarıyla açılır (aynı profil, sessiz yazdırma)', () => {
    for (const a of ['--kiosk-printing', "'LafPOS\\chrome'", "'LafPOS\\edge'", '--edge-kiosk-type=fullscreen', '--disable-session-crashed-bubble', '--noerrdialogs']) expect(ps1, a).toContain(a);
    for (const a of ['--kiosk-printing', 'LafPOS\\chrome"', 'LafPOS\\edge"', '--edge-kiosk-type=fullscreen']) expect(bat, a).toContain(a);
  });

  it('bat kasa penceresini betikle açar (bekçiyle çakışmaz); betik yoksa eski yol', () => {
    const ac = bat.indexOf('kasa-yazici.ps1" -KasaAc');
    expect(ac).toBeGreaterThan(bat.indexOf('kasa-yazici.ps1"'));
    expect(ac).toBeLessThan(bat.indexOf(':chrome'));
    expect(bat).toContain('if not errorlevel 1 exit /b 0');
    expect(ASCII.test(read('scripts/kasa/windows/LafPOS-Kasa.bat', 'latin1'))).toBe(true);
  });

  it('eski bekçi yenisiyle değişir; Başlangıç kısayolu yoksa kullanıcı düzeyinde konur', () => {
    expect(ps1).toContain("-notlike $surumli } | ForEach-Object { Stop-Process");
    expect(ps1).toContain("'-Bekci', '-BekciSurum', [string]$BekciSurumu");
    expect(ps1).toContain("Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'");
  });

  it('geçici kasa denetçisinin yalnız kısayolu ve klasörü kaldırılır', () => {
    const fn = ps1.slice(ps1.indexOf('function Remove-TemporaryKasaWatcher'), ps1.indexOf('$displayBase = $Url'));
    const removed = [...fn.matchAll(/Remove-Item -LiteralPath \$(\w+)/g)].map((m) => m[1]);
    expect(removed).toEqual(['lnk', 'dir']);
    expect(fn).toContain("'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\LafPOS Kasa Kontrol.lnk'");
    expect(fn).toContain("Join-Path $env:LOCALAPPDATA 'LafPOS-KasaKontrol'");
    // Bekçi kalıcı kurulunca (kendi kilidini aldıktan sonra) çağrılır
    const loop = ps1.slice(ps1.indexOf('if ($Bekci) {'));
    expect(loop.indexOf('Remove-TemporaryKasaWatcher')).toBeGreaterThan(loop.indexOf('WaitOne(0)'));
  });
});
