// Листи «нашого сервера» Astra Browser: застосунок (server/src/auth.rs) кличе цю функцію після входу чи видалення
// облікового запису з токеном користувача, а вона вирішує, чи потрібен лист, і надсилає його через SMTP.
//
// Види (`kind` у тілі запиту):
// - welcome — привітання; лише раз на обліковий запис (позначка astra_welcomed в app_metadata);
// - new-device — перший вхід на комп'ютері, де цей обліковий запис ще не входив;
// - sign-in — звичайний вхід: лист «Новий вхід» лише з незнайомого IP (останні 10 — в app_metadata.astra_ips);
// - account-deleted — обліковий запис щойно видалено: токен перевіряється за підписом (JWKS проєкту),
//   а користувача справді вже не має бути.
//
// Мова листа — `language` із запиту (мова інтерфейсу застосунку), інакше user_metadata.language облікового запису,
// інакше українська.
//
// Шаблони — templates.ts, його пише server/examples/email_templates.rs. Як розгорнути — README.md поруч.

import nodemailer from "npm:nodemailer@6.9.16";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { TEMPLATES, type Language, type Template } from "./templates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
/** Скільки IP пам'ятати як знайомі. */
const KNOWN_IPS = 10;
/** Час у листах — за Києвом. */
const TIME_ZONE = "Europe/Kyiv";

const jwks = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

const mailer = nodemailer.createTransport({
  host: Deno.env.get("SMTP_HOST"),
  // Edge Functions не випускають на порти 25 і 587 — лише 465 (TLS одразу).
  port: Number(Deno.env.get("SMTP_PORT") ?? 465),
  secure: Number(Deno.env.get("SMTP_PORT") ?? 465) === 465,
  auth: {
    user: Deno.env.get("SMTP_USER"),
    pass: Deno.env.get("SMTP_PASSWORD"),
  },
});

interface User {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return reply(405, "method_not_allowed");
  }
  const token = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const body = await request.json().catch(() => null);
  const kind = typeof body?.kind === "string" ? body.kind : "";
  const requested = languageOf(body?.language);
  const ip = clientIp(request);
  const values = (language: Language) => ({
    Date: now(language),
    Device: clean(body?.device, 80) || text(language, "Невідомий пристрій", "Unknown device"),
    Ip: ip || text(language, "невідомо", "unknown"),
    Location: location(request, language),
  });

  if (kind === "account-deleted") {
    const claims = await verified(token);
    if (!claims) {
      return reply(401, "unauthorized");
    }
    if (await userExists(claims.sub)) {
      return reply(409, "not_deleted");
    }
    const language = requested ?? claims.language ?? "uk";
    await send("account-deleted", language, claims.email, values(language));
    return reply(200, "sent");
  }
  if (!["welcome", "new-device", "sign-in"].includes(kind)) {
    return reply(400, "unknown_kind");
  }

  const user = await currentUser(token);
  if (!user?.email) {
    return reply(401, "unauthorized");
  }
  const metadata = user.app_metadata ?? {};
  const known = Array.isArray(metadata.astra_ips)
    ? metadata.astra_ips.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const template: Template | null =
    kind === "welcome"
      ? metadata.astra_welcomed
        ? null
        : "welcome"
      : kind === "new-device"
        ? "new-device"
        : // Перший облік IP (обліковий запис давніший за ці листи) — без листа, лише запам'ятати.
          ip && known.length > 0 && !known.includes(ip)
          ? "new-sign-in"
          : null;

  // Позначки — перш ніж надсилати: дві одночасні спроби не надішлють привітання двічі.
  await updateAppMetadata(user.id, {
    astra_welcomed: true,
    astra_ips: ip
      ? [ip, ...known.filter((item) => item !== ip)].slice(0, KNOWN_IPS)
      : known,
  });
  if (!template) {
    return reply(200, "skipped");
  }
  const language = requested ?? languageOf(user.user_metadata?.language) ?? "uk";
  await send(template, language, user.email, {
    ...values(language),
    Name: displayName(user),
  });
  return reply(200, "sent");
});

/** Мова листа, якщо це одна з мов шаблонів. */
function languageOf(value: unknown): Language | null {
  return value === "uk" || value === "en" ? value : null;
}

function text(language: Language, uk: string, en: string): string {
  return language === "en" ? en : uk;
}

function reply(status: number, result: string): Response {
  return Response.json({ result }, { status });
}

/** Рядок без керівних символів і не довший за `limit`. */
function clean(value: unknown, limit: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit)
    : "";
}

function clientIp(request: Request): string {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return clean(
    forwarded ||
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip"),
    45,
  );
}

/** Країна за заголовком мережі, якщо він є, — мовою листа; інакше «Не визначено». */
function location(request: Request, language: Language): string {
  const country =
    request.headers.get("cf-ipcountry") ??
    request.headers.get("x-country-code");
  if (country && /^[A-Z]{2}$/.test(country) && country !== "XX") {
    try {
      return (
        new Intl.DisplayNames([language], { type: "region" }).of(country) ??
        country
      );
    } catch {
      return country;
    }
  }
  return text(language, "Не визначено", "Unknown");
}

function now(language: Language): string {
  const date = new Intl.DateTimeFormat(language === "en" ? "en-US" : "uk-UA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: TIME_ZONE,
  }).format(new Date());
  return `${date} ${text(language, "(за Києвом)", "(Kyiv time)")}`;
}

function displayName(user: User): string {
  const metadata = user.user_metadata ?? {};
  const name = clean(metadata.name, 80) || clean(metadata.full_name, 80);
  return name || (user.email ?? "").split("@")[0];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function send(
  template: Template,
  language: Language,
  email: string,
  values: Record<string, string>,
): Promise<void> {
  const variables: Record<string, string> = { ...values, Email: email };
  const { subject, html } = TEMPLATES[template][language];
  await mailer.sendMail({
    from: Deno.env.get("SMTP_FROM"),
    to: email,
    subject,
    html: html.replace(/\{\{ \.(\w+) \}\}/g, (match, name: string) =>
      name in variables ? escapeHtml(variables[name]) : match,
    ),
  });
}

async function auth(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${init.token ?? SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

/** Користувач за його токеном (Supabase сам перевіряє токен). */
async function currentUser(token: string): Promise<User | null> {
  if (!token) {
    return null;
  }
  const response = await auth("user", { token });
  return response.ok ? ((await response.json()) as User) : null;
}

async function userExists(id: string): Promise<boolean> {
  const response = await auth(`admin/users/${encodeURIComponent(id)}`);
  // Будь-яка інша помилка — вважаємо, що є: краще без листа, ніж хибний «видалено».
  return response.status !== 404;
}

async function updateAppMetadata(
  id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await auth(`admin/users/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ app_metadata: metadata }),
  });
}

/** Токен видаленого користувача: Supabase його вже не прийме, тож перевіряємо підпис самі (ключі проєкту, JWKS). */
async function verified(
  token: string,
): Promise<{ sub: string; email: string; language: Language | null } | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    });
    const metadata = payload.user_metadata as
      | Record<string, unknown>
      | undefined;
    return typeof payload.sub === "string" &&
      typeof payload.email === "string" &&
      payload.email
      ? {
          sub: payload.sub,
          email: payload.email,
          language: languageOf(metadata?.language),
        }
      : null;
  } catch {
    // Немає асиметричних ключів (старий спільний секрет JWT), підпис чи термін не той — листа немає.
    return null;
  }
}
