; Хуки інсталятора NSIS (tauri.conf.json → bundle.windows.nsis.installerHooks).

; До версії 0.1.2 браузер встановлювався як «AstraBrowser»: інша тека, інші ярлики й інший запис у «Програмах».
; Встановивши «Astra Browser», тихо видаляємо ту стару копію, щоб у Windows не було двох браузерів.
; Дані браузера (%LOCALAPPDATA%\com.astrabrowser.desktop) спільні для обох і лишаються: тихий деінсталятор їх
; не видаляє (лише якщо в його вікні позначити «Видалити дані застосунку»).
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AstraBrowser"

; Astra як браузер у Windows: «Параметри → Програми за замовчуванням» пропонують його для посилань http і https,
; а Windows відкриває їх командою `astra-browser.exe "<посилання>"` (server/src/launch.rs). Назва й клас посилань —
; ті самі, що в server/src/default_browser.rs. Значення — латиницею, щоб не залежати від кодування, в якому NSIS
; прочитає цей файл.
!define BROWSER_KEY "Software\Clients\StartMenuInternet\Astra Browser"
!define BROWSER_URL_CLASS "Software\Classes\AstraBrowserURL"

!macro ASTRA_REGISTER_BROWSER
  WriteRegStr HKCU "${BROWSER_URL_CLASS}" "" "Astra Browser URL"
  WriteRegStr HKCU "${BROWSER_URL_CLASS}" "URL Protocol" ""
  WriteRegStr HKCU "${BROWSER_URL_CLASS}\DefaultIcon" "" "$INSTDIR\astra-browser.exe,0"
  WriteRegStr HKCU "${BROWSER_URL_CLASS}\shell\open\command" "" '"$INSTDIR\astra-browser.exe" "%1"'
  WriteRegStr HKCU "${BROWSER_URL_CLASS}\Application" "ApplicationName" "Astra Browser"
  WriteRegStr HKCU "${BROWSER_URL_CLASS}\Application" "ApplicationIcon" "$INSTDIR\astra-browser.exe,0"

  WriteRegStr HKCU "${BROWSER_KEY}" "" "Astra Browser"
  WriteRegStr HKCU "${BROWSER_KEY}\DefaultIcon" "" "$INSTDIR\astra-browser.exe,0"
  WriteRegStr HKCU "${BROWSER_KEY}\shell\open\command" "" '"$INSTDIR\astra-browser.exe"'
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationName" "Astra Browser"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationDescription" "Fast and private web browser"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities" "ApplicationIcon" "$INSTDIR\astra-browser.exe,0"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\StartMenu" "StartMenuInternet" "Astra Browser"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\URLAssociations" "http" "AstraBrowserURL"
  WriteRegStr HKCU "${BROWSER_KEY}\Capabilities\URLAssociations" "https" "AstraBrowserURL"
  WriteRegStr HKCU "Software\RegisteredApplications" "Astra Browser" "${BROWSER_KEY}\Capabilities"
  ; Оболонка перечитує зв'язки: Astra одразу видно в «Параметрах».
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

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

  ; І під час встановлення, і під час оновлення: шлях до програми в реєстрі завжди актуальний.
  !insertmacro ASTRA_REGISTER_BROWSER
!macroend

; Видалення (не оновлення) прибирає Astra з браузерів Windows.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "${BROWSER_KEY}"
    DeleteRegKey HKCU "${BROWSER_URL_CLASS}"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Astra Browser"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
