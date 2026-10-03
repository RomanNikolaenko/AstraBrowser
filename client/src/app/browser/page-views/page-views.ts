import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

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

export interface PageNewTabEvent {
  readonly label: string;
  readonly url: string;
}

export interface PageDownloadEvent {
  readonly label: string;
  readonly url: string;
  readonly fileName: string;
  readonly size: number;
  readonly success: boolean;
}

/** Сторінка почала чи перестала грати звук, або його вимкнули. */
export interface PageAudioEvent {
  readonly label: string;
  readonly playing: boolean;
  readonly muted: boolean;
}

export interface PageOpenOptions {
  readonly background?: boolean;
  readonly blockAudio?: readonly string[];
}

/** Нова адреса чи зміна історії вкладки — і після переходів без перезавантаження (history.pushState). */
export interface PageNavigationEvent {
  readonly label: string;
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Особливе оновлення з меню кнопки «Оновити» (server/src/webview2.rs, ReloadMode). */
export type ReloadMode = 'hard' | 'cache' | 'site-data' | 'cookies';

/** Сторінка ввійшла в повноекранний режим (відео тощо) чи вийшла з нього. */
export interface PageFullscreenEvent {
  readonly label: string;
  readonly fullscreen: boolean;
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
   * `blockAudio` — сайти, яким заборонено автовідтворення зі звуком (server/src/audio.rs).
   */
  open(label: string, url: string, bounds: PageBounds, options: PageOpenOptions = {}): Promise<void> {
    return invoke('page_open', { label, url, bounds, background: options.background ?? false, blockAudio: options.blockAudio ?? [] });
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

  setZoom(label: string, scale: number): Promise<void> {
    return invoke('page_set_zoom', { label, scale });
  }

  focus(label: string): Promise<void> {
    return invoke('page_focus', { label });
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

  /** Сайти з забороненим автовідтворенням зі звуком — для всіх сайтів вікна; діє після перезавантаження. */
  setAudioRules(origins: readonly string[]): Promise<void> {
    return invoke('page_set_audio_rules', { origins });
  }

  /** Збережений для сайту дозвіл на автовідтворення (у приватному вікні — лише до його закриття). */
  autoplay(label: string): Promise<AutoplayPermission> {
    return invoke('page_autoplay', { label });
  }

  /** Сторінка побачить новий дозвіл після перезавантаження. */
  setAutoplay(label: string, autoplay: AutoplayPermission): Promise<void> {
    return invoke('page_set_autoplay', { label, autoplay });
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
