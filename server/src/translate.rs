//! Переклад виділеного на сайті тексту: скрипт сторінки (selection-translate.js) показує біля виділення значок,
//! а натиснули його — просить переклад тут. Перекладає Google — той самий сервіс, яким перекладає виділене його
//! розширення для Chrome; мова — та, що вибрана в «Перекладачі» браузера.
//!
//! Текст іде в Google лише після натискання значка. Відповідь сторінці — без токена: його бачили б і скрипти сайту.

use std::{
  sync::{Mutex, OnceLock},
  thread,
  time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const ENDPOINT: &str = "https://clients5.google.com/translate_a/t";
/// Найдовший текст, який перекладаємо за раз.
const MAX_TEXT: usize = 5000;
const PAGE_SCRIPT: &str = include_str!("selection-translate.js");

/// Мова перекладу — її задає інтерфейс (translate_set_language).
static LANGUAGE: Mutex<String> = Mutex::new(String::new());

fn agent() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      .timeout_global(Some(Duration::from_secs(15)))
      // Без браузерного User-Agent Google вважає запит автоматичним і не відповідає.
      .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
      .build()
      .into()
  })
}

/// Код мови Google: uk, en, zh-CN…
fn is_language(code: &str) -> bool {
  (2..=10).contains(&code.len()) && code.chars().all(|char| char.is_ascii_alphanumeric() || char == '-')
}

fn language() -> String {
  LANGUAGE.lock().ok().map(|language| language.clone()).filter(|language| !language.is_empty()).unwrap_or_else(|| "uk".into())
}

/// Мова, на яку перекладати виділене, — та, що вибрана в «Перекладачі».
#[tauri::command]
pub fn translate_set_language(language: String) -> Result<(), String> {
  if !is_language(&language) {
    return Err("Некоректна мова".into());
  }
  *LANGUAGE.lock().map_err(|error| error.to_string())? = language;
  Ok(())
}

/// Скрипт сторінки зі значком перекладу (selection-translate.js) з токеном сторінки.
pub fn page_script(token: &str) -> String {
  format!("({PAGE_SCRIPT})({});", Value::from(token))
}

/// Переклад і мова оригіналу.
#[derive(Debug, PartialEq)]
struct Translation {
  text: String,
  source: String,
}

/// Відповідь Google: `[["переклад", "мова оригіналу"]]` (а якщо мову оригіналу задано — `["переклад"]`).
fn parse(reply: &Value) -> Option<Translation> {
  let first = reply.get(0)?;
  match first {
    Value::String(text) => Some(Translation { text: text.clone(), source: String::new() }),
    Value::Array(parts) => Some(Translation {
      text: parts.first()?.as_str()?.to_string(),
      source: parts.get(1).and_then(Value::as_str).unwrap_or_default().to_string(),
    }),
    _ => None,
  }
}

fn translate(text: &str, target: &str) -> Result<Translation, String> {
  const OFFLINE: &str = "Не вдалося перекласти: немає з'єднання з Google Перекладачем.";
  let mut response = agent()
    .post(ENDPOINT)
    .query("client", "dict-chrome-ex")
    .query("sl", "auto")
    .query("tl", target)
    .send_form([("q", text)])
    .map_err(|_| OFFLINE.to_string())?;
  let body = response.body_mut().read_to_string().map_err(|_| OFFLINE.to_string())?;
  serde_json::from_str::<Value>(&body)
    .ok()
    .and_then(|reply| parse(&reply))
    .ok_or_else(|| "Google Перекладач зараз не відповідає. Спробуйте трохи згодом.".to_string())
}

/// Прохання скрипта сторінки `label` перекласти виділене: переклад іде у фоні, а відповідь — тій сторінці.
pub fn on_page_message(app: &AppHandle, label: &str, message: &Value) -> Option<Value> {
  let id = message.get("id")?.as_u64()?;
  let text: String = message.get("text")?.as_str()?.trim().chars().take(MAX_TEXT).collect();
  if text.is_empty() {
    return None;
  }
  let (app, label) = (app.clone(), label.to_string());
  thread::spawn(move || {
    let target = language();
    let reply = match translate(&text, &target) {
      Ok(translation) => json!({
        "astra": "translate",
        "id": id,
        "text": translation.text,
        "source": translation.source,
        "target": target,
      }),
      Err(error) => json!({ "astra": "translate", "id": id, "error": error }),
    };
    if let Some(webview) = app.get_webview(&label) {
      let _ = crate::webview2::post_page_message(&webview, &reply);
    }
  });
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_translation_and_the_detected_language() {
    assert_eq!(
      parse(&json!([["Ми не претендуємо на право власності.", "en"]])),
      Some(Translation { text: "Ми не претендуємо на право власності.".into(), source: "en".into() })
    );
    assert_eq!(parse(&json!(["Привіт"])), Some(Translation { text: "Привіт".into(), source: String::new() }));
    assert_eq!(parse(&json!({ "error": "x" })), None);
  }

  #[test]
  fn accepts_only_language_codes() {
    assert!(is_language("uk"));
    assert!(is_language("zh-CN"));
    assert!(!is_language("uk&q=1"));
    assert!(!is_language(""));
  }
}
