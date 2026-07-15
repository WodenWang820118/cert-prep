!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri only removes this install-location key when the user opts to delete
  ; app data. It is installer metadata, so a final uninstall must remove it
  ; even for silent uninstall while an update uninstall must preserve it.
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
!macroend
