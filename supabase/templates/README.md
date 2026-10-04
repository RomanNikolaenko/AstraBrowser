# Листи Astra Browser

Згенеровано `cargo run --manifest-path server/Cargo.toml --example email_templates` — правте генератор (server/examples/email_templates.rs), а не ці файли. Кожен лист — у двох темах: світла, а темна — коли в поштовій програмі отримувача темна тема. Як виглядають обидві — [preview.html](preview.html).

| Файл | Хто надсилає | Тема (Subject) | Змінні |
|---|---|---|---|
| [01-confirm-signup.html](01-confirm-signup.html) | Supabase — шаблон «Confirm sign up» | Код підтвердження Astra Browser | `{{ .Token }}` |
| [02-welcome.html](02-welcome.html) | наш сервер — одразу після того, як пошту підтвердили кодом | Ласкаво просимо до Astra Browser | `{{ .Name }}` |
| [03-reset-password.html](03-reset-password.html) | Supabase — шаблон «Reset password» | Відновлення пароля Astra Browser | `{{ .Email }}`, `{{ .Token }}` |
| [04-password-changed.html](04-password-changed.html) | Supabase — шаблон «Password changed (Security notifications)» | Пароль Astra Browser змінено | `{{ .Email }}` |
| [05-new-sign-in.html](05-new-sign-in.html) | наш сервер — після кожного входу з нового пристрою чи місця | Новий вхід в Astra Browser | `{{ .Email }}`, `{{ .Date }}`, `{{ .Device }}`, `{{ .Location }}`, `{{ .Ip }}` |
| [06-sign-in-code.html](06-sign-in-code.html) | Supabase — шаблон «Magic link or OTP» | Ваш код входу в Astra Browser | `{{ .Token }}` |
| [07-new-device.html](07-new-device.html) | наш сервер — коли новий пристрій уперше синхронізується | Новий пристрій синхронізується з Astra Browser | `{{ .Email }}`, `{{ .Device }}`, `{{ .Date }}` |
| [08-email-change.html](08-email-change.html) | Supabase — шаблон «Change email address» | Підтвердіть зміну пошти Astra Browser | `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .Token }}` |
| [09-delete-account.html](09-delete-account.html) | не надсилається — видалення облікового запису підтверджується паролем (supabase/account.sql) | Підтвердіть видалення облікового запису Astra Browser | `{{ .Email }}`, `{{ .Token }}` |
| [10-account-deleted.html](10-account-deleted.html) | наш сервер — одразу після видалення облікового запису | Обліковий запис Astra Browser видалено | `{{ .Email }}` |
| [11-reauthentication.html](11-reauthentication.html) | Supabase — шаблон «Reauthentication» | Підтвердіть дію в Astra Browser | `{{ .Token }}` |

## Як підключати

- **Supabase**: Authentication → Emails → шаблон із таблиці: тему — у Subject, увесь файл — у Body. «Password changed» спершу ввімкнути в Security notifications.
- **Наш сервер** (ще не зроблений): підставляє змінні в тому самому вигляді (`{{ .Email }}` тощо), а кожне значення спершу HTML-екранує. `{{ .Name }}` — ім'я з облікового запису; якщо його немає — частина пошти до @.
- «Код діє одну годину» — типовий термін коду в Supabase (Email OTP Expiration = 3600 с). Змінили термін — поправте тексти в генераторі.

## Логотип

Листи беруть логотип за адресою https://flhmxwjermtajpdbqgut.supabase.co/storage/v1/object/public/email/logo.png. Один раз: Supabase → Storage → New bucket `email` (Public bucket) → завантажити туди [logo.png](logo.png). Поки його там немає, у листах поруч із назвою Astra Browser просто не буде зірки. Інша адреса — змініть `LOGO_URL` у генераторі.
