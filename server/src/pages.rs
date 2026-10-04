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
  webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload},
  Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder, WebviewUrl, Window,
};

/// Мітки webview сайтів; webview інтерфейсу називаються як їхні вікна (main, window-…, private-…).
const PAGE_PREFIX: &str = "page-";

/// Положення й розмір області вмісту в логічних пікселях вікна.
#[derive(Deserialize)]
pub struct Bounds {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

#[derive(Clone, Serialize)]
struct LoadEvent {
  label: String,
  url: String,
  loading: bool,
}

#[derive(Clone, Serialize)]
struct TitleEvent {
  label: String,
  title: String,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationEvent {
  label: String,
  url: String,
  can_go_back: bool,
  can_go_forward: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
struct FullscreenEvent {
  label: String,
  fullscreen: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
struct AudioEvent {
  label: String,
  playing: bool,
  muted: bool,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
struct FaviconEvent {
  label: String,
  url: String,
  icon: String,
}

/// Гаряча клавіша браузера, натиснута, поки фокус у сайті (webview2::watch_shortcuts).
#[cfg(windows)]
#[derive(Clone, Serialize)]
struct ShortcutEvent {
  label: String,
  shortcut: &'static str,
}

/// Скільки запитів блокувальник реклами відсік на поточній сторінці вкладки.
#[cfg(windows)]
#[derive(Clone, Serialize)]
struct AdBlockEvent {
  label: String,
  blocked: u32,
}

#[derive(Clone, Serialize)]
struct NewTabEvent {
  label: String,
  url: String,
}

/// Завантаження почалося, іде чи скінчилося (webview2::watch_downloads).
#[cfg(windows)]
#[derive(Clone, Serialize)]
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

/// Іконка з вебу або невелика вбудована картинка (data:image/…), щоб не роздувати сховище інтерфейсу.
#[cfg(windows)]
fn is_icon_url(icon: &str) -> bool {
  Url::parse(icon).is_ok_and(|url| is_web(&url)) || (icon.starts_with("data:image/") && icon.len() <= 16 * 1024)
}

fn web_url(raw: &str) -> Result<Url, String> {
  let url = Url::parse(raw).map_err(|error| error.to_string())?;
  if is_web(&url) {
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

/// Відкриває сайт у новому webview. Async, бо на Windows створення webview з синхронної команди блокує головний потік.
/// `background` — вкладка відкривається у фоні: webview прихований і не забирає фокус.
/// `block_audio` — сайти, яким заборонено автовідтворення зі звуком (audio.rs).
#[tauri::command]
pub async fn page_open(
  window: Window,
  label: String,
  url: String,
  bounds: Bounds,
  background: bool,
  block_audio: Vec<String>,
) -> Result<(), String> {
  if !label.starts_with(PAGE_PREFIX) {
    return Err(format!("Page label must start with {PAGE_PREFIX}"));
  }
  let url = web_url(&url)?;
  let ui = window.label().to_string();
  let app = window.app_handle().clone();
  #[cfg(windows)]
  let address = url.to_string();
  // Токен скрипта паролів цієї сторінки: без нього паролі сторінці не віддаються (passwords.rs).
  #[cfg(windows)]
  let password_token = crate::passwords::new_token();

  let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
    // У приватному вікні сторінки теж без збережених cookies, кешу й сховища.
    .incognito(ui.starts_with("private-"))
    .focused(!background)
    // Перетягування на сайтах (файли в пошту, картки в Trello) — самому сайту, а не обробникові Tauri,
    // який у Windows його перехоплює.
    .disable_drag_drop_handler()
    .initialization_script_for_all_frames(audio::guard_script(&block_audio))
    // Сайт не може перейти на file:, tauri: чи інші не-вебові схеми.
    .on_navigation(|url| is_web(url) || url.as_str() == "about:blank")
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
    // Посилання з target="_blank" і window.open відкриваються новою вкладкою, а не окремим вікном.
    .on_new_window({
      let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
      move |url, _features| {
        if is_web(&url) {
          let _ = app.emit_to(&ui, "page://new-tab", NewTabEvent { label: label.clone(), url: url.to_string() });
        }
        NewWindowResponse::Deny
      }
    })
    // Файл зберігається в «Завантаження» Windows, а власне вікно завантажень WebView2 сховане:
    // перебіг показує інтерфейс (webview2::watch_downloads).
    .on_download(|_, _| true);
  // Паролі: запропонувати зберегти після входу, підставити збережений у полі входу.
  #[cfg(windows)]
  let builder = builder.initialization_script(crate::passwords::page_script(&password_token));

  let webview = window
    .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
    .map_err(|error| error.to_string())?;

  // Найпершим — блокувальник реклами: перший перехід Tauri вже почав, і фільтр має стати раніше, ніж підуть
  // запити сторінки. `report` — скільки заблоковано на сторінці, для інтерфейсу.
  #[cfg(windows)]
  webview2::block_ads(&webview, app.clone(), address.clone(), {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |blocked| {
      let _ = app.emit_to(&ui, "page://adblock", AdBlockEvent { label: label.clone(), blocked });
    }
  })
  .map_err(|error| error.to_string())?;

  // Автовідтворення — заборонене, доки користувач не дозволить його сайту в «Дозволах сайту».
  #[cfg(windows)]
  webview2::block_autoplay_by_default(&webview, address.clone()).map_err(|error| error.to_string())?;

  if background {
    webview.hide().map_err(|error| error.to_string())?;
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
    move |source, message| crate::passwords::on_page_message(&app, &ui, &label, &password_token, source, message)
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
pub fn page_navigate(window: Window, label: String, url: String) -> Result<(), String> {
  page(&window, &label)?.navigate(web_url(&url)?).map_err(|error| error.to_string())
}

/// Крок по історії сторінки: -1 — назад, 1 — вперед.
#[tauri::command]
pub fn page_go(window: Window, label: String, step: i32) -> Result<(), String> {
  let webview = page(&window, &label)?;
  // На Windows — нативно: history.go() через eval дав би сторінці «активацію користувача».
  #[cfg(windows)]
  return webview2::go(&webview, step).map_err(|error| error.to_string());
  #[cfg(not(windows))]
  webview.eval(format!("history.go({step})")).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_reload(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.reload().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_set_bounds(window: Window, label: String, bounds: Bounds) -> Result<(), String> {
  place(&page(&window, &label)?, &bounds)
}

#[tauri::command]
pub fn page_set_visible(window: Window, label: String, visible: bool) -> Result<(), String> {
  let webview = page(&window, &label)?;
  if visible { webview.show() } else { webview.hide() }.map_err(|error| error.to_string())
}

/// Отвори в сайті під відкриті панелі інтерфейсу (webview2::set_clip); порожній список — сайт знову цілий.
#[cfg(windows)]
#[tauri::command]
pub fn page_set_clip(window: Window, label: String, holes: Vec<webview2::Hole>) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let scale = window.scale_factor().map_err(|error| error.to_string())?;
  webview2::set_clip(&webview, holes, scale).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_set_zoom(window: Window, label: String, scale: f64) -> Result<(), String> {
  page(&window, &label)?.set_zoom(scale).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_focus(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_print(window: Window, label: String) -> Result<(), String> {
  page(&window, &label)?.print().map_err(|error| error.to_string())
}

#[tauri::command]
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

/// Новий список сайтів із заблокованим звуком для всіх сайтів вікна; діє після перезавантаження сторінки.
#[cfg(windows)]
#[tauri::command]
pub fn page_set_audio_rules(window: Window, origins: Vec<String>) -> Result<(), String> {
  let script = audio::rules_script(&origins);
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
  }
  Ok(())
}

#[cfg(windows)]
#[tauri::command]
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

/// «Картинка в картинці» для відео на сторінці: opened, closed чи no-video.
#[cfg(windows)]
#[tauri::command]
pub async fn page_picture_in_picture(window: Window, label: String) -> Result<String, String> {
  let (reply, receiver) = mpsc::channel();
  webview2::picture_in_picture(&page(&window, &label)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Особливе оновлення з меню кнопки «Оновити»: без кешу, з очищенням даних чи cookies сайту.
#[cfg(windows)]
#[tauri::command]
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
pub async fn page_autoplay(window: Window, label: String) -> Result<Autoplay, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  webview2::autoplay(&webview, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

#[cfg(windows)]
#[tauri::command]
pub async fn page_set_autoplay(window: Window, label: String, autoplay: Autoplay) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  webview2::set_autoplay(&webview, page_origin(&webview)?, autoplay, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}
