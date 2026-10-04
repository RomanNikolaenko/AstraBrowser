import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiSwitch } from './ui-switch';

@Component({
  imports: [UiSwitch],
  template: `
    <div class="row">
      <span id="test-switch-name">Панель закладок</span>
      <span id="test-switch-hint">Показувати закладки під адресним рядком</span>
    </div>
    <app-switch
      inputId="test-switch"
      inputName="test"
      ariaLabelledby="test-switch-name"
      ariaDescribedby="test-switch-hint"
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
    expect(control.getAttribute('aria-labelledby')).toBe('test-switch-name');
    expect(control.getAttribute('aria-describedby')).toBe('test-switch-hint');
  });

  it('should change only when the switch itself is clicked, not the text of its row', async () => {
    const { host, element } = await setup();

    element.querySelector<HTMLElement>('#test-switch-name')?.click();
    element.querySelector<HTMLElement>('.row')?.click();

    expect(host.asked).toEqual([]);
  });

  it('should ask to change and show only the state it was given', async () => {
    const { fixture, host, control } = await setup();

    control.click();
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
