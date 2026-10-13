import { Envelope, SyncApplied, SyncChange, SyncItems as SealedItems } from '../../bindings';
import { SettingsStore } from '../../shared/settings/settings';
import { accountKey, storedSignalFor, writeStored } from '../../shared/storage/stored-signal';

/** Записи колекції: id → дані. */
export type SyncItems = ReadonlyMap<string, unknown>;

/**
 * Колекція, що синхронізується: як прочитати її записи тут і як прийняти записи з сервера. Записи порівнюються
 * за відбитком (`hash`, інакше — відбиток канонічного JSON).
 */
export interface SyncCollection {
  /** Назва колекції на сервері. */
  readonly name: string;
  /** Ключі localStorage, зміна яких — зміна колекції (тоді час синхронізувати). */
  readonly keys: readonly string[];
  read(): Promise<SyncItems>;
  /** Записи з сервера: id → дані, `null` — запис видалено. Повертає id записів, яких не вдалося прочитати. */
  write(changes: SyncItems): Promise<readonly string[]>;
  hash?(data: unknown): string;
}

/** Значення з localStorage — або із сигналу цього вікна, якщо він є: у ньому найсвіжіше. */
function readStored<T>(key: string, fallback: T): T {
  const signal = storedSignalFor<T>(key);
  if (signal) {
    return signal();
  }
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

interface Identified {
  readonly id: string;
}

/** Список записів з id (історія, нотатки): кожен запис синхронізується окремо. */
function listCollection(name: string, key: string): SyncCollection {
  return {
    name,
    keys: [key],
    read: () => Promise.resolve(new Map(readStored<readonly Identified[]>(key, []).map((item) => [item.id, item]))),
    write: (changes) => {
      const current = readStored<readonly Identified[]>(key, []);
      const next = current.flatMap((item) => {
        if (!changes.has(item.id)) {
          return [item];
        }
        const changed = changes.get(item.id);
        return changed === null ? [] : [changed as Identified];
      });
      for (const [id, data] of changes) {
        if (data !== null && !current.some((item) => item.id === id)) {
          next.push(data as Identified);
        }
      }
      writeStored(key, next);
      return Promise.resolve([]);
    },
  };
}

/** Окремі значення (колір аватара, мова перекладу…): id запису → ключ localStorage. */
function valuesCollection(name: string, keys: Readonly<Record<string, string>>): SyncCollection {
  const read = () => {
    const items = new Map<string, unknown>();
    for (const [id, key] of Object.entries(keys)) {
      const value = readStored<unknown>(key, undefined);
      if (value !== undefined) {
        items.set(id, value);
      }
    }
    return Promise.resolve(items);
  };
  return {
    name,
    keys: Object.values(keys),
    read,
    write: (changes) => {
      for (const [id, value] of changes) {
        const key = keys[id];
        if (key && value !== null) {
          writeStored(key, value);
        }
      }
      return Promise.resolve([]);
    },
  };
}

/** Закладка, тека чи роздільник як окремий запис: без вкладених, зате з текою й місцем у ній. */
export interface FlatBookmark {
  readonly type?: string;
  readonly title?: string;
  readonly url?: string;
  readonly color?: string;
  readonly parent: string | null;
  readonly index: number;
}

interface TreeItem {
  readonly id: string;
  readonly type?: string;
  readonly children?: readonly TreeItem[];
  readonly [field: string]: unknown;
}

/** Дерево закладок — окремими записами: тоді зміни різних закладок на різних комп'ютерах не затирають одна одну. */
export function flattenBookmarks(items: readonly TreeItem[], parent: string | null = null): Map<string, FlatBookmark> {
  const flat = new Map<string, FlatBookmark>();
  items.forEach((item, index) => {
    const { id, children, ...fields } = item;
    flat.set(id, { ...fields, parent, index });
    for (const [childId, child] of flattenBookmarks(children ?? [], id)) {
      flat.set(childId, child);
    }
  });
  return flat;
}

/** Дерево з окремих записів. Запис, чия тека зникла (чи тека «всередині себе»), стає на саму панель. */
export function buildBookmarks(flat: ReadonlyMap<string, FlatBookmark>): TreeItem[] {
  const byParent = new Map<string | null, string[]>();
  for (const [id, item] of flat) {
    const parent = item.parent !== null && flat.get(item.parent)?.type === 'folder' ? item.parent : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
  }
  const placed = new Set<string>();
  const order = (ids: readonly string[]) =>
    [...ids].sort((a, b) => (flat.get(a)?.index ?? 0) - (flat.get(b)?.index ?? 0) || a.localeCompare(b));
  // Чи вже поставлено, перевіряється для кожного запису окремо: тека могла забрати його собі щойно перед ним.
  const build = (ids: readonly string[]): TreeItem[] =>
    order(ids).flatMap((id) => {
      if (placed.has(id)) {
        return [];
      }
      placed.add(id);
      const fields: Record<string, unknown> = { ...flat.get(id) };
      delete fields['parent'];
      delete fields['index'];
      return [fields['type'] === 'folder' ? { id, ...fields, children: build(byParent.get(id) ?? []) } : { id, ...fields }];
    });
  const tree = build(byParent.get(null) ?? []);
  // Теки, що посилаються одна на одну, з панелі не досяжні — ставимо їх на панель.
  const lost = [...flat.keys()].filter((id) => !placed.has(id));
  return lost.length ? [...tree, ...build(lost)] : tree;
}

function bookmarksCollection(key: string): SyncCollection {
  return {
    name: 'bookmarks',
    keys: [key],
    read: () => Promise.resolve(flattenBookmarks(readStored<readonly TreeItem[]>(key, []))),
    write: (changes) => {
      const flat = flattenBookmarks(readStored<readonly TreeItem[]>(key, []));
      for (const [id, data] of changes) {
        if (data === null) {
          flat.delete(id);
        } else {
          flat.set(id, data as FlatBookmark);
        }
      }
      writeStored(key, buildBookmarks(flat));
      return Promise.resolve([]);
    },
  };
}

/** Налаштування облікового запису — через SettingsStore (самі значення в ключах пристрою). */
function settingsCollection(settings: SettingsStore): SyncCollection {
  return {
    name: 'settings',
    keys: settings.keys,
    read: () => Promise.resolve(new Map(Object.entries(settings.values()))),
    write: (changes) => {
      settings.apply(Object.fromEntries([...changes].filter(([, value]) => value !== null)));
      return Promise.resolve([]);
    },
  };
}

/** Зашифрований запис (passwords.rs, Envelope): `h` — відбиток відкритого тексту. */
interface SealedEnvelope {
  readonly h: string;
}

/** Записи зашифрованої колекції з Rust — уже зашифровані ключем облікового запису. */
export interface SealedSnapshot {
  readonly keyId: string | null;
  /** Коли ключ отримано з пароля облікового запису (секунди Unix). */
  readonly keyTime: number;
  readonly items: Readonly<Record<string, SealedEnvelope>>;
}

/**
 * Колекція, яку шифрує Rust ключем із пароля облікового запису: паролі сайтів (passwords.rs), адреси (addresses.rs)
 * і банківські картки (cards.rs).
 * Сервер бачить лише шифр. Зміни приходять подіями Rust, а не через localStorage.
 */
export class SealedCollection implements SyncCollection {
  readonly keys: readonly string[] = [];
  /** Останнє прочитане: ключ і записи. */
  snapshot: SealedSnapshot | null = null;

  constructor(
    readonly name: string,
    private readonly items: () => Promise<SealedItems>,
    private readonly apply: (changes: SyncChange[]) => Promise<SyncApplied>
  ) {}

  async read(): Promise<SyncItems> {
    this.snapshot = await this.items();
    return new Map(Object.entries(this.snapshot.items));
  }

  async write(changes: SyncItems): Promise<readonly string[]> {
    // Записи — конверти, які зашифрував Rust.
    const list = [...changes].map(([id, data]) => ({ id, data: data as Envelope | null }));
    const result = await this.apply(list);
    return result.unreadable;
  }

  hash(data: unknown): string {
    return (data as SealedEnvelope).h;
  }
}

/** Усе, що синхронізується з обліковим записом. Ключі — того облікового запису, що ввійшов зараз. */
export function syncCollections(settings: SettingsStore, sealed: readonly SealedCollection[]): SyncCollection[] {
  return [
    bookmarksCollection(accountKey('astra.bookmarks')),
    listCollection('notes', accountKey('astra.notes')),
    listCollection('history', accountKey('astra.history')),
    valuesCollection('profile', {
      color: accountKey('astra.profile.color'),
      photo: accountKey('astra.profile.photo'),
    }),
    valuesCollection('preferences', {
      blockAudio: accountKey('astra.autoplay.block-audio'),
      allowAutoplay: accountKey('astra.autoplay.allow'),
      translateLanguage: accountKey('astra.translate.language'),
      trackingExceptions: accountKey('astra.tracking.exceptions'),
      popupsAllowed: accountKey('astra.popups.allowed'),
      externalApps: accountKey('astra.external.allowed'),
    }),
    settingsCollection(settings),
    ...sealed,
  ];
}
