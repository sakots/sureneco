!macro NSIS_HOOK_POSTINSTALL
  Push $0
  FileOpen $0 "$INSTDIR\package-type" w
  FileWrite $0 "nsis"
  FileClose $0
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\package-type"
!macroend
