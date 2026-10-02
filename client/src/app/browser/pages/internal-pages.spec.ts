import { formatSize, groupByDay, hostname, matchesQuery } from './internal-pages';

describe('internal page helpers', () => {
  it('should group items into today, yesterday and older dates', () => {
    const now = new Date(2026, 9, 2, 14, 0).getTime();
    const items = [
      { title: 'today', time: new Date(2026, 9, 2, 9, 30).getTime() },
      { title: 'yesterday', time: new Date(2026, 9, 1, 23, 59).getTime() },
      { title: 'older', time: new Date(2026, 8, 28, 12, 0).getTime() },
    ];

    const groups = groupByDay(items, (item) => item.time, now);

    expect(groups.map((group) => group.label)).toEqual(['Сьогодні', 'Вчора', expect.stringContaining('28 вересня 2026')]);
    expect(groups.map((group) => group.items.map((item) => item.title))).toEqual([['today'], ['yesterday'], ['older']]);
  });

  it('should format sizes with Ukrainian units', () => {
    expect(formatSize(512)).toBe('512 Б');
    expect(formatSize(1536)).toBe('1,5 КБ');
    expect(formatSize(5 * 1024 * 1024)).toBe('5 МБ');
  });

  it('should show a short host name', () => {
    expect(hostname('https://www.youtube.com/watch?v=1')).toBe('youtube.com');
    expect(hostname('not a url')).toBe('not a url');
  });

  it('should search case-insensitively across fields', () => {
    expect(matchesQuery('', 'Anything')).toBe(true);
    expect(matchesQuery('ютуб', 'YouTube', 'https://ЮТУБ.example')).toBe(true);
    expect(matchesQuery('github', 'YouTube', undefined)).toBe(false);
  });
});
