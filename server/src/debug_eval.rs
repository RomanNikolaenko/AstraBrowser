//! Лише для розробки в Linux, де немає DevTools Protocol WebView2: якщо задано ASTRA_EVAL_FILE, раз на
//! секунду скрипт із цього файла виконується в інтерфейсі головного вікна, результат іде в журнал, а файл видаляється.
//! Перший рядок `// webview: <мітка>` — виконати в іншому webview, а наступний `// world: <світ>` (Linux) — у світі
//! скриптів браузера на сторінці (gtk_page.rs). У релізі цього немає.

use std::{fs, path::PathBuf, thread, time::Duration};

use tauri::{AppHandle, Manager};

pub fn start(app: &AppHandle) {
  let Some(file) = std::env::var_os("ASTRA_EVAL_FILE").map(PathBuf::from) else {
    return;
  };
  let app = app.clone();
  thread::spawn(move || loop {
    thread::sleep(Duration::from_secs(1));
    let Ok(script) = fs::read_to_string(&file) else {
      continue;
    };
    let _ = fs::remove_file(&file);
    let label = script.lines().next().and_then(|line| line.strip_prefix("// webview: ")).unwrap_or("main").trim().to_string();
    let Some(webview) = app.get_webview(&label) else {
      log::info!("eval: немає webview {label}");
      continue;
    };
    // Не eval(): його не дає CSP інтерфейсу; скрипт — вираз (чи стрілкова функція, що одразу викликається).
    let wrapped = format!("(() => {{ try {{ return JSON.stringify(({script})); }} catch (error) {{ return 'error: ' + error; }} }})()");
    #[cfg(target_os = "linux")]
    if let Some(world) = script.lines().nth(1).and_then(|line| line.strip_prefix("// world: ")).map(|world| world.trim().to_string()) {
      let _ = webview.with_webview(move |platform| {
        use javascriptcore::ValueExt;
        use webkit2gtk::WebViewExt;
        let view: webkit2gtk::WebView = platform.inner();
        view.evaluate_javascript(&wrapped, Some(&world), None, None::<&gtk::gio::Cancellable>, |result| match result {
          Ok(value) => log::info!("eval: {}", value.to_str()),
          Err(error) => log::info!("eval: error {error}"),
        });
      });
      continue;
    }
    let _ = webview.eval_with_callback(wrapped, |result| log::info!("eval: {result}"));
  });
}
