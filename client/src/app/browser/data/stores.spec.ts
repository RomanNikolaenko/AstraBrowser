import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../../shared/settings/settings';
import { BookmarkItem, BookmarksStore } from './bookmarks';
import { DOWNLOADS_LIMIT, DownloadsStore } from './downloads';
import { FaviconStore } from './favicons';
import { HISTORY_LIMIT, HistoryStore } from './history';

describe('browser data stores', () => {
  beforeEach(() => localStorage.clear());

  it('should keep history newest first and remove or clear it', () => {
    // Записи з 1970 року: щоб їх не прибрало як давні, історія — «Завжди».
    TestBed.inject(SettingsStore).historyDays.set(0);
    const history = TestBed.inject(HistoryStore);
    history.record('https://a.example', 'A', 1000);
    history.record('https://b.example', 'B', 3000);
    history.record('https://c.example', 'C', 2000);

    expect(history.entries().map((entry) => entry.title)).toEqual(['B', 'C', 'A']);

    history.remove(history.entries()[0].id);
    expect(history.entries().map((entry) => entry.title)).toEqual(['C', 'A']);

    history.clear();
    expect(history.entries()).toEqual([]);
  });

  it('should drop history older than the chosen number of days', () => {
    const day = 86_400_000;
    const history = TestBed.inject(HistoryStore);
    history.record('https://old.example', 'Давно', Date.now() - 100 * day);
    history.record('https://month.example', 'Місяць тому', Date.now() - 40 * day);
    history.record('https://today.example', 'Сьогодні');

    // Стандартно — 90 днів, як у Chrome.
    expect(history.entries().map((entry) => entry.title)).toEqual(['Сьогодні', 'Місяць тому']);

    TestBed.inject(SettingsStore).historyDays.set(30);
    TestBed.tick();
    expect(history.entries().map((entry) => entry.title)).toEqual(['Сьогодні']);
  });

  it('should keep only the latest entries of a history kept forever', () => {
    TestBed.inject(SettingsStore).historyDays.set(0);
    // Повна історія — одразу в сховище: десять тисяч відвідувань по одному — секунди, і під навантаженням тест не встигав.
    const saved = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
      id: `${index}`,
      url: `https://site${index}.example`,
      title: `${index}`,
      visitedAt: 1000 + index,
    }));
    localStorage.setItem('astra.history', JSON.stringify(saved));
    const history = TestBed.inject(HistoryStore);
    expect(history.entries()).toHaveLength(HISTORY_LIMIT);

    history.record('https://newest.example', 'Найновіший', 1000 + HISTORY_LIMIT);

    expect(history.entries()).toHaveLength(HISTORY_LIMIT);
    expect(history.entries()[0].title).toBe('Найновіший');
    expect(history.entries().at(-1)?.title).toBe('1');
  });

  it('should follow a download while it runs and record how it ended', () => {
    const downloads = TestBed.inject(DownloadsStore);
    const progress = (id: number, received: number, state: 'in-progress' | 'completed' | 'canceled' = 'in-progress') =>
      downloads.track({
        id,
        url: `https://x.example/${id}.zip`,
        path: `C:\\D\\${id}.zip`,
        fileName: `${id}.zip`,
        received,
        total: 100,
        state,
      });

    progress(1, 10);
    progress(2, 0);
    progress(1, 60);
    expect(downloads.active().map((download) => [download.id, download.received])).toEqual([
      [2, 0],
      [1, 60],
    ]);
    expect(downloads.started()).toBe(2);
    expect(downloads.recent()).toEqual([]);

    progress(1, 100, 'completed');
    progress(2, 5, 'canceled');
    expect(downloads.active()).toEqual([]);
    expect(downloads.recent().map((entry) => [entry.fileName, entry.status, entry.size, entry.path])).toEqual([
      ['2.zip', 'canceled', 5, 'C:\\D\\2.zip'],
      ['1.zip', 'completed', 100, 'C:\\D\\1.zip'],
    ]);
    expect(downloads.started()).toBe(2);
  });

  it('should keep downloads newest first', () => {
    // Записи з 1970 року: щоб їх не прибрало як давні, список — «Завжди».
    TestBed.inject(SettingsStore).downloadsDays.set(0);
    const downloads = TestBed.inject(DownloadsStore);
    downloads.add({ fileName: 'old.zip', url: 'https://a.example/old.zip', size: 10, status: 'completed', finishedAt: 1 });
    downloads.add({ fileName: 'new.zip', url: 'https://a.example/new.zip', size: 10, status: 'failed', finishedAt: 2 });

    expect(downloads.entries().map((entry) => entry.fileName)).toEqual(['new.zip', 'old.zip']);
  });

  it('should keep only the latest downloads', () => {
    TestBed.inject(SettingsStore).downloadsDays.set(0);
    const downloads = TestBed.inject(DownloadsStore);
    for (let index = 0; index <= DOWNLOADS_LIMIT; index++) {
      downloads.add({ fileName: `${index}.zip`, url: 'https://a.example/', size: 1, status: 'completed', finishedAt: index });
    }

    expect(downloads.entries()).toHaveLength(DOWNLOADS_LIMIT);
    expect(downloads.entries()[0].fileName).toBe(`${DOWNLOADS_LIMIT}.zip`);
    expect(downloads.entries().at(-1)?.fileName).toBe('1.zip');
  });

  it('should drop downloads older than the chosen number of days, but not the files', () => {
    const day = 86_400_000;
    const downloads = TestBed.inject(DownloadsStore);
    const add = (fileName: string, finishedAt: number) =>
      downloads.add({ fileName, url: 'https://a.example/', size: 1, status: 'completed', finishedAt });
    add('old.zip', Date.now() - 100 * day);
    add('month.zip', Date.now() - 40 * day);
    add('today.zip', Date.now());

    // Стандартно — 90 днів, як історія.
    expect(downloads.entries().map((entry) => entry.fileName)).toEqual(['today.zip', 'month.zip']);

    TestBed.inject(SettingsStore).downloadsDays.set(30);
    TestBed.tick();
    expect(downloads.entries().map((entry) => entry.fileName)).toEqual(['today.zip']);
  });

  it('should start empty and drop the demo bookmarks saved by older versions', () => {
    localStorage.setItem(
      'astra.bookmarks',
      JSON.stringify([
        { id: 'default-youtube', title: 'YouTube', url: 'https://www.youtube.com', favicon: 'favicon-youtube' },
        { id: 'mine', title: 'Моя', url: 'https://mine.example/' },
      ])
    );

    expect(
      TestBed.inject(BookmarksStore)
        .entries()
        .map((bookmark) => bookmark.title)
    ).toEqual(['Моя']);
  });

  it('should add, find, update and remove bookmarks', () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    expect(bookmarks.entries()).toEqual([]);

    bookmarks.add('Angular', 'https://angular.dev/');
    const added = bookmarks.find('https://angular.dev/');
    expect(added?.title).toBe('Angular');
    expect(bookmarks.find('')).toBeUndefined();

    bookmarks.update(added?.id ?? '', { title: 'Angular docs', url: 'https://angular.dev/overview' });
    expect(bookmarks.entries().map((bookmark) => [bookmark.title, bookmark.url])).toEqual([
      ['Angular docs', 'https://angular.dev/overview'],
    ]);

    bookmarks.remove(added?.id ?? '');
    TestBed.tick();
    expect(bookmarks.entries()).toEqual([]);
    expect(localStorage.getItem('astra.bookmarks')).toBe('[]');
  });

  it('should read bookmarks saved before folders existed as plain bookmarks', () => {
    localStorage.setItem('astra.bookmarks', JSON.stringify([{ id: 'old', title: 'Стара', url: 'https://old.example/' }]));

    expect(TestBed.inject(BookmarksStore).bar()).toEqual([
      { type: 'bookmark', id: 'old', title: 'Стара', url: 'https://old.example/' },
    ]);
  });

  it('should keep folders and separators on the bar in place', () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    const shape = (items: readonly BookmarkItem[] = bookmarks.bar()): unknown[] =>
      items.map((item) =>
        item.type === 'folder' ? { [item.title]: shape(item.children) } : item.type === 'separator' ? '|' : item.title
      );

    bookmarks.add('A', 'https://a.example/');
    bookmarks.add('B', 'https://b.example/');
    bookmarks.addSeparator({ folder: null, index: 1 });
    bookmarks.addFolder('Робота', { folder: null, index: 0 });
    expect(shape()).toEqual([{ Робота: [] }, 'A', '|', 'B']);

    const work = bookmarks.bar()[0].id;
    bookmarks.add('Пошта', 'https://mail.example/', { folder: work });
    bookmarks.addFolder('Архів', { folder: work });
    bookmarks.add('Старе', 'https://old.example/', { folder: bookmarks.folder(work)?.children[1].id ?? '' });
    expect(shape()).toEqual([{ Робота: ['Пошта', { Архів: ['Старе'] }] }, 'A', '|', 'B']);

    // Пошук і сторінка закладок бачать і закладки з тек, а «Відкрити всі» — лише ті, що в самій теці.
    expect(bookmarks.entries().map((bookmark) => bookmark.title)).toEqual(['Пошта', 'Старе', 'A', 'B']);
    expect(bookmarks.find('https://old.example/')?.title).toBe('Старе');
    expect(bookmarks.bookmarksOf(work).map((bookmark) => bookmark.title)).toEqual(['Пошта']);
    expect(bookmarks.bookmarksOf(null).map((bookmark) => bookmark.title)).toEqual(['A', 'B']);

    bookmarks.update(work, { title: 'Справи' });
    bookmarks.update(bookmarks.find('https://old.example/')?.id ?? '', { title: 'Найстаріше', url: 'https://oldest.example/' });
    expect(shape()).toEqual([{ Справи: ['Пошта', { Архів: ['Найстаріше'] }] }, 'A', '|', 'B']);
    expect(bookmarks.find('https://oldest.example/')).toBeTruthy();

    // Тека зникає разом з усім, що в ній.
    bookmarks.remove(work);
    bookmarks.remove(bookmarks.bar()[1].id);
    expect(shape()).toEqual(['A', 'B']);
  });

  it('should color folders and move bookmarks between them', () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    bookmarks.addFolder('Робота', { folder: null }, 'blue');
    const work = bookmarks.bar()[0].id;
    bookmarks.addFolder('Архів', { folder: work });
    const archive = bookmarks.folder(work)?.children[0].id ?? '';
    bookmarks.add('Пошта', 'https://mail.example/');
    const mail = bookmarks.find('https://mail.example/')?.id ?? '';

    expect(bookmarks.folder(work)?.color).toBe('blue');
    expect(bookmarks.folders()).toEqual([
      { id: work, path: 'Робота' },
      { id: archive, path: 'Робота › Архів' },
    ]);

    // Назву без кольору — колір лишається; color: undefined — прибирає його.
    bookmarks.update(work, { title: 'Справи' });
    expect(bookmarks.folder(work)?.color).toBe('blue');
    bookmarks.update(work, { title: 'Справи', color: 'green' });
    expect(bookmarks.folder(work)?.color).toBe('green');
    bookmarks.update(work, { title: 'Справи', color: undefined });
    expect(bookmarks.folder(work)).not.toHaveProperty('color');

    expect(bookmarks.parentOf(mail)).toBeNull();
    bookmarks.move(mail, { folder: archive });
    expect(bookmarks.parentOf(mail)).toBe(archive);
    expect(bookmarks.bar().map((item) => item.id)).toEqual([work]);
    bookmarks.move(mail, { folder: null });
    expect(bookmarks.bar().map((item) => item.id)).toEqual([work, mail]);

    // Тека не може опинитися в самій собі.
    bookmarks.move(work, { folder: archive });
    expect(bookmarks.parentOf(work)).toBeNull();
    expect(bookmarks.parentOf(archive)).toBe(work);

    // Невідомий колір зі сховища не ламає теку.
    localStorage.setItem(
      'astra.bookmarks',
      JSON.stringify([{ type: 'folder', id: 'f', title: 'Тека', children: [], color: 'plaid' }])
    );
    TestBed.resetTestingModule();
    expect(TestBed.inject(BookmarksStore).bar()).toEqual([{ type: 'folder', id: 'f', title: 'Тека', children: [] }]);
  });

  it('should move items to a place as it was before the move', () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    const titles = () => bookmarks.bar().map((item) => (item.type === 'separator' ? '|' : item.title));
    for (const title of ['A', 'B', 'C', 'D']) {
      bookmarks.add(title, `https://${title.toLowerCase()}.example/`);
    }
    const id = (title: string) => bookmarks.bar().find((item) => item.type !== 'separator' && item.title === title)?.id ?? '';

    // Місце рахується до перенесення: «перед D» для A — це третє місце після того, як A прибрали.
    bookmarks.move(id('A'), { folder: null, index: 3 });
    expect(titles()).toEqual(['B', 'C', 'A', 'D']);
    bookmarks.move(id('D'), { folder: null, index: 0 });
    expect(titles()).toEqual(['D', 'B', 'C', 'A']);
    // На своє ж місце (перед собою чи одразу після себе) — нічого не змінюється.
    bookmarks.move(id('B'), { folder: null, index: 1 });
    bookmarks.move(id('B'), { folder: null, index: 2 });
    expect(titles()).toEqual(['D', 'B', 'C', 'A']);

    bookmarks.addFolder('Тека', { folder: null, index: 0 });
    const folder = bookmarks.bar()[0].id;
    bookmarks.move(id('C'), { folder });
    bookmarks.move(id('A'), { folder, index: 0 });
    expect(bookmarks.folder(folder)?.children.map((item) => (item.type === 'separator' ? '|' : item.title))).toEqual(['A', 'C']);
    expect(titles()).toEqual(['Тека', 'D', 'B']);

    expect(bookmarks.canMove(folder, folder)).toBe(false);
    expect(bookmarks.canMove(folder, null)).toBe(true);
    expect(bookmarks.canMove('немає', null)).toBe(false);
  });

  it('should use the icon a site reported, then its favicon.ico, then nothing', () => {
    const favicons = TestBed.inject(FaviconStore);
    expect(favicons.iconFor('https://www.youtube.com/watch?v=1')).toBe('https://www.youtube.com/favicon.ico');
    expect(favicons.iconFor('astra://history')).toBeNull();

    favicons.remember('https://www.youtube.com/', 'https://www.youtube.com/s/desktop/favicon_32x32.png');
    TestBed.tick();
    expect(favicons.iconFor('https://www.youtube.com/watch?v=1')).toBe('https://www.youtube.com/s/desktop/favicon_32x32.png');
    expect(JSON.parse(localStorage.getItem('astra.favicons') ?? '{}')).toEqual({
      'www.youtube.com': 'https://www.youtube.com/s/desktop/favicon_32x32.png',
    });

    favicons.markBroken('https://www.youtube.com/s/desktop/favicon_32x32.png');
    expect(favicons.iconFor('https://www.youtube.com/')).toBe('https://www.youtube.com/favicon.ico');
    favicons.markBroken('https://www.youtube.com/favicon.ico');
    expect(favicons.iconFor('https://www.youtube.com/')).toBeNull();
  });

  it('should forget saved icons together with the history', () => {
    const favicons = TestBed.inject(FaviconStore);
    favicons.remember('https://a.example/', 'https://a.example/icon.svg');

    TestBed.inject(HistoryStore).clear();

    expect(favicons.iconFor('https://a.example/')).toBe('https://a.example/favicon.ico');
  });
});
