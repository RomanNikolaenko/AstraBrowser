import { DestroyRef, WritableSignal, effect, inject, signal } from '@angular/core';

/**
 * Обліковий запис, чиї дані зараз у браузері (id користувача). Задає AuthStore — раніше, ніж створюються сховища
 * даних (вони з'являються лише в браузері, куди пускають тих, хто ввійшов). `null` — поза застосунком і в тестах.
 */
let account: string | null = null;

export function setStorageAccount(id: string | null): void {
  account = id;
}

/** Ключ даних облікового запису: `astra.bookmarks` → `astra.<id користувача>.bookmarks`. */
export function accountKey(key: string, id = account): string {
  return id ? key.replace(/^astra\./, `astra.${id}.`) : key;
}

/** Ключі, що належать пристрою, а не обліковому запису: тема й решта налаштувань (їх видно й на сторінці входу). */
const DEVICE_KEYS = /^astra\.settings\./;
/** Ключ уже чийсь: astra.<UUID>.… */
const SCOPED_KEY = /^astra\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i;

/**
 * Дані, що лежали в браузері ще до облікових записів (astra.bookmarks, astra.history…), — першому обліковому
 * запису на цьому комп'ютері: вони переїжджають під його ключі.
 */
export function adoptLegacyData(id: string): void {
  try {
    const legacy = Object.keys(localStorage).filter(
      (key) => key.startsWith('astra.') && !DEVICE_KEYS.test(key) && !SCOPED_KEY.test(key)
    );
    for (const key of legacy) {
      const value = localStorage.getItem(key);
      const target = accountKey(key, id);
      if (value !== null && localStorage.getItem(target) === null && key !== 'astra.profile.account') {
        localStorage.setItem(target, value);
      }
      localStorage.removeItem(key);
    }
  } catch {
    // Сховище недоступне — переносити нічого.
  }
}

/** Прибирає всі дані облікового запису `id` (обліковий запис видалено). */
export function removeAccountData(id: string): void {
  try {
    const prefix = `astra.${id}.`;
    for (const key of Object.keys(localStorage).filter((key) => key.startsWith(prefix))) {
      localStorage.removeItem(key);
    }
  } catch {
    // Сховище недоступне — прибирати нічого.
  }
}

/** Сигнали цього вікна за ключами — щоб синхронізація оновлювала їх, а не лише localStorage. */
const signals = new Map<string, WritableSignal<unknown>>();
/**
 * Значення, що лежить у localStorage під ключем, наскільки відомо цьому вікну (востаннє прочитане чи записане): його
 * вдруге не записуємо. Порівнюється сам об'єкт — той, що й так у сигналі, — а не рядок JSON: історія чи нотатки можуть
 * важити мегабайти, і ні перечитувати їх зі сховища, ні тримати ще й копію рядком кожне вікно не мусить.
 */
const savedValues = new Map<string, unknown>();
/** Хто стежить за змінами збережених значень (своїми й з інших вікон). */
const listeners = new Set<(key: string) => void>();

/** Сигнал цього вікна для ключа, якщо його вже створено. */
export function storedSignalFor<T>(key: string): WritableSignal<T> | undefined {
  return signals.get(key) as WritableSignal<T> | undefined;
}

/**
 * Нове значення одразу в localStorage (інші вікна отримають подію storage) і в сигнал цього вікна, якщо він є, — без
 * сповіщення слухачів: так пише синхронізація, якій не треба бачити свої ж записи як зміни.
 */
export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    savedValues.set(key, value);
  } catch {
    // Сховище переповнене — лишається в пам'яті цього вікна.
  }
  storedSignalFor(key)?.set(value);
}

/** Слухати зміни збережених значень: записи сигналів цього вікна й зміни з інших вікон. Повертає відписку. */
export function onStoredChange(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Сигнал, що зберігається в localStorage під ключем `key` і синхронізується між вікнами застосунку.
 * Викликати в контексті впровадження (поле сервісу чи компонента), бо запис іде через effect.
 * Приватне вікно (InPrivate) має власне localStorage, яке зникає разом із вікном.
 */
export function storedSignal<T>(key: string, fallback: T): WritableSignal<T> {
  // Нічого не збережено чи збережене не прочитати — у сховище піде `fallback`.
  const read = (): T => {
    savedValues.delete(key);
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) {
        return fallback;
      }
      const value = JSON.parse(raw) as T;
      savedValues.set(key, value);
      return value;
    } catch {
      return fallback;
    }
  };

  const state = signal<T>(read());
  signals.set(key, state as WritableSignal<unknown>);

  effect(() => {
    const value = state();
    if (savedValues.has(key) && savedValues.get(key) === value) {
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
      savedValues.set(key, value);
    } catch {
      // Сховище недоступне чи переповнене: дані лишаються лише в пам'яті цього вікна.
      return;
    }
    for (const listener of listeners) {
      listener(key);
    }
  });

  // Подія storage приходить лише в інші вікна; запис того самого значення її не викликає, тож циклу немає.
  // Ключ прибрали (видалили обліковий запис) — значення не скидаємо: інакше це вікно записало б його наново.
  const onStorage = (event: StorageEvent) => {
    if (event.key === key && event.newValue !== null) {
      state.set(read());
    }
  };
  window.addEventListener('storage', onStorage);

  // Сигнал зникає разом із власником (компонентом чи сервісом): у реєстрі не лишається застарілого.
  inject(DestroyRef).onDestroy(() => {
    window.removeEventListener('storage', onStorage);
    if (signals.get(key) === state) {
      signals.delete(key);
      savedValues.delete(key);
    }
  });

  return state;
}

/** [`storedSignal`] для даних облікового запису, що ввійшов: закладки, історія, нотатки, профіль. */
export function accountSignal<T>(key: string, fallback: T): WritableSignal<T> {
  return storedSignal(accountKey(key), fallback);
}

// Зміни з інших вікон — слухачам (синхронізації); свої вони отримують з effect вище.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key) {
      for (const listener of listeners) {
        listener(event.key);
      }
    }
  });
}
