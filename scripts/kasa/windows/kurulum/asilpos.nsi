; AsilPOS Windows kurulumu (NSIS 3). Derleme: npm run kurulum:windows (derle.mjs STAGE, VERSION ve BUILD verir).
; Kurar: Program Files\LafPOS (Node, sunucu, arayüz, kasa programı), veri C:\ProgramData\LafPOS (yalnız SYSTEM
; ve yöneticiler), açılışta SYSTEM olarak çalışan "LafPOS Sunucu" görevi, güvenlik duvarında yerel ağ ve
; Tailscale izni. Görev bekçiyi başlatıcıdan (baslat.cmd) açar; bekçi yeni sürümü kendiliğinden kurar (guncelle.mjs).
; Bu dosyayla elle güncellemede önce veritabanını kopyalar. Kaldırma verilere dokunmaz.
; Siteden kurulumla (web-kurucu.ps1) aynı programı kurar (27 Kasım 2026): gün açıksa sorar, yeni dosyaları yan klasöre
; açıp eskisiyle yer değiştirir (yarıda kalırsa eski sürüm döner), kısayolları aynı listeden aynı betikle yazar
; (app\kurulum-yenile.mjs kisayollar), sunucunun yeni sürümle açıldığını bekler.
; Hiçbir şey sormaz (sahibin isteği, 28 Kasım 2026: "kurarken hiçbir şey sormasın, tek seferde bitsin; güncelleme varsa
; onu da alsın"): sayfa yok, kurulum hemen başlar; masaüstü kısayolu, oturum açılınca kasa ekranı ve prizdeyken uyku
; kapalı hep açık. Başarıda kasa ekranı açılır, pencere kendiliğinden kapanır. Yalnız gün açıkken "yine de kurulsun mu",
; veritabanı kopyası alınamayınca ve hatada sorar. Aynı anda tek kurulum (siteden kurulumla aynı kilit); kurulu sürüm
; daha yeniyse kurmaz; yarıda kalırsa eski sürüm ve sunucusu geri gelir (.onInstFailed). Sunucuyu açmadan önce
; güncelleme isteği yazar: kasa kanaldaki daha yeni sürümü iki dakika beklemeden ister (gün kapalıyken kurar).
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
!ifndef BUILD
  !error "BUILD verilmedi"
!endif

; Klasör ayırıcı: Windows'taki makensis ters bölü ister (STAGE de ters bölülü gelir), macOS ve Linux'takiler düz bölü
!ifdef NSIS_WIN32_MAKENSIS
  !define SEP "\"
!else
  !define SEP "/"
!endif

!define TASK "LafPOS Sunucu"
!define FIREWALL "LafPOS Sunucu"
!define PORT 4000
!define PS "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LafPOS"
; Siteden kurulumla (web-kurucu.ps1) aynı kilit: ikisi aynı anda çalışmaz
!define KILIT "Global\AsilPOS-Kurulum"
; Çıkış kodları (sessiz kurulum, Windows CI: ci-kurulum.mjs). 0 kuruldu; 1 ve 2 NSIS'in (vazgeçildi, yarıda kaldı);
; aşağıdakiler kurmadan çıkışı ayırt eder
!define KOD_GUN_ACIK 3
!define KOD_YENISI_KURULU 5
!define KOD_KURULUM_SURUYOR 6

Name "AsilPOS"
OutFile "${OUTFILE}"
; Klasör sabit (seçim sayfası yok): görev bu klasördeki node.exe'yi SYSTEM olarak çalıştırır; standart kullanıcının
; yazabildiği bir klasöre (C:\AsilPOS gibi) kurulursa kasiyer hesabı dosyayı değiştirip SYSTEM yetkisi alabilirdi
InstallDir "$PROGRAMFILES64\LafPOS"
RequestExecutionLevel admin
BrandingText "AsilPOS ${VERSION}"
; Başarıda pencere kendiliğinden kapanır (kasa ekranı açılır, .onInstSuccess). Yarıda kalınca NSIS pencereyi iletiyle
; açık tutar; sunucu iki dakikada açılmazsa da açık kalır (SetAutoClose false)
AutoCloseWindow true

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include WinVer.nsh
!include x64.nsh

Var DATA ; C:\ProgramData\LafPOS
Var GRUPLAR ; kısayol grupları (kurulum-yenile.mjs INSTALL_GROUPS), hep ikisi: ,masaustu,baslangic
; Yarıda kalınca geri alınacaklar (GeriAl): 1 ise bu kurulum yaptı. Var olan klasöre bakılmaz: otomatik güncellemenin
; bıraktığı app.eski (bir önceki sürüm) kurulumdan önce de durur, geri alma onu kurulu sürümün yerine koymamalı
Var DURDU ; çalışan sunucunun görevi kapatıldı
Var ESKI_APP ; app → app.eski
Var ESKI_NODE ; node → node.eski
Var YENI_APP ; kurulum.gecici\app → app
Var YENI_NODE ; kurulum.gecici\node → node

; Paket iki klasör (derle.mjs): yuk\ (app\ ve node\, yan klasöre açılır) ve kok\ (kurulum klasörünün kök dosyaları)
!define MUI_ICON "${STAGE}${SEP}kok${SEP}asilpos.ico"
!define MUI_UNICON "${STAGE}${SEP}kok${SEP}asilpos.ico"

; Tek sayfa: kurulum hemen başlar (Hoş geldiniz, Bileşenler ve Bitiş sayfaları yok). Tablet adresi ve örnek PIN'ler
; kurulum notlarında (Başlat › AsilPOS › Kurulum notları) ve programın içinde
!insertmacro MUI_PAGE_INSTFILES

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Turkish"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_TURKISH} "ProductName" "AsilPOS"
VIAddVersionKey /LANG=${LANG_TURKISH} "CompanyName" "L'Affogato"
VIAddVersionKey /LANG=${LANG_TURKISH} "FileDescription" "AsilPOS kurulumu"
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
    MessageBox MB_ICONSTOP "AsilPOS 64 bit Windows 10 ya da 11 ister." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext all
  StrCpy $DATA "$APPDATA\LafPOS"
  ; /D= ile verilen klasör de yok sayılır (yukarıdaki neden)
  StrCpy $INSTDIR "$PROGRAMFILES64\LafPOS"
  StrCpy $DURDU 0
  StrCpy $ESKI_APP 0
  StrCpy $ESKI_NODE 0
  StrCpy $YENI_APP 0
  StrCpy $YENI_NODE 0

  ; Aynı anda tek kurulum: kurulum dosyası ya da siteden kurulum, ikisi de kurulum.gecici'yi baştan siler ve aynı
  ; klasörleri taşır. Kilit bu süreç bitince bırakılır; sahibi kapanmış kilit devralınır. Kilit hiç kurulamazsa (Windows
  ; izin vermedi) kurulum kilitsiz sürer (siteden kurulum da böyle)
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "${KILIT}") p .r1 ?e'
  Pop $0
  ${If} $1 P<> 0
  ${AndIf} $0 = 183 ; ERROR_ALREADY_EXISTS: kilit vardı, tutan var mı
    System::Call 'kernel32::WaitForSingleObject(p r1, i 0) i .r2'
    ${If} $2 = 258 ; WAIT_TIMEOUT: başka kurulum sürüyor (0 ya da 128: kilit bizim)
      MessageBox MB_ICONINFORMATION "Bu bilgisayarda başka bir AsilPOS kurulumu sürüyor; bu kurulum bir şey değiştirmedi. O bitince gerekirse bu dosyayı yeniden çalıştırın." /SD IDOK
      SetErrorLevel ${KOD_KURULUM_SURUYOR}
      Abort
    ${EndIf}
  ${EndIf}

  ; Sürüm geri düşmez: kurulu derleme (app\package.json; güncelleyici ve siteden kurulum da oradan okur) bu dosyanınkinden
  ; yeniyse kurulmaz. Eski bir kurulum dosyası yeni kasayı eskisiyle değiştirmesin (yeni sürümün dönüştürdüğü veritabanı
  ; eski sürümde bozulabilir). Okunamazsa kurulur (siteden kurulum da böyle)
  ${If} ${FileExists} "$INSTDIR\app\package.json"
    nsExec::ExecToStack `"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "try { $$p = Get-Content -LiteralPath '$INSTDIR\app\package.json' -Raw | ConvertFrom-Json; if ([string]$$p.build -match '^\d{10,11}$$' -and [long]$$p.build -gt ${BUILD}) { exit ${KOD_YENISI_KURULU} } } catch { }; exit 0"`
    Pop $0
    Pop $1
    ${If} $0 == ${KOD_YENISI_KURULU}
      MessageBox MB_ICONINFORMATION "Bu bilgisayarda daha yeni bir AsilPOS kurulu; bir şey yapmanız gerekmez." /SD IDOK
      SetErrorLevel ${KOD_YENISI_KURULU}
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; Kurulum yarıda kalırsa eski sürümün sunucusu yeniden açılır: kafe sunucusuz kalmasın
Function RestoreServer
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Change /TN "${TASK}" /ENABLE'
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Run /TN "${TASK}"'
FunctionEnd

; Yeni dosyalar yerine konamadıysa eski sürüm geri gelir (yan klasör silinir): kasa programsız kalmaz. Yalnız bu kurulumun
; taşıdıkları geri alınır (bayraklar; siteden kurulum da böyle): önce yerine konan yeni klasör kalkar, eskiler ayrı ayrı
; döner
Function RollbackFiles
  SetOutPath "$INSTDIR"
  ${If} $YENI_NODE == 1
    RMDir /r "$INSTDIR\node"
    StrCpy $YENI_NODE 0
  ${EndIf}
  ${If} $YENI_APP == 1
    RMDir /r "$INSTDIR\app"
    StrCpy $YENI_APP 0
  ${EndIf}
  ${If} $ESKI_APP == 1
    Rename "$INSTDIR\app.eski" "$INSTDIR\app"
    StrCpy $ESKI_APP 0
  ${EndIf}
  ${If} $ESKI_NODE == 1
    Rename "$INSTDIR\node.eski" "$INSTDIR\node"
    StrCpy $ESKI_NODE 0
  ${EndIf}
  RMDir /r "$INSTDIR\kurulum.gecici"
FunctionEnd

; Yarıda kalan kurulum (her hata yolu ve .onInstFailed): dosyalar geri alınır, sunucuyu bu kurulum durdurduysa yeniden
; açılır. Hiçbir hata yolunda görev kapalı, sunucu durmuş kalmaz. İkinci çağrı bir şey yapmaz
Function GeriAl
  Call RollbackFiles
  ${If} $DURDU == 1
    Call RestoreServer
    StrCpy $DURDU 0
  ${EndIf}
FunctionEnd

; Kurulum yarıda kaldı (Abort ya da yazılamayan dosya): hata yolları GeriAl'ı zaten çağırır, burada kalanlar (ör. kök
; dosyalar yazılamadı) toplanır. Sessiz kurulumda hemen, pencerede kapatılınca çalışır
Function .onInstFailed
  Call GeriAl
FunctionEnd

; Başarı: kasa ekranı kendiliğinden açılır (sessiz kurulumda açılmaz), pencere kapanır (AutoCloseWindow)
Function .onInstSuccess
  ${IfNot} ${Silent}
    Call OpenKasa
  ${EndIf}
FunctionEnd

; Klasör adını değiştirir, olunca BAYRAK = 1 (geri alma bilsin); olmazsa $R8 = 1 (ilk hatadan sonra bir şey denenmez).
; Sunucu yeni durdu: Windows ya da virüs taraması dosyayı bir an tutabilir, 10 sn'ye kadar yeniden denenir (güncelleyici
; de böyle, guncelle.mjs retry)
!macro Tasi FROM TO BAYRAK
  ${If} $R8 == 0
    StrCpy $R7 0
    ${Do}
      ClearErrors
      Rename "${FROM}" "${TO}"
      ${IfNot} ${Errors}
        StrCpy ${BAYRAK} 1
        ${Break}
      ${EndIf}
      IntOp $R7 $R7 + 1
      ${If} $R7 >= 10
        StrCpy $R8 1
        ${Break}
      ${EndIf}
      Sleep 1000
    ${Loop}
  ${EndIf}
!macroend

; Ad değişikliğinden (26 Kasım 2026) önceki kurulumun kısayolları (eski-ad; shared/eski-adlar.ts). Kurulum ve kaldırma
; ikisini de siler: otomatik güncellenmiş kasada yenileri, eski kaldırıcının bıraktıkları
!macro EskiKisayollariSil
  Delete "$DESKTOP\LafPOS Kasa.lnk" ; eski-ad
  Delete "$SMSTARTUP\LafPOS Kasa.lnk" ; eski-ad
  Delete "$SMSTARTUP\LafPOS Kasa Bekcisi.lnk" ; eski-ad
  RMDir /r "$SMPROGRAMS\LafPOS" ; eski-ad
!macroend

Section "AsilPOS sunucusu ve kasa ekranı" SecMain
  SectionIn RO
  InitPluginsDir
  StrCpy $GRUPLAR ""

  ; Gün açıksa sorulur (siteden kurulumla aynı): kurulum sırasında AsilPOS bir dakika kadar kapanır. Soru yalnız bu
  ; bilgisayardaki sunucuya gider (yerel ağ 403 alır); sunucu yoksa ya da yanıt yoksa sorulmaz. Sessiz kurulumda (/S) gün
  ; açıksa kurulmaz
  nsExec::ExecToStack '"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "try { if ((Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri http://127.0.0.1:${PORT}/api/kasa/guncelleme-durumu).dayOpen -eq $$true) { exit ${KOD_GUN_ACIK} } } catch { }; exit 0"'
  Pop $0
  Pop $1
  ${If} $0 == ${KOD_GUN_ACIK}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Kasada gün açık. Kurulum sırasında AsilPOS bir dakika kadar kapanır, tabletler o sırada bağlanamaz.$\r$\n$\r$\nYine de şimdi kurulsun mu? Hayır: gün sonundan sonra kurulumu yeniden çalıştırın." /SD IDNO IDYES gun_devam
    SetErrorLevel ${KOD_GUN_ACIK}
    Abort "Kurulum bırakıldı: kasada gün açık"
    gun_devam:
  ${EndIf}

  ; Yeni sürüm önce yan klasöre açılır (sunucu o sırada çalışmaya devam eder); eskisiyle yer değiştirmesi aşağıda
  DetailPrint "Yeni sürüm hazırlanıyor"
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\kurulum.gecici"
  SetOutPath "$INSTDIR\kurulum.gecici"
  File /r "${STAGE}${SEP}yuk${SEP}*"
  SetOutPath "$INSTDIR"

  ; Güncellemede çalışan sunucuyu durdur: dosyalar kilitli kalmasın, veritabanı kopyası tutarlı olsun. Önce görev
  ; kapatılır, yoksa beş dakikalık güvence tetiği kurulum sürerken eski sürümü yeniden başlatabilir
  DetailPrint "Çalışan AsilPOS sunucusu durduruluyor"
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Change /TN "${TASK}" /DISABLE'
  ${If} $0 == 0
    StrCpy $DURDU 1 ; eski görev vardı ve kapatıldı: yarıda kalırsa GeriAl yeniden açar
  ${EndIf}
  !insertmacro Run '"$SYSDIR\schtasks.exe" /End /TN "${TASK}"'
  Sleep 3000

  ${If} ${FileExists} "$DATA\lafpos.db"
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    StrCpy $8 "$DATA\backups\lafpos-guncelleme-$3-$2-$1-$5$6$7.db"
    CreateDirectory "$DATA\backups"
    ClearErrors
    CopyFiles /SILENT "$DATA\lafpos.db" "$8"
    ${If} ${FileExists} "$DATA\lafpos.db-wal"
      CopyFiles /SILENT "$DATA\lafpos.db-wal" "$8-wal"
    ${EndIf}
    ${If} ${Errors}
    ${OrIfNot} ${FileExists} "$8"
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Veritabanının kopyası alınamadı ($8). Güncelleme yeni sürümde veritabanını dönüştürebilir.$\r$\n$\r$\nTamam: kopyasız devam et. İptal: güncellemeyi bırak, eski sürüm çalışmaya devam etsin." /SD IDCANCEL IDOK backup_skip
      Call GeriAl
      Abort "Güncelleme bırakıldı; eski sürüm çalışıyor"
      backup_skip:
    ${Else}
      DetailPrint "Veritabanının kopyası: $8"
    ${EndIf}
  ${EndIf}

  ; Uygulama klasörlerinde veri yok; otomatik güncellemenin bıraktığı klasörler kalmasın (node.yeni kalırsa başlatıcı
  ; onu Node'un yerine koyardı). Sonra yer değiştirme: app → app.eski, yeni app yerine (node da); olmazsa eskiler döner
  RMDir /r "$INSTDIR\app.eski"
  RMDir /r "$INSTDIR\app.yeni"
  RMDir /r "$INSTDIR\app.bozuk"
  RMDir /r "$INSTDIR\node.eski"
  RMDir /r "$INSTDIR\node.yeni"
  StrCpy $R8 0
  ${If} ${FileExists} "$INSTDIR\app\*.*"
    !insertmacro Tasi "$INSTDIR\app" "$INSTDIR\app.eski" $ESKI_APP
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\node\*.*"
    !insertmacro Tasi "$INSTDIR\node" "$INSTDIR\node.eski" $ESKI_NODE
  ${EndIf}
  !insertmacro Tasi "$INSTDIR\kurulum.gecici\app" "$INSTDIR\app" $YENI_APP
  !insertmacro Tasi "$INSTDIR\kurulum.gecici\node" "$INSTDIR\node" $YENI_NODE
  ${If} $R8 != 0
    Call GeriAl
    MessageBox MB_ICONSTOP "Program klasörü yazılamadı (bir program kullanıyor olabilir). Eski sürüm çalışmaya devam ediyor; bilgisayarı yeniden başlatıp kurulumu yeniden çalıştırın." /SD IDOK
    Abort "Kurulum yarıda kaldı; eski sürüm çalışıyor"
  ${EndIf}
  ; Yer değiştirme tamam: bundan sonra yarıda kalırsa yeni sürüm yerinde kalır, yalnız sunucu yeniden açılır (kök
  ; dosyaları yeni bekçi açılışta yeniler, kurulum-yenile.mjs)
  StrCpy $ESKI_APP 0
  StrCpy $ESKI_NODE 0
  StrCpy $YENI_APP 0
  StrCpy $YENI_NODE 0
  RMDir /r "$INSTDIR\app.eski"
  RMDir /r "$INSTDIR\node.eski"
  RMDir /r "$INSTDIR\kurulum.gecici"
  ; Kök dosyalar (başlatıcı, kasa kısayolunun eski yolu, yönetim betiği, simge, notlar, ayar örneği)
  SetOutPath "$INSTDIR"
  File "${STAGE}${SEP}kok${SEP}*"

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
  !insertmacro TaskLine '  <RegistrationInfo><Description>AsilPOS yerel sunucusu: kasa, tablet ve telefonlar buna bağlanır</Description></RegistrationInfo>'
  ; Öğe sırası Görev Zamanlayıcı'nın dışa aktardığıyla aynı. Açılış tetiği, bir de beş dakikada bir güvence: görev çalışıyorsa bir şey yapmaz (IgnoreNew), bekçi bir
  ; nedenle düşmüşse sunucuyu yeniden açar (RestartOnFailure yalnız açılamayan görevde devreye girer)
  !insertmacro TaskLine '  <Triggers>'
  !insertmacro TaskLine '    <BootTrigger><Enabled>true</Enabled></BootTrigger>'
  !insertmacro TaskLine '    <TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
  !insertmacro TaskLine '  </Triggers>'
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
  !insertmacro TaskLine '    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>'
  !insertmacro TaskLine '  </Settings>'
  !insertmacro TaskLine '  <Actions Context="Author"><Exec>'
  ; Bekçi başlatıcıdan açılır (baslat.cmd): otomatik güncelleme yeni sürümü kurunca bekçi 75 koduyla çıkar, başlatıcı
  ; gerekirse yeni node.exe'yi yerine koyup onu yeniden açar. Çalışma klasörü kurulum klasörü (app\ taşınabilsin)
  !insertmacro TaskLine '    <Command>$SYSDIR\cmd.exe</Command>'
  !insertmacro TaskLine '    <Arguments>/d /c "$\"$INSTDIR\baslat.cmd$\""</Arguments>'
  !insertmacro TaskLine '    <WorkingDirectory>$INSTDIR</WorkingDirectory>'
  !insertmacro TaskLine '  </Exec></Actions>'
  !insertmacro TaskLine '</Task>'
  FileClose $9
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Create /TN "${TASK}" /XML "$PLUGINSDIR\gorev.xml" /RU SYSTEM /F'
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Sunucu görevi oluşturulamadı (kod $0). Kurulumu yönetici olarak yeniden çalıştırın." /SD IDOK
    ; Eski görev kaldıysa yeniden açılır (yeni dosyalarla çalışır)
    !insertmacro Run '"$SYSDIR\schtasks.exe" /Change /TN "${TASK}" /ENABLE'
  ${EndIf}

  ; Güvenlik duvarı: yalnız kafenin ağı ve Tailscale (100.64.0.0/10); internete açık port yok
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FIREWALL}"'
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FIREWALL}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=localsubnet profile=any'
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${FIREWALL}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=100.64.0.0/10 profile=any'

  ; Kısayollar sonda (Kisayollar bölümü), siteden kurulum ve güncellemeyle aynı listeden. Önce eskileri silinir (eski
  ; kurulumda seçilmemiş olanlar listeden yeniden yazılır). Ad değişikliğinden (26 Kasım 2026) önceki kurulumun
  ; kısayolları da (eski-ad). Kaldırma kısayolu kuruluma özgü (siteden kurulumda PowerShell kaldırıcısı)
  Delete "$DESKTOP\AsilPOS Kasa.lnk"
  Delete "$SMSTARTUP\AsilPOS Kasa.lnk"
  Delete "$SMSTARTUP\AsilPOS Kasa Bekcisi.lnk"
  RMDir /r "$SMPROGRAMS\AsilPOS"
  !insertmacro EskiKisayollariSil
  CreateDirectory "$SMPROGRAMS\AsilPOS"
  CreateShortcut "$SMPROGRAMS\AsilPOS\AsilPOS'u kaldır.lnk" "$INSTDIR\Kaldir.exe"

  WriteUninstaller "$INSTDIR\Kaldir.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "AsilPOS"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "L'Affogato"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\asilpos.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Kaldir.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Kaldir.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $1 $2 $3
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $1
SectionEnd

; Üç seçenek her kurulumda açık (sayfa yok, gizli bölümler; sessiz kurulum da aynı). Kısayol bölümleri yalnız grubu
; seçer, kısayolları sondaki bölüm yazar (bölümler sırayla çalışır)
Section "-Masaüstüne kısayol" SecDesktop
  StrCpy $GRUPLAR "$GRUPLAR,masaustu"
SectionEnd

; Kasa kısayolu ve kasa bekçisi (kısayolun istediği pencereyi sunucu gelince açar) Başlangıç'a: Windows'a girilince kasa
; ekranı tam ekran açılır; kapatınca kapanır, AsilPOS Kasa kısayoluyla yeniden açılır
Section "-Oturum açılınca kasa ekranını aç" SecStartup
  StrCpy $GRUPLAR "$GRUPLAR,baslangic"
SectionEnd

Section "-Prizdeyken uyku kapalı" SecPower
  ; Uyuyan bilgisayara tabletler bağlanamaz. Ekran açık kalsın diye AsilPOS ekran kilidi ister
  !insertmacro Run '"$SYSDIR\powercfg.exe" /change standby-timeout-ac 0'
  !insertmacro Run '"$SYSDIR\powercfg.exe" /change hibernate-timeout-ac 0'
  ; USB'nin seçmeli askıya alınması prizdeyken kapalı (Güç seçenekleri › USB ayarları): fiş yazıcısı, dokunmatik ekran
  ; ve USB ağ bağdaştırıcısı boşta uyuyup kopmasın. Ağ kartının kendi güç tasarrufu elle kapatılır (BENIOKU)
  !insertmacro Run '"$SYSDIR\powercfg.exe" /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0'
  !insertmacro Run '"$SYSDIR\powercfg.exe" /setactive SCHEME_CURRENT'
SectionEnd

; Kısayollar ve açılış: üç seçenekten sonra. Kısayollar güncellemenin yenilediği listenin aynısı (kurulum-yenile.mjs
; shortcutSpec), aynı betikle (kisayollar.ps1 -Kur); siteden kurulum da bunu çalıştırır. Kasa kısayolları konsolsuz
; kasa programını açar (kasa-yazici.ps1 -Ac)
Section "-Kisayollar ve sunucu" SecSon
  DetailPrint "Kısayollar yazılıyor"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\kurulum-yenile.mjs" kisayollar --gruplar "$GRUPLAR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Kısayollar yazılamadı (kod $0). Başlat menüsündekiler AsilPOS açılınca yeniden denenir; masaüstü ve Başlangıç için kurulumu yeniden çalıştırın." /SD IDOK
  ${EndIf}

  ; Kurulum yeni sürümü de alsın: sunucu açılmadan önce güncelleme isteği yazılır ("Şimdi güncelle"nin dosyası, aynı biçim:
  ; {at, by, simdi}). Bekçi açılışta alır, kanala hemen sorar (iki dakika beklemez); daha yeni sürüm varsa indirir ve
  ; yalnız gün kapalıyken kurar (simdi hep false: gün açıkken kurdurmaz). ayarlar.env'de otomatik güncelleme kapalıysa
  ; bekçi bu isteği yok sayar (bekci.mjs). at: Unix ms (FILETIME 100 ns, 1601'den)
  DetailPrint "Yeni sürüm var mı diye bakılacak"
  CreateDirectory "$DATA\guncelleme"
  System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r1)'
  System::Int64Op $1 - 116444736000000000
  Pop $1
  System::Int64Op $1 / 10000
  Pop $1
  ClearErrors
  FileOpen $9 "$DATA\guncelleme\istek.json.tmp" w
  ${IfNot} ${Errors}
    FileWrite $9 '{"at":$1,"by":"kurulum","simdi":false}'
    FileClose $9
    Delete "$DATA\guncelleme\istek.json"
    Rename "$DATA\guncelleme\istek.json.tmp" "$DATA\guncelleme\istek.json"
  ${EndIf}

  DetailPrint "AsilPOS sunucusu başlatılıyor"
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Run /TN "${TASK}"'
  ; Sunucunun bu sürümle (ya da kurulumun isteğiyle hemen gelen daha yenisiyle) açıldığı beklenir (siteden kurulumla
  ; aynı; en çok 2 dakika): kasa ekranı yeni sürümle açılır
  DetailPrint "Yeni sürümün açılması bekleniyor (derleme ${BUILD})"
  nsExec::ExecToStack '"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "for ($$i = 0; $$i -lt 120; $$i++) { try { if ([long](Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 -Uri http://127.0.0.1:${PORT}/api/health).build -ge ${BUILD}) { exit 0 } } catch { }; Start-Sleep -Seconds 1 }; exit 1"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "AsilPOS ${VERSION} çalışıyor"
  ${Else}
    ; Pencere iletiyle açık kalır; kasa ekranı kapatınca açılır ve sunucuyu bekler
    SetAutoClose false
    DetailPrint "Sunucu iki dakikada açılmadı; kasa ekranı açılınca bekler. Açılmazsa Başlat › AsilPOS › Sunucu günlüğü"
  ${EndIf}
SectionEnd

; Kurulum yönetici olarak çalışır; kasa ekranı Gezgin üzerinden normal kullanıcı olarak açılır
Function OpenKasa
  Exec '"$WINDIR\explorer.exe" "$SMPROGRAMS\AsilPOS\AsilPOS Kasa.lnk"'
FunctionEnd

Function un.onInit
  SetShellVarContext all
  StrCpy $DATA "$APPDATA\LafPOS"
FunctionEnd

Section "Uninstall"
  ; Kasa penceresi, müşteri ekranı ve kasa bekçisi (oturumdaki kullanıcının süreçleri) kapanır: kaldırınca bekçi ve boş
  ; tam ekran kalmasın
  nsExec::ExecToLog `"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -ne $$PID -and $$_.CommandLine -and ($$_.CommandLine -match 'kasa-yazici\.ps1' -or $$_.CommandLine -match '\\LafPOS\\(chrome|edge)') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  !insertmacro Run '"$SYSDIR\schtasks.exe" /End /TN "${TASK}"'
  !insertmacro Run '"$SYSDIR\schtasks.exe" /Delete /TN "${TASK}" /F'
  Sleep 2000
  !insertmacro Run '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${FIREWALL}"'

  Delete "$DESKTOP\AsilPOS Kasa.lnk"
  Delete "$SMSTARTUP\AsilPOS Kasa.lnk"
  Delete "$SMSTARTUP\AsilPOS Kasa Bekcisi.lnk"
  RMDir /r "$SMPROGRAMS\AsilPOS"
  !insertmacro EskiKisayollariSil

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\app.eski"
  RMDir /r "$INSTDIR\app.yeni"
  RMDir /r "$INSTDIR\app.bozuk"
  RMDir /r "$INSTDIR\node.eski"
  RMDir /r "$INSTDIR\node.yeni"
  RMDir /r "$INSTDIR\kurulum.gecici"
  Delete "$INSTDIR\baslat.cmd"
  Delete "$INSTDIR\AsilPOS-Kasa.bat"
  Delete "$INSTDIR\LafPOS-Kasa.bat"
  Delete "$INSTDIR\yonet.ps1"
  Delete "$INSTDIR\asilpos.ico"
  Delete "$INSTDIR\lafpos.ico"
  Delete "$INSTDIR\BENIOKU.txt"
  Delete "$INSTDIR\ayarlar.env.ornek"
  ; Siteden kurulumun kaldırıcısı (siteden kurulum üzerine kurulduysa ya da eski Kaldir.exe'nin yerine konduysa)
  Delete "$INSTDIR\LafPOS-Kaldir.ps1"
  Delete "$INSTDIR\Kaldir.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"

  MessageBox MB_ICONINFORMATION "AsilPOS kaldırıldı. Veriler ve yedekler silinmedi: $DATA" /SD IDOK
SectionEnd
