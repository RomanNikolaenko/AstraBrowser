import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { Titlebar } from '../shared/titlebar/titlebar';
import { Browser } from './browser';
import { BookmarksStore } from './data/bookmarks';
import { DownloadSettingsStore } from './data/download-settings';
import { DownloadsStore } from './data/downloads';
import { HistoryStore } from './data/history';
import { SettingsStore } from '../shared/settings/settings';
import { AdBlockStatus, AdBlockStore, adBlockSite } from './data/adblock';
import { AutoplayStore } from './data/autoplay';
import { AutoplayPermission, AutoplayRules, PageOpenOptions, PageViews } from './page-views/page-views';

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
    this.calls.push(['autoplay', label, options.autoplay ?? { allow: [], blockAudio: [] }]);
    return this.record('open', label, url);
  }
  capture() {
    return Promise.resolve(new ArrayBuffer(8));
  }
  setAudioRules(rules: AutoplayRules) {
    return this.record('audio-rules', rules);
  }
  suggestions: string[] = [];
  searchSuggestions(engine: string, query: string) {
    this.calls.push(['suggest', engine, query]);
    return Promise.resolve(this.suggestions);
  }
  openExternal(url: string) {
    return this.record('external', url);
  }
  setBackground(label: string, background: boolean) {
    return this.record('set-background', label, background);
  }
  asleep = true;
  suspend(label: string) {
    this.calls.push(['suspend', label]);
    return Promise.resolve(this.asleep);
  }
  answerPermission(id: number, state: string, remember: boolean) {
    return this.record('permission-answer', id, state, remember);
  }
  savedPermissions: Record<string, string> = {};
  permissions() {
    return Promise.resolve(this.savedPermissions);
  }
  setPermission(label: string, kind: string, state: string) {
    return this.record('set-permission', label, kind, state);
  }
  apps: Record<string, string> = { mailto: 'Вибрати програми', tel: 'Вибрати програми', tg: 'Telegram Desktop' };
  externalApp(url: string) {
    return Promise.resolve(this.apps[url.split(':')[0]] ?? null);
  }
  setTrackingRules(rules: unknown) {
    return this.record('tracking-rules', rules);
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
  setClip(label: string, holes: unknown) {
    return this.record('clip', label, holes);
  }
  screenshot(label: string, full: boolean) {
    this.calls.push(['screenshot', label, full]);
    return Promise.reject(new Error('jsdom не знімає сторінок'));
  }
  setZoom(label: string, scale: number) {
    return this.record('zoom', label, scale);
  }
  focus(label: string) {
    return this.record('focus', label);
  }
  focusInterface() {
    return this.record('focus-interface');
  }
  cancelDownload(id: number) {
    return this.record('cancel-download', id);
  }
  openDownload(path: string) {
    return this.record('open-download', path);
  }
  showDownload(path: string) {
    return this.record('show-download', path);
  }
  resolveDownload(id: number, folder: string | null) {
    return this.record('resolve-download', id, folder);
  }
  pickedFolder: string | null = 'D:\\Файли';
  pickDownloadFolder(current: string) {
    this.calls.push(['pick-folder', current]);
    return Promise.resolve(this.pickedFolder);
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
    this.autoplayPermission = autoplay;
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

/** Блокувальник без Rust: зміни записуються й одразу відбиваються в стані, як після події adblock://status. */
class FakeAdBlock extends AdBlockStore {
  readonly calls: unknown[][] = [];

  constructor() {
    super();
    this.state.set({
      enabled: true,
      disabledSites: [],
      ready: true,
      updating: false,
      updatedAt: null,
      error: null,
      lists: ['EasyList'],
    });
  }

  patch(changes: Partial<AdBlockStatus>): void {
    this.state.update((status) => status && { ...status, ...changes });
  }

  override setEnabled(enabled: boolean): Promise<void> {
    this.calls.push(['enabled', enabled]);
    this.patch({ enabled });
    return Promise.resolve();
  }

  override setSiteEnabled(host: string, enabled: boolean): Promise<void> {
    const site = adBlockSite(host);
    this.calls.push(['site', site, enabled]);
    const others = (this.status()?.disabledSites ?? []).filter((disabled) => disabled !== site);
    this.patch({ disabledSites: enabled ? others : [...others, site] });
    return Promise.resolve();
  }
}

/** Повноекранність вікна без Tauri. */
class FakeWindows {
  readonly isPrivate = false;
  fullscreen = false;
  readonly fullscreenCalls: boolean[] = [];

  readonly opened: unknown[] = [];
  open(options: unknown = {}): void {
    this.opened.push(options);
  }

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
        { provide: AdBlockStore, useClass: FakeAdBlock },
      ],
    }).compileComponents();

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

  it('should show what the tracking protection blocked on the site and send it the rules of the window', async () => {
    expect(pages.called('tracking-rules')).toEqual([[{ level: 'standard', gpc: true, exceptions: [], smartScreen: true }]]);
    await typeInOmnibox('twitch.tv');
    const shield = () => button('Захист від стеження');
    expect(shield().classList).not.toContain('omnibox__shield--active');

    pages.emit('page://trackers', { label: label(1), trackers: [{ category: 'tracking', host: 'www.google-analytics.com' }] });
    await stable();
    expect(shield().classList).toContain('omnibox__shield--active');
    expect(element.querySelector('.tracking-panel__count')?.textContent?.trim()).toBe(
      '1 елемент стеження заблоковано на цьому сайті'
    );

    // Захист для сайту вимкнули — правила вікна з винятком, щит перекреслений.
    element.querySelector<HTMLInputElement>('#tracking-panel-site')?.click();
    await stable();
    expect(pages.called('tracking-rules').at(-1)).toEqual([
      { level: 'standard', gpc: true, exceptions: ['twitch.tv'], smartScreen: true },
    ]);
    expect(pages.called('reload')).toEqual([[label(1)]]);
    expect(shield().classList).toContain('omnibox__shield--off');

    // Нова сторінка — лічильник з нуля.
    pages.emit('page://trackers', { label: label(1), trackers: [] });
    await stable();
    expect(element.querySelector('.tracking-panel__count')).toBeNull();
  });

  describe('omnibox suggestions', () => {
    const typeOnly = async (text: string, inputType = 'insertText') => {
      omnibox().focus();
      omnibox().value = text;
      omnibox().dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
      await stable();
    };
    const key = async (name: string) => {
      omnibox().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      await stable();
    };
    const items = () =>
      [...element.querySelectorAll('.omnibox-suggestions__item')].map((item) =>
        item.querySelector('.omnibox-suggestions__title')?.textContent?.trim()
      );

    beforeEach(() => {
      const history = TestBed.inject(HistoryStore);
      history.record('https://github.com/angular/angular', 'Angular на GitHub');
      history.record('https://github.com/', 'GitHub');
    });

    it('should complete a known site inline and open it with Enter', async () => {
      await typeOnly('git');
      expect(items()).toEqual(['git', 'GitHub', 'Angular на GitHub']);
      expect(omnibox().value).toBe('github.com');
      expect(omnibox().getAttribute('aria-expanded')).toBe('true');

      await key('Enter');
      expect(pages.called('open')).toEqual([[label(1), 'https://github.com/']]);
      expect(items()).toEqual([]);
    });

    it('should not complete while deleting and search what was typed', async () => {
      await typeOnly('git', 'deleteContentBackward');
      expect(omnibox().value).toBe('git');
      await key('Enter');
      expect(pages.called('open')).toEqual([[label(1), 'https://www.google.com/search?q=git']]);
    });

    it('should walk the suggestions with the arrows and add the search engine ones', async () => {
      pages.suggestions = ['angular signals', 'angular'];
      await typeOnly('angular');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await stable();
      expect(pages.called('suggest')).toEqual([['google', 'angular']]);
      expect(items()).toEqual(['angular', 'Angular на GitHub', 'angular signals']);

      await key('ArrowDown');
      expect(omnibox().value).toBe('angular');
      await key('ArrowDown');
      expect(omnibox().value).toBe('github.com/angular/angular');
      expect(omnibox().getAttribute('aria-activedescendant')).toBe('omnibox-suggestions-1');
      await key('ArrowUp');
      await key('ArrowUp');
      expect(omnibox().value).toBe('angular');

      // Перший Esc закриває підказки, другий повертає адресу вкладки.
      await key('Escape');
      expect(items()).toEqual([]);
      expect(omnibox().value).toBe('angular');
      await key('Escape');
      expect(omnibox().value).toBe('');

      await typeOnly('angular');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await stable();
      [...element.querySelectorAll<HTMLElement>('.omnibox-suggestions__item')].at(-1)?.click();
      await stable();
      expect(pages.called('open')).toEqual([[label(1), 'https://www.google.com/search?q=angular%20signals']]);
    });

    it('should switch to an open tab instead of opening the site again', async () => {
      await typeInOmnibox('github.com');
      await load(1, 'https://github.com/');
      button('Нова вкладка').click();
      await stable();

      await typeOnly('github', 'insertFromPaste');
      const tab = [...element.querySelectorAll<HTMLElement>('.omnibox-suggestions__item')].find((item) =>
        item.textContent?.includes('Перейти на вкладку')
      );
      tab?.click();
      await stable();
      expect(titles()).toEqual(['github.com', 'Нова вкладка']);
      expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('github.com');
      expect(pages.called('open')).toEqual([[label(1), 'https://github.com/']]);
    });
  });

  it('should restore the tabs of the last time and load a site only when its tab is opened', async () => {
    fixture.destroy();
    pages.calls.length = 0;
    localStorage.setItem(
      'astra.session.web',
      JSON.stringify({
        tabs: [
          { page: 'web', url: 'https://angular.dev/', title: 'Angular' },
          { page: 'web', url: 'https://github.com/', title: 'GitHub' },
          { page: 'history' },
          { page: 'web', url: 'file:///C:/secret.txt', title: 'Не сайт' },
        ],
        active: 1,
      })
    );
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await stable();

    expect(titles()).toEqual(['Angular', 'GitHub', 'Історія']);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('GitHub');
    expect(pages.called('open')).toEqual([[label(3), 'https://github.com/']]);

    [...element.querySelectorAll<HTMLElement>('.tab__select')].find((tab) => tab.textContent?.includes('Angular'))?.click();
    await stable();
    expect(pages.called('open')).toEqual([
      [label(3), 'https://github.com/'],
      [label(2), 'https://angular.dev/'],
    ]);

    // Кожна зміна вкладок зберігається для наступного запуску.
    const saved = JSON.parse(localStorage.getItem('astra.session.web') ?? 'null');
    expect(saved).toEqual({
      tabs: [
        { page: 'web', url: 'https://angular.dev/', title: 'Angular' },
        { page: 'web', url: 'https://github.com/', title: 'GitHub' },
        { page: 'history' },
      ],
      active: 0,
    });
  });

  it('should start with a new tab when the settings say so', async () => {
    fixture.destroy();
    localStorage.setItem('astra.settings.startup', JSON.stringify('new-tab'));
    localStorage.setItem('astra.session.web', JSON.stringify({ tabs: [{ page: 'history' }], active: 0 }));
    TestBed.inject(SettingsStore).startup.set('new-tab');
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await stable();

    expect(titles()).toEqual(['Нова вкладка']);
  });

  it('should ask before a site opens an app link and remember the answer for that site', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');
    const prompt = () => element.querySelector('.external-prompt__panel');
    // Спершу Rust каже, чи є програма для посилання, — тоді вже запитання.
    const external = async (url: string) => {
      pages.emit('page://external', { label: label(1), url });
      await new Promise((resolve) => setTimeout(resolve));
      await stable();
    };
    const promptButton = (name: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.external-prompt__button')].find(
        (node) => node.textContent?.trim() === name
      );

    await external('mailto:roman@example.com');
    expect(prompt()?.querySelector('.external-prompt__text')?.textContent).toContain(
      'example.com хоче відкрити посилання в поштовій програмі'
    );
    expect(prompt()?.querySelector('.external-prompt__url')?.textContent?.trim()).toBe('mailto:roman@example.com');
    promptButton('Скасувати')?.click();
    await stable();
    expect(prompt()).toBeNull();
    expect(pages.called('external')).toEqual([]);

    await external('mailto:roman@example.com');
    element.querySelector<HTMLInputElement>('.external-prompt__remember input')?.click();
    promptButton('Відкрити')?.click();
    await stable();
    expect(pages.called('external')).toEqual([['mailto:roman@example.com']]);
    expect(prompt()).toBeNull();

    // Тепер цьому сайту — без запитання, але лише для mailto:.
    await external('mailto:team@example.com');
    expect(prompt()).toBeNull();
    expect(pages.called('external')).toEqual([['mailto:roman@example.com'], ['mailto:team@example.com']]);
    await external('tel:+380441234567');
    expect(prompt()?.querySelector('.external-prompt__text')?.textContent).toContain('програмі для дзвінків');
    promptButton('Скасувати')?.click();
    await stable();

    // Відома програма — на ім’я, а посилання, якого жодна програма не знає, нічого не робить.
    await external('tg://resolve?domain=astra');
    expect(prompt()?.querySelector('.external-prompt__text')?.textContent).toContain('програмі «Telegram Desktop»');
    promptButton('Скасувати')?.click();
    await stable();
    await external('astra-unknown:hello');
    expect(prompt()).toBeNull();
  });

  it('should show a crashed page instead of the site and reload it in a new webview', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');
    const crashButton = (name: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.crash__button')].find((node) => node.textContent?.trim() === name);

    pages.emit('page://crashed', { label: label(1), failure: 'unresponsive' });
    await stable();
    expect(element.querySelector('.crash__title')?.textContent?.trim()).toBe('Сторінка не відповідає');
    expect(pages.called('visible').at(-1)).toEqual([label(1), false]);
    crashButton('Чекати')?.click();
    await stable();
    expect(element.querySelector('.crash')).toBeNull();
    expect(pages.called('visible').at(-1)).toEqual([label(1), true]);

    pages.emit('page://crashed', { label: label(1), failure: 'exited' });
    await stable();
    expect(element.querySelector('.crash__title')?.textContent?.trim()).toBe('Ой! Сторінка аварійно завершила роботу');
    expect(element.querySelector('.tab__select--crashed')).toBeTruthy();
    crashButton('Перезавантажити')?.click();
    await stable();
    expect(pages.called('close')).toContainEqual([label(1)]);
    expect(pages.called('open').at(-1)).toEqual([`${label(1)}-2`, 'https://example.com/']);
    expect(element.querySelector('.crash')).toBeNull();
  });

  it('should ask for a site permission under the address bar and answer it', async () => {
    await typeInOmnibox('meet.example.com');
    const prompt = () => element.querySelector('.permission-prompt');
    const answer = (name: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.permission-prompt__button')]
        .find((node) => node.textContent?.trim() === name)
        ?.click();

    pages.emit('page://permission', {
      label: label(1),
      id: 7,
      kind: 'camera',
      origin: 'https://meet.example.com',
      userInitiated: true,
    });
    pages.emit('page://permission', {
      label: label(1),
      id: 8,
      kind: 'microphone',
      origin: 'https://meet.example.com',
      userInitiated: true,
    });
    await stable();
    expect(prompt()?.querySelector('.permission-prompt__title')?.textContent?.trim()).toBe('meet.example.com хоче:');
    expect(prompt()?.querySelector('.permission-prompt__ask')?.textContent?.trim()).toBe('Використовувати камеру');

    answer('Дозволити цього разу');
    await stable();
    expect(pages.called('permission-answer')).toEqual([[7, 'allow', false]]);
    expect(prompt()?.querySelector('.permission-prompt__ask')?.textContent?.trim()).toBe('Використовувати мікрофон');

    // Вкладку закрили, не відповівши, — сторінка не чекатиме вічно.
    button('Закрити вкладку «meet.example.com»').click();
    await stable();
    expect(pages.called('permission-answer')).toEqual([
      [7, 'allow', false],
      [8, 'deny', false],
    ]);
    expect(prompt()?.querySelector('.permission-prompt__ask')).toBeNull();
  });

  it('should block popups opened without a click, open them on request and allow them for the site', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');

    pages.emit('page://new-tab', { label: label(1), url: 'https://ads.example.net/', userInitiated: false });
    await stable();
    expect(titles()).toEqual(['example.com']);
    expect(button('Спливне вікно заблоковано')).toBeTruthy();
    expect(element.querySelector('.popup-blocked__url')?.textContent?.trim()).toBe('https://ads.example.net/');

    element.querySelector<HTMLButtonElement>('.popup-blocked__item')?.click();
    await stable();
    expect(titles()).toEqual(['example.com', 'ads.example.net']);
    expect(pages.called('open').at(-1)).toEqual([label(2), 'https://ads.example.net/']);

    // З кліком — новою вкладкою одразу; дозволено сайтові — і без кліку.
    pages.emit('page://new-tab', { label: label(1), url: 'https://example.com/help', userInitiated: true });
    await stable();
    expect(titles()).toHaveLength(3);
    [...element.querySelectorAll<HTMLElement>('.tab__select')].find((tab) => tab.textContent?.includes('example.com'))?.click();
    await stable();
    pages.emit('page://new-tab', { label: label(1), url: 'https://ads.example.net/2', userInitiated: false });
    await stable();
    element.querySelector<HTMLInputElement>('.popup-blocked__allow input')?.click();
    await stable();
    pages.emit('page://new-tab', { label: label(1), url: 'https://ads.example.net/3', userInitiated: false });
    await stable();
    expect(titles()).toHaveLength(4);
  });

  it('should run browser actions from the context menu of a site', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');
    const context = async (action: string, extra: object) => {
      pages.emit('page://context', { label: label(1), action, ...extra });
      await stable();
    };

    await context('open-link-tab', { url: 'https://example.com/news' });
    expect(pages.called('background')).toContainEqual([label(2)]);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('example.com');

    await context('search', { text: 'рецепт борщу' });
    expect(pages.called('open').at(-1)).toEqual([
      label(3),
      'https://www.google.com/search?q=%D1%80%D0%B5%D1%86%D0%B5%D0%BF%D1%82%20%D0%B1%D0%BE%D1%80%D1%89%D1%83',
    ]);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('google.com');

    await context('open-link-private', { url: 'https://example.com/secret' });
    expect(windows.opened.at(-1)).toEqual({ url: 'https://example.com/secret', private: true });

    await context('translate-text', { text: 'hello' });
    expect(pages.called('open').at(-1)?.[1]).toBe('https://translate.google.com/?sl=auto&tl=uk&text=hello&op=translate');
  });

  it('should put background tabs to sleep after a while and wake them up when opened', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');
    button('Нова вкладка').click();
    await stable();
    await typeInOmnibox('github.com');
    const browser = fixture.debugElement.query(By.directive(Browser)).componentInstance as unknown as {
      sleepInactiveTabs(now: number): void;
    };
    expect(pages.called('set-background')).toContainEqual([label(1), true]);

    browser.sleepInactiveTabs(Date.now() + 5 * 60_000);
    await stable();
    expect(pages.called('suspend')).toEqual([]);
    browser.sleepInactiveTabs(Date.now() + 31 * 60_000);
    await new Promise((resolve) => setTimeout(resolve));
    await stable();
    expect(pages.called('suspend')).toEqual([[label(1)]]);
    expect(element.querySelector('.tab__select--sleeping')?.textContent?.trim()).toBe('example.com');

    [...element.querySelectorAll<HTMLElement>('.tab__select')].find((tab) => tab.textContent?.includes('example.com'))?.click();
    await stable();
    expect(element.querySelector('.tab__select--sleeping')).toBeNull();
    expect(pages.called('set-background').at(-1)).toEqual([label(1), false]);
  });

  describe('tabs', () => {
    const tabItem = (title: string) =>
      [...element.querySelectorAll<HTMLElement>('.tab')].find(
        (tab) => tab.querySelector('.tab__title')?.textContent?.trim() === title
      ) as HTMLElement;
    const menu = async (title: string, item: string) => {
      tabItem(title).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
      await stable();
      [...element.querySelectorAll<HTMLButtonElement>('.tab-menu__item')]
        .find((node) => node.textContent?.trim().startsWith(item))
        ?.click();
      await stable();
    };
    /** DataTransfer без браузера: лише те, що використовує смуга вкладок. */
    const transfer = (data: Record<string, string> = {}) => {
      const store = { ...data };
      return {
        effectAllowed: 'all',
        dropEffect: 'none',
        get types() {
          return Object.keys(store);
        },
        setData: (type: string, value: string) => (store[type] = value),
        getData: (type: string) => store[type] ?? '',
      };
    };
    const drag = (target: Element, type: string, dataTransfer: object, clientX = 0, init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, ...init });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      target.dispatchEvent(event);
    };
    const openThree = async () => {
      for (const site of ['a.example', 'b.example', 'c.example']) {
        if (site !== 'a.example') {
          button('Нова вкладка').click();
          await stable();
        }
        await typeInOmnibox(site);
      }
    };

    it('should pin a tab to the left without a close button and keep it pinned in the saved session', async () => {
      await openThree();
      await menu('c.example', 'Закріпити');
      expect(titles()).toEqual(['c.example', 'a.example', 'b.example']);
      expect(tabItem('c.example').classList).toContain('tab--pinned');
      expect(tabItem('c.example').querySelector('.tab__close')).toBeNull();
      const saved = JSON.parse(localStorage.getItem('astra.session.web') ?? 'null');
      expect(saved.tabs[0]).toEqual({ page: 'web', url: 'https://c.example/', title: '', pinned: true });

      await menu('c.example', 'Відкріпити');
      expect(titles()).toEqual(['c.example', 'a.example', 'b.example']);
      expect(tabItem('c.example').classList).not.toContain('tab--pinned');
    });

    it('should duplicate a tab and close other tabs or tabs to the right, but not pinned ones', async () => {
      await openThree();
      await menu('a.example', 'Дублювати');
      expect(titles()).toEqual(['a.example', 'a.example', 'b.example', 'c.example']);
      expect(pages.called('open').at(-1)?.[1]).toBe('https://a.example/');

      await menu('b.example', 'Закрити вкладки праворуч');
      expect(titles()).toEqual(['a.example', 'a.example', 'b.example']);

      await menu('b.example', 'Закріпити');
      await menu('b.example', 'Закрити інші вкладки');
      expect(titles()).toEqual(['b.example']);
    });

    it('should move a tab to a new window from its menu', async () => {
      await openThree();
      await menu('b.example', 'Перемістити в нове вікно');
      expect(windows.opened.at(-1)).toEqual({ url: 'https://b.example/', private: false });
      expect(titles()).toEqual(['a.example', 'c.example']);
      // Перенесену вкладку не відновлюють як закриту.
      pages.emit('page://shortcut', { label: label(1), shortcut: 'reopen-tab' });
      await stable();
      expect(titles()).toEqual(['a.example', 'c.example']);
    });

    it('should reorder tabs by dragging them along the tab strip', async () => {
      await openThree();
      const strip = element.querySelector('.tab-list') as HTMLElement;
      const rects = [0, 100, 200].map((left) => ({ left, width: 100, right: left + 100, top: 0, bottom: 44, height: 44 }));
      [...element.querySelectorAll<HTMLElement>('.tab')].forEach((tab, index) => {
        tab.getBoundingClientRect = () => rects[index] as DOMRect;
      });

      const data = transfer();
      drag(tabItem('c.example'), 'dragstart', data);
      drag(strip, 'dragover', data, 40);
      await stable();
      expect(tabItem('a.example').classList).toContain('tab--drop-before');
      drag(strip, 'drop', data, 40);
      drag(tabItem('c.example'), 'dragend', data);
      await stable();
      expect(titles()).toEqual(['c.example', 'a.example', 'b.example']);
      expect(element.querySelector('.tab--drop-before')).toBeNull();
    });

    it('should take a tab dropped from another window and give away one dropped there', async () => {
      await openThree();
      const strip = element.querySelector('.tab-list') as HTMLElement;

      const incoming = transfer({
        'application/x-astra-tab': JSON.stringify({ page: 'web', url: 'https://d.example/', title: 'D' }),
      });
      drag(strip, 'dragover', incoming, 10_000);
      drag(strip, 'drop', incoming, 10_000);
      await stable();
      expect(titles()).toEqual(['a.example', 'b.example', 'c.example', 'D']);
      expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('D');
      expect(pages.called('open').at(-1)?.[1]).toBe('https://d.example/');

      // Інше вікно прийняло вкладку (dropEffect «move») — тут вона закривається.
      const outgoing = transfer();
      drag(tabItem('a.example'), 'dragstart', outgoing);
      outgoing.dropEffect = 'move';
      drag(tabItem('a.example'), 'dragend', outgoing);
      await stable();
      expect(titles()).toEqual(['b.example', 'c.example', 'D']);
    });
  });

  it('should reopen the last closed tab in its place with Ctrl+Shift+T, also from a site', async () => {
    await typeInOmnibox('angular.dev');
    button('Нова вкладка').click();
    await stable();
    await typeInOmnibox('github.com');
    expect(titles()).toEqual(['angular.dev', 'github.com']);

    button('Закрити вкладку «angular.dev»').click();
    await stable();
    expect(titles()).toEqual(['github.com']);

    // Фокус у сайті: клавіші ловить його webview і передає як гарячу клавішу.
    pages.emit('page://shortcut', { label: label(2), shortcut: 'reopen-tab' });
    await stable();
    expect(titles()).toEqual(['angular.dev', 'github.com']);
    expect(pages.called('open').at(-1)?.[1]).toBe('https://angular.dev/');

    // Порожня нова вкладка не запам'ятовується, і відновлювати більше нічого.
    button('Нова вкладка').click();
    await stable();
    button('Закрити вкладку «Нова вкладка»').click();
    await stable();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyT', key: 'T', cancelable: true })
    );
    await stable();
    expect(titles()).toEqual(['angular.dev', 'github.com']);
  });

  it('should search anything that is not an address', async () => {
    await typeInOmnibox('як працює браузер');

    expect(pages.called('open')).toEqual([
      [
        label(1),
        'https://www.google.com/search?q=%D1%8F%D0%BA%20%D0%BF%D1%80%D0%B0%D1%86%D1%8E%D1%94%20%D0%B1%D1%80%D0%B0%D1%83%D0%B7%D0%B5%D1%80',
      ],
    ]);
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
    const history = () =>
      TestBed.inject(HistoryStore)
        .entries()
        .map((entry) => [entry.title, entry.url]);
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
    expect(pages.called('go')).toEqual([
      [label(1), -1],
      [label(1), 1],
    ]);
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
    pages.emit('page://navigation', {
      label: label(2),
      url: 'https://github.com/angular',
      canGoBack: false,
      canGoForward: false,
    });
    await stable();

    expect(titles()).toEqual(['angular.dev', 'github.com']);
    expect(button('Назад').disabled).toBe(true);
  });

  describe('reload menu', () => {
    const reloadButton = () => button('Оновити');
    const menuOpen = () => !!element.querySelector('app-reload-menu .is-open');
    const item = (text: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.reload-menu__item')].find((node) => node.textContent?.includes(text));

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
      expect(pages.called('reload-with')).toEqual([
        [label(1), 'cookies'],
        [label(1), 'hard'],
      ]);
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

    pages.emit('page://favicon', {
      label: label(1),
      url: 'https://www.youtube.com/',
      icon: 'https://www.youtube.com/s/desktop/favicon_32x32.png',
    });
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

  it('should zoom with Ctrl and the wheel or the keys, also while the site has focus', async () => {
    const badge = () => element.querySelector('.zoom-badge')?.textContent?.trim();
    await typeInOmnibox('www.hltv.org');
    expect(badge()).toBeUndefined();

    // Сайт (скрипт zoom-page.js чи гаряча клавіша у webview) повідомляє про крок.
    pages.emit('page://shortcut', { label: label(1), shortcut: 'zoom-in' });
    await stable();
    expect(badge()).toBe('110%');
    expect(pages.called('zoom').at(-1)).toEqual([label(1), 1.1]);

    pages.emit('page://shortcut', { label: label(1), shortcut: 'zoom-reset' });
    await stable();
    expect(badge()).toBeUndefined();

    const press = async (code: string, key: string) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code, key, cancelable: true }));
      await stable();
    };
    await press('Minus', '-');
    expect(badge()).toBe('90%');
    await press('Equal', '=');
    expect(badge()).toBeUndefined();
    await press('NumpadAdd', '+');
    expect(badge()).toBe('110%');
    await press('Digit0', '0');
    expect(badge()).toBeUndefined();
  });

  it('should zoom an internal page with Ctrl and the mouse wheel', async () => {
    const viewport = element.querySelector('.viewport') as HTMLElement;
    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true });
    viewport.dispatchEvent(wheel);
    await stable();

    expect(wheel.defaultPrevented).toBe(true);
    expect(element.querySelector('.zoom-badge')?.textContent?.trim()).toBe('110%');

    // Без Ctrl — звичайна прокрутка.
    const scroll = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    viewport.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
  });

  it('should offer to translate a site from the address bar and mark a translated page', async () => {
    const translate = () => element.querySelector('.omnibox__translate') as HTMLButtonElement | null;
    expect(translate()).toBeNull();

    await typeInOmnibox('www.hltv.org');
    expect(translate()?.getAttribute('popovertarget')).toBe('translator');
    expect(translate()?.getAttribute('aria-label')).toBe('Перекласти сторінку');
    expect(translate()?.classList).not.toContain('omnibox__translate--active');

    pages.emit('page://navigation', {
      label: label(1),
      url: 'https://www-hltv-org.translate.goog/?_x_tr_sl=auto&_x_tr_tl=uk',
      canGoBack: true,
      canGoForward: false,
    });
    await stable();
    expect(translate()?.classList).toContain('omnibox__translate--active');
    expect(translate()?.getAttribute('title')).toBe('Сторінку перекладено');
  });

  it('should take a screenshot of the site on Ctrl+Shift+S, also while the site has focus', async () => {
    await typeInOmnibox('www.hltv.org');

    document.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyS', key: 'І', cancelable: true })
    );
    await stable();
    expect(pages.called('screenshot')).toEqual([[label(1), false]]);

    pages.emit('page://shortcut', { label: label(1), shortcut: 'screenshot' });
    await stable();
    expect(pages.called('screenshot')).toEqual([
      [label(1), false],
      [label(1), false],
    ]);
  });

  describe('site permissions', () => {
    const panel = () => element.querySelector('.site-permissions .popover') as HTMLElement;
    const autoplay = () => panel().querySelector('#site-permissions-autoplay') as HTMLButtonElement;
    // jsdom не має Popover API: відкриття — це подія toggle з newState, як її шле браузер.
    const open = async (popover: Element | null) => {
      popover?.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await stable();
      await stable();
    };
    const openPanel = () => open(panel());
    const choose = async (label: string) => {
      const list = panel().querySelector(`#${autoplay().getAttribute('aria-controls')}`);
      await open(list);
      [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
        .find((option) => option.textContent?.trim() === label)
        ?.click();
      await stable();
      await stable();
    };

    it('should keep the site playing under an open panel and hide it only under a modal window', async () => {
      const covering = () => document.documentElement.classList.contains('page-covering');
      await typeInOmnibox('www.twitch.tv');
      const shown = pages.called('visible').length;

      // Панель над сайтом: сайт не ховається й не знімається — у ньому вирізається отвір під панель.
      panel().dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }));
      expect(covering()).toBe(false);
      await openPanel();
      expect(pages.called('visible').slice(shown)).not.toContainEqual([label(1), false]);

      // Модальне вікно затемнює все, тож сайт під ним, як і раніше, ховається — ще до першого кадру вікна.
      const dialog = element.querySelector('dialog.download-prompt') as HTMLDialogElement;
      dialog.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }));
      expect(covering()).toBe(true);
      dialog.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
      expect(covering()).toBe(false);
    });

    it('should replace the logo with the permissions button on sites only', async () => {
      expect(element.querySelector('.omnibox__site')).toBeNull();
      expect(element.querySelector('.omnibox__logo')).toBeTruthy();

      await typeInOmnibox('www.twitch.tv/missmartik');

      expect(element.querySelector('.omnibox__site')?.getAttribute('popovertarget')).toBe('site-permissions');
      expect(element.querySelector('.omnibox__logo')).toBeNull();
    });

    it('should block autoplay by default, let the site have it and offer to reload the page', async () => {
      await typeInOmnibox('www.twitch.tv/missmartik');
      await openPanel();

      expect(panel().querySelector('.site-permissions__title')?.textContent?.trim()).toBe('Дозволи для www.twitch.tv');
      // Сайту, для якого ще нічого не вибрано, автовідтворення заборонене.
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо та відео');
      const name = autoplay().getAttribute('aria-labelledby') ?? '';
      expect(panel().querySelector(`#${name}`)?.textContent?.trim()).toBe('Автовідтворення');
      expect(panel().querySelector('.site-permissions__notice')).toBeNull();

      await choose('Дозволити аудіо та відео');
      expect(pages.called('set-autoplay')).toEqual([[label(1), 'allow']]);
      expect(panel().querySelector('.site-permissions__notice')?.textContent).toContain('після перезавантаження');

      panel().querySelector<HTMLButtonElement>('.site-permissions__reload')?.click();
      await stable();
      expect(pages.called('reload')).toEqual([[label(1)]]);
    });

    it('should block autoplay again on a site where it was allowed', async () => {
      pages.autoplayPermission = 'allow';
      await typeInOmnibox('www.twitch.tv');
      await openPanel();
      expect(autoplay().textContent?.trim()).toBe('Дозволити аудіо та відео');

      // Дозвіл, даний ще до наших правил (лише в WebView2), перейшов і в правила скрипта сторінки.
      expect(TestBed.inject(AutoplayStore).rules().allow).toEqual(['https://www.twitch.tv']);

      await choose('Блокувати аудіо та відео');
      expect(pages.called('set-autoplay')).toEqual([[label(1), 'block']]);
      expect(TestBed.inject(AutoplayStore).rules()).toEqual({ allow: [], blockAudio: [] });
    });

    it('should block only the sound of autoplay with a page script', async () => {
      await typeInOmnibox('www.twitch.tv/missmartik');
      await openPanel();

      await choose('Блокувати аудіо');

      // Відео сайту дозволене, а звук глушить скрипт сторінки.
      expect(pages.called('set-autoplay')).toEqual([[label(1), 'allow']]);
      const rules = { allow: [], blockAudio: ['https://www.twitch.tv'] };
      expect(TestBed.inject(AutoplayStore).rules()).toEqual(rules);
      expect(pages.called('audio-rules').at(-1)).toEqual([rules]);
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо');

      // Нові вкладки отримують список одразу, разом зі скриптом.
      element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
      await stable();
      await typeInOmnibox('twitch.tv');
      expect(pages.called('autoplay').at(-1)).toEqual([label(2), rules]);

      // І панель це пам'ятає.
      await typeInOmnibox('www.twitch.tv/other');
      await openPanel();
      expect(autoplay().textContent?.trim()).toBe('Блокувати аудіо');
    });
  });

  describe('ad blocker', () => {
    const extensionsButton = () => element.querySelector('[popovertarget="extensions-menu"]') as HTMLButtonElement;
    const menu = () => element.querySelector('.extensions-menu .popover') as HTMLElement;
    const panel = () => element.querySelector('.adblock-panel .popover') as HTMLElement;
    const state = () => menu().querySelector('.extensions-menu__state')?.textContent?.trim();
    const siteSwitch = () => panel().querySelector('#adblock-panel-site') as HTMLInputElement;
    const adblock = () => TestBed.inject(AdBlockStore) as FakeAdBlock;
    // jsdom не має Popover API: відкриття кнопкою — це подія toggle з newState, як її шле браузер.
    const openMenu = async () => {
      menu().dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await stable();
    };
    const openPanel = async () => {
      await openMenu();
      menu().querySelector<HTMLButtonElement>('.extensions-menu__open')?.click();
      await stable();
    };
    const action = async (label: string) => {
      [...element.querySelectorAll<HTMLButtonElement>('.extension-actions__item')]
        .find((item) => item.textContent?.trim() === label)
        ?.click();
      await stable();
    };
    const blocked = async (count: number) => {
      pages.emit('page://adblock', { label: label(1), blocked: count });
      await stable();
    };

    it('should list the blocker in the extensions menu of the toolbar, not in the address bar', async () => {
      expect(element.querySelector('.omnibox [popovertarget="adblock-panel"]')).toBeNull();
      expect(extensionsButton().getAttribute('aria-label')).toBe('Розширення');
      expect(menu().querySelector('.extensions-menu__name')?.textContent?.trim()).toBe('Блокувальник реклами');
      expect(state()).toBe('Прибирає рекламу й трекери на сайтах');

      await typeInOmnibox('www.youtube.com');
      expect(state()).toBe('Блокує рекламу на цьому сайті');

      await blocked(3);
      expect(state()).toBe('Заблоковано на цій сторінці: 3');

      // Нова сторінка вкладки — лічильник з нуля.
      await blocked(0);
      expect(state()).toBe('Блокує рекламу на цьому сайті');
    });

    it('should open the blocker panel from the menu and turn blocking off for the site there', async () => {
      await typeInOmnibox('www.youtube.com/watch?v=1');
      await blocked(12);
      await openPanel();

      expect(element.querySelector('app-adblock-panel app-popover')?.classList).toContain('is-open');
      expect(panel().querySelector('.adblock-panel__host')?.textContent).toBe('www.youtube.com');
      expect(panel().querySelector('.adblock-panel__number')?.textContent).toBe('12');
      expect(panel().querySelector('.adblock-panel__count')?.textContent).toContain('запитів заблоковано на цій сторінці');
      expect(siteSwitch().checked).toBe(true);

      siteSwitch().checked = false;
      siteSwitch().dispatchEvent(new Event('change'));
      await stable();

      expect(adblock().calls).toEqual([['site', 'youtube.com', false]]);
      expect(pages.called('reload')).toEqual([[label(1)]]);
      expect(siteSwitch().checked).toBe(false);
      expect(state()).toBe('Вимкнено на цьому сайті');
      expect(menu().querySelector('.extensions-menu__icon')?.classList).toContain('extensions-menu__icon--off');

      // Виняток діє й на піддомени.
      await typeInOmnibox('music.youtube.com');
      expect(state()).toBe('Вимкнено на цьому сайті');
    });

    it('should switch the blocker for the site or everywhere from the actions menu', async () => {
      await typeInOmnibox('www.youtube.com');

      await action('Вимкнути на цьому сайті');
      expect(adblock().calls).toEqual([['site', 'youtube.com', false]]);
      expect(pages.called('reload')).toEqual([[label(1)]]);
      await action('Увімкнути на цьому сайті');
      expect(adblock().calls.at(-1)).toEqual(['site', 'youtube.com', true]);

      await action('Вимкнути розширення');
      expect(adblock().calls.at(-1)).toEqual(['enabled', false]);
      expect(state()).toBe('Вимкнено');
      // Вимкнений скрізь — пункту для сайту немає.
      expect([...element.querySelectorAll('.extension-actions__item')].map((item) => item.textContent?.trim())).toEqual([
        'Увімкнути розширення',
        'Керувати розширенням',
      ]);
    });

    it('should offer to turn the blocker back on in its panel when it is off everywhere', async () => {
      adblock().patch({ enabled: false });
      await typeInOmnibox('www.youtube.com');
      await openPanel();

      expect(panel().querySelector('.adblock-panel__notice')?.textContent).toContain('вимкнено для всіх сайтів');
      expect(siteSwitch().disabled).toBe(true);

      panel().querySelector<HTMLButtonElement>('.adblock-panel__button')?.click();
      await stable();

      expect(adblock().calls).toEqual([['enabled', true]]);
      expect(pages.called('reload')).toEqual([[label(1)]]);
      expect(panel().querySelector('.adblock-panel__notice')).toBeNull();
    });

    it('should open the extensions page to manage extensions', async () => {
      await typeInOmnibox('www.youtube.com');
      await openMenu();

      menu().querySelector<HTMLButtonElement>('.extensions-menu__manage')?.click();
      await stable();

      expect(element.querySelector('app-extensions-page')).toBeTruthy();
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
    const bookmark = (title: string) =>
      [...element.querySelectorAll('.bookmark')].find((item) => item.textContent?.includes(title));
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

  it('should switch tabs with Ctrl+Tab pressed inside a site and follow with the focus', async () => {
    await typeInOmnibox('angular.dev');
    element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
    await stable();
    await typeInOmnibox('www.youtube.com');
    element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
    await stable();
    const active = () => [...element.querySelectorAll('.tab')].findIndex((tab) => tab.classList.contains('tab--active'));
    const shortcut = async (from: string, name: 'next-tab' | 'previous-tab') => {
      pages.emit('page://shortcut', { label: from, shortcut: name });
      await stable();
    };

    // Клавіші натиснуто в сайті, якого зараз не видно, — не рахуються.
    await shortcut(label(1), 'next-tab');
    expect(active()).toBe(2);

    element.querySelectorAll<HTMLButtonElement>('.tab__select')[1].click();
    await stable();
    await shortcut(label(2), 'previous-tab');
    expect(active()).toBe(0);
    expect(pages.called('focus').at(-1)).toEqual([label(1)]);

    // На вкладку без сайту фокус повертається в інтерфейс.
    await shortcut(label(1), 'previous-tab');
    expect(active()).toBe(2);
    expect(pages.called('focus-interface')).toEqual([[]]);
  });

  it('should open a site from the history page and come back to it', async () => {
    TestBed.inject(HistoryStore).record('https://angular.dev/', 'Angular', Date.now());
    await typeInOmnibox('astra://history');

    element.querySelector<HTMLButtonElement>('.page__open')?.click();
    await stable();
    expect(pages.called('open')).toEqual([[label(1), 'https://angular.dev/']]);
    expect(titles()).toEqual(['angular.dev']);

    button('Назад').click();
    await stable();
    expect(element.querySelector('app-history-page')).toBeTruthy();

    // Коліщатком — у новій вкладці у фоні.
    element
      .querySelector('.page__open')
      ?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    await stable();
    expect(titles()).toEqual(['Історія', 'angular.dev']);
    expect(pages.called('background').at(-1)).toEqual([label(2)]);
  });

  it('should open all bookmarks of the bar in new tabs from its menu and show the first', async () => {
    const bookmarks = TestBed.inject(BookmarksStore);
    bookmarks.add('YouTube', 'https://www.youtube.com/');
    bookmarks.addSeparator();
    bookmarks.add('Angular', 'https://angular.dev/');
    await stable();

    element.querySelector('.bookmarks')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await stable();
    [...element.querySelectorAll<HTMLButtonElement>('.bookmarks-menu [role="menuitem"]')]
      .find((item) => item.textContent?.trim() === 'Відкрити всі закладки')
      ?.click();
    await stable();

    expect(titles()).toEqual(['Нова вкладка', 'youtube.com', 'angular.dev']);
    expect(pages.called('open')).toEqual([
      [label(2), 'https://www.youtube.com/'],
      [label(3), 'https://angular.dev/'],
    ]);
    expect(element.querySelectorAll('.tab')[1].classList).toContain('tab--active');
    // Першу показано вже після того, як її webview створився, — інакше вона лишалася б порожньою, доки не перемкнути вкладку.
    const opened = pages.calls.findIndex(([call, page]) => call === 'open' && page === label(2));
    expect(pages.calls.slice(opened).some(([call, page, visible]) => call === 'visible' && page === label(2) && visible)).toBe(
      true
    );
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
      expect(pages.called('bounds').at(-1)).toEqual([
        label(1),
        { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      ]);

      await fullscreen(false);
      expect(windows.fullscreenCalls).toEqual([true, false]);
      expect(pages.called('bounds').at(-1)?.[1]).not.toEqual({
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      });
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

    pages.emit('page://navigation', {
      label: label(1),
      url: 'https://www.youtube.com/watch?v=abc',
      canGoBack: true,
      canGoForward: false,
    });
    await stable();
    expect(pip()?.getAttribute('aria-label')).toBe('Картинка в картинці');

    pip()?.click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'BracketRight', key: 'Ї', cancelable: true })
    );
    await stable();
    expect(pages.called('pip')).toEqual([[label(1)], [label(1)]]);

    await typeInOmnibox('example.com');
    pages.emit('page://navigation', { label: label(1), url: 'https://example.com/watch', canGoBack: true, canGoForward: false });
    await stable();
    expect(pip()).toBeNull();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'BracketRight', key: '}', cancelable: true })
    );
    expect(pages.called('pip').length).toBe(2);
  });

  describe('downloads', () => {
    const button = () => element.querySelector('.downloads-button') as HTMLButtonElement;
    const rows = () =>
      [...element.querySelectorAll('.downloads-menu__row')].map((row) => [
        row.querySelector('.downloads-menu__name')?.textContent?.trim(),
        row.querySelector('.downloads-menu__meta')?.textContent?.trim(),
      ]);
    const download = async (
      received: number,
      state: 'in-progress' | 'completed' | 'failed' | 'canceled' = 'in-progress',
      total = 4096
    ) => {
      pages.emit('page://download', {
        label: label(1),
        id: 3,
        url: 'https://x.example/a.zip',
        path: 'C:\\Downloads\\a.zip',
        fileName: 'a.zip',
        received,
        total,
        state,
      });
      await stable();
    };

    it('should show a downloads button with the progress once something downloads', async () => {
      await typeInOmnibox('angular.dev');
      expect(button()).toBeNull();

      await download(1024);
      expect(button().getAttribute('aria-label')).toBe('Завантаження: триває 1');
      expect(button().classList).toContain('downloads-button--busy');
      expect(element.querySelector('.downloads-button__value')?.getAttribute('stroke-dasharray')).toBe('25 100');
      expect(rows()).toEqual([['a.zip', '1 КБ з 4 КБ']]);
      // Перехід став завантаженням — вкладка вже не вантажиться.
      expect(element.querySelector('.tab__spinner')).toBeNull();

      element.querySelector<HTMLButtonElement>('[aria-label="Скасувати завантаження «a.zip»"]')?.click();
      expect(pages.called('cancel-download')).toEqual([[3]]);

      await download(4096, 'completed');
      expect(button().getAttribute('aria-label')).toBe('Завантаження');
      expect(element.querySelector('.downloads-button__ring')).toBeNull();
      expect(button().classList).not.toContain('downloads-button--busy');
      expect(rows()).toEqual([['a.zip', 'Завантажено · 4 КБ · x.example']]);
      // Запізнілі звістки про те, що вже скінчилося, список не змінюють.
      await download(4096, 'canceled');
      await download(4096);
      expect(rows()).toEqual([['a.zip', 'Завантажено · 4 КБ · x.example']]);
      expect(
        TestBed.inject(DownloadsStore)
          .entries()
          .map((entry) => [entry.fileName, entry.size, entry.status])
      ).toEqual([['a.zip', 4096, 'completed']]);

      element.querySelector<HTMLButtonElement>('.downloads-menu__file')?.click();
      element.querySelector<HTMLButtonElement>('[aria-label="Показати «a.zip» у теці"]')?.click();
      expect(pages.called('open-download')).toEqual([['C:\\Downloads\\a.zip']]);
      expect(pages.called('show-download')).toEqual([['C:\\Downloads\\a.zip']]);
    });

    it('should spin when the size is unknown and open the downloads page', async () => {
      await typeInOmnibox('angular.dev');
      await download(2048, 'in-progress', 0);

      expect(element.querySelector('.downloads-button__ring')?.classList).toContain('downloads-button__ring--unknown');
      expect(rows()).toEqual([['a.zip', '2 КБ']]);

      element.querySelector<HTMLButtonElement>('.downloads-menu__all')?.click();
      await stable();
      expect(element.querySelector('app-downloads-page')).toBeTruthy();
    });

    it('should remove one finished download or clear them all from the list', async () => {
      await typeInOmnibox('angular.dev');
      for (const id of [3, 4]) {
        pages.emit('page://download', {
          label: label(1),
          id,
          url: `https://x.example/${id}.zip`,
          path: `C:\\Downloads\\${id}.zip`,
          fileName: `${id}.zip`,
          received: 10,
          total: 10,
          state: 'completed',
        });
      }
      await stable();
      expect(rows().map(([name]) => name)).toEqual(['4.zip', '3.zip']);

      element.querySelector<HTMLButtonElement>('[aria-label="Прибрати «4.zip» зі списку"]')?.click();
      await stable();
      expect(rows().map(([name]) => name)).toEqual(['3.zip']);

      [...element.querySelectorAll<HTMLButtonElement>('.downloads-menu__all')]
        .find((item) => item.textContent?.includes('Очистити'))
        ?.click();
      await stable();
      expect(TestBed.inject(DownloadsStore).entries()).toEqual([]);
      expect(button()).toBeNull();
    });

    it('should ask where to save a file and let the folder change for it alone', async () => {
      await typeInOmnibox('angular.dev');
      const prompt = () => element.querySelector('.download-prompt') as HTMLDialogElement;
      const ask = async (id: number) => {
        pages.emit('page://download-prompt', {
          label: label(1),
          id,
          url: 'https://x.example/files/report.pdf',
          fileName: `report-${id}.pdf`,
          folder: 'C:\\Users\\me\\Downloads',
          total: 2048,
        });
        await stable();
      };
      const click = async (selector: string) => {
        prompt().querySelector<HTMLElement>(selector)?.click();
        await stable();
      };
      const setAsk = vi.spyOn(TestBed.inject(DownloadSettingsStore), 'setAsk').mockResolvedValue();

      await ask(5);
      await ask(6);
      expect(prompt().querySelector('.download-prompt__name')?.textContent).toBe('report-5.pdf');
      expect(prompt().querySelector('.download-prompt__meta')?.textContent?.trim()).toBe('2 КБ · x.example');
      expect(prompt().querySelector('.download-prompt__path')?.textContent).toBe('C:\\Users\\me\\Downloads');

      // Інша тека — лише для цього файла.
      await click('.download-prompt__folder .download-prompt__button');
      expect(pages.called('pick-folder')).toEqual([['C:\\Users\\me\\Downloads']]);
      expect(prompt().querySelector('.download-prompt__path')?.textContent).toBe('D:\\Файли');
      await click('.download-prompt__button--primary');
      expect(pages.called('resolve-download')).toEqual([[5, 'D:\\Файли']]);

      // Наступний запит — зі своєю текою; «Скасувати» не завантажує.
      expect(prompt().querySelector('.download-prompt__name')?.textContent).toBe('report-6.pdf');
      expect(prompt().querySelector('.download-prompt__path')?.textContent).toBe('C:\\Users\\me\\Downloads');
      await click('.download-prompt__actions .download-prompt__button:not(.download-prompt__button--primary)');
      expect(pages.called('resolve-download').at(-1)).toEqual([6, null]);
      expect(prompt().querySelector('.download-prompt__name')).toBeNull();

      // «Більше не питати» вимикає налаштування.
      await ask(7);
      await click('.download-prompt__dont-ask input');
      await click('.download-prompt__button--primary');
      expect(setAsk).toHaveBeenCalledWith(false);
      expect(pages.called('resolve-download').at(-1)).toEqual([7, 'C:\\Users\\me\\Downloads']);
    });

    it('should let a failed download be removed from the list', async () => {
      await typeInOmnibox('angular.dev');
      await download(0, 'failed');

      expect(rows()).toEqual([['a.zip', 'Помилка завантаження']]);
      element.querySelector<HTMLButtonElement>('[aria-label="Прибрати «a.zip» зі списку"]')?.click();
      await stable();
      expect(TestBed.inject(DownloadsStore).entries()).toEqual([]);
      expect(button()).toBeNull();
    });
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
