import { Injectable, computed } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

export interface HistoryEntry {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly visitedAt: number;
}

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly items = storedSignal<readonly HistoryEntry[]>('astra.history', []);

  /** Від найновіших до найстаріших. */
  readonly entries = computed(() => [...this.items()].sort((a, b) => b.visitedAt - a.visitedAt));

  /** Запис відвідування. Викликатиметься, щойно браузер навчиться відкривати сайти. */
  record(url: string, title: string, visitedAt = Date.now()): void {
    this.items.update((items) => [...items, { id: crypto.randomUUID(), url, title, visitedAt }]);
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    this.items.set([]);
  }
}
