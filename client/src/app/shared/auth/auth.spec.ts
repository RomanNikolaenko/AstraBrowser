import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { SettingsStore } from '../settings/settings';
import { accountKey, setStorageAccount } from '../storage/stored-signal';
import { AuthStore, AuthUser, RELOAD_PAGE, authErrorMessage, signedInGuard, signedOutGuard } from './auth';

const USER: AuthUser = { id: '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d', email: 'user@example.com', name: 'Роман' };

describe('AuthStore', () => {
  let calls: { readonly command: string; readonly args: unknown }[];
  let saved: AuthUser | null;
  let owner: boolean;
  let reload: ReturnType<typeof vi.fn<(url: string) => void>>;

  const tick = () => new Promise((resolve) => setTimeout(resolve));

  const runGuard = (guard: typeof signedInGuard) =>
    TestBed.runInInjectionContext(() => guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)) as Promise<
      boolean | UrlTree
    >;

  const target = async (guard: typeof signedInGuard) => {
    const result = await runGuard(guard);
    return result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : result;
  };

  beforeEach(() => {
    (globalThis as { isTauri?: boolean }).isTauri = true;
    mockWindows('main');
    calls = [];
    saved = null;
    owner = false;
    reload = vi.fn<(url: string) => void>();
    localStorage.clear();
    mockIPC(
      (command, args) => {
        calls.push({ command, args });
        switch (command) {
          case 'auth_state':
            return { user: saved, owner, syncUnlocked: !!saved };
          case 'auth_sign_in':
            return { user: USER, owner, syncUnlocked: true };
          default:
            return null;
        }
      },
      { shouldMockEvents: true }
    );
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: RELOAD_PAGE, useValue: reload }] });
  });

  afterEach(() => {
    setStorageAccount(null);
    localStorage.clear();
    clearMocks();
    delete (globalThis as { isTauri?: boolean }).isTauri;
  });

  it('should let a remembered user straight into the browser', async () => {
    saved = USER;
    const auth = TestBed.inject(AuthStore);

    await auth.ready;

    expect(auth.user()).toEqual(USER);
    expect(await target(signedInGuard)).toBe(true);
    expect(await target(signedOutGuard)).toBe('/home');
  });

  it('should send a signed-out user to the sign-in page', async () => {
    expect(await target(signedInGuard)).toBe('/sign-in');
    expect(await target(signedOutGuard)).toBe(true);
  });

  it('should sign in with the remember choice and keep only the user', async () => {
    const auth = TestBed.inject(AuthStore);
    await auth.ready;

    await auth.signIn('user@example.com', 'secret', false);

    expect(calls).toContainEqual({
      command: 'auth_sign_in',
      args: { email: 'user@example.com', password: 'secret', remember: false },
    });
    expect(auth.user()).toEqual(USER);
  });

  it('should follow sign-ins and sign-outs from other windows', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const url = vi.spyOn(router, 'url', 'get').mockReturnValue('/sign-in');
    const auth = TestBed.inject(AuthStore);
    await auth.ready;

    await emit('auth://changed', { user: USER });
    await tick();
    expect(auth.user()).toEqual(USER);
    expect(navigate).toHaveBeenCalledWith(['/home']);

    // Вихід — повне перезавантаження: даних облікового запису в пам'яті вікна не лишається.
    url.mockReturnValue('/home');
    await emit('auth://changed', { user: null });
    await tick();
    expect(auth.user()).toBeNull();
    expect(reload).toHaveBeenCalledWith('/sign-in');
  });

  it('should switch storage to the account and give it the data from before accounts when it is the first one', async () => {
    saved = USER;
    owner = true;
    localStorage.setItem('astra.notes', '["стара нотатка"]');
    localStorage.setItem(accountKey('astra.settings', USER.id), JSON.stringify({ theme: 'dark' }));
    const auth = TestBed.inject(AuthStore);

    await auth.ready;

    expect(auth.owner()).toBe(true);
    expect(auth.syncUnlocked()).toBe(true);
    expect(accountKey('astra.notes')).toBe(`astra.${USER.id}.notes`);
    expect(localStorage.getItem(`astra.${USER.id}.notes`)).toBe('["стара нотатка"]');
    expect(localStorage.getItem('astra.notes')).toBeNull();
    // Налаштування — ті, що були в цього облікового запису.
    expect(TestBed.inject(SettingsStore).theme()).toBe('dark');
  });

  it('should explain errors from the app and hide unexpected ones', () => {
    expect(authErrorMessage({ code: 'offline', message: 'Немає з’єднання' })).toBe('Немає з’єднання');
    expect(authErrorMessage(new Error('boom'))).toBe('Не вдалося виконати дію. Спробуйте ще раз.');
  });
});
