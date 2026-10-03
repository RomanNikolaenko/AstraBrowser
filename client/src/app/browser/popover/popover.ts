import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Випадна панель браузера (Popover API): під кнопкою-якорем, з рамкою, тінню, анімацією й, за потреби, стрілкою.
 * Вміст — між тегами.
 *
 * Кнопка відкриває панель через `popovertarget="<popoverId>"` і сама стає її якорем (`anchor-name: --<popoverId>`
 * ставиться їй перед відкриттям). Якщо якорем має бути частина кнопки (як аватар у профілі), цій частині
 * задають `anchor-name` у CSS. Стрілка сама стає над центром якоря; якщо там заокруглений кут панелі,
 * панель трохи зсувається назовні.
 *
 * Ширина, відступи й розкладка — CSS-змінні на `<app-popover>`:
 * `--popover-width`, `--popover-padding`, `--popover-display` (block чи flex-колонка).
 * Поки панель відкрита, на `<app-popover>` є клас `is-open` — для «натиснутої» кнопки поруч.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-popover',
  styleUrl: './popover.scss',
  templateUrl: './popover.html',
  host: {
    '[class.is-open]': 'isOpen()',
  },
})
export class Popover {
  readonly popoverId = input.required<string>();
  /** `end` — правий край панелі під правим краєм якоря (розкривається ліворуч), `start` — навпаки. */
  readonly align = input<'start' | 'end'>('end');
  /** Стрілка, що вказує на якір. */
  readonly caret = input(false, { transform: booleanAttribute });

  readonly opened = output<void>();
  readonly closed = output<void>();

  readonly isOpen = signal(false);

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  /** Відкрити не кліком по кнопці, а з коду (як меню «Оновити» за утриманням). */
  show(): void {
    this.panel().nativeElement.showPopover?.();
    this.setOpen(true);
  }

  hide(): void {
    this.panel().nativeElement.hidePopover?.();
    this.setOpen(false);
  }

  /** До першого кадру: якір для розташування панелі, а стрілці — його ширина, щоб стати над центром. */
  protected onBeforeToggle(event: Event): void {
    const anchor = (event as ToggleEvent).newState === 'open' ? this.findAnchor() : null;
    if (!anchor) {
      return;
    }
    const name = `--${this.popoverId()}`;
    if (getComputedStyle(anchor).getPropertyValue('anchor-name') !== name) {
      anchor.style.setProperty('anchor-name', name);
    }
    if (this.caret()) {
      this.panel().nativeElement.style.setProperty('--popover-anchor-width', `${anchor.getBoundingClientRect().width}px`);
    }
  }

  protected onToggle(event: Event): void {
    this.setOpen((event as ToggleEvent).newState === 'open');
  }

  private setOpen(open: boolean): void {
    if (open !== this.isOpen()) {
      this.isOpen.set(open);
      (open ? this.opened : this.closed).emit();
    }
  }

  /** Якір — кнопка, що відкриває панель (не та, що закриває її зсередини), чи її частина з тим самим anchor-name. */
  private findAnchor(): HTMLElement | null {
    const panel = this.panel().nativeElement;
    const invoker = [...document.querySelectorAll<HTMLElement>(`[popovertarget="${this.popoverId()}"]`)].find(
      (element) => !panel.contains(element)
    );
    if (!invoker) {
      return null;
    }
    const name = `--${this.popoverId()}`;
    return (
      [invoker, ...invoker.querySelectorAll<HTMLElement>('*')].find(
        (element) => getComputedStyle(element).getPropertyValue('anchor-name') === name
      ) ?? invoker
    );
  }
}
