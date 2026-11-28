# AsilPOS kasa hazirligi (Baslat > AsilPOS > Kasa hazirligi): bilgisayar yeniden acilinca her sey kendiliginden calissin
# diye istege bagli Windows ayarlari. Her adim once sorulur (Evet / Hayir); hicbir sey sormadan degismez, hicbir parola
# saklanmaz. Betik guncellemeyle gelir (app\). Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
#
# Eski kasa programi uyarisi kalkti (28 Kas 2026, sahibin istegi): kasa acilisinda haftada bir cikan "eski kasa programi
# bilgisayar acilinca hala basliyor" sorusu da, buradaki ayni soru da. -SadeceModpos o haftalik cagrinin anahtariydi:
# eski surumden kalan bir cagri (guncelleme anina denk gelen eski kasa programi) hata gostermesin diye kabul edilir,
# betik hicbir sey yapmadan cikar.
param([switch]$SadeceModpos)
if ($SadeceModpos) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms

function Sor([string]$metin) {
  return [System.Windows.Forms.MessageBox]::Show($metin, 'AsilPOS kasa hazirligi', 'YesNo', 'Question') -eq 'Yes'
}
function Bilgi([string]$metin) {
  [System.Windows.Forms.MessageBox]::Show($metin, 'AsilPOS kasa hazirligi', 'OK', 'Information') | Out-Null
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
if (Sor "Bilgisayar acilinca otomatik oturum acilsin mi? Windows'un kendi 'Kullanici hesaplari' ekrani acilir: 'Kullanicilar bu bilgisayari kullanmak icin...' kutusunun isaretini kaldirip parolanizi orada girin. AsilPOS parolanizi saklamaz.") {
  Start-Process 'netplwiz.exe'
  $yapilan += 'Otomatik oturum: Windows ekrani acildi'
}
Bilgi ("Tamamlandi.`n`n" + ($(if ($yapilan.Count) { $yapilan -join "`n" } else { 'Hicbir ayar degismedi.' })) + "`n`nAsilPOS sunucusu, kasa ekrani ve musteri ekrani bilgisayar acilinca kendiliginden baslar.")
