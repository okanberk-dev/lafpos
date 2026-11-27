# YALNIZ GELISTIRICI ICIN: git deposundan AsilPOS (Windows 10/11). Kafedeki kasa bilgisayari buna degil,
# NSIS kurulum dosyasina kurulur (AsilPOS-Kurulum-<surum>.exe; npm run kurulum:windows). Bu betik sunucuyu
# tsx ile (npm start) calistirir: TypeScript her acilista yeniden derlenir, bellek siniri yok, bekci yok ve
# data\sunucu.log hic donmez, buyur. Ayrinti: docs/05-KASA-BILGISAYARI.md ("Git ile")
#   Kur:    powershell -ExecutionPolicy Bypass -File scripts\kasa\windows\kur.ps1
#   Kaldir: powershell -ExecutionPolicy Bypass -File scripts\kasa\windows\kur.ps1 -Kaldir
# Oturum acilinca AsilPOS sunucusu gorunmeden baslar (Gorev Zamanlayici, cokerse 1 dk sonra yeniden),
# ardindan kasa ekrani kiosk Chrome'da acilir (Baslangic klasorundeki kisayol). Masaustune de kisayol konur.
param([switch]$Kaldir)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$task = "LafPOS Sunucu"
$startup = [Environment]::GetFolderPath("Startup")
$desktop = [Environment]::GetFolderPath("Desktop")
# Ad degisikligi (26 Kas 2026) oncesinin kisayolu: kaldirmada ve yeniden kurulumda silinir
$eskiKisayol = "LafPOS Kasa.lnk" # eski-ad

if ($Kaldir) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item "$startup\AsilPOS Kasa.lnk", "$desktop\AsilPOS Kasa.lnk", "$startup\$eskiKisayol", "$desktop\$eskiKisayol" -ErrorAction SilentlyContinue
  Write-Host "AsilPOS otomatik baslatma kaldirildi (veriler duruyor: $repo\data)."
  exit 0
}

Write-Warning "Gelistirici kurulumu (git). Kafedeki kasa bilgisayarina AsilPOS-Kurulum-<surum>.exe kurulur: docs/05-KASA-BILGISAYARI.md"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js bulunamadi (22.11 ya da ustu): https://nodejs.org" }
if (-not (Test-Path "$repo\dist\web\index.html")) { throw "Once derleyin: npm ci; npm run build" }
New-Item -ItemType Directory -Force "$repo\data" | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start >> `"$repo\data\sunucu.log`" 2>&1" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description "AsilPOS yerel sunucusu (kasa, tabletler ve telefonlar buna baglanir)" -Force | Out-Null

$wsh = New-Object -ComObject WScript.Shell
Remove-Item "$startup\$eskiKisayol", "$desktop\$eskiKisayol" -ErrorAction SilentlyContinue
foreach ($dir in @($startup, $desktop)) {
  $lnk = $wsh.CreateShortcut("$dir\AsilPOS Kasa.lnk")
  $lnk.TargetPath = "$repo\scripts\kasa\windows\AsilPOS-Kasa.bat"
  $lnk.WorkingDirectory = $repo
  $lnk.WindowStyle = 7
  $lnk.Description = "AsilPOS kasa ekrani (kiosk)"
  $lnk.Save()
}
Start-ScheduledTask -TaskName $task
Write-Host "Tamam: oturum acilinca AsilPOS sunucusu ve kasa ekrani acilacak. Simdi denemek icin masaustundeki 'AsilPOS Kasa'."
