import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormField, required, validateFields } from '../../shared/form-field/form-field';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiCheckbox } from '../../shared/ui-checkbox/ui-checkbox';
import { UiInput } from '../../shared/ui-input/ui-input';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiCheckbox, UiIcon, UiInput],
  selector: 'app-sign-in',
  styleUrl: '../auth.scss',
  templateUrl: './sign-in.html',
})
export class SignIn {
  private readonly router = inject(Router);

  protected readonly passwordVisible = signal(false);

  protected readonly login = new FormField([required('Введіть електронну пошту або ім’я користувача')]);
  protected readonly password = new FormField([required('Введіть пароль')]);

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  // Справжньої авторизації ще немає: коректна форма просто відкриває браузер.
  protected submit(event: Event): void {
    event.preventDefault();
    if (validateFields([this.login, this.password])) {
      void this.router.navigate(['/home']);
    }
  }
}
