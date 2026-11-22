# LafPOS kasa hazirligi (Baslat > LafPOS > Kasa hazirligi): bilgisayar yeniden acilinca her sey kendiliginden calissin
# diye istege bagli Windows ayarlari. Her adim once sorulur (Evet / Hayir); hicbir sey sormadan degismez, hicbir parola
# saklanmaz. -SadeceModpos: yalniz eski "Modpos & Gafdigi POS" acilista basliyor mu bakar ve uyarir (silmez).
# Betik guncellemeyle gelir (app\). Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([switch]$SadeceModpos)
Add-Type -AssemblyName System.Windows.Forms

function Sor([string]$metin) {
  return [System.Windows.Forms.MessageBox]::Show($metin, 'LafPOS kasa hazirligi', 'YesNo', 'Question') -eq 'Yes'
}
function Bilgi([string]$metin) {
  [System.Windows.Forms.MessageBox]::Show($metin, 'LafPOS kasa hazirligi', 'OK', 'Information') | Out-Null
}

# Acilista baslayan eski kasa programi (Baslangic klasorleri ve Run kayitlari): yalniz listelenir, silinmez
function Get-ModposStartup {
  $bul = @()
  $klasorler = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp'))
  foreach ($k in $klasorler) {
    if (Test-Path $k) { Get-ChildItem -LiteralPath $k -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'modpos|gafdigi' } | ForEach-Object { $bul += $_.BaseName } }
  }
  foreach ($r in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')) {
    try {
      $p = Get-ItemProperty -Path $r -ErrorAction Stop
      foreach ($n in $p.PSObject.Properties) { if (($n.Name + ' ' + $n.Value) -match 'modpos|gafdigi') { $bul += $n.Name } }
    } catch { }
  }
  return ($bul | Select-Object -Unique)
}

function Uyar-Modpos {
  $liste = @(Get-ModposStartup)
  if (-not $liste.Count) { return $false }
  $ac = Sor ("Eski kasa programi bilgisayar acilinca hala basliyor:`n`n  " + ($liste -join "`n  ") + "`n`nLafPOS'a tam gectiyseniz acilista baslamasini kapatmaniz onerilir (program silinmez). Windows'un 'Baslangic uygulamalari' ekrani acilsin mi?")
  if ($ac) { Start-Process 'ms-settings:startupapps' }
  return $true
}

if ($SadeceModpos) {
  Uyar-Modpos | Out-Null
  exit 0
}

# Ayarlarin cogu yonetici ister: gerekirse yonetici olarak yeniden acilir (Windows izin sorar)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

$yapilan = @()
if (Sor "Ekran ve bilgisayar hic kapanmasin / uykuya gecmesin mi? (Kasa ve musteri ekrani gun boyu acik kalir)") {
  powercfg.exe /change monitor-timeout-ac 0 | Out-Null
  powercfg.exe /change standby-timeout-ac 0 | Out-Null
  powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
  $yapilan += 'Ekran ve uyku: hicbir zaman kapanmaz'
}
if (Sor "Windows Update kafenin calisma saatlerinde (07:00 - 01:00) yeniden baslatmasin mi? (Guncellemeler gece kurulur)") {
  try {
    $k = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
    if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
    Set-ItemProperty -Path $k -Name 'SmartActiveHoursState' -Value 0 -Type DWord
    Set-ItemProperty -Path $k -Name 'ActiveHoursStart' -Value 7 -Type DWord
    Set-ItemProperty -Path $k -Name 'ActiveHoursEnd' -Value 1 -Type DWord
    $yapilan += 'Windows Update etkin saatleri: 07:00 - 01:00'
  } catch { $yapilan += 'Windows Update etkin saatleri ayarlanamadi' }
}
if (Sor "Ag karti guc tasarrufu kapatilsin mi? (Windows ag kartini kapatip Pavo ve tabletlerle baglantiyi koparmasin)") {
  try {
    Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object { Set-NetAdapterPowerManagement -Name $_.Name -AllowComputerToTurnOffDevice Disabled -ErrorAction SilentlyContinue }
    $yapilan += 'Ag karti guc tasarrufu: kapali'
  } catch { $yapilan += 'Ag karti guc tasarrufu ayarlanamadi' }
}
if (Sor "Bilgisayar acilinca otomatik oturum acilsin mi? Windows'un kendi 'Kullanici hesaplari' ekrani acilir: 'Kullanicilar bu bilgisayari kullanmak icin...' kutusunun isaretini kaldirip parolanizi orada girin. LafPOS parolanizi saklamaz.") {
  Start-Process 'netplwiz.exe'
  $yapilan += 'Otomatik oturum: Windows ekrani acildi'
}
if (Uyar-Modpos) { $yapilan += 'Eski kasa programi uyarisi gosterildi' }
Bilgi ("Tamamlandi.`n`n" + ($(if ($yapilan.Count) { $yapilan -join "`n" } else { 'Hicbir ayar degismedi.' })) + "`n`nLafPOS sunucusu, kasa ekrani ve musteri ekrani bilgisayar acilinca kendiliginden baslar.")
