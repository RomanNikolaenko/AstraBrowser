//! Типи команд і подій сторінок сайтів, спільні для всіх систем: інтерфейс отримує ті самі прив'язки (bindings.ts) на
//! Windows і Linux, а що з ними робити — вирішує код своєї системи (у Windows — webview2.rs і page_events.rs, у
//! Linux — gtk_*.rs).

use serde::{Deserialize, Serialize};

/// Дозвіл на автовідтворення: явно дозволено, заборонено чи як за замовчуванням.
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Autoplay {
  Allow,
  Block,
  Default,
}

/// Прямокутник у логічних пікселях від лівого верхнього кута вікна.
#[derive(serde::Deserialize, specta::Type)]
pub struct Area {
  pub(crate) x: f64,
  pub(crate) y: f64,
  pub(crate) width: f64,
  pub(crate) height: f64,
}

/// Особливі оновлення з меню кнопки «Оновити».
#[derive(Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ReloadMode {
  /// Повторно завантажити все, минаючи кеш.
  Hard,
  /// Сховища кешу сайту (Cache Storage) — і жорстке оновлення.
  Cache,
  /// Кеш, localStorage, sessionStorage, IndexedDB тощо — без cookies.
  SiteData,
  /// Cookies сайту (вийде з облікового запису) — і звичайне оновлення.
  Cookies,
  /// Усе разом: сховища сайту й cookies («Стерти файли cookie та дані сайту» в захисті від стеження).
  All,
}

/// Що очистити в діалозі «Очистити дані перегляду».
#[derive(Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearKinds {
  /// Cookies і сховища сайтів.
  pub site_data: bool,
  pub cache: bool,
  /// Власна історія WebView2 (історію й завантаження браузера чистить інтерфейс).
  #[cfg_attr(not(windows), allow(dead_code))]
  pub history: bool,
  /// Власне автозаповнення WebView2.
  #[cfg_attr(not(windows), allow(dead_code))]
  pub autofill: bool,
  /// Дозволи сайтів.
  pub settings: bool,
}

/// Що зробила «картинка в картинці» (є лише у WebView2).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, specta::Type)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "kebab-case")]
pub enum PictureInPicture {
  Opened,
  Closed,
  /// На сторінці немає відео.
  NoVideo,
}

/// Відповідь інтерфейсу на запит дозволу.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PermissionState {
  Allow,
  Deny,
  /// Питати щоразу (для панелі дозволів — скинути збережене).
  Ask,
}

/// Запит дозволу, який чекає відповіді інтерфейсу.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
  pub id: u64,
  pub kind: &'static str,
  pub origin: String,
  /// Запит після дії користувача (клік), а не сам собою під час завантаження.
  pub user_initiated: bool,
}

/// Що сталося з процесом сторінки.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Failure {
  /// Процес сторінки завершився (аварія, нестача пам'яті, його закрили).
  Exited,
  /// Сторінка не відповідає — може ще отямитися.
  Unresponsive,
  /// Завершився сам браузер WebView2: webview уже не відновити, лише створити новий.
  #[cfg_attr(not(windows), allow(dead_code))]
  Browser,
}
