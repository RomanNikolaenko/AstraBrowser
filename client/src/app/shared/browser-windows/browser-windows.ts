import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// Мітки вікон: за ними capabilities дають новим вікнам ті самі дозволи, що й головному,
// а приватне вікно впізнає себе без жодних параметрів в URL.
const WINDOW_PREFIX = 'window-';
const PRIVATE_PREFIX = 'private-';

/** Відкриває нові вікна браузера й знає, чи поточне вікно приватне. */
@Injectable({ providedIn: 'root' })
export class BrowserWindows {
  readonly isPrivate = isTauri() && getCurrentWindow().label.startsWith(PRIVATE_PREFIX);

  /** Вікно було розгорнуте до повноекранного режиму. */
  private restoreMaximized = false;

  /**
   * Нове вікно одразу з головним екраном. Приватне — у режимі incognito
   * (InPrivate у WebView2): cookies, сховище й історія зникають, щойно вікно закрито.
   * Розгорнуте на весь екран, якщо розгорнуте поточне (застосунок і стартує розгорнутим).
   */
  open({ private: isPrivate = false } = {}): void {
    if (!isTauri()) {
      // Поза Tauri (ng serve у звичайному браузері) приватності не відтворити — просто нова вкладка.
      window.open('/home', '_blank', 'noopener');
      return;
    }
    void this.openWindow(isPrivate);
  }

  private async openWindow(isPrivate: boolean): Promise<void> {
    const maximized = await getCurrentWindow()
      .isMaximized()
      .catch(() => false);
    const label = `${isPrivate ? PRIVATE_PREFIX : WINDOW_PREFIX}${crypto.randomUUID()}`;
    const webview = new WebviewWindow(label, {
      url: '/home',
      title: isPrivate ? 'Astra Browser — приватне вікно' : 'Astra Browser',
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      center: true,
      maximized,
      decorations: false,
      // Інакше у Windows Tauri забирає собі перетягування, і в інтерфейсі воно не працює (закладки).
      dragDropEnabled: false,
      incognito: isPrivate,
    });
    void webview.once('tauri://error', (event) => console.error('Failed to open a window', event.payload));
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
        await invoke('window_fill_monitor');
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
