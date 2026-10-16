import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { UpdateStore } from './data/updates';
import { AuthStore } from '../shared/auth/auth';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { Titlebar } from '../shared/titlebar/titlebar';
import { AUDIBLE_HOLD_MS, Browser } from './browser';
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
  /** Посилання, з якими «запустили» браузер. */
  launch: string[] = [];
  launchUrls() {
    return Promise.resolve(this.launch);
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
  exitFullscreen(label: string) {
    return this.record('exit-fullscreen', label);
  }
  setInputRegion(page: unknown, keep: unknown) {
    return this.record('input-region', page, keep);
  }
  screenshot(label: string, full: boolean) {
    this.calls.push(['screenshot', label, full]);
    return Promise.reject(new Error('jsdom не знімає сторінок'));
  }
  setZoom(label: string, scale: number) {
    return this.record('zoom', label, scale);
  }
  focus(label: string, tab: string | null = null) {
    return tab ? this.record('focus', label, tab) : this.record('focus', label);
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
  resolveDownload(id: number, folder: string | null, replace = false) {
    return replace ? this.record('resolve-download', id, folder, 'replace') : this.record('resolve-download', id, folder);
  }
  existingFiles: string[] = [];
  downloadFileExists(folder: string, fileName: string) {
    return Promise.resolve(this.existingFiles.includes(`${folder}\\${fileName}`));
  }
  pickedFolder: string | null = 'D:\\Файли';
  pickDownloadFolder(current: string) {
    this.calls.push(['pick-folder', current]);
    return Promise.resolve(this.pickedFolder);
  }
  print(label: string) {
    return this.record('print', label);
  }
  openDevTools(label: string) {
    return this.record('devtools', label);
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
    // Поки webview створювався, межі до нього не доходили (а розкладка під час запуску ще змінюється) — тож ще раз.
    const calls = pages.calls.map(([name, page]) => `${name} ${String(page)}`);
    expect(calls.lastIndexOf(`bounds ${label(3)}`)).toBeGreaterThan(calls.indexOf(`open ${label(3)}`));
    expect(calls.lastIndexOf(`visible ${label(3)}`)).toBeGreaterThan(calls.indexOf(`open ${label(3)}`));

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

  it('should start with a clean new tab right after signing in and forget the tabs of the last time', async () => {
    fixture.destroy();
    localStorage.setItem('astra.session.web', JSON.stringify({ tabs: [{ page: 'settings' }], active: 0 }));
    vi.spyOn(TestBed.inject(AuthStore), 'takeFreshSignIn').mockReturnValue(true);
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await stable();

    expect(titles()).toEqual(['Нова вкладка']);
    expect(JSON.parse(localStorage.getItem('astra.session.web') ?? 'null')).toEqual({ tabs: [{ page: 'new-tab' }], active: 0 });
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

  it('should open links clicked with the wheel or Ctrl in a background tab', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');

    pages.emit('page://new-tab', { label: label(1), url: 'https://example.com/news', userInitiated: true, background: true });
    await stable();
    expect(pages.called('background')).toContainEqual([label(2)]);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('example.com');

    // target="_blank" чи window.open — одразу на нову вкладку.
    pages.emit('page://new-tab', { label: label(1), url: 'https://example.org/', userInitiated: true });
    await stable();
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('example.org');

    // «Одразу переходити на нову вкладку»: коліщатком — на нову, а з Shift — у фоні.
    TestBed.inject(SettingsStore).switchToNewTab.set(true);
    pages.emit('page://new-tab', { label: label(1), url: 'https://example.net/', userInitiated: true, background: true });
    await stable();
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('example.net');
    pages.emit('page://new-tab', { label: label(1), url: 'https://example.edu/', userInitiated: true, background: false });
    await stable();
    expect(pages.called('background')).toContainEqual([label(5)]);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('example.net');
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

  it('should open a local development server, show its source and its developer tools', async () => {
    await typeInOmnibox('localhost:4200');
    await load(1, 'http://localhost:4200/');
    expect(pages.called('open')).toEqual([[label(1), 'http://localhost:4200/']]);

    // Ctrl+U у сайті — код сторінки новою вкладкою.
    pages.emit('page://shortcut', { label: label(1), shortcut: 'view-source' });
    await stable();
    expect(pages.called('open').at(-1)).toEqual([label(2), 'view-source:http://localhost:4200/']);
    expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('localhost');
    // WebView2 називає адресу коду сторінки адресою самого сайту — вкладка лишається з кодом, історія — без нього.
    await load(2, 'http://localhost:4200/');
    pages.emit('page://navigation', { label: label(2), url: 'http://localhost:4200/', canGoBack: false, canGoForward: false });
    pages.emit('page://title', { label: label(2), title: 'view-source:http://localhost:4200/' });
    await stable();
    expect(omnibox().value).toBe('view-source:http://localhost:4200/');
    expect(
      TestBed.inject(HistoryStore)
        .entries()
        .map((entry) => entry.title)
    ).not.toContain('view-source:http://localhost:4200/');

    // F12 з інтерфейсу — інструменти розробника сайту в активній вкладці.
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F12', key: 'F12', cancelable: true }));
    await stable();
    expect(pages.called('devtools')).toEqual([[label(2)]]);

    // «Переглянути джерело сторінки» з контекстного меню сайту.
    pages.emit('page://context', { label: label(1), action: 'view-source', url: 'http://localhost:4200/' });
    await stable();
    expect(pages.called('open').at(-1)).toEqual([label(3), 'view-source:http://localhost:4200/']);
  });

  it('should not open developer tools on internal pages', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F12', key: 'F12', cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'KeyU', key: 'г', cancelable: true }));
    await stable();

    expect(pages.called('devtools')).toEqual([]);
    expect(titles()).toEqual(['Нова вкладка']);
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

  it('should unload a tab that has slept for hours and load it again when opened', async () => {
    await typeInOmnibox('example.com');
    await load(1, 'https://example.com/');
    pages.emit('page://navigation', { label: label(1), url: 'https://example.com/', canGoBack: false, canGoForward: false });
    pages.emit('page://title', { label: label(1), title: 'Example' });
    const history = () => TestBed.inject(HistoryStore).entries();
    button('Нова вкладка').click();
    await stable();
    await typeInOmnibox('github.com');
    const browser = fixture.debugElement.query(By.directive(Browser)).componentInstance as unknown as {
      sleepInactiveTabs(now: number): void;
    };
    const now = Date.now();
    browser.sleepInactiveTabs(now + 31 * 60_000);
    await new Promise((resolve) => setTimeout(resolve));
    await stable();
    expect(pages.called('close')).toEqual([]);

    // Проспала понад 6 годин — webview закрито, а вкладка лишилася з тією самою назвою.
    browser.sleepInactiveTabs(now + 7 * 60 * 60_000);
    await stable();
    expect(pages.called('close')).toEqual([[label(1)]]);
    const tab = () =>
      [...element.querySelectorAll<HTMLElement>('.tab__select')].find((item) => item.textContent?.includes('Example'));
    expect(tab()).toBeTruthy();

    const visits = history().length;
    const opened = pages.called('open').length;
    tab()?.click();
    await stable();
    const [reopened, url] = pages.called('open').at(-1) as [string, string];
    expect(pages.called('open').length).toBe(opened + 1);
    expect(reopened).not.toBe(label(1));
    expect(url).toBe('https://example.com/');
    // Той самий сайт — без нового запису в історії.
    pages.emit('page://navigation', { label: reopened, url: 'https://example.com/', canGoBack: false, canGoForward: false });
    await stable();
    expect(history().length).toBe(visits);
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

  it('should make the menu button call for attention until the new version is seen in the menu', async () => {
    const menuButton = () => element.querySelector('.toolbar__button--menu') as HTMLButtonElement;
    const openMenu = async () => {
      element.querySelector('#browser-menu')?.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await stable();
    };
    const updates = TestBed.inject(UpdateStore);
    expect(menuButton().classList).not.toContain('toolbar__button--update');

    updates.available.set({ version: '0.2.0' });
    await stable();
    expect(menuButton().classList).toContain('toolbar__button--update');
    expect(menuButton().querySelector('.toolbar__update-dot')).toBeTruthy();
    expect(menuButton().getAttribute('aria-label')).toBe('Меню — доступне оновлення');

    // Просто відкрили й закрили меню, не оновившись, — і більше не блимає, навіть після перевірки знову.
    await openMenu();
    updates.available.set({ version: '0.2.0' });
    await stable();
    expect(menuButton().classList).not.toContain('toolbar__button--update');
    expect(menuButton().querySelector('.toolbar__update-dot')).toBeNull();
    expect(localStorage.getItem('astra.update-seen')).toBe('"0.2.0"');

    // Вийшла ще новіша версія — знову.
    updates.available.set({ version: '0.3.0' });
    await stable();
    expect(menuButton().classList).toContain('toolbar__button--update');
  });

  describe('links from other apps', () => {
    it('should open links from another app as new tabs, taking the empty new tab first', async () => {
      pages.emit('app://open', { urls: ['https://t.me/astra', 'https://mail.example/inbox'] });
      await stable();

      expect(titles()).toEqual(['t.me', 'mail.example']);
      expect(element.querySelector('.tab--active .tab__title')?.textContent?.trim()).toBe('mail.example');
      expect(windows.opened).toEqual([]);
    });

    it('should load a single link right away in the empty new tab', async () => {
      pages.emit('app://open', { urls: ['https://t.me/astra'] });
      await stable();

      expect(titles()).toEqual(['t.me']);
      expect(pages.called('open').map((call) => call[1])).toEqual(['https://t.me/astra']);
    });

    it('should keep the open site and add the link next to it', async () => {
      await typeInOmnibox('angular.dev');
      pages.emit('app://open', { urls: ['https://t.me/astra', 'file:///C:/secret.txt'] });
      await stable();

      expect(titles()).toEqual(['angular.dev', 't.me']);
      expect(pages.called('open').at(-1)?.[1]).toBe('https://t.me/astra');
    });

    it('should open a new window when the browser is started again without links', async () => {
      pages.emit('app://open', { urls: [] });
      await stable();

      expect(windows.opened).toEqual([{}]);
      expect(titles()).toEqual(['Нова вкладка']);
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
    const reloadButton = () => button('Оновити сторінку');
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
      expect(button('Оновити сторінку').disabled).toBe(true);
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

    button('Оновити сторінку').click();
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

    // Звук затих: значок ще лишається — коротка пауза (у трансляції, між треками) його не ховає…
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pages.emit('page://audio', { label: label(1), playing: false, muted: false });
      fixture.detectChanges();
      expect(audio()?.getAttribute('aria-label')).toBe('Вимкнути звук вкладки «youtube.com»');
      vi.advanceTimersByTime(AUDIBLE_HOLD_MS - 100);
      pages.emit('page://audio', { label: label(1), playing: true, muted: false });
      pages.emit('page://audio', { label: label(1), playing: false, muted: false });
      vi.advanceTimersByTime(AUDIBLE_HOLD_MS - 100);
      fixture.detectChanges();
      expect(audio()).toBeTruthy();

      // …а зупинене відео — так.
      vi.advanceTimersByTime(200);
      fixture.detectChanges();
      expect(audio()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

    it('should keep the site under panels and modal windows and let a modal window catch the mouse', async () => {
      // Регіон інтерфейсу: [сторінка, яку з нього вирізано (null — увесь інтерфейс), панелі над нею].
      const region = () => pages.called('input-region').at(-1) ?? [];
      await typeInOmnibox('www.twitch.tv');
      await stable();
      // Сайт видно крізь прозорий інтерфейс, і мишу над сторінкою ловить він сам.
      expect(document.documentElement.classList).toContain('site-visible');
      expect(region()[0]).not.toBeNull();
      const shown = pages.called('visible').length;

      // Панель над сайтом: сайт не ховається й не знімається.
      await openPanel();
      expect(pages.called('visible').slice(shown)).not.toContainEqual([label(1), false]);

      // Модальне вікно — на весь інтерфейс: затемнення лягає на живий сайт, і клік повз вікно до сайту не доходить.
      // jsdom не відкриває модальних вікон (немає showModal, :modal не збігається) — модальність підміняємо.
      const dialog = element.querySelector('dialog.download-prompt') as HTMLDialogElement;
      let modal = true;
      const matches = dialog.matches.bind(dialog);
      const find = document.querySelector.bind(document);
      const spies = [
        vi.spyOn(dialog, 'matches').mockImplementation((selector) => (selector === ':modal' ? modal : matches(selector))),
        vi
          .spyOn(document, 'querySelector')
          .mockImplementation((selector: string) => (selector === 'dialog:modal' ? (modal ? dialog : null) : find(selector))),
      ];
      dialog.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await stable();
      expect(region()[0]).toBeNull();

      // Закрили — вікно ще згасає, тож сайт знову ловить мишу лише після анімації.
      dialog.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'closed' }));
      modal = false;
      dialog.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
      await stable();
      expect(region()[0]).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(region()[0]).not.toBeNull();
      expect(document.documentElement.classList).toContain('site-visible');
      expect(pages.called('visible').slice(shown)).not.toContainEqual([label(1), false]);
      spies.forEach((spy) => spy.mockRestore());
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
    // Фокус — після того як webview вкладки покажеться (черга показу).
    const shortcut = async (from: string, name: 'next-tab' | 'previous-tab') => {
      pages.emit('page://shortcut', { label: from, shortcut: name });
      await stable();
      await new Promise((resolve) => setTimeout(resolve));
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

  it('should take the focus into the site of a tab clicked with the mouse, but leave it on the tabs from the keyboard', async () => {
    await typeInOmnibox('angular.dev');
    element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
    await stable();
    await typeInOmnibox('www.youtube.com');
    const select = (index: number) => element.querySelectorAll<HTMLButtonElement>('.tab__select')[index];
    // Фокус — після того як webview вкладки покажеться (черга показу).
    const settle = async () => {
      await stable();
      await new Promise((resolve) => setTimeout(resolve));
    };
    const focused = pages.called('focus').length;

    // Enter на вкладці (click без натискань миші) — фокус лишається на вкладках.
    select(0).click();
    await settle();
    expect(element.querySelectorAll('.tab')[0].classList).toContain('tab--active');
    expect(pages.called('focus')).toHaveLength(focused);

    // Мишею — у сайт вкладки, щоб плеєр одразу слухав клавіші.
    select(1).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await settle();
    expect(pages.called('focus').at(-1)).toEqual([label(2)]);

    // Закрито активну — фокус у сайт тієї, що стала активною.
    element.querySelectorAll<HTMLButtonElement>('.tab__close')[1].click();
    await settle();
    expect(pages.called('focus').at(-1)).toEqual([label(1)]);
  });

  it('should take the focus into the site with Tab past the panels, and back to them from the site', async () => {
    const entry = () => element.querySelector<HTMLElement>('.page-entry');
    expect(entry()).toBeNull();
    await typeInOmnibox('angular.dev');

    // Tab з останньої кнопки панелей — у сайт, на перший його елемент.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' }));
    entry()?.focus();
    expect(pages.called('focus').at(-1)).toEqual([label(1), 'forward']);
    expect(document.activeElement).not.toBe(entry());

    // З сайту назад (Shift+Tab на його початку) — на останню кнопку перед ним, а не знову в сайт.
    await new Promise((resolve) => setTimeout(resolve));
    const focused = pages.called('focus').length;
    entry()?.focus();
    expect(document.activeElement?.closest('.chrome')).toBeTruthy();
    expect(pages.called('focus')).toHaveLength(focused);

    // Shift+Tab звідти — до попередньої кнопки, як завжди; а з першої кнопки інтерфейсу — коло назад, у кінець сайту.
    const shiftTab = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true }));
    shiftTab();
    expect(pages.called('focus')).toHaveLength(focused);
    [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
      .find((candidate) => candidate.tabIndex >= 0 && !candidate.matches(':disabled'))
      ?.focus();
    shiftTab();
    expect(pages.called('focus').at(-1)).toEqual([label(1), 'backward']);

    // На внутрішній сторінці кроку немає: Tab іде далі в неї саму.
    await typeInOmnibox('astra://history');
    expect(entry()).toBeNull();
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

    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    it('should leave the window and the site to Rust and restore the site bounds afterwards', async () => {
      await typeInOmnibox('youtube.com');
      const before = pages.called('bounds').at(-1);

      // Вікно й webview на весь екран ставить Rust (fullscreen.rs) — інтерфейс вікна не чіпає.
      await fullscreen(true);
      expect(windows.fullscreenCalls).toEqual([]);
      expect(pages.called('exit-fullscreen')).toEqual([]);

      await fullscreen(false);
      await frame();
      await settle();
      expect(windows.fullscreenCalls).toEqual([]);
      expect(pages.called('exit-fullscreen')).toEqual([]);
      expect(pages.called('bounds').at(-1)).toEqual(before);
    });

    it('should bring the site out of fullscreen when another tab is shown', async () => {
      await typeInOmnibox('youtube.com');
      await fullscreen(true);

      element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
      await settle();

      expect(pages.called('exit-fullscreen')).toEqual([[label(1)]]);
    });

    it('should put back a site that went fullscreen while hidden', async () => {
      await typeInOmnibox('youtube.com');
      element.querySelector<HTMLButtonElement>('.new-tab-button')?.click();
      await settle();

      await fullscreen(true);
      expect(pages.called('exit-fullscreen')).toEqual([[label(1)]]);
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

    it('should ask whether to replace a file that already exists or keep both', async () => {
      await typeInOmnibox('angular.dev');
      const prompt = () => element.querySelector('.download-prompt') as HTMLDialogElement;
      const ask = async (id: number) => {
        pages.emit('page://download-prompt', {
          label: label(1),
          id,
          url: 'https://x.example/files/report.pdf',
          fileName: 'report.pdf',
          folder: 'C:\\Users\\me\\Downloads',
          total: 2048,
          exists: true,
        });
        await stable();
      };
      const click = async (selector: string) => {
        prompt().querySelector<HTMLElement>(selector)?.click();
        await stable();
      };
      const primary = () => prompt().querySelector('.download-prompt__button--primary')?.textContent?.trim();

      await ask(8);
      expect(prompt().querySelector('.download-prompt__title')?.textContent?.trim()).toBe('Такий файл уже є');
      expect(primary()).toBe('Зберегти обидва');
      await click('.download-prompt__button--replace');
      expect(pages.called('resolve-download').at(-1)).toEqual([8, 'C:\\Users\\me\\Downloads', 'replace']);

      // «Зберегти обидва» — новий поряд, наявний не чіпається.
      await ask(9);
      await click('.download-prompt__button--primary');
      expect(pages.called('resolve-download').at(-1)).toEqual([9, 'C:\\Users\\me\\Downloads']);

      // В іншій теці такого файла немає — звичайне «Зберегти».
      await ask(10);
      await click('.download-prompt__folder .download-prompt__button');
      expect(prompt().querySelector('.download-prompt__button--replace')).toBeNull();
      expect(primary()).toBe('Зберегти');
      // А в теці, де він є, — знову вибір.
      pages.existingFiles = ['E:\\Архів\\report.pdf'];
      pages.pickedFolder = 'E:\\Архів';
      await click('.download-prompt__folder .download-prompt__button');
      expect(primary()).toBe('Зберегти обидва');
      await click('.download-prompt__button--replace');
      expect(pages.called('resolve-download').at(-1)).toEqual([10, 'E:\\Архів', 'replace']);
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
