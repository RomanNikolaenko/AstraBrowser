import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthStore } from '../../shared/auth/auth';
import { ForgotPassword } from './forgot-password';

describe('ForgotPassword', () => {
  let fixture: ComponentFixture<ForgotPassword>;
  let element: HTMLElement;
  let navigate: ReturnType<typeof vi.spyOn>;
  const auth = {
    available: true,
    user: signal(null),
    recover: vi.fn<(email: string) => Promise<void>>(),
    resetPassword: vi.fn<(email: string, code: string, password: string) => Promise<void>>(),
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

  beforeEach(async () => {
    auth.recover.mockReset().mockResolvedValue(undefined);
    auth.resetPassword.mockReset().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [ForgotPassword],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthStore, useValue: auth }],
    }).compileComponents();

    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(ForgotPassword);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('should send the code, then set the new password and open the browser', async () => {
    type('forgot-password-email', 'user@example.com');
    await submit();

    expect(auth.recover).toHaveBeenCalledWith('user@example.com');
    expect(element.querySelector('.auth__step-title')?.textContent?.trim()).toBe('Новий пароль');

    type('reset-password-code', '123456');
    type('reset-password-new', 'new-password');
    type('reset-password-confirmation', 'new-password');
    await submit();

    expect(auth.resetPassword).toHaveBeenCalledWith('user@example.com', '123456', 'new-password');
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should not accept a code that is not digits', async () => {
    type('forgot-password-email', 'user@example.com');
    await submit();
    type('reset-password-code', 'abc');
    type('reset-password-new', 'new-password');
    type('reset-password-confirmation', 'new-password');
    await submit();

    expect(element.textContent).toContain('Код — це 6–10 цифр із листа');
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });
});
