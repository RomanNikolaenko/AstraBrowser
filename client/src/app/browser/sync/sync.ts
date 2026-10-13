import { DestroyRef, Injectable, computed, effect, inject, untracked } from '@angular/core';
import { commands } from '../../bindings';
import { listen } from '@tauri-apps/api/event';
import { AuthStore, isAuthError } from '../../shared/auth/auth';
import { BrowserWindows } from '../../shared/browser-windows/browser-windows';
import { SettingsStore } from '../../shared/settings/settings';
import { accountKey, accountSignal, onStoredChange } from '../../shared/storage/stored-signal';
import { SealedCollection, SyncCollection, syncCollections } from './sync-collections';
import { hashOf } from './sync-hash';

/** Рядок таблиці sync_items (supabase/sync.sql). */
export interface SyncRow {
  readonly collection: string;
  readonly id: string;
  readonly data: unknown;
  readonly deleted: boolean;
  readonly updated_at: number;
  readonly revision?: number | null;
}

/** Як іде синхронізація — для сторінки профілю (у всіх вікнах). */
export interface SyncStatus {
  readonly state: 'idle' | 'syncing' | 'offline' | 'not-configured' | 'error';
  /** Коли востаннє все синхронізовано (мс). */
  readonly at?: number;
  readonly message?: string;
  /**
   * Паролі сайтів і адреси (зашифровані): ok — синхронізуються; locked — немає ключа (сеанс давніший за
   * синхронізацію); stale — пароль облікового запису змінили на іншому комп'ютері, а тут ключ ще від старого.
   */
  readonly passwords: 'ok' | 'locked' | 'stale';
}

/** Що синхронізація пам'ятає між запусками: до якої ревізії все забрано і відбитки записів, які вже на сервері. */
interface SyncState {
  revision: number;
  /** Колекція → id → [відбиток, час зміни]. */
  base: Record<string, Record<string, [string, number]>>;
  /** Позначка ключа паролів на сервері: id ключа й коли його отримано з пароля (мс). */
  keyMarker?: { readonly id: string; readonly at: number };
  /** Зашифрована колекція → ключ, яким її востаннє синхронізували. */
  sealedKeys?: Record<string, string>;
  /** Ключ паролів у версіях до адрес — те саме, що sealedKeys.passwords. */
  passwordsKey?: string;
}

/** Скільки записів сервер віддає за раз (server/src/sync.rs) і скільки надсилати за раз. */
const PAGE = 500;
const PUSH_BATCH = 200;
/** Затримка після локальної зміни, звичайний інтервал і як часто питати сервер про ім'я облікового запису. */
const CHANGE_DELAY = 2000;
const INTERVAL = 60_000;
const USER_RELOAD_EVERY = 5;
/** Позначка ключа паролів: колекція й id запису. */
const KEYS_COLLECTION = 'keys';
const PASSWORDS_KEY_ITEM = 'passwords';

function emptyState(): SyncState {
  return { revision: 0, base: {} };
}

/**
 * Синхронізація даних облікового запису: закладки, нотатки, історія, профіль, налаштування, паролі сайтів і адреси
 * (останні два зашифровані на комп'ютері ключем із пароля облікового запису) — через таблицю sync_items у Supabase.
 *
 * Кожен запис колекції синхронізується окремо: що змінилося, видно з відбитків записів, які вже на сервері
 * (`base`). З двох змін одного запису перемагає пізніша (сервер приймає лише новішу й повертає відхилені).
 * Уперше для облікового запису на цьому комп'ютері спершу забирається все із сервера, а потім надсилається те,
 * чого там ще немає.
 *
 * Синхронізує одне вікно — те, що першим взяло блокування (Web Locks), інші лише показують стан і просять
 * синхронізувати зараз. Зміни з інших вікон видно через localStorage.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly auth = inject(AuthStore);
  private readonly windows = inject(BrowserWindows);
  private readonly settings = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);

  private readonly passwords = new SealedCollection(
    'passwords',
    () => commands.passwordsSyncItems(),
    (changes) => commands.passwordsSyncApply(changes)
  );
  private readonly sealed: readonly SealedCollection[] = [
    this.passwords,
    new SealedCollection(
      'addresses',
      () => commands.addressesSyncItems(),
      (changes) => commands.addressesSyncApply(changes)
    ),
  ];
  private readonly collections: readonly SyncCollection[] = syncCollections(this.settings, this.sealed);
  private readonly byName = new Map(this.collections.map((collection) => [collection.name, collection]));

  /** Стан синхронізації, спільний для вікон. */
  readonly status = accountSignal<SyncStatus>('astra.sync.status', { state: 'idle', passwords: 'ok' });
  /** Прохання «синхронізувати зараз» з будь-якого вікна. */
  private readonly request = accountSignal('astra.sync.request', 0);
  /** Синхронізація взагалі можлива: у застосунку, хтось увійшов, вікно не приватне й не гостьове. */
  readonly available = computed(
    () => this.auth.available && !!this.auth.user() && !this.windows.isPrivate && !this.windows.isGuest
  );

  private readonly stateKey = accountKey('astra.sync');
  private started = false;
  private leading = false;
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runs = 0;
  /**
   * Колекції, змінені тут після того, як їх востаннє надіслали: лише їх читають, порівнюють із сервером і надсилають.
   * Інакше кожен прохід (щохвилини й щоразу, як вікно отримує фокус) перебирав би всю історію й закладки. Спершу —
   * усі. Паролі й адреси — завжди: їх відбитки готові з Rust, а зміни приходять подіями.
   */
  private readonly changed = new Set(this.collections.map((collection) => collection.name));

  constructor() {
    const changedKeys = onStoredChange((key) => {
      for (const collection of this.collections) {
        if (collection.keys.includes(key)) {
          this.changed.add(collection.name);
        }
      }
    });
    this.destroyRef.onDestroy(changedKeys);
    effect(() => {
      this.request();
      untracked(() => {
        if (this.leading) {
          this.schedule(0);
        }
      });
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.timer));
  }

  /** Починає синхронізацію в цьому вікні (якщо це вікно її веде). Повторний виклик нічого не робить. */
  start(): void {
    if (this.started || !this.available()) {
      return;
    }
    this.started = true;
    const lead = () => this.lead();
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      void navigator.locks.request(this.stateKey, lead);
    } else {
      void lead();
    }
  }

  /** Синхронізувати зараз (з будь-якого вікна). */
  syncNow(): void {
    this.request.set(Date.now());
  }

  /** Веде синхронізацію, поки живе вікно: проміс не завершується, тож блокування тримається. */
  private lead(): Promise<void> {
    this.leading = true;
    const watched = new Set(this.collections.flatMap((collection) => collection.keys));
    const unsubscribe = onStoredChange((key) => {
      if (watched.has(key)) {
        this.schedule(CHANGE_DELAY);
      }
    });
    const sealedChanged = ['passwords://changed', 'addresses://changed'].map((event) =>
      listen(event, () => this.schedule(CHANGE_DELAY))
    );
    const interval = setInterval(() => this.schedule(0), INTERVAL);
    const onFocus = () => this.schedule(0);
    window.addEventListener('focus', onFocus);
    this.destroyRef.onDestroy(() => {
      unsubscribe();
      for (const changed of sealedChanged) {
        void changed.then((unlisten) => unlisten());
      }
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    });
    this.schedule(0);
    return new Promise(() => undefined);
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.sync();
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(CHANGE_DELAY);
      }
    }
  }

  /** Один прохід: (уперше — забрати все), паролі й адреси, надіслати змінене, забрати нове. */
  async sync(): Promise<void> {
    const state = this.loadState();
    this.setStatus({ state: 'syncing' });
    try {
      if (state.revision === 0 && !Object.keys(state.base).length) {
        await this.pull(state, { first: true });
      }
      const passwords = await this.preparePasswords(state);
      for (const collection of this.collections) {
        const due = this.isSealed(collection) ? passwords === 'ok' : this.changed.has(collection.name);
        if (due) {
          // Позначка знімається до читання: зміна посеред надсилання позначить колекцію наново.
          this.changed.delete(collection.name);
          try {
            await this.push(state, collection, passwords);
          } catch (error) {
            this.changed.add(collection.name);
            throw error;
          }
        }
      }
      await this.pull(state, { passwords });
      this.saveState(state);
      this.setStatus({ state: 'idle', at: Date.now(), passwords });
      if (this.runs++ % USER_RELOAD_EVERY === 0) {
        await this.auth.reloadUser().catch(() => undefined);
      }
    } catch (error) {
      this.saveState(state);
      const code = isAuthError(error) ? error.code : '';
      if (code === 'offline') {
        this.setStatus({ state: 'offline' });
      } else if (code === 'sync_not_configured') {
        this.setStatus({ state: 'not-configured' });
      } else {
        this.setStatus({ state: 'error', message: isAuthError(error) ? error.message : String(error) });
      }
    }
  }

  /**
   * Чи можна синхронізувати паролі й адреси. Їхній ключ — з пароля облікового запису; на сервері позначка, яким ключем
   * шифрують зараз. Інший ключ, давніший за позначку, — пароль облікового запису змінили деінде (stale); новіший —
   * змінили тут: позначка оновлюється, а паролі й адреси наново забираються й перешифровуються.
   */
  private async preparePasswords(state: SyncState): Promise<SyncStatus['passwords']> {
    for (const collection of this.sealed) {
      await collection.read();
    }
    const snapshot = this.passwords.snapshot;
    if (!snapshot?.keyId) {
      return 'locked';
    }
    const keyAt = snapshot.keyTime * 1000;
    const marker = state.keyMarker;
    if (marker && marker.id !== snapshot.keyId && keyAt <= marker.at) {
      return 'stale';
    }
    if (marker?.id !== snapshot.keyId) {
      const row: SyncRow = {
        collection: KEYS_COLLECTION,
        id: PASSWORDS_KEY_ITEM,
        data: { id: snapshot.keyId, at: keyAt },
        deleted: false,
        updated_at: keyAt,
      };
      const rejected = await commands.syncPush([row]);
      state.keyMarker = { id: snapshot.keyId, at: keyAt };
      await this.apply(state, rejected, { passwords: 'ok' });
      if (state.keyMarker.id !== snapshot.keyId) {
        return 'stale';
      }
    }
    const keys = (state.sealedKeys ??= state.passwordsKey ? { passwords: state.passwordsKey } : {});
    for (const collection of this.sealed) {
      if (keys[collection.name] !== snapshot.keyId) {
        // Новий ключ (чи колекція, якої тут ще не синхронізували): усе з сервера — наново (з ним прочитаються записи
        // інших комп'ютерів), а свої перешифруються.
        state.base[collection.name] = {};
        await this.pull(state, { first: true, collection: collection.name, passwords: 'ok' });
        keys[collection.name] = snapshot.keyId;
      }
    }
    state.passwordsKey = keys['passwords'];
    return 'ok';
  }

  /**
   * Записи, новіші за останню забрану ревізію (чи всі записи колекції `collection`). Паролі й адреси беруться, лише
   * якщо `passwords` — ok: інакше їх нічим розшифрувати (їх забере повне оновлення, щойно з'явиться ключ).
   */
  private async pull(
    state: SyncState,
    {
      first = false,
      collection,
      passwords = 'locked',
    }: { first?: boolean; collection?: string; passwords?: SyncStatus['passwords'] }
  ): Promise<void> {
    let after = collection ? 0 : state.revision;
    for (;;) {
      const rows = await commands.syncPull(after, collection ?? null);
      await this.apply(state, rows, { first, passwords });
      after = rows.reduce((last, row) => Math.max(last, row.revision ?? 0), after);
      if (!collection) {
        state.revision = after;
      }
      this.saveState(state);
      if (rows.length < PAGE) {
        return;
      }
    }
  }

  /**
   * Записи з сервера — у колекції. Запис, змінений тут і ще не надісланий, лишається (піде на сервер наступним
   * проходом); `first` — уперше: сервер перемагає. Паролі, яких не прочитати (інший ключ), не беруться, а свої
   * з тими самими id потім надсилаються наново.
   */
  private async apply(
    state: SyncState,
    rows: readonly SyncRow[],
    { first = false, passwords }: { first?: boolean; passwords: SyncStatus['passwords'] }
  ): Promise<void> {
    const groups = new Map<string, SyncRow[]>();
    for (const row of rows) {
      groups.set(row.collection, [...(groups.get(row.collection) ?? []), row]);
    }
    for (const [name, group] of groups) {
      if (name === KEYS_COLLECTION) {
        const marker = [...group].reverse().find((row) => row.id === PASSWORDS_KEY_ITEM && !row.deleted)?.data;
        if (marker) {
          state.keyMarker = marker as SyncState['keyMarker'];
        }
        continue;
      }
      const collection = this.byName.get(name);
      if (!collection || (this.isSealed(collection) && passwords !== 'ok')) {
        continue;
      }
      const base = (state.base[name] ??= {});
      const current = await collection.read();
      const changes = new Map<string, unknown>();
      for (const row of group) {
        const remote = row.deleted ? null : this.hash(collection, row.data);
        const known = base[row.id];
        if (known && known[0] === remote) {
          known[1] = Math.max(known[1], row.updated_at);
          continue;
        }
        const local = current.has(row.id) ? this.hash(collection, current.get(row.id)) : null;
        if (!first && local !== (known?.[0] ?? null)) {
          continue;
        }
        if (remote === null) {
          delete base[row.id];
        } else {
          base[row.id] = [remote, row.updated_at];
        }
        if (local !== remote) {
          changes.set(row.id, row.deleted ? null : row.data);
        }
      }
      if (changes.size) {
        for (const id of await collection.write(changes)) {
          delete base[id];
        }
      }
    }
  }

  /** Змінене тут — на сервер; що сервер відхилив (у нього новіше), приймається замість свого. */
  private async push(state: SyncState, collection: SyncCollection, passwords: SyncStatus['passwords']): Promise<void> {
    const current = await collection.read();
    const base = (state.base[collection.name] ??= {});
    const now = Date.now();
    const rows: SyncRow[] = [];
    for (const [id, data] of current) {
      const known = base[id];
      if (known?.[0] !== this.hash(collection, data)) {
        rows.push({ collection: collection.name, id, data, deleted: false, updated_at: Math.max(now, (known?.[1] ?? 0) + 1) });
      }
    }
    for (const [id, known] of Object.entries(base)) {
      if (!current.has(id)) {
        rows.push({ collection: collection.name, id, data: null, deleted: true, updated_at: Math.max(now, known[1] + 1) });
      }
    }
    for (let start = 0; start < rows.length; start += PUSH_BATCH) {
      const batch = rows.slice(start, start + PUSH_BATCH);
      const rejected = await commands.syncPush(batch);
      for (const row of batch) {
        if (row.deleted) {
          delete base[row.id];
        } else {
          base[row.id] = [this.hash(collection, row.data), row.updated_at];
        }
      }
      await this.apply(state, rejected, { passwords });
      this.saveState(state);
    }
  }

  private isSealed(collection: SyncCollection): boolean {
    return this.sealed.includes(collection as SealedCollection);
  }

  private hash(collection: SyncCollection, data: unknown): string {
    return collection.hash ? collection.hash(data) : hashOf(data);
  }

  /** Новий стан; паролі й час останньої синхронізації лишаються попередніми, поки їх не задано. */
  private setStatus(status: Pick<SyncStatus, 'state'> & Partial<SyncStatus>): void {
    this.status.update((current) => ({
      state: status.state,
      at: status.at ?? current.at,
      message: status.message,
      passwords: status.passwords ?? current.passwords,
    }));
  }

  private loadState(): SyncState {
    try {
      const raw = localStorage.getItem(this.stateKey);
      return raw ? { ...emptyState(), ...(JSON.parse(raw) as SyncState) } : emptyState();
    } catch {
      return emptyState();
    }
  }

  private saveState(state: SyncState): void {
    try {
      localStorage.setItem(this.stateKey, JSON.stringify(state));
    } catch {
      // Сховище переповнене: наступного разу частина записів просто надішлеться ще раз.
    }
  }
}
