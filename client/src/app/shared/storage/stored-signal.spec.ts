import { TestBed } from '@angular/core/testing';
import {
  accountKey,
  accountSignal,
  adoptLegacyData,
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
