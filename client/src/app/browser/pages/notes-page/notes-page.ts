import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { Note, NotesStore, isEmptyNote, notePreview, noteTitle } from '../../data/notes';
import { formatTime, matchesQuery } from '../internal-pages';

/** Скільки показувати «Скопійовано» на кнопці копіювання. */
const COPIED_FOR = 1500;
const DAY = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' });

/** «Сьогодні», «Вчора» чи дата — день, коли було `time`. */
function dayOf(time: number, now = Date.now()): 'today' | 'yesterday' | null {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  return time >= startOfToday ? 'today' : time >= startOfToday - DAY ? 'yesterday' : null;
}

/** Скільки слів: «1 слово», «3 слова», «5 слів». */
function words(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  const word =
    last === 1 && lastTwo !== 11 ? 'слово' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'слова' : 'слів';
  return `${count} ${word}`;
}

/**
 * Сторінка «Нотатки» (astra://notes): список ліворуч (пошук, закріплені вгорі) і редактор праворуч.
 * Зберігається само під час набору. Нова нотатка, яку так і не заповнили, зникає, щойно з неї пішли.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, UiIcon, UiInput],
  selector: 'app-notes-page',
  styleUrls: ['../internal-page.scss', './notes-page.scss'],
  templateUrl: './notes-page.html',
})
export class NotesPage {
  protected readonly notes = inject(NotesStore);
  private readonly injector = inject(Injector);

  protected readonly query = signal('');
  protected readonly filtered = computed(() =>
    this.notes.entries().filter((note) => matchesQuery(this.query(), note.title, note.text))
  );
  private readonly selectedId = signal<string | null>(null);
  /**
   * Відкрита нотатка: вибрана, а якщо її немає — перша в списку. Вибрана лишається відкритою, навіть коли після
   * правки вже не підходить під пошук: інакше редактор перескочив би на іншу посеред набору.
   */
  protected readonly current = computed(
    () => this.notes.entries().find((note) => note.id === this.selectedId()) ?? this.filtered()[0] ?? null
  );
  protected readonly copied = signal(false);
  protected readonly removeMessage = computed(() => {
    const note = this.current();
    return note ? `«${noteTitle(note)}» буде видалено. Скасувати це не вийде.` : '';
  });

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private readonly textInput = viewChild<ElementRef<HTMLTextAreaElement>>('textInput');
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly noteTitle = noteTitle;
  protected readonly notePreview = notePreview;
  protected readonly isEmptyNote = isEmptyNote;

  constructor() {
    // Пішли з порожньої нотатки (на іншу чи зі сторінки) — її не лишаємо.
    let previous: string | null = null;
    effect(() => {
      const id = this.current()?.id ?? null;
      untracked(() => {
        if (previous && previous !== id) {
          this.dropIfEmpty(previous);
        }
        previous = id;
        this.copied.set(false);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.copiedTimer);
      if (previous) {
        this.dropIfEmpty(previous);
      }
    });
  }

  protected select(note: Note): void {
    this.selectedId.set(note.id);
  }

  /** Нова нотатка й курсор у її назві. Порожня вже відкрита — нова не потрібна. */
  protected newNote(): void {
    const current = this.current();
    if (!current || !isEmptyNote(current)) {
      this.query.set('');
      this.selectedId.set(this.notes.create().id);
    }
    afterNextRender(() => this.titleInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected setTitle(note: Note, event: Event): void {
    this.selectedId.set(note.id);
    this.notes.update(note.id, { title: (event.target as HTMLInputElement).value });
  }

  protected setText(note: Note, event: Event): void {
    this.selectedId.set(note.id);
    this.notes.update(note.id, { text: (event.target as HTMLTextAreaElement).value });
  }

  /** Enter у назві — до тексту, як у звичайних нотатках. */
  protected focusText(event: Event): void {
    event.preventDefault();
    this.textInput()?.nativeElement.focus();
  }

  protected async copy(note: Note): Promise<void> {
    const text = [note.title.trim(), note.text.trim()].filter(Boolean).join('\n\n');
    await navigator.clipboard.writeText(text).catch(() => undefined);
    this.copied.set(true);
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_FOR);
  }

  /** Видалити відкриту нотатку; відкривається наступна в списку. */
  protected remove(): void {
    const note = this.current();
    if (!note) {
      return;
    }
    const list = this.filtered();
    const next = list[list.indexOf(note) + 1] ?? list[list.indexOf(note) - 1] ?? null;
    this.selectedId.set(next?.id ?? null);
    this.notes.remove(note.id);
  }

  protected status(note: Note): string {
    const day = dayOf(note.updated);
    const time = formatTime(note.updated);
    if (day === 'today') {
      return `Змінено сьогодні о ${time}`;
    }
    return day === 'yesterday' ? `Змінено вчора о ${time}` : `Змінено ${dateFormat.format(note.updated)}`;
  }

  /** Час у списку: сьогодні — година, раніше — дата. */
  protected shortTime(time: number): string {
    const day = dayOf(time);
    return day === 'today' ? formatTime(time) : day === 'yesterday' ? 'Вчора' : shortDateFormat.format(time);
  }

  protected counts(note: Note): string {
    const text = note.text.trim();
    const count = text ? text.split(/\s+/).length : 0;
    return `${words(count)} · ${note.text.length} симв.`;
  }

  protected isoTime(time: number): string {
    return new Date(time).toISOString();
  }

  private dropIfEmpty(id: string): void {
    const note = this.notes.entries().find((item) => item.id === id);
    if (note && isEmptyNote(note)) {
      this.notes.remove(id);
    }
  }
}
