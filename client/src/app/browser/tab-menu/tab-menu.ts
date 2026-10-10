import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
  viewChildren,
} from '@angular/core';
import { Popover } from '../popover/popover';

/** Дія з меню вкладки. */
export type TabMenuAction =
  | 'new-tab-right'
  | 'reload'
  | 'duplicate'
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'new-window'
  | 'close'
  | 'close-others'
  | 'close-right';

/** Що відомо про вкладку, для якої відкрито меню. */
export interface TabMenuTarget {
  readonly pinned: boolean;
  /** У вкладці сайт (можна перезавантажити, вимкнути звук). */
  readonly site: boolean;
  readonly muted: boolean;
  /** Є що закривати: інші вкладки, вкладки праворуч; є куди виносити (вкладка не єдина). */
  readonly others: boolean;
  readonly right: boolean;
}

/**
 * Меню вкладки (правий клік), як у Chrome: нова вкладка праворуч, перезавантажити, дублювати, закріпити,
 * звук сайту, перемістити в нове вікно, закрити — цю, інші чи праворуч. Відкривається в точці кліку.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover],
  selector: 'app-tab-menu',
  styleUrl: './tab-menu.scss',
  templateUrl: './tab-menu.html',
})
export class TabMenu {
  readonly target = input.required<TabMenuTarget>();
  readonly action = output<TabMenuAction>();

  private readonly injector = inject(Injector);
  private readonly popover = viewChild.required(Popover);
  private readonly anchor = viewChild.required<ElementRef<HTMLElement>>('anchor');
  private readonly items = viewChildren<ElementRef<HTMLButtonElement>>('item');

  /** Меню в точці кліку (з клавіатури — під вкладкою). */
  show(event: MouseEvent): void {
    let { clientX: x, clientY: y } = event;
    if (!x && !y && event.currentTarget instanceof Element) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom;
    }
    // Панель стоїть на 0.625rem нижче якоря (popover.scss) — піднімаємо якір, щоб меню було під самим курсором.
    const anchor = this.anchor().nativeElement;
    anchor.style.left = `${x}px`;
    anchor.style.top = `calc(${y}px - 0.625rem)`;
    if (this.popover().isOpen()) {
      this.popover().hide();
    }
    this.popover().show({ anchor });
    afterNextRender(() => this.items()[0]?.nativeElement.focus(), { injector: this.injector });
  }

  protected run(action: TabMenuAction): void {
    this.popover().hide();
    this.action.emit(action);
  }

  /** Стрілки — по пунктах меню, як у системних меню. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const items = this.items()
      .map((item) => item.nativeElement)
      .filter((item) => !item.disabled);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
}
