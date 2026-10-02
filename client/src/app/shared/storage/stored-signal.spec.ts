import { TestBed } from '@angular/core/testing';
import { storedSignal } from './stored-signal';

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
    window.dispatchEvent(new StorageEvent('storage', { key: 'test.items' }));

    expect(state()).toEqual(['from another window']);
  });
});
