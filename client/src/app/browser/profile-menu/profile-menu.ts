import { ChangeDetectionStrategy, Component, booleanAttribute, inject, input, output } from '@angular/core';
import { AuthStore } from '../../shared/auth/auth';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { Avatar } from '../avatar/avatar';
import { ProfileStore } from '../data/profile';
import { InternalPage } from '../pages/internal-pages';
import { Popover } from '../popover/popover';

interface ProfileItem {
  readonly label: string;
  readonly icon: string;
  readonly page?: InternalPage;
  /** Відкрити гостьове вікно. */
  readonly guest?: true;
}

/**
 * Кнопка з аватаром на панелі інструментів і її меню: ім'я, аватар і пошта облікового запису, сторінки профілю, паролів
 * і персоналізації, гостьовий режим і вихід. У гостьовому вікні — лише «Вийти з гостьового режиму».
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Popover, UiIcon],
  selector: 'app-profile-menu',
  styleUrl: './profile-menu.scss',
  templateUrl: './profile-menu.html',
})
export class ProfileMenu {
  /** Меню гостьового вікна. */
  readonly guest = input(false, { transform: booleanAttribute });
  readonly openPage = output<InternalPage>();
  readonly openGuest = output<void>();
  readonly closeGuest = output<void>();

  protected readonly profile = inject(ProfileStore);
  protected readonly auth = inject(AuthStore);

  protected readonly items: readonly ProfileItem[] = [
    { label: 'Керування профілем', icon: 'user', page: 'profile' },
    { label: 'Паролі', icon: 'key', page: 'passwords' },
    { label: 'Персоналізація', icon: 'palette', page: 'personalization' },
    { label: 'Гостьовий режим', icon: 'guest', guest: true },
  ];

  protected run(item: ProfileItem): void {
    if (item.page) {
      this.openPage.emit(item.page);
    } else if (item.guest) {
      this.openGuest.emit();
    }
  }

  /** Вихід з облікового запису: усі вікна повернуться на сторінку входу (AuthStore). */
  protected signOut(): void {
    void this.auth.signOut();
  }
}
