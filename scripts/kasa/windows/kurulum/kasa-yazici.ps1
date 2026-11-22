# LafPOS kasa ekrani acilmadan once (LafPOS-Kasa.bat, oturumdaki kullanici): bilgisayardaki yazicilari LafPOS'a bildirir
# ve LafPOS'un sectigi fis yazicisini bu kullanicinin varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma
# (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis yazicisi kurulup tek basina takiliysa hic secim
# gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da secilir. Hata olursa sessizce cikar: kasa ekrani
# yine acilir. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([string]$Url = $env:LAFPOS_URL, [switch]$Bekci)
$ErrorActionPreference = 'Stop'

# Musteri ekrani (22 Kas 2026): bilgisayara ikinci ekran takiliysa musteri ekrani orada tam ekran acilir (ayri Chrome
# profili; kasa penceresinden bagimsiz). Bu betik -Bekci ile arka planda bir kez daha baslar ve 15 sn'de bir bakar:
# pencere kapandiysa ya da ikinci ekran sonradan takildiysa yeniden acar (tek bekci). Ekran olcegi (%125) pencereyi
# birinci ekrana dusurmesin diye surec DPI'ya duyarli yapilir (Screen.Bounds gercek piksel). Sahadaki gecici bekci
# (%LocalAppData%\LafPOS-MusteriEkrani, Baslangic'ta "LafPOS Musteri Ekrani") kapatilir: iki pencere acilmaz.
# Betik guncellemeyle gelir (app\); LafPOS-Kasa.bat her acilista calistirir. Hata kasayi durdurmaz. Yalniz ASCII.
try {
  Add-Type -Namespace LafPos -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction SilentlyContinue
  [LafPos.Dpi]::SetProcessDPIAware() | Out-Null
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

function Start-CustomerDisplay([string]$base) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $second = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $second) { return }
    $running = Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | Select-Object -First 1
    if ($running) { return }
    $exe = Get-DisplayExe
    if (-not $exe) { return }
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
  } catch { }
}

function Stop-TemporaryDisplayWatcher {
  try {
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LafPOS Musteri Ekrani.lnk'
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force }
    Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*LafPOS-MusteriEkrani*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

$displayBase = $Url
if (-not $displayBase) { $displayBase = 'http://localhost:4000/' }
$displayBase = ($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/')

if ($Bekci) {
  # Arka plan bekcisi: musteri ekrani penceresini acik tutar (kasa bilgisayari kapanana dek)
  while ($true) {
    Start-CustomerDisplay $displayBase
    Start-Sleep -Seconds 15
  }
}

# Kasa hazirligi kisayolu (Baslat > LafPOS > Kasa hazirligi) ve eski kasa programi uyarisi (haftada en cok bir kez)
try {
  $hazirla = Join-Path $PSScriptRoot 'kasa-hazirla.ps1'
  if (Test-Path $hazirla) {
    $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LafPOS'
    $lnk = Join-Path $menu 'Kasa hazirligi.lnk'
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
  $watching = Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*kasa-yazici.ps1*-Bekci*' } | Select-Object -First 1
  if ($me -and -not $watching) {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $me + '"'), '-Bekci') | Out-Null
  }
} catch { }

try {
  if (-not $Url) { $Url = 'http://localhost:4000/' }
  # Sunucu IPv4 dinler; localhost once IPv6 denenip yavaslar
  $base = ($Url -replace '//localhost', '//127.0.0.1').TrimEnd('/')
  $list = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; PortName = $_.PortName; DriverName = $_.DriverName; Default = [bool]$_.Default; WorkOffline = [bool]$_.WorkOffline }
    })
  $body = ConvertTo-Json -InputObject @{ printers = $list } -Depth 4 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $res = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Method Post -Uri ($base + '/api/kasa/yazicilar') -ContentType 'application/json; charset=utf-8' -Body $bytes
  $name = [string]$res.name
  if (-not $name) { exit 0 }
  # Windows 10/11 "varsayilan yaziciyi Windows yonetsin" kapali: secilen yazici son kullanilanla degismez
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord
  $printer = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($printer -and -not $printer.Default) { Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter | Out-Null }
} catch {
  exit 0
}
exit 0
