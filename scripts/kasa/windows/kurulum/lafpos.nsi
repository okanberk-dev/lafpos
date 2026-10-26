; LafPOS Windows kurulumu (NSIS 3). Derleme: npm run kurulum:windows (derle.mjs STAGE ve VERSION verir).
; Kurar: Program Files\LafPOS (Node, sunucu, arayüz, kasa kısayolu), veri C:\ProgramData\LafPOS (yalnız SYSTEM
; ve yöneticiler), açılışta SYSTEM olarak çalışan "LafPOS Sunucu" görevi, güvenlik duvarında yerel ağ ve
; Tailscale izni. Güncellemede önce veritabanını kopyalar. Kaldırma verilere dokunmaz.
; Ayrıntı: docs/05-KASA-BILGISAYARI.md

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !error "derle.mjs ile derleyin: -DVERSION=… -DSTAGE=… -DOUTFILE=…"
!endif
!ifndef STAGE
  !error "STAGE verilmedi"
!endif
!ifndef OUTFILE
  !error "OUTFILE verilmedi"
!endif

!define TASK "LafPOS Sunucu"
!define FIREWALL "LafPOS Sunucu"
!define PORT 4000
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LafPOS"

Name "LafPOS"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\LafPOS"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
BrandingText "LafPOS ${VERSION}"

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include WinVer.nsh
!include x64.nsh

Var DATA ; C:\ProgramData\LafPOS

!define MUI_ICON "${STAGE}/lafpos.ico"
!define MUI_UNICON "${STAGE}/lafpos.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "LafPOS kurulumu"
!define MUI_WELCOMEPAGE_TEXT "LafPOS bu bilgisayara kurulacak. Sunucu Windows açılınca arka planda kendiliğinden çalışır; kasa ekranı tam ekran açılır, tablet ve telefonlar kafenin ağından bağlanır.$\r$\n$\r$\nVeriler C:\ProgramData\LafPOS klasöründe durur. Güncelleme önce veritabanının kopyasını alır; kaldırma verilere dokunmaz."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "LafPOS hazır"
!define MUI_FINISHPAGE_TEXT "Sunucu çalışıyor ve Windows her açıldığında kendiliğinden başlar.$\r$\n$\r$\nTablet ve telefonlar: http://<bu bilgisayarın IP adresi>:${PORT}. Adres ve karekod Yönetim › Ağ ve uzaktan erişim sayfasında.$\r$\n$\r$\nÖrnek PIN'leri canlıya geçmeden Yönetim › Personel'den değiştirin."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Kasa ekranını şimdi aç"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenKasa
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\BENIOKU.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Kurulum notlarını göster"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Turkish"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_TURKISH} "ProductName" "LafPOS"
VIAddVersionKey /LANG=${LANG_TURKISH} "CompanyName" "L'Affogato"
VIAddVersionKey /LANG=${LANG_TURKISH} "FileDescription" "LafPOS kurulumu"
VIAddVersionKey /LANG=${LANG_TURKISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_TURKISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_TURKISH} "LegalCopyright" "L'Affogato"

!macro Run CMD
  nsExec::ExecToLog `${CMD}`
  Pop $0
!macroend

!macro TaskLine TEXT
  FileWriteUTF16LE $9 `${TEXT}$\r$\n`
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "LafPOS 64 bit Windows 10 ya da 11 ister." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext all
  StrCpy $DATA "$APPDATA\LafPOS"
FunctionEnd

Section "LafPOS sunucusu ve kasa ekranı" SecMain
  SectionIn RO
  InitPluginsDir

  ; Güncellemede çalışan sunucuyu durdur: dosyalar kilitli kalmasın, veritabanı kopyası tutarlı olsun
  DetailPrint "Çalışan LafPOS sunucusu durduruluyor"
  !insertmacro Run '"$SYSDIR\schtasks.exe" /End /TN "${TASK}"'
  Sleep 2000

  ${If} ${FileExists} "$DATA\lafpos.db"
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    StrCpy $8 "$DATA\backups\lafpos-guncelleme-$3-$2-$1-$5$6.db"
    CreateDirectory "$DATA\backups"
    CopyFiles /SILENT "$DATA\lafpos.db" "$8"
    ${If} ${FileExists} "$DATA\lafpos.db-wal"
      CopyFiles /SILENT "$DATA\lafpos.db-wal" "$8-wal"
    ${EndIf}
    DetailPrint "Veritabanının kopyası: $8"
  ${EndIf}

  ; Uygulama klasörlerinde veri yok; eski sürümün dosyaları kalmasın
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*"

  ; Veri klasörü: yalnız SYSTEM (sunucu) ve Yöneticiler. Türkçe Windows'ta grup adı farklı, SID kullanılır
  CreateDirectory "$DATA"
  !insertmacro Run '"$SYSDIR\icacls.exe" "$DATA" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F'
  ${IfNot} ${FileExists} "$DATA\ayarlar.env"
    CopyFiles /SILENT "$INSTDIR\ayarlar.env.ornek" "$DATA\ayarlar.env"
  ${EndIf}

  ; Sunucu görevi: açılışta SYSTEM olarak, süre sınırı yok, pilde de çalışır, düşerse dakikada bir yeniden
  FileOpen $9 "$PLUGINSDIR\gorev.xml" w
  FileWriteWord $9 0xFEFF
  !insertmacro TaskLine '<?xml version="1.0" encoding="UTF-16"?>'
  !insertmacro TaskLine '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
  !insertmacro TaskLine '  <RegistrationInfo><Description>LafPOS yerel sunucusu: kasa, tablet ve telefonlar buna bağlanır</Description></RegistrationInfo>'
  !insertmacro TaskLine '  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>'
  !insertmacro TaskLine '  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>'
  !insertmacro TaskLine '  <Settings>'
  !insertmacro TaskLine '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
  !insertmacro TaskLine '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
  !insertmacro TaskLine '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
  !insertmacro TaskLine '    <AllowHardTerminate>true</AllowHardTerminate>'
  !insertmacro TaskLine '    <StartWhenAvailable>true</StartWhenAvailable>'
  !insertmacro TaskLine '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>'
  !insertmacro TaskLine '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>'
  !insertmacro TaskLine '    <AllowStartOnDemand>true</AllowStartOnDemand>'
  !insertmacro TaskLine '    <Enabled>true</Enabled>'
  !insertmacro TaskLine '    <Hidden>false</Hidden>'
  !insertmacro TaskLine '    <RunOnlyIfIdle>false</RunOnlyIfIdle>'
  !insertmacro TaskLine '    <WakeToRun>false</WakeToRun>'
  !insertmacro TaskLine '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
  !insertmacro TaskLine '    <Priority>5</Priority>'
  !insertmacro TaskLine '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>'
  !insertmacro TaskLine '  </Settings>'
  !insertmacro TaskLine '  <Actions Context="Author"><Exec>'
  !insertmacro TaskLine '    <Command>"$INSTDIR\node\node.exe"</Command>'
  !insertmacro TaskLine '    <Arguments>"$INSTDIR\app\bekci.mjs"</Arguments>'
  !insertmacro TaskLine '    <WorkingDirectory>$INSTDIR\app</WorkingDirectory>'
  !insertmacro TaskLine '  </Exec></Actions>'
  !insertmacro TaskLine '</Task>'
  FileClose $9
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Create /TN "${TASK}" /XML "$PLUGINSDIR\gorev.xml" /RU SYSTEM /F'
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Sunucu görevi oluşturulamadı (kod $0). Kurulumu yönetici olarak yeniden çalıştırın." /SD IDOK
  ${EndIf}

  ; Güvenlik duvarı: yalnız kafenin ağı ve Tailscale (100.64.0.0/10); internete açık port yok
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FIREWALL}"'
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FIREWALL}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=localsubnet profile=any'
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FIREWALL}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=100.64.0.0/10 profile=any'

  ; Başlat menüsü; isteğe bağlı kısayollar aşağıdaki bölümlerde yeniden konur
  Delete "$DESKTOP\LafPOS Kasa.lnk"
  Delete "$SMSTARTUP\LafPOS Kasa.lnk"
  RMDir /r "$SMPROGRAMS\LafPOS"
  CreateDirectory "$SMPROGRAMS\LafPOS"
  CreateShortcut "$SMPROGRAMS\LafPOS\LafPOS Kasa.lnk" "$INSTDIR\LafPOS-Kasa.bat" "" "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED "" "Kasa ekranı (tam ekran)"
  WriteINIStr "$SMPROGRAMS\LafPOS\LafPOS (tarayıcıda).url" "InternetShortcut" "URL" "http://localhost:${PORT}/"
  WriteINIStr "$SMPROGRAMS\LafPOS\LafPOS (tarayıcıda).url" "InternetShortcut" "IconFile" "$INSTDIR\lafpos.ico"
  WriteINIStr "$SMPROGRAMS\LafPOS\LafPOS (tarayıcıda).url" "InternetShortcut" "IconIndex" "0"
  CreateShortcut "$SMPROGRAMS\LafPOS\LafPOS ayarları.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\yonet.ps1" ayarlar' "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED "" "Site, lafmaliyet ve yazarkasa ayarları"
  CreateShortcut "$SMPROGRAMS\LafPOS\Sunucuyu yeniden başlat.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\yonet.ps1" yeniden-baslat' "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\LafPOS\Sunucu günlüğü.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\yonet.ps1" gunluk' "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\LafPOS\Kurulum notları.lnk" "$INSTDIR\BENIOKU.txt"
  CreateShortcut "$SMPROGRAMS\LafPOS\LafPOS'u kaldır.lnk" "$INSTDIR\Kaldir.exe"

  WriteUninstaller "$INSTDIR\Kaldir.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "LafPOS"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "L'Affogato"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\lafpos.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Kaldir.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Kaldir.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $1 $2 $3
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $1

  DetailPrint "LafPOS sunucusu başlatılıyor"
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Run /TN "${TASK}"'
SectionEnd

Section "Masaüstüne kısayol" SecDesktop
  CreateShortcut "$DESKTOP\LafPOS Kasa.lnk" "$INSTDIR\LafPOS-Kasa.bat" "" "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED "" "Kasa ekranı (tam ekran)"
SectionEnd

Section "Oturum açılınca kasa ekranını aç" SecStartup
  CreateShortcut "$SMSTARTUP\LafPOS Kasa.lnk" "$INSTDIR\LafPOS-Kasa.bat" "" "$INSTDIR\lafpos.ico" 0 SW_SHOWMINIMIZED "" "Kasa ekranı (tam ekran)"
SectionEnd

Section "Prizdeyken uyku kapalı" SecPower
  ; Uyuyan bilgisayara tabletler bağlanamaz. Ekran açık kalsın diye LafPOS ekran kilidi ister
  !insertmacro Run '"$SYSDIR\powercfg.exe" /change standby-timeout-ac 0'
  !insertmacro Run '"$SYSDIR\powercfg.exe" /change hibernate-timeout-ac 0'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Sunucu (açılışta SYSTEM olarak), kasa ekranı, güvenlik duvarında yerel ağ ve Tailscale izni."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Masaüstüne LafPOS Kasa kısayolu."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} "Windows'a girilince kasa ekranı tam ekran açılır."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPower} "Bilgisayar prizdeyken uykuya ve hazırda bekletmeye geçmez; tabletler sunucuyu hep bulur."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Kurulum yönetici olarak çalışır; kasa ekranı Gezgin üzerinden normal kullanıcı olarak açılır
Function OpenKasa
  Exec '"$WINDIR\explorer.exe" "$SMPROGRAMS\LafPOS\LafPOS Kasa.lnk"'
FunctionEnd

Function un.onInit
  SetShellVarContext all
  StrCpy $DATA "$APPDATA\LafPOS"
FunctionEnd

Section "Uninstall"
  !insertmacro Run '"$SYSDIR\schtasks.exe" /End /TN "${TASK}"'
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Delete /TN "${TASK}" /F'
  Sleep 2000
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FIREWALL}"'

  Delete "$DESKTOP\LafPOS Kasa.lnk"
  Delete "$SMSTARTUP\LafPOS Kasa.lnk"
  RMDir /r "$SMPROGRAMS\LafPOS"

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\LafPOS-Kasa.bat"
  Delete "$INSTDIR\yonet.ps1"
  Delete "$INSTDIR\lafpos.ico"
  Delete "$INSTDIR\BENIOKU.txt"
  Delete "$INSTDIR\ayarlar.env.ornek"
  Delete "$INSTDIR\Kaldir.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"

  MessageBox MB_ICONINFORMATION "LafPOS kaldırıldı. Veriler ve yedekler silinmedi: $DATA" /SD IDOK
SectionEnd
