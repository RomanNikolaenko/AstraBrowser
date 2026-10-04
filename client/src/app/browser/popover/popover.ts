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
 *
 * Контекстне меню відкривається з коду: `show({ anchor })` — під довільним елементом (скажімо, точкою кліку),
 * а `source` — елемент іншої відкритої панелі, щоб та не закрилася (вкладене меню).
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
  /** `side` — збоку від якоря, як вкладене меню, а не під ним. */
  readonly placement = input<'below' | 'side'>('below');

  readonly opened = output<void>();
  readonly closed = output<void>();

  readonly isOpen = signal(false);

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  /** Якір, заданий у show(), — на час цього відкриття. */
  private anchor: HTMLElement | null = null;

  /** Відкрити не кліком по кнопці, а з коду (як меню «Оновити» за утриманням чи контекстне меню). */
  show({ anchor, source }: { readonly anchor?: HTMLElement; readonly source?: HTMLElement } = {}): void {
    this.anchor = anchor ?? null;
    const panel = this.panel().nativeElement;
    if (source) {
      panel.showPopover?.({ source });
    } else {
      panel.showPopover?.();
    }
    this.setOpen(true);
  }

  hide(): void {
    this.panel().nativeElement.hidePopover?.();
    this.setOpen(false);
  }

  /** До першого кадру: якір для розташування панелі, а стрілці — його ширина, щоб стати над центром. */
  protected onBeforeToggle(event: Event): void {
    const anchor = (event as ToggleEvent).newState === 'open' ? (this.anchor ?? this.findAnchor()) : null;
    if (!anchor) {
      return;
    }
    const name = `--${this.popoverId()}`;
    // Додаємо своє ім'я до наявних, а не замінюємо: одна кнопка буває якорем кількох панелей (меню «Інструменти»
    // й перекладач), і панель, що саме згасає, інакше втратила б якір і стрибнула б у кут вікна.
    const names = anchorNames(anchor);
    if (!names.includes(name)) {
      anchor.style.setProperty('anchor-name', [...names, name].join(', '));
    }
    if (this.caret()) {
      this.panel().nativeElement.style.setProperty('--popover-anchor-width', `${anchor.getBoundingClientRect().width}px`);
    }
  }

  protected onToggle(event: Event): void {
    const open = (event as ToggleEvent).newState === 'open';
    if (!open) {
      this.anchor = null;
    }
    this.setOpen(open);
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
      [invoker, ...invoker.querySelectorAll<HTMLElement>('*')].find((element) => anchorNames(element).includes(name)) ?? invoker
    );
  }
}

/** Імена якоря елемента (anchor-name: --a, --b); none — жодного. */
function anchorNames(element: Element): string[] {
  return getComputedStyle(element)
    .getPropertyValue('anchor-name')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && name !== 'none');
}
