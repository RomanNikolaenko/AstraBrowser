//! Посилання не на сайти — mailto:, tel:, magnet:, zoommtg:, tg: тощо — відкриває програма Windows, а не браузер.
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

/// Відкриває посилання програмою, що в Windows для нього вибрана (пошта для mailto: тощо).
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn open_external(url: String) -> Result<(), String> {
  use windows::Win32::UI::{
    Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW},
    WindowsAndMessaging::SW_SHOWNORMAL,
  };
  use windows_core::{w, HSTRING, PCWSTR};

  let parsed = Url::parse(&url).map_err(|_| "Некоректне посилання".to_string())?;
  let scheme = scheme_of(&parsed).ok_or("Таке посилання браузер не відкриває")?;
  if app_name(scheme).is_none() {
    return Err("На цьому комп’ютері немає програми, що відкриває такі посилання".into());
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
  unsafe { ShellExecuteExW(&mut info) }.map_err(|_| "На цьому комп’ютері немає програми, що відкриває такі посилання".to_string())
}

/// Програма для посилання `url`: її назва, якщо посилання можна відкрити; `None` — нема чим, тож і питати не варто
/// (як у Chrome: посилання, якого жодна програма не знає, просто нічого не робить).
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn external_app(url: String) -> Option<String> {
  let parsed = Url::parse(&url).ok()?;
  app_name(scheme_of(&parsed)?)
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
