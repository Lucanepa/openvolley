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

!define OV_RUNNING_TEXT "OpenVolley is running.$\r$\n$\r$\nQuit it now? Tablets connected to this computer will disconnect and the computer's Wi-Fi for tablets stops. A match in progress is saved on this computer."

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
  !insertmacro OV_QUIT_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OV_QUIT_APP
!macroend
