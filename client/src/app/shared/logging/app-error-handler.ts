import { ErrorHandler, Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';

/** Помилка текстом для журналу: стек, якщо він є. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Помилки інтерфейсу — і в консоль, і в журнал застосунку (server/src/logging.rs): його можна відкрити з довідки й
 * надіслати, коли щось не працює. Сюди ж потрапляють неперехоплені помилки й відхилені обіцянки
 * (provideBrowserGlobalErrorListeners).
 */
@Injectable()
export class AppErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    if (isTauri()) {
      commands.appLogError(describeError(error)).catch(() => undefined);
    }
  }
}
