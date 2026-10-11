import { Injectable, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { listen } from '@tauri-apps/api/event';

/** Куди зберігаються завантаження (server/src/downloads.rs, DownloadSettings). */
export interface DownloadSettings {
  /** Повний шлях до теки. */
  readonly folder: string;
  /** Тека вибрана користувачем, а не стандартна «Завантаження». */
  readonly custom: boolean;
  /** Щоразу питати, куди зберегти файл. */
  readonly ask: boolean;
}

/**
 * Налаштування завантажень, спільні для всіх вікон: живуть у Rust, нові стани приходять подією
 * downloads://settings. Поза Tauri їх немає (`settings` — null).
 */
@Injectable({ providedIn: 'root' })
export class DownloadSettingsStore {
  protected readonly state = signal<DownloadSettings | null>(null);
  readonly settings = this.state.asReadonly();

  constructor() {
    if (isTauri()) {
      void listen<DownloadSettings>('downloads://settings', ({ payload }) => this.state.set(payload));
      commands.downloadsSettings().then(
        (settings) => this.state.set(settings),
        () => undefined
      );
    }
  }

  /** Вікно вибору теки Windows; якщо теку не вибрали, нічого не змінюється. */
  chooseFolder(): Promise<void> {
    return this.apply(commands.downloadsChooseFolder());
  }

  /** Знову стандартна тека «Завантаження». */
  resetFolder(): Promise<void> {
    return this.apply(commands.downloadsResetFolder());
  }

  setAsk(ask: boolean): Promise<void> {
    return this.apply(commands.downloadsSetAsk(ask));
  }

  /** Відкриває теку завантажень у Провіднику. */
  async openFolder(): Promise<void> {
    await commands.downloadsOpenFolder();
  }

  private async apply(request: Promise<DownloadSettings>): Promise<void> {
    this.state.set(await request);
  }
}
