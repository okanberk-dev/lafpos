# LafPOS kisayollarini yeniler (bekci, kurulum-yenile.mjs; SYSTEM olarak). -Liste: kisayollarin JSON listesi (UTF-8):
# klasor (.NET ozel klasor adi: CommonPrograms, CommonDesktopDirectory, CommonStartup), ad, hedef, arguman, aciklama,
# pencere, ikon, calismaKlasoru, kosul (ayni klasorde bu dosya yoksa atlanir). Her kisayol yeniden yazilir (ayni ad:
# idempotent). Ciktida sorunlu her kisayol icin "HATA <sira>: <neden>"; cikis kodu sorunlu kisayol sayisi.
# Betik guncellemeyle gelir (app\). Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([Parameter(Mandatory = $true)][string]$Liste)
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
    if ($k.kosul -and -not (Test-Path -LiteralPath (Join-Path $kok ([string]$k.kosul)))) { continue }
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
  } catch {
    $hata++
    Write-Output ('HATA ' + $sira + ': ' + $_.Exception.Message)
  }
}
exit $hata
