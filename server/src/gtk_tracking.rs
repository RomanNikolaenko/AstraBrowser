//! Захист від стеження у WebKitGTK (Linux) — як webview2::block_ads і set_tracking_prevention у Windows, але фільтрами
//! вмісту WebKit, як і блокувальник реклами (gtk_adblock.rs): на кожну категорію (tracking.rs) — свій фільтр, а
//! сторінці — ті, що блокує рівень її вікна, якщо сайт не у винятках. Куки й сховища трекерів обмежує ще й вбудований
//! захист WebKit (ITP) — як вбудований захист від стеження WebView2. Сигнал Global Privacy Control — скриптом на початку
//! кожного документа (navigator.globalPrivacyControl); заголовка Sec-GPC WebKit додати не дає.
//!
//! Що саме відсікли фільтри, WebKit не каже, тож переліку заблокованого в панелі захисту на Linux немає.
//! Об'єкти WebKit — у головному потоці, і все тут теж.

use std::{
  cell::RefCell,
  collections::HashMap,
  ffi::CString,
  path::{Path, PathBuf},
};

use gtk::glib::{self, translate::ToGlibPtr};
use tauri::{AppHandle, Manager, Url, Webview, Window};
use webkit2gtk::{
  LoadEvent, UserContentInjectedFrames, UserContentManagerExt, UserScript, UserScriptInjectionTime, WebViewExt,
  WebsiteDataManagerExt,
};
use webkit2gtk_sys::{
  webkit_user_content_filter_store_load, webkit_user_content_filter_store_load_finish, webkit_user_content_filter_store_save,
  webkit_user_content_filter_store_save_finish, webkit_user_content_filter_unref, webkit_user_content_manager_add_filter,
  webkit_user_content_manager_remove_filter, webkit_user_content_manager_remove_script, WebKitUserContentFilter, WebKitUserContentManager,
};

use crate::tracking::{page_script, Category, Level, Tracking};

/// Що стоїть на сторінці: фільтри категорій і скрипт GPC (зі значенням, з яким його поставлено).
#[derive(Default)]
struct PageState {
  filters: HashMap<Category, *mut WebKitUserContentFilter>,
  gpc: Option<(bool, UserScript)>,
}

thread_local! {
  /// Скомпільовані фільтри категорій (власні посилання).
  static FILTERS: RefCell<HashMap<Category, *mut WebKitUserContentFilter>> = RefCell::new(HashMap::new());
  /// Сторінки (мітки) — що на них стоїть.
  static PAGES: RefCell<HashMap<String, PageState>> = RefCell::new(HashMap::new());
  static APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
}

/// Назва фільтра категорії в сховищі WebKit (спільному з блокувальником реклами).
fn identifier(category: Category) -> CString {
  CString::new(format!("astra-tracking-{}", category.id())).unwrap_or_default()
}

/// Фільтр категорії готовий: замість попереднього — на всі сторінки, де він стоїть. Попередній кожна сторінка
/// відпускає сама, а наше посилання на нього — слідом за ними (раз на кілька днів, коли оновлюються списки).
fn ready(category: Category, filter: *mut WebKitUserContentFilter) {
  if filter.is_null() {
    return;
  }
  let previous = FILTERS.with(|filters| filters.borrow_mut().insert(category, filter)).map_or(0, |previous| previous as usize);
  let Some(app) = APP.with(|app| app.borrow().clone()) else {
    return;
  };
  for webview in app.webviews().into_values().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX)) {
    let ui = webview.window().label().to_string();
    let label = webview.label().to_string();
    let _ = webview.with_webview(move |platform| update(&platform.inner(), &label, &ui));
  }
  // Виклики головного потоку йдуть по черзі — цей уже після сторінок.
  if previous != 0 {
    let _ = app.run_on_main_thread(move || unsafe { webkit_user_content_filter_unref(previous as *mut WebKitUserContentFilter) });
  }
}

struct Loading {
  dir: PathBuf,
  category: Category,
}

unsafe extern "C" fn loaded(source: *mut gobject_sys::GObject, result: *mut gio_sys::GAsyncResult, data: glib_sys::gpointer) {
  let loading = unsafe { Box::from_raw(data.cast::<Loading>()) };
  let mut error = std::ptr::null_mut();
  let filter = unsafe { webkit_user_content_filter_store_load_finish(source.cast(), result, &mut error) };
  if !error.is_null() {
    unsafe { glib_sys::g_error_free(error) };
  }
  if filter.is_null() {
    // У сховищі ще немає — компілюємо з правил, якщо вони вже є.
    save(&loading.dir, loading.category);
  } else {
    ready(loading.category, filter);
  }
}

unsafe extern "C" fn saved(source: *mut gobject_sys::GObject, result: *mut gio_sys::GAsyncResult, data: glib_sys::gpointer) {
  let category = unsafe { Box::from_raw(data.cast::<Category>()) };
  let mut error = std::ptr::null_mut();
  let filter = unsafe { webkit_user_content_filter_store_save_finish(source.cast(), result, &mut error) };
  if !error.is_null() {
    let message = unsafe { std::ffi::CStr::from_ptr((*error).message) }.to_string_lossy().into_owned();
    log::warn!("tracking: WebKit не скомпілював фільтр {}: {message}", category.id());
    unsafe { glib_sys::g_error_free(error) };
  }
  ready(*category, filter);
}

/// Компілює фільтр категорії з її правил (головний потік).
fn save(dir: &Path, category: Category) {
  let Ok(rules) = std::fs::read(Tracking::content_file(dir, category)) else {
    return;
  };
  let bytes = glib::Bytes::from_owned(rules);
  let data = Box::into_raw(Box::new(category)).cast();
  unsafe {
    webkit_user_content_filter_store_save(
      crate::gtk_adblock::store(dir),
      identifier(category).as_ptr(),
      bytes.to_glib_none().0,
      std::ptr::null_mut(),
      Some(saved),
      data,
    )
  };
}

/// При запуску: фільтри зі сховища WebKit (скомпільовані раніше), а яких там немає — з правил.
pub fn load(app: &AppHandle, dir: PathBuf) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    APP.with(|app| *app.borrow_mut() = Some(handle));
    for category in Category::ALL {
      let data = Box::into_raw(Box::new(Loading { dir: dir.clone(), category })).cast();
      unsafe {
        webkit_user_content_filter_store_load(
          crate::gtk_adblock::store(&dir),
          identifier(category).as_ptr(),
          std::ptr::null_mut(),
          Some(loaded),
          data,
        )
      };
    }
  });
}

/// Нові правила (оновили списки): фільтри компілюються наново й замінюють попередні.
pub fn compile(app: &AppHandle, dir: PathBuf) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    APP.with(|app| *app.borrow_mut() = Some(handle));
    for category in Category::ALL {
      save(&dir, category);
    }
  });
}

/// Сторінка `view` (мітка `label`, вікно `ui`) переходить деінде чи змінилися правила вікна: фільтри, ITP і скрипт GPC —
/// для сайту, куди вона йде.
fn update(view: &webkit2gtk::WebView, label: &str, ui: &str) {
  let Some(app) = APP.with(|app| app.borrow().clone()) else {
    return;
  };
  let Some(manager) = view.user_content_manager() else {
    return;
  };
  let manager_ptr: *mut WebKitUserContentManager = manager.to_glib_none().0;
  let rules = app.state::<Tracking>().rules(ui);
  let uri = view.uri().map(|uri| uri.to_string()).unwrap_or_default();
  let host = Url::parse(&uri).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
  let protects = rules.protects(&host);

  PAGES.with(|pages| {
    let mut pages = pages.borrow_mut();
    let page = pages.entry(label.to_string()).or_default();
    for category in Category::ALL {
      let wanted = FILTERS.with(|filters| filters.borrow().get(&category).copied()).filter(|_| protects && rules.blocks(category));
      let current = page.filters.get(&category).copied();
      if current == wanted {
        continue;
      }
      if let Some(filter) = current {
        unsafe { webkit_user_content_manager_remove_filter(manager_ptr, filter) };
        page.filters.remove(&category);
      }
      if let Some(filter) = wanted {
        unsafe { webkit_user_content_manager_add_filter(manager_ptr, filter) };
        page.filters.insert(category, filter);
      }
    }
    // GPC — для документів, що відкриються далі (поточному його ставить tracking_set_rules).
    if page.gpc.as_ref().is_none_or(|(gpc, _)| *gpc != rules.gpc) {
      if let Some((_, previous)) = page.gpc.take() {
        unsafe { webkit_user_content_manager_remove_script(manager_ptr, previous.to_glib_none().0) };
      }
      let script = UserScript::new(&page_script(rules.gpc), UserContentInjectedFrames::AllFrames, UserScriptInjectionTime::Start, &[], &[]);
      manager.add_script(&script);
      page.gpc = Some((rules.gpc, script));
    }
  });

  // Вбудований захист WebKit — на весь профіль сторінки, як і у WebView2: рівень вікна, що відкрило її останнім.
  if let Some(data) = view.website_data_manager() {
    data.set_itp_enabled(rules.level != Level::Off);
  }
}

/// Нова сторінка сайту: на кожному переході (і переадресації) — захист для нового сайту.
pub fn attach(page: &Webview) -> tauri::Result<()> {
  let label = page.label().to_string();
  let ui = page.window().label().to_string();
  page.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    update(&view, &label, &ui);
    // Сторінку закрили — її стану тут більше не треба.
    gtk::prelude::WidgetExt::connect_destroy(&view, {
      let label = label.clone();
      move |_| {
        PAGES.with(|pages| pages.borrow_mut().remove(&label));
      }
    });
    view.connect_load_changed(move |view, event| {
      if matches!(event, LoadEvent::Started | LoadEvent::Redirected) {
        update(view, &label, &ui);
      }
    });
  })
}

/// Нові правила вікна `window` — усім його сторінкам.
pub fn apply_window(window: &Window) {
  let ui = window.label().to_string();
  for webview in window.webviews().into_iter().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX)) {
    let (label, ui) = (webview.label().to_string(), ui.clone());
    let _ = webview.with_webview(move |platform| update(&platform.inner(), &label, &ui));
  }
}
