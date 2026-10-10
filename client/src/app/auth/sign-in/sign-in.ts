import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore, authErrorMessage, isAuthError } from '../../shared/auth/auth';
import { FormField, emailFormat, required, validateFields } from '../../shared/form-field/form-field';
import { UiCheckbox } from '../../shared/ui-checkbox/ui-checkbox';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { AuthLayout } from '../auth-layout/auth-layout';
import { emailFromNavigation } from '../auth-forms';
import { SignInCode } from '../sign-in-code/sign-in-code';
import { VerifyEmail } from '../verify-email/verify-email';

/**
 * Вхід в обліковий запис. «Запам'ятати мене» — сеанс переживе перезапуск (server/src/auth.rs). Якщо пошту ще
 * не підтверджено — крок із кодом з листа. Без пароля — кодом з пошти чи через Google.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthLayout, RouterLink, SignInCode, UiCheckbox, UiIcon, UiInput, VerifyEmail],
  selector: 'app-sign-in',
  styleUrl: '../auth.scss',
  templateUrl: './sign-in.html',
})
export class SignIn {
  protected readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  /** Обліковий запис щойно видалили — сторінка входу каже про це. */
  protected readonly deletedEmail = this.auth.deletedEmail;

  protected readonly passwordVisible = signal(false);
  protected readonly remember = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Пошту не підтверджено — показуємо крок із кодом. */
  protected readonly verifying = signal(false);
  /** Лист із кодом для входу надіслано — крок «Вхід за кодом». */
  protected readonly signingInWithCode = signal(false);
  /** Відкрито вікно входу через Google. */
  protected readonly google = signal(false);

  protected readonly email = new FormField([
    required('Введіть електронну пошту'),
    emailFormat('Некоректна адреса електронної пошти'),
  ]);
  protected readonly password = new FormField([required('Введіть пароль')]);

  constructor() {
    this.email.value.set(emailFromNavigation());
  }

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !validateFields([this.email, this.password])) {
      return;
    }
    if (!this.auth.available) {
      // Поза застосунком облікових записів немає — просто відкриваємо браузер.
      await this.router.navigate(['/home']);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn(this.email.value().trim(), this.password.value(), this.remember());
      await this.router.navigate(['/home']);
    } catch (error) {
      if (isAuthError(error) && error.code === 'email_not_confirmed') {
        this.verifying.set(true);
      } else {
        this.error.set(authErrorMessage(error));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** З кроку підтвердження — назад до форми (пароль лишається). */
  protected backToForm(): void {
    this.verifying.set(false);
    this.signingInWithCode.set(false);
    this.error.set(null);
  }

  /** Лист із кодом для входу без пароля — потрібна лише пошта. */
  protected async sendCode(): Promise<void> {
    if (this.busy() || !validateFields([this.email])) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.sendSignInCode(this.email.value().trim());
      this.signingInWithCode.set(true);
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async signInWithGoogle(): Promise<void> {
    if (this.busy() || this.google()) {
      return;
    }
    this.google.set(true);
    this.error.set(null);
    try {
      await this.auth.signInWithGoogle(this.remember());
      await this.router.navigate(['/home']);
    } catch (error) {
      // Закрили вікно Google — нічого не сталося.
      if (!isAuthError(error) || error.code !== 'cancelled') {
        this.error.set(authErrorMessage(error));
      }
    } finally {
      this.google.set(false);
    }
  }
}
