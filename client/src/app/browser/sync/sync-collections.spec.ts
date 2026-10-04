import { buildBookmarks, flattenBookmarks } from './sync-collections';
import { canonicalJson, hashOf } from './sync-hash';

describe('sync collections', () => {
  const tree = [
    { type: 'bookmark', id: 'b1', title: 'Пошта', url: 'https://mail.example.com' },
    {
      type: 'folder',
      id: 'f1',
      title: 'Робота',
      color: 'blue',
      children: [
        { type: 'bookmark', id: 'b2', title: 'Задачі', url: 'https://tasks.example.com' },
        { type: 'separator', id: 's1' },
      ],
    },
  ];

  it('should split bookmarks into records with their folder and place, and put the tree back together', () => {
    const flat = flattenBookmarks(tree);

    expect(flat.get('b2')).toEqual({
      type: 'bookmark',
      title: 'Задачі',
      url: 'https://tasks.example.com',
      parent: 'f1',
      index: 0,
    });
    expect(flat.get('f1')).toEqual({ type: 'folder', title: 'Робота', color: 'blue', parent: null, index: 1 });
    expect(buildBookmarks(flat)).toEqual(tree);
  });

  it('should move a bookmark whose folder is gone, or folders inside each other, onto the bar', () => {
    const flat = flattenBookmarks(tree);
    flat.set('b3', { type: 'bookmark', title: 'Сирота', url: 'https://orphan.example.com', parent: 'deleted', index: 0 });
    flat.set('x', { type: 'folder', title: 'X', parent: 'y', index: 0 });
    flat.set('y', { type: 'folder', title: 'Y', parent: 'x', index: 0 });

    const ids = buildBookmarks(flat).map((item) => item.id);

    expect(ids).toEqual(['b1', 'b3', 'f1', 'x']);
  });

  it('should give the same fingerprint whatever the order of the fields', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(hashOf({ a: 1, b: 'текст' })).toBe(hashOf({ b: 'текст', a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
