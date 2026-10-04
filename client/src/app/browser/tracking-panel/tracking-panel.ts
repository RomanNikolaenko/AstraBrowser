import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiSwitch } from '../../shared/ui-switch/ui-switch';
import { ConfirmDialog } from '../confirm-dialog/confirm-dialog';
import { BlockedTracker, TRACKER_CATEGORIES, TrackingStore } from '../data/tracking';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';

const plural = new Intl.PluralRules('uk');
const ELEMENTS: Record<string, string> = { one: 'елемент', few: 'елементи', many: 'елементів', other: 'елемента' };

/**
 * Панель «Захист від стеження» з кнопки-щита на початку адресного рядка, як у Firefox: чи захищене з'єднання,
 * скільки елементів стеження заблоковано на сайті і які саме, захист для цього сайту, «Стерти файли cookie та дані
 * сайту» й налаштування приватності. Саме блокування — server/src/tracking.rs.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, Popover, UiIcon, UiSwitch],
  selector: 'app-tracking-panel',
  styleUrl: './tracking-panel.scss',
  templateUrl: './tracking-panel.html',
})
export class TrackingPanel {
  /** Webview сайту, про який панель. */
  readonly page = input.required<string>();
  readonly pageUrl = input.required<string>();
  /** Що заблоковано на поточній сторінці. */
  readonly trackers = input.required<readonly BlockedTracker[]>();
  readonly openSettings = output<void>();

  private readonly tracking = inject(TrackingStore);
  private readonly settings = inject(SettingsStore);
  private readonly pageViews = inject(PageViews);
  private readonly popover = viewChild.required(Popover);

  protected readonly host = computed(() => {
    try {
      return new URL(this.pageUrl()).hostname;
    } catch {
      return this.pageUrl();
    }
  });
  protected readonly secure = computed(() => this.pageUrl().startsWith('https:'));
  protected readonly level = this.settings.trackingProtection;
  protected readonly protectedSite = computed(() => this.tracking.protects(this.pageUrl()));
  /** «Показати все» — список заблокованого за категоріями. */
  protected readonly expanded = signal(false);
  protected readonly groups = computed(() =>
    TRACKER_CATEGORIES.map((category) => ({
      ...category,
      hosts: this.trackers()
        .filter((tracker) => tracker.category === category.category)
        .map((tracker) => tracker.host),
    })).filter((group) => group.hosts.length)
  );
  protected readonly count = computed(() => {
    const count = this.trackers().length;
    return count
      ? `${count} ${ELEMENTS[plural.select(count)]} стеження заблоковано на цьому сайті`
      : 'Елементів стеження на цьому сайті не знайдено';
  });

  constructor() {
    // Панель про конкретний сайт: інша вкладка чи інший сайт — закриваємо.
    effect(() => {
      this.page();
      this.host();
      untracked(() => {
        if (this.popover().isOpen()) {
          this.popover().hide();
        }
      });
    });
  }

  protected onOpened(): void {
    this.expanded.set(false);
  }

  /** Захист для сайту змінився — сторінка перезавантажується, як у Firefox, щоб він подіяв на все, що вже завантажено. */
  protected setProtected(enabled: boolean): void {
    this.tracking.setProtected(this.pageUrl(), enabled);
    void this.pageViews.reload(this.page()).catch(() => undefined);
  }

  protected clearSiteData(): void {
    this.popover().hide();
    void this.pageViews.reloadWith(this.page(), 'all').catch(() => undefined);
  }
}
