import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { InternalPage } from '../pages/internal-pages';

interface Tool {
  readonly label: string;
  readonly icon: string;
  readonly page?: InternalPage;
}

/** Панель інструментів (кнопка-сітка). Інструменти без page поки лише закривають панель. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-tools-menu',
  styleUrl: './tools-menu.scss',
  templateUrl: './tools-menu.html',
  host: {
    '[class.is-open]': 'open()',
  },
})
export class ToolsMenu {
  readonly openPage = output<InternalPage>();

  protected readonly open = signal(false);

  protected readonly tools: readonly Tool[] = [
    { label: 'Завантаження', icon: 'download', page: 'downloads' },
    { label: 'Історія', icon: 'clock', page: 'history' },
    { label: 'Закладки', icon: 'star', page: 'bookmarks' },
    { label: 'Паролі', icon: 'key' },
    { label: 'Розширення', icon: 'puzzle', page: 'extensions' },
    { label: 'Нотатки', icon: 'notes' },
    { label: 'Перекладач', icon: 'translate' },
    { label: 'Скріншот', icon: 'crop' },
    { label: 'Налаштування', icon: 'settings', page: 'settings' },
  ];

  protected run(tool: Tool): void {
    if (tool.page) {
      this.openPage.emit(tool.page);
    }
  }

  protected onToggle(event: ToggleEvent): void {
    this.open.set(event.newState === 'open');
  }
}
