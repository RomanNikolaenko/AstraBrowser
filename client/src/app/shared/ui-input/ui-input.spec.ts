import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiInput, UiInputType } from './ui-input';

@Component({
  imports: [UiInput],
  template: `
    <app-input icon="email" inputId="email" inputName="email" [type]="type()" ariaLabel="Пошта" placeholder="mail@example.com" size="lg" shape="pill" [(value)]="value">
      <button class="action" type="button">Дія</button>
    </app-input>
  `,
})
class PlainHost {
  readonly type = signal<UiInputType>('email');
  readonly value = signal('start');
}

@Component({
  imports: [UiInput],
  template: `<app-input inputId="login" [(touched)]="touched" [error]="error()" />`,
})
class ValidatedHost {
  readonly touched = signal(false);
  readonly error = signal<string | null>(null);
}

describe('UiInput', () => {
  const setup = async <T>(host: Type<T>) => {
    await TestBed.configureTestingModule({
      imports: [host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('app-input') as HTMLElement;
    const control = element.querySelector('input') as HTMLInputElement;
    return { fixture, input, control };
  };

  it('should pass attributes to the native input', async () => {
    const { input, control } = await setup(PlainHost);

    expect(control.id).toBe('email');
    expect(control.name).toBe('email');
    expect(control.type).toBe('email');
    expect(control.getAttribute('aria-label')).toBe('Пошта');
    expect(control.placeholder).toBe('mail@example.com');
    expect(input.classList).toContain('ui-input--lg');
    expect(input.classList).toContain('ui-input--pill');
    expect(input.querySelector('.ui-input__icon')).toBeTruthy();
    expect(input.querySelector('.action')).toBeTruthy();
  });

  it('should sync the value both ways', async () => {
    const { fixture, control } = await setup(PlainHost);
    expect(control.value).toBe('start');

    control.value = 'typed';
    control.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.value()).toBe('typed');

    fixture.componentInstance.value.set('from parent');
    await fixture.whenStable();
    expect(control.value).toBe('from parent');
  });

  it('should switch the input type', async () => {
    const { fixture, control } = await setup(PlainHost);

    fixture.componentInstance.type.set('password');
    await fixture.whenStable();
    expect(control.type).toBe('password');
  });

  it('should focus the input when the frame is pressed', async () => {
    const { input, control } = await setup(PlainHost);

    input.querySelector('.ui-input__field')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(control);
  });

  it('should not render an error block when [error] is not bound', async () => {
    const { input } = await setup(PlainHost);

    expect(input.querySelector('.ui-input__message')).toBeNull();
  });

  it('should show the error and describe the input with it', async () => {
    const { fixture, input, control } = await setup(ValidatedHost);
    const message = input.querySelector('.ui-input__message');
    expect(message?.classList).not.toContain('ui-input__message--visible');
    expect(control.hasAttribute('aria-invalid')).toBe(false);

    fixture.componentInstance.error.set('Введіть пароль');
    await fixture.whenStable();

    const error = input.querySelector('.ui-input__error');
    expect(input.classList).toContain('ui-input--invalid');
    expect(message?.classList).toContain('ui-input__message--visible');
    expect(error?.textContent).toContain('Введіть пароль');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe(error?.id);
  });

  it('should report touched when the input loses focus', async () => {
    const { fixture, control } = await setup(ValidatedHost);

    control.dispatchEvent(new FocusEvent('blur'));
    expect(fixture.componentInstance.touched()).toBe(true);
  });
});
