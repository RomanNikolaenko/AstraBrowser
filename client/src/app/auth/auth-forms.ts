import { signal } from '@angular/core';
import { Validator } from '../shared/form-field/form-field';
import { tr, translate } from '../shared/i18n/i18n';

/** Скільки секунд чекати, перш ніж надіслати лист із кодом ще раз (Supabase дозволяє раз на хвилину). */
export const RESEND_COOLDOWN = 60;

/** Найкоротший пароль облікового запису. */
export const PASSWORD_MIN_LENGTH = 8;
/** Підказка до закороткого пароля (число — PASSWORD_MIN_LENGTH; тест у auth-forms.spec.ts стежить, щоб збігалося). */
export const PASSWORD_TOO_SHORT = tr('Пароль має містити щонайменше 8 символів');

/** Код із листа без пробілів (його часто копіюють як «123 456»). */
export function normalizeCode(value: string): string {
  return value.replace(/\s/g, '');
}

/** Код Supabase — від 6 до 10 цифр (довжину задають у налаштуваннях проєкту). */
export const codeFormat: Validator = (value) =>
  /^\d{6,10}$/.test(normalizeCode(value)) ? null : translate('Код — це 6–10 цифр із листа');

/** Пошта, яку сторінки входу передають одна одній (стан навігації, не URL). */
export function emailFromNavigation(): string {
  const state: unknown = history.state;
  return typeof state === 'object' && state !== null && 'email' in state && typeof state.email === 'string' ? state.email : '';
}

/** Відлік до «Надіслати ще раз»: `seconds` — скільки лишилося (0 — можна). Зупинити — `stop` (при знищенні). */
export class Cooldown {
  readonly seconds = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  start(seconds = RESEND_COOLDOWN): void {
    this.stop();
    this.seconds.set(seconds);
    this.timer = setInterval(() => {
      this.seconds.update((left) => Math.max(0, left - 1));
      if (this.seconds() === 0) {
        this.stop();
      }
    }, 1000);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
