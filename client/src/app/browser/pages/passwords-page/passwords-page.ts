import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { PasswordSettings, PasswordsStore, SavedPassword } from '../../data/passwords';
import { SiteIcon } from '../../site-icon/site-icon';
import { hostname, matchesQuery } from '../internal-pages';
import { PasswordEditor } from './password-editor/password-editor';

/** Ті самі записи, але без `key`. */
function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/** Скільки показувати «Скопійовано» на кнопці копіювання. */
const COPIED_FOR = 1500;

/**
 * Сторінка «Паролі» (astra://passwords): збережені паролі сайтів — пошук, показ, копіювання, зміна й видалення,
 * додавання вручну, сайти «ніколи не зберігати» і налаштування збереження та автозаповнення.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, PasswordEditor, SiteIcon, UiIcon, UiInput],
  selector: 'app-passwords-page',
  styleUrls: ['../internal-page.scss', './passwords-page.scss'],
  templateUrl: './passwords-page.html',
})
export class PasswordsPage {
  protected readonly passwords = inject(PasswordsStore);

  protected readonly query = signal('');
  protected readonly filtered = computed(() =>
    this.passwords.entries().filter((entry) => matchesQuery(this.query(), entry.origin, entry.username))
  );
  /** Паролі, які зараз показано, — за id запису. */
  protected readonly revealed = signal<Readonly<Record<string, string>>>({});
  /** Запис, чий пароль щойно скопіювали. */
  protected readonly copied = signal<string | null>(null);
  /** Запис, про видалення якого питають. */
  protected readonly removing = signal<SavedPassword | null>(null);
  protected readonly removeMessage = computed(() => {
    const entry = this.removing();
    if (!entry) {
      return '';
    }
    const account = entry.username ? `«${entry.username}» на ${hostname(entry.origin)}` : hostname(entry.origin);
    return `Пароль для ${account} буде видалено з браузера. Скасувати це не вийде.`;
  });

  private readonly confirmRemove = viewChild.required<ConfirmDialog>('confirmRemove');
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly hostname = hostname;

  protected async toggle(entry: SavedPassword): Promise<void> {
    if (this.revealed()[entry.id] !== undefined) {
      this.revealed.update((revealed) => without(revealed, entry.id));
      return;
    }
    const password = await this.passwords.reveal(entry.id).catch(() => null);
    if (password !== null) {
      this.revealed.update((revealed) => ({ ...revealed, [entry.id]: password }));
    }
  }

  protected async copy(entry: SavedPassword): Promise<void> {
    const password = this.revealed()[entry.id] ?? (await this.passwords.reveal(entry.id).catch(() => null));
    if (password === null) {
      return;
    }
    await navigator.clipboard.writeText(password).catch(() => undefined);
    this.copied.set(entry.id);
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.copied.set(null), COPIED_FOR);
  }

  protected askRemove(entry: SavedPassword): void {
    this.removing.set(entry);
    this.confirmRemove().show();
  }

  protected remove(): void {
    const entry = this.removing();
    if (entry) {
      this.revealed.update((revealed) => without(revealed, entry.id));
      void this.passwords.remove(entry.id).catch(() => undefined);
    }
    this.removing.set(null);
  }

  protected allowSaving(origin: string): void {
    void this.passwords.allowSaving(origin).catch(() => undefined);
  }

  protected setSetting(key: keyof PasswordSettings, event: Event): void {
    const settings = this.passwords.settings();
    if (settings) {
      const value = (event.target as HTMLInputElement).checked;
      void this.passwords.setSettings({ ...settings, [key]: value }).catch(() => undefined);
    }
  }
}
