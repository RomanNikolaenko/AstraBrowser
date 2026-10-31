#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Astra Browser — для Windows і Linux.
#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("Astra Browser збирається лише для Windows і Linux");

mod adblock;
mod addresses;
mod audio;
mod auth;
mod browsing_data;
mod context_menu;
// Лише для розробки в Linux: скрипт із файла — в інтерфейс (debug_eval.rs).
mod cards;
#[cfg(all(debug_assertions, not(windows)))]
mod debug_eval;
mod default_browser;
mod dns;
// Linux: DNS через HTTPS — проксі в самому браузері.
#[cfg(target_os = "linux")]
mod doh_proxy;
mod downloads;
mod external;
mod favicons;
// Linux: сторінки сайтів у WebKitGTK (події, дозволи, завантаження, блокувальник реклами) і сайти під інтерфейсом
// у вікні GTK.
#[cfg(target_os = "linux")]
mod gtk_adblock;
#[cfg(target_os = "linux")]
mod gtk_downloads;
#[cfg(target_os = "linux")]
mod gtk_fullscreen;
#[cfg(target_os = "linux")]
mod gtk_layers;
#[cfg(target_os = "linux")]
mod gtk_page;
#[cfg(target_os = "linux")]
mod gtk_permissions;
#[cfg(target_os = "linux")]
mod gtk_tracking;
// Повний екран сайту з затемненням, перетягування вікна й Windows Hello — засобами Windows; у Linux — свої, простіші
// варіанти (src/other), а підтвердження особи — через polkit (polkit.rs).
#[cfg_attr(not(windows), path = "other/fullscreen.rs")]
mod fullscreen;
#[cfg_attr(target_os = "linux", path = "polkit.rs")]
mod hello;
mod i18n;
mod ipc;
mod launch;
mod logging;
mod page_bridge;
#[cfg(windows)]
mod page_events;
mod page_types;
mod pages;
mod passwords;
mod profiles;
mod screenshots;
mod secure;
mod suggest;
mod sync;
mod tracking;
mod translate;
mod updates;
#[cfg(windows)]
mod webview2;
#[cfg_attr(not(windows), path = "other/window_drag.rs")]
mod window_drag;
mod window_size;

/// Параметри WebView2 для кожного вікна й вебв'ю застосунку. wry за замовчуванням вимикає разом із міні-меню Edge
/// і Microsoft Defender SmartScreen (msSmartScreenProtection) — тут він лишається: захист від фішингу й шкідливих
/// завантажень (вимикається в налаштуваннях, page_events::set_smart_screen). Змінна WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
/// цього не змінила б: WebView2 об'єднує її --disable-features з параметрами wry.
///
/// Вебв'ю з одною текою даних мусять мати однакові параметри, тож ті самі — у tauri.conf.json (головне вікно) і в
/// client/src/app/shared/browser-windows/browser-windows.ts (нові вікна); тест нижче звіряє конфіг.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

fn main() {
  // Linux: GTK через X11 (у сеансі Wayland — XWayland), якщо людина не вибрала іншого: форма вікон, якою інтерфейс
  // стоїть над сайтом (gtk_layers.rs), працює лише в X11.
  #[cfg(target_os = "linux")]
  if std::env::var_os("GDK_BACKEND").is_none() {
    std::env::set_var("GDK_BACKEND", "x11");
  }
  // Мова повідомлень Rust — як у Windows, доки інтерфейс не скаже свою (i18n.rs).
  i18n::init();
  let context = tauri::generate_context!();
  let builder = tauri::Builder::default();
  // Повторний запуск і посилання з інших програм — у вже запущений браузер (launch.rs); цей плагін — першим.
  // У `tauri dev` свій ідентифікатор (tauri.dev.conf.json), тож зі встановленим Astra Browser вони не змішуються.
  #[cfg(windows)]
  launch::pass_foreground_right();
  let builder = builder.plugin(tauri_plugin_single_instance::init(launch::second_instance));
  // DNS через HTTPS — у налаштування WebView2 ще до першого вікна: браузер читає їх лише під час запуску (dns.rs).
  // Плагіном одразу після single-instance: повторний запуск завершується, не чекаючи тут.
  let builder = builder.plugin(dns::plugin());
  // Webview інтерфейсу вікна. Вікно приховане, доки інтерфейс не намалюється (window_size::reveal_later). Tab з його
  // кінця чи Shift+Tab з початку веде фокус колом (webview2::watch_focus_leaving). Інструменти розробника (feature
  // devtools) — сайтам; інтерфейс самого браузера в релізі їх не відкриває, як у Chrome. У `tauri dev` вони
  // лишаються й для інтерфейсу.
  let builder = builder.plugin(
    tauri::plugin::Builder::<tauri::Wry>::new("interface-webview")
      .on_webview_ready(|webview| {
        if webview.label().starts_with(pages::PAGE_PREFIX) {
          return;
        }
        window_size::reveal_later(webview.window());
        #[cfg(windows)]
        let _ = webview2::watch_focus_leaving(&webview);
        #[cfg(all(windows, not(debug_assertions)))]
        let _ = webview2::disable_devtools(&webview);
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
    // Головне вікно відкривається розгорнутим (window_size::window_reveal), а звичайним стає там і такого розміру,
    // як його лишили.
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION)
        .with_filter(|label| label == "main")
        .build(),
    )
    .setup(|app| {
      logging::log_panics();
      logging::watch_main_thread(app.handle().clone());
      log::info!("Astra Browser {} запущено", app.package_info().version);
      adblock::start(app.handle());
      tracking::start(app.handle());
      // Ключ, яким шифруються дані на диску, — у сховищі секретів системи (у Windows — DPAPI, без ключа).
      #[cfg(not(windows))]
      secure::init(tauri::Manager::path(app).app_data_dir()?, app.config().identifier.clone());
      tauri::Manager::manage(app, downloads::Downloads::default());
      downloads::start(app.handle());
      tauri::Manager::manage(app, passwords::Passwords::default());
      tauri::Manager::manage(app, addresses::Addresses::default());
      tauri::Manager::manage(app, cards::Cards::default());
      cards::start(app.handle());
      tauri::Manager::manage(app, auth::Auth::default());
      auth::start(app.handle());
      #[cfg(all(debug_assertions, not(windows)))]
      debug_eval::start(app.handle());
      Ok(())
    })
    .on_page_load(pages::close_orphans)
    .on_window_event(|window, event| match event {
      tauri::WindowEvent::Focused(true) => launch::focused(window),
      tauri::WindowEvent::Destroyed => {
        pages::forget_window(window);
        window_size::forget(window);
      }
      _ => window_size::on_window_event(window, event),
    })
    .invoke_handler(ipc::handler())
    .build(context)
    .expect("error while building Tauri application")
    .run(|_app, _event| {
      // Перезапуск браузера для нових налаштувань DNS закриває всі вікна — але не застосунок (dns.rs).
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
