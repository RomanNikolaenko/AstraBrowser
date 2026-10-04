import { BookmarkItem } from './bookmarks';
import { bookmarksToHtml, countImported, parseBookmarksHtml } from './bookmarks-html';

// Так експортує закладки Chrome (Edge — так само).
const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://www.youtube.com/" ADD_DATE="1">YouTube</A>
        <DT><H3>Робота</H3>
        <DL><p>
            <DT><A HREF="https://github.com/">GitHub &amp; Co</A>
            <DT><A HREF="javascript:alert(1)">Букмарклет</A>
        </DL><p>
        <DT><H3>Порожня</H3>
        <DL><p>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://www.hltv.org/"></A>
    </DL><p>
</DL><p>`;

describe('bookmarks html', () => {
  it('should read folders and links from another browser and skip what cannot be opened', () => {
    const items = parseBookmarksHtml(CHROME_EXPORT);

    expect(items).toEqual([
      {
        type: 'folder',
        title: 'Bookmarks bar',
        children: [
          { type: 'bookmark', title: 'YouTube', url: 'https://www.youtube.com/' },
          { type: 'folder', title: 'Робота', children: [{ type: 'bookmark', title: 'GitHub & Co', url: 'https://github.com/' }] },
        ],
      },
      {
        type: 'folder',
        title: 'Other bookmarks',
        children: [{ type: 'bookmark', title: 'https://www.hltv.org/', url: 'https://www.hltv.org/' }],
      },
    ]);
    expect(countImported(items)).toBe(3);
    expect(parseBookmarksHtml('<p>не закладки</p>')).toEqual([]);
  });

  it('should write a file other browsers read back the same', () => {
    const bar: BookmarkItem[] = [
      { type: 'bookmark', id: '1', title: 'Пошук <Google>', url: 'https://google.com/?q="a"&b' },
      { type: 'separator', id: '2' },
      {
        type: 'folder',
        id: '3',
        title: 'Тека',
        children: [{ type: 'bookmark', id: '4', title: 'HLTV', url: 'https://www.hltv.org/' }],
      },
    ];

    const html = bookmarksToHtml(bar);

    expect(html).toContain('<DT><A HREF="https://google.com/?q=&quot;a&quot;&amp;b">Пошук &lt;Google&gt;</A>');
    expect(parseBookmarksHtml(html)).toEqual([
      {
        type: 'folder',
        title: 'Панель закладок',
        children: [
          { type: 'bookmark', title: 'Пошук <Google>', url: 'https://google.com/?q="a"&b' },
          { type: 'folder', title: 'Тека', children: [{ type: 'bookmark', title: 'HLTV', url: 'https://www.hltv.org/' }] },
        ],
      },
    ]);
  });
});
