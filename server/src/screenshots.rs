//! Скріншоти сторінок: збереження картинки, яку зняв (і, може, обрізав) інтерфейс, через вікно «Зберегти як» Windows.
//! Саме знімання — webview2::screenshot (команда pages::page_screenshot).

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

/// Зберігає скріншот: PNG — тілом запиту, запропонована назва — у заголовку x-file-name. Тека спершу — «Зображення».
/// Повертає шлях до файла або None, якщо вікно закрили, нічого не вибравши.
#[tauri::command]
pub async fn screenshot_save(app: AppHandle, window: Window, request: Request<'_>) -> Result<Option<String>, String> {
  let InvokeBody::Raw(image) = request.body() else {
    return Err("Немає картинки".into());
  };
  let image = image.clone();
  let name = request
    .headers()
    .get("x-file-name")
    .and_then(|value| value.to_str().ok())
    .map(decode_component)
    .filter(|name| !name.trim().is_empty())
    .unwrap_or_else(|| "Скріншот.png".into());
  let mut dialog = app
    .dialog()
    .file()
    .set_parent(&window)
    .set_title("Зберегти скріншот")
    .set_file_name(name)
    .add_filter("Зображення PNG", &["png"]);
  if let Ok(pictures) = app.path().picture_dir() {
    dialog = dialog.set_directory(pictures);
  }
  let (sender, receiver) = mpsc::channel();
  dialog.save_file(move |picked| {
    let _ = sender.send(picked.and_then(|path| path.into_path().ok()));
  });
  let picked = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
    .await
    .map_err(|error| error.to_string())?;
  let Some(path) = picked else {
    return Ok(None);
  };
  fs::write(&path, image).map_err(|error| error.to_string())?;
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
