# AsilPOS yonetim kisayollari (Baslat > AsilPOS). Veri klasoru yalniz yoneticilere acik, bu yuzden izin ister.
#   ayarlar          ayarlar.env Not Defteri'nde acilir; kaydedince (Ctrl+S) bekci sunucuyu yeni ayarlarla baslatir
#   yeniden-baslat   sunucuyu yeniden baslatir
#   gunluk           sunucu gunlugunu acar
# Dosya ASCII kalir: Windows PowerShell 5.1 BOM'suz dosyayi yerel kod sayfasiyla okur.
param([Parameter(Position = 0)][ValidateSet('ayarlar', 'yeniden-baslat', 'gunluk')][string]$Islem = 'yeniden-baslat')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $Islem)
  exit
}

$data = Join-Path $env:ProgramData 'LafPOS' # eski-ad: kurulu kasanin veri klasoru
$task = 'LafPOS Sunucu'

function Restart-AsilPOS {
  schtasks.exe /End /TN $task 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  schtasks.exe /Run /TN $task 2>&1 | Out-Null
}

switch ($Islem) {
  # Yeniden baslatmayi bekci yapar (dosyayi izler): Windows 11 Not Defteri sekmeyle acildiginda -Wait beklemez
  'ayarlar' { Start-Process notepad.exe -ArgumentList "`"$data\ayarlar.env`"" }
  'yeniden-baslat' { Restart-AsilPOS }
  'gunluk' { Start-Process notepad.exe -ArgumentList "`"$data\logs\sunucu.log`"" }
}
