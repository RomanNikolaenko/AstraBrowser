import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';

/** Меню профілю (кнопка з аватаром). Пункти без page поки лише закривають меню. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, RouterLink, UiIcon],
  selector: 'app-profile-menu',
  styleUrl: './profile-menu.scss',
  templateUrl: './profile-menu.html',
})
export class ProfileMenu {
  readonly openPage = output<InternalPage>();

  protected readonly items: readonly { readonly label: string; readonly icon: string; readonly page?: InternalPage }[] = [
    { label: 'Керування профілем', icon: 'user' },
    { label: 'Паролі', icon: 'key', page: 'passwords' },
    { label: 'Персоналізація', icon: 'palette' },
    { label: 'Гостьовий режим', icon: 'guest' },
  ];

  protected run(page: InternalPage | undefined): void {
    if (page) {
      this.openPage.emit(page);
    }
  }
}
