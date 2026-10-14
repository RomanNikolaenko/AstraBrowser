//! Завантажені файли: куди їх зберігати (своя тека чи «Завантаження» системи, питати щоразу чи ні),
//! скасування, відкриття файла й показ у теці (Провіднику, Finder чи файловому менеджері).
//! Сам перебіг завантажень стежить рушій — webview2::watch_downloads у Windows, gtk_downloads.rs у Linux, — а подія
//! page://download несе його в інтерфейс.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
  process::Command,
  sync::{mpsc, Mutex, OnceLock, RwLock},
};

use serde::{Deserialize, Serialize};
#[cfg(any(windows, target_os = "linux"))]
use tauri::Url;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;
#[cfg(windows)]
use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
#[cfg(windows)]
use windows_core::{w, HSTRING};

#[cfg(windows)]
use crate::webview2;

const SETTINGS_FILE: &str = "downloads.json";
#[cfg(windows)]
const PAGE_PREFIX: &str = "page-";

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
  /// Своя тека; None — «Завантаження» Windows.
  folder: Option<PathBuf>,
  /// Перед кожним завантаженням показувати, куди зберегти файл (і давати змінити теку).
  ask: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self { folder: None, ask: true }
  }
}

/// Запит «куди зберегти» для інтерфейсу вікна, з якого завантажують.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
  label: String,
  id: u64,
  url: String,
  file_name: String,
  folder: String,
  total: i64,
}

/// Налаштування завантажень для інтерфейсу; надсилаються й подією downloads://settings.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
  folder: String,
  /// Тека вибрана користувачем, а не стандартна.
  custom: bool,
  ask: bool,
}

/// Завантаження, про яке питають, куди зберегти файл: що за файл і куди рушій збирався його покласти.
#[cfg(any(windows, target_os = "linux"))]
pub struct DownloadRequest {
  pub id: u64,
  pub url: String,
  pub path: PathBuf,
  /// 0 — розмір невідомий.
  pub total: i64,
}

/// Що інтерфейс знає про завантаження.
#[cfg(any(windows, target_os = "linux"))]
pub struct DownloadUpdate {
  pub id: u64,
  pub url: String,
  pub path: String,
  pub received: i64,
  /// 0 — розмір невідомий (сервер його не назвав).
  pub total: i64,
  /// in-progress, completed, failed чи canceled.
  pub state: &'static str,
}

#[derive(Default)]
pub struct Downloads {
  settings: RwLock<Settings>,
  file: OnceLock<PathBuf>,
  /// Завантаження, що чекають відповіді «куди зберегти», — з назвою файла.
  prompts: Mutex<HashMap<u64, String>>,
}

impl Downloads {
  /// Куди зберігаються файли: вибрана тека (якщо вона ще є) чи «Завантаження» системи — а якщо система її не називає
  /// (Linux без тек XDG), ~/Downloads, як у Chrome.
  pub fn folder(&self, app: &AppHandle) -> Option<PathBuf> {
    let chosen = self.settings.read().ok().and_then(|settings| settings.folder.clone()).filter(|folder| folder.is_dir());
    chosen
      .or_else(|| app.path().download_dir().ok())
      .or_else(|| app.path().home_dir().ok().map(|home| home.join("Downloads")))
  }

  fn ask(&self) -> bool {
    self.settings.read().is_ok_and(|settings| settings.ask)
  }

  fn status(&self, app: &AppHandle) -> DownloadSettings {
    let custom = self.settings.read().is_ok_and(|settings| settings.folder.as_ref().is_some_and(|folder| folder.is_dir()));
    DownloadSettings {
      folder: self.folder(app).map(|folder| folder.display().to_string()).unwrap_or_default(),
      custom,
      ask: self.ask(),
    }
  }

  fn change(&self, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let mut settings = self.settings.write().map_err(|error| error.to_string())?;
    edit(&mut settings);
    let file = self.file.get().ok_or("No app data directory")?;
    if let Some(dir) = file.parent() {
      fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    fs::write(file, serde_json::to_vec_pretty(&*settings).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
  }
}

/// Налаштування з диска. Викликається при запуску.
pub fn start(app: &AppHandle) {
  let Ok(dir) = app.path().app_data_dir() else {
    return;
  };
  let file = dir.join(SETTINGS_FILE);
  let downloads = app.state::<Downloads>();
  if let Some(settings) = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
    if let Ok(mut current) = downloads.settings.write() {
      *current = settings;
    }
  }
  let _ = downloads.file.set(file);
}

/// Нова тека — усім відкритим сторінкам (у WebView2 її знає профіль) і всім вікнам інтерфейсу.
fn apply(app: &AppHandle) -> DownloadSettings {
  let downloads = app.state::<Downloads>();
  #[cfg(windows)]
  if let Some(folder) = downloads.folder(app) {
    for webview in app.webviews().into_values().filter(|webview| webview.label().starts_with(PAGE_PREFIX)) {
      let _ = webview2::set_download_folder(&webview, folder.clone());
    }
  }
  let status = downloads.status(app);
  let _ = app.emit("downloads://settings", status.clone());
  status
}

/// Якщо так налаштовано — просить інтерфейс вікна `ui` показати, куди збережеться файл, і повертає true:
/// тоді завантаження чекає, поки інтерфейс відповість через download_resolve.
#[cfg(any(windows, target_os = "linux"))]
pub fn ask_where(app: &AppHandle, ui: &str, label: &str, request: DownloadRequest) -> bool {
  let downloads = app.state::<Downloads>();
  if !downloads.ask() {
    return false;
  }
  let file_name = request
    .path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .or_else(|| Url::parse(&request.url).ok()?.path_segments()?.next_back().map(str::to_owned))
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| "download".into());
  let folder = request.path.parent().map(Path::to_path_buf).or_else(|| downloads.folder(app)).unwrap_or_default();
  if let Ok(mut prompts) = downloads.prompts.lock() {
    prompts.insert(request.id, file_name.clone());
  }
  let event = PromptEvent {
    label: label.into(),
    id: request.id,
    url: request.url,
    file_name,
    folder: folder.display().to_string(),
    total: request.total,
  };
  app.emit_to(ui, "page://download-prompt", event).is_ok()
}

/// `path`, якщо такого файла ще немає, а інакше — вільна назва поряд: «звіт (1).pdf», «звіт (2).pdf»…
pub fn unused_path(path: &Path) -> PathBuf {
  match (path.parent(), path.file_name()) {
    (Some(folder), Some(file_name)) => free_path(folder, &file_name.to_string_lossy()),
    _ => path.to_path_buf(),
  }
}

/// Шлях у теці, якого ще немає: «звіт.pdf», а якщо зайнято — «звіт (1).pdf», «звіт (2).pdf»…
fn free_path(folder: &Path, file_name: &str) -> PathBuf {
  let candidate = folder.join(file_name);
  if !candidate.exists() {
    return candidate;
  }
  let name = Path::new(file_name);
  let stem = name.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
  let extension = name.extension().map(|extension| format!(".{}", extension.to_string_lossy())).unwrap_or_default();
  (1..)
    .map(|number| folder.join(format!("{stem} ({number}){extension}")))
    .find(|path| !path.exists())
    .unwrap_or(candidate)
}

/// Відповідь на «куди зберегти»: зберегти в теку `folder` чи скасувати завантаження (None).
#[tauri::command]
#[specta::specta]
pub fn download_resolve(app: AppHandle, downloads: State<'_, Downloads>, id: u64, folder: Option<String>) -> Result<(), String> {
  let file_name = downloads.prompts.lock().map_err(|error| error.to_string())?.remove(&id);
  let path = match (folder, file_name) {
    (Some(folder), Some(file_name)) => {
      let folder = PathBuf::from(folder);
      if !folder.is_dir() {
        return Err(format!("{} {}", crate::i18n::text("Немає теки", "Folder not found:"), folder.display()));
      }
      Some(free_path(&folder, &file_name))
    }
    _ => None,
  };
  #[cfg(windows)]
  return app.run_on_main_thread(move || webview2::resolve_download(id, path)).map_err(|error| error.to_string());
  #[cfg(target_os = "linux")]
  return app.run_on_main_thread(move || crate::gtk_downloads::resolve_download(id, path)).map_err(|error| error.to_string());
  // Завантаження, що чекало б відповіді, тут немає: рушій зберігає файл одразу (pages.rs, on_download).
  #[cfg(not(any(windows, target_os = "linux")))]
  {
    let _ = (app, path);
    Ok(())
  }
}

/// Вікно вибору теки Windows лише для одного завантаження — налаштування не змінюються.
#[tauri::command]
#[specta::specta]
pub async fn downloads_pick_folder(app: AppHandle, window: Window, current: Option<String>) -> Result<Option<String>, String> {
  let mut dialog = app.dialog().file().set_parent(&window).set_title(crate::i18n::text("Куди зберегти файл", "Where to save the file"));
  if let Some(current) = current.map(PathBuf::from).filter(|folder| folder.is_dir()) {
    dialog = dialog.set_directory(current);
  }
  let (sender, receiver) = mpsc::channel();
  dialog.pick_folder(move |picked| {
    let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
  });
  let picked = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
    .await
    .map_err(|error| error.to_string())?;
  Ok(picked.map(|folder| folder.display().to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn downloads_settings(app: AppHandle, downloads: State<'_, Downloads>) -> DownloadSettings {
  downloads.status(&app)
}

/// Вибір своєї теки для завантажень (вікно вибору теки Windows).
#[tauri::command]
#[specta::specta]
pub async fn downloads_choose_folder(app: AppHandle, window: Window) -> Result<DownloadSettings, String> {
  let downloads = app.state::<Downloads>();
  let mut dialog = app.dialog().file().set_parent(&window).set_title(crate::i18n::text("Тека для завантажень", "Downloads folder"));
  if let Some(folder) = downloads.folder(&app) {
    dialog = dialog.set_directory(folder);
  }
  let (sender, receiver) = mpsc::channel();
  dialog.pick_folder(move |picked| {
    let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
  });
  let picked = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
    .await
    .map_err(|error| error.to_string())?;
  if let Some(folder) = picked {
    downloads.change(|settings| settings.folder = Some(folder))?;
  }
  Ok(apply(&app))
}

/// Знову «Завантаження» Windows.
#[tauri::command]
#[specta::specta]
pub fn downloads_reset_folder(app: AppHandle, downloads: State<'_, Downloads>) -> Result<DownloadSettings, String> {
  downloads.change(|settings| settings.folder = None)?;
  Ok(apply(&app))
}

#[tauri::command]
#[specta::specta]
pub fn downloads_set_ask(app: AppHandle, downloads: State<'_, Downloads>, ask: bool) -> Result<DownloadSettings, String> {
  downloads.change(|settings| settings.ask = ask)?;
  Ok(apply(&app))
}

/// Відкриває теку завантажень у Провіднику.
#[tauri::command]
#[specta::specta]
pub fn downloads_open_folder(app: AppHandle, downloads: State<'_, Downloads>) -> Result<(), String> {
  let folder = downloads.folder(&app).ok_or(crate::i18n::text("Немає теки для завантажень", "No downloads folder"))?;
  #[cfg(windows)]
  return Command::new("explorer").arg(folder).spawn().map(|_| ()).map_err(|error| error.to_string());
  #[cfg(not(windows))]
  open_with_system(&folder)
}

#[tauri::command]
#[specta::specta]
pub fn download_cancel(app: AppHandle, id: u64) -> Result<(), String> {
  #[cfg(windows)]
  return app.run_on_main_thread(move || webview2::cancel_download(id)).map_err(|error| error.to_string());
  #[cfg(target_os = "linux")]
  return app.run_on_main_thread(move || crate::gtk_downloads::cancel_download(id)).map_err(|error| error.to_string());
  #[cfg(not(any(windows, target_os = "linux")))]
  {
    let _ = (app, id);
    Err(crate::i18n::text("На цій системі цього ще немає", "Not available on this system yet").into())
  }
}

/// Відкриває файл програмою, що стоїть для нього в системі (як подвійний клік у Провіднику).
#[tauri::command]
#[specta::specta]
pub fn download_open(path: String) -> Result<(), String> {
  let path = Path::new(&path);
  if !path.is_file() {
    return Err(format!("{} {}", crate::i18n::text("Файла вже немає:", "The file no longer exists:"), path.display()));
  }
  #[cfg(windows)]
  {
    let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(path.as_os_str()), None, None, SW_SHOWNORMAL) };
    // Більше за 32 — успіх; менші значення — коди помилок ShellExecute.
    if result.0 as isize > 32 {
      Ok(())
    } else {
      Err(format!("{} {}", crate::i18n::text("Не вдалося відкрити", "Couldn't open"), path.display()))
    }
  }
  #[cfg(not(windows))]
  open_with_system(path)
}

/// Показує файл виділеним у його теці; якщо файла вже немає — просто теку.
#[tauri::command]
#[specta::specta]
pub fn download_show(path: String) -> Result<(), String> {
  let path = Path::new(&path);
  // macOS: Finder з виділеним файлом; Linux: тека у файловому менеджері (виділити файл xdg-open не вміє).
  #[cfg(not(windows))]
  {
    #[cfg(target_os = "macos")]
    if path.is_file() {
      return Command::new("open").arg("-R").arg(path).spawn().map(drop).map_err(|error| error.to_string());
    }
    match path.parent().filter(|folder| folder.is_dir()) {
      Some(folder) => open_with_system(folder),
      None => Err(format!("{} {}", crate::i18n::text("Немає ні файла, ні теки:", "Neither the file nor the folder exists:"), path.display())),
    }
  }
  #[cfg(windows)]
  let mut explorer = Command::new("explorer");
  #[cfg(windows)]
  if path.is_file() {
    // Провідник розбирає /select, сам, тож шлях у лапках передається як є.
    explorer.raw_arg(format!("/select,\"{}\"", path.display()));
  } else if let Some(folder) = path.parent().filter(|folder| folder.is_dir()) {
    explorer.arg(folder);
  } else {
    return Err(format!("{} {}", crate::i18n::text("Немає ні файла, ні теки:", "Neither the file nor the folder exists:"), path.display()));
  }
  #[cfg(windows)]
  explorer.spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Файл чи теку — програмою системи: open на macOS, xdg-open у Linux.
#[cfg(not(windows))]
fn open_with_system(path: &Path) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  let opener = "open";
  #[cfg(not(target_os = "macos"))]
  let opener = "xdg-open";
  Command::new(opener).arg(path).spawn().map(drop).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn free_path_does_not_overwrite_existing_files() {
    let folder = std::env::temp_dir().join(format!("astra-downloads-{}", std::process::id()));
    fs::create_dir_all(&folder).expect("folder");
    assert_eq!(free_path(&folder, "звіт.pdf"), folder.join("звіт.pdf"));

    fs::write(folder.join("звіт.pdf"), b"1").expect("file");
    fs::write(folder.join("звіт (1).pdf"), b"2").expect("file");
    assert_eq!(free_path(&folder, "звіт.pdf"), folder.join("звіт (2).pdf"));

    fs::write(folder.join("README"), b"3").expect("file");
    assert_eq!(free_path(&folder, "README"), folder.join("README (1)"));
    assert_eq!(unused_path(&folder.join("звіт.pdf")), folder.join("звіт (2).pdf"));
    assert_eq!(unused_path(&folder.join("новий.pdf")), folder.join("новий.pdf"));

    let _ = fs::remove_dir_all(&folder);
  }

  #[test]
  fn asks_where_to_save_by_default() {
    assert!(Settings::default().ask);
    let settings: Settings = serde_json::from_str(r#"{"folder":null}"#).expect("settings");
    assert!(settings.ask);
  }
}
