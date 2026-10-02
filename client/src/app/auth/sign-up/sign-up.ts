import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormField, emailFormat, matches, minLength, required, validateFields } from '../../shared/form-field/form-field';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiCheckbox } from '../../shared/ui-checkbox/ui-checkbox';
import { UiInput } from '../../shared/ui-input/ui-input';

const PASSWORD_MIN_LENGTH = 8;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiCheckbox, UiIcon, UiInput],
  selector: 'app-sign-up',
  styleUrl: '../auth.scss',
  templateUrl: './sign-up.html',
})
export class SignUp {
  private readonly router = inject(Router);

  protected readonly passwordVisible = signal(false);
  protected readonly confirmationVisible = signal(false);

  protected readonly fullName = new FormField([required('Введіть ім’я та прізвище')]);
  protected readonly email = new FormField([
    required('Введіть електронну пошту'),
    emailFormat('Некоректна адреса електронної пошти'),
  ]);
  protected readonly password = new FormField([
    required('Введіть пароль'),
    minLength(PASSWORD_MIN_LENGTH, `Пароль має містити щонайменше ${PASSWORD_MIN_LENGTH} символів`),
  ]);
  protected readonly confirmation = new FormField([
    required('Повторіть пароль'),
    matches(() => this.password.value(), 'Паролі не збігаються'),
  ]);

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected toggleConfirmationVisibility(): void {
    this.confirmationVisible.update((visible) => !visible);
  }

  // Справжньої реєстрації ще немає: коректна форма просто відкриває браузер.
  protected submit(event: Event): void {
    event.preventDefault();
    if (validateFields([this.fullName, this.email, this.password, this.confirmation])) {
      void this.router.navigate(['/home']);
    }
  }
}
