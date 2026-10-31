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
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { AuthStore } from '../shared/auth/auth';
import { BrowserWindows, isNormalWindow } from '../shared/browser-windows/browser-windows';
import { normalizeAddress } from '../shared/form-field/form-field';
import { MiddleClick } from '../shared/middle-click/middle-click';
import { SEARCH_ENGINES, SettingsStore } from '../shared/settings/settings';
import { UiIcon } from '../shared/ui-icon/ui-icon';
import { UiInput } from '../shared/ui-input/ui-input';
import { TitlebarContent } from '../shared/titlebar/titlebar-content';
import { BookmarksBar } from './bookmarks-bar/bookmarks-bar';
import { BrowserMenu } from './browser-menu/browser-menu';
import { BookmarkEditor } from './bookmark-editor/bookmark-editor';
import { Bookmark, BookmarksStore } from './data/bookmarks';
import { AutoplayStore } from './data/autoplay';
import { DownloadsStore } from './data/downloads';
import { ExternalAppsStore, schemeOf } from './data/external-apps';
import { AddressesStore } from './data/addresses';
import { CardsStore } from './data/cards';
import { PasswordsStore } from './data/passwords';
import { BlockedTracker, TrackingStore } from './data/tracking';
import { DownloadPrompt } from './download-prompt/download-prompt';
import { Screenshot } from './screenshot/screenshot';
import { isTranslated } from './translator/translate-urls';
import { SyncService } from './sync/sync';
import { TranslateLanguageStore } from './translator/translate-language';
import { DEFAULT_ZOOM, WheelZoom, zoomIn, zoomOut } from './zoom';
import { Translator } from './translator/translator';
import { ZoomBadge } from './zoom-badge/zoom-badge';
import { PasswordPrompt } from './password-prompt/password-prompt';
import { AddressPrompt } from './address-prompt/address-prompt';
import { CardPrompt } from './card-prompt/card-prompt';
import { AutofillPopup } from './autofill-popup/autofill-popup';
import { DownloadsMenu } from './downloads-menu/downloads-menu';
import { ExtensionsMenu } from './extensions-menu/extensions-menu';
import { FaviconStore } from './data/favicons';
import { HistoryStore } from './data/history';
import { FindBar } from './find-bar/find-bar';
import { NewTab } from './new-tab/new-tab';
import {
  AppOpenEvent,
  PageAdBlockEvent,
  PageExternalEvent,
  PageCrashedEvent,
  PageFailure,
  PagePermissionEvent,
  PageContextEvent,
  PageTrackersEvent,
  PageAudioEvent,
  PageMediaEvent,
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
  PageAutofillEvent,
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
import { AddressesPage } from './pages/addresses-page/addresses-page';
import { CardsPage } from './pages/cards-page/cards-page';
import {
  InternalPage,
  TAB_PAGES,
  TabPage,
  hostname,
  internalPageFor,
  isOpenableUrl,
  isPageUrl,
  viewSourceUrl,
} from './pages/internal-pages';
import { SettingsPage } from './pages/settings-page/settings-page';
import { PageCrashed } from './page-crashed/page-crashed';
import { ProfileMenu } from './profile-menu/profile-menu';
import { ReloadMenu } from './reload-menu/reload-menu';
import { SiteIcon } from './site-icon/site-icon';
import { ExternalPrompt } from './external-prompt/external-prompt';
import { PermissionPrompt } from './permission-prompt/permission-prompt';
import { TabMenu, TabMenuAction, TabMenuTarget } from './tab-menu/tab-menu';
import { PopupBlocked } from './popup-blocked/popup-blocked';
import { PermissionsStore } from './data/permissions';
import { UpdateStore } from './data/updates';
import { LaunchLinks } from './launch/launch-links';
import { translatePageUrl, translateTextUrl } from './translator/translate-urls';
import { SavedSession, SavedTab, SessionStore } from './session/session';
import { OmniboxSuggestions, SUGGESTIONS_ID, suggestionId } from './omnibox/omnibox-suggestions';
import { Suggestion, inlineCompletion, localSuggestions, withSearchSuggestions } from './omnibox/suggestions';
import { SitePermissions } from './site-permissions/site-permissions';
import { TrackingPanel } from './tracking-panel/tracking-panel';
import { ToolAction, ToolsMenu } from './tools-menu/tools-menu';
import { translate, TranslatePipe } from '../shared/i18n/i18n';
import { IS_LINUX } from '../shared/platform/platform';

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
  /**
   * Значок звуку у вкладці: поки сторінка грає звук і ще AUDIBLE_HOLD_MS після того, як він затих, — тож короткі паузи
   * (у трансляції, між треками) значок не ховають, а зупинене відео ховає.
   */
  readonly audible: boolean;
  /** Звук вкладки вимкнено. */
  readonly muted: boolean;
  /**
   * На сторінці грає відео чи аудіо зі звуком (server/src/media-page.js): не на паузі, і звук у плеєрі не вимкнено.
   * Така вкладка не засинає, хоч би як довго на відео було тихо, — поки її звук не вимкнули.
   */
  readonly mediaPlaying?: boolean;
  /** Скільки запитів блокувальник реклами відсік на поточній сторінці. */
  readonly blocked: number;
  /** Елементи стеження, які захист від стеження заблокував на поточній сторінці. */
  readonly trackers: readonly BlockedTracker[];
  /** Процес сторінки впав чи не відповідає — замість неї екран «Сторінка аварійно завершила роботу». */
  readonly crashed?: PageFailure;
  /** Фонову вкладку приспано, щоб звільнити пам'ять (прокинеться, щойно її відкриють). */
  readonly sleeping?: boolean;
  /** Спливні вікна, які сторінка хотіла відкрити без кліку користувача. */
  readonly blockedPopups?: readonly string[];
  /**
   * Вкладку відновлено з минулого запуску, а сайт ще не завантажено: webview створиться, щойно вкладку відкриють
   * (як у Chrome й Edge — інакше десяток вкладок одразу забрав би десяток webview).
   */
  readonly pending?: boolean;
}

/** Закрита вкладка, яку можна відкрити знову (Ctrl+Shift+T): що в ній було і де вона стояла. */
interface ClosedTab {
  readonly page: TabPage | 'web';
  readonly url?: string;
  readonly index: number;
}

/** Скільки закритих вкладок пам'ятати. */
const CLOSED_TABS_LIMIT = 25;
/** Скільки значок звуку лишається у вкладці, коли звук затих (Site.audible). */
export const AUDIBLE_HOLD_MS = 4000;

/** Вкладка показує внутрішню сторінку або сайт (тоді page === 'web' і є site). */
interface BrowserTab {
  readonly id: number;
  readonly page: TabPage | 'web';
  readonly site?: Site;
  /** Закріплена: завжди ліворуч, лише значок, без кнопки «Закрити». */
  readonly pinned?: boolean;
  /** Внутрішня сторінка, з якої в цій вкладці перейшли на сайт: «Назад» з першої сторінки сайту повертає на неї. */
  readonly back?: TabPage;
  /** Сайт, з якого «Назад» повернув на внутрішню сторінку: «Вперед» відкриває його знову. */
  readonly forward?: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslatePipe,
    BookmarkEditor,
    BookmarksBar,
    BookmarksPage,
    BrowserMenu,
    DownloadPrompt,
    DownloadsMenu,
    DownloadsPage,
    ExtensionsMenu,
    ExtensionsPage,
    ExternalPrompt,
    PermissionPrompt,
    PopupBlocked,
    TabMenu,
    FindBar,
    HelpPage,
    HistoryPage,
    MiddleClick,
    NewTab,
    NotesPage,
    OmniboxSuggestions,
    PasswordPrompt,
    PasswordsPage,
    AddressesPage,
    AddressPrompt,
    CardPrompt,
    CardsPage,
    AutofillPopup,
    PersonalizationPage,
    PageCrashed,
    ProfileMenu,
    ProfilePage,
    ReloadMenu,
    Screenshot,
    SettingsPage,
    SiteIcon,
    SitePermissions,
    TrackingPanel,
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
    // Вкладку скидають будь-де в заголовку вікна, не лише над смугою вкладок (onTabStripDragOver).
    '(document:dragover)': 'onTabStripDragOver($event)',
    '(document:dragleave)': 'onTabStripDragLeave($event)',
    '(document:drop)': 'onTabStripDrop($event)',
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
  private readonly addresses = inject(AddressesStore);
  private readonly cards = inject(CardsStore);
  /** Збережені адреси над полем форми на сайті (server/src/addresses.rs). */
  private readonly autofillPopup = viewChild(AutofillPopup);
  private readonly favicons = inject(FaviconStore);
  private readonly autoplay = inject(AutoplayStore);
  private readonly tracking = inject(TrackingStore);
  private readonly externalApps = inject(ExternalAppsStore);
  private readonly permissions = inject(PermissionsStore);
  private readonly launchLinks = inject(LaunchLinks);
  /** Оновлення застосунку: кнопка меню привертає увагу, поки нову версію ще не бачили в меню. */
  protected readonly updates = inject(UpdateStore);
  private readonly translateLanguage = inject(TranslateLanguageStore);
  /** Адресний рядок як елемент — під ним запитання дозволів сайтів. */
  protected readonly omniboxHost = viewChild('omnibox', { read: ElementRef });
  /** Коли фонову сторінку (мітка webview) востаннє бачили — від цього вона засинає. */
  private readonly lastSeen = new Map<string, number>();
  /** Фонові сторінки (мітки), що вже в режимі малої пам'яті WebView2 (sleepInactiveTabs). */
  private readonly lowMemory = new Set<string>();
  /** Остання вкладка, відкрита з сайту вкладки `opener` (insertRelated): наступна з неї ж стане за нею. */
  private related: { opener: number; last: number } | null = null;
  /** Сторінки (мітки), чий звук затих: значок зникне, якщо звук не повернеться (AUDIBLE_HOLD_MS). */
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Щойно натиснуто Tab (без Shift) в інтерфейсі: фокус іде вперед, а не повернувся з сайту (enterPage). */
  private tabbingForward = false;
  /** Сторінка, що зараз на передньому плані (у пам'яті як звичайна). */
  private foregroundPage: string | null = null;
  /** Вкладка, для якої відкрито меню вкладки. */
  private readonly menuTabId = signal<number | null>(null);
  protected readonly menuTarget = computed<TabMenuTarget>(() => {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === this.menuTabId());
    const tab = tabs[index];
    return {
      pinned: !!tab?.pinned,
      site: !!tab?.site,
      muted: !!tab?.site?.muted,
      others: tabs.length > 1,
      right: index >= 0 && tabs.slice(index + 1).some((other) => !other.pinned),
    };
  });
  private readonly tabMenu = viewChild.required(TabMenu);
  /** Вкладка, яку зараз перетягують з цього вікна, і чи її вже прийняло саме це вікно. */
  private draggedTab: number | null = null;
  private droppedHere = false;
  /** Куди стане перетягнута вкладка (перед якою за номером) — там видно риску. */
  protected readonly dropIndex = signal<number | null>(null);
  private readonly session = inject(SessionStore);
  private readonly auth = inject(AuthStore);
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

  /** Підказки під адресним рядком: відкриті, поки в ньому друкують. */
  protected readonly suggestionsOpen = signal(false);
  /** Що надрукував сам користувач — без автодоповнення й без підказки, на яку перейшли стрілками. */
  private readonly typed = signal('');
  /** Підказка, на яку перейшли стрілками (її текст тоді в рядку); -1 — надруковане. */
  protected readonly selectedSuggestion = signal(-1);
  /** Підказки пошукової системи — для якого саме запиту вони прийшли. */
  private readonly remoteSuggestions = signal<{ readonly query: string; readonly items: readonly string[] }>({
    query: '',
    items: [],
  });
  /** Автодоповнення в рядку: який текст дописано й куди він веде. */
  private inline: { readonly text: string; readonly url: string } | null = null;
  private readonly localSuggestions = computed(() => {
    if (!this.suggestionsOpen()) {
      return [];
    }
    const active = this.activeTab();
    return localSuggestions(this.typed(), {
      history: this.history.entries(),
      bookmarks: this.bookmarks.entries(),
      tabs: this.tabs()
        .filter((tab) => tab.id !== active.id && tab.site)
        .map((tab) => ({ id: tab.id, title: this.tabTitle(tab), url: this.tabUrl(tab) })),
      engine: SEARCH_ENGINES[this.settings.searchEngine()].label,
    });
  });
  protected readonly suggestions = computed<readonly Suggestion[]>(() => {
    const local = this.localSuggestions();
    const remote = this.remoteSuggestions();
    return remote.query && remote.query === this.typed()
      ? withSearchSuggestions(this.typed(), local, remote.items, SEARCH_ENGINES[this.settings.searchEngine()].label)
      : local;
  });
  protected readonly omniboxCombobox = computed(() => ({
    controls: SUGGESTIONS_ID,
    expanded: this.suggestionsOpen() && this.suggestions().length > 0,
    active: this.selectedSuggestion() >= 0 ? suggestionId(this.selectedSuggestion()) : null,
  }));

  /** На сторінці відео YouTube — кнопка «Картинка в картинці» в адресному рядку (WebKitGTK у Linux її не вміє). */
  protected readonly canPictureInPicture = computed(() => {
    const site = this.activeTab().site;
    return !IS_LINUX && !!site && isYouTubeVideo(site.url);
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
   * Сайт — окреме вікно під інтерфейсом, а інтерфейс над ним прозорий (клас site-visible на <html>, styles.scss): меню,
   * вікна й тіні малюються просто над живою сторінкою. Мишу ж WebView2 інтерфейсу ловить на всій своїй площі, тож із
   * його регіону вирізається сторінка — над нею лишаються лише панелі (updateInputRegion).
   */
  private siteUnder: string | null = null;
  /** Покази сайтів — по черзі: кожен чекає, доки попередній справді з'явиться чи сховається. */
  private pageShow = Promise.resolve();
  private regionFrame = 0;
  /** Що востаннє надіслано: той самий регіон удруге не надсилається. */
  private sentRegion = '';
  /**
   * Панелі й вікна, що згасають після закриття, і місце, яке вони займали (null — усе вікно: модальне вікно). Доки вони
   * згасають, це місце лишається в регіоні — інакше їхню частину над сайтом обрізало б одразу.
   */
  private readonly closingLayers = new Map<
    HTMLElement,
    { readonly area: PageBounds | null; readonly timer: ReturnType<typeof setTimeout> }
  >();
  /** Панель змінила розмір — регіон теж. */
  private readonly layerObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.scheduleInputRegion());

  /** Webview сайту в активній вкладці: для нього панель дозволів сайту. */
  protected readonly activeSitePage = computed(() => {
    const tab = this.activeTab();
    return tab.page === 'web' && this.pageViews.available ? this.pageLabel(tab) : null;
  });
  /** Сайт вкладки захищено від стеження — щит в адресному рядку. */
  protected readonly siteProtected = computed(() => this.tracking.protects(this.tabUrl(this.activeTab())));

  /** Webview сайту, який зараз має бути видно. */
  protected readonly visiblePage = computed(() => {
    const tab = this.activeTab();
    // Сторінка, що впала чи не відповідає, ховається — на її місці екран з кнопкою «Перезавантажити».
    return tab.page === 'web' && !tab.site?.crashed ? this.pageLabel(tab) : null;
  });

  /**
   * Сайт, що показує відео на весь екран: його webview накриває все вікно разом із панелями. Вікно й webview для
   * цього змінює Rust (server/src/fullscreen.rs), а межі сайту тримає, доки відео на весь екран.
   */
  private readonly fullscreenPage = signal<string | null>(null);
  /** Входи й виходи з повноекранного відео — по черзі: сайт може надіслати «увійшов» і «вийшов» одне за одним. */
  private fullscreenQueue = Promise.resolve();

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly windowLabel = isTauri() ? getCurrentWindow().label : 'web';
  /** Звичайне вікно застосунку: його вкладки зберігаються й відновлюються (SessionStore); приватне й гостьове — ні. */
  private readonly keepsSession = this.pageViews.available && !this.windows.isPrivate && !this.windows.isGuest;
  private shownPage: string | null = null;
  private nextTabId = 2;
  /** Скільки webview сайтів уже створила кожна вкладка — для неповторних міток. */
  private readonly pagesCreated = new Map<number, number>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Дані облікового запису синхронізуються, поки відкритий браузер (веде одне вікно — browser/sync).
    this.sync.start();
    const injector = this.injector;
    this.restoreSession();
    this.openRequestedUrl();
    // Посилання з інших програм і повторний запуск — сюди (і ті, що чекали, поки вікно було на сторінці входу).
    destroyRef.onDestroy(this.launchLinks.attach((event) => this.onAppOpen(event)));
    // Браузер запустили посиланням з іншої програми — воно відкривається після відновлених вкладок.
    if (this.windowLabel === 'main' || !isTauri()) {
      this.ignore(this.pageViews.launchUrls().then((urls) => this.openLinks(urls)));
    }

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
      untracked(() => {
        this.findOpen.set(false);
        this.closeSuggestions();
      });
    });

    // Підказки пошукової системи — коли друкувати перестали на 150 мс (не на кожну літеру).
    effect((onCleanup) => {
      const query = this.typed();
      const engine = this.settings.searchEngine();
      if (
        !this.suggestionsOpen() ||
        !this.pageViews.available ||
        !this.settings.searchSuggestions() ||
        !query.trim() ||
        /^[a-z][a-z\d+.-]*:\/\//i.test(query.trim())
      ) {
        return;
      }
      const timer = setTimeout(() => {
        this.pageViews
          .searchSuggestions(engine, query)
          .then((items) => {
            if (this.typed() === query) {
              this.remoteSuggestions.set({ query, items });
            }
          })
          .catch(() => undefined);
      }, 150);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const label = this.visiblePage();
      untracked(() => this.queuePageShow(label));
    });

    // Інша вкладка — повноекранне відео попередньої сторінки згортається.
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

    // Popover-и й вікна не спливають подій toggle, тож ловимо їх на фазі перехоплення. beforetoggle приходить, поки шар
    // ще відкритий: тоді й запам'ятовуємо його місце, щоб тримати його в регіоні, доки шар згасає.
    const onBeforeToggle = (event: Event) => {
      if (event.target instanceof HTMLElement) {
        if ((event as ToggleEvent).newState === 'open') {
          this.forgetClosing(event.target);
        } else {
          this.keepWhileClosing(event.target);
        }
      }
    };
    const onToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if ((event as ToggleEvent).newState === 'open') {
        this.layerObserver?.observe(target);
        // Модальне вікно над повноекранним відео: відео згортається, бо вікно лягає на весь інтерфейс.
        if (target instanceof HTMLDialogElement && target.matches(':modal') && this.fullscreenPage()) {
          this.queueFullscreen(() => this.exitPageFullscreen());
        }
      } else {
        this.layerObserver?.unobserve(target);
      }
      // Одразу, а не наступним кадром: що раніше панель потрапить у регіон, то раніше її видно над сайтом.
      void this.updateInputRegion();
    };
    // Панель з'являється, трохи зменшена й вище за своє місце (transform), тож одразу після відкриття її виміряно меншою.
    // Розміру вона потім не змінює, і ResizeObserver мовчить — тож ще раз, коли з'явилася: у Linux поза регіоном
    // інтерфейс не малюється (server/src/gtk_layers.rs), і низ панелі лишався б обрізаним.
    const onSettled = (event: TransitionEvent) => {
      if (
        event.propertyName === 'transform' &&
        event.target instanceof Element &&
        event.target.matches(':popover-open, dialog[open]')
      ) {
        this.scheduleInputRegion();
      }
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
    document.addEventListener('transitionend', onSettled, true);
    window.addEventListener('blur', onBlur);
    destroyRef.onDestroy(() => {
      document.removeEventListener('beforetoggle', onBeforeToggle, true);
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('transitionend', onSettled, true);
      window.removeEventListener('blur', onBlur);
      this.layerObserver?.disconnect();
      cancelAnimationFrame(this.regionFrame);
      this.closingLayers.forEach(({ timer }) => clearTimeout(timer));
      document.documentElement.classList.remove('site-visible');
    });

    if (this.pageViews.available) {
      // Правила автовідтворення — у скрипти всіх сторінок вікна.
      effect(() => {
        const rules = this.autoplay.rules();
        untracked(() => this.ignore(this.pageViews.setAudioRules(rules)));
      });
      // Відновлена вкладка: її сайт вантажиться, щойно вкладку відкрили.
      effect(() => {
        const tab = this.activeTab();
        if (tab.site?.pending) {
          untracked(() => this.loadPendingSite(tab));
        }
      });
      if (this.keepsSession) {
        this.keepSession(destroyRef);
      }
      // Сплячі вкладки: фонова сторінка — у меншій пам'яті, а неактивна довше, ніж вибрано в налаштуваннях, засинає.
      effect(() => {
        const tab = this.activeTab();
        const label = tab.site && !tab.site.pending ? tab.site.label : null;
        untracked(() => this.bringToFront(tab, label));
      });
      const sleepTimer = setInterval(() => this.sleepInactiveTabs(), 60_000);
      destroyRef.onDestroy(() => clearInterval(sleepTimer));
      destroyRef.onDestroy(() => this.quietTimers.forEach((timer) => clearTimeout(timer)));
      // Захист від стеження (рівень, GPC, винятки) — для запитів і сторінок цього вікна.
      effect(() => {
        const rules = this.tracking.rules();
        untracked(() => this.ignore(this.pageViews.setTrackingRules(rules)));
      });

      // Webview сайту лежить поверх області вмісту, тож іде за її розміром.
      afterNextRender(() => {
        const observer = new ResizeObserver(() => {
          const label = this.visiblePage();
          // Сайт на весь екран тримає Rust; повернувшись, він отримає межі з exitPageFullscreen.
          if (label && !this.fullscreenPage()) {
            this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
          }
          // Інший розмір — і сайт, і панелі над ним деінде.
          this.scheduleInputRegion();
        });
        observer.observe(this.viewport().nativeElement);
        destroyRef.onDestroy(() => observer.disconnect());
      });

      const listeners = [
        this.pageViews.on('page://load', (event) => this.onPageLoad(event)),
        this.pageViews.on('page://navigation', (event) => this.onPageNavigation(event)),
        this.pageViews.on('page://title', (event) => this.onPageTitle(event)),
        this.pageViews.on('page://audio', (event) => this.onPageAudio(event)),
        this.pageViews.on('page://media', (event) => this.onPageMedia(event)),
        this.pageViews.on('page://fullscreen', (event) => this.queueFullscreen(() => this.onPageFullscreen(event))),
        this.pageViews.on('page://favicon', (event) => this.onPageFavicon(event)),
        this.pageViews.on('page://new-tab', (event) => this.onPageNewTab(event)),
        this.pageViews.on('page://download', (event) => this.onPageDownload(event)),
        this.pageViews.on('page://download-prompt', (event) => this.downloads.ask(event)),
        this.pageViews.on('page://adblock', (event) => this.onPageAdBlock(event)),
        this.pageViews.on('page://trackers', (event) => this.onPageTrackers(event)),
        this.pageViews.on('page://external', (event) => void this.onPageExternal(event)),
        this.pageViews.on('page://crashed', (event) => this.onPageCrashed(event)),
        this.pageViews.on('page://permission', (event) => this.onPagePermission(event)),
        this.pageViews.on('page://context', (event) => this.onPageContext(event)),
        this.pageViews.on('page://shortcut', (event) => this.onPageShortcut(event)),
        this.pageViews.on('page://password-prompt', (event) => this.passwords.ask(event)),
        this.pageViews.on('page://passwords-manage', () => this.openPage('passwords')),
        this.pageViews.on('page://address-prompt', (event) => this.addresses.ask(event)),
        this.pageViews.on('page://card-prompt', (event) => this.cards.ask(event)),
        this.pageViews.on('page://autofill', (event) => this.onPageAutofill(event)),
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
    return tab.site ? tab.site.title || hostname(tab.site.url) : translate(TAB_PAGES[tab.page as TabPage].title);
  }

  protected tabFavicon(tab: BrowserTab): string {
    return TAB_PAGES[tab.page as TabPage].favicon;
  }

  protected tabUrl(tab: BrowserTab): string {
    return tab.site ? tab.site.url : TAB_PAGES[tab.page as TabPage].url;
  }

  /**
   * Вибрати вкладку. Мишею (`follow`) — фокус іде за нею, як у Chrome і Firefox: у сайт, тож плеєр чи сторінка
   * одразу слухають клавіші. Клавішами (Enter на вкладці) — фокус лишається на вкладках.
   */
  protected selectTab(id: number, follow = true): void {
    this.activeTabId.set(id);
    const tab = this.tabs().find((candidate) => candidate.id === id);
    if (follow && tab) {
      this.followFocus(tab);
    }
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
    this.followFocus(next);
  }

  /**
   * Фокус — за вкладкою, що стала активною: у її сайт (туди, де був, — скажімо, на плеєр) чи в інтерфейс. Сайт, що
   * впав, захований — тоді теж в інтерфейс.
   */
  private followFocus(tab: BrowserTab): void {
    if (!this.pageViews.available) {
      return;
    }
    const focus = () =>
      tab.page === 'web' && !tab.site?.crashed ? this.pageViews.focus(this.pageLabel(tab)) : this.pageViews.focusInterface();
    // Після того як webview вкладки покажеться: прихований фокус не прийме. Показ іде чергою (queuePageShow), а до
    // неї вкладку ставить ефект — ще до малювання, тож тут черга вже з нею.
    afterNextRender(() => this.ignore(this.pageShow.then(focus)), { injector: this.injector });
  }

  protected openNewTab(): void {
    const tab = this.createNewTab();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.activeTabId.set(tab.id);
  }

  /** Меню вкладки (правий клік). */
  protected showTabMenu(event: MouseEvent, tab: BrowserTab): void {
    event.preventDefault();
    this.menuTabId.set(tab.id);
    this.tabMenu().show(event);
  }

  protected runTabMenu(action: TabMenuAction): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === this.menuTabId());
    const tab = tabs[index];
    if (!tab) {
      return;
    }
    switch (action) {
      case 'new-tab-right': {
        const added = this.createNewTab();
        this.insertTab(added, index + 1);
        this.activeTabId.set(added.id);
        break;
      }
      case 'reload':
        if (tab.site && !tab.site.pending) {
          this.ignore(this.pageViews.reload(tab.site.label));
        }
        break;
      case 'duplicate':
        this.duplicateTab(tab, index);
        break;
      case 'pin':
      case 'unpin':
        this.setPinned(tab.id, action === 'pin');
        break;
      case 'mute':
      case 'unmute':
        this.toggleMute(tab);
        break;
      case 'new-window':
        this.moveToNewWindow(tab);
        break;
      case 'close':
        this.closeTab(tab.id);
        break;
      case 'close-others':
        // Як у Chrome: закріплені лишаються.
        for (const other of tabs.filter((item) => item.id !== tab.id && !item.pinned)) {
          this.closeTab(other.id);
        }
        break;
      case 'close-right':
        for (const other of tabs.slice(index + 1).filter((item) => !item.pinned)) {
          this.closeTab(other.id);
        }
        break;
    }
  }

  /** Закріплена вкладка — ліворуч, серед закріплених (у кінці їх), відкріплена — одразу після них. */
  protected setPinned(id: number, pinned: boolean): void {
    const tabs = this.tabs();
    const tab = tabs.find((item) => item.id === id);
    if (!tab || !!tab.pinned === pinned) {
      return;
    }
    const rest = tabs.filter((item) => item.id !== id);
    const pinnedCount = rest.filter((item) => item.pinned).length;
    this.tabs.set([...rest.slice(0, pinnedCount), { ...tab, pinned }, ...rest.slice(pinnedCount)]);
  }

  private duplicateTab(tab: BrowserTab, index: number): void {
    const copy: BrowserTab = tab.site ? this.createNewTab() : { id: this.nextTabId++, page: tab.page };
    this.insertTab(copy, index + 1);
    this.activeTabId.set(copy.id);
    if (tab.site) {
      this.openSite(tab.site.url, copy);
    }
  }

  /**
   * Вкладка, відкрита з сайту вкладки `opener` (посилання, контекстне меню, спливне вікно), — поряд із нею, як у
   * Firefox: одразу за нею, а кожна наступна з неї ж — за попередньою такою, щоб ішли в тому порядку, в якому їх
   * відкривали. Ланцюжок обривається, щойно перейти на іншу вкладку (bringToFront).
   */
  private insertRelated(opener: number, tab: BrowserTab): void {
    const tabs = this.tabs();
    const last = this.related?.opener === opener ? tabs.findIndex((item) => item.id === this.related?.last) : -1;
    const index = last !== -1 ? last : tabs.findIndex((item) => item.id === opener);
    this.insertTab(tab, index === -1 ? tabs.length : index + 1);
    this.related = { opener, last: tab.id };
  }

  /** Вкладка на місце `index`, не порушуючи порядку: закріплені — завжди перші. */
  private insertTab(tab: BrowserTab, index: number): void {
    const tabs = this.tabs();
    const pinnedCount = tabs.filter((item) => item.pinned).length;
    const at = tab.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    this.tabs.set([...tabs.slice(0, at), tab, ...tabs.slice(at)]);
  }

  /** Вкладка як її переносять між вікнами й зберігають між запусками. */
  private savedTab(tab: BrowserTab): SavedTab {
    const pinned = tab.pinned ? { pinned: true } : {};
    return tab.site ? { page: 'web', url: tab.site.url, title: tab.site.title, ...pinned } : { page: tab.page, ...pinned };
  }

  /** Вкладка з перенесеної (з іншого вікна чи з минулого запуску): сайт завантажиться, щойно її відкриють. */
  private tabFromSaved(item: SavedTab): BrowserTab | null {
    const id = this.nextTabId++;
    const pinned = item.pinned ? { pinned: true } : {};
    if (item.page === 'web' && item.url && isOpenableUrl(item.url)) {
      const label = this.newPageLabel({ id, page: 'web' });
      return { id, page: 'web', site: { ...emptySite(label, item.url), title: item.title ?? '', pending: true }, ...pinned };
    }
    return item.page in TAB_PAGES ? { id, page: item.page as TabPage, ...pinned } : null;
  }

  /** Вкладка — у нове вікно (з меню вкладки чи перетягнута за межі вікна). Сайт у ньому відкриється наново. */
  protected moveToNewWindow(tab: BrowserTab): void {
    if (this.tabs().length < 2) {
      return;
    }
    if (tab.site) {
      this.windows.open({ url: tab.site.url, private: this.windows.isPrivate });
    } else if (this.keepsSession) {
      const key = `moved-${crypto.randomUUID()}`;
      this.session.save(key, { tabs: [this.savedTab(tab)], active: 0 });
      this.windows.open({ session: key });
    } else {
      return;
    }
    this.closeTab(tab.id, { moved: true });
  }

  protected onTabDragStart(event: DragEvent, tab: BrowserTab): void {
    if (!event.dataTransfer) {
      return;
    }
    this.draggedTab = tab.id;
    this.droppedHere = false;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TAB_MIME, JSON.stringify(this.savedTab(tab)));
  }

  /**
   * Над заголовком вікна — риска там, куди стане вкладка (і з іншого вікна теж): між вкладками, а лівіше за першу чи
   * правіше за останню (кнопка «+», порожнє місце, кнопки вікна) — на початок чи в кінець.
   */
  protected onTabStripDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(TAB_MIME)) {
      return;
    }
    if (!inTitlebar(event.target)) {
      this.dropIndex.set(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const items = [...document.querySelectorAll('.tab-list .tab')];
    const index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2;
    });
    this.dropIndex.set(index === -1 ? items.length : index);
  }

  protected onTabStripDragLeave(event: DragEvent): void {
    if (!inTitlebar(event.relatedTarget)) {
      this.dropIndex.set(null);
    }
  }

  protected onTabStripDrop(event: DragEvent): void {
    const data = event.dataTransfer?.getData(TAB_MIME);
    const index = this.dropIndex() ?? this.tabs().length;
    this.dropIndex.set(null);
    if (!data || !inTitlebar(event.target)) {
      return;
    }
    event.preventDefault();
    if (this.draggedTab !== null) {
      this.droppedHere = true;
      this.moveTab(this.draggedTab, index);
      return;
    }
    // З іншого вікна: там вкладка закриється (dropEffect «move»), тут відкривається.
    let item: SavedTab;
    try {
      item = JSON.parse(data) as SavedTab;
    } catch {
      return;
    }
    const tab = this.tabFromSaved(item);
    if (tab) {
      this.insertTab(tab, index);
      this.activeTabId.set(tab.id);
    }
  }

  /**
   * Перетягування закінчилося: вкладку прийняло інше вікно — тут вона закривається; відпустили поза вікнами
   * браузера — вона переходить у нове вікно, як у Chrome.
   */
  protected onTabDragEnd(event: DragEvent, tab: BrowserTab): void {
    const dragged = this.draggedTab;
    this.draggedTab = null;
    this.dropIndex.set(null);
    if (dragged === null || this.droppedHere) {
      return;
    }
    if (event.dataTransfer?.dropEffect === 'move') {
      this.closeTab(tab.id, { moved: true });
      return;
    }
    const outside =
      event.screenX < window.screenX ||
      event.screenY < window.screenY ||
      event.screenX > window.screenX + window.outerWidth ||
      event.screenY > window.screenY + window.outerHeight;
    if (outside) {
      this.moveToNewWindow(tab);
    }
  }

  /** Новий порядок вкладок у вікні (закріплені лишаються серед закріплених). */
  private moveTab(id: number, index: number): void {
    const tabs = this.tabs();
    const from = tabs.findIndex((tab) => tab.id === id);
    if (from === -1) {
      return;
    }
    const tab = tabs[from];
    const rest = tabs.filter((item) => item.id !== id);
    const target = index > from ? index - 1 : index;
    const pinnedCount = rest.filter((item) => item.pinned).length;
    const at = tab.pinned ? Math.min(target, pinnedCount) : Math.max(target, pinnedCount);
    this.tabs.set([...rest.slice(0, at), tab, ...rest.slice(at)]);
  }

  /** `moved` — вкладку перенесли в інше вікно, а не закрили: відновлювати її тут не треба. */
  protected closeTab(id: number, { moved = false } = {}): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const closed = tabs[index];
    const site = closed.site;
    if (site) {
      this.ignore(this.pageViews.close(site.label));
      // Запитання дозволів закритої сторінки вже нікому не потрібні.
      for (const request of this.permissions.forgetPage(site.label)) {
        this.ignore(this.pageViews.answerPermission(request.id, 'deny', false));
      }
      this.lastSeen.delete(site.label);
      this.lowMemory.delete(site.label);
      this.forgetQuiet(site.label);
    }
    // Порожню нову вкладку відновлювати нема чого, як і перенесену в інше вікно.
    if (closed.page !== 'new-tab' && !moved) {
      this.closedTabs.update((list) => [...list, { page: closed.page, url: site?.url, index }].slice(-CLOSED_TABS_LIMIT));
    }

    // id вкладок не повторюються — лічильник її міток більше не знадобиться.
    this.pagesCreated.delete(id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0) {
      const tab = this.createNewTab();
      this.tabs.set([tab]);
      this.activeTabId.set(tab.id);
      return;
    }

    this.tabs.set(remaining);
    if (id === this.activeTabId()) {
      // Як у Chrome: активною стає вкладка праворуч, а якщо її немає — ліворуч; фокус — за нею.
      const next = remaining[Math.min(index, remaining.length - 1)];
      this.activeTabId.set(next.id);
      this.followFocus(next);
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

    this.openSite(normalizeAddress(text) ?? this.settings.searchUrl(text), this.activeTab(), { back: true });
  }

  /**
   * Друкують в адресному рядку — підказки, а якщо надруковане — початок адреси знайомого сайту, рядок дописує її
   * й виділяє дописане (наступна літера його замінить), як у Chrome. Під час стирання не дописує.
   */
  protected onOmniboxInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    const value = this.omniboxText();
    this.typed.set(value);
    this.selectedSuggestion.set(-1);
    this.suggestionsOpen.set(!!value.trim());
    this.inline = null;
    const deleting = typeof InputEvent !== 'undefined' && event instanceof InputEvent && event.inputType.startsWith('delete');
    const completion = deleting ? null : inlineCompletion(value, this.suggestions());
    if (completion) {
      this.inline = completion;
      this.omniboxText.set(completion.text);
      afterNextRender(() => this.omnibox().selectRange(value.length, completion.text.length), { injector: this.injector });
    }
  }

  /**
   * Стрілки — по підказках (текст підказки — у рядку), Enter — відкрити вибрану чи надруковане, Esc — спершу закрити
   * підказки (і прибрати дописане), а вдруге повернути адресу вкладки.
   */
  protected onOmniboxKeydown(event: KeyboardEvent): void {
    // Кнопки всередині рядка (дозволи сайту, зірочка) обробляють Enter самі.
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    const list = this.suggestions();
    const open = this.suggestionsOpen() && list.length > 0;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && open) {
      event.preventDefault();
      // По колу: надруковане (-1) → перша → … → остання → знову надруковане.
      let next = this.selectedSuggestion() + (event.key === 'ArrowDown' ? 1 : -1);
      if (next >= list.length) {
        next = -1;
      } else if (next < -1) {
        next = list.length - 1;
      }
      this.selectedSuggestion.set(next);
      this.inline = null;
      this.omniboxText.set(next === -1 ? this.typed() : list[next].fill);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = open && this.selectedSuggestion() >= 0 ? list[this.selectedSuggestion()] : null;
      const inline = this.inline && this.omniboxText() === this.inline.text ? this.inline : null;
      const text = this.omniboxText();
      this.closeSuggestions();
      if (chosen) {
        this.runSuggestion(chosen);
      } else if (inline) {
        this.openSite(inline.url, this.activeTab(), { back: true });
      } else {
        this.navigate(text);
      }
      (event.target as HTMLElement).blur();
    } else if (event.key === 'Escape') {
      if (open || this.inline) {
        this.omniboxText.set(this.typed());
        this.closeSuggestions();
      } else {
        this.omniboxText.set(this.tabUrl(this.activeTab()));
      }
    }
  }

  /** Клік по підказці. */
  protected pickSuggestion(suggestion: Suggestion): void {
    this.closeSuggestions();
    this.runSuggestion(suggestion);
    this.omnibox().blur();
  }

  protected closeSuggestions(): void {
    this.suggestionsOpen.set(false);
    this.selectedSuggestion.set(-1);
    this.remoteSuggestions.set({ query: '', items: [] });
    this.inline = null;
  }

  private runSuggestion(suggestion: Suggestion): void {
    switch (suggestion.kind) {
      case 'search':
        this.openSite(this.settings.searchUrl(suggestion.query), this.activeTab(), { back: true });
        break;
      case 'tab':
        this.omniboxText.set(this.tabUrl(this.activeTab()));
        this.selectTab(suggestion.tabId);
        break;
      default:
        this.openLink(suggestion.url);
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

  /**
   * Клік коліщатком чи «Відкрити в новій вкладці»: нова вкладка у фоні чи одразу на неї — як у налаштуваннях
   * («Одразу переходити на нову вкладку»). З сайту вкладки `opener` — поряд із нею, інакше (закладки, історія) — в кінці.
   */
  protected openLinkInNewTab(url: string, background = !this.settings.switchToNewTab(), opener?: number): void {
    const page = internalPageFor(url);
    if (page) {
      // Внутрішня сторінка має одну вкладку: вже відкрита — нова не потрібна.
      let tab = this.tabs().find((item) => item.page === page);
      if (!tab) {
        tab = { id: this.nextTabId++, page };
        this.tabs.update((tabs) => [...tabs, tab!]);
      }
      if (!background) {
        this.activeTabId.set(tab.id);
      }
      return;
    }

    const tab = this.createNewTab();
    if (opener === undefined) {
      this.tabs.update((tabs) => [...tabs, tab]);
    } else {
      this.insertRelated(opener, tab);
    }
    this.openSite(url, tab, { background });
  }

  /** «Відкрити всі закладки» з панелі: кожна — у новій вкладці, а показується перша з них. */
  protected openAllBookmarks(bookmarks: readonly Bookmark[]): void {
    const firstNewTab = this.nextTabId;
    for (const bookmark of bookmarks) {
      this.openLinkInNewTab(bookmark.url, true);
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

  /** Код сторінки сайту (Ctrl+U) — у новій вкладці, як у Chrome. */
  protected viewSource(): void {
    const site = this.activeTab().site;
    if (site && isPageUrl(site.url)) {
      this.openInNewTab(viewSourceUrl(site.url));
    }
  }

  /** Інструменти розробника сайту (F12) — окремим вікном; на внутрішніх сторінках їх немає. */
  protected openDevTools(): void {
    const tab = this.activeTab();
    if (tab.site && !tab.site.pending) {
      this.ignore(this.pageViews.openDevTools(tab.site.label));
    }
  }

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
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const label = this.visiblePage();
      if (event.shiftKey && label && this.pageViews.available && document.activeElement === tabbables()[0]) {
        // Shift+Tab з першої кнопки інтерфейсу — коло назад: на останній елемент сайту.
        event.preventDefault();
        this.ignore(this.pageViews.focus(label, 'backward'));
        return;
      }
      // Фокус перейде ще за цим натисканням, тож позначка — лише до наступного завдання.
      this.tabbingForward = !event.shiftKey;
      setTimeout(() => (this.tabbingForward = false));
    }
    // F12 з адресного рядка чи панелей — інструменти розробника сайту (у самому сайті їх відкриває WebView2).
    if (event.code === 'F12' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && this.activeTab().site) {
      event.preventDefault();
      this.openDevTools();
      return;
    }
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
      case 'KeyU':
        this.viewSource();
        break;
      case 'Shift+KeyI':
      case 'Shift+KeyJ':
      case 'Shift+KeyC':
        if (!this.activeTab().site) {
          return;
        }
        this.openDevTools();
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
   * Фокус дійшов до кроку за панелями (browser.html). Клавішею Tab — далі в сайт, на перший його елемент. Інакше сюди
   * повернулися з сайту назад (Shift+Tab на його початку, webview2::watch_focus_leaving) — тоді на останню кнопку
   * панелей перед сайтом.
   */
  protected enterPage(event: FocusEvent): void {
    const step = event.target as HTMLElement;
    const label = this.visiblePage();
    if (this.tabbingForward && label && this.pageViews.available) {
      step.blur();
      this.ignore(this.pageViews.focus(label, 'forward'));
      return;
    }
    tabbableBefore(step)?.focus({ focusVisible: true });
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

    // У відновленої вкладки, сайт якої ще не завантажено, webview немає — створюється новий.
    if (tab.site && !tab.site.pending) {
      this.updateSite(tab.id, (site) => ({ ...site, url, loading: true }));
      this.ignore(this.pageViews.navigate(tab.site.label, url));
      return;
    }

    const label = this.newPageLabel(tab);
    const site = emptySite(label, url);
    this.replaceTab({ id: tab.id, page: 'web', site, back: back && tab.page !== 'web' ? tab.page : undefined });
    const autoplay = this.autoplay.rules();
    if (background) {
      // Справжні межі фонова вкладка отримає, коли її відкриють. Якщо відкрили ще до того, як її webview створився
      // («Відкрити всі закладки» одразу показує першу), показ тоді нікуди не дійшов — показуємо, щойно створився.
      this.lastSeen.set(label, Date.now());
      this.pageViews
        .open(label, url, { x: 0, y: 0, width: 0, height: 0 }, { background, autoplay })
        .then(() => this.onPageCreated(label))
        .catch(() => undefined);
      return;
    }
    this.activeTabId.set(tab.id);
    this.openPageView(label, url);
  }

  /** Webview сайту на місці області вмісту; якщо, поки він створювався, перейшли на іншу вкладку, — схований. */
  private openPageView(label: string, url: string): void {
    this.pageViews
      .open(label, url, this.pageBounds(), { autoplay: this.autoplay.rules() })
      .then(() => {
        if (!this.onPageCreated(label)) {
          this.ignore(this.pageViews.setVisible(label, false));
        }
      })
      .catch(() => undefined);
  }

  /**
   * Webview щойно створено. Поки він створювався, межі й показ до нього не доходили, а розкладка вікна могла змінитися
   * (скажімо, під час запуску з відновленими вкладками) — тож показуємо ще раз, як зараз. Повертає, чи його зараз видно.
   */
  private onPageCreated(label: string): boolean {
    if (this.visiblePage() !== label) {
      return false;
    }
    this.queuePageShow(label);
    return true;
  }

  /**
   * Вкладки з минулого запуску — якщо в налаштуваннях «Продовжити, де зупинилися» чи браузер щойно перезапускали
   * (DNS), — або вкладки іншого вікна, яке відкрили, щоб їх продовжити (?session=…). Щойно ввійшли в обліковий
   * запис — чиста нова вкладка: вкладки й вікна з минулого разу забуваються.
   */
  private restoreSession(): void {
    if (!this.keepsSession) {
      return;
    }
    const continued = new URLSearchParams(location.search).get('session');
    if (continued) {
      const saved = this.session.load(continued);
      this.session.remove(continued);
      if (saved) {
        this.applySession(saved);
      }
      return;
    }
    const signedIn = this.auth.takeFreshSignIn();
    const restore = this.session.takeRestoreOnce() || this.settings.startup() === 'restore';
    // Інші вікна з минулого разу відкриває головне вікно, щойно запущене.
    const others = this.windowLabel === 'main' ? this.session.windows().filter((label) => label !== 'main') : [];
    if (signedIn) {
      void this.forgetSavedWindows(others);
      return;
    }
    if (!restore) {
      return;
    }
    let saved = this.session.load(this.windowLabel);
    // Головне вікно закрили раніше за інші — тоді воно продовжує вкладки першого з них.
    const adopted = !saved ? others.shift() : undefined;
    if (adopted) {
      saved = this.session.load(adopted);
      this.session.remove(adopted);
    }
    if (saved) {
      this.applySession(saved);
    }
    if (others.length) {
      void this.openSavedWindows(others);
    }
  }

  private applySession(saved: SavedSession): void {
    const restored = saved.tabs.map((item) => this.tabFromSaved(item)).filter((tab): tab is BrowserTab => !!tab);
    // Закріплені — першими, як і були.
    const tabs = [...restored.filter((tab) => tab.pinned), ...restored.filter((tab) => !tab.pinned)];
    if (tabs.length) {
      this.tabs.set(tabs);
      this.activeTabId.set(tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)].id);
    }
  }

  /** Вкладки вікон з минулого разу, яких зараз немає, — вони вже не знадобляться. */
  private async forgetSavedWindows(labels: readonly string[]): Promise<void> {
    const windows = await getAllWebviewWindows().catch(() => null);
    if (!windows) {
      return;
    }
    const open = new Set(windows.map((window) => window.label));
    for (const label of labels) {
      if (!open.has(label)) {
        this.session.remove(label);
      }
    }
  }

  /** Вікна з минулого запуску, яких зараз немає (вже відкриті — після повторного входу — не дублюються). */
  private async openSavedWindows(labels: readonly string[]): Promise<void> {
    const open = new Set((await getAllWebviewWindows().catch(() => [])).map((window) => window.label));
    for (const label of labels) {
      if (!open.has(label)) {
        this.windows.open({ session: label });
      }
    }
  }

  /**
   * Вкладки вікна зберігаються з кожною зміною. Закрите вікно, поки є інші, забувається; останнє — ні: це вихід
   * із браузера, і наступний запуск його продовжить. Перезапуск для DNS закриває вікна без цього запитання.
   */
  private keepSession(destroyRef: DestroyRef): void {
    const saved = computed<SavedSession>(
      () => {
        const tabs = this.tabs();
        return {
          tabs: tabs.map((tab) => this.savedTab(tab)),
          active: Math.max(
            0,
            tabs.findIndex((tab) => tab.id === this.activeTabId())
          ),
        };
      },
      { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
    );
    effect(() => {
      const session = saved();
      untracked(() => this.session.save(this.windowLabel, session));
    });
    if (!isTauri()) {
      return;
    }
    const closing = getCurrentWindow().onCloseRequested(async () => {
      try {
        const windows = await getAllWebviewWindows();
        if (windows.some((window) => window.label !== this.windowLabel && isNormalWindow(window.label))) {
          this.session.remove(this.windowLabel);
        }
      } catch {
        // Не вдалося дізнатися про інші вікна — вкладки лишаються збереженими.
      }
    });
    destroyRef.onDestroy(() => void closing.then((unlisten) => unlisten()).catch(() => undefined));
  }

  private loadPendingSite(tab: BrowserTab): void {
    const site = tab.site;
    if (!site) {
      return;
    }
    this.updateSite(tab.id, (current) => ({ ...current, pending: false, loading: true }));
    this.openPageView(site.label, site.url);
  }

  private onPageLoad({ label, url, loading }: PageLoadEvent): void {
    // Сторінка пішла — разом із полем, над яким був список адрес.
    if (loading) {
      this.autofillPopup()?.hide(label);
    }
    const tab = this.tabByLabel(label);
    // Порожній документ нового webview, поки сайт ще не відкрився, — не сайт.
    if (tab?.site && isPageUrl(url)) {
      // Нова сторінка — заблоковані спливні вікна попередньої вже не про неї.
      this.updateSite(tab.id, (site) => ({
        ...site,
        url: this.shownUrl(site, url),
        loading,
        // Нова сторінка — і заблоковані спливні вікна, і значок звуку попередньої вже не про неї.
        ...(loading ? { blockedPopups: [], audible: site.playing, mediaPlaying: false } : {}),
      }));
    }
  }

  /** Браузер запустили ще раз (server/src/launch.rs): з посиланнями — вони тут, без них — нове вікно, як у Chrome. */
  private onAppOpen({ urls }: AppOpenEvent): void {
    if (urls.length === 0) {
      this.windows.open();
    } else {
      this.openLinks(urls);
    }
  }

  /**
   * Посилання ззовні (Telegram, пошта) і файли з Провідника — новими вкладками, остання стає активною; порожня нова
   * вкладка не лишається — її займає посилання. Приватне й гостьове вікна відкривають їх у звичайному.
   */
  private openLinks(urls: readonly string[]): void {
    const links = urls.filter(isOpenableUrl);
    if (this.windows.isPrivate || this.isGuest) {
      links.forEach((url) => this.windows.open({ url }));
      return;
    }
    for (const url of links) {
      const active = this.activeTab();
      if (active.page === 'new-tab' && !active.site) {
        this.replaceTab({ id: active.id, page: 'web', site: { ...emptySite(this.newPageLabel(active), url), pending: true } });
      } else {
        const tab = this.createNewTab();
        this.tabs.update((tabs) => [...tabs, tab]);
        this.activeTabId.set(tab.id);
        this.openSite(url, tab);
      }
    }
  }

  /** Вікно відкрили, щоб показати сайт (?url= — «Відкрити посилання в новому вікні»): він — у першій вкладці. */
  private openRequestedUrl(): void {
    const url = new URLSearchParams(location.search).get('url');
    if (!url || !/^https?:\/\//i.test(url) || !this.pageViews.available) {
      return;
    }
    const tab = this.activeTab();
    this.replaceTab({ id: tab.id, page: 'web', site: { ...emptySite(this.newPageLabel(tab), url), pending: true } });
  }

  /** Збій процесу сторінки: замість неї — екран із поясненням і кнопкою «Перезавантажити». */
  private onPageCrashed({ label, failure }: PageCrashedEvent): void {
    const tab = this.tabByLabel(label);
    if (tab?.site) {
      this.updateSite(tab.id, (site) => ({ ...site, crashed: failure, loading: false, playing: false, audible: false }));
    }
  }

  /** «Перезавантажити» після збою: старий webview закривається, а сайт відкривається в новому. */
  protected recoverPage(): void {
    const tab = this.activeTab();
    const site = tab.site;
    if (!site) {
      return;
    }
    this.ignore(this.pageViews.close(site.label));
    this.replaceTab({ ...tab, site: { ...emptySite(this.newPageLabel(tab), site.url), title: site.title, pending: true } });
  }

  /** Сторінка, що не відповідала, — показуємо знову, раптом отямилася. */
  protected waitForPage(): void {
    const tab = this.activeTab();
    this.updateSite(tab.id, (site) => ({ ...site, crashed: undefined }));
  }

  private onPagePermission({ label, id, kind, origin }: PagePermissionEvent): void {
    if (!this.tabByLabel(label)) {
      this.ignore(this.pageViews.answerPermission(id, 'deny', false));
      return;
    }
    this.permissions.ask({ id, label, kind, origin });
  }

  /** Дія з контекстного меню сайту. */
  private onPageContext({ label, action, url, text }: PageContextEvent): void {
    const tab = this.tabByLabel(label);
    if (!tab) {
      return;
    }
    switch (action) {
      case 'open-link-tab':
      case 'open-image-tab':
        if (url) {
          this.openLinkInNewTab(url, undefined, tab.id);
        }
        break;
      case 'open-link-window':
      case 'open-link-private':
        if (url) {
          this.windows.open({ url, private: action === 'open-link-private' });
        }
        break;
      case 'search':
        if (text) {
          this.openInNewTab(this.settings.searchUrl(text), tab.id);
        }
        break;
      case 'translate-text':
        if (text) {
          this.openInNewTab(translateTextUrl(text, this.translateLanguage.language()), tab.id);
        }
        break;
      case 'translate-page':
        if (tab.site) {
          this.openSite(translatePageUrl(tab.site.url, this.translateLanguage.language()), tab);
        }
        break;
      case 'screenshot':
        this.activeTabId.set(tab.id);
        this.runTool('screenshot');
        break;
      case 'view-source':
        if (url) {
          this.openInNewTab(viewSourceUrl(url), tab.id);
        }
        break;
    }
  }

  /** Нова вкладка поряд із вкладкою `opener` і одразу на неї (пошук чи переклад виділеного, код сторінки). */
  private openInNewTab(url: string, opener = this.activeTab().id): void {
    const tab = this.createNewTab();
    this.insertRelated(opener, tab);
    this.openSite(url, tab);
  }

  /** «Спливне вікно заблоковано» → відкрити його все ж. */
  protected openBlockedPopup(url: string): void {
    const tab = this.activeTab();
    this.updateSite(tab.id, (site) => ({ ...site, blockedPopups: (site.blockedPopups ?? []).filter((item) => item !== url) }));
    this.openInNewTab(url);
  }

  /**
   * Активна вкладка — у пам'яті як звичайна (і прокинулась, якщо спала), попередня — у фон: від цієї миті рахується,
   * коли вона перейде в режим малої пам'яті й засне (sleepInactiveTabs).
   */
  private bringToFront(tab: BrowserTab, label: string | null): void {
    if (this.related && this.related.opener !== tab.id) {
      this.related = null;
    }
    if (this.foregroundPage && this.foregroundPage !== label) {
      this.lastSeen.set(this.foregroundPage, Date.now());
    }
    if (label) {
      this.lastSeen.delete(label);
      if (this.lowMemory.delete(label)) {
        this.ignore(this.pageViews.setBackground(label, false));
      }
      if (tab.site?.sleeping) {
        // Показана сторінка прокидається сама (WebView2).
        this.updateSite(tab.id, (site) => ({ ...site, sleeping: false }));
      }
    }
    this.foregroundPage = label;
  }

  /**
   * Фонові вкладки, яких не відкривали LOW_MEMORY_AFTER_MS, переводить у режим малої пам'яті; яких не відкривали довше,
   * ніж вибрано в налаштуваннях, — присипляє, а ті, що проспали понад UNLOAD_AFTER_MS, вивантажує зовсім. Не чіпає
   * тих, що грають відео чи аудіо зі звуком (і стільки ж після того, як звук затих, — onPageAudio), вантажаться, впали
   * чи ще не завантажені. Вкладка з вимкненим звуком засинає, хоч би що на ній грало.
   */
  protected sleepInactiveTabs(now = Date.now()): void {
    const minutes = this.settings.sleepTabsAfter();
    const active = this.activeTab().id;
    for (const tab of this.tabs()) {
      const site = tab.site;
      if (tab.id === active || !site || site.pending || site.crashed || site.loading) {
        continue;
      }
      // Звук вимкнено — засинає, хоч би що грало.
      if ((site.playing || site.mediaPlaying) && !site.muted) {
        continue;
      }
      const seen = this.lastSeen.get(site.label);
      if (seen === undefined) {
        this.lastSeen.set(site.label, now);
        continue;
      }
      if (now - seen >= LOW_MEMORY_AFTER_MS && !this.lowMemory.has(site.label)) {
        this.lowMemory.add(site.label);
        this.ignore(this.pageViews.setBackground(site.label, true));
      }
      if (!minutes) {
        continue;
      }
      if (site.sleeping) {
        if (now - seen >= UNLOAD_AFTER_MS && !tab.pinned && !site.muted) {
          this.unloadTab(tab, site);
        }
        continue;
      }
      if (now - seen < minutes * 60_000) {
        continue;
      }
      this.pageViews
        .suspend(site.label)
        .then((asleep) => {
          if (asleep) {
            this.updateSite(tab.id, (current) => (current.label === site.label ? { ...current, sleeping: true } : current));
          }
        })
        .catch(() => undefined);
    }
  }

  /**
   * Вкладку, що давно спить, вивантажуємо зовсім: її webview закривається разом із процесом сторінки (сплячий усе ще
   * тримає пам'ять), а вкладка лишається, як відновлена після перезапуску, — сайт завантажиться знову, щойно її
   * відкриють. Запис історії той самий: повторне завантаження не дублює його. Закріплені вкладки (пошта, месенджери) і
   * вкладки з вимкненим звуком (новий webview був би зі звуком) не вивантажуються.
   */
  private unloadTab(tab: BrowserTab, site: Site): void {
    this.lastSeen.delete(site.label);
    this.lowMemory.delete(site.label);
    this.ignore(this.pageViews.close(site.label));
    this.replaceTab({
      ...tab,
      site: {
        ...emptySite(this.newPageLabel(tab), site.url),
        title: site.title,
        historyEntry: site.historyEntry,
        pending: true,
      },
    });
  }

  /** Нова адреса (і без перезавантаження) — запис в історії; «Назад» і «Вперед» — як каже WebView2. */
  private onPageNavigation({ label, url, canGoBack, canGoForward }: PageNavigationEvent): void {
    const tab = this.tabByLabel(label);
    // Початкова about:blank нового webview, поки він ще не перейшов на сайт, — не перехід користувача.
    if (!tab?.site || !isPageUrl(url)) {
      return;
    }

    this.updateSite(tab.id, (site) => {
      // Код сторінки — не відвідування сайту: без запису в історії.
      if (this.shownUrl(site, url) !== url) {
        return { ...site, canGoBack, canGoForward };
      }
      // У приватному вікні історія не ведеться; та сама адреса (оновлення, зміна лише історії) не дублює запис. Файлів
      // комп'ютера в історії теж немає: вона синхронізується, а шляхам до файлів на сервері не місце.
      if (this.windows.isPrivate || site.historyEntry?.url === url || url.startsWith('file:')) {
        return { ...site, url, canGoBack, canGoForward };
      }
      const id = this.history.record(url, site.title || hostname(url));
      return { ...site, url, canGoBack, canGoForward, historyEntry: { id, url } };
    });
  }

  /**
   * Адреса вкладки після події сторінки. Код сторінки WebView2 показує за адресою самого сайту (без view-source:),
   * тож вкладка з кодом лишається з view-source: — і в адресному рядку, і після перезапуску.
   */
  private shownUrl(site: Site, url: string): string {
    return site.url === viewSourceUrl(url) ? site.url : url;
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

  /**
   * Посилання на програму (mailto:, tel:…) — відкриваємо, лише якщо користувач погодиться чи вже дозволив цьому сайту.
   * Посилання, якого жодна програма на комп’ютері не знає, нічого не робить — як у Chrome.
   */
  private async onPageExternal({ label, url }: PageExternalEvent): Promise<void> {
    const tab = this.tabByLabel(label);
    const scheme = schemeOf(url);
    if (!tab || !scheme) {
      return;
    }
    let origin = '';
    try {
      origin = new URL(tab.site?.url ?? '').origin;
    } catch {
      // Сторінка ще без адреси — питаємо без «Завжди дозволяти».
    }
    const app = await this.pageViews.externalApp(url).catch(() => null);
    if (!app) {
      return;
    }
    if (this.externalApps.isAllowed(origin, scheme)) {
      this.ignore(this.pageViews.openExternal(url));
    } else {
      this.externalApps.ask(url, origin, app);
    }
  }

  private onPageTrackers({ label, trackers }: PageTrackersEvent): void {
    const tab = this.tabByLabel(label);
    if (tab?.site && (tab.site.trackers.length || trackers.length)) {
      this.updateSite(tab.id, (site) => ({ ...site, trackers }));
    }
  }

  /** «Налаштування приватності» з панелі захисту: сторінка налаштувань — одразу на розділі «Конфіденційність». */
  protected openPrivacySettings(): void {
    this.openPage('settings');
    afterNextRender(() => document.getElementById('settings-privacy')?.scrollIntoView({ block: 'start' }), {
      injector: this.injector,
    });
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
      case 'view-source':
        this.viewSource();
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
    if (!tab?.site) {
      return;
    }
    this.forgetQuiet(label);
    // Фонова сторінка, що грала, — не «давно не відкривали»: до сну рахуємо від миті, коли звук затих. Сторінок, що
    // грають, перевірка сну не чіпає, але на тихому місці (між треками, перед рекламою) WebView2 вважає, що звуку
    // немає, — і вкладка засинала б посеред відео, а воно зупинялося. Вкладка з вимкненим звуком засинає як звичайна.
    if (label !== this.foregroundPage && !muted) {
      this.lastSeen.set(label, Date.now());
    }
    if (!playing && tab.site.audible) {
      // Звук затих — значок ще лишається: пауза могла бути короткою.
      const timer = setTimeout(() => {
        this.quietTimers.delete(label);
        const current = this.tabByLabel(label);
        if (current?.site && !current.site.playing) {
          this.updateSite(current.id, (site) => ({ ...site, audible: false }));
        }
      }, AUDIBLE_HOLD_MS);
      this.quietTimers.set(label, timer);
    }
    this.updateSite(tab.id, (site) => ({ ...site, playing, muted, audible: site.audible || playing }));
  }

  /** Відео чи аудіо почало чи перестало грати зі звуком; коли перестало — до сну рахуємо від цієї миті. */
  private onPageMedia({ label, playing }: PageMediaEvent): void {
    const tab = this.tabByLabel(label);
    if (!tab?.site) {
      return;
    }
    if (label !== this.foregroundPage) {
      this.lastSeen.set(label, Date.now());
    }
    this.updateSite(tab.id, (site) => ({ ...site, mediaPlaying: playing }));
  }

  private forgetQuiet(label: string): void {
    clearTimeout(this.quietTimers.get(label));
    this.quietTimers.delete(label);
  }

  /**
   * Відео на весь екран. Вікно й webview сайту вже змінив Rust — одразу в події сторінки, одним кроком (через
   * інтерфейс це були б кілька кроків, і відео смикалося б між розмірами). Тут лише пам'ятаємо, хто на весь екран.
   */
  private async onPageFullscreen({ label, fullscreen }: PageFullscreenEvent): Promise<void> {
    if (!fullscreen) {
      if (label === this.fullscreenPage()) {
        await this.exitPageFullscreen(false);
      }
      return;
    }
    if (label !== this.visiblePage()) {
      // Сайт, якого не видно, — назад, як був.
      this.ignore(this.pageViews.exitFullscreen(label));
      return;
    }
    this.fullscreenPage.set(label);
    void this.updateInputRegion();
  }

  /**
   * Показує сайт `label` (чи жоден) під інтерфейсом — по черзі з попередніми показами. Спершу з'являється новий сайт,
   * тоді інтерфейс над ним стає прозорим і пропускає до нього мишу, а старий сайт ховається вже під ним: так між ними
   * на мить не проглядає порожнє вікно.
   */
  private queuePageShow(label: string | null): void {
    this.pageShow = this.pageShow.then(() => this.showPage(label)).catch(() => undefined);
  }

  private async showPage(label: string | null): Promise<void> {
    const previous = this.shownPage;
    // Список адрес — лише над полем сайту, який видно.
    if (label !== previous) {
      this.autofillPopup()?.hide();
    }
    this.shownPage = label;
    let shown = false;
    if (label) {
      this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
      // Webview ще створюється — інтерфейс лишається непрозорим, а покаже сайт onPageCreated.
      shown = await this.pageViews.setVisible(label, true).then(
        () => true,
        () => false
      );
    }
    this.siteUnder = shown ? label : null;
    document.documentElement.classList.toggle('site-visible', shown && !SHAPED_LAYERS);
    await this.updateInputRegion();
    if (previous && previous !== label) {
      await this.pageViews.setVisible(previous, false).catch(() => undefined);
    }
  }

  /**
   * Список адрес над полем форми на сайті (server/src/addresses.rs): лише над сайтом, який видно, і не над сайтом
   * на весь екран.
   */
  private onPageAutofill(event: PageAutofillEvent): void {
    const popup = this.autofillPopup();
    if (!popup) {
      return;
    }
    if (event.label !== this.visiblePage() || this.fullscreenPage()) {
      popup.hide(event.label);
      return;
    }
    switch (event.action) {
      case 'show':
        if (event.rect) {
          popup.show(event.label, event.form ?? 'address', event.kind ?? 'name', event.ids ?? [], event.rect, this.pageBounds());
        }
        break;
      case 'move':
        if (event.rect) {
          popup.move(event.label, event.rect, this.pageBounds());
        }
        break;
      case 'hide':
        popup.hide(event.label);
        break;
      case 'blur':
        popup.blur(event.label);
        break;
      case 'key':
        popup.key(event.label, event.key);
        break;
    }
  }

  /** Регіон — раз на кадр: панель, що з'являється, змінюється кілька разів поспіль. */
  protected scheduleInputRegion(): void {
    cancelAnimationFrame(this.regionFrame);
    this.regionFrame = requestAnimationFrame(() => void this.updateInputRegion());
  }

  /**
   * Де інтерфейс ловить мишу: усюди, крім сайту під ним, а над сайтом — лише відкриті й ще не згаслі панелі (разом із
   * тінню). Модальне вікно — усе вікно: затемнення лягає на живу сторінку, і клік повз вікно до сайту не доходить.
   */
  private updateInputRegion(): Promise<void> {
    cancelAnimationFrame(this.regionFrame);
    // Сайт на весь екран — поверх інтерфейсу (server/src/fullscreen.rs), тож регіон лишається, яким був.
    if (!this.pageViews.available || this.fullscreenPage()) {
      return Promise.resolve();
    }
    const closing = [...this.closingLayers.values()];
    const modal = !!document.querySelector('dialog:modal') || closing.some(({ area }) => !area);
    const page = this.siteUnder && !modal ? this.pageBounds() : null;
    const keep = page
      ? [
          ...[...document.querySelectorAll(':popover-open, dialog[open]:not(:modal)')].map(layerArea),
          ...closing.flatMap(({ area }) => (area ? [area] : [])),
        ]
      : [];
    const region = JSON.stringify([page, keep]);
    if (region === this.sentRegion) {
      return Promise.resolve();
    }
    this.sentRegion = region;
    return this.pageViews.setInputRegion(page, keep).catch(() => undefined);
  }

  /** Панель чи вікно закривається, але ще згасає: його місце лишається в регіоні до кінця анімації. */
  private keepWhileClosing(layer: HTMLElement): void {
    this.forgetClosing(layer);
    if (!this.siteUnder) {
      return;
    }
    const area = layer instanceof HTMLDialogElement && layer.matches(':modal') ? null : layerArea(layer);
    const timer = setTimeout(() => {
      this.closingLayers.delete(layer);
      void this.updateInputRegion();
    }, POPOVER_MOTION_MS + LAYER_FADE_SLACK_MS);
    this.closingLayers.set(layer, { area, timer });
  }

  private forgetClosing(layer: HTMLElement): void {
    clearTimeout(this.closingLayers.get(layer)?.timer);
    this.closingLayers.delete(layer);
  }

  private queueFullscreen(change: () => Promise<void>): void {
    this.fullscreenQueue = this.fullscreenQueue.then(change).catch(() => undefined);
  }

  /**
   * Сайт більше не на весь екран: сам вийшов (`fromPage` false — Rust уже все повернув) чи виводимо ми (інша вкладка,
   * модальне вікно). Регіон надсилаємо наново: Rust, повертаючи сайт, віддав мишу всьому інтерфейсу.
   */
  private async exitPageFullscreen(byInterface = true): Promise<void> {
    const label = this.fullscreenPage();
    this.fullscreenPage.set(null);
    if (label && byInterface) {
      await this.pageViews.exitFullscreen(label).catch(() => undefined);
    }
    this.sentRegion = '';
    // Межі — з розкладки вже після того, як вікно повернулося до свого розміру.
    requestAnimationFrame(() => {
      if (label && label === this.visiblePage()) {
        this.ignore(this.pageViews.setBounds(label, this.pageBounds()));
      }
      void this.updateInputRegion();
    });
  }

  private onPageFavicon({ label, url, icon }: PageFaviconEvent): void {
    if (this.tabByLabel(label)) {
      this.favicons.remember(url, icon);
    }
  }

  /**
   * Сайт відкриває нове вікно — новою вкладкою. Без кліку користувача це спливне вікно: його браузер блокує
   * (кнопка в адресному рядку покаже, що саме), якщо сайтові не дозволено спливні вікна.
   */
  private onPageNewTab({ label, url, userInitiated, background }: PageNewTabEvent): void {
    const source = this.tabByLabel(label);
    if (!source) {
      return;
    }
    let origin = '';
    try {
      origin = new URL(source.site?.url ?? '').origin;
    } catch {
      // Сторінка ще без адреси.
    }
    if (userInitiated === false && !this.permissions.popupsAllowed(origin)) {
      this.updateSite(source.id, (site) => ({
        ...site,
        blockedPopups: [...(site.blockedPopups ?? []).filter((item) => item !== url), url].slice(-10),
      }));
      return;
    }
    const tab = this.createNewTab();
    this.insertRelated(source.id, tab);
    // Посилання коліщатком чи з Ctrl — у фоні чи одразу на неї, як у налаштуваннях (Shift — навпаки); решта (target="_blank",
    // window.open) — одразу на нову вкладку.
    const inBackground = background !== undefined && background !== this.settings.switchToNewTab();
    this.openSite(url, tab, { background: inBackground });
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

/** На що стає фокус клавішею Tab (tabindex > 0 в інтерфейсі немає). */
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** Елементи інтерфейсу, на які стає Tab, у його порядку: видимі, не вимкнені й не під модальним вікном. */
function tabbables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert]') &&
      (element.checkVisibility?.({ visibilityProperty: true }) ?? true)
  );
}

/** Останній елемент перед `step`, на який стає Tab. */
function tabbableBefore(step: HTMLElement): HTMLElement | undefined {
  return tabbables()
    .filter((element) => element.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING)
    .at(-1);
}

/** Тип даних перетягуваної вкладки (між вікнами браузера — JSON з SavedTab). */
const TAB_MIME = 'application/x-astra-tab';

/** Ціль події — у заголовку вікна (app-titlebar): там вкладки, туди їх і скидають. */
function inTitlebar(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('app-titlebar');
}

/** Сайт вкладки, що тільки відкривається: ще без назви, історії переходів і заблокованого. */
function emptySite(label: string, url: string): Site {
  return {
    label,
    url,
    title: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    playing: false,
    audible: false,
    muted: false,
    blocked: 0,
    trackers: [],
  };
}

/** Тривалість появи й зникнення панелей ($motion у _mixins.scss). */
const POPOVER_MOTION_MS = 180;
/** Запас після анімації зникнення, перш ніж місце шару піде з регіону: таймер і кадр не збігаються точно. */
const LAYER_FADE_SLACK_MS = 40;
/** Запас довкола панелі в регіоні інтерфейсу, px: її тінь (--browser-popover-shadow) і зсув під час появи. */
const LAYER_MARGIN = 56;
/**
 * Linux (WebKitGTK): GTK3 не змішує вікна, тож інтерфейс над сайтом не прозорий, а обрізаний формою
 * (server/src/gtk_layers.rs) — і панель над сайтом лише сама, без тіні навколо: там видно сайт.
 */
const SHAPED_LAYERS = IS_LINUX;

/**
 * Місце панелі чи вікна в регіоні інтерфейсу — разом із тінню. Панель може задати свої відступи (data-layer-margins:
 * [згори, справа, знизу, зліва]), як список адрес, що не має лягати на поле сайту під ним.
 */
function layerArea(layer: Element): PageBounds {
  const rect = layer.getBoundingClientRect();
  const margins = SHAPED_LAYERS ? [0, 0, 0, 0] : layer instanceof HTMLElement ? layerMargins(layer) : null;
  const [top, right, bottom, left] = margins ?? [LAYER_MARGIN, LAYER_MARGIN, LAYER_MARGIN, LAYER_MARGIN];
  return {
    x: Math.floor(rect.left - left),
    y: Math.floor(rect.top - top),
    width: Math.ceil(rect.width + left + right),
    height: Math.ceil(rect.height + top + bottom),
  };
}

function layerMargins(layer: HTMLElement): readonly number[] | null {
  try {
    const margins: unknown = JSON.parse(layer.dataset['layerMargins'] ?? 'null');
    return Array.isArray(margins) && margins.length === 4 && margins.every((value) => typeof value === 'number')
      ? (margins as number[])
      : null;
  } catch {
    return null;
  }
}

/** Сторінка відео на YouTube (зокрема Shorts, трансляції й вбудований плеєр). */
function isYouTubeVideo(url: string): boolean {
  try {
    const { hostname: host, pathname } = new URL(url);
    return /(^|\.)youtube\.com$/.test(host) && /^\/(watch|shorts\/|live\/|embed\/)/.test(pathname);
  } catch {
    return false;
  }
}

/** Скільки вкладка має проспати, щоб її вивантажили зовсім (sleepInactiveTabs). */
const UNLOAD_AFTER_MS = 6 * 60 * 60_000;

/**
 * Скільки фонову вкладку не відкривали, щоб вона перейшла в режим малої пам'яті WebView2 (sleepInactiveTabs). Не
 * одразу: повертатися з нього довше (WebView2 відновлює звільнене), а повертаються найчастіше до нещодавніх вкладок.
 */
const LOW_MEMORY_AFTER_MS = 5 * 60_000;

/** Скільки тримати кнопку «Оновити», щоб відкрилося меню оновлення. */
const RELOAD_HOLD_MS = 500;
