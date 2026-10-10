import { Injectable } from '@angular/core';
import { accountKey } from '../../shared/storage/stored-signal';

/** Вкладка, що переживе закриття браузера: сайт (адреса й назва) чи внутрішня сторінка. */
export interface SavedTab {
  readonly page: string;
  readonly url?: string;
  readonly title?: string;
  /** Закріплена вкладка. */
  readonly pinned?: boolean;
}

/** Вкладки вікна й номер активної. */
export interface SavedSession {
  readonly tabs: readonly SavedTab[];
  readonly active: number;
}

const PREFIX = 'astra.session.';
/** Ключ пристрою (не облікового запису): наступний запуск відновить вкладки, хоч би що було в налаштуваннях. */
const RESTORE_ONCE = 'astra.settings.restore-session-once';

/**
 * Відкриті вкладки кожного звичайного вікна (за міткою вікна) — щоб наступний запуск продовжив там, де зупинилися.
 * Свої в кожного облікового запису й не синхронізуються. Приватні й гостьові вікна нічого не зберігають.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  save(window: string, session: SavedSession): void {
    try {
      const key = accountKey(`${PREFIX}${window}`);
      const value = JSON.stringify(session);
      if (localStorage.getItem(key) !== value) {
        localStorage.setItem(key, value);
      }
    } catch {
      // Сховище недоступне чи переповнене — вкладки цього разу не збережуться.
    }
  }

  load(window: string): SavedSession | null {
    try {
      const saved = JSON.parse(localStorage.getItem(accountKey(`${PREFIX}${window}`)) ?? 'null') as SavedSession | null;
      return saved && Array.isArray(saved.tabs) ? saved : null;
    } catch {
      return null;
    }
  }

  remove(window: string): void {
    try {
      localStorage.removeItem(accountKey(`${PREFIX}${window}`));
    } catch {
      // Нема чого прибирати.
    }
  }

  /** Мітки вікон, чиї вкладки збережено. */
  windows(): string[] {
    try {
      const prefix = accountKey(PREFIX);
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    } catch {
      return [];
    }
  }

  /** Наступний запуск відновить вкладки, навіть якщо в налаштуваннях «Нова вкладка» (перезапуск браузера). */
  restoreOnce(): void {
    try {
      localStorage.setItem(RESTORE_ONCE, '1');
    } catch {
      // Без сховища — як у налаштуваннях.
    }
  }

  /** Чи просили відновити вкладки цього разу (і більше вже ні). */
  takeRestoreOnce(): boolean {
    try {
      const once = localStorage.getItem(RESTORE_ONCE) === '1';
      localStorage.removeItem(RESTORE_ONCE);
      return once;
    } catch {
      return false;
    }
  }
}
