@echo off
rem AsilPOS kasa ekrani (Windows). Kurulumun kisayollari 27 Kasim 2026'dan beri bunu degil, konsolsuz
rem "powershell -WindowStyle Hidden -File app\kasa-yazici.ps1 -Ac"yi acar (kurulum-yenile.mjs shortcutSpec): bu dosya eski,
rem elle kopyalanmis ya da gorev cubuguna sabitlenmis kisayollar icin ayni programi acip hemen kapanir. Ayrinti:
rem docs/05-KASA-BILGISAYARI.md. Kiosktan cikmak icin Alt+F4.
setlocal
rem Ad degisikligi (26 Kas 2026) oncesinin degiskeni de okunur
if "%ASILPOS_URL%"=="" set "ASILPOS_URL=%LAFPOS_URL%"
if "%ASILPOS_URL%"=="" set "ASILPOS_URL=http://localhost:4000/"
rem Program: betik sunucuyu bekler, yazicilari bildirir, bekciyi ve kasa penceresini acar (zaten aciksa one getirir)
if not exist "%~dp0app\kasa-yazici.ps1" goto eski
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0app\kasa-yazici.ps1" -Ac
exit /b 0

:eski
rem Betik yoksa (git ile gelistirici kurulumu, scripts\kasa\windows\kur.ps1) eski yol: sunucu acilana dek bekle (en cok
rem 90 sn), sonra Chrome (yoksa Edge). Denetim 127.0.0.1'e: sunucu IPv4 dinler, Windows'ta localhost once IPv6 (::1)
rem denenip her seferinde ~2 sn kaybettirir
powershell -NoProfile -Command "$u=($env:ASILPOS_URL -replace '//localhost','//127.0.0.1')+'api/health'; for($i=0;$i -lt 90;$i++){ try { if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u).StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep 1 }"
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
start "" "%CHROME%" --kiosk --kiosk-printing --app=%ASILPOS_URL% --user-data-dir="%LocalAppData%\LafPOS\chrome" --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble --disable-features=Translate --noerrdialogs
exit /b 0

:edge
rem Edge'in kiosk kipi her zaman InPrivate acar (oturum ve sepet her acilista kaybolurdu): tam ekran uygulama penceresi
start "" "%EDGE%" --app=%ASILPOS_URL% --start-fullscreen --kiosk-printing --user-data-dir="%LocalAppData%\LafPOS\edge" --no-first-run --no-default-browser-check --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble --disable-features=Translate --noerrdialogs
exit /b 0
