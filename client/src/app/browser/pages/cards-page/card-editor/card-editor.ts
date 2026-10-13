import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { translate, TranslatePipe } from '../../../../shared/i18n/i18n';
import { UiInput } from '../../../../shared/ui-input/ui-input';
import { UiSelect, UiSelectOption } from '../../../../shared/ui-select/ui-select';
import { CardInfo, CardsStore } from '../../../data/cards';

/** Скільки років уперед пропонувати в терміні дії. */
const YEARS_AHEAD = 20;

const MONTHS: readonly UiSelectOption[] = Array.from({ length: 12 }, (_, index) => {
  const month = String(index + 1).padStart(2, '0');
  return { value: month, label: month };
});

/**
 * Вікно «Додати картку» / «Змінити картку» сторінки «Банківські картки»: номер, ім'я власника, термін дії й назва для
 * себе. Номер збереженої картки сюди не приходить: щоб його змінити, вводять новий, а порожнє поле лишає старий.
 * CVV/CVC не питаємо — браузер його не зберігає. Помилку з Rust (некоректний номер тощо) показує під полями.
 *
 * Відкривається з коду: `editor.add()` чи `editor.edit(card)`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiInput, UiSelect],
  selector: 'app-card-editor',
  styleUrls: ['../../addresses-page/address-editor/address-editor.scss', './card-editor.scss'],
  templateUrl: './card-editor.html',
})
export class CardEditor {
  private readonly cards = inject(CardsStore);

  /** Картка, яку змінюють; null — додають нову. */
  protected readonly editing = signal<CardInfo | null>(null);
  protected readonly number = signal('');
  protected readonly holder = signal('');
  protected readonly month = signal<string | undefined>(undefined);
  protected readonly year = signal<string | undefined>(undefined);
  protected readonly nickname = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  /** Номера збереженої картки тут немає — підказка каже, яка це картка і що порожнє поле його не змінить. */
  protected readonly numberHint = computed(() => {
    const card = this.editing();
    return card ? translate('•••• {0} — лишіть порожнім, щоб не змінювати', [card.last4]) : '0000 0000 0000 0000';
  });
  protected readonly months = MONTHS;
  /** Роки від поточного (а для старої картки — від її року) на двадцять уперед. */
  protected readonly years = computed<UiSelectOption[]>(() => {
    const now = new Date().getFullYear();
    const from = Math.min(now, this.editing()?.year || now);
    return Array.from({ length: now + YEARS_AHEAD - from + 1 }, (_, index) => {
      const year = String(from + index);
      return { value: year, label: year };
    });
  });

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly numberInput = viewChild.required<UiInput>('numberInput');

  add(): void {
    this.open(null);
  }

  edit(card: CardInfo): void {
    this.open(card);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const editing = this.editing();
    if (!editing && !this.number().trim()) {
      this.error.set(translate('Введіть номер картки'));
      return;
    }
    if (!this.month() || !this.year()) {
      this.error.set(translate('Вкажіть термін дії картки'));
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.cards.save(editing?.id ?? null, {
        number: this.number(),
        holder: this.holder(),
        month: Number(this.month()),
        year: Number(this.year()),
        nickname: this.nickname(),
      });
      this.close();
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : translate('Не вдалося зберегти картку'));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close?.();
    this.onClose();
  }

  /** Esc чи клік повз вікно — нічого не змінюється, а введений номер не лишається в полі. */
  protected onClose(): void {
    this.number.set('');
  }

  private open(card: CardInfo | null): void {
    this.editing.set(card);
    this.number.set('');
    this.holder.set(card?.holder ?? '');
    this.month.set(card?.month ? String(card.month).padStart(2, '0') : undefined);
    this.year.set(card?.year ? String(card.year) : undefined);
    this.nickname.set(card?.nickname ?? '');
    this.error.set(null);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
    setTimeout(() => this.numberInput().focus());
  }
}
