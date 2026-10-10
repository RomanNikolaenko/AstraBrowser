//! Підказки пошукової системи для адресного рядка — як у Chrome чи Firefox: що ви вводите, надсилається вибраній
//! пошуковій системі (Google, DuckDuckGo чи Bing), а вона повертає можливі запити. Запит іде з Rust, бо сторінці
//! інтерфейсу ці адреси не дозволяють читати відповіді (CORS). Вимикається в налаштуваннях.

use std::{sync::OnceLock, time::Duration};

use serde_json::Value;
use tauri::Url;

/// Більше підказок адресний рядок однаково не покаже.
const LIMIT: usize = 8;

fn agent() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      // Запізніла підказка вже нікому не потрібна: користувач надрукував далі.
      .timeout_global(Some(Duration::from_secs(3)))
      .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AstraBrowser")
      .build()
      .into()
  })
}

/// Адреса підказок пошукової системи (усі відповідають у форматі OpenSearch: `["запит", ["підказка", …]]`).
fn suggestions_url(engine: &str, query: &str) -> Option<Url> {
  let (base, key): (&str, &str) = match engine {
    "duckduckgo" => ("https://duckduckgo.com/ac/?type=list", "q"),
    "bing" => ("https://api.bing.com/osjson.aspx", "query"),
    _ => ("https://suggestqueries.google.com/complete/search?client=firefox&hl=uk&ie=utf-8&oe=utf-8", "q"),
  };
  let mut url = Url::parse(base).ok()?;
  url.query_pairs_mut().append_pair(key, query);
  Some(url)
}

fn parse(body: &str) -> Vec<String> {
  serde_json::from_str::<Value>(body)
    .ok()
    .and_then(|value| value.get(1).and_then(Value::as_array).cloned())
    .unwrap_or_default()
    .iter()
    .filter_map(Value::as_str)
    .map(|suggestion| suggestion.trim().to_string())
    .filter(|suggestion| !suggestion.is_empty())
    .take(LIMIT)
    .collect()
}

fn fetch(engine: &str, query: &str) -> Vec<String> {
  let query = query.trim();
  if query.is_empty() || query.chars().count() > 200 {
    return Vec::new();
  }
  let Some(url) = suggestions_url(engine, query) else {
    return Vec::new();
  };
  agent()
    .get(url.as_str())
    .call()
    .ok()
    .and_then(|mut response| response.body_mut().with_config().limit(256 * 1024).read_to_string().ok())
    .map(|body| parse(&body))
    .unwrap_or_default()
}

/// Підказки для `query` від пошукової системи `engine` (google, duckduckgo, bing); без мережі — порожньо.
#[tauri::command]
pub async fn search_suggestions(engine: String, query: String) -> Vec<String> {
  tauri::async_runtime::spawn_blocking(move || fetch(&engine, &query)).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_open_search_suggestions() {
    assert_eq!(parse(r#"["астра",["астра браузер","астрахань"," ",42]]"#), vec!["астра браузер", "астрахань"]);
    assert!(parse("not json").is_empty());
    assert!(parse(r#"{"q":"x"}"#).is_empty());
  }

  #[test]
  fn encodes_the_query_for_each_engine() {
    let url = |engine| suggestions_url(engine, "як варити борщ & пампушки").map(String::from).unwrap_or_default();
    assert!(url("google").starts_with("https://suggestqueries.google.com/complete/search?client=firefox"));
    assert!(url("google").ends_with("&q=%D1%8F%D0%BA+%D0%B2%D0%B0%D1%80%D0%B8%D1%82%D0%B8+%D0%B1%D0%BE%D1%80%D1%89+%26+%D0%BF%D0%B0%D0%BC%D0%BF%D1%83%D1%88%D0%BA%D0%B8"));
    assert!(url("duckduckgo").starts_with("https://duckduckgo.com/ac/?type=list&q="));
    assert!(url("bing").starts_with("https://api.bing.com/osjson.aspx?query="));
  }
}
