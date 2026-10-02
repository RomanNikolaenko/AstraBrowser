import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { getTauriVersion, getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { SHORTCUTS } from '../internal-pages';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-help-page',
  styleUrls: ['../internal-page.scss', './help-page.scss'],
  templateUrl: './help-page.html',
})
export class HelpPage {
  protected readonly shortcuts = SHORTCUTS;

  // Версії відомі лише всередині Tauri; у звичайному браузері (ng serve) їх немає.
  protected readonly appVersion = signal<string | null>(null);
  protected readonly tauriVersion = signal<string | null>(null);

  /** WebView2 — це Chromium; його версію видно з User-Agent. */
  protected readonly engineVersion = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null;

  constructor() {
    if (isTauri()) {
      void getVersion().then((version) => this.appVersion.set(version));
      void getTauriVersion().then((version) => this.tauriVersion.set(version));
    }
  }
}
