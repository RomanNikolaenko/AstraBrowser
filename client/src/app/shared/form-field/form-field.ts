import { computed, signal } from '@angular/core';

/** Повертає текст помилки або `null`, якщо значення коректне. */
export type Validator = (value: string) => string | null;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const required =
  (message: string): Validator =>
  (value) =>
    value.trim() ? null : message;

export const emailFormat =
  (message: string): Validator =>
  (value) =>
    EMAIL_PATTERN.test(value.trim()) ? null : message;

export const minLength =
  (length: number, message: string): Validator =>
  (value) =>
    value.length >= length ? null : message;

/**
 * Цей комп'ютер і локальна мережа (сервери розробки): localhost, *.localhost, 127.x, 10.x, 192.168.x, 172.16–31.x,
 * [::1]. Без схеми вони відкриваються через http://, як у Chrome.
 */
const LOCAL_HOST =
  /^(?:localhost|[^.]+\.localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])$/i;

/**
 * Адреса сайту http(s) у повному вигляді або `null`. Схему можна не вказувати: тоді це https://, а для localhost і
 * локальної мережі — http://. Без схеми слово без крапки — адреса, лише якщо це localhost чи вказано порт
 * (myhost:8080); інакше це пошук.
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : null;
    }
    const url = new URL(`https://${trimmed}`);
    if (LOCAL_HOST.test(url.hostname)) {
      return new URL(`http://${trimmed}`).href;
    }
    return url.hostname.includes('.') || url.port ? url.href : null;
  } catch {
    return null;
  }
}

/** Файл комп'ютера: адреса file:///… чи шлях Windows (C:\…) — адресою file:, інакше `null`. */
function fileAddress(value: string): string | null {
  const text = value.trim();
  try {
    if (/^file:\/\//i.test(text)) {
      return new URL(text).href;
    }
    if (/^[a-z]:[\\/]/i.test(text)) {
      return new URL(`file:///${text.replace(/\\/g, '/')}`).href;
    }
  } catch {
    // Не адреса файла — тоді пошук.
  }
  return null;
}

/**
 * Введене в адресному рядку: адреса сайту, його код (view-source:адреса) чи файл комп'ютера (file:///…, C:\…) або
 * `null` — тоді це пошук.
 */
export function normalizeAddress(value: string): string | null {
  const file = fileAddress(value);
  if (file) {
    return file;
  }
  const source = /^\s*view-source:/i.exec(value);
  if (!source) {
    return normalizeUrl(value);
  }
  const url = normalizeUrl(value.slice(source[0].length));
  return url ? `view-source:${url}` : null;
}

export const urlFormat =
  (message: string): Validator =>
  (value) =>
    normalizeUrl(value) ? null : message;

/** Значення має збігатися з іншим полем, наприклад підтвердження пароля. */
export const matches =
  (other: () => string, message: string): Validator =>
  (value) =>
    value === other() ? null : message;

/** Стан одного текстового поля форми: значення, «торкнутість» і перша помилка валідації. */
export class FormField {
  readonly value = signal('');
  readonly touched = signal(false);

  /** Перша помилка за порядком валідаторів — незалежно від того, чи її вже час показувати. */
  readonly error = computed(() => {
    const value = this.value();
    for (const validate of this.validators) {
      const error = validate(value);
      if (error) {
        return error;
      }
    }
    return null;
  });

  /** Помилку показуємо лише після того, як поле покинули або спробували надіслати форму. */
  readonly visibleError = computed(() => (this.touched() ? this.error() : null));

  constructor(private readonly validators: readonly Validator[]) {}
}

/** Показує помилки всіх полів і повертає, чи форма коректна. */
export function validateFields(fields: readonly FormField[]): boolean {
  for (const field of fields) {
    field.touched.set(true);
  }
  return fields.every((field) => field.error() === null);
}
