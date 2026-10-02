import { Injectable, computed } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

export interface DownloadEntry {
  readonly id: string;
  readonly fileName: string;
  readonly url: string;
  /** Розмір у байтах. */
  readonly size: number;
  readonly status: 'completed' | 'failed';
  readonly finishedAt: number;
}

@Injectable({ providedIn: 'root' })
export class DownloadsStore {
  private readonly items = storedSignal<readonly DownloadEntry[]>('astra.downloads', []);

  /** Від найновіших до найстаріших. */
  readonly entries = computed(() => [...this.items()].sort((a, b) => b.finishedAt - a.finishedAt));

  /** Запис завершеного завантаження. Викликатиметься, щойно браузер навчиться завантажувати файли. */
  add(download: Omit<DownloadEntry, 'id'>): void {
    this.items.update((items) => [...items, { ...download, id: crypto.randomUUID() }]);
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    this.items.set([]);
  }
}
