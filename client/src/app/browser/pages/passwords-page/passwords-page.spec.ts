import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PasswordSettings, PasswordsStore, SavedPassword, generatePassword } from '../../data/passwords';
import { PasswordsPage } from './passwords-page';

/** Паролі без Rust: команди виконуються над сховищем у пам'яті й записуються. */
class FakePasswords extends PasswordsStore {
  readonly calls: [string, Record<string, unknown> | undefined][] = [];
  private saved: SavedPassword[] = [];
  private readonly secrets = new Map<string, string>();
  private neverSites: string[] = [];
  private settingsValue: PasswordSettings = { offer: true, autofill: true };
  private nextId = 1;

  seed(accounts: readonly (readonly [string, string, string])[], never: string[] = []): Promise<void> {
    for (const [origin, username, password] of accounts) {
      this.put(origin, username, password);
    }
    this.neverSites = never;
    return this.refresh();
  }

  protected override call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push([command, args]);
    const text = (key: string) => String(args?.[key] ?? '');
    switch (command) {
      case 'passwords_state': {
        const entries = [...this.saved].sort((a, b) => a.origin.localeCompare(b.origin));
        return Promise.resolve({ entries, never: [...this.neverSites], settings: this.settingsValue } as T);
      }
      case 'password_reveal':
        return Promise.resolve(this.secrets.get(text('id')) as T);
      case 'password_add': {
        const origin = new URL(text('site').includes('://') ? text('site') : `https://${text('site')}`).origin;
        if (this.saved.some((entry) => entry.origin === origin && entry.username === text('username'))) {
          return Promise.reject("Для цього сайту вже збережено пароль із таким ім'ям");
        }
        this.put(origin, text('username'), text('password'));
        return Promise.resolve(undefined as T);
      }
      case 'password_edit':
        this.saved = this.saved.map((entry) => (entry.id === text('id') ? { ...entry, username: text('username') } : entry));
        if (text('password')) {
          this.secrets.set(text('id'), text('password'));
        }
        return Promise.resolve(undefined as T);
      case 'password_remove':
        this.saved = this.saved.filter((entry) => entry.id !== text('id'));
        return Promise.resolve(undefined as T);
      case 'passwords_never_remove':
        this.neverSites = this.neverSites.filter((origin) => origin !== text('origin'));
        return Promise.resolve(undefined as T);
      case 'passwords_set_settings':
        this.settingsValue = { offer: Boolean(args?.['offer']), autofill: Boolean(args?.['autofill']) };
        return Promise.resolve(undefined as T);
      default:
        return Promise.resolve(undefined as T);
    }
  }

  private put(origin: string, username: string, password: string): void {
    const id = String(this.nextId++);
    this.saved.push({ id, origin, username, created: 1, updated: 1, used: null });
    this.secrets.set(id, password);
  }
}

describe('PasswordsPage', () => {
  const setup = async (accounts: readonly (readonly [string, string, string])[] = [], never: string[] = []) => {
    await TestBed.configureTestingModule({
      imports: [PasswordsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PasswordsStore, useClass: FakePasswords }],
    }).compileComponents();
    const store = TestBed.inject(PasswordsStore) as FakePasswords;
    await store.seed(accounts, never);

    const fixture = TestBed.createComponent(PasswordsPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      // Відповіді «Rust» — проміси: даємо їм виконатися, а тоді — перемалювати сторінку.
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const click = async (node: Element | null | undefined) => {
      (node as HTMLElement | null)?.click();
      await stable();
    };
    const labelled = (label: string) => element.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    const type = async (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`);
      if (input) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
      }
      await stable();
    };
    return { fixture, element, store, stable, text, click, labelled, type };
  };

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('should show the empty state and change the settings', async () => {
    const { element, store, text, click } = await setup();

    expect(text('.page__empty-title')).toEqual(['Паролів ще немає']);
    expect(element.querySelector('#passwords-search')).toBeNull();
    expect(element.querySelector<HTMLInputElement>('#passwords-offer')?.checked).toBe(true);

    await click(element.querySelector('#passwords-autofill'));
    expect(store.calls.find(([command]) => command === 'passwords_set_settings')?.[1]).toEqual({
      offer: true,
      autofill: false,
    });
    expect(element.querySelector<HTMLInputElement>('#passwords-autofill')?.checked).toBe(false);
  });

  it('should list, search, show, copy and remove passwords', async () => {
    const { element, store, text, click, labelled, type } = await setup([
      ['https://github.com', 'octocat', 'hub-secret'],
      ['https://www.example.com', '', 'example-secret'],
    ]);

    expect(text('.page__group')).toEqual(['Збережені паролі · 2']);
    expect(text('.passwords__list .page__name')).toEqual(['github.com', 'example.com']);
    expect(text('.passwords__list .page__meta')).toEqual(['octocat', 'Без імені користувача']);
    expect(text('.passwords__secret')).toEqual(['••••••••••', '••••••••••']);

    await click(labelled('Показати пароль для github.com'));
    expect(text('.passwords__secret')[0]).toBe('hub-secret');
    await click(labelled('Приховати пароль для github.com'));
    expect(text('.passwords__secret')[0]).toBe('••••••••••');

    await click(labelled('Скопіювати пароль для example.com'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('example-secret');
    expect(labelled('Скопіювати пароль для example.com')?.getAttribute('title')).toBe('Скопійовано');

    await type('passwords-search', 'octo');
    expect(text('.passwords__list .page__name')).toEqual(['github.com']);
    await type('passwords-search', 'нічого');
    expect(text('.page__no-results')[0]).toContain('нічого');
    await type('passwords-search', '');

    await click(labelled('Видалити пароль для github.com'));
    expect(text('.confirm-dialog__message')[0]).toBe(
      'Пароль для «octocat» на github.com буде видалено з браузера. Скасувати це не вийде.'
    );
    await click(
      [...element.querySelectorAll('.confirm-dialog__button')].find((button) => button.textContent?.includes('Видалити'))
    );
    expect(store.calls.some(([command, args]) => command === 'password_remove' && args?.['id'] === '1')).toBe(true);
    expect(text('.passwords__list .page__name')).toEqual(['example.com']);
  });

  it('should add a password by hand with a generated one and refuse a duplicate', async () => {
    const { element, text, click, type } = await setup([['https://github.com', 'octocat', 'hub-secret']]);
    const save = () => element.querySelector('.password-editor__button--primary');

    await click([...element.querySelectorAll('.page__button')].find((button) => button.textContent?.includes('Додати')));
    expect(text('.password-editor__title')).toEqual(['Додати пароль']);
    await click(save());
    expect(text('.password-editor .ui-input__error, .password-editor [role="alert"]').join(' ')).toContain('Введіть');

    await type('password-editor-site', 'github.com');
    await type('password-editor-username', 'octocat');
    await type('password-editor-password', 'another');
    await click(save());
    expect(text('.password-editor__error')).toEqual(["Для цього сайту вже збережено пароль із таким ім'ям"]);

    await type('password-editor-site', 'gitlab.com/users/sign_in');
    await click(element.querySelector('.password-editor__generate'));
    const generated = element.querySelector<HTMLInputElement>('#password-editor-password');
    expect(generated?.type).toBe('text');
    expect(generated?.value).toHaveLength(16);
    await click(save());
    expect(text('.passwords__list .page__name')).toEqual(['github.com', 'gitlab.com']);
  });

  it('should edit a saved password and let a site offer saving again', async () => {
    const { element, store, text, click, labelled, type } = await setup(
      [['https://github.com', 'octocat', 'hub-secret']],
      ['https://bank.example']
    );

    await click(labelled('Змінити пароль для github.com'));
    expect(text('.password-editor__title')).toEqual(['Змінити пароль']);
    expect(text('.password-editor__site-name')).toEqual(['github.com']);
    expect(element.querySelector<HTMLInputElement>('#password-editor-password')?.value).toBe('hub-secret');
    await type('password-editor-username', 'mona');
    await type('password-editor-password', 'new-secret');
    await click(element.querySelector('.password-editor__button--primary'));
    expect(store.calls.find(([command]) => command === 'password_edit')?.[1]).toEqual({
      id: '1',
      username: 'mona',
      password: 'new-secret',
    });
    expect(text('.passwords__list .page__meta')[0]).toBe('mona');

    expect(text('.page__group')).toEqual(['Збережені паролі · 1', 'Ніколи не зберігати']);
    await click(labelled('Знову пропонувати зберігати паролі для bank.example'));
    expect(
      store.calls.some(([command, args]) => command === 'passwords_never_remove' && args?.['origin'] === 'https://bank.example')
    ).toBe(true);
    expect(text('.page__group')).toEqual(['Збережені паролі · 1']);
  });
});

describe('generatePassword', () => {
  it('should mix every kind of character and skip look-alikes', () => {
    for (let run = 0; run < 50; run++) {
      const password = generatePassword();
      expect(password).toHaveLength(16);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[-_.!?@#$%]/);
      expect(password).not.toMatch(/[lIO01]/);
    }
  });
});
