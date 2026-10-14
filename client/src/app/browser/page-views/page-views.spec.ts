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

  describe('a page that is still being created', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const tick = () => new Promise((resolve) => setTimeout(resolve));
    let calls: string[];
    let created: () => void;

    beforeEach(() => {
      calls = [];
      mockIPC((command, args) => {
        const { url } = (args ?? {}) as { url?: string };
        calls.push(url ? `${command} ${url}` : command);
        // Webview створюється не одразу.
        return command === 'page_open' ? new Promise<void>((resolve) => (created = resolve)) : undefined;
      });
    });

    it('should navigate it once it exists, not lose the address', async () => {
      const pages = TestBed.inject(PageViews);
      const opened = pages.open('page-main-1', 'https://a.example/', bounds);
      const navigated = pages.navigate('page-main-1', 'https://b.example/');
      await tick();
      expect(calls).toEqual(['page_open https://a.example/']);

      created();
      await opened;
      await navigated;
      expect(calls).toEqual(['page_open https://a.example/', 'page_navigate https://b.example/']);
    });

    it('should close it as soon as it exists if its tab was closed', async () => {
      const pages = TestBed.inject(PageViews);
      const opened = pages.open('page-main-1', 'https://a.example/', bounds);
      await pages.close('page-main-1');
      await tick();
      expect(calls).toEqual(['page_open https://a.example/']);

      created();
      await expect(opened).rejects.toThrow();
      expect(calls).toEqual(['page_open https://a.example/', 'page_close']);

      // Уже створену — одразу.
      await pages.close('page-main-1');
      expect(calls.at(-1)).toBe('page_close');
    });
  });
});
