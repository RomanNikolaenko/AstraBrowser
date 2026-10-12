import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { PasswordPromptChoice, PasswordPromptRequest, PasswordsStore } from '../data/passwords';
import { hostname } from '../pages/internal-pages';
import { TranslatePipe } from '../../shared/i18n/i18n';

/**
 * «Зберегти пароль?» після входу на сайт (чи «Оновити пароль?», якщо для цього імені збережено інший).
 * Ім'я й пароль можна виправити перед збереженням. «Ніколи для цього сайту» більше не питатиме про цей сайт.
 * Кілька запитів поспіль — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon, UiInput],
  selector: 'app-password-prompt',
  styleUrl: './password-prompt.scss',
  templateUrl: './password-prompt.html',
})
export class PasswordPrompt {
  private readonly passwords = inject(PasswordsStore);
  private readonly injector = inject(Injector);

  /** Запит, який зараз показано. */
  protected readonly request = signal<PasswordPromptRequest | null>(null);
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly passwordVisible = signal(false);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly hostname = hostname;

  constructor() {
    // Наступний у черзі запит показується, щойно попередній вирішено.
    effect(() => {
      const next = this.passwords.prompts()[0] ?? null;
      untracked(() => {
        if (next?.id === this.request()?.id) {
          return;
        }
        this.request.set(next);
        if (next) {
          this.username.set(next.username);
          this.password.set(next.password);
          this.passwordVisible.set(false);
          afterNextRender(
            () => {
              const dialog = this.dialog().nativeElement;
              if (!dialog.open) {
                dialog.showModal?.();
              }
            },
            { injector: this.injector }
          );
        }
      });
    });
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.answer('save');
  }

  protected never(): void {
    this.answer('never');
  }

  protected dismiss(): void {
    this.answer('dismiss');
  }

  /** Esc чи клік повз вікно — «не зараз». */
  protected onClose(): void {
    if (this.request()) {
      this.answer('dismiss');
    }
  }

  private answer(choice: PasswordPromptChoice): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.request.set(null);
    this.dialog().nativeElement.close?.();
    const edited = choice === 'save' ? [this.username().trim(), this.password() || request.password] : [];
    void this.passwords.answer(request.id, choice, ...edited).catch(() => undefined);
  }
}
