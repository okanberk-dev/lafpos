import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALAN_ADI, ESKI_URUN_ADI, KURULUM_KLASORU, SUNUCU_GOREVI } from '@shared/eski-adlar';

/**
 * Masaüstü programı (sahibin isteği, 27 Kasım 2026: "exe olarak kurulu bilgisayarda ve bu tamamen bir program olacak
 * şekilde yap; exe ve siteden de isteyen aynı şekilde kurup çalıştırabilmeli"):
 * - kasa kısayolu konsolsuz kasa programını açar (kasa-yazici.ps1 -Ac): tek pencere (ikinci tıklama öne getirir), açılış
 *   penceresi, sunucu beklenir; Edge InPrivate değil; bekçi diskteki betik değişince kendini yeniler;
 * - 28 Kasım 2026 ("PC'yi doğrudan AsilPOS'a geçir, estetikleştir, hızlandır"): tam ekran markalı açılış penceresi, kasa
 *   penceresi yazıcılardan önce, derlemesiz Win32 çağrıları, önbellek yalnız derleme değişince silinir, kasa programının
 *   günlüğü, çöken pencere geri gelir (kullanıcının kapattığı gelmez);
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

  it('güncelleme eski bat çalışırken yenisini yazarsa cmd kaldığı bayttan etikete düşer ve programı açar', async () => {
    // cmd toplu dosyayı her komuttan sonra kaydettiği bayttan yeniden okur; sunucu bekçisi kök dosyaları her açılışta
    // yeniler (kurulum-yenile.mjs syncRootFiles). 27 Kasım öncesinin AsilPOS-Kasa.bat'ı uzun süren üç komuttan sonra
    // sürer: sunucu bekleme (90 sn), kipsiz betik, -KasaAc. Kurulu hâli (CRLF) 881, 1243, 1575; LF'li kopyada 871, 1230,
    // 1559. Bayt aralığı ikisini ve sonraki set satırlarını kapsar. Kurulumun yazdığı baytlarla (web-kurucu.mjs shellFiles)
    const { shellFiles } = await load('web-kurucu.mjs');
    const bat = (shellFiles()['AsilPOS-Kasa.bat'] as Buffer).toString('latin1');
    const komut = (l: string) => l.trim() !== '' && !l.startsWith(':') && !/^rem /i.test(l);
    for (let o = 850; o <= 1720; o++) {
      const [ilk, ...sonra] = bat.slice(o).split(/\r?\n/);
      // Satırın kalanı boş ya da etiket: çalıştırılmaz (yarım bir komut ya da rem'in kuyruğu komut olurdu)
      expect(ilk === '' || ilk!.startsWith(':'), `${o}: ${ilk}`).toBe(true);
      const komutlar = sonra.filter(komut).slice(0, 3);
      expect(komutlar[0], String(o)).toBe('if not exist "%~dp0app\\kasa-yazici.ps1" goto eski');
      expect(komutlar[1], String(o)).toMatch(/^start "" \/min ".*powershell\.exe" .* -File "%~dp0app\\kasa-yazici\.ps1" -Ac$/);
      expect(komutlar[2], String(o)).toBe('exit /b 0');
    }
    // -Ac açık pencereyi öne getirir, ikincisini açmaz (eski yolun doğrudan Chrome'u ya da Edge'i açmaz)
    expect(ac).toContain('if ($acik) { Show-KasaWindow $acik }');
  });

  it('tek pencere: açıksa öne getirir (küçültülmüşse açar); ikinci tıklama beklemez', () => {
    expect(ac).toContain("Mutex($false, 'Local\\AsilPOS-KasaAcilis')");
    // Öne getirme her şeyden önce; kilidi alamayan ikinci açılış hemen çıkar
    const one = ac.indexOf('if ($acik) { Show-KasaWindow $acik }');
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(ac.indexOf('if (-not $acilisBende) { exit 0 }'));
    const show = between(ps1, 'function Show-KasaWindow', 'function Wait-KasaPenceresi');
    for (const t of ['SetForegroundWindow', 'if ($y::IsIconic($h)) { [void]$y::ShowWindowAsync($h, 9) }', 'MainWindowHandle']) expect(show, t).toContain(t);
    // Kasa kısayolunun eski yolu da öne getirir; bekçi getirmez (arka planda pencere öne fırlamaz)
    expect(between(ps1, 'if ($KasaAc) {', 'if ($Bekci) {')).toContain('Open-KasaWindow $false $true');
    // Bekçi pencereyi yalnız kısayolun isteğiyle açar; kullanıcının kapattığını açmaz, müşteri ekranını kapatır (28 Kas 2026)
    const bekci = between(ps1, 'if ($Bekci) {', 'if ($Ac) {');
    expect(bekci).toContain('(Test-KasaAcIstegi) -and -not (Test-KasaWindow)');
    expect(bekci).toContain('if (Open-KasaWindow $true) { Clear-KasaAcIstegi }');
    expect(bekci).toContain('} elseif ($kasaAcikti) {');
    expect(bekci).toContain('Stop-CustomerDisplay');
    expect(bekci).not.toContain('Open-KasaWindow $true | Out-Null');
    const open = between(ps1, 'function Open-KasaWindow', 'function Remove-TemporaryKasaWatcher');
    expect(open).toContain('if ($OneGetir) { Show-KasaWindow $acik }');
    expect(open).toContain('[bool]$OneGetir = $false');
  });

  it('sıra (28 Kas 2026): tarayıcı denetimi, açılış penceresi, sunucu (90 sn), kasa penceresi, müşteri ekranı, yazıcılar', () => {
    const order = [
      "Show-Message (Tr 'Chrome ya da Edge bulunamad{i}.",
      '$splash = Start-Splash',
      'Set-KasaAcIstegi',
      '$hazir = Test-Server $displayBase',
      '$hazir = Wait-Server $displayBase 90',
      'if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi }',
      '$kasa = Wait-KasaPenceresi 5',
      'Stop-Splash $splash',
      'if (-not $bekciBakildi) { Start-WatcherIfNeeded $psSurecleri',
      'if ((Start-CustomerDisplay $displayBase) -and $kasa) { Show-KasaWindow $kasa }',
      'Send-Printers $displayBase',
      'Stop-TemporaryDisplayWatcher $psSurecleri',
      'Remove-UserPrepShortcut',
    ];
    const at = order.map((t) => ac.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Açılış penceresi yalnız pencere kapalıyken; kasa penceresi açılınca (ekranda görününce) kapanır, her durumda kapanır
    expect(ac).toContain("if (-not $acik) {\n      $splash = Start-Splash");
    expect(ac.slice(ac.indexOf('} finally {'))).toMatch(/^\} finally \{\n\s+Stop-Splash \$splash\n\s+\}/);
    // Yazıcı sorgusu (15 sn'ye kadar) ve müşteri ekranı açılış penceresinin dışında, kasa penceresinden sonra
    const pencere = ac.slice(0, ac.indexOf('} finally {'));
    for (const t of ['Send-Printers', 'Start-CustomerDisplay']) expect(pencere, t).not.toContain(t);
    // Sunucu hazırsa bekçiye pencereden sonra bakılır; değilse bekleme başlamadan (sunucu geç gelirse pencereyi o açar)
    const soguk = between(ac, 'if (-not $hazir) {', '$hazir = Wait-Server $displayBase 90');
    expect(soguk).toContain('Start-WatcherIfNeeded');
    expect(soguk).toContain('$bekciBakildi = $true');
    // Sunucu 90 sn'de gelmezse pencere açılmaz (bekçi isteği yerine getirir), müşteri ekranı ve yazıcılar da beklenmez
    expect(ac).toContain('if ($hazir) {\n        if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi }');
    expect(between(ac, '# Kasa penceresinden sonra', 'Stop-TemporaryDisplayWatcher')).toMatch(/if \(\$hazir\) \{\n\s+if \(\(Start-CustomerDisplay/);
    // Yazıcı adımı işlev oldu: içinde script'i bitiren exit yok
    expect(between(ps1, 'function Send-Printers', '# Sunucu IPv4 dinler')).not.toMatch(/\bexit\b/);
  });

  it('eski kasa programı sorusu açılışta çıkmaz (sahibin isteği, 28 Kas 2026); kullanıcı menüsündeki ikinci "Kasa hazırlığı" silinir', async () => {
    // Kasa programı hazırlık betiğini hiç açmaz: haftalık tetik ve işaret dosyası yok, kısayol yazmaz
    for (const t of ['SadeceModpos', 'modpos-uyari', 'kasa-hazirla.ps1', 'Add-PrepShortcut']) expect(ps1, t).not.toContain(t);
    const sil = between(ps1, 'function Remove-UserPrepShortcut', '# Yazicilar:');
    expect(sil).toContain("foreach ($ad in @('AsilPOS', $EskiAd)) {");
    expect(sil).toContain("$lnk = Join-Path $menu 'Kasa hazirligi.lnk'");
    expect(sil).toContain('Remove-Item -LiteralPath $lnk -Force');
    // Menü klasörü yalnız boşaldıysa silinir; hata kasayı durdurmaz
    expect(sil).toContain('if (-not @(Get-ChildItem -LiteralPath $menu -Force).Count) { Remove-Item -LiteralPath $menu -Force }');
    expect(sil).toContain("} catch { Write-Hata 'eski hazirlik kisayolu' $_ }");
    expect(sil).not.toMatch(/CreateShortcut|Start-Process|\bexit\b/);
    // Kasa kısayolu (-Ac) ve 27 Kasım öncesinin kısayolu (kipsiz) eski kopyayı temizler
    expect(ac).toContain('Remove-UserPrepShortcut');
    expect(ps1.slice(ps1.indexOf('# Kipsiz:'))).toContain('Remove-UserPrepShortcut');
    // Ortak menüdeki "Kasa hazırlığı" kalır: koşulsuz, her kurulumda ve güncellemede yazılır
    const { shortcutSpec } = await load('kurulum-yenile.mjs');
    const kur = `C:\\Program Files\\${KURULUM_KLASORU}`;
    const hazirlik = shortcutSpec(kur, 'C:\\Windows').filter((k: any) => k.ad === 'AsilPOS\\Kasa hazırlığı.lnk');
    expect(hazirlik).toHaveLength(1);
    expect(hazirlik[0].klasor).toBe('CommonPrograms');
    expect(hazirlik[0].grup).toBeUndefined();
    expect(hazirlik[0].kosul).toBeUndefined();
    expect(hazirlik[0].arguman).toBe(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${kur}\\app\\kasa-hazirla.ps1"`);
  });

  it('kasa hazırlığı eski kasa programını sormaz; eski sürümün -SadeceModpos çağrısı hiçbir şey yapmadan çıkar', () => {
    const hazirla = read(`${K}kasa-hazirla.ps1`);
    // Anahtar kabul edilir (parametre bilinmiyor hatası yok) ve pencere, izin isteği ya da ayardan önce çıkılır
    expect(hazirla).toContain('param([switch]$SadeceModpos)');
    const cik = hazirla.indexOf('if ($SadeceModpos) { exit 0 }');
    expect(cik).toBeGreaterThan(hazirla.indexOf('param([switch]$SadeceModpos)'));
    for (const t of ['Add-Type', 'MessageBox', '-Verb RunAs', 'powercfg']) expect(cik, t).toBeLessThan(hazirla.indexOf(t));
    expect(hazirla.match(/\$SadeceModpos/g)).toHaveLength(2);
    for (const t of ['Get-ModposStartup', 'Uyar-Modpos', 'ms-settings:startupapps', 'gafdigi', 'CurrentVersion\\Run']) expect(hazirla, t).not.toContain(t);
    // Dört soru ve özet kalır
    expect(hazirla.match(/if \(Sor "/g)).toHaveLength(4);
    expect(hazirla).toContain('Bilgi ("Tamamlandi.');
    expect(/^[\x00-\x7f]*$/.test(readFileSync(new URL(`${K}kasa-hazirla.ps1`, root), 'latin1'))).toBe(true);
  });

  it('açılış penceresi kendi iş parçacığında (bekleme onu dondurmaz), Türkçe metin ASCII dosyada', () => {
    const splash = between(ps1, 'function Start-Splash', 'function Stop-Splash');
    expect(splash).toContain("$rs.ApartmentState = 'STA'");
    expect(splash).toContain('$ps.BeginInvoke()');
    expect(splash).toContain('[System.Windows.Forms.Application]::Run($f)');
    expect(splash).toContain('if ($durum.kapat) { $f.Close(); return }');
    expect(splash).toContain("Join-Path $KurulumKlasoru 'asilpos.ico'");
    expect(splash).toMatch(/catch \{\s+Write-Hata 'acilis penceresi' \$_\s+return \$null\s+\}/);
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
    expect(WATCHER_VERSION).toBe(7);
  });
});

/**
 * Daha hızlı ve markalı açılış, çöken pencere geri gelir (28 Kasım 2026, sahibin isteği: "PC'yi doğrudan AsilPOS'a geçir,
 * estetikleştir, hızlandır"). Betik yalnız Windows'ta çalışır: burada metni denetlenir, gerçek Windows'ta ci-kurulum.mjs
 * D3 (günlük, açılış penceresi), D5 (düzgün kapatılan açılmaz) ve D5b (çöken açılır) dener
 */
describe('kasa programı: hızlı ve markalı açılış, günlük, çöken pencere (28 Kas 2026)', () => {
  const ps1 = read(`${K}kasa-yazici.ps1`);
  const ac = between(ps1, 'if ($Ac) {', '# Kipsiz:');
  const bekci = between(ps1, 'if ($Bekci) {', 'if ($Ac) {');

  it('açılış penceresi tam ekran, ev yeşilinin degradesinde (DESIGN.md marka rayı), ortada simge ve "AsilPOS açılıyor"', () => {
    const splash = between(ps1, 'function Start-Splash', 'function Stop-Splash');
    for (const t of ['FormBorderStyle]::None', '$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds', 'LinearGradientMode]::Vertical', '$g.DrawImage($resim', "$f.Icon = New-Object System.Drawing.Icon($ikon)"]) expect(splash, t).toContain(t);
    // Renkler DESIGN.md'deki marka rayının üç durağı (#0B6449 → #095A42 → #074A37)
    const design = read('DESIGN.md');
    const ray = /\| Marka rayı \| `linear-gradient\(180deg, (#\w{6}) → (#\w{6}) → (#\w{6})\)`/.exec(design);
    expect(ray, 'DESIGN.md marka rayı').not.toBeNull();
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
    expect(splash).toContain(`[System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(${rgb(ray![1]!)}), [System.Drawing.Color]::FromArgb(${rgb(ray![2]!)}), [System.Drawing.Color]::FromArgb(${rgb(ray![3]!)}))`);
    // Metinler: Türkçe harfler yer tutucuyla; 20 sn'de sunucu gelmezse "Sunucu bekleniyor...", kapatma yolu yazılır
    expect(splash).toContain("(Tr 'AsilPOS a{c}{i}l{i}yor')");
    expect(splash).toContain("$rs.SessionStateProxy.SetVariable('bekleMetni', 'Sunucu bekleniyor...')");
    expect(splash).toContain("(Tr 'Kapatmak i{c}in Esc''ye bas{i}n ya da ekrana dokunun')");
    expect(splash).toContain('$bekle = (-not $durum.sunucu) -and (([DateTime]::Now - $basla).TotalSeconds -ge 20)');
    // Kasiyer kilitlenmez: Esc her an, dokunma 20 sn'den sonra kapatır; pencere en üstte zorlanmaz
    expect(splash).toContain('if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $durum.kullanici = $true; $f.Close() }');
    expect(splash).toContain('try { if ($durum.bekliyor) { $durum.kullanici = $true; $f.Close() } }');
    expect(splash).not.toContain('TopMost');
    // İş parçacığındaki her olay işleyicisi hatayı yakalar (WinForms'un hata kutusu çıkmaz), ileti günlüğe gider
    const isleyiciler = [...splash.matchAll(/\$\w+\.Add_(\w+)\(\{/g)].map((m) => m[1]);
    expect(isleyiciler).toEqual(['Paint', 'KeyDown', 'MouseDown', 'Shown', 'Tick']);
    for (const ad of isleyiciler) expect(between(splash, `.Add_${ad}({`, '})'), ad).toMatch(/try \{[\s\S]*\} catch \{ \$durum\.hata = /);
    const durdur = between(ps1, 'function Stop-Splash', 'function Wait-Server');
    expect(durdur).toContain("if ($s.durum.hata) { Write-Log ('acilis penceresi hatasi: ' + $s.durum.hata) }");
    expect(durdur).toContain("Write-Log ('acilis penceresi gorundu (' + $s.durum.gorundu + ' ms)')");
    // Sunucu hazır olunca açılış penceresine bildirilir (bekleme yazısı geri döner)
    expect(ac).toContain('if ($splash) { $splash.durum.sunucu = $hazir }');
  });

  it('Win32 işlevleri derlemesiz (Add-Type C# derlemesi yok): DPI, öne getirme', () => {
    expect(ps1).not.toMatch(/-MemberDefinition|-TypeDefinition|DllImport/);
    const kod = ps1.split('\n').filter((l) => !l.trim().startsWith('#'));
    const addType = kod.filter((l) => l.includes('Add-Type')).map((l) => l.trim());
    expect(addType.length).toBeGreaterThan(0);
    for (const l of addType) expect(l).toMatch(/^Add-Type -AssemblyName System\.(Windows\.Forms|Drawing)$/);
    const yerel = between(ps1, 'function Get-Yerel', '\ntry {');
    expect(yerel).toContain('DefinePInvokeMethod(');
    expect(yerel).toContain('[System.Reflection.MethodImplAttributes]::PreserveSig');
    expect(yerel).toContain('if ($script:YerelTip) { return $script:YerelTip }');
    for (const f of ['SetProcessDPIAware', 'SetForegroundWindow', 'ShowWindowAsync', 'IsIconic', 'keybd_event']) expect(yerel, f).toContain(`@('${f}', (`);
    // Süreç DPI'ya duyarlı, açılış penceresinden önce (pencere keskin, ikinci ekran gerçek pikselle)
    expect(ps1.indexOf('[void]$yerel::SetProcessDPIAware()')).toBeLessThan(ps1.indexOf('function Start-Splash'));
  });

  it('tarayıcı önbelleği her açılışta değil, kurulu derleme değişince silinir (profil başına son derleme dosyada)', () => {
    const derleme = between(ps1, 'function Get-KuruluDerleme', 'function Clear-BrowserCache');
    expect(derleme).toContain("Join-Path $PSScriptRoot 'package.json'");
    expect(derleme).toContain(`'"build"\\s*:\\s*(\\d+)'`);
    expect(ps1).toContain(`$OnbellekKaydi = Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}\\onbellek-derleme.txt'`);
    const temizle = between(ps1, 'function Clear-BrowserCache', 'function Get-TarayiciSurecleri');
    // Aynı derlemede silinmez; derleme yalnız önbellek gerçekten silindiyse yazılır (silinemezse sonra yeniden denenir)
    const atla = temizle.indexOf('if ($kayit[$ad] -eq $derleme) { return }');
    const sil = temizle.indexOf('Remove-Item -LiteralPath $cache -Recurse -Force');
    const kalmis = temizle.indexOf("Write-Log ('onbellek tam silinemedi: ' + $ad)");
    const yaz = temizle.indexOf('[System.IO.File]::WriteAllLines($OnbellekKaydi');
    expect(atla).toBeGreaterThan(0);
    expect(sil).toBeGreaterThan(atla);
    expect(kalmis).toBeGreaterThan(sil);
    expect(yaz).toBeGreaterThan(kalmis);
    // Derleme okunamazsa (git ile çalışan kurulum) eskisi gibi her açılışta silinir
    expect(temizle).toContain('if ($derleme -and (Test-Path -LiteralPath $OnbellekKaydi)) {');
  });

  it('tekrarlanan sorgular tekilleşti: yazıcılar bir kez, bekçi turunda tarayıcılar bir kez, kısayolda PowerShell süreçleri bir kez', () => {
    expect(ps1.match(/Get-CimInstance -ClassName Win32_Printer/g)).toHaveLength(1);
    expect(between(ps1, 'function Send-Printers', '# Sunucu IPv4 dinler')).toContain('$printer = $yazicilar | Where-Object { $_.Name -eq $name }');
    // Bekçi: tur başına tek tarayıcı sorgusu, kasa ve müşteri ekranı aynı listeden; müşteri ekranı açıksa yeniden sorulmaz
    expect(bekci).toContain('$surecler = @(Get-TarayiciSurecleri)\n      $kasa = Get-KasaProcess $surecler');
    expect(bekci).toContain('if (-not (Test-CustomerDisplay $surecler)) { [void](Start-CustomerDisplay $displayBase) }');
    // Kasa kısayolu: bekçi ve geçici müşteri ekranı bekçisi aynı süreç listesinden
    expect(ac).toContain('$psSurecleri = @(Get-PowerShellSurecleri)');
    expect(ac).toContain('Stop-TemporaryDisplayWatcher $psSurecleri');
    expect(between(ps1, 'function Start-WatcherIfNeeded', 'function Remove-UserPrepShortcut')).toContain('if ($null -eq $surecler) { $surecler = @(Get-PowerShellSurecleri) }');
  });

  it('kasa programının günlüğü: yeri, 1 MB\'ta tek yedek, adım süreleri; yakalanan hatalar sessiz geçmez, gizli değer yazılmaz', () => {
    expect(ps1).toContain(`$Gunluk = Join-Path $env:LOCALAPPDATA '${ESKI_URUN_ADI}\\logs\\kasa-programi.log'`);
    const log = between(ps1, 'function Write-Log', 'function Write-Hata');
    expect(log).toContain('if ($fi.Exists -and $fi.Length -ge 1MB) {');
    expect(log).toContain("$yedek = $Gunluk + '.1'");
    expect(log).toContain('[System.IO.File]::Move($Gunluk, $yedek)');
    // Kısayol ve bekçi aynı dosyaya ekler: paylaşımlı açma
    expect(log).toContain('[System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)');
    // Açılışın adım süreleri tek satırda
    expect(ac).toContain("$ozetSatiri = 'acilis: ' + ($adimlar -join ', ') + '; toplam ' + $saat.ElapsedMilliseconds + ' ms'");
    for (const a of ['denetim', 'acilis penceresi', 'sunucu', 'kasa penceresi', 'bekci', 'musteri ekrani', 'yazicilar']) expect(ac, a).toContain(`Add-Adim '${a}'`);
    // Boş catch yalnız günlüğün kendisinde (yazılacak yer yok) ve kilit bırakmada; öbürleri günlüğe yazar ya da değer döndürür
    const bos = [...ps1.matchAll(/catch \{\s*\}/g)].map((m) => ps1.slice(ps1.lastIndexOf('\n', m.index!) + 1, ps1.indexOf('\n', m.index!)).trim());
    expect(bos.every((l) => l === 'if ($own) { try { $mx.ReleaseMutex() } catch { } }' || l === 'try { $tek.ReleaseMutex() } catch { }'), JSON.stringify(bos)).toBe(true);
    expect(between(log, '} catch {', '\n  }\n')).toMatch(/^\} catch \{\n\s+# Gunluk yazilamadi/);
    for (const f of ['Start-CustomerDisplay', 'Stop-TemporaryDisplayWatcher', 'Show-KasaWindow', 'Set-KasaAcIstegi', 'Stop-CustomerDisplay', 'Open-KasaWindow', 'Remove-TemporaryKasaWatcher', 'Start-WatcherIfNeeded', 'Remove-UserPrepShortcut', 'Send-Printers', 'Clear-BrowserCache', 'Show-Message']) {
      const govde = ps1.slice(ps1.indexOf(`function ${f}`), ps1.indexOf('\n}\n', ps1.indexOf(`function ${f}`)));
      expect(govde, f).toMatch(/catch \{\s*Write-Hata '/);
    }
    // Gizli değer yazılmaz: günlüğe giden satırlarda istek gövdesi, yanıt, PIN, parola ya da anahtar yok
    const satirlar = ps1.split('\n').filter((l) => /Write-(Log|Hata)\b/.test(l) && !/^\s*function /.test(l));
    expect(satirlar.length).toBeGreaterThan(20);
    for (const l of satirlar) expect(l, l).not.toMatch(/\$(body|bytes|res)\b|pin|parola|sifre|token|anahtar|secret|Authorization/i);
  });

  it('bekçi çöken pencereyi yeniden açar, kullanıcının kapattığını açmaz; emin olunamayan açılmaz', () => {
    // Belirleyici işaret sürecin çıkış kodu (bilinmeli ve 0 olmamalı); ön koşul profilin Default\Preferences'ında tek
    // profile.exit_type, iki okumada da (3 sn arayla) "Crashed". exit_type tek başına yetmez: geri yükleme sorusu kapalıyken
    // Chromium bir çökmeden sonra düzgün kapanışta da "Crashed" bırakır (Windows CI, 28 Kasım)
    const tur = between(ps1, 'function Get-ExitType', 'function Watch-KasaProcess');
    expect(tur).toContain("Read-ScriptBytes (Join-Path $profil 'Default\\Preferences')");
    expect(tur).toContain(`'"exit_type"\\s*:\\s*"(\\w+)"'`);
    expect(tur).toContain('if ($m.Count -ne 1) { return $null }');
    const kapanis = between(ps1, 'function Get-KasaKapanis', 'function Remove-TemporaryKasaWatcher');
    expect(kapanis).toContain("if (-not $izlenen.Surec.WaitForExit(3000)) { return @{ karar = 'acik'; metin = 'surec calisiyor' } }");
    expect(kapanis).toMatch(/if \(\$ilk -eq 'Crashed'\) \{\n\s+Start-Sleep -Seconds 3\n\s+\$son = Get-ExitType \$izlenen\.Profil/);
    expect(kapanis).toContain("if ($ilk -eq 'Crashed' -and $son -eq 'Crashed' -and $null -ne $kod -and $kod -ne 0) { return @{ karar = 'coktu'");
    // Başka her durum (Normal, SessionEnded, okunamadı, çıkış kodu 0) çökme sayılmaz
    expect(kapanis.slice(kapanis.indexOf("karar = 'coktu'"))).toContain("return @{ karar = 'kapatildi'");
    // Süreç pencere açıkken izlenir (tutamak: çıkış kodu), profil komut satırından
    const izle = between(ps1, 'function Watch-KasaProcess', 'function Close-Izlenen');
    expect(izle).toContain('[System.Diagnostics.Process]::GetProcessById([int]$kasa.ProcessId)');
    expect(izle).toContain('[void]$surec.Handle');
    expect(izle).toContain("Write-Log ('kasa penceresi izleniyor: surec ' + $kasa.ProcessId");
    // Bekçi: yalnız gördüğü pencere kapanınca karar verir; çökmede bakım arası yoksa ve 10 dakikada 3'ü aşmadıysa istek bırakır
    const karar = between(bekci, '} elseif ($kasaAcikti -and $izlenen) {', '# Kisayolun (ya da coken pencerenin) istegi');
    const bakim = karar.indexOf('if (Test-KasaBakim $displayBase) {');
    const sinir = karar.indexOf('} elseif ($cokmeler.Count -ge 3) {');
    const istek = karar.indexOf('Set-KasaAcIstegi');
    expect(karar).toContain("if ($kapanis.karar -eq 'coktu') {");
    expect(bakim).toBeGreaterThan(0);
    expect(sinir).toBeGreaterThan(bakim);
    expect(istek).toBeGreaterThan(sinir);
    expect(karar).toContain('$cokmeler = @($cokmeler | Where-Object { ($simdi - $_).TotalMinutes -lt 10 })');
    expect(karar.match(/Set-KasaAcIstegi/g)).toHaveLength(1);
    // Çöken pencerenin yenisi öne gelir; kısayolun isteğiyle açılan pencere öne fırlamaz
    expect(bekci).toContain('if ($cokmeOne) { Show-KasaWindow $yeni }');
    expect(bekci.match(/Show-KasaWindow/g)).toHaveLength(1);
    // Pencere açıkken bekleyen istek silinir: kullanıcının sonra kapattığı pencere eski bir istekle yeniden açılmaz
    expect(bekci).toContain('if ($kasaAcik) {\n        # Pencere acik: bekleyen istek yerine gelmis sayilir');
    expect(bekci).toContain('if (Test-KasaAcIstegi) { Clear-KasaAcIstegi }');
    // Kullanıcının kapattığı pencere: istek yok, müşteri ekranı kapanır (#195)
    expect(bekci).toContain('} elseif ($kasaAcikti) {\n        # Kullanici kasa penceresini kapatti: yeniden acilmaz, musteri ekrani da kapanir');
    // Bir turun hatası bekçiyi durdurmaz (aynı hata tekrar tekrar yazılmaz)
    expect(bekci).toContain('if ($m -ne $sonHata) { Write-Log $m }');
  });

  it('Windows CI: düzgün kapatılan pencere gelmez, zorla kapatılan (çöken) gelir; günlük ve açılış penceresi denetlenir', () => {
    const ci = read(`${K}ci-kurulum.mjs`);
    const order = [
      "if (masaustu && !/ acilis penceresi gorundu",
      "step('D5. Kullanıcının kapattığı pencereyi bekçi yeniden açmaz",
      "await bekciGordu('D5');",
      "const kapatD5 = ps('kapat', ['-Duzgun']);",
      "'bekçi kullanıcının kapattığı kasa penceresini yeniden açtı'",
      '/kullanici kapatti[^\\n]*cikis kodu 0 /',
      "step('D5b. Çöken (zorla kapatılan) pencereyi bekçi yeniden açar');",
      "const kasaOnceD5b = await bekciGordu('D5b');",
      "ps('kapat');\nconst d5b = await waitSayfa(tCokme, () => true, 'bekçi çöken kasa penceresini yeniden açmadı', 120_000);",
      '/kasa penceresi kapandi, coktu: exit_type Crashed, cikis kodu -?[1-9]/',
    ];
    const at = order.map((t) => ci.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(order.filter((_, i) => at[i]! <= 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Zorla kapatmadan önce tarayıcı "Crashed"ı diske yazmış olmalı (yoksa çökme sayılmaz)
    expect(ci.match(/await until\('kasa profili açılışta exit_type "Crashed" yazmadı', \(\) => exitType\(\) === 'Crashed'/g)).toHaveLength(2);
    // Düzgün kapatma pencereye kapatma iletisi (Alt+F4 gibi); zorla kapatma süreçleri öldürür
    const helper = read(`${K}ci-windows.ps1`).replace(/\r\n/g, '\n');
    const kapat = between(helper, "'kapat' {", "'bekci-kapat' {");
    expect(kapat).toContain('if ($p -and $p.CloseMainWindow()) { $gonderilen++ }');
    expect(kapat.slice(kapat.indexOf('$n = 0'))).toContain('Stop-Process -Id $_.ProcessId -Force');
    // Bekçinin sürümü tek yerden (kurulum-yenile.mjs)
    expect(ci).not.toMatch(/-BekciSurum \d/);
    expect(ci.match(/-BekciSurum \$\{WATCHER_VERSION\}/g)).toHaveLength(2);
    // Başarısızlıkta kasa programının günlüğü de yazılır
    expect(between(ci, 'function fail(msg) {', '\n}\n')).toContain('tail(KASA_GUNLUGU)');
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
    const dongu = between(ps, 'foreach ($k in $items)', '$s = $sh.CreateShortcut($gecici)');
    const kur = dongu.indexOf('if ($Kur) {');
    const kosul = dongu.indexOf('} elseif ($k.kosul) {');
    expect(kur).toBeGreaterThan(0);
    expect(kosul).toBeGreaterThan(kur);
    expect(dongu).toContain('if ($k.grup -and -not ($secili -contains [string]$k.grup)) { continue }');
    expect(dongu).toContain("Set-Content -LiteralPath $yol -Value @('[InternetShortcut]', ('URL=' + [string]$k.url), ('IconFile=' + [string]$k.ikonDosyasi), 'IconIndex=0') -Encoding ASCII");
    expect(dongu).toContain("if ($k.dosya -and -not (Test-Path -LiteralPath ([string]$k.dosya))) { throw ('dosya yok: ' + $k.dosya) }");
    expect(/^[\x00-\x7f]*$/.test(readFileSync(new URL(`${K}kisayollar.ps1`, root), 'latin1'))).toBe(true);
  });

  it('Türkçe harfli kısayol adı (AsilPOS ayarları.lnk) Türkçe olmayan Windows\'ta da doğru yazılır ve okunur', () => {
    // WScript.Shell kısayol yolunu ANSI'ye çevirir: Windows CI'da (27 Kasım) "ayarları" "ayarlari.lnk" diye yazıldı.
    // Kısayol ASCII adlı geçici kopyada açılıp yazılır, asıl adına .NET kopyalar; WScript.Shell'e asıl ad hiç verilmez
    const ps = read(`${K}kisayollar.ps1`).replace(/\r\n/g, '\n');
    expect(ps).toContain("return Join-Path $dir ('~asilpos-' + [guid]::NewGuid().ToString('N') + '.lnk')");
    expect(ps).not.toMatch(/CreateShortcut\(\$(yol|f\.FullName)\)/);
    const yaz = between(ps, '$gecici = New-TempLink $dir', 'foreach ($ad in @($k.eski))');
    for (const t of ['[System.IO.File]::Copy($yol, $gecici, $true)', '$s = $sh.CreateShortcut($gecici)', '$s.Save()', '[System.IO.File]::Copy($gecici, $yol, $true)', 'Remove-Item -LiteralPath $gecici']) expect(yaz, t).toContain(t);
    expect(yaz.indexOf('$s.Save()')).toBeLessThan(yaz.indexOf('[System.IO.File]::Copy($gecici, $yol, $true)'));
    // Kaldırma kısayolu (AsilPOS'u kaldır.lnk) da kopyadan okunur
    expect(ps).toContain('[System.IO.File]::Copy($f.FullName, $gecici, $true)');
    const web = read(`${K}web-kurucu.ps1`).replace(/\r\n/g, '\n');
    expect(web).not.toContain('CreateShortcut($Yol)');
    expect(web).toContain('$k = $kabukNesnesi.CreateShortcut($gecici)');
    expect(web).toContain('[System.IO.File]::Copy($gecici, $Yol, $true)');
    const ci = read(`${K}ci-windows.ps1`).replace(/\r\n/g, '\n');
    expect(between(ci, 'function Read-Link', "switch ($Islem)")).toContain('$l = $sh.CreateShortcut($gecici)');
  });

  it('kurulum dosyası kısayolları elle yazmaz: seçilen grupları sondaki bölümde aynı komuta verir', () => {
    const nsi = read(`${K}asilpos.nsi`);
    // Yalnız kuruluma özgü kaldırma kısayolu elle; kasa, menü, masaüstü ve Başlangıç listeden
    expect((nsi.match(/CreateShortcut /g) ?? []).length).toBe(1);
    expect(nsi).toContain('CreateShortcut "$SMPROGRAMS\\AsilPOS\\AsilPOS\'u kaldır.lnk" "$INSTDIR\\Kaldir.exe"');
    expect(nsi).not.toContain('WriteINIStr');
    expect(between(nsi, 'Section "-Masaüstüne kısayol" SecDesktop', 'SectionEnd')).toContain('StrCpy $GRUPLAR "$GRUPLAR,masaustu"');
    expect(between(nsi, 'Section "-Oturum açılınca kasa ekranını aç" SecStartup', 'SectionEnd')).toContain('StrCpy $GRUPLAR "$GRUPLAR,baslangic"');
    // Kısayol bölümü üç seçenekten (ve güç ayarından) sonra; kısayollar sunucudan önce
    const son = between(nsi, 'Section "-Kisayollar ve sunucu" SecSon', 'SectionEnd');
    expect(nsi.indexOf('Section "-Kisayollar ve sunucu" SecSon')).toBeGreaterThan(nsi.indexOf('Section "-Prizdeyken uyku kapalı" SecPower'));
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
    expect(main).toContain('!insertmacro Tasi "$INSTDIR\\kurulum.gecici\\app" "$INSTDIR\\app" $YENI_APP');
    expect(main).toContain('!insertmacro Tasi "$INSTDIR\\kurulum.gecici\\node" "$INSTDIR\\node" $YENI_NODE');
    expect(main.slice(main.indexOf('${If} $R8 != 0'))).toMatch(/^\$\{If\} \$R8 != 0\n {4}Call GeriAl\n[\s\S]*?Abort/);
    // Sunucu yeni durdu: yer değiştirme 10 sn'ye kadar yeniden denenir
    const tasiMakro = between(nsi, '!macro Tasi FROM TO BAYRAK', '!macroend');
    expect(tasiMakro).toContain('${If} $R7 >= 10');
    expect(tasiMakro).toContain('Sleep 1000');
    const geri = between(nsi, 'Function RollbackFiles', 'FunctionEnd');
    expect(geri).toContain('Rename "$INSTDIR\\app.eski" "$INSTDIR\\app"');
    expect(geri).toContain('Rename "$INSTDIR\\node.eski" "$INSTDIR\\node"');
    // Eski düzen (önce sil, sonra aç) yok: yarıda kalan kurulum uygulamasız bırakmaz
    expect(main).not.toContain('RMDir /r "$INSTDIR\\app"\n');
    expect(main).toContain('File "${STAGE}${SEP}kok${SEP}*"');
    // Yeni sürüm: sağlık ucu bu derlemeyi ya da daha yenisini söyleyene dek (en çok 2 dk; siteden kurulum da -ge)
    const son = between(nsi, 'Section "-Kisayollar ve sunucu" SecSon', 'SectionEnd');
    expect(son).toContain('if ([long](Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 -Uri http://127.0.0.1:${PORT}/api/health).build -ge ${BUILD}) { exit 0 }');
    expect(nsi).not.toContain('.build -eq ${BUILD}');
    expect(nsi).toContain('!ifndef BUILD');
    expect(read(`${K}derle.mjs`)).toContain('`-DBUILD=${BUILD.build}`');
  });

  /**
   * Sorusuz kurulum (sahibin isteği, 28 Kasım 2026: "Windows'a kurarken hiçbir şey sormasın, tek seferde bitsin;
   * güncelleme varsa onu da alsın"). Gerçek Windows'ta CI dener (ci-kurulum.mjs E3, F2, F6)
   */
  it('kurulum dosyası hiçbir şey sormaz: tek sayfa, üç seçenek hep açık; başarıda kasa ekranı açılır, pencere kapanır', () => {
    const nsi = read(`${K}asilpos.nsi`);
    const kur = nsi.slice(0, nsi.indexOf('Section "Uninstall"'));
    // Hoş geldiniz, Bileşenler ve Bitiş sayfaları yok: kurulum hemen başlar
    expect([...nsi.matchAll(/^!insertmacro (MUI_PAGE_\w+)/gm)].map((m) => m[1])).toEqual(['MUI_PAGE_INSTFILES']);
    expect(nsi).not.toMatch(/MUI_(WELCOMEPAGE|FINISHPAGE|ABORTWARNING|COMPONENTSPAGE)/);
    expect(nsi).not.toContain('Kasa ekranını şimdi aç');
    expect(nsi).not.toContain('Kurulum notlarını göster');
    // Seçenek bölümleri gizli (hep seçili; sessiz kurulumda da aynı): masaüstü, oturum açılınca kasa ekranı, uyku
    const bolumler = [...kur.matchAll(/^Section (\/o )?"([^"]*)" (\w+)/gm)].map((m) => ({ o: m[1], ad: m[2]!, id: m[3] }));
    expect(bolumler.map((b) => b.id)).toEqual(['SecMain', 'SecDesktop', 'SecStartup', 'SecPower', 'SecSon']);
    expect(bolumler.every((b) => !b.o)).toBe(true);
    expect(bolumler.filter((b) => b.id !== 'SecMain').every((b) => b.ad.startsWith('-')), JSON.stringify(bolumler)).toBe(true);
    // Başarıda pencere kendiliğinden kapanır, kasa ekranı açılır (sessiz kurulumda açılmaz); sunucu açılmazsa pencere açık
    expect(nsi).toMatch(/^AutoCloseWindow true$/m);
    expect(between(nsi, 'Function .onInstSuccess', 'FunctionEnd')).toContain('${IfNot} ${Silent}\n    Call OpenKasa');
    const son = between(nsi, 'Section "-Kisayollar ve sunucu" SecSon', 'SectionEnd');
    expect(between(son, '${Else}', '${EndIf}')).toContain('SetAutoClose false');
    // Kalan sorular yalnız bunlar: gün açıkken "yine de kurulsun mu" ve veritabanı kopyası alınamadı; ikisi de sessizde
    // kurmadan çıkar. Öbürleri bilgi ya da hata kutusu; hepsinin sessiz kip yanıtı var
    const kutular = [...kur.matchAll(/MessageBox (\S+)[^\n]*/g)].map((m) => m[0]);
    expect(kutular.filter((k) => /MB_(YESNO|OKCANCEL)/.test(k)).map((k) => k.match(/\/SD \w+/)![0])).toEqual(['/SD IDNO', '/SD IDCANCEL']);
    for (const k of kutular) expect(k, k).toMatch(/\/SD ID(OK|NO|CANCEL)\b/);
    // Kaldırma onayı kalır
    expect(nsi).toContain('!insertmacro MUI_UNPAGE_CONFIRM');
  });

  it('kurulum dosyası aynı anda tek çalışır (siteden kurulumla aynı kilit); kurulu sürüm daha yeniyse kurmaz', () => {
    const nsi = read(`${K}asilpos.nsi`);
    const web = read(`${K}web-kurucu.ps1`);
    const init = between(nsi, 'Function .onInit', 'FunctionEnd');
    // Kilidin adı siteden kurulumunkiyle aynı
    const ad = /^!define KILIT "([^"]+)"$/m.exec(nsi)![1]!;
    expect(ad).toBe('Global\\AsilPOS-Kurulum');
    expect(web).toContain(`New-Object System.Threading.Mutex($false, '${ad}')`);
    // Kilit sahiplenilerek kurulur (siteden kurulumun WaitOne'ı onu tutulu görür); vardıysa ve tutan varsa (WAIT_TIMEOUT)
    // bilgi verip ayırt edilir kodla çıkar; sahibi kapanmış kilit devralınır
    const kilit = init.indexOf(`System::Call 'kernel32::CreateMutexW(p 0, i 1, w "\${KILIT}") p .r1 ?e'`);
    expect(kilit).toBeGreaterThan(0);
    const kilitBlok = between(init, '${AndIf} $0 = 183', '${EndIf}\n  ${EndIf}');
    expect(kilitBlok).toContain("System::Call 'kernel32::WaitForSingleObject(p r1, i 0) i .r2'");
    expect(kilitBlok).toContain('${If} $2 = 258');
    expect(kilitBlok).toContain('Bu bilgisayarda başka bir AsilPOS kurulumu sürüyor');
    expect(kilitBlok).toMatch(/SetErrorLevel \$\{KOD_KURULUM_SURUYOR\}\n\s*Abort/);
    // Sürüm geri düşmez: kurulu app\package.json'ın derlemesi bu dosyanınkinden büyükse kurulmaz (kilitten sonra)
    const derleme = init.indexOf("Get-Content -LiteralPath '$INSTDIR\\app\\package.json' -Raw | ConvertFrom-Json");
    expect(derleme).toBeGreaterThan(kilit);
    expect(init).toContain("if ([string]$$p.build -match '^\\d{10,11}$$' -and [long]$$p.build -gt ${BUILD}) { exit ${KOD_YENISI_KURULU} }");
    const yeni = between(init, '${If} $0 == ${KOD_YENISI_KURULU}', '${EndIf}');
    expect(yeni).toContain('MessageBox MB_ICONINFORMATION "Bu bilgisayarda daha yeni bir AsilPOS kurulu; bir şey yapmanız gerekmez." /SD IDOK');
    expect(yeni).toMatch(/SetErrorLevel \$\{KOD_YENISI_KURULU\}\n\s*Abort/);
    // Gün açıkken kurmadan çıkış da ayırt edilir; çıkış kodları CI'dakiyle aynı
    const main = between(nsi, 'Section "AsilPOS sunucusu ve kasa ekranı" SecMain', 'SectionEnd');
    expect(main).toMatch(/SetErrorLevel \$\{KOD_GUN_ACIK\}\n\s*Abort "Kurulum bırakıldı: kasada gün açık"/);
    const kod = (n: string) => Number(new RegExp(`^!define ${n} (\\d+)$`, 'm').exec(nsi)![1]);
    expect([kod('KOD_GUN_ACIK'), kod('KOD_YENISI_KURULU'), kod('KOD_KURULUM_SURUYOR')]).toEqual([3, 5, 6]);
    const ci = read(`${K}ci-kurulum.mjs`);
    expect(ci).toContain(`const KOD_GUN_ACIK = ${kod('KOD_GUN_ACIK')};`);
    expect(ci).toContain(`const KOD_YENISI_KURULU = ${kod('KOD_YENISI_KURULU')};`);
  });

  it('kurulum dosyası yarıda kalırsa eski sürüm ve sunucusu geri gelir: her hata yolu ve .onInstFailed; geri alma bayraklarla', () => {
    const nsi = read(`${K}asilpos.nsi`);
    const main = between(nsi, 'Section "AsilPOS sunucusu ve kasa ekranı" SecMain', 'SectionEnd');
    expect(between(nsi, 'Function .onInstFailed', 'FunctionEnd')).toContain('Call GeriAl');
    const geriAl = between(nsi, 'Function GeriAl', 'FunctionEnd');
    expect(geriAl).toContain('Call RollbackFiles');
    expect(geriAl).toMatch(/\$\{If\} \$DURDU == 1\n\s*Call RestoreServer\n\s*StrCpy \$DURDU 0/);
    // Sunucu durdu sayılır: görevi bu kurulum kapattı
    const dur = main.indexOf('/Change /TN "${TASK}" /DISABLE');
    expect(main.slice(dur)).toMatch(/^[^\n]*\n {2}\$\{If\} \$0 == 0\n {4}StrCpy \$DURDU 1/);
    // Sunucu durduktan sonraki her yarıda kalış önce GeriAl'ı çağırır (kopya alınamadı, yer değiştirme olmadı)
    const kalislar = main.slice(dur).split('Abort "');
    expect(kalislar.length).toBe(3);
    for (const k of kalislar.slice(0, -1)) expect(k.slice(k.lastIndexOf('${If}'))).toContain('Call GeriAl');
    expect(nsi).not.toContain('$R9');
    // Geri alma yalnız bu kurulumun taşıdıklarını geri koyar: otomatik güncellemenin bıraktığı app.eski (önceki sürüm)
    // kurulu sürümün yerine geçmez
    const geri = between(nsi, 'Function RollbackFiles', 'FunctionEnd');
    expect(geri).not.toContain('FileExists');
    for (const b of ['$YENI_APP', '$ESKI_APP', '$ESKI_NODE']) expect(geri).toContain(`\${If} ${b} == 1`);
    expect(geri.indexOf('RMDir /r "$INSTDIR\\app"')).toBeLessThan(geri.indexOf('Rename "$INSTDIR\\app.eski" "$INSTDIR\\app"'));
    expect(between(nsi, '!macro Tasi FROM TO BAYRAK', '!macroend')).toMatch(/\$\{IfNot\} \$\{Errors\}\n\s*StrCpy \$\{BAYRAK\} 1\n\s*\$\{Break\}/);
    for (const [kaynak, bayrak] of [['"$INSTDIR\\app" "$INSTDIR\\app.eski"', '$ESKI_APP'], ['"$INSTDIR\\node" "$INSTDIR\\node.eski"', '$ESKI_NODE'], ['"$INSTDIR\\kurulum.gecici\\app" "$INSTDIR\\app"', '$YENI_APP']]) {
      expect(main).toContain(`!insertmacro Tasi ${kaynak} ${bayrak}`);
    }
    // Yer değiştirme bitince bayraklar iner: sonraki bir hata (ör. kök dosyalar) yeni sürümü geri almaz, sunucuyu açar
    const tamam = main.slice(main.indexOf('Abort "Kurulum yarıda kaldı; eski sürüm çalışıyor"'));
    expect(tamam.indexOf('StrCpy $ESKI_APP 0')).toBeLessThan(tamam.indexOf('RMDir /r "$INSTDIR\\app.eski"'));
    expect(tamam.indexOf('StrCpy $YENI_APP 0')).toBeLessThan(tamam.indexOf('File "${STAGE}${SEP}kok${SEP}*"'));
    // Değişkenler kurulum başında sıfır
    const init = between(nsi, 'Function .onInit', 'FunctionEnd');
    for (const v of ['$DURDU', '$ESKI_APP', '$ESKI_NODE', '$YENI_APP', '$YENI_NODE']) expect(init).toContain(`StrCpy ${v} 0`);
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
    // Galaxy Tab'ın varsayılan tarayıcısı ve Firefox da Android yolunu alır: tarif tarayıcı adı vermez, adres çubuğunu söyler
    const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Safari/537.36';
    const firefox = 'Mozilla/5.0 (Android 14; Tablet; rv:132.0) Gecko/132.0 Firefox/132.0';
    for (const ua of [samsung, firefox]) expect(installWay({ ...base, ua }), ua).toBe('android');
    const { INSTALL_HINT } = await import('../src/lib/pwa-yol');
    expect(INSTALL_HINT.android).not.toMatch(/Chrome|⋮/);
    expect(INSTALL_HINT.android).toContain('adres çubuğu');
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

  it('sahibin okuduğu metinler: Android uygulama sözü vermez, karekodun yanı menüdeki yolu söyler, kasadan çıkış bakım arası', () => {
    // http'de Android yalnız kısayol ekler (docs/05 §5): "uygulama gibi" sözü yalnız Safari yoluna
    const metinler = { indir: read('src/pages/DownloadPage.tsx'), readme: read('README.md'), benioku: read(`${K}BENIOKU.txt`) };
    for (const [ad, t] of Object.entries(metinler)) {
      expect(t, ad).not.toContain('Ana ekrana ekle ile uygulama gibi');
      expect(t, ad).toMatch(/Android[’']de[^.]*kısayol/);
    }
    const ag = read('src/pages/admin/NetworkAdmin.tsx');
    expect(ag).not.toContain('Chrome menüsünden');
    expect(ag).toContain('kişi menüsündeki “Ana ekrana ekle” cihaza göre yolu söyler');
    // Bakım arası ekrandaki düğmenin adıyla anılır; notlar Alt+F4'ü çıkış diye vermez
    expect(metinler.benioku).not.toContain('Çıkmak için Alt+F4');
    expect(metinler.benioku.replace(/\s+/g, ' ')).toContain('Yönetim › Ağ ve uzaktan erişim › Bu bilgisayar › 15 dakika bakım arası');
    expect(ag).toContain('<Card title="Bu bilgisayar">');
    expect(ag).toMatch(/\n\s*15 dakika bakım arası\n/);
  });

  it('kapatınca kapanır (#195): notlar, kurulum ve ekran "15 saniyede yeniden açılır" demez; güncelleme denetimi koddaki aralıkla', async () => {
    const tek = (s: string) => s.replace(/\s+/g, ' ');
    const metinler = {
      readme: tek(read('README.md')),
      benioku: tek(read(`${K}BENIOKU.txt`)),
      nsi: tek(read(`${K}asilpos.nsi`)),
      ag: tek(read('src/pages/admin/NetworkAdmin.tsx')),
      bakim: tek(read('server/lib/kasa-bakim.ts')),
      kasa: tek(read('docs/05-KASA-BILGISAYARI.md')),
    };
    for (const [ad, t] of Object.entries(metinler)) {
      expect(t, ad).not.toMatch(/15 (saniye|sn)[^.]{0,20} yeniden açılır/);
      expect(t, ad).not.toContain('kapanırsa yeniden açılır');
      expect(t, ad).not.toContain('kapanırsa 15 saniyede');
    }
    // Kurulum dosyasında seçenek sayfası yok (28 Kasım 2026): açıklama metni de yok
    expect(metinler.nsi).not.toContain('MUI_DESCRIPTION_TEXT');
    expect(metinler.benioku).toContain('Kapatınca kapanır (müşteri ekranı da), kendiliğinden yeniden açılmaz');
    expect(metinler.readme).toContain('kapatınca kapanır (müşteri ekranı da)');
    expect(metinler.ag).toContain('Kasa penceresi kapatılınca kapanır, kendiliğinden yeniden açılmaz');
    expect(metinler.ag).not.toContain('Süre bitince kendiliğinden açılır');
    // Güncelleme denetimi guncelle.mjs'teki aralık (3 dk); "yarım saat" yazmaz
    const { CHECK_EVERY_MS, FIRST_CHECK_MS } = await load('guncelle.mjs');
    expect([FIRST_CHECK_MS, CHECK_EVERY_MS]).toEqual([2 * 60_000, 3 * 60_000]);
    expect(metinler.readme).toContain('AsilPOS 3 dakikada bir yeni sürüm var mı diye bakar');
    expect(metinler.benioku).toContain('AsilPOS 3 dakikada bir yeni sürüm var mı diye bakar');
    expect(metinler.kasa).toContain("Açılıştan 2 dk sonra, sonra 3 dk'da bir");
    for (const [ad, t] of Object.entries(metinler)) expect(t, ad).not.toMatch(/yarım saatte bir yeni sürüm|30 dk'da bir\. Yeni derleme/);
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
    const { startProxy, mainScript, eskiBasliklar, INJECT, CI_DEPO_ANAHTARI } = await load('ci-vekil.mjs');
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
    expect(INJECT).toContain(`var k='${CI_DEPO_ANAHTARI}'`);
  });

  it('kafedeki yolu yürür: önceki sürüm, kısayolla pencere, güncelleme, ilk açılış yeni sürüm, program, geri dönüş, kaldırma, iki kurulum, çalışan kasada siteden kurulum', () => {
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
      "'bekçi kullanıcının kapattığı kasa penceresini yeniden açtı'",
      "kasaAc({ ASILPOS_TARAYICI: 'edge' });",
      "republish(m1n, b2,",
      "vekil.mode = 'eski';\nawait bakim(true);",
      'kanal(b3, b3);',
      "'bekçi kendini yenilemedi (diskteki yeni betikle)'",
      "if (sabah.script !== s3) fail(",
      // Daha yeni kurulumun üzerine eski derlemeli kurulum dosyası kurmadan çıkar
      "const kodE3 = kurKod(BU_EXE);",
      'if (kodE3 !== KOD_YENISI_KURULU) fail(',
      "await kurmadi('eski derlemeli kurulum dosyası', onceE3);",
      "checkUninstalled('önceki sürümün kaldırıcısı');",
      'kur(BU_EXE);',
      // Kurulumun güncelleme isteği bekçiye ulaşır (otomatik güncelleme kapalı: yok sayılır)
      "sunucuGunlugu().includes('kurulumun güncelleme isteği yok sayıldı')",
      "'elle güncellemeden sonra sunucu açılmadı'",
      "checkUninstalled('bu sürümün kaldırıcısı');",
      "ASILPOS_KUR_SESSIZ: '1'",
      'compareInstalls(exeDurum, webDurum);',
      // Çalışan kasanın üzerine (kasa penceresi açık), görevin dışında çalışan sunucuyla, klasör başka programda açıkken
      'const f4 = await siteden();',
      "await sitedenTamam(f4, 'çalışan kasanın üzerine siteden kurulum', isaret);",
      "const elle = spawn(join(INSTALL, 'node', 'node.exe'), [join(INSTALL, 'app', 'bekci.mjs')]",
      'const f4b = await siteden();',
      "if (durmayan.length) fail(",
      "const tutan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { cwd: join(INSTALL, 'app')",
      'if (f5.status === 0) fail(',
      "await gorevCalisiyor('yarıda kalan kurulumdan sonra');",
      'tutan.kill();',
      "await sitedenTamam(f5b, ",
      // Gün açıkken iki kurulum da kurmadan çıkar
      '/api/cash/day/open',
      'const kodF6 = kurKod(BU_EXE);',
      'if (kodF6 !== KOD_GUN_ACIK) fail(',
      "await kurmadi('gün açıkken kurulum dosyası', onceF6);",
      'const f6 = await siteden();',
      "await kurmadi('gün açıkken siteden kurulum', onceF6);",
    ];
    const at = order.map((t) => ci.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(order.filter((_, i) => at[i]! <= 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Güncelleme kanalı baştan yerel (kurulumun isteği sitenin kanalına gitmesin), önceki sürüm kurulmadan önce
    expect(ci.indexOf('writeFileSync(ENV_FILE, ')).toBeLessThan(ci.indexOf('kur(ONCEKI_EXE);'));
    expect(ci).toContain("ASILPOS_GUNCELLEME_KANAL=http://127.0.0.1:${KANAL_PORT}/guncelleme/surum.json\\r\\n`);\nkur(ONCEKI_EXE);");
    // Kurmadan çıkışta: kurulu derleme, sunucunun süreçleri ve sağlığı, app\ işareti aynı; yeni kopya ve yan klasör yok
    const kurmadi = between(ci, 'async function kurmadi(', '\n}\n');
    for (const t of ['installedBuild() !== once.build', 'existsSync(once.isaret)', "existsSync(join(INSTALL, 'kurulum.gecici'))", 'guncellemeYedekleri() !== once.yedek', 'h?.build !== once.build', 'JSON.stringify(simdi) !== JSON.stringify(once.pids)', 'await gorevCalisiyor(label);']) expect(kurmadi, t).toContain(t);
    // Görev karşılaştırması iki tarafta da boşsa geçmez; görev Görev Zamanlayıcı nesnesinden okunur
    expect(between(ci, 'function compareInstalls(', '\n}\n')).toContain("if (!a.gorev || !b.gorev) fail(");
    const gorev = between(read(`${K}ci-windows.ps1`), "'gorev' {", "'gorev-durum' {");
    expect(gorev).toContain(`$x = [string]$zs.GetFolder('\\').GetTask('${SUNUCU_GOREVI}').Xml`);
    expect(gorev.indexOf('GetTask(')).toBeLessThan(gorev.indexOf('/Query'));
    // Kasa penceresi kısayolun kendisiyle açılır (hedefi ve argümanları), vekilden bağlanır
    expect(ci).toContain("ps('ac', ['-Kisayol', KASA_KISAYOLU], { ASILPOS_URL: VEKIL, ...env })");
    // Edge'in yerel deposu: Chromium yazımı ~5 sn sonra diske geçirir; zorla kapatmadan önce sayfanın yazımı diskte
    // beklenir (yoksa kalıcı profil de "tutmadı" görünür; 27 Kasım'ın ilk koşusu)
    const edgeAc = ci.indexOf("kasaAc({ ASILPOS_TARAYICI: 'edge' });");
    const diskte = ci.indexOf("disk = depoDiski('edge');", edgeAc);
    const edgeKapat = ci.indexOf("ps('kapat', ['-Profil', 'edge']);", edgeAc);
    expect(diskte).toBeGreaterThan(edgeAc);
    expect(edgeKapat).toBeGreaterThan(diskte);
    expect(ci).toContain('while (!disk.anahtar && Date.now() - tYaz < 30_000)');
    // Siteden kurulum yerel kanaldan (bu süreçteki sunucu) indirir: olay döngüsünü durduran spawnSync'le değil
    expect(ci).not.toContain("spawnSync('cmd.exe'");
    expect(ci).toContain("const child = spawn('cmd.exe', ['/d', '/c', kurucu], {");
    const helper = read(`${K}ci-windows.ps1`);
    expect(helper).toContain('$l = $sh.CreateShortcut($Kisayol)');
    expect(helper).toContain('-ArgumentList $l.Arguments -WorkingDirectory $wd');
    // Görevin durumu Görev Zamanlayıcı'nın nesnesinden (dil ve konsoldan bağımsız); sunucu süreçleri kurulumun Node'undan
    expect(helper).toContain(`$g = $zs.GetFolder('\\').GetTask('${SUNUCU_GOREVI}')`);
    expect(helper).toContain('Json ([ordered]@{ acik = [bool]$g.Enabled; durum = [int]$g.State })');
    expect(helper).toContain("$kok = (Join-Path $Klasor 'node') + '\\'");
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
