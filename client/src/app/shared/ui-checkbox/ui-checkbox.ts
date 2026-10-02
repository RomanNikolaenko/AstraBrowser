import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-checkbox',
  styleUrl: './ui-checkbox.scss',
  templateUrl: './ui-checkbox.html',
})
export class UiCheckbox {
  readonly checked = input(false);
  readonly inputName = input('');
}
