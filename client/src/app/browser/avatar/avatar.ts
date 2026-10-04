import { ChangeDetectionStrategy, Component, booleanAttribute, inject, input } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { ProfileStore } from '../data/profile';

/**
 * Аватар профілю: фото, а без нього — ініціали на кольоровому тлі (без імені — значок людини).
 * Розмір задає CSS-змінна --avatar-size на самому <app-avatar>. `guest` — значок гостя (гостьове вікно).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-avatar',
  template: `
    @if (guest()) {
      <span class="avatar avatar--guest"><app-icon class="avatar__icon" icon="guest" /></span>
    } @else if (profile.photo(); as photo) {
      <img class="avatar avatar--photo" width="80" height="80" [src]="photo" alt="" />
    } @else {
      <span class="avatar" [style.background]="profile.background()">
        @if (profile.initials(); as initials) {
          <span class="avatar__initials">{{ initials }}</span>
        } @else {
          <app-icon class="avatar__icon" icon="user" />
        }
      </span>
    }
  `,
  styles: `
    :host {
      --avatar-size: 2rem;

      display: inline-grid;
      flex: 0 0 auto;
      width: var(--avatar-size);
      height: var(--avatar-size);
    }

    .avatar {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      overflow: hidden;
      color: #fff;
      border-radius: 50%;
      user-select: none;

      &--photo {
        object-fit: cover;
      }

      &--guest {
        color: var(--browser-text);
        background: var(--browser-field);
      }
    }

    .avatar__initials {
      font-size: calc(var(--avatar-size) * 0.4);
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.02em;
    }

    .avatar__icon {
      width: 55%;
      height: 55%;
    }
  `,
})
export class Avatar {
  readonly guest = input(false, { transform: booleanAttribute });

  protected readonly profile = inject(ProfileStore);
}
