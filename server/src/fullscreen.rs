//! Повноекранне вікно на Windows.
//!
//! tao ставить вікну межі монітора асинхронним SetWindowPos, і поки сторінка WebView2 сама в повноекранному
//! режимі (відео), цей запит губиться: вікно так і лишається розміром, яким було до входу.
//! Тож після `setFullscreen(true)` межі монітора ставимо ще й синхронно.
//!
//! Відео на весь екран (сторінка сама попросила повний екран) — тут, в обробнику події WebView2, а не через
//! інтерфейс, і як у Firefox: екран плавно темніє, під затемненням вікно стає на весь монітор, а сайт — на все вікно й
//! поверх інтерфейсу (сам інтерфейс лишається свого розміру), сторінка перебудовується (YouTube — до секунди), і екран
//! так само плавно світлішає. Вихід — навпаки: спершу затемнення, тоді вікно й сайт на місце, а вже тоді сторінка
//! виходить (fullscreen-page.js). Esc WebView2 обробляє сам і одразу, тож тоді, як і коли сторінка вийшла сама, екран
//! темніє миттєво (webview2::watch_shortcuts). Стрибків сторінки не видно.

use std::{
  cell::{Cell, RefCell},
  sync::{mpsc, Arc, Mutex},
  time::{Duration, Instant},
};

use tauri::{Manager, Webview, Window};
use windows::Win32::{
  Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
  Graphics::{
    Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED},
    Gdi::{
      GetMonitorInfoW, GetStockObject, MonitorFromWindow, ScreenToClient, BLACK_BRUSH, HBRUSH, MONITORINFO,
      MONITOR_DEFAULTTONEAREST,
    },
  },
  System::LibraryLoader::GetModuleHandleW,
  UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, GetParent, GetWindowLongPtrW, GetWindowRect, IsWindow, IsZoomed,
    RegisterClassExW, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_HWNDPARENT, GWL_STYLE,
    HWND_BOTTOM, HWND_TOP, HWND_TOPMOST, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
    SW_MAXIMIZE, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_MAXIMIZE,
    WS_POPUP,
  },
};
use windows_core::{w, BOOL};

#[tauri::command]
#[specta::specta]
pub fn window_fill_monitor(window: Window) -> Result<(), String> {
  let monitor = window.current_monitor().map_err(|error| error.to_string())?.ok_or("No monitor for the window")?;
  let (position, size) = (*monitor.position(), *monitor.size());
  let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0 as _);
  unsafe {
    SetWindowPos(hwnd, None, position.x, position.y, size.width as i32, size.height as i32, SWP_NOZORDER | SWP_NOACTIVATE)
  }
  .map_err(|error| error.to_string())
}

/// Скільки екран темніє перед переходом і світлішає після нього.
const FADE_IN: Duration = Duration::from_millis(120);
const FADE_OUT: Duration = Duration::from_millis(160);
/// Найдовше, скільки екран лишається темним, чекаючи, доки сторінка перебудується (fullscreen-painted), — як у Firefox.
const SETTLE_WAIT: Duration = Duration::from_millis(1000);
/// Крок анімації затемнення.
const FRAME: Duration = Duration::from_millis(16);

/// Сайт на весь екран: де він був (HWND — числом: стан спільний для потоків).
struct Held {
  label: String,
  site: isize,
  /// Місце webview сайту у вікні до повного екрана.
  bounds: RECT,
  /// Вікно вже було на весь екран (F11) — таким і лишається.
  was_fullscreen: bool,
  /// Розгорнуте вікно до повного екрана — після нього розгортається знову, на те саме місце.
  maximized: Option<RECT>,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

fn held() -> std::sync::MutexGuard<'static, Vec<Held>> {
  HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Чи сайт `label` зараз на весь екран: тоді його межі тримає цей модуль, а не інтерфейс.
pub fn holds(label: &str) -> bool {
  held().iter().any(|item| item.label == label)
}

/// Сайти, яких виводять із повного екрана, хоч сторінка його ще не покинула: інтерфейс (інша вкладка, модальне вікно)
/// чи сама сторінка, що от-от вийде (fullscreen-page.js, Esc).
static DISMISSED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn dismissed() -> std::sync::MutexGuard<'static, Vec<String>> {
  DISMISSED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn mark_dismissed(label: &str) {
  let mut dismissed = dismissed();
  if !dismissed.iter().any(|item| item == label) {
    dismissed.push(label.to_string());
  }
}

/// Вікно й інтерфейс до повного екрана — запам'ятані ще в події, до того як Tauri, що теж просить повний екран, їх
/// змінить.
#[derive(Clone, Copy)]
struct Before {
  was_fullscreen: bool,
  maximized: Option<RECT>,
  interface: Option<RECT>,
}

/// Перехід під затемненням.
struct Fade {
  page: Webview,
  overlay: HWND,
  /// На весь екран сайт чи ні — що зробити, щойно екран темний (за цей час сторінка могла й передумати).
  target: bool,
  before: Option<Before>,
  stage: Stage,
  /// Сторінка чекає дозволу вийти (fullscreen-ready) — її вихід почався зі сторінки (кнопка плеєра, F).
  reply: bool,
}

#[derive(Clone, Copy)]
enum Stage {
  /// Екран темніє.
  In { started: Instant, from: u8 },
  /// Темно, перехід зроблено, сторінка перебудовується: чекаємо, доки вона перемалюється в такому розмірі.
  Wait { since: Instant, fullscreen: bool, size: (i32, i32) },
  /// Екран світлішає.
  Out { started: Instant, from: u8 },
}

thread_local! {
  /// Звіряння вже йде (подія прийшла посеред зміни вікна, поки Windows обробляє повідомлення) — і чи треба ще раз.
  static SYNCING: Cell<bool> = const { Cell::new(false) };
  static AGAIN: Cell<bool> = const { Cell::new(false) };
  static FADE: RefCell<Option<Fade>> = const { RefCell::new(None) };
  /// Анімація затемнення вже йде (потік, що щокадру будить головний).
  static TICKING: Cell<bool> = const { Cell::new(false) };
  /// Вікно затемнення (створюється раз).
  static OVERLAY: Cell<isize> = const { Cell::new(0) };
}

/// Приводить вікно й сайт `page` до того, що зараз на сторінці. Події WebView2 можуть прийти посеред зміни вікна
/// (поки вона триває, Windows обробляє повідомлення), тож їхньому порядку не довіряємо: щоразу дивимось, на весь екран
/// сторінка зараз чи ні, а подія посеред звіряння лише просить звірити ще раз, щойно воно скінчиться. `fade` — перехід
/// під затемненням (його почала сторінка); без нього — одразу (інтерфейс показує інше).
pub fn sync(page: &Webview, fade: bool) {
  let page = page.clone();
  let _ = page.window().run_on_main_thread(move || {
    if SYNCING.replace(true) {
      AGAIN.set(true);
      return;
    }
    for _ in 0..8 {
      AGAIN.set(false);
      let Some(fullscreen) = page_fullscreen(&page) else {
        break;
      };
      let label = page.label();
      let dismissed = {
        let mut dismissed = dismissed();
        if !fullscreen {
          dismissed.retain(|item| item != label);
        }
        dismissed.iter().any(|item| item == label)
      };
      let wanted = fullscreen && !dismissed;
      if fading(label) {
        retarget(label, wanted);
      } else if wanted != holds(label) {
        if fade {
          // Сторінка вже вийшла сама (не через fullscreen-page.js) — її перебудова вже йде: темно одразу, без
          // поступового затемнення, крізь яке її було б видно.
          begin(&page, wanted, if !wanted && !fullscreen { 255 } else { 0 });
        } else if wanted {
          let before = prepare(&page);
          enter(&page, before);
        } else {
          leave(&page);
        }
      }
      if !AGAIN.get() {
        break;
      }
    }
    SYNCING.set(false);
  });
}

/// Інтерфейс виводить сайт із повного екрана (інша вкладка, модальне вікно, сайт закривають), хоч сторінка лишається в
/// ньому: вікно й сайт — як були, одразу, доки сторінка не вийде й не ввійде знову.
pub fn dismiss(page: &Webview) {
  mark_dismissed(page.label());
  let label = page.label().to_string();
  let _ = page.window().run_on_main_thread(move || cancel(&label));
  sync(page, false);
}

/// Сторінка зараз вийде з повного екрана (кнопка плеєра, F): спершу затемнення, вікно й сайт на місце, а тоді їй
/// дозвіл (fullscreen-ready). Повертає, чи дозвіл прийде пізніше; ні — сайт і не на весь екран, можна одразу.
pub fn prepare_exit(page: &Webview) -> bool {
  if !holds(page.label()) {
    return false;
  }
  mark_dismissed(page.label());
  sync(page, true);
  set_reply(page.label());
  true
}

/// Esc на сайті на весь екран: WebView2 виводить сторінку сам і одразу (зупинити його не можна), тож екран темніє
/// одразу, ще до того, — перебудова сторінки й вікна йде вже під затемненням. Викликати з головного потоку (обробник
/// клавіш WebView2).
pub fn exit_by_key(page: &Webview) {
  if !holds(page.label()) || fading(page.label()) {
    return;
  }
  mark_dismissed(page.label());
  begin(page, false, 255);
}

/// Сторінка перемалювалась (fullscreen-page.js): якщо вже такою, як після переходу, — екран світлішає.
pub fn painted(page: &Webview, fullscreen: bool, width: i32, height: i32) {
  let label = page.label().to_string();
  let _ = page.window().run_on_main_thread(move || {
    FADE.with(|cell| {
      let mut fade = cell.borrow_mut();
      let Some(current) = fade.as_mut().filter(|current| current.page.label() == label) else {
        return;
      };
      if let Stage::Wait { fullscreen: expected, size, .. } = current.stage {
        if expected == fullscreen && (size.0 - width).abs() <= 3 && (size.1 - height).abs() <= 3 {
          current.stage = Stage::Out { started: Instant::now(), from: 255 };
        }
      }
    });
  });
}

/// Чи сторінка зараз на весь екран (None — не вдалося дізнатися).
fn page_fullscreen(page: &Webview) -> Option<bool> {
  let result = Arc::new(Mutex::new(None));
  let out = Arc::clone(&result);
  let _ = page.with_webview(move |platform| {
    let mut fullscreen = BOOL::default();
    if let Ok(core) = unsafe { platform.controller().CoreWebView2() } {
      if unsafe { core.ContainsFullScreenElement(&mut fullscreen) }.is_ok() {
        *out.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(fullscreen.as_bool());
      }
    }
  });
  let value = *result.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  value
}

fn fading(label: &str) -> bool {
  FADE.with(|cell| cell.borrow().as_ref().is_some_and(|fade| fade.page.label() == label))
}

fn set_reply(label: &str) {
  FADE.with(|cell| {
    if let Some(fade) = cell.borrow_mut().as_mut().filter(|fade| fade.page.label() == label) {
      fade.reply = true;
    }
  });
}

/// Сторінка передумала посеред переходу: що зробити під затемненням — наново; якщо вже світлішає — знову темніє. Та сама
/// мета (скажімо, сторінка вийшла, як і мала) нічого не змінює.
fn retarget(label: &str, wanted: bool) {
  FADE.with(|cell| {
    let mut fade = cell.borrow_mut();
    let Some(fade) = fade.as_mut().filter(|fade| fade.page.label() == label && fade.target != wanted) else {
      return;
    };
    fade.target = wanted;
    if let Stage::Out { started, from } = fade.stage {
      let alpha = fade_alpha(from, 0, started, FADE_OUT);
      fade.stage = Stage::In { started: Instant::now(), from: alpha };
    } else if let Stage::Wait { .. } = fade.stage {
      fade.stage = Stage::In { started: Instant::now(), from: 255 };
    }
  });
}

/// Перехід під затемненням: екран темніє (з прозорості `from`), а все інше — в tick.
fn begin(page: &Webview, target: bool, from: u8) {
  let window = page.window();
  let Ok(hwnd) = window.hwnd() else {
    return;
  };
  let Some(overlay) = overlay(HWND(hwnd.0 as _)) else {
    // Без затемнення — як без нього.
    if target {
      let before = prepare(page);
      enter(page, before);
    } else {
      leave(page);
    }
    return;
  };
  // Вікно до повного екрана — запам'ятати зараз: Tauri у цій же події просить повний екран і змінить його раніше, ніж
  // затемнення скінчиться.
  let before = target.then(|| prepare(page));
  let monitor = monitor_rect(HWND(hwnd.0 as _));
  unsafe {
    let _ = SetLayeredWindowAttributes(overlay, COLORREF(0), from, LWA_ALPHA);
    let _ = SetWindowPos(
      overlay,
      Some(HWND_TOPMOST),
      monitor.left,
      monitor.top,
      monitor.right - monitor.left,
      monitor.bottom - monitor.top,
      SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
  }
  FADE.with(|cell| {
    *cell.borrow_mut() = Some(Fade {
      page: page.clone(),
      overlay,
      target,
      before,
      stage: Stage::In { started: Instant::now(), from },
      reply: false,
    });
  });
  ticker(window);
}

/// Затемнення скасовується: інтерфейс виводить сайт одразу (dismiss).
fn cancel(label: &str) {
  let cancelled = FADE.with(|cell| {
    let mut fade = cell.borrow_mut();
    if fade.as_ref().is_some_and(|fade| fade.page.label() == label) {
      fade.take()
    } else {
      None
    }
  });
  if let Some(fade) = cancelled {
    unsafe {
      let _ = ShowWindow(fade.overlay, SW_HIDE);
    }
    if fade.reply {
      let _ = crate::webview2::post_page_message(&fade.page, &serde_json::json!({ "astra": "fullscreen-ready" }));
    }
  }
}

/// Щокадру будить головний потік (tick), доки затемнення не скінчиться.
fn ticker(window: Window) {
  if TICKING.replace(true) {
    return;
  }
  std::thread::spawn(move || loop {
    std::thread::sleep(FRAME);
    let (done, wait) = mpsc::channel();
    if window
      .run_on_main_thread(move || {
        let _ = done.send(tick());
      })
      .is_err()
    {
      break;
    }
    if !matches!(wait.recv_timeout(Duration::from_secs(2)), Ok(true)) {
      break;
    }
  });
}

/// Що зробити, коли екран уже темний (поза позиченням FADE: зміни вікна можуть знову викликати sync).
struct Switch {
  page: Webview,
  target: bool,
  before: Option<Before>,
  reply: bool,
}

/// Крок затемнення. Повертає, чи анімація ще триває.
fn tick() -> bool {
  let switch = FADE.with(|cell| {
    let mut fade = cell.borrow_mut();
    let current = fade.as_mut()?;
    let now = Instant::now();
    match current.stage {
      Stage::In { started, from } => {
        let alpha = fade_alpha(from, 255, started, FADE_IN);
        set_alpha(current.overlay, alpha);
        (alpha == 255).then(|| {
          // Розмір після переходу визначить apply; доти — очікування, якому не відповість жоден кадр.
          current.stage = Stage::Wait { since: now, fullscreen: current.target, size: (-100, -100) };
          Switch {
            page: current.page.clone(),
            target: current.target,
            before: current.before.take(),
            reply: std::mem::take(&mut current.reply),
          }
        })
      }
      Stage::Wait { since, .. } => {
        if now.duration_since(since) >= SETTLE_WAIT {
          current.stage = Stage::Out { started: now, from: 255 };
        }
        None
      }
      Stage::Out { started, from } => {
        let alpha = fade_alpha(from, 0, started, FADE_OUT);
        set_alpha(current.overlay, alpha);
        if alpha == 0 {
          unsafe {
            let _ = ShowWindow(current.overlay, SW_HIDE);
          }
          *fade = None;
        }
        None
      }
    }
  });
  if let Some(switch) = switch {
    apply(switch);
  }
  let active = FADE.with(|cell| cell.borrow().is_some());
  if !active {
    TICKING.set(false);
  }
  active
}

/// Екран темний: вікно й сайт — як треба; сторінці — дозвіл вийти; далі чекаємо, доки вона перемалюється.
fn apply(switch: Switch) {
  let page = &switch.page;
  if switch.target && !holds(page.label()) {
    let before = switch.before.unwrap_or_else(|| prepare(page));
    enter(page, before);
  } else if !switch.target && holds(page.label()) {
    leave(page);
  }
  crate::pages::notify_fullscreen(page);
  if switch.reply {
    let _ = crate::webview2::post_page_message(page, &serde_json::json!({ "astra": "fullscreen-ready" }));
  }
  let size = site_size(page);
  FADE.with(|cell| {
    if let Some(fade) = cell.borrow_mut().as_mut().filter(|fade| fade.page.label() == page.label()) {
      if let Stage::Wait { since, .. } = fade.stage {
        fade.stage = Stage::Wait { since, fullscreen: switch.target, size };
      }
    }
  });
}

/// Розмір webview сайту зараз, фізичні пікселі.
fn site_size(page: &Webview) -> (i32, i32) {
  let result = Arc::new(Mutex::new((0, 0)));
  let out = Arc::clone(&result);
  let _ = page.with_webview(move |platform| {
    let mut site = HWND::default();
    if unsafe { platform.controller().ParentWindow(&mut site) }.is_ok() {
      let mut rect = RECT::default();
      if unsafe { GetClientRect(site, &mut rect) }.is_ok() {
        *out.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = (rect.right, rect.bottom);
      }
    }
  });
  let value = *result.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  value
}

fn fade_alpha(from: u8, to: u8, started: Instant, duration: Duration) -> u8 {
  let progress = (started.elapsed().as_secs_f32() / duration.as_secs_f32()).min(1.0);
  // Плавно на початку й наприкінці.
  let eased = progress * progress * (3.0 - 2.0 * progress);
  (f32::from(from) + (f32::from(to) - f32::from(from)) * eased).round() as u8
}

fn set_alpha(overlay: HWND, alpha: u8) {
  unsafe {
    let _ = SetLayeredWindowAttributes(overlay, COLORREF(0), alpha, LWA_ALPHA);
  }
}

/// Чорне вікно затемнення над усім екраном: прозоре для миші, без фокуса й кнопки на панелі завдань. Його власник —
/// вікно, що йде на весь екран: власника Windows піднімає разом із ним, тож із чужим власником (скажімо, звичайним вікном,
/// коли на весь екран іде приватне) над сайтом лишалося б те інше вікно. Закрили власника — затемнення закрилося з ним,
/// і створюється знову.
fn overlay(owner: HWND) -> Option<HWND> {
  let existing = HWND(OVERLAY.get() as _);
  if !existing.is_invalid() && unsafe { IsWindow(Some(existing)) }.as_bool() {
    unsafe { SetWindowLongPtrW(existing, GWLP_HWNDPARENT, owner.0 as isize) };
    return Some(existing);
  }
  unsafe extern "system" fn procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
  }
  unsafe {
    let instance = GetModuleHandleW(None).ok()?;
    let class = w!("AstraFullscreenFade");
    let description = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: Some(procedure),
      hInstance: instance.into(),
      hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
      lpszClassName: class,
      ..Default::default()
    };
    RegisterClassExW(&description);
    let overlay = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
      class,
      w!(""),
      WS_POPUP,
      0,
      0,
      0,
      0,
      Some(owner),
      None,
      Some(instance.into()),
      None,
    )
    .ok()?;
    OVERLAY.set(overlay.0 as isize);
    Some(overlay)
  }
}

/// Вікно й інтерфейс до повного екрана; і стан повного екрана tao — одразу: він запам'ятовує вікно (і розгорнутість) і
/// поверне його після виходу. Tauri й сам його просить у цій події, але пізніше, — тоді вже нічого не зміниться.
fn prepare(page: &Webview) -> Before {
  let window = page.window();
  let was_fullscreen = window.is_fullscreen().unwrap_or(false);
  let maximized = window.is_maximized().unwrap_or(false).then(|| window.hwnd().ok()).flatten().map(|hwnd| {
    let mut rect = RECT::default();
    let _ = unsafe { GetWindowRect(HWND(hwnd.0 as _), &mut rect) };
    rect
  });
  let interface = interface_bounds(&window, None);
  if !was_fullscreen {
    let _ = window.set_fullscreen(true);
  }
  Before { was_fullscreen, maximized, interface }
}

/// Межі webview інтерфейсу вікна (у координатах вікна), а з `keep` — повернути їх: інтерфейс на час повного екрана
/// лишається свого розміру. Він тоді під сайтом, а після виходу одразу готовий — без перемальовування, яке
/// показувало б на місці панелі інструментів білу смугу.
fn interface_bounds(window: &Window, keep: Option<RECT>) -> Option<RECT> {
  let interface = window.get_webview(window.label())?;
  let result = Arc::new(Mutex::new(None));
  let out = Arc::clone(&result);
  let _ = interface.with_webview(move |platform| {
    let controller = platform.controller();
    let mut container = HWND::default();
    if unsafe { controller.ParentWindow(&mut container) }.is_err() {
      return;
    }
    match keep {
      Some(rect) => unsafe {
        let _ = controller.SetBounds(RECT { left: 0, top: 0, right: rect.right - rect.left, bottom: rect.bottom - rect.top });
      },
      None => {
        if let Ok(window) = unsafe { GetParent(container) } {
          *out.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(rect_in(window, container));
        }
      }
    }
  });
  let value = *result.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  value
}

/// Сайт на весь екран: вікно — на весь монітор, сайт — на все вікно, поверх інтерфейсу.
fn enter(page: &Webview, before: Before) {
  let window = page.window();
  let label = page.label().to_string();
  let _ = page.with_webview(move |platform| {
    let controller = platform.controller();
    let mut site = HWND::default();
    if unsafe { controller.ParentWindow(&mut site) }.is_err() {
      return;
    }
    let Ok(window) = (unsafe { GetParent(site) }) else {
      return;
    };
    let bounds = rect_in(window, site);
    // Сайт тепер на весь екран — ще до змін вікна: межі з інтерфейсу його вже не стосуються.
    held().push(Held {
      label,
      site: site.0 as isize,
      bounds,
      was_fullscreen: before.was_fullscreen,
      maximized: before.maximized,
    });
    if !before.was_fullscreen {
      // tao ставить межі монітора асинхронно, а розгорнутому вікну лишає робочу область (без панелі завдань). Тож
      // синхронно: розгортання — геть (без відновлення до звичайного розміру, яке показало б проміжне вікно), межі —
      // монітора.
      let monitor = monitor_rect(window);
      without_transitions(window, || unsafe {
        if IsZoomed(window).as_bool() {
          SetWindowLongPtrW(window, GWL_STYLE, GetWindowLongPtrW(window, GWL_STYLE) & !(WS_MAXIMIZE.0 as isize));
        }
        let _ = SetWindowPos(
          window,
          None,
          monitor.left,
          monitor.top,
          monitor.right - monitor.left,
          monitor.bottom - monitor.top,
          SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
      });
    }
    let mut client = RECT::default();
    let _ = unsafe { GetClientRect(window, &mut client) };
    place(&controller, site, HWND_TOP, client);
  });
  // Інтерфейс — свого розміру: вікно його розтягнуло, а він під сайтом і після виходу має бути одразу готовий.
  if let Some(rect) = before.interface {
    interface_bounds(&window, Some(rect));
  }
}

/// Сторінка вже не на весь екран (чи її виводять): вікно й сайт — як були.
fn leave(page: &Webview) {
  let window = page.window();
  let Some(item) = ({
    let mut held = held();
    held.iter().position(|item| item.label == page.label()).map(|index| held.remove(index))
  }) else {
    return;
  };
  // Сайт зараз піде під інтерфейс, а той ще не знає: до його нового регіону мишу ловить увесь інтерфейс — інакше на
  // мить зникла б і панель інструментів.
  if let Some(interface) = window.get_webview(window.label()) {
    let _ = crate::webview2::set_input_region(&interface, None, Vec::new(), 1.0);
  }
  let (site, bounds) = (item.site, item.bounds);
  let restore_site = || {
    let _ = page.with_webview(move |platform| place(&platform.controller(), HWND(site as _), HWND_BOTTOM, bounds));
  };
  if item.was_fullscreen {
    restore_site();
    return;
  }
  let Ok(hwnd) = window.hwnd() else {
    let _ = window.set_fullscreen(false);
    restore_site();
    return;
  };
  let hwnd = HWND(hwnd.0 as _);
  without_transitions(hwnd, || match item.maximized {
    // tao повертає розгорнуте вікно через його звичайний розмір, а свою рамку показує ще до того. Тож розгортаємо
    // самі й одним кроком, поки tao ще тримає повний екран, і разом — сайт на місце; tao лише прибирає свої позначки,
    // а вікно дістає місце, яке мало розгорнутим (tao лишив би його на весь монітор).
    Some(rect) => unsafe {
      let _ = ShowWindow(hwnd, SW_MAXIMIZE);
      restore_site();
      let _ = window.set_fullscreen(false);
      let _ = SetWindowPos(
        hwnd,
        None,
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
      );
    },
    None => {
      let _ = window.set_fullscreen(false);
      restore_site();
    }
  });
}

/// Webview сайту — на місце `bounds` (у координатах вікна) і в z-порядку після `after`.
fn place(
  controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
  site: HWND,
  after: HWND,
  bounds: RECT,
) {
  let (width, height) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
  unsafe {
    let _ = SetWindowPos(site, Some(after), bounds.left, bounds.top, width, height, SWP_NOACTIVATE);
    let _ = controller.SetBounds(RECT { left: 0, top: 0, right: width, bottom: height });
  }
}

/// Місце дочірнього вікна `child` у клієнтських координатах вікна `window`.
fn rect_in(window: HWND, child: HWND) -> RECT {
  let mut rect = RECT::default();
  let _ = unsafe { GetWindowRect(child, &mut rect) };
  let (mut start, mut end) = (POINT { x: rect.left, y: rect.top }, POINT { x: rect.right, y: rect.bottom });
  unsafe {
    let _ = ScreenToClient(window, &mut start);
    let _ = ScreenToClient(window, &mut end);
  }
  RECT { left: start.x, top: start.y, right: end.x, bottom: end.y }
}

fn monitor_rect(window: HWND) -> RECT {
  let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
  let _ = unsafe { GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &mut info) };
  info.rcMonitor
}

/// Зміна вікна без анімацій Windows (розгортання, відновлення).
fn without_transitions(window: HWND, change: impl FnOnce()) {
  let set = |disabled: bool| unsafe {
    let value = BOOL::from(disabled);
    let _ =
      DwmSetWindowAttribute(window, DWMWA_TRANSITIONS_FORCEDISABLED, &value as *const BOOL as *const _, size_of::<BOOL>() as u32);
  };
  set(true);
  change();
  set(false);
}
