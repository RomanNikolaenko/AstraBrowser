#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod fullscreen;
mod audio;
mod pages;
#[cfg(windows)]
mod webview2;

fn main() {
	tauri::Builder::default()
		.manage(audio::RulesScripts::default())
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
			#[cfg(windows)]
			fullscreen::window_fill_monitor,
			#[cfg(windows)]
			pages::page_capture,
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
