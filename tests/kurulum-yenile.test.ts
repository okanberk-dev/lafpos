import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ESKI_BEKCI_STDIN_ENV, ESKI_GUNCELLEME_DENEME_ENV, ESKI_URUN_ADI, KURULUM_KLASORU } from '@shared/eski-adlar';

/**
 * Güncellemenin kurulumu da yenilemesi (scripts/kasa/windows/kurulum/kurulum-yenile.mjs): kök dosyalar (baslat.cmd
 * hariç), kısayollar (kurulumdakiyle aynı adlar, derleme başına bir kez), yapılamayanın uyarısı (durum.json
 * `kurulumUyari`), kurulum derlemesinin paket denemesinde (derle.mjs) yenilemenin kapalı olması ve kasa ekranı bekçisi
 * (kasa-yazici.ps1 -Bekci): kasa penceresini açık tutar, tek çalışır, geçici denetçiyi kaldırır, müşteri ekranını
 * sunucu cevap verince açar.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href) as Promise<Mod>;
const read = (p: string, enc: BufferEncoding = 'utf8') => readFileSync(new URL(p, root), enc);
const ASCII = /^[\x00-\x7f]*$/;

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'asilpos-kurulum-'));
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
  for (const [n, v] of Object.entries({ 'AsilPOS-Kasa.bat': 'yeni bat', 'yonet.ps1': 'ayni', 'baslat.cmd': 'yeni baslat', 'BENIOKU.txt': 'yeni not' })) writeFileSync(join(app, 'kok', n), v);
  for (const [n, v] of Object.entries({ 'AsilPOS-Kasa.bat': 'eski bat', 'yonet.ps1': 'ayni', 'baslat.cmd': 'eski baslat' })) writeFileSync(join(dir, n), v);
  return { dir, app, home: join(dir, 'veri') };
}

/**
 * Gerçek bekçiyi (bekci.mjs ve pakete onunla giren betikler) install()'ın kurulum klasöründe sahte bir sunucuyla açar;
 * sunucu hazır deyince durdurur. Kurulum yenilemesi açılışta, sunucunun ilk çıktısından önce kök dosyaları koyar
 */
async function runWatchdog(extra: Record<string, string>, prepare?: (t: ReturnType<typeof install>) => void) {
  const t = install();
  prepare?.(t);
  for (const f of ['bekci.mjs', 'ayarlar.mjs', 'guncelle.mjs', 'arsiv.mjs', 'geri-yukle.mjs', 'kurulum-yenile.mjs']) {
    copyFileSync(new URL(`scripts/kasa/windows/kurulum/${f}`, root), join(t.app, f));
  }
  mkdirSync(join(t.app, 'server'));
  // Bekçinin "kapat"ı gelince (ya da bekçi kapanıp standart girdi bitince) çıkar
  writeFileSync(join(t.app, 'server', 'index.mjs'), "console.log('AsilPOS sunucusu hazır');\nfor (const e of ['data', 'end']) process.stdin.on(e, () => process.exit(0));\n");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [`${ESKI_GUNCELLEME_DENEME_ENV}`, 'ASILPOS_PAKET_DENEME', `${ESKI_BEKCI_STDIN_ENV}`, 'ASILPOS_MAX_HEAP_MB']) delete env[k];
  const child = spawn(process.execPath, [join(t.app, 'bekci.mjs')], { env: { ...env, ASILPOS_HOME: t.home, ...extra }, stdio: 'ignore' });
  const logFile = join(t.home, 'logs', 'sunucu.log');
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
  try {
    for (let i = 0; !log().includes('AsilPOS sunucusu hazır'); i++) {
      if (i > 200 || child.exitCode != null) throw new Error(`bekçi sunucuyu açmadı:\n${log()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  return { ...t, log: log() };
}

describe('kurulumun kök dosyaları ve kısayolları', () => {
  it('kök dosyalar yalnız farklıysa konur; baslat.cmd çalışırken değişmez, eski kaldığı söylenir', async () => {
    const { syncRootFiles } = await load('kurulum-yenile.mjs');
    const { dir, app } = install();
    const r = syncRootFiles({ appDir: app, installDir: dir });
    expect(r.copied).toEqual(['AsilPOS-Kasa.bat', 'BENIOKU.txt']);
    expect(r.stale).toEqual(['baslat.cmd']);
    expect(r.failed).toEqual([]);
    expect(readFileSync(join(dir, 'AsilPOS-Kasa.bat'), 'utf8')).toBe('yeni bat');
    expect(readFileSync(join(dir, 'baslat.cmd'), 'utf8')).toBe('eski baslat');
    // İkinci kez: konacak bir şey kalmaz
    expect(syncRootFiles({ appDir: app, installDir: dir }).copied).toEqual([]);
  });

  it('eski kısayolların yönlendiricisi yalnız yenisi kurulumdaysa konur (yoksa eski kasa kısayolu tam hâliyle kalır)', async () => {
    const { syncRootFiles, ROOT_FILE_NEEDS } = await load('kurulum-yenile.mjs');
    const eskiBat = `${ESKI_URUN_ADI}-Kasa.bat`;
    expect(ROOT_FILE_NEEDS).toEqual({ [eskiBat]: 'AsilPOS-Kasa.bat' });
    // Yeni bat pakette yok (ya da konamadı), kurulumda da yok: yönlendirici konmaz, eski bat yerinde
    const a = install();
    rmSync(join(a.app, 'kok', 'AsilPOS-Kasa.bat'));
    rmSync(join(a.dir, 'AsilPOS-Kasa.bat'));
    writeFileSync(join(a.app, 'kok', eskiBat), 'yonlendirici');
    writeFileSync(join(a.dir, eskiBat), 'eski tam bat');
    expect(syncRootFiles({ appDir: a.app, installDir: a.dir }).copied).not.toContain(eskiBat);
    expect(readFileSync(join(a.dir, eskiBat), 'utf8')).toBe('eski tam bat');
    // Yeni bat konunca yönlendirici de (sıra: önce bağlandığı dosya)
    const b = install();
    rmSync(join(b.dir, 'AsilPOS-Kasa.bat'));
    writeFileSync(join(b.app, 'kok', eskiBat), 'yonlendirici');
    writeFileSync(join(b.dir, eskiBat), 'eski tam bat');
    expect(syncRootFiles({ appDir: b.app, installDir: b.dir }).copied).toEqual(['AsilPOS-Kasa.bat', 'BENIOKU.txt', eskiBat]);
    expect(readFileSync(join(b.dir, eskiBat), 'utf8')).toBe('yonlendirici');
  });

  it('siteden kurulumun kaldırıcısı yalnız kurulumda varsa yenilenir (kurulum dosyasıyla kurulanda Kaldir.exe var)', async () => {
    const { syncRootFiles, IF_PRESENT_ROOT_FILES } = await load('kurulum-yenile.mjs');
    const kaldirici = `${ESKI_URUN_ADI}-Kaldir.ps1`;
    expect(IF_PRESENT_ROOT_FILES).toEqual([kaldirici]);
    const { dir, app } = install();
    writeFileSync(join(app, 'kok', kaldirici), 'yeni kaldirici');
    expect(syncRootFiles({ appDir: app, installDir: dir }).copied).not.toContain(kaldirici);
    expect(existsSync(join(dir, kaldirici))).toBe(false);
    writeFileSync(join(dir, kaldirici), 'eski kaldirici');
    expect(syncRootFiles({ appDir: app, installDir: dir }).copied).toEqual([kaldirici]);
    expect(readFileSync(join(dir, kaldirici), 'utf8')).toBe('yeni kaldirici');
  });

  it('kısayollar iki kurulumda ve güncellemede tek listeden; masaüstü ve Başlangıç yalnız varsa; bekçi Başlangıç\'ta kasa varsa', async () => {
    const { shortcutSpec, WATCHER_LINK, WATCHER_VERSION } = await load('kurulum-yenile.mjs');
    const kur = `C:\\Program Files\\${KURULUM_KLASORU}`;
    const spec = shortcutSpec(kur, 'C:\\Windows');
    const nsi = read('scripts/kasa/windows/kurulum/asilpos.nsi');
    const web = read('scripts/kasa/windows/kurulum/web-kurucu.ps1');
    // Kurulumlar listeyi elle yazmaz: kurulan app\ içindeki aynı komutu çalıştırır (tests/masaustu-programi.test.ts)
    expect(nsi).toContain('"$INSTDIR\\app\\kurulum-yenile.mjs" kisayollar --gruplar "$GRUPLAR"');
    expect(web).toContain("(Join-Path $Kur 'app\\kurulum-yenile.mjs'), 'kisayollar', '--gruplar', 'masaustu,baslangic'");
    // Kurulu kaldırıcılar (eski Kaldir.exe dahil) sabit adları siler: adlar değişmedi
    for (const ad of ['AsilPOS Kasa.lnk', WATCHER_LINK]) expect(spec.some((k: any) => k.ad.endsWith(ad)), ad).toBe(true);
    expect(nsi).toContain('Delete "$SMSTARTUP\\AsilPOS Kasa Bekcisi.lnk"');
    expect(nsi).toContain('RMDir /r "$SMPROGRAMS\\AsilPOS"');
    // Masaüstü ve Başlangıç: eski adlı kasa kısayolu da koşulu sağlar; yenisi yazılınca eskisi silinir (ad değişikliği)
    const eskiKasa = `${ESKI_URUN_ADI} Kasa.lnk`;
    for (const k of spec.filter((x: any) => x.klasor !== 'CommonPrograms')) {
      expect(k.kosul, k.ad).toEqual(['AsilPOS Kasa.lnk', eskiKasa]);
      expect(k.eski, k.ad).toEqual([k.ad === WATCHER_LINK ? `${ESKI_URUN_ADI} Kasa Bekcisi.lnk` : eskiKasa]);
      expect(k.grup, k.ad).toBe(k.klasor === 'CommonStartup' ? 'baslangic' : 'masaustu');
    }
    expect(spec.filter((x: any) => x.klasor === 'CommonPrograms').every((x: any) => x.ad.startsWith('AsilPOS\\'))).toBe(true);
    const watcher = spec.find((k: any) => k.ad === WATCHER_LINK);
    expect(watcher).toMatchObject({ klasor: 'CommonStartup', hedef: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', calismaKlasoru: kur });
    expect(watcher.arguman).toBe(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${kur}\\app\\kasa-yazici.ps1" -Bekci -BekciSurum ${WATCHER_VERSION}`);
    // Bekçi sürümü yalnız listede ve betikte: kurulumlar bekçi kısayolunu elle yazmaz
    expect(nsi).not.toContain('-Bekci -BekciSurum');
    expect(web).not.toContain('-Bekci -BekciSurum');
    const ps1 = read('scripts/kasa/windows/kurulum/kasa-yazici.ps1');
    expect(ps1).toContain(`$BekciSurumu = ${WATCHER_VERSION}`);
    expect(ps1).toContain(`'${WATCHER_LINK}'`);
  });

  it('Windows\'ta kısayollar derleme başına bir kez yazılır; başarısızsa uyarı kalır ve her açılışta yeniden denenir', async () => {
    const { refreshInstall } = await load('kurulum-yenile.mjs');
    const { dir, app, home } = install();
    writeFileSync(join(app, 'kisayollar.ps1'), '# deneme');
    const calls: any[] = [];
    const seenInstall: string[] = [];
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
        seenInstall.push(o.installDir);
        return fail;
      },
    };
    await refreshInstall(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ klasor: 'CommonPrograms', ad: 'AsilPOS\\AsilPOS Kasa.lnk' });
    expect(seenInstall).toEqual([dir]);
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

  it('kısayol betiği önce Uygulamalar kaydını yeniler: eski Kaldir.exe yerine siteden kurulumun kaldırıcısı, görünen ad AsilPOS', async () => {
    const { shortcutArgs, UNINSTALL_KEY, IF_PRESENT_ROOT_FILES, MENU } = await load('kurulum-yenile.mjs');
    // Kayıt anahtarı kurulumların yazdığıyla aynı (kurulum dosyası 32 bit: WOW6432Node)
    expect(UNINSTALL_KEY).toBe(`HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${KURULUM_KLASORU}`);
    expect(read('scripts/kasa/windows/kurulum/web-kurucu.ps1')).toContain(`$anahtar = '${UNINSTALL_KEY}'`);
    expect(read('scripts/kasa/windows/kurulum/web-kaldir.ps1')).toContain(`'${UNINSTALL_KEY}'`);
    expect(read('scripts/kasa/windows/kurulum/asilpos.nsi')).toContain(`!define UNINST_KEY "${UNINSTALL_KEY.replace('HKLM:\\', '').replace('WOW6432Node\\', '')}"`);
    const args = shortcutArgs({ appDir: 'C:\\K\\app', installDir: 'C:\\K', listFile: 'C:\\V\\liste.json' });
    const arg = (n: string) => args[args.indexOf(n) + 1];
    expect(arg('-Kurulum')).toBe('C:\\K');
    expect(arg('-Kayit')).toBe(UNINSTALL_KEY);
    expect(arg('-Kaldirici')).toBe(join('C:\\K\\app', 'kok', IF_PRESENT_ROOT_FILES[0]));
    expect([arg('-EskiMenu'), arg('-YeniMenu')]).toEqual([MENU.eski, MENU.yeni]);
    const ps = read('scripts/kasa/windows/kurulum/kisayollar.ps1').replace(/\r\n/g, '\n');
    const adim = ps.indexOf('if ($Kurulum -and $Kayit -and $YeniMenu)');
    const dongu = ps.indexOf('foreach ($k in $items)');
    expect(adim).toBeGreaterThan(0);
    // Kaldırıcı adımı kısayollardan önce; olmazsa hiçbir kısayol değişmez (eski kaldırıcı eski adları bilir)
    expect(adim).toBeLessThan(dongu);
    const kaldirici = ps.slice(adim, dongu);
    expect(kaldirici).toContain("(Test-Path -LiteralPath $exe) -and $gorunen -ne $YeniMenu");
    expect(kaldirici).toContain("Set-ItemProperty -LiteralPath $Kayit -Name 'UninstallString'");
    expect(kaldirici).toContain("Remove-ItemProperty -LiteralPath $Kayit -Name 'QuietUninstallString'");
    expect(kaldirici).toContain('Remove-Item -LiteralPath $exe -Force');
    expect(kaldirici).toContain("Set-ItemProperty -LiteralPath $Kayit -Name 'DisplayName' -Value $YeniMenu");
    expect(kaldirici).toContain("Set-ItemProperty -LiteralPath $Kayit -Name 'DisplayIcon'");
    expect(kaldirici).toMatch(/HATA kaldirici[^\n]*\n\s*exit 1/);
    // Kaldır kısayolu yeni kaldırıcıya: Kaldir.exe silinmeden önce, kayıttan önce
    expect(kaldirici.indexOf('$l.TargetPath = $psExe')).toBeLessThan(kaldirici.indexOf("-Name 'UninstallString'"));
    expect(kaldirici.indexOf("-Name 'UninstallString'")).toBeLessThan(kaldirici.indexOf('Remove-Item -LiteralPath $exe'));
    // Hedefi olmayan kısayol yazılmaz, eskisi silinmez
    const govde = ps.slice(dongu);
    expect(govde.indexOf("throw ('hedef yok: '")).toBeGreaterThan(0);
    expect(govde.indexOf("throw ('hedef yok: '")).toBeLessThan(govde.indexOf('$s.Save()'));
    // Siteden kurulum aynı kuralla: görünen ad AsilPOS değilse Kaldir.exe eskidir, silinir; kaldırıcılar onu da siler
    const web = read('scripts/kasa/windows/kurulum/web-kurucu.ps1');
    expect(web).toContain("$kaldirExeYeni = (Test-Path -LiteralPath $kaldirExe) -and ($gorunenAd -eq 'AsilPOS')");
    expect(web).toContain("if (-not $kaldirExeYeni) { Remove-ItemProperty -LiteralPath $anahtar -Name 'QuietUninstallString'");
    expect(read('scripts/kasa/windows/kurulum/web-kaldir.ps1')).toContain("'Kaldir.exe', '" + IF_PRESENT_ROOT_FILES[0] + "'");
    expect(read('scripts/kasa/windows/kurulum/asilpos.nsi')).toContain(`Delete "$INSTDIR\\${IF_PRESENT_ROOT_FILES[0]}"`);
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
    // Kasa kısayolu güncellemeyle yalnız app\kok\'ten gelir; app\'te okunmayan ikinci kopyası yok
    const at = paket.indexOf('KASA_LAUNCHER = [');
    const launcher = paket.slice(at, paket.indexOf('];', at));
    expect(launcher).toContain("['kasa-yazici.ps1', 'kasa-yazici.ps1']");
    expect(launcher).not.toContain('AsilPOS-Kasa.bat');
    for (const f of ['kisayollar.ps1', 'kasa-yazici.ps1']) expect(ASCII.test(read(`scripts/kasa/windows/kurulum/${f}`, 'latin1')), f).toBe(true);
    const bekci = read('scripts/kasa/windows/kurulum/bekci.mjs');
    expect(bekci).toContain('refreshInstall(');
    expect(bekci).toContain('setInstallWarning');
  });
});

describe('kurulumu yalnız kurulu bekçi yeniler (paket denemesi dokunmaz)', () => {
  it('kurulu bekçi açılışta kök dosyaları yeniler', async () => {
    const r = await runWatchdog({});
    expect(readFileSync(join(r.dir, 'AsilPOS-Kasa.bat'), 'utf8')).toBe('yeni bat');
    expect(r.log).toContain('[kurulum] kök dosyalar yenilendi: AsilPOS-Kasa.bat, BENIOKU.txt');
  });

  it('paket denemesi (derle.mjs, ASILPOS_PAKET_DENEME=1) kök dosyalara ve kısayollara dokunmaz; güncelleyici yine durumu yazar', async () => {
    // Yenilese yönetici kabuğunda bu bilgisayardaki AsilPOS'un ortak kısayolları silinecek deneme klasörüne dönerdi
    const r = await runWatchdog({ ASILPOS_PAKET_DENEME: '1' });
    expect(readFileSync(join(r.dir, 'AsilPOS-Kasa.bat'), 'utf8')).toBe('eski bat');
    expect(existsSync(join(r.dir, 'BENIOKU.txt'))).toBe(false);
    expect(r.log).not.toContain('[kurulum]');
    // Deneme güncelleyicinin durum dosyasına bakar (derle.mjs): güncelleyici kapanmaz
    expect(JSON.parse(readFileSync(join(r.home, 'guncelleme', 'durum.json'), 'utf8')).kurulu.build).toBe(1_795_100_000);
    // Kurulum derlemesinin denemesi bekçiyi bu bayrakla açar ve yenilenmediğini kendisi de denetler
    const derle = read('scripts/kasa/windows/kurulum/derle.mjs');
    expect(derle).toContain("ASILPOS_NO_JOBS: '1', ASILPOS_PAKET_DENEME: '1'");
    expect(derle).toContain("existsSync(join(tmp, 'AsilPOS-Kasa.bat'))");
  });
});

describe('kurulumun güncelleme isteği (asilpos.nsi: kurulum yeni sürümü de alsın)', () => {
  /** Kurulum dosyasının sunucuyu açmadan önce yazdığı istek ("Şimdi güncelle"nin dosyası, aynı biçim) */
  const istekYaz = (t: { home: string }) => {
    mkdirSync(join(t.home, 'guncelleme'), { recursive: true });
    writeFileSync(join(t.home, 'guncelleme', 'istek.json'), JSON.stringify({ at: Date.now(), by: 'kurulum', simdi: false }));
  };
  const durum = (home: string) => JSON.parse(readFileSync(join(home, 'guncelleme', 'durum.json'), 'utf8'));

  it('bekçi açılışta alır, kanala hemen sorar (iki dakika beklemez)', async () => {
    // Kanal bu bilgisayarda ve kapalı: denetim hemen düşer, dışarıya istek gitmez. Paket denemesi kipi kısayollara dokunmaz
    const r = await runWatchdog({ ASILPOS_PAKET_DENEME: '1', ASILPOS_GUNCELLEME_KANAL: 'http://127.0.0.1:9/guncelleme/surum.json' }, istekYaz);
    expect(existsSync(join(r.home, 'guncelleme', 'istek.json'))).toBe(false);
    expect(r.log).toContain('[bekçi] kurulumun güncelleme isteği: yeni sürüm hemen denetleniyor');
    expect(durum(r.home).sonIstek).toEqual(expect.any(String));
  });

  it('otomatik güncelleme kapalıysa (ayarlar.env) kurulumun isteği yok sayılır; elle istek kapalıyken de çalışır', async () => {
    const r = await runWatchdog({ ASILPOS_PAKET_DENEME: '1', ASILPOS_GUNCELLEME: 'kapali' }, istekYaz);
    expect(existsSync(join(r.home, 'guncelleme', 'istek.json'))).toBe(false);
    expect(r.log).toContain('[bekçi] kurulumun güncelleme isteği yok sayıldı: otomatik güncelleme kapalı');
    expect(durum(r.home).sonIstek ?? null).toBeNull();
    const elle = await runWatchdog({ ASILPOS_PAKET_DENEME: '1', ASILPOS_GUNCELLEME: 'kapali', ASILPOS_GUNCELLEME_KANAL: 'http://127.0.0.1:9/guncelleme/surum.json' }, (t) => {
      mkdirSync(join(t.home, 'guncelleme'), { recursive: true });
      writeFileSync(join(t.home, 'guncelleme', 'istek.json'), JSON.stringify({ at: Date.now(), by: 'patron', simdi: false }));
    });
    expect(elle.log).toContain('[bekçi] elle güncelleme isteği');
    expect(durum(elle.home).sonIstek).toEqual(expect.any(String));
  });

  it('kurulum dosyası isteği sunucuyu açmadan önce, aynı biçimde ve hep simdi: false yazar; an Unix ms', async () => {
    const nsi = read('scripts/kasa/windows/kurulum/asilpos.nsi');
    const son = nsi.slice(nsi.indexOf('Section "-Kisayollar ve sunucu" SecSon'), nsi.indexOf('SectionEnd', nsi.indexOf('Section "-Kisayollar ve sunucu" SecSon')));
    const yaz = son.indexOf('FileOpen $9 "$DATA\\guncelleme\\istek.json.tmp" w');
    const calistir = son.indexOf('/Run /TN "${TASK}"');
    expect(yaz).toBeGreaterThan(0);
    expect(yaz).toBeLessThan(calistir);
    expect(son.indexOf('Rename "$DATA\\guncelleme\\istek.json.tmp" "$DATA\\guncelleme\\istek.json"')).toBeLessThan(calistir);
    // Biçim sunucunun "Şimdi güncelle" dosyasıyla aynı (server/lib/surum.ts UpdateRequest): {at, by, simdi}
    const satir = /FileWrite \$9 '(\{"at":\$1,[^']*\})'/.exec(son)![1]!;
    const at = 1_795_824_840_000;
    expect(JSON.parse(satir.replace('$1', String(at)))).toEqual({ at, by: 'kurulum', simdi: false });
    expect(nsi).not.toMatch(/"simdi":true/);
    // an: FILETIME (100 ns, 1601'den) → Unix ms
    expect(son).toContain("System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r1)'");
    const fark = /System::Int64Op \$1 - (\d+)/.exec(son)![1]!;
    expect(BigInt(fark)).toBe(BigInt(Date.UTC(1970, 0, 1) - Date.UTC(1601, 0, 1)) * 10_000n);
    expect(son).toContain('System::Int64Op $1 / 10000');
    // Bekçi kurulumun isteğini yalnız otomatik güncelleme açıkken iletir, gün açıkken kurdurmaz
    const bekci = read('scripts/kasa/windows/kurulum/bekci.mjs');
    expect(bekci).toContain("const KURULUM_ISTEGI = 'kurulum';");
    const al = bekci.slice(bekci.indexOf('if (req.by === KURULUM_ISTEGI) {'), bekci.indexOf("log(`[bekçi] elle güncelleme isteği"));
    expect(al).toContain("if (updateMode(envFor()) === 'kapali') {");
    expect(al).toContain('updater.requestNow({ force: false })');
    expect(al).not.toContain('req.simdi');
  });
});

describe('kasa ekranı bekçisi (kasa-yazici.ps1)', () => {
  const ps1 = read('scripts/kasa/windows/kurulum/kasa-yazici.ps1');
  const bat = read('scripts/kasa/windows/AsilPOS-Kasa.bat');

  it('bekçi kasa penceresini de açık tutar; tek bekçi; kasa penceresi kilit altında açılır (iki pencere olmaz)', () => {
    const loop = ps1.slice(ps1.indexOf('if ($Bekci) {'));
    expect(loop).toContain(`Mutex($false, 'Local\\${ESKI_URUN_ADI}-KasaBekci')`);
    expect(loop).toContain('Open-KasaWindow $true');
    expect(loop).toContain('Start-Sleep -Seconds 15');
    expect(ps1).toContain(`Mutex($false, 'Local\\${ESKI_URUN_ADI}-KasaPencere')`);
    // Kasa profili; müşteri ekranının profili (chrome-musteri) ve alt süreçler sayılmaz
    expect(ps1).toContain(`'\\\\${ESKI_URUN_ADI}\\\\(chrome|edge)(?![\\w-])'`);
    expect(ps1).toContain("-notmatch '--type='");
    const re = new RegExp(`\\\\${ESKI_URUN_ADI}\\\\(chrome|edge)(?![\\w-])`);
    const profil = `C:\\Users\\k\\AppData\\Local\\${ESKI_URUN_ADI}`;
    expect(re.test(`--user-data-dir="${profil}\\chrome" --app=http://localhost:4000/`)).toBe(true);
    expect(re.test(`--user-data-dir="${profil}\\edge" --kiosk`)).toBe(true);
    expect(re.test(`--user-data-dir="${profil}\\chrome-musteri" --kiosk`)).toBe(false);
  });

  it('kasa penceresi bat\'in eski yoluyla aynı argümanlarla açılır (aynı profil, sessiz yazdırma; Edge InPrivate değil)', () => {
    for (const a of ['--kiosk-printing', `'${ESKI_URUN_ADI}\\chrome'`, `'${ESKI_URUN_ADI}\\edge'`, '--start-fullscreen', '--disable-session-crashed-bubble', '--noerrdialogs']) expect(ps1, a).toContain(a);
    for (const a of ['--kiosk-printing', `${ESKI_URUN_ADI}\\chrome"`, `${ESKI_URUN_ADI}\\edge"`, '--start-fullscreen']) expect(bat, a).toContain(a);
    // Edge'in kiosk kipi her zaman InPrivate: oturum ve sepet her açılışta giderdi (Chrome'un kiosk'u kalıcı profille)
    for (const t of [ps1, bat]) expect(t).not.toContain('--edge-kiosk-type');
    const edge = ps1.slice(ps1.indexOf("if ($exe -like '*msedge.exe') {"), ps1.indexOf('} else {', ps1.indexOf("if ($exe -like '*msedge.exe') {")));
    expect(edge).toContain("@(('--app=' + $kasaUrl), '--start-fullscreen', '--kiosk-printing'");
    expect(edge).not.toContain("'--kiosk'");
    expect(bat.slice(bat.indexOf(':edge'))).not.toMatch(/--kiosk /);
  });

  it('bat eski kısayollar için programı konsolsuz açıp hemen kapanır; betik yoksa eski yol', () => {
    const ac = bat.indexOf('kasa-yazici.ps1" -Ac');
    expect(ac).toBeGreaterThan(0);
    expect(ac).toBeLessThan(bat.indexOf(':eski'));
    // /min: start'ın açtığı yeni konsol PowerShell gizleyene dek ekranın ortasında belirmez (görev çubuğuna sabitlenmiş
    // eski kısayollar hâlâ bunu çalıştırır)
    expect(bat).toContain('start "" /min "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0app\\kasa-yazici.ps1" -Ac');
    expect(bat).toContain('if not exist "%~dp0app\\kasa-yazici.ps1" goto eski');
    expect(bat.indexOf(':eski')).toBeLessThan(bat.indexOf(':chrome'));
    expect(ASCII.test(read('scripts/kasa/windows/AsilPOS-Kasa.bat', 'latin1'))).toBe(true);
  });

  it('müşteri ekranı sunucu cevap vermeden açılmaz (hata sayfası açık kalıp bekçiyi durdurmasın); eski bekçi değişir', async () => {
    const fn = ps1.slice(ps1.indexOf('function Start-CustomerDisplay'), ps1.indexOf('function Stop-TemporaryDisplayWatcher'));
    // Kasa penceresininkiyle aynı denetim (/api/health), tarayıcı açılmadan önce
    expect(ps1).toContain('function Test-Server([string]$base)');
    expect(fn).toContain('if (-not (Test-Server $base)) { return }');
    expect(fn.indexOf('Test-Server $base')).toBeLessThan(fn.indexOf('Start-Process'));
    // Bekçi ve bat aynı adresi verir: 127.0.0.1, sonda / yok (Test-Server /api/health ekler)
    expect(ps1).toContain("$displayBase = ($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/')");
    expect(ps1.slice(ps1.indexOf('if ($Bekci) {'))).toContain('Start-CustomerDisplay $displayBase');
    // Kasada çalışan eski bekçi (sunucuya bakmadan açan) kasa kısayolunun bir sonraki açılışında yenisiyle değişsin
    const { WATCHER_VERSION } = await load('kurulum-yenile.mjs');
    expect(WATCHER_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('yeni tarayıcı açılmadan profilin HTTP önbelleği silinir (güncellemeden sonra eski arayüz önbellekten açılmasın)', () => {
    // 27 Kasım 2026 incelemesi, bulgu 5: eski sunucunun başlıksız verdiği index.html kiosk profilinde kalmış olabilir
    const temizle = ps1.slice(ps1.indexOf('function Clear-BrowserCache'), ps1.indexOf('function Test-CustomerDisplay'));
    expect(temizle).toContain("Join-Path $profileDir 'Default\\Cache'");
    expect(temizle).toContain('Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue');
    // Yalnız HTTP önbelleği: oturum ve yerel depolama kalır
    for (const kalir of ['Local Storage', 'Cookies', 'IndexedDB', 'Service Worker']) expect(temizle.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toContain(kalir);
    // Kasa penceresi: tarayıcı yokken (kilit ve Test-KasaWindow'dan sonra), Start-Process'ten hemen önce, kendi profiliyle
    const kasa = ps1.slice(ps1.indexOf('function Open-KasaWindow'), ps1.indexOf('function Remove-TemporaryKasaWatcher'));
    const kontrol = kasa.indexOf('$acik = Get-KasaProcess');
    const sil = kasa.indexOf('Clear-BrowserCache $kasaProfil');
    expect(kontrol).toBeGreaterThan(kasa.indexOf('WaitOne('));
    expect(sil).toBeGreaterThan(kontrol);
    expect(sil).toBeLessThan(kasa.indexOf('Start-Process'));
    expect(kasa).toContain(`$kasaProfil = Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}\\chrome'`);
    expect(kasa).toContain(`$kasaProfil = Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}\\edge'`);
    // Müşteri ekranı: kendi profili, açık değilken
    const musteri = ps1.slice(ps1.indexOf('function Start-CustomerDisplay'), ps1.indexOf('function Stop-TemporaryDisplayWatcher'));
    const msil = musteri.indexOf('Clear-BrowserCache $profileDir');
    expect(msil).toBeGreaterThan(musteri.indexOf('if (Test-CustomerDisplay) { return }'));
    expect(msil).toBeLessThan(musteri.indexOf('Start-Process'));
    expect(ASCII.test(read('scripts/kasa/windows/kurulum/kasa-yazici.ps1', 'latin1'))).toBe(true);
  });

  it('müşteri ekranı kilit altında açılır: oturum açılınca bat ile bekçi aynı anda iki pencere açmaz', () => {
    const fn = ps1.slice(ps1.indexOf('function Start-CustomerDisplay'), ps1.indexOf('function Stop-TemporaryDisplayWatcher'));
    // Kasa penceresinden ayrı kilit: biri açılırken öteki beklemesin
    expect(fn).toContain(`Mutex($false, 'Local\\${ESKI_URUN_ADI}-MusteriPencere')`);
    expect(fn).toContain('catch [System.Threading.AbandonedMutexException] { $own = $true }');
    // Açık mı, sunucu var mı ve açma aynı kilidin içinde; açtıktan sonra süreç görünene dek beklenir
    const lock = fn.indexOf('WaitOne(');
    const check = fn.indexOf('if (Test-CustomerDisplay) { return }');
    const start = fn.indexOf('Start-Process');
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(fn.indexOf('Test-Server $base')).toBeGreaterThan(check);
    expect(start).toBeGreaterThan(fn.indexOf('Test-Server $base'));
    const after = fn.slice(start);
    expect(after).toMatch(/for \(\$i = 0; \$i -lt 20; \$i\+\+\) \{\s+Start-Sleep -Milliseconds 500\s+if \(Test-CustomerDisplay\) \{ break \}/);
    // Kilit her çıkışta bırakılır (erken return dahil)
    expect(after.indexOf('finally {')).toBeGreaterThan(after.indexOf('Test-CustomerDisplay'));
    expect(after.slice(after.indexOf('finally {'))).toContain('$mx.ReleaseMutex()');
    // Süreç denetimi tek yerde: kilitli açma ile döngüdeki bekleme aynı süreci arar
    expect(ps1.slice(ps1.indexOf('function Test-CustomerDisplay'), ps1.indexOf('function Start-CustomerDisplay'))).toContain("-like '*chrome-musteri*'");
    expect(fn).not.toContain('$running');
  });

  it('eski bekçi yenisiyle değişir; Başlangıç kısayolu yoksa kullanıcı düzeyinde konur', () => {
    expect(ps1).toContain("-notlike $surumli } | ForEach-Object { Stop-Process");
    expect(ps1).toContain("'-Bekci', '-BekciSurum', [string]$surum");
    expect(ps1).toContain('if ($PSCommandPath -and -not $watching) { Start-WatcherProcess $BekciSurumu }');
    expect(ps1).toContain("Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'");
  });

  it('geçici kasa denetçisinin yalnız kısayolu ve klasörü kaldırılır', () => {
    const fn = ps1.slice(ps1.indexOf('function Remove-TemporaryKasaWatcher'), ps1.indexOf('function Read-ScriptBytes'));
    const removed = [...fn.matchAll(/Remove-Item -LiteralPath \$(\w+)/g)].map((m) => m[1]);
    expect(removed).toEqual(['lnk', 'dir']);
    expect(fn).toContain(`'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${ESKI_URUN_ADI} Kasa Kontrol.lnk'`);
    expect(fn).toContain(`Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}-KasaKontrol'`);
    // Bekçi kalıcı kurulunca (kendi kilidini aldıktan sonra) çağrılır
    const loop = ps1.slice(ps1.indexOf('if ($Bekci) {'));
    expect(loop.indexOf('Remove-TemporaryKasaWatcher')).toBeGreaterThan(loop.indexOf('WaitOne(0)'));
  });
});
