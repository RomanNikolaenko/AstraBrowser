import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { CardPromptRequest, CardsStore, cardExpiry, cardTitle } from '../data/cards';

/**
 * «Зберегти картку?» після оплати на сайті новою карткою (чи «Оновити картку?», якщо в неї тепер інший термін чи
 * ім'я). Показує лише платіжну систему й останні чотири цифри; CVV/CVC браузер не зберігає. Кілька запитів — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-card-prompt',
  styleUrls: ['../address-prompt/address-prompt.scss'],
  templateUrl: './card-prompt.html',
})
export class CardPrompt {
  private readonly cards = inject(CardsStore);
  private readonly injector = inject(Injector);

  /** Запит, який зараз показано. */
  protected readonly request = signal<CardPromptRequest | null>(null);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly title = cardTitle;
  protected readonly expiry = cardExpiry;

  constructor() {
    // Наступний у черзі запит показується, щойно попередній вирішено.
    effect(() => {
      const next = this.cards.prompts()[0] ?? null;
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
    void this.cards.answer(request.id, save).catch(() => undefined);
  }
}
