# AsilPOS'u kaldırır: siteden kurulumun (AsilPOS-Kur.cmd) kaldırıcısı, kurulum klasörüne LafPOS-Kaldir.ps1 olarak yazılır.
# Kurulum dosyasıyla (AsilPOS-Kurulum.exe) kurulan bilgisayarda Kaldir.exe aynı işi yapar; ad değişikliğinden önceki
# kurulum dosyasıyla kurulup kendiliğinden güncellenen bilgisayarda eski Kaldir.exe'nin yerine bu çalışır
# (kisayollar.ps1). Veriler ve yedekler (C:\ProgramData\LafPOS) silinmez. Windows PowerShell 5.1 ile uyumlu kalır
# (tests/web-kurucu.test.ts).

$ErrorActionPreference = 'Continue'
$kimlik = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $kimlik.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  exit
}

$cevap = Read-Host 'AsilPOS bu bilgisayardan kaldırılsın mı? Veriler silinmez. (E/H)'
if ($cevap -notmatch '^\s*[eEyY]') { exit }

$kur = Split-Path -Parent $PSCommandPath
$veri = Join-Path $env:ProgramData 'LafPOS' # eski-ad: kurulu kasanın veri klasörü
$sys = Join-Path $env:SystemRoot 'System32'
$gorev = 'LafPOS Sunucu'

& (Join-Path $sys 'schtasks.exe') /End /TN $gorev 2>&1 | Out-Null
& (Join-Path $sys 'schtasks.exe') /Delete /TN $gorev /F 2>&1 | Out-Null
Start-Sleep -Seconds 2
& (Join-Path $sys 'netsh.exe') advfirewall firewall delete rule ('name=' + $gorev) 2>&1 | Out-Null

Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'AsilPOS Kasa.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'AsilPOS Kasa.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'AsilPOS Kasa Bekcisi.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'AsilPOS') -Recurse -Force -ErrorAction SilentlyContinue
# Ad değişikliğinden (26 Kasım 2026) önceki kısayollar: güncellemeyle yenisine geçmemiş olabilir
$eskiAd = 'LafPOS' # eski-ad: shared/eski-adlar.ts
foreach ($ozel in @('CommonDesktopDirectory', 'CommonStartup')) {
  foreach ($ad in @(($eskiAd + ' Kasa.lnk'), ($eskiAd + ' Kasa Bekcisi.lnk'))) {
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath($ozel)) $ad) -Force -ErrorAction SilentlyContinue
  }
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $eskiAd) -Recurse -Force -ErrorAction SilentlyContinue

foreach ($ad in @('app', 'node', 'app.eski', 'app.yeni', 'app.bozuk', 'node.eski', 'node.yeni', 'kurulum.gecici', 'baslat.cmd', 'AsilPOS-Kasa.bat', 'LafPOS-Kasa.bat', 'yonet.ps1', 'asilpos.ico', 'lafpos.ico', 'BENIOKU.txt', 'ayarlar.env.ornek', 'Kaldir.exe', 'LafPOS-Kaldir.ps1')) {
  Remove-Item -LiteralPath (Join-Path $kur $ad) -Recurse -Force -ErrorAction SilentlyContinue
}
# Klasör yalnız boşsa silinir (içine başka bir şey konduysa kalır)
if (-not (Get-ChildItem -LiteralPath $kur -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $kur -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\LafPOS' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ('AsilPOS kaldırıldı. Veriler ve yedekler silinmedi: ' + $veri)
[void](Read-Host 'Pencereyi kapatmak için Enter tuşuna basın')
