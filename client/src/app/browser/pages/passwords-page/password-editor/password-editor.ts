import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormField, required, urlFormat, validateFields } from '../../../../shared/form-field/form-field';
import { UiIcon } from '../../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../../shared/ui-input/ui-input';
import { PasswordsStore, SavedPassword, generatePassword } from '../../../data/passwords';
import { SiteIcon } from '../../../site-icon/site-icon';
import { hostname } from '../../internal-pages';

/**
 * Вікно «Додати пароль» / «Змінити пароль» сторінки «Паролі». Сайт задається лише при додаванні;
 * пароль можна показати й згенерувати. Помилку з Rust (такий запис уже є тощо) показує під полями.
 *
 * Відкривається з коду: `editor.add()` чи `editor.edit(entry)`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SiteIcon, UiIcon, UiInput],
  selector: 'app-password-editor',
  styleUrl: './password-editor.scss',
  templateUrl: './password-editor.html',
})
export class PasswordEditor {
  private readonly passwords = inject(PasswordsStore);

  /** Запис, який змінюють; null — додають новий. */
  protected readonly editing = signal<SavedPassword | null>(null);
  protected readonly site = new FormField([required('Введіть адресу сайту'), urlFormat('Некоректна адреса сайту')]);
  protected readonly username = signal('');
  protected readonly password = new FormField([required('Введіть пароль')]);
  protected readonly passwordVisible = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly siteInput = viewChild<UiInput>('siteInput');
  private readonly usernameInput = viewChild.required<UiInput>('usernameInput');

  protected readonly hostname = hostname;

  add(): void {
    this.open(null, '', '');
    setTimeout(() => this.siteInput()?.focus());
  }

  async edit(entry: SavedPassword): Promise<void> {
    const password = await this.passwords.reveal(entry.id).catch(() => '');
    this.open(entry, entry.username, password);
    setTimeout(() => this.usernameInput().focus());
  }

  protected generate(): void {
    this.password.value.set(generatePassword());
    this.passwordVisible.set(true);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const entry = this.editing();
    if (!validateFields(entry ? [this.password] : [this.site, this.password]) || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      if (entry) {
        await this.passwords.edit(entry.id, this.username(), this.password.value());
      } else {
        await this.passwords.add(this.site.value(), this.username(), this.password.value());
      }
      this.close();
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : 'Не вдалося зберегти пароль');
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close?.();
    this.onClose();
  }

  /** Esc чи клік повз вікно — нічого не змінюється, а введений пароль не лишається в полях. */
  protected onClose(): void {
    this.password.value.set('');
    this.passwordVisible.set(false);
  }

  private open(entry: SavedPassword | null, username: string, password: string): void {
    this.editing.set(entry);
    this.site.value.set('');
    this.username.set(username);
    this.password.value.set(password);
    for (const field of [this.site, this.password]) {
      field.touched.set(false);
    }
    this.passwordVisible.set(false);
    this.error.set(null);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
  }
}
