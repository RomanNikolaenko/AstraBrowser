import { ChangeDetectionStrategy, Component } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiInput],
  selector: 'app-new-tab',
  styleUrl: './new-tab.scss',
  templateUrl: './new-tab.html',
})
export class NewTab {}
