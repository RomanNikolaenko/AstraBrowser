import { Bookmark } from '../data/bookmarks';
import { HistoryEntry } from '../data/history';
import { displayUrl, inlineCompletion, localSuggestions, withSearchSuggestions } from './suggestions';

describe('omnibox suggestions', () => {
  const now = Date.UTC(2026, 9, 5);
  const visit = (url: string, title: string, daysAgo = 0): HistoryEntry => ({
    id: crypto.randomUUID(),
    url,
    title,
    visitedAt: now - daysAgo * 86_400_000,
  });
  const bookmark = (url: string, title: string): Bookmark => ({ type: 'bookmark', id: crypto.randomUUID(), url, title });
  const sources = (
    history: HistoryEntry[] = [],
    bookmarks: Bookmark[] = [],
    tabs: { id: number; title: string; url: string }[] = []
  ) => ({
    history,
    bookmarks,
    tabs,
    engine: 'Google',
  });
  const titles = (input: string, from = sources()) =>
    localSuggestions(input, from, now).map((item) => `${item.kind}: ${item.title}`);

  it('should start with what Enter does: search the text or go to the address', () => {
    expect(titles('як варити борщ')).toEqual(['search: як варити борщ']);
    expect(localSuggestions('як варити борщ', sources(), now)[0].detail).toBe('Пошук у Google');
    expect(titles('angular.dev/guide')).toEqual(['url: angular.dev/guide']);
    expect(titles('   ')).toEqual([]);
  });

  it('should rank sites that start with the text first, then frequent and recent pages', () => {
    const history = [
      visit('https://www.youtube.com/', 'YouTube', 1),
      visit('https://www.youtube.com/', 'YouTube', 2),
      visit('https://music.youtube.com/', 'YouTube Music', 0),
      visit('https://news.example.com/you-and-me', 'You and me', 30),
      visit('https://github.com/', 'GitHub'),
    ];
    expect(titles('you', sources(history))).toEqual([
      'search: you',
      'history: YouTube',
      'history: YouTube Music',
      'history: You and me',
    ]);
  });

  it('should offer open tabs and bookmarks without repeating the same address', () => {
    const history = [visit('https://angular.dev/', 'Angular'), visit('https://angular.dev/guide/signals', 'Signals')];
    const bookmarks = [bookmark('https://angular.dev/guide/signals', 'Сигнали Angular')];
    const tabs = [{ id: 7, title: 'Angular', url: 'https://angular.dev/' }];
    const result = localSuggestions('angular', sources(history, bookmarks, tabs), now);
    expect(result.map((item) => `${item.kind}: ${item.title}`)).toEqual([
      'search: angular',
      'tab: Angular',
      'bookmark: Сигнали Angular',
    ]);
    expect(result[1]).toEqual(expect.objectContaining({ tabId: 7 }));
  });

  it('should match every typed word in the title or the address', () => {
    const history = [
      visit('https://shop.example.com/phones', 'Телефони Samsung'),
      visit('https://shop.example.com/tv', 'Телевізори'),
    ];
    expect(titles('shop samsung', sources(history))).toEqual(['search: shop samsung', 'history: Телефони Samsung']);
  });

  it('should add search engine suggestions after its own, without the typed text', () => {
    const local = localSuggestions('angular', sources([visit('https://angular.dev/', 'Angular')]), now);
    const all = withSearchSuggestions('angular', local, ['angular', 'angular signals', 'Angular Material'], 'Google');
    expect(all.map((item) => `${item.kind}: ${item.title}`)).toEqual([
      'search: angular',
      'history: Angular',
      'search: angular signals',
      'search: Angular Material',
    ]);
  });

  it('should complete the address of a known site inline, but not words or full addresses it does not know', () => {
    const suggestions = localSuggestions('you', sources([visit('https://www.youtube.com/watch?v=1', 'Відео')]), now);
    expect(inlineCompletion('you', suggestions)).toEqual({ text: 'youtube.com', url: 'https://www.youtube.com/' });
    // Великі літери, як надрукували, лишаються.
    expect(
      inlineCompletion('YouT', localSuggestions('YouT', sources([visit('https://youtube.com/', 'YouTube')]), now))?.text
    ).toBe('YouTube.com');
    // З «/» — до всієї адреси.
    expect(inlineCompletion('youtube.com/wa', suggestions)).toEqual({
      text: 'youtube.com/watch?v=1',
      url: 'https://www.youtube.com/watch?v=1',
    });
    expect(inlineCompletion('you tube', suggestions)).toBeNull();
    expect(inlineCompletion('youtube.com', suggestions)).toBeNull();
    expect(inlineCompletion('git', suggestions)).toBeNull();
  });

  it('should show addresses the way they are typed', () => {
    expect(displayUrl('https://www.github.com/')).toBe('github.com');
    expect(displayUrl('http://example.com/a/b')).toBe('example.com/a/b');
  });
});
