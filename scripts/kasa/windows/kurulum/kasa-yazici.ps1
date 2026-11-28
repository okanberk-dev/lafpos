# AsilPOS kasa programi (Windows, oturumdaki kullanici): kasa penceresini acar ve acik tutar, fis yazicisini ayarlar,
# musteri ekranini ikinci ekranda acar. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1
# BOM'suz dosyayi ANSI okur): ekranda gorunen Turkce harfler Tr ile yer tutucudan ({c}, {i} gibi) yazilir.
#
# Kipler:
#   -Ac      Program (27 Kas 2026, sahibin istegi: "tamamen bir program olacak sekilde"): Baslat menusu, masaustu ve
#            Baslangic'taki "AsilPOS Kasa" kisayollari bunu konsolsuz (powershell -WindowStyle Hidden) acar. Kasa penceresi
#            zaten aciksa one getirir (tek pencere, ikinci tiklama yeni pencere acmaz). Yoksa kucuk "AsilPOS aciliyor"
#            penceresi gorunur; sunucu beklenir (en cok 90 sn), yazicilar bildirilir, musteri ekrani ve bekci acilir, kasa
#            penceresi acilir. Sunucu 90 sn'de acilmazsa pencere acilmaz: bekci sunucu gelince acar (hata sayfasi kalmaz).
#   -Bekci   Arka plan bekcisi: kisayolun istedigi kasa penceresini sunucu gelince acar, musteri ekranini kasa penceresi
#            aciktayken acik tutar (tek bekci). Kullanici kasa penceresini kapatirsa yeniden ACMAZ, musteri ekranini da kapatir
#            (sahibin istegi, 28 Kas 2026: kapatinca kapansin, ben acinca acilsin). Diskteki
#            betik degisirse (otomatik guncelleme) yenisiyle yeniden baslar: yeni surum oturum kapanmayi beklemez.
#   -KasaAc  27 Kasim oncesinin kasa kisayolu (AsilPOS-Kasa.bat): kasa penceresini acar ya da one getirir.
#   (kipsiz) Ayni eski kisayolun ilk adimi: yazicilar, musteri ekrani, bekci.
#
# Fis yazicisi: bilgisayardaki yazicilari AsilPOS'a bildirir ve AsilPOS'un sectigi fis yazicisini bu kullanicinin
# varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis
# yazicisi kurulup tek basina takiliysa hic secim gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da
# secilir. Hata olursa sessizce gecilir: kasa ekrani yine acilir.
#
# Musteri ekrani (22 Kas 2026): bilgisayara ikinci ekran takiliysa musteri ekrani orada tam ekran acilir (ayri Chrome
# profili; kasa penceresinden bagimsiz). Ekran olcegi (%125) pencereyi birinci ekrana dusurmesin diye surec DPI'ya duyarli
# yapilir (Screen.Bounds gercek piksel). Sahadaki gecici bekci (%LocalAppData%\LafPOS-MusteriEkrani,
# Baslangic'ta "LafPOS Musteri Ekrani") kapatilir: iki pencere acilmaz.
#
# Kasa ekrani bekcisi (22 Kas 2026; 28 Kas 2026'dan beri kapanani yeniden acmaz): kasa kisayolu acarken sunucu henuz
# gelmediyse istek dosyasi birakir (kasa-ac.istek); bekci sunucu gelince pencereyi acar ve istegi siler. Kullanici kasa
# penceresini (%LocalAppData%\LafPOS\chrome ya da \edge profiliyle calisan Chrome/Edge) kapatirsa bekci yeniden acmaz. Bekci iki yoldan baslar: kasa kisayolu (-Ac) ve ortak
# Baslangic'taki "AsilPOS Kasa Bekcisi" kisayolu (guncelleme yazar, kurulum-yenile.mjs; o yoksa kullanici Baslangic'ina
# burada konur). Tek bekci calisir (ad verilmis mutex); eski surum bekci (-BekciSurum farkli) kapatilip yenisi acilir. Kasa
# penceresini acmak da mutex altinda: kisayol ile bekci ayni anda iki pencere acmaz. Bekci kalici kurulunca sahadaki gecici
# kasa denetcisi (kullanici Baslangic'inda "LafPOS Kasa Kontrol" ve %LocalAppData%\LafPOS-KasaKontrol) kaldirilir.
#
# Ad degisikligi (26 Kas 2026): ASILPOS_URL yoksa eski adi; tarayici profilleri, mutex adlari ve eski kisayollar eski adla
# (shared/eski-adlar.ts). Eski adli kisayollar yeni adla es sayilir. Guncellemeden once baslamis bekci pencereyi profil
# klasorunden (\LafPOS\chrome, \LafPOS\edge) tanir: bu adlar degismez.
param([string]$Url = $(if ($env:ASILPOS_URL) { $env:ASILPOS_URL } else { $env:LAFPOS_URL }), [switch]$Bekci, [int]$BekciSurum = 0, [switch]$KasaAc, [switch]$Ac)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  Add-Type -Namespace AsilPos -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction SilentlyContinue
  [AsilPos.Dpi]::SetProcessDPIAware() | Out-Null
} catch { }

# Kurulum klasoru (app\'in bir ustu): tarayici ve bekci burada calisir. app\ guncellemede tasinir (app -> app.eski); icinde
# duran bir surec (calisma klasoru) tasimayi engellerdi
$KurulumKlasoru = Split-Path -Parent $PSScriptRoot

# Ekranda gorunen Turkce metin: dosya ASCII kalsin diye harfler yer tutucuyla
function Tr([string]$s) {
  foreach ($h in @(@('{c}', 0x00E7), @('{g}', 0x011F), @('{i}', 0x0131), @('{o}', 0x00F6), @('{s}', 0x015F), @('{u}', 0x00FC))) {
    $s = $s.Replace([string]$h[0], [string][char][int]$h[1])
  }
  return $s
}

function Show-Message([string]$metin) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($metin, 'AsilPOS', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
  } catch { }
}

# Tarayici: Chrome, yoksa Edge. ASILPOS_TARAYICI=edge (kullanici ortam degiskeni) Chrome kurulu olsa da Edge'i secer
function Get-DisplayExe {
  $chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  $edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  $candidates = $chrome + $edge
  if ($env:ASILPOS_TARAYICI -eq 'edge') { $candidates = $edge + $chrome }
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# Tarayici onbellegi (inceleme, 27 Kas 2026): yeni kasa ya da musteri ekrani tarayicisi acilmadan once o profilin HTTP
# onbellegi (Default\Cache) silinir. 27 Kasim surumunden onceki sunucu arayuz sayfasini onbellek basligi olmadan veriyordu;
# Chrome onu sunucuya sormadan acabiliyor, guncellemeden sonraki ilk acilista eski arayuz gorunuyordu. Yeni sunucu sayfayi
# saklatmaz (no-store) ama eski kayit profilde kalmis olabilir. Dosyalar yerel sunucudan gelir: silmek yalniz ilk yuklemeyi
# yeniden yaptirir. Oturum, ayarlar ve yerel depolama (Local Storage, Cookies) silinmez. Profil kullanimdayken cagrilmaz
# (yalniz o profilin tarayicisi yokken, kilit altinda); silinemeyen dosya sessizce kalir
function Clear-BrowserCache([string]$profileDir) {
  try {
    $cache = Join-Path $profileDir 'Default\Cache'
    if (Test-Path -LiteralPath $cache) { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Musteri ekrani acik mi: musteri profiliyle (chrome-musteri) calisan Chrome/Edge sureci
function Test-CustomerDisplay {
  $p = Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | Select-Object -First 1
  return [bool]$p
}

function Start-CustomerDisplay([string]$base) {
  $mx = $null
  $own = $false
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $second = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $second) { return }
    # Acmak kilit altinda (inceleme, 23 Kas 2026): oturum acilinca kisayol ile bekci ayni anda sunucunun kalkmasini
    # bekler. Ikisi birden pencereyi yok gorup Chrome'u acarsa ikinci acilis ilk surece devredilir, ikinci tam ekran acilir
    $mx = New-Object System.Threading.Mutex($false, 'Local\LafPOS-MusteriPencere')
    try { $own = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $own = $true }
    if (Test-CustomerDisplay) { return }
    $exe = Get-DisplayExe
    if (-not $exe) { return }
    # Sunucu cevap vermiyorsa acilmaz, bekci 15 sn sonra yeniden bakar (inceleme, 23 Kas 2026). Bekci oturum acilinca
    # baslar, sunucu henuz kalkmamis olabilir: hata sayfasiyla acilan pencerenin sureci var oldugu icin bir daha acilmazdi
    if (-not (Test-Server $base)) { return }
    $b = $second.Bounds
    $profileDir = Join-Path $env:LOCALAPPDATA 'LafPOS\chrome-musteri'
    $chromeArgs = @(
      '--kiosk',
      ('--app=' + $base + '/musteri-ekrani?ekran=kasa'),
      ('--user-data-dir="' + $profileDir + '"'),
      ('--window-position=' + $b.X + ',' + $b.Y),
      ('--window-size=' + $b.Width + ',' + $b.Height),
      '--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required',
      '--disable-session-crashed-bubble', '--disable-features=Translate'
    )
    Clear-BrowserCache $profileDir
    Start-Process -FilePath $exe -ArgumentList $chromeArgs -WorkingDirectory $KurulumKlasoru | Out-Null
    # Surec gorunene dek beklenir: ardindan gelen (kisayol ya da bekci) ikinci pencere acmasin
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-CustomerDisplay) { break }
    }
  } catch {
  } finally {
    if ($own) { try { $mx.ReleaseMutex() } catch { } }
    if ($mx) { $mx.Dispose() }
  }
}

function Stop-TemporaryDisplayWatcher {
  try {
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LafPOS Musteri Ekrani.lnk'
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force }
    Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*LafPOS-MusteriEkrani*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Kasa bekcisinin surumu (kurulum-yenile.mjs WATCHER_VERSION ile ayni). 3: musteri ekrani sunucu cevap verince acilir;
# 4: bakim arasinda (Yonetim > Ag > Bu bilgisayar) kasa penceresi yeniden acilmaz; 5: program (27 Kas 2026): Edge
# InPrivate olmayan tam ekran pencerede, diskteki betik degisince bekci yenisiyle yeniden baslar; 6 (28 Kas 2026): kapanan
# kasa penceresini yeniden acmaz (yalniz kisayolun istegiyle acar), kasa penceresi kapaninca musteri ekranini da kapatir
$BekciSurumu = 6
$BekciKisayolu = 'AsilPOS Kasa Bekcisi.lnk'
$EskiAd = 'LafPOS' # eski-ad: ad degisikliginden onceki kisayol ve menu adi
$EskiBekciKisayolu = $EskiAd + ' Kasa Bekcisi.lnk'

function Get-KasaUrl {
  if ($Url) { return $Url }
  return 'http://localhost:4000/'
}

# Kasa penceresi: kasa profiliyle calisan ana tarayici sureci (alt surecler --type= tasir; musteri profili chrome-musteri)
function Get-KasaProcess {
  return Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -OperationTimeoutSec 15 | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '\\LafPOS\\(chrome|edge)(?![\w-])' -and $_.CommandLine -notmatch '--type='
  } | Select-Object -First 1
}

function Test-KasaWindow {
  return [bool](Get-KasaProcess)
}

# Acik kasa penceresini one getirir (kisayola yeniden basilinca: ikinci pencere yerine ayni program). Kucultulmusse geri
# acilir. Windows on plani kilitlediyse (baska programa yazilirken) bir Alt basimiyla yeniden denenir; olmazsa gorev
# cubugundaki dugme yanip soner. Bekci cagirmaz: arka planda pencere one firlamaz
function Show-KasaWindow($proc) {
  try {
    Add-Type -Namespace AsilPos -Name Pencere -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);' -ErrorAction SilentlyContinue
    $h = (Get-Process -Id $proc.ProcessId -ErrorAction Stop).MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    if ([AsilPos.Pencere]::IsIconic($h)) { [void][AsilPos.Pencere]::ShowWindowAsync($h, 9) }
    if (-not [AsilPos.Pencere]::SetForegroundWindow($h)) {
      [AsilPos.Pencere]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [AsilPos.Pencere]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      [void][AsilPos.Pencere]::SetForegroundWindow($h)
    }
  } catch { }
}

# Bakim arasi (Yonetim > Ag ve uzaktan erisim > Bu bilgisayar): sunucu "suruyor" derse bekci kasa penceresini acmaz.
# Sunucuya ulasilamazsa ya da yanit bozuksa ara yok sayilir (kasa yine acik tutulur)
function Test-KasaBakim([string]$base) {
  try { return [bool](Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/kasa/bakim')).active } catch { return $false }
}

function Test-Server([string]$base) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/health')).StatusCode -eq 200 } catch { return $false }
}

# "AsilPOS aciliyor" penceresi (kasa kisayolu, -Ac): sunucu beklenirken ve yazicilar bildirilirken gorev cubugunda AsilPOS
# simgesiyle gorunur, kasa penceresi acilinca kapanir. Kendi is parcaciginda calisir (bekleme onu dondurmaz). Hata olursa
# pencere olmadan devam edilir
# Kasa penceresi acma istegi (kasa kisayolu birakir, bekci sunucu gelince acar ve siler). Bekci kapanan pencereyi kendiliginden
# acmaz: yalniz bu istek varken acar. 30 dakikadan eski istek bayat sayilir (kullanici o arada vazgecmistir)
$KasaAcIstegi = Join-Path $env:LOCALAPPDATA 'LafPOS\kasa-ac.istek' # eski-ad
function Set-KasaAcIstegi {
  try {
    New-Item -ItemType Directory -Path (Split-Path $KasaAcIstegi) -Force | Out-Null
    Set-Content -LiteralPath $KasaAcIstegi -Value ((Get-Date).ToString('o')) -Encoding ASCII
  } catch { }
}
function Clear-KasaAcIstegi {
  try { if (Test-Path -LiteralPath $KasaAcIstegi) { Remove-Item -LiteralPath $KasaAcIstegi -Force } } catch { }
}
function Test-KasaAcIstegi {
  try {
    if (-not (Test-Path -LiteralPath $KasaAcIstegi)) { return $false }
    if (((Get-Date) - (Get-Item -LiteralPath $KasaAcIstegi).LastWriteTime).TotalMinutes -gt 30) { Clear-KasaAcIstegi; return $false }
    return $true
  } catch { return $false }
}

# Musteri ekranini kapatir (kasa penceresi kullanici tarafindan kapatilinca: uygulama butunuyle kapansin)
function Stop-CustomerDisplay {
  try {
    Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

function Start-Splash {
  try {
    $durum = [hashtable]::Synchronized(@{ kapat = $false })
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'
    $rs.ThreadOptions = 'ReuseThread'
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('durum', $durum)
    $rs.SessionStateProxy.SetVariable('ikon', (Join-Path $KurulumKlasoru 'asilpos.ico'))
    $rs.SessionStateProxy.SetVariable('baslikMetni', (Tr 'AsilPOS a{c}{i}l{i}yor'))
    $rs.SessionStateProxy.SetVariable('altMetin', (Tr 'Kasa ekran{i} haz{i}rlan{i}yor'))
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript({
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $f = New-Object System.Windows.Forms.Form
        $g = $f.CreateGraphics()
        $o = $g.DpiX / 96
        $g.Dispose()
        $f.Text = 'AsilPOS'
        $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $f.ClientSize = New-Object System.Drawing.Size([int](420 * $o), [int](120 * $o))
        $f.BackColor = [System.Drawing.Color]::White
        $f.ShowInTaskbar = $true
        if (Test-Path -LiteralPath $ikon) {
          $f.Icon = New-Object System.Drawing.Icon($ikon)
          $resim = New-Object System.Windows.Forms.PictureBox
          $resim.Image = (New-Object System.Drawing.Icon($ikon, [int](64 * $o), [int](64 * $o))).ToBitmap()
          $resim.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
          $resim.SetBounds([int](28 * $o), [int](28 * $o), [int](64 * $o), [int](64 * $o))
          $f.Controls.Add($resim)
        }
        $baslik = New-Object System.Windows.Forms.Label
        $baslik.Text = $baslikMetni
        $baslik.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
        $baslik.ForeColor = [System.Drawing.Color]::FromArgb(23, 26, 38)
        $baslik.AutoSize = $true
        $baslik.Location = New-Object System.Drawing.Point([int](110 * $o), [int](32 * $o))
        $f.Controls.Add($baslik)
        $alt = New-Object System.Windows.Forms.Label
        $alt.Text = $altMetin
        $alt.Font = New-Object System.Drawing.Font('Segoe UI', 10)
        $alt.ForeColor = [System.Drawing.Color]::FromArgb(102, 106, 120)
        $alt.AutoSize = $true
        $alt.Location = New-Object System.Drawing.Point([int](112 * $o), [int](66 * $o))
        $f.Controls.Add($alt)
        $t = New-Object System.Windows.Forms.Timer
        $t.Interval = 200
        $t.Add_Tick({ if ($durum.kapat) { $f.Close() } })
        $t.Start()
        [System.Windows.Forms.Application]::Run($f)
      })
    $h = $ps.BeginInvoke()
    return @{ durum = $durum; ps = $ps; rs = $rs; h = $h }
  } catch {
    return $null
  }
}

function Stop-Splash($s) {
  if (-not $s) { return }
  try {
    $s.durum.kapat = $true
    [void]$s.h.AsyncWaitHandle.WaitOne(3000)
    $s.ps.Dispose()
    $s.rs.Close()
  } catch { }
}

# Sunucu cevap verene dek bekler (en cok $saniye); verirse $true
function Wait-Server([string]$base, [int]$saniye) {
  $son = (Get-Date).AddSeconds($saniye)
  while ($true) {
    if (Test-Server $base) { return $true }
    if ((Get-Date) -ge $son) { return $false }
    Start-Sleep -Seconds 1
  }
}

# Kasa penceresini acar (yoksa). $SunucuGerek: sunucu kapaliysa acmaz (bekci; hata sayfasi acilmasin). $OneGetir: zaten
# aciksa one getirir (kisayol; bekci getirmez). Dondurdugu: $false yalniz tarayici bulunamazsa
function Open-KasaWindow([bool]$SunucuGerek, [bool]$OneGetir = $false) {
  $mx = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaPencere')
  $own = $false
  try {
    try { $own = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $own = $true }
    $acik = Get-KasaProcess
    if ($acik) {
      if ($OneGetir) { Show-KasaWindow $acik }
      return $true
    }
    $kasaUrl = Get-KasaUrl
    if ($SunucuGerek -and -not (Test-Server (($kasaUrl -replace '//localhost', '//127.0.0.1').TrimEnd('/')))) { return $true }
    $exe = Get-DisplayExe
    if (-not $exe) { return $false }
    $common = @('--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required')
    if ($exe -like '*msedge.exe') {
      # Edge pencere kipinde (27 Kas 2026): Edge'in kiosk kipi (--kiosk, tam ekran ya da tek uygulama) her zaman InPrivate acar; pencere
      # her yeniden acilista oturumu, gonderilmemis sepeti ve tercihleri kaybederdi. Uygulama penceresi (--app) tam ekran
      # (--start-fullscreen) ayni adres cubuksuz gorunumu kalici profille verir; profil klasoru ayni (eski bekci tanir)
      $kasaProfil = Join-Path $env:LOCALAPPDATA 'LafPOS\edge'
      $kasaArgs = @(('--app=' + $kasaUrl), '--start-fullscreen', '--kiosk-printing', ('--user-data-dir="' + $kasaProfil + '"')) + $common + @('--disable-session-crashed-bubble', '--disable-features=Translate', '--noerrdialogs')
    } else {
      $kasaProfil = Join-Path $env:LOCALAPPDATA 'LafPOS\chrome'
      $kasaArgs = @('--kiosk', '--kiosk-printing', ('--app=' + $kasaUrl), ('--user-data-dir="' + $kasaProfil + '"')) + $common + @('--disable-session-crashed-bubble', '--disable-features=Translate', '--noerrdialogs')
    }
    # Kasa profilinin tarayicisi yok (Get-KasaProcess, kilit altinda): eski arayuz onbellekten acilmasin
    Clear-BrowserCache $kasaProfil
    Start-Process -FilePath $exe -ArgumentList $kasaArgs -WorkingDirectory $KurulumKlasoru | Out-Null
    # Surec gorunene dek beklenir: ardindan gelen (kisayol ya da bekci) ikinci pencere acmasin
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-KasaWindow) { break }
    }
    return $true
  } catch {
    return $true
  } finally {
    if ($own) { try { $mx.ReleaseMutex() } catch { } }
    $mx.Dispose()
  }
}

# Sahadaki gecici kasa denetcisi: yalniz kullanici Baslangic'indaki kisayolu ve klasoru (ve oradan calisan sureci)
function Remove-TemporaryKasaWatcher {
  try {
    Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*LafPOS-KasaKontrol*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LafPOS Kasa Kontrol.lnk'
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
    $dir = Join-Path $env:LOCALAPPDATA 'LafPOS-KasaKontrol'
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  } catch { }
}

# Betigin diskteki hali (bekcinin kendini yenilemesi). Dosya silme paylasimiyla acilir: guncelleme o an app\ klasorunu
# tasiyabilsin
function Read-ScriptBytes([string]$path) {
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $ms = New-Object System.IO.MemoryStream
    $fs.CopyTo($ms)
    return , $ms.ToArray()
  } catch {
    return $null
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

function Get-ScriptHash([string]$path) {
  $b = Read-ScriptBytes $path
  if ($null -eq $b -or $b.Length -eq 0) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($b)) } finally { $sha.Dispose() }
}

function Get-ScriptVersion([string]$path) {
  $b = Read-ScriptBytes $path
  if ($null -eq $b -or $b.Length -eq 0) { return 0 }
  $m = [regex]::Match([System.Text.Encoding]::ASCII.GetString($b), '(?m)^\$BekciSurumu = (\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return 0
}

# Bekciyi baslatir (kurulum klasorunde: app\ tasinabilsin)
function Start-WatcherProcess([int]$surum) {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $KurulumKlasoru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'), '-Bekci', '-BekciSurum', [string]$surum) | Out-Null
}

# Bekci calismiyorsa acar; eski surum bekci kapatilir. Bekcinin Baslangic kisayolu: guncelleme ortak Baslangic'a yazar;
# yazamadiysa (ve kasa ekrani acilista aciliyorsa) kullanici Baslangic'ina konur. Yonetici izni gerekmez
function Start-WatcherIfNeeded {
  try {
    $surumli = '*-BekciSurum ' + $BekciSurumu + '*'
    $bekciler = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*kasa-yazici.ps1*-Bekci*' })
    # Eski surum bekci kapatilir, yenisi acilir
    $bekciler | Where-Object { $_.CommandLine -notlike $surumli } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $watching = $bekciler | Where-Object { $_.CommandLine -like $surumli } | Select-Object -First 1
    if ($PSCommandPath -and -not $watching) { Start-WatcherProcess $BekciSurumu }
    $ortak = [Environment]::GetFolderPath('CommonStartup')
    $kendi = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    $kasaAcilista = $false
    $bekciVar = $false
    foreach ($d in @($ortak, $kendi)) {
      foreach ($ad in @('AsilPOS Kasa.lnk', ($EskiAd + ' Kasa.lnk'))) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $kasaAcilista = $true } }
      foreach ($ad in @($BekciKisayolu, $EskiBekciKisayolu)) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $bekciVar = $true } }
    }
    if ($PSCommandPath -and $kasaAcilista -and -not $bekciVar) {
      $sh = New-Object -ComObject WScript.Shell
      $k = $sh.CreateShortcut((Join-Path $kendi $BekciKisayolu))
      $k.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $k.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Bekci -BekciSurum ' + $BekciSurumu
      $k.WorkingDirectory = $KurulumKlasoru
      $k.IconLocation = (Join-Path $KurulumKlasoru 'asilpos.ico') + ',0'
      $k.WindowStyle = 7
      $k.Description = 'Kasa kisayolunun istedigi pencereyi sunucu gelince acar; musteri ekranini kasa acikken tutar'
      $k.Save()
    }
  } catch { }
}

# Kullanici Baslat menusundeki eski "Kasa hazirligi" kisayolu (28 Kas 2026, sahibin istegi: kasa acilirken eski kasa
# programi sorusu cikmasin). Kasa programi eskiden her acilista bu simgesiz kisayolu yazar ve haftada bir eski kasa
# programi uyarisini acardi; ikisi de kalkti. Eski kurulumlarda kalan kisayol (eski adli menu klasorundeki de) silinir,
# klasor bosalirsa o da: menude iki "Kasa hazirligi" gorunmez. Ortak menudeki "Kasa hazirligi" (kurulum-yenile.mjs
# kisayol listesi) kalir
function Remove-UserPrepShortcut {
  foreach ($ad in @('AsilPOS', $EskiAd)) {
    try {
      $menu = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $ad)
      $lnk = Join-Path $menu 'Kasa hazirligi.lnk'
      if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force
        if (-not @(Get-ChildItem -LiteralPath $menu -Force).Count) { Remove-Item -LiteralPath $menu -Force }
      }
    } catch { }
  }
}

# Yazicilar: bilgisayardaki yazicilar AsilPOS'a bildirilir, AsilPOS'un sectigi fis yazicisi varsayilan yapilir
function Send-Printers([string]$base) {
  try {
    $list = @(Get-CimInstance -ClassName Win32_Printer -OperationTimeoutSec 15 | ForEach-Object {
        [pscustomobject]@{ Name = $_.Name; PortName = $_.PortName; DriverName = $_.DriverName; Default = [bool]$_.Default; WorkOffline = [bool]$_.WorkOffline }
      })
    $body = ConvertTo-Json -InputObject @{ printers = $list } -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Method Post -Uri ($base + '/api/kasa/yazicilar') -ContentType 'application/json; charset=utf-8' -Body $bytes
    $name = [string]$res.name
    if (-not $name) { return }
    # Windows 10/11 "varsayilan yaziciyi Windows yonetsin" kapali: secilen yazici son kullanilanla degismez
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord
    $printer = Get-CimInstance -ClassName Win32_Printer -OperationTimeoutSec 15 | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($printer -and -not $printer.Default) { Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter | Out-Null }
  } catch { }
}

# Sunucu IPv4 dinler; localhost once IPv6 denenip yavaslar
$displayBase = $Url
if (-not $displayBase) { $displayBase = 'http://localhost:4000/' }
$displayBase = ($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/')

if ($KasaAc) {
  # Eski kasa kisayolu (AsilPOS-Kasa.bat): kasa penceresini ac ya da one getir; tarayici yoksa 1 (bat uyarir)
  if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi; exit 0 }
  exit 1
}

if ($Bekci) {
  # Arka plan bekcisi: kisayolun istedigi kasa penceresini acar, musteri ekranini kasa acikken tutar. Tek bekci
  $tek = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaBekci')
  $own = $false
  try { $own = $tek.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $own = $true }
  if (-not $own) { exit 0 }
  Remove-TemporaryKasaWatcher
  $ilkOzet = Get-ScriptHash $PSCommandPath
  $tur = 0
  $kasaAcikti = $false
  while ($true) {
    # Kisayolun istegi: sunucu gelince kasa penceresi acilir, istek silinir. Ilk turda kisayolun kendisi acsin diye bakilmaz
    if ($tur -gt 0 -and (Test-KasaAcIstegi) -and -not (Test-KasaWindow) -and -not (Test-KasaBakim $displayBase) -and (Test-Server $displayBase)) {
      if (Open-KasaWindow $true) { Clear-KasaAcIstegi }
    }
    $kasaAcik = Test-KasaWindow
    if ($kasaAcik) {
      Start-CustomerDisplay $displayBase
    } elseif ($kasaAcikti) {
      # Kullanici kasa penceresini kapatti: yeniden acilmaz, musteri ekrani da kapanir (sahibin istegi, 28 Kas 2026)
      Stop-CustomerDisplay
    }
    $kasaAcikti = $kasaAcik
    $tur++
    Start-Sleep -Seconds 15
    # Kendini yenileme (27 Kas 2026): otomatik guncelleme app\'i degistirince bu betigin diskteki hali degisir. Bekci
    # yenisini acip cikar (kilidi once birakir); yeni pencere kurallari oturum kapanmayi beklemez. Diskteki betik 5'ten
    # eski bir surumse (elle geri donus) bu bekci calismaya devam eder
    $ozet = Get-ScriptHash $PSCommandPath
    if ($ilkOzet -and $ozet -and $ozet -ne $ilkOzet) {
      $yeniSurum = Get-ScriptVersion $PSCommandPath
      if ($yeniSurum -ge 5) {
        try { $tek.ReleaseMutex() } catch { }
        $tek.Dispose()
        Start-WatcherProcess $yeniSurum
        exit 0
      }
      $ilkOzet = $ozet
    }
  }
}

if ($Ac) {
  # Kasa programi (kisayol). Iki tiklama ust uste gelirse ikincisi beklemez: ilki acar, pencere varsa one getirilir
  $tekAcilis = New-Object System.Threading.Mutex($false, 'Local\AsilPOS-KasaAcilis')
  $acilisBende = $false
  try { $acilisBende = $tekAcilis.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acilisBende = $true }
  $acik = $null
  try { $acik = Get-KasaProcess } catch { $acik = $null }
  if ($acik) { Show-KasaWindow $acik }
  if (-not $acilisBende) { exit 0 }
  if (-not $acik -and -not (Get-DisplayExe)) {
    Show-Message (Tr 'Chrome ya da Edge bulunamad{i}. Kasa ekran{i} i{c}in https://www.google.com/chrome adresinden Chrome''u kurun.')
    exit 1
  }
  $splash = $null
  try {
    if (-not $acik) { $splash = Start-Splash }
    # Bekci once: sunucu gec gelirse kasa penceresini o acar
    Stop-TemporaryDisplayWatcher
    Start-WatcherIfNeeded
    $hazir = $true
    # Istek once: sunucu 90 sn'de gelmezse pencereyi bekci acar (istek yoksa bekci acmaz)
    if (-not $acik) { Set-KasaAcIstegi; $hazir = Wait-Server $displayBase 90 }
    if ($hazir) {
      Send-Printers $displayBase
      Start-CustomerDisplay $displayBase
    }
    if (-not $acik -and $hazir) { if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi } }
  } finally {
    Stop-Splash $splash
  }
  Remove-UserPrepShortcut
  exit 0
}

# Kipsiz: 27 Kasim oncesinin kasa kisayolu (AsilPOS-Kasa.bat) bunu -KasaAc'tan once cagirir
Remove-UserPrepShortcut
Stop-TemporaryDisplayWatcher
Start-CustomerDisplay $displayBase
Start-WatcherIfNeeded
Send-Printers $displayBase
exit 0
