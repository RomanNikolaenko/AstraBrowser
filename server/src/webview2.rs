//! Те, чого Tauri не відкриває, — напряму через WebView2: іконка й звук сторінки, навігація історією,
//! дозвіл сайту на автовідтворення й блокування реклами.
//!
//! Тут свідомо немає ExecuteScript (eval): скрипт, запущений через WebView2, дає сторінці «активацію
//! користувача», і вона могла б без жодного кліку запускати відео зі звуком чи відкривати вікна.
//!
//! Усе виконується на головному потоці (`with_webview`), а відповіді COM приходять у колбеки,
//! тож результат повертається через канал, який чекає команда.

use std::{
  cell::{Cell, RefCell},
  collections::{BTreeSet, HashMap},
  path::{Path, PathBuf},
  rc::Rc,
  sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::Sender,
  },
  time::{Duration, Instant},
};

use tauri::{webview::PlatformWebview, AppHandle, Manager, Url, Webview};
use webview2_com::{
  take_pwstr, AcceleratorKeyPressedEventHandler, AddScriptToExecuteOnDocumentCreatedCompletedHandler,
  BytesReceivedChangedEventHandler, CallDevToolsProtocolMethodCompletedHandler, ClearBrowsingDataCompletedHandler,
  ContainsFullScreenElementChangedEventHandler, DownloadStartingEventHandler, FaviconChangedEventHandler,
  GetCookiesCompletedHandler, GetNonDefaultPermissionSettingsCompletedHandler, HistoryChangedEventHandler,
  IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler, Microsoft::Web::WebView2::Win32::*,
  MoveFocusRequestedEventHandler, NavigationStartingEventHandler, SetPermissionStateCompletedHandler, SourceChangedEventHandler,
  StateChangedEventHandler, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
};
use windows::Win32::{
  Foundation::{E_OUTOFMEMORY, HWND},
  Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF, RGN_OR},
  UI::{
    Input::KeyboardAndMouse::{GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_MENU, VK_SHIFT, VK_TAB},
    Shell::SHCreateMemStream,
    WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE},
  },
};
use windows_core::{w, IUnknown, Interface, BOOL, HSTRING, PWSTR};

pub use crate::page_types::{Area, Autoplay, ClearKinds, PictureInPicture, ReloadMode};
use crate::{
  adblock::{AdBlock, Verdict},
  downloads::{DownloadRequest, DownloadUpdate},
  page_types::TabDirection,
  tracking::{self, Category, Tracking},
};

/// Відповідь, яку команда чекає з головного потоку.
pub type Reply<T> = Sender<Result<T, String>>;

impl Autoplay {
  fn state(self) -> COREWEBVIEW2_PERMISSION_STATE {
    match self {
      Self::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
      Self::Block => COREWEBVIEW2_PERMISSION_STATE_DENY,
      Self::Default => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    }
  }

  fn from_state(state: COREWEBVIEW2_PERMISSION_STATE) -> Self {
    match state {
      COREWEBVIEW2_PERMISSION_STATE_ALLOW => Self::Allow,
      COREWEBVIEW2_PERMISSION_STATE_DENY => Self::Block,
      _ => Self::Default,
    }
  }
}

pub(crate) fn core(platform: &PlatformWebview) -> windows_core::Result<ICoreWebView2> {
  unsafe { platform.controller().CoreWebView2() }
}

/// Профіль webview: у приватному вікні — окремий InPrivate, тож і дозволи там не зберігаються.
pub(crate) fn profile(platform: &PlatformWebview) -> windows_core::Result<ICoreWebView2Profile4> {
  unsafe { core(platform)?.cast::<ICoreWebView2_13>()?.Profile()?.cast() }
}

/// Сайт — під інтерфейсом. Там, де сторінка, інтерфейс прозорий (pages.rs), тож меню, вікна й тіні малюються просто
/// над живою сторінкою. Новий webview Windows кладе нагору, тому сайт одразу опускається вниз.
pub fn send_to_back(webview: &Webview) -> tauri::Result<()> {
  webview.with_webview(|platform| {
    let mut window = HWND::default();
    if unsafe { platform.controller().ParentWindow(&mut window) }.is_ok() {
      let _ = unsafe { SetWindowPos(window, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
    }
  })
}

/// Де інтерфейс ловить мишу. Над сайтом він прозорий, але WebView2 забирає кліки на всій своїй площі, тож із регіону
/// його вікна вирізається сторінка (`page`), а лишаються відкриті над нею панелі й вікна (`keep`). `page: None` —
/// увесь інтерфейс (сайту не видно чи над ним модальне вікно).
///
/// Регіон — із запасом довкола вікна: коли вікно росте, нова частина інтерфейсу не обрізається, доки той не надішле
/// новий регіон.
pub fn set_input_region(webview: &Webview, page: Option<Area>, keep: Vec<Area>, scale: f64) -> tauri::Result<()> {
  const OUTSIDE: i32 = 1 << 20;
  webview.with_webview(move |platform| {
    let mut window = HWND::default();
    if unsafe { platform.controller().ParentWindow(&mut window) }.is_err() {
      return;
    }
    let Some(page) = page else {
      unsafe { SetWindowRgn(window, None, true) };
      return;
    };
    let pixels = |value: f64| (value * scale).round() as i32;
    let rect = |area: &Area| unsafe {
      CreateRectRgn(pixels(area.x), pixels(area.y), pixels(area.x + area.width), pixels(area.y + area.height))
    };
    unsafe {
      let region = CreateRectRgn(-OUTSIDE, -OUTSIDE, OUTSIDE, OUTSIDE);
      let hole = rect(&page);
      CombineRgn(Some(region), Some(region), Some(hole), RGN_DIFF);
      let _ = DeleteObject(hole.into());
      for area in &keep {
        let part = rect(area);
        CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
        let _ = DeleteObject(part.into());
      }
      // Після SetWindowRgn регіоном володіє вікно — видаляти його самим не треба.
      SetWindowRgn(window, Some(region), true);
    }
  })
}

/// Повідомляє `report(page_url, icon_url)`, коли WebView2 визначив іконку сторінки (порожня — іконки немає).
pub fn watch_favicon(webview: &Webview, report: impl Fn(String, String) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?.cast::<ICoreWebView2_15>()?;
      let handler = FaviconChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(sender) = sender {
          let (mut page, mut icon) = (PWSTR::null(), PWSTR::null());
          unsafe {
            sender.Source(&mut page)?;
            sender.cast::<ICoreWebView2_15>()?.FaviconUri(&mut icon)?;
          }
          report(take_pwstr(page), take_pwstr(icon));
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core.add_FaviconChanged(&handler, &mut token) }
    };
    let _ = watch();
  })
}

/// Повідомлення скрипта сторінки (скрипт паролів, passwords.rs) — JSON-об'єкт рядком через chrome.webview.postMessage:
/// `on_message(адреса документа, повідомлення)` вирішує, що відповісти, — відповідь іде лише цій сторінці.
/// Саме рядком, бо перший цю подію отримує обробник IPC Tauri (wry): повідомлення-об'єкт він відкидає з помилкою,
/// і далі WebView2 його вже не передає. Рядки, що не є JSON-об'єктом (IPC Tauri), тут пропускаються.
pub fn watch_page_messages(
  webview: &Webview,
  on_message: impl Fn(&str, &serde_json::Value) -> Option<serde_json::Value> + Send + 'static,
) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else {
          return Ok(());
        };
        let (mut source, mut text) = (PWSTR::null(), PWSTR::null());
        unsafe {
          args.Source(&mut source)?;
          if args.TryGetWebMessageAsString(&mut text).is_err() {
            return Ok(());
          }
        }
        let (source, text) = (take_pwstr(source), take_pwstr(text));
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&text) else {
          return Ok(());
        };
        if !message.is_object() {
          return Ok(());
        }
        if let Some(reply) = on_message(&source, &message) {
          unsafe { sender.PostWebMessageAsJson(&HSTRING::from(reply.to_string()))? };
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_WebMessageReceived(&handler, &mut token) }
    };
    let _ = watch();
  })
}

/// Повідомлення сторінці сайту будь-коли, а не лише відповіддю в `watch_page_messages` (переклад приходить згодом).
/// Отримує його поточний документ webview.
pub fn post_page_message(webview: &Webview, message: &serde_json::Value) -> tauri::Result<()> {
  let message = message.to_string();
  webview.with_webview(move |platform| {
    if let Ok(core) = core(&platform) {
      let _ = unsafe { core.PostWebMessageAsJson(&HSTRING::from(message.as_str())) };
    }
  })
}

/// Повідомляє `report(fullscreen)`, коли сторінка входить у повноекранний режим (відео тощо) чи виходить з нього.
/// Сам webview про розміри не дбає: розтягнути його на все вікно — справа `report` (fullscreen.rs).
pub fn watch_fullscreen(webview: &Webview, report: impl Fn(bool) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(sender) = sender {
          let mut fullscreen = BOOL::default();
          unsafe { sender.ContainsFullScreenElement(&mut fullscreen)? };
          report(fullscreen.as_bool());
        }
        Ok(())
      }));
      let mut token = 0;
      unsafe { core(&platform)?.add_ContainsFullScreenElementChanged(&handler, &mut token) }
    };
    let _ = watch();
  })
}

impl TabDirection {
  fn reason(self) -> COREWEBVIEW2_MOVE_FOCUS_REASON {
    match self {
      Self::Forward => COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT,
      Self::Backward => COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS,
    }
  }
}

/// Фокус — у сайт, як клавішею Tab з інтерфейсу: на перший елемент сторінки чи (`Backward`) на останній.
pub fn focus_through_tab(webview: &Webview, direction: TabDirection) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let _ = unsafe { platform.controller().MoveFocus(direction.reason()) };
  })
}

/// Tab з останнього елемента сайту чи самого інтерфейсу (Shift+Tab — з першого) — в інтерфейс вікна, на його перший
/// (останній) елемент: фокус ходить колом панелі → сайт → панелі, як у Chrome (з панелей у сайт його веде сам
/// інтерфейс, Browser.enterPage). Без цього WebView2 сам шукав би, кому віддати фокус: із сайту — колом усередині
/// нього, й клавішами з сайту було б не вийти. Сайт на весь екран — інтерфейс під ним, тож там фокус лишається в сайті.
pub fn watch_focus_leaving(webview: &Webview) -> tauri::Result<()> {
  let page = webview.clone();
  webview.with_webview(move |platform| {
    let handler = MoveFocusRequestedEventHandler::create(Box::new(move |_, args| {
      let Some(args) = args else {
        return Ok(());
      };
      let window = page.window();
      let Some(interface) = window.get_webview(window.label()).filter(|_| !crate::fullscreen::holds(page.label())) else {
        return Ok(());
      };
      let mut reason = COREWEBVIEW2_MOVE_FOCUS_REASON::default();
      unsafe {
        args.Reason(&mut reason)?;
        args.SetHandled(true)?;
      }
      let _ = interface.with_webview(move |platform| {
        let _ = unsafe { platform.controller().MoveFocus(reason) };
      });
      Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { platform.controller().add_MoveFocusRequested(&handler, &mut token) };
  })
}

/// Віртуальні коди клавіш: S, T, U і 0 — їхні ASCII, решта — VK_OEM_PLUS, VK_OEM_MINUS і клавіші цифрового блока.
const KEY_S: u32 = 0x53;
const KEY_T: u32 = 0x54;
const KEY_U: u32 = 0x55;
const KEY_0: u32 = 0x30;
const KEY_PLUS: u32 = 0xBB;
const KEY_MINUS: u32 = 0xBD;
const KEY_NUMPAD_0: u32 = 0x60;
const KEY_NUMPAD_PLUS: u32 = 0x6B;
const KEY_NUMPAD_MINUS: u32 = 0x6D;

/// Без інструментів розробника: F12 і «Перевірити» не відкривають DevTools цього webview (інтерфейс браузера).
#[cfg(not(debug_assertions))]
pub fn disable_devtools(webview: &Webview) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    if let Err(error) = core(&platform).and_then(|core| unsafe { core.Settings()?.SetAreDevToolsEnabled(false) }) {
      log::warn!("webview: не вдалося вимкнути інструменти розробника: {error}");
    }
  })
}

/// Гарячі клавіші браузера, натиснуті, поки фокус у сайті: самі клавіші отримує webview сайту,
/// тож вони перехоплюються тут (сайт їх не бачить) і передаються інтерфейсу як `report(shortcut)`.
/// Це Ctrl+Tab (`next-tab`), Ctrl+Shift+Tab (`previous-tab`), Ctrl+Shift+T (`reopen-tab`), Ctrl+Shift+S (`screenshot`),
/// Ctrl+U (`view-source`, код сторінки) і масштаб: Ctrl+= чи Ctrl++ (`zoom-in`), Ctrl+− (`zoom-out`), Ctrl+0 (`zoom-reset`).
/// Інструменти розробника (F12, Ctrl+Shift+I/J/C) відкриває сам WebView2. Esc теж лишається WebView2 — `escape` лише
/// попереджає, що сторінка, можливо, зараз вийде з повного екрана (тоді екран темніє, fullscreen.rs).
pub fn watch_shortcuts(webview: &Webview, report: impl Fn(&'static str) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
      let Some(args) = args else {
        return Ok(());
      };
      let (mut kind, mut key) = (COREWEBVIEW2_KEY_EVENT_KIND::default(), 0u32);
      unsafe {
        args.KeyEventKind(&mut kind)?;
        args.VirtualKey(&mut key)?;
      }
      let held = |key: VIRTUAL_KEY| unsafe { GetKeyState(i32::from(key.0)) } < 0;
      // Esc лишається WebView2 (виводить сторінку з повного екрана), а `escape` лише попереджає (fullscreen.rs).
      if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && key == u32::from(VK_ESCAPE.0) && !held(VK_CONTROL) && !held(VK_MENU) {
        report("escape");
        return Ok(());
      }
      if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || !held(VK_CONTROL) || held(VK_MENU) {
        return Ok(());
      }
      let shortcut = match key {
        key if key == u32::from(VK_TAB.0) => Some(if held(VK_SHIFT) { "previous-tab" } else { "next-tab" }),
        KEY_S if held(VK_SHIFT) => Some("screenshot"),
        KEY_T if held(VK_SHIFT) => Some("reopen-tab"),
        KEY_U if !held(VK_SHIFT) => Some("view-source"),
        KEY_PLUS | KEY_NUMPAD_PLUS => Some("zoom-in"),
        KEY_MINUS | KEY_NUMPAD_MINUS => Some("zoom-out"),
        KEY_0 | KEY_NUMPAD_0 if !held(VK_SHIFT) => Some("zoom-reset"),
        _ => None,
      };
      if let Some(shortcut) = shortcut {
        unsafe { args.SetHandled(true)? };
        report(shortcut);
      }
      Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { platform.controller().add_AcceleratorKeyPressed(&handler, &mut token) };
  })
}

/// Замінює скрипт, що виконується на початку кожного документа: прибирає попередній (за id) і додає новий.
/// `added(id)` отримує id нового — щоб наступного разу прибрати вже його.
pub fn replace_document_script(
  webview: &Webview,
  previous: Option<String>,
  script: String,
  added: impl FnOnce(String) + Send + 'static,
) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let replace = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      if let Some(previous) = previous {
        unsafe { core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(previous.as_str()))? };
      }
      let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
        if result.is_ok() {
          added(id);
        }
        Ok(())
      }));
      unsafe { core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script.as_str()), &handler) }
    };
    let _ = replace();
  })
}

/// Рівень вбудованого захисту від стеження WebView2 (як в Edge: куки й сховища трекерів) для профілю сторінки.
pub fn set_tracking_prevention(webview: &Webview, level: tracking::Level) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let set = || -> windows_core::Result<()> {
      let profile: ICoreWebView2Profile3 = unsafe { core(&platform)?.cast::<ICoreWebView2_13>()?.Profile()?.cast()? };
      let level = match level {
        tracking::Level::Off => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
        tracking::Level::Standard => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
        tracking::Level::Strict => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT,
      };
      unsafe { profile.SetPreferredTrackingPreventionLevel(level) }
    };
    if let Err(error) = set() {
      log::warn!("tracking: не вдалося задати рівень захисту WebView2: {error}");
    }
  })
}

/// Повідомляє `report(url, can_go_back, can_go_forward)` на кожну зміну адреси чи історії вкладки —
/// зокрема коли сайт змінює адресу без перезавантаження (history.pushState, як YouTube).
pub fn watch_navigation(webview: &Webview, report: impl Fn(String, bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      let on_source = report.clone();
      let mut token = 0;
      unsafe {
        core.add_SourceChanged(
          &SourceChangedEventHandler::create(Box::new(move |sender, _| report_navigation(sender, &on_source))),
          &mut token,
        )?;
        core.add_HistoryChanged(
          &HistoryChangedEventHandler::create(Box::new(move |sender, _| report_navigation(sender, &report))),
          &mut token,
        )?;
      }
      Ok(())
    };
    let _ = watch();
  })
}

fn report_navigation(sender: Option<ICoreWebView2>, report: &impl Fn(String, bool, bool)) -> windows_core::Result<()> {
  if let Some(core) = sender {
    let (mut url, mut back, mut forward) = (PWSTR::null(), BOOL::default(), BOOL::default());
    unsafe {
      core.Source(&mut url)?;
      core.CanGoBack(&mut back)?;
      core.CanGoForward(&mut forward)?;
    }
    report(take_pwstr(url), back.as_bool(), forward.as_bool());
  }
  Ok(())
}

/// Виконує `mode` для поточного сайту вкладки (`url`, `origin`) і перезавантажує сторінку.
/// Усе — через сам WebView2 і протокол DevTools, без скриптів, які бачила б сторінка.
pub fn reload_with(webview: &Webview, mode: ReloadMode, url: String, origin: String, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let core = match core(&platform) {
      Ok(core) => core,
      Err(error) => return finish(&reply, Err(error)),
    };
    match mode {
      ReloadMode::Hard => hard_reload(&core, reply),
      ReloadMode::Cache => clear_origin_and_reload(core, &origin, "cache_storage", reply),
      ReloadMode::SiteData => {
        // sessionStorage належить вкладці, а не сайту, тож його чистимо в самій сторінці — без жесту користувача.
        let (page, failed) = (core.clone(), reply.clone());
        let started = devtools(&core, "Runtime.evaluate", r#"{"expression":"sessionStorage.clear()"}"#, move |_| {
          clear_origin_and_reload(page, &origin, "cache_storage,local_storage,indexeddb,service_workers,file_systems,websql", reply);
        });
        if let Err(error) = started {
          finish(&failed, Err(error));
        }
      }
      ReloadMode::Cookies => delete_cookies_and_reload(core, &url, reply),
      ReloadMode::All => {
        let (page, failed) = (core.clone(), reply.clone());
        let started = devtools(&core, "Runtime.evaluate", r#"{"expression":"sessionStorage.clear()"}"#, move |_| {
          let params = serde_json::json!({ "origin": origin, "storageTypes": "cache_storage,local_storage,indexeddb,service_workers,file_systems,websql" });
          let (cookies_page, failed) = (page.clone(), reply.clone());
          let started = devtools(&page, "Storage.clearDataForOrigin", &params.to_string(), move |result| match result {
            Ok(_) => delete_cookies_and_reload(cookies_page, &url, reply),
            Err(error) => finish(&reply, Err(error)),
          });
          if let Err(error) = started {
            finish(&failed, Err(error));
          }
        });
        if let Err(error) = started {
          finish(&failed, Err(error));
        }
      }
    }
  })
}

fn finish(reply: &Reply<()>, result: windows_core::Result<()>) {
  let _ = reply.send(result.map_err(|error| error.to_string()));
}

/// Очищає дані профілю сайтів `webview`, змінені від `since` (секунди Unix; 0 — за весь час).
///
/// Якщо профіль спільний з інтерфейсом браузера (`shared_with_ui`, обліковий запис-власник), localStorage цілком
/// не чиститься — у ньому дані самого браузера, — а лише для `origins` (сайти з історії) через DevTools.
pub fn clear_browsing_data(
  webview: &Webview,
  kinds: ClearKinds,
  shared_with_ui: bool,
  since: f64,
  origins: Vec<String>,
  reply: Reply<()>,
) -> tauri::Result<()> {
  let flags = |list: &[COREWEBVIEW2_BROWSING_DATA_KINDS]| list.iter().fold(0, |all, kind| all | kind.0);
  let mut mask = 0;
  if kinds.site_data {
    mask |= flags(&[
      COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES,
      COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB,
      COREWEBVIEW2_BROWSING_DATA_KINDS_FILE_SYSTEMS,
      COREWEBVIEW2_BROWSING_DATA_KINDS_WEB_SQL,
      COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
      COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS,
    ]);
    if !shared_with_ui {
      mask |= COREWEBVIEW2_BROWSING_DATA_KINDS_LOCAL_STORAGE.0;
    }
  }
  if kinds.cache {
    mask |= COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0;
  }
  if kinds.history {
    mask |= flags(&[COREWEBVIEW2_BROWSING_DATA_KINDS_BROWSING_HISTORY, COREWEBVIEW2_BROWSING_DATA_KINDS_DOWNLOAD_HISTORY]);
  }
  if kinds.autofill {
    mask |= COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0;
  }
  if kinds.settings {
    mask |= COREWEBVIEW2_BROWSING_DATA_KINDS_SETTINGS.0;
  }
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let run = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      if kinds.site_data && shared_with_ui {
        for origin in &origins {
          let params = serde_json::json!({ "origin": origin, "storageTypes": "local_storage" }).to_string();
          devtools(&core, "Storage.clearDataForOrigin", &params, |_| ())?;
        }
      }
      if mask == 0 {
        finish(&reply, Ok(()));
        return Ok(());
      }
      let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
        finish(&reply, result);
        Ok(())
      }));
      let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |time| time.as_secs_f64());
      unsafe {
        profile(&platform)?.ClearBrowsingDataInTimeRange(COREWEBVIEW2_BROWSING_DATA_KINDS(mask), since, now + 60.0, &handler)
      }
    };
    if let Err(error) = run() {
      finish(&failed, Err(error));
    }
  })
}

/// Метод протоколу DevTools у самому WebView2; `then` отримує відповідь як JSON.
/// Найбільша висота знімка всієї сторінки: довші сторінки обрізаються (більших картинок Chromium не малює).
const SCREENSHOT_MAX_HEIGHT: f64 = 16384.0;

/// Скріншот сторінки PNG (DevTools Page.captureScreenshot): видима частина чи вся сторінка з прокруткою (`full`).
pub fn screenshot(webview: &Webview, full: bool, reply: Reply<Vec<u8>>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = move || -> windows_core::Result<()> {
      let core = core(&platform)?;
      if full {
        return shoot_full_page(core, reply);
      }
      devtools(&core, "Page.captureScreenshot", r#"{"format":"png"}"#, move |result| {
        let _ = reply.send(decode_screenshot(result));
      })
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// Уся сторінка. captureBeyondViewport у WebView2 зависає, тож сторінці на мить дається область перегляду заввишки
/// з неї саму (Emulation.setDeviceMetricsOverride), знімається видиме, а тоді все повертається — разом із місцем,
/// де сторінку гортали.
fn shoot_full_page(core: ICoreWebView2, reply: Reply<Vec<u8>>) -> windows_core::Result<()> {
  let page = core.clone();
  devtools(&core, "Page.getLayoutMetrics", "{}", move |result| {
    let metrics = result.ok().and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    let number = |group: &str, key: &str| metrics.as_ref().and_then(|metrics| metrics.get(group)?.get(key)?.as_f64());
    let (Some(width), Some(height)) = (number("cssLayoutViewport", "clientWidth"), number("cssContentSize", "height")) else {
      let _ = reply.send(Err(crate::i18n::text("Не вдалося дізнатися розміри сторінки", "Couldn't get the page size").into()));
      return;
    };
    let scroll = (number("cssLayoutViewport", "pageX").unwrap_or(0.0), number("cssLayoutViewport", "pageY").unwrap_or(0.0));
    let size = serde_json::json!({
      "width": width.round(),
      "height": height.min(SCREENSHOT_MAX_HEIGHT).round(),
      "deviceScaleFactor": 0,
      "mobile": false,
    });
    let (tall, failed) = (page.clone(), reply.clone());
    let started = devtools(&page, "Emulation.setDeviceMetricsOverride", &size.to_string(), move |result| {
      if let Err(error) = result {
        let _ = reply.send(Err(error.to_string()));
        return;
      }
      let (restore, failed) = (tall.clone(), reply.clone());
      let shot = devtools(&tall, "Page.captureScreenshot", r#"{"format":"png"}"#, move |result| {
        restore_page(&restore, scroll);
        let _ = reply.send(decode_screenshot(result));
      });
      if let Err(error) = shot {
        restore_page(&tall, scroll);
        let _ = failed.send(Err(error.to_string()));
      }
    });
    if let Err(error) = started {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// Сторінка знову звичайного розміру й там, де її гортали до знімка.
fn restore_page(core: &ICoreWebView2, (x, y): (f64, f64)) {
  let page = core.clone();
  let _ = devtools(core, "Emulation.clearDeviceMetricsOverride", "{}", move |_| {
    let script = serde_json::json!({ "expression": format!("window.scrollTo({x}, {y})") });
    let _ = devtools(&page, "Runtime.evaluate", &script.to_string(), |_| {});
  });
}

fn decode_screenshot(result: windows_core::Result<String>) -> Result<Vec<u8>, String> {
  /// Відповідь Page.captureScreenshot — лише картинка (base64), без дерева JSON: знімок буває на десятки мегабайтів.
  #[derive(serde::Deserialize)]
  struct Shot<'a> {
    #[serde(borrow)]
    data: std::borrow::Cow<'a, str>,
  }
  let json = result.map_err(|error| error.to_string())?;
  let shot: Shot =
    serde_json::from_str(&json).map_err(|_| crate::i18n::text("Порожній знімок", "Empty screenshot").to_string())?;
  base64::Engine::decode(&base64::engine::general_purpose::STANDARD, shot.data.as_bytes()).map_err(|error| error.to_string())
}

fn devtools(
  core: &ICoreWebView2,
  method: &str,
  params: &str,
  then: impl FnOnce(windows_core::Result<String>) + 'static,
) -> windows_core::Result<()> {
  let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
    then(result.map(|()| json));
    Ok(())
  }));
  unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler) }
}

fn hard_reload(core: &ICoreWebView2, reply: Reply<()>) {
  let failed = reply.clone();
  let started = devtools(core, "Page.reload", r#"{"ignoreCache":true}"#, move |result| finish(&reply, result.map(|_| ())));
  if let Err(error) = started {
    finish(&failed, Err(error));
  }
}

/// Дані сайту в сховищах заданих типів (назви — як у Storage.clearDataForOrigin), а тоді жорстке оновлення.
fn clear_origin_and_reload(core: ICoreWebView2, origin: &str, types: &str, reply: Reply<()>) {
  let (page, failed) = (core.clone(), reply.clone());
  let params = serde_json::json!({ "origin": origin, "storageTypes": types }).to_string();
  let started = devtools(&core, "Storage.clearDataForOrigin", &params, move |result| match result {
    Ok(_) => hard_reload(&page, reply),
    Err(error) => finish(&reply, Err(error)),
  });
  if let Err(error) = started {
    finish(&failed, Err(error));
  }
}

/// Усі cookies, що надсилаються на `url` (і самого хоста, і домену), а тоді звичайне оновлення.
fn delete_cookies_and_reload(core: ICoreWebView2, url: &str, reply: Reply<()>) {
  let failed = reply.clone();
  let start = || -> windows_core::Result<()> {
    let manager = unsafe { core.cast::<ICoreWebView2_2>()?.CookieManager()? };
    let deleting = manager.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |result, cookies| {
      let delete = || -> windows_core::Result<()> {
        result?;
        if let Some(cookies) = cookies {
          let mut count = 0;
          unsafe { cookies.Count(&mut count)? };
          for index in 0..count {
            unsafe { deleting.DeleteCookie(&cookies.GetValueAtIndex(index)?)? };
          }
        }
        unsafe { core.Reload() }
      };
      finish(&reply, delete());
      Ok(())
    }));
    unsafe { manager.GetCookies(&HSTRING::from(url), &handler) }
  };
  if let Err(error) = start() {
    finish(&failed, Err(error));
  }
}

/// Вмикає «картинку в картинці» для відео, що грає (з кількох — найбільшого), або вимикає, якщо вже ввімкнена.
const PICTURE_IN_PICTURE_SCRIPT: &str = r#"(async () => {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return 'closed';
  }
  const area = (video) => video.clientWidth * video.clientHeight;
  const videos = [...document.querySelectorAll('video')]
    .filter((video) => video.readyState > 0 && !video.disablePictureInPicture)
    .sort((a, b) => area(b) - area(a));
  const video = videos.find((video) => !video.paused) ?? videos[0];
  if (!video) {
    return 'no-video';
  }
  await video.requestPictureInPicture();
  return 'opened';
})()"#;

/// Перемикає «картинку в картинці». Без жесту користувача браузер її не дозволить, тож скрипт
/// виконується з жестом — це чесно, бо запускає його сам користувач (кнопка чи Ctrl+Shift+]).
pub fn picture_in_picture(webview: &Webview, reply: Reply<PictureInPicture>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let params = serde_json::json!({
      "expression": PICTURE_IN_PICTURE_SCRIPT,
      "userGesture": true,
      "awaitPromise": true,
      "returnByValue": true,
    })
    .to_string();
    let started = core(&platform).and_then(|core| {
      devtools(&core, "Runtime.evaluate", &params, move |result| {
        let outcome = result.map_err(|error| error.to_string()).and_then(|json| {
          let response: serde_json::Value = serde_json::from_str(&json).map_err(|error| error.to_string())?;
          match response.get("exceptionDetails") {
            Some(details) => Err(details["exception"]["description"].as_str().unwrap_or("Picture-in-picture failed").to_string()),
            None => match response["result"]["value"].as_str() {
              Some("opened") => Ok(PictureInPicture::Opened),
              Some("closed") => Ok(PictureInPicture::Closed),
              Some("no-video") => Ok(PictureInPicture::NoVideo),
              other => Err(format!("Picture-in-picture: unexpected result {other:?}")),
            },
          }
        });
        let _ = reply.send(outcome);
      })
    });
    if let Err(error) = started {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// «Назад» (step < 0) чи «Вперед» історією вкладки.
pub fn go(webview: &Webview, step: i32) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let _ = core(&platform).and_then(|core| unsafe {
      if step < 0 {
        core.GoBack()
      } else {
        core.GoForward()
      }
    });
  })
}

fn audio(core: &ICoreWebView2_8) -> windows_core::Result<(bool, bool)> {
  let (mut playing, mut muted) = (BOOL::default(), BOOL::default());
  unsafe {
    core.IsDocumentPlayingAudio(&mut playing)?;
    core.IsMuted(&mut muted)?;
  }
  Ok((playing.as_bool(), muted.as_bool()))
}

/// Повідомляє `report(playing, muted)` щоразу, як сторінка починає чи перестає грати звук або його вимикають.
pub fn watch_audio(webview: &Webview, report: impl Fn(bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?.cast::<ICoreWebView2_8>()?;
      let mut token = 0;
      unsafe {
        core.add_IsDocumentPlayingAudioChanged(
          &IsDocumentPlayingAudioChangedEventHandler::create(on_audio(report.clone())),
          &mut token,
        )?;
        core.add_IsMutedChanged(&IsMutedChangedEventHandler::create(on_audio(report)), &mut token)?;
      }
      Ok(())
    };
    let _ = watch();
  })
}

type AudioHandler = Box<dyn FnMut(Option<ICoreWebView2>, Option<IUnknown>) -> windows_core::Result<()>>;

fn on_audio(report: impl Fn(bool, bool) + 'static) -> AudioHandler {
  Box::new(move |sender, _| {
    if let Some(sender) = sender {
      let (playing, muted) = audio(&sender.cast()?)?;
      report(playing, muted);
    }
    Ok(())
  })
}

pub fn set_muted(webview: &Webview, muted: bool, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let result = core(&platform).and_then(|core| unsafe { core.cast::<ICoreWebView2_8>()?.SetIsMuted(muted) });
    let _ = reply.send(result.map_err(|error| error.to_string()));
  })
}

/// Збережений для `origin` дозвіл на автовідтворення.
pub fn autoplay(webview: &Webview, origin: String, reply: Reply<Autoplay>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
        let found = result.and_then(|()| find_autoplay(settings, &origin));
        let _ = reply.send(found.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe { profile(&platform)?.GetNonDefaultPermissionSettings(&handler) }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

fn find_autoplay(settings: Option<ICoreWebView2PermissionSettingCollectionView>, origin: &str) -> windows_core::Result<Autoplay> {
  let Some(settings) = settings else {
    return Ok(Autoplay::Default);
  };
  let mut count = 0;
  unsafe { settings.Count(&mut count)? };
  for index in 0..count {
    let setting = unsafe { settings.GetValueAtIndex(index)? };
    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
    let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
    let mut setting_origin = PWSTR::null();
    unsafe {
      setting.PermissionKind(&mut kind)?;
      setting.PermissionState(&mut state)?;
      setting.PermissionOrigin(&mut setting_origin)?;
    }
    let setting_origin = take_pwstr(setting_origin);
    if kind == COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY && setting_origin.trim_end_matches('/') == origin {
      return Ok(Autoplay::from_state(state));
    }
  }
  Ok(Autoplay::Default)
}

/// Автовідтворення за замовчуванням заборонене — і звук, і відео. Сайту, для якого в профілі ще немає
/// дозволу, на кожному переході (і на першій сторінці `first_url`) ставиться «заборонити»;
/// дозволи, які вибрав користувач, не чіпаються.
pub fn block_autoplay_by_default(webview: &Webview, first_url: String) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?;
      let profile = profile(&platform)?;
      deny_autoplay_unless_set(&profile, &first_url)?;
      let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
          return Ok(());
        };
        let mut uri = PWSTR::null();
        unsafe { args.Uri(&mut uri)? };
        deny_autoplay_unless_set(&profile, &take_pwstr(uri))
      }));
      let mut token = 0;
      unsafe { core.add_NavigationStarting(&handler, &mut token) }
    };
    let _ = watch();
  })
}

fn deny_autoplay_unless_set(profile: &ICoreWebView2Profile4, url: &str) -> windows_core::Result<()> {
  let Some(origin) =
    Url::parse(url).ok().filter(|url| matches!(url.scheme(), "http" | "https")).map(|url| url.origin().ascii_serialization())
  else {
    return Ok(());
  };
  let target = profile.clone();
  let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
    if result.is_ok() && matches!(find_autoplay(settings, &origin), Ok(Autoplay::Default)) {
      let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
      unsafe {
        target.SetPermissionState(
          COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
          &HSTRING::from(origin.as_str()),
          COREWEBVIEW2_PERMISSION_STATE_DENY,
          &done,
        )?
      };
    }
    Ok(())
  }));
  unsafe { profile.GetNonDefaultPermissionSettings(&handler) }
}

/// Зберігає дозвіл для `origin` у профілі; сторінка побачить його після перезавантаження.
pub fn set_autoplay(webview: &Webview, origin: String, autoplay: Autoplay, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let failed = reply.clone();
    let request = || -> windows_core::Result<()> {
      let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
        let _ = reply.send(result.map_err(|error| error.to_string()));
        Ok(())
      }));
      unsafe {
        profile(&platform)?.SetPermissionState(
          COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
          &HSTRING::from(origin.as_str()),
          autoplay.state(),
          &handler,
        )
      }
    };
    if let Err(error) = request() {
      let _ = failed.send(Err(error.to_string()));
    }
  })
}

/// Блокувальник реклами вкладки (adblock.rs): кожен запит сторінки — і з iframe, і з воркерів — перевіряється
/// за списками фільтрів, а на початку кожного документа додається скрипт, що ховає рекламні блоки й запускає
/// скриптлети. `report(blocked)` — скільки запитів заблоковано на поточній сторінці.
///
/// Перший перехід на `url` Tauri починає сам, ще до цих обробників, тож перша сторінка готується тут одразу:
/// її мережевий запит приходить пізніше, ніж стає фільтр, а документ створюється вже з нашим скриптом.
/// Що заблоковано на сторінці — для інтерфейсу.
pub enum Blocked {
  /// Скільки реклами заблокував блокувальник.
  Ads(u32),
  /// Елементи стеження (категорія й хост), які заблокував захист від стеження (tracking.rs).
  Trackers(Vec<(Category, String)>),
}

/// Блокувальник реклами й захист від стеження для сторінки вікна `ui`: обидва перевіряють запити в одному обробнику.
pub fn block_ads(
  webview: &Webview,
  app: AppHandle,
  ui: String,
  url: String,
  report: impl Fn(Blocked) + Send + 'static,
) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let watch = core(&platform).and_then(|core| watch_requests(&core, platform.environment(), app, ui, &url, report));
    if let Err(error) = watch {
      log::warn!("adblock: не вдалося під'єднатися до сторінки: {error}");
    }
  })
}

/// Що блокувальник знає про документ вкладки.
#[derive(Default)]
struct AdPage {
  /// Адреса документа (без #…) — джерело запитів для правил — і її хост.
  url: String,
  host: String,
  blocked: u32,
  /// Заблоковані елементи стеження: категорія й хост.
  trackers: BTreeSet<(Category, String)>,
  /// id скрипта сторінки й «покоління»: id, що прийшов уже після наступного переходу, теж прибирається.
  script: Option<String>,
  generation: u64,
}

fn watch_requests(
  core: &ICoreWebView2,
  environment: ICoreWebView2Environment,
  app: AppHandle,
  ui: String,
  first_url: &str,
  report: impl Fn(Blocked) + 'static,
) -> windows_core::Result<()> {
  // Усі запити, зокрема з iframe й воркерів (без ICoreWebView2_22 — лише ті, що бачить старий фільтр).
  match core.cast::<ICoreWebView2_22>() {
    Ok(core) => unsafe {
      core.AddWebResourceRequestedFilterWithRequestSourceKinds(
        w!("*"),
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
      )?
    },
    Err(_) => unsafe { core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)? },
  }

  let page = Rc::new(RefCell::new(AdPage::default()));
  let report = Rc::new(report);
  start_page(core, &page, &app, first_url, false, &*report)?;
  let (on_request_page, on_request_report, on_request_app, on_request_ui) =
    (page.clone(), report.clone(), app.clone(), ui.clone());
  let mut token = 0;
  unsafe {
    core.add_WebResourceRequested(
      &WebResourceRequestedEventHandler::create(Box::new(move |_, args| match args {
        Some(args) => on_request(&args, &environment, &on_request_app, &on_request_ui, &on_request_page, &*on_request_report),
        None => Ok(()),
      })),
      &mut token,
    )?;
    core.add_NavigationStarting(
      &NavigationStartingEventHandler::create(Box::new(move |sender, args| match (sender, args) {
        (Some(core), Some(args)) => on_navigation_starting(&core, &args, &app, &ui, &page, &*report),
        _ => Ok(()),
      })),
      &mut token,
    )?;
  }
  Ok(())
}

fn on_request(
  args: &ICoreWebView2WebResourceRequestedEventArgs,
  environment: &ICoreWebView2Environment,
  app: &AppHandle,
  ui: &str,
  page: &RefCell<AdPage>,
  report: &dyn Fn(Blocked),
) -> windows_core::Result<()> {
  let request = unsafe { args.Request()? };
  let (mut uri, mut method, mut context) = (PWSTR::null(), PWSTR::null(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default());
  unsafe {
    request.Uri(&mut uri)?;
    request.Method(&mut method)?;
    args.ResourceContext(&mut context)?;
  }
  let (uri, method) = (take_pwstr(uri), take_pwstr(method));
  let rules = app.state::<Tracking>().rules(ui);
  // Global Privacy Control — кожному запитові до сайтів, і самій сторінці теж.
  if rules.gpc && (uri.starts_with("https:") || uri.starts_with("http:")) {
    let headers = unsafe { request.Headers()? };
    unsafe {
      headers.SetHeader(w!("Sec-GPC"), w!("1"))?;
      headers.SetHeader(w!("DNT"), w!("1"))?;
    }
  }
  let (page_url, page_host) = {
    let page = page.borrow();
    (page.url.clone(), page.host.clone())
  };
  let Some(kind) = request_type(context, &uri, &page_url) else {
    return Ok(());
  };
  let adblock = app.state::<AdBlock>();

  // Захист від стеження — раніше за блокувальник: заблоковане ним лічиться як елемент стеження, а не реклама.
  if rules.protects(&page_host) {
    if let Some(category) = app.state::<Tracking>().check(&rules, &uri, &page_url, kind, &method) {
      // Підміна з блокувальника (порожній analytics.js тощо) безпечніша за відмову: скрипти сайту не падають.
      let verdict = match adblock.check(&uri, &page_url, kind, &method) {
        replace @ Verdict::Replace { .. } => replace,
        _ => Verdict::Block,
      };
      respond(args, environment, &page_url, verdict)?;
      let host = Url::parse(&uri).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default();
      let trackers = {
        let mut page = page.borrow_mut();
        page.trackers.insert((category, host)).then(|| page.trackers.iter().cloned().collect())
      };
      if let Some(trackers) = trackers {
        report(Blocked::Trackers(trackers));
      }
      return Ok(());
    }
  }

  if !adblock.active_on(&page_host) {
    return Ok(());
  }
  let verdict = adblock.check(&uri, &page_url, kind, &method);
  if matches!(verdict, Verdict::Allow) {
    return Ok(());
  }
  respond(args, environment, &page_url, verdict)?;
  let blocked = {
    let mut page = page.borrow_mut();
    page.blocked += 1;
    page.blocked
  };
  report(Blocked::Ads(blocked));
  Ok(())
}

/// Відповідь замість сервера на заблокований (`Block`) чи підмінений (`Replace`) запит.
fn respond(
  args: &ICoreWebView2WebResourceRequestedEventArgs,
  environment: &ICoreWebView2Environment,
  page_url: &str,
  verdict: Verdict,
) -> windows_core::Result<()> {
  let response = match verdict {
    Verdict::Allow => return Ok(()),
    // Без CORS-заголовків: для fetch і XHR з іншого сайту це мережева помилка, як в інших блокувальників.
    Verdict::Block => unsafe { environment.CreateWebResourceResponse(None, 403, w!("Blocked"), w!(""))? },
    Verdict::Replace { mime, body } => {
      let page_origin = Url::parse(page_url).map(|url| url.origin().ascii_serialization()).unwrap_or_default();
      let stream = unsafe { SHCreateMemStream(Some(&body)) }.ok_or_else(|| windows_core::Error::from(E_OUTOFMEMORY))?;
      let headers = HSTRING::from(replacement_headers(args, &mime, &page_origin));
      unsafe { environment.CreateWebResourceResponse(&stream, 200, w!("OK"), &headers)? }
    }
  };
  unsafe { args.SetResponse(&response) }
}

/// Заголовки підмінної відповіді. Дозвіл CORS — саме для джерела запиту й разом із cookies:
/// `*` браузер для запитів з обліковими даними (fetch і XHR із credentials) не приймає, і вони падали б
/// з помилкою CORS — як запити відео YouTube, які блокувальник підміняє порожнім відео.
fn replacement_headers(args: &ICoreWebView2WebResourceRequestedEventArgs, mime: &str, page_origin: &str) -> String {
  let origin = request_origin(args).ok().flatten().unwrap_or_else(|| page_origin.to_string());
  format!(
    "Content-Type: {mime}\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Credentials: true\r\nVary: Origin"
  )
}

/// Заголовок Origin запиту, якщо він є.
fn request_origin(args: &ICoreWebView2WebResourceRequestedEventArgs) -> windows_core::Result<Option<String>> {
  let headers = unsafe { args.Request()?.Headers()? };
  let mut present = BOOL::default();
  unsafe { headers.Contains(w!("Origin"), &mut present)? };
  if !present.as_bool() {
    return Ok(None);
  }
  let mut origin = PWSTR::null();
  unsafe { headers.GetHeader(w!("Origin"), &mut origin)? };
  Ok(Some(take_pwstr(origin)).filter(|origin| !origin.is_empty()))
}

/// Тип запиту в термінах списків фільтрів; `None` — запит не перевіряється (сам документ вкладки, data:, blob:…).
fn request_type(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT, uri: &str, page: &str) -> Option<&'static str> {
  if !["http:", "https:", "ws:", "wss:"].iter().any(|scheme| uri.starts_with(scheme)) {
    return None;
  }
  Some(match context {
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT if without_fragment(uri).as_deref() == Some(page) => return None,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "sub_frame",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
    _ => "other",
  })
}

fn without_fragment(uri: &str) -> Option<String> {
  let mut url = Url::parse(uri).ok()?;
  url.set_fragment(None);
  Some(url.into())
}

/// Новий документ вкладки: лічильник з нуля (якщо це не переадресація) і скрипт сторінки для нової адреси.
/// Адресу з мітками стеження (fbclid, gclid…) захист від стеження відкриває вже без них.
fn on_navigation_starting(
  core: &ICoreWebView2,
  args: &ICoreWebView2NavigationStartingEventArgs,
  app: &AppHandle,
  ui: &str,
  page: &Rc<RefCell<AdPage>>,
  report: &dyn Fn(Blocked),
) -> windows_core::Result<()> {
  let (mut uri, mut cancel, mut redirected) = (PWSTR::null(), BOOL::default(), BOOL::default());
  unsafe {
    args.Cancel(&mut cancel)?;
    args.Uri(&mut uri)?;
    args.IsRedirected(&mut redirected)?;
  }
  let uri = take_pwstr(uri);
  // Перехід, який скасував інший обробник (не-вебова адреса тощо), сторінку не змінює.
  if cancel.as_bool() {
    return Ok(());
  }
  let rules = app.state::<Tracking>().rules(ui);
  let clean = Url::parse(&uri)
    .ok()
    .filter(|url| matches!(url.scheme(), "http" | "https") && rules.protects(url.host_str().unwrap_or_default()))
    .and_then(|url| tracking::without_tracking_params(&url));
  if let Some(clean) = clean {
    unsafe {
      args.SetCancel(true)?;
      core.Navigate(&HSTRING::from(clean.as_str()))?;
    }
    return Ok(());
  }
  start_page(core, page, app, &uri, redirected.as_bool(), report)
}

/// Нова адреса документа вкладки: від неї рахуються правила, лічильник з нуля (якщо це не переадресація)
/// і скрипт сторінки — для неї.
fn start_page(
  core: &ICoreWebView2,
  page: &Rc<RefCell<AdPage>>,
  app: &AppHandle,
  uri: &str,
  redirected: bool,
  report: &dyn Fn(Blocked),
) -> windows_core::Result<()> {
  {
    let mut page = page.borrow_mut();
    page.url = without_fragment(uri).unwrap_or_default();
    page.host = Url::parse(uri).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default();
    if !redirected {
      page.blocked = 0;
      page.trackers.clear();
    }
  }
  if !redirected {
    report(Blocked::Ads(0));
    report(Blocked::Trackers(Vec::new()));
  }
  replace_page_script(core, page, app.state::<AdBlock>().page_script(uri))
}

fn replace_page_script(core: &ICoreWebView2, page: &Rc<RefCell<AdPage>>, script: Option<String>) -> windows_core::Result<()> {
  let generation = {
    let mut page = page.borrow_mut();
    page.generation += 1;
    if let Some(id) = page.script.take() {
      unsafe { core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id))? };
    }
    page.generation
  };
  let Some(script) = script else {
    return Ok(());
  };
  let (page, owner) = (page.clone(), core.clone());
  let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
    if result.is_ok() {
      let mut page = page.borrow_mut();
      if page.generation == generation {
        page.script = Some(id);
      } else {
        unsafe { owner.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id))? };
      }
    }
    Ok(())
  }));
  unsafe { core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler) }
}

/// Завантаження, що триває: його COM-об'єкт, кому про нього повідомляти й з якої сторінки воно.
struct RunningDownload {
  operation: ICoreWebView2DownloadOperation,
  report: Rc<dyn Fn(DownloadUpdate)>,
  path: String,
  label: String,
  /// Скільки отриманих байтів WebView2 назвав на останній перевірці (check_download) і скільки перевірок поспіль
  /// це число не змінювалося.
  silent: (i64, u32),
  /// Файл, що чекав підтвердження, зберігається (keep_download).
  keeping: Option<Keeping>,
}

/// Файл, що чекав підтвердження: його друге ім'я, поки WebView2 прибирає перше.
struct Keeping {
  copy: PathBuf,
  since: Instant,
}

thread_local! {
  /// Завантаження, що тривають, — щоб їх можна було скасувати. COM-об'єкти живуть лише в головному потоці.
  static DOWNLOADS: RefCell<HashMap<u64, RunningDownload>> = RefCell::new(HashMap::new());
  /// Чи вже перевіряється раз на секунду, чи не скінчилися завантаження (check_downloads).
  static CHECKING_DOWNLOADS: Cell<bool> = const { Cell::new(false) };
}

static NEXT_DOWNLOAD: AtomicU64 = AtomicU64::new(1);

/// Про перебіг завантаження — не частіше, ніж раз на стільки.
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Як часто перевіряти, чи не скінчилися завантаження, про які WebView2 не повідомив.
const DOWNLOAD_CHECK_INTERVAL: Duration = Duration::from_secs(1);
/// Скільки перевірок поспіль WebView2 має мовчати про завантаження, щоб вірити розміру файла на диску.
const DOWNLOAD_SILENT_CHECKS: u32 = 2;
/// Скільки чекати, поки WebView2 видалить файл під першим ім'ям, перш ніж повернути файлу назву (restore_kept).
const KEEP_TIMEOUT: Duration = Duration::from_secs(10);

/// Завантаження, що чекає, поки користувач вибере, куди зберегти файл («Питати, куди зберегти»).
struct PendingDownload {
  args: ICoreWebView2DownloadStartingEventArgs,
  deferral: ICoreWebView2Deferral,
  report: Rc<dyn Fn(DownloadUpdate)>,
  label: String,
  app: AppHandle,
}

thread_local! {
  static PENDING_DOWNLOADS: RefCell<HashMap<u64, PendingDownload>> = RefCell::new(HashMap::new());
  /// Скільки завантажень іде з кожної сторінки (за міткою webview).
  static PAGE_DOWNLOADS: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
  /// Сторінки, які закрили під час завантаження: сховані, поки воно не скінчиться.
  static CLOSING_PAGES: RefCell<HashMap<String, Webview>> = RefCell::new(HashMap::new());
}

/// Закриває сторінку вкладки. Якщо з неї ще щось завантажується, лише ховає: WebView2 докачує файл і без
/// сторінки, але повідомляє про перебіг і кінець через неї — тож вона закриється сама, коли завантаження скінчаться.
/// Лише в головному потоці.
pub fn close_page(webview: Webview) -> tauri::Result<()> {
  let label = webview.label().to_string();
  if PAGE_DOWNLOADS.with(|downloads| downloads.borrow().get(&label).is_some_and(|count| *count > 0)) {
    webview.hide()?;
    CLOSING_PAGES.with(|pages| pages.borrow_mut().insert(label, webview));
    return Ok(());
  }
  webview.close()
}

fn download_finished(label: &str) {
  let remaining = PAGE_DOWNLOADS.with(|downloads| {
    let mut downloads = downloads.borrow_mut();
    let count = downloads.entry(label.to_string()).or_default();
    *count = count.saturating_sub(1);
    let remaining = *count;
    if remaining == 0 {
      downloads.remove(label);
    }
    remaining
  });
  if remaining == 0 {
    if let Some(webview) = CLOSING_PAGES.with(|pages| pages.borrow_mut().remove(label)) {
      // Не всередині події WebView2 цієї ж сторінки — закриття піде через цикл подій.
      tauri::async_runtime::spawn(async move {
        let _ = webview.close();
      });
    }
  }
}

/// Повідомляє `report(update)` про кожне завантаження сторінки: коли почалося, як іде (кілька разів на секунду)
/// і чим скінчилося. Куди зберегти файл і що власного вікна завантажень WebView2 не буде, вирішує Tauri (on_download);
/// а якщо `ask(request)` повертає true, завантаження чекає, поки resolve_download скаже, куди саме.
pub fn watch_downloads(
  webview: &Webview,
  ask: impl Fn(DownloadRequest) -> bool + Send + 'static,
  report: impl Fn(DownloadUpdate) + Send + 'static,
) -> tauri::Result<()> {
  let label = webview.label().to_string();
  let app = webview.app_handle().clone();
  webview.with_webview(move |platform| {
    let report: Rc<dyn Fn(DownloadUpdate)> = Rc::new(report);
    let watch = || -> windows_core::Result<()> {
      let core = core(&platform)?.cast::<ICoreWebView2_4>()?;
      let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| match args {
        Some(args) => on_download_starting(&args, &app, &label, &ask, &report),
        None => Ok(()),
      }));
      let mut token = 0;
      unsafe { core.add_DownloadStarting(&handler, &mut token) }
    };
    let _ = watch();
  })
}

fn on_download_starting(
  args: &ICoreWebView2DownloadStartingEventArgs,
  app: &AppHandle,
  label: &str,
  ask: &dyn Fn(DownloadRequest) -> bool,
  report: &Rc<dyn Fn(DownloadUpdate)>,
) -> windows_core::Result<()> {
  let mut cancel = BOOL::default();
  unsafe { args.Cancel(&mut cancel)? };
  if cancel.as_bool() {
    return Ok(());
  }
  let mut path = PWSTR::null();
  unsafe { args.ResultFilePath(&mut path)? };
  // Шлях, заданий явно (а Tauri задає його завжди), WebView2 не змінює, навіть коли такий файл уже є, — і перезаписав би
  // його. Тож коли файл уже є, інтерфейс питає, замінити його чи зберегти обидва (downloads::ask_where), а без запитання
  // повторне завантаження стає «назва (1).exe».
  let id = NEXT_DOWNLOAD.fetch_add(1, Ordering::Relaxed);
  let operation = unsafe { args.DownloadOperation()? };
  let wanted = original_path(&operation, PathBuf::from(take_pwstr(path)));
  let known = download_update(id, &operation, &wanted.to_string_lossy())?;
  if ask(DownloadRequest { id, url: known.url, path: wanted.clone(), total: known.total }) {
    let deferral = unsafe { args.GetDeferral()? };
    let pending =
      PendingDownload { args: args.clone(), deferral, report: report.clone(), label: label.to_string(), app: app.clone() };
    PENDING_DOWNLOADS.with(|downloads| downloads.borrow_mut().insert(id, pending));
    return Ok(());
  }
  let free = crate::downloads::unused_path(&wanted);
  unsafe { args.SetResultFilePath(&HSTRING::from(free.as_os_str()))? };
  begin_download(id, app, label, &operation, free.to_string_lossy().into_owned(), report)
}

/// Шлях, який файл мав би без перейменування. Коли такий файл уже є, Chromium сам дає вільну назву («звіт (1).pdf»), а
/// браузерові треба знати про збіг — щоб спитати, замінити наявний чи зберегти обидва. Тож «звіт (1).pdf», поряд з яким
/// лежить «звіт.pdf», — це «звіт.pdf», якщо тільки сайт сам не назвав файл «звіт (1).pdf».
fn original_path(operation: &ICoreWebView2DownloadOperation, path: PathBuf) -> PathBuf {
  let Some(original) =
    path.file_name().and_then(|name| name.to_str()).and_then(renamed_from).map(|name| path.with_file_name(name))
  else {
    return path;
  };
  let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
  let (mut uri, mut disposition) = (PWSTR::null(), PWSTR::null());
  let read = unsafe { operation.Uri(&mut uri).and_then(|()| operation.ContentDisposition(&mut disposition)) };
  let (uri, disposition) = (take_pwstr(uri), take_pwstr(disposition));
  // Не вдалося дізнатися — назва лишається, як дав Chromium.
  let named_by_site = read.is_err() || uri.replace("%20", " ").contains(&name) || disposition.contains(&name);
  if original.is_file() && !named_by_site {
    original
  } else {
    path
  }
}

/// Назва без номера, який Chromium додає вільній назві: «звіт (1).pdf» → «звіт.pdf»; без номера — None.
fn renamed_from(name: &str) -> Option<String> {
  let (stem, extension) = match name.rfind('.') {
    Some(dot) if dot > 0 => name.split_at(dot),
    _ => (name, ""),
  };
  let (base, number) = stem.strip_suffix(')')?.rsplit_once(" (")?;
  (!base.is_empty() && !number.is_empty() && number.chars().all(|char| char.is_ascii_digit()))
    .then(|| format!("{base}{extension}"))
}

/// Користувач вибрав, куди зберегти файл, чи передумав (None — завантаження скасовується).
/// Лише в головному потоці (PENDING_DOWNLOADS).
pub fn resolve_download(id: u64, path: Option<PathBuf>) {
  let Some(pending) = PENDING_DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&id)) else {
    return;
  };
  let resolve = || -> windows_core::Result<()> {
    match &path {
      Some(path) => {
        unsafe { pending.args.SetResultFilePath(&HSTRING::from(path.as_os_str()))? };
        let operation = unsafe { pending.args.DownloadOperation()? };
        begin_download(id, &pending.app, &pending.label, &operation, path.to_string_lossy().into_owned(), &pending.report)
      }
      None => unsafe { pending.args.SetCancel(true) },
    }
  };
  let _ = resolve();
  let _ = unsafe { pending.deferral.Complete() };
}

fn begin_download(
  id: u64,
  app: &AppHandle,
  label: &str,
  operation: &ICoreWebView2DownloadOperation,
  path: String,
  report: &Rc<dyn Fn(DownloadUpdate)>,
) -> windows_core::Result<()> {
  let running = RunningDownload {
    operation: operation.clone(),
    report: report.clone(),
    path: path.clone(),
    label: label.to_string(),
    silent: (0, 0),
    keeping: None,
  };
  DOWNLOADS.with(|downloads| downloads.borrow_mut().insert(id, running));
  PAGE_DOWNLOADS.with(|downloads| *downloads.borrow_mut().entry(label.to_string()).or_default() += 1);
  report(download_update(id, operation, &path)?);
  check_downloads(app);

  let last = Cell::new(Instant::now());
  let progress = report.clone();
  let mut token = 0;
  unsafe {
    operation.add_BytesReceivedChanged(
      &BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
        // Про те, що вже скінчилося чи зберігається (keep_download), інтерфейсу більше нічого казати.
        let watched = DOWNLOADS.with(|downloads| downloads.borrow().get(&id).is_some_and(|running| running.keeping.is_none()));
        if let Some(operation) = operation.filter(|_| watched) {
          let update = download_update(id, &operation, &path)?;
          // Скасоване завантаження WebView2 ще встигає повідомити про байти — кінець каже settle_download, один раз.
          if update.state != "in-progress" {
            settle_download(id);
            return Ok(());
          }
          // Останні байти — завжди: інакше перебіг міг би застигнути трохи раніше за 100 %.
          let complete = update.total > 0 && update.received >= update.total;
          if complete || last.get().elapsed() >= DOWNLOAD_PROGRESS_INTERVAL {
            last.set(Instant::now());
            progress(update);
          }
        }
        Ok(())
      })),
      &mut token,
    )?;
    operation.add_StateChanged(
      &StateChangedEventHandler::create(Box::new(move |_, _| {
        settle_download(id);
        Ok(())
      })),
      &mut token,
    )?;
  }
  Ok(())
}

/// Якщо завантаження скінчилося, повідомляє чим — один раз, хоч би хто спитав перший: подія StateChanged
/// чи перевірка check_downloads. Лише в головному потоці (DOWNLOADS).
fn settle_download(id: u64) {
  let Some((operation, path)) = DOWNLOADS.with(|downloads| {
    downloads
      .borrow()
      .get(&id)
      // Скасування збереженого файла — наше власне (keep_download): кінець скаже check_download.
      .filter(|running| running.keeping.is_none())
      .map(|running| (running.operation.clone(), running.path.clone()))
  }) else {
    return;
  };
  let Ok(update) = download_update(id, &operation, &path) else {
    return;
  };
  if update.state != "in-progress" {
    finish_download(update);
  }
}

/// Прибирає завантаження зі списку тих, що тривають, і повідомляє, чим воно скінчилося. Лише в головному потоці.
fn finish_download(update: DownloadUpdate) {
  let Some(running) = DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&update.id)) else {
    return;
  };
  (running.report)(update);
  download_finished(&running.label);
}

fn file_size(path: &Path) -> i64 {
  std::fs::metadata(path).map_or(0, |metadata| i64::try_from(metadata.len()).unwrap_or(i64::MAX))
}

/// Перевірка завантаження раз на секунду (check_downloads) — для того, про що WebView2 сам не скаже.
///
/// Коли сторінку, з якої йде завантаження, знищено (закрили вікно, перезавантажився інтерфейс), WebView2 докачує файл,
/// але про нього більше не повідомляє. Тож якщо WebView2 мовчить, а на диску вже більше, перебіг береться з розміру
/// файла, а весь файл — це кінець.
///
/// А файл, який Chromium вважає небезпечним (.exe із сайту, де користувач раніше не бував), WebView2 докачує, але не
/// завершує, доки його не підтвердять у власному вікні завантажень WebView2 — а воно в нас приховане. Такий файл
/// зберігається без підтвердження (keep_download).
/// Лише в головному потоці.
fn check_download(id: u64) {
  settle_download(id);
  let Some((operation, path, report, keeping)) = DOWNLOADS.with(|downloads| {
    downloads
      .borrow()
      .get(&id)
      .map(|running| (running.operation.clone(), running.path.clone(), running.report.clone(), running.keeping.is_some()))
  }) else {
    return;
  };
  if keeping {
    return restore_kept(id);
  }
  let Ok(update) = download_update(id, &operation, &path) else {
    return;
  };
  let silent = DOWNLOADS.with(|downloads| {
    let mut downloads = downloads.borrow_mut();
    let Some(running) = downloads.get_mut(&id) else {
      return 0;
    };
    running.silent = (update.received, if running.silent.0 == update.received { running.silent.1 + 1 } else { 0 });
    running.silent.1
  });
  // Поки WebView2 повідомляє про перебіг, вірити треба йому: отримане з мережі він знає раніше, ніж воно ляже на диск.
  if silent < DOWNLOAD_SILENT_CHECKS {
    return;
  }
  let on_disk = file_size(Path::new(&update.path));
  let full = update.total > 0 && on_disk >= update.total;
  if on_disk > update.received {
    if full {
      finish_download(DownloadUpdate { received: on_disk, state: "completed", ..update });
    } else {
      report(DownloadUpdate { received: on_disk, ..update });
    }
    return;
  }
  if full && update.received >= update.total {
    // Не вдалося — спробує наступна перевірка.
    let _ = keep_download(id, &operation, Path::new(&update.path));
  }
}

/// Зберігає файл, що чекає підтвердження. Підтвердити завантаження через API WebView2 не можна, тож файл (уже весь
/// на диску) дістає друге ім'я, завантаження скасовується — WebView2 видаляє файл під першим, — і restore_kept повертає
/// файлу його назву. Лише в головному потоці.
fn keep_download(id: u64, operation: &ICoreWebView2DownloadOperation, path: &Path) -> std::io::Result<()> {
  let mut name = path.file_name().unwrap_or_default().to_owned();
  name.push(".keep");
  let copy = crate::downloads::unused_path(&path.with_file_name(name));
  // Друге ім'я того самого файла (жорстке посилання) — миттєво й без копіювання; де таких немає (FAT) — перейменування.
  std::fs::hard_link(path, &copy).or_else(|_| std::fs::rename(path, &copy))?;
  DOWNLOADS.with(|downloads| {
    if let Some(running) = downloads.borrow_mut().get_mut(&id) {
      running.keeping = Some(Keeping { copy, since: Instant::now() });
    }
  });
  let _ = unsafe { operation.Cancel() };
  Ok(())
}

/// Збережений файл: щойно WebView2 видалив його під першим ім'ям, воно повертається. Лише в головному потоці.
fn restore_kept(id: u64) {
  let Some((operation, path, copy, since)) = DOWNLOADS.with(|downloads| {
    downloads.borrow().get(&id).and_then(|running| {
      let keeping = running.keeping.as_ref()?;
      Some((running.operation.clone(), running.path.clone(), keeping.copy.clone(), keeping.since))
    })
  }) else {
    return;
  };
  let Ok(update) = download_update(id, &operation, &path) else {
    return;
  };
  let path = PathBuf::from(&update.path);
  let gone = !path.exists();
  if !gone && since.elapsed() < KEEP_TIMEOUT {
    return;
  }
  let kept = if gone {
    std::fs::rename(&copy, &path).map_or(copy, |()| path)
  } else if update.state != "in-progress" {
    // Скасоване, а файл WebView2 так і не видалив — він той самий, друге ім'я зайве.
    let _ = std::fs::remove_file(&copy);
    path
  } else {
    // Скасувати не вдалося, і під першим ім'ям файл ще може зникнути — лишається другим.
    copy
  };
  mark_from_internet(&kept, &update.url);
  finish_download(DownloadUpdate {
    path: kept.to_string_lossy().into_owned(),
    received: file_size(&kept),
    state: "completed",
    ..update
  });
}

/// Позначка «з інтернету» (Zone.Identifier), яку WebView2 ставить завантаженим файлам, а неперевіреному ще не поставив:
/// за нею Windows перевіряє файл перед запуском.
fn mark_from_internet(path: &Path, url: &str) {
  let mut stream = path.as_os_str().to_owned();
  stream.push(":Zone.Identifier");
  if !Path::new(&stream).exists() {
    let _ = std::fs::write(&stream, format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={url}\r\n"));
  }
}

/// WebView2 інколи так і не надсилає StateChanged про кінець завантаження: файл уже весь на диску, а інтерфейс
/// показує, що він завантажується. Тож, поки щось завантажується, раз на секунду стан перевіряється й напряму
/// (check_download).
/// Лише в головному потоці.
fn check_downloads(app: &AppHandle) {
  if CHECKING_DOWNLOADS.with(|checking| checking.replace(true)) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || loop {
    std::thread::sleep(DOWNLOAD_CHECK_INTERVAL);
    let (sender, receiver) = std::sync::mpsc::channel();
    let checked = app.run_on_main_thread(move || {
      let ids: Vec<u64> = DOWNLOADS.with(|downloads| downloads.borrow().keys().copied().collect());
      for id in ids {
        check_download(id);
      }
      // Прапорець скидається в головному потоці — тож нове завантаження не розминеться з цією перевіркою.
      let more = DOWNLOADS.with(|downloads| !downloads.borrow().is_empty());
      CHECKING_DOWNLOADS.with(|checking| checking.set(more));
      let _ = sender.send(more);
    });
    if checked.is_err() || !receiver.recv().unwrap_or(false) {
      break;
    }
  });
}

/// Куди за замовчуванням зберігати файли сторінки (у WebView2 це властивість профілю).
pub fn set_download_folder(webview: &Webview, folder: PathBuf) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let _ =
      profile(&platform).and_then(|profile| unsafe { profile.SetDefaultDownloadFolderPath(&HSTRING::from(folder.as_os_str())) });
  })
}

fn download_update(
  id: u64,
  operation: &ICoreWebView2DownloadOperation,
  fallback_path: &str,
) -> windows_core::Result<DownloadUpdate> {
  let (mut uri, mut path, mut received, mut total) = (PWSTR::null(), PWSTR::null(), 0i64, 0i64);
  let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
  unsafe {
    operation.Uri(&mut uri)?;
    operation.ResultFilePath(&mut path)?;
    operation.BytesReceived(&mut received)?;
    operation.TotalBytesToReceive(&mut total)?;
    operation.State(&mut state)?;
  }
  let state = match state {
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS => "in-progress",
    COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED => "completed",
    _ => {
      let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
      unsafe { operation.InterruptReason(&mut reason)? };
      if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
        "canceled"
      } else {
        "failed"
      }
    }
  };
  let path = take_pwstr(path);
  Ok(DownloadUpdate {
    id,
    url: take_pwstr(uri),
    path: if path.is_empty() { fallback_path.to_string() } else { path },
    received,
    // Невідомий розмір WebView2 повертає як -1.
    total: total.max(0),
    state,
  })
}

/// Скасовує завантаження, що ще триває. Лише в головному потоці (DOWNLOADS).
pub fn cancel_download(id: u64) {
  DOWNLOADS.with(|downloads| {
    // Об'єкт — поза позикою: Cancel може одразу викликати StateChanged, а той прибирає завантаження зі списку.
    let operation =
      downloads.borrow().get(&id).filter(|running| running.keeping.is_none()).map(|running| running.operation.clone());
    if let Some(operation) = operation {
      let _ = unsafe { operation.Cancel() };
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn finds_the_name_chromium_numbered() {
    assert_eq!(renamed_from("звіт (1).pdf").as_deref(), Some("звіт.pdf"));
    assert_eq!(renamed_from("архів.tar (12).gz").as_deref(), Some("архів.tar.gz"));
    assert_eq!(renamed_from("README (3)").as_deref(), Some("README"));
    assert_eq!(renamed_from("звіт.pdf"), None);
    assert_eq!(renamed_from("звіт (чернетка).pdf"), None);
    assert_eq!(renamed_from(" (1).pdf"), None);
    assert_eq!(renamed_from("звіт ().pdf"), None);
  }
}
