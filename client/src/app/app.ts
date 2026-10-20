import { afterNextRender, ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LaunchLinks } from './browser/launch/launch-links';
import { BrowserWindows } from './shared/browser-windows/browser-windows';
import { closePopoversOnOutsidePress } from './shared/popover/outside-press';
import { SettingsStore } from './shared/settings/settings';
import { Titlebar } from './shared/titlebar/titlebar';
import { enableWindowDrag } from './shared/window-drag/window-drag';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Titlebar],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  constructor() {
    // Тема з налаштувань діє на всіх екранах і стежить за змінами з інших вікон.
    inject(SettingsStore);
    // Посилання з інших програм — і поки вікно ще на сторінці входу.
    inject(LaunchLinks);
    closePopoversOnOutsidePress();
    enableWindowDrag();
    // Вікно створюється прихованим і з'являється вже в темі інтерфейсу: інакше під час запуску на мить видно біле тло
    // webview з чорними смугами вікна (server/src/launch.rs, reveal_later).
    const windows = inject(BrowserWindows);
    afterNextRender(() => windows.reveal().catch(() => undefined));
  }
}
