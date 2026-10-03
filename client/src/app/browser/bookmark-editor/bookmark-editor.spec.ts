import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BookmarksStore } from '../data/bookmarks';
import { BookmarkEditor } from './bookmark-editor';

@Component({
  imports: [BookmarkEditor],
  template: `<app-bookmark-editor [pageTitle]="title()" [pageUrl]="url()" />`,
})
class Host {
  readonly title = signal('Історія');
  readonly url = signal('astra://history');
}

describe('BookmarkEditor', () => {
  beforeEach(() => localStorage.clear());

  const setup = async (title = 'Історія', url = 'astra://history') => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.title.set(title);
    fixture.componentInstance.url.set(url);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const field = (id: string) => element.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
    // jsdom не має Popover API: відкриття — це подія toggle з newState, як її шле браузер.
    const open = async () => {
      element.querySelector('.bookmark-editor .popover')?.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await fixture.whenStable();
    };
    const type = async (id: string, value: string) => {
      field(id).value = value;
      field(id).dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const click = async (label: string) => {
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)?.click();
      await fixture.whenStable();
    };
    return { element, field, open, type, click };
  };

  it('should prefill the current page and save it as a bookmark', async () => {
    const { element, field, open, click } = await setup();

    await open();
    expect(element.querySelector('.bookmark-editor__title')?.textContent).toBe('Додати закладку');
    expect(field('bookmark-editor-title').value).toBe('Історія');
    expect(field('bookmark-editor-url').value).toBe('astra://history');
    expect(document.activeElement).toBe(field('bookmark-editor-title'));

    await click('Зберегти');

    expect(TestBed.inject(BookmarksStore).entries().map((bookmark) => [bookmark.title, bookmark.url])).toEqual([['Історія', 'astra://history']]);
  });

  it('should let you type a site on an empty new tab', async () => {
    const { element, field, open, type, click } = await setup('Нова вкладка', '');

    await open();
    expect(field('bookmark-editor-title').value).toBe('');

    await click('Зберегти');
    const errors = () => [...element.querySelectorAll('.ui-input__message--visible .ui-input__error')].map((error) => error.textContent?.trim());
    expect(errors()).toEqual(['Введіть назву', 'Введіть адресу']);

    await type('bookmark-editor-title', 'Angular');
    await type('bookmark-editor-url', 'angular.dev');
    await click('Зберегти');

    expect(TestBed.inject(BookmarksStore).find('https://angular.dev/')?.title).toBe('Angular');
  });

  it('should edit and remove an existing bookmark of the page', async () => {
    localStorage.setItem('astra.bookmarks', JSON.stringify([{ id: '1', title: 'Моя історія', url: 'astra://history' }]));
    const { element, field, open, type, click } = await setup();

    await open();
    expect(element.querySelector('.bookmark-editor__title')?.textContent).toBe('Редагувати закладку');
    expect(field('bookmark-editor-title').value).toBe('Моя історія');

    await type('bookmark-editor-title', 'Історія переглядів');
    await click('Зберегти');
    expect(TestBed.inject(BookmarksStore).entries()).toEqual([{ id: '1', title: 'Історія переглядів', url: 'astra://history' }]);

    await open();
    await click('Видалити');
    expect(TestBed.inject(BookmarksStore).entries()).toEqual([]);
  });
});
