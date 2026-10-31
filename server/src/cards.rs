//! Банківські картки для форм оплати на сайтах: номер, ім'я власника, термін дії й назва для себе.
//!
//! У кожного облікового запису Astra свої картки: cards.json у його теці (profiles.rs); поки ніхто не ввійшов, карток
//! немає. Номер кожної картки зашифровано DPAPI Windows (secure.rs): прочитати його може лише той самий користувач
//! Windows. Інтерфейс номерів не отримує зовсім — лише платіжну систему й останні чотири цифри. CVV/CVC браузер не
//! зберігає й не заповнює ніколи.
//!
//! Сторінки сайтів говорять із модулем через autofill-page.js — так само, як адреси (addresses.rs): користувач став
//! у поле картки — інтерфейс показує над сайтом збережені картки; вибрав одну — браузер, якщо так налаштовано, просить
//! підтвердити особу через Windows Hello (hello.rs), і лише тоді сторінка отримує дані картки для полів своєї форми.
//! Надіслали форму з новою карткою — браузер пропонує її зберегти (page://card-prompt).
//!
//! Синхронізація (cards_sync_items, cards_sync_apply) — як у паролів (passwords.rs): кожна картка шифрується AES-GCM
//! ключем із пароля облікового запису, і сервер бачить лише шифр.

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
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Window};

use crate::{
  addresses::{focused_field, shown_reply, Addresses, AutofillEvent},
  pages::GUEST_PREFIX,
  passwords::{open_item, seal_item, Envelope, SyncApplied, SyncChange, SyncItems},
  profiles,
  secure::{self, random_hex},
};

const VAULT_FILE: &str = "cards.json";
/// Додатковий «ключ» DPAPI: інша програма того самого користувача не розшифрує номери карток, не знаючи його.
const ENTROPY: &[u8] = b"AstraBrowser cards v1";
/// Найдовше ім'я власника чи назва картки.
const MAX_TEXT: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
  id: String,
  /// Номер (лише цифри), зашифрований DPAPI, у base64.
  number: String,
  last4: String,
  brand: String,
  holder: String,
  month: u8,
  year: u16,
  /// Назва для себе («Зарплатна», «Для покупок»).
  nickname: String,
  created: u64,
  updated: u64,
  used: Option<u64>,
}

/// Картка для інтерфейсу — без номера.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
  id: String,
  /// visa, mastercard, amex, prostir, maestro, unionpay, jcb, discover, diners чи card (невідома).
  brand: String,
  last4: String,
  holder: String,
  month: u8,
  year: u16,
  nickname: String,
  created: u64,
  updated: u64,
  /// Коли карткою востаннє заповнили форму.
  used: Option<u64>,
}

impl From<&Entry> for CardInfo {
  fn from(entry: &Entry) -> Self {
    Self {
      id: entry.id.clone(),
      brand: entry.brand.clone(),
      last4: entry.last4.clone(),
      holder: entry.holder.clone(),
      month: entry.month,
      year: entry.year,
      nickname: entry.nickname.clone(),
      created: entry.created,
      updated: entry.updated,
      used: entry.used,
    }
  }
}

/// Картка з вікна «Додати картку» / «Змінити картку». Порожній номер під час зміни — номер лишається той самий.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CardInput {
  number: String,
  holder: String,
  month: u8,
  year: u16,
  nickname: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
  /// Пропонувати зберегти картку, введену у формі оплати.
  offer: bool,
  /// Пропонувати збережені картки в полях форм оплати.
  autofill: bool,
  /// Перед заповненням — Windows Hello (якщо його налаштовано).
  verify: bool,
}

impl Default for Settings {
  fn default() -> Self {
    Self { offer: true, autofill: true, verify: true }
  }
}

/// Налаштування для інтерфейсу: ті самі, але без serde(default) — у TypeScript поля обов'язкові.
#[derive(Clone, Copy, Serialize, specta::Type)]
#[serde(rename = "CardSettings")]
pub struct SettingsView {
  offer: bool,
  autofill: bool,
  verify: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Vault {
  entries: Vec<Entry>,
  settings: Settings,
}

/// Усе, що показує сторінка «Банківські картки»; надсилається й подією cards://changed.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CardsState {
  entries: Vec<CardInfo>,
  settings: SettingsView,
  /// Чи налаштовано Windows Hello: без нього підтверджувати нічим.
  hello: bool,
}

impl Vault {
  fn state(&self) -> CardsState {
    let mut entries: Vec<CardInfo> = self.entries.iter().map(CardInfo::from).collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.used.unwrap_or(0).max(entry.updated)));
    let Settings { offer, autofill, verify } = self.settings;
    CardsState { entries, settings: SettingsView { offer, autofill, verify }, hello: crate::hello::known().unwrap_or(false) }
  }

  /// Картка з цим номером (цифри), якщо її збережено.
  fn find(&self, number: &str) -> Option<usize> {
    self
      .entries
      .iter()
      .position(|entry| entry.last4 == last4(number) && decrypt(&entry.number).is_ok_and(|saved| saved == number))
  }

  fn add(&mut self, card: Card) -> Result<String, String> {
    let time = now();
    let id = random_hex(12);
    self.entries.push(Entry {
      id: id.clone(),
      number: encrypt(&card.number)?,
      last4: last4(&card.number),
      brand: brand_of(&card.number).to_string(),
      holder: card.holder,
      month: card.month,
      year: card.year,
      nickname: card.nickname,
      created: time,
      updated: time,
      used: None,
    });
    Ok(id)
  }
}

/// Картка з відкритим номером — лише в пам'яті Rust: з форми сайту, з вікна інтерфейсу чи з синхронізації.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Card {
  number: String,
  holder: String,
  month: u8,
  year: u16,
  #[serde(default)]
  nickname: String,
}

/// Картка з форми, що чекає відповіді на «Зберегти картку?»; `update` — яку збережену вона оновлює.
struct Pending {
  card: Card,
  update: Option<String>,
}

/// «Зберегти картку?» для інтерфейсу вікна, де надіслали форму, — без номера.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
  label: String,
  id: u64,
  brand: &'static str,
  last4: String,
  holder: String,
  month: u8,
  year: u16,
  update: bool,
}

#[derive(Default)]
pub struct Cards {
  vault: Mutex<Vault>,
  /// Файл карток облікового запису, що ввійшов; `None` — ніхто не ввійшов.
  file: Mutex<Option<PathBuf>>,
  prompts: Mutex<HashMap<u64, Pending>>,
  /// Види полів форми, для якої зараз показано список, — за сторінкою: вибрана картка дасть значення лише їм.
  forms: Mutex<HashMap<String, Vec<String>>>,
  /// Уже зашифровані для синхронізації записи: той самий запис не шифрується щоразу наново.
  sealed: Mutex<HashMap<String, Envelope>>,
}

/// Що шифрується для запису синхронізації.
#[derive(Serialize, Deserialize)]
struct SyncedCard {
  card: Card,
  created: u64,
  updated: u64,
  used: Option<u64>,
}

static NEXT_PROMPT: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis() as u64)
}

fn encrypt(number: &str) -> Result<String, String> {
  Ok(STANDARD.encode(secure::protect(number.as_bytes(), ENTROPY)?))
}

fn decrypt(encrypted: &str) -> Result<String, String> {
  let data = STANDARD.decode(encrypted).map_err(|error| error.to_string())?;
  String::from_utf8(secure::unprotect(&data, ENTROPY)?).map_err(|error| error.to_string())
}

fn last4(number: &str) -> String {
  number[number.len().saturating_sub(4)..].to_string()
}

/// Номер картки з того, як його ввели («4242 4242-4242 4242»): лише цифри, 12–19 і правильна контрольна цифра (Луна).
fn card_number(raw: &str) -> Option<String> {
  let digits: String = raw.chars().filter(|char| !char.is_whitespace() && *char != '-').collect();
  if !(12..=19).contains(&digits.len()) || !digits.chars().all(|char| char.is_ascii_digit()) {
    return None;
  }
  let sum: u32 = digits
    .chars()
    .rev()
    .filter_map(|char| char.to_digit(10))
    .enumerate()
    .map(|(index, digit)| {
      if index % 2 == 1 {
        if digit * 2 > 9 {
          digit * 2 - 9
        } else {
          digit * 2
        }
      } else {
        digit
      }
    })
    .sum();
  sum.is_multiple_of(10).then_some(digits)
}

/// Платіжна система за першими цифрами номера.
fn brand_of(number: &str) -> &'static str {
  let prefix = |length: usize| number.get(..length).and_then(|part| part.parse::<u32>().ok()).unwrap_or(0);
  match () {
    _ if number.starts_with('4') => "visa",
    _ if (51..=55).contains(&prefix(2)) || (2221..=2720).contains(&prefix(4)) => "mastercard",
    _ if matches!(prefix(2), 34 | 37) => "amex",
    _ if prefix(4) == 9804 => "prostir",
    _ if prefix(2) == 62 => "unionpay",
    _ if (3528..=3589).contains(&prefix(4)) => "jcb",
    _ if prefix(4) == 6011 || prefix(2) == 65 || (644..=649).contains(&prefix(3)) => "discover",
    _ if (300..=305).contains(&prefix(3)) || matches!(prefix(2), 36 | 38) => "diners",
    _ if matches!(prefix(2), 50 | 56..=69) => "maestro",
    _ => "card",
  }
}

/// Рік терміну дії: 28 — це 2028.
fn full_year(year: u16) -> u16 {
  if year < 100 {
    2000 + year
  } else {
    year
  }
}

fn clean_text(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TEXT).collect()
}

impl Card {
  /// Картка з форми сайту (autofill-page.js): номер, ім'я власника, місяць і рік. Без правильного номера — не картка.
  fn from_form(values: &Map<String, Value>) -> Option<Self> {
    let text = |key: &str| values.get(key).and_then(Value::as_str).unwrap_or_default();
    let number = card_number(text("number"))?;
    let month = text("month").trim().parse::<u8>().ok().filter(|month| (1..=12).contains(month)).unwrap_or(0);
    let year = text("year").trim().parse::<u16>().ok().map(full_year).filter(|year| (2000..=2100).contains(year)).unwrap_or(0);
    // Термін — або весь, або ніякого: сам місяць без року нічого не каже.
    let (month, year) = if month == 0 || year == 0 { (0, 0) } else { (month, year) };
    let holder = clean_text(text("holder"));
    Some(Self { number, holder, month, year, nickname: String::new() })
  }

  /// Те саме, що вже збережено: ім'я й термін або ті самі, або їх у формі не було.
  fn matches(&self, entry: &Entry) -> bool {
    (self.holder.is_empty() || self.holder.to_lowercase() == entry.holder.to_lowercase())
      && (self.month == 0 || (self.month == entry.month && self.year == entry.year))
  }
}

/// Новий список карток — усім вікнам, крім гостьових: там чужа людина.
fn broadcast(app: &AppHandle, state: CardsState) {
  let _ = app.emit_filter("cards://changed", state, |target| match target {
    EventTarget::Window { label } | EventTarget::Webview { label } | EventTarget::WebviewWindow { label } => {
      !label.starts_with(GUEST_PREFIX)
    }
    _ => false,
  });
}

impl Cards {
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
    let file = self
      .file
      .lock()
      .map_err(|error| error.to_string())?
      .clone()
      .ok_or(crate::i18n::text("Увійдіть в обліковий запис Astra", "Sign in to your Astra account"))?;
    if let Some(dir) = file.parent() {
      fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let temporary = file.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(vault).map_err(|error| error.to_string())?)
      .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &file).map_err(|error| error.to_string())
  }
}

/// Чи налаштовано Windows Hello — питаємо Windows одразу після запуску, у фоні, і тоді оновлюємо стан карток.
pub fn start(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    crate::hello::available();
    if let Ok(vault) = app.state::<Cards>().vault.lock() {
      broadcast(&app, vault.state());
    }
  });
}

/// Картки облікового запису `user` (`None` — вийшли: карток немає). Викликає auth.rs, щойно змінився обліковий запис.
pub fn switch_account(app: &AppHandle, user: Option<&str>) {
  let file = user.and_then(|user| profiles::dir(app, user)).map(|dir| dir.join(VAULT_FILE));
  let vault = file
    .as_ref()
    .and_then(|file| fs::read(file).ok())
    .and_then(|bytes| serde_json::from_slice::<Vault>(&bytes).ok())
    .unwrap_or_default();
  let cards = app.state::<Cards>();
  let state = {
    let Ok(mut current) = cards.vault.lock() else {
      return;
    };
    *current = vault;
    if let Ok(mut current_file) = cards.file.lock() {
      *current_file = file;
    }
    current.state()
  };
  if let Ok(mut prompts) = cards.prompts.lock() {
    prompts.clear();
  }
  if let Ok(mut forms) = cards.forms.lock() {
    forms.clear();
  }
  if let Ok(mut sealed) = cards.sealed.lock() {
    sealed.clear();
  }
  broadcast(app, state);
}

/// Повідомлення скрипта автозаповнення про поля картки (form: card) сторінки `label` вікна `ui`, що показує `source`.
pub fn on_page_message(app: &AppHandle, ui: &str, label: &str, token: &str, source: &str, message: &Value) -> Option<Value> {
  if ui.starts_with(GUEST_PREFIX) || message.get("token")?.as_str()? != token {
    return None;
  }
  let cards = app.state::<Cards>();
  match message.get("type")?.as_str()? {
    "focus" => {
      let (kind, kinds, rect) = focused_field(message)?;
      let ids: Vec<String> = {
        let vault = cards.vault.lock().ok()?;
        // Як у Chrome: на незахищеній сторінці (http) картки не пропонуються — дані пішли б мережею відкрито.
        if vault.settings.autofill && (source.starts_with("https:") || is_local(source)) {
          // Ім'я власника — лише з карток, де воно є.
          vault
            .state()
            .entries
            .into_iter()
            .filter(|entry| kind != "cc-name" || !entry.holder.is_empty())
            .map(|entry| entry.id)
            .collect()
        } else {
          Vec::new()
        }
      };
      let shown = !ids.is_empty();
      if let Ok(mut forms) = cards.forms.lock() {
        forms.insert(label.to_string(), kinds);
      }
      Addresses::emit(app, ui, AutofillEvent::show(label, "card", kind, rect, ids));
      Some(shown_reply(message, shown))
    }
    // Приватне вікно нічого не запам'ятовує — й карток теж. Картки — лише із захищених сторінок.
    "submitted" if !ui.starts_with("private-") && (source.starts_with("https:") || is_local(source)) => {
      if let Some(card) = Card::from_form(message.get("values")?.as_object()?) {
        offer_to_save(app, &cards, ui, label, card);
      }
      None
    }
    _ => None,
  }
}

/// Сторінка з цього комп'ютера (розробка й перевірка сайтів): http://localhost чи 127.0.0.1.
fn is_local(source: &str) -> bool {
  tauri::Url::parse(source).is_ok_and(|url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}

/// Надіслали форму з карткою: нова — «Зберегти картку?», та сама з новим терміном чи іменем — «Оновити картку?»,
/// та сама — нічого не питаємо.
fn offer_to_save(app: &AppHandle, cards: &Cards, ui: &str, label: &str, card: Card) {
  let update = {
    let Ok(mut vault) = cards.vault.lock() else {
      return;
    };
    if !vault.settings.offer {
      return;
    }
    match vault.find(&card.number) {
      Some(index) if card.matches(&vault.entries[index]) => {
        vault.entries[index].used = Some(now());
        let _ = cards.write(&vault);
        return;
      }
      Some(index) => Some(vault.entries[index].id.clone()),
      None => None,
    }
  };
  let Ok(mut prompts) = cards.prompts.lock() else {
    return;
  };
  // Те саме ще чекає відповіді — вдруге не питаємо.
  if prompts.values().any(|pending| pending.card == card) {
    return;
  }
  let id = NEXT_PROMPT.fetch_add(1, Ordering::Relaxed);
  let event = PromptEvent {
    label: label.to_string(),
    id,
    brand: brand_of(&card.number),
    last4: last4(&card.number),
    holder: card.holder.clone(),
    month: card.month,
    year: card.year,
    update: update.is_some(),
  };
  prompts.insert(id, Pending { card, update });
  drop(prompts);
  let _ = app.emit_to(ui, "page://card-prompt", event);
}

/// Команди карток — не для гостьового вікна: ним користується не власник.
fn deny_guest(window: &Window) -> Result<(), String> {
  if window.label().starts_with(GUEST_PREFIX) {
    Err(crate::i18n::text("У гостьовому режимі картки недоступні", "Cards aren't available in guest mode").into())
  } else {
    Ok(())
  }
}

#[tauri::command]
#[specta::specta]
pub fn cards_state(window: Window, cards: State<'_, Cards>) -> Result<CardsState, String> {
  if window.label().starts_with(GUEST_PREFIX) {
    let settings = SettingsView { offer: false, autofill: false, verify: false };
    return Ok(CardsState { entries: Vec::new(), settings, hello: false });
  }
  Ok(cards.vault.lock().map_err(|error| error.to_string())?.state())
}

/// Нова картка (`id` — None) чи нові дані збереженої.
#[tauri::command]
#[specta::specta]
pub fn card_save(
  app: AppHandle,
  window: Window,
  cards: State<'_, Cards>,
  id: Option<String>,
  card: CardInput,
) -> Result<(), String> {
  deny_guest(&window)?;
  let number = if card.number.trim().is_empty() && id.is_some() {
    None
  } else {
    Some(card_number(&card.number).ok_or(crate::i18n::text("Некоректний номер картки", "Invalid card number"))?)
  };
  if !(1..=12).contains(&card.month) || !(2000..=2100).contains(&card.year) {
    return Err(crate::i18n::text("Вкажіть термін дії картки", "Enter the card's expiry date").into());
  }
  let (holder, nickname) = (clean_text(&card.holder), clean_text(&card.nickname));
  cards.change(&app, |vault| {
    let duplicate = number.as_ref().and_then(|number| vault.find(number)).map(|index| vault.entries[index].id.clone());
    if duplicate.is_some() && duplicate != id {
      return Err(crate::i18n::text("Цю картку вже збережено", "This card is already saved").into());
    }
    match id {
      Some(id) => {
        let entry =
          vault.entries.iter_mut().find(|entry| entry.id == id).ok_or(crate::i18n::text("Такої картки немає", "No such card"))?;
        if let Some(number) = number {
          entry.number = encrypt(&number)?;
          entry.last4 = last4(&number);
          entry.brand = brand_of(&number).to_string();
        }
        entry.holder = holder;
        entry.month = card.month;
        entry.year = card.year;
        entry.nickname = nickname;
        entry.updated = now();
      }
      None => {
        let number = number.ok_or(crate::i18n::text("Некоректний номер картки", "Invalid card number"))?;
        vault.add(Card { number, holder, month: card.month, year: card.year, nickname })?;
      }
    }
    Ok(())
  })
}

#[tauri::command]
#[specta::specta]
pub fn card_remove(app: AppHandle, window: Window, cards: State<'_, Cards>, id: String) -> Result<(), String> {
  deny_guest(&window)?;
  cards.change(&app, |vault| {
    vault.entries.retain(|entry| entry.id != id);
    Ok(())
  })
}

#[tauri::command]
#[specta::specta]
pub fn cards_set_settings(
  app: AppHandle,
  window: Window,
  cards: State<'_, Cards>,
  offer: bool,
  autofill: bool,
  verify: bool,
) -> Result<(), String> {
  deny_guest(&window)?;
  cards.change(&app, |vault| {
    vault.settings = Settings { offer, autofill, verify };
    Ok(())
  })
}

/// Відповідь на «Зберегти картку?»: `save` — зберегти (чи оновити збережену), інакше — не зараз.
#[tauri::command]
#[specta::specta]
pub fn card_prompt_answer(app: AppHandle, window: Window, cards: State<'_, Cards>, id: u64, save: bool) -> Result<(), String> {
  deny_guest(&window)?;
  let Some(pending) = cards.prompts.lock().map_err(|error| error.to_string())?.remove(&id) else {
    return Ok(());
  };
  if !save {
    return Ok(());
  }
  cards.change(&app, |vault| {
    let time = now();
    match pending.update.and_then(|id| vault.entries.iter_mut().find(|entry| entry.id == id)) {
      Some(entry) => {
        if !pending.card.holder.is_empty() {
          entry.holder = pending.card.holder;
        }
        if pending.card.month != 0 && pending.card.year != 0 {
          entry.month = pending.card.month;
          entry.year = pending.card.year;
        }
        entry.updated = time;
        entry.used = Some(time);
      }
      None => {
        let id = vault.add(pending.card)?;
        if let Some(entry) = vault.entries.iter_mut().find(|entry| entry.id == id) {
          entry.used = Some(time);
        }
      }
    }
    Ok(())
  })
}

/// Користувач вибрав картку `id` у списку над сайтом `label`. Якщо так налаштовано й Windows Hello є — спершу
/// підтвердження особи; тоді сторінка отримує дані картки для полів своєї форми (CVV/CVC — ніколи), а фокус
/// повертається в поле. false — підтвердження не пройшло (скасували).
#[tauri::command]
#[specta::specta]
pub async fn card_autofill(app: AppHandle, window: Window, label: String, id: String) -> Result<bool, String> {
  deny_guest(&window)?;
  let page = app
    .get_webview(&label)
    .filter(|page| page.window().label() == window.label())
    .ok_or(crate::i18n::text("Сторінку вже закрито", "The page is already closed"))?;
  let verify = app.state::<Cards>().vault.lock().map_err(|error| error.to_string())?.settings.verify;
  if verify {
    #[cfg(windows)]
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let hwnd = 0;
    let message = crate::i18n::text(
      "Astra Browser хоче заповнити на сайті дані банківської картки",
      "Astra Browser wants to fill in bank card details on a site",
    );
    // Збій самого Windows Hello — не привід віддати картку без підтвердження: не заповнюємо, а в журнал — чому.
    let verified = tauri::async_runtime::spawn_blocking(move || {
      !crate::hello::available()
        || crate::hello::verify(hwnd, message).unwrap_or_else(|error| {
          log::warn!("cards: Windows Hello не спрацював: {error}");
          false
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    if !verified {
      return Ok(false);
    }
  }
  let cards = app.state::<Cards>();
  let kinds = cards.forms.lock().map_err(|error| error.to_string())?.get(&label).cloned().unwrap_or_default();
  let values: Map<String, Value> = {
    let mut vault = cards.vault.lock().map_err(|error| error.to_string())?;
    if !vault.settings.autofill {
      return Ok(false);
    }
    let entry =
      vault.entries.iter_mut().find(|entry| entry.id == id).ok_or(crate::i18n::text("Такої картки немає", "No such card"))?;
    entry.used = Some(now());
    let number = decrypt(&entry.number)?;
    let values = fill_values(&kinds, &number, entry);
    let _ = cards.write(&vault);
    values
  };
  crate::page_bridge::post(&page, &json!({ "astra": "autofill", "type": "fill", "values": values }))
    .map_err(|error| error.to_string())?;
  let _ = page.set_focus();
  Ok(true)
}

/// Значення для полів картки, що є у формі: номер, ім'я, місяць (MM), рік (YYYY) і термін разом (MM/YYYY — сторінка
/// сама запише його так, як просить поле). CVV/CVC серед них немає.
fn fill_values(kinds: &[String], number: &str, entry: &Entry) -> Map<String, Value> {
  let month = if entry.month == 0 { String::new() } else { format!("{:02}", entry.month) };
  let year = if entry.year == 0 { String::new() } else { entry.year.to_string() };
  kinds
    .iter()
    .filter_map(|kind| {
      let value = match kind.as_str() {
        "cc-number" => number.to_string(),
        "cc-name" => entry.holder.clone(),
        "cc-exp-month" => month.clone(),
        "cc-exp-year" => year.clone(),
        "cc-exp" if !month.is_empty() && !year.is_empty() => format!("{month}/{year}"),
        _ => return None,
      };
      (!value.is_empty()).then(|| (kind.clone(), Value::from(value)))
    })
    .collect()
}

/// Усі картки облікового запису, зашифровані для синхронізації.
#[tauri::command]
#[specta::specta]
pub fn cards_sync_items(app: AppHandle, window: Window, cards: State<'_, Cards>) -> Result<SyncItems, String> {
  deny_guest(&window)?;
  let Some((key, key_time)) = crate::auth::sync_key(&app) else {
    return Ok(SyncItems { key_id: None, key_time: 0, items: BTreeMap::new() });
  };
  let key_id = secure::key_id(&key);
  let vault = cards.vault.lock().map_err(|error| error.to_string())?;
  let mut cache = cards.sealed.lock().map_err(|error| error.to_string())?;
  let mut items = BTreeMap::new();
  for entry in &vault.entries {
    // Номер, що вже не розшифровується (інший користувач Windows), синхронізувати нічим.
    let Ok(number) = decrypt(&entry.number) else {
      continue;
    };
    let card =
      Card { number, holder: entry.holder.clone(), month: entry.month, year: entry.year, nickname: entry.nickname.clone() };
    let synced = SyncedCard { card, created: entry.created, updated: entry.updated, used: entry.used };
    let plain = serde_json::to_vec(&synced).map_err(|error| error.to_string())?;
    items.insert(entry.id.clone(), seal_item(&key, &key_id, &mut cache, &entry.id, &plain)?);
  }
  Ok(SyncItems { key_id: Some(key_id), key_time, items })
}

/// Записи з сервера: нові й змінені картки — у сховище, видалені — геть. Зашифровані іншим ключем лишаються як є.
#[tauri::command]
#[specta::specta]
pub fn cards_sync_apply(
  app: AppHandle,
  window: Window,
  cards: State<'_, Cards>,
  changes: Vec<SyncChange>,
) -> Result<SyncApplied, String> {
  deny_guest(&window)?;
  let (key, _) = crate::auth::sync_key(&app).ok_or(crate::i18n::text("Немає ключа синхронізації", "No sync key"))?;
  let key_id = secure::key_id(&key);
  let mut unreadable = Vec::new();
  cards.change(&app, |vault| {
    let mut cache = cards.sealed.lock().map_err(|error| error.to_string())?;
    for change in changes {
      let Some(envelope) = change.data else {
        vault.entries.retain(|entry| entry.id != change.id);
        cache.remove(&change.id);
        continue;
      };
      let Some(plain) = (envelope.k == key_id).then(|| open_item(&key, &envelope).ok()).flatten() else {
        unreadable.push(change.id);
        continue;
      };
      let synced: SyncedCard = serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
      // Та сама картка, збережена на двох комп'ютерах окремо, — один запис, з сервера.
      if let Some(index) = vault.find(&synced.card.number).filter(|index| vault.entries[*index].id != change.id) {
        vault.entries.remove(index);
      }
      let card = synced.card;
      let entry = Entry {
        id: change.id.clone(),
        number: encrypt(&card.number)?,
        last4: last4(&card.number),
        brand: brand_of(&card.number).to_string(),
        holder: card.holder,
        month: card.month,
        year: card.year,
        nickname: card.nickname,
        created: synced.created,
        updated: synced.updated,
        used: synced.used,
      };
      match vault.entries.iter_mut().find(|current| current.id == change.id) {
        Some(current) => *current = entry,
        None => vault.entries.push(entry),
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

  #[test]
  fn accepts_only_card_numbers_with_the_right_check_digit() {
    assert_eq!(card_number("4242 4242 4242 4242").as_deref(), Some("4242424242424242"));
    assert_eq!(card_number("5555-5555-5555-4444").as_deref(), Some("5555555555554444"));
    assert_eq!(card_number("4242 4242 4242 4241"), None);
    assert_eq!(card_number("4242"), None);
    assert_eq!(card_number("4242 4242 4242 424x"), None);
  }

  #[test]
  fn knows_the_payment_system() {
    assert_eq!(brand_of("4242424242424242"), "visa");
    assert_eq!(brand_of("5555555555554444"), "mastercard");
    assert_eq!(brand_of("2223003122003222"), "mastercard");
    assert_eq!(brand_of("378282246310005"), "amex");
    assert_eq!(brand_of("9804000000000000"), "prostir");
    assert_eq!(brand_of("6011111111111117"), "discover");
    assert_eq!(brand_of("1234567890123"), "card");
  }

  #[test]
  fn reads_the_card_from_the_form() {
    let values = json!({ "number": "4242 4242 4242 4242", "holder": "  IVAN   PETRENKO ", "month": "7", "year": "28" });
    let card = Card::from_form(values.as_object().expect("object")).expect("card");
    assert_eq!((card.holder.as_str(), card.month, card.year), ("IVAN PETRENKO", 7, 2028));
    assert!(Card::from_form(json!({ "number": "1111 2222" }).as_object().expect("object")).is_none());
    // Сам місяць без року — термін невідомий.
    let partial =
      Card::from_form(json!({ "number": "4242424242424242", "month": "7" }).as_object().expect("object")).expect("card");
    assert_eq!((partial.month, partial.year), (0, 0));
  }

  #[test]
  fn fills_only_the_fields_of_the_form_and_never_the_security_code() {
    let entry = Entry {
      id: "a".into(),
      number: String::new(),
      last4: "4242".into(),
      brand: "visa".into(),
      holder: "IVAN PETRENKO".into(),
      month: 7,
      year: 2028,
      nickname: String::new(),
      created: 0,
      updated: 0,
      used: None,
    };
    let kinds: Vec<String> = ["cc-number", "cc-exp", "cc-csc"].map(String::from).to_vec();
    let values = fill_values(&kinds, "4242424242424242", &entry);
    assert_eq!(Value::Object(values), json!({ "cc-number": "4242424242424242", "cc-exp": "07/2028" }));
  }

  #[test]
  fn keeps_numbers_encrypted_and_finds_saved_cards() {
    let mut vault = Vault::default();
    let card = Card { number: "4242424242424242".into(), holder: "IVAN".into(), month: 7, year: 2028, nickname: String::new() };
    vault.add(card.clone()).expect("add");
    assert!(!vault.entries[0].number.contains("4242"));
    assert_eq!(vault.find("4242424242424242"), Some(0));
    assert_eq!(vault.find("5555555555554444"), None);
    assert!(card.matches(&vault.entries[0]));
    assert!(!Card { month: 8, ..card }.matches(&vault.entries[0]));
  }
}
