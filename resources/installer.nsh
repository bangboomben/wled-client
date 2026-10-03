; Registers the wled-client:// URL scheme for Windows.
; electron-builder's "protocols" option has no effect on the NSIS target (it is only read for
; macOS, Linux and AppX), so the installer writes the keys itself. electron-builder includes this
; file automatically (directories.buildResources/installer.nsh); it is not shipped inside the app.
; SHELL_CONTEXT follows the per-user or per-machine choice made in the installer.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\wled-client" "" "URL:WLED Client"
  WriteRegStr SHELL_CONTEXT "Software\Classes\wled-client" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\wled-client\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\wled-client\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\wled-client"
  ${endIf}
!macroend
