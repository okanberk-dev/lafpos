# Windows CI yardimcisi (ci-kurulum.mjs cagirir; .github/workflows/windows.yml). Kasaya gitmez (paket.mjs almaz).
# Kurulu programin Windows'taki halini JSON olarak okur ve kasa penceresini kisayolun yaptigi gibi acar:
#   kisayollar   Baslat menusu (AsilPOS ve eski adli klasor), ortak masaustu ve ortak Baslangic'taki AsilPOS kisayollari
#   surecler     kasa penceresi, musteri ekrani (Chrome/Edge ana surecleri) ve kasa bekcileri (powershell -Bekci)
#   on           on plandaki pencere (surec ve baslik) ve oturum (0: etkilesimsiz)
#   kayit        Uygulamalar listesindeki kayit
#   gorev        "LafPOS Sunucu" gorevinin XML'i (kayit tarihi ve yazar disinda)
#   duvar        guvenlik duvari kurallari
#   agac         kurulum klasoru: kok dosyalar (ozetle), app\ ve node\ dosyalarinin yollari
#   ac           -Kisayol'un hedefini ve argumanlarini bu surecin ortamiyla calistirir (kisayolun yaptigi)
#   kapat        kasa penceresini (kasa profiliyle calisan tarayicinin butun surecleri) kapatir
#   bekci-kapat  kasa bekcilerini kapatir
#   not-defteri  Not Defteri'ni acip one getirir (one getirme denemesi icin)
#   ekran        ekranin goruntusunu -Dosya'ya yazar
#   politika     Edge ve Chrome politikalari (HKLM ve HKCU): InPrivate'i zorlayan ya da cikista veriyi silen ayar var mi
# Yalniz ASCII (Windows PowerShell 5.1).
param([Parameter(Mandatory = $true)][string]$Islem, [string]$Kisayol = '', [string]$Dosya = '', [string]$Klasor = '', [string]$Profil = 'chrome')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Kisayol adlarindaki Turkce harfler (Sunucu gunlugu) Node'a bozulmadan gitsin
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Yerel komut (schtasks, netsh): Windows PowerShell 5.1'de hata akisi Stop'ta istisna olur
function Native([string]$exe, [string[]]$a) {
  $eski = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $exe @a 2>$null) -join "`n"
    return [ordered]@{ kod = $LASTEXITCODE; cikti = $out }
  } finally {
    $ErrorActionPreference = $eski
  }
}

function Json($x) { ConvertTo-Json -InputObject $x -Depth 6 -Compress }

function Read-Link([string]$yol) {
  if ($yol.EndsWith('.url')) {
    $url = (Get-Content -LiteralPath $yol | Where-Object { $_ -like 'URL=*' } | Select-Object -First 1)
    return [ordered]@{ yol = $yol; ad = (Split-Path -Leaf $yol); url = ([string]$url).Substring(4) }
  }
  # WScript.Shell kisayol yolunu ANSI'ye cevirir: Turkce harfli ad (AsilPOS ayarlar{i}.lnk) Turkce olmayan Windows'ta
  # okunamaz (bos doner). ASCII adli gecici kopyadan okunur (kisayollar.ps1 de boyle yazar)
  $gecici = Join-Path $env:TEMP ('asilpos-ci-' + [guid]::NewGuid().ToString('N') + '.lnk')
  try {
    [System.IO.File]::Copy($yol, $gecici, $true)
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($gecici)
    return [ordered]@{ yol = $yol; ad = (Split-Path -Leaf $yol); hedef = $l.TargetPath; arguman = $l.Arguments; calismaKlasoru = $l.WorkingDirectory; ikon = $l.IconLocation; pencere = $l.WindowStyle }
  } finally {
    Remove-Item -LiteralPath $gecici -Force -ErrorAction SilentlyContinue
  }
}

switch ($Islem) {
  'kisayollar' {
    $out = @()
    foreach ($ozel in @('CommonPrograms', 'CommonDesktopDirectory', 'CommonStartup')) {
      $kok = [Environment]::GetFolderPath($ozel)
      $adaylar = @()
      if ($ozel -eq 'CommonPrograms') {
        foreach ($m in @('AsilPOS', 'LafPOS')) { # eski-ad: kurulu kasanin adlari
          $d = Join-Path $kok $m
          if (Test-Path -LiteralPath $d) { $adaylar += @(Get-ChildItem -LiteralPath $d -File | ForEach-Object { $_.FullName }) }
        }
      } else {
        $adaylar = @(Get-ChildItem -LiteralPath $kok -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'AsilPOS*' -or $_.Name -like 'LafPOS*' } | ForEach-Object { $_.FullName }) # eski-ad: kurulu kasanin adlari
      }
      foreach ($y in $adaylar) {
        $k = Read-Link $y
        $k.klasor = $ozel
        $k.goreli = $y.Substring($kok.Length + 1)
        $out += , $k
      }
    }
    Json $out
  }
  'surecler' {
    $tarayici = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match '\\LafPOS\\' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { # eski-ad: kurulu kasanin adlari
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        [ordered]@{ pid = $_.ProcessId; ad = $_.Name; komut = $_.CommandLine; oturum = $_.SessionId; baslik = $(if ($p) { $p.MainWindowTitle } else { '' }); pencere = $(if ($p) { [int64]$p.MainWindowHandle } else { 0 }) }
      })
    $bekci = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*kasa-yazici.ps1*-Bekci*' } | ForEach-Object { [ordered]@{ pid = $_.ProcessId; komut = $_.CommandLine } })
    Json ([ordered]@{ tarayici = $tarayici; bekci = $bekci })
  }
  'on' {
    Add-Type -Namespace AsilPosCi -Name On -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
    $h = [AsilPosCi.On]::GetForegroundWindow()
    $p = [uint32]0
    [void][AsilPosCi.On]::GetWindowThreadProcessId($h, [ref]$p)
    $sb = New-Object System.Text.StringBuilder 512
    [void][AsilPosCi.On]::GetWindowText($h, $sb, 512)
    Json ([ordered]@{ pencere = [int64]$h; pid = [int]$p; baslik = $sb.ToString(); oturum = (Get-Process -Id $PID).SessionId; etkilesimli = [Environment]::UserInteractive })
  }
  'kayit' {
    $a = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\LafPOS'
    if (-not (Test-Path -LiteralPath $a)) { Json $null; break }
    $v = Get-ItemProperty -LiteralPath $a
    $o = [ordered]@{}
    foreach ($n in @('DisplayName', 'DisplayVersion', 'Publisher', 'DisplayIcon', 'InstallLocation', 'UninstallString', 'QuietUninstallString', 'NoModify', 'NoRepair')) { $o[$n] = $v.$n }
    Json $o
  }
  'gorev' {
    $r = Native (Join-Path $env:SystemRoot 'System32\schtasks.exe') @('/Query', '/TN', 'LafPOS Sunucu', '/XML') # eski-ad: gorev adi
    if ($r.kod -ne 0) { Json $null; break }
    $x = $r.cikti -replace '<Date>[^<]*</Date>', '' -replace '<Author>[^<]*</Author>', '' -replace '<URI>[^<]*</URI>', ''
    Json $x
  }
  'duvar' {
    $r = Native (Join-Path $env:SystemRoot 'System32\netsh.exe') @('advfirewall', 'firewall', 'show', 'rule', 'name=LafPOS Sunucu') # eski-ad: kural adi
    Json $r.cikti
  }
  'agac' {
    $kok = @(Get-ChildItem -LiteralPath $Klasor -File | Sort-Object Name | ForEach-Object { [ordered]@{ ad = $_.Name; ozet = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
    $klasorler = @(Get-ChildItem -LiteralPath $Klasor -Directory | Sort-Object Name | ForEach-Object { $_.Name })
    $dosyalar = @()
    foreach ($d in @('app', 'node')) {
      $tam = Join-Path $Klasor $d
      if (Test-Path -LiteralPath $tam) { $dosyalar += @(Get-ChildItem -LiteralPath $tam -File -Recurse | ForEach-Object { $_.FullName.Substring($Klasor.Length + 1) }) }
    }
    Json ([ordered]@{ kok = $kok; klasorler = $klasorler; dosyalar = @($dosyalar | Sort-Object) })
  }
  'ac' {
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($Kisayol)
    $stil = 'Normal'
    if ($l.WindowStyle -eq 7) { $stil = 'Minimized' }
    $wd = $l.WorkingDirectory
    if (-not $wd) { $wd = Split-Path -Parent $l.TargetPath }
    if ($l.Arguments) {
      $p = Start-Process -FilePath $l.TargetPath -ArgumentList $l.Arguments -WorkingDirectory $wd -WindowStyle $stil -PassThru
    } else {
      $p = Start-Process -FilePath $l.TargetPath -WorkingDirectory $wd -WindowStyle $stil -PassThru
    }
    Json ([ordered]@{ pid = $p.Id; hedef = $l.TargetPath; arguman = $l.Arguments })
  }
  'kapat' {
    $re = '\\LafPOS\\' + $Profil + '(?![\w-])' # eski-ad: kurulu kasanin adlari
    $n = 0
    Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match $re } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    Json $n
  }
  'bekci-kapat' {
    $n = 0
    Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*kasa-yazici.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    Json $n
  }
  'not-defteri' {
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\notepad.exe') -PassThru
    Start-Sleep -Seconds 2
    Json ([ordered]@{ pid = $p.Id })
  }
  'ekran' {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
      $bmp.Save($Dosya, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose()
      $bmp.Dispose()
      Json $true
    } catch {
      Json ('ekran alinamadi: ' + $_.Exception.Message)
    }
  }
  'politika' {
    $o = [ordered]@{}
    foreach ($k in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKCU:\SOFTWARE\Policies\Google\Chrome')) {
      if (-not (Test-Path -LiteralPath $k)) { continue }
      $d = [ordered]@{}
      $v = Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue
      if ($v) { foreach ($p in $v.PSObject.Properties) { if ($p.Name -notlike 'PS*') { $d[$p.Name] = [string]$p.Value } } }
      $o[$k] = $d
    }
    Json $o
  }
  default { throw ('bilinmeyen islem: ' + $Islem) }
}
