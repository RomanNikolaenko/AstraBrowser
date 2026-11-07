import { TestBed } from '@angular/core/testing';
import {
  accountKey,
  accountSignal,
  adoptLegacyData,
  flushStoredSignals,
  mergeStoredList,
  onStoredChange,
  removeAccountData,
  setStorageAccount,
  storedSignal,
  writeStored,
} from './stored-signal';

describe('storedSignal', () => {
  const create = <T>(key: string, fallback: T) => TestBed.runInInjectionContext(() => storedSignal(key, fallback));

  beforeEach(() => localStorage.clear());

  it('should start from the fallback and persist changes', () => {
    const state = create('test.items', ['a']);
    expect(state()).toEqual(['a']);

    state.set(['a', 'b']);
    TestBed.tick();

    expect(JSON.parse(localStorage.getItem('test.items') ?? 'null')).toEqual(['a', 'b']);
  });

  it('should not read the whole value back from storage on every change', () => {
    const state = create('test.items', ['a']);
    const read = vi.spyOn(Storage.prototype, 'getItem');

    state.set(['a', 'b']);
    TestBed.tick();
    state.set(['a', 'b']);
    TestBed.tick();

    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('test.items') ?? 'null')).toEqual(['a', 'b']);
    read.mockRestore();
  });

  it('should take a value written by sync without reporting it as a change', () => {
    const state = create('test.items', ['a']);
    const changes: string[] = [];
    const stop = onStoredChange((key) => changes.push(key));

    writeStored('test.items', ['from the server']);
    TestBed.tick();
    expect(state()).toEqual(['from the server']);
    expect(changes).toEqual([]);

    state.set(['here']);
    TestBed.tick();
    expect(changes).toEqual(['test.items']);
    expect(JSON.parse(localStorage.getItem('test.items') ?? 'null')).toEqual(['here']);
    stop();
  });

  it('should not write back what it has just read or been given', () => {
    localStorage.setItem('test.items', JSON.stringify(['saved']));
    const state = create('test.items', ['fallback']);
    const write = vi.spyOn(Storage.prototype, 'setItem');

    TestBed.tick();
    writeStored('test.items', ['synced']);
    TestBed.tick();

    expect(state()).toEqual(['synced']);
    // Лише сам writeStored.
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it('should restore the saved value', () => {
    localStorage.setItem('test.items', JSON.stringify(['saved']));

    expect(create('test.items', ['fallback'])()).toEqual(['saved']);
  });

  it('should fall back when the saved value is broken', () => {
    localStorage.setItem('test.items', '{not json');

    expect(create('test.items', ['fallback'])()).toEqual(['fallback']);
  });

  it('should pick up changes made in another window', () => {
    const state = create('test.items', ['a']);

    localStorage.setItem('test.items', JSON.stringify(['from another window']));
    window.dispatchEvent(new StorageEvent('storage', { key: 'test.items', newValue: '["from another window"]' }));

    expect(state()).toEqual(['from another window']);
    TestBed.tick();

    // Ключ прибрали в іншому вікні — це вікно його не відновлює.
    localStorage.removeItem('test.items');
    window.dispatchEvent(new StorageEvent('storage', { key: 'test.items', newValue: null }));
    TestBed.tick();
    expect(state()).toEqual(['from another window']);
    expect(localStorage.getItem('test.items')).toBeNull();
  });
  describe('accounts', () => {
    const ID = '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d';

    afterEach(() => setStorageAccount(null));

    it('should keep the data of each account under its own keys', () => {
      setStorageAccount(ID);
      const notes = TestBed.runInInjectionContext(() => accountSignal('astra.notes', ['a']));
      notes.set(['mine']);
      TestBed.tick();

      expect(accountKey('astra.notes')).toBe(`astra.${ID}.notes`);
      expect(JSON.parse(localStorage.getItem(`astra.${ID}.notes`) ?? 'null')).toEqual(['mine']);
      expect(localStorage.getItem('astra.notes')).toBeNull();
    });

    it('should give the data from before accounts to the first account, but keep the device settings', () => {
      localStorage.setItem('astra.bookmarks', '[1]');
      localStorage.setItem('astra.profile.account', '"old"');
      localStorage.setItem('astra.settings.theme', '"dark"');
      localStorage.setItem(`astra.${ID}.notes`, '["already scoped"]');

      adoptLegacyData(ID);

      expect(localStorage.getItem(`astra.${ID}.bookmarks`)).toBe('[1]');
      expect(localStorage.getItem('astra.bookmarks')).toBeNull();
      expect(localStorage.getItem(`astra.${ID}.profile.account`)).toBeNull();
      expect(localStorage.getItem('astra.settings.theme')).toBe('"dark"');
      expect(localStorage.getItem(`astra.${ID}.notes`)).toBe('["already scoped"]');
    });

    it('should remove all the data of a deleted account and nothing else', () => {
      const other = '2a1d3b8f-66c2-4d4f-8e2b-8e2f2a3c4d5e';
      localStorage.setItem(`astra.${ID}.notes`, '["mine"]');
      localStorage.setItem(`astra.${ID}.sync.base`, '{}');
      localStorage.setItem(`astra.${other}.notes`, '["theirs"]');
      localStorage.setItem('astra.settings.theme', '"dark"');

      removeAccountData(ID);

      expect(Object.keys(localStorage).sort()).toEqual([`astra.${other}.notes`, 'astra.settings.theme']);
    });
  });

  it('should tell listeners about changes from this window and from others', () => {
    const changed: string[] = [];
    const stop = onStoredChange((key) => changed.push(key));
    const state = create('test.items', ['a']);

    state.set(['b']);
    TestBed.tick();
    window.dispatchEvent(new StorageEvent('storage', { key: 'test.other' }));
    stop();

    expect(changed).toEqual(['test.items', 'test.other']);
  });
});

describe('buffered storedSignal', () => {
  interface Item {
    readonly id: string;
    readonly text: string;
  }
  const key = 'test.buffered';
  const initial: readonly Item[] = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ];
  const create = (storageKey = key) => {
    localStorage.setItem(storageKey, JSON.stringify(initial));
    return TestBed.runInInjectionContext(() =>
      storedSignal<readonly Item[]>(storageKey, [], { delayMs: 300, merge: mergeStoredList })
    );
  };
  const saved = (storageKey = key) => JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Item[] | null;
  const edit = (items: readonly Item[], id: string, text: string) =>
    items.map((item) => (item.id === id ? { ...item, text } : item));

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    setStorageAccount(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should coalesce typing without postponing persistence indefinitely', () => {
    const state = create();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    for (const text of ['one', 'two', 'three']) {
      state.update((items) => edit(items, 'a', text));
      TestBed.tick();
      vi.advanceTimersByTime(100);
    }
    expect(state()[0].text).toBe('three');
    expect(saved()?.[0].text).toBe('three');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(['pagehide', 'beforeunload'])('should flush the last input on %s even before the effect runs', (event) => {
    const state = create();
    state.update((items) => edit(items, 'a', 'last character'));
    window.dispatchEvent(new Event(event));
    expect(saved()?.[0].text).toBe('last character');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    TestBed.tick();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it('should flush pending changes when the owner is destroyed', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'before destruction'));
    TestBed.resetTestingModule();
    expect(saved()?.[0].text).toBe('before destruction');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should merge unrelated edits and additions received from another window', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'local'));
    TestBed.tick();
    const remote = [...edit(initial, 'b', 'remote'), { id: 'c', text: 'new elsewhere' }];
    localStorage.setItem(key, JSON.stringify(remote));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(remote) }));
    TestBed.tick();
    vi.advanceTimersByTime(300);
    expect(saved()).toEqual([
      { id: 'a', text: 'local' },
      { id: 'b', text: 'remote' },
      { id: 'c', text: 'new elsewhere' },
    ]);
    expect(state()).toEqual(saved());
  });

  it('should merge a newer stored value even if its storage event has not arrived yet', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'local'));
    TestBed.tick();
    localStorage.setItem(key, JSON.stringify(edit(initial, 'b', 'remote')));
    vi.advanceTimersByTime(300);
    expect(saved()).toEqual([
      { id: 'a', text: 'local' },
      { id: 'b', text: 'remote' },
    ]);
  });

  it('should keep the original write deadline while another window keeps changing the collection', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'local'));
    TestBed.tick();
    for (const text of ['remote 1', 'remote 2']) {
      vi.advanceTimersByTime(100);
      const remote = edit(initial, 'b', text);
      localStorage.setItem(key, JSON.stringify(remote));
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(remote) }));
      TestBed.tick();
    }
    vi.advanceTimersByTime(100);
    expect(saved()).toEqual([
      { id: 'a', text: 'local' },
      { id: 'b', text: 'remote 2' },
    ]);
  });

  it('should not resurrect a record deleted in either window', () => {
    const state = create();
    state.set([{ id: 'a', text: 'locally edited but remotely deleted' }]);
    localStorage.setItem(key, JSON.stringify([{ id: 'b', text: 'remotely edited but locally deleted' }]));
    flushStoredSignals();
    expect(saved()).toEqual([]);
  });

  it('should adopt a sync write without later replaying the pending value', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'pending'));
    TestBed.tick();
    const changed = vi.fn();
    const stop = onStoredChange(changed);
    writeStored(key, [{ id: 'server', text: 'merged by sync' }]);
    TestBed.tick();
    vi.advanceTimersByTime(1000);
    expect(saved()).toEqual([{ id: 'server', text: 'merged by sync' }]);
    expect(state()).toEqual(saved());
    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it('should flush to the original account before switching accounts', () => {
    const oldAccount = '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d';
    setStorageAccount(oldAccount);
    const storageKey = accountKey('astra.notes');
    const state = create(storageKey);
    state.update((items) => edit(items, 'a', 'old account edit'));
    setStorageAccount('2a1d3b8f-66c2-4d4f-8e2b-8e2f2a3c4d5e');
    expect(saved(storageKey)?.[0].text).toBe('old account edit');
    expect(localStorage.getItem(accountKey('astra.notes'))).toBeNull();
  });

  it('should cancel pending writes when the account is deleted', () => {
    const account = '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d';
    const storageKey = accountKey('astra.notes', account);
    const state = create(storageKey);
    state.update((items) => edit(items, 'a', 'must not be restored'));
    TestBed.tick();
    removeAccountData(account);
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event('pagehide'));
    TestBed.resetTestingModule();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('should not restore a key removed before its storage event arrives', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'pending'));
    TestBed.tick();
    localStorage.removeItem(key);
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('should ignore an old write event received after account deletion', () => {
    const account = '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d';
    const storageKey = accountKey('astra.notes', account);
    const state = create(storageKey);
    state.update((items) => [...items, { id: 'new', text: 'pending' }]);
    TestBed.tick();
    removeAccountData(account);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: JSON.stringify(initial) }));
    TestBed.tick();
    vi.advanceTimersByTime(1000);
    flushStoredSignals();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('should retain local changes after a storage failure and retry only at a later flush', () => {
    const state = create();
    state.update((items) => edit(items, 'a', 'unsaved'));
    TestBed.tick();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    vi.advanceTimersByTime(300);
    TestBed.tick();
    expect(state()[0].text).toBe('unsaved');
    expect(vi.getTimerCount()).toBe(0);
    write.mockRestore();
    flushStoredSignals();
    expect(saved()?.[0].text).toBe('unsaved');
  });
});
