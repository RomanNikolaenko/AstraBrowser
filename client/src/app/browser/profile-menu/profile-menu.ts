import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { Popover } from '../popover/popover';

/** Меню профілю (кнопка з аватаром). Пункти списку поки лише закривають меню. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, RouterLink, UiIcon],
  selector: 'app-profile-menu',
  styleUrl: './profile-menu.scss',
  templateUrl: './profile-menu.html',
})
export class ProfileMenu {
  protected readonly items = [
    { label: 'Керування профілем', icon: 'user' },
    { label: 'Паролі', icon: 'key' },
    { label: 'Персоналізація', icon: 'palette' },
    { label: 'Гостьовий режим', icon: 'guest' },
  ] as const;
}
