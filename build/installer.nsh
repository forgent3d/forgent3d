!macro customInstall
  ${If} $LANGUAGE == 2052
    StrCpy $0 "zh-CN"
  ${Else}
    StrCpy $0 "en"
  ${EndIf}

  FileOpen $1 "$INSTDIR\installer-language.json" w
  FileWrite $1 '{"language":"$0"}$\r$\n'
  FileClose $1
!macroend
