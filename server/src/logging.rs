//! Журнал помилок: файл `astra-browser.log` у теці журналів застосунку
//! (%LOCALAPPDATA%\com.astrabrowser.desktop\logs) — до 1 МБ, плюс два попередні. Туди йдуть помилки й важливі події
//! Rust, збої (panic) і помилки інтерфейсу. Паролі, токени й адреси сторінок туди не пишуться.
//! «Відкрити журнал» у довідці показує файл у Провіднику.

use std::{
  sync::{mpsc, Mutex},
  time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const FILE: &str = "astra-browser";
/// Найдовше повідомлення з інтерфейсу.
const MESSAGE_LIMIT: usize = 4000;
/// Команда інтерфейсу, довша за це, — у журнал: поки вона йде, головний потік стоїть, а з ним — вікна й запити сайтів.
const SLOW_COMMAND: Duration = Duration::from_millis(500);
/// Скільки головний потік може мовчати, поки сторож запише це в журнал (вікно, що мовчить 5 с, Windows уже вважає
/// таким, що не відповідає).
const MAIN_THREAD_STALL: Duration = Duration::from_secs(3);

/// Команда інтерфейсу, яку зараз виконує головний потік, і коли вона почалася.
static RUNNING: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn set_running(command: Option<(String, Instant)>) -> Option<(String, Instant)> {
  std::mem::replace(&mut *RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), command)
}

/// Виконує команду інтерфейсу (ipc.rs) і пише в журнал, якщо вона надовго зайняла головний потік. Асинхронні команди
/// лише запускаються тут, тож довгими не бувають.
pub fn timed_command<T>(command: &str, run: impl FnOnce() -> T) -> T {
  let started = Instant::now();
  let previous = set_running(Some((command.to_string(), started)));
  let result = run();
  set_running(previous);
  let elapsed = started.elapsed();
  if elapsed >= SLOW_COMMAND {
    log::warn!("Команда {command} зайняла головний потік на {} мс", elapsed.as_millis());
  }
  result
}

/// Сторож головного потоку: щосекунди просить його відгукнутися, а коли той мовчить понад MAIN_THREAD_STALL, пише в
/// журнал, що тоді виконувалося і скільки тривало. Так видно, через що вікно «не відповідає», навіть якщо браузер
/// потім прочухується сам і Windows нічого не зберігає.
pub fn watch_main_thread(app: AppHandle) {
  std::thread::spawn(move || loop {
    std::thread::sleep(Duration::from_secs(1));
    let (answer, answered) = mpsc::channel();
    let asked = Instant::now();
    if app
      .run_on_main_thread(move || {
        let _ = answer.send(());
      })
      .is_err()
    {
      return;
    }
    if answered.recv_timeout(MAIN_THREAD_STALL).is_ok() {
      continue;
    }
    let doing = match RUNNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
      Some((command, started)) => format!("виконується команда {command} ({} с)", started.elapsed().as_secs()),
      None => "не команда інтерфейсу (події вікон, сайтів чи WebView2)".to_string(),
    };
    log::warn!("Головний потік не відповідає понад {} с: {doing}", MAIN_THREAD_STALL.as_secs());
    match answered.recv() {
      Ok(()) => log::warn!("Головний потік відгукнувся через {:.1} с", asked.elapsed().as_secs_f64()),
      Err(_) => return,
    }
  });
}

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
