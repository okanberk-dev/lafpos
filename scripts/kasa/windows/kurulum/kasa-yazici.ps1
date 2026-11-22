# LafPOS kasa ekrani acilmadan once (LafPOS-Kasa.bat, oturumdaki kullanici): bilgisayardaki yazicilari LafPOS'a bildirir
# ve LafPOS'un sectigi fis yazicisini bu kullanicinin varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma
# (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis yazicisi kurulup tek basina takiliysa hic secim
# gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da secilir. Hata olursa sessizce cikar: kasa ekrani
# yine acilir. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([string]$Url = $env:LAFPOS_URL)
$ErrorActionPreference = 'Stop'

# Musteri ekrani (22 Kas 2026): bilgisayara ikinci ekran takiliysa musteri ekrani orada tam ekran acilir (ayri Chrome
# profili; kasa penceresinden bagimsiz, kasa kapatilip acilsa da kalir). Zaten aciksa yeniden acilmaz; ikinci ekran yoksa
# hicbir sey yapmaz. Betik guncellemeyle gelir (app\); LafPOS-Kasa.bat her acilista calistirir. Hata kasayi durdurmaz.
function Start-CustomerDisplay([string]$base) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $second = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $second) { return }
    $running = Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | Select-Object -First 1
    if ($running) { return }
    $candidates = @(
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
      (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
    $exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $exe) { return }
    $b = $second.Bounds
    $profileDir = Join-Path $env:LOCALAPPDATA 'LafPOS\chrome-musteri'
    $chromeArgs = @(
      '--kiosk',
      ('--app=' + $base + '/musteri-ekrani?ekran=kasa'),
      ('--user-data-dir="' + $profileDir + '"'),
      ('--window-position=' + $b.X + ',' + $b.Y),
      ('--window-size=' + $b.Width + ',' + $b.Height),
      '--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required'
    )
    Start-Process -FilePath $exe -ArgumentList $chromeArgs | Out-Null
  } catch { }
}
try {
  $displayBase = $Url
  if (-not $displayBase) { $displayBase = 'http://localhost:4000/' }
  Start-CustomerDisplay (($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/'))
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
