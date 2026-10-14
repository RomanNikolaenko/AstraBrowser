//! Повідомлення скриптам сторінки сайту (паролі, адреси й картки, переклад виділеного) будь-коли, а не лише відповіддю
//! на їхнє. У Windows — через chrome.webview WebView2 (webview2::post_page_message), на Linux — у світ цих скриптів
//! WebKitGTK (gtk_page::post_page_message). На macOS скриптів сторінки поки немає.

use tauri::Webview;

pub fn post(webview: &Webview, message: &serde_json::Value) -> tauri::Result<()> {
  #[cfg(windows)]
  return crate::webview2::post_page_message(webview, message);
  #[cfg(target_os = "linux")]
  return crate::gtk_page::post_page_message(webview, message);
  #[cfg(not(any(windows, target_os = "linux")))]
  {
    let _ = (webview, message);
    Ok(())
  }
}
