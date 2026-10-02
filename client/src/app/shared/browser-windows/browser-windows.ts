import { Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
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

  /**
   * Нове вікно одразу з головним екраном. Приватне — у режимі incognito
   * (InPrivate у WebView2): cookies, сховище й історія зникають, щойно вікно закрито.
   */
  open({ private: isPrivate = false } = {}): void {
    if (!isTauri()) {
      // Поза Tauri (ng serve у звичайному браузері) приватності не відтворити — просто нова вкладка.
      window.open('/home', '_blank', 'noopener');
      return;
    }

    const label = `${isPrivate ? PRIVATE_PREFIX : WINDOW_PREFIX}${crypto.randomUUID()}`;
    const webview = new WebviewWindow(label, {
      url: '/home',
      title: isPrivate ? 'Astra Browser — приватне вікно' : 'Astra Browser',
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      decorations: false,
      incognito: isPrivate,
    });
    void webview.once('tauri://error', (event) => console.error('Failed to open a window', event.payload));
  }
}
