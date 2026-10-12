import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore, authErrorMessage } from '../../shared/auth/auth';
import { FormField, emailFormat, matches, minLength, required, validateFields } from '../../shared/form-field/form-field';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { AuthLayout } from '../auth-layout/auth-layout';
import { Cooldown, PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT, codeFormat, emailFromNavigation, normalizeCode } from '../auth-forms';
import { tr, translate, TranslatePipe } from '../../shared/i18n/i18n';

/**
 * «Забули пароль?»: пошта → лист із кодом → код і новий пароль — і вхід. Supabase відповідає однаково, є такий
 * обліковий запис чи ні, тож і сторінка не каже, чи пошта зареєстрована.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, AuthLayout, RouterLink, UiIcon, UiInput],
  selector: 'app-forgot-password',
  styleUrl: '../auth.scss',
  templateUrl: './forgot-password.html',
})
export class ForgotPassword {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  /** Лист із кодом надіслано — крок нового пароля. */
  protected readonly codeSent = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly passwordVisible = signal(false);
  protected readonly cooldown = new Cooldown();

  protected readonly email = new FormField([
    required(tr('Введіть електронну пошту')),
    emailFormat(tr('Некоректна адреса електронної пошти')),
  ]);
  protected readonly code = new FormField([required(tr('Введіть код із листа')), codeFormat]);
  protected readonly password = new FormField([
    required(tr('Введіть новий пароль')),
    minLength(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
  ]);
  protected readonly confirmation = new FormField([
    required(tr('Повторіть пароль')),
    matches(() => this.password.value(), tr('Паролі не збігаються')),
  ]);

  constructor() {
    this.email.value.set(emailFromNavigation());
    inject(DestroyRef).onDestroy(() => this.cooldown.stop());
  }

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  protected async sendCode(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.busy() || this.cooldown.seconds() > 0 || !validateFields([this.email])) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.auth.recover(this.email.value().trim());
      if (this.codeSent()) {
        this.notice.set(translate('Новий лист надіслано. Перевірте й папку «Спам».'));
      }
      this.codeSent.set(true);
      this.cooldown.start();
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async reset(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !validateFields([this.code, this.password, this.confirmation])) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.auth.resetPassword(this.email.value().trim(), normalizeCode(this.code.value()), this.password.value());
      await this.router.navigate(['/home']);
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected changeEmail(): void {
    this.codeSent.set(false);
    this.error.set(null);
    this.notice.set(null);
  }
}
