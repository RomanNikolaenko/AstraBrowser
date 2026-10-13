import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { accountSignal } from '../../shared/storage/stored-signal';
import { FaviconStore } from './favicons';

/**
 * Найбільше записів історії — навіть коли строк «Завжди». Історія лежить у localStorage одним записом: без межі вона
 * росла б, доки не переповнила сховище, а кожне відвідування перезаписувало б мегабайти.
 */
export const HISTORY_LIMIT = 10_000;

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
      untracked(() => this.trim(days));
    });
  }

  /** Від найновіших до найстаріших. */
  readonly entries = computed(() => [...this.items()].sort((a, b) => b.visitedAt - a.visitedAt));

  /** Запис відвідування; повертає id, щоб потім оновити назву, коли сайт повідомить свій заголовок. */
  record(url: string, title: string, visitedAt = Date.now()): string {
    const id = crypto.randomUUID();
    this.items.update((items) => [...items, { id, url, title, visitedAt }]);
    this.trim(this.settings.historyDays());
    return id;
  }

  rename(id: string, title: string): void {
    this.items.update((items) => items.map((item) => (item.id === id ? { ...item, title } : item)));
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  /** Прибирає записи, старші за `days` днів (0 — без строку), і найдавніші понад HISTORY_LIMIT. */
  private trim(days: number, now = Date.now()): void {
    const items = this.items();
    const oldest = days > 0 ? now - days * 86_400_000 : -Infinity;
    let kept = items.some((item) => item.visitedAt < oldest) ? items.filter((item) => item.visitedAt >= oldest) : items;
    if (kept.length > HISTORY_LIMIT) {
      kept = [...kept].sort((a, b) => a.visitedAt - b.visitedAt).slice(-HISTORY_LIMIT);
    }
    if (kept !== items) {
      this.items.set(kept);
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
