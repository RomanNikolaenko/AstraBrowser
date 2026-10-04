import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-checkbox',
  styleUrl: './ui-checkbox.scss',
  templateUrl: './ui-checkbox.html',
})
export class UiCheckbox {
  readonly checked = model(false);
  readonly inputName = input('');

  protected onChange(event: Event): void {
    this.checked.set((event.target as HTMLInputElement).checked);
  }
}
