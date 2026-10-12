// Що вже налаштовано в Supabase для Astra Browser: node supabase/check.mjs
//
// Лише читає: нікуди не входить, листів не надсилає й нічого не змінює. Адреса й публічний ключ — з
// server/src/auth.rs. Чого перевірити ззовні не можна (SMTP, шаблони листів, секрети функції), — у README.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const auth = readFileSync(
  resolve(import.meta.dirname, "../server/src/auth.rs"),
  "utf8",
);
const url = auth.match(/const SUPABASE_URL: &str = "([^"]+)"/)?.[1];
const key = auth.match(/const SUPABASE_KEY: &str = "([^"]+)"/)?.[1];
if (!url || !key) {
  console.error(
    "Не знайшов SUPABASE_URL чи SUPABASE_KEY у server/src/auth.rs.",
  );
  process.exit(1);
}
const headers = { apikey: key, "Content-Type": "application/json" };

async function request(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Не JSON (картинка, порожня відповідь).
  }
  return { status: response.status, body };
}

const checks = [
  [
    "Підтвердження пошти кодом",
    async () => {
      const { body } = await request("/auth/v1/settings");
      return (
        body?.mailer_autoconfirm === false ||
        "вимкнено: Authentication → Sign In / Providers → Email → Confirm email"
      );
    },
  ],
  [
    "Синхронізація (sync.sql)",
    async () => {
      // Анонімно читати записи не можна — «немає прав» означає, що таблиця є.
      const { status, body } = await request(
        "/rest/v1/sync_items?select=id&limit=0",
      );
      return (
        status === 200 ||
        body?.code === "42501" ||
        "таблиці sync_items немає: виконайте supabase/sync.sql"
      );
    },
  ],
  [
    "Видалення облікового запису (account.sql)",
    async () => {
      // Анонімно функцію не викликати (і вона нічого б не видалила) — «немає прав» означає, що вона є.
      const { body } = await request("/rest/v1/rpc/delete_account", {
        method: "POST",
        body: "{}",
      });
      return (
        body?.code === "42501" ||
        "функції delete_account немає: виконайте supabase/account.sql"
      );
    },
  ],
  [
    "Логотип для листів",
    async () => {
      const { status } = await request(
        "/storage/v1/object/public/email/logo.png",
      );
      return (
        status === 200 ||
        "немає: Storage → публічний бакет email → logo.png (supabase/templates/README.md)"
      );
    },
  ],
  [
    "Листи «нашого сервера» (функція notify)",
    async () => {
      // Без токена функція нічого не надсилає, лише відмовляє; 404 — її не розгорнули.
      const { status } = await request("/functions/v1/notify", {
        method: "POST",
        body: "{}",
      });
      return (
        status !== 404 || "не розгорнута: supabase/functions/notify/README.md"
      );
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  let result;
  try {
    result = await check();
  } catch (error) {
    result = `не вдалося перевірити: ${error.message}`;
  }
  if (result === true) {
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name} — ${result}`);
  }
}
console.log(
  "\nЗовні не видно: власний SMTP, шаблони листів із {{ .Token }} і секрети SMTP_* функції notify — їх перевірте в панелі Supabase.",
);
process.exit(failed ? 1 : 0);
