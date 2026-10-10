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
    sendSignInCode: vi.fn<(email: string) => Promise<void>>(),
    signInWithCode: vi.fn<(email: string, code: string, remember: boolean) => Promise<void>>(),
    signInWithGoogle: vi.fn<(remember: boolean) => Promise<void>>(),
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

  const alternative = async (label: string) => {
    [...element.querySelectorAll<HTMLButtonElement>('.auth__alternative')]
      .find((button) => button.textContent?.includes(label))
      ?.click();
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
    auth.sendSignInCode.mockReset().mockResolvedValue(undefined);
    auth.signInWithCode.mockReset().mockResolvedValue(undefined);
    auth.signInWithGoogle.mockReset().mockResolvedValue(undefined);
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

  it('should send a sign-in code to the email and sign in with it, without a password', async () => {
    await alternative('Код на пошту');
    expect(errors()).toEqual(['Введіть електронну пошту']);
    expect(auth.sendSignInCode).not.toHaveBeenCalled();

    type('sign-in-email', ' user@example.com ');
    await alternative('Код на пошту');
    expect(auth.sendSignInCode).toHaveBeenCalledWith('user@example.com');
    expect(element.querySelector('.auth__step-title')?.textContent?.trim()).toBe('Вхід за кодом');

    type('sign-in-code', '123 456');
    await submit();
    expect(auth.signInWithCode).toHaveBeenCalledWith('user@example.com', '123456', true);
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should say when there is no account for the code', async () => {
    auth.sendSignInCode.mockRejectedValue({ code: 'user_not_found', message: 'Облікового запису з такою поштою немає.' });
    type('sign-in-email', 'nobody@example.com');
    await alternative('Код на пошту');

    expect(alert()).toBe('Облікового запису з такою поштою немає.');
    expect(element.querySelector('.auth__step-title')).toBeNull();
  });

  it('should sign in with Google and stay quiet when its window is closed', async () => {
    await alternative('Google');
    expect(auth.signInWithGoogle).toHaveBeenCalledWith(true);
    expect(navigate).toHaveBeenCalledWith(['/home']);

    navigate.mockClear();
    auth.signInWithGoogle.mockRejectedValue({ code: 'cancelled', message: 'Вхід через Google скасовано.' });
    await alternative('Google');
    expect(alert()).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();

    auth.signInWithGoogle.mockRejectedValue({
      code: 'provider_disabled',
      message: 'Вхід через Google ще не налаштовано на сервері.',
    });
    await alternative('Google');
    expect(alert()).toBe('Вхід через Google ще не налаштовано на сервері.');
  });
});
