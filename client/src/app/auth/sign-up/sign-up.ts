import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore, authErrorMessage } from '../../shared/auth/auth';
import { FormField, emailFormat, matches, minLength, required, validateFields } from '../../shared/form-field/form-field';
import { UiCheckbox } from '../../shared/ui-checkbox/ui-checkbox';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { AuthLayout } from '../auth-layout/auth-layout';
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from '../auth-forms';
import { VerifyEmail } from '../verify-email/verify-email';
import { tr, TranslatePipe } from '../../shared/i18n/i18n';

/** Реєстрація: ім'я, пошта й пароль, згода з умовами — і крок із кодом із листа (якщо Supabase просить підтвердити пошту). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, AuthLayout, RouterLink, UiCheckbox, UiIcon, UiInput, VerifyEmail],
  selector: 'app-sign-up',
  styleUrl: '../auth.scss',
  templateUrl: './sign-up.html',
})
export class SignUp {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly passwordVisible = signal(false);
  protected readonly confirmationVisible = signal(false);
  protected readonly terms = signal(false);
  /** Спробували надіслати форму — тепер видно й помилку згоди з умовами. */
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Лист із кодом надіслано — крок підтвердження пошти. */
  protected readonly verifying = signal(false);

  protected readonly fullName = new FormField([required(tr('Введіть ім’я та прізвище'))]);
  protected readonly email = new FormField([
    required(tr('Введіть електронну пошту')),
    emailFormat(tr('Некоректна адреса електронної пошти')),
  ]);
  protected readonly password = new FormField([
    required(tr('Введіть пароль')),
    minLength(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
  ]);
  protected readonly confirmation = new FormField([
    required(tr('Повторіть пароль')),
    matches(() => this.password.value(), tr('Паролі не збігаються')),
  ]);

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected toggleConfirmationVisibility(): void {
    this.confirmationVisible.update((visible) => !visible);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.submitted.set(true);
    const valid = validateFields([this.fullName, this.email, this.password, this.confirmation]);
    if (this.busy() || !valid || !this.terms()) {
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
      const result = await this.auth.signUp(this.fullName.value().trim(), this.email.value().trim(), this.password.value());
      if (result.confirm) {
        this.verifying.set(true);
      } else {
        await this.router.navigate(['/home']);
      }
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Пошту підтвердили за посиланням із листа — лишається ввійти. */
  protected signInInstead(): void {
    void this.router.navigate(['/sign-in'], { state: { email: this.email.value().trim() } });
  }
}
