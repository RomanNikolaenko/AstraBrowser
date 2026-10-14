//! Посилання не на сайти — mailto:, tel:, magnet:, zoommtg:, tg: тощо — відкриває програма системи, а не браузер.
//! Сайт не може запустити програму сам: сторінка лише повідомляє інтерфейс (page://external), а той питає
//! користувача й тоді відкриває посилання ([`open_external`]). Схеми, через які запускали шкідливий код чи
//! відкривали локальні файли (file:, javascript:, ms-msdt:, search-ms: …), не відкриваються взагалі.

use tauri::Url;

/// Схеми, яких браузер не відкриває програмою ніколи: внутрішні, локальні файли, скрипти й ті, через які
/// атакували Windows (ms-msdt — Follina, search-ms, ms-officecmd, ms-appinstaller тощо).
const BLOCKED: &[&str] = &[
  "http", "https", "about", "blob", "chrome", "data", "devtools", "edge", "file", "filesystem", "hcp", "its", "javascript",
  "jar", "mhtml", "mk", "ms-appinstaller", "ms-cxh", "ms-cxh-full", "ms-its", "ms-msdt", "ms-officecmd", "res", "search",
  "search-ms", "shell", "tauri", "ipc", "asset", "vbscript", "view-source", "ws", "wss",
];

/// Схема посилання, яке можна запропонувати відкрити програмою; `None` — не можна.
pub fn scheme_of(url: &Url) -> Option<&str> {
  let scheme = url.scheme();
  (!scheme.is_empty() && !BLOCKED.contains(&scheme)).then_some(scheme)
}

/// Назва програми, що в Windows відкриває посилання зі схемою `scheme` (Telegram для tg: тощо); `None` — такої
/// немає. Тоді й не запускаємо: Windows замість програми показала б своє вікно «Як ви хочете відкрити це?».
#[cfg(windows)]
pub fn app_name(scheme: &str) -> Option<String> {
  use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME};
  use windows_core::{HSTRING, PWSTR};

  let scheme = HSTRING::from(scheme);
  let flags = ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN;
  let mut length = 0u32;
  unsafe { AssocQueryStringW(flags, ASSOCSTR_FRIENDLYAPPNAME, &scheme, None, None, &mut length) }.ok().ok()?;
  let mut buffer = vec![0u16; length as usize];
  unsafe { AssocQueryStringW(flags, ASSOCSTR_FRIENDLYAPPNAME, &scheme, None, Some(PWSTR(buffer.as_mut_ptr())), &mut length) }.ok().ok()?;
  let name = String::from_utf16_lossy(&buffer[..buffer.iter().position(|&char| char == 0).unwrap_or(buffer.len())]);
  Some(name.trim().to_string()).filter(|name| !name.is_empty())
}

/// Відкриває посилання програмою, що в системі для нього вибрана (пошта для mailto: тощо).
#[tauri::command]
#[specta::specta]
pub fn open_external(url: String) -> Result<(), String> {
  #[cfg(windows)]
  {
    use windows::Win32::UI::{
      Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW},
      WindowsAndMessaging::SW_SHOWNORMAL,
    };
    use windows_core::{w, HSTRING, PCWSTR};

    let parsed = Url::parse(&url).map_err(|_| crate::i18n::text("Некоректне посилання", "Invalid link").to_string())?;
    let scheme = scheme_of(&parsed).ok_or(crate::i18n::text("Таке посилання браузер не відкриває", "The browser doesn't open links like this"))?;
    if app_name(scheme).is_none() {
      return Err(crate::i18n::text("На цьому комп’ютері немає програми, що відкриває такі посилання", "There's no app on this computer that opens links like this").into());
    }
    let file = HSTRING::from(parsed.as_str());
    let mut info = SHELLEXECUTEINFOW {
      cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
      // Немає програми для такого посилання — лише помилка в діалозі, без вікна Windows «Знайти програму».
      fMask: SEE_MASK_FLAG_NO_UI,
      lpVerb: w!("open"),
      lpFile: PCWSTR(file.as_ptr()),
      nShow: SW_SHOWNORMAL.0,
      ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }.map_err(|_| crate::i18n::text("На цьому комп’ютері немає програми, що відкриває такі посилання", "There's no app on this computer that opens links like this").to_string())
  }
  #[cfg(not(windows))]
  {
    let parsed = Url::parse(&url).map_err(|_| crate::i18n::text("Некоректне посилання", "Invalid link").to_string())?;
    scheme_of(&parsed).ok_or(crate::i18n::text("Таке посилання браузер не відкриває", "The browser doesn't open links like this"))?;
    std::process::Command::new("xdg-open")
      .arg(parsed.as_str())
      .spawn()
      .map(drop)
      .map_err(|_| crate::i18n::text("На цьому комп’ютері немає програми, що відкриває такі посилання", "There's no app on this computer that opens links like this").to_string())
  }
}

/// Програма для посилання `url`: її назва, якщо посилання можна відкрити; `None` — нема чим, тож і питати не варто
/// (як у Chrome: посилання, якого жодна програма не знає, просто нічого не робить).
#[tauri::command]
#[specta::specta]
pub fn external_app(url: String) -> Option<String> {
  let parsed = Url::parse(&url).ok()?;
  app_name(scheme_of(&parsed)?)
}

/// Програма Linux для посилань зі схемою `scheme` (xdg-mime): назва з її .desktop-файла чи сам файл.
#[cfg(target_os = "linux")]
pub fn app_name(scheme: &str) -> Option<String> {
  let output = std::process::Command::new("xdg-mime").args(["query", "default", &format!("x-scheme-handler/{scheme}")]).output().ok()?;
  let desktop = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if desktop.is_empty() {
    return None;
  }
  let data = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
  let home = std::env::var("HOME").map(|home| format!("{home}/.local/share")).unwrap_or_default();
  let name = std::iter::once(home.as_str())
    .chain(data.split(':'))
    .filter_map(|dir| std::fs::read_to_string(format!("{dir}/applications/{desktop}")).ok())
    .find_map(|file| file.lines().find_map(|line| line.strip_prefix("Name=").map(str::to_string)));
  Some(name.unwrap_or_else(|| desktop.trim_end_matches(".desktop").to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Що відкриває посилання на цьому комп'ютері: cargo test apps_on_this_computer -- --ignored --nocapture
  #[cfg(windows)]
  #[test]
  #[ignore]
  fn apps_on_this_computer() {
    for scheme in ["mailto", "tel", "ms-settings", "magnet", "tg", "zoommtg", "astra-no-such-app-test"] {
      println!("{scheme}: {:?}", app_name(scheme));
    }
  }

  #[test]
  fn offers_only_safe_app_links() {
    let scheme = |text: &str| Url::parse(text).ok().and_then(|url| scheme_of(&url).map(str::to_string));
    assert_eq!(scheme("mailto:roman@example.com").as_deref(), Some("mailto"));
    assert_eq!(scheme("tel:+380441234567").as_deref(), Some("tel"));
    assert_eq!(scheme("magnet:?xt=urn:btih:abc").as_deref(), Some("magnet"));
    assert_eq!(scheme("tg://resolve?domain=astra").as_deref(), Some("tg"));
    for blocked in ["https://example.com/", "file:///C:/Windows/notepad.exe", "javascript:alert(1)", "ms-msdt:/id", "search-ms:query=x"] {
      assert_eq!(scheme(blocked), None, "{blocked}");
    }
  }
}
