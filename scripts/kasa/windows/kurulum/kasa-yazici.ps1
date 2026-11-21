# LafPOS kasa ekrani acilmadan once (LafPOS-Kasa.bat, oturumdaki kullanici): bilgisayardaki yazicilari LafPOS'a bildirir
# ve LafPOS'un sectigi fis yazicisini bu kullanicinin varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma
# (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis yazicisi kurulup tek basina takiliysa hic secim
# gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da secilir. Hata olursa sessizce cikar: kasa ekrani
# yine acilir. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([string]$Url = $env:LAFPOS_URL)
$ErrorActionPreference = 'Stop'
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
