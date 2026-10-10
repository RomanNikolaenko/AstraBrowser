import { ChangeDetectionStrategy, Component, computed, inject, input, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { PermissionsStore } from '../data/permissions';
import { Popover } from '../popover/popover';

/**
 * «Спливне вікно заблоковано» — панель з кнопки в адресному рядку, як у Chrome: які вікна сайт хотів відкрити без
 * вашого кліку, відкрити їх усе ж, і «Завжди дозволяти спливні вікна з сайту».
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon],
  selector: 'app-popup-blocked',
  styleUrl: './popup-blocked.scss',
  templateUrl: './popup-blocked.html',
})
export class PopupBlocked {
  readonly pageUrl = input.required<string>();
  /** Адреси заблокованих вікон поточної сторінки. */
  readonly popups = input.required<readonly string[]>();
  readonly open = output<string>();

  private readonly permissions = inject(PermissionsStore);
  private readonly popover = viewChild.required(Popover);

  private readonly origin = computed(() => {
    try {
      return new URL(this.pageUrl()).origin;
    } catch {
      return '';
    }
  });
  protected readonly host = computed(() => {
    try {
      return new URL(this.pageUrl()).host;
    } catch {
      return '';
    }
  });
  protected readonly allowed = computed(() => this.permissions.popupsAllowed(this.origin()));

  protected openPopup(url: string): void {
    this.open.emit(url);
  }

  protected setAllowed(event: Event): void {
    this.permissions.setPopupsAllowed(this.origin(), (event.target as HTMLInputElement).checked);
  }

  protected close(): void {
    this.popover().hide();
  }
}
