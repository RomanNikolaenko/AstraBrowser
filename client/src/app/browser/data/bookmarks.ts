import { Injectable } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

export interface Bookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

@Injectable({ providedIn: 'root' })
export class BookmarksStore {
  private readonly items = storedSignal<readonly Bookmark[]>('astra.bookmarks', []);

  /** У порядку додавання — так вони стоять на панелі закладок. */
  readonly entries = this.items.asReadonly();

  constructor() {
    // Попередні версії зберігали демо-закладки з id «default-…»; прибираємо їх один раз.
    this.items.update((items) => items.filter((item) => !item.id.startsWith('default-')));
  }

  find(url: string): Bookmark | undefined {
    return url ? this.items().find((item) => item.url === url) : undefined;
  }

  add(title: string, url: string): void {
    this.items.update((items) => [...items, { id: crypto.randomUUID(), title, url }]);
  }

  update(id: string, changes: Pick<Bookmark, 'title' | 'url'>): void {
    this.items.update((items) => items.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }
}
