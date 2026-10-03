import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiAccordion } from './ui-accordion';

@Component({
  imports: [UiAccordion],
  template: `
    <app-accordion heading="Списки фільтрів" [badge]="count()" [(open)]="open">
      <button type="button" class="inside">Оновити</button>
    </app-accordion>
  `,
})
class Host {
  readonly open = signal(false);
  readonly count = signal<number | undefined>(7);
}

describe('UiAccordion', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const trigger = element.querySelector('.ui-accordion__trigger') as HTMLButtonElement;
    const panel = element.querySelector('[role="region"]') as HTMLElement;
    return { fixture, element, trigger, panel };
  };

  it('should be a collapsed button that names and controls its region', async () => {
    const { element, trigger, panel } = await setup();

    expect(trigger.querySelector('.ui-accordion__heading')?.textContent).toBe('Списки фільтрів');
    expect(trigger.querySelector('.ui-accordion__badge')?.textContent).toBe('7');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(trigger.id);
    // Згорнутий вміст недоступний ні з клавіатури, ні для екранного читача.
    expect(panel.inert).toBe(true);
    expect(element.querySelector('app-accordion')?.classList).not.toContain('ui-accordion--open');
  });

  it('should open and close on click and report it to two-way binding', async () => {
    const { fixture, element, trigger, panel } = await setup();

    trigger.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.inert).toBe(false);
    expect(element.querySelector('app-accordion')?.classList).toContain('ui-accordion--open');

    trigger.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(panel.inert).toBe(true);
  });

  it('should follow the state set from outside and drop the badge when there is none', async () => {
    const { fixture, element, trigger } = await setup();

    fixture.componentInstance.open.set(true);
    fixture.componentInstance.count.set(undefined);
    await fixture.whenStable();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(element.querySelector('.ui-accordion__badge')).toBeNull();
  });
});
