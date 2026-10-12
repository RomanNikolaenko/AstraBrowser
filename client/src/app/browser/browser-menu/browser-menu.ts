import { ChangeDetectionStrategy, Component, computed, inject, model, output } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UpdateStore } from '../data/updates';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';
import { canZoomIn, canZoomOut, zoomIn, zoomOut } from '../zoom';
import { tr, translate, TranslatePipe } from '../../shared/i18n/i18n';

interface MenuItem {
  readonly label: string;
  readonly icon: string;
  readonly shortcut?: string;
  /** Для aria-keyshortcuts — лише ті скорочення, що справді працюють. */
  readonly keys?: string;
  readonly action?: 'new-tab' | 'new-window' | 'private-window' | 'find' | 'print';
  /** Внутрішня сторінка, яку відкриває пункт. */
  readonly page?: InternalPage;
}

/**
 * Головне меню браузера (кнопка ☰): кожен пункт або виконує дію (action), або відкриває сторінку (page).
 * Останній — оновлення застосунку: доступне, лише коли вийшла новіша версія.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, Popover, UiIcon],
  selector: 'app-browser-menu',
  styleUrl: './browser-menu.scss',
  templateUrl: './browser-menu.html',
})
export class BrowserMenu {
  readonly zoom = model(100);
  readonly newTab = output();
  readonly newWindow = output();
  readonly privateWindow = output();
  readonly openPage = output<InternalPage>();
  readonly find = output();
  readonly print = output();
  readonly fullscreen = output();

  protected readonly sections: readonly (readonly MenuItem[])[] = [
    [
      { label: tr('Нова вкладка'), icon: 'tab-plus', shortcut: 'Ctrl+T', keys: 'Control+T', action: 'new-tab' },
      { label: tr('Нове вікно'), icon: 'window', shortcut: 'Ctrl+N', keys: 'Control+N', action: 'new-window' },
      {
        label: tr('Приватне вікно'),
        icon: 'private',
        shortcut: 'Ctrl+Shift+N',
        keys: 'Control+Shift+N',
        action: 'private-window',
      },
    ],
    [
      { label: tr('Історія'), icon: 'clock', page: 'history' },
      { label: tr('Завантаження'), icon: 'download', shortcut: 'Ctrl+J', keys: 'Control+J', page: 'downloads' },
      { label: tr('Закладки'), icon: 'star', page: 'bookmarks' },
    ],
    [
      { label: tr('Знайти на сторінці'), icon: 'search', shortcut: 'Ctrl+F', keys: 'Control+F', action: 'find' },
      { label: tr('Друк'), icon: 'print', shortcut: 'Ctrl+P', keys: 'Control+P', action: 'print' },
    ],
    [
      { label: tr('Розширення'), icon: 'puzzle', page: 'extensions' },
      { label: tr('Налаштування'), icon: 'settings', page: 'settings' },
    ],
    [{ label: tr('Довідка'), icon: 'help', page: 'help' }],
  ];

  /** Рядок масштабу стоїть перед секцією з цим індексом. */
  protected readonly zoomSectionIndex = 2;

  protected readonly updates = inject(UpdateStore);
  protected readonly updateLabel = computed(() =>
    this.updates.installing() ? translate('Оновлюємо Astra Browser…') : translate('Оновити Astra Browser')
  );
  /** Підказка до пункту оновлення: що станеться чи чому він вимкнений. */
  protected readonly updateTitle = computed(() => {
    const update = this.updates.available();
    const error = this.updates.error();
    if (error) {
      return error;
    }
    if (this.updates.installing()) {
      return translate('Завантажуємо й встановлюємо оновлення — браузер перезапуститься з тими самими вкладками');
    }
    if (update) {
      return translate('Встановити версію {0}', [update.version]) + (update.notes ? `: ${update.notes}` : '');
    }
    const current = this.updates.current();
    return current ? translate('Оновлень немає — у вас найновіша версія {0}', [current]) : translate('Оновлень немає');
  });

  protected readonly canZoomOut = computed(() => canZoomOut(this.zoom()));
  protected readonly canZoomIn = computed(() => canZoomIn(this.zoom()));

  protected zoomIn(): void {
    this.zoom.set(zoomIn(this.zoom()));
  }

  protected zoomOut(): void {
    this.zoom.set(zoomOut(this.zoom()));
  }

  protected run(item: MenuItem): void {
    if (item.page) {
      this.openPage.emit(item.page);
      return;
    }

    switch (item.action) {
      case 'new-tab':
        this.newTab.emit();
        break;
      case 'new-window':
        this.newWindow.emit();
        break;
      case 'private-window':
        this.privateWindow.emit();
        break;
      case 'find':
        this.find.emit();
        break;
      case 'print':
        this.print.emit();
        break;
    }
  }
}
