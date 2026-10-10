# Supabase для Astra Browser

Проєкт `flhmxwjermtajpdbqgut`. Адреса й публічний ключ — у `server/src/auth.rs`; секретних ключів застосунок не має.

| Що | Як увімкнути |
|---|---|
| Синхронізація | SQL Editor → виконати [sync.sql](sync.sql) (і після кожної його зміни) |
| Видалення облікового запису | SQL Editor → виконати [account.sql](account.sql) |
| Листи Supabase (коди) | Authentication → Emails — шаблони з [templates](templates/README.md) |
| Вхід за кодом без пароля | шаблон «Magic link or OTP» ← [06-sign-in-code.html](templates/06-sign-in-code.html) (у листі має бути `{{ .Token }}`) |
| Листи «нашого сервера» | Edge Function [notify](functions/notify/README.md) |
| Вхід через Google | нижче |

## Вхід через Google

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create credentials → OAuth client ID:
   - тип — **Web application**;
   - Authorized redirect URIs — `https://flhmxwjermtajpdbqgut.supabase.co/auth/v1/callback`.

   Якщо Google попросить OAuth consent screen — External, назва Astra Browser, ваша пошта.
2. Supabase → Authentication → Sign In / Providers → **Google**: увімкнути, вставити Client ID і Client Secret.
3. Supabase → Authentication → URL Configuration → Redirect URLs → додати `http://localhost/astra-auth-callback`.

   Цю адресу застосунок перехоплює сам, у вікні вона не відкривається. Без неї в списку Supabase поверне на Site URL
   і вхід не завершиться.

Застосунок відкриває вхід Google в окремому приватному вікні (OAuth із PKCE). Обліковий запис Google з тією самою
поштою, що вже зареєстрована, Supabase зв'язує з наявним. Пароля в такого облікового запису немає. Щоб синхронізувати
паролі сайтів, його задають у профілі: «Змінити пароль…».
