//! Дозволи сайтів у WebKitGTK (Linux) — як page_events.rs у Windows: запит сайту (камера, мікрофон, геолокація,
//! сповіщення, буфер обміну) питає інтерфейс, а збережене рішення діє без запитання й видне в панелі дозволів сайту.
//!
//! Своїх збережених дозволів WebKitGTK не має (у Windows їх тримає профіль WebView2), тож вони тут: у файлі поряд із
//! даними сайтів облікового запису, а в приватних і гостьових вікнах — лише в пам'яті, поки працює браузер.
//! Запити WebKit живуть у головному потоці, а збережене — під м'ютексом: його читають і команди панелі дозволів.

use std::{
  cell::RefCell,
  collections::HashMap,
  fs,
  path::PathBuf,
  rc::Rc,
  sync::{
    atomic::{AtomicU64, Ordering},
    LazyLock, Mutex,
  },
};

use gtk::glib::{object::ObjectExt, Cast};
use tauri::{AppHandle, Manager, Url, Webview};
use webkit2gtk::{
  DeviceInfoPermissionRequest, GeolocationPermissionRequest, MediaKeySystemPermissionRequest, NotificationPermissionRequest,
  PermissionRequest as WebKitRequest, PermissionRequestExt, PointerLockPermissionRequest, UserMediaPermissionRequest,
  UserMediaPermissionRequestExt, WebViewExt,
};

use crate::{
  gtk_page::Reply,
  page_types::{PermissionRequest, PermissionState},
};

/// Файл дозволів у теці облікового запису.
const FILE: &str = "site-permissions.json";

/// Дозволи, про які питає браузер (назви — ті самі, що у Windows, page_events::PERMISSIONS).
const KINDS: &[&str] = &["camera", "microphone", "location", "notifications", "clipboard"];

/// Де зберігаються дозволи сторінок вікна: у файлі облікового запису чи в пам'яті приватних або гостьових вікон.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Place {
  File(PathBuf),
  Memory(&'static str),
}

/// Збережене: сайт (origin) → дозвіл → дозволено чи заборонено («питати» не зберігається).
type Sites = HashMap<String, HashMap<String, PermissionState>>;

static SAVED: LazyLock<Mutex<HashMap<Place, Sites>>> = LazyLock::new(Mutex::default);

fn place(app: &AppHandle, ui: &str) -> Option<Place> {
  if ui.starts_with("private-") {
    return Some(Place::Memory("private"));
  }
  if ui.starts_with(crate::pages::GUEST_PREFIX) {
    return Some(Place::Memory("guest"));
  }
  let dir = crate::profiles::site_data_dir(app).or_else(|| app.path().app_local_data_dir().ok())?;
  Some(Place::File(dir.join(FILE)))
}

fn place_of(webview: &Webview) -> Option<Place> {
  place(webview.app_handle(), webview.window().label())
}

/// Збережене для `place` (з диска — уперше).
fn with_sites<T>(place: &Place, use_sites: impl FnOnce(&mut Sites) -> T) -> T {
  let mut saved = SAVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let sites = saved.entry(place.clone()).or_insert_with(|| match place {
    Place::File(file) => fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default(),
    Place::Memory(_) => Sites::default(),
  });
  use_sites(sites)
}

fn write(place: &Place, sites: &Sites) {
  let Place::File(file) = place else {
    return;
  };
  let written = file
    .parent()
    .map_or(Ok(()), fs::create_dir_all)
    .and_then(|()| fs::write(file, serde_json::to_vec_pretty(sites).unwrap_or_default()));
  if let Err(error) = written {
    log::warn!("permissions: не вдалося зберегти дозволи сайтів: {error}");
  }
}

fn stored(place: &Place, origin: &str, kind: &str) -> Option<PermissionState> {
  with_sites(place, |sites| sites.get(origin)?.get(kind).copied())
}

/// Запам'ятовує рішення про дозвіл `kind` сайту `origin`; «питати» — забути збережене.
fn save(place: &Place, origin: &str, kind: &str, state: PermissionState) {
  with_sites(place, |sites| {
    let site = sites.entry(origin.to_string()).or_default();
    if state == PermissionState::Ask {
      site.remove(kind);
    } else {
      site.insert(kind.to_string(), state);
    }
    if site.is_empty() {
      sites.remove(origin);
    }
    write(place, sites);
  });
}

/// Забуває всі збережені дозволи сайтів вікна `ui` («Очистити дані перегляду» → «Дозволи сайтів»).
pub fn forget_all(app: &AppHandle, ui: &str) {
  if let Some(place) = place(app, ui) {
    with_sites(&place, |sites| {
      sites.clear();
      write(&place, sites);
    });
  }
}

// --- Запити сайтів ---

/// Запит сайту, що чекає відповіді інтерфейсу: запит WebKit, дозволи, яких він ще стосується (камеру й мікрофон
/// WebKit просить разом — інтерфейс питає про них по черзі), і кому казати.
struct Asking {
  request: WebKitRequest,
  place: Place,
  origin: String,
  kinds: Vec<&'static str>,
  report: Rc<dyn Fn(PermissionRequest)>,
}

thread_local! {
  static PENDING: RefCell<HashMap<u64, Asking>> = RefCell::new(HashMap::new());
}

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// Запити дозволів сторінки — інтерфейсу (`report`), відповідь — [`answer_permission`].
pub fn watch_permissions(webview: &Webview, report: impl Fn(PermissionRequest) + Send + 'static) -> tauri::Result<()> {
  let (app, ui) = (webview.app_handle().clone(), webview.window().label().to_string());
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let report: Rc<dyn Fn(PermissionRequest)> = Rc::new(report);
    view.connect_permission_request(move |view, request| {
      let (Some(place), Some(origin)) = (place(&app, &ui), origin_of(view)) else {
        return false;
      };
      on_request(request, place, origin, &report)
    });
  })
}

/// Origin сайту сторінки; не сайт (about:blank) — None.
fn origin_of(view: &webkit2gtk::WebView) -> Option<String> {
  let url = Url::parse(&view.uri()?).ok()?;
  matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

/// Запит сайту: `true` — вирішено чи чекає відповіді, `false` — такого дозволу браузер не дає (WebKit відмовить сам).
fn on_request(request: &WebKitRequest, place: Place, origin: String, report: &Rc<dyn Fn(PermissionRequest)>) -> bool {
  let kinds: Vec<&'static str> = if let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() {
    // Без камери й мікрофона це демонстрація екрана — її браузер не дає.
    [(media.is_for_video_device(), "camera"), (media.is_for_audio_device(), "microphone")]
      .into_iter()
      .filter_map(|(asked, kind)| asked.then_some(kind))
      .collect()
  } else if request.is::<GeolocationPermissionRequest>() {
    vec!["location"]
  } else if request.is::<NotificationPermissionRequest>() {
    vec!["notifications"]
  } else if request.type_().name() == "WebKitClipboardPermissionRequest" {
    // Читання буфера обміну (WebKitGTK 2.42): обгортка webkit2gtk цього типу не описує.
    vec!["clipboard"]
  } else if request.is::<DeviceInfoPermissionRequest>() {
    // Назви камер і мікрофонів — лише сайтам, яким дозволено хоч щось із них (як у Chromium).
    if ["camera", "microphone"].iter().any(|kind| stored(&place, &origin, kind) == Some(PermissionState::Allow)) {
      request.allow();
    } else {
      request.deny();
    }
    return true;
  } else if request.is::<PointerLockPermissionRequest>() || request.is::<MediaKeySystemPermissionRequest>() {
    // Захоплення миші (ігри) й захищене відео (DRM) Chromium дає без запитання — так само й тут.
    request.allow();
    return true;
  } else {
    return false;
  };
  if kinds.is_empty() {
    return false;
  }
  decide(Asking { request: request.clone(), place, origin, kinds, report: report.clone() });
  true
}

/// Наступний дозвіл запиту: збережене рішення діє одразу, інакше питає інтерфейс. Усе дозволено — запит дозволено,
/// хоч щось заборонено — відхилено.
fn decide(mut asking: Asking) {
  while let Some(&kind) = asking.kinds.first() {
    match stored(&asking.place, &asking.origin, kind) {
      Some(PermissionState::Allow) => {
        asking.kinds.remove(0);
      }
      Some(_) => return asking.request.deny(),
      None => {
        let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        // Чи після дії користувача, WebKit не каже.
        let event = PermissionRequest { id, kind, origin: asking.origin.clone(), user_initiated: true };
        let report = asking.report.clone();
        PENDING.with(|pending| pending.borrow_mut().insert(id, asking));
        report(event);
        return;
      }
    }
  }
  asking.request.allow();
}

/// Відповідь на запит дозволу; `remember` — запам'ятати для сайту. Викликати в головному потоці.
pub fn answer_permission(id: u64, state: PermissionState, remember: bool) {
  let Some(mut asking) = PENDING.with(|pending| pending.borrow_mut().remove(&id)) else {
    return;
  };
  let kind = asking.kinds.remove(0);
  if remember && state != PermissionState::Ask {
    save(&asking.place, &asking.origin, kind, state);
  }
  // «Питати» як відповідь — це «не цього разу».
  if state == PermissionState::Allow {
    decide(asking);
  } else {
    asking.request.deny();
  }
}

// --- Панель дозволів сайту ---

/// Збережені дозволи сайту `origin`: назва дозволу → стан (без збереженого — «питати»).
pub fn site_permissions(webview: &Webview, origin: String, reply: Reply<HashMap<String, PermissionState>>) -> tauri::Result<()> {
  let saved = place_of(webview).and_then(|place| with_sites(&place, |sites| sites.get(&origin).cloned()));
  let _ = reply.send(Ok(saved.unwrap_or_default()));
  Ok(())
}

/// Зберігає дозвіл `kind` для сайту `origin`.
pub fn set_site_permission(webview: &Webview, origin: String, kind: String, state: PermissionState, reply: Reply<()>) -> tauri::Result<()> {
  let result = match (place_of(webview), KINDS.contains(&kind.as_str())) {
    (Some(place), true) => {
      save(&place, &origin, &kind, state);
      Ok(())
    }
    _ => Err(format!("Unknown permission: {kind}")),
  };
  let _ = reply.send(result);
  Ok(())
}
