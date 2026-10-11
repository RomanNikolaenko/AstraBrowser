import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { storedSignal } from '../../shared/storage/stored-signal';
import { SessionStore } from '../session/session';

/** Новіша версія застосунку (server/src/updates.rs). */
export interface AppUpdate {
  readonly version: string;
  /** Що нового. */
  readonly notes?: string | null;
}

interface UpdateState {
  readonly current: string;
  readonly available: AppUpdate | null;
}

interface UpdateProgress {
  readonly downloaded: number;
  readonly total: number | null;
}

/** Першу перевірку — трохи згодом після запуску, щоб не заважати відкриттю вкладок. */
const FIRST_CHECK = 10_000;
/** Далі — раз на кілька годин, поки браузер відкритий. */
const CHECK_EVERY = 4 * 60 * 60 * 1000;

/**
 * Оновлення Astra Browser: перевіряє, чи вийшла новіша версія, і встановлює її (завантаження, перевірка підпису,
 * інсталятор). Застосунок перезапуститься з тими самими вкладками.
 */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  /** Новіша версія, якщо вона є. */
  readonly available = signal<AppUpdate | null>(null);
  /** Версія, що працює зараз (відома після першої перевірки). */
  readonly current = signal<string | null>(null);
  /** Оновлення завантажується й встановлюється. */
  readonly installing = signal(false);
  /** Скільки завантажено, відсотки; null — розмір невідомий чи ще не почали. */
  readonly percent = signal<number | null>(null);
  /** Чому не вдалося встановити. */
  readonly error = signal<string | null>(null);
  readonly canInstall = computed(() => this.available() !== null && !this.installing());

  /** Версія, яку вже бачили в меню (на цьому комп'ютері; не синхронізується). */
  private readonly seenVersion = storedSignal<string | null>('astra.update-seen', null);
  /** Вийшла нова версія, а меню відтоді ще не відкривали: кнопка меню привертає увагу. */
  readonly attention = computed(() => {
    const update = this.available();
    return update !== null && !this.installing() && this.seenVersion() !== update.version;
  });

  private readonly session = inject(SessionStore);

  constructor() {
    if (!isTauri()) {
      return;
    }
    setTimeout(() => void this.check(), FIRST_CHECK);
    setInterval(() => void this.check(), CHECK_EVERY);
    void listen<UpdateProgress>('update://progress', ({ payload }) =>
      this.percent.set(payload.total ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100)) : null)
    );
  }

  /** Меню відкрили — про цю версію вже знають, навіть якщо не оновилися: кнопка меню більше не блимає. */
  markSeen(): void {
    const update = this.available();
    if (update) {
      this.seenVersion.set(update.version);
    }
  }

  async check(): Promise<void> {
    if (!isTauri() || this.installing()) {
      return;
    }
    try {
      const state = await invoke<UpdateState>('app_update_check');
      this.current.set(state.current);
      this.available.set(state.available);
    } catch {
      // Немає зв'язку чи сервер оновлень ще порожній — кнопка лишається вимкненою до наступної перевірки.
    }
  }

  async install(): Promise<void> {
    if (!this.canInstall()) {
      return;
    }
    this.installing.set(true);
    this.percent.set(null);
    this.error.set(null);
    // Після оновлення браузер відкриється з тими самими вкладками, навіть якщо в налаштуваннях — «Нова вкладка».
    this.session.restoreOnce();
    try {
      await invoke('app_update_install');
    } catch (error) {
      this.installing.set(false);
      this.error.set(typeof error === 'string' ? error : 'Не вдалося встановити оновлення.');
      // Знайдене оновлення встановлення забрало — шукаємо його знову, щоб можна було спробувати ще раз.
      await this.check();
    }
  }
}
