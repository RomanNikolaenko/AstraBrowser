import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { BrowserWindows } from '../browser-windows/browser-windows';
import { SettingsStore } from '../settings/settings';
import { adoptLegacyData, setStorageAccount } from '../storage/stored-signal';

/** Користувач облікового запису Astra Browser. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  /** Ім'я з облікового запису; порожнє, якщо не вказали. */
  readonly name: string;
}

interface AuthState {
  readonly user: AuthUser | null;
  /** Перший обліковий запис на цьому комп'ютері: йому дісталися дані, що були тут до облікових записів. */
  readonly owner?: boolean;
  /** Паролі сайтів можна синхронізувати: є ключ із пароля облікового запису. */
  readonly syncUnlocked?: boolean;
}

export interface SignUpResult {
  /** Користувач, якщо вхід уже відбувся (підтвердження пошти вимкнено). */
  readonly user: AuthUser | null;
  /** На пошту надіслано лист із кодом підтвердження. */
  readonly confirm: boolean;
}

/** Помилка з server/src/auth.rs: код Supabase (чи offline, server) і повідомлення для людини. */
export interface AuthError {
  readonly code: string;
  readonly message: string;
}

/**
 * Повне перезавантаження вікна на адресу: після виходу з облікового запису в пам'яті не має лишитися його даних
 * (сховища даних створюються наново вже для наступного облікового запису).
 */
export const RELOAD_PAGE = new InjectionToken<(url: string) => void>('RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => (url) => window.location.assign(url),
});

/** Сторінки для тих, хто не ввійшов: з них після входу — у браузер. */
const SIGNED_OUT_PAGES = ['/sign-in', '/sign-up', '/forgot-password'];

export function isAuthError(error: unknown): error is AuthError {
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

/** Текст помилки для форми. */
export function authErrorMessage(error: unknown): string {
  return isAuthError(error) ? error.message : 'Не вдалося виконати дію. Спробуйте ще раз.';
}

/**
 * Обліковий запис: хто ввійшов і дії входу, реєстрації та відновлення пароля. Самі запити до Supabase й токени
 * сеансу — у server/src/auth.rs; тут лише користувач. Вхід чи вихід в одному вікні бачать усі вікна (auth://changed):
 * після виходу звичайні вікна перезавантажуються на сторінку входу, а приватні й гостьові закриваються.
 *
 * У кожного облікового запису свої дані (закладки, історія, нотатки…): щойно відомо, хто ввійшов, сховища
 * перемикаються на його ключі (stored-signal.ts), а першому обліковому запису на комп'ютері дістаються дані,
 * що були тут до облікових записів.
 *
 * Поза Tauri (ng serve у звичайному браузері) облікових записів немає: `available` — false, і браузер відкритий.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  readonly available = isTauri();
  readonly user = signal<AuthUser | null>(null);
  readonly owner = signal(false);
  /** Є ключ для синхронізації паролів сайтів; інакше треба ще раз ввести пароль облікового запису. */
  readonly syncUnlocked = signal(false);
  /** Виконується, щойно відомо, чи хтось увійшов. */
  readonly ready: Promise<void>;

  private readonly router = inject(Router);
  private readonly windows = inject(BrowserWindows);
  private readonly settings = inject(SettingsStore);
  private readonly reload = inject(RELOAD_PAGE);

  constructor() {
    this.ready = this.available ? this.load() : Promise.resolve();
  }

  async signIn(email: string, password: string, remember: boolean): Promise<void> {
    this.apply(await invoke<AuthState>('auth_sign_in', { email, password, remember }));
  }

  async signUp(name: string, email: string, password: string): Promise<SignUpResult> {
    const result = await invoke<SignUpResult>('auth_sign_up', { name, email, password });
    if (result.user) {
      // Відповідь реєстрації не каже, чи це власник і чи є ключ синхронізації, — питаємо стан окремо.
      this.apply(await invoke<AuthState>('auth_state'));
    }
    return result;
  }

  /** Код із листа «Підтвердіть пошту» — і вхід. */
  async verify(email: string, code: string): Promise<void> {
    this.apply(await invoke<AuthState>('auth_verify', { email, code }));
  }

  /** Новий лист із кодом підтвердження. */
  resend(email: string): Promise<void> {
    return invoke('auth_resend', { email });
  }

  /** Лист із кодом відновлення пароля. */
  recover(email: string): Promise<void> {
    return invoke('auth_recover', { email });
  }

  /** Код відновлення й новий пароль — і вхід. */
  async resetPassword(email: string, code: string, password: string): Promise<void> {
    this.apply(await invoke<AuthState>('auth_reset_password', { email, code, password }));
  }

  /** Новий пароль для того, хто вже ввійшов. */
  async setPassword(password: string): Promise<void> {
    await invoke('auth_set_password', { password });
    this.apply(await invoke<AuthState>('auth_state'));
  }

  /** Пароль облікового запису ще раз — щоб синхронізувати паролі сайтів. */
  async unlockSync(password: string): Promise<void> {
    this.apply(await invoke<AuthState>('auth_unlock_sync', { password }));
  }

  /** Нове ім'я — в обліковий запис (його побачать інші комп'ютери). */
  async updateName(name: string): Promise<void> {
    this.apply(await invoke<AuthState>('auth_update_name', { name }));
  }

  /** Свіжі дані облікового запису з сервера (ім'я могли змінити на іншому комп'ютері). */
  async reloadUser(): Promise<void> {
    this.apply(await invoke<AuthState>('auth_reload_user'));
  }

  async signOut(): Promise<void> {
    if (!this.available) {
      await this.router.navigate(['/sign-in']);
      return;
    }
    await invoke('auth_sign_out');
    this.apply({ user: null });
  }

  private async load(): Promise<void> {
    try {
      await listen<AuthState>('auth://changed', (event) => this.apply(event.payload));
      this.apply(await invoke<AuthState>('auth_state'));
    } catch {
      this.user.set(null);
    }
  }

  private apply(state: AuthState): void {
    const previous = this.user();
    const user = state.user;
    this.owner.set(!!state.owner);
    this.syncUnlocked.set(!!state.syncUnlocked);
    if (user && previous?.id !== user.id) {
      // Спершу сховища — на дані цього облікового запису, потім уже все інше.
      if (state.owner) {
        adoptLegacyData(user.id);
      }
      setStorageAccount(user.id);
      this.settings.useAccount(user.id);
    }
    this.user.set(user);
    if (user && !previous) {
      // Увійшли в іншому вікні — це вікно теж іде зі сторінки входу в браузер.
      if (SIGNED_OUT_PAGES.some((page) => this.router.url.startsWith(page))) {
        void this.router.navigate(['/home']);
      }
    } else if (!user && previous) {
      setStorageAccount(null);
      if (this.windows.isPrivate || this.windows.isGuest) {
        void this.windows.closeCurrent();
      } else {
        this.reload('/sign-in');
      }
    }
  }
}

/** Браузер — лише тим, хто ввійшов; решту — на сторінку входу. */
export const signedInGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ready;
  return !auth.available || auth.user() ? true : router.createUrlTree(['/sign-in']);
};

/** Вхід і реєстрація — лише тим, хто ще не ввійшов; решту — у браузер. */
export const signedOutGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ready;
  return auth.user() ? router.createUrlTree(['/home']) : true;
};
