; Uninstalling Locus takes out what it added to Claude (the Claude Code plugin folder and the
; Claude Desktop config entry), so Claude isn't left pointing at a missing program. Updates also
; run the old uninstaller, so skip it then: the new version keeps the same setup.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-claude'
  ${endIf}
!macroend
