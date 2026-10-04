import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { normalizeUrl } from '../shared/form-field/form-field';
import { MiddleClick } from '../shared/middle-click/middle-click';
import { SettingsStore } from '../shared/settings/settings';
import { UiIcon } from '../shared/ui-icon/ui-icon';
import { UiInput } from '../shared/ui-input/ui-input';
import { TitlebarContent } from '../shared/titlebar/titlebar-content';
import { BookmarksBar } from './bookmarks-bar/bookmarks-bar';
import { BrowserMenu } from './browser-menu/browser-menu';
import { Avatar } from './avatar/avatar';
import { BookmarkEditor } from './bookmark-editor/bookmark-editor';
import { Bookmark, BookmarksStore } from './data/bookmarks';
import { AutoplayStore } from './data/autoplay';
import { DownloadsStore } from './data/downloads';
import { PasswordsStore } from './data/passwords';
import { DownloadPrompt } from './download-prompt/download-prompt';
import { Screenshot } from './screenshot/screenshot';
import { isTranslated } from './translator/translate-urls';
import { SyncService } from './sync/sync';
import { TranslateLanguageStore } from './translator/translate-language';
import { DEFAULT_ZOOM, WheelZoom, zoomIn, zoomOut } from './zoom';
import { Translator } from './translator/translator';
import { ZoomBadge } from './zoom-badge/zoom-badge';
import { PasswordPrompt } from './password-prompt/password-prompt';
import { DownloadsMenu } from './downloads-menu/downloads-menu';
import { ExtensionsMenu } from './extensions-menu/extensions-menu';
import { FaviconStore } from './data/favicons';
import { HistoryStore } from './data/history';
import { FindBar } from './find-bar/find-bar';
import { NewTab } from './new-tab/new-tab';
import {
  PageAdBlockEvent,
  PageAudioEvent,
  PageBounds,
  PageDownloadEvent,
  PageFaviconEvent,
  PageFullscreenEvent,
  PageNavigationEvent,
  ReloadMode,
  PageLoadEvent,
  PageNewTabEvent,
  PageShortcutEvent,
  PageTitleEvent,
  PageViews,
} from './page-views/page-views';
import { BookmarksPage } from './pages/bookmarks-page/bookmarks-page';
import { DownloadsPage } from './pages/downloads-page/downloads-page';
import { ExtensionsPage } from './pages/extensions-page/extensions-page';
import { HelpPage } from './pages/help-page/help-page';
import { HistoryPage } from './pages/history-page/history-page';
import { NotesPage } from './pages/notes-page/notes-page';
import { PersonalizationPage } from './pages/personalization-page/personalization-page';
import { ProfilePage } from './pages/profile-page/profile-page';
import { PasswordsPage } from './pages/passwords-page/passwords-page';
import { InternalPage, TAB_PAGES, TabPage, hostname, internalPageFor } from './pages/internal-pages';
import { SettingsPage } from './pages/settings-page/settings-page';
import { ProfileMenu } from './profile-menu/profile-menu';
import { ReloadMenu } from './reload-menu/reload-menu';
import { SiteIcon } from './site-icon/site-icon';
import { SitePermissions } from './site-permissions/site-permissions';
import { ToolAction, ToolsMenu } from './tools-menu/tools-menu';

/** Стан вкладки із сайтом. */
interface Site {
  /** Мітка webview сайту. Нова для кожного webview: старий після «Назад» на внутрішню сторінку ще може закриватися. */
  readonly label: string;
  readonly url: string;
  /** Порожній, доки сайт не повідомив заголовок. */
  readonly title: string;
  readonly loading: boolean;
  /** Історію переходів веде сам WebView2 (page://navigation) — разом зі змінами адреси без перезавантаження. */
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Запис історії поточної адреси — йому оновлюємо назву, коли прийде заголовок. */
  readonly historyEntry?: { readonly id: string; readonly url: string };
  /** Сторінка зараз грає звук. */
  readonly playing: boolean;
  /** Звук вкладки вимкнено. */
  readonly muted: boolean;
  /** Скільки запитів блокувальник реклами відсік на поточній сторінці. */
  readonly blocked: number;
}

/** Закрита вкладка, яку можна відкрити знову (Ctrl+Shift+T): що в ній було і де вона стояла. */
interface ClosedTab {
  readonly page: TabPage | 'web';
  readonly url?: string;
  readonly index: number;
}

/** Скільки закритих вкладок пам'ятати. */
const CLOSED_TABS_LIMIT = 25;

/** Вкладка показує внутрішню сторінку або сайт (тоді page === 'web' і є site). */
interface BrowserTab {
  readonly id: number;
  readonly page: TabPage | 'web';
  readonly site?: Site;
  /** Внутрішня сторінка, з якої в цій вкладці перейшли на сайт: «Назад» з першої сторінки сайту повертає на неї. */
  readonly back?: TabPage;
  /** Сайт, з якого «Назад» повернув на внутрішню сторінку: «Вперед» відкриває його знову. */
  readonly forward?: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    BookmarkEditor,
    BookmarksBar,
    BookmarksPage,
    BrowserMenu,
    DownloadPrompt,
    DownloadsMenu,
    DownloadsPage,
    ExtensionsMenu,
    ExtensionsPage,
    FindBar,
    HelpPage,
    HistoryPage,
    MiddleClick,
    NewTab,
    NotesPage,
    PasswordPrompt,
    PasswordsPage,
    PersonalizationPage,
    ProfileMenu,
    ProfilePage,
    ReloadMenu,
    Screenshot,
    SettingsPage,
    SiteIcon,
    SitePermissions,
    TitlebarContent,
    ToolsMenu,
    Translator,
    UiIcon,
    UiInput,
    ZoomBadge,
  ],
  selector: 'app-browser',
  styleUrl: './browser.scss',
  templateUrl: './browser.html',
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class Browser {
  private readonly sync = inject(SyncService);
  private readonly windows = inject(BrowserWindows);
  /** Гостьове вікно: меню профілю гостя, без паролів власника. */
  protected readonly isGuest = this.windows.isGuest;
  private readonly pageViews = inject(PageViews);
  private readonly history = inject(HistoryStore);
  private readonly downloads = inject(DownloadsStore);
  private readonly passwords = inject(PasswordsStore);
  private readonly favicons = inject(FaviconStore);
  private readonly autoplay = inject(AutoplayStore);
  private readonly injector = inject(Injector);

  protected readonly settings = inject(SettingsStore);
  protected readonly bookmarks = inject(BookmarksStore);
  protected readonly pages = TAB_PAGES;

  protected readonly tabs = signal<readonly BrowserTab[]>([{ id: 1, page: 'new-tab' }]);

  protected readonly activeTabId = signal(1);
  /** Закриті вкладки цього вікна — для «Відновити закриту вкладку»; остання — в кінці. */
  protected readonly closedTabs = signal<readonly ClosedTab[]>([]);

  // Вкладок завжди щонайменше одна: closeTab замінює останню новою.
  protected readonly activeTab = computed(() => {
    const tabs = this.tabs();
    return tabs.find((tab) => tab.id === this.activeTabId()) ?? tabs[0];
  });

  /** Текст адресного рядка: адреса поточної вкладки, доки користувач не почав її редагувати. */
  protected readonly omniboxText = linkedSignal(() => this.tabUrl(this.activeTab()));

  /** На сторінці відео YouTube — кнопка «Картинка в картинці» в адресному рядку. */
  protected readonly canPictureInPicture = computed(() => {
    const site = this.activeTab().site;
    return !!site && isYouTubeVideo(site.url);
  });

  /** Закладка поточної сторінки — тоді зірочка в адресному рядку зафарбована. */
  protected readonly currentBookmark = computed(() => this.bookmarks.find(this.tabUrl(this.activeTab())));

  protected readonly canGoBack = computed(() => {
    const tab = this.activeTab();
    return !!tab.site && (tab.site.canGoBack || !!tab.back);
  });
  protected readonly canGoForward = computed(() => {
    const tab = this.activeTab();
    return tab.site ? tab.site.canGoForward : !!tab.forward;
  });

  /** Масштаб вмісту сторінки у відсотках; змінюється в головному меню. */
  protected readonly zoom = signal(DEFAULT_ZOOM);
  private readonly wheelZoom = new WheelZoom();

  /** Панель «Знайти на сторінці» шукає в поточній сторінці, тож закривається, щойно сторінка інша. */
  protected readonly findOpen = signal(false);
  private readonly findBar = viewChild(FindBar);
  private readonly omnibox = viewChild.required<UiInput>('omnibox');
  private readonly reloadMenu = viewChild.required(ReloadMenu);
  private readonly translator = viewChild.required(Translator);
  private readonly screenshot = viewChild.required(Screenshot);
  private readonly toolsButton = viewChild.required<ElementRef<HTMLElement>>('toolsButton');

  /** Сторінка у вкладці показується в перекладі Google — кнопка перекладу в адресному рядку акцентна. */
  protected readonly pageTranslated = computed(() => isTranslated(this.activeSiteUrl()));

  /** Адреса сайту в активній вкладці (порожня — у вкладці не сайт): для перекладача. */
  protected readonly activeSiteUrl = computed(() => {
    const tab = this.activeTab();
    return tab.page === 'web' ? (tab.site?.url ?? '') : '';
  });
  /** Утримання кнопки «Оновити»: за RELOAD_HOLD_MS відкривається меню, а відпущена кнопка вже не оновлює сторінку. */
  private reloadHold?: ReturnType<typeof setTimeout>;
  private reloadHeld = false;
  /** Webview сайту, для якого відкрито меню оновлення: його дії стосуються саме цього сайту. */
  private reloadMenuPage: string | null = null;

  /**
   * Відкрите модальне вікно (підтвердження, «Зберегти файл?»). Нативний webview сайту малюється поверх HTML
   * інтерфейсу й закрив би його разом із затемненням, тож поки вікно відкрите, сторінка тимчасово ховається.
   * Меню й панелі (popover) сайт не ховають: у ньому вирізається отвір під панель (updateClip).
   */
  private readonly overlayOpen = signal(false);
  /** Сайт, у якому зараз вирізано отвори під панелі. */
  private clippedPage: string | null = null;
  private clipFrame = 0;
  /** Панель змінила розмір — отвір під неї теж. */
  private readonly clipObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.scheduleClip());

  /** Webview сайту, який зараз має бути видно. */
  /** Webview сайту в активній вкладці: для нього панель дозволів сайту. */
  protected readonly activeSitePage = computed(() => {
    const tab = this.activeTab();
    return tab.page === 'web' && this.pageViews.available ? this.pageLabel(tab) : null;
  });

  private readonly visiblePage = computed(() => {
    const tab = this.activeTab();
    return tab.page === 'web' && !this.overlayOpen() ? this.pageLabel(tab) : null;
  });

  /**
   * Знімок сторінки на місці її webview, поки відкрита панель: сам webview малюється поверх HTML,
   * тож під панеллю його доводиться ховати, а сторінка при цьому не має зникати.
   */
  protected readonly pageCover = signal<{ readonly url: string; readonly width: number; readonly height: number } | null>(null);
  /** Номер останньої зміни панелей: відповідь на застарілий запит знімка відкидається. */
  private overlayChange = 0;

  /** Сайт, що показує відео на весь екран: його webview накриває все вікно разом із панелями. */
  private readonly fullscreenPage = signal<string | null>(null);
  /** Чи було вікно повноекранним ще до відео — тоді після виходу з відео таким і лишається. */
  private windowWasFullscreen = false;
  /**
   * Входи й виходи з повноекранного відео виконуються по черзі: сайт може надіслати «увійшов» і «вийшов»
   * швидше, ніж вікно встигне змінитися, і переплетені переходи лишили б вікно на весь екран без сторінки.
   */
  private fullscreenQueue = Promise.resolve();

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly windowLabel = isTauri() ? getCurrentWindow().label : 'web';
  private shownPage: string | null = null;
  private nextTabId = 2;
  /** Скільки webview сайтів уже створила кожна вкладка — для неповторних міток. */
  private readonly pagesCreated = new Map<number, number>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Дані облікового запису синхронізуються, поки відкритий браузер (веде одне вікно — browser/sync).
    this.sync.start();
    // Мова перекладу виділеного на сайтах — браузеру одразу, а не лише тоді, як відкриють «Перекладач».
    inject(TranslateLanguageStore);
    const injector = this.injector;

    // Меню оновлення — про сайт, на якому його відкрили: інша вкладка чи не сайт — закриваємо.
    effect(() => {
      this.activeSitePage();
      untracked(() => {
        clearTimeout(this.reloadHold);
        if (this.reloadMenu().isOpen()) {
          this.reloadMenu().hide();
        }
      });
    });

    // Як у Chrome: відкрили нову вкладку (чи перейшли на неї) — курсор в адресному рядку, можна одразу друкувати.
    const newTabShown = computed(() => (this.activeTab().page === 'new-tab' ? this.activeTab().id : null));
    effect(() => {
      if (newTabShown() !== null) {
        untracked(() => afterNextRender(() => this.omnibox().focus(), { injector }));
      }
    });

    const activePage = computed(() => `${this.activeTab().id}:${this.activeTab().page}:${this.activeTab().site?.url ?? ''}`);
    effect(() => {
      activePage();
      untracked(() => this.findOpen.set(false));
    });

    effect(() => {
      const label = this.visiblePage();
      untracked(() => {
        if (this.shownPage && this.shownPage !== label) {
          this.ignore(this.pageViews.setVisible(this.shownPage, false));
        }
        if (label) {
          this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
          this.ignore(this.pageViews.setVisible(label, true));
        }
        this.shownPage = label;
        // Інша сторінка — отвори під відкриті панелі тепер у ній.
        this.scheduleClip();
      });
    });

    // Інша вкладка чи відкрита панель — повноекранне відео попередньої сторінки згортається.
    effect(() => {
      const label = this.visiblePage();
      untracked(() =>
        this.queueFullscreen(async () => {
          if (this.fullscreenPage() && this.fullscreenPage() !== label) {
            await this.exitPageFullscreen();
          }
        })
      );
    });

    effect(() => {
      const scale = this.zoom() / 100;
      const label = this.visiblePage();
      if (label) {
        untracked(() => this.ignore(this.pageViews.setZoom(label, scale)));
      }
    });

    // Popover-и й вікна не спливають подій toggle, тож ловимо їх на фазі перехоплення.
    // beforetoggle приходить ще до першого кадру з модальним вікном: ховаємо його, поки сайт не знято (setPageCovering).
    const onBeforeToggle = (event: Event) => {
      if (
        event.target instanceof HTMLDialogElement &&
        (event as ToggleEvent).newState === 'open' &&
        !this.overlayOpen() &&
        this.activeTab().page === 'web' &&
        this.pageViews.available
      ) {
        this.setPageCovering(true);
      }
    };
    const onToggle = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && !(target instanceof HTMLDialogElement)) {
        if ((event as ToggleEvent).newState === 'open') {
          this.clipObserver?.observe(target);
        } else {
          this.clipObserver?.unobserve(target);
        }
        this.scheduleClip();
      }
      void this.onOverlayToggle();
    };
    // Клік по сайту — фокус іде в його webview, і HTML інтерфейсу кліку не бачить. Тоді відкриті меню закриваються
    // самі, як і від кліку повз них в інтерфейсі.
    const onBlur = () => {
      if (this.visiblePage()) {
        for (const popover of document.querySelectorAll<HTMLElement>(':popover-open')) {
          if (popover.getAttribute('popover') !== 'manual') {
            popover.hidePopover();
          }
        }
      }
    };
    document.addEventListener('beforetoggle', onBeforeToggle, true);
    document.addEventListener('toggle', onToggle, true);
    window.addEventListener('blur', onBlur);
    destroyRef.onDestroy(() => {
      document.removeEventListener('beforetoggle', onBeforeToggle, true);
      document.removeEventListener('toggle', onToggle, true);
      window.removeEventListener('blur', onBlur);
      this.clipObserver?.disconnect();
      cancelAnimationFrame(this.clipFrame);
      this.setPageCovering(false);
    });

    if (this.pageViews.available) {
      // Правила автовідтворення — у скрипти всіх сторінок вікна.
      effect(() => {
        const rules = this.autoplay.rules();
        untracked(() => this.ignore(this.pageViews.setAudioRules(rules)));
      });

      // Webview сайту лежить поверх області вмісту, тож іде за її розміром.
      afterNextRender(() => {
        const observer = new ResizeObserver(() => {
          const label = this.visiblePage();
          if (label) {
            this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
          }
          // Панелі прив'язані до кнопок вікна: інший розмір — і отвори під ними деінде.
          this.scheduleClip();
        });
        observer.observe(this.viewport().nativeElement);
        destroyRef.onDestroy(() => observer.disconnect());
      });

      const listeners = [
        this.pageViews.on('page://load', (event) => this.onPageLoad(event)),
        this.pageViews.on('page://navigation', (event) => this.onPageNavigation(event)),
        this.pageViews.on('page://title', (event) => this.onPageTitle(event)),
        this.pageViews.on('page://audio', (event) => this.onPageAudio(event)),
        this.pageViews.on('page://fullscreen', (event) => this.queueFullscreen(() => this.onPageFullscreen(event))),
        this.pageViews.on('page://favicon', (event) => this.onPageFavicon(event)),
        this.pageViews.on('page://new-tab', (event) => this.onPageNewTab(event)),
        this.pageViews.on('page://download', (event) => this.onPageDownload(event)),
        this.pageViews.on('page://download-prompt', (event) => this.downloads.ask(event)),
        this.pageViews.on('page://adblock', (event) => this.onPageAdBlock(event)),
        this.pageViews.on('page://shortcut', (event) => this.onPageShortcut(event)),
        this.pageViews.on('page://password-prompt', (event) => this.passwords.ask(event)),
        this.pageViews.on('page://passwords-manage', () => this.openPage('passwords')),
      ];
      destroyRef.onDestroy(() => {
        for (const listener of listeners) {
          void listener.then((unlisten) => unlisten());
        }
        // Вихід на сторінку входу: webview сайтів не мають пережити екран браузера.
        for (const tab of this.tabs()) {
          if (tab.site) {
            this.ignore(this.pageViews.close(tab.site.label));
          }
        }
      });
    }
  }

  protected tabTitle(tab: BrowserTab): string {
    return tab.site ? tab.site.title || hostname(tab.site.url) : TAB_PAGES[tab.page as TabPage].title;
  }

  protected tabFavicon(tab: BrowserTab): string {
    return TAB_PAGES[tab.page as TabPage].favicon;
  }

  protected tabUrl(tab: BrowserTab): string {
    return tab.site ? tab.site.url : TAB_PAGES[tab.page as TabPage].url;
  }

  protected selectTab(id: number): void {
    this.activeTabId.set(id);
  }

  /**
   * Ctrl+Tab — наступна вкладка, Ctrl+Shift+Tab — попередня (по колу, як у Chrome і Firefox).
   * Фокус іде за вкладкою: у сайт чи в інтерфейс, щоб і наступне натискання дійшло до браузера.
   */
  protected switchTab(step: 1 | -1): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === this.activeTab().id);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next.id === this.activeTab().id) {
      return;
    }
    this.activeTabId.set(next.id);
    if (!this.pageViews.available) {
      return;
    }
    // Після того як webview нової вкладки покажеться: прихований фокус не прийме.
    afterNextRender(
      () => this.ignore(next.page === 'web' ? this.pageViews.focus(this.pageLabel(next)) : this.pageViews.focusInterface()),
      { injector: this.injector }
    );
  }

  protected openNewTab(): void {
    const tab = this.createNewTab();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.activeTabId.set(tab.id);
  }

  protected closeTab(id: number): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const closed = tabs[index];
    const site = closed.site;
    if (site) {
      this.ignore(this.pageViews.close(site.label));
    }
    // Порожню нову вкладку відновлювати нема чого.
    if (closed.page !== 'new-tab') {
      this.closedTabs.update((list) => [...list, { page: closed.page, url: site?.url, index }].slice(-CLOSED_TABS_LIMIT));
    }

    const remaining = tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0) {
      const tab = this.createNewTab();
      this.tabs.set([tab]);
      this.activeTabId.set(tab.id);
      return;
    }

    this.tabs.set(remaining);
    if (id === this.activeTabId()) {
      // Як у Chrome: активною стає вкладка праворуч, а якщо її немає — ліворуч.
      this.activeTabId.set(remaining[Math.min(index, remaining.length - 1)].id);
    }
  }

  /** Відкриває знову останню закриту вкладку — на тому самому місці, з тим самим сайтом чи сторінкою. */
  protected reopenClosedTab(): void {
    const closed = this.closedTabs().at(-1);
    if (!closed) {
      return;
    }
    this.closedTabs.update((list) => list.slice(0, -1));
    const tab: BrowserTab = closed.url ? this.createNewTab() : { id: this.nextTabId++, page: closed.page };
    this.tabs.update((tabs) => [...tabs.slice(0, closed.index), tab, ...tabs.slice(closed.index)]);
    this.activeTabId.set(tab.id);
    if (closed.url) {
      this.openSite(closed.url, tab);
    }
  }

  /**
   * Відкриває введене в адресному рядку чи пошуку: astra://… — внутрішню сторінку, адресу — сайт,
   * будь-який інший текст — пошук в обраній у налаштуваннях пошуковій системі.
   */
  protected navigate(input: string): void {
    const text = input.trim();
    if (!text) {
      return;
    }

    const page = internalPageFor(text);
    if (page) {
      this.openPage(page);
      return;
    }

    this.openSite(normalizeUrl(text) ?? this.settings.searchUrl(text), this.activeTab(), { back: true });
  }

  protected onOmniboxKeydown(event: KeyboardEvent): void {
    // Кнопки всередині рядка (дозволи сайту, зірочка) обробляють Enter самі.
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.navigate(this.omniboxText());
      (event.target as HTMLElement).blur();
    } else if (event.key === 'Escape') {
      this.omniboxText.set(this.tabUrl(this.activeTab()));
    }
  }

  protected goBack(): void {
    const tab = this.activeTab();
    if (tab.site?.canGoBack) {
      this.ignore(this.pageViews.go(tab.site.label, -1));
    } else if (tab.site && tab.back) {
      // З першої сторінки сайту — на внутрішню сторінку, з якої на нього перейшли (як на нову вкладку в Chrome).
      this.ignore(this.pageViews.close(tab.site.label));
      this.replaceTab({ id: tab.id, page: tab.back, forward: tab.site.url });
    }
  }

  protected goForward(): void {
    const tab = this.activeTab();
    if (tab.site?.canGoForward) {
      this.ignore(this.pageViews.go(tab.site.label, 1));
    } else if (!tab.site && tab.forward) {
      this.openSite(tab.forward, tab, { back: true });
    }
  }

  protected reload(): void {
    const tab = this.activeTab();
    if (tab.site) {
      this.ignore(this.pageViews.reload(tab.site.label));
    }
  }

  protected togglePictureInPicture(): void {
    const tab = this.activeTab();
    if (tab.site && this.canPictureInPicture()) {
      this.ignore(this.pageViews.pictureInPicture(tab.site.label));
    }
  }

  /** Оновлення з меню кнопки: без кешу, з очищенням кешу, даних чи cookies сайту. */
  protected reloadWith(mode: ReloadMode): void {
    const tab = this.reloadMenuPage ? this.tabByLabel(this.reloadMenuPage) : undefined;
    if (tab?.site) {
      this.updateSite(tab.id, (site) => ({ ...site, loading: true }));
      this.ignore(this.pageViews.reloadWith(tab.site.label, mode));
    }
  }

  /**
   * Утримання кнопки «Оновити». Chromium надсилає події вказівника й неактивній кнопці,
   * тож без сайту у вкладці (нова вкладка, внутрішні сторінки) меню не відкривається.
   */
  protected startReloadHold(event: PointerEvent): void {
    if (event.button !== 0 || !this.activeTab().site) {
      return;
    }
    this.reloadHeld = false;
    clearTimeout(this.reloadHold);
    this.reloadHold = setTimeout(() => {
      this.reloadHeld = true;
      this.showReloadMenu();
    }, RELOAD_HOLD_MS);
  }

  protected cancelReloadHold(): void {
    clearTimeout(this.reloadHold);
  }

  /**
   * Кнопка пов'язана з меню через popovertarget — для доступності й щоб відпускання кнопки миші після
   * утримання не закрило щойно відкрите меню. Але клік має оновлювати сторінку, а не перемикати меню.
   */
  protected onReloadClick(event: MouseEvent): void {
    event.preventDefault();
    if (this.reloadHeld) {
      this.reloadHeld = false;
    } else if (this.reloadMenu().isOpen()) {
      this.reloadMenu().hide();
    } else {
      this.reload();
    }
  }

  /** Правий клік чи клавіша меню — те саме меню без утримання (теж лише на сайті). */
  protected openReloadMenu(event: MouseEvent): void {
    event.preventDefault();
    this.cancelReloadHold();
    this.showReloadMenu();
  }

  private showReloadMenu(): void {
    const site = this.activeTab().site;
    if (site) {
      this.reloadMenuPage = site.label;
      this.reloadMenu().show();
    }
  }

  /** Вимикає чи вмикає звук вкладки; значок оновиться з події page://audio. */
  protected toggleMute(tab: BrowserTab): void {
    if (tab.site) {
      this.ignore(this.pageViews.setMuted(this.pageLabel(tab), !tab.site.muted));
    }
  }

  /**
   * Подвійний клік по порожньому місцю вкладок і панелей розгортає чи відновлює вікно, як по заголовку.
   * Перетягувати вікно за них не можна — лише за порожні місця заголовка.
   */
  protected onChromeDoubleClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && !target.closest('button, a, input, textarea, select, label, app-input, [popover]')) {
      void this.windows.toggleMaximize();
    }
  }

  protected async toggleFullscreen(): Promise<void> {
    await this.windows.setFullscreen(!(await this.windows.isFullscreen()));
  }

  /**
   * Як у Chrome: якщо сторінка вже відкрита — перейти на її вкладку; якщо поточна вкладка порожня —
   * відкрити сторінку в ній; інакше — у новій вкладці.
   */
  protected openPage(page: InternalPage): void {
    const existing = this.tabs().find((tab) => tab.page === page);
    if (existing) {
      this.activeTabId.set(existing.id);
      return;
    }

    const active = this.activeTab();
    if (active.page === 'new-tab') {
      // Нова сторінка у вкладці — і «Вперед» на сайт, з якого повернулися, більше не має сенсу.
      this.replaceTab({ id: active.id, page });
      return;
    }

    const tab: BrowserTab = { id: this.nextTabId++, page };
    this.tabs.update((tabs) => [...tabs, tab]);
    this.activeTabId.set(tab.id);
  }

  /**
   * Посилання із закладок чи історії: внутрішня сторінка відкривається сама, сайт — у поточній вкладці
   * (і «Назад» повертає на сторінку, з якої перейшли).
   */
  protected openLink(url: string): void {
    const page = internalPageFor(url);
    if (page) {
      this.openPage(page);
    } else {
      this.openSite(url, this.activeTab(), { back: true });
    }
  }

  protected changeZoom(change: 'zoom-in' | 'zoom-out' | 'zoom-reset'): void {
    this.zoom.update((zoom) => (change === 'zoom-in' ? zoomIn(zoom) : change === 'zoom-out' ? zoomOut(zoom) : DEFAULT_ZOOM));
  }

  /** Ctrl + коліщатко над сторінкою браузера (нова вкладка, налаштування…); над сайтом — його скрипт (zoom-page.js). */
  protected onViewportWheel(event: WheelEvent): void {
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      this.zoom.update((zoom) => this.wheelZoom.apply(zoom, event.deltaY));
    }
  }

  /** Інструмент із панелі «Інструменти», що не є сторінкою. */
  protected runTool(action: ToolAction): void {
    if (action === 'translate') {
      this.translator().show(this.toolsButton().nativeElement);
      return;
    }
    const tab = this.activeTab();
    const site = tab.page === 'web' && tab.site && this.pageViews.available ? tab.site : null;
    void this.screenshot().start(site && { label: this.pageLabel(tab), bounds: this.pageBounds(), url: site.url });
  }

  /** Клік коліщатком: нова вкладка у фоні, як у звичайних браузерах. */
  protected openLinkInNewTab(url: string): void {
    const page = internalPageFor(url);
    if (page) {
      // Внутрішня сторінка має одну вкладку: вже відкрита — нова не потрібна.
      if (!this.tabs().some((tab) => tab.page === page)) {
        this.tabs.update((tabs) => [...tabs, { id: this.nextTabId++, page }]);
      }
      return;
    }

    const tab = this.createNewTab();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.openSite(url, tab, { background: true });
  }

  /** «Відкрити всі закладки» з панелі: кожна — у новій вкладці, а показується перша з них. */
  protected openAllBookmarks(bookmarks: readonly Bookmark[]): void {
    const firstNewTab = this.nextTabId;
    for (const bookmark of bookmarks) {
      this.openLinkInNewTab(bookmark.url);
    }
    const opened = this.tabs().find((tab) => tab.id >= firstNewTab);
    if (opened) {
      this.activeTabId.set(opened.id);
    }
  }

  protected openWindow(isPrivate = false): void {
    this.windows.open({ private: isPrivate });
  }

  /** Гостьове вікно — для когось іншого: нічого не зберігає й не бачить паролів власника. */
  protected openGuestWindow(): void {
    this.windows.open({ guest: true });
  }

  protected closeGuestWindow(): void {
    void this.windows.closeCurrent();
  }

  /** Повторне Ctrl+F при відкритій панелі лише повертає фокус у поле й виділяє запит. */
  protected openFind(): void {
    const findBar = this.findBar();
    if (findBar) {
      findBar.focus();
    } else {
      this.findOpen.set(true);
    }
  }

  /** Пошук на сайті — через window.find у його webview; збіги підсвічує сама сторінка. */
  protected readonly findOnPage = (query: string, backwards: boolean): Promise<boolean> =>
    this.pageViews.find(this.pageLabel(this.activeTab()), query, backwards);

  // Сайт друкує свій webview; внутрішні сторінки — стилі @media print у styles.scss.
  protected print(): void {
    const tab = this.activeTab();
    if (tab.page === 'web') {
      this.ignore(this.pageViews.print(this.pageLabel(tab)));
    } else {
      window.print();
    }
  }

  // event.code, а не key: з українською розкладкою клавіша T дає «е», а N — «т».
  // Коли фокус усередині сайту, клавіші отримує його webview, а не цей документ.
  protected onKeydown(event: KeyboardEvent): void {
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    switch ((event.shiftKey ? 'Shift+' : '') + event.code) {
      case 'KeyT':
        this.openNewTab();
        break;
      case 'Shift+KeyT':
        this.reopenClosedTab();
        break;
      case 'KeyN':
        this.openWindow();
        break;
      case 'Shift+KeyN':
        this.openWindow(true);
        break;
      case 'KeyJ':
        this.openPage('downloads');
        break;
      case 'KeyF':
        this.openFind();
        break;
      case 'KeyP':
        this.print();
        break;
      case 'Shift+BracketRight':
        this.togglePictureInPicture();
        break;
      case 'Shift+KeyS':
        this.runTool('screenshot');
        break;
      // Масштаб: Ctrl+= і Ctrl++ (і з Shift, і на цифровому блоці), Ctrl+−, Ctrl+0.
      case 'Equal':
      case 'Shift+Equal':
      case 'NumpadAdd':
        this.changeZoom('zoom-in');
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this.changeZoom('zoom-out');
        break;
      case 'Digit0':
      case 'Numpad0':
        this.changeZoom('zoom-reset');
        break;
      case 'Tab':
        this.switchTab(1);
        break;
      case 'Shift+Tab':
        this.switchTab(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /**
   * `background` — нова вкладка у фоні (клік коліщатком). `back` — перехід з внутрішньої сторінки цієї
   * вкладки, на яку потім можна повернутися «Назад» (з посилань у нових вкладках — ні, як у Chrome).
   */
  private openSite(url: string, tab: BrowserTab, { background = false, back = false } = {}): void {
    if (!this.pageViews.available) {
      // Поза Tauri вбудувати сайт нікуди — відкриваємо його звичайною вкладкою браузера.
      window.open(url, '_blank', 'noopener');
      return;
    }

    if (tab.site) {
      this.updateSite(tab.id, (site) => ({ ...site, url, loading: true }));
      this.ignore(this.pageViews.navigate(tab.site.label, url));
      return;
    }

    const label = this.newPageLabel(tab);
    const site: Site = {
      label,
      url,
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      playing: false,
      muted: false,
      blocked: 0,
    };
    this.replaceTab({ id: tab.id, page: 'web', site, back: back && tab.page !== 'web' ? tab.page : undefined });
    const autoplay = this.autoplay.rules();
    if (background) {
      // Справжні межі фонова вкладка отримає, коли її відкриють. Якщо відкрили ще до того, як її webview створився
      // («Відкрити всі закладки» одразу показує першу), показ тоді нікуди не дійшов — показуємо, щойно створився.
      this.pageViews
        .open(label, url, { x: 0, y: 0, width: 0, height: 0 }, { background, autoplay })
        .then(() => {
          if (this.visiblePage() === label) {
            this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
            this.ignore(this.pageViews.setVisible(label, true));
            this.scheduleClip();
          }
        })
        .catch(() => undefined);
      return;
    }
    this.activeTabId.set(tab.id);
    this.ignore(this.pageViews.open(label, url, this.pageBounds(), { autoplay }));
  }

  private onPageLoad({ label, url, loading }: PageLoadEvent): void {
    const tab = this.tabByLabel(label);
    // Порожній документ нового webview, поки сайт ще не відкрився, — не сайт.
    if (tab?.site && /^https?:/i.test(url)) {
      this.updateSite(tab.id, (site) => ({ ...site, url, loading }));
    }
  }

  /** Нова адреса (і без перезавантаження) — запис в історії; «Назад» і «Вперед» — як каже WebView2. */
  private onPageNavigation({ label, url, canGoBack, canGoForward }: PageNavigationEvent): void {
    const tab = this.tabByLabel(label);
    // Початкова about:blank нового webview, поки він ще не перейшов на сайт, — не перехід користувача.
    if (!tab?.site || !/^https?:/i.test(url)) {
      return;
    }

    this.updateSite(tab.id, (site) => {
      // У приватному вікні історія не ведеться; та сама адреса (оновлення, зміна лише історії) не дублює запис.
      if (this.windows.isPrivate || site.historyEntry?.url === url) {
        return { ...site, url, canGoBack, canGoForward };
      }
      const id = this.history.record(url, site.title || hostname(url));
      return { ...site, url, canGoBack, canGoForward, historyEntry: { id, url } };
    });
  }

  private onPageTitle({ label, title }: PageTitleEvent): void {
    const tab = this.tabByLabel(label);
    if (!tab?.site) {
      return;
    }

    this.updateSite(tab.id, (site) => ({ ...site, title }));
    const entry = tab.site.historyEntry;
    if (entry && entry.url === tab.site.url && title) {
      this.history.rename(entry.id, title);
    }
  }

  private onPageAdBlock({ label, blocked }: PageAdBlockEvent): void {
    const tab = this.tabByLabel(label);
    if (tab?.site && tab.site.blocked !== blocked) {
      this.updateSite(tab.id, (site) => ({ ...site, blocked }));
    }
  }

  /** Гаряча клавіша з сайту — лише з того, що зараз показаний. */
  private onPageShortcut({ label, shortcut }: PageShortcutEvent): void {
    if (label !== this.visiblePage()) {
      return;
    }
    switch (shortcut) {
      case 'screenshot':
        this.runTool('screenshot');
        break;
      case 'reopen-tab':
        this.reopenClosedTab();
        break;
      case 'zoom-in':
      case 'zoom-out':
      case 'zoom-reset':
        this.changeZoom(shortcut);
        break;
      default:
        this.switchTab(shortcut === 'next-tab' ? 1 : -1);
    }
  }

  private onPageAudio({ label, playing, muted }: PageAudioEvent): void {
    const tab = this.tabByLabel(label);
    if (tab?.site) {
      this.updateSite(tab.id, (site) => ({ ...site, playing, muted }));
    }
  }

  /** Відео на весь екран: вікно стає повноекранним, а webview сайту накриває його повністю. */
  private async onPageFullscreen({ label, fullscreen }: PageFullscreenEvent): Promise<void> {
    if (!fullscreen) {
      if (label === this.fullscreenPage()) {
        await this.exitPageFullscreen();
      }
      return;
    }
    if (label !== this.visiblePage() || label === this.fullscreenPage()) {
      return;
    }

    this.windowWasFullscreen = await this.windows.isFullscreen();
    this.fullscreenPage.set(label);
    await this.windows.setFullscreen(true);
    // Якщо вікно вже було на весь екран, розмір не зміниться, тож межі — одразу.
    this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
  }

  /**
   * Відкрилося чи закрилося модальне вікно. Перед тим як сховати сайт під ним, знімаємо його
   * й кладемо знімок на те саме місце; після закриття знімок зникає, щойно webview знову на місці.
   */
  private async onOverlayToggle(): Promise<void> {
    const open = !!document.querySelector('dialog:modal');
    const change = ++this.overlayChange;

    if (!open) {
      this.setPageCovering(false);
      // Сайт повертається, коли панель уже згасла: інакше webview обірвав би її анімацію.
      await delay(POPOVER_MOTION_MS);
      if (change === this.overlayChange) {
        this.overlayOpen.set(false);
        // А знімок прибираємо, коли webview точно знову на місці.
        await delay(150);
        if (change === this.overlayChange) {
          this.setPageCover(null);
        }
      }
      return;
    }
    if (this.overlayOpen()) {
      return;
    }

    const tab = this.activeTab();
    if (tab.page === 'web' && this.pageViews.available) {
      this.setPageCovering(true);
      const bounds = this.pageBounds();
      const image = await Promise.race([
        this.pageViews.capture(this.pageLabel(tab)).catch(() => null),
        delay(400).then(() => null),
      ]);
      if (image && change === this.overlayChange) {
        const url = URL.createObjectURL(new Blob([image], { type: 'image/jpeg' }));
        // Знімок має бути вже розкодований і намальований, коли webview зникне, — інакше блимне порожнеча.
        await decodeImage(url);
        this.setPageCover({ url, width: Math.round(bounds.width), height: Math.round(bounds.height) });
        await nextFrame();
        await nextFrame();
      }
      if (change !== this.overlayChange) {
        return;
      }
    }
    this.overlayOpen.set(true);
    this.setPageCovering(false);
  }

  /** Отвори оновлюються раз на кадр: панель, що з'являється, змінюється кілька разів поспіль. */
  private scheduleClip(): void {
    cancelAnimationFrame(this.clipFrame);
    this.clipFrame = requestAnimationFrame(() => this.updateClip());
  }

  /**
   * Меню й панелі над сайтом: сайт не ховається (відео грає далі), а в його webview вирізаються отвори точно під
   * відкриті панелі — крізь них і видно панель. Розміри — без анімації появи (offset*), тобто такі, як після неї.
   */
  private updateClip(): void {
    const label = this.visiblePage();
    if (this.clippedPage && this.clippedPage !== label) {
      this.ignore(this.pageViews.setClip(this.clippedPage, []));
      this.clippedPage = null;
    }
    if (!label) {
      return;
    }
    const bounds = this.pageBounds();
    const holes = [...document.querySelectorAll<HTMLElement>(':popover-open')]
      .map((popover) => ({
        x: popover.offsetLeft - bounds.x,
        y: popover.offsetTop - bounds.y,
        width: popover.offsetWidth,
        height: popover.offsetHeight,
        radius: parseFloat(getComputedStyle(popover).borderTopLeftRadius) || 0,
      }))
      .filter((hole) => hole.x < bounds.width && hole.y < bounds.height && hole.x + hole.width > 0 && hole.y + hole.height > 0);
    if (holes.length || this.clippedPage === label) {
      this.ignore(this.pageViews.setClip(label, holes));
      this.clippedPage = holes.length ? label : null;
    }
  }

  /**
   * Поки сайт знімається, модальне вікно невидиме (клас page-covering на <html>, styles.scss): інакше його
   * частину над сайтом на мить закривав би його webview. Клас ставиться одразу, а не через effect —
   * той спрацьовує вже після кадру, і панель встигала б показатися, зникнути й показатися знову.
   */
  private setPageCovering(covering: boolean): void {
    document.documentElement.classList.toggle('page-covering', covering);
  }

  private setPageCover(cover: { url: string; width: number; height: number } | null): void {
    const previous = this.pageCover();
    if (previous) {
      URL.revokeObjectURL(previous.url);
    }
    this.pageCover.set(cover);
  }

  private queueFullscreen(change: () => Promise<void>): void {
    this.fullscreenQueue = this.fullscreenQueue.then(change).catch(() => undefined);
  }

  private async exitPageFullscreen(): Promise<void> {
    const label = this.fullscreenPage();
    this.fullscreenPage.set(null);
    if (!this.windowWasFullscreen) {
      await this.windows.setFullscreen(false);
    }
    if (label) {
      this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
    }
  }

  private onPageFavicon({ label, url, icon }: PageFaviconEvent): void {
    if (this.tabByLabel(label)) {
      this.favicons.remember(url, icon);
    }
  }

  private onPageNewTab({ label, url }: PageNewTabEvent): void {
    if (!this.tabByLabel(label)) {
      return;
    }
    const tab = this.createNewTab();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.openSite(url, tab);
  }

  /** Завантаження записується, навіть коли вкладку вже закрито, — сам файл однаково зберігається. */
  private onPageDownload(event: PageDownloadEvent): void {
    this.downloads.track(event);
    // Перехід, що виявився файлом, сторінки не відкриває — вкладка вже не вантажиться.
    const tab = this.tabByLabel(event.label);
    if (tab?.site?.loading && event.state === 'in-progress') {
      this.updateSite(tab.id, (site) => ({ ...site, loading: false }));
    }
  }

  private updateSite(tabId: number, update: (site: Site) => Site): void {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === tabId && tab.site ? { ...tab, site: update(tab.site) } : tab)));
  }

  private tabByLabel(label: string): BrowserTab | undefined {
    return this.tabs().find((tab) => tab.site?.label === label);
  }

  /** Мітка webview сайту вкладки (порожня, якщо вкладка зараз не на сайті). */
  private pageLabel(tab: BrowserTab): string {
    return tab.site?.label ?? '';
  }

  /** Мітка для нового webview вкладки: унікальна в застосунку (є мітка вікна) і не повторює попередні цієї вкладки. */
  private newPageLabel(tab: BrowserTab): string {
    const created = this.pagesCreated.get(tab.id) ?? 0;
    this.pagesCreated.set(tab.id, created + 1);
    const label = `page-${this.windowLabel}-${tab.id}`;
    return created ? `${label}-${created + 1}` : label;
  }

  private replaceTab(tab: BrowserTab): void {
    this.tabs.update((tabs) => tabs.map((item) => (item.id === tab.id ? tab : item)));
  }

  /** Область вмісту в координатах вікна, без смуги пошуку на сторінці (padding-top). */
  private pageBounds(): PageBounds {
    if (this.fullscreenPage()) {
      return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const viewport = this.viewport().nativeElement;
    const rect = viewport.getBoundingClientRect();
    const top = parseFloat(getComputedStyle(viewport).paddingTop) || 0;
    return { x: rect.left, y: rect.top + top, width: rect.width, height: Math.max(rect.height - top, 0) };
  }

  /** Показ, межі й масштаб — ідемпотентні: якщо webview ще створюється чи вже закритий, пропускаємо. */
  private ignore(result: Promise<unknown>): void {
    result.catch(() => undefined);
  }

  private createNewTab(): BrowserTab {
    return { id: this.nextTabId++, page: 'new-tab' };
  }
}

/** Тривалість появи й зникнення панелей ($motion у _mixins.scss). */
const POPOVER_MOTION_MS = 180;

/** Сторінка відео на YouTube (зокрема Shorts, трансляції й вбудований плеєр). */
function isYouTubeVideo(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return /(^|\.)youtube\.com$/.test(hostname) && /^\/(watch|shorts\/|live\/|embed\/)/.test(pathname);
  } catch {
    return false;
  }
}

/** Скільки тримати кнопку «Оновити», щоб відкрилося меню оновлення. */
const RELOAD_HOLD_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    // Не розкодувався — покажемо як є, браузер домалює.
  }
}
