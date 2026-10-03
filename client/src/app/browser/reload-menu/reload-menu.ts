import { ChangeDetectionStrategy, Component, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { ReloadMode } from '../page-views/page-views';
import { Popover } from '../popover/popover';

interface ReloadAction {
  readonly mode: ReloadMode;
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
  /** Наслідки, які користувач помітить: вийде з облікового запису тощо. */
  readonly danger?: boolean;
}

/**
 * Меню кнопки «Оновити» (утримання кнопки чи правий клік): оновлення без кешу й з очищенням даних сайту.
 * Відкриває його Browser, бо звичайний клік по тій самій кнопці просто оновлює сторінку.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon],
  selector: 'app-reload-menu',
  styleUrl: './reload-menu.scss',
  templateUrl: './reload-menu.html',
})
export class ReloadMenu {
  readonly reload = output<ReloadMode>();

  protected readonly actions: readonly ReloadAction[] = [
    { mode: 'hard', icon: 'bolt', label: 'Жорстке оновлення', hint: 'Повторно завантажує все, минаючи кеш' },
    { mode: 'cache', icon: 'trash', label: 'Очистити кеш і оновити', hint: 'Видаляє кеш цього сайту' },
    { mode: 'site-data', icon: 'broom', label: 'Очистити дані сайту й оновити', hint: 'Кеш, LocalStorage, SessionStorage, IndexedDB' },
    { mode: 'cookies', icon: 'cookie', label: 'Очистити cookies і оновити', hint: 'Може вийти з облікового запису на сайті', danger: true },
  ];

  private readonly popover = viewChild.required(Popover);

  isOpen(): boolean {
    return this.popover().isOpen();
  }

  show(): void {
    this.popover().show();
  }

  hide(): void {
    this.popover().hide();
  }
}
