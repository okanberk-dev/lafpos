# AsilPOS kasa programi (Windows, oturumdaki kullanici): kasa penceresini acar ve acik tutar, fis yazicisini ayarlar,
# musteri ekranini ikinci ekranda acar. Ayrinti: docs/05-KASA-BILGISAYARI.md. Yalniz ASCII (Windows PowerShell 5.1
# BOM'suz dosyayi ANSI okur): ekranda gorunen Turkce harfler Tr ile yer tutucudan ({c}, {i} gibi) yazilir.
#
# Kipler:
#   -Ac      Program (27 Kas 2026, sahibin istegi: "tamamen bir program olacak sekilde"): Baslat menusu, masaustu ve
#            Baslangic'taki "AsilPOS Kasa" kisayollari bunu konsolsuz (powershell -WindowStyle Hidden) acar. Kasa penceresi
#            zaten aciksa one getirir (tek pencere, ikinci tiklama yeni pencere acmaz). Yoksa sira (28 Kas 2026, "daha hizli
#            ve markali"): tam ekran markali acilis penceresi, sunucu (en cok 90 sn), KASA PENCERESI (acilis penceresi
#            kapanir), musteri ekrani, yazicilar. Yazici sorgusu 15 sn'ye kadar surebilir: pencereyi bekletmez. Sunucu 90
#            sn'de acilmazsa pencere acilmaz: bekci sunucu gelince acar (hata sayfasi kalmaz).
#   -Bekci   Arka plan bekcisi: kisayolun istedigi kasa penceresini sunucu gelince acar, musteri ekranini kasa penceresi
#            aciktayken acik tutar (tek bekci). Kullanici kasa penceresini kapatirsa yeniden ACMAZ, musteri ekranini da kapatir
#            (sahibin istegi, 28 Kas 2026: kapatinca kapansin, ben acinca acilsin). Pencere COKERSE (tarayici sureci hatayla
#            ya da zorla biterse) yeniden acar (28 Kas 2026; Get-KasaKapanis). Diskteki betik degisirse (otomatik guncelleme)
#            yenisiyle yeniden baslar: yeni surum oturum kapanmayi beklemez.
#   -KasaAc  27 Kasim oncesinin kasa kisayolu (AsilPOS-Kasa.bat): kasa penceresini acar ya da one getirir.
#   (kipsiz) Ayni eski kisayolun ilk adimi: yazicilar, musteri ekrani, bekci.
#
# Fis yazicisi: bilgisayardaki yazicilari AsilPOS'a bildirir ve AsilPOS'un sectigi fis yazicisini bu kullanicinin
# varsayilan yazicisi yapar. Chrome kiosk sessiz yazdirma (--kiosk-printing) varsayilan yaziciya basar: kablolu (USB) fis
# yazicisi kurulup tek basina takiliysa hic secim gerekmez. Yazici Yonetim > Ayarlar ve yedek > Fis yazicisi'ndan da
# secilir. Hata olursa gunluge yazilip gecilir: kasa ekrani yine acilir.
#
# Musteri ekrani (22 Kas 2026): bilgisayara ikinci ekran takiliysa musteri ekrani orada tam ekran acilir (ayri Chrome
# profili; kasa penceresinden bagimsiz). Ekran olcegi (%125) pencereyi birinci ekrana dusurmesin diye surec DPI'ya duyarli
# yapilir (Screen.Bounds gercek piksel). Sahadaki gecici bekci (%LocalAppData%\LafPOS-MusteriEkrani,
# Baslangic'ta "LafPOS Musteri Ekrani") kapatilir: iki pencere acilmaz.
#
# Kasa ekrani bekcisi (22 Kas 2026; 28 Kas 2026'dan beri kapanani yeniden acmaz): kasa kisayolu acarken sunucu henuz
# gelmediyse istek dosyasi birakir (kasa-ac.istek); bekci sunucu gelince pencereyi acar ve istegi siler. Kullanici kasa
# penceresini (%LocalAppData%\LafPOS\chrome ya da \edge profiliyle calisan Chrome/Edge) kapatirsa bekci yeniden acmaz. Bekci iki yoldan baslar: kasa kisayolu (-Ac) ve ortak
# Baslangic'taki "AsilPOS Kasa Bekcisi" kisayolu (guncelleme yazar, kurulum-yenile.mjs; o yoksa kullanici Baslangic'ina
# burada konur). Tek bekci calisir (ad verilmis mutex); eski surum bekci (-BekciSurum farkli) kapatilip yenisi acilir. Kasa
# penceresini acmak da mutex altinda: kisayol ile bekci ayni anda iki pencere acmaz. Bekci kalici kurulunca sahadaki gecici
# kasa denetcisi (kullanici Baslangic'inda "LafPOS Kasa Kontrol" ve %LocalAppData%\LafPOS-KasaKontrol) kaldirilir.
#
# Ad degisikligi (26 Kas 2026): ASILPOS_URL yoksa eski adi; tarayici profilleri, mutex adlari ve eski kisayollar eski adla
# (shared/eski-adlar.ts). Eski adli kisayollar yeni adla es sayilir. Guncellemeden once baslamis bekci pencereyi profil
# klasorunden (\LafPOS\chrome, \LafPOS\edge) tanir: bu adlar degismez.
param([string]$Url = $(if ($env:ASILPOS_URL) { $env:ASILPOS_URL } else { $env:LAFPOS_URL }), [switch]$Bekci, [int]$BekciSurum = 0, [switch]$KasaAc, [switch]$Ac)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Kurulum klasoru (app\'in bir ustu): tarayici ve bekci burada calisir. app\ guncellemede tasinir (app -> app.eski); icinde
# duran bir surec (calisma klasoru) tasimayi engellerdi
$KurulumKlasoru = Split-Path -Parent $PSScriptRoot

# Kasa programinin gunlugu (28 Kas 2026): kasa profillerinin klasorunde logs\kasa-programi.log, 1 MB'a varinca .1'e doner
# (tek yedek). Her acilisin adim sureleri (ms), bekcinin kararlari (kapanan pencere, cokme, yeniden acma) ve yakalanan hatalarin
# iletileri. PIN, parola ve anahtar yazilmaz: yalniz adim adi, sure, karar ve hata iletisi. Kisayol (-Ac) ve bekci ayni
# dosyaya ekler (paylasimli acma; ayni anda yazilamayan satir kaybolur, kasa durmaz)
$Gunluk = Join-Path $env:LOCALAPPDATA 'LafPOS\logs\kasa-programi.log' # eski-ad: kasa profilleriyle ayni klasor
$Kip = 'eski'
if ($Bekci.IsPresent) { $Kip = 'bekci' } elseif ($Ac.IsPresent) { $Kip = 'ac' } elseif ($KasaAc.IsPresent) { $Kip = 'kasa-ac' }
function Write-Log([string]$metin) {
  try {
    $dir = Split-Path -Parent $Gunluk
    if (-not [System.IO.Directory]::Exists($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $fi = New-Object System.IO.FileInfo($Gunluk)
    if ($fi.Exists -and $fi.Length -ge 1MB) {
      $yedek = $Gunluk + '.1'
      if ([System.IO.File]::Exists($yedek)) { [System.IO.File]::Delete($yedek) }
      [System.IO.File]::Move($Gunluk, $yedek)
    }
    $satir = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff', [System.Globalization.CultureInfo]::InvariantCulture) + ' ' + $Kip + '[' + $PID + '] ' + $metin + "`r`n"
    $b = [System.Text.Encoding]::UTF8.GetBytes($satir)
    $fs = New-Object System.IO.FileStream($Gunluk, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    try { $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }
  } catch {
    # Gunluk yazilamadi (disk dolu, izin): kasa bunun icin durmaz; yazilacak baska yer yok
  }
}

# Yakalanan hata: yeri ve iletisi gunluge (tek satir, kisaltilmis). Ileti Windows'un ya da .NET'in metni; istek govdesi,
# PIN ya da anahtar icermez
function Write-Hata([string]$yer, $hata) {
  $m = ''
  try { $m = [string]$hata.Exception.Message } catch { $m = [string]$hata }
  $m = ($m -replace '[\r\n]+', ' ').Trim()
  if ($m.Length -gt 400) { $m = $m.Substring(0, 400) }
  Write-Log ($yer + ' hatasi: ' + $m)
}

# Win32 islevleri derlemesiz (28 Kas 2026): Add-Type C# derleyicisini (csc.exe) calistirir; yavas kasada acilis
# penceresinden once 1-3 sn suruyordu. Ayni islevler bellekte kurulan tipten cagrilir (System.Reflection.Emit, P/Invoke);
# tip surecte bir kez kurulur
$script:YerelTip = $null
function Get-Yerel {
  if ($script:YerelTip) { return $script:YerelTip }
  $an = New-Object System.Reflection.AssemblyName('AsilPosYerel')
  $tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly($an, [System.Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('AsilPosYerel').DefineType('AsilPosYerel', [System.Reflection.TypeAttributes]'Public, Class')
  $islevler = @(
    @('SetProcessDPIAware', ([bool]), @()),
    @('SetForegroundWindow', ([bool]), @([IntPtr])),
    @('ShowWindowAsync', ([bool]), @([IntPtr], [int])),
    @('IsIconic', ([bool]), @([IntPtr])),
    @('keybd_event', ([void]), @([byte], [byte], [uint32], [UIntPtr]))
  )
  foreach ($f in $islevler) {
    $m = $tb.DefinePInvokeMethod([string]$f[0], 'user32.dll', [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [System.Reflection.CallingConventions]::Standard, [Type]$f[1], [Type[]]$f[2], [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Auto)
    $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
  }
  $script:YerelTip = $tb.CreateType()
  return $script:YerelTip
}

try {
  $yerel = Get-Yerel
  [void]$yerel::SetProcessDPIAware()
} catch { Write-Hata 'DPI' $_ }

# Ekranda gorunen Turkce metin: dosya ASCII kalsin diye harfler yer tutucuyla
function Tr([string]$s) {
  foreach ($h in @(@('{c}', 0x00E7), @('{g}', 0x011F), @('{i}', 0x0131), @('{o}', 0x00F6), @('{s}', 0x015F), @('{u}', 0x00FC))) {
    $s = $s.Replace([string]$h[0], [string][char][int]$h[1])
  }
  return $s
}

function Show-Message([string]$metin) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($metin, 'AsilPOS', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
  } catch { Write-Hata 'uyari kutusu' $_ }
}

# Tarayici: Chrome, yoksa Edge. ASILPOS_TARAYICI=edge (kullanici ortam degiskeni) Chrome kurulu olsa da Edge'i secer
function Get-DisplayExe {
  $chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  $edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  $candidates = $chrome + $edge
  if ($env:ASILPOS_TARAYICI -eq 'edge') { $candidates = $edge + $chrome }
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# Kurulu derleme (app\package.json "build"; paket.mjs yazar). Okunamazsa (git ile calisan gelistirici kurulumu) $null
function Get-KuruluDerleme {
  try {
    $p = Join-Path $PSScriptRoot 'package.json'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    $m = [regex]::Match([System.IO.File]::ReadAllText($p), '"build"\s*:\s*(\d+)')
    if ($m.Success) { return $m.Groups[1].Value }
  } catch { Write-Hata 'kurulu derleme' $_ }
  return $null
}

# Tarayici onbellegi (inceleme, 27 Kas 2026): yeni kasa ya da musteri ekrani tarayicisi acilmadan once o profilin HTTP
# onbellegi (Default\Cache) silinir. 27 Kasim surumunden onceki sunucu arayuz sayfasini onbellek basligi olmadan veriyordu;
# Chrome onu sunucuya sormadan acabiliyor, guncellemeden sonraki ilk acilista eski arayuz gorunuyordu. Yeni sunucu sayfayi
# saklatmaz (no-store) ama eski kayit profilde kalmis olabilir. 28 Kas 2026'dan beri her acilista degil, yalniz kurulu
# derleme degisince silinir (her acilista silmek arayuz dosyalarini yeniden yukletip acilisi yavaslatiyordu): profilin son
# silindigi derleme kasa profillerinin klasorunde onbellek-derleme.txt'de (profil=derleme satirlari). Derleme okunamazsa eskisi gibi
# her acilista silinir. Oturum, ayarlar ve yerel depolama (Local Storage, Cookies) silinmez. Profil kullanimdayken
# cagrilmaz (yalniz o profilin tarayicisi yokken, kilit altinda); silinemeyen dosya kalir, derleme yazilmaz (sonra yeniden denenir)
$OnbellekKaydi = Join-Path $env:LOCALAPPDATA 'LafPOS\onbellek-derleme.txt' # eski-ad: kasa profilleriyle ayni klasor
function Clear-BrowserCache([string]$profileDir) {
  try {
    $ad = Split-Path -Leaf $profileDir
    $derleme = Get-KuruluDerleme
    $kayit = @{}
    if ($derleme -and (Test-Path -LiteralPath $OnbellekKaydi)) {
      foreach ($l in [System.IO.File]::ReadAllLines($OnbellekKaydi)) {
        $i = $l.IndexOf('=')
        if ($i -gt 0) { $kayit[$l.Substring(0, $i)] = $l.Substring($i + 1).Trim() }
      }
      if ($kayit[$ad] -eq $derleme) { return }
    }
    $cache = Join-Path $profileDir 'Default\Cache'
    if (Test-Path -LiteralPath $cache) { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $cache) {
      Write-Log ('onbellek tam silinemedi: ' + $ad)
      return
    }
    if ($derleme) {
      $kayit[$ad] = $derleme
      [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $OnbellekKaydi))
      [System.IO.File]::WriteAllLines($OnbellekKaydi, [string[]]@($kayit.Keys | Sort-Object | ForEach-Object { $_ + '=' + $kayit[$_] }))
    }
    Write-Log ('onbellek silindi: ' + $ad + ' (derleme ' + $(if ($derleme) { $derleme } else { 'bilinmiyor' }) + ')')
  } catch { Write-Hata 'onbellek' $_ }
}

# Kasa penceresi ve musteri ekraninin tarayici surecleri tek sorguda (bekci her turda bir kez sorar; 28 Kas 2026)
function Get-TarayiciSurecleri {
  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -OperationTimeoutSec 15)
}

# Musteri ekrani acik mi: musteri profiliyle (chrome-musteri) calisan Chrome/Edge sureci. $surecler verilirse yeniden sorulmaz
function Test-CustomerDisplay($surecler = $null) {
  if ($null -eq $surecler) { $surecler = @(Get-TarayiciSurecleri) }
  $p = $surecler | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | Select-Object -First 1
  return [bool]$p
}

# Musteri ekranini acar (ikinci ekran varsa ve acik degilse). Dondurdugu: yeni pencere acildiysa $true (yoksa bos)
function Start-CustomerDisplay([string]$base) {
  $mx = $null
  $own = $false
  $acildi = $false
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $second = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $second) { return }
    # Acmak kilit altinda (inceleme, 23 Kas 2026): oturum acilinca kisayol ile bekci ayni anda sunucunun kalkmasini
    # bekler. Ikisi birden pencereyi yok gorup Chrome'u acarsa ikinci acilis ilk surece devredilir, ikinci tam ekran acilir
    $mx = New-Object System.Threading.Mutex($false, 'Local\LafPOS-MusteriPencere')
    try { $own = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $own = $true }
    if (Test-CustomerDisplay) { return }
    $exe = Get-DisplayExe
    if (-not $exe) { return }
    # Sunucu cevap vermiyorsa acilmaz, bekci 15 sn sonra yeniden bakar (inceleme, 23 Kas 2026). Bekci oturum acilinca
    # baslar, sunucu henuz kalkmamis olabilir: hata sayfasiyla acilan pencerenin sureci var oldugu icin bir daha acilmazdi
    if (-not (Test-Server $base)) { return }
    $b = $second.Bounds
    $profileDir = Join-Path $env:LOCALAPPDATA 'LafPOS\chrome-musteri'
    $chromeArgs = @(
      '--kiosk',
      ('--app=' + $base + '/musteri-ekrani?ekran=kasa'),
      ('--user-data-dir="' + $profileDir + '"'),
      ('--window-position=' + $b.X + ',' + $b.Y),
      ('--window-size=' + $b.Width + ',' + $b.Height),
      '--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required',
      '--disable-session-crashed-bubble', '--disable-features=Translate'
    )
    Clear-BrowserCache $profileDir
    Start-Process -FilePath $exe -ArgumentList $chromeArgs -WorkingDirectory $KurulumKlasoru | Out-Null
    $acildi = $true
    Write-Log 'musteri ekrani acildi'
    # Surec gorunene dek beklenir: ardindan gelen (kisayol ya da bekci) ikinci pencere acmasin
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-CustomerDisplay) { break }
    }
  } catch {
    Write-Hata 'musteri ekrani' $_
  } finally {
    if ($own) { try { $mx.ReleaseMutex() } catch { } }
    if ($mx) { $mx.Dispose() }
  }
  return $acildi
}

# PowerShell surecleri (kasa bekcileri, sahadaki gecici bekciler) tek sorguda: kisayol ikisine de ayni listeyi verir
function Get-PowerShellSurecleri {
  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -OperationTimeoutSec 15)
}

function Stop-TemporaryDisplayWatcher($surecler = $null) {
  try {
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LafPOS Musteri Ekrani.lnk'
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force }
    if ($null -eq $surecler) { $surecler = @(Get-PowerShellSurecleri) }
    $surecler | Where-Object { $_.CommandLine -like '*LafPOS-MusteriEkrani*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { Write-Hata 'gecici musteri ekrani bekcisi' $_ }
}

# Kasa bekcisinin surumu (kurulum-yenile.mjs WATCHER_VERSION ile ayni). 3: musteri ekrani sunucu cevap verince acilir;
# 4: bakim arasinda (Yonetim > Ag > Bu bilgisayar) kasa penceresi yeniden acilmaz; 5: program (27 Kas 2026): Edge
# InPrivate olmayan tam ekran pencerede, diskteki betik degisince bekci yenisiyle yeniden baslar; 6 (28 Kas 2026): kapanan
# kasa penceresini yeniden acmaz (yalniz kisayolun istegiyle acar), kasa penceresi kapaninca musteri ekranini da kapatir;
# 7 (28 Kas 2026): coken kasa penceresini yeniden acar (kullanicinin kapattigini acmaz), kararlarini gunluge yazar
$BekciSurumu = 7
$BekciKisayolu = 'AsilPOS Kasa Bekcisi.lnk'
$EskiAd = 'LafPOS' # eski-ad: ad degisikliginden onceki kisayol ve menu adi
$EskiBekciKisayolu = $EskiAd + ' Kasa Bekcisi.lnk'

function Get-KasaUrl {
  if ($Url) { return $Url }
  return 'http://localhost:4000/'
}

# Kasa penceresi: kasa profiliyle calisan ana tarayici sureci (alt surecler --type= tasir; musteri profili chrome-musteri).
# $surecler verilirse yeniden sorulmaz
function Get-KasaProcess($surecler = $null) {
  if ($null -eq $surecler) { $surecler = @(Get-TarayiciSurecleri) }
  return $surecler | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '\\LafPOS\\(chrome|edge)(?![\w-])' -and $_.CommandLine -notmatch '--type='
  } | Select-Object -First 1
}

function Test-KasaWindow {
  return [bool](Get-KasaProcess)
}

# Acik kasa penceresini one getirir (kisayola yeniden basilinca: ikinci pencere yerine ayni program). Kucultulmusse geri
# acilir. Windows on plani kilitlediyse (baska programa yazilirken) bir Alt basimiyla yeniden denenir; olmazsa gorev
# cubugundaki dugme yanip soner. Bekci yalniz coken pencereyi yeniden actiginda cagirir: arka planda pencere one firlamaz
function Show-KasaWindow($proc) {
  try {
    $y = Get-Yerel
    $h = (Get-Process -Id $proc.ProcessId -ErrorAction Stop).MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    if ($y::IsIconic($h)) { [void]$y::ShowWindowAsync($h, 9) }
    if (-not $y::SetForegroundWindow($h)) {
      $y::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      $y::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      [void]$y::SetForegroundWindow($h)
    }
  } catch { Write-Hata 'one getirme' $_ }
}

# Kasa penceresi ekranda mi (surecin gorunen penceresi var). Acilis penceresi ancak o zaman kapanir: arada masaustu
# gorunmez. Dondurdugu: kasa sureci (ya da $null)
function Wait-KasaPenceresi([int]$saniye) {
  $son = (Get-Date).AddSeconds($saniye)
  $k = $null
  while ($true) {
    try {
      $k = Get-KasaProcess
      if ($k -and (Get-Process -Id $k.ProcessId -ErrorAction Stop).MainWindowHandle -ne [IntPtr]::Zero) { return $k }
    } catch {
      # Surec bu arada degisti ya da sorgu bir an yanit vermedi: yeniden bakilir
      $k = $null
    }
    if ((Get-Date) -ge $son) { return $k }
    Start-Sleep -Milliseconds 250
  }
}

# Bakim arasi (Yonetim > Ag ve uzaktan erisim > Bu bilgisayar): sunucu "suruyor" derse bekci kasa penceresini acmaz.
# Sunucuya ulasilamazsa ya da yanit bozuksa ara yok sayilir (kasa yine acik tutulur)
function Test-KasaBakim([string]$base) {
  try { return [bool](Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/kasa/bakim')).active } catch { return $false }
}

function Test-Server([string]$base) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ($base + '/api/health')).StatusCode -eq 200 } catch { return $false }
}

# Kasa penceresi acma istegi (kasa kisayolu birakir, bekci sunucu gelince acar ve siler; coken pencere icin bekci de
# birakir). Bekci kullanicinin kapattigi pencereyi kendiliginden acmaz: yalniz bu istek varken acar. 30 dakikadan eski
# istek bayat sayilir (kullanici o arada vazgecmistir)
$KasaAcIstegi = Join-Path $env:LOCALAPPDATA 'LafPOS\kasa-ac.istek' # eski-ad
function Set-KasaAcIstegi {
  try {
    New-Item -ItemType Directory -Path (Split-Path $KasaAcIstegi) -Force | Out-Null
    Set-Content -LiteralPath $KasaAcIstegi -Value ((Get-Date).ToString('o')) -Encoding ASCII
  } catch { Write-Hata 'acma istegi' $_ }
}
function Clear-KasaAcIstegi {
  try { if (Test-Path -LiteralPath $KasaAcIstegi) { Remove-Item -LiteralPath $KasaAcIstegi -Force } } catch { Write-Hata 'acma istegi silme' $_ }
}
function Test-KasaAcIstegi {
  try {
    if (-not (Test-Path -LiteralPath $KasaAcIstegi)) { return $false }
    if (((Get-Date) - (Get-Item -LiteralPath $KasaAcIstegi).LastWriteTime).TotalMinutes -gt 30) { Clear-KasaAcIstegi; return $false }
    return $true
  } catch {
    Write-Hata 'acma istegi okuma' $_
    return $false
  }
}

# Musteri ekranini kapatir (kasa penceresi kullanici tarafindan kapatilinca: uygulama butunuyle kapansin)
function Stop-CustomerDisplay {
  try {
    Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*chrome-musteri*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { Write-Hata 'musteri ekranini kapatma' $_ }
}

# Acilis penceresi (kasa kisayolu, -Ac; 28 Kas 2026, sahibin istegi: "estetiklestir"): tam ekran, ev yesilinin degradesi
# (DESIGN.md marka rayi #0B6449 > #095A42 > #074A37), ortada AsilPOS simgesi (asilpos.ico), "AsilPOS aciliyor" ve alt
# satir. Gorev cubugunda AsilPOS simgesiyle gorunur, kasa penceresi ekrana gelince kapanir. Sunucu 20 sn'de gelmezse yazi
# "Sunucu bekleniyor..." olur; Esc her an, 20 sn'den sonra ekrana dokunmak da pencereyi kapatir (kasiyer kilitlenmez;
# kasa penceresi sunucu gelince yine acilir). Kendi is parcaciginda calisir (bekleme onu dondurmaz). Hata olursa pencere
# olmadan devam edilir, iletisi gunluge gecer (Stop-Splash)
function Start-Splash {
  try {
    $durum = [hashtable]::Synchronized(@{ kapat = $false; sunucu = $false; bekliyor = $false; kullanici = $false; gorundu = $null; hata = $null })
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'
    $rs.ThreadOptions = 'ReuseThread'
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('durum', $durum)
    $rs.SessionStateProxy.SetVariable('ikon', (Join-Path $KurulumKlasoru 'asilpos.ico'))
    $rs.SessionStateProxy.SetVariable('baslikMetni', (Tr 'AsilPOS a{c}{i}l{i}yor'))
    $rs.SessionStateProxy.SetVariable('altMetin', (Tr 'Kasa ekran{i} haz{i}rlan{i}yor'))
    $rs.SessionStateProxy.SetVariable('bekleMetni', 'Sunucu bekleniyor...')
    $rs.SessionStateProxy.SetVariable('kapatMetni', (Tr 'Kapatmak i{c}in Esc''ye bas{i}n ya da ekrana dokunun'))
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript({
        try {
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $basla = [DateTime]::Now
          $f = New-Object System.Windows.Forms.Form
          $f.Text = 'AsilPOS'
          $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
          $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
          $f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $f.BackColor = [System.Drawing.Color]::FromArgb(9, 90, 66)
          $f.ShowInTaskbar = $true
          $f.KeyPreview = $true
          # Titremeden cizim: cift tampon (ozellik korumali, yansimayla)
          $f.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance, NonPublic').SetValue($f, $true, $null)
          $resim = $null
          if (Test-Path -LiteralPath $ikon) {
            $f.Icon = New-Object System.Drawing.Icon($ikon)
            $resim = (New-Object System.Drawing.Icon($ikon, 256, 256)).ToBitmap()
          }
          $baslikYazi = New-Object System.Drawing.Font('Segoe UI Semibold', [single]26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
          $altYazi = New-Object System.Drawing.Font('Segoe UI', [single]13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
          $beyaz = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255))
          $acik = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(227, 242, 234))
          $soluk = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 227, 207))
          $orta = New-Object System.Drawing.StringFormat
          $orta.Alignment = [System.Drawing.StringAlignment]::Center
          $f.Add_Paint({
              param($s, $e)
              try {
                $g = $e.Graphics
                $w = $f.ClientSize.Width
                $h = $f.ClientSize.Height
                if ($w -lt 2 -or $h -lt 2) { return }
                $o = $g.DpiX / 96
                $alan = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
                $zemin = New-Object System.Drawing.Drawing2D.LinearGradientBrush($alan, [System.Drawing.Color]::FromArgb(11, 100, 73), [System.Drawing.Color]::FromArgb(7, 74, 55), [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
                $karisim = New-Object System.Drawing.Drawing2D.ColorBlend(3)
                $karisim.Colors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(11, 100, 73), [System.Drawing.Color]::FromArgb(9, 90, 66), [System.Drawing.Color]::FromArgb(7, 74, 55))
                $karisim.Positions = [single[]]@(0, 0.5, 1)
                $zemin.InterpolationColors = $karisim
                $g.FillRectangle($zemin, $alan)
                $zemin.Dispose()
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
                $ust = $baslikMetni
                $alt = $altMetin
                if ($durum.bekliyor) { $ust = $bekleMetni; $alt = $kapatMetni }
                $boy = [int](112 * $o)
                $b1 = $g.MeasureString($ust, $baslikYazi).Height
                $b2 = $g.MeasureString($alt, $altYazi).Height
                $toplam = $boy + 28 * $o + $b1 + 8 * $o + $b2
                $y = [single](($h - $toplam) / 2 - $h * 0.03)
                if ($resim) { $g.DrawImage($resim, (New-Object System.Drawing.Rectangle([int](($w - $boy) / 2), [int]$y, $boy, $boy))) }
                $y = $y + $boy + 28 * $o
                $g.DrawString($ust, $baslikYazi, $beyaz, (New-Object System.Drawing.RectangleF(0, $y, $w, $b1)), $orta)
                $y = $y + $b1 + 8 * $o
                $firca = $acik
                if ($durum.bekliyor) { $firca = $soluk }
                $g.DrawString($alt, $altYazi, $firca, (New-Object System.Drawing.RectangleF(0, $y, $w, $b2)), $orta)
              } catch { $durum.hata = 'cizim: ' + $_.Exception.Message }
            })
          $f.Add_KeyDown({
              param($s, $e)
              try { if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $durum.kullanici = $true; $f.Close() } } catch { $durum.hata = 'tus: ' + $_.Exception.Message }
            })
          $f.Add_MouseDown({
              try { if ($durum.bekliyor) { $durum.kullanici = $true; $f.Close() } } catch { $durum.hata = 'dokunma: ' + $_.Exception.Message }
            })
          $f.Add_Shown({
              try { $durum.gorundu = [int]([DateTime]::Now - $basla).TotalMilliseconds; $f.Activate() } catch { $durum.hata = 'gosterme: ' + $_.Exception.Message }
            })
          $t = New-Object System.Windows.Forms.Timer
          $t.Interval = 200
          $t.Add_Tick({
              try {
                if ($durum.kapat) { $f.Close(); return }
                $bekle = (-not $durum.sunucu) -and (([DateTime]::Now - $basla).TotalSeconds -ge 20)
                if ($bekle -ne $durum.bekliyor) { $durum.bekliyor = $bekle; $f.Invalidate() }
              } catch { $durum.hata = 'zamanlayici: ' + $_.Exception.Message }
            })
          $t.Start()
          [System.Windows.Forms.Application]::Run($f)
          $t.Dispose()
          foreach ($x in @($baslikYazi, $altYazi, $beyaz, $acik, $soluk, $orta, $resim)) { if ($x) { $x.Dispose() } }
        } catch {
          $durum.hata = $_.Exception.Message
        }
      })
    $h = $ps.BeginInvoke()
    return @{ durum = $durum; ps = $ps; rs = $rs; h = $h }
  } catch {
    Write-Hata 'acilis penceresi' $_
    return $null
  }
}

function Stop-Splash($s) {
  if (-not $s) { return }
  try {
    $s.durum.kapat = $true
    [void]$s.h.AsyncWaitHandle.WaitOne(3000)
    if ($null -ne $s.durum.gorundu) { Write-Log ('acilis penceresi gorundu (' + $s.durum.gorundu + ' ms)') }
    if ($s.durum.hata) { Write-Log ('acilis penceresi hatasi: ' + $s.durum.hata) }
    if ($s.durum.kullanici) { Write-Log 'acilis penceresini kullanici kapatti' }
    $s.ps.Dispose()
    $s.rs.Close()
  } catch { Write-Hata 'acilis penceresini kapatma' $_ }
}

# Sunucu cevap verene dek bekler (en cok $saniye); verirse $true
function Wait-Server([string]$base, [int]$saniye) {
  $son = (Get-Date).AddSeconds($saniye)
  while ($true) {
    if (Test-Server $base) { return $true }
    if ((Get-Date) -ge $son) { return $false }
    Start-Sleep -Seconds 1
  }
}

# Kasa penceresini acar (yoksa). $SunucuGerek: sunucu kapaliysa acmaz (bekci; hata sayfasi acilmasin). $OneGetir: zaten
# aciksa one getirir (kisayol; bekci getirmez). Dondurdugu: $false yalniz tarayici bulunamazsa
function Open-KasaWindow([bool]$SunucuGerek, [bool]$OneGetir = $false) {
  $mx = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaPencere')
  $own = $false
  try {
    try { $own = $mx.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $own = $true }
    $acik = Get-KasaProcess
    if ($acik) {
      if ($OneGetir) { Show-KasaWindow $acik }
      return $true
    }
    $kasaUrl = Get-KasaUrl
    if ($SunucuGerek -and -not (Test-Server (($kasaUrl -replace '//localhost', '//127.0.0.1').TrimEnd('/')))) { return $true }
    $exe = Get-DisplayExe
    if (-not $exe) { return $false }
    $common = @('--no-first-run', '--no-default-browser-check', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required')
    if ($exe -like '*msedge.exe') {
      # Edge pencere kipinde (27 Kas 2026): Edge'in kiosk kipi (--kiosk, tam ekran ya da tek uygulama) her zaman InPrivate acar; pencere
      # her yeniden acilista oturumu, gonderilmemis sepeti ve tercihleri kaybederdi. Uygulama penceresi (--app) tam ekran
      # (--start-fullscreen) ayni adres cubuksuz gorunumu kalici profille verir; profil klasoru ayni (eski bekci tanir)
      $kasaProfil = Join-Path $env:LOCALAPPDATA 'LafPOS\edge'
      $kasaArgs = @(('--app=' + $kasaUrl), '--start-fullscreen', '--kiosk-printing', ('--user-data-dir="' + $kasaProfil + '"')) + $common + @('--disable-session-crashed-bubble', '--disable-features=Translate', '--noerrdialogs')
    } else {
      $kasaProfil = Join-Path $env:LOCALAPPDATA 'LafPOS\chrome'
      $kasaArgs = @('--kiosk', '--kiosk-printing', ('--app=' + $kasaUrl), ('--user-data-dir="' + $kasaProfil + '"')) + $common + @('--disable-session-crashed-bubble', '--disable-features=Translate', '--noerrdialogs')
    }
    # Kasa profilinin tarayicisi yok (Get-KasaProcess, kilit altinda): eski arayuz onbellekten acilmasin
    Clear-BrowserCache $kasaProfil
    Start-Process -FilePath $exe -ArgumentList $kasaArgs -WorkingDirectory $KurulumKlasoru | Out-Null
    Write-Log ('kasa penceresi acildi (' + (Split-Path -Leaf $exe) + ')')
    # Surec gorunene dek beklenir: ardindan gelen (kisayol ya da bekci) ikinci pencere acmasin
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-KasaWindow) { break }
    }
    return $true
  } catch {
    Write-Hata 'kasa penceresi' $_
    return $true
  } finally {
    if ($own) { try { $mx.ReleaseMutex() } catch { } }
    $mx.Dispose()
  }
}

# Cokme ayrimi (28 Kas 2026; bekci surumu 7). #195'ten beri bekci kullanicinin kapattigi pencereyi yeniden acmiyor; pencere
# cokerse de acmiyordu (vardiya ortasinda kasiyer masaustunde kalirdi). Chromium (Chrome da Edge de) acilistan birkac saniye
# sonra profilin Default\Preferences dosyasina profile.exit_type = "Crashed" yazar; duzgun kapaninca (Alt+F4, kapatma
# dugmesi) "Normal", Windows oturumu kapanirken "SessionEnded". Surec coker ya da zorla kapatilirsa (Gorev Yoneticisi'nde
# Gorevi sonlandir, bellek) "Crashed" kalir; tarayici da "sayfalari geri yukle" sorusunu buna gore sorar. Ikinci isaret
# surecin cikis kodu (bekci tutamagi pencere acikken alir): duzgun kapanista 0. Coktu sayilmasi icin dosya iki okumada da
# (3 sn arayla) "Crashed" demeli ve cikis kodu 0 olmamali. Dosya okunamazsa, deger yoksa, birden cok ya da baskaysa ya da
# cikis kodu 0 ise coktu SAYILMAZ: emin olunamayan pencere yeniden acilmaz. Tarayici degeri acilistan ~10 sn sonra diske
# yazar: daha once coken pencere de yeniden acilmaz (guvenli taraf). Dondurdugu: Preferences'taki deger ya da $null
function Get-ExitType([string]$profil) {
  $b = Read-ScriptBytes (Join-Path $profil 'Default\Preferences')
  if ($null -eq $b -or $b.Length -eq 0) { return $null }
  $m = [regex]::Matches([System.Text.Encoding]::UTF8.GetString($b), '"exit_type"\s*:\s*"(\w+)"')
  if ($m.Count -ne 1) { return $null }
  return $m[0].Groups[1].Value
}

# Gorulen kasa penceresi: sureci (cikis kodu icin tutamak acik tutulur) ve profil klasoru
function Watch-KasaProcess($kasa) {
  $surec = $null
  try {
    $surec = [System.Diagnostics.Process]::GetProcessById([int]$kasa.ProcessId)
    [void]$surec.Handle
  } catch {
    Write-Hata 'kasa sureci izleme (cikis kodu bilinmeyecek)' $_
    $surec = $null
  }
  $profil = 'chrome'
  if ([string]$kasa.CommandLine -match '\\LafPOS\\(chrome|edge)(?![\w-])') { $profil = $Matches[1] }
  Write-Log ('kasa penceresi izleniyor: surec ' + $kasa.ProcessId + ' (' + $profil + ')')
  return @{ Pid = [int]$kasa.ProcessId; Surec = $surec; Profil = (Join-Path $env:LOCALAPPDATA ($EskiAd + '\' + $profil)) }
}

function Close-Izlenen($izlenen) {
  if ($izlenen -and $izlenen.Surec) { try { $izlenen.Surec.Dispose() } catch { Write-Hata 'surec tutamagi' $_ } }
}

# Kasa penceresi nasil kapandi (yukaridaki kural). karar: 'acik' (surec hala calisiyor: sorgu bir an gormedi), 'coktu',
# 'kapatildi' (duzgun kapandi ya da emin olunamadi); metin gunluge
function Get-KasaKapanis($izlenen) {
  $kod = $null
  if ($izlenen.Surec) {
    try {
      if (-not $izlenen.Surec.WaitForExit(3000)) { return @{ karar = 'acik'; metin = 'surec calisiyor' } }
      $kod = $izlenen.Surec.ExitCode
    } catch {
      Write-Hata 'cikis kodu' $_
      $kod = $null
    }
  } elseif (Get-Process -Id $izlenen.Pid -ErrorAction SilentlyContinue) {
    return @{ karar = 'acik'; metin = 'surec calisiyor' }
  }
  $ilk = Get-ExitType $izlenen.Profil
  $son = $ilk
  if ($ilk -eq 'Crashed') {
    Start-Sleep -Seconds 3
    $son = Get-ExitType $izlenen.Profil
  }
  $kodMetni = 'bilinmiyor'
  if ($null -ne $kod) { $kodMetni = [string]$kod }
  $metin = 'exit_type ' + $(if ($son) { $son } else { 'okunamadi' }) + ', cikis kodu ' + $kodMetni + ' (' + (Split-Path -Leaf $izlenen.Profil) + ')'
  if ($ilk -eq 'Crashed' -and $son -eq 'Crashed' -and $kod -ne 0) { return @{ karar = 'coktu'; metin = 'coktu: ' + $metin } }
  return @{ karar = 'kapatildi'; metin = 'kullanici kapatti ya da emin olunamadi: ' + $metin }
}

# Sahadaki gecici kasa denetcisi: yalniz kullanici Baslangic'indaki kisayolu ve klasoru (ve oradan calisan sureci)
function Remove-TemporaryKasaWatcher {
  try {
    Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*LafPOS-KasaKontrol*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LafPOS Kasa Kontrol.lnk'
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
    $dir = Join-Path $env:LOCALAPPDATA 'LafPOS-KasaKontrol'
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  } catch { Write-Hata 'gecici kasa denetcisi' $_ }
}

# Betigin diskteki hali (bekcinin kendini yenilemesi). Dosya silme paylasimiyla acilir: guncelleme o an app\ klasorunu
# tasiyabilsin
function Read-ScriptBytes([string]$path) {
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $ms = New-Object System.IO.MemoryStream
    $fs.CopyTo($ms)
    return , $ms.ToArray()
  } catch {
    return $null
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

function Get-ScriptHash([string]$path) {
  $b = Read-ScriptBytes $path
  if ($null -eq $b -or $b.Length -eq 0) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($b)) } finally { $sha.Dispose() }
}

function Get-ScriptVersion([string]$path) {
  $b = Read-ScriptBytes $path
  if ($null -eq $b -or $b.Length -eq 0) { return 0 }
  $m = [regex]::Match([System.Text.Encoding]::ASCII.GetString($b), '(?m)^\$BekciSurumu = (\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return 0
}

# Bekciyi baslatir (kurulum klasorunde: app\ tasinabilsin)
function Start-WatcherProcess([int]$surum) {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $KurulumKlasoru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'), '-Bekci', '-BekciSurum', [string]$surum) | Out-Null
}

# Bekci calismiyorsa acar; eski surum bekci kapatilir. Bekcinin Baslangic kisayolu: guncelleme ortak Baslangic'a yazar;
# yazamadiysa (ve kasa ekrani acilista aciliyorsa) kullanici Baslangic'ina konur. Yonetici izni gerekmez. $surecler
# (Get-PowerShellSurecleri) verilirse yeniden sorulmaz
function Start-WatcherIfNeeded($surecler = $null) {
  try {
    if ($null -eq $surecler) { $surecler = @(Get-PowerShellSurecleri) }
    $surumli = '*-BekciSurum ' + $BekciSurumu + '*'
    $bekciler = @($surecler | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*kasa-yazici.ps1*-Bekci*' })
    # Eski surum bekci kapatilir, yenisi acilir
    $bekciler | Where-Object { $_.CommandLine -notlike $surumli } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Log ('eski surum bekci kapatildi: ' + $_.ProcessId) }
    $watching = $bekciler | Where-Object { $_.CommandLine -like $surumli } | Select-Object -First 1
    if ($PSCommandPath -and -not $watching) { Start-WatcherProcess $BekciSurumu }
    $ortak = [Environment]::GetFolderPath('CommonStartup')
    $kendi = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    $kasaAcilista = $false
    $bekciVar = $false
    foreach ($d in @($ortak, $kendi)) {
      foreach ($ad in @('AsilPOS Kasa.lnk', ($EskiAd + ' Kasa.lnk'))) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $kasaAcilista = $true } }
      foreach ($ad in @($BekciKisayolu, $EskiBekciKisayolu)) { if (Test-Path -LiteralPath (Join-Path $d $ad)) { $bekciVar = $true } }
    }
    if ($PSCommandPath -and $kasaAcilista -and -not $bekciVar) {
      $sh = New-Object -ComObject WScript.Shell
      $k = $sh.CreateShortcut((Join-Path $kendi $BekciKisayolu))
      $k.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $k.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Bekci -BekciSurum ' + $BekciSurumu
      $k.WorkingDirectory = $KurulumKlasoru
      $k.IconLocation = (Join-Path $KurulumKlasoru 'asilpos.ico') + ',0'
      $k.WindowStyle = 7
      $k.Description = 'Kasa kisayolunun istedigi pencereyi sunucu gelince acar; musteri ekranini kasa acikken tutar'
      $k.Save()
    }
  } catch { Write-Hata 'bekci' $_ }
}

# Kullanici Baslat menusundeki eski "Kasa hazirligi" kisayolu (28 Kas 2026, sahibin istegi: kasa acilirken eski kasa
# programi sorusu cikmasin). Kasa programi eskiden her acilista bu simgesiz kisayolu yazar ve haftada bir eski kasa
# programi uyarisini acardi; ikisi de kalkti. Eski kurulumlarda kalan kisayol (eski adli menu klasorundeki de) silinir,
# klasor bosalirsa o da: menude iki "Kasa hazirligi" gorunmez. Ortak menudeki "Kasa hazirligi" (kurulum-yenile.mjs
# kisayol listesi) kalir
function Remove-UserPrepShortcut {
  foreach ($ad in @('AsilPOS', $EskiAd)) {
    try {
      $menu = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $ad)
      $lnk = Join-Path $menu 'Kasa hazirligi.lnk'
      if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force
        if (-not @(Get-ChildItem -LiteralPath $menu -Force).Count) { Remove-Item -LiteralPath $menu -Force }
      }
    } catch { Write-Hata 'eski hazirlik kisayolu' $_ }
  }
}

# Yazicilar: bilgisayardaki yazicilar AsilPOS'a bildirilir, AsilPOS'un sectigi fis yazicisi varsayilan yapilir. Yazici
# listesi bir kez sorulur (28 Kas 2026; Win32_Printer sorgusu 15 sn'ye kadar surebilir, eskiden iki kez soruluyordu)
function Send-Printers([string]$base) {
  try {
    $yazicilar = @(Get-CimInstance -ClassName Win32_Printer -OperationTimeoutSec 15)
    $list = @($yazicilar | ForEach-Object {
        [pscustomobject]@{ Name = $_.Name; PortName = $_.PortName; DriverName = $_.DriverName; Default = [bool]$_.Default; WorkOffline = [bool]$_.WorkOffline }
      })
    $body = ConvertTo-Json -InputObject @{ printers = $list } -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Method Post -Uri ($base + '/api/kasa/yazicilar') -ContentType 'application/json; charset=utf-8' -Body $bytes
    $name = [string]$res.name
    if (-not $name) {
      Write-Log ('yazicilar bildirildi (' + $list.Count + '); fis yazicisi secilmedi')
      return
    }
    # Windows 10/11 "varsayilan yaziciyi Windows yonetsin" kapali: secilen yazici son kullanilanla degismez
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord
    $printer = $yazicilar | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($printer -and -not $printer.Default) {
      Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter | Out-Null
      Write-Log ('varsayilan yazici yapildi: ' + $name)
    }
  } catch { Write-Hata 'yazicilar' $_ }
}

# Sunucu IPv4 dinler; localhost once IPv6 denenip yavaslar
$displayBase = $Url
if (-not $displayBase) { $displayBase = 'http://localhost:4000/' }
$displayBase = ($displayBase -replace '//localhost', '//127.0.0.1').TrimEnd('/')

if ($KasaAc) {
  # Eski kasa kisayolu (AsilPOS-Kasa.bat): kasa penceresini ac ya da one getir; tarayici yoksa 1 (bat uyarir)
  if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi; exit 0 }
  exit 1
}

if ($Bekci) {
  # Arka plan bekcisi: kisayolun istedigi kasa penceresini acar, coken pencereyi yeniden acar, musteri ekranini kasa
  # acikken tutar. Tek bekci
  $tek = New-Object System.Threading.Mutex($false, 'Local\LafPOS-KasaBekci')
  $own = $false
  try { $own = $tek.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $own = $true }
  if (-not $own) { exit 0 }
  Write-Log ('bekci basladi (surum ' + $BekciSurumu + ')')
  Remove-TemporaryKasaWatcher
  $ilkOzet = Get-ScriptHash $PSCommandPath
  $tur = 0
  $kasaAcikti = $false
  # Gorulen kasa penceresi (Watch-KasaProcess), yeniden acilan cokmelerin zamani (10 dakikada en cok 3: tarayici her
  # acilista cokuyorsa dongu olmasin), coken pencere icin acilacak pencerenin one getirilmesi, son hata (tekrari yazilmaz)
  $izlenen = $null
  $cokmeler = @()
  $cokmeOne = $false
  $sonHata = ''
  while ($true) {
    try {
      $surecler = @(Get-TarayiciSurecleri)
      $kasa = Get-KasaProcess $surecler
      $kasaAcik = [bool]$kasa
      if ($kasa) {
        if (-not $izlenen -or $izlenen.Pid -ne [int]$kasa.ProcessId) {
          Close-Izlenen $izlenen
          $izlenen = Watch-KasaProcess $kasa
        }
      } elseif ($kasaAcikti -and $izlenen) {
        # Pencere kapandi: kullanici kapattiysa yeniden acilmaz (#195); coktuyse istek birakilir, asagida acilir
        $kapanis = Get-KasaKapanis $izlenen
        if ($kapanis.karar -eq 'acik') {
          $kasaAcik = $true
        } else {
          Write-Log ('kasa penceresi kapandi, ' + $kapanis.metin)
          if ($kapanis.karar -eq 'coktu') {
            $simdi = Get-Date
            $cokmeler = @($cokmeler | Where-Object { ($simdi - $_).TotalMinutes -lt 10 })
            if (Test-KasaBakim $displayBase) {
              Write-Log 'bakim arasi suruyor: coken pencere yeniden acilmaz'
            } elseif ($cokmeler.Count -ge 3) {
              Write-Log '10 dakikada 3 kez coktu: yeniden acilmaz (AsilPOS Kasa kisayoluyla acin)'
            } else {
              $cokmeler += $simdi
              $cokmeOne = $true
              Set-KasaAcIstegi
              Write-Log 'coken kasa penceresi yeniden acilacak'
            }
          }
          Close-Izlenen $izlenen
          $izlenen = $null
        }
      }
      # Kisayolun (ya da coken pencerenin) istegi: sunucu gelince kasa penceresi acilir, istek silinir. Ilk turda kisayolun
      # kendisi acsin diye bakilmaz
      if ($tur -gt 0 -and (Test-KasaAcIstegi) -and -not (Test-KasaWindow) -and -not (Test-KasaBakim $displayBase) -and (Test-Server $displayBase)) {
        if (Open-KasaWindow $true) { Clear-KasaAcIstegi }
        $yeni = Wait-KasaPenceresi 10
        if ($yeni) {
          $kasaAcik = $true
          # Coken pencere kasiyerin onundeydi: yenisi de one gelir (kisayolun istegiyle acilan pencere arka planda kalir)
          if ($cokmeOne) { Show-KasaWindow $yeni }
        }
        $cokmeOne = $false
        $surecler = @(Get-TarayiciSurecleri)
      }
      if ($kasaAcik) {
        if (-not (Test-CustomerDisplay $surecler)) { [void](Start-CustomerDisplay $displayBase) }
      } elseif ($kasaAcikti) {
        # Kullanici kasa penceresini kapatti: yeniden acilmaz, musteri ekrani da kapanir (sahibin istegi, 28 Kas 2026)
        Stop-CustomerDisplay
      }
      $kasaAcikti = $kasaAcik
    } catch {
      $m = 'bekci turu hatasi: ' + (($_.Exception.Message -replace '[\r\n]+', ' ').Trim())
      if ($m -ne $sonHata) { Write-Log $m }
      $sonHata = $m
    }
    $tur++
    Start-Sleep -Seconds 15
    # Kendini yenileme (27 Kas 2026): otomatik guncelleme app\'i degistirince bu betigin diskteki hali degisir. Bekci
    # yenisini acip cikar (kilidi once birakir); yeni pencere kurallari oturum kapanmayi beklemez. Diskteki betik 5'ten
    # eski bir surumse (elle geri donus) bu bekci calismaya devam eder
    $ozet = Get-ScriptHash $PSCommandPath
    if ($ilkOzet -and $ozet -and $ozet -ne $ilkOzet) {
      $yeniSurum = Get-ScriptVersion $PSCommandPath
      if ($yeniSurum -ge 5) {
        Write-Log ('betik degisti: bekci yenisiyle yeniden basliyor (surum ' + $yeniSurum + ')')
        Close-Izlenen $izlenen
        try { $tek.ReleaseMutex() } catch { }
        $tek.Dispose()
        Start-WatcherProcess $yeniSurum
        exit 0
      }
      $ilkOzet = $ozet
    }
  }
}

if ($Ac) {
  # Kasa programi (kisayol). Iki tiklama ust uste gelirse ikincisi beklemez: ilki acar, pencere varsa one getirilir
  $saat = [System.Diagnostics.Stopwatch]::StartNew()
  $adimlar = New-Object System.Collections.Generic.List[string]
  $oncekiMs = 0
  # Adim suresi (ms): acilisin sonunda tek satir gunluge. Ilk adim PowerShell'in kendi acilisi (surec baslangicindan beri)
  function Add-Adim([string]$ad) {
    $simdi = $saat.ElapsedMilliseconds
    $adimlar.Add($ad + ' ' + ($simdi - $script:oncekiMs) + ' ms')
    $script:oncekiMs = $simdi
  }
  try { $adimlar.Add('powershell ' + [int]([DateTime]::Now - [System.Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds + ' ms') } catch { Write-Hata 'surec baslangici' $_ }
  $tekAcilis = New-Object System.Threading.Mutex($false, 'Local\AsilPOS-KasaAcilis')
  $acilisBende = $false
  try { $acilisBende = $tekAcilis.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acilisBende = $true }
  $acik = $null
  try { $acik = Get-KasaProcess } catch { Write-Hata 'kasa sureci sorgusu' $_; $acik = $null }
  if ($acik) { Show-KasaWindow $acik }
  if (-not $acilisBende) { exit 0 }
  if (-not $acik -and -not (Get-DisplayExe)) {
    Write-Log 'Chrome ya da Edge bulunamadi'
    Show-Message (Tr 'Chrome ya da Edge bulunamad{i}. Kasa ekran{i} i{c}in https://www.google.com/chrome adresinden Chrome''u kurun.')
    exit 1
  }
  Add-Adim 'denetim'
  $splash = $null
  $bekciBakildi = $false
  $hazir = $true
  $kasa = $acik
  try {
    if (-not $acik) {
      $splash = Start-Splash
      Add-Adim 'acilis penceresi'
      # Istek once: sunucu 90 sn'de gelmezse pencereyi bekci acar (istek yoksa bekci acmaz)
      Set-KasaAcIstegi
      $hazir = Test-Server $displayBase
      if (-not $hazir) {
        # Sunucu henuz yok (bilgisayar yeni acildi): bekci once, sunucu gec gelirse kasa penceresini o acar
        Start-WatcherIfNeeded
        $bekciBakildi = $true
        $hazir = Wait-Server $displayBase 90
      }
      Add-Adim 'sunucu'
      if ($splash) { $splash.durum.sunucu = $hazir }
      if ($hazir) {
        if (Open-KasaWindow $false $true) { Clear-KasaAcIstegi }
        $kasa = Wait-KasaPenceresi 5
        Add-Adim 'kasa penceresi'
      } else {
        Write-Log 'sunucu 90 sn icinde acilmadi: kasa penceresini sunucu gelince bekci acar'
      }
    }
  } finally {
    Stop-Splash $splash
  }
  # Kasa penceresinden sonra (28 Kas 2026): bekci, musteri ekrani, yazicilar. Musteri ekrani yeni acildiysa kasa penceresi
  # yeniden one gelir (klavye ve barkod okuyucu kasaya yazsin)
  $psSurecleri = $null
  try { $psSurecleri = @(Get-PowerShellSurecleri) } catch { Write-Hata 'powershell surecleri' $_ }
  if (-not $bekciBakildi) { Start-WatcherIfNeeded $psSurecleri; Add-Adim 'bekci' }
  if ($hazir) {
    if ((Start-CustomerDisplay $displayBase) -and $kasa) { Show-KasaWindow $kasa }
    Add-Adim 'musteri ekrani'
    Send-Printers $displayBase
    Add-Adim 'yazicilar'
  }
  Stop-TemporaryDisplayWatcher $psSurecleri
  Remove-UserPrepShortcut
  $ozetSatiri = 'acilis: ' + ($adimlar -join ', ') + '; toplam ' + $saat.ElapsedMilliseconds + ' ms'
  if ($acik) { $ozetSatiri = 'acik pencere one getirildi; ' + $ozetSatiri }
  Write-Log $ozetSatiri
  exit 0
}

# Kipsiz: 27 Kasim oncesinin kasa kisayolu (AsilPOS-Kasa.bat) bunu -KasaAc'tan once cagirir
Remove-UserPrepShortcut
Stop-TemporaryDisplayWatcher
[void](Start-CustomerDisplay $displayBase)
Start-WatcherIfNeeded
Send-Printers $displayBase
exit 0
