import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PageViews } from '../page-views/page-views';
import { Screenshot, screenshotFileName } from './screenshot';

describe('Screenshot', () => {
  it('should name the file after the site and the moment', () => {
    expect(screenshotFileName('https://www.hltv.org/news', new Date(2026, 9, 4, 7, 5, 9))).toBe(
      'Скріншот hltv.org 2026-10-04 07-05-09.png'
    );
    expect(screenshotFileName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('Скріншот 2026-01-02 03-04-05.png');
  });

  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Screenshot],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(Screenshot);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, element, pageViews: TestBed.inject(PageViews) };
  };

  it('should explain that only a site can be captured', async () => {
    const { fixture, element } = await setup();

    await fixture.componentInstance.start(null);
    await fixture.whenStable();

    expect(element.querySelector('.screenshot__message')?.textContent?.trim()).toBe(
      'Скріншот можна зробити лише для сайту — відкрийте сайт у вкладці.'
    );
    element.querySelector<HTMLButtonElement>('.screenshot__button--primary')?.click();
    await fixture.whenStable();
    expect(element.querySelector('.screenshot__panel')).toBeNull();
  });

  it('should tell when the page could not be captured', async () => {
    const { fixture, element, pageViews } = await setup();
    vi.spyOn(pageViews, 'screenshot').mockRejectedValue('немає сторінки');

    await fixture.componentInstance.start({
      label: 'page-1',
      bounds: { x: 0, y: 100, width: 800, height: 600 },
      url: 'https://a.example/',
    });
    await fixture.whenStable();

    expect(pageViews.screenshot).toHaveBeenCalledWith('page-1', false);
    expect(element.querySelector('.screenshot__message')?.textContent).toContain('Не вдалося зняти сторінку');
  });

  describe('keyboard', () => {
    // jsdom не розкодовує картинок і не малює на canvas: знімок «читається» одразу, а вирізання дає готовий PNG.
    class LoadedImage {
      naturalWidth = 1600;
      naturalHeight = 1200;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) {
        setTimeout(() => this.onload?.());
      }
    }

    beforeEach(() => {
      vi.stubGlobal('Image', LoadedImage);
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(readonly items: Record<string, Blob>) {}
        }
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: vi.fn().mockResolvedValue(undefined) },
      });
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: vi.fn() });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
      HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
        callback(new Blob(['png'], { type: 'image/png' }));
      };
    });

    afterEach(() => vi.unstubAllGlobals());

    const settle = async (fixture: { whenStable: () => Promise<unknown> }) => {
      for (let step = 0; step < 3; step++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
      }
    };

    it('should take the visible part on Enter, then copy on Ctrl+C and save on Ctrl+S', async () => {
      const { fixture, element, pageViews } = await setup();
      vi.spyOn(pageViews, 'screenshot').mockResolvedValue(new ArrayBuffer(8));
      const save = vi.spyOn(pageViews, 'saveScreenshot').mockResolvedValue('C:\\Users\\me\\Pictures\\shot.png');
      const dialog = () => element.querySelector('dialog') as HTMLDialogElement;
      const press = async (init: KeyboardEventInit) => {
        dialog().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        await settle(fixture);
      };

      await fixture.componentInstance.start({
        label: 'page-1',
        bounds: { x: 0, y: 100, width: 800, height: 600 },
        url: 'https://www.hltv.org/',
      });
      await settle(fixture);
      expect(element.querySelector('.screenshot__hint')?.textContent?.trim()).toBe('Виділіть область мишею');
      expect([...element.querySelectorAll('.screenshot__tool .screenshot__key')].map((key) => key.textContent)).toEqual([
        'Enter',
        'Shift+Enter',
      ]);

      await press({ key: 'Enter' });
      expect(element.querySelector('.screenshot__meta')?.textContent?.trim()).toBe('1600 × 1200 пікс.');

      await press({ key: 'с', code: 'KeyC', ctrlKey: true });
      expect(navigator.clipboard.write).toHaveBeenCalledTimes(1);
      expect(element.querySelector('.screenshot__button[title="Копіювати (Ctrl+C)"]')?.textContent).toContain('Скопійовано');

      await press({ key: 'і', code: 'KeyS', ctrlKey: true });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][1]).toMatch(/^Скріншот hltv\.org \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.png$/);
      expect(element.querySelector('.screenshot__saved')?.textContent).toContain('shot.png');
    });

    it('should take the whole page on Shift+Enter', async () => {
      const { fixture, element, pageViews } = await setup();
      const shoot = vi.spyOn(pageViews, 'screenshot').mockResolvedValue(new ArrayBuffer(8));

      await fixture.componentInstance.start({
        label: 'page-1',
        bounds: { x: 0, y: 100, width: 800, height: 600 },
        url: 'https://a.example/',
      });
      await settle(fixture);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      element
        .querySelector('dialog')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await settle(fixture);

      expect(shoot.mock.calls).toEqual([
        ['page-1', false],
        ['page-1', true],
      ]);
      expect(element.querySelector('.screenshot__meta')?.textContent?.trim()).toBe('1600 × 1200 пікс.');
    });
  });
});
