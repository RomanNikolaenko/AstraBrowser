import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiSwitch } from './ui-switch';

@Component({
  imports: [UiSwitch],
  template: `
    <label for="test-switch">Панель закладок</label>
    <app-switch
      inputId="test-switch"
      inputName="test"
      [checked]="on()"
      [disabled]="locked()"
      (checkedChange)="asked.push($event)" />
  `,
})
class Host {
  readonly on = signal(false);
  readonly locked = signal(false);
  readonly asked: boolean[] = [];
}

describe('UiSwitch', () => {
  const setup = async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const control = element.querySelector('input') as HTMLInputElement;
    return { fixture, host: fixture.componentInstance, element, control };
  };

  it('should be a labelled checkbox with the switch role', async () => {
    const { control } = await setup();

    expect(control.type).toBe('checkbox');
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.id).toBe('test-switch');
    expect(control.name).toBe('test');
    expect(control.labels?.[0]?.textContent).toBe('Панель закладок');
  });

  it('should ask to change and show only the state it was given', async () => {
    const { fixture, host, element, control } = await setup();

    element.querySelector('label')?.click();
    expect(host.asked).toEqual([true]);
    // Поки стан не прийняли, перемикач не бреше.
    expect(control.checked).toBe(false);

    host.on.set(true);
    await fixture.whenStable();
    expect(control.checked).toBe(true);

    control.click();
    expect(host.asked).toEqual([true, false]);
    expect(control.checked).toBe(true);

    host.locked.set(true);
    await fixture.whenStable();
    expect(control.disabled).toBe(true);
  });
});
