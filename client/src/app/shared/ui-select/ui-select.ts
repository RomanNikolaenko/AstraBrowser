import { ChangeDetectionStrategy, Component, ElementRef, computed, input, model, signal, viewChild } from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';

export interface UiSelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

let nextId = 0;

/**
 * Випадний список у стилі застосунку — шаблон «select-only combobox» з WAI-ARIA:
 * кнопка з role="combobox" і список у popover. Фокус лишається на кнопці, а пункт під курсором
 * позначає aria-activedescendant. Клавіатура: стрілки, Home/End, Enter/пробіл, Esc, Tab і набір літер.
 * Кольори задаються CSS-змінними `--select-*` на самому `<app-select>`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-select',
  styleUrl: './ui-select.scss',
  templateUrl: './ui-select.html',
  host: {
    '[class.ui-select--open]': 'open()',
  },
})
export class UiSelect<T extends string = string> {
  readonly value = model<T>();
  readonly options = input.required<readonly UiSelectOption<T>[]>();

  /** id кнопки-комбобокса. */
  readonly selectId = input<string>();
  /** Ім'я для форми: значення йде прихованим полем. */
  readonly selectName = input<string>();
  readonly ariaLabel = input<string>();
  /**
   * id тексту-назви поряд. Не `<label for>`: наведення на такий підпис підсвічує сам контрол, а клік по ньому
   * ставить на нього фокус — селект відгукується лише на себе.
   */
  readonly ariaLabelledby = input<string>();
  /** id тексту, що пояснює вибір. */
  readonly ariaDescribedby = input<string>();
  readonly disabled = input(false);

  protected readonly listId = `ui-select-${nextId++}`;
  protected readonly open = signal(false);
  /** Пункт під курсором чи клавіатурою. */
  protected readonly active = signal(-1);
  protected readonly selected = computed(() => this.options().find((option) => option.value === this.value()));

  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');
  private typed = '';
  private typedAt = 0;

  protected optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  /** Список відкрився чи закрився (зокрема кліком поза ним — popover закривається сам). */
  protected onToggle(event: ToggleEvent): void {
    if (event.newState === 'open') {
      this.showActive();
    } else {
      this.open.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const last = this.options().length - 1;
    const open = this.open();

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          this.openList();
        } else {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          this.active.update((index) => Math.min(Math.max(index + step, 0), last));
        }
        return;
      case 'Home':
      case 'End':
        if (open) {
          event.preventDefault();
          this.active.set(event.key === 'Home' ? 0 : last);
        }
        return;
      case 'Enter':
      case ' ':
        // Відкритий список: вибір замість кліку по кнопці (він би просто закрив список).
        if (open) {
          event.preventDefault();
          this.choose(this.active());
        }
        return;
      case 'Escape':
        // Закриваємо лише список, а не панель, у якій він лежить.
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          this.closeList();
        }
        return;
      case 'Tab':
        this.closeList();
        return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.typeahead(event.key, open);
    }
  }

  protected choose(index: number): void {
    const option = this.options()[index];
    if (option && option.value !== this.value()) {
      this.value.set(option.value);
    }
    this.closeList();
  }

  protected hover(index: number): void {
    this.active.set(index);
  }

  private openList(): void {
    this.list().nativeElement.showPopover?.();
    this.showActive();
  }

  private closeList(): void {
    this.list().nativeElement.hidePopover?.();
    this.open.set(false);
  }

  private showActive(): void {
    this.open.set(true);
    this.active.set(
      Math.max(
        this.options().findIndex((option) => option.value === this.value()),
        0
      )
    );
  }

  /** Набір перших літер переходить до пункту, що з них починається (у закритому — одразу вибирає). */
  private typeahead(key: string, open: boolean): void {
    const now = Date.now();
    this.typed = now - this.typedAt > 700 ? key : this.typed + key;
    this.typedAt = now;
    const query = this.typed.toLocaleLowerCase();
    const index = this.options().findIndex((option) => option.label.toLocaleLowerCase().startsWith(query));
    if (index === -1) {
      return;
    }
    if (open) {
      this.active.set(index);
    } else if (this.options()[index].value !== this.value()) {
      this.value.set(this.options()[index].value);
    }
  }
}
