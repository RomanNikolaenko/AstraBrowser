import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { closePopoversOnOutsidePress } from './shared/popover/outside-press';
import { SettingsStore } from './shared/settings/settings';
import { Titlebar } from './shared/titlebar/titlebar';

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
    closePopoversOnOutsidePress();
  }
}
