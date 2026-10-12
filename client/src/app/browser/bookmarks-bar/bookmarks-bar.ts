import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormField, required, validateFields } from '../../shared/form-field/form-field';
import { MiddleClick } from '../../shared/middle-click/middle-click';
import { Tooltip } from '../../shared/tooltip/tooltip';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { bookmarkUrl, siteOrInternalPage } from '../bookmark-editor/bookmark-editor';
import { Bookmark, BookmarkFolder, BookmarkItem, BookmarkPlace, BookmarksStore, FolderColor } from '../data/bookmarks';
import { Popover } from '../popover/popover';
import { SiteIcon } from '../site-icon/site-icon';
import { BookmarkActions, BookmarkMenuTarget, folderMenuId, openFolderInBackground } from './bookmark-actions';
import { BookmarkDrag } from './bookmark-drag';
import { BookmarkFolderMenu } from './bookmark-folder-menu';
import { FOLDER_PALETTE, folderColor, folderIcon } from './folder-colors';
import { tr, translate, TranslatePipe } from '../../shared/i18n/i18n';

/** Форма з контекстного меню: нова закладка чи тека (у `place`) або зміна наявної (`editing`). */
interface BookmarkDialog {
  readonly kind: 'bookmark' | 'folder';
  readonly editing?: string;
  readonly place?: BookmarkPlace;
}

const DIALOG_TITLES = {
  bookmark: [tr('Нова закладка'), tr('Редагувати закладку')],
  folder: [tr('Нова тека'), tr('Редагувати теку')],
} as const;

/**
 * Панель закладок під адресним рядком: закладки, теки (випадні меню) й роздільники.
 * Правий клік відкриває контекстне меню, як у Firefox: відкрити всі закладки, додати закладку, теку чи
 * роздільник (поруч із тим, на чому клацнули), а на самому елементі — ще відкрити, змінити чи видалити.
 * Порядок змінюється перетягуванням — і на панелі, і в теки та з них (BookmarkDrag).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, BookmarkFolderMenu, MiddleClick, Popover, SiteIcon, Tooltip, UiIcon, UiInput],
  providers: [{ provide: BookmarkActions, useExisting: BookmarksBar }, BookmarkDrag],
  selector: 'app-bookmarks-bar',
  styleUrl: './bookmarks-bar.scss',
  templateUrl: './bookmarks-bar.html',
})
export class BookmarksBar implements BookmarkActions {
  /** Поточна сторінка — нею заповнюється «Додати закладку…». */
  readonly pageTitle = input('');
  readonly pageUrl = input('');

  readonly openBookmark = output<Bookmark>();
  readonly openBookmarkInNewTab = output<Bookmark>();
  /** «Відкрити всі закладки»: кожна — у новій вкладці. */
  readonly openBookmarks = output<readonly Bookmark[]>();

  protected readonly bookmarks = inject(BookmarksStore);
  protected readonly drag = inject(BookmarkDrag);
  private readonly injector = inject(Injector);

  protected readonly target = signal<BookmarkMenuTarget>({ item: null, folder: null, index: 0 });
  protected readonly dialog = signal<BookmarkDialog>({ kind: 'bookmark' });
  protected readonly dialogTitle = computed(() => {
    const dialog = this.dialog();
    return DIALOG_TITLES[dialog.kind][dialog.editing ? 1 : 0];
  });

  /** Тека, яку відкриває «Відкрити всі закладки»: та, на якій клацнули, чи та, де клацнули (null — панель). */
  private readonly openAllFolder = computed(() => {
    const target = this.target();
    return target.item?.type === 'folder' ? target.item.id : target.folder;
  });
  protected readonly openAllCount = computed(() => this.bookmarks.bookmarksOf(this.openAllFolder()).length);

  protected readonly title = new FormField([required(tr('Введіть назву'))]);
  protected readonly url = new FormField([required(tr('Введіть адресу')), siteOrInternalPage(tr('Некоректна адреса сайту'))]);
  /** Колір теки у формі; undefined — без кольору. */
  protected readonly color = signal<FolderColor | undefined>(undefined);
  protected readonly palette = FOLDER_PALETTE;
  protected readonly folderIcon = folderIcon;
  protected readonly folderColor = folderColor;

  protected readonly folderMenuId = folderMenuId;

  private readonly menu = viewChild.required<Popover>('menu');
  private readonly menuList = viewChild.required<ElementRef<HTMLElement>>('menuList');
  private readonly editor = viewChild.required<Popover>('editor');
  private readonly titleInput = viewChild.required<UiInput>('titleInput');
  /** Невидима точка, від якої відкриваються меню й форма, — там, де клацнули. */
  private readonly anchor = viewChild.required<ElementRef<HTMLElement>>('anchor');

  open(bookmark: Bookmark): void {
    this.openBookmark.emit(bookmark);
  }

  openInNewTab(bookmark: Bookmark): void {
    this.openBookmarkInNewTab.emit(bookmark);
  }

  /** Коліщатком по теці на панелі — усі її закладки в нових вкладках у фоні. */
  protected openFolderInBackground(folder: BookmarkFolder): void {
    openFolderInBackground(this, folder);
  }

  openAllOf(bookmarks: readonly Bookmark[]): void {
    if (bookmarks.length) {
      this.openBookmarks.emit(bookmarks);
    }
  }

  showMenu(event: MouseEvent, target: BookmarkMenuTarget, source?: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();
    this.target.set(target);
    this.placeAnchor(event);
    if (this.menu().isOpen()) {
      this.menu().hide();
    }
    this.menu().show({ anchor: this.anchor().nativeElement, source });
    afterNextRender(() => this.menuItems()[0]?.focus(), { injector: this.injector });
  }

  /** Порожнє місце панелі: нове додається в її кінець. */
  protected showBarMenu(event: MouseEvent): void {
    this.showMenu(event, { item: null, folder: null, index: this.bookmarks.bar().length });
  }

  protected showItemMenu(event: MouseEvent, item: BookmarkItem, index: number): void {
    this.showMenu(event, { item, folder: null, index });
  }

  /** Стрілки, Home і End ходять пунктами меню. */
  protected onMenuKeydown(event: KeyboardEvent): void {
    const items = this.menuItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined || !items.length) {
      return;
    }
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  }

  protected openAll(): void {
    const bookmarks = this.bookmarks.bookmarksOf(this.openAllFolder());
    this.closeMenus();
    if (bookmarks.length) {
      this.openBookmarks.emit(bookmarks);
    }
  }

  protected openTargetInNewTab(): void {
    const item = this.target().item;
    this.menu().hide();
    if (item?.type === 'bookmark') {
      this.openInNewTab(item);
    }
  }

  protected edit(): void {
    const item = this.target().item;
    if (item?.type === 'bookmark') {
      this.showDialog({ kind: 'bookmark', editing: item.id }, item.title, item.url);
    } else if (item?.type === 'folder') {
      this.showDialog({ kind: 'folder', editing: item.id }, item.title, '', item.color);
    }
  }

  protected remove(): void {
    const item = this.target().item;
    this.menu().hide();
    if (item) {
      this.bookmarks.remove(item.id);
    }
  }

  protected addBookmark(): void {
    this.showDialog({ kind: 'bookmark', place: this.insertPlace() }, this.pageUrl() ? this.pageTitle() : '', this.pageUrl());
  }

  protected addFolder(): void {
    this.showDialog({ kind: 'folder', place: this.insertPlace() }, translate('Нова тека'));
  }

  protected addSeparator(): void {
    this.bookmarks.addSeparator(this.insertPlace());
    this.menu().hide();
  }

  protected save(event: Event): void {
    event.preventDefault();
    const dialog = this.dialog();
    const fields = dialog.kind === 'bookmark' ? [this.title, this.url] : [this.title];
    if (!validateFields(fields)) {
      return;
    }

    const title = this.title.value().trim();
    if (dialog.kind === 'folder') {
      if (dialog.editing) {
        this.bookmarks.update(dialog.editing, { title, color: this.color() });
      } else {
        this.bookmarks.addFolder(title, dialog.place, this.color());
      }
    } else {
      const url = bookmarkUrl(this.url.value());
      if (!url) {
        return;
      }
      if (dialog.editing) {
        this.bookmarks.update(dialog.editing, { title, url });
      } else {
        this.bookmarks.add(title, url, dialog.place);
      }
    }
    this.editor().hide();
  }

  /** Як у Firefox: нове стає перед елементом, на якому клацнули, а з порожнього місця — у кінець. */
  private insertPlace(): BookmarkPlace {
    const { item, folder, index } = this.target();
    return item ? { folder, index } : { folder };
  }

  private showDialog(dialog: BookmarkDialog, title: string, url = '', color?: FolderColor): void {
    this.closeMenus();
    this.dialog.set(dialog);
    this.title.value.set(title);
    this.url.value.set(url);
    this.color.set(color);
    for (const field of [this.title, this.url]) {
      field.touched.set(false);
    }
    this.editor().show({ anchor: this.anchor().nativeElement });
    afterNextRender(
      () => {
        this.titleInput().focus();
        this.titleInput().select();
      },
      { injector: this.injector }
    );
  }

  /** Контекстне меню й меню тек, з якого його відкрили. */
  private closeMenus(): void {
    this.menu().hide();
    const folder = this.target().folder;
    const root = folder && this.rootFolderOf(folder);
    if (root) {
      document.getElementById(folderMenuId(root))?.hidePopover?.();
    }
  }

  /** Тека на самій панелі, в якій (на будь-якій глибині) лежить тека `id`. */
  private rootFolderOf(id: string): BookmarkFolder | undefined {
    return this.bookmarks
      .bar()
      .find((item): item is BookmarkFolder => item.type === 'folder' && (item.id === id || this.contains(item.children, id)));
  }

  private contains(items: readonly BookmarkItem[], id: string): boolean {
    return items.some((item) => item.type === 'folder' && (item.id === id || this.contains(item.children, id)));
  }

  /** Меню відкривається під курсором, а з клавіатури (клавіша меню, Shift+F10) — під самим елементом. */
  private placeAnchor(event: MouseEvent): void {
    let { clientX: x, clientY: y } = event;
    if (!x && !y && event.currentTarget instanceof Element) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom;
    }
    // Стиль одразу, а не через шаблон: позицію панелі браузер рахує, щойно її відкрито.
    // Панель стоїть на 0.625rem нижче якоря (popover.scss) — піднімаємо якір, щоб меню було під самим курсором.
    const anchor = this.anchor().nativeElement;
    anchor.style.left = `${x}px`;
    anchor.style.top = `calc(${y}px - 0.625rem)`;
  }

  private menuItems(): HTMLButtonElement[] {
    return [...this.menuList().nativeElement.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  }
}
