import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  input,
  linkedSignal,
  model,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';
import { TranslatePipe } from '../i18n/i18n';

export type UiInputType = 'text' | 'email' | 'password' | 'search' | 'url' | 'tel';

/** Поле з випадним списком підказок (WAI-ARIA combobox): id списку, чи він відкритий і вибраний у ньому пункт. */
export interface UiInputCombobox {
  readonly controls: string;
  readonly expanded: boolean;
  readonly active: string | null;
}

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
  imports: [TranslatePipe, UiIcon],
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
  /** id тексту-назви поряд (замість `<label for>`, наведення на який підсвічує поле). */
  readonly ariaLabelledby = input<string>();
  /** id тексту, що пояснює поле; помилка, коли вона є, додається до нього. */
  readonly ariaDescribedby = input<string>();
  readonly autocomplete = input<string>();
  readonly spellcheck = input<boolean>();
  readonly enterKeyHint = input<string>();
  readonly icon = input<string>();
  readonly size = input<'md' | 'lg'>('md');
  readonly shape = input<'rounded' | 'pill'>('rounded');
  /** Як адресний рядок браузера: поле, у яке щойно перейшли (кліком чи Tab), виділяє весь текст — можна одразу писати. */
  readonly selectOnFocus = input(false, { transform: booleanAttribute });
  /** Поле — combobox зі списком підказок (адресний рядок). */
  readonly combobox = input<UiInputCombobox | null>(null);

  protected readonly errorId = `ui-input-error-${nextErrorId++}`;
  /** aria-describedby поля: пояснення поряд і помилка, якщо вона є. */
  protected readonly describedBy = computed(
    () => [this.ariaDescribedby(), this.error() ? this.errorId : null].filter(Boolean).join(' ') || null
  );

  // Поки повідомлення згортається, показуємо попередній текст, а не порожній рядок.
  protected readonly shownError = linkedSignal<string | null | undefined, string | null>({
    source: this.error,
    computation: (error, previous) => error ?? previous?.value ?? null,
  });

  private readonly control = viewChild.required<ElementRef<HTMLInputElement>>('control');
  /** Клік, яким поле щойно отримало фокус: коли кнопку миші відпустять, текст має лишитися виділеним. */
  private focusingClick = false;

  focus(): void {
    this.control().nativeElement.focus();
  }

  select(): void {
    this.control().nativeElement.select();
  }

  blur(): void {
    this.control().nativeElement.blur();
  }

  /** Виділяє частину тексту — дописане автодоповненням, щоб наступна літера його замінила. */
  selectRange(start: number, end: number): void {
    this.control().nativeElement.setSelectionRange(start, end);
  }

  protected onPointerDown(): void {
    this.focusingClick = this.selectOnFocus() && document.activeElement !== this.control().nativeElement;
  }

  protected onFocus(): void {
    if (this.selectOnFocus()) {
      this.control().nativeElement.select();
    }
  }

  /**
   * Браузер ставить курсор у місце кліку вже після фокусу й так знімає виділення. Тож якщо цим кліком
   * у поле лише перейшли, виділяємо все знову — але не тоді, коли мишею виділили частину тексту.
   */
  protected onMouseUp(): void {
    if (!this.focusingClick) {
      return;
    }
    this.focusingClick = false;
    const control = this.control().nativeElement;
    if (control.selectionStart === control.selectionEnd) {
      control.select();
    }
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
