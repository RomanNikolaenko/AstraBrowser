import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import { UiSwitch } from '../../shared/ui-switch/ui-switch';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { AdBlockStore } from '../data/adblock';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';

const plural = new Intl.PluralRules('uk');
const REQUESTS: Record<string, string> = { one: 'запит', few: 'запити', many: 'запитів', other: 'запиту' };

/**
 * Панель блокувальника реклами — з меню розширень на панелі інструментів (як спливне вікно розширення в Chrome):
 * скільки заблоковано на сторінці й чи блокувати рекламу на цьому сайті. Зміна одразу перезавантажує
 * сторінку — інакше вона не подіє. Без сайту у вкладці — лише стан блокувальника.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon, UiSwitch],
  selector: 'app-adblock-panel',
  styleUrl: './adblock-panel.scss',
  templateUrl: './adblock-panel.html',
})
export class AdBlockPanel {
  /** Webview сайту в активній вкладці; null — у вкладці не сайт. */
  readonly page = input<string | null>(null);
  readonly pageUrl = input('');
  /** Скільки запитів заблоковано на поточній сторінці. */
  readonly blocked = input(0);

  /** «Налаштування блокувальника» — сторінка розширень. */
  readonly openSettings = output<void>();

  protected readonly adblock = inject(AdBlockStore);
  private readonly pageViews = inject(PageViews);
  private readonly popover = viewChild.required(Popover);

  protected readonly host = computed(() => {
    if (!this.page()) {
      return '';
    }
    try {
      return new URL(this.pageUrl()).hostname;
    } catch {
      return '';
    }
  });
  protected readonly active = computed(() =>
    this.host() ? this.adblock.blocksOn(this.host()) : !!this.adblock.status()?.enabled
  );
  protected readonly requests = computed(() => REQUESTS[plural.select(this.blocked())]);

  constructor() {
    // Панель про конкретну сторінку: інша вкладка чи інший сайт — закриваємо.
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

  /** Відкривається з меню розширень — під кнопкою, що його відкрила. */
  show(anchor: HTMLElement): void {
    this.popover().show({ anchor });
  }

  protected async setSiteEnabled(enabled: boolean): Promise<void> {
    try {
      await this.adblock.setSiteEnabled(this.host(), enabled);
      this.reload();
    } catch {
      // Перемикач лишається як був: стан не змінився.
    }
  }

  protected async enable(): Promise<void> {
    await this.adblock.setEnabled(true).catch(() => undefined);
    this.reload();
  }

  protected showSettings(): void {
    this.popover().hide();
    this.openSettings.emit();
  }

  private reload(): void {
    const page = this.page();
    if (page) {
      void this.pageViews.reload(page).catch(() => undefined);
    }
  }
}
