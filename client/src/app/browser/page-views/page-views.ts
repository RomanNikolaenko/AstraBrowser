import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
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

/** Отвір у сайті під панель: у логічних пікселях від лівого верхнього кута сторінки, з радіусом кутів панелі. */
export interface PageHole {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
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
    | 'screenshot';
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
  readonly shortcut: 'next-tab' | 'previous-tab' | 'reopen-tab' | 'screenshot' | 'zoom-in' | 'zoom-out' | 'zoom-reset';
}

/** Користувач увійшов на сайт — «Зберегти пароль?» (server/src/passwords.rs). */
export interface PagePasswordPromptEvent extends PasswordPromptRequest {
  readonly label: string;
}

/** «Керувати паролями…» у списку облікових записів на сайті. */
export interface PagePasswordsManageEvent {
  readonly label: string;
}

/** Дозвіл сайту на автовідтворення; `default` у WebView2 теж дозволяє. */
export type AutoplayPermission = 'allow' | 'block' | 'default';

interface PageEvents {
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
}

/**
 * Нативні webview сайтів (команди page_* у server/src/pages.rs). Кожна вкладка із сайтом — окремий
 * webview поверх області вмісту, тож інтерфейс лише задає йому межі, видимість і навігацію.
 * Поза Tauri (ng serve у звичайному браузері) сайтів не вбудувати — `available` = false.
 */
@Injectable({ providedIn: 'root' })
export class PageViews {
  readonly available = isTauri();

  private readonly pendingBounds = new Map<string, PageBounds>();
  private readonly sendingBounds = new Set<string>();

  /**
   * `background` — для фонової вкладки: webview прихований і не забирає фокус.
   * `autoplay` — правила автовідтворення сайтів (server/src/audio.rs).
   */
  open(label: string, url: string, bounds: PageBounds, options: PageOpenOptions = {}): Promise<void> {
    return invoke('page_open', {
      label,
      url,
      bounds,
      background: options.background ?? false,
      autoplay: options.autoplay ?? { allow: [], blockAudio: [] },
    });
  }

  navigate(label: string, url: string): Promise<void> {
    return invoke('page_navigate', { label, url });
  }

  go(label: string, step: -1 | 1): Promise<void> {
    return invoke('page_go', { label, step });
  }

  reload(label: string): Promise<void> {
    return invoke('page_reload', { label });
  }

  /**
   * Межі змінюються пачками (вікно розгортається, панель відкривається), а виклики команд можуть дійти
   * до Rust не по порядку — і останнім застосувався б проміжний розмір. Тож для кожної сторінки
   * в дорозі лише один виклик, а наступний несе найсвіжіші межі.
   */
  /** Вмикає чи вимикає «картинку в картинці» для відео на сторінці. */
  pictureInPicture(label: string): Promise<'opened' | 'closed' | 'no-video'> {
    return invoke('page_picture_in_picture', { label });
  }

  reloadWith(label: string, mode: ReloadMode): Promise<void> {
    return invoke('page_reload_with', { label, mode });
  }

  setBounds(label: string, bounds: PageBounds): Promise<void> {
    this.pendingBounds.set(label, bounds);
    if (!this.sendingBounds.has(label)) {
      void this.sendBounds(label);
    }
    return Promise.resolve();
  }

  setVisible(label: string, visible: boolean): Promise<void> {
    return invoke('page_set_visible', { label, visible });
  }

  /** Отвори в сайті під панелі інтерфейсу (server/src/webview2.rs, set_clip); порожній список — сайт знову цілий. */
  setClip(label: string, holes: readonly PageHole[]): Promise<void> {
    return invoke('page_set_clip', { label, holes });
  }

  setZoom(label: string, scale: number): Promise<void> {
    return invoke('page_set_zoom', { label, scale });
  }

  focus(label: string): Promise<void> {
    return invoke('page_focus', { label });
  }

  /** Фокус — у сам інтерфейс вікна (скажімо, з прихованого щойно сайту). */
  focusInterface(): Promise<void> {
    return getCurrentWebview().setFocus();
  }

  print(label: string): Promise<void> {
    return invoke('page_print', { label });
  }

  close(label: string): Promise<void> {
    return invoke('page_close', { label });
  }

  /** Виділяє наступний (чи попередній) збіг на сторінці; true — якщо знайшовся. */
  find(label: string, query: string, backwards: boolean): Promise<boolean> {
    return invoke('page_find', { label, query, backwards });
  }

  setMuted(label: string, muted: boolean): Promise<void> {
    return invoke('page_set_muted', { label, muted });
  }

  /** Знімок того, що показує сторінка (JPEG): лежить на місці webview, поки той прихований під панеллю. */
  capture(label: string): Promise<ArrayBuffer> {
    return invoke('page_capture', { label });
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
  setAudioRules(rules: AutoplayRules): Promise<void> {
    return invoke('page_set_audio_rules', { rules });
  }

  /** Підказки пошукової системи для введеного в адресному рядку (server/src/suggest.rs); без мережі — порожньо. */
  searchSuggestions(engine: string, query: string): Promise<string[]> {
    return invoke<string[]>('search_suggestions', { engine, query });
  }

  /** Присипляє приховану фонову вкладку; `true` — заснула. */
  suspend(label: string): Promise<boolean> {
    return invoke<boolean>('page_suspend', { label });
  }

  /** Вкладка у фоні — WebView2 тримає її в меншій пам'яті. */
  setBackground(label: string, background: boolean): Promise<void> {
    return invoke('page_set_background', { label, background });
  }

  /** Відповідь на запит дозволу сайту; `remember` — запам'ятати для сайту. */
  answerPermission(id: number, state: PermissionState, remember: boolean): Promise<void> {
    return invoke('page_permission_answer', { id, state, remember });
  }

  /** Збережені дозволи сайту вкладки: дозвіл → стан. */
  permissions(label: string): Promise<Readonly<Record<string, PermissionState>>> {
    return invoke('page_permissions', { label });
  }

  setPermission(label: string, kind: PermissionKind, state: PermissionState): Promise<void> {
    return invoke('page_set_permission', { label, kind, state });
  }

  /** Назва програми Windows, що відкриє посилання (mailto:, tg:…); null — такої немає. */
  externalApp(url: string): Promise<string | null> {
    return invoke<string | null>('external_app', { url });
  }

  /** Відкриває посилання (mailto:, tel:…) програмою Windows — лише після згоди користувача. */
  openExternal(url: string): Promise<void> {
    return invoke('open_external', { url });
  }

  /** Правила захисту від стеження для всіх сайтів вікна: запитам — одразу, а куки й GPC — і сторінкам, що вже відкриті. */
  setTrackingRules(rules: TrackingRules): Promise<void> {
    return invoke('tracking_set_rules', { rules });
  }

  /** Збережений для сайту дозвіл на автовідтворення (у приватному вікні — лише до його закриття). */
  autoplay(label: string): Promise<AutoplayPermission> {
    return invoke('page_autoplay', { label });
  }

  /** Сторінка побачить новий дозвіл після перезавантаження. */
  setAutoplay(label: string, autoplay: AutoplayPermission): Promise<void> {
    return invoke('page_set_autoplay', { label, autoplay });
  }

  /** Відповідь «куди зберегти»: тека чи null — не завантажувати. */
  resolveDownload(id: number, folder: string | null): Promise<void> {
    return invoke('download_resolve', { id, folder });
  }

  /** Вікно вибору теки Windows для одного файла; null — теку не вибрали. */
  pickDownloadFolder(current: string): Promise<string | null> {
    return invoke('downloads_pick_folder', { current });
  }

  cancelDownload(id: number): Promise<void> {
    return invoke('download_cancel', { id });
  }

  /** Відкриває завантажений файл програмою, що стоїть для нього в Windows. */
  openDownload(path: string): Promise<void> {
    return invoke('download_open', { path });
  }

  /** Показує файл виділеним у його теці. */
  showDownload(path: string): Promise<void> {
    return invoke('download_show', { path });
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
        await invoke('page_set_bounds', { label, bounds }).catch(() => undefined);
      }
    } finally {
      this.sendingBounds.delete(label);
    }
  }
}
