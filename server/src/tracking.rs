//! Захист від стеження, як у Firefox: запити сторінки до відомих елементів стеження блокуються, а інтерфейс
//! показує, що саме заблоковано на сайті (webview2::block_ads — той самий обробник запитів, що й у блокувальника
//! реклами, але перевіряє раніше за нього).
//!
//! Елементи стеження — зі списків EasyPrivacy, соцмереж (Fanboy's Social, AdGuard Social Media) і криптомайнерів
//! (NoCoin); з них беруться лише мережеві правила, і для кожної категорії збирається свій рушій adblock-rust.
//! Списки Disconnect, як у Firefox, не підходять: їхня ліцензія забороняє комерційне використання.
//!
//! Куки й сховища трекерів блокує ще й вбудований захист від стеження WebView2 (той самий, що в Edge): рівень
//! відповідає вибраному тут (webview2::set_tracking_prevention). Сайти, яким захист вимкнули, він не знає — для нього
//! є лише рівень профілю.
//!
//! Ще захист прибирає з адрес мітки, за якими сайти впізнають, звідки ви прийшли (fbclid, gclid…), а сигнал
//! Global Privacy Control («не продавати й не поширювати мої дані») надсилає заголовком Sec-GPC і показує сайтам
//! як navigator.globalPrivacyControl.

use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, RwLock,
  },
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use adblock::{
  lists::{FilterSet, ParseOptions, RuleTypes},
  request::Request,
  Engine,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

use crate::adblock::{covers, download_all};

/// Що саме заблоковано: так елементи групуються в панелі захисту.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
  /// Аналітика й рекламні мітки, що стежать за вами з сайту на сайт.
  Tracking,
  /// Кнопки «Поділитися», вбудовані дописи й пікселі соцмереж.
  Social,
  /// Скрипти, що добувають криптовалюту коштом вашого комп'ютера.
  Cryptomining,
}

impl Category {
  const ALL: [Category; 3] = [Category::Tracking, Category::Social, Category::Cryptomining];

  fn id(self) -> &'static str {
    match self {
      Category::Tracking => "tracking",
      Category::Social => "social",
      Category::Cryptomining => "cryptomining",
    }
  }
}

struct TrackerList {
  category: Category,
  url: &'static str,
}

const LISTS: &[TrackerList] = &[
  TrackerList { category: Category::Tracking, url: "https://easylist.to/easylist/easyprivacy.txt" },
  TrackerList { category: Category::Social, url: "https://easylist.to/easylist/fanboy-social.txt" },
  TrackerList { category: Category::Social, url: "https://filters.adtidy.org/extension/ublock/filters/4.txt" },
  TrackerList { category: Category::Cryptomining, url: "https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/nocoin.txt" },
];

/// Як часто оновлювати списки й як часто перевіряти, чи не час, — як у блокувальника реклами.
const MAX_AGE: Duration = Duration::from_secs(4 * 24 * 60 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Кеш рушіїв: номер змінюється разом зі списками чи способом збирання.
const CACHE_VERSION: &str = "v1";

/// Мітки в адресах, за якими сайти й реклама впізнають, звідки ви прийшли (як privacy.query_stripping у Firefox).
const TRACKING_PARAMS: &[&str] = &[
  "__hsfp", "__hssc", "__hstc", "__s", "_hsenc", "_openstat", "dclid", "fbclid", "gbraid", "gclid", "hsCtaTracking", "igshid",
  "li_fat_id", "mc_eid", "mkt_tok", "ml_subscriber", "ml_subscriber_hash", "msclkid", "oft_c", "oft_ck", "oft_d", "oft_id",
  "oft_ids", "oft_k", "oft_lk", "oft_sk", "oly_anon_id", "oly_enc_id", "rb_clickid", "s_cid", "ttclid", "twclid", "vero_conv",
  "vero_id", "wbraid", "wickedid", "yclid",
];

/// Рівень захисту.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
  /// Відомі елементи стеження й криптомайнери; сайти працюють як звичайно.
  #[default]
  Standard,
  /// Ще й елементи соцмереж, а вбудований захист WebView2 — найсуворіший.
  Strict,
  Off,
}

/// Правила вікна: їх задає інтерфейс вікна (tracking_set_rules). У приватного вікна свої налаштування.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
  pub level: Level,
  /// Global Privacy Control: «не продавати й не поширювати мої дані».
  pub gpc: bool,
  /// Сайти (хост без www.), яким захист вимкнули, — разом з піддоменами.
  pub exceptions: Vec<String>,
}

impl Default for Rules {
  fn default() -> Self {
    Self { level: Level::Standard, gpc: true, exceptions: Vec::new() }
  }
}

impl Rules {
  /// Чи захищати сторінку з хостом `host`.
  pub fn protects(&self, host: &str) -> bool {
    self.level != Level::Off && !host.is_empty() && !self.exceptions.iter().any(|site| covers(site, host))
  }

  fn blocks(&self, category: Category) -> bool {
    match self.level {
      Level::Off => false,
      Level::Standard => category != Category::Social,
      Level::Strict => true,
    }
  }
}

#[derive(Default)]
pub struct Tracking {
  engines: RwLock<HashMap<Category, Arc<Engine>>>,
  rules: RwLock<HashMap<String, Arc<Rules>>>,
  dir: OnceLock<PathBuf>,
  updating: AtomicBool,
  updated_at: Mutex<Option<u64>>,
}

/// id скрипта GPC кожної сторінки (label → id), щоб замінити його, коли зміниться налаштування.
#[derive(Default)]
pub struct PageScripts(pub Mutex<HashMap<String, String>>);

impl Tracking {
  /// Правила вікна `window`; поки інтерфейс вікна їх не надіслав — типові.
  pub fn rules(&self, window: &str) -> Arc<Rules> {
    self.rules.read().ok().and_then(|rules| rules.get(window).cloned()).unwrap_or_default()
  }

  fn set_rules(&self, window: &str, rules: Rules) -> Option<Arc<Rules>> {
    self.rules.write().ok()?.insert(window.to_string(), Arc::new(rules))
  }

  /// Категорія елемента стеження, якщо запит `url` типу `kind` зі сторінки `source` треба заблокувати.
  pub fn check(&self, rules: &Rules, url: &str, source: &str, kind: &str, method: &str) -> Option<Category> {
    let engines = self.engines.read().ok()?;
    let request = Request::new(url, source, kind, method).ok()?;
    Category::ALL.into_iter().filter(|category| rules.blocks(*category)).find(|category| {
      engines.get(category).is_some_and(|engine| engine.check_network_request(&request).should_block())
    })
  }

  fn engine_file(&self, category: Category) -> Option<PathBuf> {
    Some(self.dir.get()?.join(format!("tracking-{}-{CACHE_VERSION}.dat", category.id())))
  }

  /// Рушії з кешу попереднього запуску.
  fn load_cache(&self) {
    let mut oldest: Option<u64> = None;
    for category in Category::ALL {
      let Some(path) = self.engine_file(category) else {
        return;
      };
      let Ok(bytes) = fs::read(&path) else {
        continue;
      };
      let mut engine = Engine::default();
      if engine.deserialize(&bytes).is_ok() {
        if let Some(time) = modified_ms(&path) {
          oldest = Some(oldest.map_or(time, |oldest| oldest.min(time)));
        }
        if let Ok(mut engines) = self.engines.write() {
          engines.insert(category, Arc::new(engine));
        }
      }
    }
    if let Ok(mut updated_at) = self.updated_at.lock() {
      *updated_at = oldest;
    }
  }

  fn is_stale(&self) -> bool {
    let complete = self.engines.read().is_ok_and(|engines| engines.len() == Category::ALL.len());
    let updated_at = self.updated_at.lock().ok().and_then(|time| *time);
    !complete || updated_at.is_none_or(|time| now_ms().saturating_sub(time) > MAX_AGE.as_millis() as u64)
  }

  /// Завантажує свіжі списки й збирає з них рушії; старі працюють, доки нові не готові.
  fn refresh(&self) {
    if self.updating.swap(true, Ordering::SeqCst) {
      return;
    }
    match build() {
      Ok(built) => {
        for (category, engine) in built {
          if let Some(path) = self.engine_file(category) {
            if let Some(dir) = path.parent() {
              let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(&path, engine.serialize());
          }
          if let Ok(mut engines) = self.engines.write() {
            engines.insert(category, Arc::new(engine));
          }
        }
        if let Ok(mut updated_at) = self.updated_at.lock() {
          *updated_at = Some(now_ms());
        }
      }
      Err(message) => eprintln!("tracking: не вдалося оновити списки: {message}"),
    }
    self.updating.store(false, Ordering::SeqCst);
  }
}

fn build() -> Result<Vec<(Category, Engine)>, String> {
  let urls: Vec<String> = LISTS.iter().map(|list| list.url.to_string()).collect();
  let mut sets: HashMap<Category, FilterSet> = HashMap::new();
  for (list, text) in LISTS.iter().zip(download_all(&urls)) {
    let text = String::from_utf8(text?).map_err(|error| format!("{}: {error}", list.url))?;
    // Лише мережеві правила: ховати кнопки на сторінці — справа блокувальника реклами.
    let options = ParseOptions { rule_types: RuleTypes::NetworkOnly, ..ParseOptions::default() };
    sets.entry(list.category).or_insert_with(|| FilterSet::new(false)).add_filter_list(text, options);
  }
  Ok(sets.into_iter().map(|(category, filters)| (category, Engine::new_with_filter_set(filters))).collect())
}

/// Адреса без міток стеження; `None`, якщо їх у ній немає.
pub fn without_tracking_params(url: &Url) -> Option<Url> {
  let pairs: Vec<(String, String)> = url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
  let kept: Vec<&(String, String)> = pairs.iter().filter(|(key, _)| !TRACKING_PARAMS.contains(&key.as_str())).collect();
  if kept.len() == pairs.len() {
    return None;
  }
  let mut clean = url.clone();
  if kept.is_empty() {
    clean.set_query(None);
  } else {
    clean.query_pairs_mut().clear().extend_pairs(kept.iter().map(|(key, value)| (key, value)));
  }
  Some(clean)
}

/// Скрипт сторінки для Global Privacy Control: властивості navigator, які читають сайти (і їхні менеджери згоди).
/// Без GPC — прибирає їх, якщо сторінку відкрили, ще поки GPC був увімкнений.
pub fn page_script(gpc: bool) -> String {
  if gpc {
    "(() => { for (const [name, value] of [['globalPrivacyControl', true], ['doNotTrack', '1']]) { \
     try { Object.defineProperty(navigator, name, { get: () => value, configurable: true, enumerable: true }); } catch {} } })();"
      .to_string()
  } else {
    "(() => { try { delete navigator.globalPrivacyControl; delete navigator.doNotTrack; } catch {} })();".to_string()
  }
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

fn modified_ms(path: &Path) -> Option<u64> {
  let modified = fs::metadata(path).ok()?.modified().ok()?;
  Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Рушії з кешу, а далі — оновлення списків у фоні. Викликається при запуску.
pub fn start(app: &AppHandle) {
  let Ok(dir) = app.path().app_data_dir() else {
    return;
  };
  let _ = app.state::<Tracking>().dir.set(dir);
  let app = app.clone();
  thread::spawn(move || {
    let tracking = app.state::<Tracking>();
    tracking.load_cache();
    loop {
      if tracking.is_stale() {
        tracking.refresh();
      }
      thread::sleep(CHECK_EVERY);
    }
  });
}

/// Нові правила вікна (рівень, GPC, винятки): запитам — одразу, вбудованому захисту WebView2 й скрипту GPC —
/// для всіх сторінок вікна.
#[cfg(windows)]
#[tauri::command]
pub fn tracking_set_rules(window: tauri::Window, rules: Rules) -> Result<(), String> {
  let tracking = window.state::<Tracking>();
  let (level, gpc) = (rules.level, rules.gpc);
  let previous = tracking.set_rules(window.label(), rules);
  let gpc_changed = previous.as_ref().is_none_or(|previous| previous.gpc != gpc);
  let level_changed = previous.as_ref().is_none_or(|previous| previous.level != level);
  let pages = window.webviews().into_iter().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX));
  for webview in pages {
    if level_changed {
      crate::webview2::set_tracking_prevention(&webview, level).map_err(|error| error.to_string())?;
    }
    if gpc_changed {
      let label = webview.label().to_string();
      let scripts = window.state::<PageScripts>();
      let previous = scripts.0.lock().map_err(|error| error.to_string())?.get(&label).cloned();
      let app = window.app_handle().clone();
      let script = page_script(gpc);
      crate::webview2::replace_document_script(&webview, previous, script.clone(), move |id| {
        if let Ok(mut scripts) = app.state::<PageScripts>().0.lock() {
          scripts.insert(label, id);
        }
      })
      .map_err(|error| error.to_string())?;
      let _ = webview.eval(script);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn engine(rules: &str) -> Arc<Engine> {
    let mut filters = FilterSet::new(false);
    filters.add_filter_list(rules.to_string(), ParseOptions { rule_types: RuleTypes::NetworkOnly, ..ParseOptions::default() });
    Arc::new(Engine::new_with_filter_set(filters))
  }

  #[test]
  fn blocks_trackers_by_level_and_respects_exceptions() {
    let tracking = Tracking::default();
    {
      let mut engines = tracking.engines.write().expect("engines");
      engines.insert(Category::Tracking, engine("||tracker.example^$third-party"));
      engines.insert(Category::Social, engine("||social.example/like.js"));
    }
    let page = "https://news.example.org/article";
    let standard = Rules::default();
    let check = |rules: &Rules, url: &str| tracking.check(rules, url, page, "script", "GET");

    assert_eq!(check(&standard, "https://tracker.example/t.js"), Some(Category::Tracking));
    assert_eq!(check(&standard, "https://cdn.example.org/app.js"), None);
    // Соцмережі — лише в суворому режимі.
    assert_eq!(check(&standard, "https://social.example/like.js"), None);
    let strict = Rules { level: Level::Strict, ..Rules::default() };
    assert_eq!(check(&strict, "https://social.example/like.js"), Some(Category::Social));

    assert!(standard.protects("news.example.org"));
    let excepted = Rules { exceptions: vec!["example.org".into()], ..Rules::default() };
    assert!(!excepted.protects("news.example.org"));
    assert!(excepted.protects("example.com"));
    assert!(!Rules { level: Level::Off, ..Rules::default() }.protects("example.com"));
  }

  #[test]
  fn strips_only_tracking_params_from_addresses() {
    let url = |text: &str| Url::parse(text).expect("url");
    assert_eq!(
      without_tracking_params(&url("https://shop.example/item?id=7&fbclid=abc&utm_source=mail&gclid=x#reviews")).map(String::from),
      Some("https://shop.example/item?id=7&utm_source=mail#reviews".to_string())
    );
    assert_eq!(without_tracking_params(&url("https://example.com/?fbclid=abc")).map(String::from), Some("https://example.com/".to_string()));
    assert_eq!(without_tracking_params(&url("https://example.com/search?q=fbclid")), None);
  }
}
