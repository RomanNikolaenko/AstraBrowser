import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { BrowserWindows } from '../../../shared/browser-windows/browser-windows';
import { translate, TranslatePipe } from '../../../shared/i18n/i18n';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { CardInfo, CardSettings, CardsStore, brandName, cardExpired, cardExpiry, cardTitle } from '../../data/cards';
import { CardEditor } from './card-editor/card-editor';

/**
 * Сторінка «Банківські картки» (astra://cards): картки, якими браузер заповнює форми оплати, — додавання, зміна
 * й видалення, а також налаштування: пропонувати зберігати картки, показувати їх у полях форм і підтверджувати
 * заповнення через Windows Hello. Номерів тут немає — лише платіжна система й останні чотири цифри.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, CardEditor, ConfirmDialog, UiIcon, UiSwitch],
  selector: 'app-cards-page',
  styleUrls: ['../internal-page.scss', '../addresses-page/addresses-page.scss', './cards-page.scss'],
  templateUrl: './cards-page.html',
})
export class CardsPage {
  protected readonly cards = inject(CardsStore);
  /** У гостьовому вікні карток власника не видно, а нові не зберігаються (server/src/cards.rs). */
  protected readonly guest = inject(BrowserWindows).isGuest;

  /** Картка, про видалення якої питають. */
  protected readonly removing = signal<CardInfo | null>(null);
  protected readonly removeMessage = computed(() => {
    const card = this.removing();
    return card ? translate('Картку «{0}» буде видалено з браузера. Скасувати це не вийде.', [cardTitle(card)]) : '';
  });

  private readonly confirmRemove = viewChild.required<ConfirmDialog>('confirmRemove');

  protected readonly title = cardTitle;
  protected readonly expired = (card: CardInfo) => cardExpired(card);

  /** Під назвою: картка (якщо назва своя), ім'я власника й термін дії. */
  protected details(card: CardInfo): string {
    const expiry = cardExpiry(card);
    return [
      card.nickname.trim() ? `${brandName(card.brand)} •••• ${card.last4}` : '',
      card.holder,
      expiry ? (cardExpired(card) ? translate('Термін дії минув') : translate('до {0}', [expiry])) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected askRemove(card: CardInfo): void {
    this.removing.set(card);
    this.confirmRemove().show();
  }

  protected remove(): void {
    const card = this.removing();
    if (card) {
      void this.cards.remove(card.id).catch(() => undefined);
    }
    this.removing.set(null);
  }

  protected setSetting(key: keyof CardSettings, value: boolean): void {
    const settings = this.cards.settings();
    if (settings) {
      void this.cards.setSettings({ ...settings, [key]: value }).catch(() => undefined);
    }
  }
}
