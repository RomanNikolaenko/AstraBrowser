import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UiIcon } from './shared/ui-icon/ui-icon';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, UiIcon],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('astra-browser');
  protected readonly isMaximized = signal(false);

  constructor() {
    if (!isTauri()) {
      return;
    }

    const window = getCurrentWindow();
    void this.syncMaximizedState();
    void window.onResized(() => void this.syncMaximizedState());
  }

  protected minimizeWindow(): void {
    void getCurrentWindow().minimize();
  }

  protected toggleMaximizeWindow(): void {
    void getCurrentWindow().toggleMaximize();
  }

  private async syncMaximizedState(): Promise<void> {
    this.isMaximized.set(await getCurrentWindow().isMaximized());
  }

  protected closeWindow(): void {
    void getCurrentWindow().close();
  }
}
