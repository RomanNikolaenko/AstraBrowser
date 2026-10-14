//! Блокувальник реклами й трекерів, як AdGuard чи uBlock Origin: правила зі списків EasyList, EasyPrivacy,
//! uBlock і AdGuard перевіряє рушій adblock-rust від Brave.
//!
//! Мережеві правила відсікають запити сторінки (у Windows — webview2::block_ads; на macOS і Linux — сам WebKit за
//! тими самими правилами, перекладеними у формат блокувальників Safari, gtk_adblock.rs), а косметичні — ховають
//! рекламні блоки й запускають скриптлети uBlock Origin (як проти реклами на YouTube) скриптом на початку документа
//! (adblock-page.js). На macOS і Linux рушієві мережеві правила не потрібні (їх виконує WebKit), тож він там лише
//! косметичний і в кілька разів менший. Скриптлети й підмінні ресурси (порожній скрипт, прозора картинка тощо) беруться з
//! вихідного коду uBlock Origin. Списки оновлюються у фоні раз на 4 дні, а зібраний рушій кешується
//! в теці даних застосунку, щоб запуск не розбирав десятки тисяч правил заново.
//!
//! Не підтримуються загальні правила, що ховають елементи лише за класом чи id (`##.ad`): для них сторінка
//! мала б повідомляти, які класи має, а свого каналу від сайту до застосунку тут свідомо немає.

use std::{
  collections::{BTreeSet, HashMap, HashSet},
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
  lists::{FilterSet, ParseOptions},
  request::Request,
  resources::{MimeType, PermissionMask, Resource, ResourceType},
  Engine,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Url};

struct FilterList {
  name: &'static str,
  url: &'static str,
  /// Списки самого uBlock Origin — їм дозволені «довірені» скриптлети (див. TRUSTED).
  trusted: bool,
}

const LISTS: &[FilterList] = &[
  FilterList { name: "EasyList", url: "https://easylist.to/easylist/easylist.txt", trusted: false },
  FilterList { name: "EasyPrivacy", url: "https://easylist.to/easylist/easyprivacy.txt", trusted: false },
  FilterList { name: "uBlock filters", url: "https://ublockorigin.github.io/uAssets/filters/filters.min.txt", trusted: true },
  FilterList { name: "uBlock filters – Privacy", url: "https://ublockorigin.github.io/uAssets/filters/privacy.min.txt", trusted: true },
  FilterList { name: "uBlock filters – Unbreak", url: "https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt", trusted: true },
  FilterList { name: "uBlock filters – Quick fixes", url: "https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt", trusted: true },
  FilterList { name: "AdGuard Ukrainian filter", url: "https://filters.adtidy.org/extension/ublock/filters/23.txt", trusted: false },
];

/// Скриптлети, що можуть більше за інші (ставити cookies, переписувати відповіді сервера), — лише для
/// довірених списків, як в uBlock Origin.
const TRUSTED: PermissionMask = PermissionMask::from_bits(1);

/// Як часто оновлювати списки й як часто перевіряти, чи не час.
const MAX_AGE: Duration = Duration::from_secs(4 * 24 * 60 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

/// Кеш рушія й ресурсів. Номер у назві змінюється разом зі списками чи способом збирання рушія —
/// тоді кеш попередньої версії не підходить і прибирається.
#[cfg(windows)]
const ENGINE_FILE: &str = "adblock-engine-v2.dat";
/// На macOS і Linux рушій лише косметичний (cosmetic_rules) — і кеш свій.
#[cfg(not(windows))]
const ENGINE_FILE: &str = "adblock-engine-cosmetic-v1.dat";
const RESOURCES_FILE: &str = "adblock-resources-v2.json";
const SETTINGS_FILE: &str = "adblock.json";
/// Мережеві правила у форматі блокувальників Safari — для WebKit (macOS, Linux).
#[cfg(not(windows))]
pub(crate) const CONTENT_FILE: &str = "adblock-content-v1.json";

/// Реліз uBlock Origin зі скриптлетами, якщо GitHub не скаже про новіший.
const UBO_RELEASE: &str = "1.75.0";

/// Скрипт сторінки: `(host, selectors, procedural, runScriptlets) => { … }`.
const PAGE_SCRIPT: &str = include_str!("adblock-page.js");

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
  enabled: bool,
  /// Сайти (хост без www.), на яких блокування вимкнене, — разом з їхніми піддоменами.
  disabled_sites: BTreeSet<String>,
}

impl Default for Settings {
  fn default() -> Self {
    Self { enabled: true, disabled_sites: BTreeSet::new() }
  }
}

/// Стан для інтерфейсу; надсилається подією `adblock://status` щоразу, як змінюється.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  enabled: bool,
  disabled_sites: Vec<String>,
  /// Рушій зібрано — блокування працює.
  ready: bool,
  updating: bool,
  /// Коли списки востаннє оновилися (мс від 1970 року).
  updated_at: Option<u64>,
  /// Чому не вдалося останнє оновлення.
  error: Option<String>,
  lists: Vec<&'static str>,
}

/// Що робити із запитом сторінки.
// Перевіряє запити WebView2 (Windows); у Linux блокують фільтри WebKit, а це — для тестів.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Verdict {
  Allow,
  Block,
  /// Віддати замість відповіді сервера нешкідливий ресурс (порожній скрипт, прозору картинку тощо).
  Replace { mime: String, body: Vec<u8> },
}

#[derive(Default)]
pub struct AdBlock {
  engine: RwLock<Option<Arc<Engine>>>,
  settings: RwLock<Settings>,
  dir: OnceLock<PathBuf>,
  updating: AtomicBool,
  updated_at: Mutex<Option<u64>>,
  error: Mutex<Option<String>>,
}

impl AdBlock {
  fn engine(&self) -> Option<Arc<Engine>> {
    self.engine.read().ok()?.clone()
  }

  fn set_engine(&self, engine: Engine) {
    if let Ok(mut current) = self.engine.write() {
      *current = Some(Arc::new(engine));
    }
  }

  pub fn status(&self) -> Status {
    let settings = self.settings.read().map(|settings| settings.clone()).unwrap_or_default();
    Status {
      enabled: settings.enabled,
      disabled_sites: settings.disabled_sites.into_iter().collect(),
      ready: self.engine().is_some(),
      updating: self.updating.load(Ordering::SeqCst),
      updated_at: self.updated_at.lock().ok().and_then(|time| *time),
      error: self.error.lock().ok().and_then(|error| error.clone()),
      lists: LISTS.iter().map(|list| list.name).collect(),
    }
  }

  /// Чи блокувати рекламу на сторінці з хостом `host`.
  pub fn active_on(&self, host: &str) -> bool {
    let Ok(settings) = self.settings.read() else {
      return false;
    };
    settings.enabled && !host.is_empty() && !is_disabled(&settings.disabled_sites, host) && self.engine().is_some()
  }

  /// Запит `url` типу `kind` (script, image, xmlhttprequest, sub_frame…) зі сторінки `source`.
  #[cfg_attr(not(windows), allow(dead_code))]
  pub fn check(&self, url: &str, source: &str, kind: &str, method: &str) -> Verdict {
    let Some(engine) = self.engine() else {
      return Verdict::Allow;
    };
    let Ok(request) = Request::new(url, source, kind, method) else {
      return Verdict::Allow;
    };
    let result = engine.check_network_request(&request);
    if let Some((mime, body)) = result.redirect.as_deref().and_then(decode_data_url) {
      return Verdict::Replace { mime, body };
    }
    if result.should_block() {
      Verdict::Block
    } else {
      Verdict::Allow
    }
  }

  /// Скрипт, що ховає рекламні блоки й запускає скриптлети на сторінці `url`; `None` — нічого робити.
  pub fn page_script(&self, url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok().filter(|url| matches!(url.scheme(), "http" | "https"))?;
    let host = parsed.host_str()?;
    if !self.active_on(host) {
      return None;
    }
    let resources = self.engine()?.url_cosmetic_resources(url);
    let procedural: Vec<serde_json::Value> =
      resources.procedural_actions.iter().filter_map(|action| serde_json::from_str(action).ok()).collect();
    if resources.hide_selectors.is_empty() && procedural.is_empty() && resources.injected_script.is_empty() {
      return None;
    }
    let selectors: Vec<&String> = resources.hide_selectors.iter().collect();
    Some(format!(
      "({PAGE_SCRIPT})({}, {}, {}, (scriptletGlobals) => {{\n{}\n}});",
      json(host),
      json(&selectors),
      json(&procedural),
      resources.injected_script,
    ))
  }

  fn change(&self, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let mut settings = self.settings.write().map_err(|error| error.to_string())?;
    edit(&mut settings);
    let dir = self.dir.get().ok_or("No app data directory")?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let text = serde_json::to_vec_pretty(&*settings).map_err(|error| error.to_string())?;
    fs::write(dir.join(SETTINGS_FILE), text).map_err(|error| error.to_string())
  }

  fn is_stale(&self) -> bool {
    let updated_at = self.updated_at.lock().ok().and_then(|time| *time);
    updated_at.is_none_or(|time| now_ms().saturating_sub(time) > MAX_AGE.as_millis() as u64)
  }

  /// Рушій і ресурси з кешу попереднього запуску.
  fn load_cache(&self) {
    let Some(dir) = self.dir.get() else {
      return;
    };
    let path = dir.join(ENGINE_FILE);
    let Ok(bytes) = fs::read(&path) else {
      return;
    };
    let mut engine = Engine::default();
    if engine.deserialize(&bytes).is_err() {
      return;
    }
    engine.use_resources(cached_resources(dir));
    if let Ok(mut updated_at) = self.updated_at.lock() {
      *updated_at = modified_ms(&path);
    }
    self.set_engine(engine);
  }
}

fn is_disabled(sites: &BTreeSet<String>, host: &str) -> bool {
  sites.iter().any(|site| covers(site, host))
}

/// Чи стосується виняток для сайту `site` хоста `host` — самого сайту чи його піддомену.
pub(crate) fn covers(site: &str, host: &str) -> bool {
  let host = host.strip_prefix("www.").unwrap_or(host);
  host == site || host.strip_suffix(site).is_some_and(|rest| rest.ends_with('.'))
}

/// Хост сайту для списку винятків: у нижньому регістрі й без www.
fn normalize_site(site: &str) -> Option<String> {
  let url = Url::parse(&format!("https://{}/", site.trim())).ok()?;
  let host = url.host_str()?;
  Some(host.strip_prefix("www.").unwrap_or(host).to_string())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
  let (mime, data) = url.strip_prefix("data:")?.split_once(";base64,")?;
  Some((mime.to_string(), BASE64.decode(data).ok()?))
}

fn json<T: Serialize + ?Sized>(value: &T) -> String {
  serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

fn modified_ms(path: &Path) -> Option<u64> {
  let modified = fs::metadata(path).ok()?.modified().ok()?;
  Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Кеш попередніх версій (інші списки, інший формат) — лише займав би місце.
fn remove_old_caches(dir: &Path) {
  let Ok(entries) = fs::read_dir(dir) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name().to_string_lossy().into_owned();
    let cache = name.starts_with("adblock-engine") || name.starts_with("adblock-resources");
    if cache && name != ENGINE_FILE && name != RESOURCES_FILE {
      let _ = fs::remove_file(entry.path());
    }
  }
}

fn cached_resources(dir: &Path) -> Vec<Resource> {
  fs::read(dir.join(RESOURCES_FILE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Повідомляє всім вікнам новий стан (сторінки сайтів подій не слухають, тож їм нічого не надходить).
fn broadcast(app: &AppHandle) {
  let _ = app.emit("adblock://status", app.state::<AdBlock>().status());
}

/// Налаштування з диска, рушій з кешу, а далі — оновлення списків у фоні. Викликається при запуску.
pub fn start(app: &AppHandle) {
  let Ok(dir) = app.path().app_data_dir() else {
    return;
  };
  let adblock = app.state::<AdBlock>();
  if let Some(settings) = fs::read(dir.join(SETTINGS_FILE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
    if let Ok(mut current) = adblock.settings.write() {
      *current = settings;
    }
  }
  remove_old_caches(&dir);
  let _ = adblock.dir.set(dir.clone());

  let app = app.clone();
  thread::spawn(move || {
    let adblock = app.state::<AdBlock>();
    adblock.load_cache();
    release_memory();
    // Правил для WebKit ще немає (рушій з версії без них) — списки оновлюються одразу.
    #[cfg(not(windows))]
    if !dir.join(CONTENT_FILE).exists() {
      if let Ok(mut updated_at) = adblock.updated_at.lock() {
        *updated_at = None;
      }
    }
    #[cfg(target_os = "linux")]
    crate::gtk_adblock::load(&app, dir.clone());
    broadcast(&app);
    loop {
      if app.state::<AdBlock>().is_stale() {
        refresh(&app);
      }
      thread::sleep(CHECK_EVERY);
    }
  });
}

/// Завантажує свіжі списки й ресурси та збирає з них новий рушій; старий працює, доки новий не готовий.
fn refresh(app: &AppHandle) {
  let adblock = app.state::<AdBlock>();
  if adblock.updating.swap(true, Ordering::SeqCst) {
    return;
  }
  broadcast(app);

  let Some(dir) = adblock.dir.get().cloned() else {
    adblock.updating.store(false, Ordering::SeqCst);
    return;
  };
  let result = build(&dir).and_then(|(engine, resources, content)| {
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(dir.join(ENGINE_FILE), engine.serialize()).map_err(|error| error.to_string())?;
    fs::write(dir.join(RESOURCES_FILE), json(&resources)).map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    fs::write(dir.join(CONTENT_FILE), content).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let _ = content;
    Ok(engine)
  });
  match result {
    Ok(engine) => {
      adblock.set_engine(engine);
      #[cfg(target_os = "linux")]
      crate::gtk_adblock::compile(app, dir.clone());
      if let Ok(mut updated_at) = adblock.updated_at.lock() {
        *updated_at = Some(now_ms());
      }
      if let Ok(mut error) = adblock.error.lock() {
        *error = None;
      }
    }
    Err(message) => {
      log::warn!("adblock: не вдалося оновити списки: {message}");
      if let Ok(mut error) = adblock.error.lock() {
        *error = Some(message);
      }
    }
  }
  adblock.updating.store(false, Ordering::SeqCst);
  broadcast(app);
  // Списки, правила й попередній рушій — десятки мегабайтів, і вже не потрібні.
  release_memory();
}

/// Звільнене після великої роботи — системі. glibc (Linux) інакше тримає звільнену пам'ять за процесом, і браузер після
/// оновлення списків займав би на десятки мегабайтів більше.
pub(crate) fn release_memory() {
  #[cfg(all(target_os = "linux", target_env = "gnu"))]
  unsafe {
    libc::malloc_trim(0);
  }
}

/// Свіжі списки: рушій, ресурси (скриптлети, підмінні файли) і, для WebKit (macOS, Linux), мережеві правила у
/// форматі блокувальників Safari (JSON; у Windows — порожньо).
fn build(dir: &Path) -> Result<(Engine, Vec<Resource>, Vec<u8>), String> {
  let urls: Vec<String> = LISTS.iter().map(|list| list.url.to_string()).collect();
  let mut lists = Vec::new();
  for (list, text) in LISTS.iter().zip(download_all(&urls)) {
    let text = String::from_utf8(text?).map_err(|error| format!("{}: {error}", list.url))?;
    let permissions = if list.trusted { TRUSTED } else { PermissionMask::default() };
    lists.push((text, ParseOptions { permissions, ..ParseOptions::default() }));
  }
  let mut filters = FilterSet::new(false);
  #[cfg(windows)]
  let content = {
    for (text, options) in lists {
      filters.add_filter_list(text, options);
    }
    Vec::new()
  };
  // Рушієві — лише косметика, а мережеві правила виконає WebKit.
  #[cfg(not(windows))]
  let content = {
    for (text, options) in &lists {
      filters.add_filter_list(cosmetic_rules(text), *options);
    }
    content_rules(lists)?
  };
  let mut engine = Engine::new_with_filter_set(filters);

  // Без свіжих скриптлетів рушій усе одно корисний — тоді беремо їх з попереднього оновлення.
  let resources = ubo_resources().unwrap_or_else(|error| {
    log::warn!("adblock: не вдалося завантажити скриптлети uBlock Origin: {error}");
    cached_resources(dir)
  });
  engine.use_resources(resources.clone());
  Ok((engine, resources, content))
}

/// Мережеві правила списків — у форматі блокувальників Safari (JSON) для WebKit (і захисту від стеження, tracking.rs).
/// Косметичних серед них немає: рекламні блоки й так ховає скрипт сторінки (adblock-page.js), тут вони лише подвоїли б
/// і без того великий список.
#[cfg(not(windows))]
pub(crate) fn content_rules(lists: impl IntoIterator<Item = (String, ParseOptions)>) -> Result<Vec<u8>, String> {
  use adblock::content_blocking::CbType;
  let mut filters = FilterSet::new(true);
  for (text, options) in lists {
    filters.add_filter_list(text, options);
  }
  let (rules, _) = filters.into_content_blocking().map_err(|()| "content blocking: no debug filter set".to_string())?;
  let rules: Vec<_> = rules.into_iter().filter(|rule| rule.action.typ != CbType::CssDisplayNone).collect();
  log::info!("adblock: правил для WebKit — {}", rules.len());
  serde_json::to_vec(&rules).map_err(|error| error.to_string())
}

/// Рядки списку, потрібні рушієві там, де запити блокує сам WebKit (macOS, Linux): косметичні правила й скриптлети (усі
/// з `#`, як і директиви `!#if`) і мережеві винятки, що вимикають косметику на сайті ($generichide, $elemhide…), — без
/// них рушій ховав би блоки й там, де списки цього не дозволяють.
#[cfg(not(windows))]
fn cosmetic_rules(list: &str) -> String {
  const HIDING: [&str; 6] = ["generichide", "ghide", "elemhide", "ehide", "specifichide", "shide"];
  let lines: Vec<&str> = list.lines().filter(|line| line.contains('#') || HIDING.iter().any(|option| line.contains(option))).collect();
  lines.join("\n")
}

fn agent() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      .timeout_global(Some(Duration::from_secs(60)))
      .user_agent("AstraBrowser")
      .build()
      .into()
  })
}

fn download(url: &str) -> Result<Vec<u8>, String> {
  agent()
    .get(url)
    .call()
    .map_err(|error| format!("{url}: {error}"))?
    .body_mut()
    .with_config()
    .limit(32 * 1024 * 1024)
    .read_to_vec()
    .map_err(|error| format!("{url}: {error}"))
}

/// Завантажує кілька адрес паралельно (по вісім); результати — в тому ж порядку.
pub(crate) fn download_all(urls: &[String]) -> Vec<Result<Vec<u8>, String>> {
  urls
    .chunks(8)
    .flat_map(|chunk| {
      thread::scope(|scope| {
        let downloads: Vec<_> = chunk.iter().map(|url| scope.spawn(move || download(url))).collect();
        downloads
          .into_iter()
          .map(|download| download.join().unwrap_or_else(|_| Err("download failed".into())))
          .collect::<Vec<_>>()
      })
    })
    .collect()
}

fn ubo_release() -> Result<String, String> {
  #[derive(Deserialize, specta::Type)]
  struct Release {
    tag_name: String,
  }
  let body = download("https://api.github.com/repos/gorhill/uBlock/releases/latest")?;
  let release: Release = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
  let valid = !release.tag_name.is_empty() && release.tag_name.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c));
  if valid {
    Ok(release.tag_name)
  } else {
    Err(format!("Unexpected uBlock Origin release: {}", release.tag_name))
  }
}

/// Скриптлети й підмінні ресурси з вихідного коду uBlock Origin (src/js/resources, web_accessible_resources).
fn ubo_resources() -> Result<Vec<Resource>, String> {
  let release = ubo_release().unwrap_or_else(|_| UBO_RELEASE.to_string());
  let src = format!("https://raw.githubusercontent.com/gorhill/uBlock/{release}/src/");
  let mut resources = scriptlets(&scriptlet_sources(&format!("{src}js/"))?);
  if resources.is_empty() {
    return Err("No scriptlets found in uBlock Origin sources".into());
  }
  resources.extend(redirect_resources(&src)?);
  Ok(resources)
}

/// Файли зі скриптлетами: resources/scriptlets.js і все, що він імпортує (у межах src/js).
fn scriptlet_sources(base: &str) -> Result<Vec<String>, String> {
  let import = Regex::new(r#"(?:from|import)\s+'(\.{1,2}/[^'\s]+\.js)'"#).map_err(|error| error.to_string())?;
  let mut seen = HashSet::from(["resources/scriptlets.js".to_string()]);
  let mut wave = vec!["resources/scriptlets.js".to_string()];
  let mut sources = Vec::new();
  while !wave.is_empty() {
    let urls: Vec<String> = wave.iter().map(|path| format!("{base}{path}")).collect();
    let mut next = Vec::new();
    for (path, body) in wave.iter().zip(download_all(&urls)) {
      let text = String::from_utf8(body?).map_err(|error| error.to_string())?.replace("\r\n", "\n");
      for found in import.captures_iter(&text) {
        if let Some(target) = join_path(path, &found[1]) {
          if seen.insert(target.clone()) {
            next.push(target);
          }
        }
      }
      sources.push(text);
    }
    wave = next;
  }
  Ok(sources)
}

/// Відносний шлях імпорту від файлу `from` (усе — відносно src/js); `None`, якщо виходить за її межі.
fn join_path(from: &str, relative: &str) -> Option<String> {
  let mut parts: Vec<&str> = from.split('/').collect();
  parts.pop();
  for part in relative.split('/') {
    match part {
      "." | "" => {}
      ".." => {
        parts.pop()?;
      }
      part => parts.push(part),
    }
  }
  Some(parts.join("/"))
}

/// Розбирає скриптлети uBlock Origin. Кожен — функція чи клас верхнього рівня (до `}` на початку рядка),
/// зареєстрований як `registerScriptlet(fn, { name, aliases, dependencies, requiresTrust })` або
/// `builtinScriptlets.push({ name, fn, … })`; залежності — інші такі ж функції, за назвою чи за іменем.
fn scriptlets(files: &[String]) -> Vec<Resource> {
  let definition = Regex::new(r"^(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*([\w$]+)|class\s+([\w$]+))").unwrap();
  let register = Regex::new(r"(?s)registerScriptlet\(\s*([\w$]+)\s*,\s*\{(.*?)\n\}\);").unwrap();
  let push = Regex::new(r"(?s)builtinScriptlets\.push\(\{(.*?)\n\}\);").unwrap();
  let name = Regex::new(r"name:\s*'([^']+)'").unwrap();
  let function = Regex::new(r"fn:\s*([\w$]+)").unwrap();
  let quoted = Regex::new(r"'([^']+)'").unwrap();

  let mut definitions = HashMap::new();
  for file in files {
    let mut current: Option<(String, String)> = None;
    for line in file.lines() {
      if let Some((_, body)) = current.as_mut() {
        body.push_str(line);
        body.push('\n');
        if line == "}" {
          let (name, body) = current.take().unwrap_or_default();
          definitions.insert(name, body);
        }
        continue;
      }
      let Some(found) = definition.captures(line) else {
        continue;
      };
      let ident = found.get(1).or(found.get(2)).map_or("", |ident| ident.as_str()).to_string();
      let start = line.strip_prefix("export ").unwrap_or(line).trim_start();
      // Функція в один рядок: `function noop() {}`.
      if start.contains('{') && start.matches('{').count() == start.matches('}').count() {
        definitions.insert(ident, format!("{start}\n"));
      } else {
        current = Some((ident, format!("{start}\n")));
      }
    }
  }

  struct Registration {
    ident: String,
    name: String,
    aliases: Vec<String>,
    dependencies: Vec<String>,
    trusted: bool,
  }
  let list = |details: &str, key: &str| -> Vec<String> {
    let pattern = Regex::new(&format!(r"(?s){key}:\s*\[(.*?)\]")).unwrap();
    pattern.captures(details).map_or_else(Vec::new, |found| {
      found[1].split(',').map(|item| item.trim().to_string()).filter(|item| !item.is_empty()).collect()
    })
  };
  let parse = |ident: Option<&str>, details: &str| -> Option<Registration> {
    Some(Registration {
      ident: ident?.to_string(),
      name: name.captures(details)?[1].to_string(),
      aliases: list(details, "aliases").iter().filter_map(|alias| quoted.captures(alias).map(|found| found[1].to_string())).collect(),
      dependencies: list(details, "dependencies"),
      trusted: details.contains("requiresTrust: true"),
    })
  };

  let mut registrations = Vec::new();
  for file in files {
    for found in register.captures_iter(file) {
      registrations.extend(parse(Some(&found[1]), &found[2]));
    }
    for found in push.captures_iter(file) {
      registrations.extend(parse(function.captures(&found[1]).map(|ident| ident.get(1).map_or("", |ident| ident.as_str())), &found[1]));
    }
  }

  let names: HashMap<&str, &str> = registrations.iter().map(|registration| (registration.ident.as_str(), registration.name.as_str())).collect();
  registrations
    .iter()
    .filter_map(|registration| {
      let source = definitions.get(&resolve(&registration.ident, &definitions, files)?)?;
      let dependencies = registration
        .dependencies
        .iter()
        .filter_map(|dependency| match quoted.captures(dependency) {
          Some(found) => Some(found[1].to_string()),
          None => names.get(dependency.as_str()).map(|name| name.to_string()),
        })
        .collect();
      // Самі скриптлети (*.js) вставляються в сторінку, а допоміжні функції (*.fn) — лише як їхні залежності.
      let mime = if registration.name.ends_with(".fn") { MimeType::FnJavascript } else { MimeType::ApplicationJavascript };
      Some(Resource {
        name: registration.name.clone(),
        aliases: registration.aliases.clone(),
        kind: ResourceType::Mime(mime),
        content: BASE64.encode(source),
        dependencies,
        permission: if registration.trusted { TRUSTED } else { PermissionMask::default() },
      })
    })
    .collect()
}

/// Ім'я, під яким функцію визначено. Класи з інших частин uBlock Origin реєструються через псевдонім:
/// `import { JSONPath as __JSONPath__ } from '../jsonpath.js'; export const JSONPath = __JSONPath__;`.
fn resolve(ident: &str, definitions: &HashMap<String, String>, files: &[String]) -> Option<String> {
  if definitions.contains_key(ident) {
    return Some(ident.to_string());
  }
  let alias = Regex::new(&format!(r"const\s+{}\s*=\s*([\w$]+);", regex::escape(ident))).ok()?;
  let target = files.iter().find_map(|file| alias.captures(file).map(|found| found[1].to_string()))?;
  let import = Regex::new(&format!(r"import\s*\{{\s*([\w$]+)\s+as\s+{}\s*\}}", regex::escape(&target))).ok()?;
  files.iter().find_map(|file| import.captures(file).map(|found| found[1].to_string())).filter(|name| definitions.contains_key(name))
}

/// Підмінні ресурси для правил `$redirect=` (src/js/redirect-resources.js): назва, псевдоніми, сам файл.
fn redirect_resources(src: &str) -> Result<Vec<Resource>, String> {
  let manifest = String::from_utf8(download(&format!("{src}js/redirect-resources.js"))?).map_err(|error| error.to_string())?;
  let entry = Regex::new(r"(?s)\[\s*'([^']+)'\s*,\s*\{(.*?)\}\s*\]").unwrap();
  let alias = Regex::new(r"(?s)alias:\s*(\[.*?\]|'[^']+')").unwrap();
  let quoted = Regex::new(r"'([^']+)'").unwrap();

  // Ресурси з параметрами чи лише для довірених списків правилам $redirect не потрібні.
  let entries: Vec<(String, Vec<String>)> = entry
    .captures_iter(&manifest)
    .filter(|found| !found[2].contains("params") && !found[2].contains("requiresTrust"))
    .map(|found| {
      let aliases = alias.captures(&found[2]).map_or_else(Vec::new, |aliases| {
        quoted.captures_iter(&aliases[1]).map(|alias| alias[1].to_string()).collect()
      });
      (found[1].to_string(), aliases)
    })
    .collect();
  let urls: Vec<String> = entries.iter().map(|(name, _)| format!("{src}web_accessible_resources/{name}")).collect();

  Ok(
    entries
      .into_iter()
      .zip(download_all(&urls))
      .filter_map(|((name, aliases), body)| {
        let mime = match MimeType::from_extension(&name) {
          MimeType::Unknown => MimeType::TextPlain,
          mime => mime,
        };
        Some(Resource {
          content: BASE64.encode(body.ok()?),
          name,
          aliases,
          kind: ResourceType::Mime(mime),
          dependencies: Vec::new(),
          permission: PermissionMask::default(),
        })
      })
      .collect(),
  )
}

#[tauri::command]
#[specta::specta]
pub fn adblock_status(adblock: State<'_, AdBlock>) -> Status {
  adblock.status()
}

/// Вмикає чи вимикає блокування на всіх сайтах; відкриті сторінки побачать зміну після перезавантаження.
#[tauri::command]
#[specta::specta]
pub fn adblock_set_enabled(app: AppHandle, adblock: State<'_, AdBlock>, enabled: bool) -> Result<(), String> {
  adblock.change(|settings| settings.enabled = enabled)?;
  broadcast(&app);
  Ok(())
}

/// Вимикає блокування на сайті `site` (хост сторінки) і його піддоменах або знову вмикає —
/// тоді прибираються й винятки для ширших доменів, що його накривають (example.com для news.example.com).
#[tauri::command]
#[specta::specta]
pub fn adblock_set_site_enabled(app: AppHandle, adblock: State<'_, AdBlock>, site: String, enabled: bool) -> Result<(), String> {
  let site = normalize_site(&site).ok_or_else(|| format!("Invalid site: {site}"))?;
  adblock.change(|settings| {
    if enabled {
      settings.disabled_sites.retain(|disabled| !covers(disabled, &site));
    } else {
      settings.disabled_sites.insert(site);
    }
  })?;
  broadcast(&app);
  Ok(())
}

/// Оновлює списки зараз, не чекаючи чотирьох днів.
#[tauri::command]
#[specta::specta]
pub fn adblock_update(app: AppHandle) {
  thread::spawn(move || refresh(&app));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn blocker_is_on_right_after_install() {
    assert!(AdBlock::default().status().enabled);
    // І коли файл налаштувань є, але цього поля в ньому немає.
    let settings: Settings = serde_json::from_str(r#"{"disabledSites":[]}"#).expect("settings");
    assert!(settings.enabled);
  }

  #[test]
  fn disabled_site_covers_its_subdomains_only() {
    let sites = BTreeSet::from(["example.com".to_string()]);
    assert!(is_disabled(&sites, "example.com"));
    assert!(is_disabled(&sites, "www.example.com"));
    assert!(is_disabled(&sites, "news.example.com"));
    assert!(!is_disabled(&sites, "badexample.com"));
    assert!(!is_disabled(&sites, "example.org"));
    assert!(covers("example.com", "news.example.com") && !covers("news.example.com", "example.com"));
  }

  #[test]
  fn sites_are_normalized() {
    assert_eq!(normalize_site(" WWW.Example.COM ").as_deref(), Some("example.com"));
    assert_eq!(normalize_site("bad host"), None);
  }

  #[test]
  fn imports_resolve_inside_src_js() {
    assert_eq!(join_path("resources/scriptlets.js", "./utils.js").as_deref(), Some("resources/utils.js"));
    assert_eq!(join_path("resources/shared.js", "../jsonpath.js").as_deref(), Some("jsonpath.js"));
    assert_eq!(join_path("jsonpath.js", "../outside.js"), None);
  }

  #[test]
  fn data_urls_are_decoded() {
    assert_eq!(decode_data_url("data:text/plain;base64,aGk="), Some(("text/plain".to_string(), b"hi".to_vec())));
    assert_eq!(decode_data_url("https://example.com"), None);
  }

  const SOURCES: &str = r#"
import { JSONPath as __JSONPath__ } from '../jsonpath.js';
export const JSONPath = __JSONPath__;
registerScriptlet(JSONPath, {
    name: 'jsonpath.fn',
});

export function safeSelf() {
    return {};
}
registerScriptlet(safeSelf, {
    name: 'safe-self.fn',
});

function setConstant(
    chain = '',
    value = ''
) {
    const safe = safeSelf();
    if ( chain === '' ) { return; }
}
registerScriptlet(setConstant, {
    name: 'set-constant.js',
    aliases: [
        'set.js',
    ],
    dependencies: [
        safeSelf,
        'jsonpath.fn',
    ],
});

builtinScriptlets.push({
    name: 'trusted-set-cookie.js',
    requiresTrust: true,
    fn: trustedSetCookie,
    dependencies: [
        'safe-self.fn',
    ],
});
async function trustedSetCookie(name = '') {
    await Promise.resolve(name);
}
"#;

  const JSONPATH: &str = "export class JSONPath {\n    static create() {}\n}\n";

  #[test]
  fn scriptlets_are_parsed_from_ublock_sources() {
    let resources = scriptlets(&[SOURCES.to_string(), JSONPATH.to_string()]);
    let find = |name: &str| resources.iter().find(|resource| resource.name == name).unwrap_or_else(|| panic!("no {name}"));
    let source = |name: &str| String::from_utf8(BASE64.decode(&find(name).content).unwrap()).unwrap();

    assert_eq!(resources.len(), 4);
    assert!(source("set-constant.js").starts_with("function setConstant(\n    chain = '',"));
    assert!(source("set-constant.js").ends_with("    if ( chain === '' ) { return; }\n}\n"));
    assert_eq!(find("set-constant.js").aliases, ["set.js"]);
    assert_eq!(find("set-constant.js").dependencies, ["safe-self.fn", "jsonpath.fn"]);
    assert!(source("safe-self.fn").starts_with("function safeSelf() {"));
    assert!(source("jsonpath.fn").starts_with("class JSONPath {"));
    assert!(source("trusted-set-cookie.js").starts_with("async function trustedSetCookie"));
    assert_eq!(find("trusted-set-cookie.js").permission.to_bits(), TRUSTED.to_bits());
    assert_eq!(find("set-constant.js").permission.to_bits(), 0);
    assert!(matches!(find("set-constant.js").kind, ResourceType::Mime(MimeType::ApplicationJavascript)));
    assert!(matches!(find("safe-self.fn").kind, ResourceType::Mime(MimeType::FnJavascript)));
  }

  /// Справжні списки й скриптлети з мережі: `cargo test real_lists -- --ignored --nocapture`.
  #[test]
  #[ignore]
  fn real_lists() {
    let started = std::time::Instant::now();
    let (engine, resources, _) = build(&std::env::temp_dir()).expect("lists");
    let scriptlets = resources.iter().filter(|resource| resource.name.ends_with(".js") || resource.name.ends_with(".fn")).count();
    eprintln!("built in {:?}: {} resources, {scriptlets} of them scripts", started.elapsed(), resources.len());

    let adblock = AdBlock::default();
    adblock.set_engine(engine);
    // Запити перевіряє лише рушій Windows: на macOS і Linux він косметичний.
    #[cfg(windows)]
    {
      let ads = adblock.check("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "https://example.com/", "script", "GET");
      assert!(matches!(ads, Verdict::Block | Verdict::Replace { .. }));
      assert!(matches!(adblock.check("https://www.google-analytics.com/analytics.js", "https://example.com/", "script", "GET"), Verdict::Block | Verdict::Replace { .. }));
      assert!(matches!(adblock.check("https://example.com/app.js", "https://example.com/", "script", "GET"), Verdict::Allow));
    }

    let script = adblock.page_script("https://www.youtube.com/watch?v=dQw4w9WgXcQ").expect("youtube script");
    eprintln!("youtube script: {} bytes", script.len());
    assert!(script.contains("function jsonPrune"));
    let _ = fs::write(std::env::temp_dir().join("astra-youtube-script.js"), &script);
  }

  /// Що рушій ховає й запускає на сторінці `url` (множини — без порядку).
  #[cfg(not(windows))]
  fn cosmetics(engine: &Engine, url: &str) -> (HashSet<String>, HashSet<String>, HashSet<String>, String, bool) {
    let found = engine.url_cosmetic_resources(url);
    (found.hide_selectors, found.procedural_actions, found.exceptions, found.injected_script, found.generichide)
  }

  /// Косметичний рушій (macOS, Linux) ховає й запускає на сторінках те саме, що й повний, — разом із винятками
  /// $generichide і $elemhide.
  #[cfg(not(windows))]
  #[test]
  fn cosmetic_engine_hides_the_same() {
    let list = [
      "||ads.example^",
      "||cdn.example/tracker.js$script,redirect=noop.js",
      "##.ad-banner",
      "example.org##.sponsored",
      "example.org#@#.ad-banner",
      "example.org##div:has-text(Sponsored):remove()",
      "@@||quiet.example^$generichide",
      "@@||plain.example^$elemhide",
      "news.example##+js(set-constant, ads, false)",
      "!#if false",
      "hidden.example##.never",
      "!#endif",
    ]
    .join("\n");
    let engine = |text: String| {
      let mut filters = FilterSet::new(false);
      filters.add_filter_list(text, ParseOptions { permissions: TRUSTED, ..ParseOptions::default() });
      let mut engine = Engine::new_with_filter_set(filters);
      engine.use_resources(scriptlets(&[SOURCES.to_string(), JSONPATH.to_string()]));
      engine
    };
    let cosmetic_list = cosmetic_rules(&list);
    assert!(!cosmetic_list.contains("||ads.example^") && cosmetic_list.contains("$generichide"));
    let (full, cosmetic) = (engine(list), engine(cosmetic_list));
    for url in ["https://example.org/", "https://quiet.example/", "https://plain.example/", "https://news.example/", "https://hidden.example/"] {
      assert_eq!(cosmetics(&full, url), cosmetics(&cosmetic, url), "{url}");
    }
  }

  /// Те саме на справжніх списках, і наскільки менший косметичний рушій:
  /// `cargo test cosmetic_engine_on_real_lists -- --ignored --nocapture`.
  #[cfg(not(windows))]
  #[test]
  #[ignore]
  fn cosmetic_engine_on_real_lists() {
    let urls: Vec<String> = LISTS.iter().map(|list| list.url.to_string()).collect();
    let texts: Vec<(String, ParseOptions)> = LISTS
      .iter()
      .zip(download_all(&urls))
      .map(|(list, text)| {
        let permissions = if list.trusted { TRUSTED } else { PermissionMask::default() };
        (String::from_utf8(text.expect("list")).expect("utf-8"), ParseOptions { permissions, ..ParseOptions::default() })
      })
      .collect();
    let engine = |only_cosmetic: bool| {
      let mut filters = FilterSet::new(false);
      for (text, options) in &texts {
        filters.add_filter_list(if only_cosmetic { cosmetic_rules(text) } else { text.clone() }, *options);
      }
      Engine::new_with_filter_set(filters)
    };
    let (full, cosmetic) = (engine(false), engine(true));
    eprintln!("рушій: повний {} байтів, косметичний {} байтів", full.serialize().len(), cosmetic.serialize().len());
    for url in [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.google.com/search?q=astra",
      "https://www.pravda.com.ua/",
      "https://rozetka.com.ua/",
      "https://www.facebook.com/",
      "https://edition.cnn.com/",
      "https://github.com/",
      "https://example.com/",
    ] {
      assert!(cosmetics(&full, url) == cosmetics(&cosmetic, url), "{url}");
    }
  }

  #[test]
  fn engine_blocks_redirects_and_injects() {
    let mut filters = FilterSet::new(false);
    filters.add_filter_list(
      [
        "||ads.example^",
        "||cdn.example/tracker.js$script,redirect=noop.js",
        "example.org##.banner",
        "example.org##+js(set-constant, ads, false)",
        "example.org##div:has-text(Sponsored):remove()",
      ]
      .join("\n"),
      ParseOptions { permissions: TRUSTED, ..ParseOptions::default() },
    );
    let mut engine = Engine::new_with_filter_set(filters);
    let mut resources = scriptlets(&[SOURCES.to_string(), JSONPATH.to_string()]);
    resources.push(Resource {
      name: "noop.js".into(),
      aliases: vec![],
      kind: ResourceType::Mime(MimeType::ApplicationJavascript),
      content: BASE64.encode("(function(){})();"),
      dependencies: vec![],
      permission: PermissionMask::default(),
    });
    engine.use_resources(resources);

    let adblock = AdBlock::default();
    adblock.set_engine(engine);
    let _ = adblock.dir.set(std::env::temp_dir());

    assert!(matches!(adblock.check("https://ads.example/banner.png", "https://example.org/", "image", "GET"), Verdict::Block));
    assert!(matches!(adblock.check("https://example.org/logo.png", "https://example.org/", "image", "GET"), Verdict::Allow));
    match adblock.check("https://cdn.example/tracker.js", "https://example.org/", "script", "GET") {
      Verdict::Replace { mime, body } => assert_eq!((mime.as_str(), body.as_slice()), ("application/javascript", b"(function(){})();".as_slice())),
      _ => panic!("tracker.js should be replaced"),
    }

    let script = adblock.page_script("https://example.org/page").expect("cosmetic script");
    assert!(script.contains(r#"("example.org", [".banner"], [{"#));
    assert!(script.contains(r#""has-text""#) && script.contains(r#""Sponsored""#) && script.contains(r#""remove""#));
    assert!(script.contains("function setConstant("));
    assert!(script.contains("function safeSelf("));
    assert!(script.contains(r#"setConstant("ads", "false")"#));
    assert!(adblock.page_script("https://example.com/").is_none());

    if let Ok(mut settings) = adblock.settings.write() {
      settings.disabled_sites.insert("example.org".into());
    }
    assert!(adblock.page_script("https://example.org/page").is_none());
    assert!(!adblock.active_on("www.example.org"));
  }
}
