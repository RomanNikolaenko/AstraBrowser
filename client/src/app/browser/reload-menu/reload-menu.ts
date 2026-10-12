import { ChangeDetectionStrategy, Component, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { ReloadMode } from '../page-views/page-views';
import { Popover } from '../popover/popover';
import { tr, TranslatePipe } from '../../shared/i18n/i18n';

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
  imports: [TranslatePipe, Popover, UiIcon],
  selector: 'app-reload-menu',
  styleUrl: './reload-menu.scss',
  templateUrl: './reload-menu.html',
})
export class ReloadMenu {
  readonly reload = output<ReloadMode>();

  protected readonly actions: readonly ReloadAction[] = [
    { mode: 'hard', icon: 'bolt', label: tr('Жорстке оновлення'), hint: tr('Повторно завантажує все, минаючи кеш') },
    { mode: 'cache', icon: 'trash', label: tr('Очистити кеш і оновити'), hint: tr('Видаляє кеш цього сайту') },
    {
      mode: 'site-data',
      icon: 'broom',
      label: tr('Очистити дані сайту й оновити'),
      hint: tr('Кеш, LocalStorage, SessionStorage, IndexedDB'),
    },
    {
      mode: 'cookies',
      icon: 'cookie',
      label: tr('Очистити cookies і оновити'),
      hint: tr('Може вийти з облікового запису на сайті'),
      danger: true,
    },
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
