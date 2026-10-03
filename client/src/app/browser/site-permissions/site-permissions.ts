import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiSelect, UiSelectOption } from '../../shared/ui-select/ui-select';
import { AutoplayStore } from '../data/autoplay';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';

type AutoplayChoice = 'allow' | 'block-audio' | 'block';

/**
 * Панель дозволів сайту з кнопки на початку адресного рядка.
 * Дозволи зберігає профіль WebView2 для origin сторінки, тож вони діють у всіх вкладках цього сайту.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon, UiSelect],
  selector: 'app-site-permissions',
  styleUrl: './site-permissions.scss',
  templateUrl: './site-permissions.html',
})
export class SitePermissions {
  /** Webview сайту, дозволи якого показуються. */
  readonly page = input.required<string>();
  readonly pageUrl = input.required<string>();

  private readonly pageViews = inject(PageViews);
  private readonly autoplayRules = inject(AutoplayStore);

  private readonly origin = computed(() => {
    try {
      return new URL(this.pageUrl()).origin;
    } catch {
      return '';
    }
  });
  protected readonly host = computed(() => {
    try {
      return new URL(this.pageUrl()).host;
    } catch {
      return this.pageUrl();
    }
  });

  /** null — дозвіл ще читається. */
  protected readonly autoplay = signal<AutoplayChoice | null>(null);
  /** Дозвіл змінено, а сторінка ще працює зі старим. */
  protected readonly changed = signal(false);

  // «Блокувати аудіо та відео» — заборона в самому WebView2, «Блокувати аудіо» — наш скрипт (server/src/audio.rs).
  protected readonly choices: readonly UiSelectOption<AutoplayChoice>[] = [
    { value: 'allow', label: 'Дозволити аудіо та відео' },
    { value: 'block-audio', label: 'Блокувати аудіо' },
    { value: 'block', label: 'Блокувати аудіо та відео' },
  ];

  private readonly popover = viewChild.required(Popover);

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

  protected async onOpened(): Promise<void> {
    this.changed.set(false);
    this.autoplay.set(null);
    const permission = await this.pageViews.autoplay(this.page()).catch(() => 'default');
    // За замовчуванням автовідтворення заборонене (server/src/webview2.rs, block_autoplay_by_default):
    // дозволене — лише те, що дозволив сам користувач.
    if (permission !== 'allow') {
      this.autoplay.set('block');
    } else {
      this.autoplay.set(this.autoplayRules.blocksAudio(this.origin()) ? 'block-audio' : 'allow');
    }
  }

  protected async setAutoplay(choice: AutoplayChoice | undefined): Promise<void> {
    if (!choice) {
      return;
    }
    const previous = this.autoplay();
    this.autoplay.set(choice);
    try {
      // «Блокувати аудіо» — відео дозволене WebView2, а звук глушить наш скрипт (server/src/audio.rs).
      await this.pageViews.setAutoplay(this.page(), choice === 'block' ? 'block' : 'allow');
      this.autoplayRules.setBlockAudio(this.origin(), choice === 'block-audio');
      this.changed.set(true);
    } catch {
      this.autoplay.set(previous);
    }
  }

  protected reload(): void {
    this.popover().hide();
    void this.pageViews.reload(this.page()).catch(() => undefined);
  }
}
