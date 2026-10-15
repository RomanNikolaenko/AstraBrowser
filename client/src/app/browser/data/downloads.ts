import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { accountSignal } from '../../shared/storage/stored-signal';

/**
 * Найбільше записів у списку завантажень — навіть коли строк «Завжди» (самі файли лишаються на диску). Список лежить у
 * localStorage одним записом: без межі він ріс би з кожним завантаженням, а кожне нове перезаписувало б його весь.
 */
export const DOWNLOADS_LIMIT = 1000;

/** Чим скінчилося завантаження. */
export type DownloadStatus = 'completed' | 'failed' | 'canceled';

export interface DownloadEntry {
  readonly id: string;
  readonly fileName: string;
  readonly url: string;
  /** Розмір у байтах. */
  readonly size: number;
  readonly status: DownloadStatus;
  readonly finishedAt: number;
  /** Де файл на диску; записи попередніх версій його не мають. */
  readonly path?: string;
}

/** Як іде завантаження (server/src/webview2.rs, watch_downloads). */
export interface DownloadProgress {
  /** Номер завантаження в цьому запуску застосунку. */
  readonly id: number;
  readonly url: string;
  readonly path: string;
  readonly fileName: string;
  readonly received: number;
  /** 0 — розмір невідомий. */
  readonly total: number;
  readonly state: 'in-progress' | DownloadStatus;
}

/** Запит «куди зберегти» перед завантаженням (server/src/downloads.rs, PromptEvent). */
export interface DownloadPromptRequest {
  readonly id: number;
  readonly url: string;
  readonly fileName: string;
  /** Тека, куди файл ляже, якщо її не змінити. */
  readonly folder: string;
  /** 0 — розмір невідомий. */
  readonly total: number;
  /** У теці вже є файл із такою назвою: замінити його чи зберегти обидва. */
  readonly exists?: boolean;
}

/** Завантаження, що ще триває. */
export interface ActiveDownload {
  readonly id: number;
  readonly url: string;
  readonly path: string;
  readonly fileName: string;
  readonly received: number;
  readonly total: number;
}

@Injectable({ providedIn: 'root' })
export class DownloadsStore {
  private readonly items = accountSignal<readonly DownloadEntry[]>('astra.downloads', []);
  private readonly settings = inject(SettingsStore);
  private readonly running = signal<readonly ActiveDownload[]>([]);
  private readonly asking = signal<readonly DownloadPromptRequest[]>([]);
  /** Завантаження цього запуску, що вже скінчилися: запізнілі звістки про них нічого не змінюють. */
  private readonly finished = new Set<number>();
  /** Скільки завантажень почалося від запуску — щоб кнопка завантажень кожне помітно позначала. */
  private readonly startedCount = signal(0);
  private readonly sessionStart = Date.now();

  /** Від найновіших до найстаріших. */
  // Серед однакових часів новіше додане — першим (сортування стійке, тож спершу розвертаємо).
  readonly entries = computed(() => [...this.items()].reverse().sort((a, b) => b.finishedAt - a.finishedAt));
  /** Ті, що тривають, — від найновіших. */
  readonly active = computed(() => [...this.running()].reverse());
  /** Завершені від запуску застосунку — з ними на панелі інструментів з'являється кнопка завантажень. */
  readonly recent = computed(() => this.entries().filter((entry) => entry.finishedAt >= this.sessionStart));
  readonly started = this.startedCount.asReadonly();
  /** Завантаження, що чекають на відповідь «куди зберегти», — по черзі. */
  readonly prompts = this.asking.asReadonly();

  constructor() {
    // Давніші за вибраний у налаштуваннях строк записи прибираються — при запуску й щойно строк змінили.
    effect(() => {
      const days = this.settings.downloadsDays();
      untracked(() => this.trim(days));
    });
  }

  ask(request: DownloadPromptRequest): void {
    this.asking.update((prompts) => [...prompts.filter((prompt) => prompt.id !== request.id), request]);
  }

  answerPrompt(id: number): void {
    this.asking.update((prompts) => prompts.filter((prompt) => prompt.id !== id));
  }

  /** Прибирає зі списку все завершене; те, що ще завантажується, лишається. */
  clearFinished(): void {
    this.items.set([]);
  }

  /** Нові відомості про завантаження: те, що триває, оновлюється, а завершене стає записом списку. */
  track(progress: DownloadProgress): void {
    const { id, url, path, fileName, received, total } = progress;
    if (this.finished.has(id)) {
      return;
    }
    if (progress.state === 'in-progress') {
      const known = this.running().some((download) => download.id === id);
      if (!known) {
        this.startedCount.update((count) => count + 1);
      }
      const download: ActiveDownload = { id, url, path, fileName, received, total };
      this.running.update((running) =>
        known ? running.map((item) => (item.id === id ? download : item)) : [...running, download]
      );
      return;
    }
    this.finished.add(id);
    this.running.update((running) => running.filter((download) => download.id !== id));
    this.add({ fileName, url, path, size: received || total, status: progress.state, finishedAt: Date.now() });
  }

  add(download: Omit<DownloadEntry, 'id'>): void {
    this.items.update((items) => [...items, { ...download, id: crypto.randomUUID() }]);
    this.trim(this.settings.downloadsDays());
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    this.items.set([]);
  }

  /** Прибирає записи, старші за `days` днів (0 — без строку), і найдавніші понад DOWNLOADS_LIMIT. */
  private trim(days: number, now = Date.now()): void {
    const items = this.items();
    const oldest = days > 0 ? now - days * 86_400_000 : -Infinity;
    let kept = items.some((item) => item.finishedAt < oldest) ? items.filter((item) => item.finishedAt >= oldest) : items;
    if (kept.length > DOWNLOADS_LIMIT) {
      kept = kept.slice(-DOWNLOADS_LIMIT);
    }
    if (kept !== items) {
      this.items.set(kept);
    }
  }

  /** Записи завантажень, що закінчилися від `since` (мс); самі файли лишаються на диску. */
  removeSince(since: number): void {
    this.items.update((items) => items.filter((item) => item.finishedAt < since));
  }
}
