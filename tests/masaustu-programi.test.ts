import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALAN_ADI, ESKI_URUN_ADI, KURULUM_KLASORU } from '@shared/eski-adlar';

/**
 * Masaüstü programı (sahibin isteği, 27 Kasım 2026: "exe olarak kurulu bilgisayarda ve bu tamamen bir program olacak
 * şekilde yap; exe ve siteden de isteyen aynı şekilde kurup çalıştırabilmeli"):
 * - kasa kısayolu konsolsuz kasa programını açar (kasa-yazici.ps1 -Ac): tek pencere (ikinci tıklama öne getirir), açılış
 *   penceresi, sunucu beklenir; Edge InPrivate değil; bekçi diskteki betik değişince kendini yeniler;
 * - kurulum dosyası (asilpos.nsi) ve siteden kurulum (web-kurucu.ps1) aynı programı kurar: kısayollar tek listeden aynı
 *   betikle (kurulum-yenile.mjs kisayollar), gün açıksa sorulur, yeni sürüm yan klasörden yer değiştirir, sunucunun yeni
 *   sürümle açıldığı beklenir.
 * Gerçek Windows'ta kurulum, önceki sürümden güncelleme ve kasa penceresi CI'da (ci-kurulum.mjs).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const K = 'scripts/kasa/windows/kurulum/';
const load = (f: string) => import(/* @vite-ignore */ new URL(`${K}${f}`, root).href) as Promise<Mod>;
const read = (p: string) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  expect(i, a).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(b, i + a.length);
  expect(j, b).toBeGreaterThan(i);
  return s.slice(i, j);
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('kasa programı: kasa-yazici.ps1 -Ac', () => {
  const ps1 = read(`${K}kasa-yazici.ps1`);
  const ac = between(ps1, 'if ($Ac) {', '# Kipsiz:');

  it('kasa kısayolları konsolsuz programı açar (bat ve görev çubuğundaki konsol yok); adlar aynı', async () => {
    const { shortcutSpec, KASA_MODE } = await load('kurulum-yenile.mjs');
    const kur = `C:\\Program Files\\${KURULUM_KLASORU}`;
    const spec = shortcutSpec(kur, 'C:\\Windows');
    const kasa = spec.filter((k: any) => k.ad.endsWith('AsilPOS Kasa.lnk'));
    expect(kasa.map((k: any) => k.klasor)).toEqual(['CommonPrograms', 'CommonDesktopDirectory', 'CommonStartup']);
    for (const k of kasa) {
      expect(k.hedef).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(k.arguman).toBe(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${kur}\\app\\kasa-yazici.ps1" ${KASA_MODE}`);
      expect(k.dosya).toBe(`${kur}\\app\\kasa-yazici.ps1`);
      expect(k.pencere).toBe(7);
      expect(k.ikon).toBe(`${kur}\\asilpos.ico,0`);
      // Çalışma klasörü kurulum klasörü: app\ güncellemede taşınır, içinde duran süreç taşımayı engellerdi
      expect(k.calismaKlasoru).toBe(kur);
    }
    expect(JSON.stringify(spec)).not.toContain('AsilPOS-Kasa.bat');
    expect(ps1).toContain('[switch]$Ac)');
  });

  it('tek pencere: açıksa öne getirir (küçültülmüşse açar); ikinci tıklama beklemez', () => {
    expect(ac).toContain("Mutex($false, 'Local\\AsilPOS-KasaAcilis')");
    // Öne getirme her şeyden önce; kilidi alamayan ikinci açılış hemen çıkar
    const one = ac.indexOf('if ($acik) { Show-KasaWindow $acik }');
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(ac.indexOf('if (-not $acilisBende) { exit 0 }'));
    const show = between(ps1, 'function Show-KasaWindow', 'function Test-KasaBakim');
    for (const t of ['SetForegroundWindow', 'IsIconic($h)) { [void][AsilPos.Pencere]::ShowWindowAsync($h, 9) }', 'MainWindowHandle']) expect(show, t).toContain(t);
    // Kasa kısayolunun eski yolu da öne getirir; bekçi getirmez (arka planda pencere öne fırlamaz)
    expect(between(ps1, 'if ($KasaAc) {', 'if ($Bekci) {')).toContain('Open-KasaWindow $false $true');
    expect(between(ps1, 'if ($Bekci) {', 'if ($Ac) {')).toContain('Open-KasaWindow $true | Out-Null');
    const open = between(ps1, 'function Open-KasaWindow', 'function Remove-TemporaryKasaWatcher');
    expect(open).toContain('if ($OneGetir) { Show-KasaWindow $acik }');
    expect(open).toContain('[bool]$OneGetir = $false');
  });

  it('sıra: tarayıcı denetimi, açılış penceresi, bekçi, sunucu (90 sn), yazıcılar ve müşteri ekranı, kasa penceresi', () => {
    const order = [
      "Show-Message (Tr 'Chrome ya da Edge bulunamad{i}.",
      'if (-not $acik) { $splash = Start-Splash }',
      'Start-WatcherIfNeeded',
      'if (-not $acik) { $hazir = Wait-Server $displayBase 90 }',
      'Send-Printers $displayBase',
      'Start-CustomerDisplay $displayBase',
      'if (-not $acik -and $hazir) { Open-KasaWindow $false $true | Out-Null }',
      'Stop-Splash $splash',
      'Add-PrepShortcut',
    ];
    const at = order.map((t) => ac.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Açılış penceresi her durumda kapanır; sunucu 90 sn'de gelmezse pencere açılmaz (bekçi açar), hata sayfası kalmaz
    expect(ac.slice(ac.indexOf('} finally {'))).toContain('Stop-Splash $splash');
    // Yazıcı adımı işlev oldu: içinde script'i bitiren exit yok
    expect(between(ps1, 'function Send-Printers', '# Sunucu IPv4 dinler')).not.toMatch(/\bexit\b/);
  });

  it('açılış penceresi kendi iş parçacığında (bekleme onu dondurmaz), Türkçe metin ASCII dosyada', () => {
    const splash = between(ps1, 'function Start-Splash', 'function Stop-Splash');
    expect(splash).toContain("$rs.ApartmentState = 'STA'");
    expect(splash).toContain('$ps.BeginInvoke()');
    expect(splash).toContain('[System.Windows.Forms.Application]::Run($f)');
    expect(splash).toContain('if ($durum.kapat) { $f.Close() }');
    expect(splash).toContain("Join-Path $KurulumKlasoru 'asilpos.ico'");
    expect(splash).toMatch(/catch \{\s+return \$null\s+\}/);
    // Tr: yer tutucular Türkçe harfe döner (ç, ğ, ı, ö, ş, ü)
    const tr = (s: string) => s.replaceAll('{c}', 'ç').replaceAll('{g}', 'ğ').replaceAll('{i}', 'ı').replaceAll('{o}', 'ö').replaceAll('{s}', 'ş').replaceAll('{u}', 'ü');
    expect(between(ps1, 'function Tr(', 'function Show-Message')).toContain("@(@('{c}', 0x00E7), @('{g}', 0x011F), @('{i}', 0x0131), @('{o}', 0x00F6), @('{s}', 0x015F), @('{u}', 0x00FC))");
    expect(tr('AsilPOS a{c}{i}l{i}yor')).toBe('AsilPOS açılıyor');
    expect(/^[\x00-\x7f]*$/.test(readFileSync(new URL(`${K}kasa-yazici.ps1`, root), 'latin1'))).toBe(true);
  });

  it('tarayıcı ve bekçi kurulum klasöründe çalışır (app\\ güncellemede taşınabilir)', () => {
    expect(ps1).toContain('$KurulumKlasoru = Split-Path -Parent $PSScriptRoot');
    const starts = ps1.match(/Start-Process -FilePath \$exe [^\n]*/g) ?? [];
    expect(starts.length).toBe(2);
    for (const s of starts) expect(s).toContain('-WorkingDirectory $KurulumKlasoru');
    expect(between(ps1, 'function Start-WatcherProcess', 'function Start-WatcherIfNeeded')).toContain('-WorkingDirectory $KurulumKlasoru');
  });

  it('Edge kalıcı profille tam ekran (InPrivate değil); ASILPOS_TARAYICI=edge Edge\'i seçer', () => {
    const exe = between(ps1, 'function Get-DisplayExe', 'function Clear-BrowserCache');
    expect(exe).toContain("if ($env:ASILPOS_TARAYICI -eq 'edge') { $candidates = $edge + $chrome }");
    // Chrome önce (kafede önerilen); Edge yalnız yoksa ya da seçilirse
    expect(exe).toContain('$candidates = $chrome + $edge');
    // Eski bekçi pencereyi profil klasöründen tanır: profil adları değişmedi
    expect(ps1).toContain(`$kasaProfil = Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}\\edge'`);
    expect(ps1).toContain(`'\\\\${ESKI_URUN_ADI}\\\\(chrome|edge)(?![\\w-])'`);
  });

  it('bekçi kendini yeniler: diskteki betik değişince kilidi bırakıp yenisini açar; eski sürüm betiğe dönmez', async () => {
    const loop = between(ps1, 'if ($Bekci) {', 'if ($Ac) {');
    expect(loop).toContain('$ilkOzet = Get-ScriptHash $PSCommandPath');
    const yenile = loop.slice(loop.indexOf('$ozet = Get-ScriptHash $PSCommandPath'));
    const rel = yenile.indexOf('$tek.ReleaseMutex()');
    const start = yenile.indexOf('Start-WatcherProcess $yeniSurum');
    expect(rel).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(rel);
    expect(yenile.indexOf('exit 0')).toBeGreaterThan(start);
    expect(yenile).toContain('if ($yeniSurum -ge 5) {');
    // Betik silme paylaşımıyla okunur: güncelleme o an app\ klasörünü taşıyabilsin
    expect(between(ps1, 'function Read-ScriptBytes', 'function Get-ScriptHash')).toContain('[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete');
    expect(between(ps1, 'function Get-ScriptVersion', 'function Start-WatcherProcess')).toContain("'(?m)^\\$BekciSurumu = (\\d+)'");
    // Sürüm okuma kalıbı betiğin kendi satırını bulur
    const m = /\(\?m\)\^\\\$BekciSurumu = \(\\d\+\)/.test(ps1);
    expect(m).toBe(true);
    const { WATCHER_VERSION } = await load('kurulum-yenile.mjs');
    expect(new RegExp('^\\$BekciSurumu = (\\d+)', 'm').exec(ps1)?.[1]).toBe(String(WATCHER_VERSION));
    expect(WATCHER_VERSION).toBe(5);
  });
});

describe('kurulumlar aynı programı kurar: tek kısayol listesi', () => {
  /** kurulum-yenile.mjs'in pakettekine benzer kopyası (doğrudan çalıştırma) */
  function copyCli() {
    const d = mkdtempSync(join(tmpdir(), 'asilpos-cli-'));
    dirs.push(d);
    copyFileSync(new URL(`${K}kurulum-yenile.mjs`, root), join(d, 'kurulum-yenile.mjs'));
    return join(d, 'kurulum-yenile.mjs');
  }

  it('komut satırı: seçilen grupların listesi güncellemenin listesiyle aynı; bilinmeyen grup reddedilir', async () => {
    const { shortcutSpec } = await load('kurulum-yenile.mjs');
    const cli = copyCli();
    const kur = `C:\\Program Files\\${KURULUM_KLASORU}`;
    const list = (g: string) => JSON.parse(execFileSync(process.execPath, [cli, 'kisayollar', '--gruplar', g, '--yalniz-liste', '--kurulum', kur], { encoding: 'utf8', env: { ...process.env, SystemRoot: 'C:\\Windows' } }));
    const all = shortcutSpec(kur, 'C:\\Windows');
    expect(list('masaustu,baslangic')).toEqual(all);
    expect(list('')).toEqual(all.filter((k: any) => !k.grup));
    expect(list(',masaustu').map((k: any) => k.ad)).toEqual(all.filter((k: any) => k.grup !== 'baslangic').map((k: any) => k.ad));
    const bad = spawnSync(process.execPath, [cli, 'kisayollar', '--gruplar', 'masaustu,x', '--yalniz-liste'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('bilinmeyen kısayol grubu: x');
  });

  it('kurulumun kısayol adımı listeyi -Kur ve seçili gruplarla kisayollar.ps1\'e verir; Uygulamalar kaydına dokunmaz', async () => {
    const { installShortcuts, shortcutSpec } = await load('kurulum-yenile.mjs');
    const calls: { exe: string; args: string[]; list: any }[] = [];
    let out = '';
    const run = async (exe: string, args: string[]) => {
      calls.push({ exe, args, list: JSON.parse(readFileSync(args[args.indexOf('-Liste') + 1]!, 'utf8')) });
      return { code: out ? 2 : 0, out };
    };
    const o = { appDir: 'C:\\K\\app', installDir: 'C:\\K', groups: ['masaustu'], systemRoot: 'C:\\Windows', run };
    expect(await installShortcuts(o)).toBeNull();
    const c = calls[0]!;
    expect(c.exe).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(c.args.slice(c.args.indexOf('-Kur'))).toEqual(['-Kur', '-Gruplar', 'masaustu']);
    expect(c.args).not.toContain('-Kayit');
    expect(c.args).not.toContain('-EskiMenu');
    expect(c.list).toEqual(shortcutSpec('C:\\K', 'C:\\Windows'));
    // Liste dosyası silinir; betiğin HATA satırları sonuca geçer
    expect(existsSync(c.args[c.args.indexOf('-Liste') + 1]!)).toBe(false);
    out = 'HATA 8: Erişim engellendi\r\n';
    expect(await installShortcuts(o)).toBe('HATA 8: Erişim engellendi');
  });

  it('kisayollar.ps1: kurulumda grup seçimi, güncellemede koşul; .url ve çalıştırılan dosyanın denetimi', () => {
    const ps = read(`${K}kisayollar.ps1`);
    expect(ps).toContain("[switch]$Kur, [string]$Gruplar = ''");
    const dongu = between(ps, 'foreach ($k in $items)', '$s = $sh.CreateShortcut($yol)');
    const kur = dongu.indexOf('if ($Kur) {');
    const kosul = dongu.indexOf('} elseif ($k.kosul) {');
    expect(kur).toBeGreaterThan(0);
    expect(kosul).toBeGreaterThan(kur);
    expect(dongu).toContain('if ($k.grup -and -not ($secili -contains [string]$k.grup)) { continue }');
    expect(dongu).toContain("Set-Content -LiteralPath $yol -Value @('[InternetShortcut]', ('URL=' + [string]$k.url), ('IconFile=' + [string]$k.ikonDosyasi), 'IconIndex=0') -Encoding ASCII");
    expect(dongu).toContain("if ($k.dosya -and -not (Test-Path -LiteralPath ([string]$k.dosya))) { throw ('dosya yok: ' + $k.dosya) }");
    expect(/^[\x00-\x7f]*$/.test(readFileSync(new URL(`${K}kisayollar.ps1`, root), 'latin1'))).toBe(true);
  });

  it('kurulum dosyası kısayolları elle yazmaz: seçilen grupları sondaki bölümde aynı komuta verir', () => {
    const nsi = read(`${K}asilpos.nsi`);
    // Yalnız kuruluma özgü kaldırma kısayolu elle; kasa, menü, masaüstü ve Başlangıç listeden
    expect((nsi.match(/CreateShortcut /g) ?? []).length).toBe(1);
    expect(nsi).toContain('CreateShortcut "$SMPROGRAMS\\AsilPOS\\AsilPOS\'u kaldır.lnk" "$INSTDIR\\Kaldir.exe"');
    expect(nsi).not.toContain('WriteINIStr');
    expect(between(nsi, 'Section "Masaüstüne kısayol" SecDesktop', 'SectionEnd')).toContain('StrCpy $GRUPLAR "$GRUPLAR,masaustu"');
    expect(between(nsi, 'Section "Oturum açılınca kasa ekranını aç" SecStartup', 'SectionEnd')).toContain('StrCpy $GRUPLAR "$GRUPLAR,baslangic"');
    // Kısayol bölümü seçimlerden (ve güç ayarından) sonra; kısayollar sunucudan önce
    const son = between(nsi, 'Section "-Kisayollar ve sunucu" SecSon', 'SectionEnd');
    expect(nsi.indexOf('Section "-Kisayollar ve sunucu" SecSon')).toBeGreaterThan(nsi.indexOf('Section "Prizdeyken uyku kapalı" SecPower'));
    expect(son.indexOf('kurulum-yenile.mjs" kisayollar --gruplar "$GRUPLAR"')).toBeLessThan(son.indexOf('/Run /TN'));
    // Siteden kurulum aynı komutu iki grupla
    const web = read(`${K}web-kurucu.ps1`);
    expect(web).toContain("Calistir (Join-Path $Kur 'node\\node.exe') @((Join-Path $Kur 'app\\kurulum-yenile.mjs'), 'kisayollar', '--gruplar', 'masaustu,baslangic')");
    expect(web).not.toMatch(/Kisayol \(Join-Path \$(menu|masaustu|baslangic) 'AsilPOS Kasa/);
    expect(web).not.toContain('[InternetShortcut]');
  });

  it('kurulum dosyası da gün açıksa sorar (sessizde kurmaz), yan klasörden yer değiştirir, yeni sürümün açılmasını bekler', () => {
    const nsi = read(`${K}asilpos.nsi`);
    const main = between(nsi, 'Section "AsilPOS sunucusu ve kasa ekranı" SecMain', 'SectionEnd');
    const gun = main.indexOf('/api/kasa/guncelleme-durumu');
    expect(gun).toBeGreaterThan(0);
    expect(main).toContain('/SD IDNO IDYES gun_devam');
    // Önce yan klasöre açılır, sonra sunucu durur, yedek, yer değiştirme; olmazsa eskisi döner
    const ac = main.indexOf('File /r "${STAGE}${SEP}yuk${SEP}*"');
    const dur = main.indexOf('/End /TN');
    const yedek = main.indexOf('CopyFiles /SILENT "$DATA\\');
    const tasi = main.indexOf('!insertmacro Tasi "$INSTDIR\\app" "$INSTDIR\\app.eski"');
    expect(gun).toBeLessThan(ac);
    expect(ac).toBeLessThan(dur);
    expect(dur).toBeLessThan(yedek);
    expect(yedek).toBeLessThan(tasi);
    expect(main).toContain('SetOutPath "$INSTDIR\\kurulum.gecici"');
    expect(main).toContain('!insertmacro Tasi "$INSTDIR\\kurulum.gecici\\app" "$INSTDIR\\app"');
    expect(main).toContain('!insertmacro Tasi "$INSTDIR\\kurulum.gecici\\node" "$INSTDIR\\node"');
    expect(main.slice(main.indexOf('${If} $R8 != 0'))).toMatch(/Call RollbackFiles[\s\S]*Call RestoreServer[\s\S]*Abort/);
    // Sunucu yeni durdu: yer değiştirme 10 sn'ye kadar yeniden denenir
    const tasiMakro = between(nsi, '!macro Tasi FROM TO', '!macroend');
    expect(tasiMakro).toContain('${If} $R7 >= 10');
    expect(tasiMakro).toContain('Sleep 1000');
    const geri = between(nsi, 'Function RollbackFiles', 'FunctionEnd');
    expect(geri).toContain('Rename "$INSTDIR\\app.eski" "$INSTDIR\\app"');
    expect(geri).toContain('Rename "$INSTDIR\\node.eski" "$INSTDIR\\node"');
    // Eski düzen (önce sil, sonra aç) yok: yarıda kalan kurulum uygulamasız bırakmaz
    expect(main).not.toContain('RMDir /r "$INSTDIR\\app"\n');
    expect(main).toContain('File "${STAGE}${SEP}kok${SEP}*"');
    // Yeni sürüm: sağlık ucu bu derlemeyi söyleyene dek (en çok 2 dk)
    const son = between(nsi, 'Section "-Kisayollar ve sunucu" SecSon', 'SectionEnd');
    expect(son).toContain('/api/health).build -eq ${BUILD}');
    expect(nsi).toContain('!ifndef BUILD');
    expect(read(`${K}derle.mjs`)).toContain('`-DBUILD=${BUILD.build}`');
  });

  it('paket iki klasör: yan klasöre açılan yük ve kök dosyalar; paket denemesi kısayol listesini pakette çalıştırır', () => {
    const derle = read(`${K}derle.mjs`);
    expect(derle).toContain("const YUK = join(STAGE, 'yuk');");
    expect(derle).toContain("const KOK = join(STAGE, 'kok');");
    expect(derle).toContain("const APP = join(YUK, 'app');");
    expect(derle).toContain("join(tmp, 'app/kurulum-yenile.mjs'), 'kisayollar', '--gruplar', 'masaustu,baslangic', '--yalniz-liste'");
    const nsi = read(`${K}asilpos.nsi`);
    expect(nsi).toContain('!define MUI_ICON "${STAGE}${SEP}kok${SEP}asilpos.ico"');
  });

  it('iki kaldırıcı da kasa penceresini ve bekçiyi kapatır (boş tam ekran ve bekçi kalmaz); kendini kapatmaz', () => {
    const nsi = between(read(`${K}asilpos.nsi`), 'Section "Uninstall"', 'SectionEnd');
    const web = read(`${K}web-kaldir.ps1`);
    for (const t of [nsi.replaceAll('$$', '$'), web]) {
      expect(t).toContain(`$_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -match 'kasa-yazici\\.ps1' -or $_.CommandLine -match '\\\\${ESKI_URUN_ADI}\\\\(chrome|edge)')`);
      expect(t).toContain('Stop-Process -Id $_.ProcessId -Force');
    }
    expect(nsi).toContain('RMDir /r "$INSTDIR\\kurulum.gecici"');
  });

  it('siteden kurulumun CI anahtarları yalnız bu bilgisayardaki kanalı kabul eder; sessizde soru sorulmaz', () => {
    const web = read(`${K}web-kurucu.ps1`);
    const line = /^if \(\[string\]\$env:ASILPOS_KUR_KANAL -match '([^']+)'\)/m.exec(web)![1]!;
    const re = new RegExp(line);
    expect(re.test('http://127.0.0.1:8765/guncelleme/')).toBe(true);
    for (const kotu of ['https://ornek.com/guncelleme/', 'http://127.0.0.1.ornek.com:80/g/', 'http://10.0.0.5:8765/guncelleme/', 'http://127.0.0.1:8765/guncelleme']) expect(re.test(kotu), kotu).toBe(false);
    expect(web).toContain("$Sessiz = ([string]$env:ASILPOS_KUR_SESSIZ -eq '1')");
    expect(between(web, 'function Bekle {', '}')).toContain('if ($Sessiz) { return');
    expect(web).toContain("if (-not $Sessiz) { $cevap = Read-Host 'Yine de şimdi kurulsun mu? (E/H)' }");
    // Gün açıkken sessiz kurulum kurmaz (cevap Hayır)
    expect(web).toContain("$cevap = 'H'");
  });
});

describe('tablet ve telefon: ana ekrana ekleme (kiosku bozmadan)', () => {
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const base = { standalone: false, kasaPc: false, hasPrompt: false, touchPoints: 0, secure: false };

  it('yol cihaza göre: yükleme penceresi, Safari Paylaş, http\'deki Android menüsü; kasa bilgisayarında ve eklenmişte yok', async () => {
    const { installWay } = await import('../src/lib/pwa-yol');
    expect(installWay({ ...base, ua: android, hasPrompt: true, secure: true })).toBe('prompt');
    expect(installWay({ ...base, ua: windows, hasPrompt: true, secure: true })).toBe('prompt');
    expect(installWay({ ...base, ua: iphone })).toBe('ios');
    // iPadOS masaüstü kimliğiyle gelir: dokunma noktasından tanınır
    expect(installWay({ ...base, ua: ipad, touchPoints: 5 })).toBe('ios');
    expect(installWay({ ...base, ua: ipad, touchPoints: 0 })).toBeNull();
    expect(installWay({ ...base, ua: iphoneChrome })).toBeNull();
    // Kafenin ağındaki http adresi: tam yükleme yok, menüden kısayol
    expect(installWay({ ...base, ua: android })).toBe('android');
    expect(installWay({ ...base, ua: android, secure: true })).toBeNull();
    // Kasa bilgisayarı (sunucunun kendisi) ve zaten ana ekrandan açılmış uygulama
    expect(installWay({ ...base, ua: windows, hasPrompt: true, secure: true, kasaPc: true })).toBeNull();
    expect(installWay({ ...base, ua: iphone, standalone: true })).toBeNull();
    const { isLoopbackHost } = await import('../src/lib/pwa-yol');
    for (const h of ['localhost', '127.0.0.1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['192.168.1.20', 'kasa.local', ALAN_ADI]) expect(isLoopbackHost(h), h).toBe(false);
  });

  it('manifest uygulamanın kimliği ve kapsamıyla; simgeler var; sayfalar önbelleğe alınmaz (eklenen uygulama da güncel açılır)', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    expect(m).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', short_name: 'AsilPOS' });
    const sizes = m.icons.map((i: any) => i.sizes);
    for (const s of ['192x192', '512x512']) expect(sizes, s).toContain(s);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const i of m.icons) expect(existsSync(new URL(`public${i.src}`, root)), i.src).toBe(true);
    // Hizmet çalışanı yalnız bildirim: getirme işleyicisi yok, sayfa saklanmaz
    const sw = read('public/sw.js');
    expect(sw).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(sw).not.toMatch(/caches\./);
  });

  it('görev çubuğu simgesi: bit eşlem simge ve PNG bağlantıları (kasa programının penceresi), SVG sekmede', () => {
    const html = read('index.html');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png" />');
    expect(html.indexOf('/favicon.ico')).toBeLessThan(html.indexOf('/favicon.svg'));
    expect(html).toContain('<title>AsilPOS</title>');
    const ico = readFileSync(new URL('public/favicon.ico', root));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const n = ico.readUInt16LE(4);
    expect([...Array(n)].map((_, i) => ico[6 + i * 16])).toEqual([16, 32, 48]);
  });

  it('kullanıcı menüsünde yalnız yol varken; olay ilk iş yakalanır, kasa bilgisayarında saklanmaz', () => {
    const shell = read('src/components/AppShell.tsx');
    expect(shell).toContain('{installOffer && !DEMO && (');
    expect(shell).toContain('<DrawerLabel hint={installOffer.hint}>Ana ekrana ekle</DrawerLabel>');
    expect(read('src/main.tsx')).toContain('listenInstallPrompt();');
    const pwa = read('src/lib/pwa.ts');
    expect(pwa).toContain('e.preventDefault();');
    expect(pwa).toContain('if (!isLoopbackHost(window.location.hostname)) usePrompt.setState(');
  });
});

describe('Windows CI: önceki sürümden güncelleme ve kasa penceresi (ci-kurulum.mjs)', () => {
  it('vekil eski sunucuyu taklit eder, sayfaya gösterilen derlemeyi bildiren betiği ekler; API\'ye dokunmaz', async () => {
    const { createServer } = await import('node:http');
    const { startProxy, mainScript, eskiBasliklar, INJECT } = await load('ci-vekil.mjs');
    const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AbC12345.js"></script><title>AsilPOS</title></head><body><div id="root"></div></body></html>';
    expect(mainScript(html)).toBe('/assets/index-AbC12345.js');
    expect(eskiBasliklar({ 'cache-control': 'no-store', etag: 'x' }, Date.UTC(2026, 10, 27))).toEqual({ etag: 'x', 'last-modified': new Date(Date.UTC(2026, 9, 28)).toUTCString() });
    const up = createServer((req, res) => {
      if (req.url === '/api/health') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"ok":true}');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(html)) }).end(html);
    });
    await new Promise<void>((ok) => up.listen(0, '127.0.0.1', () => ok()));
    const v = await startProxy({ port: 0, upstreamPort: (up.address() as { port: number }).port });
    const base = `http://127.0.0.1:${v.port}`;
    try {
      // Eski kip: arayüz sayfası önbellek başlıksız, eski Last-Modified'la (Chrome saklar); sayfaya betik eklenir
      const doc = await fetch(`${base}/`, { headers: { 'sec-fetch-dest': 'document' } });
      const body = await doc.text();
      expect(doc.headers.get('cache-control')).toBeNull();
      expect(Date.parse(doc.headers.get('last-modified')!)).toBeLessThan(Date.now() - 29 * 86_400_000);
      expect(body).toContain(`${INJECT}</body>`);
      expect(Number(doc.headers.get('content-length'))).toBe(Buffer.byteLength(body));
      // API'ye dokunulmaz; sayfanın kendi denetimi (fetch) betiksiz
      expect((await fetch(`${base}/api/health`)).headers.get('cache-control')).toBe('no-store');
      expect(await (await fetch(`${base}/`)).text()).toBe(html);
      // Gerçek kip: başlıklar olduğu gibi
      v.mode = 'gercek';
      expect((await fetch(`${base}/`, { headers: { 'sec-fetch-dest': 'document' } })).headers.get('cache-control')).toBe('no-store');
      // Sayfanın bildirimi
      await fetch(`${base}/__ci/sayfa?script=%2Fassets%2Findex-AbC12345.js&depo=1&baslik=AsilPOS`, { method: 'POST' });
      const sayfa = v.log.find((e: any) => e.tur === 'sayfa');
      expect(sayfa).toMatchObject({ script: '/assets/index-AbC12345.js', depo: '1', baslik: 'AsilPOS' });
      const docs = v.log.filter((e: any) => e.tur === 'istek' && e.dest === 'document');
      expect(docs.map((e: any) => [e.mode, e.cc, e.script])).toEqual([
        ['eski', null, '/assets/index-AbC12345.js'],
        ['gercek', 'no-store', '/assets/index-AbC12345.js'],
      ]);
    } finally {
      await v.close();
      up.close();
    }
    // Eklenen betik sayfanın ana betiğini, başlığı ve yerel deponun kalıcılığını bildirir
    for (const t of ["querySelector('script[type=\"module\"][src]')", "localStorage.getItem(k)", "'/__ci/sayfa?'", 'document.title']) expect(INJECT, t).toContain(t);
  });

  it('kafedeki yolu yürür: önceki sürüm, kısayolla pencere, güncelleme, ilk açılış yeni sürüm, program, geri dönüş, kaldırma, iki kurulum', () => {
    const ci = read(`${K}ci-kurulum.mjs`);
    const order = [
      'kur(ONCEKI_EXE);',
      'vekil = await startProxy(',
      'kasaAc();',
      "waitSayfa(tB, (s) => s.script === sOnceki",
      'kanal(b1, b1);',
      "vekil.mode = 'gercek';",
      "waitSayfa(tB, (s) => s.script === sYeni, 'açık kasa penceresi yeni sürüme geçmedi'",
      "checkLinks(ps('kisayollar'), 'güncellemeden sonra')",
      "ps('kapat');",
      "if (d3.script !== sYeni) fail(",
      "e.dest === 'document' && e.status === 200",
      "const kasaD4 = kasaSurecleri();",
      "'bekçi kapanan kasa penceresini açmadı'",
      "kasaAc({ ASILPOS_TARAYICI: 'edge' });",
      "republish(m1n, b2,",
      "vekil.mode = 'eski';\nawait bakim(true);",
      'kanal(b3, b3);',
      "'bekçi kendini yenilemedi (diskteki yeni betikle)'",
      "if (sabah.script !== s3) fail(",
      "checkUninstalled('önceki sürümün kaldırıcısı');",
      'kur(BU_EXE);',
      "'elle güncellemeden sonra sunucu açılmadı'",
      "checkUninstalled('bu sürümün kaldırıcısı');",
      "ASILPOS_KUR_SESSIZ: '1'",
      'compareInstalls(exeDurum, webDurum);',
    ];
    const at = order.map((t) => ci.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(order.filter((_, i) => at[i]! <= 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Kasa penceresi kısayolun kendisiyle açılır (hedefi ve argümanları), vekilden bağlanır
    expect(ci).toContain("ps('ac', ['-Kisayol', KASA_KISAYOLU], { ASILPOS_URL: VEKIL, ...env })");
    const helper = read(`${K}ci-windows.ps1`);
    expect(helper).toContain('$l = $sh.CreateShortcut($Kisayol)');
    expect(helper).toContain('-ArgumentList $l.Arguments -WorkingDirectory $wd');
    // Kanal derlemesinin işareti ana betiği değiştirir (yeni sürüm penceredeki betikten ayırt edilir); gerçek derlemede yok
    expect(ci).toContain('env.VITE_ASILPOS_CI_DERLEME = String(isaret)');
    expect(read('src/main.tsx')).toContain('if (import.meta.env.VITE_ASILPOS_CI_DERLEME)');
    expect(read('scripts/kasa/windows/kurulum/kanal.mjs')).not.toContain('VITE_ASILPOS_CI_DERLEME');
    expect(/^[\x00-\x7f]*$/.test(readFileSync(new URL(`${K}ci-windows.ps1`, root), 'latin1'))).toBe(true);
  });

  it('iş akışı kafedeki sürümü (GitHub\'daki son kurulum dosyası) indirir, denemeyi koşar, ekran görüntülerini yükler', () => {
    const wf = read('.github/workflows/windows.yml');
    const indir = wf.indexOf('gh release download --pattern AsilPOS-Kurulum.exe --dir dist/onceki');
    const kos = wf.indexOf('node scripts/kasa/windows/kurulum/ci-kurulum.mjs');
    const yayim = wf.indexOf('gh release create');
    expect(indir).toBeGreaterThan(0);
    expect(kos).toBeGreaterThan(indir);
    // Kurulamayan ya da güncellenemeyen dosya yayımlanmaz
    expect(yayim).toBeGreaterThan(kos);
    expect(wf).toContain('path: dist/ci-ekran');
    expect(wf).toContain('if: always()');
    // Arayüzün ilk açılışını etkileyen dosyalar da Windows denetimini koşturur
    for (const p of ["- 'index.html'", "- 'public/**'", "- 'src/lib/buildWatch.ts'", "- 'src/main.tsx'"]) expect(wf, p).toContain(p);
  });
});
