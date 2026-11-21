@echo off
rem LafPOS baslaticisi: "LafPOS Sunucu" gorevi bunu acilista SYSTEM olarak calistirir (lafpos.nsi). Bekci 75 koduyla
rem cikarsa (otomatik guncelleme yeni surumu kurdu, guncelle.mjs) yeniden acilir; guncelleme Node'u da degistirdiyse
rem once node.yeni klasoru node'un yerine gecer (calisan node.exe kendi dosyasinin uzerine yazamaz).
rem Dosya ASCII kalir: cmd.exe toplu dosyayi yerel kod sayfasiyla okur.
setlocal
cd /d "%~dp0"
:dongu
if exist "node.yeni\node.exe" (
  if exist "node.eski" rmdir /s /q "node.eski"
  move "node" "node.eski" >nul 2>&1
  move "node.yeni" "node" >nul 2>&1
  rem Tasima yarim kaldiysa eski Node geri gelir: sunucu Node'suz kalmasin
  if not exist "node\node.exe" if exist "node.eski\node.exe" move "node.eski" "node" >nul 2>&1
)
"node\node.exe" "app\bekci.mjs"
if %ERRORLEVEL% EQU 75 goto dongu
exit /b %ERRORLEVEL%
