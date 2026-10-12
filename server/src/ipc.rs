//! Команди для інтерфейсу. Аргументи, результат і типи кожної tauri-specta описує мовою TypeScript у
//! client/src/app/bindings.ts: інтерфейс кличе `commands.pageOpen(…)` з перевіркою типів, тож розбіжність між Rust
//! і Angular ловить компілятор, а не користувач. Під час `tauri dev` файл оновлюється сам, а тест нижче не дає йому
//! відстати від Rust.
//!
//! Три команди передають двійкові дані (tauri::ipc::Response чи Request), яких specta не описує: їх обслуговує
//! звичайний обробник Tauri. Список команд — без `#[cfg(windows)]` (макрос його не приймає): браузер працює лише на Windows.

use tauri::{ipc::Invoke, Wry};

use crate::{adblock, auth, browsing_data, default_browser, dns, downloads, external, favicons, fullscreen, i18n, launch, logging, pages, passwords, screenshots, suggest, sync, tracking, translate, updates, window_drag};

/// Прив'язки для інтерфейсу (оновлюються під час розробки й перевіряються тестом).
#[cfg(any(debug_assertions, test))]
const BINDINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../client/src/app/bindings.ts");

fn specta() -> tauri_specta::Builder<Wry> {
  tauri_specta::Builder::<Wry>::new()
    // Як у invoke(): помилка команди — виняток у JavaScript.
    .error_handling(tauri_specta::ErrorHandlingMode::Throw)
    // u64/i64 — розміри файлів, час (мс) і номери ревізій синхронізації: усі значно менші за 2^53, і JavaScript
    // і так отримує їх звичайними числами.
    .dangerously_cast_bigints_to_number()
    .commands(tauri_specta::collect_commands![
      pages::page_open,
      pages::page_navigate,
      pages::page_go,
      pages::page_reload,
      pages::page_set_bounds,
      pages::page_set_visible,
      pages::page_set_zoom,
      pages::page_focus,
      pages::page_print,
      pages::page_open_devtools,
      pages::page_close,
      pages::page_find,
      adblock::adblock_status,
      adblock::adblock_set_enabled,
      adblock::adblock_set_site_enabled,
      adblock::adblock_update,
      suggest::search_suggestions,
      downloads::downloads_settings,
      downloads::downloads_choose_folder,
      downloads::downloads_reset_folder,
      downloads::downloads_set_ask,
      downloads::downloads_open_folder,
      downloads::download_resolve,
      downloads::downloads_pick_folder,
      downloads::download_cancel,
      downloads::download_open,
      downloads::download_show,
      auth::auth_state,
      auth::auth_sign_in,
      auth::auth_sign_up,
      auth::auth_verify,
      auth::auth_resend,
      auth::auth_recover,
      auth::auth_reset_password,
      auth::auth_set_password,
      auth::auth_change_email,
      auth::auth_confirm_email_change,
      auth::auth_delete_account,
      auth::auth_sign_out,
      auth::auth_unlock_sync,
      auth::auth_update_name,
      auth::auth_reload_user,
      sync::sync_pull,
      sync::sync_push,
      passwords::passwords_sync_items,
      passwords::passwords_sync_apply,
      passwords::passwords_state,
      passwords::password_prompt_answer,
      passwords::password_reveal,
      passwords::password_add,
      passwords::password_edit,
      passwords::password_remove,
      passwords::passwords_never_remove,
      passwords::passwords_set_settings,
      fullscreen::window_fill_monitor,
      window_drag::window_start_drag,
      translate::translate_set_language,
      favicons::favicon_find,
      browsing_data::browsing_data_sizes,
      browsing_data::browsing_data_clear,
      pages::page_set_clip,
      pages::page_reload_with,
      pages::page_picture_in_picture,
      pages::page_set_audio_rules,
      tracking::tracking_set_rules,
      dns::dns_settings,
      dns::dns_set,
      dns::dns_restart,
      updates::app_update_check,
      updates::app_update_install,
      launch::launch_urls,
      i18n::app_set_language,
      logging::app_log_error,
      logging::app_open_logs,
      default_browser::default_browser_state,
      default_browser::default_browser_open_settings,
      external::open_external,
      external::external_app,
      pages::page_set_muted,
      pages::page_autoplay,
      pages::page_set_autoplay,
      pages::page_suspend,
      pages::page_set_background,
      pages::page_permission_answer,
      pages::page_permissions,
      pages::page_set_permission,
    ])
}

#[cfg(any(debug_assertions, test))]
fn typescript() -> specta_typescript::Typescript {
  specta_typescript::Typescript::default().header("// Згенеровано server/src/ipc.rs (tauri-specta) — не правте вручну.")
}

/// Обробник усіх команд інтерфейсу. Під час розробки ще й оновлює прив'язки.
pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
  // Обробник позичає builder до кінця роботи браузера (так влаштовано invoke_handler), тож той живе вічно — він один.
  let builder: &'static tauri_specta::Builder<Wry> = Box::leak(Box::new(specta()));
  #[cfg(debug_assertions)]
  if let Err(error) = builder.export(typescript(), BINDINGS) {
    eprintln!("Не вдалося оновити client/src/app/bindings.ts: {error}");
  }
  let typed = builder.invoke_handler();
  let binary: Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync> =
    Box::new(tauri::generate_handler![pages::page_capture, pages::page_screenshot, screenshots::file_save]);
  move |invoke| match invoke.message.command() {
    "page_capture" | "page_screenshot" | "file_save" => binary(invoke),
    _ => typed(invoke),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Без різниці між закінченнями рядків Windows і Unix.
  fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n")
  }

  /// Прив'язки відповідають Rust. Оновити їх: UPDATE_BINDINGS=1 cargo test bindings (чи просто запустити tauri dev).
  #[test]
  fn typescript_bindings_are_up_to_date() {
    let fresh = std::env::temp_dir().join(format!("astra-bindings-{}.ts", std::process::id()));
    specta().export(typescript(), &fresh).expect("прив'язки TypeScript");
    let fresh_text = std::fs::read_to_string(&fresh).expect("згенеровані прив'язки");
    let _ = std::fs::remove_file(&fresh);
    if std::env::var_os("UPDATE_BINDINGS").is_some() {
      std::fs::write(BINDINGS, &fresh_text).expect("запис прив'язок");
      return;
    }
    let committed = std::fs::read_to_string(BINDINGS).unwrap_or_default();
    assert!(
      normalized(&committed) == normalized(&fresh_text),
      "client/src/app/bindings.ts застарів: UPDATE_BINDINGS=1 cargo test bindings"
    );
  }
}
