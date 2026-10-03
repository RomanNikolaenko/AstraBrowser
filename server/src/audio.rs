//! «Блокувати аудіо»: сайт може запускати відео без звуку, а зі звуком — лише після дії користувача.
//!
//! WebView2 для сайту вміє тільки дозволити чи заборонити все автовідтворення, тож цей режим — скрипт,
//! що виконується на початку кожного документа (і в iframe) раніше за код сторінки. Список сайтів
//! він отримує двома шляхами: початковий — разом із собою при створенні webview, а оновлення — окремим
//! скриптом, який WebView2 додає вже живим webview (webview2::replace_document_script).
//! Змінити список може лише той, хто знає випадковий ключ, а текст наших скриптів сторінці не видно.

use std::{
  collections::{hash_map::RandomState, HashMap},
  hash::{BuildHasher, Hasher},
  sync::{Mutex, OnceLock},
};

/// id скрипта з останнім списком для кожного webview сайту — щоб замінювати, а не накопичувати.
#[derive(Default)]
pub struct RulesScripts(pub Mutex<HashMap<String, String>>);

const GUARD_SCRIPT: &str = r#"(() => {
  const token = __TOKEN__;
  let origins = new Set(__ORIGINS__);
  try {
    Object.defineProperty(window, Symbol.for('astra.audio-rules'), {
      value: (key, list) => {
        if (key === token) origins = new Set(list);
      },
    });
  } catch {
    return;
  }
  // Правило — від сайту у вкладці: вбудований плеєр слухається сторінки, на якій стоїть.
  const ancestors = location.ancestorOrigins;
  const site = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : location.origin;
  const blocked = (media) => origins.has(site) && !media.muted && media.volume > 0 && !navigator.userActivation.hasBeenActive;

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    return blocked(this) ? Promise.reject(new DOMException('Autoplay with sound is blocked', 'NotAllowedError')) : play.call(this);
  };
  // Атрибут autoplay і ввімкнення звуку посеред відтворення обходяться без play().
  const stop = (event) => {
    const media = event.target;
    if (media instanceof HTMLMediaElement && !media.paused && blocked(media)) {
      media.pause();
    }
  };
  addEventListener('play', stop, true);
  addEventListener('volumechange', stop, true);
})();"#;

fn token() -> &'static str {
  static TOKEN: OnceLock<String> = OnceLock::new();
  TOKEN.get_or_init(|| format!("{:016x}", RandomState::new().build_hasher().finish()))
}

fn json<T: serde::Serialize + ?Sized>(value: &T) -> String {
  serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// Скрипт, що стереже звук, зі списком сайтів на момент створення webview.
pub fn guard_script(origins: &[String]) -> String {
  GUARD_SCRIPT.replace("__TOKEN__", &json(token())).replace("__ORIGINS__", &json(origins))
}

/// Новий список сайтів для документів, що відкриються після цього.
#[cfg(windows)]
pub fn rules_script(origins: &[String]) -> String {
  format!("window[Symbol.for('astra.audio-rules')]?.({}, {});", json(token()), json(origins))
}
