import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthStore } from '../../shared/auth/auth';
import { SignIn } from './sign-in';

describe('SignIn', () => {
  let fixture: ComponentFixture<SignIn>;
  let element: HTMLElement;
  let navigate: ReturnType<typeof vi.spyOn>;
  const auth = {
    available: true,
    user: signal(null),
    deletedEmail: signal<string | null>(null),
    signIn: vi.fn<(email: string, password: string, remember: boolean) => Promise<void>>(),
    verify: vi.fn<(email: string, code: string) => Promise<void>>(),
    resend: vi.fn<(email: string) => Promise<void>>(),
  };

  const errors = () =>
    [...element.querySelectorAll('.ui-input__message--visible .ui-input__error')].map((error) => error.textContent?.trim());
  const alert = () => element.querySelector('.auth__alert--error')?.textContent?.trim();

  const type = (id: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(`#${id}`);
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
  };

  const submit = async () => {
    element.querySelector<HTMLButtonElement>('.auth__submit')?.click();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };

  const fillForm = () => {
    type('sign-in-email', ' user@example.com ');
    type('sign-in-password', 'secret');
  };

  beforeEach(async () => {
    auth.signIn.mockReset().mockResolvedValue(undefined);
    auth.verify.mockReset().mockResolvedValue(undefined);
    auth.resend.mockReset().mockResolvedValue(undefined);
    auth.deletedEmail.set(null);
    await TestBed.configureTestingModule({
      imports: [SignIn],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthStore, useValue: auth }],
    }).compileComponents();

    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(SignIn);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach(() => localStorage.removeItem('astra.settings.language'));

  it('should not show errors before the user interacts', () => {
    expect(errors()).toEqual([]);
    expect(element.querySelector('.auth__alert')).toBeNull();
  });

  it('should say that the account was just deleted', async () => {
    auth.deletedEmail.set('user@example.com');
    await fixture.whenStable();

    expect(element.querySelector('.auth__alert')?.textContent?.trim()).toBe(
      'Обліковий запис user@example.com видалено разом з його даними.'
    );
  });

  it('should show errors and stay on the page when submitted empty', async () => {
    await submit();

    expect(errors()).toEqual(['Введіть електронну пошту', 'Введіть пароль']);
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('should switch the whole page to English with the language switch', async () => {
    element.querySelector<HTMLInputElement>('.language-switch__input[value="en"]')?.click();
    await fixture.whenStable();
    await submit();

    expect(element.querySelector('.auth__heading')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Welcome to Astra Browser');
    expect(element.querySelector('.auth__submit')?.textContent?.trim()).toBe('Sign in');
    expect(errors()).toEqual(['Enter your email', 'Enter your password']);
  });

  it('should sign in, remembering the session by default, and open the browser', async () => {
    fillForm();
    await submit();

    expect(auth.signIn).toHaveBeenCalledWith('user@example.com', 'secret', true);
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should not remember the session when the box is unchecked', async () => {
    element.querySelector<HTMLInputElement>('input[name="remember"]')?.click();
    fillForm();
    await submit();

    expect(auth.signIn).toHaveBeenCalledWith('user@example.com', 'secret', false);
  });

  it('should show why signing in failed and stay on the page', async () => {
    auth.signIn.mockRejectedValue({ code: 'invalid_credentials', message: 'Неправильна пошта або пароль.' });
    fillForm();
    await submit();

    expect(alert()).toBe('Неправильна пошта або пароль.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('should ask for the code from the email when the address is not confirmed yet', async () => {
    auth.signIn.mockRejectedValue({ code: 'email_not_confirmed', message: 'Пошту ще не підтверджено.' });
    fillForm();
    await submit();

    expect(element.querySelector('.auth__step-title')?.textContent?.trim()).toBe('Підтвердіть пошту');
    expect(element.querySelector('.auth__step-email')?.textContent?.trim()).toBe('user@example.com');

    type('verify-email-code', '123 456');
    await submit();

    expect(auth.verify).toHaveBeenCalledWith('user@example.com', '123456');
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });
});
