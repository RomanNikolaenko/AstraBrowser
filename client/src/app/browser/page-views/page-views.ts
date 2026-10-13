import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { AddressPromptRequest, AutofillKind } from '../data/addresses';
import type { CardPromptRequest } from '../data/cards';
import { DownloadProgress, DownloadPromptRequest } from '../data/downloads';
import { PasswordPromptRequest } from '../data/passwords';
import type { PermissionKind, PermissionState } from '../data/permissions';
import type { BlockedTracker, TrackingRules } from '../data/tracking';

export interface PageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PageLoadEvent {
  readonly label: string;
  readonly url: string;
  readonly loading: boolean;
}

export interface PageTitleEvent {
  readonly label: string;
  readonly title: string;
}

/** Іконка сторінки з її <link rel="icon">. */
export interface PageFaviconEvent {
  readonly label: string;
  readonly url: string;
  readonly icon: string;
}

/** Процес сторінки впав чи не відповідає (server/src/page_events.rs). */
export interface PageCrashedEvent {
  readonly label: string;
  readonly failure: PageFailure;
}

export type PageFailure = 'exited' | 'unresponsive' | 'browser';

/** Сайт просить дозвіл (камера, мікрофон…). */
export interface PagePermissionEvent {
  readonly label: string;
  readonly id: number;
  readonly kind: PermissionKind;
  readonly origin: string;
  readonly userInitiated: boolean;
}

/** Дія браузера з контекстного меню сайту. */
export interface PageContextEvent {
  readonly label: string;
  readonly action:
    | 'open-link-tab'
    | 'open-link-window'
    | 'open-link-private'
    | 'open-image-tab'
    | 'search'
    | 'translate-text'
    | 'translate-page'
    | 'screenshot'
    | 'view-source';
  readonly url?: string;
  readonly text?: string;
}

export interface PageNewTabEvent {
  readonly label: string;
  readonly url: string;
  /** Після кліку користувача; `false` — спливне вікно, яке браузер блокує. */
  readonly userInitiated?: boolean;
}

/** Завантаження зі сторінки чекає відповіді, куди зберегти файл. */
export interface PageDownloadPromptEvent extends DownloadPromptRequest {
  readonly label: string;
}

/** Завантаження зі сторінки почалося, іде чи скінчилося. */
export interface PageDownloadEvent extends DownloadProgress {
  readonly label: string;
}

/** Сторінка почала чи перестала грати звук, або його вимкнули. */
export interface PageAudioEvent {
  readonly label: string;
  readonly playing: boolean;
  readonly muted: boolean;
}

/** Правила автовідтворення (server/src/audio.rs): решта сайтів — «Блокувати аудіо та відео». */
export interface AutoplayRules {
  /** Сайти (origin), яким дозволено все. */
  readonly allow: readonly string[];
  /** Сайти, яким заборонено лише автовідтворення зі звуком. */
  readonly blockAudio: readonly string[];
}

export interface PageOpenOptions {
  readonly background?: boolean;
  readonly autoplay?: AutoplayRules;
}

/** Нова адреса чи зміна історії вкладки — і після переходів без перезавантаження (history.pushState). */
export interface PageNavigationEvent {
  readonly label: string;
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Особливе оновлення з меню кнопки «Оновити» (server/src/webview2.rs, ReloadMode). */
export type ReloadMode = 'hard' | 'cache' | 'site-data' | 'cookies' | 'all';

/** Сторінка ввійшла в повноекранний режим (відео тощо) чи вийшла з нього. */
export interface PageFullscreenEvent {
  readonly label: string;
  readonly fullscreen: boolean;
}

/** Скільки запитів блокувальник реклами відсік на поточній сторінці вкладки (server/src/adblock.rs). */
export interface PageAdBlockEvent {
  readonly label: string;
  readonly blocked: number;
}

/** Елементи стеження, заблоковані на поточній сторінці вкладки (server/src/tracking.rs); порожньо — нова сторінка. */
export interface PageTrackersEvent {
  readonly label: string;
  readonly trackers: readonly BlockedTracker[];
}

/** Сайт хоче відкрити посилання програмою: mailto:, tel:… (server/src/external.rs). */
export interface PageExternalEvent {
  readonly label: string;
  readonly url: string;
}

/** Гаряча клавіша браузера, натиснута, поки фокус у сайті (server/src/webview2.rs, watch_shortcuts). */
export interface PageShortcutEvent {
  readonly label: string;
  readonly shortcut:
    'next-tab' | 'previous-tab' | 'reopen-tab' | 'screenshot' | 'view-source' | 'zoom-in' | 'zoom-out' | 'zoom-reset';
}

/** Користувач увійшов на сайт — «Зберегти пароль?» (server/src/passwords.rs). */
export interface PagePasswordPromptEvent extends PasswordPromptRequest {
  readonly label: string;
}

/** «Керувати паролями…» у списку облікових записів на сайті. */
export interface PagePasswordsManageEvent {
  readonly label: string;
}

/** Список над полем форми на сайті: адреси чи банківські картки. */
export type AutofillForm = 'address' | 'card';

/** Оплатили на сайті новою карткою — «Зберегти картку?» (server/src/cards.rs). */
export interface PageCardPromptEvent extends CardPromptRequest {
  readonly label: string;
}

/** Надіслали форму з адресою — «Зберегти адресу?» (server/src/addresses.rs). */
export interface PageAddressPromptEvent extends AddressPromptRequest {
  readonly label: string;
}

/**
 * Список адрес над полем форми на сайті (server/src/addresses.rs, AutofillEvent): show — показати під полем `rect`
 * (фізичні пікселі від кута сайту) адреси `ids`; move — поле зсунулося; hide — сховати; blur — сайт утратив фокус
 * (сховати, якщо фокус не в інтерфейсі); key — клавіша в полі.
 */
export interface PageAutofillEvent {
  readonly label: string;
  readonly action: 'show' | 'move' | 'hide' | 'blur' | 'key';
  /** Що показати: адреси (server/src/addresses.rs) чи банківські картки (server/src/cards.rs). */
  readonly form?: AutofillForm;
  /** Вид поля: адреси чи картки (cc-number, cc-name, cc-exp…). */
  readonly kind?: AutofillKind | `cc-${'number' | 'name' | 'exp' | 'exp-month' | 'exp-year'}`;
  readonly rect?: PageBounds;
  readonly ids?: readonly string[];
  readonly key?: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape';
}

/** Дозвіл сайту на автовідтворення; `default` у WebView2 теж дозволяє. */
export type AutoplayPermission = 'allow' | 'block' | 'default';

/**
 * Посилання з іншої програми (Telegram, пошта) чи повторний запуск браузера (server/src/launch.rs).
 * Без посилань — просто відкрити нове вікно.
 */
export interface AppOpenEvent {
  readonly urls: readonly string[];
}

interface PageEvents {
  'app://open': AppOpenEvent;
  'page://load': PageLoadEvent;
  'page://navigation': PageNavigationEvent;
  'page://audio': PageAudioEvent;
  'page://fullscreen': PageFullscreenEvent;
  'page://title': PageTitleEvent;
  'page://favicon': PageFaviconEvent;
  'page://new-tab': PageNewTabEvent;
  'page://download': PageDownloadEvent;
  'page://download-prompt': PageDownloadPromptEvent;
  'page://adblock': PageAdBlockEvent;
  'page://trackers': PageTrackersEvent;
  'page://external': PageExternalEvent;
  'page://crashed': PageCrashedEvent;
  'page://permission': PagePermissionEvent;
  'page://context': PageContextEvent;
  'page://shortcut': PageShortcutEvent;
  'page://password-prompt': PagePasswordPromptEvent;
  'page://passwords-manage': PagePasswordsManageEvent;
  'page://address-prompt': PageAddressPromptEvent;
  'page://autofill': PageAutofillEvent;
  'page://card-prompt': PageCardPromptEvent;
}

/**
 * Нативні webview сайтів (команди page_* у server/src/pages.rs). Кожна вкладка із сайтом — окремий
 * webview поверх області вмісту, тож інтерфейс лише задає йому межі, видимість і навігацію.
 * Поза Tauri (ng serve у звичайному браузері) сайтів не вбудувати — `available` = false.
 */
/** Правила автовідтворення для Rust: bindings.ts описує масиви без readonly. */
function autoplayArgs(rules: AutoplayRules = { allow: [], blockAudio: [] }) {
  return { allow: [...rules.allow], blockAudio: [...rules.blockAudio] };
}

@Injectable({ providedIn: 'root' })
export class PageViews {
  readonly available = isTauri();

  private readonly pendingBounds = new Map<string, PageBounds>();
  private readonly sendingBounds = new Set<string>();

  /**
   * `background` — для фонової вкладки: webview прихований і не забирає фокус.
   * `autoplay` — правила автовідтворення сайтів (server/src/audio.rs).
   */
  async open(label: string, url: string, bounds: PageBounds, options: PageOpenOptions = {}): Promise<void> {
    await commands.pageOpen(label, url, bounds, options.background ?? false, autoplayArgs(options.autoplay));
  }

  async navigate(label: string, url: string): Promise<void> {
    await commands.pageNavigate(label, url);
  }

  async go(label: string, step: -1 | 1): Promise<void> {
    await commands.pageGo(label, step);
  }

  async reload(label: string): Promise<void> {
    await commands.pageReload(label);
  }

  /**
   * Межі змінюються пачками (вікно розгортається, панель відкривається), а виклики команд можуть дійти
   * до Rust не по порядку — і останнім застосувався б проміжний розмір. Тож для кожної сторінки
   * в дорозі лише один виклик, а наступний несе найсвіжіші межі.
   */
  /** Вмикає чи вимикає «картинку в картинці» для відео на сторінці. */
  pictureInPicture(label: string): Promise<'opened' | 'closed' | 'no-video'> {
    return commands.pagePictureInPicture(label);
  }

  async reloadWith(label: string, mode: ReloadMode): Promise<void> {
    await commands.pageReloadWith(label, mode);
  }

  setBounds(label: string, bounds: PageBounds): Promise<void> {
    this.pendingBounds.set(label, bounds);
    if (!this.sendingBounds.has(label)) {
      void this.sendBounds(label);
    }
    return Promise.resolve();
  }

  async setVisible(label: string, visible: boolean): Promise<void> {
    await commands.pageSetVisible(label, visible);
  }

  /**
   * Де інтерфейс вікна ловить мишу (server/src/webview2.rs, set_input_region): поза сторінкою `page`, а над нею — лише
   * в `keep` (панелі над сайтом). `page` null — увесь інтерфейс.
   */
  async setInputRegion(page: PageBounds | null, keep: readonly PageBounds[]): Promise<void> {
    await commands.interfaceSetInputRegion(page, [...keep]);
  }

  /** Вивести сайт із повного екрана (server/src/fullscreen.rs): вікно й webview — як були до нього. */
  async exitFullscreen(label: string): Promise<void> {
    await commands.pageExitFullscreen(label);
  }

  async setZoom(label: string, scale: number): Promise<void> {
    await commands.pageSetZoom(label, scale);
  }

  async focus(label: string): Promise<void> {
    await commands.pageFocus(label);
  }

  /** Фокус — у сам інтерфейс вікна (скажімо, з прихованого щойно сайту). */
  focusInterface(): Promise<void> {
    return getCurrentWebview().setFocus();
  }

  async print(label: string): Promise<void> {
    await commands.pagePrint(label);
  }

  /** Інструменти розробника сайту (DevTools) — окремим вікном. */
  async openDevTools(label: string): Promise<void> {
    await commands.pageOpenDevtools(label);
  }

  async close(label: string): Promise<void> {
    await commands.pageClose(label);
  }

  /** Виділяє наступний (чи попередній) збіг на сторінці; true — якщо знайшовся. */
  find(label: string, query: string, backwards: boolean): Promise<boolean> {
    return commands.pageFind(label, query, backwards);
  }

  async setMuted(label: string, muted: boolean): Promise<void> {
    await commands.pageSetMuted(label, muted);
  }

  /** Скріншот сторінки (PNG): видима частина чи вся сторінка з прокруткою (`full`). */
  screenshot(label: string, full: boolean): Promise<ArrayBuffer> {
    return invoke('page_screenshot', { label, full });
  }

  /**
   * Вікно «Зберегти як» для файла, який зробив інтерфейс: скріншота (png) чи закладок (html).
   * Шлях до файла або null, якщо не зберегли.
   */
  saveFile(content: Uint8Array, fileName: string, kind: 'png' | 'html'): Promise<string | null> {
    return invoke('file_save', content, {
      headers: { 'x-file-name': encodeURIComponent(fileName), 'x-file-kind': kind },
    });
  }

  /** Правила автовідтворення — для всіх сайтів вікна: відкритим сторінкам одразу, а відео, що вже на них, — після перезавантаження. */
  async setAudioRules(rules: AutoplayRules): Promise<void> {
    await commands.pageSetAudioRules(autoplayArgs(rules));
  }

  /** Підказки пошукової системи для введеного в адресному рядку (server/src/suggest.rs); без мережі — порожньо. */
  searchSuggestions(engine: string, query: string): Promise<string[]> {
    return commands.searchSuggestions(engine, query);
  }

  /** Присипляє приховану фонову вкладку; `true` — заснула. */
  suspend(label: string): Promise<boolean> {
    return commands.pageSuspend(label);
  }

  /** Вкладка у фоні — WebView2 тримає її в меншій пам'яті. */
  async setBackground(label: string, background: boolean): Promise<void> {
    await commands.pageSetBackground(label, background);
  }

  /** Відповідь на запит дозволу сайту; `remember` — запам'ятати для сайту. */
  async answerPermission(id: number, state: PermissionState, remember: boolean): Promise<void> {
    await commands.pagePermissionAnswer(id, state, remember);
  }

  /** Збережені дозволи сайту вкладки: дозвіл → стан. */
  permissions(label: string): Promise<Readonly<Record<string, PermissionState>>> {
    return commands.pagePermissions(label);
  }

  async setPermission(label: string, kind: PermissionKind, state: PermissionState): Promise<void> {
    await commands.pageSetPermission(label, kind, state);
  }

  /** Посилання, з якими браузер запустили (Astra — браузер за замовчуванням); віддаються один раз. */
  launchUrls(): Promise<string[]> {
    return this.available ? commands.launchUrls() : Promise.resolve([]);
  }

  /** Назва програми Windows, що відкриє посилання (mailto:, tg:…); null — такої немає. */
  externalApp(url: string): Promise<string | null> {
    return commands.externalApp(url);
  }

  /** Відкриває посилання (mailto:, tel:…) програмою Windows — лише після згоди користувача. */
  async openExternal(url: string): Promise<void> {
    await commands.openExternal(url);
  }

  /** Правила захисту від стеження для всіх сайтів вікна: запитам — одразу, а куки й GPC — і сторінкам, що вже відкриті. */
  async setTrackingRules(rules: TrackingRules): Promise<void> {
    await commands.trackingSetRules({ ...rules, exceptions: [...rules.exceptions] });
  }

  /** Збережений для сайту дозвіл на автовідтворення (у приватному вікні — лише до його закриття). */
  autoplay(label: string): Promise<AutoplayPermission> {
    return commands.pageAutoplay(label);
  }

  /** Сторінка побачить новий дозвіл після перезавантаження. */
  async setAutoplay(label: string, autoplay: AutoplayPermission): Promise<void> {
    await commands.pageSetAutoplay(label, autoplay);
  }

  /** Відповідь «куди зберегти»: тека чи null — не завантажувати. */
  async resolveDownload(id: number, folder: string | null): Promise<void> {
    await commands.downloadResolve(id, folder);
  }

  /** Вікно вибору теки Windows для одного файла; null — теку не вибрали. */
  pickDownloadFolder(current: string): Promise<string | null> {
    return commands.downloadsPickFolder(current);
  }

  async cancelDownload(id: number): Promise<void> {
    await commands.downloadCancel(id);
  }

  /** Відкриває завантажений файл програмою, що стоїть для нього в Windows. */
  async openDownload(path: string): Promise<void> {
    await commands.downloadOpen(path);
  }

  /** Показує файл виділеним у його теці. */
  async showDownload(path: string): Promise<void> {
    await commands.downloadShow(path);
  }

  /** Події надходять лише webview інтерфейсу поточного вікна. */
  on<K extends keyof PageEvents>(event: K, handler: (payload: PageEvents[K]) => void): Promise<UnlistenFn> {
    return getCurrentWebview().listen<PageEvents[K]>(event, ({ payload }) => handler(payload));
  }

  private async sendBounds(label: string): Promise<void> {
    this.sendingBounds.add(label);
    try {
      for (let bounds = this.pendingBounds.get(label); bounds; bounds = this.pendingBounds.get(label)) {
        this.pendingBounds.delete(label);
        // Webview може ще створюватися чи вже бути закритим — тоді просто пропускаємо.
        await commands.pageSetBounds(label, bounds).catch(() => undefined);
      }
    } finally {
      this.sendingBounds.delete(label);
    }
  }
}
