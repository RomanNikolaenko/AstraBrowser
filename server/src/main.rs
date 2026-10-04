#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod audio;
#[cfg(windows)]
mod downloads;
#[cfg(windows)]
mod fullscreen;
mod pages;
mod screenshots;
#[cfg(windows)]
mod passwords;
#[cfg(windows)]
mod webview2;

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
				passwords::start(app.handle());
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
			pages::page_capture,
			#[cfg(windows)]
			pages::page_screenshot,
			screenshots::screenshot_save,
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
