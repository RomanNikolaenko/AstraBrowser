import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SignIn } from './sign-in';

describe('SignIn', () => {
  let fixture: ComponentFixture<SignIn>;
  let element: HTMLElement;
  let navigate: ReturnType<typeof vi.spyOn>;

  const errors = () => [...element.querySelectorAll('.ui-input__message--visible .ui-input__error')].map((error) => error.textContent?.trim());

  const type = (id: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(`#${id}`);
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
  };

  const submit = async () => {
    element.querySelector<HTMLButtonElement>('.auth__submit')?.click();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SignIn],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(SignIn);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('should not show errors before the user interacts', () => {
    expect(errors()).toEqual([]);
  });

  it('should show errors and stay on the page when submitted empty', async () => {
    await submit();

    expect(errors()).toEqual(['Введіть електронну пошту або ім’я користувача', 'Введіть пароль']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('should open the browser when the form is valid', async () => {
    type('sign-in-login', 'user@example.com');
    type('sign-in-password', 'secret');
    await submit();

    expect(errors()).toEqual([]);
    expect(navigate).toHaveBeenCalledWith(['/home']);
  });
});
