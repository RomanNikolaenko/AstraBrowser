import { Injectable, computed } from '@angular/core';
import { accountKey, flushStoredSignals, mergeStoredList, storedSignal } from '../../shared/storage/stored-signal';
import { translate } from '../../shared/i18n/i18n';

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Закріплена — завжди вгорі списку. */
  readonly pinned: boolean;
  readonly created: number;
  /** Коли востаннє змінювали назву чи текст. */
  readonly updated: number;
}

/**
 * Нотатки сторінки «Нотатки» (astra://notes). Живуть у localStorage, спільні для всіх вікон (крім приватних,
 * у яких своє сховище, що зникає разом із вікном).
 */
@Injectable({ providedIn: 'root' })
export class NotesStore {
  private readonly key = accountKey('astra.notes');
  private readonly items = storedSignal<readonly Note[]>(this.key, [], { delayMs: 300, merge: mergeStoredList });

  /** Спершу закріплені, далі — від щойно змінених. */
  readonly entries = computed(() =>
    [...this.items()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated)
  );

  /** Нова порожня нотатка; повертає її, щоб одразу відкрити. */
  create(): Note {
    const now = Date.now();
    const note: Note = { id: crypto.randomUUID(), title: '', text: '', pinned: false, created: now, updated: now };
    this.items.update((items) => [...items, note]);
    return note;
  }

  update(id: string, changes: { readonly title?: string; readonly text?: string }): void {
    this.items.update((items) => {
      const index = items.findIndex((note) => note.id === id);
      const note = items[index];
      if (!note || ((changes.title ?? note.title) === note.title && (changes.text ?? note.text) === note.text)) {
        return items;
      }
      const next = [...items];
      next[index] = { ...note, ...changes, updated: Date.now() };
      return next;
    });
  }

  /** Завершили редагування чи пішли зі сторінки — останні клавіші вже мають бути на диску. */
  flush(): void {
    flushStoredSignals(this.key);
  }

  /** Закріпити чи відкріпити; час зміни при цьому лишається тим самим. */
  togglePin(id: string): void {
    this.items.update((items) => items.map((note) => (note.id === id ? { ...note, pinned: !note.pinned } : note)));
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((note) => note.id !== id));
  }
}

/** Ні назви, ні тексту — така нотатка зникає, щойно з неї пішли. */
export function isEmptyNote(note: Note): boolean {
  return !note.title.trim() && !note.text.trim();
}

const titles = new WeakMap<Note, string>();
const previews = new WeakMap<Note, Map<number, string>>();

/** Назва для списку: своя, інакше — перший рядок тексту. */
export function noteTitle(note: Note): string {
  let title = titles.get(note);
  if (title === undefined) {
    title = note.title.trim();
    let start = 0;
    while (!title && start < note.text.length) {
      const newline = note.text.indexOf('\n', start);
      const end = newline < 0 ? note.text.length : newline;
      title = note.text.slice(start, end).trim();
      start = end + 1;
    }
    titles.set(note, title);
  }
  // Порожня назва перекладається наново після зміни мови.
  return title || translate('Нова нотатка');
}

/** Початок тексту для списку — без рядка, що вже став назвою. */
export function notePreview(note: Note, length = 120): string {
  let cached = previews.get(note);
  if (!cached) {
    cached = new Map();
    previews.set(note, cached);
  }
  const known = cached.get(length);
  if (known !== undefined) {
    return known;
  }
  let start = 0;
  // Перший непорожній рядок уже став назвою — він не входить у preview.
  if (!note.title.trim()) {
    while (start < note.text.length) {
      const newline = note.text.indexOf('\n', start);
      const end = newline < 0 ? note.text.length : newline;
      const nonempty = /\S/.test(note.text.slice(start, end));
      start = end + 1;
      if (nonempty) {
        break;
      }
    }
  }
  let text = '';
  let pendingStart = start;
  let newLine = true;
  // Не розбираємо решту великої нотатки: достатньо length + 1 значущих символів для багатокрапки.
  for (let index = start; index < note.text.length; index++) {
    const character = note.text[index];
    if (character === '\n') {
      newLine = true;
      pendingStart = index + 1;
    } else if (!/\s/.test(character)) {
      const separator = newLine ? (text ? ' ' : '') : note.text.slice(pendingStart, index);
      const remaining = Math.max(0, length + 1 - text.length);
      text += (separator + character).slice(0, remaining);
      if (text.length > length) {
        break;
      }
      newLine = false;
      pendingStart = index + 1;
    }
  }
  const preview = text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
  cached.set(length, preview);
  return preview;
}
