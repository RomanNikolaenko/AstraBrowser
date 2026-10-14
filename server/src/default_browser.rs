//! Браузер за замовчуванням. Інсталятор реєструє Astra у Windows як браузер для посилань http і https
//! (server/windows/installer-hooks.nsh: StartMenuInternet, RegisteredApplications і клас посилань `AstraBrowserURL`).
//! Вибрати себе основним програма не може — це робить людина в «Параметрах Windows». Тут — чи зареєстровано, чи
//! вибрано, і команда, що відкриває «Параметри» одразу на сторінці Astra.
//!
//! У Linux браузер реєструє пакет (.deb чи .rpm) — файлом «Astra Browser.desktop» зі схемами http і https
//! (server/linux/astra-browser.desktop), а вибрати його основним можна й звідси (GIO). На macOS цього ще немає.

use serde::Serialize;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBrowserState {
  /// Інсталятор зареєстрував Astra як браузер (у запуску з `tauri dev` — ні).
  registered: bool,
  /// Посилання https відкриваються в Astra.
  is_default: bool,
}

#[cfg(windows)]
mod system {
  use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
  use windows_core::HSTRING;

  /// Назва застосунку в реєстрі й «Параметрах Windows» — як в інсталяторі.
  pub const APP: &str = "Astra Browser";
  /// Клас посилань, яким Windows відкриває http/https в Astra.
  pub const PROG_ID: &str = "AstraBrowserURL";
  /// Сторінка «Програми за замовчуванням → Astra Browser» (Windows 11; Windows 10 відкриє загальну сторінку).
  pub const SETTINGS: &str = "ms-settings:defaultapps?registeredAppUser=Astra%20Browser";

  /// Рядкове значення з HKEY_CURRENT_USER.
  pub fn read_string(key: &str, value: &str) -> Option<String> {
    let key = HSTRING::from(key);
    let value = HSTRING::from(value);
    let mut buffer = [0u16; 512];
    let mut size = (buffer.len() * 2) as u32;
    let result = unsafe {
      RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size))
    };
    if result.is_err() {
      return None;
    }
    let length = (size as usize / 2).saturating_sub(1).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
  }

  /// Яким класом Windows відкриває посилання https. Новіші Windows 11 тримають вибір у UserChoiceLatest, давніші —
  /// у UserChoice.
  pub fn https_prog_id() -> Option<String> {
    let base = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https";
    [format!(r"{base}\UserChoiceLatest\ProgId"), format!(r"{base}\UserChoiceLatest"), format!(r"{base}\UserChoice")]
      .iter()
      .find_map(|key| read_string(key, "ProgId").filter(|id| !id.is_empty()))
  }
}

#[cfg(target_os = "linux")]
mod system {
  use gtk::gio::{self, prelude::*};

  /// Файл застосунку, що його ставить пакет (назва — productName із tauri.conf.json).
  const DESKTOP: &str = "Astra Browser.desktop";
  /// Що відкриває браузер за замовчуванням.
  const TYPES: [&str; 3] = ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"];

  pub fn registered() -> bool {
    gio::DesktopAppInfo::new(DESKTOP).is_some()
  }

  pub fn is_default() -> bool {
    gio::AppInfo::default_for_uri_scheme("https").and_then(|app| app.id()).is_some_and(|id| id == DESKTOP)
  }

  /// Astra — для посилань і сторінок (GIO записує це в mimeapps.list, який читають і GNOME, і KDE).
  pub fn make_default() -> Result<(), String> {
    let app = gio::DesktopAppInfo::new(DESKTOP).ok_or(crate::i18n::text("Astra Browser не встановлено пакетом", "Astra Browser isn't installed from a package"))?;
    for kind in TYPES {
      app.set_as_default_for_type(kind).map_err(|error| error.to_string())?;
    }
    Ok(())
  }
}

#[tauri::command]
#[specta::specta]
pub fn default_browser_state() -> DefaultBrowserState {
  #[cfg(windows)]
  {
    use system::{https_prog_id, read_string, APP, PROG_ID};
    let registered = read_string(&format!(r"Software\Clients\StartMenuInternet\{APP}\Capabilities"), "ApplicationName").is_some();
    DefaultBrowserState { registered, is_default: https_prog_id().as_deref() == Some(PROG_ID) }
  }
  #[cfg(target_os = "linux")]
  return DefaultBrowserState { registered: system::registered(), is_default: system::is_default() };
  #[cfg(not(any(windows, target_os = "linux")))]
  DefaultBrowserState { registered: false, is_default: false }
}

/// «Параметри Windows» → «Програми за замовчуванням» на сторінці Astra: там людина вибирає його для посилань. У Linux —
/// одразу вибирає Astra.
#[tauri::command]
#[specta::specta]
pub fn default_browser_open_settings() -> Result<(), String> {
  #[cfg(windows)]
  {
    use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    use windows_core::{w, HSTRING};

    let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(system::SETTINGS), None, None, SW_SHOWNORMAL) };
    // ShellExecute повертає число, більше за 32, коли вдалося.
    if result.0 as isize > 32 {
      Ok(())
    } else {
      Err(crate::i18n::text("Не вдалося відкрити «Параметри Windows».", "Couldn't open Windows Settings.").to_string())
    }
  }
  #[cfg(target_os = "linux")]
  return system::make_default();
  #[cfg(not(any(windows, target_os = "linux")))]
  Err(crate::i18n::text("На цій системі цього ще немає", "Not available on this system yet").to_string())
}

#[cfg(all(test, windows))]
mod tests {
  use super::system::read_string;

  #[test]
  fn reads_strings_from_the_current_user_registry() {
    // Цей ключ є в кожного користувача Windows.
    assert!(read_string(r"Control Panel\Desktop", "WallPaper").is_some() || read_string(r"Control Panel\International", "LocaleName").is_some());
    assert_eq!(read_string(r"Software\Немає такого ключа", "X"), None);
  }
}
