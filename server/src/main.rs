#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod audio;
#[cfg(windows)]
mod auth;
#[cfg(windows)]
mod browsing_data;
#[cfg(windows)]
mod downloads;
mod favicons;
#[cfg(windows)]
mod fullscreen;
mod pages;
mod screenshots;
#[cfg(windows)]
mod passwords;
#[cfg(windows)]
mod profiles;
#[cfg(windows)]
mod secure;
#[cfg(windows)]
mod sync;
#[cfg(windows)]
mod translate;
#[cfg(windows)]
mod webview2;
#[cfg(windows)]
mod window_drag;

fn main() {
	tauri::Builder::default()
		.manage(audio::RulesScripts::default())
		.manage(adblock::AdBlock::default())
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			adblock::start(app.handle());
			#[cfg(windows)]
			{
				tauri::Manager::manage(app, downloads::Downloads::default());
				downloads::start(app.handle());
				tauri::Manager::manage(app, passwords::Passwords::default());
				tauri::Manager::manage(app, auth::Auth::default());
				auth::start(app.handle());
			}
			Ok(())
		})
		.on_page_load(pages::close_orphans)
		.invoke_handler(tauri::generate_handler![
			pages::page_open,
			pages::page_navigate,
			pages::page_go,
			pages::page_reload,
			pages::page_set_bounds,
			pages::page_set_visible,
			pages::page_set_zoom,
			pages::page_focus,
			pages::page_print,
			pages::page_close,
			pages::page_find,
			adblock::adblock_status,
			adblock::adblock_set_enabled,
			adblock::adblock_set_site_enabled,
			adblock::adblock_update,
			#[cfg(windows)]
			downloads::downloads_settings,
			#[cfg(windows)]
			downloads::downloads_choose_folder,
			#[cfg(windows)]
			downloads::downloads_reset_folder,
			#[cfg(windows)]
			downloads::downloads_set_ask,
			#[cfg(windows)]
			downloads::downloads_open_folder,
			#[cfg(windows)]
			downloads::download_resolve,
			#[cfg(windows)]
			downloads::downloads_pick_folder,
			#[cfg(windows)]
			downloads::download_cancel,
			#[cfg(windows)]
			downloads::download_open,
			#[cfg(windows)]
			downloads::download_show,
			#[cfg(windows)]
			auth::auth_state,
			#[cfg(windows)]
			auth::auth_sign_in,
			#[cfg(windows)]
			auth::auth_sign_up,
			#[cfg(windows)]
			auth::auth_verify,
			#[cfg(windows)]
			auth::auth_resend,
			#[cfg(windows)]
			auth::auth_recover,
			#[cfg(windows)]
			auth::auth_reset_password,
			#[cfg(windows)]
			auth::auth_set_password,
			#[cfg(windows)]
			auth::auth_sign_out,
			#[cfg(windows)]
			auth::auth_unlock_sync,
			#[cfg(windows)]
			auth::auth_update_name,
			#[cfg(windows)]
			auth::auth_reload_user,
			#[cfg(windows)]
			sync::sync_pull,
			#[cfg(windows)]
			sync::sync_push,
			#[cfg(windows)]
			passwords::passwords_sync_items,
			#[cfg(windows)]
			passwords::passwords_sync_apply,
			#[cfg(windows)]
			passwords::passwords_state,
			#[cfg(windows)]
			passwords::password_prompt_answer,
			#[cfg(windows)]
			passwords::password_reveal,
			#[cfg(windows)]
			passwords::password_add,
			#[cfg(windows)]
			passwords::password_edit,
			#[cfg(windows)]
			passwords::password_remove,
			#[cfg(windows)]
			passwords::passwords_never_remove,
			#[cfg(windows)]
			passwords::passwords_set_settings,
			#[cfg(windows)]
			fullscreen::window_fill_monitor,
			#[cfg(windows)]
			window_drag::window_start_drag,
			#[cfg(windows)]
			translate::translate_set_language,
			#[cfg(windows)]
			pages::page_capture,
			#[cfg(windows)]
			pages::page_screenshot,
			screenshots::file_save,
			favicons::favicon_find,
			#[cfg(windows)]
			browsing_data::browsing_data_sizes,
			#[cfg(windows)]
			browsing_data::browsing_data_clear,
			#[cfg(windows)]
			pages::page_set_clip,
			#[cfg(windows)]
			pages::page_reload_with,
			#[cfg(windows)]
			pages::page_picture_in_picture,
			#[cfg(windows)]
			pages::page_set_audio_rules,
			#[cfg(windows)]
			pages::page_set_muted,
			#[cfg(windows)]
			pages::page_autoplay,
			#[cfg(windows)]
			pages::page_set_autoplay,
		])
		.run(tauri::generate_context!())
		.expect("error while running Tauri application");
}
