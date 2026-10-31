//! Розмір вікон браузера. Відкриваються вони розгорнутими, а звичайне (не розгорнуте) вікно не буває більшим за
//! розгорнуте: ширшим чи вищим за робочу область свого монітора (екран без панелі задач).

use std::{
  cell::{Cell, RefCell},
  sync::Mutex,
  time::Duration,
};

use tauri::{PhysicalPosition, PhysicalSize, Window, WindowEvent};

/// Скільки чекати, доки інтерфейс сам покаже своє вікно ([`reveal_later`]).
const REVEAL_FALLBACK: Duration = Duration::from_secs(5);

/// Розгорнуті вікна (мітки): так видно, що вікно щойно перестало бути розгорнутим.
static MAXIMIZED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Межі вікна: x, y, ширина й висота (з рамкою).
type Bounds = (i32, i32, u32, u32);

// Події вікон приходять у головному потоці, тож і стан підгонки — його.
thread_local! {
  /// Вікно саме підганяється: події від set_size і set_position приходять ще під час них і нової підгонки не варті.
  static FITTING: Cell<bool> = const { Cell::new(false) };
  /// Куди вже пробували поставити вікно (мітка → межі). Удруге ту саму мету не пробуємо: якщо Windows ставить вікно
  /// трохи інакше (рамка, масштаб), підгонка ганялася б по колу й вішала головний потік — так було в 0.1.26.
  static TRIED: RefCell<Vec<(String, Bounds)>> = const { RefCell::new(Vec::new()) };
}

/// Чи вже пробували поставити вікно `label` у межі `bounds`; якщо ні — запам'ятовує, що пробуємо.
fn tried(label: &str, bounds: Bounds) -> bool {
  TRIED.with(|tried| {
    let mut tried = tried.borrow_mut();
    if tried.iter().any(|(other, earlier)| other == label && *earlier == bounds) {
      return true;
    }
    tried.retain(|(other, _)| other != label);
    tried.push((label.to_string(), bounds));
    false
  })
}

fn forget_tried(label: &str) {
  TRIED.with(|tried| tried.borrow_mut().retain(|(other, _)| other != label));
}

/// Показати вікно, створене прихованим (tauri.conf.json, browser-windows.ts), — розгорнутим. Розгортається воно саме
/// тут, а не параметром вікна: розмір звичайного вікна з минулого запуску (tauri-plugin-window-state) розгортання
/// знімає. Уже показане вікно (інтерфейс перезавантажився) лишається, яким було.
#[tauri::command]
#[specta::specta]
pub fn window_reveal(window: Window) -> Result<(), String> {
  reveal(&window).map_err(|error| error.to_string())
}

fn reveal(window: &Window) -> tauri::Result<()> {
  if window.is_visible()? {
    return Ok(());
  }
  window.maximize()?;
  window.show()
}

/// Вікно показує інтерфейс, щойно намалюється у своїй темі (client/src/app/app.ts): так під час запуску не видно
/// білого тла webview з чорними смугами вікна. Не показав (інтерфейс не завантажився) — вікно з'являється за
/// REVEAL_FALLBACK усе одно.
pub fn reveal_later(window: Window) {
  std::thread::spawn(move || {
    std::thread::sleep(REVEAL_FALLBACK);
    if window.is_visible().is_ok_and(|visible| !visible) {
      log::warn!("Вікно {} показано без інтерфейсу", window.label());
      let _ = reveal(&window);
    }
  });
}

/// Розмір, місце чи масштаб вікна змінилися (main.rs): звичайне вікно — в межі робочої області монітора.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
  if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. }) {
    return;
  }
  if let Err(error) = fit_to_screen(window) {
    log::warn!("Вікно {} не вміщено в екран: {error}", window.label());
  }
}

/// Вікно закрили — його мітка більше не знадобиться.
pub fn forget(window: &Window) {
  restored(window, false);
  forget_tried(window.label());
}

/// Запам'ятовує, чи вікно розгорнуте; `true` — щойно перестало бути.
fn restored(window: &Window, maximized: bool) -> bool {
  let mut windows = MAXIMIZED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let index = windows.iter().position(|label| label == window.label());
  match (maximized, index) {
    (true, None) => {
      windows.push(window.label().to_string());
      false
    }
    (false, Some(index)) => {
      windows.swap_remove(index);
      true
    }
    _ => false,
  }
}

/// Звичайне вікно, більше за робочу область свого монітора (його так зберегли, перенесли на менший екран чи
/// розтягнули), — до її розміру й цілком на екран. Так само цілком на екран — щойно розгорнуте стало звичайним: місце
/// для нього Windows бере з минулого разу, і низ вікна міг опинитися під панеллю задач. Решту вікон, що вміщаються,
/// не чіпаємо, хай і за краєм екрана (так їх могли поставити самі). Розгорнуте, на весь екран, згорнуте й ще не
/// показане — теж. Кожну мету пробуємо раз (tried), тож підгонка завжди скінченна.
fn fit_to_screen(window: &Window) -> tauri::Result<()> {
  if FITTING.get() || !window.is_visible()? || window.is_minimized()? || window.is_fullscreen()? {
    return Ok(());
  }
  let maximized = window.is_maximized()?;
  let restored = restored(window, maximized);
  if maximized {
    forget_tried(window.label());
    return Ok(());
  }
  let Some(monitor) = window.current_monitor()? else {
    return Ok(());
  };
  let area = *monitor.work_area();
  let (outer, inner) = (window.outer_size()?, window.inner_size()?);
  let (width, height) = (outer.width.min(area.size.width), outer.height.min(area.size.height));
  let shrink = (width, height) != (outer.width, outer.height);
  if !shrink && !restored {
    return Ok(());
  }
  let position = window.outer_position()?;
  let right = area.position.x + (area.size.width - width) as i32;
  let bottom = area.position.y + (area.size.height - height) as i32;
  let (x, y) = (position.x.clamp(area.position.x, right), position.y.clamp(area.position.y, bottom));
  let moved = (x, y) != (position.x, position.y);
  if (!shrink && !moved) || tried(window.label(), (x, y, width, height)) {
    return Ok(());
  }
  FITTING.set(true);
  let result = (|| {
    if shrink {
      // Розмір задається без рамки — на стільки ж менший, на скільки менше має стати вікно з нею.
      window.set_size(PhysicalSize::new(
        inner.width.saturating_sub(outer.width - width),
        inner.height.saturating_sub(outer.height - height),
      ))?;
    }
    if moved {
      window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
  })();
  FITTING.set(false);
  result
}
