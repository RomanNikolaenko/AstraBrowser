import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { accountSignal } from '../../shared/storage/stored-signal';
import { FaviconStore } from './favicons';

export interface HistoryEntry {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly visitedAt: number;
}

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly items = accountSignal<readonly HistoryEntry[]>('astra.history', []);
  private readonly favicons = inject(FaviconStore);
  private readonly settings = inject(SettingsStore);

  constructor() {
    // Давніші за вибраний у налаштуваннях строк записи прибираються — при запуску й щойно строк змінили.
    effect(() => {
      const days = this.settings.historyDays();
      untracked(() => this.expire(days));
    });
  }

  /** Від найновіших до найстаріших. */
  readonly entries = computed(() => [...this.items()].sort((a, b) => b.visitedAt - a.visitedAt));

  /** Запис відвідування; повертає id, щоб потім оновити назву, коли сайт повідомить свій заголовок. */
  record(url: string, title: string, visitedAt = Date.now()): string {
    const id = crypto.randomUUID();
    this.items.update((items) => [...items, { id, url, title, visitedAt }]);
    this.expire(this.settings.historyDays());
    return id;
  }

  rename(id: string, title: string): void {
    this.items.update((items) => items.map((item) => (item.id === id ? { ...item, title } : item)));
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  /** Прибирає записи, старші за `days` днів; 0 — історія зберігається завжди. */
  private expire(days: number, now = Date.now()): void {
    if (days <= 0) {
      return;
    }
    const oldest = now - days * 86_400_000;
    if (this.items().some((item) => item.visitedAt < oldest)) {
      this.items.update((items) => items.filter((item) => item.visitedAt >= oldest));
    }
  }

  /** Записи, відвідані від `since` (мс); 0 — уся історія. */
  removeSince(since: number): void {
    if (since <= 0) {
      this.clear();
    } else {
      this.items.update((items) => items.filter((item) => item.visitedAt < since));
    }
  }

  clear(): void {
    this.items.set([]);
    // Збережені іконки теж видають, які сайти відкривали.
    this.favicons.clear();
  }
}
