@echo off
rem AsilPOS baslaticisi: "LafPOS Sunucu" gorevi bunu acilista SYSTEM olarak calistirir (asilpos.nsi). Bekci 75 koduyla
rem cikarsa (otomatik guncelleme yeni surumu kurdu, guncelle.mjs) yeniden acilir; guncelleme Node'u da degistirdiyse
rem once node.yeni klasoru node'un yerine gecer (calisan node.exe kendi dosyasinin uzerine yazamaz). Bekci yeni cikmis
rem oldugundan Windows eski node.exe'yi bir an kilitli tutabilir: tasima 20 saniyeye kadar yeniden denenir.
rem Dosya ASCII kalir: cmd.exe toplu dosyayi yerel kod sayfasiyla okur.
setlocal
cd /d "%~dp0"
:dongu
if exist "node.yeni\node.exe" call :nodedegis
"node\node.exe" "app\bekci.mjs"
if %ERRORLEVEL% EQU 75 goto dongu
exit /b %ERRORLEVEL%

:nodedegis
set deneme=0
:nodetekrar
if exist "node.eski" rmdir /s /q "node.eski"
move "node" "node.eski" >nul 2>&1
if not exist "node\node.exe" goto nodeyeni
set /a deneme+=1
if %deneme% GEQ 20 exit /b 0
ping -n 2 127.0.0.1 >nul
goto nodetekrar
:nodeyeni
rem Yeni Node'u deneyen surec de yeni cikti: node.yeni de bir an kilitli olabilir, 20 saniyeye kadar yeniden denenir
set deneme=0
:yenitekrar
move "node.yeni" "node" >nul 2>&1
if exist "node\node.exe" exit /b 0
set /a deneme+=1
if %deneme% GEQ 20 goto geridon
ping -n 2 127.0.0.1 >nul
goto yenitekrar
:geridon
rem Tasima olmadiysa eski Node geri gelir: sunucu Node'suz kalmasin (node.yeni sonraki acilista yeniden denenir)
if not exist "node\node.exe" if exist "node.eski\node.exe" move "node.eski" "node" >nul 2>&1
exit /b 0
