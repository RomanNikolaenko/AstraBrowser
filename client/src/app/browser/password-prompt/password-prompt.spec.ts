import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PasswordPromptRequest, PasswordsStore } from '../data/passwords';
import { PasswordPrompt } from './password-prompt';

/** Без Rust: відповіді лише записуються. */
class FakePasswords extends PasswordsStore {
  readonly calls: [string, Record<string, unknown> | undefined][] = [];

  protected override call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push([command, args]);
    return Promise.resolve((command === 'passwords_state' ? null : undefined) as T);
  }
}

describe('PasswordPrompt', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [PasswordPrompt],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PasswordsStore, useClass: FakePasswords }],
    }).compileComponents();
    const store = TestBed.inject(PasswordsStore) as FakePasswords;
    const fixture = TestBed.createComponent(PasswordPrompt);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const ask = async (request: Partial<PasswordPromptRequest> = {}) => {
      store.ask({ id: 7, origin: 'https://github.com', username: 'octocat', password: 'hub-secret', update: false, ...request });
      await stable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
    const answers = () => store.calls.filter(([command]) => command === 'password_prompt_answer').map(([, args]) => args);
    return { element, store, stable, ask, button, answers };
  };

  it('should offer to save the password with the username fixed by hand', async () => {
    const { element, store, stable, ask, button, answers } = await setup();
    await ask();

    expect(element.querySelector('.password-prompt__title')?.textContent?.trim()).toBe('Зберегти пароль?');
    expect(element.querySelector('.password-prompt__site')?.textContent?.trim()).toBe('github.com');
    const username = element.querySelector<HTMLInputElement>('#password-prompt-username');
    const password = element.querySelector<HTMLInputElement>('#password-prompt-password');
    expect(username?.value).toBe('octocat');
    expect(password?.type).toBe('password');
    expect(password?.value).toBe('hub-secret');

    element.querySelector<HTMLButtonElement>('[aria-label="Показати пароль"]')?.click();
    await stable();
    expect(password?.type).toBe('text');

    if (username) {
      username.value = ' mona ';
      username.dispatchEvent(new Event('input'));
    }
    button('Зберегти')?.click();
    await stable();
    expect(answers()).toEqual([{ id: 7, choice: 'save', username: 'mona', password: 'hub-secret' }]);
    expect(store.prompts()).toEqual([]);
    expect(element.querySelector('.password-prompt__panel')).toBeNull();
  });

  it('should never ask again for the site or ask nothing now', async () => {
    const { ask, button, answers } = await setup();

    await ask();
    button('Ніколи для цього сайту')?.click();
    await ask({ id: 8 });
    button('Не зараз')?.click();

    expect(answers()).toEqual([
      { id: 7, choice: 'never', username: undefined, password: undefined },
      { id: 8, choice: 'dismiss', username: undefined, password: undefined },
    ]);
  });

  it('should offer to update a changed password', async () => {
    const { element, ask, button } = await setup();
    await ask({ update: true });

    expect(element.querySelector('.password-prompt__title')?.textContent?.trim()).toBe('Оновити пароль?');
    expect(button('Оновити')).toBeTruthy();
    expect(button('Ніколи для цього сайту')).toBeUndefined();
  });
});
