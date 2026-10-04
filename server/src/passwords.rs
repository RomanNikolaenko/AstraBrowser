//! Паролі сайтів: збережені облікові записи, сайти, для яких паролі «ніколи не зберігати», і налаштування.
//!
//! У кожного облікового запису Astra свої паролі: passwords.json у його теці (profiles.rs); поки ніхто не ввійшов,
//! паролів немає. На диску кожен пароль зашифровано DPAPI Windows (CryptProtectData):
//! розшифрувати його може лише той самий користувач Windows. Інтерфейс отримує список без паролів, а сам пароль —
//! лише на прохання показати чи скопіювати (password_reveal).
//!
//! Сторінки сайтів говорять із цим модулем через скрипт password-page.js (webview2::watch_page_messages): «користувач
//! увійшов» — і браузер пропонує зберегти пароль; «які облікові записи є», «заповни для такого-то» — для автозаповнення.
//! Відповідає модуль лише про origin самої сторінки і лише скрипту, що знає токен своєї сторінки (його не знають
//! скрипти сайту).
//!
//! Синхронізація (passwords_sync_items, passwords_sync_apply): кожен запис шифрується AES-GCM ключем із пароля
//! облікового запису (auth::sync_key) — сервер бачить лише шифр, а розшифрувати його може тільки власник облікового
//! запису на своїх комп'ютерах.

use std::{
  collections::{BTreeMap, HashMap},
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
  },
  time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Url, Window};

use crate::{
  pages::GUEST_PREFIX,
  profiles,
  secure::{self, random_hex},
};

const VAULT_FILE: &str = "passwords.json";
/// Додатковий «ключ» DPAPI: інша програма того самого користувача не розшифрує паролі, не знаючи його.
const ENTROPY: &[u8] = b"AstraBrowser passwords v1";
const PAGE_SCRIPT: &str = include_str!("password-page.js");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
  id: String,
  /// https://example.com — пароль підставляється лише сторінкам цього origin.
  origin: String,
  username: String,
  /// Пароль, зашифрований DPAPI, у base64.
  password: String,
  created: u64,
  updated: u64,
  /// Коли пароль востаннє підставили на сайті.
  #[serde(default)]
  used: Option<u64>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
  /// Пропонувати зберегти пароль, коли користувач входить на сайт.
  offer: bool,
  /// Пропонувати збережені облікові записи в полях входу.
  autofill: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self { offer: true, autofill: true }
  }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Vault {
  entries: Vec<Entry>,
  /// Origin-и, для яких пароль не пропонується зберегти.
  never: Vec<String>,
  settings: Settings,
}

/// Збережений пароль для інтерфейсу — без самого пароля.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordInfo {
  id: String,
  origin: String,
  username: String,
  created: u64,
  updated: u64,
  used: Option<u64>,
}

/// Усе, що показує сторінка «Паролі»; надсилається й подією passwords://changed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsState {
  entries: Vec<PasswordInfo>,
  never: Vec<String>,
  settings: Settings,
}

/// Пароль, який користувач щойно ввів на сайті, — чекає відповіді на «Зберегти пароль?».
struct Pending {
  origin: String,
  username: String,
  password: String,
}

/// «Зберегти пароль?» для інтерфейсу вікна, де користувач увійшов на сайт.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
  label: String,
  id: u64,
  origin: String,
  username: String,
  password: String,
  /// Для цього імені вже збережено інший пароль — тоді «Оновити пароль?».
  update: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManageEvent {
  label: String,
}

#[derive(Default)]
pub struct Passwords {
  vault: Mutex<Vault>,
  /// Файл паролів облікового запису, що ввійшов; `None` — ніхто не ввійшов.
  file: Mutex<Option<PathBuf>>,
  prompts: Mutex<HashMap<u64, Pending>>,
  /// Уже зашифровані для синхронізації записи: той самий запис не шифрується щоразу наново.
  sealed: Mutex<HashMap<String, Envelope>>,
}

/// Id запису синхронізації зі списком «ніколи не зберігати» (у звичайних записів id — випадкові hex).
const NEVER_ITEM: &str = "never";

/// Запис паролів для сервера синхронізації: `k` — відбиток ключа, `n` і `c` — nonce й шифр AES-GCM (base64),
/// `h` — HMAC відкритого тексту: за ним видно зміни, не розшифровуючи.
#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
  k: String,
  n: String,
  c: String,
  h: String,
}

/// Що шифрується для запису синхронізації — збережений пароль разом із сайтом та ім'ям.
#[derive(Serialize, Deserialize)]
struct SyncedEntry {
  origin: String,
  username: String,
  password: String,
  created: u64,
  updated: u64,
  used: Option<u64>,
}

/// Зашифровані записи для синхронізації; без ключа (`key_id` — None) синхронізувати паролі не можна.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItems {
  key_id: Option<String>,
  /// Коли ключ отримано з пароля облікового запису (секунди Unix): новіший ключ перемагає давніший.
  key_time: u64,
  items: BTreeMap<String, Envelope>,
}

/// Запис із сервера: `data` — None, якщо його видалили.
#[derive(Deserialize)]
pub struct SyncChange {
  id: String,
  data: Option<Envelope>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncApplied {
  /// Записи, зашифровані іншим ключем (пароль облікового запису змінили), — їх не прочитати.
  unreadable: Vec<String>,
}

static NEXT_PROMPT: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

fn encrypt(password: &str) -> Result<String, String> {
  Ok(STANDARD.encode(secure::protect(password.as_bytes(), ENTROPY)?))
}

fn decrypt(encrypted: &str) -> Result<String, String> {
  let data = STANDARD.decode(encrypted).map_err(|error| error.to_string())?;
  String::from_utf8(secure::unprotect(&data, ENTROPY)?).map_err(|error| error.to_string())
}

/// Origin адреси http(s): https://example.com; для інших адрес — None.
fn origin_of(url: &str) -> Option<String> {
  let url = Url::parse(url).ok().filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())?;
  Some(url.origin().ascii_serialization())
}

/// Адреса, яку ввів користувач («example.com» чи повна), — у origin.
fn origin_from_input(raw: &str) -> Option<String> {
  let raw = raw.trim();
  origin_of(raw).or_else(|| origin_of(&format!("https://{raw}"))).filter(|origin| origin.contains('.') || origin.contains("localhost"))
}

impl Vault {
  fn state(&self) -> PasswordsState {
    let mut entries: Vec<PasswordInfo> = self
      .entries
      .iter()
      .map(|entry| PasswordInfo {
        id: entry.id.clone(),
        origin: entry.origin.clone(),
        username: entry.username.clone(),
        created: entry.created,
        updated: entry.updated,
        used: entry.used,
      })
      .collect();
    entries.sort_by(|a, b| a.origin.cmp(&b.origin).then_with(|| a.username.cmp(&b.username)));
    PasswordsState { entries, never: self.never.clone(), settings: self.settings }
  }

  fn find(&self, origin: &str, username: &str) -> Option<usize> {
    self.entries.iter().position(|entry| entry.origin == origin && entry.username == username)
  }

  /// Новий пароль для origin і імені — або новий запис, або заміна пароля наявного.
  fn save(&mut self, origin: String, username: String, password: &str) -> Result<(), String> {
    let encrypted = encrypt(password)?;
    let time = now();
    match self.find(&origin, &username) {
      Some(index) => {
        let entry = &mut self.entries[index];
        entry.password = encrypted;
        entry.updated = time;
      }
      None => self.entries.push(Entry {
        id: random_hex(12),
        origin: origin.clone(),
        username,
        password: encrypted,
        created: time,
        updated: time,
        used: None,
      }),
    }
    self.never.retain(|never| *never != origin);
    Ok(())
  }
}

/// Новий список паролів — усім вікнам, крім гостьових: там чужа людина.
fn broadcast(app: &AppHandle, state: PasswordsState) {
  let _ = app.emit_filter("passwords://changed", state, |target| match target {
    EventTarget::Window { label } | EventTarget::Webview { label } | EventTarget::WebviewWindow { label } => {
      !label.starts_with(GUEST_PREFIX)
    }
    _ => false,
  });
}

impl Passwords {
  fn change<T>(&self, app: &AppHandle, edit: impl FnOnce(&mut Vault) -> Result<T, String>) -> Result<T, String> {
    let (result, state) = {
      let mut vault = self.vault.lock().map_err(|error| error.to_string())?;
      let result = edit(&mut vault)?;
      self.write(&vault)?;
      (result, vault.state())
    };
    broadcast(app, state);
    Ok(result)
  }

  /// Спершу в тимчасовий файл, потім заміна: обірваний запис не зіпсує сховище.
  fn write(&self, vault: &Vault) -> Result<(), String> {
    let file = self.file.lock().map_err(|error| error.to_string())?.clone().ok_or("Увійдіть в обліковий запис Astra")?;
    let file = &file;
    if let Some(dir) = file.parent() {
      fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let temporary = file.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(vault).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    fs::rename(&temporary, file).map_err(|error| error.to_string())
  }
}

/// Паролі облікового запису `user` (`None` — вийшли: паролів немає). Власник облікових записів на цьому комп'ютері
/// забирає паролі, збережені ще до них. Викликає auth.rs, щойно змінився обліковий запис.
pub fn switch_account(app: &AppHandle, user: Option<&str>) {
  let file = user.and_then(|user| profiles::dir(app, user)).map(|dir| dir.join(VAULT_FILE));
  if let (Some(user), Some(file), Ok(base)) = (user, &file, app.path().app_data_dir()) {
    let legacy = base.join(VAULT_FILE);
    if legacy.exists() && !file.exists() && profiles::is_owner(app, user) {
      if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
      }
      let _ = fs::rename(&legacy, file);
    }
  }
  let vault = file
    .as_ref()
    .and_then(|file| fs::read(file).ok())
    .and_then(|bytes| serde_json::from_slice::<Vault>(&bytes).ok())
    .unwrap_or_default();
  let passwords = app.state::<Passwords>();
  let state = {
    let Ok(mut current) = passwords.vault.lock() else {
      return;
    };
    *current = vault;
    if let Ok(mut current_file) = passwords.file.lock() {
      *current_file = file;
    }
    current.state()
  };
  if let Ok(mut prompts) = passwords.prompts.lock() {
    prompts.clear();
  }
  if let Ok(mut sealed) = passwords.sealed.lock() {
    sealed.clear();
  }
  broadcast(app, state);
}

/// Токен сторінки: його знає лише скрипт паролів цієї сторінки, тож скрипти самого сайту не можуть просити паролі.
pub fn new_token() -> String {
  random_hex(16)
}

/// Скрипт паролів для сторінки з токеном `token` (password-page.js).
pub fn page_script(token: &str) -> String {
  format!("({PAGE_SCRIPT})({});", Value::from(token))
}

/// Повідомлення скрипта паролів сторінки `label` (вікна `ui`), що зараз показує `source`. Повертає відповідь сторінці.
pub fn on_page_message(app: &AppHandle, ui: &str, label: &str, token: &str, source: &str, message: &Value) -> Option<Value> {
  if ui.starts_with(GUEST_PREFIX) {
    return None;
  }
  if message.get("astra")?.as_str()? != "password" || message.get("token")?.as_str()? != token {
    return None;
  }
  let origin = origin_of(source)?;
  let passwords = app.state::<Passwords>();
  let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
  match message.get("type")?.as_str()? {
    "submitted" => {
      offer_to_save(app, &passwords, ui, label, origin, text("username").trim().to_string(), text("password"));
      None
    }
    "accounts" => {
      let vault = passwords.vault.lock().ok()?;
      let accounts: Vec<Value> = if vault.settings.autofill {
        vault.entries.iter().filter(|entry| entry.origin == origin).map(|entry| json!({ "username": entry.username })).collect()
      } else {
        Vec::new()
      };
      Some(json!({ "astra": "password", "type": "accounts", "accounts": accounts }))
    }
    "fill" => {
      let username = text("username");
      let password = {
        let mut vault = passwords.vault.lock().ok()?;
        if !vault.settings.autofill {
          return None;
        }
        let index = vault.find(&origin, &username)?;
        vault.entries[index].used = Some(now());
        let password = decrypt(&vault.entries[index].password).ok()?;
        let _ = passwords.write(&vault);
        password
      };
      Some(json!({ "astra": "password", "type": "fill", "username": username, "password": password }))
    }
    "manage" => {
      let _ = app.emit_to(ui, "page://passwords-manage", ManageEvent { label: label.to_string() });
      None
    }
    _ => None,
  }
}

/// Користувач увійшов на сайт: якщо такого пароля ще немає — «Зберегти пароль?», якщо для імені збережено інший —
/// «Оновити пароль?».
fn offer_to_save(app: &AppHandle, passwords: &Passwords, ui: &str, label: &str, origin: String, username: String, password: String) {
  if password.is_empty() {
    return;
  }
  let update = {
    let Ok(mut vault) = passwords.vault.lock() else {
      return;
    };
    if !vault.settings.offer || vault.never.contains(&origin) {
      return;
    }
    match vault.find(&origin, &username) {
      Some(index) if decrypt(&vault.entries[index].password).is_ok_and(|saved| saved == password) => {
        // Той самий пароль — вхід зі збереженим, питати нічого.
        vault.entries[index].used = Some(now());
        let _ = passwords.write(&vault);
        return;
      }
      Some(_) => true,
      None => false,
    }
  };
  let Ok(mut prompts) = passwords.prompts.lock() else {
    return;
  };
  // Те саме ще чекає відповіді — вдруге не питаємо.
  if prompts.values().any(|pending| pending.origin == origin && pending.username == username && pending.password == password) {
    return;
  }
  let id = NEXT_PROMPT.fetch_add(1, Ordering::Relaxed);
  prompts.insert(id, Pending { origin: origin.clone(), username: username.clone(), password: password.clone() });
  drop(prompts);
  let event = PromptEvent { label: label.to_string(), id, origin, username, password, update };
  let _ = app.emit_to(ui, "page://password-prompt", event);
}

/// Відкритий текст запису для синхронізації.
fn synced_entry(entry: &Entry) -> Result<Vec<u8>, String> {
  let synced = SyncedEntry {
    origin: entry.origin.clone(),
    username: entry.username.clone(),
    password: decrypt(&entry.password)?,
    created: entry.created,
    updated: entry.updated,
    used: entry.used,
  };
  serde_json::to_vec(&synced).map_err(|error| error.to_string())
}

/// Запис для сервера: той самий відкритий текст — той самий запис, без нового шифрування.
fn seal_item(key: &secure::SyncKey, key_id: &str, cache: &mut HashMap<String, Envelope>, id: &str, plain: &[u8]) -> Result<Envelope, String> {
  let h = secure::mac(key, plain);
  if let Some(cached) = cache.get(id).filter(|cached| cached.h == h && cached.k == key_id) {
    return Ok(cached.clone());
  }
  let (nonce, sealed) = secure::seal(key, plain)?;
  let envelope = Envelope { k: key_id.to_string(), n: STANDARD.encode(nonce), c: STANDARD.encode(sealed), h };
  cache.insert(id.to_string(), envelope.clone());
  Ok(envelope)
}

fn open_item(key: &secure::SyncKey, envelope: &Envelope) -> Result<Vec<u8>, String> {
  let nonce = STANDARD.decode(&envelope.n).map_err(|error| error.to_string())?;
  let sealed = STANDARD.decode(&envelope.c).map_err(|error| error.to_string())?;
  secure::open(key, &nonce, &sealed)
}

/// Усі паролі облікового запису, зашифровані для синхронізації (і список «ніколи не зберігати» — записом `never`).
#[tauri::command]
pub fn passwords_sync_items(app: AppHandle, window: Window, passwords: State<'_, Passwords>) -> Result<SyncItems, String> {
  deny_guest(&window)?;
  let Some((key, key_time)) = crate::auth::sync_key(&app) else {
    return Ok(SyncItems { key_id: None, key_time: 0, items: BTreeMap::new() });
  };
  let key_id = secure::key_id(&key);
  let vault = passwords.vault.lock().map_err(|error| error.to_string())?;
  let mut cache = passwords.sealed.lock().map_err(|error| error.to_string())?;
  let mut items = BTreeMap::new();
  for entry in &vault.entries {
    // Пароль, що вже не розшифровується (інший користувач Windows), синхронізувати нічим.
    if let Ok(plain) = synced_entry(entry) {
      items.insert(entry.id.clone(), seal_item(&key, &key_id, &mut cache, &entry.id, &plain)?);
    }
  }
  let never = serde_json::to_vec(&vault.never).map_err(|error| error.to_string())?;
  items.insert(NEVER_ITEM.to_string(), seal_item(&key, &key_id, &mut cache, NEVER_ITEM, &never)?);
  Ok(SyncItems { key_id: Some(key_id), key_time, items })
}

/// Записи з сервера: нові й змінені паролі — у сховище, видалені — геть. Зашифровані іншим ключем лишаються як є.
#[tauri::command]
pub fn passwords_sync_apply(
  app: AppHandle,
  window: Window,
  passwords: State<'_, Passwords>,
  changes: Vec<SyncChange>,
) -> Result<SyncApplied, String> {
  deny_guest(&window)?;
  let (key, _) = crate::auth::sync_key(&app).ok_or("Немає ключа синхронізації")?;
  let key_id = secure::key_id(&key);
  let mut unreadable = Vec::new();
  passwords.change(&app, |vault| {
    let mut cache = passwords.sealed.lock().map_err(|error| error.to_string())?;
    for change in changes {
      let Some(envelope) = change.data else {
        if change.id == NEVER_ITEM {
          vault.never.clear();
        } else {
          vault.entries.retain(|entry| entry.id != change.id);
        }
        cache.remove(&change.id);
        continue;
      };
      let Some(plain) = (envelope.k == key_id).then(|| open_item(&key, &envelope).ok()).flatten() else {
        unreadable.push(change.id);
        continue;
      };
      if change.id == NEVER_ITEM {
        vault.never = serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
      } else {
        let synced: SyncedEntry = serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
        // Той самий сайт і ім'я, збережені на двох комп'ютерах окремо, — один запис, з сервера.
        vault.entries.retain(|entry| entry.id == change.id || entry.origin != synced.origin || entry.username != synced.username);
        let entry = Entry {
          id: change.id.clone(),
          origin: synced.origin,
          username: synced.username,
          password: encrypt(&synced.password)?,
          created: synced.created,
          updated: synced.updated,
          used: synced.used,
        };
        match vault.entries.iter_mut().find(|current| current.id == change.id) {
          Some(current) => *current = entry,
          None => vault.entries.push(entry),
        }
      }
      cache.insert(change.id, envelope);
    }
    Ok(())
  })?;
  Ok(SyncApplied { unreadable })
}

/// Команди паролів — не для гостьового вікна: ним користується не власник.
fn deny_guest(window: &Window) -> Result<(), String> {
  if window.label().starts_with(GUEST_PREFIX) {
    Err("У гостьовому режимі паролі недоступні".into())
  } else {
    Ok(())
  }
}

#[tauri::command]
pub fn passwords_state(window: Window, passwords: State<'_, Passwords>) -> Result<PasswordsState, String> {
  if window.label().starts_with(GUEST_PREFIX) {
    return Ok(PasswordsState { entries: Vec::new(), never: Vec::new(), settings: Settings { offer: false, autofill: false } });
  }
  Ok(passwords.vault.lock().map_err(|error| error.to_string())?.state())
}

/// Відповідь на «Зберегти пароль?»: save — зберегти (з тим ім'ям і паролем, що в полях вікна), never — більше не
/// пропонувати для цього сайту, інше — не зараз.
#[tauri::command]
pub fn password_prompt_answer(
  app: AppHandle,
  window: Window,
  passwords: State<'_, Passwords>,
  id: u64,
  choice: String,
  username: Option<String>,
  password: Option<String>,
) -> Result<(), String> {
  deny_guest(&window)?;
  let Some(pending) = passwords.prompts.lock().map_err(|error| error.to_string())?.remove(&id) else {
    return Ok(());
  };
  match choice.as_str() {
    "save" => {
      let username = username.unwrap_or(pending.username).trim().to_string();
      let password = password.filter(|password| !password.is_empty()).unwrap_or(pending.password);
      passwords.change(&app, |vault| vault.save(pending.origin, username, &password))
    }
    "never" => passwords.change(&app, |vault| {
      if !vault.never.contains(&pending.origin) {
        vault.never.push(pending.origin);
      }
      Ok(())
    }),
    _ => Ok(()),
  }
}

/// Сам пароль — щоб показати чи скопіювати його на сторінці «Паролі».
#[tauri::command]
pub fn password_reveal(window: Window, passwords: State<'_, Passwords>, id: String) -> Result<String, String> {
  deny_guest(&window)?;
  let vault = passwords.vault.lock().map_err(|error| error.to_string())?;
  let entry = vault.entries.iter().find(|entry| entry.id == id).ok_or("Такого пароля немає")?;
  decrypt(&entry.password)
}

/// Пароль, доданий вручну. Для сайту й імені, що вже є, — помилка (змінити наявний можна password_edit).
#[tauri::command]
pub fn password_add(
  app: AppHandle,
  window: Window,
  passwords: State<'_, Passwords>,
  site: String,
  username: String,
  password: String,
) -> Result<(), String> {
  deny_guest(&window)?;
  let origin = origin_from_input(&site).ok_or("Некоректна адреса сайту")?;
  if password.is_empty() {
    return Err("Введіть пароль".into());
  }
  let username = username.trim().to_string();
  passwords.change(&app, |vault| {
    if vault.find(&origin, &username).is_some() {
      return Err("Для цього сайту вже збережено пароль із таким ім'ям".into());
    }
    vault.save(origin, username, &password)
  })
}

/// Нове ім'я чи пароль збереженого запису; порожній пароль — пароль не змінюється.
#[tauri::command]
pub fn password_edit(
  app: AppHandle,
  window: Window,
  passwords: State<'_, Passwords>,
  id: String,
  username: String,
  password: String,
) -> Result<(), String> {
  deny_guest(&window)?;
  let username = username.trim().to_string();
  passwords.change(&app, |vault| {
    let index = vault.entries.iter().position(|entry| entry.id == id).ok_or("Такого пароля немає")?;
    let origin = vault.entries[index].origin.clone();
    if vault.find(&origin, &username).is_some_and(|other| other != index) {
      return Err("Для цього сайту вже збережено пароль із таким ім'ям".into());
    }
    let encrypted = if password.is_empty() { None } else { Some(encrypt(&password)?) };
    let entry = &mut vault.entries[index];
    entry.username = username;
    if let Some(encrypted) = encrypted {
      entry.password = encrypted;
    }
    entry.updated = now();
    Ok(())
  })
}

#[tauri::command]
pub fn password_remove(app: AppHandle, window: Window, passwords: State<'_, Passwords>, id: String) -> Result<(), String> {
  deny_guest(&window)?;
  passwords.change(&app, |vault| {
    vault.entries.retain(|entry| entry.id != id);
    Ok(())
  })
}

/// Сайт знову може пропонувати зберегти пароль.
#[tauri::command]
pub fn passwords_never_remove(app: AppHandle, window: Window, passwords: State<'_, Passwords>, origin: String) -> Result<(), String> {
  deny_guest(&window)?;
  passwords.change(&app, |vault| {
    vault.never.retain(|never| *never != origin);
    Ok(())
  })
}

#[tauri::command]
pub fn passwords_set_settings(app: AppHandle, window: Window, passwords: State<'_, Passwords>, offer: bool, autofill: bool) -> Result<(), String> {
  deny_guest(&window)?;
  passwords.change(&app, |vault| {
    vault.settings = Settings { offer, autofill };
    Ok(())
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encrypts_so_that_only_this_user_can_read() {
    let encrypted = encrypt("сек ret 123").expect("encrypt");
    assert!(!encrypted.contains("ret"));
    assert_eq!(decrypt(&encrypted).expect("decrypt"), "сек ret 123");
  }

  #[test]
  fn origins_are_scheme_host_and_port() {
    assert_eq!(origin_of("https://accounts.example.com/login?next=1").as_deref(), Some("https://accounts.example.com"));
    assert_eq!(origin_of("http://localhost:8080/").as_deref(), Some("http://localhost:8080"));
    assert_eq!(origin_of("file:///C:/x.html"), None);
    assert_eq!(origin_from_input("example.com/login").as_deref(), Some("https://example.com"));
    assert_eq!(origin_from_input("не адреса"), None);
  }

  #[test]
  fn saving_twice_replaces_the_password() {
    let mut vault = Vault::default();
    vault.never.push("https://example.com".into());
    vault.save("https://example.com".into(), "me".into(), "one").expect("save");
    vault.save("https://example.com".into(), "me".into(), "two").expect("save");
    assert_eq!(vault.entries.len(), 1);
    assert_eq!(decrypt(&vault.entries[0].password).expect("decrypt"), "two");
    // Збережений вручну пароль знімає «ніколи не зберігати».
    assert!(vault.never.is_empty());
  }

  #[test]
  fn synced_passwords_are_sealed_once_and_read_back_with_the_same_key() {
    let key = secure::derive_key("пароль", "user-1").expect("key");
    let key_id = secure::key_id(&key);
    let mut cache = HashMap::new();
    let first = seal_item(&key, &key_id, &mut cache, "a", b"{\"password\":\"x\"}").expect("seal");
    let again = seal_item(&key, &key_id, &mut cache, "a", b"{\"password\":\"x\"}").expect("seal");
    assert_eq!(first.c, again.c);
    assert!(!STANDARD.decode(&first.c).expect("base64").windows(8).any(|part| part == b"password"));
    assert_eq!(open_item(&key, &first).expect("open"), b"{\"password\":\"x\"}");
    assert!(open_item(&secure::derive_key("інший", "user-1").expect("key"), &first).is_err());
  }

  #[test]
  fn page_script_gets_its_token() {
    let script = page_script("abc");
    assert!(script.ends_with(r#")("abc");"#));
  }
}
