import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormField, Validator, normalizeUrl, required, validateFields } from '../../shared/form-field/form-field';
import { UiInput } from '../../shared/ui-input/ui-input';
import { UiSelect, UiSelectOption } from '../../shared/ui-select/ui-select';
import { Bookmark, BookmarksStore } from '../data/bookmarks';
import { internalPageFor } from '../pages/internal-pages';
import { Popover } from '../popover/popover';

// Як urlFormat, але приймає й адреси внутрішніх сторінок (astra://history тощо).
export const siteOrInternalPage =
  (message: string): Validator =>
  (value) =>
    internalPageFor(value.trim()) || normalizeUrl(value) ? null : message;

/** Адреса для закладки: внутрішні astra://… — як є, сайти — у повному вигляді https://…; null — некоректна. */
export function bookmarkUrl(raw: string): string | null {
  const url = raw.trim();
  return internalPageFor(url) ? url : normalizeUrl(url);
}

/**
 * Панель зірочки в адресному рядку: додає поточну сторінку в закладки або редагує/видаляє наявну.
 * На порожній новій вкладці адресу можна ввести вручну. Коли є теки, закладку можна покласти чи перенести в одну з них.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiInput, UiSelect],
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
  /** Тека закладки; '' — сама панель закладок. */
  protected readonly folder = signal('');
  protected readonly folderOptions = computed<readonly UiSelectOption[]>(() => [
    { value: '', label: 'Панель закладок' },
    ...this.bookmarks.folders().map(({ id, path }) => ({ value: id, label: path })),
  ]);

  private readonly popover = viewChild.required(Popover);
  private readonly titleInput = viewChild.required<UiInput>('titleInput');

  protected onOpened(): void {
    const existing = this.bookmarks.find(this.pageUrl());
    this.existing.set(existing);
    this.title.value.set(existing?.title ?? (this.pageUrl() ? this.pageTitle() : ''));
    this.url.value.set(existing?.url ?? this.pageUrl());
    this.folder.set((existing && this.bookmarks.parentOf(existing.id)) ?? '');
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

    const url = bookmarkUrl(this.url.value());
    if (!url) {
      return;
    }

    const title = this.title.value().trim();
    const existing = this.existing();
    const folder = this.folder() || null;
    if (existing) {
      this.bookmarks.update(existing.id, { title, url });
      this.bookmarks.move(existing.id, { folder });
    } else {
      this.bookmarks.add(title, url, { folder });
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
