//! «Очистити дані перегляду і файли cookie»: скільки займають дані сайтів і кеш і саме очищення за вибраний час.
//!
//! Очищає WebView2 профіль сайтів облікового запису, що ввійшов (profiles.rs): для цього створюється прихований
//! webview у тому самому профілі. Історію й список завантажень браузера чистить інтерфейс — вони його власні.

use std::{
  fs,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicU64, Ordering},
    mpsc,
  },
  time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl, Window};

use crate::{
  profiles,
  webview2::{self, ClearKinds},
};

/// Що в профілі WebView2 — дані сайтів, а що — кеш (шляхи всередині теки профілю).
const SITE_DATA: [&str; 9] = [
  "Network/Cookies",
  "Network/Cookies-journal",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Service Worker",
  "File System",
  "databases",
  "WebStorage",
];
const CACHE: [&str; 5] = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];
/// Скільки чекати, поки WebView2 очистить дані (великий кеш — це не миттєво).
const CLEAR_TIMEOUT: Duration = Duration::from_secs(120);

static NEXT_CLEANER: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsingDataSizes {
  site_data: u64,
  cache: u64,
}

fn size_of(path: &Path) -> u64 {
  match fs::symlink_metadata(path) {
    Ok(metadata) if metadata.is_file() => metadata.len(),
    Ok(metadata) if metadata.is_dir() => {
      fs::read_dir(path).map(|entries| entries.flatten().map(|entry| size_of(&entry.path())).sum()).unwrap_or(0)
    }
    _ => 0,
  }
}

/// Тека профілю WebView2 з даними сайтів облікового запису, що ввійшов.
fn profile_dir(app: &AppHandle) -> Option<PathBuf> {
  let data = profiles::site_data_dir(app).or_else(|| app.path().app_local_data_dir().ok())?;
  Some(data.join("EBWebView").join("Default"))
}

#[tauri::command]
pub async fn browsing_data_sizes(app: AppHandle) -> BrowsingDataSizes {
  let measure = move || {
    let Some(dir) = profile_dir(&app) else {
      return BrowsingDataSizes { site_data: 0, cache: 0 };
    };
    let sum = |parts: &[&str]| parts.iter().map(|part| size_of(&dir.join(part))).sum();
    BrowsingDataSizes { site_data: sum(&SITE_DATA), cache: sum(&CACHE) }
  };
  tauri::async_runtime::spawn_blocking(measure).await.unwrap_or(BrowsingDataSizes { site_data: 0, cache: 0 })
}

/// Очищає вибране (`kinds`), змінене від `since` (секунди Unix; 0 — за весь час). `origins` — сайти з історії: у
/// профілі, спільному з інтерфейсом, їхній localStorage чиститься окремо (webview2::clear_browsing_data).
#[tauri::command]
pub async fn browsing_data_clear(window: Window, kinds: ClearKinds, since: f64, origins: Vec<String>) -> Result<(), String> {
  let app = window.app_handle().clone();
  let separate = profiles::site_data_dir(&app);
  // Сам інтерфейс браузера — теж «сайт» у спільному профілі; його дані не чіпаємо.
  let ui_origin = window
    .webviews()
    .into_iter()
    .find(|webview| webview.label() == window.label())
    .and_then(|webview| webview.url().ok())
    .map(|url| url.origin().ascii_serialization());
  let origins: Vec<String> = origins
    .into_iter()
    .filter(|origin| (origin.starts_with("https://") || origin.starts_with("http://")) && Some(origin) != ui_origin.as_ref())
    .collect();

  let label = format!("{}cleaner-{}", crate::pages::PAGE_PREFIX, NEXT_CLEANER.fetch_add(1, Ordering::Relaxed));
  let blank = Url::parse("about:blank").map_err(|error| error.to_string())?;
  let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(blank));
  if let Some(dir) = &separate {
    builder = builder.data_directory(dir.clone());
  }
  let webview = window
    .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(0.0, 0.0))
    .map_err(|error| error.to_string())?;

  let (reply, receiver) = mpsc::channel();
  let result = match webview2::clear_browsing_data(&webview, kinds, separate.is_none(), since.max(0.0), origins, reply) {
    Ok(()) => tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(CLEAR_TIMEOUT))
      .await
      .map_err(|error| error.to_string())
      .and_then(|received| received.map_err(|_| "Очищення триває задовго".to_string()))
      .and_then(|cleared| cleared),
    Err(error) => Err(error.to_string()),
  };
  let _ = webview.close();
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn adds_up_folder_sizes() {
    let dir = std::env::temp_dir().join(format!("astra-size-{}", std::process::id()));
    fs::create_dir_all(dir.join("Cache/inner")).expect("dirs");
    fs::write(dir.join("Cache/a"), [0u8; 10]).expect("file");
    fs::write(dir.join("Cache/inner/b"), [0u8; 5]).expect("file");
    assert_eq!(size_of(&dir.join("Cache")), 15);
    assert_eq!(size_of(&dir.join("missing")), 0);
    let _ = fs::remove_dir_all(dir);
  }
}
