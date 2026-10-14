//! Перетягування вікна за порожні місця заголовка в Linux — засобами Tauri (у Windows — свій варіант:
//! src/window_drag.rs).

use tauri::Window;

#[tauri::command]
#[specta::specta]
pub fn window_start_drag(window: Window) -> Result<(), String> {
  window.start_dragging().map_err(|error| error.to_string())
}
