import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';
import { canZoomIn, canZoomOut, zoomIn, zoomOut } from '../zoom';

interface MenuItem {
  readonly label: string;
  readonly icon: string;
  readonly shortcut?: string;
  /** Для aria-keyshortcuts — лише ті скорочення, що справді працюють. */
  readonly keys?: string;
  readonly action?: 'new-tab' | 'reopen-tab' | 'new-window' | 'private-window' | 'find' | 'print';
  /** Внутрішня сторінка, яку відкриває пункт. */
  readonly page?: InternalPage;
}

/** Головне меню браузера (кнопка ☰): кожен пункт або виконує дію (action), або відкриває сторінку (page). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon],
  selector: 'app-browser-menu',
  styleUrl: './browser-menu.scss',
  templateUrl: './browser-menu.html',
})
export class BrowserMenu {
  readonly zoom = model(100);
  /** Є закрита вкладка, яку можна відкрити знову. */
  readonly canReopenTab = input(false);
  readonly newTab = output();
  readonly reopenTab = output();
  readonly newWindow = output();
  readonly privateWindow = output();
  readonly openPage = output<InternalPage>();
  readonly find = output();
  readonly print = output();
  readonly fullscreen = output();

  protected readonly sections: readonly (readonly MenuItem[])[] = [
    [
      { label: 'Нова вкладка', icon: 'tab-plus', shortcut: 'Ctrl+T', keys: 'Control+T', action: 'new-tab' },
      {
        label: 'Відновити закриту вкладку',
        icon: 'tab-restore',
        shortcut: 'Ctrl+Shift+T',
        keys: 'Control+Shift+T',
        action: 'reopen-tab',
      },
      { label: 'Нове вікно', icon: 'window', shortcut: 'Ctrl+N', keys: 'Control+N', action: 'new-window' },
      { label: 'Приватне вікно', icon: 'private', shortcut: 'Ctrl+Shift+N', keys: 'Control+Shift+N', action: 'private-window' },
    ],
    [
      { label: 'Історія', icon: 'clock', page: 'history' },
      { label: 'Завантаження', icon: 'download', shortcut: 'Ctrl+J', keys: 'Control+J', page: 'downloads' },
      { label: 'Закладки', icon: 'star', page: 'bookmarks' },
    ],
    [
      { label: 'Знайти на сторінці', icon: 'search', shortcut: 'Ctrl+F', keys: 'Control+F', action: 'find' },
      { label: 'Друк', icon: 'print', shortcut: 'Ctrl+P', keys: 'Control+P', action: 'print' },
    ],
    [
      { label: 'Розширення', icon: 'puzzle', page: 'extensions' },
      { label: 'Налаштування', icon: 'settings', page: 'settings' },
    ],
    [{ label: 'Довідка', icon: 'help', page: 'help' }],
  ];

  /** Рядок масштабу стоїть перед секцією з цим індексом. */
  protected readonly zoomSectionIndex = 2;

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
      case 'reopen-tab':
        this.reopenTab.emit();
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
