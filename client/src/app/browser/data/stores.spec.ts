import { TestBed } from '@angular/core/testing';
import { BookmarksStore } from './bookmarks';
import { DownloadsStore } from './downloads';
import { FaviconStore } from './favicons';
import { HistoryStore } from './history';

describe('browser data stores', () => {
  beforeEach(() => localStorage.clear());

  it('should keep history newest first and remove or clear it', () => {
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

  it('should keep downloads newest first', () => {
    const downloads = TestBed.inject(DownloadsStore);
    downloads.add({ fileName: 'old.zip', url: 'https://a.example/old.zip', size: 10, status: 'completed', finishedAt: 1 });
    downloads.add({ fileName: 'new.zip', url: 'https://a.example/new.zip', size: 10, status: 'failed', finishedAt: 2 });

    expect(downloads.entries().map((entry) => entry.fileName)).toEqual(['new.zip', 'old.zip']);
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
