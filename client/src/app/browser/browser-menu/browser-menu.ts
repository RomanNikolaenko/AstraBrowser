import { ChangeDetectionStrategy, Component, computed, model, output } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';

interface MenuItem {
  readonly label: string;
  readonly icon: string;
  readonly shortcut?: string;
  /** Для aria-keyshortcuts — лише ті скорочення, що справді працюють. */
  readonly keys?: string;
  readonly action?: 'new-tab' | 'new-window' | 'private-window' | 'find' | 'print' | 'sign-out';
  /** Внутрішня сторінка, яку відкриває пункт. */
  readonly page?: InternalPage;
}

// Ті самі кроки масштабу, що й у Chrome.
const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

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
  readonly newTab = output();
  readonly newWindow = output();
  readonly privateWindow = output();
  readonly openPage = output<InternalPage>();
  readonly find = output();
  readonly print = output();
  readonly signOut = output();
  readonly fullscreen = output();

  protected readonly sections: readonly (readonly MenuItem[])[] = [
    [
      { label: 'Нова вкладка', icon: 'tab-plus', shortcut: 'Ctrl+T', keys: 'Control+T', action: 'new-tab' },
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
    [{ label: 'Вийти', icon: 'logout', action: 'sign-out' }],
  ];

  /** Рядок масштабу стоїть перед секцією з цим індексом. */
  protected readonly zoomSectionIndex = 2;

  protected readonly canZoomOut = computed(() => this.zoom() > ZOOM_LEVELS[0]);
  protected readonly canZoomIn = computed(() => this.zoom() < ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);

  protected zoomIn(): void {
    this.zoom.set(ZOOM_LEVELS.find((level) => level > this.zoom()) ?? this.zoom());
  }

  protected zoomOut(): void {
    this.zoom.set([...ZOOM_LEVELS].reverse().find((level) => level < this.zoom()) ?? this.zoom());
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
      case 'sign-out':
        this.signOut.emit();
        break;
    }
  }
}
