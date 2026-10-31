//! Оновлення застосунку (tauri-plugin-updater). Перевірка читає latest.json з адреси в tauri.conf.json
//! (plugins.updater.endpoints — останній реліз репозиторію на GitHub): чи є версія, новіша за цю.
//! Встановлення завантажує інсталятор, перевіряє його підпис публічним ключем із конфігу (plugins.updater.pubkey)
//! і запускає. На Windows інсталятор сам закриває застосунок і відкриває нову версію.
//!
//! Як випустити оновлення — RELEASING.md.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Знайдене оновлення — між перевіркою й встановленням.
#[derive(Default)]
pub struct Updates {
  pending: Mutex<Option<Update>>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
  /// Версія, що працює зараз.
  current: String,
  /// Новіша версія, якщо вона є.
  available: Option<AvailableUpdate>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
  version: String,
  /// Що нового (notes з latest.json).
  notes: Option<String>,
}

/// Скільки завантажено — подія `update://progress`.
#[derive(Clone, Serialize, specta::Type)]
struct Progress {
  downloaded: u64,
  total: Option<u64>,
}

/// Чи є новіша версія. Помилка — немає зв'язку чи файлу з оновленням на сервері.
#[tauri::command]
#[specta::specta]
pub async fn app_update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateState, String> {
  let current = app.package_info().version.to_string();
  let update = app
    .updater()
    .map_err(|error| error.to_string())?
    .check()
    .await
    .map_err(|error| error.to_string())
    .inspect_err(|error| log::warn!("Не вдалося перевірити оновлення: {error}"))?;
  let available = update.as_ref().map(|update| AvailableUpdate { version: update.version.clone(), notes: update.body.clone() });
  *updates.pending.lock().map_err(|_| crate::i18n::text("Оновлення недоступне.", "The update isn't available.").to_string())? =
    update;
  Ok(UpdateState { current, available })
}

/// Завантажити й встановити знайдене оновлення; застосунок закриється й відкриється вже новим.
#[tauri::command]
#[specta::specta]
pub async fn app_update_install(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
  let update = updates
    .pending
    .lock()
    .map_err(|_| crate::i18n::text("Оновлення недоступне.", "The update isn't available.").to_string())?
    .take()
    .ok_or_else(|| crate::i18n::text("Оновлень немає.", "There are no updates.").to_string())?;
  log::info!("Встановлюємо оновлення {}", update.version);
  let mut downloaded = 0;
  update
    .download_and_install(
      |chunk, total| {
        downloaded += chunk as u64;
        let _ = app.emit("update://progress", Progress { downloaded, total });
      },
      || {},
    )
    .await
    .map_err(|error| format!("{} {error}", crate::i18n::text("Не вдалося встановити оновлення:", "Couldn't install the update:")))
    .inspect_err(|error| log::error!("{error}"))?;
  app.restart()
}
