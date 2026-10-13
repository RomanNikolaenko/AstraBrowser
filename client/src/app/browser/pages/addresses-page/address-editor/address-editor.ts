import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild, viewChildren } from '@angular/core';
import { tr, translate, TranslatePipe } from '../../../../shared/i18n/i18n';
import { UiInput, UiInputType } from '../../../../shared/ui-input/ui-input';
import { Address, AddressFields, AddressesStore, EMPTY_ADDRESS } from '../../../data/addresses';

/** Поле вікна: що в адресі, підпис, тип і автозаповнення (щоб і Astra, і менеджери паролів розуміли поля). */
interface EditorField {
  readonly key: keyof AddressFields;
  readonly label: string;
  readonly type: UiInputType;
  readonly autocomplete: string;
  /** На всю ширину вікна, а не в пів. */
  readonly wide?: boolean;
}

const FIELDS: readonly EditorField[] = [
  { key: 'given', label: tr("Ім'я"), type: 'text', autocomplete: 'given-name' },
  { key: 'family', label: tr('Прізвище'), type: 'text', autocomplete: 'family-name' },
  { key: 'organization', label: tr('Організація'), type: 'text', autocomplete: 'organization', wide: true },
  { key: 'line1', label: tr('Вулиця й будинок'), type: 'text', autocomplete: 'address-line1', wide: true },
  { key: 'line2', label: tr("Квартира, офіс, під'їзд"), type: 'text', autocomplete: 'address-line2', wide: true },
  { key: 'city', label: tr('Місто'), type: 'text', autocomplete: 'address-level2' },
  { key: 'region', label: tr('Область'), type: 'text', autocomplete: 'address-level1' },
  { key: 'postal', label: tr('Поштовий індекс'), type: 'text', autocomplete: 'postal-code' },
  { key: 'country', label: tr('Країна'), type: 'text', autocomplete: 'country-name' },
  { key: 'phone', label: tr('Телефон'), type: 'tel', autocomplete: 'tel' },
  { key: 'email', label: tr('Пошта'), type: 'email', autocomplete: 'email' },
];

/**
 * Вікно «Додати адресу» / «Змінити адресу» сторінки «Адреси». Обов'язкових полів немає — лише щоб хоч одне було
 * заповнене. Помилку з Rust показує під полями.
 *
 * Відкривається з коду: `editor.add()` чи `editor.edit(entry)`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiInput],
  selector: 'app-address-editor',
  styleUrl: './address-editor.scss',
  templateUrl: './address-editor.html',
})
export class AddressEditor {
  private readonly addresses = inject(AddressesStore);

  protected readonly fields = FIELDS;
  /** Адреса, яку змінюють; null — додають нову. */
  protected readonly editing = signal<Address | null>(null);
  protected readonly values = signal<AddressFields>(EMPTY_ADDRESS);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly inputs = viewChildren(UiInput);

  add(): void {
    this.open(null, EMPTY_ADDRESS);
  }

  edit(entry: Address): void {
    this.open(entry, entry.fields);
  }

  protected set(key: keyof AddressFields, value: string): void {
    this.values.update((values) => ({ ...values, [key]: value }));
    this.error.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const values = this.values();
    if (!Object.values(values).some((value) => value.trim())) {
      this.error.set(translate('Заповніть хоча б одне поле'));
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.addresses.save(this.editing()?.id ?? null, values);
      this.close();
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : translate('Не вдалося зберегти адресу'));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close?.();
  }

  private open(entry: Address | null, values: AddressFields): void {
    this.editing.set(entry);
    this.values.set({ ...values });
    this.error.set(null);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
    setTimeout(() => this.inputs()[0]?.focus());
  }
}
