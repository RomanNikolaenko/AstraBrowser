import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Note, NotesStore, notePreview, noteTitle } from '../../data/notes';
import { NotesPage } from './notes-page';

describe('NotesPage', () => {
  const note = (id: string, title: string, text: string, updated: number, pinned = false): Note => ({
    id,
    title,
    text,
    pinned,
    created: updated,
    updated,
  });

  const setup = async (notes: Note[] = []) => {
    localStorage.setItem('astra.notes', JSON.stringify(notes));
    await TestBed.configureTestingModule({
      imports: [NotesPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotesPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const click = async (node: Element | null | undefined) => {
      (node as HTMLElement | null)?.click();
      await stable();
    };
    const type = async (selector: string, value: string) => {
      const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (field) {
        field.value = value;
        field.dispatchEvent(new Event('input'));
      }
      await stable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label));
    return { fixture, element, store: TestBed.inject(NotesStore), stable, text, click, type, button };
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('should write a new note that saves itself and drop it if it stays empty', async () => {
    const { element, store, text, click, type, button } = await setup();
    expect(text('.page__empty-title')).toEqual(['Нотаток ще немає']);

    await click(button('Нова нотатка'));
    expect(document.activeElement?.id).toBe('note-title');
    await type('#note-title', 'Покупки');
    await type('#note-text', 'Молоко\nХліб і сир');

    expect(text('.notes__item-title')).toEqual(['Покупки']);
    expect(text('.notes__item-preview')).toEqual(['Молоко Хліб і сир']);
    expect(text('.notes__footer')).toEqual(['4 слова · 17 симв.']);
    expect(text('.notes__status')[0]).toMatch(/^Змінено сьогодні о \d\d:\d\d$/);
    expect(store.entries().map((item) => [item.title, item.text])).toEqual([['Покупки', 'Молоко\nХліб і сир']]);

    // Нова нотатка, яку так і не заповнили, зникає, щойно відкрили іншу.
    await click(button('Нова нотатка'));
    expect(store.entries()).toHaveLength(2);
    await click([...element.querySelectorAll('.notes__item')].find((item) => item.textContent?.includes('Покупки')));
    expect(store.entries().map((item) => item.title)).toEqual(['Покупки']);
  });

  it('should pin, search, copy and remove notes', async () => {
    const { element, store, text, click, type, button } = await setup([
      note('a', 'Ідеї', 'Браузер з нотатками', 3000),
      note('b', '', 'Список справ\nПодзвонити', 2000),
      note('c', 'Рецепт', 'Борщ', 1000),
    ]);
    expect(text('.notes__item-title')).toEqual(['Ідеї', 'Список справ', 'Рецепт']);
    expect(text('.notes__item-preview')).toEqual(['Браузер з нотатками', 'Подзвонити', 'Борщ']);
    expect(element.querySelector<HTMLInputElement>('#note-title')?.value).toBe('Ідеї');

    await click(element.querySelectorAll('.notes__item')[2]);
    await click(element.querySelector('[aria-label="Закріпити нотатку вгорі"]'));
    expect(text('.notes__item-title')).toEqual(['Рецепт', 'Ідеї', 'Список справ']);
    expect(element.querySelector('.notes__item .notes__item-pin')).toBeTruthy();

    await click(element.querySelector('[aria-label="Скопіювати текст нотатки"]'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Рецепт\n\nБорщ');

    await type('#notes-search', 'справ');
    expect(text('.notes__item-title')).toEqual(['Список справ']);
    await type('#notes-search', 'нічого');
    expect(text('.page__no-results')[0]).toContain('нічого');
    await type('#notes-search', '');

    await click(element.querySelector('[aria-label="Видалити нотатку"]'));
    expect(text('.confirm-dialog__message')).toEqual(['«Рецепт» буде видалено. Скасувати це не вийде.']);
    await click(element.querySelector('.confirm-dialog__button--confirm'));
    expect(store.entries().map((item) => item.id)).toEqual(['a', 'b']);
    expect(element.querySelector<HTMLInputElement>('#note-title')?.value).toBe('Ідеї');
    expect(button('Нова нотатка')).toBeTruthy();
  });
});

describe('note titles', () => {
  const note = (title: string, text: string): Note => ({ id: '1', title, text, pinned: false, created: 0, updated: 0 });

  it('should fall back to the first line and keep the preview short', () => {
    expect(noteTitle(note('', '\n  Перший рядок \nДругий'))).toBe('Перший рядок');
    expect(noteTitle(note('', ''))).toBe('Нова нотатка');
    expect(notePreview(note('', 'Назва\nТекст'))).toBe('Текст');
    expect(notePreview(note('Назва', 'Текст\nще'))).toBe('Текст ще');
    expect(notePreview(note('Назва', 'а'.repeat(200)), 10)).toBe(`${'а'.repeat(10)}…`);
  });
});
