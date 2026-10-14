//! Події сторінки сайту у WebKitGTK (Linux) — ті самі, що webview2.rs і page_events.rs дають у Windows, з тими самими
//! сигнатурами: pages.rs під'єднує їх однаково на обох системах (`engine::…`, `events::…`). Дозволи сайтів і
//! завантаження — в окремих gtk_permissions.rs і gtk_downloads.rs, а звідси лише видні під тими самими назвами.
//!
//! Обробники — сигнали GTK/WebKit, тож живуть у головному потоці (with_webview).

use std::rc::Rc;

use gtk::{
  gdk, gio,
  glib::{self, object::ObjectExt},
};
use javascriptcore::ValueExt;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::{Manager, Url, Webview};
use webkit2gtk::{
  ContextMenuAction, ContextMenuExt, ContextMenuItem, ContextMenuItemExt, HardwareAccelerationPolicy, HitTestResultExt, SettingsExt,
  SnapshotOptions, SnapshotRegion, URIRequestExt, UserContentInjectedFrames, UserContentManagerExt, UserScript,
  UserScriptInjectionTime, WebContextExt, WebInspectorExt, WebProcessTerminationReason, WebViewExt, WebsiteDataManagerExt,
  WebsiteDataManagerExtManual, WebsiteDataTypes,
};

pub use crate::gtk_downloads::watch_downloads;
pub use crate::gtk_permissions::{answer_permission, set_site_permission, site_permissions, watch_permissions};
use crate::{
  context_menu::{custom_items, ContextAction, MenuTarget},
  page_types::{ClearKinds, Failure, ReloadMode},
};

/// Повідомляє `report(url, can_go_back, can_go_forward)` на кожну зміну адреси чи історії вкладки — зокрема коли сайт
/// змінює адресу без перезавантаження (history.pushState, як YouTube).
pub fn watch_navigation(webview: &Webview, report: impl Fn(String, bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let notify = move |view: &webkit2gtk::WebView| {
      let url = view.uri().map(|uri| uri.to_string()).unwrap_or_default();
      report(url, view.can_go_back(), view.can_go_forward());
    };
    if let Some(history) = view.back_forward_list() {
      // Слабке посилання: історія живе в самому webview, сильне не дало б закритій вкладці звільнитися.
      let (view, notify) = (view.downgrade(), notify.clone());
      // Сигнал changed обгортка webkit2gtk не описує — під'єднуємо за назвою.
      history.connect_local("changed", false, move |_| {
        if let Some(view) = view.upgrade() {
          notify(&view);
        }
        None
      });
    }
    view.connect_uri_notify(notify);
  })
}

/// Сайт відкриває нове вікно (посилання з target="_blank", window.open): власного вікна WebKit не буде —
/// `report(адреса, після дії користувача)`, а інтерфейс відкриє вкладку чи заблокує спливне вікно.
pub fn watch_new_windows(webview: &Webview, report: impl Fn(String, bool) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    view.connect_create(move |_, action| {
      if let Some(url) = action.request().and_then(|request| request.uri()) {
        report(url.to_string(), action.is_user_gesture());
      }
      None
    });
  })
}

// --- Скрипти браузера на сторінці ---

/// Світ скриптів браузера на сторінці (паролі, адреси, масштаб, переклад): DOM у нього спільний із сайтом, а змінні й
/// прототипи — свої, тож сайт не може ні підмінити скрипти, ні слати від їхнього імені, ні читати відповіді.
const WORLD: &str = "astra";
/// Канал повідомлень цих скриптів (window.webkit.messageHandlers.astra у їхньому світі).
const HANDLER: &str = "astra";

/// Скрипти браузера на початку кожного документа сторінки — у світі WORLD, за мостом chrome.webview
/// (webkit-bridge.js), тож вони ті самі, що й у Windows. Ще один — лише свій: виділене для контекстного меню
/// (webkit-context.js).
pub fn add_page_scripts(webview: &Webview, scripts: Vec<String>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let Some(manager) = view.user_content_manager() else {
      return;
    };
    let own = [include_str!("webkit-bridge.js"), include_str!("webkit-context.js")].map(str::to_string);
    for source in own.into_iter().chain(scripts) {
      let script = UserScript::for_world(&source, UserContentInjectedFrames::TopFrame, UserScriptInjectionTime::Start, WORLD, &[], &[]);
      manager.add_script(&script);
    }
  })
}

/// Повідомлення скриптів сторінки — JSON-об'єкт рядком, як у Windows (webview2::watch_page_messages):
/// `on_message(адреса документа, повідомлення)`, а що поверне — відповідь тій самій сторінці.
pub fn watch_page_messages(
  webview: &Webview,
  on_message: impl Fn(&str, &serde_json::Value) -> Option<serde_json::Value> + Send + 'static,
) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let Some(manager) = view.user_content_manager() else {
      return;
    };
    manager.register_script_message_handler_in_world(HANDLER, WORLD);
    let page = view.downgrade();
    manager.connect_script_message_received(Some(HANDLER), move |_, result| {
      let (Some(view), Some(value)) = (page.upgrade(), result.js_value()) else {
        return;
      };
      let Ok(message) = serde_json::from_str::<serde_json::Value>(&value.to_str()) else {
        return;
      };
      if !message.is_object() {
        return;
      }
      // Виділене перед контекстним меню (webkit-context.js) — для пунктів меню, а не скриптам браузера.
      if message.get("astra").and_then(serde_json::Value::as_str) == Some("context") {
        let selection = message.get("selection").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        unsafe { view.set_data(SELECTION_DATA, selection) };
        return;
      }
      let source = view.uri().map(|uri| uri.to_string()).unwrap_or_default();
      if let Some(reply) = on_message(&source, &message) {
        post(&view, &reply);
      }
    });
  })
}

/// Повідомлення скриптам сторінки будь-коли, а не лише відповіддю (переклад приходить згодом).
pub fn post_page_message(webview: &Webview, message: &serde_json::Value) -> tauri::Result<()> {
  let message = message.clone();
  webview.with_webview(move |platform| post(&platform.inner(), &message))
}

fn post(view: &webkit2gtk::WebView, message: &serde_json::Value) {
  let script = format!("window.astraHostMessage && window.astraHostMessage({message});");
  view.evaluate_javascript(&script, Some(WORLD), None, None::<&gtk::gio::Cancellable>, |_| {});
}

/// Відповідь, яку команда чекає з головного потоку.
pub type Reply<T> = std::sync::mpsc::Sender<Result<T, String>>;

// --- Звук ---

/// Звук сторінки — `report(грає, вимкнено)` на кожну зміну: значок у вкладці й кнопка, що його вимикає.
pub fn watch_audio(webview: &Webview, report: impl Fn(bool, bool) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let notify = move |view: &webkit2gtk::WebView| report(view.is_playing_audio(), view.is_muted());
    view.connect_is_playing_audio_notify(notify.clone());
    view.connect_is_muted_notify(notify);
  })
}

/// Вимикає чи вмикає весь звук сторінки — і відео, і Web Audio.
pub fn set_muted(webview: &Webview, muted: bool, reply: Reply<()>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    platform.inner().set_is_muted(muted);
    let _ = reply.send(Ok(()));
  })
}

// --- Знімок сторінки ---

/// Знімок сторінки в PNG: видима частина чи вся сторінка з прокруткою (`full`).
pub fn screenshot(webview: &Webview, full: bool, reply: Reply<Vec<u8>>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let region = if full { SnapshotRegion::FullDocument } else { SnapshotRegion::Visible };
    view.snapshot(region, SnapshotOptions::NONE, None::<&gio::Cancellable>, move |result| {
      let png = result.map_err(|error| error.to_string()).and_then(|surface| to_png(&surface));
      let _ = reply.send(png);
    });
  })
}

/// Найбільша висота знімка, px — як у Windows (webview2.rs): довші сторінки обрізаються.
const SCREENSHOT_MAX_HEIGHT: usize = 16384;

/// Знімок cairo (ARGB32 із домноженою прозорістю, байти BGRA) — у PNG (RGBA). Рядок за рядком: другої копії всієї
/// картинки немає, а знімок довгої сторінки — сотні мегабайтів.
fn to_png(surface: &gtk::cairo::Surface) -> Result<Vec<u8>, String> {
  let image = gtk::cairo::ImageSurface::try_from(surface.clone()).map_err(|_| "Not an image surface".to_string())?;
  let (width, stride) = (image.width() as usize, image.stride() as usize);
  let height = (image.height() as usize).min(SCREENSHOT_MAX_HEIGHT);
  let mut png = Vec::new();
  let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
  encoder.set_color(png::ColorType::Rgba);
  encoder.set_depth(png::BitDepth::Eight);
  let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
  let mut stream = writer.stream_writer().map_err(|error| error.to_string())?;
  let mut rgba = vec![[0u8; 4]; width];
  let mut written = Ok(());
  image
    .with_data(|data| {
      for row in data.chunks(stride).take(height) {
        for (pixel, &[blue, green, red, alpha]) in rgba.iter_mut().zip(row[..width * 4].as_chunks::<4>().0) {
          let straight = |value: u8| if alpha == 0 { 0 } else { (u16::from(value) * 255 / u16::from(alpha)) as u8 };
          *pixel = [straight(red), straight(green), straight(blue), alpha];
        }
        written = std::io::Write::write_all(&mut stream, rgba.as_flattened());
        if written.is_err() {
          break;
        }
      }
    })
    .map_err(|error| error.to_string())?;
  written.map_err(|error| error.to_string())?;
  stream.finish().map_err(|error| error.to_string())?;
  writer.finish().map_err(|error| error.to_string())?;
  Ok(png)
}

// --- Значок сторінки ---

/// Найбільший бік значка, px: у вкладці він 16 px, тож 32 — і для екранів з подвоєною щільністю.
const FAVICON_SIZE: i32 = 32;

/// Значок, який для сторінки обрав сам WebKit (з її розмітки), — `report(адреса сторінки, значок data:image/png)`.
/// Значки WebKit знає, лише коли ввімкнено їхню базу: вона в теці облікового запису, а в приватному вікні її немає.
pub fn watch_favicon(webview: &Webview, report: impl Fn(String, String) + Send + 'static) -> tauri::Result<()> {
  let app = webview.app_handle().clone();
  let dir = crate::profiles::site_data_dir(&app).or_else(|| app.path().app_local_data_dir().ok()).map(|dir| dir.join("favicons"));
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    if let (Some(context), Some(dir)) = (view.context().filter(|context| !context.is_ephemeral()), dir) {
      // Вмикається раз на контекст; далі виклики нічого не змінюють.
      if context.favicon_database_directory().is_none() {
        context.set_favicon_database_directory(Some(&dir.to_string_lossy()));
      }
    }
    view.connect_favicon_notify(move |view| {
      let (Some(uri), Some(icon)) = (view.uri(), view.favicon()) else {
        return;
      };
      if let Ok(png) = small(&icon).and_then(|icon| to_png(&icon)) {
        report(uri.to_string(), format!("data:image/png;base64,{}", BASE64.encode(png)));
      }
    });
  })
}

/// Значок не більший за FAVICON_SIZE (сайти дають і по 256 px).
fn small(icon: &gtk::cairo::Surface) -> Result<gtk::cairo::Surface, String> {
  let image = gtk::cairo::ImageSurface::try_from(icon.clone()).map_err(|_| "Not an image surface".to_string())?;
  let (width, height) = (image.width(), image.height());
  if width <= FAVICON_SIZE && height <= FAVICON_SIZE {
    return Ok(icon.clone());
  }
  let scale = f64::from(FAVICON_SIZE) / f64::from(width.max(height));
  let (to_width, to_height) = (((f64::from(width) * scale).round() as i32).max(1), ((f64::from(height) * scale).round() as i32).max(1));
  let target = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, to_width, to_height).map_err(|error| error.to_string())?;
  let cairo = gtk::cairo::Context::new(&target).map_err(|error| error.to_string())?;
  cairo.scale(scale, scale);
  cairo.set_source_surface(icon, 0.0, 0.0).map_err(|error| error.to_string())?;
  cairo.paint().map_err(|error| error.to_string())?;
  drop(cairo);
  Ok((*target).clone())
}

// --- Особливе оновлення ---

/// Особливе оновлення з меню кнопки «Оновити» — як webview2::reload_with: без кешу, а перед тим ще й стерти Cache
/// Storage, сховища чи cookies сайту `origin` (дані WebKit зберігає за доменом сайту, тож і стирає за ним).
pub fn reload_with(webview: &Webview, mode: ReloadMode, _url: String, origin: String, reply: Reply<()>) -> tauri::Result<()> {
  // Сховища сайту — без cookies (вийти з облікового запису на ньому — окремий вибір).
  let storage = WebsiteDataTypes::DOM_CACHE
    | WebsiteDataTypes::LOCAL_STORAGE
    | WebsiteDataTypes::SESSION_STORAGE
    | WebsiteDataTypes::INDEXEDDB_DATABASES
    | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
    | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
    | WebsiteDataTypes::WEBSQL_DATABASES;
  // Що стерти й чи оновлювати без кешу: після cookies — звичайне оновлення, як у Windows.
  let (types, bypass) = match mode {
    ReloadMode::Hard => (WebsiteDataTypes::empty(), true),
    ReloadMode::Cache => (WebsiteDataTypes::DOM_CACHE, true),
    ReloadMode::SiteData => (storage, true),
    ReloadMode::Cookies => (WebsiteDataTypes::COOKIES, false),
    ReloadMode::All => (storage | WebsiteDataTypes::COOKIES, true),
  };
  let host = Url::parse(&origin).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let manager = view.website_data_manager().filter(|_| !types.is_empty() && !host.is_empty());
    let Some(manager) = manager else {
      reload(&view, bypass);
      let _ = reply.send(Ok(()));
      return;
    };
    manager.clone().fetch(types, None::<&gio::Cancellable>, move |records| {
      let records = match records {
        Ok(records) => records,
        Err(error) => {
          let _ = reply.send(Err(error.to_string()));
          return;
        }
      };
      let site: Vec<_> = records
        .into_iter()
        .filter(|record| record.name().is_some_and(|name| host == name.as_str() || host.ends_with(&format!(".{name}"))))
        .collect();
      if site.is_empty() {
        reload(&view, bypass);
        let _ = reply.send(Ok(()));
        return;
      }
      // Відповідь WebKit приходить у головний потік — там же й сторінка.
      let view = glib::thread_guard::ThreadGuard::new(view);
      let site: Vec<_> = site.iter().collect();
      manager.remove(types, &site, None::<&gio::Cancellable>, move |removed| {
        reload(view.get_ref(), bypass);
        let _ = reply.send(removed.map_err(|error| error.to_string()));
      });
    });
  })
}

/// Очищає дані профілю сторінки `webview`, змінені від `since` (секунди Unix; 0 — за весь час), — як
/// webview2::clear_browsing_data. Якщо профіль спільний з інтерфейсом браузера (`shared_with_ui`, обліковий
/// запис-власник), localStorage цілком не чиститься — у ньому дані самого браузера, — а лише сайтів `origins`.
/// Історію й завантаження чистить інтерфейс, а дозволи сайтів — gtk_permissions.rs.
pub fn clear_browsing_data(
  webview: &Webview,
  kinds: ClearKinds,
  shared_with_ui: bool,
  since: f64,
  origins: Vec<String>,
  reply: Reply<()>,
) -> tauri::Result<()> {
  let mut types = WebsiteDataTypes::empty();
  if kinds.site_data {
    types |= WebsiteDataTypes::COOKIES
      | WebsiteDataTypes::INDEXEDDB_DATABASES
      | WebsiteDataTypes::WEBSQL_DATABASES
      | WebsiteDataTypes::DOM_CACHE
      | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
      | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
      | WebsiteDataTypes::SESSION_STORAGE
      | WebsiteDataTypes::HSTS_CACHE;
    if !shared_with_ui {
      types |= WebsiteDataTypes::LOCAL_STORAGE;
    }
  }
  if kinds.cache {
    types |= WebsiteDataTypes::MEMORY_CACHE | WebsiteDataTypes::DISK_CACHE;
  }
  // Сайти, чий localStorage стерти окремо (у спільному з інтерфейсом профілі).
  let hosts: Vec<String> = if kinds.site_data && shared_with_ui {
    origins.iter().filter_map(|origin| Url::parse(origin).ok()?.host_str().map(str::to_string)).collect()
  } else {
    Vec::new()
  };
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |time| time.as_secs_f64());
  // Змінене за останні стільки мікросекунд; 0 — за весь час.
  let timespan = if since > 0.0 { glib::TimeSpan(((now - since).max(0.0) * 1_000_000.0) as i64) } else { glib::TimeSpan(0) };
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let Some(manager) = view.website_data_manager() else {
      let _ = reply.send(Err("No website data manager".into()));
      return;
    };
    let clear_storage = {
      let manager = glib::thread_guard::ThreadGuard::new(manager.clone());
      move |reply: Reply<()>| {
        if hosts.is_empty() {
          let _ = reply.send(Ok(()));
          return;
        }
        let manager = manager.get_ref().clone();
        manager.clone().fetch(WebsiteDataTypes::LOCAL_STORAGE, None::<&gio::Cancellable>, move |records| {
          let records: Vec<_> = records
            .unwrap_or_default()
            .into_iter()
            .filter(|record| record.name().is_some_and(|name| hosts.iter().any(|host| host == name.as_str() || host.ends_with(&format!(".{name}")))))
            .collect();
          let records: Vec<_> = records.iter().collect();
          manager.remove(WebsiteDataTypes::LOCAL_STORAGE, &records, None::<&gio::Cancellable>, move |removed| {
            let _ = reply.send(removed.map_err(|error| error.to_string()));
          });
        });
      }
    };
    if types.is_empty() {
      clear_storage(reply);
      return;
    }
    // Відповідь WebKit приходить у головний потік — там і решта.
    let clear_storage = glib::thread_guard::ThreadGuard::new(clear_storage);
    manager.clear(types, timespan, None::<&gio::Cancellable>, move |cleared| match cleared {
      Ok(()) => (clear_storage.into_inner())(reply),
      Err(error) => {
        let _ = reply.send(Err(error.to_string()));
      }
    });
  })
}

fn reload(view: &webkit2gtk::WebView, bypass_cache: bool) {
  if bypass_cache {
    view.reload_bypass_cache();
  } else {
    view.reload();
  }
}

// --- Сплячі вкладки ---

/// «Присипляє» приховану сторінку. Своєї сплячки, як у WebView2, WebKitGTK не має, але приховану сторінку
/// пригальмовує сам (таймери, малювання). Тож прихована й беззвучна вважається сплячою — `reply(true)`, — а давно
/// сплячу інтерфейс згодом вивантажує зовсім, і тоді звільняється й пам'ять.
pub fn suspend(webview: &Webview, reply: Reply<bool>) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let hidden = !gtk::prelude::WidgetExt::is_visible(&view);
    let _ = reply.send(Ok(hidden && !view.is_playing_audio()));
  })
}

// --- Збій сторінки ---

/// Збій процесу сторінки — `report(Failure)`: процес завершився (аварія, нестача пам'яті) чи сторінка не відповідає.
pub fn watch_process_failed(webview: &Webview, report: impl Fn(Failure) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let report = Rc::new(report);
    view.connect_web_process_terminated({
      let report = report.clone();
      move |_, reason| {
        // Процес, завершений самим браузером (terminate_web_process), — не збій.
        if reason != WebProcessTerminationReason::TerminatedByApi {
          report(Failure::Exited);
        }
      }
    });
    view.connect_is_web_process_responsive_notify(move |view| {
      if !view.is_web_process_responsive() {
        report(Failure::Unresponsive);
      }
    });
  })
}

// --- Гарячі клавіші ---

/// Гарячі клавіші браузера, натиснуті, поки фокус у сайті: самі клавіші отримує webview сайту, тож вони
/// перехоплюються тут (сайт їх не бачить). Ті самі, що у Windows, — інтерфейсу (`report(shortcut)`): Ctrl+Tab
/// (`next-tab`), Ctrl+Shift+Tab (`previous-tab`), Ctrl+Shift+T (`reopen-tab`) і масштаб: Ctrl+= чи Ctrl++ (`zoom-in`),
/// Ctrl+− (`zoom-out`), Ctrl+0 (`zoom-reset`), Ctrl+Shift+S (`screenshot`). Коду сторінки (Ctrl+U) WebKitGTK не показує.
/// А те, що WebView2 робить сам, а WebKitGTK — ні, — тут: F5 і Ctrl+R (оновити), Ctrl+F5 і Ctrl+Shift+R (оновити без
/// кешу), Alt+← і Alt+→ (назад і вперед), F12 і Ctrl+Shift+I (інструменти розробника).
pub fn watch_shortcuts(webview: &Webview, report: impl Fn(&'static str) + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    // Через трейт явно: у WidgetExt є свої методи з тими самими назвами, що й у WebViewExt (settings).
    gtk::prelude::WidgetExt::connect_key_press_event(&view, move |view, event| {
      let Some(shortcut) = shortcut(event) else {
        return glib::Propagation::Proceed;
      };
      match shortcut {
        Shortcut::Interface(name) => report(name),
        Shortcut::Reload => view.reload(),
        Shortcut::ReloadBypassCache => view.reload_bypass_cache(),
        Shortcut::Back => view.go_back(),
        Shortcut::Forward => view.go_forward(),
        Shortcut::DevTools => {
          if let Some(inspector) = view.inspector() {
            inspector.show();
          }
        }
      }
      glib::Propagation::Stop
    });
  })
}

/// Що робить гаряча клавіша: її обробляє інтерфейс (назва — як у Windows) чи сам webview.
#[derive(Debug, PartialEq)]
enum Shortcut {
  Interface(&'static str),
  Reload,
  ReloadBypassCache,
  Back,
  Forward,
  DevTools,
}

fn shortcut(event: &gdk::EventKey) -> Option<Shortcut> {
  use gdk::keys::constants as key;
  let state = event.state();
  let (control, shift, alt) = (
    state.contains(gdk::ModifierType::CONTROL_MASK),
    state.contains(gdk::ModifierType::SHIFT_MASK),
    state.contains(gdk::ModifierType::MOD1_MASK),
  );
  let pressed = latin_key(event);
  let is = |keys: &[gdk::keys::Key]| keys.contains(&pressed);
  if alt {
    return match (control, shift) {
      (false, false) if is(&[key::Left, key::KP_Left]) => Some(Shortcut::Back),
      (false, false) if is(&[key::Right, key::KP_Right]) => Some(Shortcut::Forward),
      _ => None,
    };
  }
  if !control {
    return match () {
      _ if is(&[key::F5]) => Some(Shortcut::Reload),
      _ if is(&[key::F12]) => Some(Shortcut::DevTools),
      _ => None,
    };
  }
  match () {
    // Shift+Tab GTK дає як ISO_Left_Tab.
    _ if is(&[key::Tab, key::KP_Tab, key::ISO_Left_Tab]) => Some(Shortcut::Interface(if shift { "previous-tab" } else { "next-tab" })),
    _ if shift && is(&[key::t]) => Some(Shortcut::Interface("reopen-tab")),
    _ if shift && is(&[key::s]) => Some(Shortcut::Interface("screenshot")),
    _ if is(&[key::equal, key::plus, key::KP_Add]) => Some(Shortcut::Interface("zoom-in")),
    _ if is(&[key::minus, key::underscore, key::KP_Subtract]) => Some(Shortcut::Interface("zoom-out")),
    _ if !shift && is(&[key::_0, key::KP_0]) => Some(Shortcut::Interface("zoom-reset")),
    _ if is(&[key::F5]) || (shift && is(&[key::r])) => Some(Shortcut::ReloadBypassCache),
    _ if is(&[key::r]) => Some(Shortcut::Reload),
    _ if shift && is(&[key::i]) => Some(Shortcut::DevTools),
    _ => None,
  }
}

/// Клавіша без урахування розкладки: та, що на цьому місці в першій (зазвичай латинській) розкладці, і маленька
/// літера — щоб Ctrl+Shift+T працював і з українською розкладкою.
fn latin_key(event: &gdk::EventKey) -> gdk::keys::Key {
  let translated = gdk::Display::default().and_then(|display| gdk::Keymap::for_display(&display)).and_then(|keymap| {
    keymap.translate_keyboard_state(u32::from(event.hardware_keycode()), event.state(), 0).map(|(key, ..)| gdk::keys::Key::from(key))
  });
  translated.unwrap_or_else(|| event.keyval()).to_lower()
}

// --- Контекстне меню ---

/// Пункти WebKit, яких у браузері не треба: «відкрити в новому вікні» — у нас свої пункти з новими вкладками й вікнами.
const REMOVED_ITEMS: &[ContextMenuAction] = &[
  ContextMenuAction::OpenLinkInNewWindow,
  ContextMenuAction::OpenImageInNewWindow,
  ContextMenuAction::OpenFrameInNewWindow,
  ContextMenuAction::OpenVideoInNewWindow,
  ContextMenuAction::OpenAudioInNewWindow,
];

/// Дані GObject на webview: виділене на сторінці перед її контекстним меню (webkit-context.js).
const SELECTION_DATA: &str = "astra-selection";

/// Контекстне меню сайту — стандартне меню WebKit зі своїми пунктами браузера (context_menu.rs); вибраний пункт —
/// `report`.
pub fn customize_context_menu(webview: &Webview, report: impl Fn(ContextAction) + Clone + Send + 'static) -> tauri::Result<()> {
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    view.connect_context_menu(move |view, menu, _, hit| {
      // Виділене WebKit не називає — його щойно перед меню надіслав скрипт сторінки (у фреймах його немає, тож і
      // пунктів для виділеного там не буде).
      let selection = unsafe { view.steal_data::<String>(SELECTION_DATA) };
      let web = |url: Option<glib::GString>| url.map(String::from).filter(|url| url.starts_with("http://") || url.starts_with("https://"));
      let target = MenuTarget {
        page: web(view.uri()),
        link: if hit.context_is_link() { web(hit.link_uri()) } else { None },
        image: if hit.context_is_image() { web(hit.image_uri()) } else { None },
        selection: selection.filter(|text| (hit.context_is_selection() || hit.context_is_editable()) && !text.trim().is_empty()),
        editable: hit.context_is_editable(),
      };
      for item in menu.items() {
        if REMOVED_ITEMS.contains(&item.stock_action()) {
          menu.remove(&item);
        }
      }
      let (top, bottom) = custom_items(&target);
      for (position, (action, label, value)) in (0..).zip(top) {
        menu.insert(&menu_item(action, &label, value, report.clone()), position);
      }
      for (action, label, value) in bottom {
        menu.append(&menu_item(action, &label, value, report.clone()));
      }
      false
    });
  })
}

fn menu_item(action: &'static str, label: &str, value: Option<String>, report: impl Fn(ContextAction) + 'static) -> ContextMenuItem {
  if action.is_empty() {
    return ContextMenuItem::new_separator();
  }
  let command = gio::SimpleAction::new(action, None);
  let is_text = matches!(action, "search" | "translate-text");
  command.connect_activate(move |_, _| {
    let (url, text) = if is_text { (None, value.clone()) } else { (value.clone(), None) };
    report(ContextAction { action, url, text });
  });
  ContextMenuItem::from_gaction(&command, label, None)
}

// --- Без апаратного прискорення ---

/// Сторінка без переходів View Transitions, якщо WebKit малює її без апаратного прискорення (WEBKIT_DISABLE_DMABUF_RENDERER,
/// WEBKIT_DISABLE_COMPOSITING_MODE, немає потрібного EGL — тоді й налаштування сторінки кажуть «ніколи»). Перехід
/// (document.startViewTransition, як на YouTube, чи між документами за CSS) вмикає компонування сторінки й тоді, а
/// вікну нема куди його показати: WebKitGTK 2.52 звертається до сховища кадрів, якого немає
/// (AcceleratedBackingStore::update), — і падає весь браузер. Без переходів сайти просто міняють вміст одразу.
pub fn avoid_view_transitions_crash(webview: &Webview) -> tauri::Result<()> {
  webview.with_webview(|platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let Some(settings) = WebViewExt::settings(&view) else {
      return;
    };
    if settings.hardware_acceleration_policy() == HardwareAccelerationPolicy::Never {
      static LOGGED: std::sync::Once = std::sync::Once::new();
      LOGGED.call_once(|| log::info!("WebKit без апаратного прискорення: переходи View Transitions вимкнено"));
      features::disable(&settings, &[c"ViewTransitions", c"CrossDocumentViewTransitions"]);
    }
  })
}

/// Функції WebKit (WebKitFeature, з 2.42): обгортка webkit2gtk їх не описує, а старіший WebKit їх не має зовсім — тож
/// вони шукаються під час роботи, і без них браузер так само запускається.
mod features {
  use std::ffi::{c_char, c_void, CStr};

  use gtk::glib::{ffi::gboolean, translate::ToGlibPtr};
  use webkit2gtk_sys::WebKitSettings;

  type AllFeatures = unsafe extern "C" fn() -> *mut c_void;
  type Length = unsafe extern "C" fn(*mut c_void) -> usize;
  type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
  type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
  type SetEnabled = unsafe extern "C" fn(*mut WebKitSettings, *mut c_void, gboolean);
  type Unref = unsafe extern "C" fn(*mut c_void);

  /// Вимикає в `settings` функції WebKit з цими назвами (WebKitFeature:identifier).
  pub fn disable(settings: &webkit2gtk::Settings, identifiers: &[&CStr]) {
    let (Some(all), Some(length), Some(get), Some(identifier), Some(set_enabled), Some(unref)) = (
      symbol::<AllFeatures>(c"webkit_settings_get_all_features"),
      symbol::<Length>(c"webkit_feature_list_get_length"),
      symbol::<Get>(c"webkit_feature_list_get"),
      symbol::<Identifier>(c"webkit_feature_get_identifier"),
      symbol::<SetEnabled>(c"webkit_settings_set_feature_enabled"),
      symbol::<Unref>(c"webkit_feature_list_unref"),
    ) else {
      return;
    };
    unsafe {
      let list = all();
      for index in 0..length(list) {
        let feature = get(list, index);
        let name = identifier(feature);
        if !name.is_null() && identifiers.contains(&CStr::from_ptr(name)) {
          set_enabled(settings.to_glib_none().0, feature, 0);
        }
      }
      unref(list);
    }
  }

  /// Функція `name` бібліотек, уже завантажених у процес; `T` — її тип (вказівник на функцію).
  fn symbol<T>(name: &CStr) -> Option<T> {
    let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!pointer.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, T>(&pointer) })
  }
}
