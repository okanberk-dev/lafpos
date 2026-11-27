# AsilPOS siteden kurulum: AsilPOS-Kur.cmd'nin PowerShell gövdesi (Windows PowerShell 5.1). Bu dosya tek başına
# çalışmaz: web-kurucu.mjs onu .cmd başlığının ardına koyar, iki yer tutucunun ($Gomulu ve $Dosyalar) yerine
# derlemenin değerlerini yazar. Kanal derlemesi (kanal.mjs) çıktıyı dist/web/guncelleme/AsilPOS-Kur.cmd'ye yazar.
#
# Kurulum dosyasıyla (asilpos.nsi) aynı programı kurar: aynı klasörler, görev, güvenlik duvarı, kısayollar (aynı listeden
# aynı betikle: app\kurulum-yenile.mjs kisayollar), Uygulamalar kaydı ve güncelleme kanalı. Farkı yalnız kaynağı (bu dosya
# programı internetten indirir, kurulum dosyası içinde taşır) ve kaldırıcısı (LafPOS-Kaldir.ps1, kurulum dosyasında
# Kaldir.exe). Testi tests/web-kurucu.test.ts ve tests/masaustu-programi.test.ts; gerçek Windows'ta CI (ci-kurulum.mjs).
#
# Ne yapar: yönetici izni ister; güncelleme kanalının surum.json'unu okur (okunamazsa
# dosyaya gömülü derlemeyi kullanır); Node'u nodejs.org'dan, better-sqlite3'ün Windows ikilisini GitHub'dan, uygulama
# yükünü kanaldan indirir ve üçünü de SHA-256 ile doğrular; çalışan sunucuyu durdurur, veritabanının kopyasını alır,
# Program Files\LafPOS'u kurar, "LafPOS Sunucu" görevini, güvenlik duvarı iznini, kısayolları, güç ayarlarını ve
# Uygulamalar listesindeki kaydı yazar, sunucuyu başlatır. Yeniden çalıştırmak onarır ya da son sürüme günceller;
# veriler (C:\ProgramData\LafPOS) ve ayarlar kalır. Anahtar ya da parola taşımaz.
#
# PowerShell 5.1 ile uyumlu kalır (tests/web-kurucu.test.ts denetler): boş birleştirme, üçlü koşul ve zincir işleçleri yok.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { $Host.UI.RawUI.WindowTitle = 'AsilPOS kurulumu' } catch { }

$Kaynak = $env:ASILPOS_KUR
$Kanal = @('https://lafpos.laffogato.net/guncelleme/', 'https://lafpos.vercel.app/guncelleme/')
# Yalnız CI denemesi (ci-kurulum.mjs): kanal bu bilgisayardaki yerel sunucudan okunur (başka adres kabul edilmez) ve
# kurulum soru sormadan biter (gün açıksa kurmaz, sonda Enter beklemez, kasa ekranını açmaz)
if ([string]$env:ASILPOS_KUR_KANAL -match '^http://127\.0\.0\.1:[0-9]{2,5}/[A-Za-z0-9/_-]*/$') { $Kanal = @([string]$env:ASILPOS_KUR_KANAL) }
$Sessiz = ([string]$env:ASILPOS_KUR_SESSIZ -eq '1')
$Gorev = 'LafPOS Sunucu'
$Port = 4000
$Gomulu = __GOMULU__
$Dosyalar = __DOSYALAR__
# Şubenin kurulum kodu: ladmin (Ayarlar › Şubeler) şubeye özel indirmede bu iki satırı doldurur (docs/03-ENTEGRASYON.md
# "Şube kurulumu"). Kod tek kullanımlıktır; kasa ilk açılışta onunla ladmin'den şubesini ve bağlantı bilgilerini alır.
# Kanaldaki genel kurucuda ikisi de boştur
$KurulumAdresi = ''
$KurulumKodu = ''

$Sys = Join-Path $env:SystemRoot 'System32'
$ProgramKlasoru = $env:ProgramW6432
if (-not $ProgramKlasoru) { $ProgramKlasoru = $env:ProgramFiles }
# Klasörler ad değişikliğinden (26 Kasım 2026) önceki adla kalır: kurulu kasa, görev ve güncelleyici bunları bilir
$Kur = Join-Path $ProgramKlasoru 'LafPOS' # eski-ad
$Veri = Join-Path $env:ProgramData 'LafPOS' # eski-ad
$Gecici = Join-Path $Kur 'kurulum.gecici'
$SunucuDurdu = $false
$GorevVardi = $false

function Adim([string]$Metin) {
  Write-Host ''
  Write-Host ('> ' + $Metin) -ForegroundColor Cyan
}

function Bekle {
  if ($Sessiz) { return }
  Write-Host ''
  try { [void](Read-Host 'Pencereyi kapatmak için Enter tuşuna basın') } catch { }
}

function Calistir([string]$Exe, [string[]]$Arg) {
  $eski = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $kod = 1
  try {
    & $Exe @Arg 2>&1 | Out-Null
    $kod = $LASTEXITCODE
  } catch {
    $kod = 1
  }
  $ErrorActionPreference = $eski
  return $kod
}

function Sil([string]$Yol) {
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-Path -LiteralPath $Yol)) { return }
    try { Remove-Item -LiteralPath $Yol -Recurse -Force } catch { Start-Sleep -Milliseconds 500 }
  }
  if (Test-Path -LiteralPath $Yol) { throw ($Yol + ' silinemedi (bir program kullanıyor olabilir)') }
}

# Kurulum yarıda kalırsa eski sunucu yeniden açılır: kafe sunucusuz kalmasın
function SunucuyuGeriAc {
  if ($SunucuDurdu -and $GorevVardi) {
    [void](Calistir (Join-Path $Sys 'schtasks.exe') @('/Change', '/TN', $Gorev, '/ENABLE'))
    [void](Calistir (Join-Path $Sys 'schtasks.exe') @('/Run', '/TN', $Gorev))
    Write-Host 'Eski AsilPOS sunucusu yeniden başlatıldı.' -ForegroundColor Yellow
  }
}

function Dur([string]$Metin) {
  Write-Host ''
  Write-Host $Metin -ForegroundColor Red
  Bekle
  exit 1
}

# ─── Yönetici izni ───────────────────────────────────────────────────────────

$kimlik = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $kimlik.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'AsilPOS yönetici izniyle kurulur. Windows "değişiklik yapmasına izin verilsin mi" diye soracak: Evet deyin.'
  if (-not $Kaynak -or $Sessiz) { Dur 'Kurulum dosyası bulunamadı. AsilPOS-Kur.cmd dosyasına çift tıklayarak çalıştırın.' }
  try { Unblock-File -LiteralPath $Kaynak } catch { }
  try {
    Start-Process -FilePath $Kaynak -Verb RunAs | Out-Null
  } catch {
    Dur 'İzin verilmedi; kurulum yapılmadı. Dosyayı yeniden çalıştırıp Evet deyin.'
  }
  exit 0
}

Write-Host 'AsilPOS kurulumu' -ForegroundColor Green
Write-Host 'Program indirilip doğrulanacak ve bu bilgisayara kurulacak. İnternet hızına göre birkaç dakika sürer.'
Write-Host 'Verileriniz ve ayarlarınız (C:\ProgramData\LafPOS) korunur.'

if ((-not [Environment]::Is64BitOperatingSystem) -or ([Environment]::OSVersion.Version.Major -lt 10)) {
  Dur 'AsilPOS 64 bit Windows 10 ya da 11 ister.'
}
if (-not [Environment]::Is64BitProcess) {
  Dur 'Kurulum 64 bit PowerShell ister. AsilPOS-Kur.cmd dosyasına Gezgin''den çift tıklayarak çalıştırın.'
}
$Tar = Join-Path $Sys 'tar.exe'
if (-not (Test-Path -LiteralPath $Tar)) { Dur 'Windows güncel değil (tar.exe yok). Windows Update ile güncelleyip yeniden deneyin.' }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ─── Hangi sürüm ─────────────────────────────────────────────────────────────

# surum.json, güncelleyicinin (guncelle.mjs parseManifest) kurallarıyla
function GecerliSurum($m) {
  if ($null -eq $m) { return $false }
  if ([string]$m.v -ne '1') { return $false }
  $b = [string]$m.build
  if ($b -notmatch '^\d{10,11}$') { return $false }
  if ([string]$m.version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { return $false }
  if ([string]$m.app.file -ne ('lafpos-app-' + $b + '.zip')) { return $false }
  if ([string]$m.app.sha256 -notmatch '^[0-9a-f]{64}$') { return $false }
  if ([string]$m.app.size -notmatch '^\d{1,9}$') { return $false }
  if ([string]$m.node.version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { return $false }
  if ([string]$m.node.abi -notmatch '^\d{2,4}$') { return $false }
  if ([string]$m.node.sha256 -notmatch '^[0-9a-f]{64}$') { return $false }
  if ([string]$m.sqlite.version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { return $false }
  if ([string]$m.sqlite.sha256 -notmatch '^[0-9a-f]{64}$') { return $false }
  return $true
}

Adim 'Son sürüm soruluyor'
$Surum = $null
foreach ($taban in $Kanal) {
  try {
    $m = Invoke-RestMethod -UseBasicParsing -Uri ($taban + 'surum.json') -TimeoutSec 30 -Headers @{ 'Cache-Control' = 'no-cache' }
    if (GecerliSurum $m) {
      $Surum = @{
        taban = $taban; build = [string]$m.build; version = [string]$m.version
        appFile = [string]$m.app.file; appSha = [string]$m.app.sha256; appSize = [long]$m.app.size
        nodeVersion = [string]$m.node.version; nodeAbi = [string]$m.node.abi; nodeSha = [string]$m.node.sha256
        sqliteVersion = [string]$m.sqlite.version; sqliteSha = [string]$m.sqlite.sha256
      }
      break
    }
  } catch { }
}
if ($null -eq $Surum) {
  Write-Host '  Güncelleme kanalı okunamadı; bu dosyanın sürümü kurulacak.' -ForegroundColor Yellow
  $Surum = $Gomulu.Clone()
  $Surum.taban = $Kanal[0]
}
Write-Host ('  AsilPOS ' + $Surum.version + ' (derleme ' + $Surum.build + ')')

# ─── İndir ve doğrula ────────────────────────────────────────────────────────

function Indir([string]$Url, [string]$Hedef, [string]$Sha, [string]$Ad) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Hedef -TimeoutSec 900
      $h = (Get-FileHash -LiteralPath $Hedef -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($h -eq $Sha) {
        Write-Host ('  ' + $Ad + ': doğrulandı') -ForegroundColor Green
        return
      }
      Write-Host ('  ' + $Ad + ': SHA-256 özeti tutmadı, yeniden indiriliyor') -ForegroundColor Yellow
    } catch {
      Write-Host ('  ' + $Ad + ' indirilemedi: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
    if (Test-Path -LiteralPath $Hedef) { Remove-Item -LiteralPath $Hedef -Force }
    Start-Sleep -Seconds (5 * $i)
  }
  throw ($Ad + ' indirilemedi ya da doğrulanamadı. İnternet bağlantısını kontrol edip dosyayı yeniden çalıştırın.')
}

try {
  if (-not (Test-Path -LiteralPath $Kur)) { New-Item -ItemType Directory -Path $Kur | Out-Null }
  Sil $Gecici
  $indirilen = Join-Path $Gecici 'indirilen'
  New-Item -ItemType Directory -Path $indirilen | Out-Null

  Adim 'İndiriliyor (Node, veritabanı modülü, AsilPOS)'
  $nodeZip = Join-Path $indirilen ('node-v' + $Surum.nodeVersion + '-win-x64.zip')
  Indir ('https://nodejs.org/dist/v' + $Surum.nodeVersion + '/node-v' + $Surum.nodeVersion + '-win-x64.zip') $nodeZip $Surum.nodeSha ('Node ' + $Surum.nodeVersion)
  $sqliteAd = 'better-sqlite3-v' + $Surum.sqliteVersion + '-node-v' + $Surum.nodeAbi + '-win32-x64.tar.gz'
  $sqliteTgz = Join-Path $indirilen $sqliteAd
  Indir ('https://github.com/WiseLibs/better-sqlite3/releases/download/v' + $Surum.sqliteVersion + '/' + $sqliteAd) $sqliteTgz $Surum.sqliteSha ('better-sqlite3 ' + $Surum.sqliteVersion)
  $appZip = Join-Path $indirilen $Surum.appFile
  Indir ($Surum.taban + $Surum.appFile) $appZip $Surum.appSha ('AsilPOS ' + $Surum.version)
  if ((Get-Item -LiteralPath $appZip).Length -ne $Surum.appSize) { throw 'AsilPOS yükünün boyu surum.json''dakiyle aynı değil' }

  Adim 'Dosyalar hazırlanıyor'
  $yeniApp = Join-Path $Gecici 'app'
  [IO.Compression.ZipFile]::ExtractToDirectory($appZip, $yeniApp)
  $paket = Get-Content -LiteralPath (Join-Path $yeniApp 'package.json') -Raw | ConvertFrom-Json
  if ([string]$paket.build -ne $Surum.build) { throw 'AsilPOS yükünün derleme numarası beklenenle aynı değil' }
  $sqliteKlasoru = Join-Path $yeniApp 'node_modules\better-sqlite3'
  if ((Calistir $Tar @('-xzf', $sqliteTgz, '-C', $sqliteKlasoru)) -ne 0) { throw 'better-sqlite3 açılamadı' }
  if (-not (Test-Path -LiteralPath (Join-Path $sqliteKlasoru 'build\Release\better_sqlite3.node'))) { throw 'better-sqlite3 ikilisi pakette yok' }
  $yeniNode = Join-Path $Gecici 'node'
  New-Item -ItemType Directory -Path $yeniNode | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($nodeZip)
  try {
    foreach ($ad in @('node.exe', 'LICENSE')) {
      $kayit = $zip.GetEntry('node-v' + $Surum.nodeVersion + '-win-x64/' + $ad)
      if ($null -eq $kayit) { throw ('Node arşivinde ' + $ad + ' yok') }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($kayit, (Join-Path $yeniNode $ad), $true)
    }
  } finally {
    $zip.Dispose()
  }
  $kabuk = Join-Path $Gecici 'kabuk'
  New-Item -ItemType Directory -Path $kabuk | Out-Null
  foreach ($ad in $Dosyalar.Keys) {
    [IO.File]::WriteAllBytes((Join-Path $kabuk $ad), [Convert]::FromBase64String($Dosyalar[$ad]))
  }
} catch {
  Sil $Gecici
  Dur ('Kurulum yapılamadı: ' + $_.Exception.Message)
}

# ─── Açık gün ────────────────────────────────────────────────────────────────

# Bu bilgisayardaki sunucu açıksa gün açık mı diye sorulur: satış sırasında kurmak sunucuyu bir dakika durdurur
try {
  $gun = Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:' + $Port + '/api/kasa/guncelleme-durumu') -TimeoutSec 5
  if ($gun.dayOpen -eq $true) {
    Write-Host ''
    Write-Host 'Kasada gün açık. Kurulum sırasında AsilPOS bir dakika kadar kapanır, tabletler o sırada bağlanamaz.' -ForegroundColor Yellow
    $cevap = 'H'
    if (-not $Sessiz) { $cevap = Read-Host 'Yine de şimdi kurulsun mu? (E/H)' }
    if ($cevap -notmatch '^\s*[eEyY]') {
      Sil $Gecici
      Write-Host 'Kurulum bırakıldı. Gün sonundan sonra dosyayı yeniden çalıştırın.'
      Bekle
      exit 0
    }
  }
} catch { }

# ─── Kur ─────────────────────────────────────────────────────────────────────

try {
  Adim 'Çalışan AsilPOS sunucusu durduruluyor'
  $schtasks = Join-Path $Sys 'schtasks.exe'
  $GorevVardi = ((Calistir $schtasks @('/Query', '/TN', $Gorev)) -eq 0)
  if ($GorevVardi) {
    # Önce görev kapatılır, yoksa beş dakikalık güvence tetiği kurulum sürerken eski sürümü yeniden başlatabilir
    [void](Calistir $schtasks @('/Change', '/TN', $Gorev, '/DISABLE'))
    [void](Calistir $schtasks @('/End', '/TN', $Gorev))
    $SunucuDurdu = $true
    Start-Sleep -Seconds 3
  }

  $db = Join-Path $Veri 'lafpos.db'
  if (Test-Path -LiteralPath $db) {
    $yedekler = Join-Path $Veri 'backups'
    if (-not (Test-Path -LiteralPath $yedekler)) { New-Item -ItemType Directory -Path $yedekler | Out-Null }
    $yedek = Join-Path $yedekler ('lafpos-guncelleme-' + (Get-Date -Format 'yyyy-MM-dd-HHmmss') + '.db')
    try {
      Copy-Item -LiteralPath $db -Destination $yedek
      if (Test-Path -LiteralPath ($db + '-wal')) { Copy-Item -LiteralPath ($db + '-wal') -Destination ($yedek + '-wal') }
    } catch {
      throw ('Veritabanının kopyası alınamadı (' + $yedek + '); eski sürüm çalışmaya devam ediyor')
    }
    Write-Host ('  Veritabanının kopyası: ' + $yedek)
  }

  Adim 'AsilPOS kuruluyor'
  # Otomatik güncellemenin bıraktığı klasörler kalmasın; node.yeni kalırsa başlatıcı onu Node'un yerine koyardı
  foreach ($k in @('app.eski', 'app.yeni', 'app.bozuk', 'node.eski', 'node.yeni')) { Sil (Join-Path $Kur $k) }
  $app = Join-Path $Kur 'app'
  $node = Join-Path $Kur 'node'
  if (Test-Path -LiteralPath $app) { Rename-Item -LiteralPath $app -NewName 'app.eski' }
  if (Test-Path -LiteralPath $node) { Rename-Item -LiteralPath $node -NewName 'node.eski' }
  try {
    Move-Item -LiteralPath (Join-Path $Gecici 'app') -Destination $app
    Move-Item -LiteralPath (Join-Path $Gecici 'node') -Destination $node
  } catch {
    # Yarım kalan yeni klasörler kaldırılır, eski sürüm yerine döner
    Sil $app
    Sil $node
    if (Test-Path -LiteralPath (Join-Path $Kur 'app.eski')) { Rename-Item -LiteralPath (Join-Path $Kur 'app.eski') -NewName 'app' }
    if (Test-Path -LiteralPath (Join-Path $Kur 'node.eski')) { Rename-Item -LiteralPath (Join-Path $Kur 'node.eski') -NewName 'node' }
    throw ('Program klasörü yazılamadı: ' + $_.Exception.Message)
  }
  Sil (Join-Path $Kur 'app.eski')
  Sil (Join-Path $Kur 'node.eski')
  Get-ChildItem -LiteralPath (Join-Path $Gecici 'kabuk') | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Kur $_.Name) -Force }
  Sil $Gecici

  # Veri klasörü: yalnız SYSTEM (sunucu) ve Yöneticiler. Türkçe Windows'ta grup adı farklı, SID kullanılır
  if (-not (Test-Path -LiteralPath $Veri)) { New-Item -ItemType Directory -Path $Veri | Out-Null }
  [void](Calistir (Join-Path $Sys 'icacls.exe') @($Veri, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'))
  if (-not (Test-Path -LiteralPath (Join-Path $Veri 'ayarlar.env'))) {
    Copy-Item -LiteralPath (Join-Path $Kur 'ayarlar.env.ornek') -Destination (Join-Path $Veri 'ayarlar.env')
  }
  # Şubeye özel kurucu: kod veri klasörüne yazılır, sunucu ilk açılışta ladmin'den şubesini ve bağlantılarını alır
  if ($KurulumKodu -and $KurulumAdresi) {
    $kodJson = '{"adres":"' + $KurulumAdresi + '","kod":"' + $KurulumKodu + '"}'
    [IO.File]::WriteAllText((Join-Path $Veri 'kurulum-kodu.json'), $kodJson, (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Şube kurulum kodu kaydedildi: kasa açılınca şubesine kendiliğinden bağlanır.'
  }

  Adim 'Sunucu görevi, güvenlik duvarı ve kısayollar'
  # Görev asilpos.nsi'dekiyle aynı: açılışta SYSTEM olarak, süre sınırı yok, pilde de çalışır, beş dakikada bir güvence
  $baslat = Join-Path $Kur 'baslat.cmd'
  $xml = @(
    '<?xml version="1.0" encoding="UTF-16"?>'
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
    '  <RegistrationInfo><Description>AsilPOS yerel sunucusu: kasa, tablet ve telefonlar buna bağlanır</Description></RegistrationInfo>'
    '  <Triggers>'
    '    <BootTrigger><Enabled>true</Enabled></BootTrigger>'
    '    <TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
    '  </Triggers>'
    '  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>'
    '  <Settings>'
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
    '    <AllowHardTerminate>true</AllowHardTerminate>'
    '    <StartWhenAvailable>true</StartWhenAvailable>'
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>'
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>'
    '    <AllowStartOnDemand>true</AllowStartOnDemand>'
    '    <Enabled>true</Enabled>'
    '    <Hidden>false</Hidden>'
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>'
    '    <WakeToRun>false</WakeToRun>'
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
    '    <Priority>5</Priority>'
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>'
    '  </Settings>'
    '  <Actions Context="Author"><Exec>'
    ('    <Command>' + (Join-Path $Sys 'cmd.exe') + '</Command>')
    ('    <Arguments>/d /c ""' + $baslat + '""</Arguments>')
    ('    <WorkingDirectory>' + $Kur + '</WorkingDirectory>')
    '  </Exec></Actions>'
    '</Task>'
  ) -join "`r`n"
  $xmlYol = Join-Path $env:TEMP 'asilpos-gorev.xml'
  [IO.File]::WriteAllText($xmlYol, $xml, [Text.Encoding]::Unicode)
  $kod = Calistir $schtasks @('/Create', '/TN', $Gorev, '/XML', $xmlYol, '/RU', 'SYSTEM', '/F')
  Remove-Item -LiteralPath $xmlYol -Force
  if ($kod -ne 0) {
    [void](Calistir $schtasks @('/Change', '/TN', $Gorev, '/ENABLE'))
    throw ('Sunucu görevi oluşturulamadı (kod ' + $kod + ')')
  }

  # Güvenlik duvarı: yalnız kafenin ağı ve Tailscale (100.64.0.0/10); internete açık port yok
  $netsh = Join-Path $Sys 'netsh.exe'
  [void](Calistir $netsh @('advfirewall', 'firewall', 'delete', 'rule', ('name=' + $Gorev)))
  foreach ($uzak in @('localsubnet', '100.64.0.0/10')) {
    [void](Calistir $netsh @('advfirewall', 'firewall', 'add', 'rule', ('name=' + $Gorev), 'dir=in', 'action=allow', 'protocol=TCP', ('localport=' + $Port), ('remoteip=' + $uzak), 'profile=any'))
  }

  # Kısayollar: kurulum dosyasıyla ve güncellemeyle aynı liste, aynı betik (app\kurulum-yenile.mjs kisayollar; kasa
  # kısayolları konsolsuz kasa programını açar). Önce eski Başlat menüsü ve ad değişikliğinden (26 Kasım 2026) önceki
  # kurulumun kısayolları silinir. Kaldırma kısayolu kuruluma özgü (kurulum dosyasında Kaldir.exe)
  $ikon = (Join-Path $Kur 'asilpos.ico') + ',0'
  $kabukNesnesi = New-Object -ComObject WScript.Shell
  # WScript.Shell kısayolun yolunu ANSI'ye çevirir: Türkçe olmayan Windows'ta "AsilPOS'u kaldır.lnk" "kaldir.lnk" diye
  # yazılırdı (kurulum dosyasınınki doğru adla). ASCII adlı geçici kopyada yazılır, asıl adına .NET kopyalar (kisayollar.ps1)
  function Kisayol([string]$Yol, [string]$Hedef, [string]$Arguman, [string]$Aciklama, [int]$Pencere) {
    $gecici = Join-Path (Split-Path -Parent $Yol) ('~asilpos-' + [guid]::NewGuid().ToString('N') + '.lnk')
    try {
      $k = $kabukNesnesi.CreateShortcut($gecici)
      $k.TargetPath = $Hedef
      $k.Arguments = $Arguman
      $k.WorkingDirectory = $Kur
      $k.IconLocation = $ikon
      $k.WindowStyle = $Pencere
      $k.Description = $Aciklama
      $k.Save()
      [System.IO.File]::Copy($gecici, $Yol, $true)
    } finally {
      Remove-Item -LiteralPath $gecici -Force -ErrorAction SilentlyContinue
    }
  }
  $menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'AsilPOS'
  $masaustu = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $baslangic = [Environment]::GetFolderPath('CommonStartup')
  Sil $menu
  $EskiAd = 'LafPOS' # eski-ad: shared/eski-adlar.ts
  Sil (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $EskiAd)
  foreach ($eski in @((Join-Path $masaustu ($EskiAd + ' Kasa.lnk')), (Join-Path $baslangic ($EskiAd + ' Kasa.lnk')), (Join-Path $baslangic ($EskiAd + ' Kasa Bekcisi.lnk')))) {
    Remove-Item -LiteralPath $eski -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $menu | Out-Null
  $ps = Join-Path $Sys 'WindowsPowerShell\v1.0\powershell.exe'
  $kisayolKodu = Calistir (Join-Path $Kur 'node\node.exe') @((Join-Path $Kur 'app\kurulum-yenile.mjs'), 'kisayollar', '--gruplar', 'masaustu,baslangic')
  if ($kisayolKodu -ne 0) { Write-Host ('  Kısayollar yazılamadı (kod ' + $kisayolKodu + '); AsilPOS açılınca Başlat menüsündekiler yeniden denenir.') -ForegroundColor Yellow }
  $kaldirExe = Join-Path $Kur 'Kaldir.exe'
  $kaldirPs = Join-Path $Kur 'LafPOS-Kaldir.ps1'
  $anahtar = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\LafPOS'
  # Kurulum dosyasının Kaldir.exe'si yalnız kayıtta görünen ad AsilPOS ise yenidir. Ad değişikliğinden önceki Kaldir.exe
  # yeni adlı kısayolları bilmez (kaldırınca Başlangıç'taki kasa kısayolu kalır): silinir, kaldırma bu kurulumun
  # kaldırıcısına geçer (kurulum-yenile.mjs ile aynı kural)
  $gorunenAd = $null
  try { $gorunenAd = [string](Get-ItemProperty -LiteralPath $anahtar -ErrorAction Stop).DisplayName } catch { }
  $kaldirExeYeni = (Test-Path -LiteralPath $kaldirExe) -and ($gorunenAd -eq 'AsilPOS')
  if ((Test-Path -LiteralPath $kaldirExe) -and -not $kaldirExeYeni) { Remove-Item -LiteralPath $kaldirExe -Force -ErrorAction SilentlyContinue }
  if ($kaldirExeYeni) {
    Kisayol (Join-Path $menu 'AsilPOS''u kaldır.lnk') $kaldirExe '' '' 1
    $kaldirKomutu = '"' + $kaldirExe + '"'
  } else {
    Kisayol (Join-Path $menu 'AsilPOS''u kaldır.lnk') $ps ('-NoProfile -ExecutionPolicy Bypass -File "' + $kaldirPs + '"') '' 1
    $kaldirKomutu = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File "' + $kaldirPs + '"'
  }

  # Prizdeyken uyku kapalı: uyuyan bilgisayara tabletler bağlanamaz; USB aygıtları (yazıcı, dokunmatik) askıya alınmaz
  $powercfg = Join-Path $Sys 'powercfg.exe'
  [void](Calistir $powercfg @('/change', 'standby-timeout-ac', '0'))
  [void](Calistir $powercfg @('/change', 'hibernate-timeout-ac', '0'))
  [void](Calistir $powercfg @('/setacvalueindex', 'SCHEME_CURRENT', '2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', '0'))
  [void](Calistir $powercfg @('/setactive', 'SCHEME_CURRENT'))

  # Uygulamalar listesi: kurulum dosyasıyla (32 bit NSIS) aynı kayıt
  if (-not (Test-Path -LiteralPath $anahtar)) { New-Item -Path $anahtar | Out-Null }
  $boyut = [int]((Get-ChildItem -LiteralPath $Kur -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1024)
  Set-ItemProperty -LiteralPath $anahtar -Name 'DisplayName' -Value 'AsilPOS'
  Set-ItemProperty -LiteralPath $anahtar -Name 'DisplayVersion' -Value $Surum.version
  Set-ItemProperty -LiteralPath $anahtar -Name 'Publisher' -Value 'L''Affogato'
  Set-ItemProperty -LiteralPath $anahtar -Name 'DisplayIcon' -Value (Join-Path $Kur 'asilpos.ico')
  Set-ItemProperty -LiteralPath $anahtar -Name 'InstallLocation' -Value $Kur
  Set-ItemProperty -LiteralPath $anahtar -Name 'UninstallString' -Value $kaldirKomutu
  # Kurulum dosyasının sessiz kaldırma satırı yalnız onun Kaldir.exe'si için (PowerShell kaldırıcısı soru sorar)
  if (-not $kaldirExeYeni) { Remove-ItemProperty -LiteralPath $anahtar -Name 'QuietUninstallString' -ErrorAction SilentlyContinue }
  New-ItemProperty -LiteralPath $anahtar -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -LiteralPath $anahtar -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -LiteralPath $anahtar -Name 'EstimatedSize' -Value $boyut -PropertyType DWord -Force | Out-Null

  Adim 'AsilPOS sunucusu başlatılıyor'
  [void](Calistir $schtasks @('/Run', '/TN', $Gorev))
  $SunucuDurdu = $false
} catch {
  Sil $Gecici
  SunucuyuGeriAc
  Dur ('Kurulum yarıda kaldı: ' + $_.Exception.Message)
}

$acildi = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $saglik = Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 2
    if ([string]$saglik.build -eq $Surum.build) { $acildi = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}

Write-Host ''
if ($acildi) {
  Write-Host ('AsilPOS ' + $Surum.version + ' kuruldu ve çalışıyor.') -ForegroundColor Green
  Write-Host 'Kasa ekranı masaüstündeki "AsilPOS Kasa" kısayoluyla açılır; şimdi açılıyor.'
  Write-Host 'Ayarlar: Başlat > AsilPOS > AsilPOS ayarları. Tabletler için adres ve karekod: Yönetim > Ağ ve uzaktan erişim.'
  # Kurulum yönetici olarak çalışır; kasa ekranı Gezgin üzerinden normal kullanıcı olarak açılır
  if (-not $Sessiz) {
    try { Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"' + (Join-Path $menu 'AsilPOS Kasa.lnk') + '"') } catch { }
  }
} else {
  Write-Host 'AsilPOS kuruldu ama sunucu 90 saniyede açılmadı.' -ForegroundColor Yellow
  Write-Host 'Bir dakika sonra masaüstündeki "AsilPOS Kasa"yı açın. Açılmazsa bilgisayarı yeniden başlatın;'
  Write-Host 'sunucu günlüğü: Başlat > AsilPOS > Sunucu günlüğü.'
}
Bekle
if (-not $acildi -and $Sessiz) { exit 4 }
exit 0
