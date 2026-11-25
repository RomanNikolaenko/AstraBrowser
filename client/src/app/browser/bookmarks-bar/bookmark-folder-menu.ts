import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { MiddleClick } from '../../shared/middle-click/middle-click';
import { Tooltip } from '../../shared/tooltip/tooltip';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { BookmarkFolder, BookmarkItem } from '../data/bookmarks';
import { Popover } from '../popover/popover';
import { SiteIcon } from '../site-icon/site-icon';
import { BookmarkActions, folderBookmarks, folderMenuId, openFolderInBackground } from './bookmark-actions';
import { BookmarkDrag } from './bookmark-drag';
import { folderColor, folderIcon } from './folder-colors';
import { TranslatePipe } from '../../shared/i18n/i18n';

/**
 * Випадне меню теки на панелі закладок: її закладки, роздільники й вкладені теки (ті — збоку, як підменю).
 * Клік відкриває закладку й закриває всі меню, коліщатком — у новій вкладці, а меню лишається відкритим.
 * Унизу — «Відкрити всі»: закладки саме цієї теки (без вкладених тек), кожна в новій вкладці.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, MiddleClick, Popover, SiteIcon, Tooltip, UiIcon],
  selector: 'app-bookmark-folder-menu',
  styleUrl: './bookmark-folder-menu.scss',
  templateUrl: './bookmark-folder-menu.html',
})
export class BookmarkFolderMenu {
  readonly folder = input.required<BookmarkFolder>();
  /** Меню вкладеної теки — збоку від пункту, що його відкрив. */
  readonly nested = input(false, { transform: booleanAttribute });
  /** Меню верхньої теки: закриваючи його, браузер закриває й усі вкладені. */
  readonly rootId = input<string>();
  /**
   * Меню «»» в кінці панелі: у `folder` — пункти самої панелі, що на неї не вмістилися, починаючи з цього місця.
   * Тоді перетягування й контекстне меню працюють із панеллю, а не з текою.
   */
  readonly barOffset = input<number>();

  protected readonly actions = inject(BookmarkActions);
  protected readonly drag = inject(BookmarkDrag);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly contentsVisible = signal(false);

  protected readonly menuId = computed(() => folderMenuId(this.folder()));
  protected readonly root = computed(() => this.rootId() ?? this.menuId());
  /** Де насправді лежать пункти: тека чи панель (null), і місце першого з них там. */
  protected readonly parent = computed(() => (this.barOffset() === undefined ? this.folder().id : null));
  protected readonly offset = computed(() => this.barOffset() ?? 0);
  /** Меню «»» стоїть у правому кінці панелі — розкривається ліворуч. */
  protected readonly align = computed(() => (this.barOffset() === undefined ? 'start' : 'end'));
  /** Закладки самої теки — для «Відкрити всі»; у меню «»», як у Firefox, цього пункту немає. */
  protected readonly bookmarks = computed(() => (this.barOffset() === undefined ? folderBookmarks(this.folder()) : []));
  protected readonly folderMenuId = folderMenuId;
  protected readonly folderIcon = folderIcon;
  protected readonly folderColor = folderColor;

  /** До showPopover: браузер має одразу бачити пункти для фокуса й порядку Tab. */
  protected showContents(): void {
    this.contentsVisible.set(true);
    this.changeDetector.detectChanges();
  }

  /** Лінія перед чи після пункту, підсвічена тека й напівпрозорий пункт, який зараз тягнуть. */
  protected dropClasses(item: BookmarkItem, index: number): Record<string, boolean> {
    const parent = this.parent();
    const offset = this.offset();
    return {
      'bookmark-folder-menu__entry': true,
      'bookmark-folder-menu__entry--dragging': this.drag.dragging() === item.id,
      'bookmark-folder-menu__entry--drop-before': this.drag.before(parent, offset + index),
      'bookmark-folder-menu__entry--drop-after': this.drag.after(parent, offset + index, offset + this.folder().children.length),
      'bookmark-folder-menu__entry--drop-into': this.drag.into(item.id),
    };
  }

  /** Коліщатком по вкладеній теці — усі її закладки в нових вкладках у фоні; меню лишається відкритим. */
  protected openInBackground(folder: BookmarkFolder): void {
    openFolderInBackground(this.actions, folder);
  }

  protected showMenu(event: MouseEvent, item: BookmarkItem | null, index: number): void {
    this.actions.showMenu(
      event,
      { item, folder: this.parent(), index: this.offset() + index },
      event.currentTarget as HTMLElement
    );
  }
}
