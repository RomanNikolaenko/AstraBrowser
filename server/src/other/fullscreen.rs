//! Вікно на весь монітор у Linux — засобами Tauri. Повний екран сайту з затемненням, як у Windows
//! (src/fullscreen.rs), тут ще не зроблено: сайт розгортається так, як це робить сам рушій.

use tauri::Window;

#[tauri::command]
#[specta::specta]
pub fn window_fill_monitor(window: Window) -> Result<(), String> {
  let monitor = window.current_monitor().map_err(|error| error.to_string())?.ok_or("No monitor for the window")?;
  window.set_position(*monitor.position()).map_err(|error| error.to_string())?;
  window.set_size(*monitor.size()).map_err(|error| error.to_string())
}
