import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Cooldown, PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT, codeFormat, normalizeCode } from '../../../auth/auth-forms';
import { AuthStore, authErrorMessage } from '../../../shared/auth/auth';
import { BrowserWindows } from '../../../shared/browser-windows/browser-windows';
import { FormField, emailFormat, matches, minLength, required, validateFields } from '../../../shared/form-field/form-field';
import { resizeImage } from '../../../shared/images/resize-image';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { Avatar } from '../../avatar/avatar';
import { clearSiteData } from '../../clear-data/clear-data-dialog';
import { BookmarksStore } from '../../data/bookmarks';
import { bookmarksToHtml, countImported, parseBookmarksHtml } from '../../data/bookmarks-html';
import { HistoryStore } from '../../data/history';
import { NotesStore } from '../../data/notes';
import { AddressesStore } from '../../data/addresses';
import { CardsStore } from '../../data/cards';
import { PasswordsStore } from '../../data/passwords';
import { AVATAR_COLORS, ProfileStore } from '../../data/profile';
import { PageViews } from '../../page-views/page-views';
import { SyncService } from '../../sync/sync';
import { formatDate, tr, translate, TranslatePipe } from '../../../shared/i18n/i18n';

/** Розмір фото профілю: досить для великого аватара й не забагато для localStorage. */
const PHOTO_SIZE = 256;

/** Видалення облікового запису чистить у WebView2 все — за весь час. */
const ALL_SITE_DATA = { siteData: true, cache: true, history: true, autofill: true, settings: true };

type Message = { readonly text: string; readonly error: boolean } | null;

/** «о 14:05» сьогодні, «4 жовтня о 14:05» — раніше. */
function syncedAt(time: number, now = new Date()): string {
  const date = new Date(time);
  return date.toDateString() === now.toDateString()
    ? translate('о {0}', [formatDate(date, { hour: '2-digit', minute: '2-digit' })])
    : formatDate(date, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** «Закладки 2026-10-04.html». */
function exportFileName(time = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return translate('Закладки {0}.html', [`${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`]);
}

/**
 * Сторінка «Керування профілем» (astra://profile): ім'я й аватар (фото чи колір з ініціалами), обліковий запис
 * (вихід, зміна пошти й пароля, видалення), імпорт закладок з інших браузерів і експорт своїх, і скільки даних
 * зберігає цей браузер.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, Avatar, UiIcon, UiInput],
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
  private readonly addresses = inject(AddressesStore);
  private readonly cards = inject(CardsStore);
  private readonly pageViews = inject(PageViews);
  private readonly windows = inject(BrowserWindows);

  protected readonly colors = AVATAR_COLORS;
  protected readonly photoError = signal<string | null>(null);
  protected readonly bookmarksMessage = signal<{ readonly text: string; readonly error: boolean } | null>(null);

  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncService);
  protected readonly syncBusy = signal(false);
  protected readonly syncMessage = signal<string | null>(null);
  protected readonly syncPassword = new FormField([required(tr('Введіть пароль облікового запису'))]);

  protected readonly syncProblem = computed(() => !['idle', 'syncing'].includes(this.sync.status().state));
  protected readonly syncTitle = computed(() => {
    const status = this.sync.status();
    switch (status.state) {
      case 'syncing':
        return translate('Синхронізуємо…');
      case 'offline':
        return translate('Немає з’єднання');
      case 'not-configured':
        return translate('Синхронізацію не налаштовано на сервері');
      case 'error':
        return translate('Не вдалося синхронізувати');
      default:
        return status.at ? translate('Синхронізовано') : translate('Синхронізацію ввімкнено');
    }
  });
  protected readonly syncDetail = computed(() => {
    const status = this.sync.status();
    const last = status.at ? translate('Востаннє {0}. ', [syncedAt(status.at)]) : '';
    switch (status.state) {
      case 'offline':
        return last + translate('Синхронізуємо, щойно з’явиться інтернет.');
      case 'not-configured':
        return translate('У проєкті Supabase потрібно один раз виконати SQL із файла supabase/sync.sql.');
      case 'error':
        return `${last}${status.message ?? ''}`;
      default:
        return last + translate('Закладки, нотатки, історія, профіль, налаштування й паролі сайтів — на всіх ваших комп’ютерах.');
    }
  });
  protected readonly changingPassword = signal(false);
  protected readonly passwordBusy = signal(false);
  protected readonly passwordMessage = signal<{ readonly text: string; readonly error: boolean } | null>(null);
  protected readonly newPassword = new FormField([
    required(tr('Введіть новий пароль')),
    minLength(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
  ]);
  protected readonly passwordConfirmation = new FormField([
    required(tr('Повторіть пароль')),
    matches(() => this.newPassword.value(), tr('Паролі не збігаються')),
  ]);

  /** Зміна пошти: спершу нова адреса, потім коди з листів. */
  protected readonly emailStep = signal<'closed' | 'email' | 'code'>('closed');
  protected readonly emailBusy = signal(false);
  protected readonly emailMessage = signal<Message>(null);
  /** На яку адресу прийшов код, якого чекаємо; `partial` — перший із двох кодів уже прийнято. */
  protected readonly emailWaiting = signal({ address: '', partial: false });
  protected readonly emailCooldown = new Cooldown();
  protected readonly newEmail = new FormField([
    required(tr('Введіть нову пошту')),
    emailFormat(tr('Некоректна адреса електронної пошти')),
    (value) =>
      value.trim().toLowerCase() === this.auth.user()?.email.toLowerCase()
        ? translate('Це вже пошта вашого облікового запису')
        : null,
  ]);
  protected readonly emailCode = new FormField([required(tr('Введіть код із листа')), codeFormat]);

  /** Видаляти обліковий запис — лише зі звичайного вікна: приватне й гостьове мають власні дані. */
  protected readonly canDeleteAccount = !this.windows.isPrivate && !this.windows.isGuest;
  protected readonly deletingAccount = signal(false);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<string | null>(null);
  protected readonly deletePassword = new FormField([required(tr('Введіть пароль облікового запису'))]);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.emailCooldown.stop());
  }

  protected readonly stats = computed(() => [
    { icon: 'star', label: translate('Закладки'), value: this.bookmarks.entries().length },
    { icon: 'key', label: translate('Паролі'), value: this.passwords.entries().length },
    { icon: 'location', label: translate('Адреси'), value: this.addresses.entries().length },
    { icon: 'card', label: translate('Банківські картки'), value: this.cards.entries().length },
    { icon: 'notes', label: translate('Нотатки'), value: this.notes.entries().length },
    { icon: 'clock', label: translate('Записи історії'), value: this.history.entries().length },
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
      this.passwordMessage.set({ text: translate('Пароль змінено.'), error: false });
    } catch (error) {
      this.passwordMessage.set({ text: authErrorMessage(error), error: true });
    } finally {
      this.passwordBusy.set(false);
    }
  }

  protected startEmailChange(): void {
    for (const field of [this.newEmail, this.emailCode]) {
      field.value.set('');
      field.touched.set(false);
    }
    this.emailMessage.set(null);
    this.emailStep.set('email');
  }

  protected cancelEmailChange(): void {
    this.emailStep.set('closed');
    this.emailMessage.set(null);
  }

  /** Лист із кодом на нову пошту — і повторний, з кроку коду. */
  protected async sendEmailCode(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.emailBusy() || this.emailCooldown.seconds() > 0 || !validateFields([this.newEmail])) {
      return;
    }
    const resend = this.emailStep() === 'code';
    const email = this.newEmail.value().trim();
    this.emailBusy.set(true);
    this.emailMessage.set(null);
    try {
      await this.auth.changeEmail(email);
      // Нові листи — нові коди: Supabase знову чекає всіх.
      this.emailWaiting.set({ address: email, partial: false });
      this.emailCode.value.set('');
      this.emailCode.touched.set(false);
      this.emailStep.set('code');
      this.emailCooldown.start();
      if (resend) {
        this.emailMessage.set({ text: translate('Новий лист надіслано. Перевірте й папку «Спам».'), error: false });
      }
    } catch (error) {
      this.emailMessage.set({ text: authErrorMessage(error), error: true });
    } finally {
      this.emailBusy.set(false);
    }
  }

  protected async confirmEmailCode(event: Event): Promise<void> {
    event.preventDefault();
    if (this.emailBusy() || !validateFields([this.emailCode])) {
      return;
    }
    const email = this.newEmail.value().trim();
    this.emailBusy.set(true);
    this.emailMessage.set(null);
    try {
      const waiting = await this.auth.confirmEmailChange(email, normalizeCode(this.emailCode.value()));
      this.emailCode.value.set('');
      this.emailCode.touched.set(false);
      if (waiting) {
        this.emailWaiting.set({ address: waiting, partial: true });
      } else {
        this.emailStep.set('closed');
        this.emailMessage.set({ text: translate('Пошту змінено. Тепер входьте з {0}.', [email]), error: false });
      }
    } catch (error) {
      this.emailMessage.set({ text: authErrorMessage(error), error: true });
    } finally {
      this.emailBusy.set(false);
    }
  }

  protected startAccountDeletion(): void {
    this.deletePassword.value.set('');
    this.deletePassword.touched.set(false);
    this.deleteError.set(null);
    this.deletingAccount.set(true);
  }

  /** Видалення облікового запису: на сервері, а потім — його дані на цьому комп'ютері; далі вікно перезавантажиться. */
  protected async deleteAccount(event: Event): Promise<void> {
    event.preventDefault();
    if (this.deleteBusy() || !validateFields([this.deletePassword])) {
      return;
    }
    this.deleteBusy.set(true);
    this.deleteError.set(null);
    const visited = this.history.entries().map((entry) => entry.url);
    try {
      await this.auth.deleteAccount(this.deletePassword.value(), () => clearSiteData(ALL_SITE_DATA, 0, visited));
    } catch (error) {
      this.deleteError.set(authErrorMessage(error));
      this.deleteBusy.set(false);
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
      this.photoError.set(translate('Не вдалося відкрити це зображення. Виберіть фото у форматі JPEG, PNG чи WebP.'));
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
      this.bookmarksMessage.set({ text: translate('У файлі немає закладок, які можна імпортувати.'), error: true });
      return;
    }
    const date = formatDate(new Date(), { day: 'numeric', month: 'long', year: 'numeric' });
    this.bookmarks.importTree(translate('Імпорт {0}', [date]), items);
    this.bookmarksMessage.set({
      text: translate('Імпортовано закладок: {0}. Вони в новій теці на панелі закладок.', [count]),
      error: false,
    });
  }

  protected async exportBookmarks(): Promise<void> {
    const html = new TextEncoder().encode(bookmarksToHtml(this.bookmarks.bar()));
    try {
      const path = await this.pageViews.saveFile(html, exportFileName(), 'html');
      if (path) {
        this.bookmarksMessage.set({ text: translate('Закладки збережено: {0}', [path]), error: false });
      }
    } catch {
      this.bookmarksMessage.set({ text: translate('Не вдалося зберегти файл закладок.'), error: true });
    }
  }
}
