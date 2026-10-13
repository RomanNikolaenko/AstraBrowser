import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { SettingsStore } from '../../shared/settings/settings';
import { SyncRow, SyncService } from './sync';

/** Таблиця sync_items і функція sync_push у пам'яті — як у supabase/sync.sql. */
class FakeServer {
  private readonly rows = new Map<string, SyncRow & { readonly revision: number }>();
  private revision = 0;

  item(collection: string, id: string): SyncRow | undefined {
    return this.rows.get(`${collection}/${id}`);
  }

  /** Зміна з іншого комп'ютера. */
  write(collection: string, id: string, data: unknown, updatedAt: number, deleted = false): void {
    this.rows.set(`${collection}/${id}`, { collection, id, data, deleted, updated_at: updatedAt, revision: ++this.revision });
  }

  pull(after: number, collection: string | null): SyncRow[] {
    return [...this.rows.values()]
      .filter((row) => row.revision > after && (!collection || row.collection === collection))
      .sort((a, b) => a.revision - b.revision)
      .slice(0, 500);
  }

  push(items: readonly SyncRow[]): SyncRow[] {
    const rejected: SyncRow[] = [];
    for (const item of items) {
      const current = this.item(item.collection, item.id);
      if (current && current.updated_at >= item.updated_at) {
        rejected.push(current);
      } else {
        this.write(item.collection, item.id, item.data, item.updated_at, item.deleted);
      }
    }
    return rejected;
  }
}

const note = (id: string, text: string) => ({ id, title: '', text, pinned: false, created: 1, updated: 1 });
const notesHere = () =>
  (JSON.parse(localStorage.getItem('astra.notes') ?? '[]') as { id: string; text: string }[]).map(
    (item) => `${item.id}:${item.text}`
  );

/** Зміна тут — як із вікна застосунку: значення в localStorage і подія storage. */
function changeHere(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(value) }));
}

describe('SyncService', () => {
  let server: FakeServer;
  let sync: SyncService;
  let calls: string[];

  beforeEach(() => {
    localStorage.clear();
    server = new FakeServer();
    calls = [];
    mockIPC((command, args) => {
      calls.push(command);
      const payload = args as { after: number; collection: string | null; items: SyncRow[] };
      switch (command) {
        case 'sync_pull':
          return server.pull(payload.after, payload.collection);
        case 'sync_push':
          return server.push(payload.items);
        case 'passwords_sync_items':
        case 'addresses_sync_items':
        case 'cards_sync_items':
          // Сеанс без ключа: паролі, адреси й картки не синхронізуються, поки не введуть пароль облікового запису.
          return { keyId: null, keyTime: 0, items: {} };
        case 'auth_reload_user':
          return { user: null };
        default:
          return null;
      }
    });
    sync = TestBed.inject(SyncService);
  });

  afterEach(() => {
    clearMocks();
    localStorage.clear();
  });

  it('should send what is here the first time and take what other computers changed later', async () => {
    localStorage.setItem('astra.notes', JSON.stringify([note('n1', 'Перша')]));
    localStorage.setItem(
      'astra.bookmarks',
      JSON.stringify([
        {
          type: 'folder',
          id: 'f1',
          title: 'Робота',
          children: [{ type: 'bookmark', id: 'b1', title: 'Пошта', url: 'https://mail.example.com' }],
        },
      ])
    );

    await sync.sync();

    expect(server.item('notes', 'n1')?.data).toEqual(note('n1', 'Перша'));
    expect(server.item('bookmarks', 'b1')?.data).toEqual({
      type: 'bookmark',
      title: 'Пошта',
      url: 'https://mail.example.com',
      parent: 'f1',
      index: 0,
    });
    expect(server.item('settings', 'theme')?.data).toBe('system');
    expect(sync.status()).toEqual(expect.objectContaining({ state: 'idle', passwords: 'locked' }));

    server.write('notes', 'n2', note('n2', 'З ноутбука'), Date.now() + 1000);
    server.write(
      'bookmarks',
      'b1',
      { type: 'bookmark', title: 'Пошта (нова)', url: 'https://mail.example.com', parent: 'f1', index: 0 },
      Date.now() + 1000
    );
    await sync.sync();

    expect(notesHere()).toEqual(['n1:Перша', 'n2:З ноутбука']);
    const [folder] = JSON.parse(localStorage.getItem('astra.bookmarks') ?? '[]') as { children: { title: string }[] }[];
    expect(folder.children[0].title).toBe('Пошта (нова)');
  });

  it('should take what is on the server first when this computer syncs for the first time', async () => {
    server.write('settings', 'theme', 'dark', 1000);
    server.write('notes', 'n1', note('n1', 'З хмари'), 1000);
    localStorage.setItem('astra.notes', JSON.stringify([note('n2', 'Тутешня')]));

    await sync.sync();

    // Стандартна тема цього комп'ютера не затирає вибрану в обліковому записі, а нотатки з обох місць лишаються.
    expect(TestBed.inject(SettingsStore).theme()).toBe('dark');
    expect(server.item('settings', 'theme')?.data).toBe('dark');
    expect(notesHere()).toEqual(['n2:Тутешня', 'n1:З хмари']);
    expect(server.item('notes', 'n2')).toBeDefined();
  });

  it('should send deletions and keep the later of two changes to the same note', async () => {
    localStorage.setItem('astra.notes', JSON.stringify([note('n1', 'Перша'), note('n2', 'Друга')]));
    await sync.sync();

    // Тут видалили n1 і змінили n2, а на іншому комп'ютері n2 змінили пізніше.
    changeHere('astra.notes', [note('n2', 'Друга (тут)')]);
    server.write('notes', 'n2', note('n2', 'Друга (там, пізніше)'), Date.now() + 60_000);
    await sync.sync();

    expect(server.item('notes', 'n1')?.deleted).toBe(true);
    expect(notesHere()).toEqual(['n2:Друга (там, пізніше)']);
  });

  it('should read and send only what changed here since the last run', async () => {
    localStorage.setItem('astra.notes', JSON.stringify([note('n1', 'Перша')]));
    await sync.sync();
    const pushes = () => calls.filter((command) => command === 'sync_push').length;
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const notesRead = () => read.mock.calls.filter(([key]) => key === 'astra.notes').length;
    const before = pushes();

    // Нічого не змінилося — прохід лише питає сервер: нотатки навіть не читаються.
    await sync.sync();
    expect(notesRead()).toBe(0);
    expect(pushes()).toBe(before);

    changeHere('astra.notes', [note('n1', 'Перша (змінена)')]);
    read.mockClear();
    await sync.sync();
    expect(notesRead()).toBeGreaterThan(0);
    expect(pushes()).toBe(before + 1);
    expect(server.item('notes', 'n1')?.data).toEqual(note('n1', 'Перша (змінена)'));
  });

  it('should sync addresses encrypted with the passwords key and take all of them the first time', async () => {
    const envelope = (h: string) => ({ k: 'k1', n: 'n', c: 'c', h });
    const addresses: Record<string, unknown> = { a1: envelope('h1') };
    const applied: unknown[] = [];
    clearMocks();
    mockIPC((command, args) => {
      const payload = args as {
        after: number;
        collection: string | null;
        items: SyncRow[];
        changes: { id: string; data: unknown }[];
      };
      switch (command) {
        case 'sync_pull':
          return server.pull(payload.after, payload.collection);
        case 'sync_push':
          return server.push(payload.items);
        case 'passwords_sync_items':
        case 'cards_sync_items':
          return { keyId: 'k1', keyTime: 1, items: {} };
        case 'addresses_sync_items':
          return { keyId: 'k1', keyTime: 1, items: { ...addresses } };
        case 'addresses_sync_apply':
          for (const change of payload.changes) {
            applied.push(change);
            addresses[change.id] = change.data;
          }
          return { unreadable: [] };
        case 'passwords_sync_apply':
        case 'cards_sync_apply':
          return { unreadable: [] };
        case 'auth_reload_user':
          return { user: null };
        default:
          return null;
      }
    });
    // Цей комп'ютер синхронізував паролі цим ключем ще до адрес, а адресу з іншого комп'ютера тоді пропустив.
    server.write('addresses', 'a2', envelope('h2'), 1000);
    localStorage.setItem(
      'astra.sync',
      JSON.stringify({ revision: 1, base: {}, keyMarker: { id: 'k1', at: 1000 }, passwordsKey: 'k1' })
    );

    await sync.sync();

    expect(applied).toEqual([{ id: 'a2', data: envelope('h2') }]);
    expect(server.item('addresses', 'a1')?.data).toEqual(envelope('h1'));
    expect(server.item('addresses', 'a2')?.deleted).toBe(false);
    expect(sync.status().passwords).toBe('ok');
  });

  it('should say when the server is not set up for sync', async () => {
    clearMocks();
    mockIPC((command) => {
      if (command === 'sync_pull') {
        return Promise.reject({ code: 'sync_not_configured', message: 'Синхронізацію ще не налаштовано на сервері.' });
      }
      return command.endsWith('_sync_items') ? { keyId: null, keyTime: 0, items: {} } : [];
    });

    await sync.sync();

    expect(sync.status().state).toBe('not-configured');
  });
});
