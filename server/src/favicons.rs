//! Значок сайту, якого браузер ще не бачив: закладка є, а сайт тут не відкривали, і /favicon.ico на ньому немає
//! (Supabase кладе значок у /favicon/, gmail.com переадресовує на mail.google.com). Тоді беремо головну сторінку
//! сайту — як її відкрив би браузер — і йдемо переадресаціями: на кожному кроці /favicon.ico, а на останній сторінці
//! ще й значки з її розмітки (<link rel="icon">). Звертаємося лише до самого сайту, без сторонніх сервісів значків.

use std::{sync::OnceLock, time::Duration};

use regex::Regex;
use tauri::Url;
use ureq::ResponseExt;

/// Скільки переадресацій пройти і скільки розмітки прочитати (значки — у <head>, на початку).
const MAX_HOPS: usize = 5;
const MAX_HTML: u64 = 512 * 1024;
const MAX_ICON: u64 = 2 * 1024 * 1024;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// Для сторінок: переадресації — самі, бо значок шукаємо на кожному кроці.
fn pages() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      .timeout_global(Some(Duration::from_secs(10)))
      .http_status_as_error(false)
      .max_redirects(0)
      .user_agent(USER_AGENT)
      .build()
      .into()
  })
}

/// Для самих значків: їх часто переадресовують (mail.google.com/favicon.ico → gstatic.com).
fn icons() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      .timeout_global(Some(Duration::from_secs(10)))
      .http_status_as_error(false)
      .user_agent(USER_AGENT)
      .build()
      .into()
  })
}

/// Значення атрибута тегу: rel="…", rel='…' чи rel=…
fn attribute(tag: &str, name: &str) -> Option<String> {
  static PATTERNS: OnceLock<Regex> = OnceLock::new();
  let pattern = PATTERNS.get_or_init(|| {
    Regex::new(r#"(?is)\b([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).expect("valid attribute pattern")
  });
  pattern.captures_iter(tag).find(|found| found[1].eq_ignore_ascii_case(name)).and_then(|found| {
    found.get(2).or_else(|| found.get(3)).or_else(|| found.get(4)).map(|value| value.as_str().replace("&amp;", "&"))
  })
}

/// Найкращий значок із розмітки сторінки `base`: звичайний icon (маленький чи .ico/.png/.svg) краще за apple-touch-icon.
fn icon_in_html(html: &str, base: &Url) -> Option<Url> {
  static LINKS: OnceLock<Regex> = OnceLock::new();
  let links = LINKS.get_or_init(|| Regex::new(r"(?is)<link\b[^>]*>").expect("valid link pattern"));
  links
    .find_iter(html)
    .filter_map(|link| {
      let tag = link.as_str();
      let rel = attribute(tag, "rel")?.to_ascii_lowercase();
      let href = attribute(tag, "href")?;
      let words: Vec<&str> = rel.split_whitespace().collect();
      let score = if words.contains(&"icon") {
        let sizes = attribute(tag, "sizes").unwrap_or_default();
        // Для панелі закладок і вкладок найкраще 32×32: чітко й на екранах зі збільшенням.
        let size = if sizes.contains("32x32") { 2 } else { u8::from(sizes.contains("16x16") || sizes.contains("48x48")) };
        let format = [".ico", ".png", ".svg"].iter().any(|extension| href.to_ascii_lowercase().split('?').next().is_some_and(|path| path.ends_with(extension)));
        3 + size + u8::from(format)
      } else if words.iter().any(|word| word.starts_with("apple-touch-icon")) {
        1
      } else {
        return None;
      };
      Some((score, base.join(href.trim()).ok().filter(|url| matches!(url.scheme(), "http" | "https"))?))
    })
    // З рівних — перший на сторінці.
    .fold(None, |best: Option<(u8, Url)>, (score, url)| match best {
      Some((best_score, _)) if best_score >= score => best,
      _ => Some((score, url)),
    })
    .map(|(_, url)| url)
}

/// /favicon.ico сайту справді є: відповідь 200 і картинка, а не сторінка «не знайдено». Повертає кінцеву адресу
/// після переадресацій: mail.google.com/favicon.ico віддає значок лише без cookies Google, а інтерфейс браузера
/// просить картинки з ними — тож йому потрібна сама картинка (ssl.gstatic.com/…).
fn favicon_ico(page: &Url) -> Option<Url> {
  let icon = page.join("/favicon.ico").ok()?;
  let mut response = icons().get(icon.as_str()).call().ok()?;
  let icon = Url::parse(&response.get_uri().to_string()).unwrap_or(icon);
  let kind = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
  let image = kind.starts_with("image/") || kind.contains("octet-stream") || kind.is_empty();
  let size = response.body_mut().with_config().limit(MAX_ICON).read_to_vec().ok()?.len();
  (response.status() == 200 && image && size > 0).then_some(icon)
}

/// Іде від `start` переадресаціями й шукає значок: /favicon.ico кожного кроку, а на останній сторінці — і в розмітці.
fn find(start: Url) -> Option<String> {
  let mut page = start;
  for _ in 0..MAX_HOPS {
    let mut response = pages().get(page.as_str()).call().ok()?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
      if let Some(icon) = favicon_ico(&page) {
        return Some(icon.to_string());
      }
      let location = response.headers().get("location").and_then(|value| value.to_str().ok())?.to_string();
      page = page.join(&location).ok()?;
      continue;
    }
    let html = response.body_mut().with_config().limit(MAX_HTML).read_to_string().unwrap_or_default();
    return icon_in_html(&html, &page).or_else(|| favicon_ico(&page)).map(|icon| icon.to_string());
  }
  None
}

/// Значок сайту з адресою `url` (беремо його головну сторінку); `None` — не знайшли.
#[tauri::command]
#[specta::specta]
pub async fn favicon_find(url: String) -> Option<String> {
  let start = Url::parse(&url).ok().filter(|url| matches!(url.scheme(), "http" | "https"))?.join("/").ok()?;
  tauri::async_runtime::spawn_blocking(move || find(start)).await.ok().flatten()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn picks_the_best_icon_from_the_page() {
    let base = Url::parse("https://supabase.com/").expect("url");
    let html = r#"<head>
      <link rel="apple-touch-icon" href="/favicon/apple.png">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="shortcut icon" href="/favicon/favicon.ico"/>
      <link rel="icon" href="/favicon/favicon.ico" type="image/x-icon"/>
    </head>"#;
    assert_eq!(icon_in_html(html, &base).map(String::from), Some("https://supabase.com/favicon/favicon.ico".into()));

    let sizes = r#"<link rel="icon" type="image/png" sizes="192x192" href="/big.png"><link href='/small.png?v=2' sizes="32x32" rel=icon>"#;
    assert_eq!(icon_in_html(sizes, &base).map(String::from), Some("https://supabase.com/small.png?v=2".into()));

    assert_eq!(icon_in_html(r#"<link rel="stylesheet" href="/a.css">"#, &base), None);
    assert_eq!(icon_in_html(r#"<link rel="icon" href="javascript:alert(1)">"#, &base), None);
  }

  /// Справжні сайти — лише вручну: cargo test real_sites -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_sites() {
    for site in ["https://gmail.com/", "https://supabase.com/dashboard/projects", "https://github.com/"] {
      println!("{site} -> {:?}", find(Url::parse(site).expect("url").join("/").expect("root")));
    }
  }

  #[test]
  fn reads_quoted_and_bare_attributes() {
    assert_eq!(attribute(r#"<link REL="Icon" href=/x.ico>"#, "rel").as_deref(), Some("Icon"));
    assert_eq!(attribute(r#"<link rel=icon href='/a?b=1&amp;c=2'>"#, "href").as_deref(), Some("/a?b=1&c=2"));
  }
}
