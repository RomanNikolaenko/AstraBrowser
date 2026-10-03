import { ChangeDetectionStrategy, Component, inject, input, signal, viewChild } from '@angular/core';
import { FormField, Validator, normalizeUrl, required, validateFields } from '../../shared/form-field/form-field';
import { UiInput } from '../../shared/ui-input/ui-input';
import { Bookmark, BookmarksStore } from '../data/bookmarks';
import { internalPageFor } from '../pages/internal-pages';
import { Popover } from '../popover/popover';

// Як urlFormat, але приймає й адреси внутрішніх сторінок (astra://history тощо).
const siteOrInternalPage = (message: string): Validator => (value) =>
  internalPageFor(value.trim()) || normalizeUrl(value) ? null : message;

/**
 * Панель зірочки в адресному рядку: додає поточну сторінку в закладки або редагує/видаляє наявну.
 * На порожній новій вкладці адресу можна ввести вручну.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiInput],
  selector: 'app-bookmark-editor',
  styleUrl: './bookmark-editor.scss',
  templateUrl: './bookmark-editor.html',
})
export class BookmarkEditor {
  /** Поточна сторінка вкладки; порожня адреса — нова вкладка. */
  readonly pageTitle = input('');
  readonly pageUrl = input('');

  private readonly bookmarks = inject(BookmarksStore);

  /** Закладка поточної сторінки на момент відкриття панелі: тоді панель її редагує. */
  protected readonly existing = signal<Bookmark | undefined>(undefined);

  protected readonly title = new FormField([required('Введіть назву')]);
  protected readonly url = new FormField([required('Введіть адресу'), siteOrInternalPage('Некоректна адреса сайту')]);

  private readonly popover = viewChild.required(Popover);
  private readonly titleInput = viewChild.required<UiInput>('titleInput');

  protected onOpened(): void {
    const existing = this.bookmarks.find(this.pageUrl());
    this.existing.set(existing);
    this.title.value.set(existing?.title ?? (this.pageUrl() ? this.pageTitle() : ''));
    this.url.value.set(existing?.url ?? this.pageUrl());
    for (const field of [this.title, this.url]) {
      field.touched.set(false);
    }
    this.titleInput().focus();
    this.titleInput().select();
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (!validateFields([this.title, this.url])) {
      return;
    }

    // Внутрішні адреси astra://… зберігаємо як є, сайти — у повному вигляді https://….
    const rawUrl = this.url.value().trim();
    const url = internalPageFor(rawUrl) ? rawUrl : normalizeUrl(rawUrl);
    if (!url) {
      return;
    }

    const title = this.title.value().trim();
    const existing = this.existing();
    if (existing) {
      this.bookmarks.update(existing.id, { title, url });
    } else {
      this.bookmarks.add(title, url);
    }
    this.close();
  }

  protected remove(): void {
    const existing = this.existing();
    if (existing) {
      this.bookmarks.remove(existing.id);
    }
    this.close();
  }

  private close(): void {
    this.popover().hide();
  }
}
