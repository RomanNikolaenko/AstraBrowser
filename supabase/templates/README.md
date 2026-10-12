# Листи Astra Browser

Згенеровано `cargo run --manifest-path server/Cargo.toml --example email_templates` — правте генератор (server/examples/email_templates.rs), а не ці файли. Кожен лист — українською й англійською, у двох темах: світла, а темна — коли в поштовій програмі отримувача темна тема. Як виглядають усі — [preview.html](preview.html).

| Файл | Хто надсилає | Тема (Subject): українською / англійською | Змінні |
|---|---|---|---|
| [01-confirm-signup.html](01-confirm-signup.html) | Supabase — шаблон «Confirm sign up» | Код підтвердження Astra Browser<br>Your Astra Browser confirmation code | `{{ .Token }}` |
| [02-welcome.html](02-welcome.html) | наш сервер — одразу після того, як пошту підтвердили кодом | Ласкаво просимо до Astra Browser<br>Welcome to Astra Browser | `{{ .Name }}` |
| [03-reset-password.html](03-reset-password.html) | Supabase — шаблон «Reset password» | Відновлення пароля Astra Browser<br>Reset your Astra Browser password | `{{ .Email }}`, `{{ .Token }}` |
| [04-password-changed.html](04-password-changed.html) | Supabase — шаблон «Password changed (Security notifications)» | Пароль Astra Browser змінено<br>Your Astra Browser password was changed | `{{ .Email }}` |
| [05-new-sign-in.html](05-new-sign-in.html) | наш сервер — після входу з незнайомого місця (IP) на вже знайомому комп’ютері | Новий вхід в Astra Browser<br>New sign-in to Astra Browser | `{{ .Email }}`, `{{ .Date }}`, `{{ .Device }}`, `{{ .Location }}`, `{{ .Ip }}` |
| [06-sign-in-code.html](06-sign-in-code.html) | не надсилається — входу за кодом без пароля в застосунку поки немає | Ваш код входу в Astra Browser<br>Your Astra Browser sign-in code | `{{ .Token }}` |
| [07-new-device.html](07-new-device.html) | наш сервер — після першого входу на комп’ютері, де цей обліковий запис ще не входив | Новий пристрій синхронізується з Astra Browser<br>A new device is syncing with Astra Browser | `{{ .Email }}`, `{{ .Device }}`, `{{ .Date }}` |
| [08-email-change.html](08-email-change.html) | Supabase — шаблон «Change email address» | Підтвердіть зміну пошти Astra Browser<br>Confirm your Astra Browser email change | `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .Token }}` |
| [09-delete-account.html](09-delete-account.html) | не надсилається — видалення облікового запису підтверджується паролем (supabase/account.sql) | Підтвердіть видалення облікового запису Astra Browser<br>Confirm deleting your Astra Browser account | `{{ .Email }}`, `{{ .Token }}` |
| [10-account-deleted.html](10-account-deleted.html) | наш сервер — одразу після видалення облікового запису | Обліковий запис Astra Browser видалено<br>Your Astra Browser account was deleted | `{{ .Email }}` |
| [11-reauthentication.html](11-reauthentication.html) | Supabase — шаблон «Reauthentication» | Підтвердіть дію в Astra Browser<br>Confirm an action in Astra Browser | `{{ .Token }}` |

## Мова

Мова листа — з облікового запису: `user_metadata.language` (`uk` чи `en`). Її записує застосунок (server/src/auth.rs) — під час реєстрації й щоразу, коли змінюють мову інтерфейсу. У файлах для Supabase обидві версії під умовою `{{ if and .Data (eq (printf "%v" .Data.language) "en") }}`: Supabase надсилає англійську лише тим, у кого мова `en`, решті (і давнім обліковим записам без мови) — українську. Функція notify вибирає мову сама (мова з запиту застосунку, інакше з облікового запису).

## Як підключати

- **Supabase**: Authentication → Emails → шаблон із таблиці: увесь файл — у Body (разом з умовою на початку), а в Subject — тема з умовою нижче. «Password changed» спершу ввімкнути в Security notifications.
- **Наш сервер** — Edge Function [notify](../functions/notify/index.ts), як розгорнути — у її [README](../functions/notify/README.md). Бере ці листи з templates.ts, підставляє змінні в тому самому вигляді (`{{ .Email }}` тощо), а кожне значення спершу HTML-екранує. `{{ .Name }}` — ім'я з облікового запису; якщо його немає — частина пошти до @.
- «Код діє одну годину» — типовий термін коду в Supabase (Email OTP Expiration = 3600 с). Змінили термін — поправте тексти в генераторі.

## Теми для Supabase (Subject)

**Confirm sign up** ([01-confirm-signup.html](01-confirm-signup.html)):

```
{{ if and .Data (eq (printf "%v" .Data.language) "en") }}Your Astra Browser confirmation code{{ else }}Код підтвердження Astra Browser{{ end }}
```

**Reset password** ([03-reset-password.html](03-reset-password.html)):

```
{{ if and .Data (eq (printf "%v" .Data.language) "en") }}Reset your Astra Browser password{{ else }}Відновлення пароля Astra Browser{{ end }}
```

**Password changed (Security notifications)** ([04-password-changed.html](04-password-changed.html)):

```
{{ if and .Data (eq (printf "%v" .Data.language) "en") }}Your Astra Browser password was changed{{ else }}Пароль Astra Browser змінено{{ end }}
```

**Change email address** ([08-email-change.html](08-email-change.html)):

```
{{ if and .Data (eq (printf "%v" .Data.language) "en") }}Confirm your Astra Browser email change{{ else }}Підтвердіть зміну пошти Astra Browser{{ end }}
```

**Reauthentication** ([11-reauthentication.html](11-reauthentication.html)):

```
{{ if and .Data (eq (printf "%v" .Data.language) "en") }}Confirm an action in Astra Browser{{ else }}Підтвердіть дію в Astra Browser{{ end }}
```

## Логотип

Листи беруть логотип за адресою https://flhmxwjermtajpdbqgut.supabase.co/storage/v1/object/public/email/logo.png. Один раз: Supabase → Storage → New bucket `email` (Public bucket) → завантажити туди [logo.png](logo.png). Поки його там немає, у листах поруч із назвою Astra Browser просто не буде зірки. Інша адреса — змініть `LOGO_URL` у генераторі.
