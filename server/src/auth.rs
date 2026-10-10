//! Обліковий запис Astra Browser: вхід, реєстрація з кодом із листа, відновлення пароля — через Supabase Auth.
//!
//! Токени сеансу не потрапляють в інтерфейс: він отримує лише користувача (auth_state, подія auth://changed), а всі
//! запити до Supabase робить цей модуль. «Запам'ятати мене» — сеанс на диску (session.dat у теці даних застосунку),
//! зашифрований DPAPI, як і паролі сайтів; без нього сеанс живе, лише поки застосунок відкритий.
//!
//! Токен доступу Supabase діє годину; фоновий потік оновлює його заздалегідь. Без інтернету сеанс лишається — браузер
//! працює й офлайн, а вийти змусить лише відповідь сервера, що сеанс більше не дійсний (обліковий запис видалили,
//! вийшли на всіх пристроях).
//!
//! Під час входу з пароля облікового запису виводиться ключ синхронізації (secure::derive_key): ним паролі сайтів
//! шифруються перед відправкою на сервер (passwords.rs). Сам пароль ніде не зберігається, а ключ живе в сеансі.
//! Зміна облікового запису перемикає дані браузера на його власні (profiles.rs).
//!
//! Увійти можна й без пароля: кодом з листа ([`auth_send_sign_in_code`]) чи через Google ([`auth_google`] —
//! OAuth з PKCE в окремому вікні; Supabase повертає на адресу, яку застосунок перехоплює). Без пароля ключа
//! синхронізації паролів немає — паролі сайтів синхронізуються, щойно в профілі задати чи ввести пароль.
//!
//! Після входу й підтвердження пошти — лист «нашого сервера» (supabase/functions/notify): привітання, новий пристрій
//! чи новий вхід. Функцію розгортають у Supabase окремо; без неї листи просто не надсилаються.
//!
//! Видалити обліковий запис застосунок сам не може: на це потрібен секретний ключ Supabase, якого в застосунку бути
//! не повинно. Видаляє функція бази `delete_account` (supabase/account.sql) — лише того, хто її викликав, і лише
//! якщо він щойно ввів пароль.

use std::{
  fs,
  path::PathBuf,
  sync::{Mutex, OnceLock},
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{profiles, secure};

const SUPABASE_URL: &str = "https://flhmxwjermtajpdbqgut.supabase.co";
/// Публічний ключ проєкту: його можна вбудовувати в застосунок, доступ до даних обмежують правила Supabase (RLS).
const SUPABASE_KEY: &str = "sb_publishable_5a3iyX7fgjhiN6xi9m_g7g_3l7QgPzp";
const SESSION_FILE: &str = "session.dat";
/// Додатковий «ключ» DPAPI для файла сеансу.
const ENTROPY: &[u8] = b"AstraBrowser session v1";
/// За скільки секунд до кінця дії токен доступу оновлюється.
const REFRESH_AHEAD: u64 = 300;
/// Як часто фоновий потік перевіряє, чи не пора оновити токен.
const REFRESH_CHECK: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct User {
  id: String,
  email: String,
  /// Ім'я з реєстрації; порожнє, якщо не вказали.
  name: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
  access_token: String,
  refresh_token: String,
  /// Коли токен доступу перестане діяти (секунди Unix).
  expires_at: u64,
  user: User,
  /// «Запам'ятати мене»: сеанс зберігається на диску.
  remember: bool,
  /// Ключ синхронізації (шістнадцятковий) — з пароля облікового запису. Немає, якщо сеанс давніший за синхронізацію.
  #[serde(default)]
  sync_key: Option<String>,
  /// Коли сервер востаннє прийняв пароль, з якого цей ключ (секунди Unix): з двох різних ключів новіший — від
  /// новішого пароля, а давніший ключ (пароль відтоді змінили) синхронізувати паролі вже не може.
  #[serde(default)]
  sync_key_at: u64,
}

/// Що бачить інтерфейс: користувач або `None`, якщо не ввійшли.
#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
  user: Option<User>,
  /// Перший обліковий запис на цьому комп'ютері — йому дісталися дані, що були тут до облікових записів.
  owner: bool,
  /// Паролі сайтів можна синхронізувати: є ключ із пароля облікового запису.
  sync_unlocked: bool,
}

/// Результат коду зі зміни пошти.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailChange {
  /// Пошту змінено — новий стан облікового запису.
  state: Option<AuthState>,
  /// Один код прийнято, а Supabase («Secure email change») чекає ще код із листа на цю адресу.
  waiting: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignUpResult {
  /// Користувач, якщо пошту підтверджувати не треба й вхід уже відбувся.
  user: Option<User>,
  /// На пошту надіслано лист із кодом: обліковий запис запрацює після його введення.
  confirm: bool,
}

/// Помилка для інтерфейсу: код Supabase (чи власний: offline, server) і повідомлення українською.
#[derive(Clone, Serialize, Debug)]
pub struct AuthError {
  code: String,
  message: String,
}

impl AuthError {
  pub fn new(code: &str, message: &str) -> Self {
    Self { code: code.to_string(), message: message.to_string() }
  }
}

#[derive(Default)]
pub struct Auth {
  session: Mutex<Option<Session>>,
  file: OnceLock<PathBuf>,
  /// Не дає двом потокам одночасно оновлювати токен: refresh token Supabase одноразовий.
  refreshing: Mutex<()>,
  /// Сеанс із коду відновлення пароля — чекає, поки новий пароль приймуть (тоді він і стане сеансом входу).
  recovery: Mutex<Option<(String, Session)>>,
  /// Ключ синхронізації з реєстрації (пошта, id користувача, ключ) — чекає коду з листа.
  pending_key: Mutex<Option<(String, String, String)>>,
  /// Обліковий запис (id), який щойно видалили на сервері: поки інтерфейс прибирає його дані на цьому комп'ютері,
  /// сеанс ще є, але запитів від його імені вже немає. Вихід (auth_sign_out) прибирає й теки облікового запису.
  deleting: Mutex<Option<String>>,
}

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_secs())
}

fn agent() -> &'static ureq::Agent {
  static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
  AGENT.get_or_init(|| {
    ureq::Agent::config_builder()
      .http_status_as_error(false)
      .timeout_global(Some(Duration::from_secs(20)))
      .user_agent("AstraBrowser")
      .build()
      .into()
  })
}

pub enum Method {
  Get,
  Post,
  Put,
}

/// Найбільша відповідь сервера: сторінка синхронізації з фото профілю й історією.
const RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;

/// Запит до Supabase: статус і JSON відповіді (без відповіді — Null).
fn request(method: Method, url: &str, token: Option<&str>, body: &Value) -> Result<(u16, Value), AuthError> {
  let bearer = token.map(|token| format!("Bearer {token}"));
  let response = match method {
    Method::Get => {
      let mut request = agent().get(url).header("apikey", SUPABASE_KEY);
      if let Some(bearer) = &bearer {
        request = request.header("Authorization", bearer);
      }
      request.call()
    }
    Method::Post | Method::Put => {
      let request = if matches!(method, Method::Put) { agent().put(url) } else { agent().post(url) };
      let mut request = request.header("apikey", SUPABASE_KEY).header("Content-Type", "application/json");
      if let Some(bearer) = &bearer {
        request = request.header("Authorization", bearer);
      }
      request.send(body.to_string())
    }
  };
  let mut response = response.map_err(|_| offline())?;
  let status = response.status().as_u16();
  let text = response.body_mut().with_config().limit(RESPONSE_LIMIT).read_to_string().map_err(|_| offline())?;
  let value = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
  Ok((status, value))
}

/// Запит до Supabase Auth (`path` — після /auth/v1/). Відповідь з помилкою стає [`AuthError`].
fn call(method: Method, path: &str, token: Option<&str>, body: &Value) -> Result<Value, AuthError> {
  let (status, value) = request(method, &format!("{SUPABASE_URL}/auth/v1/{path}"), token, body)?;
  if (200..300).contains(&status) {
    Ok(value)
  } else {
    Err(api_error(status, &value))
  }
}

/// Помилка REST API бази (PostgREST): `{"code": "PGRST205", "message": "..."}`.
fn rest_error(status: u16, body: &Value) -> AuthError {
  match text(body, "code").unwrap_or_default() {
    // Таблиці чи функції синхронізації ще немає (SQL з інструкції не виконали) чи немає до неї доступу.
    "PGRST202" | "PGRST205" | "42P01" | "42883" | "42501" => {
      AuthError::new("sync_not_configured", "Синхронізацію ще не налаштовано на сервері.")
    }
    "PGRST301" | "PGRST303" => AuthError::new("session_expired", "Сеанс завершився. Увійдіть знову."),
    _ if status >= 500 => AuthError::new("server", "Сервер синхронізації зараз недоступний. Спробуйте пізніше."),
    code => AuthError::new(if code.is_empty() { "server" } else { code }, "Не вдалося синхронізувати дані. Спробуємо ще раз згодом."),
  }
}

fn offline() -> AuthError {
  AuthError::new("offline", "Немає з'єднання з сервером. Перевірте інтернет і спробуйте ще раз.")
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// Відповідь Supabase з помилкою: `{"error_code": "...", "msg": "..."}` (а в старіших — `{"error": "...", ...}`).
fn api_error(status: u16, body: &Value) -> AuthError {
  let code = text(body, "error_code").or_else(|| text(body, "error")).unwrap_or(if status >= 500 { "server" } else { "unknown" });
  let message = match code {
    "invalid_credentials" | "invalid_grant" => "Неправильна пошта або пароль.",
    "email_not_confirmed" => "Пошту ще не підтверджено. Введіть код із листа, який ми надіслали.",
    "user_already_exists" | "email_exists" | "identity_already_exists" => {
      "Обліковий запис із цією поштою вже існує. Увійдіть або відновіть пароль."
    }
    "weak_password" => return weak_password(body),
    "same_password" => "Новий пароль має відрізнятися від попереднього.",
    "otp_expired" | "otp_disabled" => "Код неправильний або застарів. Надішліть новий.",
    "over_email_send_rate_limit" => "Забагато листів за короткий час. Зачекайте трохи й спробуйте знову.",
    "over_request_rate_limit" => "Забагато спроб. Зачекайте хвилину й спробуйте знову.",
    "email_address_invalid" | "validation_failed" => "Перевірте адресу електронної пошти.",
    "email_address_not_authorized" => "На цю адресу зараз не можна надіслати лист. Спробуйте іншу пошту.",
    "signup_disabled" | "email_provider_disabled" => "Реєстрацію тимчасово вимкнено.",
    "user_banned" => "Цей обліковий запис заблоковано.",
    "user_not_found" => "Обліковий запис не знайдено.",
    "reauthentication_needed" | "reauthentication_not_valid" => "Щоб змінити пароль, вийдіть і увійдіть знову.",
    "session_not_found" | "session_expired" | "refresh_token_not_found" | "refresh_token_already_used" | "bad_jwt" => {
      "Сеанс завершився. Увійдіть знову."
    }
    _ if status >= 500 => "Сервер облікових записів зараз недоступний. Спробуйте пізніше.",
    _ => "Не вдалося виконати дію. Спробуйте ще раз.",
  };
  AuthError::new(code, message)
}

/// Supabase каже, чим пароль слабкий: `weak_password.reasons` — length, characters, pwned.
fn weak_password(body: &Value) -> AuthError {
  let reasons: Vec<&str> = body
    .pointer("/weak_password/reasons")
    .and_then(Value::as_array)
    .map(|reasons| reasons.iter().filter_map(Value::as_str).collect())
    .unwrap_or_default();
  let message = if reasons.contains(&"pwned") {
    "Цей пароль трапляється у витоках даних. Виберіть інший."
  } else if reasons.contains(&"characters") {
    "Пароль має містити великі й малі літери, цифри та символи."
  } else {
    "Пароль закороткий. Виберіть довший."
  };
  AuthError::new("weak_password", message)
}

fn user_of(value: &Value) -> Option<User> {
  let metadata = value.get("user_metadata");
  let name = metadata.and_then(|metadata| text(metadata, "name").or_else(|| text(metadata, "full_name")));
  Some(User {
    id: text(value, "id")?.to_string(),
    email: text(value, "email").unwrap_or_default().to_string(),
    name: name.unwrap_or_default().trim().to_string(),
  })
}

/// Сеанс із відповіді `token`/`verify`/`signup` Supabase; `None`, якщо токенів у відповіді немає.
fn session_of(value: &Value, remember: bool) -> Option<Session> {
  let expires_at = value
    .get("expires_at")
    .and_then(Value::as_u64)
    .or_else(|| value.get("expires_in").and_then(Value::as_u64).map(|seconds| now() + seconds))?;
  Some(Session {
    access_token: text(value, "access_token")?.to_string(),
    refresh_token: text(value, "refresh_token")?.to_string(),
    expires_at,
    user: user_of(value.get("user")?)?,
    remember,
    sync_key: None,
    sync_key_at: 0,
  })
}

fn session_or_error(value: &Value, remember: bool) -> Result<Session, AuthError> {
  session_of(value, remember).ok_or_else(unexpected)
}

fn state_of(app: &AppHandle, session: Option<&Session>) -> AuthState {
  AuthState {
    user: session.map(|session| session.user.clone()),
    owner: session.is_some_and(|session| profiles::is_owner(app, &session.user.id)),
    sync_unlocked: session.is_some_and(|session| session.sync_key.is_some()),
  }
}

impl Session {
  /// Ключ синхронізації з пароля, який сервер щойно прийняв.
  fn unlock(&mut self, password: &str) {
    if let Some(key) = secure::derive_key(password, &self.user.id) {
      self.sync_key = Some(secure::hex(&key));
      self.sync_key_at = now();
    }
  }
}

/// Тепер увійшов `user` (`None` — вийшли): браузер перемикається на його дані.
fn activate(app: &AppHandle, user: Option<&str>) {
  profiles::set_current(user);
  crate::passwords::switch_account(app, user);
}

impl Auth {
  fn current(&self) -> Option<Session> {
    self.session.lock().ok()?.clone()
  }

  /// Новий сеанс (або вихід із `None`): у пам'ять, на диск, якщо його треба пам'ятати, і всім вікнам.
  fn set(&self, app: &AppHandle, session: Option<Session>) -> AuthState {
    self.replace(app, session, |_| true)
  }

  /// Як [`Auth::set`], але лише якщо поточний сеанс підходить `allowed` — інакше лишається поточний.
  fn replace(&self, app: &AppHandle, session: Option<Session>, allowed: impl FnOnce(Option<&Session>) -> bool) -> AuthState {
    let state = state_of(app, session.as_ref());
    let (changed, switched) = {
      let Ok(mut current) = self.session.lock() else {
        return state;
      };
      if !allowed(current.as_ref()) {
        return state_of(app, current.as_ref());
      }
      let changed = state_of(app, current.as_ref()) != state;
      let user_id = |session: Option<&Session>| session.map(|session| session.user.id.clone());
      let switched = user_id(current.as_ref()) != user_id(session.as_ref());
      self.write(session.as_ref());
      *current = session;
      (changed, switched)
    };
    if switched {
      activate(app, state.user.as_ref().map(|user| user.id.as_str()));
    }
    if changed {
      let _ = app.emit("auth://changed", state.clone());
    }
    state
  }

  /// Змінює поточний сеанс (якщо за цей час не вийшли й не ввійшли іншим обліковим записом).
  fn modify(&self, app: &AppHandle, change: impl FnOnce(&mut Session)) -> AuthState {
    let Some(mut session) = self.current() else {
      return state_of(app, None);
    };
    let user = session.user.id.clone();
    change(&mut session);
    self.replace(app, Some(session), |current| current.is_some_and(|current| current.user.id == user))
  }

  /// Сеанс «Запам'ятати мене» — на диск, решту з диска прибираємо.
  fn write(&self, session: Option<&Session>) {
    let Some(file) = self.file.get() else {
      return;
    };
    let Some(session) = session.filter(|session| session.remember) else {
      let _ = fs::remove_file(file);
      return;
    };
    let Ok(sealed) = serde_json::to_vec(session).map_err(|error| error.to_string()).and_then(|json| secure::protect(&json, ENTROPY)) else {
      return;
    };
    if let Some(dir) = file.parent() {
      let _ = fs::create_dir_all(dir);
    }
    // Спершу в тимчасовий файл, потім заміна: обірваний запис не зіпсує сеанс.
    let temporary = file.with_extension("dat.tmp");
    if fs::write(&temporary, sealed).is_ok() {
      let _ = fs::rename(&temporary, file);
    }
  }

  /// Оновлює токен доступу, якщо той скоро спливе (чи `force`). Відповідь сервера, що сеанс недійсний, — вихід;
  /// без інтернету сеанс лишається як є.
  fn refresh(&self, app: &AppHandle, force: bool) -> Result<Option<Session>, AuthError> {
    let _guard = self.refreshing.lock().map_err(|_| AuthError::new("internal", "Не вдалося оновити сеанс."))?;
    if self.deleting.lock().map_or(true, |deleting| deleting.is_some()) {
      return Err(signed_out());
    }
    let Some(session) = self.current() else {
      return Ok(None);
    };
    if !force && session.expires_at > now() + REFRESH_AHEAD {
      return Ok(Some(session));
    }
    // Поки чекали на сервер, могли вийти чи ввійти наново — тоді відповідь уже не про поточний сеанс.
    let same = |current: Option<&Session>| current.is_some_and(|current| current.refresh_token == session.refresh_token);
    match call(Method::Post, "token?grant_type=refresh_token", None, &json!({ "refresh_token": session.refresh_token })) {
      Ok(reply) => {
        let mut fresh = session_or_error(&reply, session.remember)?;
        fresh.sync_key = session.sync_key.clone();
        fresh.sync_key_at = session.sync_key_at;
        self.replace(app, Some(fresh.clone()), same);
        Ok(Some(fresh))
      }
      Err(error) if is_session_gone(&error) => {
        self.replace(app, None, same);
        Err(error)
      }
      Err(error) => Err(error),
    }
  }

  /// Чинний токен доступу (оновлений, якщо спливає) — для запитів від імені користувача.
  fn access_token(&self, app: &AppHandle) -> Result<String, AuthError> {
    self.refresh(app, false)?.map(|session| session.access_token).ok_or_else(signed_out)
  }
}

fn signed_out() -> AuthError {
  AuthError::new("signed_out", "Ви не ввійшли в обліковий запис.")
}

/// Ключ синхронізації паролів поточного облікового запису і коли його отримано з пароля (секунди Unix).
pub fn sync_key(app: &AppHandle) -> Option<(secure::SyncKey, u64)> {
  let session = app.state::<Auth>().current()?;
  let key = secure::from_hex(&session.sync_key?)?;
  Some((key.try_into().ok()?, session.sync_key_at))
}

/// Запит до бази Supabase (REST API, `path` — після /rest/v1/) від імені користувача. Якщо сервер каже, що токен
/// протермінований, токен оновлюється, і запит повторюється один раз.
pub fn rest(app: &AppHandle, method: fn() -> Method, path: &str, body: &Value) -> Result<Value, AuthError> {
  let auth = app.state::<Auth>();
  let url = format!("{SUPABASE_URL}/rest/v1/{path}");
  let (mut status, mut value) = request(method(), &url, Some(&auth.access_token(app)?), body)?;
  if status == 401 {
    let token = auth.refresh(app, true)?.map(|session| session.access_token).ok_or_else(signed_out)?;
    (status, value) = request(method(), &url, Some(&token), body)?;
  }
  if (200..300).contains(&status) {
    Ok(value)
  } else {
    Err(rest_error(status, &value))
  }
}

/// Помилки, після яких сеанс уже не відновити: потрібен новий вхід.
fn is_session_gone(error: &AuthError) -> bool {
  matches!(
    error.code.as_str(),
    "invalid_grant"
      | "refresh_token_not_found"
      | "refresh_token_already_used"
      | "session_not_found"
      | "session_expired"
      | "user_not_found"
      | "user_banned"
      | "bad_jwt"
  )
}

/// Сеанс із диска й фоновий потік, що вчасно оновлює токен. Викликається при запуску.
pub fn start(app: &AppHandle) {
  let auth = app.state::<Auth>();
  if let Ok(dir) = app.path().app_data_dir() {
    let file = dir.join(SESSION_FILE);
    let saved = fs::read(&file)
      .ok()
      .and_then(|sealed| secure::unprotect(&sealed, ENTROPY).ok())
      .and_then(|json| serde_json::from_slice::<Session>(&json).ok());
    let user = saved.as_ref().map(|session| session.user.id.clone());
    if let (Some(session), Ok(mut current)) = (saved, auth.session.lock()) {
      *current = Some(session);
    }
    let _ = auth.file.set(file);
    activate(app, user.as_deref());
  }

  let app = app.clone();
  thread::spawn(move || loop {
    let _ = app.state::<Auth>().refresh(&app, false);
    thread::sleep(REFRESH_CHECK);
  });
}

/// Мережеві запити — не в потоці подій інтерфейсу.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, AuthError> + Send + 'static) -> Result<T, AuthError> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(|_| AuthError::new("internal", "Не вдалося виконати дію. Спробуйте ще раз."))?
}

fn clean_email(email: &str) -> String {
  email.trim().to_lowercase()
}

#[tauri::command]
pub fn auth_state(app: AppHandle, auth: State<'_, Auth>) -> AuthState {
  state_of(&app, auth.current().as_ref())
}

#[tauri::command]
pub async fn auth_sign_in(app: AppHandle, email: String, password: String, remember: bool) -> Result<AuthState, AuthError> {
  blocking(move || {
    let reply = call(Method::Post, "token?grant_type=password", None, &json!({ "email": clean_email(&email), "password": password }))?;
    let mut session = session_or_error(&reply, remember)?;
    session.unlock(&password);
    Ok(signed_in(&app, session, false))
  })
  .await
}

/// Вхід (не оновлення сеансу): сеанс — у браузер, а на пошту — лист «нашого сервера»: привітання новому обліковому
/// запису, «Новий пристрій» з комп'ютера, де цей обліковий запис ще не входив. Про звичайний вхід сервер напише
/// («Новий вхід»), лише якщо ввійшли з незнайомого місця (IP).
fn signed_in(app: &AppHandle, session: Session, created: bool) -> AuthState {
  let first = profiles::first_sign_in(app, &session.user.id);
  let kind = if created {
    "welcome"
  } else if first {
    "new-device"
  } else {
    "sign-in"
  };
  let token = session.access_token.clone();
  let state = app.state::<Auth>().set(app, Some(session));
  notify(token, kind);
  state
}

/// Лист «нашого сервера» (supabase/functions/notify) — у фоні; без зв'язку чи без розгорнутої функції його просто немає.
fn notify(token: String, kind: &'static str) {
  thread::spawn(move || {
    let url = format!("{SUPABASE_URL}/functions/v1/notify");
    let _ = request(Method::Post, &url, Some(&token), &json!({ "kind": kind, "device": device_name() }));
  });
}

/// Як назвати цей комп'ютер у листі: «Astra Browser на Windows (ROMAN-PC)».
fn device_name() -> String {
  match std::env::var("COMPUTERNAME").ok().filter(|name| !name.trim().is_empty()) {
    Some(computer) => format!("Astra Browser на Windows ({})", computer.trim()),
    None => "Astra Browser на Windows".to_string(),
  }
}

/// Лист із кодом для входу без пароля (шаблон Supabase «Magic link or OTP»). Обліковий запис має вже існувати.
#[tauri::command]
pub async fn auth_send_sign_in_code(email: String) -> Result<(), AuthError> {
  blocking(move || match call(Method::Post, "otp", None, &json!({ "email": clean_email(&email), "create_user": false })) {
    Ok(_) => Ok(()),
    Err(error) if matches!(error.code.as_str(), "otp_disabled" | "signup_disabled" | "user_not_found") => Err(AuthError::new(
      "user_not_found",
      "Облікового запису з такою поштою немає. Перевірте адресу або зареєструйтеся.",
    )),
    Err(error) => Err(error),
  })
  .await
}

/// Код із листа — і вхід без пароля.
#[tauri::command]
pub async fn auth_sign_in_with_code(app: AppHandle, email: String, code: String, remember: bool) -> Result<AuthState, AuthError> {
  blocking(move || {
    let reply = call(Method::Post, "verify", None, &json!({ "type": "email", "email": clean_email(&email), "token": code.trim() }))?;
    let session = session_or_error(&reply, remember)?;
    Ok(signed_in(&app, session, false))
  })
  .await
}

/// Куди Supabase повертає після входу через Google. Адресу перехоплює сам застосунок — у вікні вона не відкривається,
/// але має бути в Supabase серед дозволених (Authentication → URL Configuration → Redirect URLs).
pub const OAUTH_REDIRECT: &str = "http://localhost/astra-auth-callback";
/// Скільки чекати, поки людина ввійде в Google.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// PKCE: випадковий `code_verifier` і `code_challenge` до нього (SHA-256, base64url без вирівнювання).
fn pkce() -> (String, String) {
  use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
  use sha2::{Digest, Sha256};
  let verifier = secure::random_hex(32);
  let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
  (verifier, challenge)
}

/// Код з адреси, на яку Supabase повернув після входу (`?code=…`), чи помилка (`?error_description=…`).
fn oauth_result(url: &tauri::Url) -> Result<String, AuthError> {
  let value = |key: &str| url.query_pairs().find(|(name, _)| name == key).map(|(_, value)| value.into_owned());
  match value("code") {
    Some(code) if !code.is_empty() => Ok(code),
    _ => Err(AuthError::new(
      "oauth_failed",
      &value("error_description").map_or_else(|| "Не вдалося ввійти через Google.".to_string(), |text| format!("Не вдалося ввійти через Google: {text}")),
    )),
  }
}

/// Чи обліковий запис щойно створено цим входом (Google-користувач уперше): створено й увійшли майже одночасно.
fn just_created(user: &Value) -> bool {
  let seconds = |key: &str| text(user, key).and_then(unix_seconds);
  matches!((seconds("created_at"), seconds("last_sign_in_at")), (Some(created), Some(signed)) if (signed - created).abs() < 120)
}

/// Секунди Unix з часу ISO 8601 від Supabase («2026-10-10T12:34:56.789Z»), без часових поясів (Supabase — UTC).
fn unix_seconds(text: &str) -> Option<i64> {
  let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
  let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
  let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
  // Дні від 1970-01-01 за григоріанським календарем (алгоритм days_from_civil).
  let year = if month <= 2 { year - 1 } else { year };
  let era = year.div_euclid(400);
  let year_of_era = year - era * 400;
  let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  let days = era * 146_097 + day_of_era - 719_468;
  Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Вхід через Google: вікно зі сторінкою входу Google (через Supabase, OAuth з PKCE), а коли Supabase поверне
/// на [`OAUTH_REDIRECT`] з кодом — обмін коду на сеанс. Закрили вікно — вхід скасовано.
#[tauri::command]
pub async fn auth_google(app: AppHandle, remember: bool) -> Result<AuthState, AuthError> {
  let settings = blocking(|| call(Method::Get, "settings", None, &Value::Null)).await?;
  if settings.pointer("/external/google").and_then(Value::as_bool) != Some(true) {
    return Err(AuthError::new("provider_disabled", "Вхід через Google ще не налаштовано на сервері."));
  }
  let (verifier, challenge) = pkce();
  let mut url = tauri::Url::parse(&format!("{SUPABASE_URL}/auth/v1/authorize")).map_err(|_| unexpected())?;
  url
    .query_pairs_mut()
    .append_pair("provider", "google")
    .append_pair("redirect_to", OAUTH_REDIRECT)
    .append_pair("code_challenge", &challenge)
    .append_pair("code_challenge_method", "s256");

  let (sender, receiver) = std::sync::mpsc::channel::<Result<String, AuthError>>();
  let closed = sender.clone();
  // Кожна спроба — своє вікно (попереднє, якщо лишилося, закриваємо).
  if let Some(previous) = app.get_webview_window("google-sign-in") {
    let _ = previous.destroy();
  }
  let window = tauri::WebviewWindowBuilder::new(&app, "google-sign-in", tauri::WebviewUrl::External(url))
    .additional_browser_args(crate::BROWSER_ARGS)
    .title("Вхід через Google — Astra Browser")
    .inner_size(520.0, 720.0)
    .center()
    // Без cookies браузера: вхід у Google лише для цього разу.
    .incognito(true)
    .on_navigation(move |url| {
      if url.as_str().starts_with(OAUTH_REDIRECT) {
        let _ = sender.send(oauth_result(url));
        false
      } else {
        true
      }
    })
    .build()
    .map_err(|_| AuthError::new("internal", "Не вдалося відкрити вікно входу через Google."))?;
  window.on_window_event(move |event| {
    if matches!(event, tauri::WindowEvent::Destroyed) {
      let _ = closed.send(Err(AuthError::new("cancelled", "Вхід через Google скасовано.")));
    }
  });

  let code = blocking(move || receiver.recv_timeout(OAUTH_TIMEOUT).map_err(|_| AuthError::new("cancelled", "Вхід через Google скасовано."))?)
    .await;
  let _ = window.destroy();
  let code = code?;
  blocking(move || {
    let reply = call(Method::Post, "token?grant_type=pkce", None, &json!({ "auth_code": code, "code_verifier": verifier }))?;
    let session = session_or_error(&reply, remember)?;
    let created = reply.get("user").is_some_and(just_created);
    Ok(signed_in(&app, session, created))
  })
  .await
}

#[tauri::command]
pub async fn auth_sign_up(app: AppHandle, name: String, email: String, password: String) -> Result<SignUpResult, AuthError> {
  blocking(move || {
    let reply = call(
      Method::Post,
      "signup",
      None,
      &json!({ "email": clean_email(&email), "password": password, "data": { "name": name.trim() } }),
    )?;
    // Підтвердження пошти вимкнено — Supabase одразу дає сеанс.
    if let Some(mut session) = session_of(&reply, true) {
      session.unlock(&password);
      let user = session.user.clone();
      app.state::<Auth>().set(&app, Some(session));
      return Ok(SignUpResult { user: Some(user), confirm: false });
    }
    // На вже зареєстровану й підтверджену пошту Supabase не каже «зайнято» (щоб не видавати, чия це пошта), а
    // повертає користувача без жодної identity.
    if reply.get("identities").and_then(Value::as_array).is_some_and(Vec::is_empty) {
      return Err(api_error(422, &json!({ "error_code": "user_already_exists" })));
    }
    // Ключ синхронізації — зараз, поки є пароль: знадобиться, щойно пошту підтвердять кодом.
    if let Some(user) = text(&reply, "id") {
      let key = secure::derive_key(&password, user).map(|key| secure::hex(&key));
      if let (Some(key), Ok(mut pending)) = (key, app.state::<Auth>().pending_key.lock()) {
        *pending = Some((clean_email(&email), user.to_string(), key));
      }
    }
    Ok(SignUpResult { user: None, confirm: true })
  })
  .await
}

/// Код із листа «Підтвердіть пошту» — і вхід.
#[tauri::command]
pub async fn auth_verify(app: AppHandle, email: String, code: String) -> Result<AuthState, AuthError> {
  blocking(move || {
    let email = clean_email(&email);
    let reply = call(Method::Post, "verify", None, &json!({ "type": "email", "email": email, "token": code.trim() }))?;
    let mut session = session_or_error(&reply, true)?;
    let auth = app.state::<Auth>();
    let pending = auth.pending_key.lock().ok().and_then(|mut pending| pending.take());
    if let Some((_, _, key)) = pending.filter(|(owner, user, _)| *owner == email && *user == session.user.id) {
      session.sync_key = Some(key);
      session.sync_key_at = now();
    }
    // Пошту щойно підтвердили — обліковий запис новий: лист-привітання.
    Ok(signed_in(&app, session, true))
  })
  .await
}

/// Новий лист із кодом підтвердження пошти.
#[tauri::command]
pub async fn auth_resend(email: String) -> Result<(), AuthError> {
  blocking(move || call(Method::Post, "resend", None, &json!({ "type": "signup", "email": clean_email(&email) })).map(drop)).await
}

/// Лист із кодом відновлення пароля. Supabase відповідає однаково, є така пошта чи ні.
#[tauri::command]
pub async fn auth_recover(email: String) -> Result<(), AuthError> {
  blocking(move || call(Method::Post, "recover", None, &json!({ "email": clean_email(&email) })).map(drop)).await
}

/// Код відновлення й новий пароль — і вхід. Якщо пароль не прийняли (наприклад, заслабкий), код уже використано,
/// тож його сеанс чекає наступної спроби з тією самою поштою.
#[tauri::command]
pub async fn auth_reset_password(app: AppHandle, email: String, code: String, password: String) -> Result<AuthState, AuthError> {
  blocking(move || {
    let email = clean_email(&email);
    let auth = app.state::<Auth>();
    let pending = auth.recovery.lock().ok().and_then(|mut recovery| recovery.take()).filter(|(owner, _)| *owner == email);
    let mut session = match pending {
      Some((_, session)) if session.expires_at > now() => session,
      _ => {
        let reply = call(Method::Post, "verify", None, &json!({ "type": "recovery", "email": email, "token": code.trim() }))?;
        session_or_error(&reply, true)?
      }
    };
    if let Err(error) = call(Method::Put, "user", Some(&session.access_token), &json!({ "password": password })) {
      if let Ok(mut recovery) = auth.recovery.lock() {
        *recovery = Some((email, session));
      }
      return Err(error);
    }
    // Новий пароль — новий ключ: паролі сайтів перешифруються ним під час синхронізації.
    session.unlock(&password);
    Ok(auth.set(&app, Some(session)))
  })
  .await
}

/// Новий пароль для того, хто вже ввійшов. Ключ синхронізації теж новий: паролі сайтів перешифруються ним.
#[tauri::command]
pub async fn auth_set_password(app: AppHandle, password: String) -> Result<(), AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let token = auth.access_token(&app)?;
    call(Method::Put, "user", Some(&token), &json!({ "password": password }))?;
    auth.modify(&app, |session| session.unlock(&password));
    Ok(())
  })
  .await
}

/// Пароль облікового запису ще раз — щоб отримати ключ синхронізації паролів (сеанс давніший за синхронізацію
/// чи пароль змінили на іншому комп'ютері).
#[tauri::command]
pub async fn auth_unlock_sync(app: AppHandle, password: String) -> Result<AuthState, AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let current = auth.current().ok_or_else(signed_out)?;
    let reply = call(Method::Post, "token?grant_type=password", None, &json!({ "email": current.user.email, "password": password }))?;
    let mut session = session_or_error(&reply, current.remember)?;
    if session.user.id != current.user.id {
      return Err(signed_out());
    }
    session.unlock(&password);
    Ok(auth.set(&app, Some(session)))
  })
  .await
}

/// Нове ім'я — в обліковий запис Supabase (user_metadata.name), звідки його візьмуть інші комп'ютери.
#[tauri::command]
pub async fn auth_update_name(app: AppHandle, name: String) -> Result<AuthState, AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let token = auth.access_token(&app)?;
    let reply = call(Method::Put, "user", Some(&token), &json!({ "data": { "name": name.trim() } }))?;
    let user = user_of(&reply).ok_or_else(unexpected)?;
    Ok(auth.modify(&app, |session| session.user = user))
  })
  .await
}

/// Свіжі дані облікового запису з сервера (ім'я могли змінити на іншому комп'ютері).
#[tauri::command]
pub async fn auth_reload_user(app: AppHandle) -> Result<AuthState, AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let token = auth.access_token(&app)?;
    match call(Method::Get, "user", Some(&token), &Value::Null) {
      Ok(reply) => {
        let user = user_of(&reply).ok_or_else(unexpected)?;
        Ok(auth.modify(&app, |session| session.user = user))
      }
      Err(error) if is_session_gone(&error) => {
        auth.set(&app, None);
        Err(error)
      }
      Err(error) => Err(error),
    }
  })
  .await
}

/// Нова пошта облікового запису: Supabase надсилає на неї лист із кодом, а з «Secure email change» — ще й на
/// поточну. Пошта зміниться, коли коди введуть (auth_confirm_email_change). Повторний виклик — нові листи (і коди).
#[tauri::command]
pub async fn auth_change_email(app: AppHandle, email: String) -> Result<(), AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let token = auth.access_token(&app)?;
    let email = clean_email(&email);
    if auth.current().is_some_and(|session| session.user.email == email) {
      return Err(AuthError::new("same_email", "Це вже пошта вашого облікового запису."));
    }
    match call(Method::Put, "user", Some(&token), &json!({ "email": email })) {
      Ok(_) => Ok(()),
      Err(error) if matches!(error.code.as_str(), "email_exists" | "user_already_exists" | "identity_already_exists") => {
        Err(AuthError::new(&error.code, "Ця пошта вже належить іншому обліковому запису."))
      }
      Err(error) => Err(error),
    }
  })
  .await
}

/// Код із листа про зміну пошти на `email`. Код міг прийти на нову пошту чи (з «Secure email change») на поточну —
/// пробуємо обидві. Якщо Supabase чекає ще й другий код, `waiting` — адреса, на яку він прийшов.
#[tauri::command]
pub async fn auth_confirm_email_change(app: AppHandle, email: String, code: String) -> Result<EmailChange, AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let current = auth.current().ok_or_else(signed_out)?;
    let new_email = clean_email(&email);
    let verify = |address: &str| call(Method::Post, "verify", None, &json!({ "type": "email_change", "email": address, "token": code.trim() }));
    let (reply, other) = match verify(&new_email) {
      Ok(reply) => (reply, current.user.email.clone()),
      Err(error) if error.code == "otp_expired" => match verify(&current.user.email) {
        Ok(reply) => (reply, new_email),
        Err(_) => return Err(error),
      },
      Err(error) => return Err(error),
    };
    // Прийнято лише один із двох кодів: відповідь без сеансу.
    let Some(mut session) = session_of(&reply, current.remember) else {
      return Ok(EmailChange { state: None, waiting: Some(other) });
    };
    if session.user.id != current.user.id {
      return Err(signed_out());
    }
    // Ключ синхронізації — з пароля й id користувача, не з пошти: лишається той самий.
    session.sync_key = current.sync_key;
    session.sync_key_at = current.sync_key_at;
    let user = current.user.id;
    let state = auth.replace(&app, Some(session), |now| now.is_some_and(|now| now.user.id == user));
    Ok(EmailChange { state: Some(state), waiting: None })
  })
  .await
}

/// Видаляє обліковий запис назавжди — разом з усіма його синхронізованими даними на сервері. Пароль — підтвердження:
/// з ним щойно входимо, а функція бази видаляє лише того, хто ввів пароль кілька хвилин тому (supabase/account.sql).
/// Сеанс лишається, поки інтерфейс не прибере дані облікового запису на цьому комп'ютері й не вийде (auth_sign_out),
/// але запитів від імені видаленого облікового запису вже немає.
#[tauri::command]
pub async fn auth_delete_account(app: AppHandle, password: String) -> Result<(), AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let current = auth.current().ok_or_else(signed_out)?;
    let reply = call(Method::Post, "token?grant_type=password", None, &json!({ "email": current.user.email, "password": password }))
      .map_err(|error| if error.code == "invalid_credentials" { AuthError::new(&error.code, "Неправильний пароль.") } else { error })?;
    let checked = session_or_error(&reply, false)?;
    if checked.user.id != current.user.id {
      return Err(signed_out());
    }
    let url = format!("{SUPABASE_URL}/rest/v1/rpc/delete_account");
    let (status, body) = request(Method::Post, &url, Some(&checked.access_token), &json!({}))?;
    if !(200..300).contains(&status) {
      // Обліковий запис лишився, а сеанс із перевірки пароля — зайвий.
      let _ = call(Method::Post, "logout?scope=local", Some(&checked.access_token), &json!({}));
      return Err(delete_error(status, &body));
    }
    if let Ok(mut deleting) = auth.deleting.lock() {
      *deleting = Some(current.user.id);
    }
    // Лист «Обліковий запис видалено»: сервер перевірить підпис токена й те, що користувача справді вже немає.
    notify(checked.access_token, "account-deleted");
    Ok(())
  })
  .await
}

/// Помилка функції бази `delete_account` (PostgREST): `{"code": "28000", "message": "reauthentication_needed"}`.
fn delete_error(status: u16, body: &Value) -> AuthError {
  match (text(body, "code").unwrap_or_default(), text(body, "message").unwrap_or_default()) {
    // Функції ще немає (SQL з інструкції не виконали) чи її не дозволено викликати.
    ("PGRST202" | "42883" | "42501", _) => {
      AuthError::new("delete_not_configured", "Видалення облікового запису ще не налаштовано на сервері (supabase/account.sql).")
    }
    (_, "reauthentication_needed") => AuthError::new("reauthentication_needed", "Не вдалося підтвердити пароль. Спробуйте ще раз."),
    ("PGRST301" | "PGRST303", _) => AuthError::new("session_expired", "Сеанс завершився. Увійдіть знову."),
    _ if status >= 500 => AuthError::new("server", "Сервер облікових записів зараз недоступний. Спробуйте пізніше."),
    (code, _) => AuthError::new(if code.is_empty() { "server" } else { code }, "Не вдалося видалити обліковий запис. Спробуйте ще раз."),
  }
}

fn unexpected() -> AuthError {
  AuthError::new("server", "Сервер облікових записів відповів неочікувано. Спробуйте ще раз.")
}

/// Вихід: сеанс забувається одразу, а Supabase повідомляємо, як вийде (без інтернету — ні). Після видалення
/// облікового запису повідомляти нема кому — натомість прибираємо його теки на цьому комп'ютері.
#[tauri::command]
pub async fn auth_sign_out(app: AppHandle) -> Result<(), AuthError> {
  blocking(move || {
    let auth = app.state::<Auth>();
    let session = auth.current();
    let deleted = auth.deleting.lock().ok().and_then(|mut deleting| deleting.take());
    auth.set(&app, None);
    if let Some(user) = deleted {
      profiles::forget(&app, &user);
    } else if let Some(session) = session {
      let _ = call(Method::Post, "logout?scope=local", Some(&session.access_token), &json!({}));
    }
    Ok(())
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_session_and_user_from_a_token_reply() {
    let reply = json!({
      "access_token": "access",
      "refresh_token": "refresh",
      "expires_in": 3600,
      "expires_at": 2_000_000_000u64,
      "user": { "id": "u1", "email": "user@example.com", "user_metadata": { "name": " Роман " } }
    });
    let session = session_of(&reply, true).expect("session");
    assert_eq!(session.expires_at, 2_000_000_000);
    assert_eq!(session.user, User { id: "u1".into(), email: "user@example.com".into(), name: "Роман".into() });

    // Відповідь на реєстрацію з підтвердженням пошти — лише користувач, без токенів.
    assert!(session_of(&json!({ "id": "u1", "email": "user@example.com" }), true).is_none());
  }

  #[test]
  fn explains_database_errors() {
    assert_eq!(rest_error(404, &json!({ "code": "PGRST205", "message": "Could not find the table" })).code, "sync_not_configured");
    assert_eq!(rest_error(401, &json!({ "code": "PGRST303" })).code, "session_expired");
    assert_eq!(rest_error(502, &Value::Null).code, "server");
  }

  #[test]
  fn reads_supabase_times_and_tells_new_accounts() {
    assert_eq!(unix_seconds("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(unix_seconds("2026-10-10T12:34:56.789Z"), Some(1_791_635_696));
    assert_eq!(unix_seconds("2024-02-29T00:00:00Z"), Some(1_709_164_800));
    assert_eq!(unix_seconds("не дата"), None);
    assert!(just_created(&json!({ "created_at": "2026-10-10T12:00:00Z", "last_sign_in_at": "2026-10-10T12:00:01.5Z" })));
    assert!(!just_created(&json!({ "created_at": "2026-01-01T12:00:00Z", "last_sign_in_at": "2026-10-10T12:00:00Z" })));
  }

  #[test]
  fn takes_the_code_or_the_error_from_the_oauth_redirect() {
    let url = |text: &str| tauri::Url::parse(text).expect("url");
    assert_eq!(oauth_result(&url("http://localhost/astra-auth-callback?code=abc-123")).ok().as_deref(), Some("abc-123"));
    let error = oauth_result(&url("http://localhost/astra-auth-callback?error=access_denied&error_description=User+cancelled")).unwrap_err();
    assert_eq!(error.message, "Не вдалося ввійти через Google: User cancelled");
    let (verifier, challenge) = pkce();
    assert_eq!(verifier.len(), 64);
    assert_eq!(challenge.len(), 43);
  }

  #[test]
  fn explains_account_deletion_errors() {
    let missing = delete_error(404, &json!({ "code": "PGRST202", "message": "Could not find the function public.delete_account" }));
    assert_eq!(missing.code, "delete_not_configured");
    let stale = delete_error(403, &json!({ "code": "28000", "message": "reauthentication_needed" }));
    assert_eq!(stale.code, "reauthentication_needed");
    assert_eq!(delete_error(503, &Value::Null).code, "server");
  }

  #[test]
  fn explains_supabase_errors_in_ukrainian() {
    let error = api_error(400, &json!({ "code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials" }));
    assert_eq!(error.code, "invalid_credentials");
    assert_eq!(error.message, "Неправильна пошта або пароль.");

    let old = api_error(400, &json!({ "error": "invalid_grant", "error_description": "Invalid Refresh Token" }));
    assert!(is_session_gone(&old));

    let weak = api_error(422, &json!({ "error_code": "weak_password", "weak_password": { "reasons": ["pwned"] } }));
    assert_eq!(weak.message, "Цей пароль трапляється у витоках даних. Виберіть інший.");

    assert_eq!(api_error(503, &Value::Null).code, "server");
    assert!(!is_session_gone(&offline()));
  }
}
