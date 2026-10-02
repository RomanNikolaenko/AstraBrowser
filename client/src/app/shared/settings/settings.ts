import { Injectable, effect } from '@angular/core';
import { storedSignal } from '../storage/stored-signal';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * Налаштування браузера, спільні для всіх вікон. Тему ще до старту Angular
 * виставляє скрипт в index.html (той самий ключ), щоб не блимала тема системи.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  readonly theme = storedSignal<ThemePreference>('astra.settings.theme', 'system');
  readonly showBookmarksBar = storedSignal('astra.settings.bookmarks-bar', true);

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
}
