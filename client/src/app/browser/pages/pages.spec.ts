import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BookmarksStore } from '../data/bookmarks';
import { BookmarksPage } from './bookmarks-page/bookmarks-page';
import { DownloadsPage } from './downloads-page/downloads-page';
import { HistoryPage } from './history-page/history-page';

describe('internal pages', () => {
  const render = async <T>(page: Type<T>) => {
    await TestBed.configureTestingModule({
      imports: [page],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(page);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const button = (label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label));
    const type = async (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`);
      if (input) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
      }
      await fixture.whenStable();
    };
    const click = async (node: HTMLElement | null | undefined) => {
      node?.click();
      await fixture.whenStable();
    };
    return { fixture, element, text, button, type, click };
  };

  beforeEach(() => localStorage.clear());

  // Сховища читають localStorage під час створення, тож дані кладемо туди до рендеру сторінки.
  const seed = (key: string, items: unknown[]) => localStorage.setItem(key, JSON.stringify(items));

  describe('HistoryPage', () => {
    it('should show the empty state', async () => {
      const { element, text } = await render(HistoryPage);

      expect(text('.page__empty-title')).toEqual(['Історія порожня']);
      expect(element.querySelector('#history-search')).toBeNull();
    });

    it('should group, search and remove entries', async () => {
      seed('astra.history', [
        { id: '1', url: 'https://www.youtube.com/', title: 'YouTube', visitedAt: Date.now() - 1000 },
        { id: '2', url: 'https://github.com/', title: 'GitHub', visitedAt: Date.now() },
      ]);
      const { element, text, type, click } = await render(HistoryPage);

      expect(text('.page__group')).toEqual(['Сьогодні']);
      expect(text('.page__name')).toEqual(['GitHub', 'YouTube']);
      expect(text('.page__meta')).toEqual(['github.com', 'youtube.com']);

      await type('history-search', 'tube');
      expect(text('.page__name')).toEqual(['YouTube']);

      await type('history-search', 'немає такого');
      expect(text('.page__no-results')).toEqual(['Нічого не знайдено за запитом «немає такого».']);

      await type('history-search', '');
      await click(element.querySelector<HTMLButtonElement>('[aria-label="Видалити «GitHub» з історії"]'));
      expect(text('.page__name')).toEqual(['YouTube']);
    });

    it('should clear history only after confirmation', async () => {
      seed('astra.history', [{ id: '1', url: 'https://github.com/', title: 'GitHub', visitedAt: Date.now() }]);
      const { element, text, button, click } = await render(HistoryPage);

      await click(button('Очистити історію'));
      expect(text('.page__name')).toEqual(['GitHub']);

      await click(button('Скасувати'));
      expect(text('.page__confirm')).toEqual([]);

      await click(button('Очистити історію'));
      await click(element.querySelector<HTMLButtonElement>('.page__confirm .page__button--danger'));
      expect(text('.page__empty-title')).toEqual(['Історія порожня']);
    });
  });

  describe('DownloadsPage', () => {
    it('should show finished and failed downloads', async () => {
      seed('astra.downloads', [
        { id: '1', fileName: 'report.pdf', url: 'https://files.example.com/report.pdf', size: 1536, status: 'completed', finishedAt: Date.now() - 1000 },
        { id: '2', fileName: 'video.mp4', url: 'https://cdn.example.com/video.mp4', size: 0, status: 'failed', finishedAt: Date.now() },
      ]);
      const { text } = await render(DownloadsPage);

      expect(text('.page__name')).toEqual(['video.mp4', 'report.pdf']);
      expect(text('.page__meta')).toEqual(['Помилка завантаження · cdn.example.com', '1,5 КБ · files.example.com']);
    });
  });

  describe('BookmarksPage', () => {
    it('should show the empty state when there are no bookmarks', async () => {
      const { text } = await render(BookmarksPage);

      expect(text('.page__empty-title')).toEqual(['Закладок немає']);
    });

    it('should list the bookmarks and remove one', async () => {
      seed('astra.bookmarks', [
        { id: '1', title: 'YouTube', url: 'https://www.youtube.com/' },
        { id: '2', title: 'Історія', url: 'astra://history' },
      ]);
      const { element, text, click } = await render(BookmarksPage);

      expect(text('.page__name')).toEqual(['YouTube', 'Історія']);
      expect(text('.page__meta')).toEqual(['youtube.com', 'astra://history']);

      await click(element.querySelector<HTMLButtonElement>('[aria-label="Видалити закладку «YouTube»"]'));
      expect(TestBed.inject(BookmarksStore).entries().map((bookmark) => bookmark.title)).toEqual(['Історія']);
    });

    it('should validate and add a new bookmark', async () => {
      const { element, text, button, type, click } = await render(BookmarksPage);

      await click(button('Додати закладку'));
      await click(button('Зберегти'));
      expect(text('.ui-input__message--visible .ui-input__error')).toEqual(['Введіть назву', 'Введіть адресу']);

      await type('bookmark-title', 'Angular');
      await type('bookmark-url', 'not a url');
      expect(text('.ui-input__message--visible .ui-input__error')).toEqual(['Некоректна адреса сайту']);

      await type('bookmark-url', 'angular.dev');
      await click(button('Зберегти'));

      expect(element.querySelector('.bookmark-form')).toBeNull();
      const added = TestBed.inject(BookmarksStore).entries().at(-1);
      expect(added).toEqual(expect.objectContaining({ title: 'Angular', url: 'https://angular.dev/' }));
      expect(text('.page__name').at(-1)).toBe('Angular');
    });
  });
});
