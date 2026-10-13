import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MiddleClick } from '../../../shared/middle-click/middle-click';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { ClearDataDialog } from '../../clear-data/clear-data-dialog';
import { HistoryStore } from '../../data/history';
import { SiteIcon } from '../../site-icon/site-icon';
import { formatTime, groupByDay, hostname, matchesQuery } from '../internal-pages';
import { TranslatePipe } from '../../../shared/i18n/i18n';

/** Скільки записів показувати за раз: їх можуть бути тисячі, а кожен рядок — це іконка, назва й кнопки. */
const STEP = 200;

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
  /** Скільки записів зараз показано; наступна порція — щойно прокрутили до кінця списку. */
  private readonly shown = signal(STEP);
  private readonly matching = computed(() => {
    const query = this.query();
    return this.history.entries().filter((entry) => matchesQuery(query, entry.title, entry.url));
  });

  protected readonly groups = computed(() => groupByDay(this.matching().slice(0, this.shown()), (entry) => entry.visitedAt));
  protected readonly hasMore = computed(() => this.matching().length > this.shown());
  private readonly end = viewChild<ElementRef<HTMLElement>>('end');

  constructor() {
    // Новий пошук — знову з першої порції.
    effect(() => {
      this.query();
      untracked(() => this.shown.set(STEP));
    });
    // Кінець списку видно — ще порція. Спостерігач новий після кожної порції: якщо кінець усе ще видно (великий
    // екран), він одразу скаже про це, і додасться наступна.
    effect((onCleanup) => {
      const end = this.end()?.nativeElement;
      this.shown();
      if (!end || typeof IntersectionObserver === 'undefined') {
        return;
      }
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.shown.update((count) => count + STEP);
        }
      });
      observer.observe(end);
      onCleanup(() => observer.disconnect());
    });
  }

  protected readonly formatTime = formatTime;
  protected readonly hostname = hostname;

  protected isoTime(time: number): string {
    return new Date(time).toISOString();
  }
}
