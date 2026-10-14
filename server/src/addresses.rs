//! Адреси для форм на сайтах: ім'я, організація, адреса доставки, телефон і пошта.
//!
//! У кожного облікового запису Astra свої адреси: addresses.dat у його теці (profiles.rs); поки ніхто не ввійшов,
//! адрес немає. Увесь файл зашифровано DPAPI Windows (secure.rs): прочитати його може лише той самий користувач Windows.
//!
//! Сторінки сайтів говорять із модулем через скрипт autofill-page.js (webview2::watch_page_messages). Користувач став
//! у поле адреси — інтерфейс вікна показує над сайтом збережені адреси (подія page://autofill); вибрав одну — сторінка
//! отримує її значення й заповнює ними поля форми. Список малює інтерфейс, а не сторінка, тож скрипти сайту адрес не
//! бачать, а значення отримують лише після вибору й лише для полів, що є у формі. Надіслали форму з новою адресою —
//! браузер пропонує її зберегти (page://address-prompt). Відповідає модуль лише скрипту, що знає токен своєї сторінки.
//!
//! Синхронізація (addresses_sync_items, addresses_sync_apply) — як у паролів (passwords.rs): кожна адреса шифрується
//! AES-GCM ключем із пароля облікового запису, і сервер бачить лише шифр.

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

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Window};

use crate::{
  pages::GUEST_PREFIX,
  passwords::{open_item, seal_item, Envelope, SyncApplied, SyncChange, SyncItems},
  profiles,
  secure::{self, random_hex},
};

const BOOK_FILE: &str = "addresses.dat";
/// Додатковий «ключ» DPAPI: інша програма того самого користувача не розшифрує адреси, не знаючи його.
const ENTROPY: &[u8] = b"AstraBrowser addresses v1";
const PAGE_SCRIPT: &str = include_str!("autofill-page.js");
/// Найдовше значення поля, яке береться з форми сайту.
const MAX_FIELD: usize = 300;

/// Поля адреси. У формі сайту їм відповідають види полів autofill-page.js; ще два види складаються з кількох полів:
/// `name` — ім'я й прізвище разом, `street` — обидва рядки адреси.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddressFields {
  given: String,
  family: String,
  organization: String,
  /// Вулиця й будинок.
  line1: String,
  /// Квартира, офіс, під'їзд.
  line2: String,
  city: String,
  /// Область, штат, провінція.
  region: String,
  postal: String,
  country: String,
  phone: String,
  email: String,
}

impl AddressFields {
  /// Поля з назвами їхніх видів у формі (autofill-page.js).
  fn named(&self) -> [(&'static str, &String); 11] {
    [
      ("given", &self.given),
      ("family", &self.family),
      ("organization", &self.organization),
      ("line1", &self.line1),
      ("line2", &self.line2),
      ("city", &self.city),
      ("region", &self.region),
      ("postal", &self.postal),
      ("country", &self.country),
      ("phone", &self.phone),
      ("email", &self.email),
    ]
  }

  fn fields(&self) -> [&String; 11] {
    self.named().map(|(_, field)| field)
  }

  fn fields_mut(&mut self) -> [&mut String; 11] {
    [
      &mut self.given,
      &mut self.family,
      &mut self.organization,
      &mut self.line1,
      &mut self.line2,
      &mut self.city,
      &mut self.region,
      &mut self.postal,
      &mut self.country,
      &mut self.phone,
      &mut self.email,
    ]
  }

  fn is_empty(&self) -> bool {
    self.fields().iter().all(|field| field.trim().is_empty())
  }

  fn trimmed(mut self) -> Self {
    for field in self.fields_mut() {
      *field = field.trim().to_string();
    }
    self
  }

  /// Значення для поля форми виду `kind` (autofill-page.js); порожнє — такого в адресі немає.
  fn value(&self, kind: &str) -> String {
    let join = |parts: [&String; 2], separator: &str| {
      parts.iter().map(|part| part.trim()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(separator)
    };
    match kind {
      "name" => join([&self.given, &self.family], " "),
      "street" => join([&self.line1, &self.line2], "\n"),
      _ => self.named().into_iter().find(|(name, _)| *name == kind).map(|(_, field)| field.trim().to_string()).unwrap_or_default(),
    }
  }

  /// Що надіслали у формі сайту: значення за видами полів (autofill-page.js).
  fn from_form(values: &Map<String, Value>) -> Self {
    let get = |kind: &str| -> String {
      values.get(kind).and_then(Value::as_str).unwrap_or_default().trim().chars().take(MAX_FIELD).collect()
    };
    let mut fields = Self {
      given: get("given"),
      family: get("family"),
      organization: get("organization"),
      line1: get("line1"),
      line2: get("line2"),
      city: get("city"),
      region: get("region"),
      postal: get("postal"),
      country: get("country"),
      phone: get("phone"),
      email: get("email"),
    };
    // Одне поле для імені: два слова — ім'я й прізвище; інакше (ПІБ, одне слово) ділити не беремося.
    let name = get("name");
    if fields.given.is_empty() && fields.family.is_empty() && !name.is_empty() {
      let words: Vec<&str> = name.split_whitespace().collect();
      if let [given, family] = words[..] {
        fields.given = given.to_string();
        fields.family = family.to_string();
      } else {
        fields.given = words.join(" ");
      }
    }
    // Адреса одним полем: перший рядок — вулиця й будинок, решта — квартира тощо.
    let street = get("street");
    if fields.line1.is_empty() && !street.is_empty() {
      let mut lines = street.lines().map(str::trim).filter(|line| !line.is_empty());
      fields.line1 = lines.next().unwrap_or_default().to_string();
      if fields.line2.is_empty() {
        fields.line2 = lines.collect::<Vec<_>>().join(", ");
      }
    }
    fields
  }

  /// Чи варто пропонувати зберегти: хоча б три поля, і серед них — де (вулиця, місто чи індекс). Форма зворотного
  /// зв'язку з іменем, поштою й телефоном — ще не адреса.
  fn worth_saving(&self) -> bool {
    let has = |field: &String| !field.trim().is_empty();
    let filled = [
      has(&self.given) || has(&self.family),
      has(&self.organization),
      has(&self.line1),
      has(&self.city),
      has(&self.region),
      has(&self.postal),
      has(&self.country),
      has(&self.phone),
      has(&self.email),
    ]
    .into_iter()
    .filter(|filled| *filled)
    .count();
    filled >= 3 && (has(&self.line1) || has(&self.city) || has(&self.postal))
  }

  /// Усе, що є в `other`, уже є й тут (ті самі значення) — нового в ній нічого.
  fn covers(&self, other: &Self) -> bool {
    self.named().into_iter().zip(other.fields()).all(|((name, mine), theirs)| {
      theirs.trim().is_empty() || if name == "phone" { same_phone(mine, theirs) } else { same_text(mine, theirs) }
    })
  }

  /// Та сама людина за тією самою адресою, телефоном чи поштою — тоді це оновлення збереженої адреси, а не нова.
  fn same_owner(&self, other: &Self) -> bool {
    let name = |fields: &Self| fields.value("name");
    let filled = |a: &String, b: &String| !a.trim().is_empty() && !b.trim().is_empty();
    !name(self).is_empty()
      && same_text(&name(self), &name(other))
      && ((filled(&self.line1, &other.line1) && same_text(&self.line1, &other.line1))
        || (filled(&self.phone, &other.phone) && same_phone(&self.phone, &other.phone))
        || (filled(&self.email, &other.email) && same_text(&self.email, &other.email)))
  }

  /// Ця адреса, де замість її значень — непорожні з `other`.
  fn merged(&self, other: &Self) -> Self {
    let mut merged = self.clone();
    for (mine, theirs) in merged.fields_mut().into_iter().zip(other.fields()) {
      if !theirs.trim().is_empty() {
        *mine = theirs.trim().to_string();
      }
    }
    merged
  }
}

/// Те саме значення без огляду на регістр і зайві пробіли.
fn same_text(a: &str, b: &str) -> bool {
  let normal = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
  normal(a) == normal(b)
}

/// Той самий номер, хоч би як записаний: +380 67 123 45 67 і 0671234567 — однакові (останні 9 цифр).
fn same_phone(a: &str, b: &str) -> bool {
  let digits = |text: &str| text.chars().filter(char::is_ascii_digit).collect::<String>();
  let (a, b) = (digits(a), digits(b));
  if a.len() >= 9 && b.len() >= 9 {
    a[a.len() - 9..] == b[b.len() - 9..]
  } else {
    a == b
  }
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Address {
  id: String,
  fields: AddressFields,
  created: u64,
  updated: u64,
  /// Коли адресою востаннє заповнили форму.
  used: Option<u64>,
}

impl Address {
  /// Свіжіші вгорі: якою користувалися нещодавно, а тоді — нещодавно змінені.
  fn recency(&self) -> u64 {
    self.used.unwrap_or(0).max(self.updated)
  }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
  /// Пропонувати зберегти адресу, надіслану у формі.
  offer: bool,
  /// Пропонувати збережені адреси в полях форм.
  autofill: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self { offer: true, autofill: true }
  }
}

/// Налаштування для інтерфейсу: ті самі, але без serde(default) — у TypeScript поля обов'язкові.
#[derive(Clone, Copy, Serialize, specta::Type)]
#[serde(rename = "AddressSettings")]
pub struct SettingsView {
  offer: bool,
  autofill: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Book {
  entries: Vec<Address>,
  settings: Settings,
}

/// Усе, що показує сторінка «Адреси»; надсилається й подією addresses://changed.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddressesState {
  entries: Vec<Address>,
  settings: SettingsView,
}

impl Book {
  fn state(&self) -> AddressesState {
    let mut entries = self.entries.clone();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.recency()));
    AddressesState { entries, settings: SettingsView { offer: self.settings.offer, autofill: self.settings.autofill } }
  }

  /// Адреси, якими можна заповнити поле виду `kind`, — свіжіші першими.
  fn suggestions(&self, kind: &str) -> Vec<String> {
    let mut entries: Vec<&Address> = self.entries.iter().filter(|entry| !entry.fields.value(kind).trim().is_empty()).collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.recency()));
    entries.into_iter().map(|entry| entry.id.clone()).collect()
  }

  fn add(&mut self, fields: AddressFields) -> String {
    let time = now();
    let id = random_hex(12);
    self.entries.push(Address { id: id.clone(), fields, created: time, updated: time, used: None });
    id
  }
}

/// Адреса з форми, що чекає відповіді на «Зберегти адресу?»; `update` — яку збережену вона оновлює.
struct Pending {
  fields: AddressFields,
  update: Option<String>,
}

/// «Зберегти адресу?» для інтерфейсу вікна, де надіслали форму.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
  label: String,
  id: u64,
  /// Що збережеться: для оновлення — збережена адреса разом із новим із форми.
  fields: AddressFields,
  update: bool,
}

/// Місце поля на сторінці — у фізичних пікселях від лівого верхнього кута сайту.
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub(crate) struct Rect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

/// Що робити зі списком над сайтом (інтерфейсові): show — показати під полем `rect` адреси чи картки (`form`) `ids`;
/// move — поле зсунулося; hide — сховати; blur — сайт утратив фокус (сховати, якщо не в сам інтерфейс); key — клавіша
/// в полі. Картки показує cards.rs тією самою подією.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutofillEvent {
  label: String,
  action: &'static str,
  /// address чи card.
  #[serde(skip_serializing_if = "Option::is_none")]
  form: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  kind: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  rect: Option<Rect>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  ids: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  key: Option<String>,
}

impl AutofillEvent {
  fn new(label: &str, action: &'static str) -> Self {
    Self { label: label.to_string(), action, form: None, kind: None, rect: None, ids: Vec::new(), key: None }
  }

  /// Показати список `ids` виду `form` під полем `rect` виду `kind`; без жодного — сховати.
  pub(crate) fn show(label: &str, form: &'static str, kind: String, rect: Rect, ids: Vec<String>) -> Self {
    if ids.is_empty() {
      return Self::new(label, "hide");
    }
    Self { form: Some(form), kind: Some(kind), rect: Some(rect), ids, ..Self::new(label, "show") }
  }
}

/// Поле, у яке став користувач (повідомлення focus від autofill-page.js): вид поля, види полів його частини форми
/// й місце на сторінці.
pub(crate) fn focused_field(message: &Value) -> Option<(String, Vec<String>, Rect)> {
  let kind = message.get("kind")?.as_str()?.to_string();
  let kinds = message
    .get("kinds")
    .and_then(Value::as_array)
    .map(|kinds| kinds.iter().filter_map(Value::as_str).map(str::to_string).collect())
    .unwrap_or_default();
  let rect = message.get("rect").and_then(|rect| serde_json::from_value::<Rect>(rect.clone()).ok()).unwrap_or_default();
  Some((kind, kinds, rect))
}

/// Відповідь сторінці на focus: чи показано список (без того, що в ньому).
pub(crate) fn shown_reply(message: &Value, shown: bool) -> Value {
  json!({ "astra": "autofill", "type": "shown", "seq": message.get("seq"), "on": shown })
}

#[derive(Default)]
pub struct Addresses {
  book: Mutex<Book>,
  /// Файл адрес облікового запису, що ввійшов; `None` — ніхто не ввійшов.
  file: Mutex<Option<PathBuf>>,
  prompts: Mutex<HashMap<u64, Pending>>,
  /// Види полів форми, для якої зараз показано список, — за сторінкою: вибрана адреса дасть значення лише їм.
  forms: Mutex<HashMap<String, Vec<String>>>,
  /// Уже зашифровані для синхронізації записи: той самий запис не шифрується щоразу наново.
  sealed: Mutex<HashMap<String, Envelope>>,
}

/// Що шифрується для запису синхронізації.
#[derive(Serialize, Deserialize)]
struct SyncedAddress {
  fields: AddressFields,
  created: u64,
  updated: u64,
  used: Option<u64>,
}

static NEXT_PROMPT: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

/// Новий список адрес — усім вікнам, крім гостьових: там чужа людина.
fn broadcast(app: &AppHandle, state: AddressesState) {
  let _ = app.emit_filter("addresses://changed", state, |target| match target {
    EventTarget::Window { label } | EventTarget::Webview { label } | EventTarget::WebviewWindow { label } => {
      !label.starts_with(GUEST_PREFIX)
    }
    _ => false,
  });
}

impl Addresses {
  fn change<T>(&self, app: &AppHandle, edit: impl FnOnce(&mut Book) -> Result<T, String>) -> Result<T, String> {
    let (result, state) = {
      let mut book = self.book.lock().map_err(|error| error.to_string())?;
      let result = edit(&mut book)?;
      self.write(&book)?;
      (result, book.state())
    };
    broadcast(app, state);
    Ok(result)
  }

  /// Зашифровано, спершу в тимчасовий файл, потім заміна: обірваний запис не зіпсує сховище.
  fn write(&self, book: &Book) -> Result<(), String> {
    let file = self
      .file
      .lock()
      .map_err(|error| error.to_string())?
      .clone()
      .ok_or(crate::i18n::text("Увійдіть в обліковий запис Astra", "Sign in to your Astra account"))?;
    if let Some(dir) = file.parent() {
      fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let plain = serde_json::to_vec(book).map_err(|error| error.to_string())?;
    let temporary = file.with_extension("dat.tmp");
    fs::write(&temporary, secure::protect(&plain, ENTROPY)?).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &file).map_err(|error| error.to_string())
  }

  pub(crate) fn emit(app: &AppHandle, ui: &str, event: AutofillEvent) {
    let _ = app.emit_to(ui, "page://autofill", event);
  }
}

/// Адреси облікового запису `user` (`None` — вийшли: адрес немає). Викликає auth.rs, щойно змінився обліковий запис.
pub fn switch_account(app: &AppHandle, user: Option<&str>) {
  let file = user.and_then(|user| profiles::dir(app, user)).map(|dir| dir.join(BOOK_FILE));
  let book = file
    .as_ref()
    .and_then(|file| fs::read(file).ok())
    .and_then(|bytes| secure::unprotect(&bytes, ENTROPY).ok())
    .and_then(|plain| serde_json::from_slice::<Book>(&plain).ok())
    .unwrap_or_default();
  let addresses = app.state::<Addresses>();
  let state = {
    let Ok(mut current) = addresses.book.lock() else {
      return;
    };
    *current = book;
    if let Ok(mut current_file) = addresses.file.lock() {
      *current_file = file;
    }
    current.state()
  };
  if let Ok(mut prompts) = addresses.prompts.lock() {
    prompts.clear();
  }
  if let Ok(mut forms) = addresses.forms.lock() {
    forms.clear();
  }
  if let Ok(mut sealed) = addresses.sealed.lock() {
    sealed.clear();
  }
  broadcast(app, state);
}

/// Скрипт автозаповнення для сторінки з токеном `token` (autofill-page.js).
pub fn page_script(token: &str) -> String {
  format!("({PAGE_SCRIPT})({});", Value::from(token))
}

/// Повідомлення скрипта автозаповнення сторінки `label` (вікна `ui`), що зараз показує `source`. Повертає відповідь
/// сторінці.
pub fn on_page_message(app: &AppHandle, ui: &str, label: &str, token: &str, source: &str, message: &Value) -> Option<Value> {
  if ui.starts_with(GUEST_PREFIX) || message.get("token")?.as_str()? != token {
    return None;
  }
  let addresses = app.state::<Addresses>();
  match message.get("type")?.as_str()? {
    "focus" => {
      let (kind, kinds, rect) = focused_field(message)?;
      let ids = {
        let book = addresses.book.lock().ok()?;
        if book.settings.autofill { book.suggestions(&kind) } else { Vec::new() }
      };
      let shown = !ids.is_empty();
      if let Ok(mut forms) = addresses.forms.lock() {
        forms.insert(label.to_string(), kinds);
      }
      Addresses::emit(app, ui, AutofillEvent::show(label, "address", kind, rect, ids));
      Some(shown_reply(message, shown))
    }
    "move" => {
      let rect = serde_json::from_value::<Rect>(message.get("rect")?.clone()).ok()?;
      Addresses::emit(app, ui, AutofillEvent { rect: Some(rect), ..AutofillEvent::new(label, "move") });
      None
    }
    "hide" => {
      Addresses::emit(app, ui, AutofillEvent::new(label, "hide"));
      None
    }
    "blur" => {
      Addresses::emit(app, ui, AutofillEvent::new(label, "blur"));
      None
    }
    "key" => {
      let key = message.get("key")?.as_str()?;
      if matches!(key, "ArrowDown" | "ArrowUp" | "Enter" | "Escape") {
        Addresses::emit(app, ui, AutofillEvent { key: Some(key.to_string()), ..AutofillEvent::new(label, "key") });
      }
      None
    }
    // Приватне вікно нічого не запам'ятовує — й адрес теж.
    "submitted" if !ui.starts_with("private-") && (source.starts_with("https:") || source.starts_with("http:")) => {
      let fields = AddressFields::from_form(message.get("values")?.as_object()?);
      offer_to_save(app, &addresses, ui, label, fields);
      None
    }
    _ => None,
  }
}

/// Надіслали форму з адресою: нова — «Зберегти адресу?», та сама людина з чимось новим — «Оновити адресу?», нічого
/// нового — нічого й не питаємо.
fn offer_to_save(app: &AppHandle, addresses: &Addresses, ui: &str, label: &str, fields: AddressFields) {
  if !fields.worth_saving() {
    return;
  }
  let (shown, update) = {
    let Ok(mut book) = addresses.book.lock() else {
      return;
    };
    if !book.settings.offer {
      return;
    }
    if let Some(entry) = book.entries.iter_mut().find(|entry| entry.fields.covers(&fields)) {
      entry.used = Some(now());
      let _ = addresses.write(&book);
      return;
    }
    match book.entries.iter().find(|entry| entry.fields.same_owner(&fields)) {
      Some(entry) => (entry.fields.merged(&fields), Some(entry.id.clone())),
      None => (fields.clone(), None),
    }
  };
  let Ok(mut prompts) = addresses.prompts.lock() else {
    return;
  };
  // Те саме ще чекає відповіді — вдруге не питаємо.
  if prompts.values().any(|pending| pending.fields == fields) {
    return;
  }
  let id = NEXT_PROMPT.fetch_add(1, Ordering::Relaxed);
  let event = PromptEvent { label: label.to_string(), id, fields: shown, update: update.is_some() };
  prompts.insert(id, Pending { fields, update });
  drop(prompts);
  let _ = app.emit_to(ui, "page://address-prompt", event);
}

/// Команди адрес — не для гостьового вікна: ним користується не власник.
fn deny_guest(window: &Window) -> Result<(), String> {
  if window.label().starts_with(GUEST_PREFIX) {
    Err(crate::i18n::text("У гостьовому режимі адреси недоступні", "Addresses aren't available in guest mode").into())
  } else {
    Ok(())
  }
}

#[tauri::command]
#[specta::specta]
pub fn addresses_state(window: Window, addresses: State<'_, Addresses>) -> Result<AddressesState, String> {
  if window.label().starts_with(GUEST_PREFIX) {
    return Ok(AddressesState { entries: Vec::new(), settings: SettingsView { offer: false, autofill: false } });
  }
  Ok(addresses.book.lock().map_err(|error| error.to_string())?.state())
}

/// Нова адреса (`id` — None) чи нові значення збереженої.
#[tauri::command]
#[specta::specta]
pub fn address_save(
  app: AppHandle,
  window: Window,
  addresses: State<'_, Addresses>,
  id: Option<String>,
  fields: AddressFields,
) -> Result<(), String> {
  deny_guest(&window)?;
  let fields = fields.trimmed();
  if fields.is_empty() {
    return Err(crate::i18n::text("Заповніть хоча б одне поле", "Fill in at least one field").into());
  }
  addresses.change(&app, |book| {
    match id {
      Some(id) => {
        let entry = book
          .entries
          .iter_mut()
          .find(|entry| entry.id == id)
          .ok_or(crate::i18n::text("Такої адреси немає", "No such address"))?;
        entry.fields = fields;
        entry.updated = now();
      }
      None => {
        book.add(fields);
      }
    }
    Ok(())
  })
}

#[tauri::command]
#[specta::specta]
pub fn address_remove(app: AppHandle, window: Window, addresses: State<'_, Addresses>, id: String) -> Result<(), String> {
  deny_guest(&window)?;
  addresses.change(&app, |book| {
    book.entries.retain(|entry| entry.id != id);
    Ok(())
  })
}

#[tauri::command]
#[specta::specta]
pub fn addresses_set_settings(app: AppHandle, window: Window, addresses: State<'_, Addresses>, offer: bool, autofill: bool) -> Result<(), String> {
  deny_guest(&window)?;
  addresses.change(&app, |book| {
    book.settings = Settings { offer, autofill };
    Ok(())
  })
}

/// Відповідь на «Зберегти адресу?»: `save` — зберегти (чи оновити збережену), інакше — не зараз.
#[tauri::command]
#[specta::specta]
pub fn address_prompt_answer(app: AppHandle, window: Window, addresses: State<'_, Addresses>, id: u64, save: bool) -> Result<(), String> {
  deny_guest(&window)?;
  let Some(pending) = addresses.prompts.lock().map_err(|error| error.to_string())?.remove(&id) else {
    return Ok(());
  };
  if !save {
    return Ok(());
  }
  addresses.change(&app, |book| {
    let time = now();
    match pending.update.and_then(|id| book.entries.iter_mut().find(|entry| entry.id == id)) {
      Some(entry) => {
        entry.fields = entry.fields.merged(&pending.fields);
        entry.updated = time;
        entry.used = Some(time);
      }
      None => {
        let id = book.add(pending.fields);
        if let Some(entry) = book.entries.iter_mut().find(|entry| entry.id == id) {
          entry.used = Some(time);
        }
      }
    }
    Ok(())
  })
}

/// Користувач вибрав адресу `id` у списку над сайтом `label`: сторінка отримує її значення для полів своєї форми
/// й заповнює їх, а фокус повертається в поле.
#[tauri::command]
#[specta::specta]
pub fn address_autofill(app: AppHandle, window: Window, addresses: State<'_, Addresses>, label: String, id: String) -> Result<(), String> {
  deny_guest(&window)?;
  let page = app
    .get_webview(&label)
    .filter(|page| page.window().label() == window.label())
    .ok_or(crate::i18n::text("Сторінку вже закрито", "The page is already closed"))?;
  let kinds = addresses.forms.lock().map_err(|error| error.to_string())?.get(&label).cloned().unwrap_or_default();
  let values: Map<String, Value> = {
    let mut book = addresses.book.lock().map_err(|error| error.to_string())?;
    if !book.settings.autofill {
      return Ok(());
    }
    let entry = book.entries.iter_mut().find(|entry| entry.id == id).ok_or(crate::i18n::text("Такої адреси немає", "No such address"))?;
    entry.used = Some(now());
    let values = kinds
      .iter()
      .filter_map(|kind| {
        let value = entry.fields.value(kind);
        (!value.is_empty()).then(|| (kind.clone(), Value::from(value)))
      })
      .collect();
    let _ = addresses.write(&book);
    values
  };
  crate::page_bridge::post(&page, &json!({ "astra": "autofill", "type": "fill", "values": values }))
    .map_err(|error| error.to_string())?;
  let _ = page.set_focus();
  Ok(())
}

/// Відкритий текст запису для синхронізації.
fn synced_address(entry: &Address) -> Result<Vec<u8>, String> {
  let synced = SyncedAddress { fields: entry.fields.clone(), created: entry.created, updated: entry.updated, used: entry.used };
  serde_json::to_vec(&synced).map_err(|error| error.to_string())
}

/// Усі адреси облікового запису, зашифровані для синхронізації.
#[tauri::command]
#[specta::specta]
pub fn addresses_sync_items(app: AppHandle, window: Window, addresses: State<'_, Addresses>) -> Result<SyncItems, String> {
  deny_guest(&window)?;
  let Some((key, key_time)) = crate::auth::sync_key(&app) else {
    return Ok(SyncItems { key_id: None, key_time: 0, items: BTreeMap::new() });
  };
  let key_id = secure::key_id(&key);
  let book = addresses.book.lock().map_err(|error| error.to_string())?;
  let mut cache = addresses.sealed.lock().map_err(|error| error.to_string())?;
  let mut items = BTreeMap::new();
  for entry in &book.entries {
    items.insert(entry.id.clone(), seal_item(&key, &key_id, &mut cache, &entry.id, &synced_address(entry)?)?);
  }
  Ok(SyncItems { key_id: Some(key_id), key_time, items })
}

/// Записи з сервера: нові й змінені адреси — у книгу, видалені — геть. Зашифровані іншим ключем лишаються як є.
#[tauri::command]
#[specta::specta]
pub fn addresses_sync_apply(
  app: AppHandle,
  window: Window,
  addresses: State<'_, Addresses>,
  changes: Vec<SyncChange>,
) -> Result<SyncApplied, String> {
  deny_guest(&window)?;
  let (key, _) = crate::auth::sync_key(&app).ok_or(crate::i18n::text("Немає ключа синхронізації", "No sync key"))?;
  let key_id = secure::key_id(&key);
  let mut unreadable = Vec::new();
  addresses.change(&app, |book| {
    let mut cache = addresses.sealed.lock().map_err(|error| error.to_string())?;
    for change in changes {
      let Some(envelope) = change.data else {
        book.entries.retain(|entry| entry.id != change.id);
        cache.remove(&change.id);
        continue;
      };
      let Some(plain) = (envelope.k == key_id).then(|| open_item(&key, &envelope).ok()).flatten() else {
        unreadable.push(change.id);
        continue;
      };
      let synced: SyncedAddress = serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
      // Та сама адреса, збережена на двох комп'ютерах окремо, — один запис, з сервера.
      book.entries.retain(|entry| entry.id == change.id || entry.fields != synced.fields);
      let entry = Address { id: change.id.clone(), fields: synced.fields, created: synced.created, updated: synced.updated, used: synced.used };
      match book.entries.iter_mut().find(|current| current.id == change.id) {
        Some(current) => *current = entry,
        None => book.entries.push(entry),
      }
      cache.insert(change.id, envelope);
    }
    Ok(())
  })?;
  Ok(SyncApplied { unreadable })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn form(values: Value) -> AddressFields {
    AddressFields::from_form(values.as_object().expect("object"))
  }

  fn home() -> AddressFields {
    AddressFields {
      given: "Іван".into(),
      family: "Петренко".into(),
      line1: "вул. Хрещатик, 1".into(),
      line2: "кв. 5".into(),
      city: "Київ".into(),
      postal: "01001".into(),
      country: "Україна".into(),
      phone: "+380 67 123 45 67".into(),
      email: "ivan@example.com".into(),
      ..AddressFields::default()
    }
  }

  #[test]
  fn reads_one_field_names_and_streets_from_the_form() {
    let fields = form(json!({ "name": " Іван  Петренко ", "street": "вул. Хрещатик, 1\nкв. 5\n", "city": "Київ" }));
    assert_eq!((fields.given.as_str(), fields.family.as_str()), ("Іван", "Петренко"));
    assert_eq!((fields.line1.as_str(), fields.line2.as_str()), ("вул. Хрещатик, 1", "кв. 5"));
    // ПІБ із трьох слів не ділиться: незрозуміло, де ім'я, а де прізвище.
    assert_eq!(form(json!({ "name": "Петренко Іван Петрович" })).given, "Петренко Іван Петрович");
  }

  #[test]
  fn gives_each_form_field_its_value() {
    let fields = home();
    assert_eq!(fields.value("name"), "Іван Петренко");
    assert_eq!(fields.value("street"), "вул. Хрещатик, 1\nкв. 5");
    assert_eq!(fields.value("postal"), "01001");
    assert_eq!(fields.value("organization"), "");
    assert_eq!(fields.value("password"), "");
  }

  #[test]
  fn offers_to_save_only_addresses() {
    assert!(home().worth_saving());
    // Ім'я, телефон і місто — адреса для доставки у відділення.
    assert!(form(json!({ "name": "Іван Петренко", "phone": "0671234567", "city": "Київ" })).worth_saving());
    // Форма зворотного зв'язку — ні.
    assert!(!form(json!({ "name": "Іван Петренко", "phone": "0671234567", "email": "ivan@example.com" })).worth_saving());
    assert!(!form(json!({ "line1": "вул. Хрещатик, 1", "city": "Київ" })).worth_saving());
  }

  #[test]
  fn knows_what_is_already_saved_and_what_updates_it() {
    let saved = home();
    // Те саме, по-іншому записане, — нічого нового.
    assert!(saved.covers(&form(json!({ "name": "іван петренко", "phone": "067 123 45 67", "city": "КИЇВ" }))));
    let moved = form(json!({ "name": "Іван Петренко", "phone": "0671234567", "line1": "вул. Січових Стрільців, 10", "city": "Київ" }));
    assert!(!saved.covers(&moved));
    // Та сама людина й телефон — оновлення: нова вулиця, а решта лишається.
    assert!(saved.same_owner(&moved));
    let merged = saved.merged(&moved);
    assert_eq!(merged.line1, "вул. Січових Стрільців, 10");
    assert_eq!(merged.email, "ivan@example.com");
    // Інша людина — нова адреса.
    assert!(!saved.same_owner(&form(json!({ "name": "Олена Петренко", "phone": "0671234567" }))));
  }

  #[test]
  fn suggests_addresses_that_have_the_field_most_recent_first() {
    let mut book = Book::default();
    let old = book.add(home());
    let new = book.add(AddressFields { given: "Олена".into(), city: "Львів".into(), ..AddressFields::default() });
    book.entries[0].used = Some(now() + 1000);
    assert_eq!(book.suggestions("city"), vec![old.clone(), new]);
    assert_eq!(book.suggestions("postal"), vec![old]);
  }

  #[test]
  fn page_script_gets_its_token() {
    assert!(page_script("abc").ends_with(r#")("abc");"#));
  }
}
