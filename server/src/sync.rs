//! Синхронізація даних облікового запису через базу Supabase: таблиця sync_items (SQL — у supabase/sync.sql).
//!
//! Кожен запис — (колекція, id, дані, видалено, час зміни). Що саме синхронізується й як зливаються зміни, вирішує
//! інтерфейс (client/src/app/browser/sync); тут лише запити від імені користувача: забрати записи, новіші за
//! номер ревізії, і надіслати змінені. Сервер приймає запис, лише якщо він новіший за збережений (функція
//! sync_push), а відхилені повертає — інтерфейс прийме їх замість своїх.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Window};

use crate::auth::{self, AuthError, Method};

/// Скільки записів за один запит.
const PAGE: u32 = 500;

/// Рядок таблиці sync_items (supabase/sync.sql). Інші стовпці (user_id) сервер теж віддає — їх пропускаємо.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct SyncRow {
  collection: String,
  id: String,
  /// Дані запису як є (у кожної колекції свої — їх розбирає інтерфейс); null у видаленого. У TypeScript — `unknown`:
  /// сам serde_json::Value specta описати не може, бо зациклюється на його вкладеності.
  #[specta(type = specta_typescript::Unknown)]
  data: Value,
  deleted: bool,
  /// Час зміни, мс.
  updated_at: i64,
  /// Номер зміни на сервері; у записах, що лише надсилаються, його ще немає.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  revision: Option<i64>,
}

fn deny_guest(window: &Window) -> Result<(), AuthError> {
  if window.label().starts_with(crate::pages::GUEST_PREFIX) || window.label().starts_with("private-") {
    Err(AuthError::new("guest", crate::i18n::text("У гостьовому й приватному вікні синхронізації немає.", "Sync isn't available in guest and private windows.")))
  } else {
    Ok(())
  }
}

/// Записи з номером ревізії, більшим за `after`, — за порядком ревізій, не більше сторінки. `collection` — лише
/// записи цієї колекції (наприклад, паролі наново після зміни пароля облікового запису).
#[tauri::command]
#[specta::specta]
pub async fn sync_pull(app: AppHandle, window: Window, after: i64, collection: Option<String>) -> Result<Vec<SyncRow>, AuthError> {
  deny_guest(&window)?;
  auth::blocking(move || {
    let only = collection
      .filter(|name| name.chars().all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_'))
      .map(|name| format!("&collection=eq.{name}"))
      .unwrap_or_default();
    let path = format!(
      "sync_items?select=collection,id,data,deleted,updated_at,revision&revision=gt.{after}{only}&order=revision.asc&limit={PAGE}"
    );
    let rows = auth::rest(&app, || Method::Get, &path, &Value::Null)?;
    serde_json::from_value(rows).map_err(|_| AuthError::new("server", crate::i18n::text("Сервер синхронізації відповів неочікувано.", "The sync server sent an unexpected response.")))
  })
  .await
  .inspect_err(|error| log::warn!("Синхронізація (отримати): {error}"))
}

/// Змінені записи на сервер. Повертає ті, що сервер відхилив, бо в нього новіші, — з його версією.
#[tauri::command]
#[specta::specta]
pub async fn sync_push(app: AppHandle, window: Window, items: Vec<SyncRow>) -> Result<Vec<SyncRow>, AuthError> {
  deny_guest(&window)?;
  auth::blocking(move || {
    let rejected = auth::rest(&app, || Method::Post, "rpc/sync_push", &json!({ "items": items }))?;
    serde_json::from_value(rejected).map_err(|_| AuthError::new("server", crate::i18n::text("Сервер синхронізації відповів неочікувано.", "The sync server sent an unexpected response.")))
  })
  .await
  .inspect_err(|error| log::warn!("Синхронізація (надіслати): {error}"))
}
