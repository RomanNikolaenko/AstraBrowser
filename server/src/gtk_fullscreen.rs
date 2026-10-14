//! Сайт на весь екран у Linux (WebKitGTK) — як fullscreen.rs у Windows, але простіше. Вікно на весь монітор
//! розгортає сам WebKit, а сайт лишився б на місці області вмісту, під панелями браузера. Тож поки сайт на весь
//! екран, його webview займає весь монітор, а інтерфейс над ним не малюється й не ловить мишу (порожня форма,
//! gtk_layers.rs). Виходить сайт сам (Esc, кнопка відео) чи його виводить інтерфейс — тоді інтерфейс отримує подію
//! й повертає сайтові його місце.
//!
//! Обробники — сигнали WebKit, тож у головному потоці; а які сторінки на весь екран, питають і команди.

use std::{
  collections::HashSet,
  rc::Rc,
  sync::{LazyLock, Mutex},
  time::{Duration, Instant},
};

use gtk::{
  gdk,
  glib::{self, Cast},
  prelude::*,
};
use tauri::{Manager, Webview};
use webkit2gtk::WebViewExt;

use crate::page_types::Area;

/// Сторінки (мітки), що зараз на весь екран.
static HELD: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Чи сторінка `label` на весь екран: тоді її межі тримає цей модуль, а не інтерфейс.
pub fn holds(label: &str) -> bool {
  HELD.lock().is_ok_and(|held| held.contains(label))
}

fn hold(label: &str, fullscreen: bool) {
  if let Ok(mut held) = HELD.lock() {
    if fullscreen {
      held.insert(label.to_string());
    } else {
      held.remove(label);
    }
  }
}

/// Повний екран сайту `page` — `report(на весь екран)`.
pub fn watch(page: &Webview, report: impl Fn(bool) + Send + 'static) -> tauri::Result<()> {
  let label = page.label().to_string();
  let interface = page.window().get_webview(page.window().label());
  page.with_webview(move |platform| {
    let view: webkit2gtk::WebView = platform.inner();
    let report = Rc::new(report);
    view.connect_enter_fullscreen({
      let (label, report) = (label.clone(), report.clone());
      move |view| {
        hold(&label, true);
        if let Some((width, height)) = monitor_size(view) {
          veil(view, move |view| view.allocated_height() >= height);
          fill(view, width, height);
          // Інтерфейс — увесь «під сайтом»: форма порожня, тож його не видно й миша йде до сайту.
          if let Some(interface) = &interface {
            let area = Area { x: 0.0, y: 0.0, width: f64::from(width), height: f64::from(height) };
            let _ = crate::gtk_layers::set_input_region(interface, Some(area), Vec::new());
          }
        }
        report(true);
        // Вікно на весь монітор розгортає сам WebKit.
        false
      }
    });
    view.connect_leave_fullscreen(move |view| {
      hold(&label, false);
      // Місце сайтові поверне інтерфейс (page_set_bounds) — завіса, доки сайт не стане меншим за монітор.
      if let Some((_, height)) = monitor_size(view) {
        veil(view, move |view| view.allocated_height() < height);
      }
      report(false);
      false
    });
  })
}

/// Назва чорної завіси серед шарів вікна.
const VEIL: &str = "astra-fullscreen-veil";
/// Як часто дивитися, чи сайт уже на новому місці, і скільки найдовше тримати завісу.
const VEIL_CHECK: Duration = Duration::from_millis(40);
const VEIL_LIMIT: Duration = Duration::from_secs(1);
/// Ще трохи після того: новий розмір сайт малює не одразу.
const VEIL_SETTLE: Duration = Duration::from_millis(120);

/// Чорна завіса над вікном, поки воно розгортається на весь екран чи повертається: вікно й сайт змінюються кількома
/// кроками, і без неї сайт смикався б між розмірами (у Windows так само ховає згасання, fullscreen.rs). Зникає, щойно
/// `settled(сайт)`, — а найпізніше за VEIL_LIMIT. Згасати, як у Windows, вона не вміє: GTK3 не робить прозорими дочірні
/// вікна.
fn veil(view: &webkit2gtk::WebView, settled: impl Fn(&webkit2gtk::WebView) -> bool + 'static) {
  let Some(veil) = veil_of(view) else {
    return;
  };
  veil.show();
  if let Some(window) = veil.window() {
    window.ensure_native();
    window.raise();
  }
  let (view, started) = (view.clone(), Instant::now());
  glib::timeout_add_local(VEIL_CHECK, move || {
    if settled(&view) || started.elapsed() >= VEIL_LIMIT {
      let veil = veil.clone();
      glib::timeout_add_local_once(VEIL_SETTLE, move || veil.hide());
      return glib::ControlFlow::Break;
    }
    glib::ControlFlow::Continue
  });
}

/// Завіса вікна сторінки `view` (над шаром сайтів і інтерфейсом, gtk_layers.rs); немає — створюється.
fn veil_of(view: &webkit2gtk::WebView) -> Option<gtk::EventBox> {
  let overlay = view.parent()?.parent()?.downcast::<gtk::Overlay>().ok()?;
  if let Some(existing) = overlay.children().into_iter().find(|child| child.widget_name() == VEIL) {
    return existing.downcast().ok();
  }
  let veil = gtk::EventBox::new();
  veil.set_widget_name(VEIL);
  veil.set_halign(gtk::Align::Fill);
  veil.set_valign(gtk::Align::Fill);
  veil.connect_draw(|_, cairo| {
    cairo.set_source_rgb(0.0, 0.0, 0.0);
    let _ = cairo.paint();
    glib::Propagation::Stop
  });
  overlay.add_overlay(&veil);
  Some(veil)
}

/// Розмір монітора, на якому вікно сторінки (логічні пікселі): таким стане вікно на весь екран.
fn monitor_size(view: &webkit2gtk::WebView) -> Option<(i32, i32)> {
  let window = view.toplevel()?.window()?;
  let monitor = window.display().monitor_at_window(&window)?;
  let geometry: gdk::Rectangle = monitor.geometry();
  Some((geometry.width(), geometry.height()))
}

/// Сайт — на все вікно: у лівий верхній кут шару сайтів (gtk_layers.rs) і розміром з монітор.
fn fill(view: &webkit2gtk::WebView, width: i32, height: i32) {
  let widget: &gtk::Widget = view.upcast_ref();
  if let Some(fixed) = widget.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) {
    fixed.move_(widget, 0, 0);
  }
  widget.set_size_request(width, height);
}

/// Сторінку закривають, поки вона на весь екран: вікно повертається, яким було (саме WebKit цього не зробить).
pub fn dismiss(page: &Webview) {
  let label = page.label().to_string();
  if !holds(&label) {
    return;
  }
  hold(&label, false);
  let _ = page.with_webview(|platform| {
    let view: webkit2gtk::WebView = platform.inner();
    if let Some(window) = view.toplevel().and_then(|toplevel| toplevel.downcast::<gtk::Window>().ok()) {
      window.unfullscreen();
    }
  });
}
