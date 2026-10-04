//! Синхронізація даних облікового запису через базу Supabase: таблиця sync_items (SQL — у supabase/sync.sql).
//!
//! Кожен запис — (колекція, id, дані, видалено, час зміни). Що саме синхронізується й як зливаються зміни, вирішує
//! інтерфейс (client/src/app/browser/sync); тут лише запити від імені користувача: забрати записи, новіші за
//! номер ревізії, і надіслати змінені. Сервер приймає запис, лише якщо він новіший за збережений (функція
//! sync_push), а відхилені повертає — інтерфейс прийме їх замість своїх.

use serde_json::{json, Value};
use tauri::{AppHandle, Window};

use crate::auth::{self, AuthError, Method};

/// Скільки записів за один запит.
const PAGE: u32 = 500;

fn deny_guest(window: &Window) -> Result<(), AuthError> {
  if window.label().starts_with(crate::pages::GUEST_PREFIX) || window.label().starts_with("private-") {
    Err(AuthError::new("guest", "У гостьовому й приватному вікні синхронізації немає."))
  } else {
    Ok(())
  }
}

/// Записи з номером ревізії, більшим за `after`, — за порядком ревізій, не більше сторінки. `collection` — лише
/// записи цієї колекції (наприклад, паролі наново після зміни пароля облікового запису).
#[tauri::command]
pub async fn sync_pull(app: AppHandle, window: Window, after: i64, collection: Option<String>) -> Result<Vec<Value>, AuthError> {
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
    Ok(rows.as_array().cloned().unwrap_or_default())
  })
  .await
}

/// Змінені записи на сервер. Повертає ті, що сервер відхилив, бо в нього новіші, — з його версією.
#[tauri::command]
pub async fn sync_push(app: AppHandle, window: Window, items: Vec<Value>) -> Result<Vec<Value>, AuthError> {
  deny_guest(&window)?;
  auth::blocking(move || {
    let rejected = auth::rest(&app, || Method::Post, "rpc/sync_push", &json!({ "items": items }))?;
    Ok(rejected.as_array().cloned().unwrap_or_default())
  })
  .await
}
