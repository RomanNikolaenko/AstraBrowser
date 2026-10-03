import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { PageViews } from './page-views';

describe('PageViews', () => {
  afterEach(() => clearMocks());

  it('should send page bounds one call at a time, always the latest ones', async () => {
    const sent: unknown[] = [];
    let finish = (): void => undefined;
    mockIPC((command, args) => {
      if (command !== 'page_set_bounds') {
        return undefined;
      }
      sent.push((args as { bounds: unknown }).bounds);
      // Перший виклик «застрягає» в дорозі, поки за ним приходять нові межі.
      return sent.length === 1 ? new Promise<void>((resolve) => (finish = resolve)) : undefined;
    });
    const pages = TestBed.inject(PageViews);
    const bounds = (width: number) => ({ x: 0, y: 0, width, height: 100 });

    void pages.setBounds('page-main-1', bounds(1));
    void pages.setBounds('page-main-1', bounds(2));
    void pages.setBounds('page-main-1', bounds(3));
    await new Promise((resolve) => setTimeout(resolve));
    expect(sent).toEqual([bounds(1)]);

    finish();
    await new Promise((resolve) => setTimeout(resolve));
    expect(sent).toEqual([bounds(1), bounds(3)]);
  });
});
