//! Блокувальник реклами на Linux (WebKitGTK). Запитів сторінки, як WebView2 у Windows, WebKitGTK застосункові не
//! показує, зате сам виконує фільтри вмісту — правила у форматі блокувальників Safari. adblock.rs перекладає в нього
//! мережеві правила списків (CONTENT_FILE), WebKit компілює їх і кешує в теці застосунку, а тут фільтр під'єднується
//! до кожної сторінки — крім сайтів, де блокувальник вимкнено. Рекламні блоки й скриптлети uBlock Origin — той самий
//! скрипт сторінки, що й у Windows (AdBlock::page_script), скриптом WebKit на початку документа.
//!
//! Фільтр і скрипти — об'єкти WebKit, тож усе тут — у головному потоці.

use std::{
  cell::{Cell, RefCell},
  collections::{HashMap, HashSet},
  ffi::CString,
  path::PathBuf,
};

use gtk::glib::{self, translate::ToGlibPtr};
use tauri::{AppHandle, Manager, Url, Webview};
use webkit2gtk::{LoadEvent, UserContentInjectedFrames, UserContentManagerExt, UserScript, UserScriptInjectionTime, WebViewExt};
use webkit2gtk_sys::{
  webkit_user_content_filter_store_load, webkit_user_content_filter_store_load_finish, webkit_user_content_filter_store_new,
  webkit_user_content_filter_store_save, webkit_user_content_filter_store_save_finish,
  webkit_user_content_filter_unref, webkit_user_content_manager_add_filter, webkit_user_content_manager_remove_filter,
  webkit_user_content_manager_remove_script, WebKitUserContentFilter, WebKitUserContentFilterStore,
};

use crate::adblock::{AdBlock, CONTENT_FILE};

/// Назва фільтра в сховищі WebKit.
const IDENTIFIER: &str = "astra-adblock";
/// Тека сховища скомпільованих фільтрів (у теці даних застосунку).
const STORE_DIR: &str = "content-filters";

thread_local! {
  /// Скомпільований фільтр (власне посилання); нуль — ще не готовий.
  static FILTER: Cell<*mut WebKitUserContentFilter> = const { Cell::new(std::ptr::null_mut()) };
  /// Сховище фільтрів: живе, доки йде збереження чи завантаження.
  static STORE: Cell<*mut WebKitUserContentFilterStore> = const { Cell::new(std::ptr::null_mut()) };
  /// Сторінки (мітки), у яких фільтр зараз є.
  static FILTERED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
  /// Скрипт блокувальника сторінки — за міткою: на наступній сторінці замінюється.
  static SCRIPTS: RefCell<HashMap<String, UserScript>> = RefCell::new(HashMap::new());
  /// Застосунок — для колбеків WebKit.
  static APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
}

pub(crate) fn store(dir: &std::path::Path) -> *mut WebKitUserContentFilterStore {
  STORE.with(|store| {
    if store.get().is_null() {
      let path = CString::new(dir.join(STORE_DIR).to_string_lossy().into_owned()).unwrap_or_default();
      store.set(unsafe { webkit_user_content_filter_store_new(path.as_ptr()) });
    }
    store.get()
  })
}

/// Фільтр готовий: замість попереднього — в усі сторінки, де блокувальник діє. Попередній фільтр сторінки відпускають
/// самі, а наше посилання на нього — слідом за ними (раз на кілька днів, коли оновлюються списки): скомпільований фільтр
/// важить мегабайти.
fn ready(filter: *mut WebKitUserContentFilter) {
  if filter.is_null() {
    return;
  }
  let previous = FILTER.with(|current| current.replace(filter)) as usize;
  let Some(app) = APP.with(|app| app.borrow().clone()) else {
    return;
  };
  for webview in app.webviews().into_values().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX)) {
    let label = webview.label().to_string();
    let _ = webview.with_webview(move |platform| {
      let view: webkit2gtk::WebView = platform.inner();
      let Some(manager) = view.user_content_manager() else {
        return;
      };
      let manager_ptr: *mut webkit2gtk_sys::WebKitUserContentManager = manager.to_glib_none().0;
      FILTERED.with(|filtered| {
        if filtered.borrow_mut().remove(&label) && previous != 0 {
          unsafe { webkit_user_content_manager_remove_filter(manager_ptr, previous as *mut WebKitUserContentFilter) };
        }
      });
      update(&view, &label);
    });
  }
  // Виклики головного потоку йдуть по черзі — цей уже після сторінок.
  if previous != 0 {
    let _ = app.run_on_main_thread(move || unsafe { webkit_user_content_filter_unref(previous as *mut WebKitUserContentFilter) });
  }
  log::info!("adblock: фільтр WebKit готовий");
}

unsafe extern "C" fn loaded(source: *mut gobject_sys::GObject, result: *mut gio_sys::GAsyncResult, data: glib_sys::gpointer) {
  let dir = unsafe { Box::from_raw(data.cast::<PathBuf>()) };
  let mut error = std::ptr::null_mut();
  let filter = unsafe { webkit_user_content_filter_store_load_finish(source.cast(), result, &mut error) };
  if !error.is_null() {
    unsafe { glib_sys::g_error_free(error) };
  }
  if filter.is_null() {
    // У сховищі ще немає — компілюємо з правил, якщо вони вже є.
    if dir.join(CONTENT_FILE).exists() {
      save(&dir);
    }
  } else {
    ready(filter);
  }
}

unsafe extern "C" fn saved(source: *mut gobject_sys::GObject, result: *mut gio_sys::GAsyncResult, _data: glib_sys::gpointer) {
  let mut error = std::ptr::null_mut();
  let filter = unsafe { webkit_user_content_filter_store_save_finish(source.cast(), result, &mut error) };
  if !error.is_null() {
    let message = unsafe { std::ffi::CStr::from_ptr((*error).message) }.to_string_lossy().into_owned();
    log::warn!("adblock: WebKit не скомпілював фільтр: {message}");
    unsafe { glib_sys::g_error_free(error) };
  }
  ready(filter);
}

/// Компілює фільтр із правил CONTENT_FILE (головний потік).
fn save(dir: &std::path::Path) {
  let Ok(rules) = std::fs::read(dir.join(CONTENT_FILE)) else {
    return;
  };
  let bytes = glib::Bytes::from_owned(rules);
  let identifier = CString::new(IDENTIFIER).unwrap_or_default();
  unsafe {
    webkit_user_content_filter_store_save(
      store(dir),
      identifier.as_ptr(),
      bytes.to_glib_none().0,
      std::ptr::null_mut(),
      Some(saved),
      std::ptr::null_mut(),
    )
  };
}

/// При запуску: фільтр зі сховища WebKit (скомпільований раніше), а якщо його там немає — з правил.
pub fn load(app: &AppHandle, dir: PathBuf) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    APP.with(|app| *app.borrow_mut() = Some(handle));
    let identifier = CString::new(IDENTIFIER).unwrap_or_default();
    let data = Box::into_raw(Box::new(dir.clone())).cast();
    unsafe { webkit_user_content_filter_store_load(store(&dir), identifier.as_ptr(), std::ptr::null_mut(), Some(loaded), data) };
  });
}

/// Нові правила (оновили списки): фільтр компілюється наново й замінює попередній.
pub fn compile(app: &AppHandle, dir: PathBuf) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    APP.with(|app| *app.borrow_mut() = Some(handle));
    save(&dir);
  });
}

/// Сторінка `view` (мітка `label`) переходить деінде: фільтр і скрипт блокувальника — для сайту, куди вона йде.
fn update(view: &webkit2gtk::WebView, label: &str) {
  let Some(app) = APP.with(|app| app.borrow().clone()) else {
    return;
  };
  let Some(manager) = view.user_content_manager() else {
    return;
  };
  let manager_ptr: *mut webkit2gtk_sys::WebKitUserContentManager = manager.to_glib_none().0;
  let uri = view.uri().map(|uri| uri.to_string()).unwrap_or_default();
  let host = Url::parse(&uri).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
  let adblock = app.state::<AdBlock>();
  let active = adblock.active_on(&host);

  let filter = FILTER.with(Cell::get);
  if !filter.is_null() {
    FILTERED.with(|filtered| {
      let mut filtered = filtered.borrow_mut();
      if active && filtered.insert(label.to_string()) {
        unsafe { webkit_user_content_manager_add_filter(manager_ptr, filter) };
      } else if !active && filtered.remove(label) {
        unsafe { webkit_user_content_manager_remove_filter(manager_ptr, filter) };
      }
    });
  }

  SCRIPTS.with(|scripts| {
    let mut scripts = scripts.borrow_mut();
    if let Some(previous) = scripts.remove(label) {
      unsafe { webkit_user_content_manager_remove_script(manager_ptr, previous.to_glib_none().0) };
    }
    if let Some(source) = adblock.page_script(&uri) {
      let script = UserScript::new(&source, UserContentInjectedFrames::TopFrame, UserScriptInjectionTime::Start, &[], &[]);
      manager.add_script(&script);
      scripts.insert(label.to_string(), script);
    }
  });
}

/// Нова сторінка сайту: на кожному переході (і переадресації) — фільтр і скрипт блокувальника для нового сайту.
pub fn attach(page: &Webview) -> tauri::Result<()> {
  let label = page.label().to_string();
  page.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    update(&view, &label);
    // Сторінку закрили — її скрипт блокувальника (буває й на сотні кілобайтів) і позначка фільтра тут більше не потрібні.
    gtk::prelude::WidgetExt::connect_destroy(&view, {
      let label = label.clone();
      move |_| {
        FILTERED.with(|filtered| filtered.borrow_mut().remove(&label));
        SCRIPTS.with(|scripts| scripts.borrow_mut().remove(&label));
      }
    });
    view.connect_load_changed(move |view, event| {
      if matches!(event, LoadEvent::Started | LoadEvent::Redirected) {
        update(view, &label);
      }
    });
  })
}
