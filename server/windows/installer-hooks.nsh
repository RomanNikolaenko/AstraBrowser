; Хуки інсталятора NSIS (tauri.conf.json → bundle.windows.nsis.installerHooks).

; До версії 0.1.2 браузер встановлювався як «AstraBrowser»: інша тека, інші ярлики й інший запис у «Програмах».
; Встановивши «Astra Browser», тихо видаляємо ту стару копію, щоб у Windows не було двох браузерів.
; Дані браузера (%LOCALAPPDATA%\com.astrabrowser.desktop) спільні для обох і лишаються: тихий деінсталятор їх
; не видаляє (лише якщо в його вікні позначити «Видалити дані застосунку»).
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AstraBrowser"

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  ReadRegStr $R0 HKCU "${OLD_UNINSTKEY}" "InstallLocation"
  ${If} $R0 != ""
    ; Шлях записано в лапках.
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 -1 1
    ${EndIf}
    ; Ярлик на робочому столі був у старої копії — буде й у нової.
    StrCpy $R2 0
    ${If} ${FileExists} "$DESKTOP\AstraBrowser.lnk"
      StrCpy $R2 1
    ${EndIf}
    ${If} ${FileExists} "$R0\uninstall.exe"
      ; _?= — деінсталятор працює на місці й інсталятор чекає на нього (інакше той копіює себе в TEMP і
      ; повертається одразу). Сам себе він тоді не видаляє — це робимо ми.
      ExecWait '"$R0\uninstall.exe" /S _?=$R0'
      Delete "$R0\uninstall.exe"
      RMDir "$R0"
    ${EndIf}
    DeleteRegKey HKCU "${OLD_UNINSTKEY}"
    ; Тека встановлення й мова старої копії.
    DeleteRegKey HKCU "Software\astrabrowser\AstraBrowser"
    ; Оновлення (кнопка в браузері) лише поновлює наявні ярлики й нових не створює, а ярликів «Astra Browser»
    ; ще немає, старі ж щойно видалено. Тож створюємо їх, як під час звичайного встановлення.
    ${If} $UpdateMode = 1
      StrCpy $UpdateMode 0
      Call CreateOrUpdateStartMenuShortcut
      ${If} $R2 = 1
        Call CreateOrUpdateDesktopShortcut
      ${EndIf}
      StrCpy $UpdateMode 1
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
