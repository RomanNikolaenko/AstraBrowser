//! Журнал помилок: файл `astra-browser.log` у теці журналів застосунку
//! (%LOCALAPPDATA%\com.astrabrowser.desktop\logs) — до 1 МБ, плюс два попередні. Туди йдуть помилки й важливі події
//! Rust, збої (panic) і помилки інтерфейсу. Паролі, токени й адреси сторінок туди не пишуться.
//! «Відкрити журнал» у довідці показує файл у Провіднику.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const FILE: &str = "astra-browser";
/// Найдовше повідомлення з інтерфейсу.
const MESSAGE_LIMIT: usize = 4000;

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  let builder = tauri_plugin_log::Builder::new()
    .clear_targets()
    .target(Target::new(TargetKind::LogDir { file_name: Some(FILE.into()) }))
    .max_file_size(1_000_000)
    .rotation_strategy(RotationStrategy::KeepSome(2))
    .timezone_strategy(TimezoneStrategy::UseLocal)
    .level(log::LevelFilter::Info)
    // Бібліотеки пишуть багато службового — лише їхні попередження й помилки.
    .level_for("tao", log::LevelFilter::Warn)
    .level_for("wry", log::LevelFilter::Warn)
    .level_for("tauri", log::LevelFilter::Warn)
    .level_for("ureq", log::LevelFilter::Warn)
    .level_for("rustls", log::LevelFilter::Warn)
    .level_for("adblock", log::LevelFilter::Warn);
  // Під час розробки — ще й у термінал.
  let builder = if cfg!(debug_assertions) { builder.target(Target::new(TargetKind::Stdout)) } else { builder };
  builder.build()
}

/// Збій Rust (panic) — теж у журнал, а далі як завжди.
pub fn log_panics() {
  let previous = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    log::error!("Збій: {info}");
    previous(info);
  }));
}

/// Помилка інтерфейсу (Angular ErrorHandler, client/src/app/shared/logging).
#[tauri::command]
#[specta::specta]
pub fn app_log_error(message: String) {
  let message: String = message.chars().take(MESSAGE_LIMIT).collect();
  log::error!("Інтерфейс: {message}");
}

/// Показати файл журналу в Провіднику (чи теку, якщо записів ще не було).
#[tauri::command]
#[specta::specta]
pub fn app_open_logs(app: AppHandle) -> Result<(), String> {
  let dir = app.path().app_log_dir().map_err(|error| error.to_string())?;
  let file = dir.join(format!("{FILE}.log"));
  let mut explorer = std::process::Command::new("explorer");
  if file.exists() {
    explorer.arg(format!("/select,{}", file.display()));
  } else {
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    explorer.arg(&dir);
  }
  // Провідник повертає 1 навіть після успіху, тож важить лише те, чи вдалося його запустити.
  explorer.spawn().map(|_| ()).map_err(|error| error.to_string())
}
