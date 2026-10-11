//! Один екземпляр браузера й посилання з інших програм.
//!
//! Повторний запуск (меню «Пуск», ярлик) чи посилання з Telegram або пошти, коли Astra вже відкритий, не стартують
//! другу копію: tauri-plugin-single-instance передає їхні аргументи першій. Без посилань — нове вікно, як у Chrome;
//! з посиланнями — нові вкладки в останньому звичайному вікні, яким користувалися (подія `app://open`).
//! Посилання, з якими браузер щойно запустили, головне вікно забирає саме, коли відновить вкладки ([`launch_urls`]).
//!
//! Посилання Windows передає сюди, коли Astra — браузер за замовчуванням: реєструє його інсталятор
//! (server/windows/installer-hooks.nsh), а стан і кнопку в налаштуваннях дає default_browser.rs.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Скільки посилань із командного рядка приймати за раз.
const MAX_URLS: usize = 20;

pub struct Launch {
  /// Посилання, з якими браузер запустили, — поки їх не забрало головне вікно.
  pending: Mutex<Vec<String>>,
  /// Останнє звичайне вікно (не приватне й не гостьове), що було у фокусі.
  last_window: Mutex<Option<String>>,
}

impl Launch {
  /// `args` — аргументи без першого (шляху до самої програми).
  pub fn new(args: impl IntoIterator<Item = String>) -> Self {
    Self { pending: Mutex::new(web_urls(args)), last_window: Mutex::default() }
  }
}

/// Вебові адреси з аргументів; решту (прапорці, шляхи до файлів) пропускаємо.
fn web_urls(args: impl IntoIterator<Item = String>) -> Vec<String> {
  args
    .into_iter()
    .filter_map(|arg| tauri::Url::parse(arg.trim()).ok())
    .filter(|url| matches!(url.scheme(), "http" | "https"))
    .map(String::from)
    .take(MAX_URLS)
    .collect()
}

/// Звичайне вікно браузера (головне чи нове) — як isNormalWindow у client/src/app/shared/browser-windows.
fn is_normal(label: &str) -> bool {
  label == "main" || label.starts_with("window-")
}

#[cfg_attr(debug_assertions, allow(dead_code))]
#[derive(Clone, Serialize, specta::Type)]
struct OpenRequest {
  urls: Vec<String>,
}

/// Браузер запустили ще раз: його посилання — у вже відкрите вікно (а без посилань воно відкриє нове вікно).
// У розробці плагін single-instance вимкнено (main.rs), і цим у debug-збірці ніхто не користується.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn second_instance(app: &AppHandle, args: Vec<String>) {
  let urls = web_urls(args.into_iter().skip(1));
  log::info!("Повторний запуск, посилань: {}", urls.len());
  let Some(window) = target(app) else {
    return;
  };
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();
  let _ = app.emit_to(window.label(), "app://open", OpenRequest { urls });
}

/// Останнє звичайне вікно у фокусі, інакше головне, інакше будь-яке звичайне. Лишилися тільки приватні чи гостьові
/// вікна — одне з них: воно саме відкриє звичайне.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn target(app: &AppHandle) -> Option<WebviewWindow> {
  let windows = app.webview_windows();
  let last = app.state::<Launch>().last_window.lock().ok().and_then(|last| last.clone());
  last
    .and_then(|label| windows.get(&label).cloned())
    .or_else(|| windows.get("main").cloned())
    .or_else(|| windows.values().find(|window| is_normal(window.label())).cloned())
    .or_else(|| windows.values().next().cloned())
}

/// Вікно отримало фокус: звичайне запам'ятовуємо — туди підуть посилання з інших програм.
pub fn focused(window: &tauri::Window) {
  if is_normal(window.label()) {
    if let Ok(mut last) = window.state::<Launch>().last_window.lock() {
      *last = Some(window.label().to_string());
    }
  }
}

/// Посилання, з якими браузер запустили (віддаються один раз).
#[tauri::command]
#[specta::specta]
pub fn launch_urls(launch: State<'_, Launch>) -> Vec<String> {
  launch.pending.lock().map(|mut pending| std::mem::take(&mut *pending)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn takes_only_web_links_from_the_command_line() {
    let args = ["https://example.com/a?b=1", "--flag", "C:\\Users\\me\\page.html", "file:///C:/x.html", " http://test.dev ", "mailto:a@b.c"];
    assert_eq!(web_urls(args.map(String::from)), ["https://example.com/a?b=1", "http://test.dev/"]);
    assert_eq!(web_urls((0..30).map(|i| format!("https://site{i}.example/"))).len(), MAX_URLS);
  }

  #[test]
  fn sends_links_only_to_normal_windows() {
    assert!(is_normal("main"));
    assert!(is_normal("window-1f2e"));
    assert!(!is_normal("private-1f2e"));
    assert!(!is_normal("guest-1f2e"));
  }
}
