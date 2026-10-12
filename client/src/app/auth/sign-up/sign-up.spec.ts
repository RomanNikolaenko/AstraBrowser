import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthStore, SignUpResult } from '../../shared/auth/auth';
import { SignUp } from './sign-up';

describe('SignUp', () => {
  let fixture: ComponentFixture<SignUp>;
  let element: HTMLElement;
  let navigate: ReturnType<typeof vi.spyOn>;
  const auth = {
    available: true,
    user: signal(null),
    signUp: vi.fn<(name: string, email: string, password: string) => Promise<SignUpResult>>(),
    verify: vi.fn<(email: string, code: string) => Promise<void>>(),
    resend: vi.fn<(email: string) => Promise<void>>(),
  };

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
    type('sign-up-name', 'Іван Петренко');
    type('sign-up-email', 'ivan@example.com');
    type('sign-up-password', 'password1');
    type('sign-up-password-confirmation', 'password1');
  };

  const acceptTerms = () => element.querySelector<HTMLInputElement>('input[name="terms"]')?.click();

  beforeEach(async () => {
    auth.signUp.mockReset().mockResolvedValue({ user: null, confirm: true });
    auth.verify.mockReset().mockResolvedValue(undefined);
    auth.resend.mockReset().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [SignUp],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthStore, useValue: auth }],
    }).compileComponents();

    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(SignUp);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('should require accepting the terms', async () => {
    fillForm();
    await submit();

    expect(element.querySelector('.auth__consent-error')?.textContent?.trim()).toBe('Погодьтеся з умовами, щоб створити акаунт');
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('should open the terms and the privacy policy without ticking the consent', async () => {
    const link = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.auth__consent .auth__link')].find((button) =>
        button.textContent?.includes(label)
      );

    link('умовами користування')?.click();
    await fixture.whenStable();
    expect(element.querySelector('.legal-dialog__title')?.textContent?.trim()).toBe('Умови користування');

    link('політикою конфіденційності')?.click();
    await fixture.whenStable();
    expect(element.querySelector('.legal-dialog__title')?.textContent?.trim()).toBe('Політика конфіденційності');
    expect(element.querySelector<HTMLInputElement>('input[name="terms"]')?.checked).toBe(false);
  });

  it('should create the account and ask for the code from the email', async () => {
    fillForm();
    acceptTerms();
    await submit();

    expect(auth.signUp).toHaveBeenCalledWith('Іван Петренко', 'ivan@example.com', 'password1');
    expect(element.querySelector('.auth__step-title')?.textContent?.trim()).toBe('Підтвердіть пошту');
    expect(navigate).not.toHaveBeenCalled();

    type('verify-email-code', '87654321');
    await submit();

    expect(auth.verify).toHaveBeenCalledWith('ivan@example.com', '87654321');
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should open the browser right away when no confirmation is needed', async () => {
    auth.signUp.mockResolvedValue({ user: { id: 'u1', email: 'ivan@example.com', name: 'Іван Петренко' }, confirm: false });
    fillForm();
    acceptTerms();
    await submit();

    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should show why the account was not created', async () => {
    auth.signUp.mockRejectedValue({ code: 'user_already_exists', message: 'Обліковий запис із цією поштою вже існує.' });
    fillForm();
    acceptTerms();
    await submit();

    expect(element.querySelector('.auth__alert--error')?.textContent?.trim()).toBe('Обліковий запис із цією поштою вже існує.');
  });
});
