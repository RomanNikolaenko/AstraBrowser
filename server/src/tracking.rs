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
//!
//! У Linux запитів WebKit не показує, тож ті самі списки йдуть у фільтри вмісту WebKit (gtk_tracking.rs), а рушіїв там
//! немає зовсім: вони лише займали б пам'ять.

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

#[cfg(any(windows, test))]
use adblock::lists::FilterSet;
use adblock::{
  lists::{ParseOptions, RuleTypes},
  request::Request,
  Engine,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

use crate::adblock::{covers, download_all};

/// Що саме заблоковано: так елементи групуються в панелі захисту.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, specta::Type)]
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
  pub(crate) const ALL: [Category; 3] = [Category::Tracking, Category::Social, Category::Cryptomining];

  pub(crate) fn id(self) -> &'static str {
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
  TrackerList {
    category: Category::Cryptomining,
    url: "https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/nocoin.txt",
  },
];

/// Як часто оновлювати списки й як часто перевіряти, чи не час, — як у блокувальника реклами.
const MAX_AGE: Duration = Duration::from_secs(4 * 24 * 60 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Кеш рушіїв: номер змінюється разом зі списками чи способом збирання.
const CACHE_VERSION: &str = "v1";

/// Мітки в адресах, за якими сайти й реклама впізнають, звідки ви прийшли (як privacy.query_stripping у Firefox).
const TRACKING_PARAMS: &[&str] = &[
  "__hsfp",
  "__hssc",
  "__hstc",
  "__s",
  "_hsenc",
  "_openstat",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "hsCtaTracking",
  "igshid",
  "li_fat_id",
  "mc_eid",
  "mkt_tok",
  "ml_subscriber",
  "ml_subscriber_hash",
  "msclkid",
  "oft_c",
  "oft_ck",
  "oft_d",
  "oft_id",
  "oft_ids",
  "oft_k",
  "oft_lk",
  "oft_sk",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "s_cid",
  "ttclid",
  "twclid",
  "vero_conv",
  "vero_id",
  "wbraid",
  "wickedid",
  "yclid",
];

/// Рівень захисту.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, specta::Type)]
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
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
  pub level: Level,
  /// Global Privacy Control: «не продавати й не поширювати мої дані».
  pub gpc: bool,
  /// Сайти (хост без www.), яким захист вимкнули, — разом з піддоменами.
  pub exceptions: Vec<String>,
  /// Microsoft Defender SmartScreen: попередження про фішинг і шкідливі завантаження (page_events.rs).
  pub smart_screen: bool,
}

impl Default for Rules {
  fn default() -> Self {
    Self { level: Level::Standard, gpc: true, exceptions: Vec::new(), smart_screen: true }
  }
}

impl Rules {
  /// Чи захищати сторінку з хостом `host`.
  pub fn protects(&self, host: &str) -> bool {
    self.level != Level::Off && !host.is_empty() && !self.exceptions.iter().any(|site| covers(site, host))
  }

  pub(crate) fn blocks(&self, category: Category) -> bool {
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
/// Заповнюється лише у Windows: у Linux скрипт GPC наступним документам ставить gtk_tracking.rs.
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

  /// Вікно `window` закрили — його правил більше не треба.
  pub fn forget(&self, window: &str) {
    if let Ok(mut rules) = self.rules.write() {
      rules.remove(window);
    }
  }

  /// Категорія елемента стеження, якщо запит `url` типу `kind` зі сторінки `source` треба заблокувати (запити WebView2;
  /// у Linux блокують фільтри WebKit).
  #[cfg_attr(not(windows), allow(dead_code))]
  pub fn check(&self, rules: &Rules, url: &str, source: &str, kind: &str, method: &str) -> Option<Category> {
    let engines = self.engines.read().ok()?;
    let request = Request::new(url, source, kind, method).ok()?;
    Category::ALL
      .into_iter()
      .filter(|category| rules.blocks(*category))
      .find(|category| engines.get(category).is_some_and(|engine| engine.check_network_request(&request).should_block()))
  }

  fn engine_file(dir: &Path, category: Category) -> PathBuf {
    dir.join(format!("tracking-{}-{CACHE_VERSION}.dat", category.id()))
  }

  /// Рушії з кешу попереднього запуску. У Linux — лише коли востаннє оновлено (за файлами правил для WebKit), а рушії
  /// попередніх версій прибираються з диска.
  fn load_cache(&self) {
    let Some(dir) = self.dir.get() else {
      return;
    };
    let mut oldest: Option<u64> = None;
    for category in Category::ALL {
      #[cfg(windows)]
      let (path, loaded) = {
        let path = Self::engine_file(dir, category);
        let mut engine = Engine::default();
        let loaded = fs::read(&path).is_ok_and(|bytes| engine.deserialize(&bytes).is_ok());
        if loaded {
          if let Ok(mut engines) = self.engines.write() {
            engines.insert(category, Arc::new(engine));
          }
        }
        (path, loaded)
      };
      #[cfg(not(windows))]
      let (path, loaded) = {
        let _ = fs::remove_file(Self::engine_file(dir, category));
        let path = Self::content_file(dir, category);
        let loaded = path.exists();
        (path, loaded)
      };
      if let Some(time) = modified_ms(&path).filter(|_| loaded) {
        oldest = Some(oldest.map_or(time, |oldest| oldest.min(time)));
      }
    }
    if let Ok(mut updated_at) = self.updated_at.lock() {
      *updated_at = oldest;
    }
  }

  fn is_stale(&self) -> bool {
    #[cfg(windows)]
    let complete = self.engines.read().is_ok_and(|engines| engines.len() == Category::ALL.len());
    // Без правил для WebKit фільтрів не буде.
    #[cfg(not(windows))]
    let complete =
      self.dir.get().is_some_and(|dir| Category::ALL.iter().all(|category| Self::content_file(dir, *category).exists()));
    let updated_at = self.updated_at.lock().ok().and_then(|time| *time);
    !complete || updated_at.is_none_or(|time| now_ms().saturating_sub(time) > MAX_AGE.as_millis() as u64)
  }

  /// Правила категорії `category` для WebKit (Linux, gtk_tracking.rs).
  #[cfg(not(windows))]
  pub(crate) fn content_file(dir: &Path, category: Category) -> PathBuf {
    dir.join(format!("tracking-content-{}-{CACHE_VERSION}.json", category.id()))
  }

  /// Завантажує свіжі списки й збирає з них рушії (у Linux — правила для фільтрів WebKit); старі працюють, доки нові не
  /// готові. true — оновлено.
  fn refresh(&self) -> bool {
    if self.updating.swap(true, Ordering::SeqCst) {
      return false;
    }
    let updated = match (download_lists(), self.dir.get()) {
      (Ok(texts), Some(dir)) => {
        self.build(dir, texts);
        if let Ok(mut updated_at) = self.updated_at.lock() {
          *updated_at = Some(now_ms());
        }
        true
      }
      (Ok(_), None) => false,
      (Err(message), _) => {
        log::warn!("tracking: не вдалося оновити списки: {message}");
        false
      }
    };
    self.updating.store(false, Ordering::SeqCst);
    updated
  }

  /// Рушії категорій — у кеш і на заміну попереднім.
  #[cfg(windows)]
  fn build(&self, dir: &Path, texts: HashMap<Category, Vec<String>>) {
    let _ = fs::create_dir_all(dir);
    for (category, engine) in engines(texts) {
      let _ = fs::write(Self::engine_file(dir, category), engine.serialize());
      if let Ok(mut engines) = self.engines.write() {
        engines.insert(category, Arc::new(engine));
      }
    }
  }

  /// WebKit блокує не рушіями, а фільтрами вмісту — правила для них із тих самих списків (gtk_tracking.rs).
  #[cfg(not(windows))]
  fn build(&self, dir: &Path, texts: HashMap<Category, Vec<String>>) {
    let options = ParseOptions { rule_types: RuleTypes::NetworkOnly, ..ParseOptions::default() };
    for (category, lists) in texts {
      match crate::adblock::content_rules(lists.into_iter().map(|text| (text, options))) {
        Ok(content) => {
          let _ = fs::create_dir_all(dir).and_then(|()| fs::write(Self::content_file(dir, category), content));
        }
        Err(message) => log::warn!("tracking: правила для WebKit не зібрано: {message}"),
      }
    }
    // Списки й правила — десятки мегабайтів, і вже не потрібні.
    crate::adblock::release_memory();
  }
}

/// Тексти списків — за категоріями.
fn download_lists() -> Result<HashMap<Category, Vec<String>>, String> {
  let urls: Vec<String> = LISTS.iter().map(|list| list.url.to_string()).collect();
  let mut texts: HashMap<Category, Vec<String>> = HashMap::new();
  for (list, text) in LISTS.iter().zip(download_all(&urls)) {
    let text = String::from_utf8(text?).map_err(|error| format!("{}: {error}", list.url))?;
    texts.entry(list.category).or_default().push(text);
  }
  Ok(texts)
}

#[cfg(windows)]
fn engines(texts: HashMap<Category, Vec<String>>) -> Vec<(Category, Engine)> {
  // Лише мережеві правила: ховати кнопки на сторінці — справа блокувальника реклами.
  let options = ParseOptions { rule_types: RuleTypes::NetworkOnly, ..ParseOptions::default() };
  texts
    .into_iter()
    .map(|(category, lists)| {
      let mut filters = FilterSet::new(false);
      for text in lists {
        filters.add_filter_list(text, options);
      }
      (category, Engine::new_with_filter_set(filters))
    })
    .collect()
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
  let _ = app.state::<Tracking>().dir.set(dir.clone());
  // WebKit блокує фільтрами вмісту, скомпільованими раніше (gtk_tracking.rs).
  #[cfg(target_os = "linux")]
  crate::gtk_tracking::load(app, dir.clone());
  let app = app.clone();
  thread::spawn(move || {
    let tracking = app.state::<Tracking>();
    tracking.load_cache();
    loop {
      let updated = tracking.is_stale() && tracking.refresh();
      #[cfg(target_os = "linux")]
      if updated {
        crate::gtk_tracking::compile(&app, dir.clone());
      }
      #[cfg(windows)]
      let _ = updated;
      thread::sleep(CHECK_EVERY);
    }
  });
}

/// Нові правила вікна (рівень, GPC, винятки, SmartScreen): запитам — одразу, вбудованому захисту WebView2, SmartScreen
/// і скрипту GPC — для всіх сторінок вікна.
#[tauri::command]
#[specta::specta]
pub fn tracking_set_rules(window: tauri::Window, rules: Rules) -> Result<(), String> {
  #[cfg(windows)]
  {
    let tracking = window.state::<Tracking>();
    let (level, gpc, smart_screen) = (rules.level, rules.gpc, rules.smart_screen);
    let previous = tracking.set_rules(window.label(), rules);
    let gpc_changed = previous.as_ref().is_none_or(|previous| previous.gpc != gpc);
    let level_changed = previous.as_ref().is_none_or(|previous| previous.level != level);
    let smart_screen_changed = previous.as_ref().is_none_or(|previous| previous.smart_screen != smart_screen);
    let pages = window.webviews().into_iter().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX));
    for webview in pages {
      if level_changed {
        crate::webview2::set_tracking_prevention(&webview, level).map_err(|error| error.to_string())?;
      }
      if smart_screen_changed {
        crate::page_events::set_smart_screen(&webview, smart_screen).map_err(|error| error.to_string())?;
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
  #[cfg(not(windows))]
  {
    // SmartScreen тут немає. Фільтри, захист WebKit і скрипт GPC наступних документів сторінок — gtk_tracking.rs (Linux),
    // а скрипт GPC поточних — одразу.
    let gpc = rules.gpc;
    let previous = window.state::<Tracking>().set_rules(window.label(), rules);
    #[cfg(target_os = "linux")]
    crate::gtk_tracking::apply_window(&window);
    if previous.as_ref().is_none_or(|previous| previous.gpc != gpc) {
      let pages = window.webviews().into_iter().filter(|webview| webview.label().starts_with(crate::pages::PAGE_PREFIX));
      for webview in pages {
        let _ = webview.eval(page_script(gpc));
      }
    }
    Ok(())
  }
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
      without_tracking_params(&url("https://shop.example/item?id=7&fbclid=abc&utm_source=mail&gclid=x#reviews"))
        .map(String::from),
      Some("https://shop.example/item?id=7&utm_source=mail#reviews".to_string())
    );
    assert_eq!(
      without_tracking_params(&url("https://example.com/?fbclid=abc")).map(String::from),
      Some("https://example.com/".to_string())
    );
    assert_eq!(without_tracking_params(&url("https://example.com/search?q=fbclid")), None);
  }
}
