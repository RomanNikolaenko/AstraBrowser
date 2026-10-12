//! Мова повідомлень Rust, які бачить користувач: помилки, пункти контекстного меню сайтів, вікна вибору файлів.
//! Та сама, що в інтерфейсі, — він повідомляє її командою [`app_set_language`]. До того — мова Windows (англійська
//! чи, для будь-якої іншої, українська), як і в інтерфейсі (client/src/app/shared/i18n). Журнал — завжди українською.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Мова Windows — до першої команди інтерфейсу.
pub fn init() {
  ENGLISH.store(windows_is_english(), Ordering::Relaxed);
}

#[cfg(windows)]
fn windows_is_english() -> bool {
  // Основна мова — молодші 10 біт LANGID; 0x09 — англійська.
  let language = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
  language & 0x3ff == 0x09
}

#[cfg(not(windows))]
fn windows_is_english() -> bool {
  false
}

/// Інтерфейс англійською.
pub fn english() -> bool {
  ENGLISH.load(Ordering::Relaxed)
}

/// Текст мовою інтерфейсу.
pub fn text(uk: &'static str, en: &'static str) -> &'static str {
  pick(english(), uk, en)
}

fn pick(english: bool, uk: &'static str, en: &'static str) -> &'static str {
  if english {
    en
  } else {
    uk
  }
}

/// Код мови інтерфейсу: `uk` чи `en`.
pub fn code() -> &'static str {
  pick(english(), "uk", "en")
}

/// Мова інтерфейсу змінилася (чи інтерфейс щойно запустився): `uk` чи `en`. Нею ж — і листи облікового запису.
#[tauri::command]
#[specta::specta]
pub fn app_set_language(app: tauri::AppHandle, language: String) {
  ENGLISH.store(language == "en", Ordering::Relaxed);
  #[cfg(windows)]
  crate::auth::sync_language(&app);
  #[cfg(not(windows))]
  let _ = app;
}

#[cfg(test)]
mod tests {
  use super::*;

  // Без app_set_language: мова спільна для всіх тестів, а вони йдуть паралельно.
  #[test]
  fn picks_the_text_of_the_interface_language() {
    assert_eq!(pick(true, "Скасовано", "Cancelled"), "Cancelled");
    assert_eq!(pick(false, "Скасовано", "Cancelled"), "Скасовано");
  }
}
