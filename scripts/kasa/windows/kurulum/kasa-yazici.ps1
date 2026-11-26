# AsilPOS kasa ekrani acilmadan once (AsilPOS-Kasa.bat, oturumdaki kullanici): bilgisayardaki yazicilari AsilPOS'a bildirir
# ve AsilPOS'un sectigi fis yazicisini bu kullanicinin varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma
# (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis yazicisi kurulup tek basina takiliysa hic secim
# gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da secilir. Hata olursa sessizce cikar: kasa ekrani
# yine acilir. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
# Ad degisikligi (26 Kas 2026): ASILPOS_URL yoksa eski adi; tarayici profilleri, mutex adlari ve eski kisayollar eski adla
# (shared/eski-adlar.ts). Eski adli kisayollar yeni adla es sayilir
param([string]$Url = $(if ($env:ASILPOS_URL) { $env:ASILPOS_URL } else { $env:LAFPOS_URL }), [switch]$Bekci, [int]$BekciSurum = 0, [switch]$KasaAc)
$ErrorActionPreference = 'Stop'

# Musteri ekrani (22 Kas 2026): bilgisayara ikinci ekran takiliysa musteri ekrani orada tam ekran acilir (ayri Chrome
# profili; kasa penceresinden bagimsiz). Bu betik -Bekci ile arka planda bir kez daha baslar ve 15 sn'de bir bakar:
# pencere kapandiysa ya da ikinci ekran sonradan takildiysa yeniden acar (tek bekci). Ekran olcegi (%125) pencereyi
# birinci ekrana dusurmesin diye surec DPI'ya duyarli yapilir (Screen.Bounds gercek piksel). Sahadaki gecici bekci
# (%LocalAppData%\LafPOS-MusteriEkrani, Baslangic'ta "LafPOS Musteri Ekrani") kapatilir: iki pencere acilmaz.
# Betik guncellemeyle gelir (app\); AsilPOS-Kasa.bat her acilista calistirir. Hata kasayi durdurmaz. Yalniz ASCII.
#
# Kasa ekrani bekcisi (22 Kas 2026): ayni bekci kasa penceresini de acik tutar. Kasa penceresi (AsilPOS-Kasa.bat'in
# actigi kiosk Chrome/Edge, %LocalAppData%\LafPOS\chrome ya da \edge profili) yoksa ve sunucu aciksa acar; kapanirsa en
# gec 15 sn'de yeniden acar. Bekci iki yoldan baslar: AsilPOS-Kasa.bat (bu betik) ve ortak Baslangic'taki "AsilPOS Kasa
# Bekcisi" kisayolu (guncelleme yazar, kurulum-yenile.mjs; o yoksa kullanici Baslangic'ina burada konur). Tek bekci
# calisir (ad verilmis mutex); eski surum bekci (-BekciSurum eksik) kapatilip yenisi acilir. Kasa penceresini acmak da
# mutex altinda: bat ile bekci ayni anda iki pencere acmaz (-KasaAc: bat'in kasa penceresini acma yolu). Bekci kalici
# kurulunca sahadaki gecici kasa denetcisi (kullanici Baslangic'inda "LafPOS Kasa Kontrol" ve
# %LocalAppData%\LafPOS-KasaKontrol) kaldirilir; baska bir seye dokunulmaz.
try {
  Add-Type -Namespace AsilPos -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction SilentlyContinue
  [AsilPos.Dpi]::SetProcessDPIAware() | Out-Null
} catch { }

function Get-DisplayExe {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
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
    # Acmak kilit altinda (inceleme, 23 Kas 2026): oturum acilinca bat ile bekci ayni anda sunucunun kalkmasini bekler.
    # Ikisi birden pencereyi yok gorup Chrome'u acarsa ikinci acilis ilk surece devredilir, ikinci tam ekran pencere acilir
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
    Start-Process -FilePath $exe -ArgumentList $chromeArgs | Out-Null
    # Surec gorunene dek beklenir: ardindan gelen (bat ya da bekci) ikinci pencere acmasin
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
# 4: bakim arasinda (Yonetim > Ag > Bu bilgisayar) kasa penceresi yeniden acilmaz
$BekciSurumu = 4
$BekciKisayolu = 'AsilPOS Kasa Bekcisi.lnk'
$EskiAd = 'LafPOS' # eski-ad: ad degisikliginden onceki kisayol ve menu adi
$EskiBekciKisayolu = $EskiAd + ' Kasa Bekcisi.lnk'

function Get-KasaUrl {
  if ($Url) { return $Url }
  return 'http://localhost:4000/'
}

# Kasa penceresi: kasa profiliyle calisan ana tarayici sureci (alt surecler --type= tasir; musteri profili chrome-musteri)
function Test-KasaWindow {
  $p = Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -OperationTimeoutSec 15 | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '\\LafPOS\\(chrome|edge)(?![\w-])' -and $_.CommandLine -notmatch '--type='
  } | Select-Object -First 1
  return [bool]$p
}

# Bakim arasi (Yonetim > Ag ve uzaktan erisim > Bu bilgisayar): sunucu "suruyor" derse bekci kasa penceresini acmaz.
# Sunucuya ulasilamazsa ya da yanit bozuksa ara yok sayilir (kasa yine acik tutulur)
function Test-KasaBakim([string]$base) {
  try { return [bool](Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/kasa/bakim')).active } catch { return $false }
}

function Test-Server([string]$base) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/health')).StatusCode -eq 200 } catch { return $false }
}

# Kasa penceresini acar (yoksa). AsilPOS-Kasa.bat'in Chrome/Edge argumanlarinin aynisi. $SunucuGerek: sunucu kapaliysa
# acmaz (bekci; hata sayfasi acilmasin). Dondurdugu: $false yalniz tarayici bulunamazsa
function Open-KasaWindow([bool]$SunucuGerek) {
  $mx = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaPencere')
  $own = $false
  try {
    try { $own = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $own = $true }
    if (Test-KasaWindow) { return $true }
    $kasaUrl = Get-KasaUrl
    if ($SunucuGerek -and -not (Test-Server (($kasaUrl -replace '//localhost', '//127.0.0.1').TrimEnd('/')))) { return $true }
    $exe = Get-DisplayExe
    if (-not $exe) { return $false }
    $common = @('--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required')
    if ($exe -like '*msedge.exe') {
      $kasaArgs = @('--kiosk', $kasaUrl, '--edge-kiosk-type=fullscreen', '--kiosk-printing', ('--user-data-dir="' + (Join-Path $env:LOCALAPPDATA 'LafPOS\edge') + '"')) + $common + @('--disable-features=Translate', '--noerrdialogs')
    } else {
      $kasaArgs = @('--kiosk', '--kiosk-printing', ('--app=' + $kasaUrl), ('--user-data-dir="' + (Join-Path $env:LOCALAPPDATA 'LafPOS\chrome') + '"')) + $common + @('--disable-session-crashed-bubble', '--disable-features=Translate', '--noerrdialogs')
    }
    Start-Process -FilePath $exe -ArgumentList $kasaArgs | Out-Null
    # Surec gorunene dek beklenir: ardindan gelen (bat ya da bekci) ikinci pencere acmasin
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

$displayBase = $Url
if (-not $displayBase) { $displayBase = 'http://localhost:4000/' }
$displayBase = ($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/')

if ($KasaAc) {
  # AsilPOS-Kasa.bat: kasa penceresini ac (zaten aciksa bir sey yapma); tarayici yoksa 1 (bat uyarir)
  if (Open-KasaWindow $false) { exit 0 }
  exit 1
}

if ($Bekci) {
  # Arka plan bekcisi: musteri ekrani ve kasa penceresini acik tutar (kasa bilgisayari kapanana dek). Tek bekci
  $tek = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaBekci')
  $own = $false
  try { $own = $tek.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $own = $true }
  if (-not $own) { exit 0 }
  Remove-TemporaryKasaWatcher
  $tur = 0
  while ($true) {
    Start-CustomerDisplay $displayBase
    # Ilk turda kasa penceresine bat'in kendisi acsin diye bakilmaz (en gec 15 sn sonra bekci bakar)
    if ($tur -gt 0 -and -not (Test-KasaBakim $displayBase)) { Open-KasaWindow $true | Out-Null }
    $tur++
    Start-Sleep -Seconds 15
  }
}

# Kasa hazirligi kisayolu (Baslat > AsilPOS > Kasa hazirligi) ve eski kasa programi uyarisi (haftada en cok bir kez)
try {
  $hazirla = Join-Path $PSScriptRoot 'kasa-hazirla.ps1'
  if (Test-Path $hazirla) {
    $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AsilPOS'
    $lnk = Join-Path $menu 'Kasa hazirligi.lnk'
    # Eski adli menu klasorundeki kopya (ad degisikligi): yenisi yazilacagi icin silinir, klasor bosalirsa o da
    $eskiMenu = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $EskiAd)
    $eskiLnk = Join-Path $eskiMenu 'Kasa hazirligi.lnk'
    if (Test-Path -LiteralPath $eskiLnk) {
      Remove-Item -LiteralPath $eskiLnk -Force
      if (-not @(Get-ChildItem -LiteralPath $eskiMenu -Force).Count) { Remove-Item -LiteralPath $eskiMenu -Force }
    }
    if (-not (Test-Path $lnk)) {
      if (-not (Test-Path $menu)) { New-Item -ItemType Directory -Path $menu -Force | Out-Null }
      $sh = New-Object -ComObject WScript.Shell
      $s = $sh.CreateShortcut($lnk)
      $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $hazirla + '"'
      $s.Description = 'Bilgisayar acilinca her sey kendiliginden calissin: ekran, Windows Update, ag karti, otomatik oturum'
      $s.Save()
    }
    $isaret = Join-Path $env:LOCALAPPDATA 'LafPOS\modpos-uyari.txt'
    $son = if (Test-Path $isaret) { (Get-Item $isaret).LastWriteTime } else { [datetime]::MinValue }
    if (((Get-Date) - $son).TotalDays -ge 7) {
      New-Item -ItemType File -Path $isaret -Force | Out-Null
      Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $hazirla + '"'), '-SadeceModpos') | Out-Null
    }
  }
} catch { }

try {
  Stop-TemporaryDisplayWatcher
  Start-CustomerDisplay $displayBase
  $me = $MyInvocation.MyCommand.Path
  $surumli = '*-BekciSurum ' + $BekciSurumu + '*'
  $bekciler = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*kasa-yazici.ps1*-Bekci*' })
  # Eski surum bekci (yalniz musteri ekranina bakan) kapatilir, yenisi acilir
  $bekciler | Where-Object { $_.CommandLine -notlike $surumli } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $watching = $bekciler | Where-Object { $_.CommandLine -like $surumli } | Select-Object -First 1
  if ($me -and -not $watching) {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $me + '"'), '-Bekci', '-BekciSurum', [string]$BekciSurumu) | Out-Null
  }
  # Bekcinin Baslangic kisayolu: guncelleme ortak Baslangic'a yazar; yazamadiysa (ve kasa ekrani acilista aciliyorsa)
  # kullanici Baslangic'ina konur. Yonetici izni gerekmez
  $ortak = [Environment]::GetFolderPath('CommonStartup')
  $kendi = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $kasaAcilista = $false
  $bekciVar = $false
  foreach ($d in @($ortak, $kendi)) {
    foreach ($ad in @('AsilPOS Kasa.lnk', ($EskiAd + ' Kasa.lnk'))) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $kasaAcilista = $true } }
    foreach ($ad in @($BekciKisayolu, $EskiBekciKisayolu)) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $bekciVar = $true } }
  }
  if ($me -and $kasaAcilista -and -not $bekciVar) {
    $kur = Split-Path -Parent $PSScriptRoot
    $sh = New-Object -ComObject WScript.Shell
    $k = $sh.CreateShortcut((Join-Path $kendi $BekciKisayolu))
    $k.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $k.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $me + '" -Bekci -BekciSurum ' + $BekciSurumu
    $k.WorkingDirectory = $kur
    $k.IconLocation = (Join-Path $kur 'asilpos.ico') + ',0'
    $k.WindowStyle = 7
    $k.Description = 'Kasa ve musteri ekrani acik kalsin (kapanirsa yeniden acar)'
    $k.Save()
  }
} catch { }

try {
  if (-not $Url) { $Url = 'http://localhost:4000/' }
  # Sunucu IPv4 dinler; localhost once IPv6 denenip yavaslar
  $base = ($Url -replace '//localhost', '//127.0.0.1').TrimEnd('/')
  $list = @(Get-CimInstance -ClassName Win32_Printer -OperationTimeoutSec 15 | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; PortName = $_.PortName; DriverName = $_.DriverName; Default = [bool]$_.Default; WorkOffline = [bool]$_.WorkOffline }
    })
  $body = ConvertTo-Json -InputObject @{ printers = $list } -Depth 4 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $res = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Method Post -Uri ($base + '/api/kasa/yazicilar') -ContentType 'application/json; charset=utf-8' -Body $bytes
  $name = [string]$res.name
  if (-not $name) { exit 0 }
  # Windows 10/11 "varsayilan yaziciyi Windows yonetsin" kapali: secilen yazici son kullanilanla degismez
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord
  $printer = Get-CimInstance -ClassName Win32_Printer -OperationTimeoutSec 15 | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($printer -and -not $printer.Default) { Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter | Out-Null }
} catch {
  exit 0
}
exit 0
