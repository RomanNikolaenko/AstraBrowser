#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod audio;
#[cfg(windows)]
mod auth;
#[cfg(windows)]
mod browsing_data;
#[cfg(windows)]
mod default_browser;
#[cfg(windows)]
mod dns;
#[cfg(windows)]
mod downloads;
mod external;
mod favicons;
#[cfg(windows)]
mod fullscreen;
mod i18n;
mod ipc;
mod launch;
mod logging;
mod pages;
#[cfg(windows)]
mod page_events;
mod screenshots;
mod suggest;
mod tracking;
mod updates;
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

/// Параметри WebView2 для кожного вікна й вебв'ю застосунку. wry за замовчуванням вимикає разом із міні-меню Edge
/// і Microsoft Defender SmartScreen (msSmartScreenProtection) — тут він лишається: захист від фішингу й шкідливих
/// завантажень (вимикається в налаштуваннях, page_events::set_smart_screen). Змінна WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
/// цього не змінила б: WebView2 об'єднує її --disable-features з параметрами wry.
///
/// Вебв'ю з одною текою даних мусять мати однакові параметри, тож ті самі — у tauri.conf.json (головне вікно) і в
/// client/src/app/shared/browser-windows/browser-windows.ts (нові вікна); тест нижче звіряє конфіг.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

fn main() {
	// Мова повідомлень Rust — як у Windows, доки інтерфейс не скаже свою (i18n.rs).
	i18n::init();
	let context = tauri::generate_context!();
	let builder = tauri::Builder::default();
	// Повторний запуск і посилання з інших програм — у вже запущений браузер (launch.rs); цей плагін — першим.
	// Лише в релізі: інакше `tauri dev` при запущеному встановленому Astra Browser (той самий ідентифікатор) не
	// запустився б, а віддав би свої аргументи йому.
	#[cfg(not(debug_assertions))]
	let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| launch::second_instance(app, args)));
	// DNS через HTTPS — у налаштування WebView2 ще до першого вікна: браузер читає їх лише під час запуску (dns.rs).
	// Плагіном одразу після single-instance: повторний запуск завершується, не чекаючи тут.
	#[cfg(windows)]
	let builder = builder.plugin(dns::plugin());
	// Інструменти розробника (feature devtools) — сайтам; інтерфейс самого браузера в релізі їх не відкриває,
	// як у Chrome. У `tauri dev` вони лишаються й для інтерфейсу.
	#[cfg(all(windows, not(debug_assertions)))]
	let builder = builder.plugin(
		tauri::plugin::Builder::<tauri::Wry>::new("ui-devtools")
			.on_webview_ready(|webview| {
				if !webview.label().starts_with(pages::PAGE_PREFIX) {
					let _ = webview2::disable_devtools(&webview);
				}
			})
			.build(),
	);
	builder
		.manage(audio::RulesScripts::default())
		.manage(adblock::AdBlock::default())
		.manage(tracking::Tracking::default())
		.manage(tracking::PageScripts::default())
		.manage(updates::Updates::default())
		.manage(launch::Launch::new(std::env::args().skip(1)))
		.plugin(logging::plugin())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		// Головне вікно відкривається там і такого розміру, як його лишили (розгорнуте чи ні).
		.plugin(
			tauri_plugin_window_state::Builder::default()
				.with_state_flags(
					tauri_plugin_window_state::StateFlags::SIZE
						| tauri_plugin_window_state::StateFlags::POSITION
						| tauri_plugin_window_state::StateFlags::MAXIMIZED,
				)
				.with_filter(|label| label == "main")
				.build(),
		)
		.setup(|app| {
			logging::log_panics();
			log::info!("Astra Browser {} запущено", app.package_info().version);
			adblock::start(app.handle());
			tracking::start(app.handle());
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
		.on_window_event(|window, event| {
			if let tauri::WindowEvent::Focused(true) = event {
				launch::focused(window);
			}
		})
		.invoke_handler(ipc::handler())
		.build(context)
		.expect("error while building Tauri application")
		.run(|_app, _event| {
			// Перезапуск браузера для нових налаштувань DNS закриває всі вікна — але не застосунок (dns.rs).
			#[cfg(windows)]
			if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &_event {
				if tauri::Manager::state::<dns::Dns>(_app).is_restarting() {
					api.prevent_exit();
				}
			}
		});
}

#[cfg(test)]
mod tests {
	/// Головне й нові вікна (tauri.conf.json, browser-windows.ts) — з тими самими параметрами WebView2, що й решта вебв'ю.
	#[test]
	fn every_window_uses_the_same_browser_arguments() {
		let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
		let windows = config.pointer("/app/windows").and_then(serde_json::Value::as_array).expect("вікна");
		for window in windows {
			assert_eq!(window.get("additionalBrowserArgs").and_then(serde_json::Value::as_str), Some(super::BROWSER_ARGS));
		}
		let client = include_str!("../../client/src/app/shared/browser-windows/browser-windows.ts");
		assert!(client.contains(&format!("const BROWSER_ARGS = '{}';", super::BROWSER_ARGS)));
	}
}
