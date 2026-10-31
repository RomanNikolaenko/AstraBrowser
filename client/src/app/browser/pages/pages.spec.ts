import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BookmarksStore } from '../data/bookmarks';
import { DownloadsStore } from '../data/downloads';
import { PageViews } from '../page-views/page-views';
import { BookmarksPage } from './bookmarks-page/bookmarks-page';
import { DownloadsPage } from './downloads-page/downloads-page';
import { HistoryPage } from './history-page/history-page';

describe('internal pages', () => {
  const render = async <T>(page: Type<T>) => {
    await TestBed.configureTestingModule({
      imports: [page],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const fixture = TestBed.createComponent(page);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label));
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

    it('should show a long history in portions as the list is scrolled to its end', { timeout: 20_000 }, async () => {
      // jsdom не має IntersectionObserver: «кінець списку видно» — коли тест так скаже.
      const observers = new Set<{ callback: IntersectionObserverCallback; target?: Element }>();
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          private readonly entry: { callback: IntersectionObserverCallback; target?: Element };
          constructor(callback: IntersectionObserverCallback) {
            this.entry = { callback };
            observers.add(this.entry);
          }
          observe(target: Element) {
            this.entry.target = target;
          }
          disconnect() {
            observers.delete(this.entry);
          }
        }
      );
      const reachEnd = async () => {
        // Копія: колбек може відписатися (observers.delete) просто під час обходу.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const { callback, target } of [...observers]) {
          callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
        await fixture.whenStable();
      };
      seed(
        'astra.history',
        Array.from({ length: 250 }, (_, index) => ({
          id: `${index}`,
          url: `https://site${index}.example/`,
          title: `Сайт ${index}`,
          visitedAt: Date.now() - index * 1000,
        }))
      );
      const { fixture, element, type } = await render(HistoryPage);
      const rows = () => element.querySelectorAll('.page__open').length;

      expect(rows()).toBe(200);
      await reachEnd();
      expect(rows()).toBe(250);
      expect(element.querySelector('.page__end')).toBeNull();

      // Новий пошук — знову з першої порції.
      await type('history-search', 'Сайт');
      expect(rows()).toBe(200);
      vi.unstubAllGlobals();
    });

    it('should open a history entry here or, with the middle button, in a new tab', async () => {
      seed('astra.history', [{ id: '1', url: 'https://github.com/', title: 'GitHub', visitedAt: Date.now() }]);
      const { fixture, element } = await render(HistoryPage);
      const opened: string[][] = [];
      fixture.componentInstance.openUrl.subscribe((url) => opened.push(['here', url]));
      fixture.componentInstance.openUrlInNewTab.subscribe((url) => opened.push(['new-tab', url]));
      const entry = element.querySelector('.page__open') as HTMLButtonElement;

      expect(entry.getAttribute('title')).toBe('https://github.com/');
      entry.click();
      entry.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));

      expect(opened).toEqual([
        ['here', 'https://github.com/'],
        ['new-tab', 'https://github.com/'],
      ]);
    });

    it('should clear browsing data from the history page with the same dialog as in settings', async () => {
      seed('astra.history', [{ id: '1', url: 'https://github.com/', title: 'GitHub', visitedAt: Date.now() }]);
      const { element, text, button, click } = await render(HistoryPage);

      await click(button('Очистити дані перегляду…'));
      expect(text('.clear-data__title')).toEqual(['Очистити дані перегляду і файли cookie']);
      expect(text('.page__name')).toEqual(['GitHub']);

      await click(button('Скасувати'));
      expect(text('.page__name')).toEqual(['GitHub']);

      await click(button('Очистити дані перегляду…'));
      await click(element.querySelector<HTMLButtonElement>('.clear-data__button--primary'));
      await new Promise((resolve) => setTimeout(resolve));
      expect(text('.page__empty-title')).toEqual(['Історія порожня']);
    });
  });

  describe('DownloadsPage', () => {
    it('should show finished and failed downloads', async () => {
      seed('astra.downloads', [
        {
          id: '1',
          fileName: 'report.pdf',
          url: 'https://files.example.com/report.pdf',
          size: 1536,
          status: 'completed',
          finishedAt: Date.now() - 1000,
        },
        {
          id: '2',
          fileName: 'video.mp4',
          url: 'https://cdn.example.com/video.mp4',
          size: 0,
          status: 'failed',
          finishedAt: Date.now(),
        },
      ]);
      const { text } = await render(DownloadsPage);

      expect(text('.page__name')).toEqual(['video.mp4', 'report.pdf']);
      expect(text('.page__meta')).toEqual(['Помилка завантаження · cdn.example.com', 'Завантажено · 1,5 КБ · files.example.com']);
    });

    it('should show what is downloading, open finished files and show them in their folder', async () => {
      // Один момент на обидва записи: інакше між двома Date.now() могла б пройти мілісекунда, і порядок записів «поплив» би.
      const now = Date.now();
      seed('astra.downloads', [
        {
          id: '1',
          fileName: 'report.pdf',
          url: 'https://files.example.com/report.pdf',
          size: 1536,
          status: 'completed',
          finishedAt: now,
          path: 'C:\\Users\\me\\Downloads\\report.pdf',
        },
        {
          id: '2',
          fileName: 'old.zip',
          url: 'https://files.example.com/old.zip',
          size: 10,
          status: 'canceled',
          finishedAt: now - 1000,
        },
      ]);
      const { fixture, element, text, click } = await render(DownloadsPage);
      const pageViews = TestBed.inject(PageViews);
      const open = vi.spyOn(pageViews, 'openDownload').mockResolvedValue();
      const show = vi.spyOn(pageViews, 'showDownload').mockResolvedValue();
      const cancel = vi.spyOn(pageViews, 'cancelDownload').mockResolvedValue();

      TestBed.inject(DownloadsStore).track({
        id: 7,
        url: 'https://cdn.example.com/big.iso',
        path: 'C:\\Users\\me\\Downloads\\big.iso',
        fileName: 'big.iso',
        received: 1024 * 1024,
        total: 4 * 1024 * 1024,
        state: 'in-progress',
      });
      await fixture.whenStable();

      expect(text('.page__group')[0]).toBe('Зараз завантажується');
      // Блоку з текою немає: показати теку можна в кожного запису, хоч би де лежав файл.
      expect(element.querySelector('.downloads-location')).toBeNull();
      const active = element.querySelector('.page__list .page__row') as HTMLElement;
      expect(active.querySelector('.page__time')).toBeNull();
      expect(active.querySelector('[aria-label="Показати «big.iso» у теці"]')).toBeTruthy();
      expect(text('.page__name')).toEqual(['big.iso', 'report.pdf', 'old.zip']);
      expect(text('.page__meta')[0]?.replace(/\s+/g, ' ')).toBe('1 МБ з 4 МБ · cdn.example.com');
      expect(element.querySelector<HTMLElement>('.page__progress-value')?.style.width).toBe('25%');
      expect(text('.page__meta').slice(1)).toEqual(['Завантажено · 1,5 КБ · files.example.com', 'Скасовано · files.example.com']);

      await click(element.querySelector<HTMLButtonElement>('[aria-label="Скасувати завантаження «big.iso»"]'));
      expect(cancel).toHaveBeenCalledWith(7);

      // Скасований файл не відкрити — його немає на диску.
      expect(element.querySelectorAll('.page__link').length).toBe(1);
      await click(element.querySelector<HTMLButtonElement>('.page__link'));
      expect(open).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\report.pdf');
      await click(element.querySelector<HTMLButtonElement>('[aria-label="Показати «report.pdf» у теці"]'));
      expect(show).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\report.pdf');
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
      const { fixture, element, text, click } = await render(BookmarksPage);

      expect(text('.page__name')).toEqual(['YouTube', 'Історія']);
      expect(text('.page__meta')).toEqual(['youtube.com', 'astra://history']);

      const opened: string[] = [];
      fixture.componentInstance.openUrl.subscribe((url) => opened.push(url));
      await click(element.querySelectorAll<HTMLButtonElement>('.page__open')[1]);
      expect(opened).toEqual(['astra://history']);

      await click(element.querySelector<HTMLButtonElement>('[aria-label="Видалити закладку «YouTube»"]'));
      expect(
        TestBed.inject(BookmarksStore)
          .entries()
          .map((bookmark) => bookmark.title)
      ).toEqual(['Історія']);
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
