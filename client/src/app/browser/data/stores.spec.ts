import { TestBed } from '@angular/core/testing';
import { BookmarksStore, bookmarkIcon } from './bookmarks';
import { DownloadsStore } from './downloads';
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

  it('should start with the default bookmarks and save new ones after them', () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    expect(bookmarks.entries().map((bookmark) => bookmark.title)).toEqual(['Робота', 'YouTube', 'GitHub', 'Figma', 'Пошта', 'Документи']);

    bookmarks.add('Angular', 'https://angular.dev/');
    bookmarks.remove('default-youtube');
    TestBed.tick();

    const titles = bookmarks.entries().map((bookmark) => bookmark.title);
    expect(titles).toEqual(['Робота', 'GitHub', 'Figma', 'Пошта', 'Документи', 'Angular']);
    expect(JSON.parse(localStorage.getItem('astra.bookmarks') ?? '[]').length).toBe(6);
  });

  it('should pick the bookmark icon', () => {
    expect(bookmarkIcon({ id: '1', title: 'GitHub', url: 'https://github.com', favicon: 'favicon-github' })).toBe('favicon-github');
    expect(bookmarkIcon({ id: '2', title: 'Сайт', url: 'https://example.com' })).toBe('globe');
    expect(bookmarkIcon({ id: '3', title: 'Папка' })).toBe('favicon-folder');
  });
});
