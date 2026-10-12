import { ChangeDetectionStrategy, Component, computed, inject, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { DownloadSettingsStore } from '../data/download-settings';
import { DownloadStatus, DownloadsStore } from '../data/downloads';
import { PageViews } from '../page-views/page-views';
import { formatSize, hostname } from '../pages/internal-pages';
import { Popover } from '../popover/popover';
import { translate, TranslatePipe } from '../../shared/i18n/i18n';

/** Рядок списку: завантаження, що триває (`active`), чи завершене (`entry`). */
interface DownloadRow {
  readonly key: string;
  readonly fileName: string;
  readonly url: string;
  readonly status: 'in-progress' | DownloadStatus;
  readonly received: number;
  readonly total: number;
  readonly path?: string;
  readonly active?: number;
  readonly entry?: string;
}

/** Скільки завантажень показувати в списку кнопки; решта — на сторінці «Завантаження». */
const ROWS = 6;

/**
 * Кнопка завантажень на панелі інструментів, як у Chrome: з'являється з першим завантаженням,
 * поки щось завантажується, показує загальний поступ колом, а відкрита — список із поступом,
 * скасуванням, «Відкрити» (клік по файлу) і «Показати в теці».
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, Popover, UiIcon],
  selector: 'app-downloads-menu',
  styleUrl: './downloads-menu.scss',
  templateUrl: './downloads-menu.html',
})
export class DownloadsMenu {
  /** «Усі завантаження» — сторінка завантажень. */
  readonly openDownloads = output<void>();

  protected readonly downloads = inject(DownloadsStore);
  protected readonly downloadSettings = inject(DownloadSettingsStore);
  private readonly pageViews = inject(PageViews);
  private readonly popover = viewChild(Popover);

  protected readonly visible = computed(() => this.downloads.active().length > 0 || this.downloads.recent().length > 0);

  protected readonly rows = computed<readonly DownloadRow[]>(() =>
    [
      ...this.downloads.active().map((download) => ({
        key: `active-${download.id}`,
        fileName: download.fileName,
        url: download.url,
        status: 'in-progress' as const,
        received: download.received,
        total: download.total,
        path: download.path,
        active: download.id,
      })),
      ...this.downloads.recent().map((entry) => ({
        key: entry.id,
        fileName: entry.fileName,
        url: entry.url,
        status: entry.status,
        received: entry.size,
        total: entry.size,
        path: entry.path,
        entry: entry.id,
      })),
    ].slice(0, ROWS)
  );

  /** Загальний поступ завантажень, що тривають: від 0 до 1, -1 — невідомий, null — нічого не завантажується. */
  protected readonly progress = computed(() => {
    const active = this.downloads.active();
    if (!active.length) {
      return null;
    }
    if (active.some((download) => !download.total)) {
      return -1;
    }
    const total = active.reduce((sum, download) => sum + download.total, 0);
    return active.reduce((sum, download) => sum + download.received, 0) / total;
  });

  protected readonly label = computed(() => {
    const count = this.downloads.active().length;
    return count ? translate('Завантаження: триває {0}', [count]) : translate('Завантаження');
  });

  protected describe(row: DownloadRow): string {
    switch (row.status) {
      case 'in-progress':
        return row.total ? translate('{0} з {1}', [formatSize(row.received), formatSize(row.total)]) : formatSize(row.received);
      case 'completed':
        return translate('Завантажено · {0} · {1}', [formatSize(row.received), hostname(row.url)]);
      case 'canceled':
        return translate('Скасовано');
      case 'failed':
        return translate('Помилка завантаження');
    }
  }

  protected percent(row: DownloadRow): number {
    return row.total ? Math.min(100, (row.received / row.total) * 100) : 0;
  }

  protected open(row: DownloadRow): void {
    if (row.path) {
      this.popover()?.hide();
      void this.pageViews.openDownload(row.path).catch(() => undefined);
    }
  }

  protected show(row: DownloadRow): void {
    if (row.path) {
      void this.pageViews.showDownload(row.path).catch(() => undefined);
    }
  }

  protected cancel(row: DownloadRow): void {
    if (row.active !== undefined) {
      void this.pageViews.cancelDownload(row.active).catch(() => undefined);
    }
  }

  protected clear(): void {
    this.popover()?.hide();
    this.downloads.clearFinished();
  }

  protected remove(row: DownloadRow): void {
    if (row.entry) {
      // Останній запис — кнопка зникне, тож панель закриваємо заздалегідь.
      if (this.rows().length === 1) {
        this.popover()?.hide();
      }
      this.downloads.remove(row.entry);
    }
  }

  protected openFolder(): void {
    this.popover()?.hide();
    void this.downloadSettings.openFolder().catch(() => undefined);
  }

  protected showAll(): void {
    this.popover()?.hide();
    this.openDownloads.emit();
  }
}
