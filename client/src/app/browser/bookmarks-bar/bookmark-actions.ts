import { Bookmark, BookmarkFolder, BookmarkItem } from '../data/bookmarks';

/** На чому відкрили контекстне меню: елемент (null — порожнє місце), тека, де він лежить (null — панель), і його місце. */
export interface BookmarkMenuTarget {
  readonly item: BookmarkItem | null;
  readonly folder: string | null;
  readonly index: number;
}

/** Дії панелі закладок, якими користуються меню її тек (зокрема вкладені). */
export abstract class BookmarkActions {
  abstract open(bookmark: Bookmark): void;
  abstract openInNewTab(bookmark: Bookmark): void;
  /** Контекстне меню в точці події; `source` — пункт відкритого меню теки, щоб те не закрилося. */
  abstract showMenu(event: MouseEvent, target: BookmarkMenuTarget, source?: HTMLElement): void;
}

export function folderMenuId(folder: Pick<BookmarkFolder, 'id'>): string {
  return `bookmark-folder-${folder.id}`;
}
