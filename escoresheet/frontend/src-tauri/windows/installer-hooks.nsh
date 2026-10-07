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

; One file for both apps built from this shell (src/flavour.rs): OpenBeach
; (tauri.beach.conf.json, MAINBINARYNAME openbeach-escoresheet) gets its own
; rule name and texts, so both apps can be installed side by side and each
; uninstaller removes only its own rule. OV_FW_RULE must match
; flavour.rs firewall_rule (firewall.rs reads it back).
!if "${MAINBINARYNAME}" == "openbeach-escoresheet"
  !define OV_APP_NAME "OpenBeach"
  !define OV_FW_RULE "OpenBeach (tablets on the local network)"
  !define OV_FW_DESC "Lets the referee and livescore tablets and the court displays on the local network reach the built-in server of OpenBeach. Added by its installer, removed when it is uninstalled."
!else
  !define OV_APP_NAME "OpenVolley"
  !define OV_FW_RULE "OpenVolley eScoresheet (tablets on the local network)"
  !define OV_FW_DESC "Lets the referee, bench and livescore tablets on the local network reach the built-in server of OpenVolley eScoresheet. Added by its installer, removed when it is uninstalled."
!endif

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
      ; The app must be closed before anything is removed, and for every
      ; Windows user. The template's own check right after this hook
      ; (CheckIfAppIsRunning; perMachine: FindProcess / KillProcess, all
      ; users) would otherwise still find another user's copy (fast user
      ; switching) and, on Cancel, stop the install with the old copy already
      ; gone: the old uninstaller closes only this user's copy. So ask once
      ; (the only question): Cancel stops with nothing changed; OK closes it
      ; for all users here, and the template's check finds nothing left.
      nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 0
        ${IfNot} ${Silent}
        ${AndIf} $PassiveMode <> 1
          MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "${PRODUCTNAME} is running (maybe for another Windows user too). Click OK to close it and continue (matches are saved), or Cancel to stop the installation: nothing is changed then." IDOK ov_close_ok
          Abort "${PRODUCTNAME} is running. Close it and run the installer again."
          ov_close_ok:
        ${EndIf}
        ; all users, as the template's perMachine check (0 closed, 2 none left)
        nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
        Pop $0
        Sleep 500
        ${If} $0 <> 0
        ${AndIf} $0 <> 2
          Abort "${PRODUCTNAME} could not be closed. Close it for every Windows user and run the installer again: nothing was changed."
        ${EndIf}
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

; ---------------------------------------------------------------------------
; 3. Quit a running app cleanly (it usually runs in the tray).
;
; OpenVolley: the Windows installer and uninstaller quit a running app
; cleanly instead of killing it.
;
; Closing the window keeps the app running in the tray (lifecycle.rs), so it
; usually still runs when the scorer updates or uninstalls it. Tauri's own
; check (CheckIfAppIsRunning, right after these hooks) ends it with
; TerminateProcess: the app's exit never runs, so the tablets' Wi-Fi (Windows
; Mobile Hotspot) stayed on with the app's name and password, and on older
; Windows the user's own hotspot settings were not put back. After an
; uninstall nothing ever repaired that.
;
; Here, first:
; - the app runs: ask (the tablets disconnect), then
;   `openvolley-escoresheet.exe --quit` hands --quit to it (single instance,
;   main.rs) and it quits as after "Quit OpenVolley…": the tablets' network
;   stops, the user's hotspot settings come back. Silent / passive runs (the
;   updater) do not ask. Cancel stops the installer; nothing is changed.
; - it does not run: the same --quit only undoes a tablet Wi-Fi a crashed run
;   left on (the tablet-wifi-on marker) and exits.
; Then it waits up to 15 s for the app to be gone. Should it still run, Tauri's
; check after this asks to end it, as before.
;
; English only, like the rest of this installer (no other NSIS languages are
; configured in tauri.conf.json).

!define OV_RUNNING_TEXT "${OV_APP_NAME} is running.$\r$\n$\r$\nQuit it now? Tablets connected to this computer will disconnect and the computer's Wi-Fi for tablets stops. A match in progress is saved on this computer."

!macro OV_FIND_APP
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0 ; 0: running
!macroend

!macro OV_QUIT_APP
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro OV_FIND_APP
    ${If} $R0 = 0
    ${AndIfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "${OV_RUNNING_TEXT}" IDOK +2
      Abort
    ${EndIf}
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    StrCpy $R1 0
    ${Do}
      !insertmacro OV_FIND_APP
      ${If} $R0 != 0
      ${OrIf} $R1 >= 30
        ${Break}
      ${EndIf}
      Sleep 500
      IntOp $R1 $R1 + 1
    ${Loop}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; an older version of this per-machine install runs: quit it cleanly first
  !insertmacro OV_QUIT_APP
  ; an older per-user install (2.0.x / 2.1.0): remove it, data stays
  !insertmacro OV_REMOVE_PER_USER_INSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OV_FIREWALL_ADD
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OV_QUIT_APP
!macroend

; After the files are gone, not before: a cancelled "close the running app"
; question aborts the uninstall, and the rule must then still be there.
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OV_FIREWALL_REMOVE
!macroend
