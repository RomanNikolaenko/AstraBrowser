import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  booleanAttribute,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore, authErrorMessage } from '../../shared/auth/auth';
import { FormField, required, validateFields } from '../../shared/form-field/form-field';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { Cooldown, codeFormat, normalizeCode } from '../auth-forms';

/**
 * Крок «Підтвердіть пошту»: код із листа Supabase — і вхід у браузер. Код можна надіслати ще раз (не частіше,
 * ніж раз на хвилину, — так обмежує й Supabase). Якщо в листі лише посилання і за ним уже перейшли,
 * пошта підтверджена — лишається ввійти (`confirmed`).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiInput],
  selector: 'app-verify-email',
  styleUrl: '../auth.scss',
  templateUrl: './verify-email.html',
})
export class VerifyEmail implements OnInit {
  readonly email = input.required<string>();
  /** Лист щойно надіслано: «Надіслати ще раз» — після паузи. */
  readonly justSent = input(false, { transform: booleanAttribute });
  /** «Змінити пошту». */
  readonly back = output<void>();
  /** «Підтвердили за посиланням — увійдіть». */
  readonly confirmed = output<void>();

  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly code = new FormField([required('Введіть код із листа'), codeFormat]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly cooldown = new Cooldown();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cooldown.stop());
  }

  ngOnInit(): void {
    if (this.justSent()) {
      this.cooldown.start();
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !validateFields([this.code])) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.verify(this.email(), normalizeCode(this.code.value()));
      await this.router.navigate(['/home']);
    } catch (error) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend(): Promise<void> {
    if (this.cooldown.seconds() > 0) {
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    this.cooldown.start();
    try {
      await this.auth.resend(this.email());
      this.notice.set('Новий лист надіслано. Перевірте й папку «Спам».');
    } catch (error) {
      this.error.set(authErrorMessage(error));
    }
  }
}
