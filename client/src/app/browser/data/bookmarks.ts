import { Injectable } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

export interface Bookmark {
  readonly id: string;
  readonly title: string;
  /** Немає — це папка. */
  readonly url?: string;
  /** Кольорова іконка сайту; без неї показується загальна. */
  readonly favicon?: string;
}

// Початковий набір для панелі закладок, доки користувач не змінить його.
const DEFAULT_BOOKMARKS: readonly Bookmark[] = [
  { id: 'default-work', title: 'Робота', favicon: 'favicon-folder' },
  { id: 'default-youtube', title: 'YouTube', url: 'https://www.youtube.com', favicon: 'favicon-youtube' },
  { id: 'default-github', title: 'GitHub', url: 'https://github.com', favicon: 'favicon-github' },
  { id: 'default-figma', title: 'Figma', url: 'https://www.figma.com', favicon: 'favicon-figma' },
  { id: 'default-mail', title: 'Пошта', url: 'https://mail.google.com', favicon: 'favicon-mail' },
  { id: 'default-docs', title: 'Документи', url: 'https://docs.google.com', favicon: 'favicon-docs' },
];

@Injectable({ providedIn: 'root' })
export class BookmarksStore {
  private readonly items = storedSignal<readonly Bookmark[]>('astra.bookmarks', DEFAULT_BOOKMARKS);

  /** У порядку, в якому стоять на панелі закладок. */
  readonly entries = this.items.asReadonly();

  add(title: string, url: string): void {
    this.items.update((items) => [...items, { id: crypto.randomUUID(), title, url }]);
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }
}

/** Іконка закладки: власна, папка або загальна іконка сайту. */
export function bookmarkIcon(bookmark: Bookmark): string {
  return bookmark.favicon ?? (bookmark.url ? 'globe' : 'favicon-folder');
}
