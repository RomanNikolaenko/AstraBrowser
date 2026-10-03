import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiInput],
  selector: 'app-new-tab',
  styleUrl: './new-tab.scss',
  templateUrl: './new-tab.html',
})
export class NewTab {
  /** Запит чи адреса з поля пошуку (Enter). */
  readonly search = output<string>();

  protected readonly query = signal('');

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.query().trim()) {
      this.search.emit(this.query());
    }
  }
}
