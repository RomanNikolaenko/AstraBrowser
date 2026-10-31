//! Збереження файлів, які зробив інтерфейс (скріншот PNG, експорт закладок HTML), через вікно «Зберегти як» Windows.
//! Саме знімання сторінки — webview2::screenshot (команда pages::page_screenshot).

use std::{fs, sync::mpsc};

use tauri::{
  ipc::{InvokeBody, Request},
  AppHandle, Manager, Window,
};
use tauri_plugin_dialog::DialogExt;

/// Розкодовує encodeURIComponent: назва файла йде в заголовку запиту, а заголовки — лише ASCII.
fn decode_component(text: &str) -> String {
  let bytes = text.as_bytes();
  let mut decoded = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    let hex = bytes.get(index + 1..index + 3).and_then(|hex| std::str::from_utf8(hex).ok());
    match (bytes[index], hex.and_then(|hex| u8::from_str_radix(hex, 16).ok())) {
      (b'%', Some(byte)) => {
        decoded.push(byte);
        index += 3;
      }
      (byte, _) => {
        decoded.push(byte);
        index += 1;
      }
    }
  }
  String::from_utf8_lossy(&decoded).into_owned()
}

/// Зберігає файл: вміст — тілом запиту, запропонована назва — у заголовку x-file-name, вид — у x-file-kind
/// (png — скріншот, тека «Зображення»; html — закладки, тека «Документи»).
/// Повертає шлях до файла або None, якщо вікно закрили, нічого не вибравши.
#[tauri::command]
pub async fn file_save(app: AppHandle, window: Window, request: Request<'_>) -> Result<Option<String>, String> {
  let InvokeBody::Raw(content) = request.body() else {
    return Err(crate::i18n::text("Немає вмісту файла", "No file content").into());
  };
  let content = content.clone();
  let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(decode_component);
  let html = header("x-file-kind").as_deref() == Some("html");
  let name = header("x-file-name").filter(|name| !name.trim().is_empty()).unwrap_or_else(|| {
    if html {
      crate::i18n::text("Закладки.html", "Bookmarks.html").into()
    } else {
      crate::i18n::text("Скріншот.png", "Screenshot.png").into()
    }
  });
  let (title, filter, extension) = if html {
    (crate::i18n::text("Зберегти закладки", "Save bookmarks"), crate::i18n::text("Закладки HTML", "HTML bookmarks"), "html")
  } else {
    (crate::i18n::text("Зберегти скріншот", "Save screenshot"), crate::i18n::text("Зображення PNG", "PNG image"), "png")
  };
  let mut dialog = app.dialog().file().set_parent(&window).set_title(title).set_file_name(name).add_filter(filter, &[extension]);
  let folder = if html { app.path().document_dir() } else { app.path().picture_dir() };
  if let Ok(folder) = folder {
    dialog = dialog.set_directory(folder);
  }
  let (sender, receiver) = mpsc::channel();
  dialog.save_file(move |picked| {
    let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
  });
  let picked =
    tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten()).await.map_err(|error| error.to_string())?;
  let Some(path) = picked else {
    return Ok(None);
  };
  fs::write(&path, content).map_err(|error| error.to_string())?;
  Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn file_names_come_back_from_the_header() {
    assert_eq!(decode_component("%D0%A1%D0%BA%D1%80%D1%96%D0%BD%D1%88%D0%BE%D1%82%202026.png"), "Скріншот 2026.png");
    assert_eq!(decode_component("100%"), "100%");
  }
}
