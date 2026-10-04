//! Паролі сайтів: збережені облікові записи, сайти, для яких паролі «ніколи не зберігати», і налаштування.
//!
//! На диску (passwords.json у теці даних застосунку) кожен пароль зашифровано DPAPI Windows (CryptProtectData):
//! розшифрувати його може лише той самий користувач Windows. Інтерфейс отримує список без паролів, а сам пароль —
//! лише на прохання показати чи скопіювати (password_reveal).
//!
//! Сторінки сайтів говорять із цим модулем через скрипт password-page.js (webview2::watch_page_messages): «користувач
//! увійшов» — і браузер пропонує зберегти пароль; «які облікові записи є», «заповни для такого-то» — для автозаповнення.
//! Відповідає модуль лише про origin самої сторінки і лише скрипту, що знає токен своєї сторінки (його не знають
//! скрипти сайту).

use std::{
  collections::HashMap,
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
  },
  time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use windows::Win32::{
  Foundation::{LocalFree, HLOCAL},
  Security::Cryptography::{
    BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_USE_SYSTEM_PREFERRED_RNG, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
  },
};
use windows_core::PCWSTR;

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
  file: OnceLock<PathBuf>,
  prompts: Mutex<HashMap<u64, Pending>>,
}

static NEXT_PROMPT: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

fn random_hex(bytes: usize) -> String {
  let mut buffer = vec![0u8; bytes];
  let _ = unsafe { BCryptGenRandom(None, &mut buffer, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
  buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
  CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() }
}

/// Копіює й звільняє буфер, який виділив DPAPI.
fn take_blob(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
  if output.pbData.is_null() {
    return Vec::new();
  }
  let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
  unsafe { LocalFree(Some(HLOCAL(output.pbData.cast()))) };
  bytes
}

fn encrypt(password: &str) -> Result<String, String> {
  let mut output = CRYPT_INTEGER_BLOB::default();
  unsafe {
    CryptProtectData(&blob(password.as_bytes()), PCWSTR::null(), Some(&blob(ENTROPY)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
  }
  .map_err(|error| error.to_string())?;
  Ok(STANDARD.encode(take_blob(output)))
}

fn decrypt(encrypted: &str) -> Result<String, String> {
  let data = STANDARD.decode(encrypted).map_err(|error| error.to_string())?;
  let mut output = CRYPT_INTEGER_BLOB::default();
  unsafe { CryptUnprotectData(&blob(&data), None, Some(&blob(ENTROPY)), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    .map_err(|error| error.to_string())?;
  String::from_utf8(take_blob(output)).map_err(|error| error.to_string())
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

impl Passwords {
  fn change<T>(&self, app: &AppHandle, edit: impl FnOnce(&mut Vault) -> Result<T, String>) -> Result<T, String> {
    let (result, state) = {
      let mut vault = self.vault.lock().map_err(|error| error.to_string())?;
      let result = edit(&mut vault)?;
      self.write(&vault)?;
      (result, vault.state())
    };
    let _ = app.emit("passwords://changed", state);
    Ok(result)
  }

  /// Спершу в тимчасовий файл, потім заміна: обірваний запис не зіпсує сховище.
  fn write(&self, vault: &Vault) -> Result<(), String> {
    let file = self.file.get().ok_or("No app data directory")?;
    if let Some(dir) = file.parent() {
      fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let temporary = file.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(vault).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    fs::rename(&temporary, file).map_err(|error| error.to_string())
  }
}

/// Сховище з диска. Викликається при запуску.
pub fn start(app: &AppHandle) {
  let Ok(dir) = app.path().app_data_dir() else {
    return;
  };
  let file = dir.join(VAULT_FILE);
  let passwords = app.state::<Passwords>();
  if let Some(vault) = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice::<Vault>(&bytes).ok()) {
    if let Ok(mut current) = passwords.vault.lock() {
      *current = vault;
    }
  }
  let _ = passwords.file.set(file);
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

#[tauri::command]
pub fn passwords_state(passwords: State<'_, Passwords>) -> Result<PasswordsState, String> {
  Ok(passwords.vault.lock().map_err(|error| error.to_string())?.state())
}

/// Відповідь на «Зберегти пароль?»: save — зберегти (з тим ім'ям і паролем, що в полях вікна), never — більше не
/// пропонувати для цього сайту, інше — не зараз.
#[tauri::command]
pub fn password_prompt_answer(
  app: AppHandle,
  passwords: State<'_, Passwords>,
  id: u64,
  choice: String,
  username: Option<String>,
  password: Option<String>,
) -> Result<(), String> {
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
pub fn password_reveal(passwords: State<'_, Passwords>, id: String) -> Result<String, String> {
  let vault = passwords.vault.lock().map_err(|error| error.to_string())?;
  let entry = vault.entries.iter().find(|entry| entry.id == id).ok_or("Такого пароля немає")?;
  decrypt(&entry.password)
}

/// Пароль, доданий вручну. Для сайту й імені, що вже є, — помилка (змінити наявний можна password_edit).
#[tauri::command]
pub fn password_add(app: AppHandle, passwords: State<'_, Passwords>, site: String, username: String, password: String) -> Result<(), String> {
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
pub fn password_edit(app: AppHandle, passwords: State<'_, Passwords>, id: String, username: String, password: String) -> Result<(), String> {
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
pub fn password_remove(app: AppHandle, passwords: State<'_, Passwords>, id: String) -> Result<(), String> {
  passwords.change(&app, |vault| {
    vault.entries.retain(|entry| entry.id != id);
    Ok(())
  })
}

/// Сайт знову може пропонувати зберегти пароль.
#[tauri::command]
pub fn passwords_never_remove(app: AppHandle, passwords: State<'_, Passwords>, origin: String) -> Result<(), String> {
  passwords.change(&app, |vault| {
    vault.never.retain(|never| *never != origin);
    Ok(())
  })
}

#[tauri::command]
pub fn passwords_set_settings(app: AppHandle, passwords: State<'_, Passwords>, offer: bool, autofill: bool) -> Result<(), String> {
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
  fn page_script_gets_its_token() {
    let script = page_script("abc");
    assert!(script.ends_with(r#")("abc");"#));
  }
}
