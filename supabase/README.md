# Supabase для Astra Browser

Проєкт `flhmxwjermtajpdbqgut`. Адреса й публічний ключ — у `server/src/auth.rs`; секретних ключів застосунок не має.

| Що | Як увімкнути |
|---|---|
| Синхронізація | SQL Editor → виконати [sync.sql](sync.sql) (і після кожної його зміни); він же вмикає pg_cron і щоденне прибирання давніх позначок «видалено» |
| Видалення облікового запису | SQL Editor → виконати [account.sql](account.sql) |
| Листи Supabase (коди) | Authentication → Emails — шаблони з [templates](templates/README.md) |
| Листи «нашого сервера» | Edge Function [notify](functions/notify/README.md) |

Що з цього вже налаштовано — `node supabase/check.mjs` (лише читає: нікуди не входить і листів не надсилає).
