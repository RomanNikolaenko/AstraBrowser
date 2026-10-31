//! Сторінки сайтів: кожна вкладка із сайтом — окремий нативний webview поверх області вмісту вікна.
//!
//! Інтерфейс (Angular) керує ними командами `page_*`, а про навігацію, заголовок, нові вкладки
//! й завантаження дізнається з подій `page://…`, які надсилаються лише webview інтерфейсу цього вікна.
//! Віддалені сторінки не мають доступу до команд: у Tauri 2 IPC для них закритий без явного дозволу.

use std::path::Path;
use std::{
  collections::HashSet,
  sync::{mpsc, LazyLock, Mutex},
  time::Duration,
};

use serde::{Deserialize, Serialize};

/// Події й керування сторінкою — засобами рушія системи: WebView2 (Windows) чи WebKitGTK (Linux, gtk_page.rs).
#[cfg(target_os = "linux")]
use crate::gtk_page as engine;
#[cfg(target_os = "linux")]
use crate::gtk_page as events;
#[cfg(windows)]
use crate::page_events as events;
#[cfg(windows)]
use crate::webview2;
#[cfg(windows)]
use crate::webview2 as engine;
use crate::{
  audio,
  page_types::{Area, Autoplay, PermissionState, PictureInPicture, ReloadMode, TabDirection},
};
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

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct NavigationEvent {
  label: String,
  url: String,
  can_go_back: bool,
  can_go_forward: bool,
}

#[derive(Clone, Serialize, specta::Type)]
struct FullscreenEvent {
  label: String,
  fullscreen: bool,
}

/// Інтерфейсові вікна — чи сайт зараз на весь екран (fullscreen.rs): як є, а не що сказала подія сторінки.
#[cfg(windows)]
pub(crate) fn notify_fullscreen(page: &Webview) {
  let label = page.label().to_string();
  let fullscreen = crate::fullscreen::holds(&label);
  let _ = page.app_handle().emit_to(page.window().label(), "page://fullscreen", FullscreenEvent { label, fullscreen });
}

#[derive(Clone, Serialize, specta::Type)]
struct AudioEvent {
  label: String,
  playing: bool,
  muted: bool,
}

/// Відео чи аудіо на сторінці почало чи перестало грати зі звуком (media-page.js).
#[derive(Clone, Serialize, specta::Type)]
struct MediaEvent {
  label: String,
  playing: bool,
}

#[derive(Clone, Serialize, specta::Type)]
struct FaviconEvent {
  label: String,
  url: String,
  icon: String,
}

/// Гаряча клавіша браузера, натиснута, поки фокус у сайті (webview2::watch_shortcuts), чи Ctrl + коліщатко
/// (zoom-page.js).
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

/// Процес сторінки впав чи не відповідає (page_events.rs, gtk_page.rs).
#[derive(Clone, Serialize, specta::Type)]
struct CrashedEvent {
  label: String,
  failure: crate::page_types::Failure,
}

/// Сайт просить дозвіл (камера, мікрофон…): інтерфейс питає й відповідає page_permission_answer.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
  label: String,
  #[serde(flatten)]
  request: crate::page_types::PermissionRequest,
}

/// Дія браузера з контекстного меню сайту.
#[derive(Clone, Serialize, specta::Type)]
struct ContextEvent {
  label: String,
  #[serde(flatten)]
  action: crate::context_menu::ContextAction,
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
  /// Лише в посилань, відкритих коліщатком чи з Ctrl (new-tab-page.js): true — без Shift. Чи вкладка піде у фон, вирішує
  /// інтерфейс за налаштуванням «Одразу переходити на нову вкладку» (Shift — навпаки); без поля — одразу на неї.
  #[serde(skip_serializing_if = "Option::is_none")]
  background: Option<bool>,
}

/// Завантаження почалося, іде чи скінчилося (webview2::watch_downloads, gtk_downloads.rs).
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

fn is_file(url: &Url) -> bool {
  url.scheme() == "file"
}

/// Адреса, яку показує вкладка: сайт, його код (view-source:https://…, Ctrl+U) чи файл комп'ютера (file:, лише у
/// вкладках, де його відкрив сам користувач, — [`may_open`]).
fn is_page_url(url: &Url) -> bool {
  is_web(url)
    || is_file(url)
    || url.as_str().strip_prefix("view-source:").and_then(|inner| Url::parse(inner).ok()).is_some_and(|inner| is_web(&inner))
}

/// Вкладки (мітки), у яких користувач сам відкрив файл комп'ютера: з Провідника, адресного рядка чи з минулого запуску.
/// Лише в них можна переходити між файлами й відкривати файли новими вкладками; сайт до файлів комп'ютера не дістанеться
/// ні переходом, ні новим вікном.
static LOCAL_PAGES: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Чи може вкладка `label` відкрити `url`: сайти — будь-яка, файли комп'ютера — лише та, де їх відкрив користувач.
fn may_open(label: &str, url: &Url) -> bool {
  !is_file(url) || LOCAL_PAGES.lock().is_ok_and(|pages| pages.contains(label))
}

/// Користувач сам відкриває `url` у вкладці `label` (page_open, page_navigate): файлові — дозвіл на файли.
fn allow_local(label: &str, url: &Url) {
  if is_file(url) {
    if let Ok(mut pages) = LOCAL_PAGES.lock() {
      pages.insert(label.to_string());
    }
  }
}

/// Іконка з вебу або невелика вбудована картинка (data:image/…), щоб не роздувати сховище інтерфейсу.
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

/// Вікно закрили: правила захисту від стеження його інтерфейсу й записи про скрипти сторінок, яких уже немає (закритих
/// разом із ним), більше не потрібні.
pub fn forget_window(window: &Window) {
  let app = window.app_handle();
  let open = |label: &String| app.get_webview(label).is_some();
  if let Ok(mut scripts) = app.state::<audio::RulesScripts>().0.lock() {
    scripts.retain(|label, _| open(label));
  }
  if let Ok(mut scripts) = app.state::<crate::tracking::PageScripts>().0.lock() {
    scripts.retain(|label, _| open(label));
  }
  if let Ok(mut pages) = LOCAL_PAGES.lock() {
    pages.retain(|label| open(label));
  }
  app.state::<crate::tracking::Tracking>().forget(window.label());
}

#[cfg(target_os = "linux")]
impl Bounds {
  fn area(&self) -> Area {
    Area { x: self.x, y: self.y, width: self.width, height: self.height }
  }
}

fn place(webview: &Webview, bounds: &Bounds) -> Result<(), String> {
  // Linux: Tauri кладе webview стовпчиком у вікно, а не на місце, — сайт ставить gtk_layers.rs.
  #[cfg(target_os = "linux")]
  return crate::gtk_layers::place(webview, bounds.area()).map_err(|error| error.to_string());
  #[cfg(windows)]
  {
    webview.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| error.to_string())?;
    webview.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|error| error.to_string())
  }
}

/// Скрипт сторінки, що виводить її з повного екрана після того, як вікно й сайт уже на місці (fullscreen-page.js).
#[cfg(windows)]
fn fullscreen_script(token: &str) -> String {
  format!("({})({});", include_str!("fullscreen-page.js"), serde_json::Value::from(token))
}

/// Скрипт сторінки для Ctrl + коліщатка (zoom-page.js) з токеном сторінки.
fn zoom_script(token: &str) -> String {
  format!("({})({});", include_str!("zoom-page.js"), serde_json::Value::from(token))
}

/// Скрипт сторінки для посилань коліщатком і з Ctrl (new-tab-page.js) з токеном сторінки.
fn new_tab_script(token: &str) -> String {
  format!("({})({});", include_str!("new-tab-page.js"), serde_json::Value::from(token))
}

/// Скрипт сторінки, що каже, чи грає на ній відео чи аудіо зі звуком (media-page.js), з токеном сторінки.
fn media_script(token: &str) -> String {
  format!("({})({});", include_str!("media-page.js"), serde_json::Value::from(token))
}

/// Повідомлення скриптів сторінки: паролі — до passwords.rs, адреси — до addresses.rs, банківські картки — до
/// cards.rs, переклад виділеного — до translate.rs, крок масштабу — інтерфейсу вікна як гаряча клавіша.
fn on_page_message(
  app: &AppHandle,
  ui: &str,
  label: &str,
  token: &str,
  source: &str,
  message: &serde_json::Value,
) -> Option<serde_json::Value> {
  match message.get("astra")?.as_str()? {
    // Посилання коліщатком чи з Ctrl (new-tab-page.js): нова вкладка, а у фоні чи ні — вирішує інтерфейс.
    "open-tab" if message.get("token")?.as_str()? == token => {
      let url = message.get("url")?.as_str()?;
      Url::parse(url).ok().filter(|url| is_page_url(url) && may_open(label, url))?;
      let background = Some(message.get("background").and_then(serde_json::Value::as_bool).unwrap_or(true));
      let event = NewTabEvent { label: label.to_string(), url: url.to_string(), user_initiated: true, background };
      let _ = app.emit_to(ui, "page://new-tab", event);
      None
    }
    // Таку вкладку інтерфейс не присипляє.
    "media" if message.get("token")?.as_str()? == token => {
      let playing = message.get("playing")?.as_bool()?;
      let _ = app.emit_to(ui, "page://media", MediaEvent { label: label.to_string(), playing });
      None
    }
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
    // Поля банківської картки — до cards.rs, решта автозаповнення (адреси, рух і клавіші списку) — до addresses.rs.
    "autofill" if message.get("form").and_then(serde_json::Value::as_str) == Some("card") => {
      crate::cards::on_page_message(app, ui, label, token, source, message)
    }
    "autofill" => crate::addresses::on_page_message(app, ui, label, token, source, message),
    // Сторінка виходить із повного екрана: спершу вікно й сайт на місце, тоді — їй відповідь, що можна.
    #[cfg(windows)]
    "fullscreen-exit" if message.get("token")?.as_str()? == token => {
      // Дозвіл прийде, коли під затемненням вікно й сайт уже на місці; не на весь екран — одразу.
      let later = app.get_webview(label).is_some_and(|page| crate::fullscreen::prepare_exit(&page));
      (!later).then(|| serde_json::json!({ "astra": "fullscreen-ready" }))
    }
    // Сторінка перемалювалась під час переходу: затемнення може сходити.
    #[cfg(windows)]
    "fullscreen-painted" if message.get("token")?.as_str()? == token => {
      let size = |key: &str| message.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0) as i32;
      if let Some(page) = app.get_webview(label) {
        let fullscreen = message.get("fullscreen").and_then(serde_json::Value::as_bool).unwrap_or(false);
        crate::fullscreen::painted(&page, fullscreen, size("width"), size("height"));
      }
      None
    }
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
  allow_local(&label, &url);
  let ui = window.label().to_string();
  let app = window.app_handle().clone();
  // Захист від стеження вікна: мітки стеження (fbclid, gclid…) прибираються з адреси ще до відкриття.
  let privacy = app.state::<crate::tracking::Tracking>().rules(&ui);
  let url = match url.host_str() {
    Some(host) if privacy.protects(host) => crate::tracking::without_tracking_params(&url).unwrap_or(url),
    _ => url,
  };
  #[cfg(windows)]
  let address = url.to_string();
  // Токен скриптів цієї сторінки (паролі, адреси, масштаб коліщатком, переклад виділеного): повідомлення без нього
  // не приймаються, тож скрипти самого сайту не можуть ні просити паролів, ні крутити масштаб, ні перекладати.
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
    // Сайт не може перейти на tauri: чи інші не-вебові схеми, а на file: — лише у вкладці, де файл відкрив сам
    // користувач. Посилання на програму (mailto:, tel:…) — не перехід: його відкриє програма Windows, якщо дозволить
    // користувач.
    .on_navigation({
      let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
      move |url| {
        if (is_page_url(url) && may_open(&label, url)) || url.as_str() == "about:blank" {
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
    // перебіг показує інтерфейс (webview2::watch_downloads). У Linux завантаження веде gtk_downloads.rs.
    .on_download(|_, _| true);
  // Паролі: запропонувати зберегти після входу, підставити збережений у полі входу. Адреси й картки — так само у
  // формах (один скрипт, autofill-page.js).
  // Global Privacy Control: navigator.globalPrivacyControl (а заголовок Sec-GPC додає webview2::block_ads).
  #[cfg(windows)]
  let builder =
    if privacy.gpc { builder.initialization_script_for_all_frames(crate::tracking::page_script(true)) } else { builder };
  #[cfg(windows)]
  let builder = builder
    .initialization_script(crate::passwords::page_script(&page_token))
    .initialization_script(crate::addresses::page_script(&page_token))
    .initialization_script(zoom_script(&page_token))
    .initialization_script(new_tab_script(&page_token))
    .initialization_script(media_script(&page_token))
    .initialization_script(fullscreen_script(&page_token))
    .initialization_script(crate::translate::page_script(&page_token));

  // Cookies, входи й сховище сайтів — свої в кожного облікового запису Astra (profiles.rs).
  let builder = match crate::profiles::site_data_dir(&app) {
    Some(dir) if !ui.starts_with("private-") && !ui.starts_with(GUEST_PREFIX) => {
      // Тека облікового запису, що вперше ввійшов, — з тими самими налаштуваннями DNS, що й решта (dns.rs; DNS через
      // HTTPS є лише у WebView2).
      #[cfg(windows)]
      app.state::<crate::dns::Dns>().apply_to(&dir);
      builder.data_directory(dir)
    }
    _ => builder,
  };

  // Linux: DNS через HTTPS — проксі профілю даних WebKit (doh_proxy.rs). Сторінка починає вантажитися, щойно створена,
  // тож проксі ставиться заздалегідь — профілю інтерфейсу вікна, спільному із сайтами власника.
  #[cfg(target_os = "linux")]
  if let Some(interface) = window.get_webview(&ui) {
    let _ = crate::doh_proxy::apply(&interface);
  }
  let webview = window
    .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
    .map_err(|error| error.to_string())?;
  // Сайт — під інтерфейсом, а інтерфейс над ним прозорий: меню й вікна малюються просто над сторінкою
  // (webview2::send_to_back, interface_set_input_region).
  #[cfg(windows)]
  let _ = webview2::send_to_back(&webview);
  #[cfg(target_os = "linux")]
  {
    // Найпершим: без апаратного прискорення переходи View Transitions валять увесь браузер (gtk_page.rs).
    let _ = crate::gtk_page::avoid_view_transitions_crash(&webview);
    // Проксі DoH і профілю самої сторінки (в іншого облікового запису й у приватному вікні — свій).
    let _ = crate::doh_proxy::apply(&webview);
    let _ = crate::gtk_layers::adopt(&webview, bounds.area());
    // Блокувальник реклами й захист від стеження: фільтри вмісту WebKit і скрипти сторінки на кожному переході
    // (gtk_adblock.rs, gtk_tracking.rs).
    let _ = crate::gtk_adblock::attach(&webview);
    let _ = crate::gtk_tracking::attach(&webview);
    // Паролі, адреси й картки, масштаб коліщатком і переклад виділеного — ті самі скрипти, що й у Windows, але в
    // окремому світі WebKit (gtk_page.rs).
    let scripts = vec![
      crate::passwords::page_script(&page_token),
      crate::addresses::page_script(&page_token),
      zoom_script(&page_token),
      new_tab_script(&page_token),
      media_script(&page_token),
      crate::translate::page_script(&page_token),
    ];
    crate::gtk_page::add_page_scripts(&webview, scripts).map_err(|error| error.to_string())?;
  }
  #[cfg(windows)]
  if let Some(interface) = window.get_webview(&ui) {
    let _ = interface.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
  }

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
  #[cfg(windows)]
  crate::page_events::disable_general_autofill(&webview).map_err(|error| error.to_string())?;

  // Посилання з target="_blank" і window.open — новою вкладкою, а не окремим вікном; спливні вікна без дії
  // користувача інтерфейс може заблокувати. Посилання на програми (mailto:…) — після запитання.
  events::watch_new_windows(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, user_initiated, background| {
      let Ok(parsed) = Url::parse(&url) else {
        return;
      };
      if is_page_url(&parsed) && may_open(&label, &parsed) {
        let _ = app.emit_to(&ui, "page://new-tab", NewTabEvent { label: label.clone(), url, user_initiated, background });
      } else if crate::external::scheme_of(&parsed).is_some() {
        let _ = app.emit_to(&ui, "page://external", ExternalEvent { label: label.clone(), url });
      }
    }
  })
  .map_err(|error| error.to_string())?;

  // Збій сторінки, запити дозволів і контекстне меню — через інтерфейс (page_events.rs, gtk_page.rs).
  events::watch_process_failed(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |failure| {
      // Без адреси сторінки: журнал не має знати, що відкривали.
      log::warn!("Процес сторінки: {failure:?}");
      let _ = app.emit_to(&ui, "page://crashed", CrashedEvent { label: label.clone(), failure });
    }
  })
  .map_err(|error| error.to_string())?;
  events::watch_permissions(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |request| {
      let _ = app.emit_to(&ui, "page://permission", PermissionEvent { label: label.clone(), request });
    }
  })
  .map_err(|error| error.to_string())?;
  events::customize_context_menu(&webview, {
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

  // Іконка сторінки — та, яку обрав сам рушій (без скриптів на сторінці).
  engine::watch_favicon(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, icon| {
      if is_icon_url(&icon) {
        let _ = app.emit_to(&ui, "page://favicon", FaviconEvent { label: label.clone(), url, icon });
      }
    }
  })
  .map_err(|error| error.to_string())?;

  // Адреса й історія вкладки — від самого WebView2, разом зі змінами адреси без перезавантаження.
  engine::watch_navigation(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |url, can_go_back, can_go_forward| {
      let event = NavigationEvent { label: label.clone(), url, can_go_back, can_go_forward };
      let _ = app.emit_to(&ui, "page://navigation", event);
    }
  })
  .map_err(|error| error.to_string())?;

  // Відео на весь екран: вікно й webview змінюються одразу тут (fullscreen.rs), а інтерфейс лише дізнається.
  #[cfg(windows)]
  webview2::watch_fullscreen(&webview, {
    let (app, label) = (app.clone(), label.clone());
    move |_| {
      if let Some(page) = app.get_webview(&label) {
        crate::fullscreen::sync(&page, true);
        notify_fullscreen(&page);
      }
    }
  })
  .map_err(|error| error.to_string())?;
  // Linux: вікно на весь екран розгортає WebKit, а сайт на все вікно ставить gtk_fullscreen.rs.
  #[cfg(target_os = "linux")]
  crate::gtk_fullscreen::watch(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |fullscreen| {
      let _ = app.emit_to(&ui, "page://fullscreen", FullscreenEvent { label: label.clone(), fullscreen });
    }
  })
  .map_err(|error| error.to_string())?;

  // Звук сторінки: значок у вкладці й кнопка, що його вимикає.
  engine::watch_audio(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |playing, muted| {
      let _ = app.emit_to(&ui, "page://audio", AudioEvent { label: label.clone(), playing, muted });
    }
  })
  .map_err(|error| error.to_string())?;

  engine::watch_page_messages(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |source, message| on_page_message(&app, &ui, &label, &page_token, source, message)
  })
  .map_err(|error| error.to_string())?;

  // Ctrl+Tab і Ctrl+Shift+Tab перемикають вкладки й тоді, коли фокус у сайті.
  engine::watch_shortcuts(&webview, {
    let (app, ui, label) = (app.clone(), ui.clone(), label.clone());
    move |shortcut| {
      // Esc у повному екрані: WebView2 зараз виведе сторінку, а екран темніє ще до того (fullscreen.rs).
      #[cfg(windows)]
      if shortcut == "escape" {
        if let Some(page) = app.get_webview(&label) {
          crate::fullscreen::exit_by_key(&page);
        }
        return;
      }
      let _ = app.emit_to(&ui, "page://shortcut", ShortcutEvent { label: label.clone(), shortcut });
    }
  })
  .map_err(|error| error.to_string())?;

  // Tab з кінця сайту — назад в інтерфейс (у Linux фокус між webview і так переводить GTK).
  #[cfg(windows)]
  webview2::watch_focus_leaving(&webview).map_err(|error| error.to_string())?;

  // Завантаження: у вибрану теку (чи щоразу питати куди), а як ідуть і чим скінчилися — для кнопки
  // завантажень і сторінки «Завантаження».
  #[cfg(windows)]
  if let Some(folder) = app.state::<crate::downloads::Downloads>().folder(&app) {
    webview2::set_download_folder(&webview, folder).map_err(|error| error.to_string())?;
  }
  engine::watch_downloads(
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

  Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn page_navigate(window: Window, label: String, url: String) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let url = web_url(&url)?;
  allow_local(&label, &url);
  webview.navigate(url).map_err(|error| error.to_string())
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
  let webview = page(&window, &label)?;
  // Сайт на весь екран тримає fullscreen.rs: запізнілі межі з інтерфейсу його не зменшують.
  #[cfg(windows)]
  if crate::fullscreen::holds(&label) {
    return Ok(());
  }
  #[cfg(target_os = "linux")]
  if crate::gtk_fullscreen::holds(&label) {
    return Ok(());
  }
  place(&webview, &bounds)
}

/// Вивести сайт із повного екрана, хоч сторінка його й не покидала (інша вкладка, модальне вікно): вікно й webview —
/// як були до нього.
#[tauri::command]
#[specta::specta]
pub fn page_exit_fullscreen(window: Window, label: String) -> Result<(), String> {
  #[cfg(windows)]
  {
    crate::fullscreen::dismiss(&page(&window, &label)?);
    Ok(())
  }
  #[cfg(not(windows))]
  {
    page(&window, &label)?.eval("document.fullscreenElement && document.exitFullscreen()").map_err(|error| error.to_string())
  }
}

#[tauri::command]
#[specta::specta]
pub fn page_set_visible(window: Window, label: String, visible: bool) -> Result<(), String> {
  let webview = page(&window, &label)?;
  if !visible {
    return webview.hide().map_err(|error| error.to_string());
  }
  // Показаний сайт — над рештою сайтів вікна (під інтерфейсом). Кожен новий лягає в самий низ, тож вкладку, відкриту
  // пізніше за попередню, інакше було б видно, лише коли та сховається (інтерфейс ховає її вже після показу нової).
  #[cfg(windows)]
  for other in window.webviews().into_iter().filter(|other| other.label() != label && other.label().starts_with(PAGE_PREFIX)) {
    let _ = webview2::send_to_back(&other);
  }
  webview.show().map_err(|error| error.to_string())
}

/// Де інтерфейс вікна ловить мишу (webview2::set_input_region): поза сторінкою, а над нею — лише відкриті панелі й
/// вікна. `page: None` — увесь інтерфейс.
#[tauri::command]
#[specta::specta]
pub fn interface_set_input_region(webview: Webview, page: Option<Area>, keep: Vec<Area>) -> Result<(), String> {
  #[cfg(windows)]
  {
    let scale = webview.window().scale_factor().map_err(|error| error.to_string())?;
    webview2::set_input_region(&webview, page, keep, scale).map_err(|error| error.to_string())
  }
  #[cfg(target_os = "linux")]
  {
    crate::gtk_layers::set_input_region(&webview, page, keep).map_err(|error| error.to_string())
  }
}

#[tauri::command]
#[specta::specta]
pub fn page_set_zoom(window: Window, label: String, scale: f64) -> Result<(), String> {
  page(&window, &label)?.set_zoom(scale).map_err(|error| error.to_string())
}

/// Фокус — у сайт. З `tab` — так, ніби до нього дійшли клавішею Tab з інтерфейсу: на перший елемент сторінки
/// (`Forward`) чи останній (`Backward`), як у Chrome, а не туди, де фокус був раніше.
#[tauri::command]
#[specta::specta]
pub fn page_focus(window: Window, label: String, tab: Option<TabDirection>) -> Result<(), String> {
  let webview = page(&window, &label)?;
  match tab {
    Some(direction) => engine::focus_through_tab(&webview, direction),
    None => webview.set_focus(),
  }
  .map_err(|error| error.to_string())
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
  window.state::<crate::tracking::PageScripts>().0.lock().map_err(|error| error.to_string())?.remove(&label);
  LOCAL_PAGES.lock().map_err(|error| error.to_string())?.remove(&label);
  let Some(webview) = window.get_webview(&label) else {
    return Ok(());
  };
  // Закривають сайт на весь екран — вікно спершу повертається, яким було.
  #[cfg(windows)]
  crate::fullscreen::dismiss(&webview);
  // Сторінку, з якої ще йде завантаження, лише ховаємо до його кінця (webview2::close_page).
  #[cfg(windows)]
  return window
    .run_on_main_thread(move || {
      let _ = webview2::close_page(webview);
    })
    .map_err(|error| error.to_string());
  #[cfg(target_os = "linux")]
  crate::gtk_fullscreen::dismiss(&webview);
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
fn page_origin(webview: &Webview) -> Result<String, String> {
  let url = webview.url().map_err(|error| error.to_string())?;
  if is_web(&url) {
    Ok(url.origin().ascii_serialization())
  } else {
    Err(format!("No permissions for {url}"))
  }
}

/// Нові правила автовідтворення (audio.rs) для всіх сайтів вікна: відкритим сторінкам — одразу, новим — зі скриптом.
#[tauri::command]
#[specta::specta]
pub fn page_set_audio_rules(window: Window, rules: audio::AutoplayRules) -> Result<(), String> {
  #[cfg(windows)]
  {
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
  #[cfg(not(windows))]
  {
    // Новим сторінкам правила дає скрипт із page_open, відкритим — одразу.
    let script = audio::rules_script(&rules);
    for webview in window.webviews().into_iter().filter(|webview| webview.label().starts_with(PAGE_PREFIX)) {
      let _ = webview.eval(script.clone());
    }
    Ok(())
  }
}

#[tauri::command]
#[specta::specta]
pub async fn page_set_muted(window: Window, label: String, muted: bool) -> Result<(), String> {
  let (reply, receiver) = mpsc::channel();
  engine::set_muted(&page(&window, &label)?, muted, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Скріншот сторінки PNG: видима частина чи вся сторінка з прокруткою (`full`). Уся сторінка знімається довше,
/// тож і чекаємо довше, ніж на звичайні відповіді WebView2.
#[tauri::command]
pub async fn page_screenshot(window: Window, label: String, full: bool) -> Result<tauri::ipc::Response, String> {
  let (reply, receiver) = mpsc::channel();
  engine::screenshot(&page(&window, &label)?, full, reply).map_err(|error| error.to_string())?;
  let image = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(20)))
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())??;
  Ok(tauri::ipc::Response::new(image))
}

/// «Картинка в картинці» для відео на сторінці.
#[tauri::command]
#[specta::specta]
pub async fn page_picture_in_picture(window: Window, label: String) -> Result<PictureInPicture, String> {
  #[cfg(windows)]
  {
    let (reply, receiver) = mpsc::channel();
    webview2::picture_in_picture(&page(&window, &label)?, reply).map_err(|error| error.to_string())?;
    receive(receiver).await?
  }
  #[cfg(not(windows))]
  {
    let _ = (window, label);
    Err(unsupported())
  }
}

/// Особливе оновлення з меню кнопки «Оновити»: без кешу, з очищенням даних чи cookies сайту.
#[tauri::command]
#[specta::specta]
pub async fn page_reload_with(window: Window, label: String, mode: ReloadMode) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let url = webview.url().map_err(|error| error.to_string())?.to_string();
  let (reply, receiver) = mpsc::channel();
  engine::reload_with(&webview, mode, url, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Дозвіл сайту на автовідтворення, збережений у профілі WebView2.
#[tauri::command]
#[specta::specta]
pub async fn page_autoplay(window: Window, label: String) -> Result<Autoplay, String> {
  #[cfg(windows)]
  {
    let webview = page(&window, &label)?;
    let (reply, receiver) = mpsc::channel();
    webview2::autoplay(&webview, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
    receive(receiver).await?
  }
  #[cfg(not(windows))]
  {
    page(&window, &label)?;
    Ok(Autoplay::Default)
  }
}

/// Присипляє приховану фонову вкладку (page_events.rs, gtk_page.rs); `true` — заснула.
#[tauri::command]
#[specta::specta]
pub async fn page_suspend(window: Window, label: String) -> Result<bool, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  events::suspend(&webview, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Вкладка пішла у фон (менше пам'яті) чи стала активною.
#[tauri::command]
#[specta::specta]
pub fn page_set_background(window: Window, label: String, background: bool) -> Result<(), String> {
  #[cfg(windows)]
  {
    crate::page_events::set_background(&page(&window, &label)?, background).map_err(|error| error.to_string())
  }
  #[cfg(not(windows))]
  {
    let _ = (window, label, background);
    Ok(())
  }
}

/// Відповідь користувача на запит дозволу сайту.
#[tauri::command]
#[specta::specta]
pub fn page_permission_answer(app: AppHandle, id: u64, state: PermissionState, remember: bool) -> Result<(), String> {
  app.run_on_main_thread(move || events::answer_permission(id, state, remember)).map_err(|error| error.to_string())
}

/// Збережені дозволи сайту вкладки — для панелі дозволів.
#[tauri::command]
#[specta::specta]
pub async fn page_permissions(
  window: Window,
  label: String,
) -> Result<std::collections::HashMap<String, PermissionState>, String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  events::site_permissions(&webview, page_origin(&webview)?, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

/// Зберігає дозвіл сайту вкладки (з панелі дозволів).
#[tauri::command]
#[specta::specta]
pub async fn page_set_permission(window: Window, label: String, kind: String, state: PermissionState) -> Result<(), String> {
  let webview = page(&window, &label)?;
  let (reply, receiver) = mpsc::channel();
  events::set_site_permission(&webview, page_origin(&webview)?, kind, state, reply).map_err(|error| error.to_string())?;
  receive(receiver).await?
}

#[tauri::command]
#[specta::specta]
pub async fn page_set_autoplay(window: Window, label: String, autoplay: Autoplay) -> Result<(), String> {
  #[cfg(windows)]
  {
    let webview = page(&window, &label)?;
    let (reply, receiver) = mpsc::channel();
    webview2::set_autoplay(&webview, page_origin(&webview)?, autoplay, reply).map_err(|error| error.to_string())?;
    receive(receiver).await?
  }
  #[cfg(not(windows))]
  {
    let _ = (window, label, autoplay);
    Ok(())
  }
}

/// Що є лише в WebView2 (Windows) і чого на цій системі ще немає.
#[cfg(not(windows))]
fn unsupported() -> String {
  crate::i18n::text("На цій системі цього ще немає", "Not available on this system yet").into()
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
    assert!(web_url("view-source:javascript:alert(1)").is_err());
  }

  #[test]
  fn only_tabs_where_the_user_opened_a_file_may_open_files() {
    let url = |raw: &str| Url::parse(raw).unwrap();
    let file = url("file:///C:/Users/me/page.html");
    assert!(is_page_url(&file));
    // Сайт не відкриє файл ні переходом, ні новою вкладкою.
    assert!(!may_open("page-web-1", &file));
    assert!(may_open("page-web-1", &url("https://example.com/")));
    // Файл, відкритий користувачем, — і переходи між файлами в цій вкладці.
    allow_local("page-web-2", &file);
    assert!(may_open("page-web-2", &url("file:///C:/Users/me/other.html")));
    assert!(!may_open("page-web-1", &file));
    // Сайт, відкритий користувачем, дозволу на файли не дає.
    allow_local("page-web-3", &url("https://example.com/"));
    assert!(!may_open("page-web-3", &file));
  }
}
