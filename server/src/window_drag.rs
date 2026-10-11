//! Перетягування вікна за порожні місця заголовка на Windows.
//!
//! `start_dragging` Tauri (tao) передає системі в WM_NCLBUTTONDOWN не координати курсора, а адресу змінної з ними,
//! і запускає перетягування навіть тоді, коли кнопку миші вже відпустили. Розгорнуте вікно від цього часом
//! «відривалося» від краю екрана й зменшувалося на звичайний клік. Тут — те саме, що робить заголовок звичайного
//! вікна Windows: перетягування з точки, де курсор зараз, і лише поки кнопка натиснута. А починає його інтерфейс,
//! щойно мишу з натиснутою кнопкою зсунули (client/src/app/shared/window-drag).

use tauri::Window;
use windows::Win32::{
  Foundation::{HWND, LPARAM, WPARAM},
  UI::{
    Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON},
    WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, PostMessageW, HTCAPTION, SM_SWAPBUTTON, WM_NCLBUTTONDOWN},
  },
};

/// Точка екрана для повідомлень миші: x — молодші 16 бітів, y — старші (як MAKELPARAM).
fn screen_point(x: i32, y: i32) -> LPARAM {
  LPARAM(((y as u16 as u32) << 16 | x as u16 as u32) as isize)
}

#[tauri::command]
#[specta::specta]
pub fn window_start_drag(window: Window) -> Result<(), String> {
  let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
  // Захоплення миші й черга повідомлень — потоку вікна.
  window
    .run_on_main_thread(move || unsafe {
      // Основна кнопка миші (у шульги — права). Її вже відпустили — тягнути нічого, інакше вікно «прилипло» б до курсора.
      let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
      if GetAsyncKeyState(i32::from(button.0)) >= 0 {
        return;
      }
      let mut cursor = Default::default();
      if GetCursorPos(&mut cursor).is_err() {
        return;
      }
      let _ = ReleaseCapture();
      let _ = PostMessageW(
        Some(HWND(hwnd as _)),
        WM_NCLBUTTONDOWN,
        WPARAM(HTCAPTION as usize),
        screen_point(cursor.x, cursor.y),
      );
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn packs_the_screen_point_like_makelparam() {
    assert_eq!(screen_point(100, 200).0, (200 << 16) | 100);
    // Другий монітор ліворуч чи вгорі — від'ємні координати.
    assert_eq!(screen_point(-10, -20).0 as u32, 0xFFEC_FFF6);
  }
}
