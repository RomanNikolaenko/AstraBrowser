import { Injectable, inject, signal } from '@angular/core';
import { BookmarkItem, BookmarksStore } from '../data/bookmarks';
import { folderMenuId } from './bookmark-actions';

/** Власний тип даних перетягування: інші місця (адресний рядок, сайти) закладку не приймуть. */
const DRAG_TYPE = 'application/x-astra-bookmark';

/** Скільки тримати закладку над текою, щоб та розкрилася. */
const SPRING_DELAY_MS = 600;

/** Куди впаде закладка: місце `index` у теці (null — панель) або в кінець теки `into`. */
export interface BookmarkDropTarget {
  readonly folder: string | null;
  readonly index: number;
  readonly into?: string;
}

/**
 * Перетягування закладок, тек і роздільників (HTML5 drag and drop) — на панелі й у меню тек.
 * Над елементом: ліва чи верхня половина — перед ним, права чи нижня — після; над текою середина — в неї,
 * а якщо потримати, тека розкривається, щоб покласти точно на місце. Один на панель (providers у BookmarksBar).
 */
@Injectable()
export class BookmarkDrag {
  private readonly bookmarks = inject(BookmarksStore);

  /** id елемента, який тягнуть. */
  readonly dragging = signal<string | null>(null);
  readonly target = signal<BookmarkDropTarget | null>(null);

  private spring?: { readonly folder: string; readonly timer: ReturnType<typeof setTimeout> };
  /** Теки, розкриті під час перетягування, — після нього згортаються. */
  private readonly sprung = new Set<string>();

  start(event: DragEvent, item: BookmarkItem): void {
    event.stopPropagation();
    event.dataTransfer?.setData(DRAG_TYPE, item.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
    this.dragging.set(item.id);
  }

  /** Над елементом `item`, що стоїть на місці `index` у теці `folder` (null — на панелі); `axis` — напрям списку. */
  overItem(event: DragEvent, item: BookmarkItem, folder: string | null, index: number, axis: 'x' | 'y'): void {
    event.stopPropagation();
    if (!this.dragging()) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = axis === 'x' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    const position = Number.isFinite(ratio) ? ratio : 0.5;

    if (item.type === 'folder' && position >= 0.25 && position <= 0.75 && item.id !== this.dragging()) {
      this.accept(event, { folder: item.id, index: item.children.length, into: item.id });
      this.springOpen(item.id);
      return;
    }
    this.cancelSpring();
    const after = item.type === 'folder' ? position > 0.75 : position >= 0.5;
    this.accept(event, { folder, index: after ? index + 1 : index });
  }

  /** Над порожнім місцем теки (null — панелі): у її кінець. */
  overEnd(event: DragEvent, folder: string | null, length: number): void {
    event.stopPropagation();
    if (!this.dragging()) {
      return;
    }
    this.cancelSpring();
    this.accept(event, { folder, index: length });
  }

  /** Курсор вийшов за межі `container` — місця падіння більше немає. */
  leave(event: DragEvent, container: HTMLElement): void {
    if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) {
      this.cancelSpring();
      this.target.set(null);
    }
  }

  drop(event: DragEvent): void {
    event.preventDefault();
    const id = this.dragging();
    const target = this.target();
    if (id && target) {
      this.bookmarks.move(id, target.into ? { folder: target.into } : { folder: target.folder, index: target.index });
    }
    this.end();
  }

  /** Кінець перетягування — і після падіння, і коли його скасували (Esc чи за межами панелі). */
  end(): void {
    this.cancelSpring();
    this.dragging.set(null);
    this.target.set(null);
    for (const folder of this.sprung) {
      document.getElementById(folderMenuId({ id: folder }))?.hidePopover?.();
    }
    this.sprung.clear();
  }

  /** Лінія перед елементом `index` теки `folder`. */
  before(folder: string | null, index: number): boolean {
    const target = this.target();
    return !!target && !target.into && target.folder === folder && target.index === index;
  }

  /** Лінія після останнього елемента теки. */
  after(folder: string | null, index: number, length: number): boolean {
    return index === length - 1 && this.before(folder, length);
  }

  into(folder: string): boolean {
    return this.target()?.into === folder;
  }

  private accept(event: DragEvent, target: BookmarkDropTarget): void {
    const id = this.dragging();
    if (!id || !this.bookmarks.canMove(id, target.folder)) {
      this.target.set(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    const current = this.target();
    if (current?.folder !== target.folder || current.index !== target.index || current.into !== target.into) {
      this.target.set(target);
    }
  }

  private springOpen(folder: string): void {
    if (this.spring?.folder === folder) {
      return;
    }
    this.cancelSpring();
    const timer = setTimeout(() => {
      const menu = document.getElementById(folderMenuId({ id: folder }));
      if (menu && !menu.matches?.(':popover-open')) {
        menu.showPopover?.();
        this.sprung.add(folder);
      }
    }, SPRING_DELAY_MS);
    this.spring = { folder, timer };
  }

  private cancelSpring(): void {
    clearTimeout(this.spring?.timer);
    this.spring = undefined;
  }
}
