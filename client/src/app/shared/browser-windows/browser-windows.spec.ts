import { TestBed } from '@angular/core/testing';
import { BrowserWindows } from './browser-windows';

describe('BrowserWindows', () => {
  // У тестах (як і в ng serve у звичайному браузері) Tauri немає.
  it('should not treat a plain browser window as private', () => {
    expect(TestBed.inject(BrowserWindows).isPrivate).toBe(false);
  });

  it('should fall back to a new browser tab with the home screen outside Tauri', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    TestBed.inject(BrowserWindows).open({ private: true });

    expect(open).toHaveBeenCalledWith('/home', '_blank', 'noopener');
  });
});
