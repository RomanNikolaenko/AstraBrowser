import { Injectable, computed } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';
import type { ImportedBookmark } from './bookmarks-html';

export interface Bookmark {
  readonly type: 'bookmark';
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** Кольори, які можна дати теці; самі відтінки — у bookmarks-bar/folder-colors.ts. */
export const FOLDER_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

export interface BookmarkFolder {
  readonly type: 'folder';
  readonly id: string;
  readonly title: string;
  readonly children: readonly BookmarkItem[];
  /** Без кольору — звичайна тека. */
  readonly color?: FolderColor;
}

export interface BookmarkSeparator {
  readonly type: 'separator';
  readonly id: string;
}

/** Те, що стоїть на панелі закладок чи в теці. */
export type BookmarkItem = Bookmark | BookmarkFolder | BookmarkSeparator;

/** Куди вставити новий елемент: тека (null — сама панель) і місце в ній (без index — у кінець). */
export interface BookmarkPlace {
  readonly folder: string | null;
  readonly index?: number;
}

/** Тека для вибору: її id і повний шлях («Робота › Архів»). */
export interface BookmarkFolderPath {
  readonly id: string;
  readonly path: string;
}

/** Попередні версії зберігали лише закладки й без поля type. */
type StoredItem = Partial<BookmarkItem> & { readonly id: string };

function normalize(item: StoredItem): BookmarkItem {
  if (item.type === 'folder') {
    const folder = folderOf(item.id, item.title ?? '', (item.children ?? []).map(normalize));
    return withColor(
      folder,
      FOLDER_COLORS.find((color) => color === item.color)
    );
  }
  if (item.type === 'separator') {
    return { type: 'separator', id: item.id };
  }
  const bookmark = item as Partial<Bookmark>;
  return { type: 'bookmark', id: item.id, title: bookmark.title ?? '', url: bookmark.url ?? '' };
}

function folderOf(id: string, title: string, children: readonly BookmarkItem[]): BookmarkFolder {
  return { type: 'folder', id, title, children };
}

/** Тека з кольором чи без нього — без поля color, а не з color: undefined. */
function withColor(folder: BookmarkFolder, color: FolderColor | undefined): BookmarkFolder {
  const { type, id, title, children } = folder;
  return color ? { type, id, title, children, color } : { type, id, title, children };
}

function bookmarksIn(items: readonly BookmarkItem[]): Bookmark[] {
  return items.flatMap((item) => (item.type === 'bookmark' ? [item] : item.type === 'folder' ? bookmarksIn(item.children) : []));
}

function foldersIn(items: readonly BookmarkItem[], path: string): BookmarkFolderPath[] {
  return items.flatMap((item) => {
    if (item.type !== 'folder') {
      return [];
    }
    const itemPath = path ? `${path} › ${item.title}` : item.title;
    return [{ id: item.id, path: itemPath }, ...foldersIn(item.children, itemPath)];
  });
}

/** Елемент з id і тека, в якій він лежить (null — сама панель). */
function locate(
  items: readonly BookmarkItem[],
  id: string,
  parent: string | null = null
): { item: BookmarkItem; parent: string | null } | undefined {
  for (const item of items) {
    if (item.id === id) {
      return { item, parent };
    }
    const found = item.type === 'folder' ? locate(item.children, id, item.id) : undefined;
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Те саме дерево, де кожен елемент пропущено через `change`; null — прибрати елемент. */
function mapTree(items: readonly BookmarkItem[], change: (item: BookmarkItem) => BookmarkItem | null): BookmarkItem[] {
  return items.flatMap((item): BookmarkItem[] => {
    const changed = change(item);
    if (!changed) {
      return [];
    }
    return changed.type === 'folder' ? [{ ...changed, children: mapTree(changed.children, change) }] : [changed];
  });
}

function insertAt(items: readonly BookmarkItem[], item: BookmarkItem, index = items.length): BookmarkItem[] {
  const at = Math.min(Math.max(index, 0), items.length);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

@Injectable({ providedIn: 'root' })
export class BookmarksStore {
  private readonly stored = accountSignal<readonly StoredItem[]>('astra.bookmarks', []);

  /** Панель закладок: закладки, теки й роздільники в тому порядку, як вони на ній стоять. */
  readonly bar = computed(() => this.stored().map(normalize));
  /** Усі закладки, зокрема з тек, — для пошуку й сторінки закладок. */
  readonly entries = computed(() => bookmarksIn(this.bar()));
  /** Усі теки, зокрема вкладені, з повним шляхом — для вибору теки. */
  readonly folders = computed(() => foldersIn(this.bar(), ''));

  constructor() {
    // Попередні версії зберігали демо-закладки з id «default-…»; прибираємо їх один раз.
    this.stored.update((items) => items.filter((item) => !item.id.startsWith('default-')));
  }

  find(url: string): Bookmark | undefined {
    return url ? this.entries().find((item) => item.url === url) : undefined;
  }

  /** Закладки теки без вкладених тек (null — закладки самої панелі), як їх відкриває «Відкрити всі закладки». */
  bookmarksOf(folder: string | null): Bookmark[] {
    const items = folder === null ? this.bar() : this.folder(folder)?.children;
    return (items ?? []).filter((item): item is Bookmark => item.type === 'bookmark');
  }

  folder(id: string): BookmarkFolder | undefined {
    const item = locate(this.bar(), id)?.item;
    return item?.type === 'folder' ? item : undefined;
  }

  /** Тека, де лежить елемент; null — сама панель (чи такого елемента немає). */
  parentOf(id: string): string | null {
    return locate(this.bar(), id)?.parent ?? null;
  }

  add(title: string, url: string, place: BookmarkPlace = { folder: null }): void {
    this.insert({ type: 'bookmark', id: crypto.randomUUID(), title, url }, place);
  }

  addFolder(title: string, place: BookmarkPlace = { folder: null }, color?: FolderColor): void {
    this.insert(withColor(folderOf(crypto.randomUUID(), title, []), color), place);
  }

  /** Закладки з іншого браузера — однією текою в кінці панелі (щоб не змішалися з наявними). Повертає id теки. */
  importTree(title: string, items: readonly ImportedBookmark[]): string {
    const build = (item: ImportedBookmark): BookmarkItem =>
      item.type === 'folder'
        ? folderOf(crypto.randomUUID(), item.title, item.children.map(build))
        : { type: 'bookmark', id: crypto.randomUUID(), title: item.title, url: item.url };
    const folder = folderOf(crypto.randomUUID(), title, items.map(build));
    this.insert(folder, { folder: null });
    return folder.id;
  }

  addSeparator(place: BookmarkPlace = { folder: null }): void {
    this.insert({ type: 'separator', id: crypto.randomUUID() }, place);
  }

  /**
   * Нова назва, а ще адреса — для закладки чи колір — для теки (`color: undefined` прибирає колір,
   * а без поля color він лишається). Роздільник змінювати нічого.
   */
  update(id: string, changes: { readonly title: string; readonly url?: string; readonly color?: FolderColor }): void {
    this.stored.set(
      mapTree(this.bar(), (item) => {
        if (item.id !== id || item.type === 'separator') {
          return item;
        }
        if (item.type === 'bookmark') {
          return { ...item, title: changes.title, url: changes.url ?? item.url };
        }
        return withColor({ ...item, title: changes.title }, 'color' in changes ? changes.color : item.color);
      })
    );
  }

  /** Чи можна перенести елемент у теку (null — на панель): теку — не в неї саму й не у вкладені в неї. */
  canMove(id: string, folder: string | null): boolean {
    const found = locate(this.bar(), id);
    if (!found) {
      return false;
    }
    return folder === null || found.item.type !== 'folder' || (folder !== id && !locate(found.item.children, folder));
  }

  /**
   * Переносить елемент на місце `index` у теці (null — на панелі), як його видно до перенесення.
   * Без index — у кінець теки; якщо елемент уже в ній, то нікуди (як вибір теки в панелі зірочки).
   */
  move(id: string, { folder, index }: BookmarkPlace): void {
    const found = locate(this.bar(), id);
    if (!found || !this.canMove(id, folder) || (index === undefined && found.parent === folder)) {
      return;
    }
    let at = index;
    if (at !== undefined && found.parent === folder) {
      const siblings = folder === null ? this.bar() : (this.folder(folder)?.children ?? []);
      const from = siblings.findIndex((item) => item.id === id);
      // Місце рахується з елементом, тож після нього все зсувається на одне ліворуч.
      at = from < at ? at - 1 : at;
      if (at === from) {
        return;
      }
    }
    this.stored.set(mapTree(this.bar(), (item) => (item.id === id ? null : item)));
    this.insert(found.item, { folder, index: at });
  }

  /** Прибирає закладку, роздільник чи теку разом з усім, що в ній. */
  remove(id: string): void {
    this.stored.set(mapTree(this.bar(), (item) => (item.id === id ? null : item)));
  }

  private insert(item: BookmarkItem, { folder, index }: BookmarkPlace): void {
    if (folder === null) {
      this.stored.set(insertAt(this.bar(), item, index));
      return;
    }
    this.stored.set(
      mapTree(this.bar(), (current) =>
        current.type === 'folder' && current.id === folder
          ? { ...current, children: insertAt(current.children, item, index) }
          : current
      )
    );
  }
}
