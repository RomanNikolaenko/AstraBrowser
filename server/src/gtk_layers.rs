//! Сайти під інтерфейсом у вікні GTK (Linux) — як у Windows (webview2::send_to_back, set_input_region).
//!
//! Tauri на Linux кладе всі webview вікна стовпчиком у його GtkBox, тож сайт став би під інтерфейсом, а не на місці
//! області вмісту. Тут вікно перебудовується: у GtkBox — GtkOverlay, у ньому знизу GtkFixed із сайтами на їхніх
//! місцях, а над ними — інтерфейс на весь розмір. Прозорість тут не допоможе: GTK3 не змішує дочірні вікна, кожен
//! піксель — одного з них. Тож інтерфейс обрізається формою: над сайтом його немає, крім відкритих панелей і меню, —
//! там він і малюється, і ловить мишу, а решту бачить і отримує сайт під ним. Форму малювання GDK3 застосовує лише до
//! рідних вікон X11 (XShape), тож вікна інтерфейсу стають рідними, а GTK працює через X11 (main.rs; у сеансі Wayland —
//! через XWayland).
//!
//! Усе тут — у головному потоці (with_webview): віджети GTK між потоками не передаються.

use gtk::{cairo, gdk, glib::Cast, prelude::*};
use tauri::Webview;

use crate::page_types::Area;

/// Шари вікна, у якому інтерфейс `interface`: GtkFixed для сайтів (перебудовує вікно, якщо ще не перебудоване).
fn layers(interface: &gtk::Widget) -> Option<gtk::Fixed> {
  let parent = interface.parent()?;
  if let Some(overlay) = parent.downcast_ref::<gtk::Overlay>() {
    return overlay.child()?.downcast::<gtk::Fixed>().ok();
  }
  let vbox = parent.downcast::<gtk::Box>().ok()?;
  let overlay = gtk::Overlay::new();
  let fixed = gtk::Fixed::new();
  overlay.add(&fixed);
  vbox.remove(interface);
  overlay.add_overlay(interface);
  interface.set_halign(gtk::Align::Fill);
  interface.set_valign(gtk::Align::Fill);
  vbox.pack_start(&overlay, true, true, 0);
  overlay.show_all();
  Some(fixed)
}

/// Шар для сайту `page`: GtkFixed, у якому він уже є, чи той, що в GtkBox його вікна (вікно перебудовується, якщо
/// ще не перебудоване: інтерфейс — перший webview вікна, сайти Tauri додає після нього).
fn fixed_for(page: &gtk::Widget) -> Option<gtk::Fixed> {
  let parent = page.parent()?;
  if let Ok(fixed) = parent.clone().downcast::<gtk::Fixed>() {
    return Some(fixed);
  }
  let children = parent.downcast::<gtk::Box>().ok()?.children();
  if let Some(overlay) = children.iter().find_map(|child| child.clone().downcast::<gtk::Overlay>().ok()) {
    return overlay.child()?.downcast::<gtk::Fixed>().ok();
  }
  let interface = children.into_iter().find(|child| child != page && child.is::<webkit2gtk::WebView>())?;
  layers(&interface)
}

/// Сайт — у шар під інтерфейсом, на місце `bounds` (логічні пікселі вікна).
pub fn adopt(page: &Webview, bounds: Area) -> tauri::Result<()> {
  page.with_webview(move |platform| {
    let view: gtk::Widget = platform.inner().upcast();
    let Some(fixed) = fixed_for(&view) else {
      log::warn!("gtk_layers: немає шару для сайту (батько — {:?})", view.parent().map(|parent| parent.type_().name()));
      return;
    };
    if view.parent().as_ref() != Some(fixed.upcast_ref::<gtk::Widget>()) {
      if let Some(parent) = view.parent().and_then(|parent| parent.downcast::<gtk::Container>().ok()) {
        parent.remove(&view);
      }
      fixed.put(&view, 0, 0);
    }
    move_to(&fixed, &view, &bounds);
  })
}

/// Нове місце сайту в шарі під інтерфейсом.
pub fn place(page: &Webview, bounds: Area) -> tauri::Result<()> {
  page.with_webview(move |platform| {
    let view: gtk::Widget = platform.inner().upcast();
    if let Some(fixed) = view.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) {
      move_to(&fixed, &view, &bounds);
    }
  })
}

fn move_to(fixed: &gtk::Fixed, view: &gtk::Widget, bounds: &Area) {
  fixed.move_(view, bounds.x.round() as i32, bounds.y.round() as i32);
  view.set_size_request(bounds.width.round().max(1.0) as i32, bounds.height.round().max(1.0) as i32);
}

fn rectangle(area: &Area) -> cairo::RectangleInt {
  cairo::RectangleInt::new(area.x.floor() as i32, area.y.floor() as i32, area.width.ceil() as i32, area.height.ceil() as i32)
}

/// Заокруглення кутів панелей і вікон над сайтом (як у інтерфейсі, ~0.75–1.25rem), px.
const CORNER: f64 = 14.0;
/// Крок сходинок, якими заокруглюються кути: форма GDK — лише з прямокутників.
const STEP: i32 = 2;

/// Прямокутник із заокругленими кутами — сходинками по `STEP` пікселів: кути панелей не затуляють сайт квадратом.
fn rounded(area: &Area) -> cairo::Region {
  let outer = rectangle(area);
  let (x, y, width, height) = (outer.x(), outer.y(), outer.width(), outer.height());
  let radius = CORNER.min(f64::from(width.min(height)) / 2.0) as i32;
  let region = cairo::Region::create_rectangle(&cairo::RectangleInt::new(x, y + radius, width, (height - 2 * radius).max(0)));
  let mut row = 0;
  while row < radius {
    // Відступ від краю на висоті рядка: коло радіуса radius.
    let from_center = f64::from(radius) - f64::from(row) - f64::from(STEP) / 2.0;
    let inset = (f64::from(radius) - (f64::from(radius).powi(2) - from_center.powi(2)).max(0.0).sqrt()).round() as i32;
    let band = STEP.min(radius - row);
    for top in [y + row, y + height - row - band] {
      let _ = region.union_rectangle(&cairo::RectangleInt::new(x + inset, top, (width - 2 * inset).max(0), band));
    }
    row += STEP;
  }
  region
}

/// Де інтерфейс є (малюється й ловить мишу): усюди, крім сайту `page`, а над ним — лише `keep` (панелі й меню).
/// `None` — увесь.
pub fn set_input_region(interface: &Webview, page: Option<Area>, keep: Vec<Area>) -> tauri::Result<()> {
  interface.with_webview(move |platform| {
    let view: gtk::Widget = platform.inner().upcast();
    let allocation = view.allocation();
    let region = cairo::Region::create_rectangle(&cairo::RectangleInt::new(0, 0, allocation.width(), allocation.height()));
    if let Some(page) = &page {
      let _ = region.subtract_rectangle(&rectangle(page));
      for area in &keep {
        let _ = region.union(&rounded(area));
      }
    }
    // Форма — і вікну самого webview, і вікнам над ним аж до вікна верхнього рівня (вікно дочірнього шару GtkOverlay):
    // інакше там, де webview немає, лишалися б вони — і затуляли б сайт, і забирали б його кліки. Вікна — рідні: форму
    // малювання GDK3 застосовує лише до них.
    let mut window = view.window();
    while let Some(current) = window {
      if current.window_type() == gdk::WindowType::Toplevel {
        break;
      }
      current.ensure_native();
      current.shape_combine_region(Some(&region), 0, 0);
      current.input_shape_combine_region(&region, 0, 0);
      window = current.parent();
    }
  })
}
