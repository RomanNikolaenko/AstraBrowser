import { WritableSignal, effect, signal } from '@angular/core';

/**
 * Сигнал, що зберігається в localStorage під ключем `key` і синхронізується між вікнами застосунку.
 * Викликати в контексті впровадження (поле сервісу чи компонента), бо запис іде через effect.
 * Приватне вікно (InPrivate) має власне localStorage, яке зникає разом із вікном.
 */
export function storedSignal<T>(key: string, fallback: T): WritableSignal<T> {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };

  const state = signal<T>(read());

  effect(() => {
    const value = JSON.stringify(state());
    try {
      localStorage.setItem(key, value);
    } catch {
      // Сховище недоступне чи переповнене: дані лишаються лише в пам'яті цього вікна.
    }
  });

  // Подія storage приходить лише в інші вікна; запис того самого значення її не викликає, тож циклу немає.
  window.addEventListener('storage', (event) => {
    if (event.key === key) {
      state.set(read());
    }
  });

  return state;
}
