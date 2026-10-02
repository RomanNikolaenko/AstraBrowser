import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { DownloadsStore } from '../../data/downloads';
import { formatSize, formatTime, groupByDay, hostname, matchesQuery } from '../internal-pages';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiInput],
  selector: 'app-downloads-page',
  styleUrls: ['../internal-page.scss'],
  templateUrl: './downloads-page.html',
})
export class DownloadsPage {
  protected readonly downloads = inject(DownloadsStore);

  protected readonly query = signal('');
  protected readonly confirmingClear = signal(false);

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

  protected clear(): void {
    this.downloads.clear();
    this.confirmingClear.set(false);
  }
}
