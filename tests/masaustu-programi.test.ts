import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ESKI_URUN_ADI, KURULUM_KLASORU } from '@shared/eski-adlar';

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

