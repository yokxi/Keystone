; Installatore di Keystone per Windows (NSIS 3). Lo compila app/scripts/installer.mjs, che passa:
;   VERSION  la versione (x.y.z)
;   SRC      la cartella dell'app portabile (app/release/Keystone-win32-x64)
;   OUTFILE  l'installatore da scrivere
;   UNLIST   l'elenco generato dei file e delle cartelle da togliere alla disinstallazione
;   ICON     l'icona (app/assets/icon.ico)
;
; Regole (docs/pacchetto.md, "Installatore"):
; - installazione per il solo utente, senza permessi di amministratore;
; - l'app va sempre in una cartella chiamata "Keystone", vuota oppure con un'installazione
;   precedente: l'installatore non scrive mai in una cartella con altri file;
; - la disinstallazione toglie solo i file che l'installatore ha messo (elenco generato), mai
;   cartelle intere, e non tocca i tuoi dati in %USERPROFILE%\.keystone;
; - con Keystone in esecuzione (finestra od orchestratore) non si installa e non si disinstalla.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef VERSION | SRC | OUTFILE | UNLIST | ICON
  !error "servono VERSION, SRC, OUTFILE, UNLIST e ICON (usa app/scripts/installer.mjs)"
!endif

!define APP "Keystone"
!define EXE "Keystone.exe"
!define UNINSTALLER "Uninstall.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Keystone"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Name "${APP}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "${APP} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APP}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileDescription" "Installatore di ${APP}"
VIAddVersionKey /LANG=0 "LegalCopyright" "Licenza MIT"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEPAGE_TEXT "Keystone orchestra un team di agenti AI sui tuoi repository git.$\r$\n$\r$\nL'app si installa solo per il tuo utente, senza permessi di amministratore. I tuoi dati (stato, impostazioni, skill personali) restano in %USERPROFILE%\.keystone e non vengono toccati.$\r$\n$\r$\nSe Keystone è aperto, chiudilo e ferma l'orchestratore (Impostazioni → Ferma orchestratore) prima di continuare."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Avvia Keystone"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Crea un collegamento sul desktop"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Italian"

; ---- Keystone in esecuzione? ---------------------------------------------------------------
; Un eseguibile in uso non si apre in scrittura: vale per la finestra e per l'orchestratore, che
; gira come Keystone.exe (ELECTRON_RUN_AS_NODE). Riprova finché non è chiuso, oppure annulla.
!macro WAIT_NOT_RUNNING un
Function ${un}WaitNotRunning
  ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
    Return
  ${EndIf}
  retry:
    ClearErrors
    FileOpen $0 "$INSTDIR\${EXE}" a
    ${IfNot} ${Errors}
      FileClose $0
      Return
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Keystone è in esecuzione.$\r$\n$\r$\nChiudi la finestra di Keystone e ferma l'orchestratore (Impostazioni → Ferma orchestratore), poi premi Riprova.$\r$\n$\r$\nL'orchestratore resta attivo anche a finestra chiusa." /SD IDCANCEL IDRETRY retry
    SetErrorLevel 2
    Quit
FunctionEnd
!macroend
!insertmacro WAIT_NOT_RUNNING ""
!insertmacro WAIT_NOT_RUNNING "un."

; ---- cartella di installazione ---------------------------------------------------------------

; $0 = "1" se la cartella $1 non contiene nulla
Function IsEmptyDir
  StrCpy $0 "1"
  FindFirst $2 $3 "$1\*.*"
  loop:
    StrCmp $3 "" done
    StrCmp $3 "." next
    StrCmp $3 ".." next
    StrCpy $0 "0"
    Goto done
  next:
    FindNext $2 $3
    Goto loop
  done:
  FindClose $2
FunctionEnd

Function DirLeave
  ; sempre in una cartella "Keystone": scegliere C:\Users\tu\Documenti installa in Documenti\Keystone
  ${GetFileName} "$INSTDIR" $1
  ${If} $1 != "${APP}"
    StrCpy $INSTDIR "$INSTDIR\${APP}"
  ${EndIf}
  ; niente cartelle con altri file: o vuota, o con un'installazione precedente di Keystone
  ${If} ${FileExists} "$INSTDIR\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\${UNINSTALLER}"
    StrCpy $1 "$INSTDIR"
    Call IsEmptyDir
    ${If} $0 != "1"
      MessageBox MB_OK|MB_ICONSTOP "La cartella $INSTDIR contiene già dei file e non è un'installazione di Keystone.$\r$\n$\r$\nScegline un'altra (una cartella vuota, o quella proposta)." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onInit
  ; con /S (installazione silenziosa) la pagina della cartella non c'è: stessi controlli qui
  ${If} ${Silent}
    Call DirLeave
  ${EndIf}
FunctionEnd

Function DesktopShortcut
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"
FunctionEnd

; ---- installazione ---------------------------------------------------------------------------

Section "Keystone" SecMain
  SectionIn RO
  Call WaitNotRunning

  ; aggiornamento: il disinstallatore della versione precedente toglie i suoi file (solo quelli
  ; del suo elenco), poi si copiano i nuovi. Così non restano file vecchi accanto a quelli nuovi
  ${If} ${FileExists} "$INSTDIR\${UNINSTALLER}"
    DetailPrint "Tolgo la versione precedente…"
    ExecWait '"$INSTDIR\${UNINSTALLER}" /S /KEEPSHORTCUTS _?=$INSTDIR' $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Non sono riuscito a togliere la versione precedente (codice $0). Nulla è stato installato." /SD IDOK
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}

  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"

  ; "App installate" di Windows, per il solo utente
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/yokxi/Keystone"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

; ---- disinstallazione ------------------------------------------------------------------------

Section "Uninstall"
  Call un.WaitNotRunning
  ; solo i file e le cartelle che l'installatore ha messo; una cartella non vuota resta
  !include "${UNLIST}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"

  ; durante un aggiornamento collegamenti e registro restano: li riscrive l'installatore
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/KEEPSHORTCUTS" $1
  ${If} ${Errors}
    Delete "$SMPROGRAMS\${APP}.lnk"
    Delete "$DESKTOP\${APP}.lnk"
    DeleteRegKey HKCU "${UNINST_KEY}"
  ${EndIf}
  DetailPrint "I tuoi dati in %USERPROFILE%\.keystone restano: cancellali a mano se non ti servono più."
SectionEnd
