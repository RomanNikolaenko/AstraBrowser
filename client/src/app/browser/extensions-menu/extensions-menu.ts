import { ChangeDetectionStrategy, Component, computed, inject, input, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { AdBlockPanel } from '../adblock-panel/adblock-panel';
import { AdBlockStore } from '../data/adblock';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';
import { translate, TranslatePipe } from '../../shared/i18n/i18n';

/**
 * Меню розширень з кнопки-пазла на панелі інструментів, як у Chrome: список розширень (поки — блокувальник
 * реклами) з коротким станом. Клік по розширенню відкриває його панель, «⋯» — швидкі дії з ним,
 * а «Керувати розширеннями» — сторінку розширень.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, AdBlockPanel, Popover, UiIcon],
  selector: 'app-extensions-menu',
  styleUrl: './extensions-menu.scss',
  templateUrl: './extensions-menu.html',
})
export class ExtensionsMenu {
  /** Кнопка-пазл: під нею відкривається й панель розширення. */
  readonly anchor = input.required<HTMLElement>();
  /** Webview сайту в активній вкладці; null — у вкладці не сайт. */
  readonly page = input<string | null>(null);
  readonly pageUrl = input('');
  /** Скільки запитів заблоковано на поточній сторінці. */
  readonly blocked = input(0);

  /** «Керувати розширеннями» — сторінка розширень. */
  readonly openSettings = output<void>();

  protected readonly adblock = inject(AdBlockStore);
  private readonly pageViews = inject(PageViews);
  private readonly menu = viewChild.required<Popover>('menu');
  private readonly panel = viewChild.required(AdBlockPanel);

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
  /** Блокувальник працює тут: на сайті вкладки чи, без сайту, взагалі. */
  protected readonly active = computed(() =>
    this.host() ? this.adblock.blocksOn(this.host()) : !!this.adblock.status()?.enabled
  );

  /** Рядок під назвою розширення. */
  protected readonly state = computed(() => {
    const status = this.adblock.status();
    if (!status) {
      return translate('Працює лише в застосунку Astra Browser');
    }
    if (!status.enabled) {
      return translate('Вимкнено');
    }
    if (!status.ready) {
      return status.updating ? translate('Завантаження списків фільтрів…') : translate('Списки фільтрів ще не завантажено');
    }
    if (!this.host()) {
      return translate('Прибирає рекламу й трекери на сайтах');
    }
    if (!this.active()) {
      return translate('Вимкнено на цьому сайті');
    }
    return this.blocked()
      ? translate('Заблоковано на цій сторінці: {0}', [this.blocked()])
      : translate('Блокує рекламу на цьому сайті');
  });

  protected openAdBlock(): void {
    this.menu().hide();
    this.panel().show(this.anchor());
  }

  /** Вмикає чи вимикає блокування на сайті вкладки й перезавантажує сторінку. */
  protected toggleSite(): void {
    this.menu().hide();
    void this.adblock
      .setSiteEnabled(this.host(), !this.active())
      .then(() => this.reload())
      .catch(() => undefined);
  }

  protected toggleEnabled(): void {
    this.menu().hide();
    void this.adblock
      .setEnabled(!this.adblock.status()?.enabled)
      .then(() => this.reload())
      .catch(() => undefined);
  }

  protected manage(): void {
    this.menu().hide();
    this.openSettings.emit();
  }

  private reload(): void {
    const page = this.page();
    if (page) {
      void this.pageViews.reload(page).catch(() => undefined);
    }
  }
}
