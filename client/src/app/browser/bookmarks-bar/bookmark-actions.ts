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
  /** «Відкрити всі» в меню теки: її закладки — кожна в новій вкладці. */
  abstract openAllOf(bookmarks: readonly Bookmark[]): void;
  /** Контекстне меню в точці події; `source` — пункт відкритого меню теки, щоб те не закрилося. */
  abstract showMenu(event: MouseEvent, target: BookmarkMenuTarget, source?: HTMLElement): void;
}

/** Закладки самої теки, без вкладених тек, — їх відкривають «Відкрити всі» і клік коліщатком по теці. */
export function folderBookmarks(folder: BookmarkFolder): Bookmark[] {
  return folder.children.filter((child): child is Bookmark => child.type === 'bookmark');
}

/** Клік коліщатком по теці, як у Chrome: усі її закладки — у нових вкладках у фоні. */
export function openFolderInBackground(actions: BookmarkActions, folder: BookmarkFolder): void {
  for (const bookmark of folderBookmarks(folder)) {
    actions.openInNewTab(bookmark);
  }
}

export function folderMenuId(folder: Pick<BookmarkFolder, 'id'>): string {
  return `bookmark-folder-${folder.id}`;
}
