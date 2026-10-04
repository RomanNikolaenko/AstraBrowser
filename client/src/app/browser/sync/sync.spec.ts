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

describe('SyncService', () => {
  let server: FakeServer;
  let sync: SyncService;

  beforeEach(() => {
    localStorage.clear();
    server = new FakeServer();
    mockIPC((command, args) => {
      const payload = args as { after: number; collection: string | null; items: SyncRow[] };
      switch (command) {
        case 'sync_pull':
          return server.pull(payload.after, payload.collection);
        case 'sync_push':
          return server.push(payload.items);
        case 'passwords_sync_items':
          // Сеанс без ключа: паролі не синхронізуються, поки не введуть пароль облікового запису.
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
    localStorage.setItem('astra.notes', JSON.stringify([note('n2', 'Друга (тут)')]));
    server.write('notes', 'n2', note('n2', 'Друга (там, пізніше)'), Date.now() + 60_000);
    await sync.sync();

    expect(server.item('notes', 'n1')?.deleted).toBe(true);
    expect(notesHere()).toEqual(['n2:Друга (там, пізніше)']);
  });

  it('should say when the server is not set up for sync', async () => {
    clearMocks();
    mockIPC((command) => {
      if (command === 'sync_pull') {
        return Promise.reject({ code: 'sync_not_configured', message: 'Синхронізацію ще не налаштовано на сервері.' });
      }
      return command === 'passwords_sync_items' ? { keyId: null, keyTime: 0, items: {} } : [];
    });

    await sync.sync();

    expect(sync.status().state).toBe('not-configured');
  });
});
