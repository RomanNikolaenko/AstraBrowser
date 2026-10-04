import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { UiInput } from '../../shared/ui-input/ui-input';
import { newTabBackgroundCss } from './new-tab-backgrounds';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiInput],
  selector: 'app-new-tab',
  styleUrl: './new-tab.scss',
  templateUrl: './new-tab.html',
  host: {
    '[style.--new-tab-background]': 'background()',
    '[class.new-tab--photo]': "settings.newTabBackground() === 'custom'",
  },
})
export class NewTab {
  /** Запит чи адреса з поля пошуку (Enter). */
  readonly searched = output<string>();

  protected readonly query = signal('');
  protected readonly settings = inject(SettingsStore);
  /** Фон із Персоналізації: бульбашки, градієнт, без фону чи своє зображення. */
  protected readonly background = computed(() =>
    newTabBackgroundCss(this.settings.newTabBackground(), this.settings.newTabImage())
  );

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.query().trim()) {
      this.searched.emit(this.query());
    }
  }
}
