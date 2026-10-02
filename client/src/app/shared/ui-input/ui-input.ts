import { ChangeDetectionStrategy, Component, ElementRef, input, linkedSignal, model, viewChild } from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';

export type UiInputType = 'text' | 'email' | 'password' | 'search' | 'url' | 'tel';

let nextErrorId = 0;

/**
 * Текстове поле з рамкою та анімованим кільцем фокусу.
 *
 * Вміст між тегами (кнопки показу пароля, дії пошуку) стає праворуч від поля,
 * а елемент з атрибутом `data-input-start` — ліворуч, замість `icon`.
 * Кольори задаються CSS-змінними `--input-*` на самому `<app-input>`.
 *
 * Помилка: `[error]` приймає текст або `null` (помилки зараз немає). Якщо `[error]` не прив'язано,
 * блоку помилки під полем немає взагалі — так у пошукових полях.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-input',
  styleUrl: './ui-input.scss',
  templateUrl: './ui-input.html',
  host: {
    '[class.ui-input--lg]': "size() === 'lg'",
    '[class.ui-input--pill]': "shape() === 'pill'",
    '[class.ui-input--invalid]': '!!error()',
    '(mousedown)': 'focusControl($event)',
  },
})
export class UiInput {
  readonly value = model('');
  /** Стає `true`, коли поле втрачає фокус. */
  readonly touched = model(false);
  readonly error = input<string | null>();

  readonly inputId = input<string>();
  readonly inputName = input<string>();
  readonly type = input<UiInputType>('text');
  readonly placeholder = input<string>();
  readonly ariaLabel = input<string>();
  readonly autocomplete = input<string>();
  readonly spellcheck = input<boolean>();
  readonly enterKeyHint = input<string>();
  readonly icon = input<string>();
  readonly size = input<'md' | 'lg'>('md');
  readonly shape = input<'rounded' | 'pill'>('rounded');

  protected readonly errorId = `ui-input-error-${nextErrorId++}`;

  // Поки повідомлення згортається, показуємо попередній текст, а не порожній рядок.
  protected readonly shownError = linkedSignal<string | null | undefined, string | null>({
    source: this.error,
    computation: (error, previous) => error ?? previous?.value ?? null,
  });

  private readonly control = viewChild.required<ElementRef<HTMLInputElement>>('control');

  focus(): void {
    this.control().nativeElement.focus();
  }

  select(): void {
    this.control().nativeElement.select();
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  // Клік по рамці чи іконці ставить курсор у поле, як у звичайному інпуті.
  protected focusControl(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, button, a, select, textarea')) {
      return;
    }

    event.preventDefault();
    this.focus();
  }
}
