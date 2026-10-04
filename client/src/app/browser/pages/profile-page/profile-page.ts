import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PASSWORD_MIN_LENGTH } from '../../../auth/auth-forms';
import { AuthStore, authErrorMessage } from '../../../shared/auth/auth';
import { FormField, matches, minLength, required, validateFields } from '../../../shared/form-field/form-field';
import { resizeImage } from '../../../shared/images/resize-image';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { Avatar } from '../../avatar/avatar';
import { BookmarksStore } from '../../data/bookmarks';
import { bookmarksToHtml, countImported, parseBookmarksHtml } from '../../data/bookmarks-html';
import { HistoryStore } from '../../data/history';
import { NotesStore } from '../../data/notes';
import { PasswordsStore } from '../../data/passwords';
import { AVATAR_COLORS, ProfileStore } from '../../data/profile';
import { PageViews } from '../../page-views/page-views';
import { SyncService } from '../../sync/sync';

/** Розмір фото профілю: досить для великого аватара й не забагато для localStorage. */
const PHOTO_SIZE = 256;

const dateFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });
const dayTimeFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** «о 14:05» сьогодні, «4 жовтня о 14:05» — раніше. */
function syncedAt(time: number, now = new Date()): string {
  const date = new Date(time);
  return date.toDateString() === now.toDateString() ? `о ${timeFormat.format(date)}` : dayTimeFormat.format(date);
}

/** «Закладки 2026-10-04.html». */
function exportFileName(time = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Закладки ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}.html`;
}

/**
 * Сторінка «Керування профілем» (astra://profile): ім'я й аватар (фото чи колір з ініціалами), обліковий запис
 * (пошта, вихід, зміна пароля),
 * імпорт закладок з інших браузерів і експорт своїх, і скільки даних зберігає цей браузер.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, UiIcon, UiInput],
  selector: 'app-profile-page',
  styleUrls: ['../internal-page.scss', './profile-page.scss'],
  templateUrl: './profile-page.html',
})
export class ProfilePage {
  protected readonly profile = inject(ProfileStore);
  protected readonly bookmarks = inject(BookmarksStore);
  private readonly history = inject(HistoryStore);
  private readonly notes = inject(NotesStore);
  private readonly passwords = inject(PasswordsStore);
  private readonly pageViews = inject(PageViews);

  protected readonly colors = AVATAR_COLORS;
  protected readonly photoError = signal<string | null>(null);
  protected readonly bookmarksMessage = signal<{ readonly text: string; readonly error: boolean } | null>(null);

  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncService);
  protected readonly syncBusy = signal(false);
  protected readonly syncMessage = signal<string | null>(null);
  protected readonly syncPassword = new FormField([required('Введіть пароль облікового запису')]);

  protected readonly syncProblem = computed(() => !['idle', 'syncing'].includes(this.sync.status().state));
  protected readonly syncTitle = computed(() => {
    const status = this.sync.status();
    switch (status.state) {
      case 'syncing':
        return 'Синхронізуємо…';
      case 'offline':
        return 'Немає з’єднання';
      case 'not-configured':
        return 'Синхронізацію не налаштовано на сервері';
      case 'error':
        return 'Не вдалося синхронізувати';
      default:
        return status.at ? 'Синхронізовано' : 'Синхронізацію ввімкнено';
    }
  });
  protected readonly syncDetail = computed(() => {
    const status = this.sync.status();
    const last = status.at ? `Востаннє ${syncedAt(status.at)}. ` : '';
    switch (status.state) {
      case 'offline':
        return `${last}Синхронізуємо, щойно з’явиться інтернет.`;
      case 'not-configured':
        return 'У проєкті Supabase потрібно один раз виконати SQL із файла supabase/sync.sql.';
      case 'error':
        return `${last}${status.message ?? ''}`;
      default:
        return `${last}Закладки, нотатки, історія, профіль, налаштування й паролі сайтів — на всіх ваших комп’ютерах.`;
    }
  });
  protected readonly changingPassword = signal(false);
  protected readonly passwordBusy = signal(false);
  protected readonly passwordMessage = signal<{ readonly text: string; readonly error: boolean } | null>(null);
  protected readonly newPassword = new FormField([
    required('Введіть новий пароль'),
    minLength(PASSWORD_MIN_LENGTH, `Пароль має містити щонайменше ${PASSWORD_MIN_LENGTH} символів`),
  ]);
  protected readonly passwordConfirmation = new FormField([
    required('Повторіть пароль'),
    matches(() => this.newPassword.value(), 'Паролі не збігаються'),
  ]);

  protected readonly stats = computed(() => [
    { icon: 'star', label: 'Закладки', value: this.bookmarks.entries().length },
    { icon: 'key', label: 'Паролі', value: this.passwords.entries().length },
    { icon: 'notes', label: 'Нотатки', value: this.notes.entries().length },
    { icon: 'clock', label: 'Записи історії', value: this.history.entries().length },
  ]);

  protected async unlockSync(event: Event): Promise<void> {
    event.preventDefault();
    if (this.syncBusy() || !validateFields([this.syncPassword])) {
      return;
    }
    this.syncBusy.set(true);
    this.syncMessage.set(null);
    try {
      await this.auth.unlockSync(this.syncPassword.value());
      this.syncPassword.value.set('');
      this.syncPassword.touched.set(false);
      this.sync.syncNow();
    } catch (error) {
      this.syncMessage.set(authErrorMessage(error));
    } finally {
      this.syncBusy.set(false);
    }
  }

  protected signOut(): void {
    void this.auth.signOut();
  }

  protected startPasswordChange(): void {
    for (const field of [this.newPassword, this.passwordConfirmation]) {
      field.value.set('');
      field.touched.set(false);
    }
    this.passwordMessage.set(null);
    this.changingPassword.set(true);
  }

  protected async savePassword(event: Event): Promise<void> {
    event.preventDefault();
    if (this.passwordBusy() || !validateFields([this.newPassword, this.passwordConfirmation])) {
      return;
    }
    this.passwordBusy.set(true);
    this.passwordMessage.set(null);
    try {
      await this.auth.setPassword(this.newPassword.value());
      this.changingPassword.set(false);
      this.passwordMessage.set({ text: 'Пароль змінено.', error: false });
    } catch (error) {
      this.passwordMessage.set({ text: authErrorMessage(error), error: true });
    } finally {
      this.passwordBusy.set(false);
    }
  }

  protected async choosePhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.photoError.set(null);
    try {
      this.profile.photo.set(await resizeImage(file, PHOTO_SIZE, PHOTO_SIZE, 'cover'));
    } catch {
      this.photoError.set('Не вдалося відкрити це зображення. Виберіть фото у форматі JPEG, PNG чи WebP.');
    }
  }

  protected async importBookmarks(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    const items = parseBookmarksHtml(await file.text());
    const count = countImported(items);
    if (!count) {
      this.bookmarksMessage.set({ text: 'У файлі немає закладок, які можна імпортувати.', error: true });
      return;
    }
    this.bookmarks.importTree(`Імпорт ${dateFormat.format(new Date())}`, items);
    this.bookmarksMessage.set({ text: `Імпортовано закладок: ${count}. Вони в новій теці на панелі закладок.`, error: false });
  }

  protected async exportBookmarks(): Promise<void> {
    const html = new TextEncoder().encode(bookmarksToHtml(this.bookmarks.bar()));
    try {
      const path = await this.pageViews.saveFile(html, exportFileName(), 'html');
      if (path) {
        this.bookmarksMessage.set({ text: `Закладки збережено: ${path}`, error: false });
      }
    } catch {
      this.bookmarksMessage.set({ text: 'Не вдалося зберегти файл закладок.', error: true });
    }
  }
}
