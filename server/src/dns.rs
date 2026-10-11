//! DNS через HTTPS, як у Firefox і Chrome: запити про назви сайтів шифруються, тож провайдерові й іншим у мережі
//! складніше дізнатися, які сайти ви відкриваєте.
//!
//! Окремого API для цього WebView2 не має, а його рушій (Chromium) бере режим із власних налаштувань — файла
//! «Local State» у теці даних WebView2 (`dns_over_https.mode` і `.templates`, ті самі, що пише сторінка налаштувань
//! Edge). Читає він їх лише під час запуску, тож налаштування записуються до того, як застосунок створить перше
//! вікно ([`prepare`]), а змінені — діють після перезапуску браузера ([`dns_restart`]: вікна закриваються, браузер
//! WebView2 виходить, і вікно відкривається знову — сам застосунок при цьому не виходить). Вибір зберігається
//! в dns.json у локальній теці даних застосунку: це налаштування комп'ютера, а не облікового запису.
//!
//! Записувати можна, лише поки браузер у теці не працює: виходячи, він сам переписує «Local State» тим, що прочитав
//! під час запуску. Тож запис чекає, поки браузер відпустить теку ([`in_use`]).

use std::{
  fs,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  thread,
  time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Url};

const SETTINGS_FILE: &str = "dns.json";
/// Скільки чекати, поки браузер WebView2 вийде й відпустить свою теку.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  /// Захищений DNS, якщо його підтримує ваш постачальник DNS (як за замовчуванням у Chrome й Edge).
  #[default]
  Default,
  /// Через вибраного постачальника, а якщо він недоступний — звичайний DNS.
  Increased,
  /// Лише через вибраного постачальника: без нього сайти не відкриваються.
  Max,
  Off,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
  #[default]
  Cloudflare,
  Google,
  Quad9,
  Adguard,
  Custom,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize, specta::Type)]
// Без serde(default): з ним specta зробила б поля необов'язковими й у відповіді. Файл налаштувань завжди пише
// сам застосунок, з усіма полями, а якщо він зіпсований — діють типові налаштування (Settings::default).
#[serde(rename_all = "camelCase")]
#[serde(rename = "DnsSettings")]
pub struct Settings {
  pub mode: Mode,
  pub provider: Provider,
  /// Адреса власного постачальника (шаблон DoH, https://…), якщо `provider` — Custom.
  pub custom: String,
}

impl Settings {
  /// Шаблон DoH вибраного постачальника; `None` — власна адреса некоректна.
  fn template(&self) -> Option<String> {
    Some(
      match self.provider {
        Provider::Cloudflare => "https://cloudflare-dns.com/dns-query",
        Provider::Google => "https://dns.google/dns-query",
        Provider::Quad9 => "https://dns.quad9.net/dns-query",
        Provider::Adguard => "https://dns.adguard-dns.com/dns-query",
        Provider::Custom => return valid_template(&self.custom),
      }
      .to_string(),
    )
  }

  /// Режим і шаблони для Chromium.
  fn chromium(&self) -> (&'static str, String) {
    match self.mode {
      Mode::Default => ("automatic", String::new()),
      Mode::Increased => ("automatic", self.template().unwrap_or_default()),
      Mode::Max => ("secure", self.template().unwrap_or_default()),
      Mode::Off => ("off", String::new()),
    }
  }
}

/// Власна адреса постачальника: https:// з хостом; шаблон може закінчуватися на `{?dns}`.
fn valid_template(text: &str) -> Option<String> {
  let text = text.trim();
  let url = Url::parse(text.strip_suffix("{?dns}").unwrap_or(text)).ok()?;
  (url.scheme() == "https" && url.host_str().is_some_and(|host| !host.is_empty())).then(|| text.to_string())
}

pub struct Dns {
  /// Локальна тека даних застосунку: у ній dns.json і теки WebView2.
  root: PathBuf,
  /// З чим запущено браузер.
  applied: Mutex<Settings>,
  saved: Mutex<Settings>,
  /// Браузер перезапускається: вікна закрито, але застосунок не виходить (main.rs).
  restarting: AtomicBool,
}

/// Що бачить інтерфейс.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DnsState {
  settings: Settings,
  /// Збережене ще не діє: потрібен перезапуск браузера.
  restart_needed: bool,
}

impl Dns {
  fn state(&self) -> DnsState {
    let settings = self.saved.lock().map(|saved| saved.clone()).unwrap_or_default();
    let applied = self.applied.lock().map(|applied| applied.clone()).unwrap_or_default();
    DnsState { restart_needed: settings != applied, settings }
  }

  /// Тека WebView2 (`user_data`), яку створили вже після запуску (обліковий запис, що вперше ввійшов), — з тими
  /// самими налаштуваннями DNS. Якщо браузер у ній уже працює, запис нічого не змінить, і це не шкодить.
  pub fn apply_to(&self, user_data: &Path) {
    if let Ok(applied) = self.applied.lock() {
      write_local_state(&user_data.join("EBWebView").join("Local State"), &applied);
    }
  }

  /// Браузер перезапускається — останнє закрите вікно не означає виходу із застосунку.
  pub fn is_restarting(&self) -> bool {
    self.restarting.load(Ordering::SeqCst)
  }
}

/// Теки WebView2 застосунку: типова (інтерфейс і сайти власника) і власні теки інших облікових записів.
fn folders(root: &Path) -> Vec<PathBuf> {
  let mut folders = vec![root.to_path_buf()];
  if let Ok(profiles) = fs::read_dir(root.join("profiles")) {
    folders.extend(profiles.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()));
  }
  folders
}

/// Чи працює браузер WebView2 у теці: його процес тримає EBWebView/lockfile відкритим, не даючи писати в нього,
/// і видаляє, коли виходить.
fn in_use(folder: &Path) -> bool {
  const ERROR_SHARING_VIOLATION: i32 = 32;
  let lockfile = folder.join("EBWebView").join("lockfile");
  lockfile.exists()
    && fs::OpenOptions::new()
      .write(true)
      .open(&lockfile)
      .is_err_and(|error| error.raw_os_error() == Some(ERROR_SHARING_VIOLATION))
}

/// Налаштування DNS — у всі теки WebView2, щойно браузер у них вийде (не довше за CLOSE_TIMEOUT).
fn apply(root: &Path, settings: &Settings) {
  let folders = folders(root);
  let deadline = Instant::now() + CLOSE_TIMEOUT;
  while folders.iter().any(|folder| in_use(folder)) && Instant::now() < deadline {
    thread::sleep(Duration::from_millis(100));
  }
  for folder in folders {
    write_local_state(&folder.join("EBWebView").join("Local State"), settings);
  }
}

/// Плагін, що готує DNS: плагіни Tauri запускаються до перших вікон. Окремим плагіном після single-instance
/// (main.rs) — щоб повторний запуск, який лише передає посилання вже відкритому браузеру, не чекав тут на його
/// теку WebView2 (prepare чекає, поки її відпустять, до 10 с).
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("astra-dns")
    .setup(|app, _api| {
      app.manage(prepare(&app.config().identifier));
      Ok(())
    })
    .build()
}

/// Записує вибране в налаштування всіх тек WebView2 застосунку — до того, як створено перше вікно.
/// `identifier` — ідентифікатор застосунку (tauri.conf.json): від нього шлях до локальної теки даних.
fn prepare(identifier: &str) -> Dns {
  let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join(identifier);
  let settings: Settings =
    fs::read(root.join(SETTINGS_FILE)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
  apply(&root, &settings);
  Dns { root, applied: Mutex::new(settings.clone()), saved: Mutex::new(settings), restarting: AtomicBool::new(false) }
}

/// Режим DNS у «Local State» WebView2; решта налаштувань у файлі лишається. Зіпсований файл не чіпаємо.
fn write_local_state(path: &Path, settings: &Settings) {
  let mut state = match fs::read(path) {
    Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
      Ok(state @ Value::Object(_)) => state,
      _ => return,
    },
    Err(_) => json!({}),
  };
  let (mode, templates) = settings.chromium();
  let wanted = json!({ "mode": mode, "templates": templates });
  if state.get("dns_over_https") == Some(&wanted) {
    return;
  }
  state["dns_over_https"] = wanted;
  let Some(dir) = path.parent() else {
    return;
  };
  if fs::create_dir_all(dir).is_err() {
    return;
  }
  // Спершу в тимчасовий файл, потім заміна: обірваний запис не зіпсує налаштування браузера.
  let temporary = path.with_extension("astra.tmp");
  if fs::write(&temporary, state.to_string()).is_ok() {
    let _ = fs::rename(&temporary, path);
  }
}

#[tauri::command]
#[specta::specta]
pub fn dns_settings(dns: State<'_, Dns>) -> DnsState {
  dns.state()
}

/// Новий вибір — у dns.json; діятиме після перезапуску браузера.
#[tauri::command]
#[specta::specta]
pub fn dns_set(dns: State<'_, Dns>, settings: Settings) -> Result<DnsState, String> {
  let needs_provider = matches!(settings.mode, Mode::Increased | Mode::Max);
  if needs_provider && settings.template().is_none() {
    return Err("Адреса постачальника має починатися з https://".into());
  }
  fs::create_dir_all(&dns.root).map_err(|error| error.to_string())?;
  let text = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
  fs::write(dns.root.join(SETTINGS_FILE), text).map_err(|error| error.to_string())?;
  *dns.saved.lock().map_err(|error| error.to_string())? = settings;
  Ok(dns.state())
}

/// Перезапуск браузера — щоб нові налаштування DNS запрацювали: вікна закриваються, браузер WebView2 виходить,
/// налаштування записуються, і головне вікно відкривається знову (вкладки інтерфейс відновить сам). Сам застосунок
/// не виходить: так і обліковий запис лишається, і `tauri dev` не вважає застосунок закритим.
#[tauri::command]
#[specta::specta]
pub async fn dns_restart(app: AppHandle) -> Result<(), String> {
  let dns = app.state::<Dns>();
  if dns.restarting.swap(true, Ordering::SeqCst) {
    return Ok(());
  }
  log::info!("Перезапуск браузера для нових налаштувань DNS");
  for window in app.windows().into_values() {
    let _ = window.destroy();
  }
  let root = dns.root.clone();
  let settings = dns.saved.lock().map(|saved| saved.clone()).map_err(|error| error.to_string())?;
  let applying = settings.clone();
  let _ = tauri::async_runtime::spawn_blocking(move || apply(&root, &applying)).await;
  if let Ok(mut applied) = dns.applied.lock() {
    *applied = settings;
  }
  let reopened = app
    .config()
    .app
    .windows
    .first()
    .ok_or_else(|| "No main window in tauri.conf.json".to_string())
    .and_then(|config| {
      tauri::WebviewWindowBuilder::from_config(&app, config).and_then(|builder| builder.build()).map_err(|error| error.to_string())
    });
  dns.restarting.store(false, Ordering::SeqCst);
  reopened.map(drop).inspect_err(|error| log::error!("Після перезапуску для DNS вікно не відкрилося: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn maps_modes_to_chromium_settings() {
    let settings = |mode, provider, custom: &str| Settings { mode, provider, custom: custom.into() };
    assert_eq!(settings(Mode::Default, Provider::Google, "").chromium(), ("automatic", String::new()));
    assert_eq!(
      settings(Mode::Increased, Provider::Cloudflare, "").chromium(),
      ("automatic", "https://cloudflare-dns.com/dns-query".to_string())
    );
    assert_eq!(
      settings(Mode::Max, Provider::Custom, " https://doh.example.net/dns-query{?dns} ").chromium(),
      ("secure", "https://doh.example.net/dns-query{?dns}".to_string())
    );
    assert_eq!(settings(Mode::Off, Provider::Quad9, "").chromium(), ("off", String::new()));
    assert!(settings(Mode::Max, Provider::Custom, "http://doh.example.net/").template().is_none());
    assert!(settings(Mode::Max, Provider::Custom, "просто текст").template().is_none());
  }

  #[test]
  fn knows_when_the_browser_still_holds_its_folder() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    let dir = std::env::temp_dir().join(format!("astra-dns-lock-{}", std::process::id()));
    fs::create_dir_all(dir.join("EBWebView")).expect("dirs");
    assert!(!in_use(&dir));

    // Як Chromium: lockfile відкритий без дозволу писати іншим.
    let lockfile = dir.join("EBWebView").join("lockfile");
    let held = fs::OpenOptions::new().write(true).create(true).truncate(true).share_mode(FILE_SHARE_READ).open(&lockfile).expect("lock");
    assert!(in_use(&dir));
    drop(held);
    assert!(!in_use(&dir));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn writes_only_the_dns_settings_into_local_state() {
    let dir = std::env::temp_dir().join(format!("astra-dns-{}", std::process::id()));
    let path = dir.join("EBWebView").join("Local State");
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(&path, r#"{"browser":{"enabled_labs_experiments":[]},"dns_over_https":{"mode":"off","templates":""}}"#).expect("write");

    let max = Settings { mode: Mode::Max, provider: Provider::Quad9, custom: String::new() };
    write_local_state(&path, &max);
    let state: Value = serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
    assert_eq!(state["dns_over_https"], json!({ "mode": "secure", "templates": "https://dns.quad9.net/dns-query" }));
    assert_eq!(state["browser"], json!({ "enabled_labs_experiments": [] }));

    // Зіпсований файл лишається як є, а відсутній — створюється.
    fs::write(&path, "{broken").expect("write");
    write_local_state(&path, &max);
    assert_eq!(fs::read_to_string(&path).expect("read"), "{broken");
    let fresh = dir.join("fresh").join("EBWebView").join("Local State");
    write_local_state(&fresh, &Settings::default());
    let state: Value = serde_json::from_slice(&fs::read(&fresh).expect("read")).expect("json");
    assert_eq!(state["dns_over_https"]["mode"], "automatic");
    let _ = fs::remove_dir_all(dir);
  }
}
