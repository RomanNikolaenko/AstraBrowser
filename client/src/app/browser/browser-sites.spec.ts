import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { Titlebar } from '../shared/titlebar/titlebar';
import { Browser } from './browser';
import { BookmarksStore } from './data/bookmarks';
import { DownloadsStore } from './data/downloads';
import { HistoryStore } from './data/history';
import { AutoplayStore } from './data/autoplay';
import { AutoplayPermission, PageOpenOptions, PageViews } from './page-views/page-views';

@Component({
  imports: [Browser, Titlebar],
  template: '<app-titlebar /><app-browser />',
})
class Host {}

/** Замість нативних webview: записує виклики й дозволяє надіслати події, як це робить server/src/pages.rs. */
class FakePageViews {
  readonly available = true;
  readonly calls: [string, ...unknown[]][] = [];
  findResult = true;
  autoplayPermission: AutoplayPermission = 'default';
  private readonly handlers = new Map<string, (payload: never) => void>();

  open(label: string, url: string, _bounds: unknown, options: PageOpenOptions = {}) {
    if (options.background) {
      this.calls.push(['background', label]);
    }
    this.calls.push(['block-audio', label, options.blockAudio ?? []]);
    return this.record('open', label, url);
  }
  capture() {
    return Promise.resolve(new ArrayBuffer(8));
  }
  setAudioRules(origins: readonly string[]) {
    return this.record('audio-rules', [...origins]);
  }
  navigate(label: string, url: string) {
    return this.record('navigate', label, url);
  }
  go(label: string, step: number) {
    return this.record('go', label, step);
  }
  reload(label: string) {
    return this.record('reload', label);
  }
  pictureInPicture(label: string) {
    this.calls.push(['pip', label]);
    return Promise.resolve('opened' as const);
  }
  reloadWith(label: string, mode: string) {
    return this.record('reload-with', label, mode);
  }
  setBounds(label: string, bounds: unknown) {
    return this.record('bounds', label, bounds);
  }
  setVisible(label: string, visible: boolean) {
    return this.record('visible', label, visible);
  }
  setZoom(label: string, scale: number) {
    return this.record('zoom', label, scale);
  }
  focus() {
    return Promise.resolve();
  }
  print(label: string) {
    return this.record('print', label);
  }
  close(label: string) {
    return this.record('close', label);
  }
  find(label: string, query: string, backwards: boolean) {
    this.calls.push(['find', label, query, backwards]);
    return Promise.resolve(this.findResult);
  }
  setMuted(label: string, muted: boolean) {
    return this.record('muted', label, muted);
  }
  autoplay() {
    return Promise.resolve(this.autoplayPermission);
  }
  setAutoplay(label: string, autoplay: AutoplayPermission) {
    return this.record('set-autoplay', label, autoplay);
  }
  on(event: string, handler: (payload: never) => void) {
    this.handlers.set(event, handler);
    return Promise.resolve(() => undefined);
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload as never);
  }

  called(name: string): unknown[][] {
    return this.calls.filter(([call]) => call === name).map(([, ...args]) => args);
  }

  private record(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push([name, ...args]);
    return Promise.resolve();
  }
}

/** Повноекранність вікна без Tauri. */
class FakeWindows {
  readonly isPrivate = false;
  fullscreen = false;
  readonly fullscreenCalls: boolean[] = [];

  open(): void {}

  isFullscreen(): Promise<boolean> {
    return Promise.resolve(this.fullscreen);
  }

  setFullscreen(fullscreen: boolean): Promise<void> {
    this.fullscreenCalls.push(fullscreen);
    this.fullscreen = fullscreen;
    return Promise.resolve();
  }
}

describe('Browser with sites', () => {
  let fixture: ComponentFixture<Host>;
  let element: HTMLElement;
  let pages: FakePageViews;
  let windows: FakeWindows;

  const label = (id: number) => `page-web-${id}`;
  const titles = () => [...element.querySelectorAll('.tab__title')].map((title) => title.textContent?.trim());
  const omnibox = () => element.querySelector<HTMLInputElement>('#omnibox') as HTMLInputElement;
  const button = (name: string) => element.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`) as HTMLButtonElement;
  const stable = () => fixture.whenStable();

  const typeInOmnibox = async (text: string) => {
    omnibox().value = text;
    omnibox().dispatchEvent(new Event('input'));
    omnibox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await stable();
  };
  const load = async (id: number, url: string) => {
    pages.emit('page://load', { label: label(id), url, loading: true });
    pages.emit('page://load', { label: label(id), url, loading: false });
    await stable();
  };

  beforeEach(async () => {
    localStorage.clear();
    // jsdom не має ResizeObserver, а з webview сайтів браузер стежить за розміром області вмісту.
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PageViews, useClass: FakePageViews },
        { provide: BrowserWindows, useClass: FakeWindows },
      ],
    })
      .compileComponents();

    pages = TestBed.inject(PageViews) as unknown as FakePageViews;
    windows = TestBed.inject(BrowserWindows) as unknown as FakeWindows;
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await stable();
  });

  it('should open an address typed in the omnibox in the current tab', async () => {
    await typeInOmnibox('angular.dev');

    expect(pages.called('open')).toEqual([[label(1), 'https://angular.dev/']]);
    expect(titles()).toEqual(['angular.dev']);
    expect(element.querySelector('.tab__spinner')).toBeTruthy();
    expect(element.querySelector('app-new-tab')).toBeNull();
    expect(omnibox().value).toBe('https://angular.dev/');
  });

  it('should search anything that is not an address', async () => {
    await typeInOmnibox('як працює браузер');

    expect(pages.called('open')).toEqual([[label(1), 'https://www.google.com/search?q=%D1%8F%D0%BA%20%D0%BF%D1%80%D0%B0%D1%86%D1%8E%D1%94%20%D0%B1%D1%80%D0%B0%D1%83%D0%B7%D0%B5%D1%80']]);
  });

  it('should open internal pages typed as astra:// addresses', async () => {
    await typeInOmnibox('astra://settings');

    expect(element.querySelector('app-settings-page')).toBeTruthy();
    expect(pages.called('open')).toEqual([]);
  });

  it('should search from the new tab page', async () => {
    const search = element.querySelector<HTMLInputElement>('#new-tab-search') as HTMLInputElement;
    search.value = 'github.com';
    search.dispatchEvent(new Event('input'));
    search.form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await stable();

    expect(pages.called('open')).toEqual([[label(1), 'https://github.com/']]);
  });

  it('should navigate the same webview once the tab shows a site', async () => {
    await typeInOmnibox('angular.dev');
    await typeInOmnibox('github.com');

    expect(pages.called('open').length).toBe(1);
    expect(pages.called('navigate')).toEqual([[label(1), 'https://github.com/']]);
  });

  it('should follow the page: title, history and back/forward from WebView2', async () => {
    const history = () => TestBed.inject(HistoryStore).entries().map((entry) => [entry.title, entry.url]);
    const navigation = async (url: string, canGoBack: boolean, canGoForward: boolean) => {
      pages.emit('page://navigation', { label: label(1), url, canGoBack, canGoForward });
      await stable();
    };
    await typeInOmnibox('angular.dev');
    // Новий webview спершу повідомляє про порожню about:blank — це не перехід.
    await navigation('about:blank', false, false);
    expect(history()).toEqual([]);
    expect(omnibox().value).toBe('https://angular.dev/');
    await navigation('https://angular.dev/', false, false);
    await load(1, 'https://angular.dev/');
    pages.emit('page://title', { label: label(1), title: 'Angular' });
    await stable();

    expect(titles()).toEqual(['Angular']);
    expect(element.querySelector('.tab__spinner')).toBeNull();
    expect(history()).toEqual([['Angular', 'https://angular.dev/']]);

    // Сайт змінив адресу без перезавантаження (history.pushState) — і адресний рядок, і історія це бачать.
    await navigation('https://angular.dev/overview', true, false);
    expect(omnibox().value).toBe('https://angular.dev/overview');
    expect(history()[0][1]).toBe('https://angular.dev/overview');
    expect(button('Назад').disabled).toBe(false);
    expect(button('Вперед').disabled).toBe(true);

    button('Назад').click();
    await stable();
    expect(pages.called('go')).toEqual([[label(1), -1]]);

    await navigation('https://angular.dev/', false, true);
    expect(button('Вперед').disabled).toBe(false);
    expect(omnibox().value).toBe('https://angular.dev/');
    button('Вперед').click();
    await stable();
    expect(pages.called('go')).toEqual([[label(1), -1], [label(1), 1]]);
  });

  it('should go back from the first page of a site to the new tab page and forward again', async () => {
    await typeInOmnibox('angular.dev');
    pages.emit('page://navigation', { label: label(1), url: 'https://angular.dev/', canGoBack: false, canGoForward: false });
    await stable();
    expect(button('Назад').disabled).toBe(false);

    button('Назад').click();
    await stable();
    expect(pages.called('close')).toEqual([[label(1)]]);
    expect(element.querySelector('app-new-tab')).toBeTruthy();
    expect(titles()).toEqual(['Нова вкладка']);
    expect(button('Назад').disabled).toBe(true);
    expect(button('Вперед').disabled).toBe(false);

    // Новий webview — з новою міткою: старий ще може закриватися.
    button('Вперед').click();
    await stable();
    expect(pages.called('open').at(-1)).toEqual([`${label(1)}-2`, 'https://angular.dev/']);
    expect(element.querySelector('app-new-tab')).toBeNull();
    expect(button('Назад').disabled).toBe(false);
  });

  it('should not offer to go back from a site opened in a new tab by a link', async () => {
    await typeInOmnibox('angular.dev');
    pages.emit('page://new-tab', { label: label(1), url: 'https://github.com/angular' });
    pages.emit('page://navigation', { label: label(2), url: 'https://github.com/angular', canGoBack: false, canGoForward: false });
    await stable();

    expect(titles()).toEqual(['angular.dev', 'github.com']);
    expect(button('Назад').disabled).toBe(true);
  });

  describe('reload menu', () => {
    const reloadButton = () => button('Оновити');
    const menuOpen = () => !!element.querySelector('app-reload-menu .is-open');
    const item = (text: string) => [...element.querySelectorAll<HTMLButtonElement>('.reload-menu__item')].find((node) => node.textContent?.includes(text));

    it('should reload on a click and keep the menu closed', async () => {
      await typeInOmnibox('angular.dev');

      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      reloadButton().dispatchEvent(click);
      await stable();

      expect(click.defaultPrevented).toBe(true);
      expect(pages.called('reload')).toEqual([[label(1)]]);
      expect(menuOpen()).toBe(false);
    });

    it('should open the menu by holding the button and not reload on release', async () => {
      await typeInOmnibox('angular.dev');

      reloadButton().dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      reloadButton().dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
      reloadButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await stable();

      expect(menuOpen()).toBe(true);
      expect(pages.called('reload')).toEqual([]);
    });

    it('should not open the menu for a short press', async () => {
      await typeInOmnibox('angular.dev');

      reloadButton().dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      reloadButton().dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      await stable();

      expect(menuOpen()).toBe(false);
    });

    it('should not open the menu without a site in the tab', async () => {
      // Кнопка на новій вкладці неактивна, але Chromium усе одно шле їй події вказівника.
      reloadButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      reloadButton().dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      await stable();

      expect(menuOpen()).toBe(false);
    });

    it('should close the menu when another tab is shown', async () => {
      await typeInOmnibox('angular.dev');
      reloadButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await stable();
      expect(menuOpen()).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyT', key: 'е', cancelable: true }));
      await stable();

      expect(menuOpen()).toBe(false);
      expect(button('Оновити').disabled).toBe(true);
    });

    it('should open the menu from the context menu and run the chosen reload', async () => {
      await typeInOmnibox('angular.dev');

      const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      reloadButton().dispatchEvent(contextMenu);
      await stable();
      expect(contextMenu.defaultPrevented).toBe(true);
      expect(menuOpen()).toBe(true);
      expect([...element.querySelectorAll('.reload-menu__label')].map((node) => node.textContent?.trim())).toEqual([
        'Жорстке оновлення',
        'Очистити кеш і оновити',
        'Очистити дані сайту й оновити',
        'Очистити cookies і оновити',
      ]);

      item('Очистити cookies')?.click();
      item('Жорстке оновлення')?.click();
      await stable();
      expect(pages.called('reload-with')).toEqual([[label(1), 'cookies'], [label(1), 'hard']]);
      expect(element.querySelector('.tab__spinner')).toBeTruthy();
    });
  });

  it('should reload, print and find on the site', async () => {
    await typeInOmnibox('angular.dev');

    button('Оновити').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyP', key: 'з', cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyF', key: 'а', cancelable: true }));
    await stable();

    expect(pages.called('reload')).toEqual([[label(1)]]);
    expect(pages.called('print')).toEqual([[label(1)]]);
    expect(element.querySelector('.viewport')?.classList).toContain('viewport--docked');

    const find = element.querySelector<HTMLInputElement>('#find-on-page') as HTMLInputElement;
    find.value = 'signals';
    find.dispatchEvent(new Event('input'));
    await stable();
    expect(pages.called('find')).toEqual([[label(1), 'signals', false]]);
    expect(element.querySelector('.find-bar__status')?.textContent?.trim()).toBe('Знайдено');
  });

  it('should open links for a new window in a new tab', async () => {
    await typeInOmnibox('angular.dev');
    pages.emit('page://new-tab', { label: label(1), url: 'https://github.com/angular' });
    await stable();

    expect(titles()).toEqual(['angular.dev', 'github.com']);
    expect(pages.called('open').at(-1)).toEqual([label(2), 'https://github.com/angular']);
  });

  it('should show the icon a site reported in its tab and bookmark', async () => {
    TestBed.inject(BookmarksStore).add('YouTube', 'https://www.youtube.com/');
    const tabIcon = () => element.querySelector<HTMLImageElement>('.tab__favicon img');
    const bookmarkIcon = () => element.querySelector<HTMLImageElement>('.bookmark__favicon img');
    await stable();
    expect(bookmarkIcon()?.getAttribute('src')).toBe('https://www.youtube.com/favicon.ico');

    await typeInOmnibox('youtube.com');
    expect(tabIcon()).toBeNull();
    await load(1, 'https://www.youtube.com/');
    expect(tabIcon()?.getAttribute('src')).toBe('https://www.youtube.com/favicon.ico');

    pages.emit('page://favicon', { label: label(1), url: 'https://www.youtube.com/', icon: 'https://www.youtube.com/s/desktop/favicon_32x32.png' });
    await stable();

    expect(tabIcon()?.getAttribute('src')).toBe('https://www.youtube.com/s/desktop/favicon_32x32.png');
    expect(bookmarkIcon()?.getAttribute('src')).toBe('https://www.youtube.com/s/desktop/favicon_32x32.png');
    expect([bookmarkIcon()?.width, bookmarkIcon()?.height]).toEqual([16, 16]);

    // Іконки, що не вантажаться, замінює наступний варіант, а врешті — глобус.
    bookmarkIcon()?.dispatchEvent(new Event('error'));
    await stable();
    expect(bookmarkIcon()?.getAttribute('src')).toBe('https://www.youtube.com/favicon.ico');
    bookmarkIcon()?.dispatchEvent(new Event('error'));
    await stable();
    expect(bookmarkIcon()).toBeNull();
    expect(element.querySelector('.bookmark__favicon app-icon')).toBeTruthy();
  });

  it('should show that a site plays sound in its tab and mute it', async () => {
    const audio = () => element.querySelector<HTMLButtonElement>('.tab__audio');
    await typeInOmnibox('youtube.com');
    expect(audio()).toBeNull();

    pages.emit('page://audio', { label: label(1), playing: true, muted: false });
    await stable();
    expect(audio()?.getAttribute('aria-label')).toBe('Вимкнути звук вкладки «youtube.com»');
    expect(element.querySelector('.tab')?.classList).toContain('tab--audio');

    audio()?.click();
    await stable();
    expect(pages.called('muted')).toEqual([[label(1), true]]);

    pages.emit('page://audio', { label: label(1), playing: true, muted: true });
    await stable();
    expect(audio()?.classList).toContain('tab__audio--muted');
    expect(audio()?.getAttribute('aria-label')).toBe('Увімкнути звук вкладки «youtube.com»');

    // Вимкнений звук видно й тоді, коли сторінка замовкла, — інакше його не ввімкнути назад.
    pages.emit('page://audio', { label: label(1), playing: false, muted: true });
    await stable();
    expect(audio()).toBeTruthy();

    pages.emit('page://audio', { label: label(1), playing: false, muted: false });
    await stable();
    expect(audio()).toBeNull();
  });

  describe('site permissions', () => {
    const panel = () => element.querySelector('.site-permissions .popover') as HTMLElement;
    const autoplay = () => panel().querySelector('[role="combobox"]') as HTMLButtonElement;
    // jsdom не має Popover API: відкриття — це подія toggle з newState, як її шле браузер.
    const open = async (popover: Element | null) => {
      popover?.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await stable();
      await stable();
    };
    const openPanel = () => open(panel());
    const choose = async (label: string) => {
      await open(panel().querySelector('[role="listbox"]'));
      [...panel().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === label)?.click();
      await stable();
      await stable();
    };

    it('should hide a panel opening over a site at once, before its first frame', async () => {
      const beforeToggle = (newState: string) => panel()?.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState }));
      const covering = () => document.documentElement.classList.contains('page-covering');

      // Без сайту знімати нічого — панель з'являється одразу.
      element.querySelector('app-bookmark-editor div')?.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }));
      expect(covering()).toBe(false);

      await typeInOmnibox('www.twitch.tv');
      beforeToggle('open');
      // Без жодного очікування: клас має стояти раніше, ніж браузер намалює панель.
      expect(covering()).toBe(true);

      panel().dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
      expect(covering()).toBe(false);
    });

    it('should replace the logo with the permissions button on sites only', async () => {
      expect(element.querySelector('.omnibox__site')).toBeNull();
      expect(element.querySelector('.omnibox__logo')).toBeTruthy();

      await typeInOmnibox('www.twitch.tv/missmartik');

      expect(element.querySelector('.omnibox__site')?.getAttribute('popovertarget')).toBe('site-permissions');
      expect(element.querySelector('.omnibox__logo')).toBeNull();
    });

    it('should block autoplay for the site and offer to reload the page', async () => {
      await typeInOmnibox('www.twitch.tv/missmartik');
      await openPanel();

      expect(panel().querySelector('.site-permissions__title')?.textContent?.trim()).toBe('Дозволи для www.twitch.tv');
      expect(autoplay().textContent?.trim()).toBe('Дозволити аудіо та відео');
      expect(autoplay().labels?.[0]?.textContent?.trim()).toBe('Автовідтворення');
      expect(panel().querySelector('.site-permissions__notice')).toBeNull();

      await choose('Блокувати аудіо та відео');
      expect(pages.called('set-autoplay')).toEqual([[label(1), 'block']]);
      expect(panel().querySelector('.site-permissions__notice')?.textContent).toContain('після перезавантаження');

      panel().querySelector<HTMLButtonElement>('.site-permissions__reload')?.click();
      await stable();
      expect(pages.called('reload')).toEqual([[label(1)]]);
    });

    it('should allow autoplay again by dropping the exception', async () => {
      pages.autoplayPermission = 'block';
      await typeInOmnibox('www.twitch.tv');
      await openPanel();
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо та відео');

      await choose('Дозволити аудіо та відео');
      expect(pages.called('set-autoplay')).toEqual([[label(1), 'default']]);
    });

    it('should block only the sound of autoplay with a page script', async () => {
      await typeInOmnibox('www.twitch.tv/missmartik');
      await openPanel();

      await choose('Блокувати аудіо');

      expect(pages.called('set-autoplay')).toEqual([[label(1), 'default']]);
      expect(TestBed.inject(AutoplayStore).blockAudio()).toEqual(['https://www.twitch.tv']);
      expect(pages.called('audio-rules').at(-1)).toEqual([['https://www.twitch.tv']]);
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо');

      // Нові вкладки отримують список одразу, разом зі скриптом.
      element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
      await stable();
      await typeInOmnibox('twitch.tv');
      expect(pages.called('block-audio').at(-1)).toEqual([label(2), ['https://www.twitch.tv']]);

      // І панель це пам'ятає.
      await typeInOmnibox('www.twitch.tv/other');
      await openPanel();
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо');
    });
  });

  it('should leave Enter on the buttons inside the address bar to them', async () => {
    omnibox().value = 'angular.dev';
    omnibox().dispatchEvent(new Event('input'));
    const star = element.querySelector('.omnibox__action') as HTMLButtonElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    star.dispatchEvent(enter);
    await stable();

    expect(enter.defaultPrevented).toBe(false);
    expect(pages.called('open')).toEqual([]);
  });

  it('should open a bookmark in a background tab with the middle mouse button', async () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    bookmarks.add('YouTube', 'https://www.youtube.com/');
    bookmarks.add('Історія', 'astra://history');
    await stable();
    const bookmark = (title: string) => [...element.querySelectorAll('.bookmark')].find((item) => item.textContent?.includes(title));
    const middleClick = async (target: Element | undefined) => {
      target?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
      await stable();
    };

    await middleClick(bookmark('YouTube'));
    expect(titles()).toEqual(['Нова вкладка', 'youtube.com']);
    expect(element.querySelectorAll('.tab')[0].classList).toContain('tab--active');
    expect(pages.called('open')).toEqual([[label(2), 'https://www.youtube.com/']]);
    expect(pages.called('background')).toEqual([[label(2)]]);

    await middleClick(bookmark('Історія'));
    await middleClick(bookmark('Історія'));
    expect(titles()).toEqual(['Нова вкладка', 'youtube.com', 'Історія']);
    expect(element.querySelectorAll('.tab')[0].classList).toContain('tab--active');
  });

  describe('fullscreen video', () => {
    // Переходи йдуть чергою промісів — даємо їй відпрацювати.
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await stable();
    };
    const fullscreen = async (value: boolean, id = 1) => {
      pages.emit('page://fullscreen', { label: label(id), fullscreen: value });
      await settle();
    };

    it('should stretch the site over the whole window and restore it afterwards', async () => {
      await typeInOmnibox('youtube.com');

      await fullscreen(true);
      expect(windows.fullscreenCalls).toEqual([true]);
      expect(pages.called('bounds').at(-1)).toEqual([label(1), { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]);

      await fullscreen(false);
      expect(windows.fullscreenCalls).toEqual([true, false]);
      expect(pages.called('bounds').at(-1)?.[1]).not.toEqual({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    });

    it('should keep the window fullscreen if it already was', async () => {
      windows.fullscreen = true;
      await typeInOmnibox('youtube.com');

      await fullscreen(true);
      await fullscreen(false);

      expect(windows.fullscreenCalls).toEqual([true]);
      expect(windows.fullscreen).toBe(true);
    });

    it('should leave fullscreen when another tab is shown', async () => {
      await typeInOmnibox('youtube.com');
      await fullscreen(true);

      element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
      await settle();

      expect(windows.fullscreenCalls).toEqual([true, false]);
    });

    it('should follow the site when it enters and leaves fullscreen at once', async () => {
      await typeInOmnibox('youtube.com');

      pages.emit('page://fullscreen', { label: label(1), fullscreen: true });
      pages.emit('page://fullscreen', { label: label(1), fullscreen: false });
      await settle();

      expect(windows.fullscreenCalls).toEqual([true, false]);
      expect(windows.fullscreen).toBe(false);
    });
  });

  it('should offer picture-in-picture on YouTube videos only', async () => {
    const pip = () => element.querySelector<HTMLButtonElement>('.omnibox__pip');
    await typeInOmnibox('youtube.com');
    expect(pip()).toBeNull();

    pages.emit('page://navigation', { label: label(1), url: 'https://www.youtube.com/watch?v=abc', canGoBack: true, canGoForward: false });
    await stable();
    expect(pip()?.getAttribute('aria-label')).toBe('Картинка в картинці');

    pip()?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'BracketRight', key: 'Ї', cancelable: true }));
    await stable();
    expect(pages.called('pip')).toEqual([[label(1)], [label(1)]]);

    await typeInOmnibox('example.com');
    pages.emit('page://navigation', { label: label(1), url: 'https://example.com/watch', canGoBack: true, canGoForward: false });
    await stable();
    expect(pip()).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'BracketRight', key: '}', cancelable: true }));
    expect(pages.called('pip').length).toBe(2);
  });

  it('should record finished downloads', async () => {
    await typeInOmnibox('angular.dev');
    pages.emit('page://download', { label: label(1), url: 'https://x.example/a.zip', fileName: 'a.zip', size: 2048, success: true });
    await stable();

    expect(TestBed.inject(DownloadsStore).entries().map((entry) => [entry.fileName, entry.size, entry.status])).toEqual([['a.zip', 2048, 'completed']]);
  });

  it('should hide the site behind other tabs and close its webview with the tab', async () => {
    await typeInOmnibox('angular.dev');
    element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
    await stable();
    expect(pages.called('visible').at(-1)).toEqual([label(1), false]);

    element.querySelectorAll<HTMLButtonElement>('.tab__close')[0].click();
    await stable();
    expect(pages.called('close')).toEqual([[label(1)]]);
  });
});
