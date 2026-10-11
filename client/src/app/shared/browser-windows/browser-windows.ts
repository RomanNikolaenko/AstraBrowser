import { Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// Мітки вікон: за ними capabilities дають новим вікнам ті самі дозволи, що й головному,
// а приватне вікно впізнає себе без жодних параметрів в URL.
const WINDOW_PREFIX = 'window-';
const PRIVATE_PREFIX = 'private-';
const GUEST_PREFIX = 'guest-';

/** Параметри WebView2 — ті самі, що `BROWSER_ARGS` у server/src/main.rs. */
const BROWSER_ARGS = '--disable-features=msWebOOUI,msPdfOOUI';

/** Параметри нового вікна. `additionalBrowserArgs` Tauri приймає (WindowConfig), хоч у типах JS його й немає. */
type WindowOptions = NonNullable<ConstructorParameters<typeof WebviewWindow>[1]> & { readonly additionalBrowserArgs: string };

/** Звичайне вікно браузера (головне чи нове): його вкладки зберігаються між запусками. */
export function isNormalWindow(label: string): boolean {
  return label === 'main' || label.startsWith(WINDOW_PREFIX);
}

/** Яке вікно відкрити: звичайне, приватне чи гостьове. */
export type WindowKind = 'normal' | 'private' | 'guest';

const WINDOWS: Readonly<Record<WindowKind, { readonly prefix: string; readonly title: string }>> = {
  normal: { prefix: WINDOW_PREFIX, title: 'Astra Browser' },
  private: { prefix: PRIVATE_PREFIX, title: 'Astra Browser — приватне вікно' },
  guest: { prefix: GUEST_PREFIX, title: 'Astra Browser — гість' },
};

/** Відкриває нові вікна браузера й знає, чи поточне вікно приватне чи гостьове. */
@Injectable({ providedIn: 'root' })
export class BrowserWindows {
  readonly isPrivate = isTauri() && getCurrentWindow().label.startsWith(PRIVATE_PREFIX);
  /**
   * Гостьове вікно: для когось іншого за цим комп'ютером. Як і приватне, нічого не зберігає (cookies, історія,
   * закладки зникають разом із вікном), а ще не бачить паролів власника (server/src/passwords.rs).
   */
  readonly isGuest = isTauri() && getCurrentWindow().label.startsWith(GUEST_PREFIX);

  /** Вікно було розгорнуте до повноекранного режиму. */
  private restoreMaximized = false;

  /**
   * Нове вікно одразу з головним екраном. Приватне — у режимі incognito
   * (InPrivate у WebView2): cookies, сховище й історія зникають, щойно вікно закрито.
   * Розгорнуте на весь екран, якщо розгорнуте поточне (застосунок і стартує розгорнутим).
   * `session` — мітка вікна з минулого запуску: нове вікно продовжить його вкладки (browser/session).
   */
  open({
    private: isPrivate = false,
    guest = false,
    session,
    url,
  }: { private?: boolean; guest?: boolean; session?: string; url?: string } = {}): void {
    if (!isTauri()) {
      // Поза Tauri (ng serve у звичайному браузері) приватності не відтворити — просто нова вкладка.
      window.open(url ?? '/home', '_blank', 'noopener');
      return;
    }
    void this.openWindow(guest ? 'guest' : isPrivate ? 'private' : 'normal', session, url);
  }

  /** Закрити поточне вікно (вийти з гостьового режиму). */
  async closeCurrent(): Promise<void> {
    if (isTauri()) {
      await getCurrentWindow().close();
    }
  }

  private async openWindow(kind: WindowKind, session?: string, url?: string): Promise<void> {
    const maximized = await getCurrentWindow()
      .isMaximized()
      .catch(() => false);
    const { prefix, title } = WINDOWS[kind];
    const label = `${prefix}${crypto.randomUUID()}`;
    const options: WindowOptions = {
      // ?session= — продовжити вкладки вікна з минулого запуску, ?url= — одразу відкрити сайт (посилання з меню сайту).
      url: session ? `/home?session=${encodeURIComponent(session)}` : url ? `/home?url=${encodeURIComponent(url)}` : '/home',
      title,
      width: 1280,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      center: true,
      maximized,
      decorations: false,
      // Інакше у Windows Tauri забирає собі перетягування, і в інтерфейсі воно не працює (закладки).
      dragDropEnabled: false,
      incognito: kind !== 'normal',
      // Як у головного вікна (server/src/main.rs, BROWSER_ARGS): одна тека даних — однакові параметри WebView2,
      // і SmartScreen не вимкнено.
      additionalBrowserArgs: BROWSER_ARGS,
    };
    const webview = new WebviewWindow(label, options);
    void webview.once('tauri://error', (event) => console.error('Failed to open a window', event.payload));
  }

  /** Починає перетягування вікна за курсором (кнопка миші натиснута); поза Tauri — нічого. */
  async startDragging(): Promise<void> {
    if (isTauri()) {
      await commands.windowStartDrag();
    }
  }

  /** Розгортає вікно на весь робочий стіл або повертає попередній розмір; поза Tauri — нічого. */
  async toggleMaximize(): Promise<void> {
    if (isTauri()) {
      await getCurrentWindow().toggleMaximize();
    }
  }

  isFullscreen(): Promise<boolean> {
    return isTauri() ? getCurrentWindow().isFullscreen() : Promise.resolve(!!document.fullscreenElement);
  }

  /** Поточне вікно на весь екран; поза Tauri — повноекранний режим сторінки. */
  async setFullscreen(fullscreen: boolean): Promise<void> {
    if (isTauri()) {
      const window = getCurrentWindow();
      // Розгорнутому вікну без рамки Windows лишає відступи розгорнутого стану, і на весь екран
      // воно не дотягує знизу. Тож спершу знімаємо розгортання, а після виходу повертаємо.
      if (fullscreen && (await window.isMaximized())) {
        this.restoreMaximized = true;
        await window.unmaximize();
      }
      await window.setFullscreen(fullscreen);
      if (fullscreen) {
        // Поки сторінка сайту сама на весь екран (відео), tao не встигає розтягнути вікно — server/src/fullscreen.rs.
        await commands.windowFillMonitor();
      } else if (this.restoreMaximized) {
        this.restoreMaximized = false;
        await window.maximize();
      }
    } else if (fullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (!fullscreen && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  }
}
