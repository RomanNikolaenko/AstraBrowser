import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { MiddleClick } from '../../shared/middle-click/middle-click';
import { Tooltip } from '../../shared/tooltip/tooltip';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { BookmarkFolder, BookmarkItem } from '../data/bookmarks';
import { Popover } from '../popover/popover';
import { SiteIcon } from '../site-icon/site-icon';
import { BookmarkActions, folderMenuId } from './bookmark-actions';
import { BookmarkDrag } from './bookmark-drag';
import { folderColor, folderIcon } from './folder-colors';

/**
 * Випадне меню теки на панелі закладок: її закладки, роздільники й вкладені теки (ті — збоку, як підменю).
 * Клік відкриває закладку й закриває всі меню, коліщатком — у новій вкладці, а меню лишається відкритим.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MiddleClick, Popover, SiteIcon, Tooltip, UiIcon],
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

  protected readonly actions = inject(BookmarkActions);
  protected readonly drag = inject(BookmarkDrag);

  protected readonly menuId = computed(() => folderMenuId(this.folder()));
  protected readonly root = computed(() => this.rootId() ?? this.menuId());
  protected readonly folderMenuId = folderMenuId;
  protected readonly folderIcon = folderIcon;
  protected readonly folderColor = folderColor;

  /** Лінія перед чи після пункту, підсвічена тека й напівпрозорий пункт, який зараз тягнуть. */
  protected dropClasses(item: BookmarkItem, index: number): Record<string, boolean> {
    const folder = this.folder();
    return {
      'bookmark-folder-menu__entry': true,
      'bookmark-folder-menu__entry--dragging': this.drag.dragging() === item.id,
      'bookmark-folder-menu__entry--drop-before': this.drag.before(folder.id, index),
      'bookmark-folder-menu__entry--drop-after': this.drag.after(folder.id, index, folder.children.length),
      'bookmark-folder-menu__entry--drop-into': this.drag.into(item.id),
    };
  }

  protected showMenu(event: MouseEvent, item: BookmarkItem | null, index: number): void {
    this.actions.showMenu(event, { item, folder: this.folder().id, index }, event.currentTarget as HTMLElement);
  }
}
