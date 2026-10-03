import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { DownloadEntry, DownloadsStore } from '../../data/downloads';
import { PageViews } from '../../page-views/page-views';
import { formatSize, formatTime, groupByDay, hostname, matchesQuery } from '../internal-pages';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, UiIcon, UiInput],
  selector: 'app-downloads-page',
  styleUrls: ['../internal-page.scss'],
  templateUrl: './downloads-page.html',
})
export class DownloadsPage {
  protected readonly downloads = inject(DownloadsStore);
  private readonly pageViews = inject(PageViews);

  protected readonly query = signal('');

  protected readonly groups = computed(() => {
    const query = this.query();
    const entries = this.downloads.entries().filter((entry) => matchesQuery(query, entry.fileName, entry.url));
    return groupByDay(entries, (entry) => entry.finishedAt);
  });

  protected readonly formatSize = formatSize;
  protected readonly formatTime = formatTime;
  protected readonly hostname = hostname;

  protected isoTime(time: number): string {
    return new Date(time).toISOString();
  }

  protected percent(received: number, total: number): number {
    return total ? Math.min(100, (received / total) * 100) : 0;
  }

  protected status(entry: DownloadEntry): string {
    switch (entry.status) {
      case 'completed':
        return `Завантажено · ${formatSize(entry.size)} · ${hostname(entry.url)}`;
      case 'canceled':
        return `Скасовано · ${hostname(entry.url)}`;
      case 'failed':
        return `Помилка завантаження · ${hostname(entry.url)}`;
    }
  }

  protected cancel(id: number): void {
    void this.pageViews.cancelDownload(id).catch(() => undefined);
  }

  protected open(entry: DownloadEntry): void {
    if (entry.path) {
      void this.pageViews.openDownload(entry.path).catch(() => undefined);
    }
  }

  /** Показує файл виділеним у його теці (якщо файла вже немає — саму теку), хоч би де він лежав. */
  protected showPath(path: string): void {
    void this.pageViews.showDownload(path).catch(() => undefined);
  }
}
