//! Браузер за замовчуванням. Інсталятор реєструє Astra у Windows як браузер для посилань http і https
//! (server/windows/installer-hooks.nsh: StartMenuInternet, RegisteredApplications і клас посилань `AstraBrowserURL`).
//! Вибрати себе основним програма не може — це робить людина в «Параметрах Windows». Тут — чи зареєстровано, чи
//! вибрано, і команда, що відкриває «Параметри» одразу на сторінці Astra.

use serde::Serialize;
use windows::Win32::{
  System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
  UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};
use windows_core::{w, HSTRING};

/// Назва застосунку в реєстрі й «Параметрах Windows» — як в інсталяторі.
const APP: &str = "Astra Browser";
/// Клас посилань, яким Windows відкриває http/https в Astra.
const PROG_ID: &str = "AstraBrowserURL";
/// Сторінка «Програми за замовчуванням → Astra Browser» (Windows 11; Windows 10 відкриє загальну сторінку).
const SETTINGS: &str = "ms-settings:defaultapps?registeredAppUser=Astra%20Browser";

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBrowserState {
  /// Інсталятор зареєстрував Astra як браузер (у запуску з `tauri dev` — ні).
  registered: bool,
  /// Посилання https відкриваються в Astra.
  is_default: bool,
}

/// Рядкове значення з HKEY_CURRENT_USER.
fn read_string(key: &str, value: &str) -> Option<String> {
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
fn https_prog_id() -> Option<String> {
  let base = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https";
  [format!(r"{base}\UserChoiceLatest\ProgId"), format!(r"{base}\UserChoiceLatest"), format!(r"{base}\UserChoice")]
    .iter()
    .find_map(|key| read_string(key, "ProgId").filter(|id| !id.is_empty()))
}

#[tauri::command]
#[specta::specta]
pub fn default_browser_state() -> DefaultBrowserState {
  let registered = read_string(&format!(r"Software\Clients\StartMenuInternet\{APP}\Capabilities"), "ApplicationName").is_some();
  DefaultBrowserState { registered, is_default: https_prog_id().as_deref() == Some(PROG_ID) }
}

/// «Параметри Windows» → «Програми за замовчуванням» на сторінці Astra: там людина вибирає його для посилань.
#[tauri::command]
#[specta::specta]
pub fn default_browser_open_settings() -> Result<(), String> {
  let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(SETTINGS), None, None, SW_SHOWNORMAL) };
  // ShellExecute повертає число, більше за 32, коли вдалося.
  if result.0 as isize > 32 {
    Ok(())
  } else {
    Err("Не вдалося відкрити «Параметри Windows».".to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_strings_from_the_current_user_registry() {
    // Цей ключ є в кожного користувача Windows.
    assert!(read_string(r"Control Panel\Desktop", "WallPaper").is_some() || read_string(r"Control Panel\International", "LocaleName").is_some());
    assert_eq!(read_string(r"Software\Немає такого ключа", "X"), None);
  }
}
