import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UiIcon } from '../ui-icon/ui-icon';
import { TranslatePipe } from '../i18n/i18n';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-window-controls',
  styleUrl: './window-controls.scss',
  templateUrl: './window-controls.html',
})
export class WindowControls {
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

  protected closeWindow(): void {
    void getCurrentWindow().close();
  }

  private async syncMaximizedState(): Promise<void> {
    this.isMaximized.set(await getCurrentWindow().isMaximized());
  }
}
