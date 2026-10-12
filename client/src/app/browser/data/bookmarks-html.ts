import type { BookmarkItem } from './bookmarks';
import { translate } from '../../shared/i18n/i18n';

/** Закладка чи тека з файла закладок іншого браузера — ще без id. */
export type ImportedBookmark =
  | { readonly type: 'bookmark'; readonly title: string; readonly url: string }
  | { readonly type: 'folder'; readonly title: string; readonly children: readonly ImportedBookmark[] };

/**
 * Файл закладок HTML (формат Netscape), який експортують Chrome, Edge, Firefox і Opera:
 * &lt;DL&gt; — список, &lt;DT&gt;&lt;H3&gt; — тека (її вміст — наступний &lt;DL&gt;), &lt;DT&gt;&lt;A HREF&gt; — закладка.
 * Беруться лише адреси http(s): букмарклети (javascript:) і службові адреси пропускаються.
 */
export function parseBookmarksHtml(html: string): ImportedBookmark[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const root = document.querySelector('dl');
  return root ? readList(root) : [];
}

function readList(list: Element): ImportedBookmark[] {
  // Розбір HTML вкладає теки по-різному (DL всередині DT чи поряд), тож беремо пункти саме цього списку.
  const items = [...list.querySelectorAll('dt')].filter((item) => item.closest('dl') === list);
  return items.flatMap((item): ImportedBookmark[] => {
    const heading = [...item.children].find((child) => child.tagName === 'H3');
    if (heading) {
      const nested =
        [...item.children].find((child) => child.tagName === 'DL') ??
        (item.nextElementSibling?.tagName === 'DL' ? item.nextElementSibling : null);
      const children = nested ? readList(nested) : [];
      return children.length ? [{ type: 'folder', title: heading.textContent?.trim() || translate('Тека'), children }] : [];
    }
    const link = [...item.children].find((child): child is HTMLAnchorElement => child.tagName === 'A');
    const url = link?.getAttribute('href')?.trim() ?? '';
    if (!link || !/^https?:\/\//i.test(url)) {
      return [];
    }
    return [{ type: 'bookmark', title: link.textContent?.trim() || url, url }];
  });
}

/** Скільки закладок (без тек) у дереві. */
export function countImported(items: readonly ImportedBookmark[]): number {
  return items.reduce((count, item) => count + (item.type === 'folder' ? countImported(item.children) : 1), 0);
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Закладки у файл HTML (формат Netscape), який відкриють інші браузери: панель — тека «Панель закладок». */
export function bookmarksToHtml(items: readonly BookmarkItem[]): string {
  const list = (children: readonly BookmarkItem[], depth: number): string[] => {
    const indent = '    '.repeat(depth);
    return children.flatMap((item) => {
      if (item.type === 'bookmark') {
        return [`${indent}<DT><A HREF="${escape(item.url)}">${escape(item.title)}</A>`];
      }
      if (item.type === 'folder') {
        return [
          `${indent}<DT><H3>${escape(item.title)}</H3>`,
          `${indent}<DL><p>`,
          ...list(item.children, depth + 1),
          `${indent}</DL><p>`,
        ];
      }
      return [];
    });
  };
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    `<!-- ${translate('Закладки Astra Browser. Цей файл можна імпортувати в будь-який браузер.')} -->`,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">${escape(translate('Панель закладок'))}</H3>`,
    '    <DL><p>',
    ...list(items, 2),
    '    </DL><p>',
    '</DL><p>',
    '',
  ].join('\n');
}
