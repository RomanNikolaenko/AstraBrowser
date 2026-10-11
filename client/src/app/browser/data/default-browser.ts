import { Injectable, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';

/** Astra у Windows як браузер (server/src/default_browser.rs). */
export interface DefaultBrowserState {
  /** Інсталятор зареєстрував Astra як браузер (запуск з `tauri dev` — ні). */
  readonly registered: boolean;
  /** Посилання з інших програм відкриваються в Astra. */
  readonly isDefault: boolean;
}

/**
 * Браузер за замовчуванням. Вибрати себе основним програма не може — це робить людина в «Параметрах Windows»;
 * тут — чи вибрано, і кнопка, що відкриває «Параметри» на сторінці Astra.
 */
@Injectable({ providedIn: 'root' })
export class DefaultBrowserStore {
  /** null — ще не дізналися (чи поза застосунком). */
  readonly state = signal<DefaultBrowserState | null>(null);

  async refresh(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    try {
      this.state.set(await commands.defaultBrowserState());
    } catch {
      // Не вдалося прочитати реєстр — розділ лишається як був.
    }
  }

  async openSettings(): Promise<void> {
    await commands.defaultBrowserOpenSettings();
  }
}
