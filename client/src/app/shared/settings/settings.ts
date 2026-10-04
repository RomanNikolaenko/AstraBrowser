import { Injectable, WritableSignal, computed, effect, signal } from '@angular/core';
import { accountKey, storedSignal } from '../storage/stored-signal';

/** Копія налаштувань облікового запису (astra.<id>.settings): з нею інший обліковий запис у цьому браузері має свої. */
const ACCOUNT_SETTINGS_KEY = 'astra.settings';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Колір акценту інтерфейсу (Персоналізація): кнопки, перемикачі, виділення. Синій — стандартний. */
export type AccentColor = 'blue' | 'violet' | 'green' | 'orange' | 'pink' | 'teal';

export const ACCENT_COLORS: readonly { readonly value: AccentColor; readonly label: string; readonly swatch: string }[] = [
  { value: 'blue', label: 'Синій', swatch: 'linear-gradient(135deg, #2563eb, #7c3aed)' },
  { value: 'violet', label: 'Фіолетовий', swatch: 'linear-gradient(135deg, #7c3aed, #c026d3)' },
  { value: 'pink', label: 'Рожевий', swatch: 'linear-gradient(135deg, #db2777, #f43f5e)' },
  { value: 'orange', label: 'Помаранчевий', swatch: 'linear-gradient(135deg, #ea580c, #f59e0b)' },
  { value: 'green', label: 'Зелений', swatch: 'linear-gradient(135deg, #059669, #65a30d)' },
  { value: 'teal', label: 'Бірюзовий', swatch: 'linear-gradient(135deg, #0891b2, #0d9488)' },
];

/** Фон нової вкладки: бульбашки (стандартний), один із градієнтів, без фону чи своє зображення. */
export type NewTabBackground = 'bubbles' | 'aurora' | 'sunset' | 'ocean' | 'none' | 'custom';
export type SearchEngine = 'google' | 'duckduckgo' | 'bing';

/** Скільки днів зберігати історію переглядів; 0 — завжди. Як у Chrome, стандартно — 90. */
export const HISTORY_RETENTION: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: '7 днів' },
  { days: 30, label: '30 днів' },
  { days: 90, label: '90 днів' },
  { days: 180, label: '6 місяців' },
  { days: 365, label: '1 рік' },
  { days: 0, label: 'Завжди' },
];

export const SEARCH_ENGINES: Readonly<Record<SearchEngine, { readonly label: string; readonly url: string }>> = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
};

/**
 * Налаштування браузера, спільні для всіх вікон. Тему ще до старту Angular
 * виставляє скрипт в index.html (той самий ключ), щоб не блимала тема системи.
 *
 * Самі значення — налаштування цього комп'ютера (їх видно й на сторінці входу), а для облікового запису, що ввійшов,
 * зберігається їхня копія: увійде інший — отримає свої. Синхронізація (browser/sync) читає й задає їх через
 * `values` і `apply`.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  readonly theme = storedSignal<ThemePreference>('astra.settings.theme', 'system');
  readonly showBookmarksBar = storedSignal('astra.settings.bookmarks-bar', true);
  readonly searchEngine = storedSignal<SearchEngine>('astra.settings.search-engine', 'google');
  readonly accent = storedSignal<AccentColor>('astra.settings.accent', 'blue');
  readonly newTabBackground = storedSignal<NewTabBackground>('astra.settings.new-tab-background', 'bubbles');
  /** Своє зображення для фону нової вкладки (data: URL, уже зменшене). */
  readonly newTabImage = storedSignal('astra.settings.new-tab-image', '');
  /** Скільки днів зберігати історію (HISTORY_RETENTION); давніші записи прибираються самі. */
  readonly historyDays = storedSignal('astra.settings.history-days', 90);

  /** Налаштування, що належать обліковому запису й синхронізуються: id → сигнал. */
  private readonly synced: Readonly<Record<string, WritableSignal<unknown>>> = {
    theme: this.theme as WritableSignal<unknown>,
    bookmarksBar: this.showBookmarksBar as WritableSignal<unknown>,
    searchEngine: this.searchEngine as WritableSignal<unknown>,
    accent: this.accent as WritableSignal<unknown>,
    newTabBackground: this.newTabBackground as WritableSignal<unknown>,
    newTabImage: this.newTabImage as WritableSignal<unknown>,
    historyDays: this.historyDays as WritableSignal<unknown>,
  };
  /** Ключі localStorage цих налаштувань — щоб синхронізація знала, коли вони змінилися. */
  readonly keys: readonly string[] = [
    'astra.settings.theme',
    'astra.settings.bookmarks-bar',
    'astra.settings.search-engine',
    'astra.settings.accent',
    'astra.settings.new-tab-background',
    'astra.settings.new-tab-image',
    'astra.settings.history-days',
  ];
  /** Усі налаштування облікового запису: id → значення. */
  readonly values = computed(() => Object.fromEntries(Object.entries(this.synced).map(([id, value]) => [id, value()])));
  /** Обліковий запис, якому належать поточні налаштування. */
  private readonly account = signal<string | null>(null);

  constructor() {
    // Колір акценту — атрибут data-accent на <html>, як і тема (кольори — assets/styles/accents.scss).
    effect(() => {
      const accent = this.accent();
      if (accent === 'blue') {
        delete document.documentElement.dataset['accent'];
      } else {
        document.documentElement.dataset['accent'] = accent;
      }
    });
    // Копія налаштувань облікового запису оновлюється з кожною зміною.
    effect(() => {
      const account = this.account();
      const values = JSON.stringify(this.values());
      if (account) {
        try {
          localStorage.setItem(accountKey(ACCOUNT_SETTINGS_KEY, account), values);
        } catch {
          // Сховище переповнене: копія лишиться попередньою.
        }
      }
    });
    effect(() => {
      const theme = this.theme();
      if (theme === 'system') {
        delete document.documentElement.dataset['theme'];
      } else {
        document.documentElement.dataset['theme'] = theme;
      }
    });
  }

  /** Налаштування з синхронізації чи з копії облікового запису; невідомі id пропускаються. */
  apply(values: Readonly<Record<string, unknown>>): void {
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined && value !== null) {
        this.synced[id]?.set(value);
      }
    }
  }

  /** Увійшов обліковий запис (`null` — вийшли): його налаштування, якщо вони вже були в цьому браузері. */
  useAccount(id: string | null): void {
    if (id && id !== this.account()) {
      try {
        const copy = localStorage.getItem(accountKey(ACCOUNT_SETTINGS_KEY, id));
        if (copy) {
          this.apply(JSON.parse(copy) as Record<string, unknown>);
        }
      } catch {
        // Копії немає чи вона зіпсована — лишаються поточні.
      }
    }
    this.account.set(id);
  }

  /** Адреса пошуку запиту в обраній пошуковій системі. */
  searchUrl(query: string): string {
    return SEARCH_ENGINES[this.searchEngine()].url + encodeURIComponent(query.trim());
  }
}
