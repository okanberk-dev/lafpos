@echo off
rem LafPOS kasa ekrani (Windows): Chrome (yoksa Edge) kiosk (tam ekran, adres cubuksuz) ve sessiz fis yazdirma ile acar.
rem Ayrinti: docs/05-KASA-BILGISAYARI.md. Kiosktan cikmak icin Alt+F4.
setlocal
if "%LAFPOS_URL%"=="" set "LAFPOS_URL=http://localhost:4000/"
rem Sunucu acilana dek bekle (en cok 90 sn); bilgisayar yeni acildiysa sunucu birkac saniye gec gelir.
rem Denetim 127.0.0.1'e: sunucu IPv4 dinler, Windows'ta localhost once IPv6 (::1) denenip her seferinde ~2 sn kaybettirir
powershell -NoProfile -Command "$u=($env:LAFPOS_URL -replace '//localhost','//127.0.0.1')+'api/health'; for($i=0;$i -lt 90;$i++){ try { if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u).StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep 1 }"
rem Fis yazicisi: bilgisayardaki yazicilari LafPOS'a bildirir, secilen (ya da tek) fis yazicisini varsayilan yapar;
rem sessiz yazdirma ona basar. Betik guncellemeyle gelir (app\); yoksa ya da hata verirse kasa yine acilir
if exist "%~dp0app\kasa-yazici.ps1" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0app\kasa-yazici.ps1"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" goto chrome
rem Chrome yoksa Windows'la gelen Edge
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto edge
echo Chrome ya da Edge bulunamadi. https://www.google.com/chrome adresinden Chrome'u kurun.
pause
exit /b 1

:chrome
rem Ayri profil: kasa penceresi kisisel Chrome'dan bagimsiz calisir, kiosk ayarlari karismaz
start "" "%CHROME%" --kiosk --kiosk-printing --app=%LAFPOS_URL% --user-data-dir="%LocalAppData%\LafPOS\chrome" --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble --disable-features=Translate --noerrdialogs
exit /b 0

:edge
start "" "%EDGE%" --kiosk %LAFPOS_URL% --edge-kiosk-type=fullscreen --kiosk-printing --user-data-dir="%LocalAppData%\LafPOS\edge" --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --disable-features=Translate --noerrdialogs
exit /b 0
