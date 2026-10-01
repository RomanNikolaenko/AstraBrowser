import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiCheckbox } from '../../shared/ui-checkbox/ui-checkbox';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiCheckbox, UiIcon],
  selector: 'app-sign-in',
  host: { class: 'auth-route' },
  styleUrl: '../auth.scss',
  templateUrl: './sign-in.html',
})
export class SignIn {
  protected readonly passwordVisible = signal(false);

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }
}
