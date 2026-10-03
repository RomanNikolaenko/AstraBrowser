import { Injectable, effect } from '@angular/core';
import { storedSignal } from '../storage/stored-signal';

export type ThemePreference = 'system' | 'light' | 'dark';
export type SearchEngine = 'google' | 'duckduckgo' | 'bing';

export const SEARCH_ENGINES: Readonly<Record<SearchEngine, { readonly label: string; readonly url: string }>> = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
};

/**
 * Налаштування браузера, спільні для всіх вікон. Тему ще до старту Angular
 * виставляє скрипт в index.html (той самий ключ), щоб не блимала тема системи.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  readonly theme = storedSignal<ThemePreference>('astra.settings.theme', 'system');
  readonly showBookmarksBar = storedSignal('astra.settings.bookmarks-bar', true);
  readonly searchEngine = storedSignal<SearchEngine>('astra.settings.search-engine', 'google');

  constructor() {
    effect(() => {
      const theme = this.theme();
      if (theme === 'system') {
        delete document.documentElement.dataset['theme'];
      } else {
        document.documentElement.dataset['theme'] = theme;
      }
    });
  }

  /** Адреса пошуку запиту в обраній пошуковій системі. */
  searchUrl(query: string): string {
    return SEARCH_ENGINES[this.searchEngine()].url + encodeURIComponent(query.trim());
  }
}
