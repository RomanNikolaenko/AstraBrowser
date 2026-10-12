import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { MiddleClick } from '../../../shared/middle-click/middle-click';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { ClearDataDialog } from '../../clear-data/clear-data-dialog';
import { HistoryStore } from '../../data/history';
import { SiteIcon } from '../../site-icon/site-icon';
import { formatTime, groupByDay, hostname, matchesQuery } from '../internal-pages';
import { TranslatePipe } from '../../../shared/i18n/i18n';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ClearDataDialog, MiddleClick, SiteIcon, UiIcon, UiInput],
  selector: 'app-history-page',
  styleUrls: ['../internal-page.scss'],
  templateUrl: './history-page.html',
})
export class HistoryPage {
  /** Клік по запису — сторінка в цій вкладці, коліщатком — у новій. */
  readonly openUrl = output<string>();
  readonly openUrlInNewTab = output<string>();

  protected readonly history = inject(HistoryStore);

  protected readonly query = signal('');

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
}
