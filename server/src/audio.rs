//! Автовідтворення на сайтах — скрипт, що виконується на початку кожного документа (і в iframe) раніше за код
//! сторінки:
//! - «Дозволити аудіо та відео» — нічого не заважає;
//! - «Блокувати аудіо» — без звуку можна, зі звуком — лише після дії користувача;
//! - «Блокувати аудіо та відео» (і всі сайти, яким нічого не дозволяли) — відео й аудіо стартують лише після кліку
//!   чи клавіші, натиснутих уже після того, як відео почало вантажитися. Заборони самого WebView2 тут мало: вона
//!   не діє, якщо на сторінці вже клікали, — а YouTube перемикає відео без перезавантаження сторінки.
//!
//! Правила скрипт отримує двома шляхами: початкові — разом із собою при створенні webview, а оновлення — окремим
//! скриптом, який WebView2 додає вже живим webview (webview2::replace_document_script).
//! Змінити правила може лише той, хто знає випадковий ключ, а текст наших скриптів сторінці не видно.

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
  let rules = __RULES__;
  try {
    Object.defineProperty(window, Symbol.for('astra.audio-rules'), {
      value: (key, next) => {
        if (key === token) rules = next;
      },
    });
  } catch {
    return;
  }
  // Правило — від сайту у вкладці: вбудований плеєр слухається сторінки, на якій стоїть.
  const ancestors = location.ancestorOrigins;
  const site = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : location.origin;
  const now = performance.now.bind(performance);

  // Коли користувач востаннє клікнув чи натиснув клавішу і коли кожне медіа отримало поточне відео.
  let gesture = -1;
  const loaded = new WeakMap();
  const mark = (media) => loaded.set(media, now());
  const remember = (event) => {
    if (event.isTrusted) gesture = now();
  };
  addEventListener('pointerdown', remember, true);
  addEventListener('keydown', remember, true);
  // Нове джерело — одразу, а не з подією loadstart: YouTube, перемикаючи відео, викликає play() відразу після
  // заміни src, ще до loadstart, і тоді клік по мініатюрі зарахувався б як дозвіл для нового відео.
  for (const name of ['src', 'srcObject']) {
    const property = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
    if (property && property.set) {
      Object.defineProperty(HTMLMediaElement.prototype, name, {
        ...property,
        set(value) {
          mark(this);
          property.set.call(this, value);
        },
      });
    }
  }
  const load = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function () {
    mark(this);
    return load.call(this);
  };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'src') mark(this);
    return setAttribute.call(this, name, value);
  };
  // Відео з розмітки сторінки (атрибут src без нашого коду) — з першої події loadstart. Пізніші loadstart уже ні:
  // вони приходять із запізненням і «з'їли» б клік, яким відео щойно запустили.
  addEventListener(
    'loadstart',
    (event) => {
      if (event.target instanceof HTMLMediaElement && !loaded.has(event.target)) mark(event.target);
    },
    true
  );

  const blocked = (media) => {
    if (rules.allow.includes(site)) return false;
    // «Блокувати аудіо»: без звуку можна, зі звуком — після будь-якої дії користувача на сторінці.
    if (rules.blockAudio.includes(site)) return !media.muted && media.volume > 0 && !navigator.userActivation.hasBeenActive;
    // «Блокувати аудіо та відео»: лише після дії користувача вже після того, як відео почало вантажитися.
    // Клік, яким відкрили відео (YouTube перемикає їх без перезавантаження сторінки), — ще не дозвіл.
    return gesture < 0 || gesture < (loaded.get(media) ?? 0);
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    return blocked(this) ? Promise.reject(new DOMException('Autoplay is blocked', 'NotAllowedError')) : play.call(this);
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

/// Правила автовідтворення: сайти (origin), яким усе дозволено, і ті, яким заборонено лише звук. Решта — «Блокувати
/// аудіо та відео».
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutoplayRules {
  pub allow: Vec<String>,
  pub block_audio: Vec<String>,
}

/// Скрипт, що стереже автовідтворення, з правилами на момент створення webview.
pub fn guard_script(rules: &AutoplayRules) -> String {
  GUARD_SCRIPT.replace("__TOKEN__", &json(token())).replace("__RULES__", &json(rules))
}

/// Нові правила для документів, що відкриються після цього.
#[cfg(windows)]
pub fn rules_script(rules: &AutoplayRules) -> String {
  format!("window[Symbol.for('astra.audio-rules')]?.({}, {});", json(token()), json(rules))
}
