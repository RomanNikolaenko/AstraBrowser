import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { BrowserWindows } from '../../../shared/browser-windows/browser-windows';
import { translate, TranslatePipe } from '../../../shared/i18n/i18n';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { Address, AddressSettings, AddressesStore, addressLine, addressTitle } from '../../data/addresses';
import { matchesQuery } from '../internal-pages';
import { AddressEditor } from './address-editor/address-editor';

/**
 * Сторінка «Адреси» (astra://addresses): адреси, якими браузер заповнює форми на сайтах, — пошук, додавання, зміна
 * й видалення, а також налаштування: пропонувати зберігати адреси й показувати їх у полях форм.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, AddressEditor, ConfirmDialog, UiIcon, UiInput, UiSwitch],
  selector: 'app-addresses-page',
  styleUrls: ['../internal-page.scss', './addresses-page.scss'],
  templateUrl: './addresses-page.html',
})
export class AddressesPage {
  protected readonly addresses = inject(AddressesStore);
  /** У гостьовому вікні адрес власника не видно, а нові не зберігаються (server/src/addresses.rs). */
  protected readonly guest = inject(BrowserWindows).isGuest;

  protected readonly query = signal('');
  protected readonly filtered = computed(() =>
    this.addresses.entries().filter((entry) => matchesQuery(this.query(), ...Object.values(entry.fields)))
  );
  /** Адреса, про видалення якої питають. */
  protected readonly removing = signal<Address | null>(null);
  protected readonly removeMessage = computed(() => {
    const entry = this.removing();
    return entry ? translate('Адресу «{0}» буде видалено з браузера. Скасувати це не вийде.', [addressTitle(entry.fields)]) : '';
  });

  private readonly confirmRemove = viewChild.required<ConfirmDialog>('confirmRemove');

  protected readonly title = (entry: Address) => addressTitle(entry.fields);

  /** Решта адреси під назвою: де, телефон і пошта — без того, що вже в назві. */
  protected details(entry: Address): string {
    const title = addressTitle(entry.fields);
    return [entry.fields.organization, addressLine(entry.fields), entry.fields.phone, entry.fields.email]
      .map((part) => part.trim())
      .filter((part) => part && part !== title)
      .join(' · ');
  }

  protected askRemove(entry: Address): void {
    this.removing.set(entry);
    this.confirmRemove().show();
  }

  protected remove(): void {
    const entry = this.removing();
    if (entry) {
      void this.addresses.remove(entry.id).catch(() => undefined);
    }
    this.removing.set(null);
  }

  protected setSetting(key: keyof AddressSettings, value: boolean): void {
    const settings = this.addresses.settings();
    if (settings) {
      void this.addresses.setSettings({ ...settings, [key]: value }).catch(() => undefined);
    }
  }
}
