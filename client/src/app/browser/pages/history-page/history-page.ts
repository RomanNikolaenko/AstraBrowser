import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { HistoryStore } from '../../data/history';
import { SiteIcon } from '../../site-icon/site-icon';
import { formatTime, groupByDay, hostname, matchesQuery } from '../internal-pages';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SiteIcon, UiIcon, UiInput],
  selector: 'app-history-page',
  styleUrls: ['../internal-page.scss'],
  templateUrl: './history-page.html',
})
export class HistoryPage {
  protected readonly history = inject(HistoryStore);

  protected readonly query = signal('');
  protected readonly confirmingClear = signal(false);

  protected readonly groups = computed(() => {
    const query = this.query();
    const entries = this.history.entries().filter((entry) => matchesQuery(query, entry.title, entry.url));
    return groupByDay(entries, (entry) => entry.visitedAt);
  });

  protected readonly formatTime = formatTime;
  protected readonly hostname = hostname;

  protected isoTime(time: number): string {
    return new Date(time).toISOString();
  }

  protected clear(): void {
    this.history.clear();
    this.confirmingClear.set(false);
  }
}
