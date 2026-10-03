//! Повноекранне вікно на Windows.
//!
//! tao ставить вікну межі монітора асинхронним SetWindowPos, і поки сторінка WebView2 сама в повноекранному
//! режимі (відео), цей запит губиться: вікно так і лишається розміром, яким було до входу.
//! Тож після `setFullscreen(true)` межі монітора ставимо ще й синхронно.

use tauri::Window;
use windows::Win32::{
  Foundation::HWND,
  UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER},
};

#[tauri::command]
pub fn window_fill_monitor(window: Window) -> Result<(), String> {
  let monitor = window.current_monitor().map_err(|error| error.to_string())?.ok_or("No monitor for the window")?;
  let (position, size) = (*monitor.position(), *monitor.size());
  let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0 as _);
  unsafe {
    SetWindowPos(hwnd, None, position.x, position.y, size.width as i32, size.height as i32, SWP_NOZORDER | SWP_NOACTIVATE)
  }
  .map_err(|error| error.to_string())
}
