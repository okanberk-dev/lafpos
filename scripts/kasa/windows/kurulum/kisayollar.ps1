# AsilPOS kisayollarini yeniler (bekci, kurulum-yenile.mjs; SYSTEM olarak). -Liste: kisayollarin JSON listesi (UTF-8):
# klasor (.NET ozel klasor adi: CommonPrograms, CommonDesktopDirectory, CommonStartup), ad, hedef, arguman, aciklama,
# pencere, ikon, calismaKlasoru, kosul (ayni klasorde bu dosyalardan hicbiri yoksa atlanir), eski (kisayol yazilinca
# ayni klasorden silinen eski adlar). Her kisayol yeniden yazilir (ayni ad: idempotent). -EskiMenu/-YeniMenu: hepsi
# yazildiysa Baslat menusunun eski klasorunde kalanlar (kaldirma, tarayici kisayolu) adlari yeni adla yeni klasore
# tasinir, eski klasor silinir (ad degisikligi, 26 Kasim 2026). Ciktida sorunlu her kisayol icin "HATA <sira>: <neden>";
# cikis kodu sorunlu kisayol sayisi. Betik guncellemeyle gelir (app\). Yalniz ASCII (Windows PowerShell 5.1 BOM'suz
# dosyayi ANSI okur).
param([Parameter(Mandatory = $true)][string]$Liste, [string]$EskiMenu = '', [string]$YeniMenu = '')
$ErrorActionPreference = 'Stop'
$hata = 0
try {
  # PowerShell 5.1'de ConvertFrom-Json diziyi tek nesne olarak verir: ForEach-Object diziyi ogelerine acar
  $parsed = ConvertFrom-Json (Get-Content -LiteralPath $Liste -Raw -Encoding UTF8)
  $items = @($parsed | ForEach-Object { $_ })
  $sh = New-Object -ComObject WScript.Shell
} catch {
  Write-Output ('HATA liste: ' + $_.Exception.Message)
  exit 1
}
$sira = 0
foreach ($k in $items) {
  $sira++
  try {
    $kok = [Environment]::GetFolderPath([Environment+SpecialFolder]([string]$k.klasor))
    if (-not $kok) { throw ('klasor bulunamadi: ' + $k.klasor) }
    if ($k.kosul) {
      $var = $false
      foreach ($ad in @($k.kosul)) { if ($ad -and (Test-Path -LiteralPath (Join-Path $kok ([string]$ad)))) { $var = $true } }
      if (-not $var) { continue }
    }
    $yol = Join-Path $kok ([string]$k.ad)
    $dir = Split-Path -Parent $yol
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $s = $sh.CreateShortcut($yol)
    $s.TargetPath = [string]$k.hedef
    $s.Arguments = [string]$k.arguman
    $s.WorkingDirectory = [string]$k.calismaKlasoru
    $s.IconLocation = [string]$k.ikon
    $s.WindowStyle = [int]$k.pencere
    $s.Description = [string]$k.aciklama
    $s.Save()
    foreach ($ad in @($k.eski)) {
      if (-not $ad) { continue }
      $eskiYol = Join-Path $kok ([string]$ad)
      if ($eskiYol -ne $yol -and (Test-Path -LiteralPath $eskiYol)) { Remove-Item -LiteralPath $eskiYol -Force }
    }
  } catch {
    $hata++
    Write-Output ('HATA ' + $sira + ': ' + $_.Exception.Message)
  }
}
if ($hata -eq 0 -and $EskiMenu -and $YeniMenu -and $EskiMenu -ne $YeniMenu) {
  try {
    $kok = [Environment]::GetFolderPath('CommonPrograms')
    $eski = Join-Path $kok $EskiMenu
    $yeni = Join-Path $kok $YeniMenu
    if ($kok -and (Test-Path -LiteralPath $eski)) {
      if (-not (Test-Path -LiteralPath $yeni)) { New-Item -ItemType Directory -Path $yeni -Force | Out-Null }
      foreach ($f in @(Get-ChildItem -LiteralPath $eski -File -Force)) {
        $hedef = Join-Path $yeni ($f.Name.Replace($EskiMenu, $YeniMenu))
        if (Test-Path -LiteralPath $hedef) { Remove-Item -LiteralPath $f.FullName -Force } else { Move-Item -LiteralPath $f.FullName -Destination $hedef -Force }
      }
      Remove-Item -LiteralPath $eski -Recurse -Force
    }
  } catch {
    $hata++
    Write-Output ('HATA menu: ' + $_.Exception.Message)
  }
}
exit $hata
