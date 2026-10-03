import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Bookmark, BookmarkItem, BookmarksStore } from '../data/bookmarks';
import { BookmarksBar } from './bookmarks-bar';

@Component({
  imports: [BookmarksBar],
  template: `
    <app-bookmarks-bar
      pageTitle="Angular"
      pageUrl="https://angular.dev/"
      (openBookmark)="log('open', [$event])"
      (openBookmarkInNewTab)="log('new-tab', [$event])"
      (openBookmarks)="log('all', $event)" />
  `,
})
class Host {
  readonly opened: string[][] = [];

  log(kind: string, bookmarks: readonly Bookmark[]): void {
    this.opened.push([kind, ...bookmarks.map((bookmark) => bookmark.title)]);
  }
}

describe('BookmarksBar', () => {
  beforeEach(() => localStorage.clear());

  const setup = async (fill: (bookmarks: BookmarksStore) => void = () => undefined) => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const bookmarks = TestBed.inject(BookmarksStore);
    fill(bookmarks);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = () => fixture.whenStable();

    /** Панель так, як її видно: назви, теки в дужках і роздільники. */
    const bar = () =>
      [...element.querySelectorAll('.bookmarks__item')].map((item) =>
        item.querySelector('.bookmarks__separator')
          ? '|'
          : item.querySelector('[aria-haspopup]')
            ? `[${item.querySelector('.bookmark')?.textContent?.trim()}]`
            : item.querySelector('.bookmark')?.textContent?.trim()
      );
    const shape = (items: readonly BookmarkItem[] = bookmarks.bar()): unknown[] =>
      items.map((item) =>
        item.type === 'folder' ? { [item.title]: shape(item.children) } : item.type === 'separator' ? '|' : item.title
      );
    const rightClick = async (target: Element | null) => {
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 48 }));
      await stable();
    };
    const itemAt = (index: number) => element.querySelectorAll('.bookmarks__item')[index];
    const menu = () =>
      [...element.querySelectorAll<HTMLButtonElement>('.bookmarks-menu [role="menuitem"]')].map((item) =>
        item.disabled ? `(${item.textContent?.trim()})` : item.textContent?.trim()
      );
    const choose = async (label: string) => {
      [...element.querySelectorAll<HTMLButtonElement>('.bookmarks-menu [role="menuitem"]')]
        .find((item) => item.textContent?.trim() === label)
        ?.click();
      await stable();
    };
    const field = (id: string) => element.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
    const type = async (id: string, value: string) => {
      field(id).value = value;
      field(id).dispatchEvent(new Event('input'));
      await stable();
    };
    const save = async () => {
      element.querySelector<HTMLButtonElement>('.bookmark-dialog [type="submit"]')?.click();
      await stable();
    };
    return { fixture, element, bookmarks, bar, shape, rightClick, itemAt, menu, choose, field, type, save };
  };

  it('should offer the Firefox bar menu on its free space', async () => {
    const { element, rightClick, menu } = await setup();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.querySelector('.bookmarks')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await rightClick(element.querySelector('.bookmarks__empty'));
    // Закладок ще немає — відкривати нічого.
    expect(menu()).toEqual(['(Відкрити всі закладки)', 'Додати закладку…', 'Додати теку…', 'Додати роздільник']);
    expect(element.querySelectorAll('.bookmarks-menu [role="separator"]').length).toBe(1);
  });

  it('should open all bookmarks of the bar, but not those in its folders', async () => {
    const { fixture, element, rightClick, menu, choose } = await setup((bookmarks) => {
      bookmarks.add('A', 'https://a.example/');
      bookmarks.addFolder('Тека');
      bookmarks.add('B', 'https://b.example/');
      bookmarks.add('C', 'https://c.example/', { folder: bookmarks.bar()[1].id });
    });

    await rightClick(element.querySelector('.bookmarks'));
    expect(menu()[0]).toBe('Відкрити всі закладки');
    await choose('Відкрити всі закладки');

    expect(fixture.componentInstance.opened).toEqual([['all', 'A', 'B']]);
  });

  it('should add a separator at the end or before the bookmark it was asked on', async () => {
    const { element, bar, rightClick, itemAt, choose } = await setup((bookmarks) => {
      bookmarks.add('A', 'https://a.example/');
      bookmarks.add('B', 'https://b.example/');
    });
    // Самі по собі роздільників між закладками немає.
    expect(bar()).toEqual(['A', 'B']);

    await rightClick(element.querySelector('.bookmarks'));
    await choose('Додати роздільник');
    expect(bar()).toEqual(['A', 'B', '|']);

    await rightClick(itemAt(1));
    await choose('Додати роздільник');
    expect(bar()).toEqual(['A', '|', 'B', '|']);

    // Роздільник можна лише прибрати.
    await rightClick(itemAt(3));
    expect(element.querySelector('.bookmarks-menu [role="menuitem"]')?.textContent?.trim()).toBe('Видалити');
    await choose('Видалити');
    expect(bar()).toEqual(['A', '|', 'B']);
  });

  it('should add a folder named in a form at the place of the click', async () => {
    const { element, bar, rightClick, itemAt, choose, field, type, save } = await setup((bookmarks) => {
      bookmarks.add('A', 'https://a.example/');
    });

    await rightClick(itemAt(0));
    await choose('Додати теку…');
    expect(element.querySelector('.bookmark-dialog__title')?.textContent).toBe('Нова тека');
    expect(field('bookmark-dialog-title').value).toBe('Нова тека');
    expect(document.activeElement).toBe(field('bookmark-dialog-title'));
    expect(field('bookmark-dialog-url')).toBeNull();

    await type('bookmark-dialog-title', 'Робота');
    await save();
    expect(bar()).toEqual(['[Робота]', 'A']);
  });

  it('should add a bookmark prefilled with the current page and check the address', async () => {
    const { element, bar, rightClick, choose, field, type, save } = await setup();

    await rightClick(element.querySelector('.bookmarks'));
    await choose('Додати закладку…');
    expect(element.querySelector('.bookmark-dialog__title')?.textContent).toBe('Нова закладка');
    expect(field('bookmark-dialog-title').value).toBe('Angular');
    expect(field('bookmark-dialog-url').value).toBe('https://angular.dev/');

    await type('bookmark-dialog-url', 'не адреса');
    await save();
    expect(element.querySelector('.bookmark-dialog .ui-input__message--visible')?.textContent).toContain(
      'Некоректна адреса сайту'
    );
    expect(bar()).toEqual([]);

    await type('bookmark-dialog-url', 'angular.dev/overview');
    await save();
    expect(bar()).toEqual(['Angular']);
    expect(TestBed.inject(BookmarksStore).find('https://angular.dev/overview')).toBeTruthy();
  });

  it('should open, edit and remove the bookmark it was asked on', async () => {
    const { fixture, element, bar, rightClick, itemAt, menu, choose, field, type, save } = await setup((bookmarks) => {
      bookmarks.add('A', 'https://a.example/');
      bookmarks.add('B', 'https://b.example/');
    });

    await rightClick(itemAt(1));
    expect(menu()).toEqual([
      'Відкрити в новій вкладці',
      'Редагувати…',
      'Видалити',
      'Додати закладку…',
      'Додати теку…',
      'Додати роздільник',
    ]);

    await choose('Відкрити в новій вкладці');
    expect(fixture.componentInstance.opened).toEqual([['new-tab', 'B']]);

    await rightClick(itemAt(1));
    await choose('Редагувати…');
    expect(element.querySelector('.bookmark-dialog__title')?.textContent).toBe('Редагувати закладку');
    expect([field('bookmark-dialog-title').value, field('bookmark-dialog-url').value]).toEqual(['B', 'https://b.example/']);
    await type('bookmark-dialog-title', 'Бе');
    await save();
    expect(bar()).toEqual(['A', 'Бе']);

    await rightClick(itemAt(0));
    await choose('Видалити');
    expect(bar()).toEqual(['Бе']);
  });

  it('should show a folder as a menu and manage what is inside it', async () => {
    const { fixture, element, bookmarks, shape, rightClick, menu, choose, type, save } = await setup((store) => {
      store.addFolder('Робота');
      store.add('Пошта', 'https://mail.example/', { folder: store.bar()[0].id });
      store.addFolder('Архів', { folder: store.bar()[0].id });
    });
    const folderButton = element.querySelector<HTMLButtonElement>('.bookmark[aria-haspopup]');
    const folderMenu = () => element.querySelector('.bookmark-folder-menu .popover') as HTMLElement;
    const folderItems = () =>
      [...folderMenu().querySelectorAll(':scope > .bookmark-folder-menu__list > li')].map(
        (item) => item.querySelector('.bookmark-folder-menu__label')?.textContent
      );

    expect(folderButton?.getAttribute('popovertarget')).toBe(folderMenu().id);
    expect(folderItems()).toEqual(['Пошта', 'Архів']);
    // Порожня вкладена тека так і каже.
    expect(
      folderMenu().querySelector('.bookmark-folder-menu .bookmark-folder-menu .bookmark-folder-menu__empty')?.textContent?.trim()
    ).toBe('Порожньо');

    folderMenu().querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.opened).toEqual([['open', 'Пошта']]);

    // Правий клік у теці додає в саму теку — перед пунктом, на якому клацнули.
    await rightClick(folderMenu().querySelectorAll('[role="menuitem"]')[1]);
    await choose('Додати теку…');
    await type('bookmark-dialog-title', 'Нове');
    await save();
    expect(shape()).toEqual([{ Робота: ['Пошта', { Нове: [] }, { Архів: [] }] }]);

    // На самій теці: відкрити всі її закладки чи перейменувати.
    await rightClick(element.querySelector('.bookmarks__item'));
    expect(menu()).toEqual([
      'Відкрити всі закладки',
      'Перейменувати…',
      'Видалити',
      'Додати закладку…',
      'Додати теку…',
      'Додати роздільник',
    ]);
    await choose('Відкрити всі закладки');
    expect(fixture.componentInstance.opened.at(-1)).toEqual(['all', 'Пошта']);

    await rightClick(element.querySelector('.bookmarks__item'));
    await choose('Перейменувати…');
    expect(element.querySelector('.bookmark-dialog__title')?.textContent).toBe('Перейменувати теку');
    await type('bookmark-dialog-title', 'Справи');
    await save();
    expect(shape()).toEqual([{ Справи: ['Пошта', { Нове: [] }, { Архів: [] }] }]);
    expect(bookmarks.entries().map((bookmark) => bookmark.title)).toEqual(['Пошта']);
  });

  it('should give a folder a color, change it and take it away', async () => {
    const { element, bookmarks, rightClick, choose, save } = await setup();
    const colors = () => [...element.querySelectorAll<HTMLInputElement>('.bookmark-dialog [name="folder-color"]')];
    const pick = async (label: string) => {
      colors()
        .find((color) => color.getAttribute('aria-label') === label)
        ?.click();
      await save();
    };
    const folderIcon = () => element.querySelector<HTMLElement>('.bookmarks__item app-icon');

    await rightClick(element.querySelector('.bookmarks'));
    await choose('Додати теку…');
    expect(colors().map((color) => color.getAttribute('aria-label'))).toEqual([
      'Без кольору',
      'Червоний',
      'Помаранчевий',
      'Жовтий',
      'Зелений',
      'Бірюзовий',
      'Синій',
      'Фіолетовий',
      'Рожевий',
    ]);
    expect(colors()[0].checked).toBe(true);

    await pick('Синій');
    expect(bookmarks.bar()[0]).toMatchObject({ type: 'folder', title: 'Нова тека', color: 'blue' });
    expect(folderIcon()?.style.color).toBe('rgb(62, 123, 250)');

    // Перейменування показує поточний колір і змінює його.
    await rightClick(element.querySelector('.bookmarks__item'));
    await choose('Перейменувати…');
    expect(
      colors()
        .find((color) => color.checked)
        ?.getAttribute('aria-label')
    ).toBe('Синій');
    await pick('Без кольору');
    expect(bookmarks.bar()[0]).not.toHaveProperty('color');
    expect(folderIcon()?.style.color).toBe('');
  });

  it('should move through the menu with the arrow keys', async () => {
    const { element, rightClick } = await setup();
    await rightClick(element.querySelector('.bookmarks'));
    const items = [...element.querySelectorAll<HTMLButtonElement>('.bookmarks-menu [role="menuitem"]:not(:disabled)')];
    const key = (name: string) =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

    expect(document.activeElement).toBe(items[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement).toBe(items[2]);
    key('Home');
    expect(document.activeElement).toBe(items[0]);
  });

  describe('drag and drop', () => {
    // jsdom не має DragEvent і розмітки: подія — з координатами, а кожен елемент — 100×20 від (0, 0).
    const dragEvent = (type: string, x = 50, y = 10) =>
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        clientX: x,
        clientY: y,
        dataTransfer: { setData: () => undefined, effectAllowed: '', dropEffect: '' },
      });

    beforeEach(() => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 100,
        bottom: 20,
        width: 100,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    });
    afterEach(() => vi.restoreAllMocks());

    const fill = (store: BookmarksStore) => {
      store.add('A', 'https://a.example/');
      store.addFolder('Тека');
      store.add('B', 'https://b.example/');
      store.add('X', 'https://x.example/', { folder: store.bar()[1].id });
      store.add('Y', 'https://y.example/', { folder: store.bar()[1].id });
    };

    it('should move a bookmark along the bar and show where it lands', async () => {
      const { fixture, element, shape, itemAt } = await setup(fill);
      const source = itemAt(0).querySelector('.bookmark') as HTMLElement;

      source.dispatchEvent(dragEvent('dragstart'));
      const over = dragEvent('dragover', 90);
      itemAt(2).dispatchEvent(over);
      await fixture.whenStable();
      expect(over.defaultPrevented).toBe(true);
      expect(itemAt(0).classList).toContain('bookmarks__item--dragging');
      expect(itemAt(2).classList).toContain('bookmarks__item--drop-after');

      itemAt(2).dispatchEvent(dragEvent('drop', 90));
      source.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();

      expect(shape()).toEqual([{ Тека: ['X', 'Y'] }, 'B', 'A']);
      expect(element.querySelector('[class*="--drop-"], .bookmarks__item--dragging')).toBeNull();
    });

    it('should put a bookmark into a folder dropped on its middle and take it out again', async () => {
      const { fixture, element, shape, itemAt } = await setup(fill);
      const drag = async (source: Element, over: Element, x: number, y = 10) => {
        source.dispatchEvent(dragEvent('dragstart'));
        over.dispatchEvent(dragEvent('dragover', x, y));
        await fixture.whenStable();
        over.dispatchEvent(dragEvent('drop', x, y));
        source.dispatchEvent(dragEvent('dragend'));
        await fixture.whenStable();
      };
      const folderEntries = () => [...element.querySelectorAll('.bookmark-folder-menu .bookmark-folder-menu__entry')];

      // Середина теки — у теку (в кінець), краї — поруч із нею.
      itemAt(2).querySelector('.bookmark')?.dispatchEvent(dragEvent('dragstart'));
      itemAt(1).dispatchEvent(dragEvent('dragover', 50));
      await fixture.whenStable();
      expect(itemAt(1).classList).toContain('bookmarks__item--drop-into');
      itemAt(1).dispatchEvent(dragEvent('drop', 50));
      element.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();
      expect(shape()).toEqual(['A', { Тека: ['X', 'Y', 'B'] }]);

      // З теки — на панель, перед A (ліва половина).
      await drag(folderEntries()[0].querySelector('button') as Element, itemAt(0), 10);
      expect(shape()).toEqual(['X', 'A', { Тека: ['Y', 'B'] }]);

      // Усередині теки — вгору (верхня половина пункту).
      await drag(folderEntries()[1].querySelector('button') as Element, folderEntries()[0], 50, 5);
      expect(shape()).toEqual(['X', 'A', { Тека: ['B', 'Y'] }]);
    });

    it('should not let a folder go into itself or a folder inside it', async () => {
      const { fixture, shape, itemAt } = await setup((store) => {
        store.addFolder('Тека');
        store.addFolder('Вкладена', { folder: store.bar()[0].id });
      });
      const folder = itemAt(0).querySelector('.bookmark') as HTMLElement;
      const nested = itemAt(0).querySelector('.bookmark-folder-menu__entry') as HTMLElement;

      folder.dispatchEvent(dragEvent('dragstart'));
      const over = dragEvent('dragover', 50, 10);
      nested.dispatchEvent(over);
      await fixture.whenStable();

      expect(over.defaultPrevented).toBe(false);
      expect(nested.classList).not.toContain('bookmark-folder-menu__entry--drop-into');
      nested.dispatchEvent(dragEvent('drop', 50, 10));
      folder.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();
      expect(shape()).toEqual([{ Тека: [{ Вкладена: [] }] }]);
    });

    it('should drop into an empty folder and onto the free end of the bar', async () => {
      const { fixture, element, shape, itemAt } = await setup((store) => {
        store.add('A', 'https://a.example/');
        store.addFolder('Порожня');
        store.addSeparator();
      });
      const empty = element.querySelector('.bookmark-folder-menu__empty') as HTMLElement;
      const source = itemAt(0).querySelector('.bookmark') as HTMLElement;

      source.dispatchEvent(dragEvent('dragstart'));
      empty.dispatchEvent(dragEvent('dragover'));
      await fixture.whenStable();
      expect(empty.classList).toContain('bookmark-folder-menu__empty--drop');
      empty.dispatchEvent(dragEvent('drop'));
      source.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();
      expect(shape()).toEqual([{ Порожня: ['A'] }, '|']);

      // Роздільник теж тягнеться — на вільне місце панелі, тобто в кінець.
      const separator = element.querySelector('.bookmarks__separator') as HTMLElement;
      const nav = element.querySelector('.bookmarks') as HTMLElement;
      separator.dispatchEvent(dragEvent('dragstart'));
      itemAt(0).dispatchEvent(dragEvent('dragover', 10));
      await fixture.whenStable();
      nav.dispatchEvent(dragEvent('drop'));
      separator.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();
      expect(shape()).toEqual(['|', { Порожня: ['A'] }]);
    });

    it('should leave everything in place when the drag is cancelled', async () => {
      const { fixture, element, shape, itemAt } = await setup(fill);
      const source = itemAt(0).querySelector('.bookmark') as HTMLElement;

      source.dispatchEvent(dragEvent('dragstart'));
      itemAt(2).dispatchEvent(dragEvent('dragover', 90));
      await fixture.whenStable();
      source.dispatchEvent(dragEvent('dragend'));
      await fixture.whenStable();

      expect(shape()).toEqual(['A', { Тека: ['X', 'Y'] }, 'B']);
      expect(element.querySelector('[class*="--drop-"]')).toBeNull();
    });
  });
});
