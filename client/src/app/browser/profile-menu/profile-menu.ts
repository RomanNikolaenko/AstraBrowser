import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiIcon } from '../../shared/ui-icon/ui-icon';

/** Меню профілю (кнопка з аватаром). Пункти списку поки лише закривають меню. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiIcon],
  selector: 'app-profile-menu',
  styleUrl: './profile-menu.scss',
  templateUrl: './profile-menu.html',
  host: {
    '[class.is-open]': 'open()',
  },
})
export class ProfileMenu {
  protected readonly open = signal(false);

  protected readonly items = [
    { label: 'Керування профілем', icon: 'user' },
    { label: 'Паролі', icon: 'key' },
    { label: 'Персоналізація', icon: 'palette' },
    { label: 'Гостьовий режим', icon: 'guest' },
  ] as const;

  protected onToggle(event: ToggleEvent): void {
    this.open.set(event.newState === 'open');
  }
}
