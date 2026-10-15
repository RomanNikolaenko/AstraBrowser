//! Завантаження файлів у WebKitGTK (Linux) — як webview2::watch_downloads у Windows: файл іде в теку з налаштувань
//! (чи туди, куди скаже користувач, якщо треба питати), а як іде й чим скінчилося — для кнопки й сторінки
//! «Завантаження». Скасувати можна й посеред завантаження.
//!
//! Про завантаження WebKit повідомляє контекст сторінок (WebKitWebContext), спільний для сторінок з однією текою даних.
//! Тож обробник у контексту один, а сторінку, з якої завантажують, він знаходить за webview завантаження.
//!
//! Об'єкти WebKit живуть у головному потоці — і все тут теж.

use std::{
  cell::RefCell,
  collections::HashMap,
  path::{Path, PathBuf},
  rc::Rc,
  sync::atomic::{AtomicU64, Ordering},
  time::{Duration, Instant},
};

use gtk::glib::{
  object::{ObjectExt, ObjectType},
  subclass::signal::SignalId,
  translate::IntoGlib,
  Cast, StaticType,
};
use tauri::{AppHandle, Manager, Webview};
use webkit2gtk::{
  Download, DownloadError, DownloadExt, PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt,
  URIRequestExt, URIResponseExt, WebContextExt, WebViewExt,
};

use crate::downloads::{unused_path, DownloadRequest, DownloadUpdate, Downloads};

/// Дані GObject: сторінка на її webview і позначка контексту, до якого обробник уже під'єднано.
const PAGE_DATA: &str = "astra-downloads";
const CONTEXT_DATA: &str = "astra-downloads";

/// Про перебіг завантаження — не частіше, ніж раз на стільки (як у Windows).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Сторінка, з якої завантажують: кого питати, куди зберегти файл, і кому казати, як іде.
struct Page {
  app: AppHandle,
  ask: Box<dyn Fn(DownloadRequest) -> bool>,
  report: Rc<dyn Fn(DownloadUpdate)>,
}

/// Завантаження, що триває.
struct Running {
  download: Download,
  report: Rc<dyn Fn(DownloadUpdate)>,
  url: String,
  path: String,
  /// Коли востаннє казали про перебіг.
  reported: Instant,
}

/// Завантаження, що чекає, куди зберегти файл (resolve_download).
struct Pending {
  download: Download,
  page: Rc<Page>,
  url: String,
}

thread_local! {
  static RUNNING: RefCell<HashMap<u64, Running>> = RefCell::new(HashMap::new());
  static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new());
}

static NEXT_DOWNLOAD: AtomicU64 = AtomicU64::new(1);

/// Стежить за завантаженнями сторінки: `ask(request)` — питати, куди зберегти файл (true — завантаження чекає
/// resolve_download), `report(update)` — коли почалося, як іде й чим скінчилося.
pub fn watch_downloads(
  webview: &Webview,
  ask: impl Fn(DownloadRequest) -> bool + Send + 'static,
  report: impl Fn(DownloadUpdate) + Send + 'static,
) -> tauri::Result<()> {
  let app = webview.app_handle().clone();
  webview.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let page = Rc::new(Page { app, ask: Box::new(ask), report: Rc::new(report) });
    // Сторінка живе в даних webview — і зникає разом із ним.
    unsafe { view.set_data(PAGE_DATA, page) };
    // Файл, якого WebKit не покаже (архів, програма), — завантаження, як у Chromium: сам WebKit завантажує лише те, що
    // сервер позначив як вкладення, а решту мовчки відкидає.
    view.connect_decide_policy(|_, decision, kind| {
      let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>().filter(|_| kind == PolicyDecisionType::Response) else {
        return false;
      };
      let empty = response.response().is_some_and(|response| response.status_code() == 204);
      if response.is_mime_type_supported() || empty {
        return false;
      }
      decision.download();
      true
    });
    let Some(context) = view.context() else {
      return;
    };
    if unsafe { context.data::<bool>(CONTEXT_DATA) }.is_none() {
      unsafe { context.set_data(CONTEXT_DATA, true) };
      context.connect_download_started(|_, download| {
        // wry чіпляє на контекст свій обробник від кожної webview (і без on_download Tauri), і ті вже під'єднали
        // до завантаження свій вибір місця — у поточну теку процесу. Вирішуємо лише ми.
        disconnect_all(download, "decide-destination");
        download.connect_decide_destination(decide);
      });
    }
  })
}

/// Від'єднує від `object` усі обробники сигналу `signal`.
fn disconnect_all(object: &Download, signal: &str) {
  let Some(id) = SignalId::lookup(signal, Download::static_type()) else {
    return;
  };
  unsafe {
    gobject_sys::g_signal_handlers_disconnect_matched(
      object.as_ptr().cast(),
      gobject_sys::G_SIGNAL_MATCH_ID,
      id.into_glib(),
      0,
      std::ptr::null_mut(),
      std::ptr::null_mut(),
      std::ptr::null_mut(),
    );
  }
}

fn page_of(download: &Download) -> Option<Rc<Page>> {
  let view = download.web_view()?;
  let page = unsafe { view.data::<Rc<Page>>(PAGE_DATA) }?;
  Some(unsafe { page.as_ref() }.clone())
}

/// Куди зберегти файл: у теку з налаштувань — одразу чи після відповіді інтерфейсу. `true` — вирішуємо ми (зараз чи
/// згодом), `false` — завантаження не зі сторінки сайту, і вирішує сам WebKit.
fn decide(download: &Download, suggested: &str) -> bool {
  let Some(page) = page_of(download) else {
    return false;
  };
  let Some(folder) = page.app.state::<Downloads>().folder(&page.app) else {
    return false;
  };
  // ~/Downloads може ще не бути.
  let _ = std::fs::create_dir_all(&folder);
  let url = download.request().and_then(|request| request.uri()).map(String::from).unwrap_or_default();
  // Файл із такою назвою вже є — інтерфейс спитає, замінити його чи зберегти обидва (downloads::ask_where); без
  // запитання — вільна назва поряд.
  let wanted = folder.join(file_name(suggested));
  let id = NEXT_DOWNLOAD.fetch_add(1, Ordering::Relaxed);
  if (page.ask)(DownloadRequest { id, url: url.clone(), path: wanted.clone(), total: total(download) }) {
    PENDING.with(|pending| pending.borrow_mut().insert(id, Pending { download: download.clone(), page, url }));
  } else {
    begin(id, download, &page.report, url, &unused_path(&wanted), false);
  }
  true
}

/// Назва файла з тієї, що пропонує WebKit: без шляху. Для data: без назви WebKit пропонує самі дані — тоді «download».
fn file_name(suggested: &str) -> String {
  let name = suggested.replace('/', "_");
  let name = name.trim();
  if name.is_empty() || name.len() > 200 || name.chars().all(|char| char == '.') {
    "download".into()
  } else {
    name.to_string()
  }
}

/// Розмір файла, якщо сервер його назвав; 0 — невідомий.
fn total(download: &Download) -> i64 {
  download.response().map_or(0, |response| i64::try_from(response.content_length()).unwrap_or(0))
}

/// Завантаження йде у файл `path`: відтепер про нього знає інтерфейс. `replace` — файл, що там уже є, замінити.
fn begin(id: u64, download: &Download, report: &Rc<dyn Fn(DownloadUpdate)>, url: String, path: &Path, replace: bool) {
  let path = path.to_string_lossy().into_owned();
  let running = Running { download: download.clone(), report: report.clone(), url, path: path.clone(), reported: Instant::now() };
  RUNNING.with(|downloads| downloads.borrow_mut().insert(id, running));
  download.connect_received_data(move |_, _| progress(id, false));
  // Після failed WebKit шле ще й finished — тож кінець каже той, хто перший (finish).
  download.connect_failed(move |_, error| finish(id, if error.matches(DownloadError::CancelledByUser) { "canceled" } else { "failed" }));
  download.connect_finished(move |_| finish(id, "completed"));
  progress(id, true);
  download.set_allow_overwrite(replace);
  download.set_destination(&path);
}

fn update(id: u64, running: &Running, state: &'static str) -> DownloadUpdate {
  DownloadUpdate {
    id,
    url: running.url.clone(),
    path: running.path.clone(),
    received: i64::try_from(running.download.received_data_length()).unwrap_or(i64::MAX),
    total: total(&running.download),
    state,
  }
}

/// Як іде завантаження — інтерфейсу; `now` — не зважаючи на PROGRESS_INTERVAL.
fn progress(id: u64, now: bool) {
  let Some((report, update)) = RUNNING.with(|downloads| {
    let mut downloads = downloads.borrow_mut();
    let running = downloads.get_mut(&id)?;
    if !now && running.reported.elapsed() < PROGRESS_INTERVAL {
      return None;
    }
    running.reported = Instant::now();
    Some((running.report.clone(), update(id, running, "in-progress")))
  }) else {
    return;
  };
  report(update);
}

/// Прибирає завантаження зі списку тих, що тривають, і каже, чим воно скінчилося, — один раз.
fn finish(id: u64, state: &'static str) {
  let Some(running) = RUNNING.with(|downloads| downloads.borrow_mut().remove(&id)) else {
    return;
  };
  (running.report)(update(id, &running, state));
}

/// Користувач вибрав, куди зберегти файл, чи передумав (None — завантаження скасовується); `replace` — файл, що там уже
/// є, замінити. Лише в головному потоці.
pub fn resolve_download(id: u64, path: Option<PathBuf>, replace: bool) {
  let Some(pending) = PENDING.with(|downloads| downloads.borrow_mut().remove(&id)) else {
    return;
  };
  match path {
    Some(path) => begin(id, &pending.download, &pending.page.report, pending.url, &path, replace),
    None => pending.download.cancel(),
  }
}

/// Скасовує завантаження, що ще триває. Лише в головному потоці.
pub fn cancel_download(id: u64) {
  // Об'єкт — поза позикою: cancel може одразу викликати failed, а той прибирає завантаження зі списку.
  let download = RUNNING.with(|downloads| downloads.borrow().get(&id).map(|running| running.download.clone()));
  if let Some(download) = download {
    download.cancel();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keeps_suggested_names_inside_the_folder() {
    assert_eq!(file_name("звіт.pdf"), "звіт.pdf");
    assert_eq!(file_name("../../.bashrc"), ".._.._.bashrc");
    assert_eq!(file_name(" "), "download");
    assert_eq!(file_name(".."), "download");
    assert_eq!(file_name(&"a".repeat(300)), "download");
  }
}
