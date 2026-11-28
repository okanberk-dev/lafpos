# AsilPOS kisayollarini yazar: guncellemede bekci (kurulum-yenile.mjs, SYSTEM olarak) ve kurulumda iki kurulum da
# (asilpos.nsi ve web-kurucu.ps1, "node app\kurulum-yenile.mjs kisayollar"; ayni liste). -Liste: kisayollarin JSON listesi
# (UTF-8): klasor (.NET ozel klasor adi: CommonPrograms, CommonDesktopDirectory, CommonStartup), ad, hedef, arguman,
# aciklama, pencere, ikon, calismaKlasoru, dosya (kisayolun calistirdigi dosya), grup (kurulumda secilebilen grup), kosul
# (guncellemede: ayni klasorde bu dosyalardan hicbiri yoksa atlanir), eski (kisayol yazilinca ayni klasorden silinen eski
# adlar); url ve ikonDosyasi olan oge Internet kisayoludur (.url). Her kisayol yeniden yazilir (ayni ad: idempotent). Hedefi
# ya da dosyasi olmayan kisayol yazilmaz, eskisi de silinmez (hata sayilir: kok dosya konamadiysa calisan eski kisayol
# kalir, sonraki acilista yeniden denenir).
# -Kur -Gruplar masaustu,baslangic (kurulum): grubu secilen oge kosulsuz yazilir, secilmeyen atlanir.
# -EskiMenu/-YeniMenu: hepsi yazildiysa Baslat menusunun eski klasorunde kalanlar (kaldirma, tarayici kisayolu) adlari
# yeni adla yeni klasore tasinir, eski klasor silinir (ad degisikligi, 26 Kasim 2026).
# -Kurulum/-Kayit/-Kaldirici: Uygulamalar kaydi (once, kisayollardan once): kurulum dosyasinin ad degisikliginden onceki
# kaldiricisi (Kaldir.exe; kayitta gorunen ad henuz yeni ad degil) yeni adli kisayollari bilmez, kaldirilinca Baslangic'taki
# kasa kisayolu kalir ve her oturumda olu adrese tam ekran acar. Kaldirma siteden kurulumun kaldiricisina (-Kaldirici,
# iki adi da siler) gecer: kurulum klasorune kopyalanir, kayit ve Baslat menusundeki kaldirma kisayolu ona doner, eski
# Kaldir.exe silinir. Sonra kayitta gorunen ad yeni ad, simge yeni simge olur. Bu adim olmazsa hicbir kisayol degismez
# (eski kaldirici eski adlari bilir).
# -Surum (guncelleme, 28 Kas 2026): Uygulamalar kaydinda surum (DisplayVersion), boyut (EstimatedSize, kurulum klasoru, KB)
# ve tarih (InstallDate, yyyyMMdd) yenilenir; otomatik guncelleme yalniz app\ ve node\'u degistirir, kayit kurulumdaki
# surumde kaliyordu. Yazilamazsa "UYARI surum: <neden>" (kisayollar yine yazilir, sorunlu adim sayilmaz).
# Ciktida sorunlu her adim icin "HATA <sira>: <neden>"; cikis kodu sorunlu adim sayisi. Betik guncellemeyle gelir
# (app\). Yalniz ASCII (Windows PowerShell 5.1 BOM'suz dosyayi ANSI okur).
param([Parameter(Mandatory = $true)][string]$Liste, [string]$EskiMenu = '', [string]$YeniMenu = '', [string]$Kurulum = '', [string]$Kayit = '', [string]$Kaldirici = '', [switch]$Kur, [string]$Gruplar = '', [string]$Surum = '')
$ErrorActionPreference = 'Stop'
$hata = 0
$secili = @($Gruplar.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# Kisayol adi Turkce harfli olabilir (AsilPOS ayarlar{i}.lnk). WScript.Shell'in kisayol nesnesi dosya yolunu Windows'un
# "Unicode olmayan programlar" diline (ANSI) cevirir: Turkce olmayan Windows'ta (Windows CI, 27 Kas 2026) ad en yakin harfle
# yazilir (ayarlari.lnk), dogru adli kisayol da okunamaz. Kisayol ayni klasorde ASCII adli gecici kopyada acilir ve
# yazilir; asil adina .NET kopyalar (Unicode). Turkce Windows'ta ad zaten dogruydu: sonuc ayni
function New-TempLink([string]$dir) {
  return Join-Path $dir ('~asilpos-' + [guid]::NewGuid().ToString('N') + '.lnk')
}
try {
  # PowerShell 5.1'de ConvertFrom-Json diziyi tek nesne olarak verir: ForEach-Object diziyi ogelerine acar
  $parsed = ConvertFrom-Json (Get-Content -LiteralPath $Liste -Raw -Encoding UTF8)
  $items = @($parsed | ForEach-Object { $_ })
  $sh = New-Object -ComObject WScript.Shell
} catch {
  Write-Output ('HATA liste: ' + $_.Exception.Message)
  exit 1
}

if ($Kurulum -and $Kayit -and $YeniMenu) {
  try {
    if (Test-Path -LiteralPath $Kayit) {
      $exe = Join-Path $Kurulum 'Kaldir.exe'
      $gorunen = [string](Get-ItemProperty -LiteralPath $Kayit).DisplayName
      if ((Test-Path -LiteralPath $exe) -and $gorunen -ne $YeniMenu) {
        if (-not ($Kaldirici -and (Test-Path -LiteralPath $Kaldirici))) { throw ('kaldirici pakette yok: ' + $Kaldirici) }
        $ps1 = Join-Path $Kurulum (Split-Path -Leaf $Kaldirici)
        Copy-Item -LiteralPath $Kaldirici -Destination $ps1 -Force
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $psArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $ps1 + '"'
        $ikon = Join-Path $Kurulum 'asilpos.ico'
        # Baslat menusundeki kaldirma kisayolu (eski klasorde de olabilir; asagida yeni klasore tasinir)
        foreach ($m in @($EskiMenu, $YeniMenu)) {
          if (-not $m) { continue }
          $mk = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $m
          if (-not (Test-Path -LiteralPath $mk)) { continue }
          foreach ($f in @(Get-ChildItem -LiteralPath $mk -Filter '*.lnk' -File -Force)) {
            if ($f.Name -like '~asilpos-*') { continue }
            # Kaldirma kisayolunun adi Turkce harfli (AsilPOS'u kald{i}r.lnk): ASCII adli kopyadan okunur
            $gecici = New-TempLink $mk
            try {
              [System.IO.File]::Copy($f.FullName, $gecici, $true)
              $l = $sh.CreateShortcut($gecici)
              if ([string]$l.TargetPath -eq $exe) {
                $l.TargetPath = $psExe
                $l.Arguments = $psArg
                $l.WorkingDirectory = $Kurulum
                if (Test-Path -LiteralPath $ikon) { $l.IconLocation = $ikon + ',0' }
                $l.Save()
                [System.IO.File]::Copy($gecici, $f.FullName, $true)
              }
            } finally {
              Remove-Item -LiteralPath $gecici -Force -ErrorAction SilentlyContinue
            }
          }
        }
        Set-ItemProperty -LiteralPath $Kayit -Name 'UninstallString' -Value ('"' + $psExe + '" ' + $psArg)
        # Sessiz kaldirma eski Kaldir.exe'yi cagirirdi; PowerShell kaldiricisi soru sorar, sessiz satiri yoktur
        Remove-ItemProperty -LiteralPath $Kayit -Name 'QuietUninstallString' -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $exe -Force
      }
      if (-not (Test-Path -LiteralPath $exe) -or $gorunen -eq $YeniMenu) {
        if ($gorunen -ne $YeniMenu) { Set-ItemProperty -LiteralPath $Kayit -Name 'DisplayName' -Value $YeniMenu }
        $ikon = Join-Path $Kurulum 'asilpos.ico'
        if (Test-Path -LiteralPath $ikon) { Set-ItemProperty -LiteralPath $Kayit -Name 'DisplayIcon' -Value $ikon }
      }
    }
  } catch {
    Write-Output ('HATA kaldirici: ' + $_.Exception.Message)
    exit 1
  }
}

if ($Kayit -and $Surum) {
  try {
    if (Test-Path -LiteralPath $Kayit) {
      Set-ItemProperty -LiteralPath $Kayit -Name 'DisplayVersion' -Value $Surum
      Set-ItemProperty -LiteralPath $Kayit -Name 'InstallDate' -Value ([DateTime]::Now.ToString('yyyyMMdd', [System.Globalization.CultureInfo]::InvariantCulture))
      if ($Kurulum -and (Test-Path -LiteralPath $Kurulum)) {
        $boyut = [int]((Get-ChildItem -LiteralPath $Kurulum -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1024)
        New-ItemProperty -LiteralPath $Kayit -Name 'EstimatedSize' -Value $boyut -PropertyType DWord -Force | Out-Null
      }
    }
  } catch {
    Write-Output ('UYARI surum: ' + $_.Exception.Message)
  }
}

$sira = 0
foreach ($k in $items) {
  $sira++
  try {
    $kok = [Environment]::GetFolderPath([Environment+SpecialFolder]([string]$k.klasor))
    if (-not $kok) { throw ('klasor bulunamadi: ' + $k.klasor) }
    if ($Kur) {
      if ($k.grup -and -not ($secili -contains [string]$k.grup)) { continue }
    } elseif ($k.kosul) {
      $var = $false
      foreach ($ad in @($k.kosul)) { if ($ad -and (Test-Path -LiteralPath (Join-Path $kok ([string]$ad)))) { $var = $true } }
      if (-not $var) { continue }
    }
    $yol = Join-Path $kok ([string]$k.ad)
    $dir = Split-Path -Parent $yol
    if ($k.url) {
      # Internet kisayolu (.url): tarayicida acilan adres ve simge
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Set-Content -LiteralPath $yol -Value @('[InternetShortcut]', ('URL=' + [string]$k.url), ('IconFile=' + [string]$k.ikonDosyasi), 'IconIndex=0') -Encoding ASCII
      continue
    }
    if (-not (Test-Path -LiteralPath ([string]$k.hedef))) { throw ('hedef yok: ' + $k.hedef) }
    if ($k.dosya -and -not (Test-Path -LiteralPath ([string]$k.dosya))) { throw ('dosya yok: ' + $k.dosya) }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # ASCII adli gecici kopyada yazilir, asil (Turkce harfli olabilen) adina kopyalanir (yukarida New-TempLink)
    $gecici = New-TempLink $dir
    try {
      if (Test-Path -LiteralPath $yol) { [System.IO.File]::Copy($yol, $gecici, $true) }
      $s = $sh.CreateShortcut($gecici)
      $s.TargetPath = [string]$k.hedef
      $s.Arguments = [string]$k.arguman
      $s.WorkingDirectory = [string]$k.calismaKlasoru
      $s.IconLocation = [string]$k.ikon
      $s.WindowStyle = [int]$k.pencere
      $s.Description = [string]$k.aciklama
      $s.Save()
      [System.IO.File]::Copy($gecici, $yol, $true)
    } finally {
      Remove-Item -LiteralPath $gecici -Force -ErrorAction SilentlyContinue
    }
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
