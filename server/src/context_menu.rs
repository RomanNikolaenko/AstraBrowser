//! Пункти браузера в контекстному меню сайту — однакові на всіх системах: відкрити посилання в новій вкладці, шукати
//! й перекласти виділене тощо. Саме меню будує рушій: у Windows — page_events::customize_context_menu, у Linux —
//! gtk_page::customize_context_menu.

use serde::Serialize;

/// Дія браузера з контекстного меню сайту — для інтерфейсу.
#[derive(Clone, Serialize, PartialEq, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextAction {
  pub action: &'static str,
  pub url: Option<String>,
  pub text: Option<String>,
}

/// Що є там, де клацнули: посилання, зображення, виділений текст; адреса самої сторінки, якщо це сайт.
#[derive(Default, Debug, PartialEq)]
pub struct MenuTarget {
  pub page: Option<String>,
  pub link: Option<String>,
  pub image: Option<String>,
  pub selection: Option<String>,
  pub editable: bool,
}

/// Свої пункти меню: (дія, підпис, адреса чи текст для дії). Порожня дія — роздільник.
pub type MenuItems = Vec<(&'static str, String, Option<String>)>;

/// Знімок сторінки — у WebView2 і WebKitGTK (Windows і Linux).
const SCREENSHOT: bool = cfg!(any(windows, target_os = "linux"));
/// Код сторінки (view-source:) — лише у WebView2: WebKitGTK його не показує.
const VIEW_SOURCE: bool = cfg!(windows);

/// Пункти для `target`: ті, що на початку меню, і ті, що в кінці.
pub fn custom_items(target: &MenuTarget) -> (MenuItems, MenuItems) {
  let mut top = Vec::new();
  let mut bottom = Vec::new();
  if let Some(link) = &target.link {
    top.push(("open-link-tab", crate::i18n::text("Відкрити посилання в новій вкладці", "Open link in new tab").to_string(), Some(link.clone())));
    top.push(("open-link-window", crate::i18n::text("Відкрити посилання в новому вікні", "Open link in new window").to_string(), Some(link.clone())));
    top.push(("open-link-private", crate::i18n::text("Відкрити посилання в приватному вікні", "Open link in private window").to_string(), Some(link.clone())));
    top.push(("", String::new(), None));
  }
  if let Some(image) = &target.image {
    top.push(("open-image-tab", crate::i18n::text("Відкрити зображення в новій вкладці", "Open image in new tab").to_string(), Some(image.clone())));
    top.push(("", String::new(), None));
  }
  if let Some(text) = &target.selection {
    let short = shorten(text);
    top.push(("search", crate::i18n::text("Шукати в інтернеті «{0}»", "Search the web for “{0}”").replace("{0}", &short), Some(text.clone())));
    if !target.editable {
      top.push(("translate-text", crate::i18n::text("Перекласти «{0}»", "Translate “{0}”").replace("{0}", &short), Some(text.clone())));
    }
    top.push(("", String::new(), None));
  }
  // Меню самої сторінки — не на посиланні, зображенні, виділенні й не в полі вводу.
  if target.link.is_none() && target.image.is_none() && target.selection.is_none() && !target.editable {
    bottom.push(("", String::new(), None));
    bottom.push(("translate-page", crate::i18n::text("Перекласти сторінку", "Translate page").to_string(), None));
    if SCREENSHOT {
      bottom.push(("screenshot", crate::i18n::text("Знімок екрана", "Screenshot").to_string(), None));
    }
    // Для розробки: код сторінки (як Ctrl+U) — перед «Перевірити» самого WebView2.
    if let Some(page) = target.page.as_ref().filter(|_| VIEW_SOURCE) {
      bottom.push(("", String::new(), None));
      bottom.push(("view-source", crate::i18n::text("Переглянути джерело сторінки", "View page source").to_string(), Some(page.clone())));
    }
  }
  (top, bottom)
}

/// Виділене в підписі пункту — коротко, в один рядок.
fn shorten(text: &str) -> String {
  let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if line.chars().count() > 30 {
    format!("{}…", line.chars().take(29).collect::<String>().trim_end())
  } else {
    line
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn actions(target: &MenuTarget) -> Vec<&'static str> {
    let (top, bottom) = custom_items(target);
    top.into_iter().chain(bottom).map(|(action, _, _)| action).filter(|action| !action.is_empty()).collect()
  }

  /// Дії меню сторінки на цій системі: без знімка й коду сторінки там, де їх немає.
  fn page_actions(list: &[&'static str]) -> Vec<&'static str> {
    list.iter().copied().filter(|action| match *action {
      "screenshot" => SCREENSHOT,
      "view-source" => VIEW_SOURCE,
      _ => true,
    }).collect()
  }

  #[test]
  fn offers_browser_actions_for_what_was_clicked() {
    let link = MenuTarget { link: Some("https://example.com/".into()), ..MenuTarget::default() };
    assert_eq!(actions(&link), ["open-link-tab", "open-link-window", "open-link-private"]);

    let image = MenuTarget { image: Some("https://example.com/cat.png".into()), ..MenuTarget::default() };
    assert_eq!(actions(&image), ["open-image-tab"]);

    let selection = MenuTarget { selection: Some("рецепт борщу".into()), ..MenuTarget::default() };
    assert_eq!(actions(&selection), ["search", "translate-text"]);
    let (top, _) = custom_items(&selection);
    assert_eq!(top[0].1, "Шукати в інтернеті «рецепт борщу»");

    // У полі вводу — без перекладу й без дій сторінки.
    let field = MenuTarget { selection: Some("текст".into()), editable: true, ..MenuTarget::default() };
    assert_eq!(actions(&field), ["search"]);

    assert_eq!(actions(&MenuTarget::default()), page_actions(&["translate-page", "screenshot"]));
    // На сайті — ще й його код; на посиланні — ні.
    let page = MenuTarget { page: Some("https://example.com/".into()), ..MenuTarget::default() };
    assert_eq!(actions(&page), page_actions(&["translate-page", "screenshot", "view-source"]));
    if VIEW_SOURCE {
      let (_, bottom) = custom_items(&page);
      assert_eq!(bottom.last().and_then(|(_, _, url)| url.as_deref()), Some("https://example.com/"));
    }
    let link_on_page = MenuTarget { link: Some("https://example.com/a".into()), ..page };
    assert_eq!(actions(&link_on_page), ["open-link-tab", "open-link-window", "open-link-private"]);
  }

  #[test]
  fn shortens_long_selections_to_one_line() {
    assert_eq!(shorten("  два\n рядки  "), "два рядки");
    assert_eq!(shorten(&"дуже довгий текст ".repeat(5)), "дуже довгий текст дуже довгий…");
  }
}
