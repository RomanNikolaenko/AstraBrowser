import { Injectable, computed, inject } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';
import { FaviconStore } from './favicons';

export interface HistoryEntry {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly visitedAt: number;
}

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly items = storedSignal<readonly HistoryEntry[]>('astra.history', []);
  private readonly favicons = inject(FaviconStore);

  /** Від найновіших до найстаріших. */
  readonly entries = computed(() => [...this.items()].sort((a, b) => b.visitedAt - a.visitedAt));

  /** Запис відвідування; повертає id, щоб потім оновити назву, коли сайт повідомить свій заголовок. */
  record(url: string, title: string, visitedAt = Date.now()): string {
    const id = crypto.randomUUID();
    this.items.update((items) => [...items, { id, url, title, visitedAt }]);
    return id;
  }

  rename(id: string, title: string): void {
    this.items.update((items) => items.map((item) => (item.id === id ? { ...item, title } : item)));
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    this.items.set([]);
    // Збережені іконки теж видають, які сайти відкривали.
    this.favicons.clear();
  }
}
