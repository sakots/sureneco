!define SURENECO_DISPLAY_NAME "スレネコチェッカー"
!define SURENECO_PREVIOUS_DISPLAY_NAME "スレネコアラート"

!macro SURENECO_RENAME_SHORTCUT DIRECTORY
  !insertmacro IsShortcutTarget "${DIRECTORY}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "${DIRECTORY}\${SURENECO_DISPLAY_NAME}.lnk"
    Rename "${DIRECTORY}\${PRODUCTNAME}.lnk" "${DIRECTORY}\${SURENECO_DISPLAY_NAME}.lnk"
    !insertmacro IsShortcutTarget "${DIRECTORY}\${SURENECO_PREVIOUS_DISPLAY_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      Delete "${DIRECTORY}\${SURENECO_PREVIOUS_DISPLAY_NAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro SURENECO_REMOVE_SHORTCUT DIRECTORY
  !insertmacro IsShortcutTarget "${DIRECTORY}\${SURENECO_DISPLAY_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro UnpinShortcut "${DIRECTORY}\${SURENECO_DISPLAY_NAME}.lnk"
    Delete "${DIRECTORY}\${SURENECO_DISPLAY_NAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  FileOpen $0 "$INSTDIR\package-type" w
  FileWrite $0 "nsis"
  FileClose $0
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${SURENECO_DISPLAY_NAME}"
  !insertmacro SURENECO_RENAME_SHORTCUT "$SMPROGRAMS"
  !insertmacro SURENECO_RENAME_SHORTCUT "$DESKTOP"
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  ${If} $UpdateMode <> 1
    !insertmacro SURENECO_REMOVE_SHORTCUT "$SMPROGRAMS"
    !insertmacro SURENECO_REMOVE_SHORTCUT "$DESKTOP"
  ${EndIf}
  Delete "$INSTDIR\package-type"
  Pop $0
!macroend
