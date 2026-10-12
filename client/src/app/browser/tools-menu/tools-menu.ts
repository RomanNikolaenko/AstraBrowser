import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';
import { tr, TranslatePipe } from '../../shared/i18n/i18n';

/** Інструмент, що не є сторінкою: його відкриває сам браузер. */
export type ToolAction = 'translate' | 'screenshot';

interface Tool {
  readonly label: string;
  readonly icon: string;
  readonly page?: InternalPage;
  readonly action?: ToolAction;
  /** Гаряча клавіша — у підказці плитки. */
  readonly shortcut?: string;
}

/** Панель інструментів (кнопка-сітка): внутрішня сторінка чи інструмент браузера (перекладач, скріншот). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, Popover, UiIcon],
  selector: 'app-tools-menu',
  styleUrl: './tools-menu.scss',
  templateUrl: './tools-menu.html',
})
export class ToolsMenu {
  readonly openPage = output<InternalPage>();
  readonly runAction = output<ToolAction>();

  protected readonly tools: readonly Tool[] = [
    { label: tr('Завантаження'), icon: 'download', page: 'downloads', shortcut: 'Ctrl+J' },
    { label: tr('Історія'), icon: 'clock', page: 'history' },
    { label: tr('Закладки'), icon: 'star', page: 'bookmarks' },
    { label: tr('Паролі'), icon: 'key', page: 'passwords' },
    { label: tr('Розширення'), icon: 'puzzle', page: 'extensions' },
    { label: tr('Нотатки'), icon: 'notes', page: 'notes' },
    { label: tr('Перекладач'), icon: 'translate', action: 'translate' },
    { label: tr('Скріншот'), icon: 'crop', action: 'screenshot', shortcut: 'Ctrl+Shift+S' },
    { label: tr('Налаштування'), icon: 'settings', page: 'settings' },
  ];

  protected run(tool: Tool): void {
    if (tool.page) {
      this.openPage.emit(tool.page);
    } else if (tool.action) {
      this.runAction.emit(tool.action);
    }
  }
}
