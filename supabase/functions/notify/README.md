# notify — листи «нашого сервера»

Edge Function, яку застосунок кличе після входу чи видалення облікового запису (`server/src/auth.rs`, `notify`).
Вона сама вирішує, чи потрібен лист, і надсилає його через ваш SMTP:

| Вид | Лист | Коли |
|---|---|---|
| `welcome` | 02-welcome | обліковий запис щойно створено (пошту підтвердили кодом чи перший вхід через Google); лише раз |
| `new-device` | 07-new-device | перший вхід на комп’ютері, де цей обліковий запис ще не входив |
| `sign-in` | 05-new-sign-in | звичайний вхід — лише з незнайомого IP (функція пам’ятає 10 останніх в `app_metadata.astra_ips`) |
| `account-deleted` | 10-account-deleted | обліковий запис видалено; токен перевіряється за підписом (JWKS), користувача вже не має бути |

Шаблони — `templates.ts`, його пише `cargo run --manifest-path server/Cargo.toml --example email_templates`.
Не розгорнули функцію — застосунок працює так само, просто цих листів немає.

## Розгорнути

1. Секрети: Supabase → Edge Functions → Secrets (ті самі дані, що в Authentication → SMTP Settings):
   - `SMTP_HOST` — напр. `smtp.gmail.com`;
   - `SMTP_PORT` — `465` (Edge Functions не випускають на порти 25 і 587);
   - `SMTP_USER`, `SMTP_PASSWORD`;
   - `SMTP_FROM` — напр. `Astra Browser <your@gmail.com>`.

   `SUPABASE_URL` і `SUPABASE_SERVICE_ROLE_KEY` функція отримує від Supabase сама — вводити їх не треба.
2. З кореня репозиторію (вхід у Supabase CLI — один раз, через браузер):

   ```bash
   npx supabase login
   ```

   ```bash
   npx supabase functions deploy notify --project-ref flhmxwjermtajpdbqgut --no-verify-jwt
   ```

   `--no-verify-jwt` потрібен, бо токен видаленого облікового запису Supabase уже не прийме. Функція сама перевіряє
   кожен запит: токен — через Supabase Auth, а для `account-deleted` — підписом за ключами проєкту.

Лист `account-deleted` надсилається лише тоді, коли проєкт підписує токени асиметричними ключами (Authentication →
JWT Keys → JWT Signing Keys). Зі старим спільним секретом JWT підпис перевірити нічим — цього листа просто не буде.
