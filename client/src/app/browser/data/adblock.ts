import { Injectable, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { listen } from '@tauri-apps/api/event';

/** Стан блокувальника реклами (server/src/adblock.rs, Status). */
export interface AdBlockStatus {
  readonly enabled: boolean;
  /** Сайти (хост без www.), на яких блокування вимкнене, — разом із піддоменами. */
  readonly disabledSites: readonly string[];
  /** Списки фільтрів завантажено — блокування працює. */
  readonly ready: boolean;
  readonly updating: boolean;
  /** Коли списки востаннє оновилися (мс від 1970 року). */
  readonly updatedAt: number | null;
  /** Чому не вдалося останнє оновлення. */
  readonly error: string | null;
  readonly lists: readonly string[];
}

/** Сайт у списку винятків — хост без www., як його зберігає блокувальник. */
export function adBlockSite(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Блокувальник реклами, спільний для всіх вікон: налаштування й списки фільтрів живуть у Rust
 * (server/src/adblock.rs), а нові стани приходять подією adblock://status. Поза Tauri його немає (`status` — null).
 */
@Injectable({ providedIn: 'root' })
export class AdBlockStore {
  /** Блокувальник є лише в застосунку (Tauri), а не у звичайному браузері. */
  readonly available = isTauri();

  protected readonly state = signal<AdBlockStatus | null>(null);
  readonly status = this.state.asReadonly();
  /** Застосунок не відповів на запит стану — скажімо, інтерфейс новіший за запущену збірку. */
  protected readonly failure = signal(false);
  readonly failed = this.failure.asReadonly();

  constructor() {
    if (this.available) {
      void listen<AdBlockStatus>('adblock://status', ({ payload }) => this.state.set(payload));
      commands.adblockStatus().then(
        (status) => this.state.set(status),
        () => this.failure.set(true)
      );
    }
  }

  /** Виняток для сайту з хостом `host`: його власний чи ширшого домену (example.com для news.example.com). */
  isSiteDisabled(host: string): boolean {
    const site = adBlockSite(host);
    return (this.state()?.disabledSites ?? []).some((disabled) => site === disabled || site.endsWith(`.${disabled}`));
  }

  /** Чи блокується реклама на сайті: блокувальник увімкнено й для сайту немає винятку. */
  blocksOn(host: string): boolean {
    return !!this.state()?.enabled && !this.isSiteDisabled(host);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await commands.adblockSetEnabled(enabled);
  }

  /** Відкриті сторінки сайту побачать зміну після перезавантаження. */
  async setSiteEnabled(host: string, enabled: boolean): Promise<void> {
    await commands.adblockSetSiteEnabled(adBlockSite(host), enabled);
  }

  /** Завантажує свіжі списки фільтрів зараз, не чекаючи планового оновлення. */
  async update(): Promise<void> {
    await commands.adblockUpdate();
  }
}
