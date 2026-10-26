# LafPOS kasa bilgisayari kurulumu (Windows 10/11). Ayrinti: docs/05-KASA-BILGISAYARI.md
#   Kur:    powershell -ExecutionPolicy Bypass -File scripts\kasa\windows\kur.ps1
#   Kaldir: powershell -ExecutionPolicy Bypass -File scripts\kasa\windows\kur.ps1 -Kaldir
# Oturum acilinca LafPOS sunucusu gorunmeden baslar (Gorev Zamanlayici, cokerse 1 dk sonra yeniden),
# ardindan kasa ekrani kiosk Chrome'da acilir (Baslangic klasorundeki kisayol). Masaustune de kisayol konur.
param([switch]$Kaldir)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$task = "LafPOS Sunucu"
$startup = [Environment]::GetFolderPath("Startup")
$desktop = [Environment]::GetFolderPath("Desktop")

if ($Kaldir) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item "$startup\LafPOS Kasa.lnk", "$desktop\LafPOS Kasa.lnk" -ErrorAction SilentlyContinue
  Write-Host "LafPOS otomatik baslatma kaldirildi (veriler duruyor: $repo\data)."
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js bulunamadi (22.11 ya da ustu): https://nodejs.org" }
if (-not (Test-Path "$repo\dist\web\index.html")) { throw "Once derleyin: npm ci; npm run build" }
New-Item -ItemType Directory -Force "$repo\data" | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start >> `"$repo\data\sunucu.log`" 2>&1" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description "LafPOS yerel sunucusu (kasa, tabletler ve telefonlar buna baglanir)" -Force | Out-Null

$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in @($startup, $desktop)) {
  $lnk = $wsh.CreateShortcut("$dir\LafPOS Kasa.lnk")
  $lnk.TargetPath = "$repo\scripts\kasa\windows\LafPOS-Kasa.bat"
  $lnk.WorkingDirectory = $repo
  $lnk.WindowStyle = 7
  $lnk.Description = "LafPOS kasa ekrani (kiosk)"
  $lnk.Save()
}
Start-ScheduledTask -TaskName $task
Write-Host "Tamam: oturum acilinca LafPOS sunucusu ve kasa ekrani acilacak. Simdi denemek icin masaustundeki 'LafPOS Kasa'."
