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

/** Адреса сайту http(s) у повному вигляді або `null`. Схему https:// можна не вказувати. */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
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
