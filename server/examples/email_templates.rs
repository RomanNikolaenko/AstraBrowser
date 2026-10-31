//! Листи Astra Browser: `cargo run --manifest-path server/Cargo.toml --example email_templates` пише в supabase/templates/
//! усі листи, README.md (який лист куди підключати, теми й змінні) і preview.html — кожен лист обома мовами у світлій
//! і темній темі поруч.
//!
//! Кожен лист — один файл у двох темах: світла — звичайна, темна — коли в поштовій програмі отримувача темна тема
//! (`prefers-color-scheme`, а для Outlook.com — його атрибути data-ogsc/data-ogsb). Програми без підтримки тем
//! показують світлу.
//!
//! І двома мовами: українською й англійською. Мова — з облікового запису (`user_metadata.language`, її записує
//! застосунок, server/src/auth.rs). У файлі обидві версії під умовою Go-шаблону: Supabase надсилає ту, що збігається
//! з мовою, а без мови (давні облікові записи) — українську. Тема (Subject) — так само, її теж дає README.md.
//!
//! Змінні — як у Supabase (Go-шаблони): `{{ .Token }}` — код, `{{ .Email }}` — пошта… Частину листів надсилає сам
//! Supabase (його шаблони Authentication → Emails), решту — наш сервер, функція supabase/functions/notify: генератор
//! пише для неї templates.ts з обома мовами, а вона вибирає мову й підставляє змінні в тому самому вигляді. Скрізь
//! код, а не посилання: браузер просить ввести код, сайту з посиланнями в нього немає.
//! Ім'я з реєстрації — лише в листі, який надсилають уже після підтвердження пошти (зареєструватися на чужу пошту
//! може будь-хто, тож у лист до чужої людини не має потрапити текст, який він написав).
//!
//! Верстка — таблицями з inline-стилями, як того вимагають поштові програми.
//!
//! Логотип — та сама зірка, що в застосунку (server/icons/128x128.png). Поштові програми показують лише картинки з
//! публічної адреси, тож генератор кладе logo.png поруч із листами, а в листах — його адреса в Supabase Storage
//! (`LOGO_URL`): туди logo.png треба завантажити один раз. У preview.html логотип вбудовано, він видно й без цього.

use std::{fs, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine};

/// Куди записати листи — відносно теки server.
const OUTPUT: &str = "../supabase/templates";
/// Листи нашого сервера для функції notify — відносно теки server.
const SERVER_TEMPLATES: &str = "../supabase/functions/notify/templates.ts";

/// Логотип застосунку (відносно теки server) і де його беруть листи: публічний бакет `email` у Supabase Storage.
const LOGO_SOURCE: &str = "icons/128x128.png";
const LOGO_URL: &str = "https://flhmxwjermtajpdbqgut.supabase.co/storage/v1/object/public/email/logo.png";

const FONT: &str = "'Segoe UI',Arial,Helvetica,sans-serif";
const MONO: &str = "Consolas,'Courier New',monospace";

/// Умова Go-шаблону Supabase: мова облікового запису — англійська. `.Data` — user_metadata; `and` не чіпає
/// `.Data.language`, якщо даних немає, а `printf` дає рядок і тоді, коли мови в них немає (давні облікові записи).
const ENGLISH_CONDITION: &str = r#"and .Data (eq (printf "%v" .Data.language) "en")"#;

/// Кольори теми листа.
struct Palette {
  page: &'static str,
  card: &'static str,
  border: &'static str,
  heading: &'static str,
  text: &'static str,
  muted: &'static str,
  footer: &'static str,
  footer_text: &'static str,
  box_bg: &'static str,
  box_text: &'static str,
  code_bg: &'static str,
  code_border: &'static str,
  code_text: &'static str,
  danger_bg: &'static str,
  danger_border: &'static str,
  danger_text: &'static str,
  check: &'static str,
}

const LIGHT: Palette = Palette {
  page: "#EEF4FF",
  card: "#FFFFFF",
  border: "#E3E8F5",
  heading: "#101954",
  text: "#4F5A86",
  muted: "#6F7AA8",
  footer: "#FBFCFF",
  footer_text: "#8A93B5",
  box_bg: "#F4F6FF",
  box_text: "#1A235F",
  code_bg: "#EEF2FF",
  code_border: "#DCE3FF",
  code_text: "#2638B7",
  danger_bg: "#FFF1F2",
  danger_border: "#FECDD3",
  danger_text: "#9F1239",
  check: "#4F5AF7",
};

const DARK: Palette = Palette {
  page: "#0B1020",
  card: "#141B33",
  border: "#28324F",
  heading: "#F2F5FF",
  text: "#B7C0E0",
  muted: "#8E98BF",
  footer: "#10162B",
  footer_text: "#7C86AD",
  box_bg: "#1B2343",
  box_text: "#E6EBFF",
  code_bg: "#1C2552",
  code_border: "#36438F",
  code_text: "#B4C3FF",
  danger_bg: "#2A1420",
  danger_border: "#5B2236",
  danger_text: "#FDA4AF",
  check: "#8EA2FF",
};

/// Класи елементів, що змінюють колір із темою, і їхні кольори в палітрі.
fn theme_rules(palette: &Palette) -> Vec<(&'static str, String)> {
  vec![
    ("t-page", format!("background-color:{}", palette.page)),
    ("t-card", format!("background-color:{};border-color:{}", palette.card, palette.border)),
    ("t-line", format!("border-color:{}", palette.border)),
    ("t-heading", format!("color:{}", palette.heading)),
    ("t-text", format!("color:{}", palette.text)),
    ("t-muted", format!("color:{}", palette.muted)),
    ("t-footer", format!("background-color:{};color:{};border-color:{}", palette.footer, palette.footer_text, palette.border)),
    ("t-box", format!("background-color:{};color:{}", palette.box_bg, palette.box_text)),
    ("t-strong", format!("color:{}", palette.box_text)),
    ("t-code", format!("background-color:{};border-color:{};color:{}", palette.code_bg, palette.code_border, palette.code_text)),
    (
      "t-danger",
      format!("background-color:{};border-color:{};color:{}", palette.danger_bg, palette.danger_border, palette.danger_text),
    ),
    ("t-check", format!("color:{}", palette.check)),
  ]
}

/// CSS темної теми: правила класів із `!important` (сильніші за inline-стилі), кожне з префіксом `prefix`.
fn dark_css(prefix: &str) -> String {
  theme_rules(&DARK)
    .iter()
    .map(|(class, properties)| {
      let important: Vec<String> = properties.split(';').map(|property| format!("{property} !important")).collect();
      format!("{prefix}.{class}{{{}}}", important.join(";"))
    })
    .collect::<Vec<_>>()
    .join("\n      ")
}

/// Замінює `%назва%` у шаблоні значеннями.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
  values.iter().fold(template.to_string(), |html, (name, value)| html.replace(&format!("%{name}%"), value))
}

fn paragraph(text: &str) -> String {
  format!(r#"<p style="margin:0 0 16px 0;">{text}</p>"#)
}

/// Код із листа — великими цифрами, які легко скопіювати.
fn code_box() -> String {
  fill(
    r##"<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:4px auto 20px auto;">
                <tr>
                  <td align="center" class="t-code" bgcolor="%bg%" style="padding:18px 28px;border-radius:16px;background-color:%bg%;border:1px solid %border%;font-family:%mono%;font-size:34px;line-height:40px;font-weight:700;letter-spacing:8px;white-space:nowrap;color:%color%;">{{ .Token }}</td>
                </tr>
              </table>"##,
    &[("bg", LIGHT.code_bg), ("border", LIGHT.code_border), ("color", LIGHT.code_text), ("mono", MONO)],
  )
}

/// Виділений рядок — пошта облікового запису.
fn highlight(text: &str) -> String {
  fill(
    r##"<p class="t-box" style="margin:0 0 16px 0;padding:14px 16px;background-color:%bg%;border-radius:12px;color:%color%;font-weight:700;word-break:break-all;">%text%</p>"##,
    &[("bg", LIGHT.box_bg), ("color", LIGHT.box_text), ("text", text)],
  )
}

/// Подробиці: «назва — значення» в рамці.
fn details(rows: &[(&str, &str)]) -> String {
  let rows: String = rows
    .iter()
    .map(|(label, value)| {
      fill(
        r##"<tr>
                    <td class="t-muted" valign="top" style="padding:4px 12px 4px 0;color:%muted%;white-space:nowrap;">%label%</td>
                    <td class="t-strong" valign="top" style="padding:4px 0;color:%strong%;font-weight:700;word-break:break-word;">%value%</td>
                  </tr>"##,
        &[("muted", LIGHT.muted), ("strong", LIGHT.box_text), ("label", label), ("value", value)],
      )
    })
    .collect();
  fill(
    r##"<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="t-box" bgcolor="%bg%" style="margin:0 0 18px 0;background-color:%bg%;border-radius:14px;">
                <tr>
                  <td style="padding:12px 18px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;line-height:22px;text-align:left;">
                  %rows%
                    </table>
                  </td>
                </tr>
              </table>"##,
    &[("bg", LIGHT.box_bg), ("rows", &rows)],
  )
}

/// Список переваг із галочками.
fn checklist(items: &[&str]) -> String {
  let rows: String = items
    .iter()
    .map(|item| {
      fill(
        r##"<tr>
                    <td class="t-check" width="26" valign="top" style="padding:5px 0;color:%check%;font-weight:700;">&#10003;</td>
                    <td class="t-strong" valign="top" style="padding:5px 0;color:%strong%;">%item%</td>
                  </tr>"##,
        &[("check", LIGHT.check), ("strong", LIGHT.box_text), ("item", item)],
      )
    })
    .collect();
  fill(
    r##"<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="t-box" bgcolor="%bg%" style="margin:0 0 18px 0;background-color:%bg%;border-radius:16px;">
                <tr>
                  <td style="padding:14px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:15px;line-height:23px;text-align:left;">
                  %rows%
                    </table>
                  </td>
                </tr>
              </table>"##,
    &[("bg", LIGHT.box_bg), ("rows", &rows)],
  )
}

/// Попередження в червоній рамці.
fn danger(text: &str) -> String {
  fill(
    r##"<p class="t-danger" style="margin:0 0 18px 0;padding:14px 16px;background-color:%bg%;border:1px solid %border%;border-radius:12px;color:%color%;font-size:15px;line-height:23px;">%text%</p>"##,
    &[("bg", LIGHT.danger_bg), ("border", LIGHT.danger_border), ("color", LIGHT.danger_text), ("text", text)],
  )
}

/// Мова листа.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Language {
  Uk,
  En,
}

impl Language {
  const ALL: [Language; 2] = [Language::Uk, Language::En];

  /// Як у user_metadata.language і в templates.ts.
  fn code(self) -> &'static str {
    match self {
      Language::Uk => "uk",
      Language::En => "en",
    }
  }

  fn name(self) -> &'static str {
    match self {
      Language::Uk => "Українська",
      Language::En => "English",
    }
  }

  fn footer(self) -> &'static str {
    match self {
      Language::Uk => "Лист надіслано автоматично — відповідати на нього не потрібно.",
      Language::En => "This email was sent automatically — no need to reply.",
    }
  }

  /// Приклади значень змінних для preview.html.
  fn samples(self) -> [(&'static str, &'static str); 8] {
    let (name, date, device, location) = match self {
      Language::Uk => ("Роман", "4 жовтня 2026 р. о 14:05 (за Києвом)", "Astra Browser на Windows (ROMAN-PC)", "Україна"),
      Language::En => ("Roman", "October 4, 2026 at 2:05 PM (Kyiv time)", "Astra Browser on Windows (ROMAN-PC)", "Ukraine"),
    };
    [
      ("{{ .Token }}", "482913"),
      ("{{ .Email }}", "roma@example.com"),
      ("{{ .NewEmail }}", "roma.new@example.com"),
      ("{{ .Name }}", name),
      ("{{ .Date }}", date),
      ("{{ .Device }}", device),
      ("{{ .Location }}", location),
      ("{{ .Ip }}", "93.75.12.34"),
    ]
  }
}

/// Хто надсилає лист.
enum Sender {
  /// Сам Supabase: назва шаблону в Authentication → Emails.
  Supabase(&'static str),
  /// Наш сервер (supabase/functions/notify): вид листа, з яким його просять надіслати, і коли саме.
  Server(&'static str, &'static str),
  /// Лист не надсилається: чому.
  Unused(&'static str),
}

impl Sender {
  fn describe(&self) -> String {
    match self {
      Sender::Supabase(template) => format!("Supabase — шаблон «{template}»"),
      Sender::Server(_, when) => format!("наш сервер — {when}"),
      Sender::Unused(why) => format!("не надсилається — {why}"),
    }
  }
}

/// Тексти листа однією мовою.
struct Content {
  subject: &'static str,
  /// Текст, який поштові програми показують поруч із темою, до відкриття листа.
  preheader: &'static str,
  heading: &'static str,
  body: String,
  /// Дрібний текст під основним.
  note: &'static str,
}

struct Email {
  file: &'static str,
  sender: Sender,
  uk: Content,
  en: Content,
  /// Змінні, які підставляє той, хто надсилає.
  variables: &'static [&'static str],
}

impl Email {
  fn content(&self, language: Language) -> &Content {
    match language {
      Language::Uk => &self.uk,
      Language::En => &self.en,
    }
  }
}

/// Що синхронізується — так, як воно справді є в браузері.
const SYNCED_UK: &str = "закладки, нотатки, історія, профіль і налаштування";
const SYNCED_EN: &str = "bookmarks, notes, history, profile and settings";

fn emails() -> Vec<Email> {
  vec![
    Email {
      file: "01-confirm-signup.html",
      sender: Sender::Supabase("Confirm sign up"),
      uk: Content {
        subject: "Код підтвердження Astra Browser",
        preheader: "Введіть цей код у вікні Astra Browser, щоб завершити реєстрацію.",
        heading: "Підтвердіть свою пошту",
        body: [
          paragraph("Вітаємо! Щоб завершити створення облікового запису Astra Browser, введіть цей код у вікні браузера:"),
          code_box(),
          paragraph("Код діє одну годину."),
        ]
        .concat(),
        note: "Якщо ви не реєструвалися в Astra Browser, просто проігноруйте цей лист — без коду обліковий запис не запрацює.",
      },
      en: Content {
        subject: "Your Astra Browser confirmation code",
        preheader: "Enter this code in the Astra Browser window to finish signing up.",
        heading: "Confirm your email",
        body: [
          paragraph("Welcome! To finish creating your Astra Browser account, enter this code in the browser window:"),
          code_box(),
          paragraph("The code is valid for one hour."),
        ]
        .concat(),
        note: "If you didn’t sign up for Astra Browser, just ignore this email — the account won’t work without the code.",
      },
      variables: &["{{ .Token }}"],
    },
    Email {
      file: "02-welcome.html",
      sender: Sender::Server("welcome", "одразу після того, як пошту підтвердили кодом"),
      uk: Content {
        subject: "Ласкаво просимо до Astra Browser",
        preheader: "Обліковий запис готовий: ваші дані тепер з вами на кожному комп’ютері.",
        heading: "Ваш Astra готовий",
        body: [
          paragraph("Вітаємо, {{ .Name }}! Обліковий запис створено — тепер у нього входять:"),
          checklist(&[
            "Закладки, нотатки й історія — однакові на всіх ваших комп’ютерах",
            "Паролі сайтів — шифруються ще на комп’ютері, сервер їх не бачить",
            "Профіль, тема й налаштування — підтягуються самі",
          ]),
          paragraph("Увійдіть із цією поштою на іншому комп’ютері — і все з’явиться там за хвилину."),
        ]
        .concat(),
        note: "Ваш веб. Ваші дані. Ваш простір.",
      },
      en: Content {
        subject: "Welcome to Astra Browser",
        preheader: "Your account is ready: your data is now with you on every computer.",
        heading: "Your Astra is ready",
        body: [
          paragraph("Welcome, {{ .Name }}! Your account is created — it now includes:"),
          checklist(&[
            "Bookmarks, notes and history — the same on all your computers",
            "Site passwords — encrypted on your computer, the server never sees them",
            "Profile, theme and settings — come along automatically",
          ]),
          paragraph("Sign in with this email on another computer and everything will appear there within a minute."),
        ]
        .concat(),
        note: "Your web. Your data. Your space.",
      },
      variables: &["{{ .Name }}"],
    },
    Email {
      file: "03-reset-password.html",
      sender: Sender::Supabase("Reset password"),
      uk: Content {
        subject: "Відновлення пароля Astra Browser",
        preheader: "Код, щоб задати новий пароль облікового запису Astra Browser.",
        heading: "Відновлення пароля",
        body: [
          paragraph("Ми отримали запит на новий пароль для облікового запису:"),
          highlight("{{ .Email }}"),
          paragraph("Введіть цей код у вікні Astra Browser і задайте новий пароль:"),
          code_box(),
          paragraph("Код діє одну годину."),
        ]
        .concat(),
        note: "Не просили новий пароль? Нічого робити не потрібно: без коду пароль не зміниться. Нікому не повідомляйте цей код.",
      },
      en: Content {
        subject: "Reset your Astra Browser password",
        preheader: "A code to set a new password for your Astra Browser account.",
        heading: "Password reset",
        body: [
          paragraph("We received a request for a new password for this account:"),
          highlight("{{ .Email }}"),
          paragraph("Enter this code in the Astra Browser window and set a new password:"),
          code_box(),
          paragraph("The code is valid for one hour."),
        ]
        .concat(),
        note: "Didn’t ask for a new password? There’s nothing to do: without the code, your password won’t change. Don’t share this code \
               with anyone.",
      },
      variables: &["{{ .Email }}", "{{ .Token }}"],
    },
    Email {
      file: "04-password-changed.html",
      sender: Sender::Supabase("Password changed (Security notifications)"),
      uk: Content {
        subject: "Пароль Astra Browser змінено",
        preheader: "Пароль вашого облікового запису Astra Browser щойно змінили.",
        heading: "Пароль змінено",
        body: [
          paragraph("Пароль облікового запису Astra Browser щойно змінили:"),
          highlight("{{ .Email }}"),
          paragraph(
            "Якщо це були ви — нічого робити не потрібно. Щоб і далі синхронізувати паролі сайтів на інших комп’ютерах, \
             введіть там новий пароль у розділі «Керування профілем → Синхронізація».",
          ),
        ]
        .concat(),
        note: "Якщо пароль змінили не ви, одразу відновіть його: у вікні входу Astra Browser натисніть «Забули пароль?».",
      },
      en: Content {
        subject: "Your Astra Browser password was changed",
        preheader: "The password for your Astra Browser account was just changed.",
        heading: "Password changed",
        body: [
          paragraph("The password for this Astra Browser account was just changed:"),
          highlight("{{ .Email }}"),
          paragraph(
            "If it was you, there’s nothing to do. To keep syncing site passwords on your other computers, enter the new \
             password there in “Manage profile → Sync”.",
          ),
        ]
        .concat(),
        note: "If you didn’t change your password, reset it right away: click “Forgot your password?” in the Astra Browser sign-in \
               window.",
      },
      variables: &["{{ .Email }}"],
    },
    Email {
      file: "05-new-sign-in.html",
      sender: Sender::Server("new-sign-in", "після входу з незнайомого місця (IP) на вже знайомому комп’ютері"),
      uk: Content {
        subject: "Новий вхід в Astra Browser",
        preheader: "У ваш обліковий запис Astra Browser щойно ввійшли.",
        heading: "Новий вхід у ваш обліковий запис",
        body: [
          paragraph("У ваш обліковий запис {{ .Email }} щойно ввійшли:"),
          details(&[("Час", "{{ .Date }}"), ("Пристрій", "{{ .Device }}"), ("Місце", "{{ .Location }}"), ("IP", "{{ .Ip }}")]),
          paragraph("Якщо це були ви — нічого робити не потрібно."),
        ]
        .concat(),
        note: "Не ви? Одразу змініть пароль: в Astra Browser — «Керування профілем → Змінити пароль», а якщо ввійти не \
               вдається — «Забули пароль?» у вікні входу.",
      },
      en: Content {
        subject: "New sign-in to Astra Browser",
        preheader: "Someone just signed in to your Astra Browser account.",
        heading: "New sign-in to your account",
        body: [
          paragraph("Someone just signed in to your account {{ .Email }}:"),
          details(&[("Time", "{{ .Date }}"), ("Device", "{{ .Device }}"), ("Location", "{{ .Location }}"), ("IP", "{{ .Ip }}")]),
          paragraph("If it was you, there’s nothing to do."),
        ]
        .concat(),
        note: "Not you? Change your password right away: in Astra Browser, “Manage profile → Change password”, or, if you can’t \
               sign in, “Forgot your password?” in the sign-in window.",
      },
      variables: &["{{ .Email }}", "{{ .Date }}", "{{ .Device }}", "{{ .Location }}", "{{ .Ip }}"],
    },
    Email {
      file: "06-sign-in-code.html",
      sender: Sender::Unused("входу за кодом без пароля в застосунку поки немає"),
      uk: Content {
        subject: "Ваш код входу в Astra Browser",
        preheader: "Код, щоб увійти в Astra Browser без пароля.",
        heading: "Код для входу",
        body: [paragraph("Введіть цей код у вікні Astra Browser, щоб увійти:"), code_box(), paragraph("Код діє одну годину.")].concat(),
        note: "Нікому не повідомляйте цей код: працівники Astra Browser ніколи його не просять. Не намагалися ввійти? \
               Просто проігноруйте лист.",
      },
      en: Content {
        subject: "Your Astra Browser sign-in code",
        preheader: "A code to sign in to Astra Browser without a password.",
        heading: "Sign-in code",
        body: [
          paragraph("Enter this code in the Astra Browser window to sign in:"),
          code_box(),
          paragraph("The code is valid for one hour."),
        ]
        .concat(),
        note: "Don’t share this code with anyone: Astra Browser staff will never ask for it. Didn’t try to sign in? Just ignore \
               this email.",
      },
      variables: &["{{ .Token }}"],
    },
    Email {
      file: "07-new-device.html",
      sender: Sender::Server("new-device", "після першого входу на комп’ютері, де цей обліковий запис ще не входив"),
      uk: Content {
        subject: "Новий пристрій синхронізується з Astra Browser",
        preheader: "До вашого облікового запису Astra Browser підключився новий пристрій.",
        heading: "Новий пристрій підключено",
        body: [
          paragraph("До облікового запису {{ .Email }} підключився новий пристрій:"),
          details(&[("Пристрій", "{{ .Device }}"), ("Час", "{{ .Date }}")]),
          paragraph(&format!(
            "Тепер на ньому синхронізуються {SYNCED_UK}. Паролі сайтів з’являться там, щойно на ньому введуть пароль облікового \
             запису."
          )),
        ]
        .concat(),
        note: "Не впізнаєте пристрій? Одразу змініть пароль облікового запису: «Керування профілем → Змінити пароль».",
      },
      en: Content {
        subject: "A new device is syncing with Astra Browser",
        preheader: "A new device has connected to your Astra Browser account.",
        heading: "New device connected",
        body: [
          paragraph("A new device has connected to the account {{ .Email }}:"),
          details(&[("Device", "{{ .Device }}"), ("Time", "{{ .Date }}")]),
          paragraph(&format!(
            "It now syncs your {SYNCED_EN}. Site passwords will appear there once the account password is entered on it."
          )),
        ]
        .concat(),
        note: "Don’t recognize the device? Change your account password right away: “Manage profile → Change password”.",
      },
      variables: &["{{ .Email }}", "{{ .Device }}", "{{ .Date }}"],
    },
    Email {
      file: "08-email-change.html",
      sender: Sender::Supabase("Change email address"),
      uk: Content {
        subject: "Підтвердіть зміну пошти Astra Browser",
        preheader: "Код, щоб підтвердити зміну пошти облікового запису Astra Browser.",
        heading: "Зміна пошти",
        body: [
          paragraph("Ви попросили змінити пошту облікового запису Astra Browser:"),
          details(&[("Було", "{{ .Email }}"), ("Стане", "{{ .NewEmail }}")]),
          paragraph("Щоб підтвердити зміну, введіть цей код у вікні Astra Browser:"),
          code_box(),
          paragraph("Код діє одну годину."),
        ]
        .concat(),
        note: "Не ви? Не вводьте код — пошта лишиться попередньою. І про всяк випадок змініть пароль облікового запису.",
      },
      en: Content {
        subject: "Confirm your Astra Browser email change",
        preheader: "A code to confirm the email change for your Astra Browser account.",
        heading: "Email change",
        body: [
          paragraph("You asked to change the email for your Astra Browser account:"),
          details(&[("From", "{{ .Email }}"), ("To", "{{ .NewEmail }}")]),
          paragraph("To confirm the change, enter this code in the Astra Browser window:"),
          code_box(),
          paragraph("The code is valid for one hour."),
        ]
        .concat(),
        note: "Not you? Don’t enter the code — your email will stay the same. And change your account password just in case.",
      },
      variables: &["{{ .Email }}", "{{ .NewEmail }}", "{{ .Token }}"],
    },
    Email {
      file: "09-delete-account.html",
      sender: Sender::Unused("видалення облікового запису підтверджується паролем (supabase/account.sql)"),
      uk: Content {
        subject: "Підтвердіть видалення облікового запису Astra Browser",
        preheader: "Код, щоб остаточно видалити обліковий запис Astra Browser.",
        heading: "Ви впевнені?",
        body: [
          paragraph("Ви попросили видалити обліковий запис {{ .Email }}."),
          danger(&format!(
            "Разом із ним із сервера назавжди зникнуть усі синхронізовані дані: {SYNCED_UK}, а також паролі сайтів. \
             Повернути їх буде неможливо."
          )),
          paragraph("Щоб підтвердити видалення, введіть цей код у вікні Astra Browser:"),
          code_box(),
          paragraph("Код діє одну годину."),
        ]
        .concat(),
        note: "Передумали чи це не ви? Просто не вводьте код — обліковий запис лишиться. Якщо запит надіслали не ви, \
               змініть пароль.",
      },
      en: Content {
        subject: "Confirm deleting your Astra Browser account",
        preheader: "A code to permanently delete your Astra Browser account.",
        heading: "Are you sure?",
        body: [
          paragraph("You asked to delete the account {{ .Email }}."),
          danger(&format!(
            "All synced data will be permanently removed from the server with it: your {SYNCED_EN}, as well as site passwords. \
             It can’t be restored."
          )),
          paragraph("To confirm the deletion, enter this code in the Astra Browser window:"),
          code_box(),
          paragraph("The code is valid for one hour."),
        ]
        .concat(),
        note: "Changed your mind, or it wasn’t you? Just don’t enter the code — the account will stay. If you didn’t send the \
               request, change your password.",
      },
      variables: &["{{ .Email }}", "{{ .Token }}"],
    },
    Email {
      file: "10-account-deleted.html",
      sender: Sender::Server("account-deleted", "одразу після видалення облікового запису"),
      uk: Content {
        subject: "Обліковий запис Astra Browser видалено",
        preheader: "Ваш обліковий запис Astra Browser і його дані видалено.",
        heading: "Обліковий запис видалено",
        body: [
          paragraph("Обліковий запис Astra Browser видалено разом з усіма синхронізованими даними:"),
          highlight("{{ .Email }}"),
          paragraph("Дякуємо, що були з Astra Browser. Повернутися можна будь-коли — просто зареєструйтеся знову з цією поштою."),
        ]
        .concat(),
        note: "Видалення підтвердили паролем облікового запису.",
      },
      en: Content {
        subject: "Your Astra Browser account was deleted",
        preheader: "Your Astra Browser account and its data have been deleted.",
        heading: "Account deleted",
        body: [
          paragraph("The Astra Browser account has been deleted along with all synced data:"),
          highlight("{{ .Email }}"),
          paragraph("Thank you for using Astra Browser. You can come back any time — just sign up again with this email."),
        ]
        .concat(),
        note: "The deletion was confirmed with the account password.",
      },
      variables: &["{{ .Email }}"],
    },
    Email {
      file: "11-reauthentication.html",
      sender: Sender::Supabase("Reauthentication"),
      uk: Content {
        subject: "Підтвердіть дію в Astra Browser",
        preheader: "Код, щоб підтвердити важливу дію з обліковим записом Astra Browser.",
        heading: "Підтвердіть, що це ви",
        body: [
          paragraph(
            "Щоб підтвердити важливу дію з обліковим записом Astra Browser — наприклад, зміну пароля, — введіть цей код у \
             вікні браузера:",
          ),
          code_box(),
          paragraph("Код діє недовго — використайте його одразу."),
        ]
        .concat(),
        note: "Нічого не робили в Astra Browser? Не повідомляйте нікому цей код і змініть пароль облікового запису.",
      },
      en: Content {
        subject: "Confirm an action in Astra Browser",
        preheader: "A code to confirm an important action with your Astra Browser account.",
        heading: "Confirm it’s you",
        body: [
          paragraph(
            "To confirm an important action with your Astra Browser account — such as changing your password — enter this code \
             in the browser window:",
          ),
          code_box(),
          paragraph("The code is valid for a short time — use it right away."),
        ]
        .concat(),
        note: "Didn’t do anything in Astra Browser? Don’t share this code with anyone and change your account password.",
      },
      variables: &["{{ .Token }}"],
    },
  ]
}

/// Як показати тему.
#[derive(Clone, Copy)]
enum Theme {
  /// Як у поштовій програмі отримувача: світла, а темна — якщо там темна тема. Так лист і надсилається.
  Auto,
  /// Лише світла — для preview.html.
  Light,
  /// Лише темна — для preview.html.
  Dark,
}

/// Лист однією мовою повністю: шапка з логотипом, заголовок, вміст, примітка, підвал.
fn render(email: &Email, language: Language, theme: Theme) -> String {
  const LAYOUT: &str = r##"<!doctype html>
<!-- Надсилає %sender% · Тема листа (Subject): %subject% -->
<html lang="%lang%">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="%scheme%">
  <meta name="supported-color-schemes" content="%scheme%">
  <title>%subject%</title>
  <style>
    :root { color-scheme: %scheme%; supported-color-schemes: %scheme%; }
    %dark%
  </style>
</head>
<body class="t-page" style="margin:0;padding:0;background-color:%page%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">%preheader%</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="t-page" bgcolor="%page%" style="width:100%;background-color:%page%;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="t-card" bgcolor="%card%" style="width:100%;max-width:600px;background-color:%card%;border-radius:24px;border:1px solid %border%;">
          <tr>
            <td class="t-line" style="padding:24px 32px;border-bottom:1px solid %border%;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="40" valign="middle" style="width:40px;"><img src="%logo%" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;"></td>
                  <td class="t-heading" style="padding-left:10px;font-family:%font%;font-size:20px;line-height:24px;color:%heading%;"><strong>Astra</strong> Browser</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px 8px 32px;text-align:center;">
              <h1 class="t-heading" style="margin:0;color:%heading%;font-family:%font%;font-size:28px;line-height:36px;font-weight:800;">%title%</h1>
            </td>
          </tr>
          <tr>
            <td class="t-text" style="padding:16px 32px 8px 32px;color:%text%;font-family:%font%;font-size:16px;line-height:26px;text-align:center;">
              %body%
            </td>
          </tr>
          <tr>
            <td class="t-muted" style="padding:0 32px 28px 32px;color:%muted%;font-family:%font%;font-size:13px;line-height:20px;text-align:center;">%note%</td>
          </tr>
          <tr>
            <td class="t-footer" bgcolor="%footer%" style="padding:20px 32px 24px 32px;border-top:1px solid %border%;background-color:%footer%;border-radius:0 0 24px 24px;text-align:center;font-family:%font%;font-size:12px;line-height:19px;color:%footer_text%;">
              %footer_note%<br>
              &copy; Astra Browser
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"##;
  let content = email.content(language);
  let (scheme, dark) = match theme {
    Theme::Auto => (
      "light dark",
      format!(
        "@media (prefers-color-scheme: dark) {{\n      {}\n    }}\n    /* Outlook.com у темній темі */\n    {}\n    {}",
        dark_css(""),
        dark_css("[data-ogsc] "),
        dark_css("[data-ogsb] ")
      ),
    ),
    Theme::Light => ("light", String::new()),
    Theme::Dark => ("dark", dark_css("")),
  };
  // Вміст — першим: позначки оформлення в ньому підставляться разом з рештою листа.
  fill(
    LAYOUT,
    &[
      ("body", &content.body),
      ("note", content.note),
      ("title", content.heading),
      ("preheader", content.preheader),
      ("subject", content.subject),
      ("sender", &email.sender.describe()),
      ("lang", language.code()),
      ("footer_note", language.footer()),
      ("scheme", scheme),
      ("dark", &dark),
      ("logo", LOGO_URL),
      ("font", FONT),
      ("page", LIGHT.page),
      ("card", LIGHT.card),
      ("border", LIGHT.border),
      ("heading", LIGHT.heading),
      ("text", LIGHT.text),
      ("muted", LIGHT.muted),
      ("footer_text", LIGHT.footer_text),
      ("footer", LIGHT.footer),
    ],
  )
}

/// Файл листа для Supabase: обидві мови під умовою — Supabase лишить ту, що збігається з мовою облікового запису.
fn bilingual(email: &Email) -> String {
  format!(
    "{{{{ if {ENGLISH_CONDITION} }}}}{}{{{{ else }}}}{}{{{{ end }}}}\n",
    render(email, Language::En, Theme::Auto),
    render(email, Language::Uk, Theme::Auto)
  )
}

/// Тема для поля Subject у Supabase — так само під умовою.
fn bilingual_subject(email: &Email) -> String {
  format!("{{{{ if {ENGLISH_CONDITION} }}}}{}{{{{ else }}}}{}{{{{ end }}}}", email.en.subject, email.uk.subject)
}

/// Лист для перегляду: приклади замість змінних, логотип вбудовано (`logo` — data: URL).
fn with_samples(html: &str, logo: &str, language: Language) -> String {
  language.samples().iter().fold(html.replace(LOGO_URL, logo), |html, (variable, sample)| html.replace(variable, sample))
}

fn escape_attribute(text: &str) -> String {
  text.replace('&', "&amp;").replace('"', "&quot;")
}

/// templates.ts для функції notify: листи нашого сервера за видом і мовою — тема й HTML.
fn server_templates(emails: &[Email]) -> String {
  let entries: String = emails
    .iter()
    .filter_map(|email| match email.sender {
      Sender::Server(kind, _) => {
        let languages: String = Language::ALL
          .iter()
          .map(|&language| {
            format!(
              "    {}: {{\n      subject: {},\n      html: {},\n    }},\n",
              language.code(),
              serde_json::to_string(email.content(language).subject).expect("рядок"),
              serde_json::to_string(&render(email, language, Theme::Auto)).expect("рядок"),
            )
          })
          .collect();
        Some(format!("  {}: {{\n{languages}  }},\n", serde_json::to_string(kind).expect("рядок")))
      }
      _ => None,
    })
    .collect();
  format!(
    "// Згенеровано server/examples/email_templates.rs — правте генератор, а не цей файл.\n\n\
     export const TEMPLATES = {{\n{entries}}} as const;\n\n\
     export type Template = keyof typeof TEMPLATES;\n\
     export type Language = \"uk\" | \"en\";\n"
  )
}

/// Сторінка, де кожен лист — обома мовами, у світлій і темній темі.
fn preview(emails: &[Email], logo: &str) -> String {
  let sections: String = emails
    .iter()
    .map(|email| {
      let frames: String = Language::ALL
        .iter()
        .flat_map(|&language| [(language, Theme::Light, "світла тема"), (language, Theme::Dark, "темна тема")])
        .map(|(language, theme, theme_name)| {
          let label = format!("{} · {theme_name}", language.name());
          format!(
            r#"<figure><figcaption>{label}</figcaption><iframe title="{label}" srcdoc="{}" onload="this.style.height=this.contentDocument.documentElement.scrollHeight+'px'"></iframe></figure>"#,
            escape_attribute(&with_samples(&render(email, language, theme), logo, language))
          )
        })
        .collect();
      format!(
        "  <section><h2>{} — {} / {}</h2><p>Надсилає {}</p><div class=\"pair\">{frames}</div></section>\n",
        email.file,
        email.uk.subject,
        email.en.subject,
        email.sender.describe(),
      )
    })
    .collect();
  format!(
    r#"<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <title>Листи Astra Browser</title>
  <style>
    body {{ margin: 0; padding: 24px; font-family: 'Segoe UI', Arial, sans-serif; background: #D9DEE8; color: #111827; }}
    h1 {{ margin: 0 0 24px; }}
    h2 {{ margin: 0 0 4px; font-size: 18px; }}
    p {{ margin: 0 0 12px; color: #4B5563; }}
    section {{ margin-bottom: 48px; }}
    .pair {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; }}
    figure {{ margin: 0; }}
    figcaption {{ margin-bottom: 6px; font-size: 13px; color: #4B5563; }}
    iframe {{ width: 100%; height: 900px; border: 0; border-radius: 12px; }}
  </style>
</head>
<body>
  <h1>Листи Astra Browser — українською й англійською, у світлій і темній темі</h1>
{sections}</body>
</html>
"#
  )
}

/// README: який лист хто надсилає, теми й змінні, а для Supabase — що вставити в Subject.
fn readme(emails: &[Email]) -> String {
  let rows: String = emails
    .iter()
    .map(|email| {
      let variables: Vec<String> = email.variables.iter().map(|variable| format!("`{variable}`")).collect();
      format!(
        "| [{0}]({0}) | {1} | {2}<br>{3} | {4} |\n",
        email.file,
        email.sender.describe(),
        email.uk.subject,
        email.en.subject,
        variables.join(", ")
      )
    })
    .collect();
  let subjects: String = emails
    .iter()
    .filter_map(|email| match email.sender {
      Sender::Supabase(template) => {
        Some(format!("**{template}** ([{0}]({0})):\n\n```\n{1}\n```\n\n", email.file, bilingual_subject(email)))
      }
      _ => None,
    })
    .collect();
  format!(
    "# Листи Astra Browser\n\n\
     Згенеровано `cargo run --manifest-path server/Cargo.toml --example email_templates` — правте генератор \
     (server/examples/email_templates.rs), а не ці файли. Кожен лист — українською й англійською, у двох темах: світла, \
     а темна — коли в поштовій програмі отримувача темна тема. Як виглядають усі — [preview.html](preview.html).\n\n\
     | Файл | Хто надсилає | Тема (Subject): українською / англійською | Змінні |\n|---|---|---|---|\n{rows}\n\
     ## Мова\n\n\
     Мова листа — з облікового запису: `user_metadata.language` (`uk` чи `en`). Її записує застосунок \
     (server/src/auth.rs) — під час реєстрації й щоразу, коли змінюють мову інтерфейсу. У файлах для Supabase обидві \
     версії під умовою `{{{{ if {ENGLISH_CONDITION} }}}}`: Supabase надсилає англійську лише тим, у кого мова `en`, \
     решті (і давнім обліковим записам без мови) — українську. Функція notify вибирає мову сама \
     (мова з запиту застосунку, інакше з облікового запису).\n\n\
     ## Як підключати\n\n\
     - **Supabase**: Authentication → Emails → шаблон із таблиці: увесь файл — у Body (разом з умовою на початку), \
     а в Subject — тема з умовою нижче. «Password changed» спершу ввімкнути в Security notifications.\n\
     - **Наш сервер** — Edge Function [notify](../functions/notify/index.ts), як розгорнути — у її \
     [README](../functions/notify/README.md). Бере ці листи з templates.ts, підставляє змінні в тому самому вигляді \
     (`{{{{ .Email }}}}` тощо), а кожне значення спершу HTML-екранує. `{{{{ .Name }}}}` — ім'я з облікового запису; якщо його немає — частина пошти до @.\n\
     - «Код діє одну годину» — типовий термін коду в Supabase (Email OTP Expiration = 3600 с). Змінили термін — поправте \
     тексти в генераторі.\n\n\
     ## Теми для Supabase (Subject)\n\n{subjects}\
     ## Логотип\n\n\
     Листи беруть логотип за адресою {LOGO_URL}. Один раз: Supabase → Storage → New bucket `email` (Public bucket) → \
     завантажити туди [logo.png](logo.png). Поки його там немає, у листах поруч із назвою Astra Browser просто не буде \
     зірки. Інша адреса — змініть `LOGO_URL` у генераторі.\n"
  )
}

fn main() -> std::io::Result<()> {
  let output = Path::new(env!("CARGO_MANIFEST_DIR")).join(OUTPUT);
  fs::create_dir_all(&output)?;
  let emails = emails();
  for email in &emails {
    fs::write(output.join(email.file), bilingual(email))?;
    println!("{} — {} / {}", email.file, email.uk.subject, email.en.subject);
  }
  let logo = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(LOGO_SOURCE))?;
  fs::write(output.join("logo.png"), &logo)?;
  let logo = format!("data:image/png;base64,{}", STANDARD.encode(&logo));
  fs::write(output.join("preview.html"), preview(&emails, &logo))?;
  fs::write(output.join("README.md"), readme(&emails))?;
  println!("logo.png, preview.html, README.md");
  let server = Path::new(env!("CARGO_MANIFEST_DIR")).join(SERVER_TEMPLATES);
  if let Some(parent) = server.parent() {
    fs::create_dir_all(parent)?;
  }
  fs::write(&server, server_templates(&emails))?;
  println!("{SERVER_TEMPLATES}");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Змінні, які Supabase підставляє в шаблони, що нам потрібні.
  const SUPABASE_VARIABLES: [&str; 3] = ["{{ .Token }}", "{{ .Email }}", "{{ .NewEmail }}"];
  /// Змінні, які підставляє функція notify (supabase/functions/notify/index.ts).
  const SERVER_VARIABLES: [&str; 6] =
    ["{{ .Email }}", "{{ .Name }}", "{{ .Date }}", "{{ .Device }}", "{{ .Location }}", "{{ .Ip }}"];

  /// Усі `{{ … }}` у тексті.
  fn variables_in(html: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("{{") {
      let end = rest[start..].find("}}").expect("незакрита змінна") + start + 2;
      found.push(&rest[start..end]);
      rest = &rest[end..];
    }
    found
  }

  #[test]
  fn every_email_uses_exactly_its_variables_in_both_languages() {
    for email in emails() {
      for language in Language::ALL {
        let html = render(&email, language, Theme::Auto);
        let used = variables_in(&html);
        for variable in &used {
          assert!(email.variables.contains(variable), "{} ({language:?}): незаявлена змінна {variable}", email.file);
        }
        for variable in email.variables {
          assert!(used.contains(variable), "{} ({language:?}): змінна {variable} не використана", email.file);
        }
      }
      if matches!(email.sender, Sender::Supabase(_)) {
        for variable in email.variables {
          assert!(SUPABASE_VARIABLES.contains(variable), "{}: Supabase не знає {variable}", email.file);
        }
      }
      if matches!(email.sender, Sender::Server(..)) {
        for variable in email.variables {
          assert!(SERVER_VARIABLES.contains(variable), "{}: функція notify не знає {variable}", email.file);
        }
      }
    }
  }

  #[test]
  fn there_are_eleven_emails_and_each_has_both_themes() {
    let emails = emails();
    assert_eq!(emails.len(), 11);
    for email in &emails {
      for language in Language::ALL {
        let auto = render(email, language, Theme::Auto);
        assert!(auto.contains("@media (prefers-color-scheme: dark)"), "{}: немає темної теми", email.file);
        assert!(auto.contains(".t-card{background-color:#141B33 !important"), "{}: темна картка", email.file);
        // Жодної незаповненої позначки оформлення.
        for marker in ["%body%", "%page%", "%font%", "%bg%", "%color%", "%rows%", "%lang%", "%footer_note%"] {
          assert!(!auto.contains(marker), "{}: лишилося {marker}", email.file);
        }
        assert!(!render(email, language, Theme::Light).contains("!important"));
      }
    }
  }

  #[test]
  fn files_for_supabase_pick_the_language_of_the_account() {
    for email in emails() {
      let file = bilingual(&email);
      let english = format!("{{{{ if {ENGLISH_CONDITION} }}}}");
      assert!(file.starts_with(&english), "{}: без умови мови", email.file);
      assert!(file.trim_end().ends_with("{{ end }}"), "{}", email.file);
      let (en, uk) = file[english.len()..].split_once("{{ else }}").expect("обидві мови");
      assert!(en.contains(r#"<html lang="en">"#) && en.contains(email.en.heading), "{}: англійська версія", email.file);
      assert!(uk.contains(r#"<html lang="uk">"#) && uk.contains(email.uk.heading), "{}: українська версія", email.file);
      let subject = bilingual_subject(&email);
      assert!(subject.contains(email.en.subject) && subject.contains(email.uk.subject), "{}: тема", email.file);
    }
  }

  #[test]
  fn server_templates_have_both_languages_of_each_kind() {
    let source = server_templates(&emails());
    for kind in ["welcome", "new-sign-in", "new-device", "account-deleted"] {
      let start = source.find(&format!("\"{kind}\": {{")).unwrap_or_else(|| panic!("немає {kind}"));
      let entry = &source[start..];
      let entry = &entry[..entry.find("\n  },").expect("кінець")];
      assert!(entry.contains("    uk: {") && entry.contains("    en: {"), "{kind}: не обидві мови");
    }
    // Шаблони Supabase у функцію не потрапляють.
    assert!(!source.contains("Confirm your email"));
  }

  #[test]
  fn previews_show_samples_instead_of_variables() {
    let html = preview(&emails(), "data:image/png;base64,AAAA");
    assert!(!html.contains("{{"));
    assert!(html.contains("482913") && html.contains("Kyiv time") && html.contains("за Києвом"));
    assert!(!html.contains(LOGO_URL) && html.contains("data:image/png;base64,AAAA"));
  }

  #[test]
  fn emails_show_the_app_logo_from_its_public_address() {
    for email in emails() {
      for language in Language::ALL {
        assert!(
          render(&email, language, Theme::Auto).contains(&format!(r#"<img src="{LOGO_URL}""#)),
          "{}: немає логотипа",
          email.file
        );
      }
    }
    assert!(Path::new(env!("CARGO_MANIFEST_DIR")).join(LOGO_SOURCE).exists());
  }
}
