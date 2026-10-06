; OpenVolley eScoresheet: hooks for Tauri's NSIS installer
; (tauri.conf.json > bundle > windows > nsis > installerHooks).
;
; The installer is per machine (installMode "perMachine": Program Files, one
; administrator prompt), so it can:
;
;   1. Open Windows Defender Firewall for the tablets: one inbound rule that
;      lets the app's own program accept TCP connections from the local
;      network only (remote address LocalSubnet), on private and public
;      networks. The laptop's own Wi-Fi (Mobile Hotspot / Wi-Fi Direct) and a
;      newly joined hall Wi-Fi are usually "Public". Added (delete, then add:
;      a reinstall never makes a second one) after the files are in place,
;      removed after an uninstall. Without it the tablets join the Wi-Fi and
;      get no page until someone ticks "Public" at Defender's prompt.
;   2. Take over an older per-user install of the same user (OpenVolley
;      2.0.x / 2.1.0 lived in %LOCALAPPDATA%\Openvolley eScoresheet, HKCU):
;      Tauri's own "already installed" check reads HKLM only in perMachine
;      mode, so it would leave two installs and two Start menu entries. The
;      old uninstaller runs silently: silent means its "Delete the
;      application data" box is never ticked, so the match data
;      (%LOCALAPPDATA%\com.openvolley.escoresheet, WebView2) stays, and the
;      backups (%APPDATA%\OpenVolley\backups) are never touched by any
;      uninstaller.
;
; These macros are inserted into Tauri's installer.nsi, which defines
; PRODUCTNAME, MAINBINARYNAME, UNINSTKEY, $PassiveMode and includes LogicLib,
; x64.nsh, FileFunc.nsh and the nsis_tauri_utils plugin. Nothing here
; comes from the user: the only variable parts are $INSTDIR (a Windows path,
; which cannot contain a double quote) and paths read from the registry.

!define OV_FW_RULE "OpenVolley eScoresheet (tablets on the local network)"
!define OV_FW_DESC "Lets the referee, bench and livescore tablets on the local network reach the built-in server of OpenVolley eScoresheet. Added by its installer, removed when it is uninstalled."

; $R9 = the 64-bit netsh.exe (the installer itself is a 32-bit program, so
; $SYSDIR would be SysWOW64).
!macro OV_NETSH
  ${If} ${FileExists} "$WINDIR\Sysnative\netsh.exe"
    StrCpy $R9 "$WINDIR\Sysnative\netsh.exe"
  ${Else}
    StrCpy $R9 "$SYSDIR\netsh.exe"
  ${EndIf}
!macroend

!macro OV_FIREWALL_REMOVE
  !insertmacro OV_NETSH
  ; exit code 1 ("No rules match") when it is not there: fine
  nsExec::ExecToLog '"$R9" advfirewall firewall delete rule name="${OV_FW_RULE}"'
  Pop $0
!macroend

!macro OV_FIREWALL_ADD
  !insertmacro OV_FIREWALL_REMOVE
  DetailPrint "Windows Defender Firewall: ${OV_FW_RULE}"
  nsExec::ExecToLog '"$R9" advfirewall firewall add rule name="${OV_FW_RULE}" dir=in action=allow program="$INSTDIR\${MAINBINARYNAME}.exe" enable=yes profile=private,public protocol=TCP remoteip=LocalSubnet description="${OV_FW_DESC}"'
  Pop $0
  ${If} $0 != "0"
    ; Not fatal: Defender asks at the first start instead (tick "Public"),
    ; and the Connect tablets dialog shows that step while the rule is missing.
    DetailPrint "Could not add the firewall rule (netsh: $0). Windows asks at the first start instead."
  ${EndIf}
!macroend

; An older per-user install of this user: uninstall it silently (match data
; and backups stay), so only the new per-machine install is left.
!macro OV_REMOVE_PER_USER_INSTALL
  ReadRegStr $R6 HKCU "${UNINSTKEY}" "UninstallString"
  ${If} $R6 != ""
    ; "C:\Users\...\Openvolley eScoresheet\uninstall.exe" without the quotes
    StrCpy $1 $R6 1
    ${If} $1 == '"'
      StrCpy $R6 $R6 "" 1
    ${EndIf}
    StrCpy $1 $R6 1 -1
    ${If} $1 == '"'
      StrCpy $R6 $R6 -1
    ${EndIf}
    ${GetParent} "$R6" $R7

    ${If} $R7 == ""
    ${OrIf} $R7 == $INSTDIR
      ; the same folder (installed over it): nothing to remove but the entry
      DetailPrint "Earlier per-user install in $R7: replaced in place"
      DeleteRegKey HKCU "${UNINSTKEY}"
    ${ElseIf} ${FileExists} "$R6"
      ; The old uninstaller closes a running app without asking when silent:
      ; ask first, as the install itself would.
      nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 0
      ${AndIfNot} ${Silent}
      ${AndIf} $PassiveMode <> 1
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "${PRODUCTNAME} is running. Click OK to close it and continue (matches are saved), or Cancel to stop the installation." IDOK ov_close_ok
        Abort "${PRODUCTNAME} is running. Close it and run the installer again."
        ov_close_ok:
      ${EndIf}

      DetailPrint "Removing the earlier per-user install in $R7 (match data and backups stay)"
      ; _?= runs it in place, so ExecWait really waits for it (it cannot
      ; delete itself then: done below). No /UPDATE: its shortcuts go too.
      ClearErrors
      ExecWait '"$R6" /S _?=$R7' $0
      ${If} ${Errors}
      ${OrIf} $0 <> 0
        DetailPrint "The earlier per-user install could not be removed (code $0): uninstall it in Settings > Apps. Its match data stays."
      ${Else}
        Delete "$R6"
        RMDir "$R7"
        ; rules Windows made at Defender's prompt for the old program path
        !insertmacro OV_NETSH
        nsExec::ExecToLog '"$R9" advfirewall firewall delete rule name=all program="$R7\${MAINBINARYNAME}.exe"'
        Pop $0
      ${EndIf}
    ${Else}
      ; its folder is gone already: only the stale Apps entry is left
      DeleteRegKey HKCU "${UNINSTKEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OV_REMOVE_PER_USER_INSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OV_FIREWALL_ADD
!macroend

; After the files are gone, not before: a cancelled "close the running app"
; question aborts the uninstall, and the rule must then still be there.
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OV_FIREWALL_REMOVE
!macroend
