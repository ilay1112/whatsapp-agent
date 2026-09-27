; build/installer.nsh - NSIS customisation for electron-builder 26.15.3.
; Owner: W2-04-packaging. Binding source: ARCHITECTURE.md section 15.2 (last line) and section 19 / V10.
;
; The ONE job of this file: make an upgrade-install possible while the app is running.
; NSIS cannot overwrite "WhatsApp Calendar Agent.exe" (nor resources\app.asar) while the process holds them,
; and a one-click upgrade silently leaves a half-installed directory when it tries.
;
; SAFETY RULE (ARCH 15.2, invariant behind manual checklist M9 / V10):
;   `taskkill /F /T /IM "WhatsApp Calendar Agent.exe"` - OUR OWN main image only, with /T.
;   /T ends the whole process TREE, which is precisely how our children (whatsapp-bridge.exe, llama-server.exe,
;   the calendar-mcp stdio child) are stopped: because they are OUR children, not because they are named here.
;   This file MUST NEVER name `whatsapp-bridge.exe`, `llama-server.exe` or any other image:
;   the user runs an unrelated whatsapp-mcp bridge of their own on this machine, and an /IM kill by that name
;   would terminate a process this installer does not own. That is the accident M9 exists to rule out.
;
; Nothing else belongs here. No registry writes, no file deletion, no userData touching:
; `deleteAppDataOnUninstall: false` (ARCH 15.2) means %APPDATA%\WhatsApp Calendar Agent survives an uninstall
; by design - app.db, the bridge store and the Google tokens are the user's data.

!macro customInit
  ; Runs at the very start of the installer, before the previous version's uninstaller is invoked.
  ; nsExec::Exec keeps it silent; the return code is deliberately ignored - "process not found" (128)
  ; is the normal case on a first install and must not fail the installation.
  DetailPrint "Stopping WhatsApp Calendar Agent (if running)..."
  nsExec::Exec 'taskkill /F /T /IM "WhatsApp Calendar Agent.exe"'
  Pop $0
  ; Give Windows a moment to release the file handles on the exe and on resources\app.asar.
  Sleep 1500
!macroend
