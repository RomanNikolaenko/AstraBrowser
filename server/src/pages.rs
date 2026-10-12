//! Сторінки сайтів: кожна вкладка із сайтом — окремий нативний webview поверх області вмісту вікна.
//!
//! Інтерфейс (Angular) керує ними командами `page_*`, а про навігацію, заголовок, нові вкладки
//! й завантаження дізнається з подій `page://…`, які надсилаються лише webview інтерфейсу цього вікна.
//! Віддалені сторінки не мають доступу до команд: у Tauri 2 IPC для них закритий без явного дозволу.

use std::{path::Path, sync::mpsc, time::Duration};

use serde::{Deserialize, Serialize};

use crate::audio;
#[cfg(windows)]
use crate::webview2::{self, Autoplay};
use tauri::{
  webview::{PageLoadEvent, PageLoadPayload},
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl, Window,
};

/// Мітки webview сайтів; webview інтерфейсу називаються як їхні вікна (main, window-…, private-…, guest-…).
pub(crate) const PAGE_PREFIX: &str = "page-";
/// Мітки гостьових вікон: сайти в них без збережених даних, а паролів власника гість не бачить.
pub const GUEST_PREFIX: &str = "guest-";

/// Положення й розмір області вмісту в логічних пікселях вікна.
#[derive(Deserialize, specta::Type)]
pub struct Bounds {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

#[derive(Clone, Serialize, specta::Type)]
struct LoadEvent {
  label: String,
  url: String,
  loading: bool,
}

#[derive(Clone, Serialize, specta::Type)]
struct TitleEvent {
  label: String,
  title: String,
}

#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct NavigationEvent {
  label: String,
  url: String,
  can_go_back: bool,
  can_go_forward: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct FullscreenEvent {
  label: String,
  fullscreen: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct AudioEvent {
  label: String,
  playing: bool,
  muted: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct FaviconEvent {
  label: String,
  url: String,
  icon: String,
}

/// Гаряча клавіша браузера, натиснута, поки фокус у сайті (webview2::watch_shortcuts).
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct ShortcutEvent {
  label: String,
  shortcut: &'static str,
}

/// Скільки запитів блокувальник реклами відсік на поточній сторінці вкладки.
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct AdBlockEvent {
  label: String,
  blocked: u32,
}

/// Елемент стеження, заблокований на поточній сторінці вкладки (tracking.rs).
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct BlockedTracker {
  category: crate::tracking::Category,
  host: String,
}

/// Усі елементи стеження, заблоковані на поточній сторінці вкладки (порожньо — на новій сторінці).
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct TrackersEvent {
  label: String,
  trackers: Vec<BlockedTracker>,
}

/// Процес сторінки впав чи не відповідає (page_events.rs).
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct CrashedEvent {
  label: String,
  failure: crate::page_events::Failure,
}

/// Сайт просить дозвіл (камера, мікрофон…): інтерфейс питає й відповідає page_permission_answer.
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
  label: String,
  #[serde(flatten)]
  request: crate::page_events::PermissionRequest,
}

/// Дія браузера з контекстного меню сайту.
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
struct ContextEvent {
  label: String,
  #[serde(flatten)]
  action: crate::page_events::ContextAction,
}

/// Сайт хоче відкрити посилання програмою (mailto:, tel:…): інтерфейс спершу спитає користувача (external.rs).
#[derive(Clone, Serialize, specta::Type)]
struct ExternalEvent {
  label: String,
  url: String,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct NewTabEvent {
  label: String,
  url: String,
  /// Після дії користувача (клік); інакше це спливне вікно, і інтерфейс може його заблокувати.
  user_initiated: bool,
}

/// Завантаження почалося, іде чи скінчилося (webview2::watch_downloads).
#[cfg(windows)]
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
  label: String,
  id: u64,
  url: String,
  path: String,
  file_name: String,
  received: i64,
  total: i64,
  state: &'static str,
}

fn is_web(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https")
}

/// Адреса, яку показує вкладка: сайт чи його код (view-source:https://…, Ctrl+U).
fn is_page_url(url: &Url) -> bool {
  is_web(url) || url.as_str().strip_prefix("view-source:").and_then(|inner| Url::parse(inner).ok()).is_some_and(|inner| is_web(&inner))
}

/// Іконка з вебу або невелика вбудована картинка (data:image/…), щоб не роздувати сховище інтерфейсу.
#[cfg(windows)]
fn is_icon_url(icon: &str) -> bool {
  Url::parse(icon).is_ok_and(|url| is_web(&url)) || (icon.starts_with("data:image/") && icon.len() <= 16 * 1024)
}

fn web_url(raw: &str) -> Result<Url, String> {
  let url = Url::parse(raw).map_err(|error| error.to_string())?;
  if is_page_url(&url) {
    Ok(url)
  } else {
    Err(format!("Unsupported URL scheme: {}", url.scheme()))
  }
}

fn page(window: &Window, label: &str) -> Result<Webview, String> {
  window.get_webview(label).ok_or_else(|| format!("No page with label {label}"))
}

/// Інтерфейс вікна почав (пере)завантажуватися: його вкладки починаються заново, тож webview сайтів від
/// попереднього завантаження лишилися б прихованими «сиротами» з тими самими мітками. Закриває їх.
pub fn close_orphans(webview: &Webview, payload: &PageLoadPayload<'_>) {
  if !matches!(payload.event(), PageLoadEvent::Started) || webview.label().starts_with(PAGE_PREFIX) {
    return;
  }
  let window = webview.window();
  // Не всередині події WebView2 іншого webview — закриття піде через цикл подій.
  tauri::async_runtime::spawn(async move {
    for orphan in window.webviews().into_iter().filter(|webview| webview.label().starts_with(PAGE_PREFIX)) {
      let _ = orphan.close();
    }
  });
}

fn place(webview: &Webview, bounds: &Bounds) -> Result<(), String> {
  webview.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| error.to_string())?;
  webview.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|error| error.to_string())
}

/// Скрипт сторінки для Ctrl + коліщатка (zoom-page.js) з токеном сторінки.
#[cfg(windows)]
fn zoom_script(token: &str) -> String {
  format!("({})({});", include_str!("zoom-page.js"), serde_json::Value::from(token))
}

/// Повідомлення скриптів сторінки: паролі — до passwords.rs, переклад виділеного — до translate.rs, крок масштабу —
/// інтерфейсу вікна як гаряча клавіша.
#[cfg(windows)]
fn on_page_message(
  app: &AppHandle,
  ui: &str,
  label: &str,
  token: &str,
  source: &str,
  message: &serde_json::Value,
) -> Option<serde_json::Value> {
  match message.get("astra")?.as_str()? {
    "zoom" if message.get("token")?.as_str()? == token => {
      let shortcut = match message.get("step")?.as_str()? {
        "in" => "zoom-in",
        "out" => "zoom-out",
        _ => return None,
      };
      let _ = app.emit_to(ui, "page://shortcut", ShortcutEvent { label: label.to_string(), shortcut });
      None
    }
    "translate" if message.get("token")?.as_str()? == token => crate::translate::on_page_message(app, label, message),
    _ => crate::passwords::on_page_message(app, ui, label, token, source, message),
  }
}

/// Відкриває сайт у новому webview. Async, бо на Windows створення webview з синхронної команди блокує головний потік.
/// `background` — вкладка відкривається у фоні: webview прихований і не забирає фокус.
/// `autoplay` — правила автовідтворення сайтів (audio.rs).
#[tauri::command]
#[specta::specta]
pub async fn page_open(
  window: Window,
  label: String,
  url: String,
  bounds: Bounds,
  background: bool,
  autoplay: audio::AutoplayRules,
) -> Result<(), String> {
  if !label.starts_with(PAGE_PREFIX) {
    return Err(format!("Page label must start with {PAGE_PREFIX}"));
  }
  let url = web_url(&url)?;
  let ui = window.label().to_string();
  let app = window.app_handle().clone();
  // Захист від стеження вікна: мітки стеження (fbclid, gclid…) прибираються з адреси ще до відкриття.
  #[cfg(windows)]
  let privacy = app.state::<crate::tracking::Tracking>().rules(&ui);
  #[cfg(windows)]
  let url = match url.host_str() {
    Some(host) if privacy.protects(host) => crate::tracking::without_tracking_params(&url).unwrap_or(url),
    _ => url,
  };
  #[cfg(windows)]
  let address = url.to_string();
  // Токен скриптів цієї сторінки (паролі, масштаб коліщатком, переклад виділеного): повідомлення без нього
  // не приймаються, тож скрипти самого сайту не можуть ні просити паролів, ні крутити масштаб, ні перекладати.
  #[cfg(windows)]
  let page_token = crate::passwords::new_token();

  let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
    .additional_browser_args(crate::BROWSER_ARGS)
    // У приватному вікні сторінки теж без збережених cookies, кешу й сховища.
    .incognito(ui.starts_with("private-") || ui.starts_with(GUEST_PREFIX))
    .focused(!background)
    // Інструменти розробника (F12, «Перевірити» в меню) — сайтам; інтерфейсу браузера в релізі — ні (main.rs).
    .devtools(true)
    // Перетягування на сайтах (файли в пошту, картки в Trello) — самому сайту, а не обробникові Tauri,
    // який у Windows його перехоплює.
    .disable_drag_drop_handler()
    .initialization_script_for_all_frames(audio::guard_script(&autoplay))
    // Сайт не може перейти на file:, tauri: чи інші не-вебові схеми. Посилання на програму (mailto:, tel:…) —
    // не перехід: його відкриє програма Windows, якщо дозволить користувач.
    .on_navigation({
      let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
      move |url| {
        if is_page_url(url) || url.as_str() == "about:blank" {
          return true;
        }
        if crate::external::scheme_of(url).is_some() {
          let _ = app.emit_to(&ui, "page://external", ExternalEvent { label: label.clone(), url: url.to_string() });
        }
        false
      }
    })
    .on_page_load({
      let (app, ui) = (app.clone(), ui.clone());
      move |webview, payload| {
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        let event = LoadEvent { label: webview.label().into(), url: payload.url().to_string(), loading };
        let _ = app.emit_to(&ui, "page://load", event);
      }
    })
    .on_document_title_changed({
      let (app, ui) = (app.clone(), ui.clone());
      move |webview, title| {
        let _ = app.emit_to(&ui, "page://title", TitleEvent { label: webview.label().into(), title });
      }
    })
    // Файл зберігається в «Завантаження» Windows, а власне вікно завантажень WebView2 сховане:
    // перебіг показує інтерфейс (webview2::watch_downloads).
    .on_download(|_, _| true);
  // Паролі: запропонувати зберегти після входу, підставити збережений у полі входу.
  // Global Privacy Control: navigator.globalPrivacyControl (а заголовок Sec-GPC додає webview2::block_ads).
  #[cfg(windows)]
  let builder = if privacy.gpc { builder.initialization_script_for_all_frames(crate::tracking::page_script(true)) } else { builder };
  #[cfg(windows)]
  let builder = builder
    .initialization_script(crate::passwords::page_script(&page_token))
    .initialization_script(zoom_script(&page_token))
    .initialization_script(crate::translate::page_script(&page_token));

  // Cookies, входи й сховище сайтів — свої в кожного облікового запису Astra (profiles.rs).
  #[cfg(windows)]
  let builder = match crate::profiles::site_data_dir(&app) {
    Some(dir) if !ui.starts_with("private-") && !ui.starts_with(GUEST_PREFIX) => {
      // Тека облікового запису, що вперше ввійшов, — з тими самими налаштуваннями DNS, що й решта (dns.rs).
      app.state::<crate::dns::Dns>().apply_to(&dir);
      builder.data_directory(dir)
    }
    _ => builder,
  };

  let webview = window
    .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
    .map_err(|error| error.to_string())?;

  // Найпершим — блокувальник реклами й захист від стеження: перший перехід Tauri вже почав, і фільтр має стати
  // раніше, ніж підуть запити сторінки. `report` — що заблоковано на сторінці, для інтерфейсу.
  #[cfg(windows)]
  webview2::block_ads(&webview, app.clone(), ui.clone(), address.clone(), {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |blocked| match blocked {
      webview2::Blocked::Ads(blocked) => {
        let _ = app.emit_to(&ui, "page://adblock", AdBlockEvent { label: label.clone(), blocked });
      }
      webview2::Blocked::Trackers(trackers) => {
        let trackers = trackers.into_iter().map(|(category, host)| BlockedTracker { category, host }).collect();
        let _ = app.emit_to(&ui, "page://trackers", TrackersEvent { label: label.clone(), trackers });
      }
    }
  })
  .map_err(|error| error.to_string())?;
  // Куки й сховища трекерів — вбудований захист WebView2 на рівні, вибраному в налаштуваннях; SmartScreen — так само.
  #[cfg(windows)]
  webview2::set_tracking_prevention(&webview, privacy.level).map_err(|error| error.to_string())?;
  #[cfg(windows)]
  crate::page_events::set_smart_screen(&webview, privacy.smart_screen).map_err(|error| error.to_string())?;

  // Посилання з target="_blank" і window.open — новою вкладкою, а не окремим вікном; спливні вікна без дії
  // користувача інтерфейс може заблокувати. Посилання на програми (mailto:…) — після запитання.
  #[cfg(windows)]
  crate::page_events::watch_new_windows(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, user_initiated| {
      let Ok(parsed) = Url::parse(&url) else {
        return;
      };
      if is_page_url(&parsed) {
        let _ = app.emit_to(&ui, "page://new-tab", NewTabEvent { label: label.clone(), url, user_initiated });
      } else if crate::external::scheme_of(&parsed).is_some() {
        let _ = app.emit_to(&ui, "page://external", ExternalEvent { label: label.clone(), url });
      }
    }
  })
  .map_err(|error| error.to_string())?;

  // Збій сторінки, запити дозволів і контекстне меню — через інтерфейс (page_events.rs).
  #[cfg(windows)]
  crate::page_events::watch_process_failed(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |failure| {
      // Без адреси сторінки: журнал не має знати, що відкривали.
      log::warn!("Процес сторінки: {failure:?}");
      let _ = app.emit_to(&ui, "page://crashed", CrashedEvent { label: label.clone(), failure });
    }
  })
  .map_err(|error| error.to_string())?;
  #[cfg(windows)]
  crate::page_events::watch_permissions(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |request| {
      let _ = app.emit_to(&ui, "page://permission", PermissionEvent { label: label.clone(), request });
    }
  })
  .map_err(|error| error.to_string())?;
  #[cfg(windows)]
  crate::page_events::customize_context_menu(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |action| {
      let _ = app.emit_to(&ui, "page://context", ContextEvent { label: label.clone(), action });
    }
  })
  .map_err(|error| error.to_string())?;

  // Автовідтворення — заборонене, доки користувач не дозволить його сайту в «Дозволах сайту».
  #[cfg(windows)]
  webview2::block_autoplay_by_default(&webview, address.clone()).map_err(|error| error.to_string())?;

  // Фонова вкладка — прихована. Ховаємо в головному потоці й чекаємо: інакше прихування стояло б у черзі, і показ,
  // який інтерфейс робить одразу після відкриття ("Відкрити всі закладки" показує першу), виконався б раніше за нього —
  // і сторінка лишалася б прихованою, доки не перемкнути вкладку.
  if background {
    let (done, hidden) = mpsc::channel();
    let page = webview.clone();
    app
      .run_on_main_thread(move || {
        let _ = done.send(page.hide().map_err(|error| error.to_string()));
      })
      .map_err(|error| error.to_string())?;
    receive(hidden).await??;
  }

  // Іконка сторінки — та, яку обрав сам WebView2 (без скриптів на сторінці).
  #[cfg(windows)]
  webview2::watch_favicon(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, icon| {
      if is_icon_url(&icon) {
        let _ = app.emit_to(&ui, "page://favicon", FaviconEvent { label: label.clone(), url, icon });
      }
    }
  })
  .map_err(|error| error.to_string())?;

  // Адреса й історія вкладки — від самого WebView2, разом зі змінами адреси без перезавантаження.
  #[cfg(windows)]
  webview2::watch_navigation(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, can_go_back, can_go_forward| {
      let event = NavigationEvent { label: label.clone(), url, can_go_back, can_go_forward };
      let _ = app.emit_to(&ui, "page://navigation", event);
    }
  })
  .map_err(|error| error.to_string())?;

  // Відео на весь екран: інтерфейс розтягує webview на все вікно.
  #[cfg(windows)]
  webview2::watch_fullscreen(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |fullscreen| {
      let _ = app.emit_to(&ui, "page://fullscreen", FullscreenEvent { label: label.clone(), fullscreen });
    }
  })
  .map_err(|error| error.to_string())?;

  // Звук сторінки: значок у вкладці й кнопка, що його вимикає.
  #[cfg(windows)]
  webview2::watch_audio(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |playing, muted| {
      let _ = app.emit_to(&ui, "page://audio", AudioEvent { label: label.clone(), playing, muted });
    }
  })
  .map_err(|error| error.to_string())?;

  #[cfg(windows)]
  webview2::watch_page_messages(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |source, message| on_page_message(&app, &ui, &label, &page_token, source, message)
  })
  .map_err(|error| error.to_string())?;

  // Ctrl+Tab і Ctrl+Shift+Tab перемикають вкладки й тоді, коли фокус у сайті.
  #[cfg(windows)]
  webview2::watch_shortcuts(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |shortcut| {
      let _ = app.emit_to(&ui, "page://shortcut", ShortcutEvent { label: label.clone(), shortcut });
    }
  })
  .map_err(|error| error.to_string())?;

  // Завантаження: у вибрану теку (чи щоразу питати куди), а як ідуть і чим скінчилися — для кнопки
  // завантажень і сторінки «Завантаження».
  #[cfg(windows)]
  if let Some(folder) = app.state::<crate::downloads::Downloads>().folder(&app) {
    webview2::set_download_folder(&webview, folder).map_err(|error| error.to_string())?;
  }
  #[cfg(windows)]
  webview2::watch_downloads(
    &webview,
    {
      let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
      move |request| crate::downloads::ask_where(&app, &ui, &label, request)
    },
    {
      let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
      move |update| {
        let file_name = Path::new(&update.path)
          .file_name()
          .map(|name| name.to_string_lossy().into_owned())
          .or_else(|| Url::parse(&update.url).ok()?.path_segments()?.next_back().map(str::to_owned))
          .filter(|name| !name.is_empty())
          .unwrap_or_else(|| update.url.clone());
        let event = DownloadEvent {
          label: label.clone(),
          id: update.id,
          url: update.url,
          path: update.path,
          file_name,
          received: update.received,
          total: update.total,
          state: update.state,
        };
        let _ = app.emit_to(&ui, "page://download", event);
      }
    },
  )
  .map_err(|error| error.to_string())?;

  #[cfg(not(windows))]
  let _ = (webview, app);
  Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn page_navigate(window: Window, label: String, url: String) -> Result<(), String> {
  page(&window, &label)?.navigate(web_url(&url)?).map_err(|error| error.to_string())
}

/// Крок по історії сторінки: -1 — назад, 1 — вперед.
#[tauri::command]
#[specta::specta]
pub fn page_go(window: Window, label: String, step: i32) -> Result<(), String> {
  let webview = page(&window, &label)?;
  // На Windows — нативно: history.go() через eval дав би сторінці «активацію користувача».
  #[cfg(windows)]
  return webview2::go(&webview, step).map_err(|error| error.to_string());
  #[cfg(not(windows))]
  webview.eval(format!("history.go({step})")).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn page_reload(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.reload().map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn page_set_bounds(window: Window, label: String, bounds: Bounds) -> Result<(), String> {
  place(&page(&window, &label)?, &bounds)
}

#[tauri::command]
#[specta::specta]
pub fn page_set_visible(window: Window, label: String, visible: bool) -> Result<(), String> {
  let webview = page(&window, &label)?;
  if visible { webview.show() } else { webview.hide() }.map_err(|error| error.to_string())
}

/// Отвори в сайті під відкриті панелі інтерфейсу (webview2::set_clip); порожній список — сайт знову цілий.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn page_set_clip(window: Window, label: String, holes: Vec<webview2::Hole>) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let scale = window.scale_factor().map_err(|error| error.to_string())?;
  let origin = webview.position().map_err(|error| error.to_string())?;
  webview2::set_clip(&webview, holes, scale, (origin.x, origin.y)).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn page_set_zoom(window: Window, label: String, scale: f64) -> Result<(), String> {
  page(&window, &label)?.set_zoom(scale).map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn page_focus(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn page_print(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.print().map_err(|error| error.to_string())
}

/// Інструменти розробника сайту (DevTools WebView2) — окремим вікном.
#[tauri::command]
#[specta::specta]
pub fn page_open_devtools(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.open_devtools();
  Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn page_close(window: Window, scripts: State<'_, audio::RulesScripts>, label: String) -> Result<(), String> {
  scripts.0.lock().map_err(|error| error.to_string())?.remove(&label);
  let Some(webview) = window.get_webview(&label) else {
    return Ok(());
  };
  // Сторінку, з якої ще йде завантаження, лише ховаємо до його кінця (webview2::close_page).
  #[cfg(windows)]
  return window
    .run_on_main_thread(move || {
      let _ = webview2::close_page(webview);
    })
    .map_err(|error| error.to_string());
  #[cfg(not(windows))]
  webview.close().map_err(|error| error.to_string())
}

/// Пошук тексту на сторінці через window.find: виділяє наступний (чи попередній) збіг і каже, чи він знайшовся.
/// Скрипт через WebView2 дає сторінці «активацію користувача»; тут це прийнятно — пошук запускає сам користувач.
#[tauri::command]
#[specta::specta]
pub async fn page_find(window: Window, label: String, query: String, backwards: bool) -> Result<bool, String> {
  let webview = page(&window, &label)?;
  let query = serde_json::to_string(&query).map_err(|error| error.to_string())?;
  let (sender, receiver) = mpsc::channel();
  webview
    .eval_with_callback(format!("window.find({query}, false, {backwards}, true)"), move |result| {
      let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;

  Ok(receive(receiver).await? == "true")
}

/// Чекає відповіді з головного потоку чи колбека WebView2, не блокуючи async runtime.
async fn receive<T: Send + 'static>(receiver: mpsc::Receiver<T>) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(2)))
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// Origin сторінки (https://www.example.com), для якого зберігаються дозволи.
#[cfg(windows)]
fn page_origin(webview: &Webview) -> Result<String, String> {
  let url = webview.url().map_err(|error| error.to_string())?;
  if is_web(&url) {
    Ok(url.origin().ascii_serialization())
  } else {
    Err(format!("No permissions for {url}"))
  }
}

/// Нові правила автовідтворення (audio.rs) для всіх сайтів вікна: відкритим сторінкам — одразу, новим — зі скриптом.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn page_set_audio_rules(window: Window, rules: audio::AutoplayRules) -> Result<(), String> {
  let script = audio::rules_script(&rules);
  let pages = window.webviews().into_iter().filter(|webview| webview.label().starts_with(PAGE_PREFIX));
  for webview in pages {
    let label = webview.label().to_string();
    let scripts = window.state::<audio::RulesScripts>();
    let previous = scripts.0.lock().map_err(|error| error.to_string())?.get(&label).cloned();
    let app = window.app_handle().clone();
    webview2::replace_document_script(&webview, previous, script.clone(), move |id| {
      if let Ok(mut scripts) = app.state::<audio::RulesScripts>().0.lock() {
        scripts.insert(label, id);
      }
    })
    .map_err(|error| error.to_string())?;
    // І вже відкритим сторінкам — одразу: дозволили YouTube й перейшли на інше відео без перезавантаження сторінки —
    // нове правило вже діє.
    let _ = webview.eval(script.clone());
  }
  Ok(())
}

#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_set_muted(window: Window, label: String, muted: bool) -> Result<(), String> {
  let (reply, receiver) = mpsc::channel();
  webview2::set_muted(&page(&window, &label)?, muted, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Знімок сторінки (JPEG) — його показує інтерфейс, поки webview прихований під відкритою панеллю.
#[cfg(windows)]
#[tauri::command]
pub async fn page_capture(window: Window, label: String) -> Result<tauri::ipc::Response, String> {
  let (reply, receiver) = mpsc::channel();
  webview2::capture(&page(&window, &label)?, reply).map_err(|error| error.to_string())?;
  Ok(tauri::ipc::Response::new(receive(receiver).await??))
}

/// Скріншот сторінки PNG: видима частина чи вся сторінка з прокруткою (`full`). Уся сторінка знімається довше,
/// тож і чекаємо довше, ніж на звичайні відповіді WebView2.
#[cfg(windows)]
#[tauri::command]
pub async fn page_screenshot(window: Window, label: String, full: bool) -> Result<tauri::ipc::Response, String> {
  let (reply, receiver) = mpsc::channel();
  webview2::screenshot(&page(&window, &label)?, full, reply).map_err(|error| error.to_string())?;
  let image = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(20)))
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())??;
  Ok(tauri::ipc::Response::new(image))
}

/// «Картинка в картинці» для відео на сторінці.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_picture_in_picture(window: Window, label: String) -> Result<webview2::PictureInPicture, String> {
  let (reply, receiver) = mpsc::channel();
  webview2::picture_in_picture(&page(&window, &label)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Особливе оновлення з меню кнопки «Оновити»: без кешу, з очищенням даних чи cookies сайту.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_reload_with(window: Window, label: String, mode: webview2::ReloadMode) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let url = webview.url().map_err(|error| error.to_string())?.to_string();
  let (reply, receiver) = mpsc::channel();
  webview2::reload_with(&webview, mode, url, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Дозвіл сайту на автовідтворення, збережений у профілі WebView2.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_autoplay(window: Window, label: String) -> Result<Autoplay, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  webview2::autoplay(&webview, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Присипляє приховану фонову вкладку (page_events.rs); `true` — заснула.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_suspend(window: Window, label: String) -> Result<bool, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  crate::page_events::suspend(&webview, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Вкладка пішла у фон (менше пам'яті) чи стала активною.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn page_set_background(window: Window, label: String, background: bool) -> Result<(), String> {
  crate::page_events::set_background(&page(&window, &label)?, background).map_err(|error| error.to_string())
}

/// Відповідь користувача на запит дозволу сайту.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub fn page_permission_answer(
  app: AppHandle,
  id: u64,
  state: crate::page_events::PermissionState,
  remember: bool,
) -> Result<(), String> {
  app
    .run_on_main_thread(move || crate::page_events::answer_permission(id, state, remember))
    .map_err(|error| error.to_string())
}

/// Збережені дозволи сайту вкладки — для панелі дозволів.
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_permissions(
  window: Window,
  label: String,
) -> Result<std::collections::HashMap<String, crate::page_events::PermissionState>, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  crate::page_events::site_permissions(&webview, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Зберігає дозвіл сайту вкладки (з панелі дозволів).
#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_set_permission(
  window: Window,
  label: String,
  kind: String,
  state: crate::page_events::PermissionState,
) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  crate::page_events::set_site_permission(&webview, page_origin(&webview)?, kind, state, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

#[cfg(windows)]
#[tauri::command]
#[specta::specta]
pub async fn page_set_autoplay(window: Window, label: String, autoplay: Autoplay) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  webview2::set_autoplay(&webview, page_origin(&webview)?, autoplay, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tabs_show_sites_and_their_source_only() {
    let url = |raw: &str| Url::parse(raw).unwrap();
    assert!(is_page_url(&url("https://example.com/")));
    assert!(is_page_url(&url("http://localhost:4200/")));
    assert!(is_page_url(&url("view-source:https://example.com/a?b=1")));
    assert!(!is_page_url(&url("view-source:file:///C:/secret.txt")));
    assert!(!is_page_url(&url("file:///C:/secret.txt")));
    assert!(web_url("view-source:javascript:alert(1)").is_err());
  }
}
