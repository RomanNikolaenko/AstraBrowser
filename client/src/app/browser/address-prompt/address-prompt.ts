import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { AddressPromptRequest, AddressesStore, addressLine, fullName } from '../data/addresses';

/**
 * «Зберегти адресу?» після надсилання форми з адресою на сайті (чи «Оновити адресу?», якщо це та сама людина з новими
 * даними). Показує, що саме збережеться; змінити адресу можна потім на сторінці «Адреси». Кілька запитів — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-address-prompt',
  styleUrl: './address-prompt.scss',
  templateUrl: './address-prompt.html',
})
export class AddressPrompt {
  private readonly addresses = inject(AddressesStore);
  private readonly injector = inject(Injector);

  /** Запит, який зараз показано. */
  protected readonly request = signal<AddressPromptRequest | null>(null);
  /** Рядки того, що збережеться: ім'я, організація, адреса, телефон і пошта — що є. */
  protected readonly lines = computed(() => {
    const fields = this.request()?.fields;
    if (!fields) {
      return [];
    }
    return [fullName(fields), fields.organization, addressLine(fields), fields.phone, fields.email]
      .map((line) => line.trim())
      .filter(Boolean);
  });

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    // Наступний у черзі запит показується, щойно попередній вирішено.
    effect(() => {
      const next = this.addresses.prompts()[0] ?? null;
      untracked(() => {
        if (next?.id === this.request()?.id) {
          return;
        }
        this.request.set(next);
        if (next) {
          afterNextRender(
            () => {
              const dialog = this.dialog().nativeElement;
              if (!dialog.open) {
                dialog.showModal?.();
              }
            },
            { injector: this.injector }
          );
        }
      });
    });
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.answer(true);
  }

  protected dismiss(): void {
    this.answer(false);
  }

  /** Esc чи клік повз вікно — «не зараз». */
  protected onClose(): void {
    if (this.request()) {
      this.answer(false);
    }
  }

  private answer(save: boolean): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.request.set(null);
    this.dialog().nativeElement.close?.();
    void this.addresses.answer(request.id, save).catch(() => undefined);
  }
}
