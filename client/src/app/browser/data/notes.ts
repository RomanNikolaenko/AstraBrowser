import { Injectable, computed } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';

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
  private readonly items = accountSignal<readonly Note[]>('astra.notes', []);

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
    this.items.update((items) => items.map((note) => (note.id === id ? { ...note, ...changes, updated: Date.now() } : note)));
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

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Назва для списку: своя, інакше — перший рядок тексту. */
export function noteTitle(note: Note): string {
  return note.title.trim() || lines(note.text)[0] || 'Нова нотатка';
}

/** Початок тексту для списку — без рядка, що вже став назвою. */
export function notePreview(note: Note, length = 120): string {
  const text = lines(note.text)
    .slice(note.title.trim() ? 0 : 1)
    .join(' ');
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}
