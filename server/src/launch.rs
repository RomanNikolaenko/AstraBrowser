//! Один екземпляр браузера й посилання з інших програм.
//!
//! Повторний запуск (меню «Пуск», ярлик) чи посилання з Telegram або пошти, коли Astra вже відкритий, не стартують
//! другу копію: tauri-plugin-single-instance передає їхні аргументи першій. Без посилань — нове вікно, як у Chrome;
//! з посиланнями — нові вкладки в останньому звичайному вікні, яким користувалися (подія `app://open`).
//! Посилання, з якими браузер щойно запустили, головне вікно забирає саме, коли відновить вкладки ([`launch_urls`]).
//!
//! Посилання Windows передає сюди, коли Astra — браузер за замовчуванням: реєструє його інсталятор
//! (server/windows/installer-hooks.nsh), а стан і кнопку в налаштуваннях дає default_browser.rs. Так само — і файли,
//! які браузер показує сам (сторінки, SVG, PDF): подвійний клік, «Відкрити за допомогою».

use std::{
  path::{Path, PathBuf},
  sync::Mutex,
  time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Window};

/// Скільки посилань із командного рядка приймати за раз.
const MAX_URLS: usize = 20;
/// Файли, які браузер показує сам: їх можна відкрити в Astra з Провідника (типи — і в інсталяторі).
const FILE_TYPES: [&str; 7] = ["htm", "html", "shtml", "xht", "xhtml", "svg", "pdf"];

pub struct Launch {
  /// Посилання, з якими браузер запустили, — поки їх не забрало головне вікно.
  pending: Mutex<Vec<String>>,
  /// Останнє звичайне вікно (не приватне й не гостьове), що було у фокусі.
  last_window: Mutex<Option<String>>,
}

impl Launch {
  /// `args` — аргументи без першого (шляху до самої програми).
  pub fn new(args: impl IntoIterator<Item = String>) -> Self {
    let urls = urls_from_args(args, std::env::current_dir().ok().as_deref());
    Self { pending: Mutex::new(urls), last_window: Mutex::default() }
  }
}

/// Адреси з аргументів: вебові й файли, які браузер показує сам (FILE_TYPES), — адресами file:. Відносні шляхи — від
/// теки `cwd`. Решту (прапорці, інші файли й схеми) пропускаємо.
fn urls_from_args(args: impl IntoIterator<Item = String>, cwd: Option<&Path>) -> Vec<String> {
  args
    .into_iter()
    .filter_map(|arg| {
      let arg = arg.trim();
      // «C:\…» теж розбирається як адреса (зі схемою «c») — такий аргумент далі береться як шлях.
      match tauri::Url::parse(arg) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Some(url.into()),
        Ok(url) if url.scheme() == "file" => url.to_file_path().ok().and_then(|path| file_url(&path)),
        _ => {
          let path = PathBuf::from(arg);
          let path = match cwd {
            Some(cwd) if path.is_relative() => cwd.join(path),
            _ => path,
          };
          file_url(&path)
        }
      }
    })
    .take(MAX_URLS)
    .collect()
}

/// Адреса file: наявного файла, який браузер показує сам.
fn file_url(path: &Path) -> Option<String> {
  let extension = path.extension()?.to_str()?.to_ascii_lowercase();
  if !FILE_TYPES.contains(&extension.as_str()) || !path.is_file() {
    return None;
  }
  tauri::Url::from_file_path(std::path::absolute(path).ok()?).ok().map(String::from)
}

/// Звичайне вікно браузера (головне чи нове) — як isNormalWindow у client/src/app/shared/browser-windows.
fn is_normal(label: &str) -> bool {
  label == "main" || label.starts_with("window-")
}

#[derive(Clone, Serialize, specta::Type)]
struct OpenRequest {
  urls: Vec<String>,
}

/// Браузер запустили ще раз: його посилання — у вже відкрите вікно (а без посилань воно відкриє нове вікно).
pub fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
  let urls = urls_from_args(args.into_iter().skip(1), Some(Path::new(&cwd)));
  log::info!("Повторний запуск, посилань: {}", urls.len());
  let Some(window) = target(app) else {
    return;
  };
  let _ = window.unminimize();
  let _ = window.show();
  // Наперед — коли вікно вже розгорнулося з панелі задач: того, що ще згорнуте, tao не фокусує.
  let front = window.clone();
  let _ = app.run_on_main_thread(move || {
    let _ = front.set_focus();
  });
  let _ = app.emit_to(window.label(), "app://open", OpenRequest { urls });
}

/// Скільки чекати, доки інтерфейс сам покаже своє вікно ([`reveal_later`]).
const REVEAL_FALLBACK: Duration = Duration::from_secs(5);

/// Вікно створюється прихованим (tauri.conf.json, browser-windows.ts), а показує його інтерфейс, щойно намалюється у
/// своїй темі (client/src/app/app.ts): так під час запуску не видно білого тла webview з чорними смугами вікна. Не
/// показав (інтерфейс не завантажився) — вікно з'являється за REVEAL_FALLBACK усе одно.
pub fn reveal_later(window: Window) {
  std::thread::spawn(move || {
    std::thread::sleep(REVEAL_FALLBACK);
    if window.is_visible().is_ok_and(|visible| !visible) {
      log::warn!("Вікно {} показано без інтерфейсу", window.label());
      let _ = window.show();
    }
  });
}

/// Вивести вікно наперед Windows дає лише процесу, який запустила програма на передньому плані (Telegram, пошта), —
/// тобто повторному запуску, а не браузеру, що вже працює. Повторний запуск лише передає посилання першому й
/// завершується, тож і це право передає далі; інакше вікно з посиланням лишалося б позаду. Без права — нічого.
#[cfg(windows)]
pub fn pass_foreground_right() {
  use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
  let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
}

/// Останнє звичайне вікно у фокусі, інакше головне, інакше будь-яке звичайне. Лишилися тільки приватні чи гостьові
/// вікна — одне з них: воно саме відкриє звичайне.
///
/// Саме вікна (`windows`), а не `webview_windows`: вікно з відкритим сайтом має кілька webview, і серед «webview-вікон»
/// Tauri його вже не лічить — посилання тоді губилися.
fn target(app: &AppHandle) -> Option<Window> {
  let windows = app.windows();
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
  fn takes_web_links_and_pages_from_the_command_line() {
    let dir = std::env::temp_dir().join(format!("astra-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let page = dir.join("сторінка.html");
    std::fs::write(&page, "<p>hi</p>").expect("page");
    std::fs::write(dir.join("program.exe"), "").expect("program");
    let page_url = tauri::Url::from_file_path(&page).expect("url").to_string();

    let args = [
      "https://example.com/a?b=1".to_string(),
      "--flag".into(),
      page.to_string_lossy().into_owned(),
      "сторінка.html".into(),
      page_url.clone(),
      dir.join("program.exe").to_string_lossy().into_owned(),
      dir.join("missing.html").to_string_lossy().into_owned(),
      " http://test.dev ".into(),
      "mailto:a@b.c".into(),
    ];
    assert_eq!(
      urls_from_args(args, Some(&dir)),
      ["https://example.com/a?b=1".to_string(), page_url.clone(), page_url.clone(), page_url, "http://test.dev/".into()]
    );
    assert_eq!(urls_from_args((0..30).map(|i| format!("https://site{i}.example/")), None).len(), MAX_URLS);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn sends_links_only_to_normal_windows() {
    assert!(is_normal("main"));
    assert!(is_normal("window-1f2e"));
    assert!(!is_normal("private-1f2e"));
    assert!(!is_normal("guest-1f2e"));
  }
}
